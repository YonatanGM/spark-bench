// Spark Splat Bench: a stress-test viewer for large Gaussian splat scenes.
//
// Spark setup follows the official 2.4.0 examples (copies in reference/):
// - SparkRenderer added to the scene, SplatMesh per file   (hello-world, lod)
// - lod / nonLod load options, live mesh.enableLod toggle    (lod, nonlod)
// - SparkControls with rotateSpeed x2                        (lod)
// - virtual joystick on touch devices                        (mobile-joystick)
// - spark.lodSplatCount / lodSplatScale / foveation knobs    (docs/lod-getting-started.md)
// - maxStdDev, antialias:false, pixel ratio                  (docs/performance.md)
import * as THREE from "three";
import { SparkRenderer, SplatMesh, SparkControls, SplatFileType, isMobile, isIos, isAndroid } from "@sparkjsdev/spark";
import { createGpuTimer } from "./gpu_timer.js";
import { FrameStats, RateCounter } from "./stats.js";
import { BenchRun, poseAt, setPose } from "./bench.js";
import { initMobileControls, getMobileInput, isMobileDevice, setMobileControlsEnabled } from "./joystick.js";

const APP_VERSION = "0.1.0";
const SPARK_VERSION = "2.4.0";
const $ = (id) => document.getElementById(id);
const fmtInt = (n) => (n == null || !Number.isFinite(n) ? "—" : Math.round(n).toLocaleString("en-US"));
const fmtMs = (n, d = 1) => (n == null ? "—" : `${n.toFixed(d)} ms`);
const fmtMB = (b) => (b == null ? "—" : `${(b / 1048576).toFixed(b < 100 * 1048576 ? 1 : 0)} MB`);
const fmtS = (ms) => (ms == null ? "—" : `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`);
const fmtCompact = (n) => (n == null ? "—" : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

// ---------------------------------------------------------------- config
const params = new URLSearchParams(location.search);
const catalog = await (await fetch("scenes/scenes.json", { cache: "no-cache" })).json();
const sceneDef = catalog.scenes.find((s) => s.id === params.get("scene")) ?? catalog.scenes[0];
const source = sceneDef.sources.find((s) => s.id === params.get("src")) ?? sceneDef.sources[0];
// isMobile() is false whenever navigator.platform is Windows (also in Chrome's
// phone emulation), so the UA checks are added for emulated test runs.
const mobile = isMobile() || isIos() || isAndroid();
const num = (key, fallback) => {
  const v = Number.parseFloat(params.get(key));
  return Number.isFinite(v) ? v : fallback;
};
const pick = (key, allowed, fallback) => (allowed.includes(params.get(key)) ? params.get(key) : fallback);
const cfg = {
  lodMode: pick("lod", ["quick", "quality", "none"], "quick"),
  // Keeping the original next to the LOD tree enables live LOD on/off (nonlod
  // example) but roughly doubles splat memory, so phones default to off.
  keepOriginal: params.has("keep") ? params.get("keep") === "1" : !mobile,
  lodOn: params.get("lodon") !== "0",
  budget: params.get("budget") ?? "auto",
  scale: num("scale", 1),
  minPx: num("minpx", 1),
  fovea: pick("fovea", ["default", "off", "strong"], "default"),
  dpr: num("dpr", Math.min(devicePixelRatio, 2)),
  stddev: num("stddev", Math.sqrt(8)),
  fov: num("fov", sceneDef.camera.fov),
  speed: num("speed", 1),
  joystick: params.has("joy") ? params.get("joy") === "1" : isMobileDevice(),
  autoBench: params.get("bench") === "1",
};
const hasLod = cfg.lodMode !== "none";
const canToggleLod = hasLod && cfg.keepOriginal;

// ------------------------------------------- crash detection across reloads
// iOS Safari kills tabs that use too much memory and reloads them. A marker
// written before loading and cleared once rendering is stable reveals that.
const PENDING_KEY = "sparkbench.pending";
const store = {
  get(k) {
    try { return JSON.parse(localStorage.getItem(k)); } catch { return null; }
  },
  set(k, v) {
    try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {}
  },
};
const previousCrash = store.get(PENDING_KEY);
const pending = { scene: sceneDef.id, src: source.id, lod: cfg.lodMode, keep: cfg.keepOriginal, dpr: cfg.dpr, at: new Date().toISOString(), stage: "start" };
const setStage = (stage) => {
  pending.stage = stage;
  store.set(PENDING_KEY, pending);
};

function showBanner(html, { dismiss = true } = {}) {
  const el = $("banner");
  el.innerHTML = html + (dismiss ? ' <button type="button">OK</button>' : "");
  el.hidden = false;
  el.querySelector("button")?.addEventListener("click", () => (el.hidden = true));
}
if (previousCrash) {
  const s = catalog.scenes.find((x) => x.id === previousCrash.scene);
  showBanner(`The last load (${s?.title ?? previousCrash.scene}, LOD ${previousCrash.lod}${previousCrash.keep ? " + original" : ""}) never finished. It stopped during <b>${previousCrash.stage}</b>, so the tab most likely crashed or ran out of memory. This is included in the report.`);
}

// ----------------------------------------------------------------- three
const canvas = $("canvas");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
renderer.setPixelRatio(cfg.dpr);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(cfg.fov, 1, 0.01, 2000);
setPose(camera, sceneDef.camera);

function resize() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  renderer.setPixelRatio(cfg.dpr);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas);
resize();

const spark = new SparkRenderer({ renderer, maxStdDev: cfg.stddev });
scene.add(spark);
const FOVEA = {
  default: { coneFov0: spark.coneFov0, coneFov: spark.coneFov, coneFoveate: spark.coneFoveate, behindFoveate: spark.behindFoveate },
  off: { coneFov0: 0, coneFov: 0, coneFoveate: 1, behindFoveate: 1 },
  strong: { coneFov0: 60, coneFov: 100, coneFoveate: 0.3, behindFoveate: 0.1 },
};

const gpuTimer = createGpuTimer(renderer);
const gl = renderer.getContext();
const dbg = gl.getExtension("WEBGL_debug_renderer_info");
const device = {
  gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
  gpuVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
  maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
  maxArrayTextureLayers: gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS),
  gpuTimerQuery: gpuTimer.supported,
  devicePixelRatio: devicePixelRatio,
  screen: [screen.width, screen.height],
  cpuThreads: navigator.hardwareConcurrency ?? null,
  deviceMemoryGB: navigator.deviceMemory ?? null,
  userAgent: navigator.userAgent,
  sparkPlatform: isIos() ? "ios" : isAndroid() ? "android" : mobile ? "mobile" : "desktop",
  sparkDefaultBudget: spark.defaultSplatTarget(),
};

let contextLost = 0;
canvas.addEventListener("webglcontextlost", (e) => {
  e.preventDefault();
  contextLost++;
  setStage("webgl-context-lost");
  showBanner("WebGL context lost: the GPU driver reset, usually from running out of GPU memory. Reload to try again with a smaller budget or pixel ratio.", { dismiss: false });
});

// -------------------------------------------------------------- controls
const controls = new SparkControls({ canvas });
controls.pointerControls.rotateSpeed *= 2.0; // as in examples/lod
const base = {
  move: controls.fpsMovement.moveSpeed,
  slide: controls.pointerControls.slideSpeed,
  scroll: controls.pointerControls.scrollSpeed,
};
function applySpeed() {
  const k = (sceneDef.moveSpeed ?? 1) * cfg.speed;
  controls.fpsMovement.moveSpeed = base.move * k;
  controls.pointerControls.slideSpeed = base.slide * k;
  controls.pointerControls.scrollSpeed = base.scroll * k;
}
function applyJoystick() {
  if (cfg.joystick) {
    initMobileControls({ joystickSize: 120, knobSize: 50, marginLeft: 24, marginBottom: 28 });
    setMobileControlsEnabled(true);
  } else {
    setMobileControlsEnabled(false);
  }
  document.body.classList.toggle("has-joystick", cfg.joystick);
}

// ------------------------------------------------------------ live knobs
function applyLiveSettings() {
  spark.lodSplatCount = cfg.budget === "auto" ? undefined : Number(cfg.budget);
  spark.lodSplatScale = cfg.scale;
  spark.lodRenderScale = cfg.minPx;
  Object.assign(spark, FOVEA[cfg.fovea]);
  spark.maxStdDev = cfg.stddev;
  camera.fov = cfg.fov;
  camera.updateProjectionMatrix();
  resize();
  applySpeed();
  if (mesh && canToggleLod) {
    // examples/nonlod: flip enableLod on a mesh loaded with lod+nonLod, then updateVersion()
    mesh.enableLod = cfg.lodOn;
    mesh.updateVersion();
  }
}
const effectiveBudget = () => (spark.lodSplatCount ?? spark.defaultSplatTarget()) * spark.lodSplatScale;
const lodActive = () => hasLod && (!canToggleLod || cfg.lodOn);

// ------------------------------------------------------------ load scene
const timing = { start: performance.now(), firstByte: null, downloadEnd: null, initialized: null, firstFrame: null };
const net = { bytes: 0, total: source.bytes, partsDone: 0, parts: source.parts.length };

// The .sog is split into <50 MB parts for GitHub. This joins them back into
// one ReadableStream for SplatMesh({ stream, streamLength }); Spark's worker
// pulls chunks from it and decodes the whole file. Not LOD streaming.
function joinedStream(urls) {
  let index = 0;
  let reader = null;
  return new ReadableStream({
    async pull(controller) {
      for (;;) {
        if (!reader) {
          if (index >= urls.length) {
            timing.downloadEnd = performance.now();
            controller.close();
            return;
          }
          const response = await fetch(urls[index++]);
          if (!response.ok || !response.body) throw new Error(`Failed to fetch ${urls[index - 1]}: ${response.status}`);
          reader = response.body.getReader();
        }
        const { done, value } = await reader.read();
        if (done) {
          reader = null;
          net.partsDone++;
          continue;
        }
        if (timing.firstByte == null) timing.firstByte = performance.now();
        net.bytes += value.byteLength;
        controller.enqueue(value);
        return;
      }
    },
  });
}

const loadEl = $("loading");
function loadUi(title, detail, fraction) {
  $("load-title").textContent = title;
  $("load-detail").textContent = detail;
  const bar = $("load-bar");
  bar.classList.toggle("indeterminate", fraction == null);
  if (fraction != null) bar.style.width = `${Math.round(fraction * 100)}%`;
}
function loadError(err) {
  console.error(err);
  loadEl.classList.add("error");
  loadUi("Failed to load", String(err?.message ?? err), 0);
  setStage("error");
}

let mesh = null;
setStage("download");
try {
  mesh = new SplatMesh({
    stream: joinedStream(source.parts),
    streamLength: source.bytes,
    fileName: source.fileName,
    fileType: SplatFileType.PCSOGSZIP,
    lod: cfg.lodMode === "quality" ? "quality" : hasLod,
    nonLod: canToggleLod,
  });
  const [rx, ry, rz] = sceneDef.rotationDeg.map(THREE.MathUtils.degToRad);
  mesh.rotation.set(rx, ry, rz);
  scene.add(mesh);
  mesh.initialized.then(
    () => {
      timing.initialized = performance.now();
      setStage("first-frame");
      applyLiveSettings();
    },
    loadError,
  );
} catch (err) {
  loadError(err);
}

function updateLoadingOverlay(now) {
  if (timing.firstFrame) return;
  if (loadEl.classList.contains("error")) return;
  const elapsed = fmtS(now - timing.start);
  if (!timing.downloadEnd) {
    loadUi(`Downloading ${sceneDef.title}`, `${fmtMB(net.bytes)} / ${fmtMB(net.total)} · part ${Math.min(net.partsDone + 1, net.parts)} of ${net.parts}\n${elapsed}`, net.bytes / net.total);
  } else if (!timing.initialized) {
    if (pending.stage !== "decode") setStage("decode");
    const what = hasLod ? `Decoding + building ${cfg.lodMode} LOD tree in a worker` : "Decoding splats";
    loadUi(what, `${fmtInt(sceneDef.splats)} splats · ${fmtS(now - timing.downloadEnd)}\n(no progress events for this step)`, null);
  } else {
    loadUi("Preparing first frame", hasLod ? "Waiting for the first LOD selection" : "Uploading to GPU", null);
  }
}

// -------------------------------------------------------------- metrics
const frameStats = new FrameStats(2000);
const cutRate = new RateCounter(2000);
let lastMappingVersion = null;
let stableSince = null;

function arrayBytes(splats) {
  if (!splats) return 0;
  let b = splats.packedArray?.byteLength ?? 0;
  for (const a of splats.extArrays ?? []) b += a?.byteLength ?? 0;
  for (const k of ["sh1", "sh2", "sh3"]) {
    const a = splats.extra?.[k];
    if (ArrayBuffer.isView(a)) b += a.byteLength;
  }
  return b;
}
function counts() {
  if (!mesh || !timing.initialized) return null;
  const original = mesh.packedSplats ?? mesh.extSplats;
  const tree = original?.lodSplats ?? null;
  const originalCount = original?.packedArray || original?.extArrays ? original.numSplats : 0;
  return {
    drawn: mesh.numSplats, // SplatMesh: current LOD cut when LOD is active, else all splats
    rendered: spark.activeSplats,
    originalLoaded: originalCount || null,
    lodTreeNodes: tree?.numSplats ?? null,
    lodActive: lodActive(),
    budget: lodActive() ? Math.round(effectiveBudget()) : null,
    splatArrayBytes: arrayBytes(original) + (tree && tree !== original ? arrayBytes(tree) : 0),
  };
}
const jsHeap = () => performance.memory?.usedJSHeapSize ?? null;

function loadSummary() {
  const t = timing;
  const d = (a, b) => (a != null && b != null ? Math.round(b - a) : null);
  return {
    downloadMs: d(t.start, t.downloadEnd),
    decodeAndLodMs: d(t.downloadEnd, t.initialized),
    firstFrameMs: d(t.initialized, t.firstFrame),
    totalMs: d(t.start, t.firstFrame),
    bytes: net.bytes,
    mbPerSecond: t.downloadEnd ? Number(((net.bytes / 1048576) / ((t.downloadEnd - t.start) / 1000)).toFixed(1)) : null,
  };
}

// -------------------------------------------------------------------- HUD
const hud = $("hud");
const hudBody = $("hud-body");
if (mobile) hud.classList.add("collapsed");
$("hud-toggle").addEventListener("click", () => hud.classList.toggle("collapsed"));
let lastHud = 0;
const row = (k, v, cls = "") => `<div class="row"><span class="k">${k}</span><span class="${cls}">${v}</span></div>`;

function updateHud(now) {
  if (now - lastHud < 250) return;
  lastHud = now;
  const f = frameStats.summary();
  const c = counts();
  const fpsCls = !f ? "" : f.fps >= 50 ? "good" : f.fps >= 28 ? "warnc" : "badc";
  $("hud-fps").textContent = f ? `${f.fps.toFixed(0)} FPS` : "— FPS";
  $("hud-fps").className = fpsCls;
  $("hud-brief").textContent = f ? `p95 ${f.p95.toFixed(1)} ms · ${c ? fmtCompact(c.drawn) : "—"} splats` : "";
  if (hud.classList.contains("collapsed")) return;

  const gpu = gpuTimer.milliseconds;
  const L = loadSummary();
  const heap = jsHeap();
  const lines = [];
  lines.push('<div class="sec">');
  lines.push(row("Frame p50 / p95", f ? `${f.p50.toFixed(1)} / ${f.p95.toFixed(1)} ms` : "—"));
  lines.push(row("Worst frame · slow frames", f ? `${f.max.toFixed(0)} ms · ${(f.slowShare * 100).toFixed(1)}%` : "—", f && f.slowShare > 0.05 ? "warnc" : ""));
  lines.push(row("GPU time", gpuTimer.supported ? fmtMs(gpu, 2) : "n/a on this browser"));
  lines.push("</div><div class=\"sec\">");
  if (c) {
    lines.push(row(c.lodActive ? "LOD cut (drawn)" : "Drawn (all splats)", fmtInt(c.drawn)));
    if (c.lodActive) {
      const baseTxt = spark.lodSplatCount == null ? `auto ${fmtCompact(spark.defaultSplatTarget())}` : fmtCompact(spark.lodSplatCount);
      lines.push(row("Budget", `${fmtInt(c.budget)} <span class="k">(${baseTxt} × ${spark.lodSplatScale.toFixed(1)})</span>`));
      lines.push(row("LOD updates", `${cutRate.perSecond(now).toFixed(1)}/s · last ${cutRate.lastAt ? fmtS(now - cutRate.lastAt) : "—"} ago`));
    }
    lines.push(row("File splats", fmtInt(sceneDef.splats)));
    if (c.lodTreeNodes) lines.push(row("LOD tree nodes", fmtInt(c.lodTreeNodes)));
  } else {
    lines.push(row("Splats", "loading…"));
  }
  lines.push("</div><div class=\"sec\">");
  lines.push(row("Splat arrays (allocated)", c ? fmtMB(c.splatArrayBytes) : "—"));
  lines.push(row("JS heap", heap != null ? fmtMB(heap) : "n/a (Chrome only)"));
  lines.push("</div><div class=\"sec\">");
  lines.push(row("Download", L.downloadMs != null ? `${fmtS(L.downloadMs)} · ${fmtMB(L.bytes)} · ${L.mbPerSecond} MB/s` : "…"));
  lines.push(row(hasLod ? "Decode + LOD build" : "Decode", fmtS(L.decodeAndLodMs)));
  lines.push(row("First frame after", fmtS(L.firstFrameMs)));
  lines.push(row("Total to first frame", fmtS(L.totalMs)));
  lines.push("</div><div class=\"sec\">");
  lines.push(row("GPU", `<span title="${device.gpu}">${device.gpu.length > 34 ? device.gpu.slice(0, 33) + "…" : device.gpu}</span>`));
  lines.push(row("Pixels", `${renderer.domElement.width}×${renderer.domElement.height} @ ${cfg.dpr.toFixed(2)}×`));
  lines.push(row("Load mode", `${hasLod ? `LOD ${cfg.lodMode}` : "no LOD"}${canToggleLod ? " + original" : ""}`));
  if (contextLost) lines.push(row("Context lost", String(contextLost), "badc"));
  lines.push("</div>");
  hudBody.innerHTML = lines.join("");
}

// ------------------------------------------------------------- benchmark
let bench = null;
let userPose = null;
let gpuUnsub = null;

function startBench() {
  if (!timing.firstFrame || bench) return;
  closePanel();
  userPose = { position: camera.position.clone(), quaternion: camera.quaternion.clone() };
  bench = new BenchRun({ warmupMs: 2000, durationMs: 15000 });
  gpuUnsub = gpuTimer.onSample((ms) => bench?.addGpuSample(ms));
  $("bench-button").disabled = true;
}
function finishBench() {
  const result = bench.result();
  bench = null;
  gpuUnsub?.();
  camera.position.copy(userPose.position);
  camera.quaternion.copy(userPose.quaternion);
  $("bench-button").disabled = false;
  $("bench-button").textContent = "Run benchmark";
  showReport(buildReport(result), "Benchmark result");
}

// --------------------------------------------------------------- report
function shareParams() {
  const p = new URLSearchParams();
  p.set("scene", sceneDef.id);
  p.set("src", source.id);
  p.set("lod", cfg.lodMode);
  p.set("keep", cfg.keepOriginal ? "1" : "0");
  if (canToggleLod && !cfg.lodOn) p.set("lodon", "0");
  if (cfg.budget !== "auto") p.set("budget", cfg.budget);
  if (cfg.scale !== 1) p.set("scale", String(cfg.scale));
  if (cfg.minPx !== 1) p.set("minpx", String(cfg.minPx));
  if (cfg.fovea !== "default") p.set("fovea", cfg.fovea);
  p.set("dpr", String(cfg.dpr));
  if (Math.abs(cfg.stddev - Math.sqrt(8)) > 1e-3) p.set("stddev", String(cfg.stddev));
  if (cfg.fov !== sceneDef.camera.fov) p.set("fov", String(cfg.fov));
  return p;
}
const shareUrl = () => `${location.origin}${location.pathname}?${shareParams()}`;

function buildReport(benchResult = null) {
  const f = frameStats.summary();
  const c = counts();
  const r = (v, d = 2) => (v == null ? null : Number(v.toFixed(d)));
  return {
    app: { name: "spark-bench", version: APP_VERSION, spark: SPARK_VERSION, three: `r${THREE.REVISION}` },
    time: new Date().toISOString(),
    url: shareUrl(),
    scene: { id: sceneDef.id, title: sceneDef.title, source: source.id, fileSplats: sceneDef.splats, fileBytes: source.bytes, shDegree: sceneDef.shDegree },
    loadMode: { lod: cfg.lodMode, keepOriginal: cfg.keepOriginal },
    settings: {
      lodOn: lodActive(),
      baseBudget: spark.lodSplatCount ?? `auto(${spark.defaultSplatTarget()})`,
      lodScale: spark.lodSplatScale,
      effectiveBudget: hasLod ? Math.round(effectiveBudget()) : null,
      minSplatPx: spark.lodRenderScale,
      foveation: cfg.fovea,
      maxStdDev: r(spark.maxStdDev, 4),
      pixelRatio: cfg.dpr,
      drawingBuffer: [renderer.domElement.width, renderer.domElement.height],
      fov: cfg.fov,
    },
    device,
    load: loadSummary(),
    live: {
      fps: f ? r(f.fps, 1) : null,
      frameP50Ms: f ? r(f.p50) : null,
      frameP95Ms: f ? r(f.p95) : null,
      gpuMs: r(gpuTimer.milliseconds),
      drawnSplats: c?.drawn ?? null,
      sparkActiveSplats: c?.rendered ?? null, // instances after the last depth sort; refreshes only when Spark re-sorts
      lodTreeNodes: c?.lodTreeNodes ?? null,
      lodUpdatesPerSec: r(cutRate.perSecond(performance.now()), 1),
    },
    memory: { splatArraysAllocatedMB: c ? r(c.splatArrayBytes / 1048576, 1) : null, jsHeapMB: jsHeap() != null ? r(jsHeap() / 1048576, 1) : null },
    events: { webglContextLost: contextLost, previousLoadDidNotFinish: previousCrash },
    benchmark: benchResult,
  };
}

let currentReport = null;
function showReport(report, title) {
  currentReport = report;
  $("report-title").textContent = title;
  const b = report.benchmark;
  const rows = [];
  const tr = (k, v) => rows.push(`<tr><td>${k}</td><td>${v ?? "—"}</td></tr>`);
  tr("Scene", `${report.scene.title} · ${report.loadMode.lod === "none" ? "no LOD" : `LOD ${report.loadMode.lod}`}`);
  tr("Device", `${report.device.gpu} · DPR ${report.device.devicePixelRatio} → ${report.settings.pixelRatio}`);
  if (b) {
    tr("Avg FPS", b.fpsAvg);
    tr("Frame p50 / p95 / p99", `${b.frameMs.p50} / ${b.frameMs.p95} / ${b.frameMs.p99} ms`);
    tr("Slow frames (&lt;30 FPS)", `${b.slowFramesPct}% · ${b.framesOver50ms} over 50 ms`);
    tr("GPU ms (median / p95)", b.gpuMs ? `${b.gpuMs.median} / ${b.gpuMs.p95}` : "n/a");
    tr("LOD cut min / mean / max", b.lodCut ? `${fmtInt(b.lodCut.min)} / ${fmtInt(b.lodCut.mean)} / ${fmtInt(b.lodCut.max)}` : "n/a");
  } else {
    tr("FPS · p95", `${report.live.fps} · ${report.live.frameP95Ms} ms`);
    tr("Drawn splats", fmtInt(report.live.drawnSplats));
  }
  tr("Effective budget", fmtInt(report.settings.effectiveBudget));
  tr("Load: download · decode+LOD · total", `${fmtS(report.load.downloadMs)} · ${fmtS(report.load.decodeAndLodMs)} · ${fmtS(report.load.totalMs)}`);
  tr("Splat arrays (allocated)", `${report.memory.splatArraysAllocatedMB} MB`);
  $("report-summary").innerHTML = `<table>${rows.join("")}</table>`;
  const json = JSON.stringify(report, null, 2);
  $("report-json").value = json;
  const issue = $("report-issue");
  if (catalog.reportIssueUrl) {
    const t = `Bench: ${report.scene.id} on ${report.device.gpu}`.slice(0, 120);
    issue.href = `${catalog.reportIssueUrl}?title=${encodeURIComponent(t)}&body=${encodeURIComponent("```json\n" + json + "\n```")}`;
    issue.hidden = false;
  }
  $("report").showModal();
}
$("report-copy").addEventListener("click", async () => {
  const text = $("report-json").value;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    $("report-json").select();
    document.execCommand("copy");
  }
  $("report-copy").textContent = "Copied";
  setTimeout(() => ($("report-copy").textContent = "Copy JSON"), 1500);
});
$("report-download").addEventListener("click", () => {
  const blob = new Blob([$("report-json").value], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `spark-bench-${sceneDef.id}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

// ------------------------------------------------------------ settings UI
const panel = $("panel");
function openPanel() {
  panel.hidden = false;
  $("settings-toggle").setAttribute("aria-expanded", "true");
}
function closePanel() {
  panel.hidden = true;
  $("settings-toggle").setAttribute("aria-expanded", "false");
}
$("settings-toggle").addEventListener("click", () => (panel.hidden ? openPanel() : closePanel()));
$("panel-close").addEventListener("click", closePanel);

const sceneSelect = $("scene-select");
const sourceSelect = $("source-select");
for (const s of catalog.scenes) sceneSelect.add(new Option(`${s.title} · ${fmtCompact(s.splats)}`, s.id));
sceneSelect.value = sceneDef.id;
function fillSources() {
  const s = catalog.scenes.find((x) => x.id === sceneSelect.value);
  sourceSelect.replaceChildren(...s.sources.map((x) => new Option(x.label, x.id)));
  if (s === sceneDef) sourceSelect.value = source.id;
  updateLoadWarning();
}
const lodModeSelect = $("lodmode-select");
const keepBox = $("keep-original");
lodModeSelect.value = cfg.lodMode;
keepBox.checked = cfg.keepOriginal;
function updateLoadWarning() {
  const s = catalog.scenes.find((x) => x.id === sceneSelect.value);
  const warn = [];
  if (lodModeSelect.value === "none" && s.splats > 3e6) warn.push(`Renders all ${fmtCompact(s.splats)} splats every frame. Phones will likely run out of memory.`);
  if (lodModeSelect.value !== "none" && keepBox.checked && mobile) warn.push("Keeping the original roughly doubles splat memory on this phone.");
  if (lodModeSelect.value === "quality") warn.push("Quality LOD takes noticeably longer to build.");
  keepBox.disabled = lodModeSelect.value === "none";
  $("load-warning").textContent = warn.join(" ");
  $("load-warning").hidden = !warn.length;
}
sceneSelect.addEventListener("change", fillSources);
lodModeSelect.addEventListener("change", updateLoadWarning);
keepBox.addEventListener("change", updateLoadWarning);
fillSources();
$("load-button").addEventListener("click", () => {
  const p = shareParams();
  p.set("scene", sceneSelect.value);
  p.set("src", sourceSelect.value);
  p.set("lod", lodModeSelect.value);
  p.set("keep", keepBox.checked ? "1" : "0");
  p.delete("lodon");
  if (sceneSelect.value !== sceneDef.id) p.delete("fov");
  store.set(PENDING_KEY, null); // leaving on purpose, not a crash
  location.search = p.toString();
});

// LOD knobs
const budgetSelect = $("budget-select");
const budgetCustom = $("budget-custom");
budgetSelect.querySelector('[value="auto"]').textContent = `Auto (Spark ${device.sparkPlatform}: ${fmtCompact(spark.defaultSplatTarget())})`;
if (cfg.budget === "auto" || budgetSelect.querySelector(`[value="${cfg.budget}"]`)) budgetSelect.value = cfg.budget;
else {
  budgetSelect.value = "custom";
  budgetCustom.value = cfg.budget;
}
budgetCustom.value ||= String(spark.defaultSplatTarget());
$("budget-custom-wrap").hidden = budgetSelect.value !== "custom";
function syncUrl() {
  history.replaceState(null, "", `?${shareParams()}`);
}
function onBudget() {
  $("budget-custom-wrap").hidden = budgetSelect.value !== "custom";
  if (budgetSelect.value === "custom") {
    if (!budgetCustom.checkValidity() || !budgetCustom.value) return;
    cfg.budget = String(Math.round(Number(budgetCustom.value)));
  } else cfg.budget = budgetSelect.value;
  applyLiveSettings();
  syncUrl();
}
budgetSelect.addEventListener("change", onBudget);
budgetCustom.addEventListener("change", onBudget);

function bindRange(id, key, fmt) {
  const input = $(id);
  const out = $(`${id}-out`);
  input.value = String(cfg[key]);
  const show = () => (out.value = fmt(Number(input.value)));
  show();
  input.addEventListener("input", () => {
    cfg[key] = Number(input.value);
    show();
    applyLiveSettings();
  });
  input.addEventListener("change", syncUrl);
}
$("dpr").max = String(Math.max(1, devicePixelRatio));
bindRange("scale", "scale", (v) => `${v.toFixed(1)}×`);
bindRange("minpx", "minPx", (v) => `${v.toFixed(1)} px`);
bindRange("dpr", "dpr", (v) => `${v.toFixed(2)}×`);
bindRange("fov", "fov", (v) => `${v.toFixed(0)}°`);
bindRange("speed", "speed", (v) => `${v.toFixed(1)}×`);

const foveaSelect = $("fov-select");
foveaSelect.value = cfg.fovea;
foveaSelect.addEventListener("change", () => {
  cfg.fovea = foveaSelect.value;
  applyLiveSettings();
  syncUrl();
});
const stddevSelect = $("stddev-select");
stddevSelect.value = [...stddevSelect.options].reduce((best, o) => (Math.abs(Number(o.value) - cfg.stddev) < Math.abs(Number(best) - cfg.stddev) ? o.value : best), stddevSelect.options[0].value);
stddevSelect.addEventListener("change", () => {
  cfg.stddev = Number(stddevSelect.value);
  applyLiveSettings();
  syncUrl();
});
const lodOnBox = $("lod-enabled");
lodOnBox.checked = cfg.lodOn;
$("lod-enabled-wrap").hidden = !canToggleLod;
lodOnBox.addEventListener("change", () => {
  cfg.lodOn = lodOnBox.checked;
  applyLiveSettings();
  syncUrl();
});
$("lod-fieldset").disabled = !hasLod;
const joyBox = $("joystick");
joyBox.checked = cfg.joystick;
joyBox.addEventListener("change", () => {
  cfg.joystick = joyBox.checked;
  applyJoystick();
});
$("reset-view").addEventListener("click", () => setPose(camera, sceneDef.camera));
$("bench-button").addEventListener("click", startBench);
$("snapshot-button").addEventListener("click", () => showReport(buildReport(), "Current state"));
$("share-button").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(shareUrl());
    $("share-button").textContent = "Link copied";
  } catch {
    prompt("Copy this link", shareUrl());
  }
  setTimeout(() => ($("share-button").textContent = "Copy link with these settings"), 1500);
});
$("versions").textContent = `spark-bench ${APP_VERSION} · Spark ${SPARK_VERSION} · three r${THREE.REVISION}`;
$("credit").innerHTML = `<a href="${sceneDef.sourceUrl}" target="_blank" rel="noopener">${sceneDef.title}</a> by <a href="${sceneDef.authorUrl}" target="_blank" rel="noopener">${sceneDef.author}</a> · <a href="${sceneDef.licenseUrl}" target="_blank" rel="noopener">${sceneDef.license}</a>`;

applyJoystick();
applyLiveSettings();

// ------------------------------------------------------------ main loop
const move = new THREE.Vector3();
let lastLoop = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min((now - lastLoop) / 1000, 0.1);
  lastLoop = now;
  frameStats.push(now);

  if (bench) {
    const ph = bench.phase(now);
    if (ph.stage === "done") finishBench();
    else {
      if (ph.stage === "settle") setPose(camera, sceneDef.camera);
      else poseAt(camera, sceneDef.camera, sceneDef.bench, ph.u);
      $("bench-button").textContent = `Running… ${Math.round(ph.progress * 100)}%`;
    }
  } else {
    controls.update(camera);
    if (cfg.joystick) {
      // examples/mobile-joystick: move along the camera's facing direction
      const input = getMobileInput();
      if (input.x !== 0 || input.y !== 0) {
        move.set(input.x, 0, input.y).multiplyScalar(controls.fpsMovement.moveSpeed * dt).applyQuaternion(camera.quaternion);
        camera.position.add(move);
      }
    }
  }

  gpuTimer.render(() => renderer.render(scene, camera));

  let cutDelta = 0;
  if (mesh && timing.initialized) {
    if (lodActive() && lastMappingVersion !== null && mesh.mappingVersion !== lastMappingVersion) {
      cutDelta = Math.max(1, mesh.mappingVersion - lastMappingVersion);
      cutRate.add(now, cutDelta);
    }
    lastMappingVersion = mesh.mappingVersion;
    if (!timing.firstFrame && spark.activeSplats > 0) {
      timing.firstFrame = performance.now();
      setStage("rendering");
      loadEl.classList.add("done");
      stableSince = now;
      if (cfg.autoBench) setTimeout(startBench, 1000);
    }
    if (stableSince && now - stableSince > 5000) {
      store.set(PENDING_KEY, null); // rendered for 5 s: this load did not crash
      stableSince = null;
    }
  }
  if (bench) bench.record(now, { cut: lodActive() ? mesh?.numSplats : null, rendered: spark.activeSplats, cutUpdates: cutDelta });

  updateLoadingOverlay(now);
  updateHud(now);
});

// Expose for automated checks in tools/check_app.py
window.sparkBench = { spark, get mesh() { return mesh; }, timing, cfg, counts, buildReport, startBench, get benchRunning() { return !!bench; } };
