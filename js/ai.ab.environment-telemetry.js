/**
 * Local, best-effort runtime telemetry for A/B evaluation run segments.
 *
 * The telemetry is diagnostic evidence, not a trusted-machine attestation.
 * Every unavailable platform metric is represented explicitly instead of
 * being replaced with zero.  The collector is deliberately dependency-free
 * so it can be included in the evaluator's implementation fingerprint.
 */
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { PerformanceObserver, performance as nodePerformance } from 'node:perf_hooks';

export const ENVIRONMENT_TELEMETRY_SCHEMA = 'guandan-evaluation-environment-telemetry-v1';
export const ENVIRONMENT_TELEMETRY_ARTIFACT_SCHEMA = 'guandan-evaluation-environment-telemetry-artifact-v1';
export const ENVIRONMENT_TELEMETRY_SIDECAR_SCHEMA = 'guandan-evaluation-environment-telemetry-sidecar-v1';

const MAX_POWER_DETAIL_LENGTH = 240;
// Environment telemetry is opt-in diagnostics.  One-second sampling keeps
// the observer and repeated sidecar serialization bounded during a long run;
// the caller can request a shorter interval for a focused smoke test.
const DEFAULT_SAMPLE_INTERVAL_MS = 1000;
const DEFAULT_MAX_SAMPLES = 8192;

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonNegativeNumber(value) {
  const parsed = finiteNumber(value);
  return parsed != null && parsed >= 0 ? parsed : null;
}

function nonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function isoNow(now = Date.now) {
  try {
    const value = now();
    return new Date(value).toISOString();
  } catch {
    return null;
  }
}

function sanitizeDetail(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_POWER_DETAIL_LENGTH);
}

/**
 * Query only the active power profile.  Battery/AC details are not exposed by
 * every platform, so unsupported or failed queries remain explicit.
 */
export function readPowerState({
  platform = process.platform,
  execFileSyncImpl = execFileSync,
} = {}) {
  if (platform !== 'win32') {
    return {
      source: 'platform-unsupported',
      status: 'unavailable',
      detail: `platform:${platform}`,
    };
  }
  try {
    const output = execFileSyncImpl('powercfg', ['/getactivescheme'], {
      encoding: 'utf8',
      timeout: 2000,
      windowsHide: true,
    });
    // Keep only the active profile GUID.  Localized scheme names are noisy and
    // may be decoded with the wrong code page; they are not needed for audit.
    const detail = sanitizeDetail(output).match(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    )?.[0] || null;
    return {
      source: 'powercfg',
      status: detail ? 'active_scheme' : 'unknown',
      detail,
    };
  } catch (error) {
    return {
      source: 'powercfg',
      status: 'unavailable',
      detail: error?.code ? `query_failed:${String(error.code)}` : 'query_failed',
    };
  }
}

function cpuSnapshot({ resourceUsage = process.resourceUsage } = {}) {
  try {
    const usage = typeof resourceUsage === 'function' ? resourceUsage() : null;
    return {
      source: usage ? 'process.resourceUsage' : 'unavailable',
      available: !!usage,
      userMicros: nonNegativeInteger(usage?.userCPUTime),
      systemMicros: nonNegativeInteger(usage?.systemCPUTime),
    };
  } catch {
    return {
      source: 'process.resourceUsage',
      available: false,
      userMicros: null,
      systemMicros: null,
    };
  }
}

function systemCpuSnapshot({ cpuInfo = os.cpus } = {}) {
  try {
    const cpus = typeof cpuInfo === 'function' ? cpuInfo() : [];
    if (!Array.isArray(cpus) || !cpus.length) throw new Error('cpu_info_unavailable');
    const fields = ['user', 'nice', 'sys', 'idle', 'irq'];
    const totals = Object.fromEntries(fields.map((field) => [field, 0]));
    for (const cpu of cpus) {
      if (!cpu || !cpu.times || fields.some((field) => nonNegativeNumber(cpu.times[field]) == null)) {
        throw new Error('cpu_times_invalid');
      }
      for (const field of fields) totals[field] += Number(cpu.times[field]);
    }
    const speeds = cpus.map((cpu) => nonNegativeNumber(cpu?.speed)).filter((value) => value != null);
    return {
      source: 'os.cpus',
      available: true,
      logicalCores: cpus.length,
      timesMs: totals,
      speedMHz: speeds.length ? {
        min: Math.min(...speeds),
        average: speeds.reduce((sum, value) => sum + value, 0) / speeds.length,
        max: Math.max(...speeds),
      } : null,
    };
  } catch {
    return {
      source: 'os.cpus',
      available: false,
      logicalCores: null,
      timesMs: null,
      speedMHz: null,
    };
  }
}

function externalLoadSnapshot({ loadAverage = os.loadavg, platform = process.platform } = {}) {
  try {
    const values = typeof loadAverage === 'function' ? loadAverage() : [];
    const load = Array.isArray(values) && values.length >= 3
      ? values.slice(0, 3).map((value) => finiteNumber(value)) : [];
    // Node on Windows returns [0, 0, 0] because loadavg is not implemented;
    // do not turn that sentinel into false evidence of a quiet machine.
    const available = platform !== 'win32'
      && load.length === 3 && load.every((value) => value != null);
    return {
      source: 'os.loadavg',
      available,
      loadAverage: available ? load : null,
      note: platform === 'win32'
        ? 'Windows Node 不提供有效 loadavg；0 值标记为 unavailable'
        : null,
    };
  } catch {
    return {
      source: 'os.loadavg',
      available: false,
      loadAverage: null,
      note: 'loadavg_query_failed',
    };
  }
}

function memorySnapshot({ memoryUsage = process.memoryUsage } = {}) {
  try {
    const usage = typeof memoryUsage === 'function' ? memoryUsage() : {};
    return {
      rssBytes: nonNegativeInteger(usage.rss),
      heapUsedBytes: nonNegativeInteger(usage.heapUsed),
      heapTotalBytes: nonNegativeInteger(usage.heapTotal),
      externalBytes: nonNegativeInteger(usage.external),
      arrayBuffersBytes: nonNegativeInteger(usage.arrayBuffers),
    };
  } catch {
    return {
      rssBytes: null,
      heapUsedBytes: null,
      heapTotalBytes: null,
      externalBytes: null,
      arrayBuffersBytes: null,
    };
  }
}

/**
 * Capture one point-in-time process/system snapshot.  Dependencies are
 * injectable for deterministic unit tests and for platforms without a metric.
 */
export function collectEnvironmentSnapshot({
  monotonicNow = () => nodePerformance.now(),
  wallClockNow = () => Date.now(),
  memoryUsage = process.memoryUsage,
  resourceUsage = process.resourceUsage,
  cpuInfo = os.cpus,
  loadAverage = os.loadavg,
  platform = process.platform,
  powerState = () => readPowerState({ platform }),
} = {}) {
  const memory = memorySnapshot({ memoryUsage });
  const cpu = cpuSnapshot({ resourceUsage });
  const externalLoad = externalLoadSnapshot({ loadAverage, platform });
  let monotonicMs = null;
  try { monotonicMs = finiteNumber(monotonicNow()); } catch { /* unavailable */ }
  let power = null;
  try { power = powerState(); } catch { /* unavailable */ }
  if (!power || typeof power !== 'object') {
    power = { source: 'unknown', status: 'unavailable', detail: 'query_failed' };
  }
  return {
    timestamp: isoNow(wallClockNow),
    monotonicMs,
    ...memory,
    cpu,
    systemCpu: systemCpuSnapshot({ cpuInfo }),
    externalLoad,
    power: {
      source: typeof power.source === 'string' && power.source ? power.source : 'unknown',
      status: typeof power.status === 'string' && power.status ? power.status : 'unavailable',
      detail: power.detail == null ? null : sanitizeDetail(power.detail),
    },
  };
}

function validSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return false;
  if (snapshot.timestamp != null && (typeof snapshot.timestamp !== 'string'
    || !Number.isFinite(Date.parse(snapshot.timestamp)))) return false;
  if (snapshot.monotonicMs != null && (typeof snapshot.monotonicMs !== 'number'
    || nonNegativeNumber(snapshot.monotonicMs) == null)) return false;
  for (const field of ['rssBytes', 'heapUsedBytes', 'heapTotalBytes', 'externalBytes', 'arrayBuffersBytes']) {
    if (snapshot[field] != null && (typeof snapshot[field] !== 'number'
      || nonNegativeInteger(snapshot[field]) == null)) return false;
  }
  if (!snapshot.cpu || typeof snapshot.cpu !== 'object'
    || typeof snapshot.cpu.available !== 'boolean'
    || typeof snapshot.cpu.source !== 'string' || !snapshot.cpu.source) return false;
  for (const field of ['userMicros', 'systemMicros']) {
    if (snapshot.cpu[field] != null && (typeof snapshot.cpu[field] !== 'number'
      || nonNegativeInteger(snapshot.cpu[field]) == null)) return false;
  }
  const processCpuMeasured = snapshot.cpu.userMicros != null && snapshot.cpu.systemMicros != null;
  if (snapshot.cpu.available !== processCpuMeasured) return false;
  if (!snapshot.systemCpu || typeof snapshot.systemCpu !== 'object'
    || typeof snapshot.systemCpu.available !== 'boolean'
    || typeof snapshot.systemCpu.source !== 'string' || !snapshot.systemCpu.source) return false;
  if (snapshot.systemCpu.available) {
    if (!Number.isSafeInteger(snapshot.systemCpu.logicalCores) || snapshot.systemCpu.logicalCores <= 0
      || !snapshot.systemCpu.timesMs || typeof snapshot.systemCpu.timesMs !== 'object') return false;
    for (const field of ['user', 'nice', 'sys', 'idle', 'irq']) {
      if (nonNegativeNumber(snapshot.systemCpu.timesMs[field]) == null) return false;
    }
    if (snapshot.systemCpu.speedMHz != null) {
      if (!snapshot.systemCpu.speedMHz || typeof snapshot.systemCpu.speedMHz !== 'object'
        || ['min', 'average', 'max'].some((field) => (
          nonNegativeNumber(snapshot.systemCpu.speedMHz[field]) == null
        ))) return false;
    }
  } else if (snapshot.systemCpu.logicalCores != null
    || snapshot.systemCpu.timesMs != null || snapshot.systemCpu.speedMHz != null) {
    return false;
  }
  if (!snapshot.externalLoad || typeof snapshot.externalLoad !== 'object'
    || typeof snapshot.externalLoad.available !== 'boolean'
    || typeof snapshot.externalLoad.source !== 'string' || !snapshot.externalLoad.source) return false;
  if (snapshot.externalLoad.loadAverage != null
    && (!Array.isArray(snapshot.externalLoad.loadAverage)
      || snapshot.externalLoad.loadAverage.length !== 3
      || snapshot.externalLoad.loadAverage.some((value) => (
        typeof value !== 'number' || finiteNumber(value) == null || value < 0
      )))) return false;
  const loadMeasured = Array.isArray(snapshot.externalLoad.loadAverage)
    && snapshot.externalLoad.loadAverage.length === 3
    && snapshot.externalLoad.loadAverage.every((value) => typeof value === 'number'
      && finiteNumber(value) != null);
  if (snapshot.externalLoad.available !== loadMeasured) return false;
  if (!snapshot.power || typeof snapshot.power !== 'object'
    || typeof snapshot.power.source !== 'string' || !snapshot.power.source
    || typeof snapshot.power.status !== 'string' || !snapshot.power.status) return false;
  return true;
}

function validCheckpointTiming(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Number.isSafeInteger(value.nextBlockIndex) && value.nextBlockIndex >= 0
    && typeof value.bytes === 'number' && nonNegativeInteger(value.bytes) != null
    && typeof value.buildMs === 'number' && nonNegativeNumber(value.buildMs) != null
    && typeof value.serializationMs === 'number' && nonNegativeNumber(value.serializationMs) != null
    && typeof value.primaryWriteMs === 'number' && nonNegativeNumber(value.primaryWriteMs) != null
    && typeof value.primaryFsyncMs === 'number' && nonNegativeNumber(value.primaryFsyncMs) != null
    && typeof value.primaryReadbackMs === 'number' && nonNegativeNumber(value.primaryReadbackMs) != null
    && typeof value.backupWriteMs === 'number' && nonNegativeNumber(value.backupWriteMs) != null
    && typeof value.backupFsyncMs === 'number' && nonNegativeNumber(value.backupFsyncMs) != null
    && typeof value.backupReadbackMs === 'number' && nonNegativeNumber(value.backupReadbackMs) != null
    && typeof value.backupRenameMs === 'number' && nonNegativeNumber(value.backupRenameMs) != null
    && typeof value.renameMs === 'number' && nonNegativeNumber(value.renameMs) != null
    && typeof value.totalMs === 'number' && nonNegativeNumber(value.totalMs) != null;
}

function summarizePeaks(samples) {
  const max = (field) => {
    const values = samples.map((sample) => sample[field]).filter((value) => value != null);
    return values.length ? Math.max(...values) : null;
  };
  return {
    rssBytes: max('rssBytes'),
    heapUsedBytes: max('heapUsedBytes'),
    heapTotalBytes: max('heapTotalBytes'),
    externalBytes: max('externalBytes'),
    arrayBuffersBytes: max('arrayBuffersBytes'),
  };
}

function summarizeSystemCpu(samples) {
  const measured = samples.filter((sample) => sample.systemCpu?.available
    && sample.systemCpu.timesMs);
  if (!measured.length) {
    return {
      available: false,
      samples: 0,
      logicalCores: null,
      busyPercent: null,
      speedMHz: null,
      externalLoadProxy: {
        available: false,
        source: null,
        metric: null,
      },
    };
  }
  const speeds = measured.map((sample) => sample.systemCpu.speedMHz).filter(Boolean);
  // `os.cpus().times` are cumulative counters.  Sum only adjacent positive
  // deltas so a hot-plug/reset cannot manufacture a negative or over-wide
  // interval; the resulting busy percentage is a Windows external-load
  // proxy, never a replacement for a real load average.
  let totalDelta = 0;
  let busyDelta = 0;
  for (let index = 1; index < measured.length; index += 1) {
    const previous = measured[index - 1].systemCpu.timesMs;
    const current = measured[index].systemCpu.timesMs;
    const deltas = Object.fromEntries(['user', 'nice', 'sys', 'idle', 'irq'].map((field) => [
      field, Math.max(0, Number(current[field]) - Number(previous[field])),
    ]));
    totalDelta += Object.values(deltas).reduce((sum, value) => sum + value, 0);
    busyDelta += ['user', 'nice', 'sys', 'irq']
      .reduce((sum, field) => sum + deltas[field], 0);
  }
  return {
    available: true,
    samples: measured.length,
    logicalCores: measured[0].systemCpu.logicalCores,
    busyPercent: totalDelta > 0 ? Number((busyDelta / totalDelta * 100).toFixed(3)) : null,
    speedMHz: speeds.length ? {
      min: Math.min(...speeds.map((speed) => speed.min)),
      average: speeds.reduce((sum, speed) => sum + speed.average, 0) / speeds.length,
      max: Math.max(...speeds.map((speed) => speed.max)),
    } : null,
    externalLoadProxy: {
      available: true,
      source: 'os.cpus',
      metric: 'busyPercent+speedMHz',
    },
  };
}

function summarizeExternalLoad(samples) {
  const measured = samples.filter((sample) => sample.externalLoad?.available
    && Array.isArray(sample.externalLoad.loadAverage)
    && sample.externalLoad.loadAverage.length === 3);
  const systemCpuMeasured = samples.filter((sample) => sample.systemCpu?.available
    && sample.systemCpu.timesMs);
  const averageLoad = measured.length
    ? [0, 1, 2].map((index) => Number((measured.reduce(
      (sum, sample) => sum + Number(sample.externalLoad.loadAverage[index]), 0,
    ) / measured.length).toFixed(6)))
    : null;
  return {
    available: measured.length > 0,
    samples: measured.length,
    loadAverage: averageLoad,
    proxy: {
      available: measured.length === 0 && systemCpuMeasured.length > 0,
      source: measured.length === 0 && systemCpuMeasured.length > 0 ? 'os.cpus' : null,
      samples: systemCpuMeasured.length,
      metric: measured.length === 0 && systemCpuMeasured.length > 0
        ? 'systemCpu.busyPercent+speedMHz' : null,
      note: measured.length === 0 && systemCpuMeasured.length > 0
        ? '系统 CPU 累计时序/频率仅作 Windows 外部负载代理，不等同于 loadavg' : null,
    },
  };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requiredSignalsMeasured(samples) {
  if (!samples.length) return false;
  return samples.every((sample) => {
    const memoryMeasured = ['rssBytes', 'heapUsedBytes', 'heapTotalBytes']
      .every((field) => sample[field] != null);
    const processMeasured = sample.cpu?.available
      && sample.cpu.userMicros != null && sample.cpu.systemMicros != null;
    const powerMeasured = sample.power?.status
      && sample.power.status !== 'unavailable' && sample.power.status !== 'unknown';
    const externalLoadMeasured = sample.externalLoad?.available
      || (sample.systemCpu?.available && sample.systemCpu.timesMs);
    return memoryMeasured && processMeasured && powerMeasured && !!externalLoadMeasured;
  });
}

function derivedArtifactStatus(value) {
  if (!value.samples.length) return 'unavailable';
  const requiredMeasured = requiredSignalsMeasured(value.samples);
  return value.errors.length || !requiredMeasured ? 'partial' : 'complete';
}

function unavailableArtifact({ resume = false, reason = 'telemetry_not_collected' } = {}) {
  return {
    schema: ENVIRONMENT_TELEMETRY_ARTIFACT_SCHEMA,
    status: 'unavailable',
    resume: resume === true,
    sampling: {
      method: 'none',
      intervalMs: null,
      maxSamples: null,
      droppedSamples: 0,
    },
    samples: [],
    peaks: {
      rssBytes: null,
      heapUsedBytes: null,
      heapTotalBytes: null,
      externalBytes: null,
      arrayBuffersBytes: null,
    },
    systemCpu: {
      available: false,
      samples: 0,
      logicalCores: null,
      busyPercent: null,
      speedMHz: null,
      externalLoadProxy: {
        available: false,
        source: null,
        metric: null,
      },
    },
    externalLoad: {
      available: false,
      samples: 0,
      loadAverage: null,
      proxy: {
        available: false,
        source: null,
        samples: 0,
        metric: null,
        note: null,
      },
    },
    gc: { events: 0, totalPauseMs: 0, maxPauseMs: 0, byKind: {} },
    checkpointWrites: [],
    resumeLoad: null,
    errors: [String(reason)],
  };
}

/**
 * Build a collector.  `snapshot()` is safe to call before `finish()` and is
 * used to persist diagnostic sidecar progress alongside checkpoints.
 */
export function createEnvironmentTelemetryCollector({
  resume = false,
  resumeLoad = null,
  sampleIntervalMs = DEFAULT_SAMPLE_INTERVAL_MS,
  maxSamples = DEFAULT_MAX_SAMPLES,
  snapshot = null,
  powerStateReader = () => readPowerState(),
  setIntervalImpl = globalThis.setInterval,
  clearIntervalImpl = globalThis.clearInterval,
  performanceObserverFactory = (callback) => new PerformanceObserver(callback),
  wallClockNow = () => Date.now(),
} = {}) {
  const intervalMs = Number.isFinite(Number(sampleIntervalMs)) && Number(sampleIntervalMs) > 0
    ? Number(sampleIntervalMs) : DEFAULT_SAMPLE_INTERVAL_MS;
  const sampleLimit = Number.isSafeInteger(Number(maxSamples)) && Number(maxSamples) > 0
    ? Number(maxSamples) : DEFAULT_MAX_SAMPLES;
  const samples = [];
  const checkpointWrites = [];
  const errors = [];
  const gcByKind = {};
  let gcEvents = 0;
  let gcPauseMs = 0;
  let maxGcPauseMs = 0;
  let timer = null;
  let observer = null;
  let started = false;
  let finished = false;
  let powerState = null;
  let droppedSamples = 0;

  function captureSnapshot() {
    if (snapshot) return snapshot();
    return collectEnvironmentSnapshot({ powerState: () => powerState });
  }

  function recordSample(kind) {
    if (samples.length >= sampleLimit) {
      // Preserve boundary/checkpoint observations when possible.  Interval
      // samples are the only entries that may be evicted; every eviction is
      // explicit so a capped artifact cannot be mistaken for complete data.
      const removable = kind === 'segment-end' || kind === 'checkpoint'
        ? samples.findIndex((sample) => sample.kind === 'interval') : -1;
      if (removable >= 0) samples.splice(removable, 1);
      else {
        droppedSamples += 1;
        if (!errors.includes('sample_limit_reached')) errors.push('sample_limit_reached');
        return;
      }
      droppedSamples += 1;
      if (!errors.includes('sample_limit_reached')) errors.push('sample_limit_reached');
    }
    let value;
    try { value = captureSnapshot(); } catch (error) {
      errors.push(`snapshot_failed:${error?.message || String(error)}`);
      return;
    }
    if (!validSnapshot(value)) {
      errors.push('snapshot_invalid');
      return;
    }
    samples.push({ kind, ...value });
  }

  function observeGc(list) {
    for (const entry of list.getEntries()) {
      const duration = nonNegativeNumber(entry.duration);
      if (duration == null) {
        errors.push('gc_duration_invalid');
        continue;
      }
      gcEvents += 1;
      gcPauseMs += duration;
      maxGcPauseMs = Math.max(maxGcPauseMs, duration);
      const kind = String(entry.kind ?? 'unknown');
      gcByKind[kind] = (gcByKind[kind] || 0) + 1;
    }
  }

  function start() {
    if (started || finished) return;
    started = true;
    if (!snapshot) {
      try { powerState = powerStateReader(); } catch { powerState = null; }
    }
    recordSample('segment-start');
    try {
      observer = performanceObserverFactory(observeGc);
      observer.observe({ entryTypes: ['gc'], buffered: false });
    } catch (error) {
      errors.push(`gc_observer_unavailable:${error?.message || String(error)}`);
      observer = null;
    }
    try {
      timer = setIntervalImpl(() => recordSample('interval'), intervalMs);
      timer?.unref?.();
    } catch (error) {
      errors.push(`interval_unavailable:${error?.message || String(error)}`);
      timer = null;
    }
  }

  function recordCheckpoint(timing) {
    if (finished) return;
    if (!validCheckpointTiming(timing)) {
      errors.push('checkpoint_timing_invalid');
    } else {
      checkpointWrites.push({
        nextBlockIndex: timing.nextBlockIndex,
        bytes: timing.bytes,
        buildMs: Number(timing.buildMs),
        serializationMs: Number(timing.serializationMs),
        primaryWriteMs: Number(timing.primaryWriteMs),
        primaryFsyncMs: Number(timing.primaryFsyncMs),
        primaryReadbackMs: Number(timing.primaryReadbackMs),
        backupWriteMs: Number(timing.backupWriteMs),
        backupFsyncMs: Number(timing.backupFsyncMs),
        backupReadbackMs: Number(timing.backupReadbackMs),
        backupRenameMs: Number(timing.backupRenameMs),
        renameMs: Number(timing.renameMs),
        totalMs: Number(timing.totalMs),
      });
    }
    recordSample('checkpoint');
  }

  function recordError(message) {
    errors.push(String(message || 'telemetry_error'));
  }

  function build(statusOverride = null) {
    const requiredMemoryMeasured = samples.length > 0 && samples.every((sample) => (
      ['rssBytes', 'heapUsedBytes', 'heapTotalBytes'].every((field) => sample[field] != null)
    ));
    const requiredProcessMeasured = samples.length > 0 && samples.every((sample) => (
      sample.cpu.available && sample.cpu.userMicros != null && sample.cpu.systemMicros != null
    ));
    const requiredEnvironmentMeasured = requiredSignalsMeasured(samples);
    const derivedStatus = samples.length === 0
      ? 'unavailable'
      : (errors.length || !requiredMemoryMeasured || !requiredProcessMeasured
        || !requiredEnvironmentMeasured ? 'partial' : 'complete');
    // There are currently no callers that override status.  If a future
    // diagnostic hook does, never let it claim a stronger state than content
    // supports; validation independently re-derives the same value.
    const status = ['complete', 'partial', 'unavailable'].includes(statusOverride)
      ? (statusOverride === 'complete' && derivedStatus !== 'complete' ? derivedStatus : statusOverride)
      : derivedStatus;
    return {
      schema: ENVIRONMENT_TELEMETRY_ARTIFACT_SCHEMA,
      status,
      resume: resume === true,
      sampling: {
        method: 'boundary+interval+gc',
        intervalMs,
        maxSamples: sampleLimit,
        droppedSamples,
      },
      samples: samples.slice(),
      peaks: summarizePeaks(samples),
      systemCpu: summarizeSystemCpu(samples),
      externalLoad: summarizeExternalLoad(samples),
      gc: {
        events: gcEvents,
        totalPauseMs: Number(gcPauseMs.toFixed(3)),
        maxPauseMs: Number(maxGcPauseMs.toFixed(3)),
        byKind: { ...gcByKind },
      },
      checkpointWrites: checkpointWrites.slice(),
      resumeLoad: resumeLoad == null ? null : { ...resumeLoad },
      errors: errors.slice(),
    };
  }

  function snapshotResult() {
    if (!started) return unavailableArtifact({ resume, reason: 'collector_not_started' });
    return build();
  }

  function finish() {
    if (finished) return snapshotResult();
    if (!started) return unavailableArtifact({ resume, reason: 'collector_not_started' });
    if (!snapshot) {
      try { powerState = powerStateReader(); } catch { /* keep start state */ }
    }
    // Drain buffered GC entries before disconnecting, otherwise a final pause
    // can disappear from the segment summary.
    try {
      const pending = observer?.takeRecords?.();
      if (pending?.length) observeGc({ getEntries: () => pending });
    } catch { /* diagnostic cleanup only */ }
    recordSample('segment-end');
    if (timer != null) {
      try { clearIntervalImpl(timer); } catch { /* diagnostic cleanup only */ }
      timer = null;
    }
    try { observer?.disconnect?.(); } catch { /* diagnostic cleanup only */ }
    observer = null;
    finished = true;
    return build();
  }

  return {
    start,
    sample: recordSample,
    recordCheckpoint,
    recordError,
    snapshot: snapshotResult,
    finish,
    get started() { return started; },
    get finished() { return finished; },
    wallClockNow,
  };
}

function validArtifactShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.schema !== ENVIRONMENT_TELEMETRY_ARTIFACT_SCHEMA
    || !['complete', 'partial', 'unavailable'].includes(value.status)
    || typeof value.resume !== 'boolean'
    || !value.sampling || typeof value.sampling !== 'object'
    || (value.sampling.intervalMs != null
      && (typeof value.sampling.intervalMs !== 'number'
        || nonNegativeNumber(value.sampling.intervalMs) == null))
    || (value.sampling.maxSamples != null
      && (typeof value.sampling.maxSamples !== 'number'
        || !Number.isSafeInteger(value.sampling.maxSamples) || value.sampling.maxSamples <= 0))
    || (value.sampling.droppedSamples != null
      && (typeof value.sampling.droppedSamples !== 'number'
        || nonNegativeInteger(value.sampling.droppedSamples) == null))
    || !Array.isArray(value.samples) || !value.peaks || typeof value.peaks !== 'object'
    || !value.systemCpu || typeof value.systemCpu !== 'object'
    || typeof value.systemCpu.available !== 'boolean'
    || !Number.isSafeInteger(value.systemCpu.samples) || value.systemCpu.samples < 0
    || (value.systemCpu.logicalCores != null
      && (!Number.isSafeInteger(value.systemCpu.logicalCores) || value.systemCpu.logicalCores <= 0))
    || (value.systemCpu.busyPercent != null
      && (typeof value.systemCpu.busyPercent !== 'number'
        || finiteNumber(value.systemCpu.busyPercent) == null
        || value.systemCpu.busyPercent < 0 || value.systemCpu.busyPercent > 100))
    || (value.systemCpu.speedMHz != null
      && (!value.systemCpu.speedMHz || typeof value.systemCpu.speedMHz !== 'object'
        || ['min', 'average', 'max'].some((field) => (
          nonNegativeNumber(value.systemCpu.speedMHz[field]) == null
        ))))
    || !value.systemCpu.externalLoadProxy
    || typeof value.systemCpu.externalLoadProxy !== 'object'
    || typeof value.systemCpu.externalLoadProxy.available !== 'boolean'
    || (value.systemCpu.externalLoadProxy.source != null
      && (typeof value.systemCpu.externalLoadProxy.source !== 'string'
        || !value.systemCpu.externalLoadProxy.source))
    || (value.systemCpu.externalLoadProxy.metric != null
      && (typeof value.systemCpu.externalLoadProxy.metric !== 'string'
        || !value.systemCpu.externalLoadProxy.metric))
    || !value.externalLoad || typeof value.externalLoad !== 'object'
    || typeof value.externalLoad.available !== 'boolean'
    || !Number.isSafeInteger(value.externalLoad.samples) || value.externalLoad.samples < 0
    || (value.externalLoad.loadAverage != null
      && (!Array.isArray(value.externalLoad.loadAverage)
        || value.externalLoad.loadAverage.length !== 3
        || value.externalLoad.loadAverage.some((item) => (
          typeof item !== 'number' || finiteNumber(item) == null || item < 0
        ))))
    || !value.externalLoad.proxy || typeof value.externalLoad.proxy !== 'object'
    || typeof value.externalLoad.proxy.available !== 'boolean'
    || !Number.isSafeInteger(value.externalLoad.proxy.samples)
    || value.externalLoad.proxy.samples < 0
    || (value.externalLoad.proxy.source != null
      && (typeof value.externalLoad.proxy.source !== 'string' || !value.externalLoad.proxy.source))
    || (value.externalLoad.proxy.metric != null
      && (typeof value.externalLoad.proxy.metric !== 'string' || !value.externalLoad.proxy.metric))
    || (value.externalLoad.proxy.note != null && typeof value.externalLoad.proxy.note !== 'string')
    || !value.gc || typeof value.gc !== 'object' || !Array.isArray(value.checkpointWrites)
    || !Array.isArray(value.errors)) return false;
  if (value.samples.some((sample) => !sample || typeof sample.kind !== 'string'
    || !validSnapshot(sample))) return false;
  for (const field of ['rssBytes', 'heapUsedBytes', 'heapTotalBytes', 'externalBytes', 'arrayBuffersBytes']) {
    if (value.peaks[field] != null && (typeof value.peaks[field] !== 'number'
      || nonNegativeInteger(value.peaks[field]) == null)) return false;
  }
  if (!Number.isSafeInteger(value.gc.events) || value.gc.events < 0
    || typeof value.gc.totalPauseMs !== 'number' || nonNegativeNumber(value.gc.totalPauseMs) == null
    || typeof value.gc.maxPauseMs !== 'number' || nonNegativeNumber(value.gc.maxPauseMs) == null
    || !value.gc.byKind || typeof value.gc.byKind !== 'object'
    || Array.isArray(value.gc.byKind)) return false;
  if (value.checkpointWrites.some((item) => !validCheckpointTiming(item))) return false;
  for (let index = 1; index < value.checkpointWrites.length; index += 1) {
    if (value.checkpointWrites[index].nextBlockIndex
      <= value.checkpointWrites[index - 1].nextBlockIndex) return false;
  }
  if (value.resumeLoad != null && (!value.resumeLoad || typeof value.resumeLoad !== 'object'
    || typeof value.resumeLoad.source !== 'string'
    || !['primary', 'last-valid'].includes(value.resumeLoad.source)
    || typeof value.resumeLoad.bytes !== 'number' || nonNegativeInteger(value.resumeLoad.bytes) == null
    || typeof value.resumeLoad.readMs !== 'number' || nonNegativeNumber(value.resumeLoad.readMs) == null
    || typeof value.resumeLoad.parseMs !== 'number' || nonNegativeNumber(value.resumeLoad.parseMs) == null
    || typeof value.resumeLoad.validateMs !== 'number' || nonNegativeNumber(value.resumeLoad.validateMs) == null
    || typeof value.resumeLoad.totalMs !== 'number' || nonNegativeNumber(value.resumeLoad.totalMs) == null
    || !/^[a-f0-9]{64}$/.test(value.resumeLoad.inputCheckpointSha256))) return false;
  if (value.systemCpu.available !== (value.systemCpu.samples > 0)
    || value.systemCpu.externalLoadProxy.available !== value.systemCpu.available
    || value.externalLoad.available !== (value.externalLoad.samples > 0)
    || value.externalLoad.proxy.available !== (
      !value.externalLoad.available && value.externalLoad.proxy.samples > 0
    )) return false;
  if (!value.systemCpu.available
    && (value.systemCpu.logicalCores != null
      || value.systemCpu.busyPercent != null || value.systemCpu.speedMHz != null)) return false;
  if (value.systemCpu.available
    && (!Number.isSafeInteger(value.systemCpu.logicalCores)
      || value.systemCpu.logicalCores <= 0
      || value.systemCpu.externalLoadProxy.source !== 'os.cpus')) return false;
  if (!value.externalLoad.available && value.externalLoad.loadAverage != null) return false;
  if (value.externalLoad.available
    && (!Array.isArray(value.externalLoad.loadAverage)
      || value.externalLoad.loadAverage.length !== 3
      || value.externalLoad.proxy.available)) return false;
  if (value.samples.length === 0 && value.systemCpu.samples !== 0) return false;
  if (value.samples.length > 0 && value.systemCpu.samples > value.samples.length) return false;
  if (value.samples.length > 0 && value.externalLoad.samples > value.samples.length) return false;
  if (!sameJson(value.peaks, summarizePeaks(value.samples))) return false;
  if (!sameJson(value.systemCpu, summarizeSystemCpu(value.samples))) return false;
  if (!sameJson(value.externalLoad, summarizeExternalLoad(value.samples))) return false;
  const gcByKindTotal = Object.values(value.gc.byKind)
    .every((count) => Number.isSafeInteger(count) && count >= 0)
    && Object.values(value.gc.byKind).reduce((sum, count) => sum + count, 0);
  if (gcByKindTotal !== value.gc.events
    || (value.gc.events === 0 && (value.gc.totalPauseMs !== 0 || value.gc.maxPauseMs !== 0))
    || (value.gc.events > 0 && value.gc.maxPauseMs > value.gc.totalPauseMs)) return false;
  if (value.status !== derivedArtifactStatus(value)) return false;
  return value.errors.every((item) => typeof item === 'string');
}

export function validateEnvironmentTelemetryArtifact(value, label = 'environmentTelemetry') {
  if (!validArtifactShape(value)) {
    throw new Error(`${label} 结构无效或包含未测量字段`);
  }
  return value;
}

export function unavailableEnvironmentTelemetry(options = {}) {
  return unavailableArtifact(options);
}
