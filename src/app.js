// Splat stress test on Spark 2.4.0. Setup follows the official examples
// (copies in reference/spark-2.4.0/examples):
// - SparkRenderer in the scene, one SplatMesh            (hello-world)
// - load without LOD, then createLodSplats(), enableLod  (lod-on-demand)
//   so decode and LOD build are timed separately and "All splats" stays available
// - mesh.enableLod + updateVersion() for LOD on/off      (nonlod)
// - SparkControls with rotateSpeed x2                    (lod)
// - virtual joystick on touch devices                    (mobile-joystick)
// LOD budget/scale controls mirror the local experiment viewer (hybrid_web).
import * as THREE from "three";
import { SparkRenderer, SplatMesh, SparkControls, SplatFileType, isMobile, isIos, isAndroid } from "@sparkjsdev/spark";
import { createGpuTimer } from "./gpu_timer.js";
import { initMobileControls, getMobileInput, isMobileDevice, setMobileControlsEnabled } from "./joystick.js";

const VERSIONS = { app: "0.2.0", spark: "2.4.0", three: `r${THREE.REVISION}` };
const $ = (id) => document.getElementById(id);
const num = (n) => (n == null ? "n/a" : Math.round(n).toLocaleString("en-US"));
const secs = (ms) => (ms == null ? "waiting" : `${(ms / 1000).toFixed(1)} s`);
const mb = (b) => (b == null ? "n/a" : b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GB` : `${Math.round(b / 1024 ** 2)} MB`);
const readStore = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const writeStore = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {} };

// ---------------------------------------------------------------- scene
const catalog = await (await fetch("scenes/scenes.json", { cache: "no-cache" })).json();
const params = new URLSearchParams(location.search);
const sceneDef = catalog.scenes.find((s) => s.id === params.get("scene")) ?? catalog.scenes[0];
const source = sceneDef.sources[0];
const lodQuality = params.get("lod") === "quality";
// Spark's isMobile() is false whenever navigator.platform is Windows, so add UA checks.
const mobile = isMobile() || isIos() || isAndroid();
const platform = isIos() ? "iOS" : isAndroid() ? "Android" : mobile ? "mobile" : "desktop";

// A load that never reaches "rendering" means the tab died (iOS kills tabs
// that run out of memory). Remember the stage so the next visit can report it.
const PENDING = "splatbench.pending";
const lastCrash = readStore(PENDING);
let stage = "downloading";
const setStage = (s) => { stage = s; writeStore(PENDING, s === "rendering" ? null : { scene: sceneDef.title, stage: s }); };
setStage("downloading");

// ---------------------------------------------------------------- three
const canvas = $("canvas");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(sceneDef.camera.fov, 1, 0.01, 2000);
const Y = new THREE.Vector3(0, 1, 0);
function resetView() {
  camera.position.fromArray(sceneDef.camera.position);
  camera.up.copy(Y);
  camera.lookAt(new THREE.Vector3().fromArray(sceneDef.camera.target));
}
resetView();

const prefs = { budget: "auto", custom: null, scale: 1, minPx: 1, fovea: "default", dpr: Math.min(devicePixelRatio, 2), stddev: 2.8284, fov: sceneDef.camera.fov, speed: 1, joystick: isMobileDevice(), ...(readStore("splatbench.prefs.v2") ?? {}) };
prefs.fov = readStore("splatbench.fov")?.[sceneDef.id] ?? sceneDef.camera.fov;

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  renderer.setPixelRatio(prefs.dpr);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas);

const spark = new SparkRenderer({ renderer, maxStdDev: prefs.stddev });
scene.add(spark);
const autoBase = spark.defaultSplatTarget();
const FOVEA = {
  default: { coneFov0: spark.coneFov0, coneFov: spark.coneFov, coneFoveate: spark.coneFoveate, behindFoveate: spark.behindFoveate },
  off: { coneFov0: 0, coneFov: 0, coneFoveate: 1, behindFoveate: 1 },
  strong: { coneFov0: 60, coneFov: 100, coneFoveate: 0.3, behindFoveate: 0.1 },
};
const gpuTimer = createGpuTimer(renderer);
const gl = renderer.getContext();
const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
const gpuName = debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
let contextLost = false;
canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); contextLost = true; setStage("WebGL context lost"); });

const controls = new SparkControls({ canvas });
controls.pointerControls.rotateSpeed *= 2.0; // examples/lod
const baseSpeed = { move: controls.fpsMovement.moveSpeed, slide: controls.pointerControls.slideSpeed, scroll: controls.pointerControls.scrollSpeed };

// ------------------------------------------------------------------ load
const t = { start: performance.now(), downloaded: null, decoded: null, lodStart: null, lodEnd: null, firstFrame: null };
let downloadedBytes = 0;
// The .sog is split into parts under 50 MB for GitHub; join them into one
// stream for SplatMesh({ stream, streamLength }). Spark reads the whole file.
function joinParts(urls) {
  let i = 0, reader = null;
  return new ReadableStream({
    async pull(controller) {
      for (;;) {
        if (!reader) {
          if (i >= urls.length) { t.downloaded = performance.now(); controller.close(); return; }
          const res = await fetch(urls[i++]);
          if (!res.ok || !res.body) throw new Error(`Could not download ${urls[i - 1]} (HTTP ${res.status})`);
          reader = res.body.getReader();
        }
        const { done, value } = await reader.read();
        if (done) { reader = null; continue; }
        downloadedBytes += value.byteLength;
        controller.enqueue(value);
        return;
      }
    },
  });
}

const loading = $("loading");
function fail(err) {
  console.error(err);
  loading.classList.add("error");
  $("load-title").textContent = `Could not load ${sceneDef.title}`;
  $("load-detail").textContent = String(err?.message ?? err);
  setStage("error");
}

const mesh = new SplatMesh({
  stream: joinParts(source.parts),
  streamLength: source.bytes,
  fileName: source.fileName,
  fileType: SplatFileType.PCSOGSZIP,
});
mesh.rotation.set(...sceneDef.rotationDeg.map(THREE.MathUtils.degToRad));
mesh.enableLod = false;
mesh.visible = false; // hidden until the LOD tree exists
scene.add(mesh);

let lodReady = false;
(async () => {
  await mesh.initialized;
  t.decoded = performance.now();
  setStage("building the LOD tree");
  t.lodStart = performance.now();
  await mesh.createLodSplats({ quality: lodQuality }); // examples/lod-on-demand
  t.lodEnd = performance.now();
  lodReady = true;
  mesh.visible = true;
  applySettings();
})().catch(fail);

// -------------------------------------------------------------- settings
const panel = $("panel");
const ui = { scene: $("scene"), quality: $("lod-quality"), budget: $("budget"), custom: $("custom"), scale: $("scale"), minPx: $("minpx"), fovea: $("fovea"), dpr: $("dpr"), stddev: $("stddev"), fov: $("fov"), speed: $("speed"), joystick: $("joystick") };

for (const s of catalog.scenes) ui.scene.add(new Option(`${s.title} (${(s.splats / 1e6).toFixed(1)} million splats)`, s.id));
ui.scene.value = sceneDef.id;
ui.quality.value = lodQuality ? "quality" : "fast";
$("load").addEventListener("click", () => {
  writeStore(PENDING, null); // leaving on purpose, not a crash
  location.search = `?scene=${ui.scene.value}${ui.quality.value === "quality" ? "&lod=quality" : ""}`;
});

ui.budget.querySelector('[value="auto"]').textContent = `Auto (Spark's ${platform} default: ${num(autoBase)})`;
const ratios = [...new Set([devicePixelRatio, 3, 2, 1.5, 1, 0.75, 0.5].filter((r) => r <= devicePixelRatio).map((r) => +r.toFixed(2)))];
for (const r of ratios) ui.dpr.add(new Option(r === +devicePixelRatio.toFixed(2) ? `Full (pixel ratio ${r})` : `Pixel ratio ${r}`, String(r)));

if ([...ui.budget.options].some((o) => o.value === prefs.budget)) ui.budget.value = prefs.budget;
ui.custom.value = String(prefs.custom ?? autoBase);
ui.scale.value = String(prefs.scale);
ui.minPx.value = String(prefs.minPx);
ui.fovea.value = prefs.fovea;
ui.dpr.value = String(ratios.find((r) => r <= prefs.dpr) ?? ratios.at(-1));
ui.stddev.value = [...ui.stddev.options].some((o) => Number(o.value) === prefs.stddev) ? String(prefs.stddev) : "2.8284";
ui.fov.value = String(prefs.fov);
ui.speed.value = String(prefs.speed);
ui.joystick.checked = prefs.joystick;

const lodOn = () => lodReady && ui.budget.value !== "full";
const baseBudget = () => spark.lodSplatCount ?? autoBase;

function applySettings() {
  const full = ui.budget.value === "full";
  $("custom-wrap").hidden = ui.budget.value !== "custom";
  for (const el of [ui.scale, ui.minPx, ui.fovea]) el.disabled = full;
  if (ui.budget.value === "custom" && !ui.custom.checkValidity()) return;

  spark.lodSplatCount = full || ui.budget.value === "auto" ? undefined : Number(ui.budget.value === "custom" ? ui.custom.value : ui.budget.value);
  spark.lodSplatScale = Number(ui.scale.value);
  spark.lodRenderScale = Number(ui.minPx.value);
  Object.assign(spark, FOVEA[ui.fovea.value]);
  spark.maxStdDev = Number(ui.stddev.value);
  if (lodReady) {
    mesh.enableLod = !full; // examples/nonlod
    mesh.updateVersion();
  }

  Object.assign(prefs, { budget: ui.budget.value, custom: Number(ui.custom.value), scale: Number(ui.scale.value), minPx: Number(ui.minPx.value), fovea: ui.fovea.value, dpr: Number(ui.dpr.value), stddev: Number(ui.stddev.value), fov: Number(ui.fov.value), speed: Number(ui.speed.value), joystick: ui.joystick.checked });
  camera.fov = prefs.fov;
  resize();
  const k = (sceneDef.moveSpeed ?? 1) * prefs.speed; // scenes differ in scale
  controls.fpsMovement.moveSpeed = baseSpeed.move * k;
  controls.pointerControls.slideSpeed = baseSpeed.slide * k;
  controls.pointerControls.scrollSpeed = baseSpeed.scroll * k;
  if (prefs.joystick) initMobileControls({ joystickSize: 140, knobSize: 60, marginLeft: 40, marginBottom: 40 }); // values from examples/mobile-joystick
  setMobileControlsEnabled(prefs.joystick && panel.hidden);
  document.body.classList.toggle("has-joystick", prefs.joystick);

  $("scale-out").value = `${prefs.scale.toFixed(1)}x`;
  $("minpx-out").value = `${prefs.minPx} px`;
  $("fov-out").value = `${prefs.fov} deg`;
  $("speed-out").value = `${prefs.speed.toFixed(1)}x`;
  const { fov, ...saved } = prefs;
  writeStore("splatbench.prefs.v2", saved);
  writeStore("splatbench.fov", { ...(readStore("splatbench.fov") ?? {}), [sceneDef.id]: fov });
}
for (const el of [ui.budget, ui.custom, ui.fovea, ui.dpr, ui.stddev, ui.joystick]) el.addEventListener("change", applySettings);
for (const el of [ui.scale, ui.minPx, ui.fov, ui.speed]) el.addEventListener("input", applySettings);
applySettings();

// While Settings is open, hide what would sit on top of it or show through it
// (the joystick from examples/mobile-joystick uses z-index 1000).
function setPanel(open) {
  panel.hidden = !open;
  document.body.classList.toggle("panel-open", open);
  setMobileControlsEnabled(prefs.joystick && !open);
}
$("settings-open").addEventListener("click", () => setPanel(true));
$("panel-close").addEventListener("click", () => setPanel(false));
$("reset").addEventListener("click", resetView);
$("versions").textContent = `Splat Stress Test ${VERSIONS.app}, Spark ${VERSIONS.spark}, three.js ${VERSIONS.three}`;
const credit = `<a href="${sceneDef.sourceUrl}" target="_blank" rel="noopener">${sceneDef.title}</a> by <a href="${sceneDef.authorUrl}" target="_blank" rel="noopener">${sceneDef.author}</a>, <a href="${sceneDef.licenseUrl}" target="_blank" rel="noopener">${sceneDef.license}</a>`;
$("credit").innerHTML = credit;
$("panel-credit").innerHTML = `Scene: ${credit}`;

// Hint as in examples/mobile-joystick, faded out after a few seconds.
const hint = $("hint");
hint.textContent = prefs.joystick ? "Use the joystick to move, drag to look around" : "WASD to move, drag to look around";
hint.classList.toggle("touch", prefs.joystick);
setTimeout(() => hint.classList.add("fade"), 8000);

// ------------------------------------------------------------------ stats
const frames = []; // [time, frame ms], last 10 s
const cutEvents = []; // times of LOD selection updates, last 2 s
let cutTotal = 0, lastVersion = null;

function splatBytes() {
  const bytes = (s) => (s ? (s.packedArray?.byteLength ?? 0) + ["sh1", "sh2", "sh3"].reduce((a, k) => a + (s.extra?.[k]?.byteLength ?? 0), 0) : 0);
  return bytes(mesh.packedSplats) + bytes(mesh.packedSplats?.lodSplats);
}
function browserName() {
  const ua = navigator.userAgent;
  const m = ua.match(/(Edg|OPR|Firefox|CriOS|FxiOS|Chrome|Version)\/(\d+)/);
  const name = { Edg: "Edge", OPR: "Opera", CriOS: "Chrome iOS", FxiOS: "Firefox iOS", Version: "Safari" }[m?.[1]] ?? m?.[1] ?? "Unknown";
  return `${name} ${m?.[2] ?? ""}`.trim();
}

// Returns sections of [label, value, hint?, cls?] rows. Used for the panel and "Copy stats".
function collectStats(now) {
  const last1 = frames.filter(([at]) => now - at < 1000);
  const last2 = frames.filter(([at]) => now - at < 2000).map(([, d]) => d);
  const avg = last2.length ? last2.reduce((a, b) => a + b, 0) / last2.length : null;
  const slowest = last2.length ? Math.max(...last2) : null;
  const stutters = frames.filter(([, d]) => d > 50).length;
  const gpu = gpuTimer.milliseconds;
  const heap = performance.memory?.usedJSHeapSize;
  const S = [];

  S.push(["Performance", [
    ["Frames per second", String(last1.length), null, last1.length >= 50 ? "good" : last1.length >= 28 ? "warn" : "bad"],
    ["Frame time, average", avg ? `${avg.toFixed(1)} ms` : "n/a"],
    ["Slowest frame, last 2 s", slowest ? `${slowest.toFixed(0)} ms` : "n/a"],
    ["Stutters, last 10 s", `${stutters} frames over 50 ms`, null, stutters ? "warn" : ""],
    ["GPU time per frame", gpuTimer.supported ? (gpu != null ? `${gpu.toFixed(2)} ms` : "measuring") : "not available in this browser"],
  ], "The screen caps the frame rate (often 60). GPU time shows how much headroom is left."]);

  const splatRows = [["Drawn now", lodReady ? num(mesh.numSplats) : "loading"]];
  if (lodOn()) {
    splatRows.push(["Budget", num(baseBudget() * spark.lodSplatScale), `${spark.lodSplatCount == null ? "Auto" : "Custom"} base ${num(baseBudget())} times scale ${spark.lodSplatScale.toFixed(1)}`]);
    while (cutEvents.length && now - cutEvents[0] > 2000) cutEvents.shift();
    splatRows.push(["LOD selection updates", `${(cutEvents.length / 2).toFixed(1)} per second, ${num(cutTotal)} total`]);
  } else if (lodReady) {
    splatRows.push(["Budget", "LOD off, every splat is drawn"]);
  }
  splatRows.push(["Scene total", num(sceneDef.splats)]);
  splatRows.push(["LOD tree size", mesh.packedSplats?.lodSplats ? `${num(mesh.packedSplats.lodSplats.numSplats)} nodes` : "not built yet"]);
  S.push(["Splats", splatRows]);

  S.push(["Memory", [
    ["Splat data, original and LOD tree", lodReady ? mb(splatBytes()) : "loading"],
    ["JavaScript heap", heap ? mb(heap) : "only reported by Chrome"],
  ]]);

  S.push(["Loading", [
    ["Download", t.downloaded ? `${secs(t.downloaded - t.start)}, ${mb(source.bytes)}, ${((source.bytes / 1048576) / ((t.downloaded - t.start) / 1000)).toFixed(0)} MB/s` : `${mb(downloadedBytes)} of ${mb(source.bytes)}`],
    ["Decode", secs(t.decoded && t.downloaded && t.decoded - t.downloaded)],
    [`LOD tree build, ${lodQuality ? "quality" : "fast"}`, secs(t.lodEnd && t.lodEnd - t.lodStart)],
    ["Ready to view after", secs(t.firstFrame && t.firstFrame - t.start)],
  ]]);

  S.push(["Device", [
    ["GPU", gpuName],
    ["Browser", browserName()],
    ["Screen", `${screen.width} by ${screen.height}, pixel ratio ${+devicePixelRatio.toFixed(2)}`],
    ["Rendering", `${renderer.domElement.width} by ${renderer.domElement.height} pixels`],
    ["Spark device type", `${platform}, default budget ${num(autoBase)}`],
    ["CPU threads, memory", `${navigator.hardwareConcurrency ?? "n/a"}, ${navigator.deviceMemory ? `${navigator.deviceMemory} GB or more` : "not reported"}`],
  ]]);

  const problems = [];
  if (lastCrash) problems.push(["Previous load", `${lastCrash.scene} did not finish (stopped while ${lastCrash.stage}). The tab most likely ran out of memory.`, null, "bad"]);
  if (contextLost) problems.push(["WebGL", "Context lost, the GPU ran out of memory or reset. Reload to continue.", null, "bad"]);
  if (problems.length) S.push(["Problems", problems]);
  return S;
}

const hud = $("hud");
const hudBody = $("hud-body");
if (mobile) hud.classList.add("collapsed");
function syncHudToggle() { $("hud-toggle-text").textContent = hud.classList.contains("collapsed") ? "Show details" : "Hide details"; }
$("hud-toggle").addEventListener("click", () => { hud.classList.toggle("collapsed"); syncHudToggle(); });
syncHudToggle();

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
let lastHud = 0;
function updateHud(now) {
  if (now - lastHud < 250) return;
  lastHud = now;
  const fps = frames.filter(([at]) => now - at < 1000).length;
  $("hud-summary").textContent = lodReady ? `${fps} FPS, ${num(mesh.numSplats)} splats` : "Loading";
  if (hud.classList.contains("collapsed")) return;
  hudBody.innerHTML = collectStats(now).map(([title, rows, hint]) =>
    `<h3>${title}</h3>${rows.map(([k, v, h, cls]) => `<div class="row"><span class="k">${esc(k)}</span><span class="v ${cls ?? ""}">${esc(v)}</span></div>${h ? `<div class="hint">${esc(h)}</div>` : ""}`).join("")}${hint ? `<div class="hint">${esc(hint)}</div>` : ""}`
  ).join("");
}

$("copy").addEventListener("click", async () => {
  const lines = [`Splat Stress Test, ${new Date().toISOString()}`, `Scene: ${sceneDef.title}`, ""];
  for (const [title, rows] of collectStats(performance.now())) {
    lines.push(title);
    for (const [k, v, h] of rows) lines.push(`  ${k}: ${v}${h ? ` (${h})` : ""}`);
  }
  lines.push("Settings", `  Budget: ${ui.budget.selectedOptions[0].text}${ui.budget.value === "custom" ? ` ${ui.custom.value}` : ""}`, `  LOD scale: ${prefs.scale}`, `  Skip splats smaller than: ${prefs.minPx} px`, `  Detail toward edges: ${ui.fovea.selectedOptions[0].text}`, `  Resolution: ${ui.dpr.selectedOptions[0].text}`, `  Splat edge cutoff: ${ui.stddev.selectedOptions[0].text}`, `  Field of view: ${prefs.fov} deg`);
  lines.push(`Versions: Spark ${VERSIONS.spark}, three.js ${VERSIONS.three}, app ${VERSIONS.app}`, `User agent: ${navigator.userAgent}`);
  const text = lines.join("\n");
  try { await navigator.clipboard.writeText(text); $("copy").textContent = "Copied"; }
  catch { prompt("Copy these stats", text); }
  setTimeout(() => ($("copy").textContent = "Copy stats as text"), 1500);
});

function updateLoading(now) {
  if (t.firstFrame || loading.classList.contains("error")) return;
  const bar = $("load-bar");
  if (!t.downloaded) {
    $("load-title").textContent = `Downloading ${sceneDef.title}`;
    $("load-detail").textContent = `${mb(downloadedBytes)} of ${mb(source.bytes)}`;
    bar.classList.remove("busy");
    bar.style.width = `${Math.round((100 * downloadedBytes) / source.bytes)}%`;
    return;
  }
  bar.classList.add("busy");
  if (!t.decoded) {
    $("load-title").textContent = "Decoding";
    $("load-detail").textContent = `${num(sceneDef.splats)} splats, ${secs(now - t.downloaded)} so far`;
  } else if (!lodReady) {
    $("load-title").textContent = `Building the LOD tree (${lodQuality ? "quality" : "fast"})`;
    $("load-detail").textContent = `${secs(now - t.lodStart)} so far. This step has no progress events.`;
  } else {
    $("load-title").textContent = "Preparing the first frame";
    $("load-detail").textContent = "";
  }
}

// ------------------------------------------------------------- main loop
const move = new THREE.Vector3();
let last = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = now - last;
  last = now;
  if (dt < 1000) frames.push([now, dt]);
  while (frames.length && now - frames[0][0] > 10000) frames.shift();

  controls.update(camera);
  if (prefs.joystick) {
    // examples/mobile-joystick: move along the view direction
    const input = getMobileInput();
    if (input.x || input.y) camera.position.add(move.set(input.x, 0, input.y).multiplyScalar((controls.fpsMovement.moveSpeed * dt) / 1000).applyQuaternion(camera.quaternion));
  }
  gpuTimer.render(() => renderer.render(scene, camera));

  if (lodReady) {
    if (mesh.enableLod && lastVersion !== null && mesh.mappingVersion !== lastVersion) {
      cutTotal += mesh.mappingVersion - lastVersion;
      cutEvents.push(now);
    }
    lastVersion = mesh.mappingVersion;
    if (!t.firstFrame && spark.activeSplats > 0) {
      t.firstFrame = performance.now();
      loading.hidden = true;
      setTimeout(() => setStage("rendering"), 5000); // survived 5 s, so not a crash
    }
  }
  updateLoading(now);
  updateHud(now);
});

// For the headless check (tools/check_app.py)
window.splatBench = { spark, mesh, t, get lodReady() { return lodReady; }, get stage() { return stage; } };
