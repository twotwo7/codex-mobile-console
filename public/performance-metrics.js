function nowIso() {
  return new Date().toISOString();
}

function emptyMetric() {
  return {
    count: 0,
    lastMs: 0,
    maxMs: 0,
    totalMs: 0,
    lastAt: '',
    detail: null
  };
}

export function createPerformanceMetrics(options = {}) {
  const limit = Math.max(10, Number(options.limit || 80));
  const metrics = new Map();
  let recent = [];

  function record(name, durationMs, detail = null) {
    const key = String(name || 'unknown');
    const duration = Number(durationMs || 0);
    const current = metrics.get(key) || emptyMetric();
    current.count += 1;
    current.lastMs = duration;
    current.maxMs = Math.max(current.maxMs, duration);
    current.totalMs += duration;
    current.lastAt = nowIso();
    current.detail = detail;
    metrics.set(key, current);
    recent = [{
      name: key,
      durationMs: duration,
      at: current.lastAt,
      detail
    }, ...recent].slice(0, limit);
    return current;
  }

  function snapshot() {
    const values = {};
    for (const [key, value] of metrics.entries()) {
      values[key] = {
        ...value,
        avgMs: value.count ? value.totalMs / value.count : 0
      };
    }
    return {
      metrics: values,
      recent: recent.slice()
    };
  }

  return {
    record,
    snapshot
  };
}
