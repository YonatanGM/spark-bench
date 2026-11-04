// Spark test viewer on Spark 2.4.0. Setup follows the official examples
// (copies in reference/spark-2.4.0/examples):
// - SparkRenderer in the scene, one SplatMesh            (hello-world)
// - load without LOD, then createLodSplats(), enableLod  (lod-on-demand)
//   so decode and LOD build are timed separately and "All splats" stays available
// - mesh.enableLod + updateVersion() for LOD on/off      (nonlod)
// - SparkControls with rotateSpeed x2                    (lod)
// - virtual joystick on touch devices                    (mobile-joystick)
// Budget and LOD scale controls mirror the local experiment viewer (hybrid_web).
import * as THREE from "three";
import { SparkRenderer, SplatMesh, SparkControls, SplatFileType, isMobile, isIos, isAndroid } from "@sparkjsdev/spark";
import { createGpuTimer } from "./gpu_timer.js";
import { initMobileControls, getMobileInput, isMobileDevice } from "./joystick.js";

const $ = (id) => document.getElementById(id);
const num = (n) => (n == null ? "n/a" : Math.round(n).toLocaleString("en-US"));
const secs = (ms) => (ms == null ? "..." : `${(ms / 1000).toFixed(1)} s`);
const mb = (b) => (b == null ? "n/a" : b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GB` : `${Math.round(b / 1024 ** 2)} MB`);
const readStore = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const writeStore = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {} };

// ---------------------------------------------------------------- scene
const catalog = await (await fetch("scenes/scenes.json", { cache: "no-cache" })).json();
const params = new URLSearchParams(location.search);
const sceneDef = catalog.scenes.find((s) => s.id === params.get("scene")) ?? catalog.scenes[0];
const source = sceneDef.sources[0];
// Spark's isMobile() is false whenever navigator.platform is Windows, so add UA checks.
const mobile = isMobile() || isIos() || isAndroid();
const platform = isIos() ? "iOS" : isAndroid() ? "Android" : mobile ? "mobile" : "desktop";

// A load that never reaches "rendering" means the tab died (iOS kills tabs
// that run out of memory). Remember the stage so the next visit can report it.
const PENDING = "splatbench.pending";
const lastCrash = readStore(PENDING);
const setStage = (s) => writeStore(PENDING, s === "rendering" ? null : { scene: sceneDef.name, stage: s });
setStage("downloading");

// ---------------------------------------------------------------- three
const canvas = $("canvas");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(sceneDef.camera.fov, 1, 0.01, 2000);
const Y = new THREE.Vector3(0, 1, 0);
function resetView() {
  camera.position.fromArray(sceneDef.camera.position);
  camera.up.copy(Y);
  camera.lookAt(new THREE.Vector3().fromArray(sceneDef.camera.target));
}
resetView();
function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas);

const spark = new SparkRenderer({ renderer });
scene.add(spark);
const autoBase = spark.defaultSplatTarget();
const gpuTimer = createGpuTimer(renderer);
const gl = renderer.getContext();
const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
const gpuName = debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
let contextLost = false;
canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); contextLost = true; setStage("WebGL context lost"); });

const controls = new SparkControls({ canvas });
controls.pointerControls.rotateSpeed *= 2.0; // examples/lod
const k = sceneDef.moveSpeed ?? 1; // scenes differ in scale (garage ~10 m, planet ~70 units)
controls.fpsMovement.moveSpeed *= k;
controls.pointerControls.slideSpeed *= k;
controls.pointerControls.scrollSpeed *= k;

// Joystick on touch screens, values from examples/mobile-joystick
const joystick = isMobileDevice();
if (joystick) {
  initMobileControls({ joystickSize: 140, knobSize: 60, marginLeft: 40, marginBottom: 40 });
  document.body.classList.add("has-joystick");
  const hint = $("hint");
  hint.textContent = "Use the joystick to move, drag to look around";
  hint.hidden = false;
  setTimeout(() => hint.classList.add("fade"), 6000);
}

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
  $("load-title").textContent = `Could not load ${sceneDef.name}`;
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
  await mesh.createLodSplats({ quality: false }); // examples/lod-on-demand
  t.lodEnd = performance.now();
  lodReady = true;
  mesh.visible = true;
  applyLod();
})().catch(fail);

// -------------------------------------------------------------- controls
const sceneSelect = $("scene"), budget = $("budget"), custom = $("custom"), scale = $("scale");
for (const s of catalog.scenes) sceneSelect.add(new Option(`${s.name} (${(s.splats / 1e6).toFixed(1)}M splats)`, s.id));
sceneSelect.value = sceneDef.id;
sceneSelect.addEventListener("change", () => {
  writeStore(PENDING, null); // leaving on purpose, not a crash
  location.search = `?scene=${sceneSelect.value}`;
});
$("reset").addEventListener("click", resetView);

budget.querySelector('[value="auto"]').textContent = `Auto (${(autoBase / 1e6).toFixed(1)}M on ${platform})`;
const PREFS = "splatbench.prefs.v3";
const saved = readStore(PREFS) ?? {};
if ([...budget.options].some((o) => o.value === saved.budget)) budget.value = saved.budget;
custom.value = String(saved.custom ?? autoBase);
scale.value = String(saved.scale ?? 1);

function applyLod() {
  const full = budget.value === "full";
  $("custom-wrap").hidden = budget.value !== "custom";
  scale.disabled = full;
  if (budget.value === "custom" && !custom.checkValidity()) return;
  spark.lodSplatCount = full || budget.value === "auto" ? undefined : Number(budget.value === "custom" ? custom.value : budget.value);
  spark.lodSplatScale = Number(scale.value);
  $("scale-out").value = `${spark.lodSplatScale.toFixed(1)}x`;
  if (lodReady) {
    mesh.enableLod = !full; // examples/nonlod
    mesh.updateVersion();
  }
  writeStore(PREFS, { budget: budget.value, custom: Number(custom.value), scale: Number(scale.value) });
}
budget.addEventListener("change", applyLod);
custom.addEventListener("change", applyLod);
scale.addEventListener("input", applyLod);
applyLod();

$("credit").innerHTML = `<a href="${sceneDef.sourceUrl}" target="_blank" rel="noopener">${sceneDef.title}</a> by <a href="${sceneDef.authorUrl}" target="_blank" rel="noopener">${sceneDef.author}</a>, <a href="${sceneDef.licenseUrl}" target="_blank" rel="noopener">${sceneDef.license}</a>`;

// ------------------------------------------------------------------ stats
const frames = []; // [time, frame ms], last 10 s
const cutEvents = []; // times of LOD updates, last 2 s
let lastVersion = null;

function splatBytes() {
  const bytes = (s) => (s ? (s.packedArray?.byteLength ?? 0) + ["sh1", "sh2", "sh3"].reduce((a, k) => a + (s.extra?.[k]?.byteLength ?? 0), 0) : 0);
  return bytes(mesh.packedSplats) + bytes(mesh.packedSplats?.lodSplats);
}
function browserName() {
  const m = navigator.userAgent.match(/(Edg|OPR|Firefox|CriOS|FxiOS|Chrome|Version)\/(\d+)/);
  const name = { Edg: "Edge", OPR: "Opera", CriOS: "Chrome", FxiOS: "Firefox", Version: "Safari" }[m?.[1]] ?? m?.[1] ?? "Unknown";
  return `${name} ${m?.[2] ?? ""}`.trim();
}

function statSections(now) {
  const last1 = frames.filter(([at]) => now - at < 1000).length;
  const last2 = frames.filter(([at]) => now - at < 2000).map(([, d]) => d);
  const avg = last2.length ? last2.reduce((a, b) => a + b, 0) / last2.length : null;
  const stutters = frames.filter(([, d]) => d > 50).length;
  const gpu = gpuTimer.milliseconds;
  const heap = performance.memory?.usedJSHeapSize;
  const lodOn = lodReady && budget.value !== "full";
  while (cutEvents.length && now - cutEvents[0] > 2000) cutEvents.shift();

  const S = [];
  S.push(["Performance", [
    ["FPS", String(last1), last1 >= 28 ? "" : "bad"],
    ["Frame time", avg ? `${avg.toFixed(1)} ms` : "n/a"],
    ["Slowest frame (2 s)", last2.length ? `${Math.max(...last2).toFixed(0)} ms` : "n/a"],
    ["Stutters over 50 ms (10 s)", String(stutters), stutters ? "warn" : ""],
    ["GPU time", gpuTimer.supported ? (gpu != null ? `${gpu.toFixed(2)} ms` : "...") : "n/a in this browser"],
  ]]);
  S.push(["Splats", [
    // Count from the loaded file once decoded (catalog value until then)
    ["Original (no LOD)", num(mesh.packedSplats?.numSplats || sceneDef.splats)],
    ["Drawn", lodReady ? num(mesh.numSplats) : "..."],
    ["Budget", lodOn ? num((spark.lodSplatCount ?? autoBase) * spark.lodSplatScale) : lodReady ? "LOD off" : "..."],
    ["LOD tree", mesh.packedSplats?.lodSplats ? `${num(mesh.packedSplats.lodSplats.numSplats)} nodes` : "..."],
    ["LOD updates", lodOn ? `${(cutEvents.length / 2).toFixed(1)}/s` : "n/a"],
  ]]);
  const memory = [["Splat data", lodReady ? mb(splatBytes()) : "..."]];
  if (heap) memory.push(["JS heap", mb(heap)]);
  S.push(["Memory", memory]);
  S.push(["Loading", [
    ["Download", t.downloaded ? `${secs(t.downloaded - t.start)}, ${mb(source.bytes)}` : `${mb(downloadedBytes)} of ${mb(source.bytes)}`],
    ["Download speed", t.downloaded ? `${((source.bytes / 1048576) / ((t.downloaded - t.start) / 1000)).toFixed(1)} MB/s` : "..."],
    ["Decode", secs(t.decoded && t.downloaded && t.decoded - t.downloaded)],
    ["LOD build", secs(t.lodEnd && t.lodEnd - t.lodStart)],
    ["Total until visible", secs(t.firstFrame && t.firstFrame - t.start)],
  ]]);
  S.push(["Device", [
    ["GPU", gpuName],
    ["Browser", browserName()],
    ["Screen", `${screen.width} x ${screen.height}, DPR ${+devicePixelRatio.toFixed(2)}`],
    ["Render size", `${renderer.domElement.width} x ${renderer.domElement.height}`],
    ["CPU threads", String(navigator.hardwareConcurrency ?? "n/a")],
  ]]);
  const problems = [];
  if (lastCrash) problems.push(["Last load", `${lastCrash.scene} crashed while ${lastCrash.stage}`, "bad"]);
  if (contextLost) problems.push(["WebGL", "context lost (GPU out of memory?)", "bad"]);
  if (problems.length) S.push(["Problems", problems]);
  return S;
}

const hud = $("hud");
const stats = $("stats");
if (mobile) hud.classList.add("collapsed");
function syncToggle() { $("hud-toggle-text").textContent = hud.classList.contains("collapsed") ? "Show" : "Hide"; }
$("hud-toggle").addEventListener("click", () => { hud.classList.toggle("collapsed"); syncToggle(); });
syncToggle();

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
let lastHud = 0;
function updateHud(now) {
  if (now - lastHud < 250) return;
  lastHud = now;
  const fps = frames.filter(([at]) => now - at < 1000).length;
  $("hud-summary").textContent = lodReady ? `${fps} FPS, ${num(mesh.numSplats)} splats` : "Loading";
  if (hud.classList.contains("collapsed")) return;
  stats.innerHTML = statSections(now).map(([title, rows]) =>
    `<h3>${title}</h3>${rows.map(([key, value, cls]) => `<div class="row"><span class="k">${esc(key)}</span><span class="v ${cls ?? ""}">${esc(value)}</span></div>`).join("")}`
  ).join("");
}

// Plain-text copy of the panel, for pasting into a message
$("copy").addEventListener("click", async () => {
  const lines = [`Spark Test, ${new Date().toISOString()}`, `Scene: ${sceneDef.name}`, `Budget: ${budget.selectedOptions[0].text}${budget.value === "custom" ? ` ${num(Number(custom.value))}` : ""}, LOD scale ${spark.lodSplatScale.toFixed(1)}x`];
  for (const [title, rows] of statSections(performance.now())) {
    lines.push("", title);
    for (const [key, value] of rows) lines.push(`${key}: ${value}`);
  }
  lines.push("", `User agent: ${navigator.userAgent}`, location.href);
  const text = lines.join("\n");
  try { await navigator.clipboard.writeText(text); $("copy").textContent = "Copied"; }
  catch { prompt("Copy these stats", text); }
  setTimeout(() => ($("copy").textContent = "Copy stats"), 1500);
});

function updateLoading(now) {
  if (t.firstFrame || loading.classList.contains("error")) return;
  const bar = $("load-bar");
  if (!t.downloaded) {
    $("load-title").textContent = `Downloading ${sceneDef.name}`;
    $("load-detail").textContent = `${mb(downloadedBytes)} of ${mb(source.bytes)}`;
    bar.classList.remove("busy");
    bar.style.width = `${Math.round((100 * downloadedBytes) / source.bytes)}%`;
    return;
  }
  bar.classList.add("busy");
  if (!t.decoded) {
    $("load-title").textContent = "Decoding";
    $("load-detail").textContent = `${num(sceneDef.splats)} splats, ${secs(now - t.downloaded)}`;
  } else if (!lodReady) {
    $("load-title").textContent = "Building LOD tree";
    $("load-detail").textContent = secs(now - t.lodStart);
  } else {
    $("load-title").textContent = "First frame";
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
  if (joystick) {
    // examples/mobile-joystick: move along the view direction
    const input = getMobileInput();
    if (input.x || input.y) camera.position.add(move.set(input.x, 0, input.y).multiplyScalar((controls.fpsMovement.moveSpeed * dt) / 1000).applyQuaternion(camera.quaternion));
  }
  gpuTimer.render(() => renderer.render(scene, camera));

  if (lodReady) {
    if (mesh.enableLod && lastVersion !== null && mesh.mappingVersion !== lastVersion) cutEvents.push(now);
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
window.splatBench = { spark, mesh, t, get lodReady() { return lodReady; } };
