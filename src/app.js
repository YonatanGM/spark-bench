// Splat stress test on Spark 2.4.0. Setup follows the official examples
// (copies in reference/spark-2.4.0/examples):
// - SparkRenderer in the scene, one SplatMesh            (hello-world)
// - load without LOD, then createLodSplats(), enableLod  (lod-on-demand)
//   -> lets us time decode and LOD build separately, and keep "All splats"
// - mesh.enableLod + updateVersion() for LOD on/off      (nonlod)
// - SparkControls with rotateSpeed x2                    (lod)
// - virtual joystick on touch devices                    (mobile-joystick)
// LOD controls and readout mirror the local experiment viewer (hybrid_web).
import * as THREE from "three";
import { SparkRenderer, SplatMesh, SparkControls, SplatFileType, isMobile, isIos, isAndroid } from "@sparkjsdev/spark";
import { createGpuTimer } from "./gpu_timer.js";
import { initMobileControls, getMobileInput, isMobileDevice } from "./joystick.js";

const $ = (id) => document.getElementById(id);
const fmt = (n) => (n == null ? "—" : Math.round(n).toLocaleString("en-US"));
const secs = (ms) => (ms == null ? "…" : `${(ms / 1000).toFixed(1)} s`);
const mb = (b) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GB` : `${Math.round(b / 1024 ** 2)} MB`);

// ---------------------------------------------------------------- scene
const catalog = await (await fetch("scenes/scenes.json", { cache: "no-cache" })).json();
const params = new URLSearchParams(location.search);
const sceneDef = catalog.scenes.find((s) => s.id === params.get("scene")) ?? catalog.scenes[0];
const source = sceneDef.sources[0];
// isMobile() is false whenever navigator.platform is Windows, so add UA checks.
const mobile = isMobile() || isIos() || isAndroid();

// A load that never reaches "rendering" means the tab died (iOS kills tabs
// that run out of memory). Remember the stage so the next visit can say so.
const PENDING = "splatbench.pending";
const readStore = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const writeStore = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const lastCrash = readStore(PENDING);
let stage = "downloading";
const setStage = (s) => { stage = s; writeStore(PENDING, s === "rendering" ? null : { scene: sceneDef.id, stage: s }); };
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

let pixelRatio = Math.min(devicePixelRatio, 2);
function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas);

const spark = new SparkRenderer({ renderer });
scene.add(spark);
const gpuTimer = createGpuTimer(renderer);
let contextLost = false;
canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); contextLost = true; setStage("WebGL context lost"); });

const controls = new SparkControls({ canvas });
controls.pointerControls.rotateSpeed *= 2.0; // examples/lod
const k = sceneDef.moveSpeed ?? 1; // scenes differ in scale (garage ~10 m, planet ~70 units)
controls.fpsMovement.moveSpeed *= k;
controls.pointerControls.slideSpeed *= k;
controls.pointerControls.scrollSpeed *= k;
const joystick = isMobileDevice();
if (joystick) initMobileControls({ joystickSize: 120, knobSize: 50, marginLeft: 24, marginBottom: 28 });

// ------------------------------------------------------------------ load
const t = { start: performance.now(), downloaded: null, decoded: null, lodStart: null, lodEnd: null, firstFrame: null };
let downloadedBytes = 0;
// The .sog is split into <50 MB parts for GitHub; join them into one stream
// for SplatMesh({ stream, streamLength }). Spark reads the whole file.
function joinParts(urls) {
  let i = 0, reader = null;
  return new ReadableStream({
    async pull(controller) {
      for (;;) {
        if (!reader) {
          if (i >= urls.length) { t.downloaded = performance.now(); controller.close(); return; }
          const res = await fetch(urls[i++]);
          if (!res.ok || !res.body) throw new Error(`Could not download ${urls[i - 1]} (${res.status})`);
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
  loading.textContent = `Could not load ${sceneDef.title}\n${err?.message ?? err}`;
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
mesh.visible = false; // stay hidden until the LOD tree exists
scene.add(mesh);

let lodReady = false;
(async () => {
  await mesh.initialized;
  t.decoded = performance.now();
  setStage("building LOD");
  t.lodStart = performance.now();
  await mesh.createLodSplats({ quality: false }); // examples/lod-on-demand
  t.lodEnd = performance.now();
  lodReady = true;
  mesh.visible = true;
  applyLod();
})().catch(fail);

// ------------------------------------------------------------- controls
const budget = $("budget"), custom = $("custom"), scale = $("scale"), scaleOut = $("scale-out"), dprSelect = $("dpr");
const autoBase = spark.defaultSplatTarget();
budget.querySelector('[value="auto"]').textContent = `Auto LOD · base ${fmt(autoBase)}`;
custom.value = String(autoBase);

for (const s of catalog.scenes) $("scene").add(new Option(`${s.title} · ${(s.splats / 1e6).toFixed(1)}M splats`, s.id));
$("scene").value = sceneDef.id;
$("scene").addEventListener("change", (e) => {
  writeStore(PENDING, null); // leaving on purpose, not a crash
  location.search = `?scene=${e.target.value}`;
});
$("reset").addEventListener("click", resetView);

const ratios = [...new Set([devicePixelRatio, 2, 1.5, 1, 0.75, 0.5].filter((r) => r <= devicePixelRatio).map((r) => +r.toFixed(2)))];
for (const r of ratios) dprSelect.add(new Option(r === +devicePixelRatio.toFixed(2) ? `Native (${r}×)` : `${r}×`, String(r)));
dprSelect.value = String(ratios.find((r) => r <= pixelRatio) ?? ratios.at(-1));

// Saved like the local viewer's preferences.
const PREFS = "splatbench.prefs.v1";
const saved = readStore(PREFS) ?? {};
if ([...budget.options].some((o) => o.value === saved.budget)) budget.value = saved.budget;
if (saved.scale >= 0.1 && saved.scale <= 2) scale.value = String(saved.scale);
if (saved.custom >= 10000) custom.value = String(saved.custom);
if ([...dprSelect.options].some((o) => o.value === String(saved.dpr))) dprSelect.value = String(saved.dpr);

function applyLod() {
  const lodOn = budget.value !== "full";
  custom.hidden = budget.value !== "custom";
  scale.disabled = !lodOn;
  if (budget.value === "custom" && !custom.checkValidity()) return;
  spark.lodSplatCount = !lodOn || budget.value === "auto" ? undefined : Number(budget.value === "custom" ? custom.value : budget.value);
  spark.lodSplatScale = Number(scale.value);
  scaleOut.value = `${spark.lodSplatScale.toFixed(1)}×`;
  pixelRatio = Number(dprSelect.value);
  resize();
  if (lodReady) {
    mesh.enableLod = lodOn; // examples/nonlod
    mesh.updateVersion();
  }
  writeStore(PREFS, { budget: budget.value, scale: Number(scale.value), custom: Number(custom.value), dpr: pixelRatio });
}
for (const el of [budget, custom, dprSelect]) el.addEventListener("change", applyLod);
scale.addEventListener("input", applyLod);
applyLod();

$("credit").innerHTML = `<a href="${sceneDef.sourceUrl}" target="_blank" rel="noopener">${sceneDef.title}</a> by <a href="${sceneDef.authorUrl}" target="_blank" rel="noopener">${sceneDef.author}</a> · <a href="${sceneDef.licenseUrl}" target="_blank" rel="noopener">${sceneDef.license}</a>`;

// --------------------------------------------------------------- readout
const readout = $("readout");
if (mobile) readout.classList.add("compact");
readout.addEventListener("click", () => readout.classList.toggle("compact"));
readout.title = "Tap to show or hide details";

const frames = []; // [time, frameMs] for the last 10 s
let cutUpdates = 0, lastVersion = null, lastReadout = 0;

function splatMemory() {
  const bytes = (s) => (s ? (s.packedArray?.byteLength ?? 0) + ["sh1", "sh2", "sh3"].reduce((a, k) => a + (s.extra?.[k]?.byteLength ?? 0), 0) : 0);
  const original = mesh.packedSplats;
  return bytes(original) + bytes(original?.lodSplats);
}

function updateReadout(now) {
  if (now - lastReadout < 250) return;
  lastReadout = now;
  const recent = frames.filter(([at]) => now - at < 1000);
  const fps = recent.length;
  const frameMs = recent.length ? recent.reduce((a, [, d]) => a + d, 0) / recent.length : null;
  const hitches = frames.filter(([, d]) => d > 50).length;
  const gpu = gpuTimer.milliseconds;
  const lodOn = lodReady && budget.value !== "full";
  const base = spark.lodSplatCount ?? autoBase;
  const heap = performance.memory?.usedJSHeapSize;
  const L = [];
  L.push(`<div class="label">${lodOn ? "Current LOD splats" : "Current splats"}</div>`);
  L.push(`<div class="big">${lodReady ? fmt(mesh.numSplats) : "—"}</div>`);
  L.push(`<div class="mode">${!lodReady ? "Loading" : lodOn ? `LOD on · ${spark.lodSplatCount == null ? "automatic" : "custom"} base` : "All splats · LOD off"}</div>`);
  L.push(`<div class="line">${fps} fps${frameMs ? ` · ${frameMs.toFixed(1)} ms per frame` : ""}${gpu != null ? ` · ${gpu.toFixed(2)} ms GPU` : ""}</div>`);
  L.push('<div class="more">');
  if (lodOn) {
    L.push(`<div class="line gap">Max splats (budget) ${fmt(base * spark.lodSplatScale)}</div>`);
    L.push(`<div class="sub">Base ${fmt(base)} × ${spark.lodSplatScale.toFixed(1)} scale</div>`);
  }
  L.push(`<div class="line${lodOn ? "" : " gap"}">Scene splats ${fmt(sceneDef.splats)}</div>`);
  if (lodOn) L.push(`<div class="line">LOD cut updates ${fmt(cutUpdates)}</div>`);
  L.push(`<div class="line ${hitches ? "warn" : ""}">Stutters (frames over 50 ms, last 10 s) ${hitches}</div>`);
  L.push(`<div class="line gap">Splat memory ${lodReady ? mb(splatMemory()) : "…"}</div>`);
  if (heap) L.push(`<div class="line">JS memory ${mb(heap)}</div>`);
  L.push(`<div class="line gap">Download ${secs(t.downloaded && t.downloaded - t.start)} · ${mb(source.bytes)}</div>`);
  L.push(`<div class="line">Decode ${secs(t.decoded && t.downloaded && t.decoded - t.downloaded)}</div>`);
  L.push(`<div class="line">LOD build ${secs(t.lodEnd && t.lodEnd - t.lodStart)}</div>`);
  L.push(`<div class="line">Ready after ${secs(t.firstFrame && t.firstFrame - t.start)}</div>`);
  if (lastCrash) L.push(`<div class="line bad gap">Previous load of ${catalog.scenes.find((s) => s.id === lastCrash.scene)?.title ?? lastCrash.scene} crashed while ${lastCrash.stage}</div>`);
  if (contextLost) L.push('<div class="line bad">WebGL context lost (GPU out of memory?)</div>');
  L.push("</div>");
  readout.innerHTML = L.join("");
}

function updateLoading(now) {
  if (t.firstFrame || loading.classList.contains("error")) return;
  if (!t.downloaded) loading.textContent = `Downloading ${sceneDef.title}\n${mb(downloadedBytes)} of ${mb(source.bytes)}`;
  else if (!t.decoded) loading.textContent = `Decoding ${fmt(sceneDef.splats)} splats… ${secs(now - t.downloaded)}`;
  else if (!lodReady) loading.textContent = `Building LOD tree… ${secs(now - t.lodStart)}`;
  else loading.textContent = "Preparing first frame…";
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
    if (input.x || input.y) camera.position.add(move.set(input.x, 0, input.y).multiplyScalar(controls.fpsMovement.moveSpeed * dt / 1000).applyQuaternion(camera.quaternion));
  }
  gpuTimer.render(() => renderer.render(scene, camera));

  if (lodReady) {
    if (mesh.enableLod && lastVersion !== null && mesh.mappingVersion !== lastVersion) cutUpdates += mesh.mappingVersion - lastVersion;
    lastVersion = mesh.mappingVersion;
    if (!t.firstFrame && spark.activeSplats > 0) {
      t.firstFrame = performance.now();
      loading.hidden = true;
      setTimeout(() => setStage("rendering"), 5000); // survived 5 s: not a crash
    }
  }
  updateLoading(now);
  updateReadout(now);
});

// For headless checks (tools/check_app.py)
window.splatBench = { spark, mesh, t, get lodReady() { return lodReady; }, get stage() { return stage; } };
