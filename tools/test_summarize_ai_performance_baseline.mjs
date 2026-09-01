#!/usr/bin/env node
/** Synthetic regression for formal A/B performance-receipt provenance. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveHybridSearchConfig, resolvePolicyVariant } from '../js/ai.js';
import {
  collectEvaluationEnvironment,
  sha256Canonical,
} from '../js/ai.ab.provenance.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tool = path.join(root, 'tools', 'summarize_ai_performance_baseline.mjs');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'guandan-performance-gate-'));
try {
  const rootReport = path.join(temporary, 'root.json');
  const ismctsReport = path.join(temporary, 'ismcts.json');
  write(rootReport, report('root-pimc-v1'));
  write(ismctsReport, report('ismcts-v3'));

  let result = run(rootReport, ismctsReport);
  assert.equal(result.status, 0, `两份完整同机报告应形成正式回执：${result.stderr}`);
  let receipt = JSON.parse(result.stdout);
  assert.equal(receipt.schema, 'guandan-ai-performance-baseline-v3', '性能回执必须升级为 provenance v3');
  assert.equal(receipt.overall.formalReceiptReady, true, '默认固定阈值和完整证据才可形成正式回执');
  assert.equal(receipt.overall.allEnginesPass, true, '两份合格完整报告应通过性能门');
  assert.equal(receipt.runs[0].runSegments.length, 2, '回执必须保留 fresh + resume 的运行段链');
  assert(receipt.runs[0].searchTriggeredByRunSegment.every((item) => item.pass),
    '每个贡献搜索数据的运行段都必须单独通过尾延迟门');

  const p95Failure = report('ismcts-v3');
  p95Failure.performance.byRunSegment[1].decisionLatencyByPolicy['ismcts-v3']
    .searchTriggered.p95DecisionMs = 800;
  write(ismctsReport, p95Failure);
  result = run(rootReport, ismctsReport);
  assert.notEqual(result.status, 0, '任一 resume 段 P95 超门不得由总体低延迟稀释');
  receipt = JSON.parse(result.stdout);
  assert.equal(receipt.runs[1].searchTriggeredByRunSegment[1].pass, false,
    '回执必须显式暴露失败运行段');

  const triggeredAccountingMismatch = report('ismcts-v3');
  for (const segmentPerformance of triggeredAccountingMismatch.performance.byRunSegment) {
    Object.assign(segmentPerformance.decisionLatencyByPolicy['ismcts-v3'].searchTriggered, {
      decisionTurns: 100,
      measuredDecisionTurns: 100,
      unmeasuredDecisionTurns: 0,
      fallbackEvaluableTurns: 100,
      timeoutFallbacks: 0,
      timeoutFallbackRate: 0,
    });
  }
  assertReject(triggeredAccountingMismatch, /运行段遥测\/对象计数与总体不守恒/,
    '各段各自合格但 searchTriggered 合计与总体不一致时必须拒绝');

  const forgedAggregate = report('ismcts-v3');
  forgedAggregate.config.evaluationImplementation.sha256 = 'a'.repeat(64);
  assertReject(forgedAggregate, /聚合摘要/,
    '伪造的 64 位 implementation 摘要不得形成正式性能回执');

  const forgedSource = report('ismcts-v3');
  forgedSource.config.evaluationImplementation.sources[0].sha256 = 'b'.repeat(64);
  refreshImplementationAggregate(forgedSource.config.evaluationImplementation);
  assertReject(forgedSource, /当前字节不一致/,
    '即使同步伪造单文件和聚合摘要，也必须由本机字节复算阻断');

  const missingSource = report('ismcts-v3');
  missingSource.config.evaluationImplementation.sources.pop();
  refreshImplementationAggregate(missingSource.config.evaluationImplementation);
  assertReject(missingSource, /源码清单数量/,
    '缺失依赖文件不得降格为仅检查摘要长度');

  const duplicateSource = report('ismcts-v3');
  duplicateSource.config.evaluationImplementation.sources[1] = structuredClone(
    duplicateSource.config.evaluationImplementation.sources[0],
  );
  refreshImplementationAggregate(duplicateSource.config.evaluationImplementation);
  assertReject(duplicateSource, /源码清单不是当前评测依赖闭包/,
    '重复路径不得伪装为完整源码清单');

  const missingRunSegments = report('ismcts-v3');
  missingRunSegments.provenance.runSegments = [];
  refreshProvenance(missingRunSegments);
  assertReject(missingRunSegments, /运行段 provenance/,
    '缺少运行段信息不得形成正式性能回执');

  const resumeWithoutInputCheckpoint = report('ismcts-v3');
  resumeWithoutInputCheckpoint.provenance.runSegments[1].inputCheckpointSha256 = null;
  refreshProvenance(resumeWithoutInputCheckpoint);
  assertReject(resumeWithoutInputCheckpoint, /resume 语义/,
    'resume 段缺失输入 checkpoint 摘要必须阻断');

  const gappedSegments = report('ismcts-v3');
  gappedSegments.provenance.runSegments[1].startBlockIndex = 41;
  refreshProvenance(gappedSegments);
  assertReject(gappedSegments, /运行段链不连续/,
    '运行段范围存在缺口时不得形成正式回执');

  const missingSegmentPerformance = report('ismcts-v3');
  missingSegmentPerformance.performance.byRunSegment.pop();
  assertReject(missingSegmentPerformance, /每个运行段的性能聚合/,
    '缺少某段性能聚合不得用总体分布替代');

  const diagnosticEnvironment = report('ismcts-v3');
  diagnosticEnvironment.performance.byRunSegment[0].environmentTelemetry = {
    schema: 'guandan-evaluation-environment-telemetry-artifact-v1',
    diagnosticOnly: true,
    formalGateEligible: false,
  };
  assertReject(diagnosticEnvironment, /diagnostic-only environmentTelemetry/,
    '带诊断环境遥测的报告不得伪装成正式性能回执');

  const rootDiagnosticEnvironment = report('ismcts-v3');
  rootDiagnosticEnvironment.performance.environmentTelemetry = {
    schema: 'guandan-evaluation-environment-telemetry-artifact-v1',
    diagnosticOnly: true,
    formalGateEligible: false,
  };
  assertReject(rootDiagnosticEnvironment, /diagnostic-only environmentTelemetry/,
    '性能根部带诊断环境遥测的报告不得被静默忽略');

  const otherMachine = report('ismcts-v3');
  const remoteEnvironment = structuredClone(otherMachine.provenance.runSegments[0].environment);
  remoteEnvironment.machine.hostnameSha256 = 'f'.repeat(64);
  refreshEnvironment(remoteEnvironment);
  for (const segment of otherMachine.provenance.runSegments) segment.environment = structuredClone(remoteEnvironment);
  refreshProvenance(otherMachine);
  assertReject(otherMachine, /跨机器重汇总/,
    '复制到另一台机器重新汇总不得形成正式性能回执');

  const missingLevel = report('ismcts-v3');
  missingLevel.config.evaluationLevels.pop();
  assertReject(missingLevel, /13 级/,
    '缺一个级牌不得形成正式回执');

  const duplicateLevel = report('ismcts-v3');
  duplicateLevel.config.evaluationLevels[12] = 13;
  assertReject(duplicateLevel, /13 级/,
    '重复级牌不得冒充完整 13 级覆盖');

  const opponentMode = report('ismcts-v3');
  opponentMode.config.evaluationOpponentModelMode = 'adaptive';
  assertReject(opponentMode, /OpponentModelMode=off/,
    '对手模型非 off 的评测不得形成正式性能回执');

  const mismatchedSearchMode = report('ismcts-v3');
  mismatchedSearchMode.config.candidateSearchConfig.searchMode = 'paired-root-pimc-v1';
  assertReject(mismatchedSearchMode, /candidateSearchConfig/,
    '候选与 searchMode 不一致必须阻断');

  const mismatchedObservedMode = report('ismcts-v3');
  mismatchedObservedMode.performance.byRunSegment[0].hybrid.searchModes = { 'ismcts-v2': 1000 };
  assertReject(mismatchedObservedMode, /hybrid\.searchModes/,
    '观察到的运行时 searchMode 不一致必须阻断');

  write(ismctsReport, report('ismcts-v3'));
  const diagnosticOut = path.join(temporary, 'diagnostic.json');
  result = runSingle(ismctsReport, '--min-blocks', '1', '--out', diagnosticOut);
  assert.notEqual(result.status, 0, '阈值覆盖只能产生诊断，不能降低正式门槛');
  receipt = JSON.parse(result.stdout);
  assert.equal(receipt.overall.formalReceiptReady, false, '覆写任一正式阈值时必须显式降为诊断');
  assert.equal(fs.existsSync(diagnosticOut), false, '诊断运行不得写出正式性能回执文件');

  result = spawnSync(process.execPath, [tool, '--report', ismctsReport,
    '--root-report', rootReport, '--ismcts-report', ismctsReport], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0, '单一模式不得与双报告模式混用');
  assert.match(`${result.stderr}${result.stdout}`, /不能与/, '拒绝信息必须说明不能混用');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

console.log('performance baseline provenance gate: OK');

function run(rootFile, ismctsFile) {
  return spawnSync(process.execPath, [tool, '--root-report', rootFile, '--ismcts-report', ismctsFile], {
    cwd: root,
    encoding: 'utf8',
  });
}

function runSingle(reportFile, ...extra) {
  return spawnSync(process.execPath, [tool, '--report', reportFile, ...extra], {
    cwd: root,
    encoding: 'utf8',
  });
}

function assertReject(value, pattern, message) {
  const file = path.join(temporary, `reject-${Math.random().toString(16).slice(2)}.json`);
  const out = path.join(temporary, `reject-${Math.random().toString(16).slice(2)}.receipt.json`);
  write(file, value);
  const result = runSingle(file, '--out', out);
  assert.notEqual(result.status, 0, message);
  assert.match(`${result.stderr}${result.stdout}`, pattern, message);
  assert.equal(fs.existsSync(out), false, '结构性无效报告不得写出正式回执文件');
}

function write(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function report(candidate) {
  const evaluationId = '11111111-1111-4111-8111-111111111111';
  const environment = collectEvaluationEnvironment();
  const runSegments = [
    segment({
      evaluationId,
      runSegmentId: '22222222-2222-4222-8222-222222222222',
      ordinal: 1,
      resume: false,
      previousRunSegmentId: null,
      inputCheckpointSha256: null,
      startBlockIndex: 0,
      endBlockIndex: 40,
      environment,
    }),
    segment({
      evaluationId,
      runSegmentId: '33333333-3333-4333-8333-333333333333',
      ordinal: 2,
      resume: true,
      previousRunSegmentId: '22222222-2222-4222-8222-222222222222',
      inputCheckpointSha256: 'c'.repeat(64),
      startBlockIndex: 40,
      endBlockIndex: 80,
      environment,
    }),
  ];
  const candidateTelemetry = telemetry(2000, 240, 400, 700);
  const allAIDecisions = allTelemetry(4000, 240, 400, 700);
  const searchMode = expectedSearchConfig(candidate).searchMode;
  return {
    schema: 'guandan-ai-ab-report-v1',
    provenance: {
      schema: 'guandan-evaluation-provenance-v1',
      evaluationId,
      runSegments,
      runSegmentsSha256: sha256Canonical(runSegments),
    },
    config: {
      candidate,
      comparison: 'expert',
      deterministic: true,
      evaluationDesign: 'same-deal-cross-level-blocks',
      baseDealBlocks: 80,
      seedGroups: 1040,
      gamesPlanned: 2080,
      evaluationLevels: Array.from({ length: 13 }, (_, index) => index + 2),
      evaluationOpponentModelMode: 'off',
      evaluationImplementation: implementationManifest(),
      hybridEngineVersion: 1,
      candidateSearchConfig: expectedSearchConfig(candidate),
    },
    completion: {
      gamesCompleted: 2080,
      mirrorPairsCompleted: 1040,
      baseDealBlocksCompleted: 80,
      failures: 0,
      deadlocks: 0,
      mirrorMismatches: 0,
    },
    hybrid: { turns: 2000, searchModes: { [searchMode]: 2000 } },
    performance: {
      allAIDecisions,
      decisionLatencyByPolicy: { [candidate]: candidateTelemetry },
      byRunSegment: runSegments.map((entry) => ({
        schema: 'guandan-ai-performance-by-run-segment-v1',
        runSegmentId: entry.runSegmentId,
        startBlockIndex: entry.startBlockIndex,
        endBlockIndex: entry.endBlockIndex,
        gamesCompleted: 1040,
        allAIDecisions: allTelemetry(2000, 120, 400, 700),
        decisionLatencyByPolicy: { [candidate]: telemetry(1000, 120, 400, 700) },
        hybrid: { turns: 1000, searchModes: { [searchMode]: 1000 } },
      })),
    },
  };
}

function segment(value) {
  return {
    schema: 'guandan-evaluation-run-segment-v1',
    evaluationId: value.evaluationId,
    runSegmentId: value.runSegmentId,
    ordinal: value.ordinal,
    resume: value.resume,
    previousRunSegmentId: value.previousRunSegmentId,
    inputCheckpointSha256: value.inputCheckpointSha256,
    startBlockIndex: value.startBlockIndex,
    endBlockIndex: value.endBlockIndex,
    startedAt: '2026-08-31T00:00:00.000Z',
    completedAt: '2026-08-31T00:01:00.000Z',
    process: { pid: 1234 + value.ordinal, ppid: 123 },
    environment: structuredClone(value.environment),
  };
}

function telemetry(decisionTurns, triggeredTurns, p95, p99) {
  return {
    decisionTurns,
    measuredDecisionTurns: decisionTurns,
    unmeasuredDecisionTurns: 0,
    averageDecisionMs: 40,
    p95DecisionMs: 80,
    p99DecisionMs: 100,
    maxDecisionMs: 120,
    fallbackEvaluableTurns: decisionTurns,
    timeoutFallbacks: 0,
    timeoutFallbackRate: 0,
    searchTriggered: {
      decisionTurns: triggeredTurns,
      measuredDecisionTurns: triggeredTurns,
      unmeasuredDecisionTurns: 0,
      averageDecisionMs: 300,
      p95DecisionMs: p95,
      p99DecisionMs: p99,
      maxDecisionMs: p99,
      fallbackEvaluableTurns: triggeredTurns,
      timeoutFallbacks: 0,
      timeoutFallbackRate: 0,
    },
  };
}

function allTelemetry(decisionTurns, triggeredTurns, p95, p99) {
  return {
    schema: 'guandan-evaluation-decision-telemetry-v2',
    ...telemetry(decisionTurns, triggeredTurns, p95, p99),
    integrityComplete: true,
    missingVariantTurns: 0,
    missingLocalDecisionTurns: 0,
    missingSearchTelemetryTurns: 0,
    missingFallbackKindTurns: 0,
  };
}

function expectedSearchConfig(candidate) {
  const variant = resolvePolicyVariant(candidate);
  return resolveHybridSearchConfig(variant.decisionEngine, { deterministic: true, timeBudgetMs: 0 });
}

function implementationManifest() {
  const files = collectEvaluationRuntimeClosure();
  const sources = files.map((file) => ({
    file,
    sha256: createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex'),
  }));
  const hash = createHash('sha256');
  for (const source of sources) {
    hash.update(source.file);
    hash.update('\0');
    hash.update(source.sha256);
    hash.update('\0');
  }
  return {
    schema: 'guandan-evaluation-implementation-v2',
    sha256: hash.digest('hex'),
    sources,
  };
}

function refreshImplementationAggregate(implementation) {
  const hash = createHash('sha256');
  for (const source of implementation.sources) {
    hash.update(source.file);
    hash.update('\0');
    hash.update(source.sha256);
    hash.update('\0');
  }
  implementation.sha256 = hash.digest('hex');
}

function refreshEnvironment(environment) {
  environment.environmentSha256 = sha256Canonical({
    schema: environment.schema,
    machine: environment.machine,
    runtime: environment.runtime,
  });
}

function refreshProvenance(value) {
  value.provenance.runSegmentsSha256 = sha256Canonical(value.provenance.runSegments);
}

function collectEvaluationRuntimeClosure() {
  const jsDirectory = path.join(root, 'js');
  const pending = [path.join(jsDirectory, 'ai.ab.simulation.js')];
  const visited = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    const source = fs.readFileSync(file, 'utf8');
    for (const dependencyPath of localModuleReferences(source)) {
      const dependency = path.resolve(path.dirname(file), dependencyPath);
      assert.equal(path.extname(dependency), '.js', `评测依赖必须显式指向 .js：${dependencyPath}`);
      assert(dependency === jsDirectory || dependency.startsWith(`${jsDirectory}${path.sep}`),
        `评测依赖不得逃出 js 目录：${dependencyPath}`);
      assert(fs.existsSync(dependency), `评测依赖不存在：${dependencyPath}`);
      pending.push(dependency);
    }
  }
  return [...visited]
    .map((file) => `js/${path.relative(jsDirectory, file).split(path.sep).join('/')}`)
    .sort();
}

function localModuleReferences(source) {
  return [...source.matchAll(
    /\bfrom\s*['"](\.[^'"]+)['"]|\bimport\s*(?:\(\s*)?['"](\.[^'"]+)['"]|\bnew\s+URL\s*\(\s*['"](\.[^'"]+)['"]/g,
  )].map((match) => match[1] || match[2] || match[3]);
}
