// Spark test viewer on Spark 2.4.0. Loading follows Spark's streaming-lod
// example (reference/spark-2.4.0/examples/streaming-lod): a pre-built LOD tree
// (.rad, made with Spark's build-lod --quality --rad-chunked) loaded with
// SplatMesh({ url, paged: true }). Spark fetches only the chunks the current
// view needs, coarse first, into a fixed-size splat pool. This is the same idea
// SuperSplat uses for large scenes.
// Other patterns: SparkControls with rotateSpeed x2 (examples/lod), joystick on
// touch screens (examples/mobile-joystick). Budget and LOD scale controls mirror
// the local experiment viewer (hybrid_web).
import * as THREE from "three";
import { SparkRenderer, SplatMesh, SparkControls, isMobile, isIos, isAndroid } from "@sparkjsdev/spark";
import { createGpuTimer } from "./gpu_timer.js";
import { initMobileControls, getMobileInput, isMobileDevice } from "./joystick.js";

const $ = (id) => document.getElementById(id);
const num = (n) => (n == null ? "n/a" : Math.round(n).toLocaleString("en-US"));
const secs = (ms) => (ms == null ? "..." : `${(ms / 1000).toFixed(1)} s`);
const mb = (b) => (b == null ? "n/a" : b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GB` : `${(b / 1024 ** 2).toFixed(b < 10 * 1024 ** 2 ? 1 : 0)} MB`);
const millions = (n) => `${(n / 1e6).toFixed(1)}M`;
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
setStage("loading");

// Count streamed chunks and bytes. PagedSplats fetches chunks on the main
// thread, so the browser's resource timing sees every request.
const sourceDir = new URL(source.url, location.href).href.replace(/[^/]*$/, "");
const net = { chunks: new Set(), bytes: 0 };
performance.setResourceTimingBufferSize?.(10000);
new PerformanceObserver((list) => {
  for (const e of list.getEntries()) {
    if (!e.name.startsWith(sourceDir)) continue;
    net.bytes += e.encodedBodySize || e.transferSize || 0;
    if (e.name.endsWith(".radc")) net.chunks.add(e.name);
  }
}).observe({ type: "resource", buffered: true });

// ---------------------------------------------------------------- three
const canvas = $("canvas");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
// examples/streaming-lod: full pixel ratio on desktop, 1 on phones
renderer.setPixelRatio(mobile ? 1 : Math.min(devicePixelRatio, 2));
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

// Renderer settings from examples/streaming-lod
const spark = new SparkRenderer({
  renderer,
  pagedExtSplats: true,
  coneFov0: 70.0,
  coneFov: 120.0,
  behindFoveate: 0.2,
  coneFoveate: 0.4,
});
scene.add(spark);
const autoBase = spark.defaultSplatTarget();
const gpuTimer = createGpuTimer(renderer);
const gl = renderer.getContext();
const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
const gpuName = debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
let contextLost = false;
canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); contextLost = true; setStage("WebGL context lost"); });

// SparkControls polls navigator.getGamepads() every frame; some browsers and
// in-app web views lack it, which would throw inside the render loop.
if (typeof navigator.getGamepads !== "function") navigator.getGamepads = () => [];
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
const t = { start: performance.now(), firstFrame: null, sharp: null };
const loading = $("loading");
function fail(err) {
  console.error(err);
  loading.classList.add("error");
  $("load-title").textContent = `Could not load ${sceneDef.name}`;
  $("load-detail").textContent = String(err?.message ?? err);
  setStage("error");
}
const mesh = new SplatMesh({ url: source.url, paged: true }); // examples/streaming-lod
mesh.rotation.set(...sceneDef.rotationDeg.map(THREE.MathUtils.degToRad));
scene.add(mesh);
mesh.initialized.catch(fail);
setStage("streaming");

// Total LOD tree size from the .rad header (PagedSplats.radMetaPromise -> meta.count)
let treeNodes = null;
mesh.initialized.then(() => mesh.paged?.radMetaPromise?.then(({ meta }) => (treeNodes = meta.count))).catch(() => {});

// Memory reserved by the splat pool: Spark's pager backs each pool texture with
// a Uint32Array (the GPU holds a matching copy), so their sizes are exact.
function poolBytes() {
  const pager = spark.pager;
  if (!pager) return null;
  const textures = [pager.packedTexture?.value, pager.extTexture?.value, ...(pager.shTextures ?? []).map((t) => t.value)];
  return textures.reduce((sum, tex) => sum + (tex?.image?.data?.byteLength ?? 0), 0);
}

// Chunk loading state from Spark's pager: each filled page holds one chunk
const pagerState = () => {
  const pager = spark.pager;
  if (!pager) return null;
  return { resident: pager.pageToSplatsChunk.filter(Boolean).length, busy: pager.isFetching() || pager.hasQueued(), poolPages: Math.floor(spark.maxPagedSplats / 65536) };
};

// -------------------------------------------------------------- controls
const sceneSelect = $("scene"), budget = $("budget"), custom = $("custom"), scale = $("scale");
for (const s of catalog.scenes) sceneSelect.add(new Option(`${s.name} (${millions(s.splats)} splats)`, s.id));
sceneSelect.value = sceneDef.id;
sceneSelect.addEventListener("change", () => {
  writeStore(PENDING, null); // leaving on purpose, not a crash
  location.search = `?scene=${sceneSelect.value}`;
});
$("reset").addEventListener("click", resetView);

budget.querySelector('[value="auto"]').textContent = `Auto (${millions(autoBase)} on ${platform})`;
const PREFS = "splatbench.prefs.v4";
const saved = readStore(PREFS) ?? {};
if ([...budget.options].some((o) => o.value === saved.budget)) budget.value = saved.budget;
custom.value = String(saved.custom ?? autoBase);
scale.value = String(saved.scale ?? 1);

function applyLod() {
  $("custom-wrap").hidden = budget.value !== "custom";
  if (budget.value === "custom" && !custom.checkValidity()) return;
  spark.lodSplatCount = budget.value === "auto" ? undefined : Number(budget.value === "custom" ? custom.value : budget.value);
  spark.lodSplatScale = Number(scale.value);
  $("scale-out").value = `${spark.lodSplatScale.toFixed(1)}x`;
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
  const p = pagerState();
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
    ["Original (no LOD)", num(sceneDef.splats)],
    ["Drawn", t.firstFrame ? num(mesh.numSplats) : "..."],
    ["Budget", num((spark.lodSplatCount ?? autoBase) * spark.lodSplatScale)],
    ["LOD updates", `${(cutEvents.length / 2).toFixed(1)}/s`],
  ]]);
  // Streaming, in reading order: the whole tree, what came down, what is held
  S.push(["Streaming", [
    ["LOD tree", treeNodes ? `${num(treeNodes)} nodes, ${mb(source.bytes)}` : mb(source.bytes)],
    ["Downloaded", `${net.chunks.size} of ${source.chunks} chunks, ${mb(net.bytes)}`],
    ["In memory", p ? `${p.resident} of ${p.poolPages} chunks` : "..."],
    ["Status", p ? (p.busy ? "loading detail" : "idle") : "..."],
  ]]);
  const pool = poolBytes();
  S.push(["Memory", [
    ["Splat pool", `${millions(spark.maxPagedSplats)} splats${pool ? `, ${mb(pool)}` : ""}`],
    ["Whole tree fits in pool", treeNodes ? (treeNodes <= spark.maxPagedSplats ? "yes" : "no") : "..."],
    ["JS heap", heap ? mb(heap) : "n/a in this browser"],
  ]]);
  S.push(["Loading", [
    ["First view after", secs(t.firstFrame && t.firstFrame - t.start)],
    ["Full detail after", secs(t.sharp && t.sharp - t.start)],
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
  $("hud-summary").textContent = t.firstFrame ? `${fps} FPS, ${num(mesh.numSplats)} splats` : "Loading";
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
  $("load-title").textContent = `Loading ${sceneDef.name}`;
  $("load-detail").textContent = `${net.chunks.size} chunks, ${mb(net.bytes)}, ${secs(now - t.start)}`;
  $("load-bar").classList.add("busy");
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

  if (lastVersion !== null && mesh.mappingVersion !== lastVersion) cutEvents.push(now);
  lastVersion = mesh.mappingVersion;
  if (!t.firstFrame && spark.activeSplats > 0) {
    t.firstFrame = performance.now();
    loading.hidden = true;
    setTimeout(() => setStage("rendering"), 5000); // survived 5 s, so not a crash
  }
  // "Full detail": first moment after the first view when the pager has nothing left to fetch
  const p = pagerState();
  if (t.firstFrame && !t.sharp && p && !p.busy && now - t.firstFrame > 500) t.sharp = performance.now();

  updateLoading(now);
  updateHud(now);
});

// For the headless check (tools/check_app.py)
window.splatBench = { spark, mesh, t, net, pagerState };
