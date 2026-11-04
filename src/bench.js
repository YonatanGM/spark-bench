// Fixed, repeatable camera path relative to the scene's authored start pose,
// so results from different devices fly the same route.
import * as THREE from "three";
import { percentile, mean, SLOW_FRAME_MS } from "./stats.js";

const Y = new THREE.Vector3(0, 1, 0);
const rad = THREE.MathUtils.degToRad;

export function setPose(camera, pose) {
  camera.position.fromArray(pose.position);
  camera.up.copy(Y);
  camera.lookAt(new THREE.Vector3().fromArray(pose.target));
}

// u in [0, 1]. "orbit" circles the target; "walk" looks around and steps
// forward from the start position (for interiors, where orbiting would pass
// through walls).
export function poseAt(camera, pose, bench, u) {
  const p0 = new THREE.Vector3().fromArray(pose.position);
  const target = new THREE.Vector3().fromArray(pose.target);
  const wave = Math.sin(2 * Math.PI * u);
  const bump = Math.sin(Math.PI * u) ** 2;
  if (bench.type === "orbit") {
    const offset = p0.clone().sub(target);
    offset.applyAxisAngle(Y, rad(bench.yawDeg ?? 60) * wave);
    offset.multiplyScalar(1 - (bench.dolly ?? 0) * bump);
    camera.position.copy(target).add(offset);
    camera.up.copy(Y);
    camera.lookAt(target);
    return;
  }
  const dir = target.clone().sub(p0).normalize();
  camera.position.copy(p0).addScaledVector(dir, (bench.distance ?? 0) * bump);
  const look = dir.clone().applyAxisAngle(Y, rad(bench.yawDeg ?? 45) * wave);
  const right = new THREE.Vector3().crossVectors(look, Y).normalize();
  look.applyAxisAngle(right, rad(bench.pitchDeg ?? 0) * Math.sin(4 * Math.PI * u));
  camera.up.copy(Y);
  camera.lookAt(camera.position.clone().add(look));
}

export class BenchRun {
  constructor({ warmupMs = 2000, durationMs = 15000 } = {}) {
    this.warmupMs = warmupMs;
    this.durationMs = durationMs;
    this.t0 = performance.now();
    this.frames = [];
    this.gpu = [];
    this.cuts = [];
    this.rendered = [];
    this.cutUpdates = 0;
    this.lastFrame = null;
  }
  phase(now) {
    const t = now - this.t0;
    if (t < this.warmupMs) return { stage: "settle", u: 0, progress: t / (this.warmupMs + this.durationMs) };
    const u = (t - this.warmupMs) / this.durationMs;
    return { stage: u >= 1 ? "done" : "run", u: Math.min(u, 1), progress: t / (this.warmupMs + this.durationMs) };
  }
  record(now, { cut, rendered, cutUpdates }) {
    if (this.phase(now).stage !== "run") {
      this.lastFrame = now;
      return;
    }
    if (this.lastFrame !== null) this.frames.push(now - this.lastFrame);
    this.lastFrame = now;
    if (cut != null) this.cuts.push(cut);
    if (rendered != null) this.rendered.push(rendered);
    this.cutUpdates += cutUpdates;
  }
  addGpuSample(ms) {
    if (this.phase(performance.now()).stage === "run") this.gpu.push(ms);
  }
  result() {
    const f = this.frames;
    const total = f.reduce((a, b) => a + b, 0);
    const r = (v, d = 2) => (v == null ? null : Number(v.toFixed(d)));
    return {
      durationMs: Math.round(total),
      frames: f.length,
      fpsAvg: r((f.length * 1000) / total, 1),
      frameMs: { p50: r(percentile(f, 50)), p90: r(percentile(f, 90)), p95: r(percentile(f, 95)), p99: r(percentile(f, 99)), max: r(Math.max(...f)) },
      slowFramesPct: r((100 * f.filter((d) => d > SLOW_FRAME_MS).length) / f.length, 1),
      framesOver50ms: f.filter((d) => d > 50).length,
      gpuMs: this.gpu.length ? { median: r(percentile(this.gpu, 50)), p95: r(percentile(this.gpu, 95)), samples: this.gpu.length } : null,
      lodCut: this.cuts.length ? { min: Math.min(...this.cuts), mean: Math.round(mean(this.cuts)), max: Math.max(...this.cuts) } : null,
      renderedMean: this.rendered.length ? Math.round(mean(this.rendered)) : null,
      lodCutUpdates: this.cutUpdates,
    };
  }
}
