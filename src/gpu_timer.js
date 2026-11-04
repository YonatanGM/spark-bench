// GPU time per frame via EXT_disjoint_timer_query_webgl2. Queries are sparse
// and read back asynchronously (no gl.finish). Most mobile browsers and Safari
// do not expose the extension; `supported` is then false and readings are null.
export function createGpuTimer(renderer, { every = 4, keep = 30 } = {}) {
  const gl = renderer.getContext();
  const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2");
  let frame = 0;
  let queue = [];
  let recent = [];
  const listeners = new Set();
  return {
    supported: !!ext,
    onSample(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    // Median of the last `keep` samples, in milliseconds.
    get milliseconds() {
      if (!recent.length) return null;
      const s = [...recent].sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)];
    },
    render(draw) {
      if (!ext) return draw();
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
      while (queue.length && gl.getQueryParameter(queue[0], gl.QUERY_RESULT_AVAILABLE)) {
        const q = queue.shift();
        if (!disjoint) {
          const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
          recent.push(ms);
          if (recent.length > keep) recent.shift();
          for (const fn of listeners) fn(ms);
        }
        gl.deleteQuery(q);
      }
      if (disjoint) recent = [];
      let query = null;
      if (++frame % every === 0 && queue.length < 8) {
        query = gl.createQuery();
        gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
      }
      try {
        draw();
      } finally {
        if (query) {
          gl.endQuery(ext.TIME_ELAPSED_EXT);
          queue.push(query);
        }
      }
    },
  };
}
