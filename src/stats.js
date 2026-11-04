// Frame timing from requestAnimationFrame timestamps. On phones the display
// caps FPS (60/90/120 Hz), so frame-time percentiles and the share of slow
// frames say more than the FPS number alone.

export const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};
export const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

export const SLOW_FRAME_MS = 1000 / 30 + 0.5; // a frame that missed 30 FPS

export class FrameStats {
  constructor(windowMs = 2000) {
    this.windowMs = windowMs;
    this.samples = []; // {t, dt}
    this.last = null;
  }
  push(now) {
    if (this.last !== null) {
      const dt = now - this.last;
      // Ignore gaps from hidden tabs / debugger pauses.
      if (dt < 1000) this.samples.push({ t: now, dt });
    }
    this.last = now;
    while (this.samples.length && now - this.samples[0].t > this.windowMs) this.samples.shift();
  }
  reset() {
    this.samples = [];
    this.last = null;
  }
  summary() {
    const dts = this.samples.map((s) => s.dt);
    if (dts.length < 2) return null;
    const span = this.samples.at(-1).t - this.samples[0].t + this.samples[0].dt;
    return {
      fps: (dts.length * 1000) / span,
      p50: percentile(dts, 50),
      p95: percentile(dts, 95),
      max: Math.max(...dts),
      slowShare: dts.filter((d) => d > SLOW_FRAME_MS).length / dts.length,
    };
  }
}

// Counts how often an integer version number changes per second.
export class RateCounter {
  constructor(windowMs = 2000) {
    this.windowMs = windowMs;
    this.events = [];
    this.total = 0;
    this.lastAt = null;
  }
  add(now, n = 1) {
    for (let i = 0; i < n; i++) this.events.push(now);
    this.total += n;
    this.lastAt = now;
  }
  perSecond(now) {
    while (this.events.length && now - this.events[0] > this.windowMs) this.events.shift();
    return (this.events.length * 1000) / this.windowMs;
  }
}
