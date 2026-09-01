#!/usr/bin/env node
/** PERF-2 regression: runtime telemetry shape, GC accounting and sidecar binding. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ENVIRONMENT_TELEMETRY_ARTIFACT_SCHEMA,
  ENVIRONMENT_TELEMETRY_SIDECAR_SCHEMA,
  collectEnvironmentSnapshot,
  createEnvironmentTelemetryCollector,
  readPowerState,
  validateEnvironmentTelemetryArtifact,
} from '../js/ai.ab.environment-telemetry.js';
import { sha256Canonical } from '../js/ai.ab.provenance.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Completion watchdog for deterministic multi-game runner checks. Search
// latency remains governed by the emitted telemetry and performance gate.
const TEST_RUNNER_TIMEOUT_MS = 90000;
const temporaryDirectories = [];
const makeTemporaryDirectory = (prefix) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};
process.on('exit', () => {
  for (const directory of temporaryDirectories) {
    try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

console.log('PERF-2：环境快照与 GC/checkpoint 计时回归');
{
  const snapshot = collectEnvironmentSnapshot({
    monotonicNow: () => 42.5,
    wallClockNow: () => Date.parse('2026-09-01T00:00:00.000Z'),
    memoryUsage: () => ({
      rss: 100,
      heapUsed: 40,
      heapTotal: 80,
      external: 10,
      arrayBuffers: 5,
    }),
    resourceUsage: () => ({ userCPUTime: 11, systemCPUTime: 7 }),
    loadAverage: () => [0.1, 0.2, 0.3],
    platform: 'linux',
    powerState: () => ({ source: 'fixture', status: 'ac', detail: 'fixture' }),
  });
  assert.equal(snapshot.timestamp, '2026-09-01T00:00:00.000Z');
  assert.equal(snapshot.rssBytes, 100);
  assert.deepEqual(snapshot.cpu, {
    source: 'process.resourceUsage', available: true, userMicros: 11, systemMicros: 7,
  });
  assert.deepEqual(snapshot.externalLoad.loadAverage, [0.1, 0.2, 0.3]);
  assert.equal(snapshot.power.status, 'ac');

  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const timers = [];
  let gcCallback = null;
  let tick = 0;
  const collector = createEnvironmentTelemetryCollector({
    resume: true,
    sampleIntervalMs: 10,
    snapshot: () => ({
      timestamp: '2026-09-01T00:00:00.000Z',
      monotonicMs: tick++,
      rssBytes: 100 + tick,
      heapUsedBytes: 40 + tick,
      heapTotalBytes: 80 + tick,
      externalBytes: 10,
      arrayBuffersBytes: 5,
      cpu: { source: 'fixture', available: true, userMicros: tick, systemMicros: 2 },
      systemCpu: {
        source: 'fixture', available: true, logicalCores: 2,
        timesMs: { user: tick, nice: 0, sys: 1, idle: 10 + tick, irq: 0 },
        speedMHz: { min: 2400, average: 2500, max: 2600 },
      },
      externalLoad: { source: 'fixture', available: true, loadAverage: [0.1, 0.2, 0.3], note: null },
      power: { source: 'fixture', status: 'ac', detail: null },
    }),
    setIntervalImpl: (fn, interval) => {
      const timer = { fn, interval, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearIntervalImpl: (timer) => { timer.cleared = true; },
    performanceObserverFactory: (callback) => {
      gcCallback = callback;
      return { observe() {}, disconnect() {} };
    },
  });
  collector.start();
  collector.sample('game');
  gcCallback({ getEntries: () => [{ duration: 3.25, kind: 1 }, { duration: 1.75, kind: 2 }] });
  collector.recordCheckpoint({
    nextBlockIndex: 2,
    bytes: 1234,
    buildMs: 0.5,
    serializationMs: 1.5,
    primaryWriteMs: 2,
    primaryFsyncMs: 0.75,
    primaryReadbackMs: 1,
    backupWriteMs: 0.25,
    backupFsyncMs: 0.1,
    backupReadbackMs: 0.2,
    backupRenameMs: 0.05,
    renameMs: 0.15,
    totalMs: 4.5,
  });
  const artifact = collector.finish();
  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
  assert.equal(timers.length, 1);
  assert.equal(timers[0].cleared, true);
  assert.equal(artifact.schema, ENVIRONMENT_TELEMETRY_ARTIFACT_SCHEMA);
  assert.equal(artifact.status, 'complete');
  assert.equal(artifact.resume, true);
  assert.equal(artifact.gc.events, 2);
  assert.equal(artifact.gc.totalPauseMs, 5);
  assert.equal(artifact.gc.maxPauseMs, 3.25);
  assert.equal(artifact.checkpointWrites[0].bytes, 1234);
  assert.equal(artifact.checkpointWrites[0].primaryFsyncMs, 0.75);
  assert.equal(artifact.peaks.rssBytes, 104);
  assert.equal(artifact.systemCpu.available, true);
  assert.equal(artifact.systemCpu.externalLoadProxy.available, true);
  assert.equal(artifact.externalLoad.available, true);
  assert(artifact.samples.some((sample) => sample.kind === 'segment-start'));
  assert(artifact.samples.some((sample) => sample.kind === 'segment-end'));
  assert.doesNotThrow(() => validateEnvironmentTelemetryArtifact(artifact));
  assert.throws(() => validateEnvironmentTelemetryArtifact({
    ...artifact,
    checkpointWrites: [{ ...artifact.checkpointWrites[0], bytes: '0' }],
  }), /结构无效/);
  assert.throws(() => validateEnvironmentTelemetryArtifact({
    ...artifact,
    status: 'complete',
    errors: ['synthetic_error'],
  }), /结构无效/);
  assert.throws(() => validateEnvironmentTelemetryArtifact({
    ...artifact,
    peaks: { ...artifact.peaks, rssBytes: artifact.peaks.rssBytes + 1 },
  }), /结构无效/);
  assert.throws(() => validateEnvironmentTelemetryArtifact({
    ...artifact,
    systemCpu: { ...artifact.systemCpu, busyPercent: 99 },
  }), /结构无效/);
  assert.throws(() => validateEnvironmentTelemetryArtifact({
    ...artifact,
    externalLoad: { ...artifact.externalLoad, loadAverage: [9, 9, 9] },
  }), /结构无效/);
  assert.throws(() => validateEnvironmentTelemetryArtifact({
    ...artifact,
    checkpointWrites: [
      artifact.checkpointWrites[0],
      { ...artifact.checkpointWrites[0], nextBlockIndex: artifact.checkpointWrites[0].nextBlockIndex },
    ],
  }), /结构无效/);
}

console.log('PERF-2：长段采样有界且丢样显式降级');
{
  const snapshot = () => ({
    timestamp: '2026-09-01T00:00:00.000Z',
    monotonicMs: 1,
    rssBytes: 1,
    heapUsedBytes: 1,
    heapTotalBytes: 1,
    externalBytes: 1,
    arrayBuffersBytes: 1,
    cpu: { source: 'fixture', available: true, userMicros: 1, systemMicros: 1 },
    systemCpu: {
      source: 'fixture', available: true, logicalCores: 1,
      timesMs: { user: 1, nice: 0, sys: 1, idle: 1, irq: 0 },
      speedMHz: { min: 2400, average: 2400, max: 2400 },
    },
    externalLoad: { source: 'fixture', available: true, loadAverage: [0, 0, 0], note: null },
    power: { source: 'fixture', status: 'ac', detail: null },
  });
  const capped = createEnvironmentTelemetryCollector({
    maxSamples: 2,
    snapshot,
    setIntervalImpl: () => null,
    clearIntervalImpl: () => {},
    performanceObserverFactory: () => ({ observe() {}, disconnect() {} }),
  });
  capped.start();
  capped.sample('interval');
  const artifact = capped.finish();
  assert(artifact.samples.length <= 2 && artifact.sampling.maxSamples === 2,
    '采样数量必须受显式上限约束');
  assert(artifact.sampling.droppedSamples > 0 && artifact.status === 'partial'
    && artifact.errors.includes('sample_limit_reached'),
  '达到上限时必须记录丢样并将诊断标为 partial');
  assert(artifact.samples.some((sample) => sample.kind === 'segment-end'),
    '有界采样仍应尽量保留 segment-end 边界样本');
}

console.log('PERF-2：powercfg 失败必须显式标记 unavailable');
{
  const power = readPowerState({
    platform: 'win32',
    execFileSyncImpl: () => { throw Object.assign(new Error('fixture'), { code: 'ENOENT' }); },
  });
  assert.deepEqual(power, {
    source: 'powercfg', status: 'unavailable', detail: 'query_failed:ENOENT',
  });
}

console.log('PERF-2：sidecar 路径冲突必须在启动前拒绝');
{
  const temporary = makeTemporaryDirectory('guandan-perf2-collision-');
  const checkpointPath = path.join(temporary, 'checkpoint.json');
  const reportPath = path.join(temporary, 'report.json');
  const rawTelemetryPath = path.join(temporary, 'raw.json');
  const conflictingPaths = [
    checkpointPath,
    `${checkpointPath}.last-valid`,
    reportPath,
    rawTelemetryPath,
  ];
  for (const conflictingPath of conflictingPaths) {
    const args = [
      path.join(root, 'js', 'ai.ab.simulation.js'),
      '1', '990008', 'root-pimc-v1', 'expert', '--levels=2', '--summary-only', '--json',
      `--report=${reportPath}`, `--checkpoint=${checkpointPath}`,
      `--raw-telemetry=${rawTelemetryPath}`,
      `--environment-telemetry=${conflictingPath}`,
    ];
    const result = spawnSync(process.execPath, args, {
      cwd: root, encoding: 'utf8', timeout: TEST_RUNNER_TIMEOUT_MS,
    });
    assert.notEqual(result.status, 0,
      `sidecar 冲突路径必须拒绝：${conflictingPath}`);
    assert.match(`${result.stderr}${result.stdout}`, /路径不得覆盖 checkpoint/,
      '冲突拒绝信息必须指出核心工件保护');
    assert(!fs.existsSync(checkpointPath), '启动前拒绝不得创建 checkpoint');
  }
  fs.rmSync(temporary, { recursive: true, force: true });
}

console.log('PERF-2：真实目录别名（junction/symlink）路径冲突必须拒绝');
{
  const temporary = makeTemporaryDirectory('guandan-perf2-alias-');
  const realDirectory = path.join(temporary, 'real');
  const aliasDirectory = path.join(temporary, 'alias');
  fs.mkdirSync(realDirectory);
  let aliasCreated = false;
  try {
    fs.symlinkSync(realDirectory, aliasDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    aliasCreated = true;
  } catch (error) {
    // Directory symlinks may be disabled in restricted non-Windows CI.  The
    // Windows junction path is required on the project's target platform.
    if (process.platform === 'win32' || !['EACCES', 'EPERM', 'ENOTSUP'].includes(error?.code)) {
      throw error;
    }
    console.log(`跳过受限平台目录别名回归：${error?.code || 'symlink_unavailable'}`);
  }
  if (aliasCreated) {
    const checkpointPath = path.join(realDirectory, 'checkpoint.json');
    const reportPath = path.join(realDirectory, 'report.json');
    const rawTelemetryPath = path.join(realDirectory, 'raw.json');
    const result = spawnSync(process.execPath, [
      path.join(root, 'js', 'ai.ab.simulation.js'),
      '1', '990011', 'root-pimc-v1', 'expert', '--levels=2', '--summary-only', '--json',
      `--report=${reportPath}`, `--checkpoint=${checkpointPath}`,
      `--raw-telemetry=${rawTelemetryPath}`,
      `--environment-telemetry=${path.join(aliasDirectory, 'checkpoint.json')}`,
    ], { cwd: root, encoding: 'utf8', timeout: TEST_RUNNER_TIMEOUT_MS });
    assert.notEqual(result.status, 0, '真实目录别名指向核心工件时必须在启动前拒绝');
    assert.match(`${result.stderr}${result.stdout}`, /路径不得覆盖 checkpoint/,
      '目录别名拒绝信息必须指出核心工件保护');
    assert(!fs.existsSync(checkpointPath), '目录别名冲突拒绝不得创建 checkpoint');
    fs.unlinkSync(aliasDirectory);
  }
}

console.log('PERF-2：A/B smoke 写出按运行段 sidecar');
{
  const temporary = makeTemporaryDirectory('guandan-perf2-');
  const reportPath = path.join(temporary, 'report.json');
  const checkpointPath = path.join(temporary, 'checkpoint.json');
  const result = spawnSync(process.execPath, [
    path.join(root, 'js', 'ai.ab.simulation.js'),
    '1', '990009', 'root-pimc-v1', 'expert', '--levels=2', '--summary-only', '--json',
    `--report=${reportPath}`, `--checkpoint=${checkpointPath}`,
    `--environment-telemetry=${checkpointPath}.environment-telemetry.json`,
  ], { cwd: root, encoding: 'utf8', timeout: TEST_RUNNER_TIMEOUT_MS });
  assert.equal(result.status, 0, String(result.stderr || result.stdout).slice(-1600));
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const segment = report.performance?.byRunSegment?.[0];
  assert(['complete', 'partial'].includes(segment?.environmentTelemetry?.status));
  assert.equal(segment.environmentTelemetry.resume, false);
  assert(segment.environmentTelemetry.samples.every((sample) => (
    sample.externalLoad.available === (process.platform !== 'win32')
  )), 'Windows loadavg sentinel must remain explicitly unavailable');
  assert(segment.environmentTelemetry.samples.some((sample) => sample.kind === 'checkpoint'));
  assert(segment.environmentTelemetry.checkpointWrites.length >= 1);
  const checkpointIndices = segment.environmentTelemetry.checkpointWrites
    .map((entry) => entry.nextBlockIndex);
  assert.equal(new Set(checkpointIndices).size, checkpointIndices.length,
    '每个 checkpoint nextBlockIndex 只能记录一次，避免末尾重复写入');
  assert.deepEqual(checkpointIndices, checkpointIndices.slice().sort((a, b) => a - b),
    'checkpoint 计时必须按 nextBlockIndex 递增');
  assert.equal(checkpointIndices.at(-1), segment.endBlockIndex,
    'checkpoint 计时末项必须覆盖运行段终点');
  const sidecarPath = `${checkpointPath}.environment-telemetry.json`;
  const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
  assert.equal(sidecar.schema, ENVIRONMENT_TELEMETRY_SIDECAR_SCHEMA);
  assert.equal(sidecar.diagnosticOnly, true);
  assert.equal(sidecar.formalGateEligible, false);
  assert.equal(sidecar.evaluationId, report.provenance.evaluationId);
  assert.equal(sidecar.segments.length, 1);
  const content = {
    schema: sidecar.schema,
    diagnosticOnly: sidecar.diagnosticOnly,
    formalGateEligible: sidecar.formalGateEligible,
    evaluationId: sidecar.evaluationId,
    checkpointSha256: sidecar.checkpointSha256,
    checkpointIntegritySha256: sidecar.checkpointIntegritySha256,
    nextBlockIndex: sidecar.nextBlockIndex,
    segments: sidecar.segments,
  };
  assert.equal(sidecar.artifactSha256, sha256Canonical(content),
    'sidecar artifactSha256 must be reproducible');
  assert.equal(sidecar.segments[0].telemetry.systemCpu.available,
    sidecar.segments[0].telemetry.systemCpu.samples > 0);
}

console.log('PERF-2：短 fresh→中断→resume 运行段回归');
{
  const temporary = makeTemporaryDirectory('guandan-perf2-resume-');
  const reportPath = path.join(temporary, 'report.json');
  const checkpointPath = path.join(temporary, 'checkpoint.json');
  const sidecarPath = `${checkpointPath}.environment-telemetry.json`;
  const args = [
    path.join(root, 'js', 'ai.ab.simulation.js'),
    '3', '990010', 'root-pimc-v1', 'expert', '--levels=2', '--summary-only', '--json',
    `--report=${reportPath}`, `--checkpoint=${checkpointPath}`,
    `--environment-telemetry=${sidecarPath}`,
  ];
  const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  child.stderr.on('data', (chunk) => { output += String(chunk); });
  let checkpointSeen = false;
  const deadline = Date.now() + TEST_RUNNER_TIMEOUT_MS;
  while (!checkpointSeen && Date.now() < deadline && child.exitCode == null) {
    if (fs.existsSync(checkpointPath)) {
      try {
        const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
        checkpointSeen = Number(checkpoint.nextBlockIndex) >= 1;
      } catch { /* wait for atomic rename to finish */ }
    }
    if (!checkpointSeen) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(checkpointSeen, true, `fresh smoke 未在完成看门狗时限内写出首个 checkpoint：${output.slice(-1200)}`);
  const exited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fresh smoke 子进程未退出')), 10000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  child.kill();
  await exited;

  const resumed = spawnSync(process.execPath, [...args, '--resume'], {
    cwd: root, encoding: 'utf8', timeout: TEST_RUNNER_TIMEOUT_MS,
  });
  assert.equal(resumed.status, 0,
    `resume smoke 应完成：${String(resumed.stderr || resumed.stdout).slice(-1600)}`);
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const segments = report.performance?.byRunSegment || [];
  assert(segments.length >= 2, 'fresh→resume 必须保留至少两个运行段');
  assert.equal(segments[0].environmentTelemetry.resume, false);
  assert(segments.slice(1).some((segment) => segment.environmentTelemetry?.resume === true),
    'resume 运行段必须显式标记 resume=true');
  const resumeSegment = segments.find((segment) => segment.environmentTelemetry?.resume === true);
  assert(resumeSegment.environmentTelemetry.resumeLoad,
    'resume 运行段必须记录 checkpoint 读取/解析/校验时序');
  assert(['primary', 'last-valid'].includes(resumeSegment.environmentTelemetry.resumeLoad.source));
  assert(resumeSegment.environmentTelemetry.checkpointWrites.length >= 1,
    'resume 运行段必须记录至少一次 checkpoint 分阶段计时');
  const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
  assert.equal(sidecar.segments.length, segments.length,
    '最终 sidecar 与报告必须包含同一批运行段');
  assert.equal(sidecar.nextBlockIndex, 3);
  assert.equal(sidecar.formalGateEligible, false);
  assert.equal(sidecar.segments.map((entry) => entry.runSegmentId).join(','),
    segments.map((entry) => entry.runSegmentId).join(','),
    'sidecar 运行段 ID 必须与报告逐项绑定');

  // Diagnostic corruption must not turn a valid core checkpoint into a
  // resume failure; it is surfaced as unavailable instead of a fake zero.
  const corruptedSidecar = { ...sidecar, checkpointSha256: '0'.repeat(64) };
  fs.writeFileSync(sidecarPath, `${JSON.stringify(corruptedSidecar)}\n`, 'utf8');
  const diagnosticOnlyResume = spawnSync(process.execPath, [...args, '--resume'], {
    cwd: root, encoding: 'utf8', timeout: TEST_RUNNER_TIMEOUT_MS,
  });
  assert.equal(diagnosticOnlyResume.status, 0,
    `sidecar 损坏不应阻断 checkpoint resume：${String(diagnosticOnlyResume.stderr || diagnosticOnlyResume.stdout).slice(-1200)}`);
  const unavailableReport = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert(unavailableReport.performance.byRunSegment
    .every((entry) => entry.environmentTelemetry.status === 'unavailable'),
  'sidecar 损坏必须显式降级为 unavailable');

  // A sidecar can remain self-consistent while omitting a later segment.  The
  // loader must validate the complete segment set transactionally and make
  // every recovered segment unavailable rather than exposing a partial mix.
  const incompleteSidecar = {
    ...sidecar,
    segments: sidecar.segments.slice(0, -1),
  };
  const incompleteContent = {
    schema: incompleteSidecar.schema,
    diagnosticOnly: incompleteSidecar.diagnosticOnly,
    formalGateEligible: incompleteSidecar.formalGateEligible,
    evaluationId: incompleteSidecar.evaluationId,
    checkpointSha256: incompleteSidecar.checkpointSha256,
    checkpointIntegritySha256: incompleteSidecar.checkpointIntegritySha256,
    nextBlockIndex: incompleteSidecar.nextBlockIndex,
    segments: incompleteSidecar.segments,
  };
  incompleteSidecar.artifactSha256 = sha256Canonical(incompleteContent);
  fs.writeFileSync(sidecarPath, `${JSON.stringify(incompleteSidecar)}\n`, 'utf8');
  const incompleteResume = spawnSync(process.execPath, [...args, '--resume'], {
    cwd: root, encoding: 'utf8', timeout: TEST_RUNNER_TIMEOUT_MS,
  });
  assert.equal(incompleteResume.status, 0,
    `缺失运行段的诊断 sidecar 不应阻断 checkpoint resume：${String(incompleteResume.stderr || incompleteResume.stdout).slice(-1200)}`);
  const incompleteReport = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert(incompleteReport.performance.byRunSegment
    .every((entry) => entry.environmentTelemetry.status === 'unavailable'),
  'sidecar 缺失后置运行段时，所有旧段必须统一降级为 unavailable');
}

console.log('PERF-2 environment telemetry regression: PASS');
