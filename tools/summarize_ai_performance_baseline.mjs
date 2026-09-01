#!/usr/bin/env node
/**
 * Build a strict, local performance receipt from completed A/B reports.
 *
 * A receipt is only formal when the current machine can independently
 * reproduce the report's source manifest and all evaluator run segments were
 * produced by this exact machine/runtime. Hashes make evidence auditable, not
 * remotely trusted machine attestation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { resolveHybridSearchConfig, resolvePolicyVariant } from '../js/ai.js';
import {
  AB_REPORT_SCHEMA,
  EVALUATION_ENVIRONMENT_SCHEMA,
  EVALUATION_PROVENANCE_SCHEMA,
  PERFORMANCE_BY_RUN_SEGMENT_SCHEMA,
  RUN_SEGMENT_SCHEMA,
  collectEvaluationEnvironment,
  environmentHashMatches,
  isSha256,
  isUuid,
  sha256Canonical,
  stableJson,
} from '../js/ai.ab.provenance.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const formalThresholds = Object.freeze({
  baseDealBlocks: 80,
  searchTriggeredDecisionTurns: 100,
  searchTriggeredMeasurementCoverage: 0.99,
  p95SearchTriggeredDecisionMsMax: 500,
  p99SearchTriggeredDecisionMsMax: 750,
  timeoutFallbackRateMaxExclusive: 0.005,
});
const formalLevels = Object.freeze(Array.from({ length: 13 }, (_, index) => index + 2));
const formalCandidates = Object.freeze(new Set([
  'root-pimc-v1', 'ismcts-v2', 'ismcts-v3',
]));
const options = parseArgs(process.argv.slice(2));
const summarizerEnvironment = collectEvaluationEnvironment();
const reports = options.report
  ? [readReport(options.report, '单引擎报告')]
  : [
    readReport(options.rootReport, 'root PIMC'),
    readReport(options.ismctsReport, 'ISMCTS'),
  ];

const formalSettingsUnchanged = Object.keys(options.diagnosticOverrides).length === 0;
const runs = reports.map((item) => item.summary);
const formalReceiptReady = formalSettingsUnchanged && runs.every((item) => item.complete);
const artifactBindings = {
  // A single-report receipt is the only form that can be consumed by the M2
  // gate.  Paired diagnostic receipts intentionally leave reportSha256 null.
  reportSha256: runs.length === 1 ? runs[0].sha256 : null,
  evaluationImplementationSha256: runs.length === 1 ? runs[0].evaluationImplementationSha256 : null,
  checkpointSha256: options.checkpoint ? sha256File(options.checkpoint, 'checkpoint') : null,
  rawTelemetrySha256: options.rawTelemetry ? sha256File(options.rawTelemetry, 'raw telemetry') : null,
};
const output = {
  schema: 'guandan-ai-performance-baseline-v3',
  generatedAt: new Date().toISOString(),
  thresholds: formalThresholds,
  formalReceiptReady,
  diagnosticOverrides: options.diagnosticOverrides,
  artifactBindings,
  summarizerEnvironment,
  runs,
  overall: {
    complete: runs.every((item) => item.complete),
    formalReceiptReady,
    allEnginesPass: formalReceiptReady && runs.every((item) => item.pass),
    decision: !formalReceiptReady
      ? 'performance_receipt_invalid'
      : runs.every((item) => item.pass)
        ? 'performance_gate_passed'
        : 'performance_gate_blocked',
  },
};

const serialized = `${JSON.stringify(output, null, 2)}\n`;
if (options.output && formalReceiptReady) {
  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  fs.writeFileSync(options.output, serialized, 'utf8');
}
console.log(serialized.trimEnd());
if (!output.overall.allEnginesPass) process.exitCode = 1;

function parseArgs(args) {
  const result = {
    rootReport: null,
    ismctsReport: null,
    report: null,
    output: null,
    checkpoint: null,
    rawTelemetry: null,
    diagnosticOverrides: {},
  };
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!['--report', '--root-report', '--ismcts-report', '--out', '--min-blocks',
      '--min-search-triggered-turns', '--min-measurement-coverage', '--checkpoint',
      '--raw-telemetry'].includes(key)) {
      throw new Error(`未知参数：${key}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${key} 需要一个值`);
    if (key === '--report') result.report = value;
    if (key === '--root-report') result.rootReport = value;
    if (key === '--ismcts-report') result.ismctsReport = value;
    if (key === '--out') result.output = path.resolve(value);
    if (key === '--checkpoint') result.checkpoint = path.resolve(value);
    if (key === '--raw-telemetry') result.rawTelemetry = path.resolve(value);
    if (key === '--min-blocks') result.diagnosticOverrides.minBlocks = value;
    if (key === '--min-search-triggered-turns') result.diagnosticOverrides.minSearchTriggeredTurns = value;
    if (key === '--min-measurement-coverage') result.diagnosticOverrides.minMeasurementCoverage = value;
    index += 1;
  }
  const hasNamedPair = !!result.rootReport || !!result.ismctsReport;
  if (result.report && hasNamedPair) {
    throw new Error('--report 不能与 --root-report / --ismcts-report 混用，避免伪造或重复引擎项');
  }
  if (!result.report && (!result.rootReport || !result.ismctsReport)) {
    throw new Error('用法：node tools/summarize_ai_performance_baseline.mjs --report 报告.json | --root-report 报告.json --ismcts-report 报告.json [--checkpoint 检查点.json --raw-telemetry 遥测.json] [--out 基线.json]');
  }
  return result;
}

function sha256File(file, label) {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) throw new Error(`${label} 文件不存在：${resolved}`);
  return createHash('sha256').update(fs.readFileSync(resolved)).digest('hex');
}

function readReport(file, label) {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) throw new Error(`${label}报告不存在：${resolved}`);
  const bytes = fs.readFileSync(resolved);
  let report;
  try {
    report = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`${label}报告不是有效 JSON：${error.message}`);
  }
  return {
    summary: summarizeReport(report, {
      label,
      file: resolved,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }),
  };
}

function summarizeReport(report, input) {
  if (!isRecord(report) || report.schema !== AB_REPORT_SCHEMA) {
    throw new Error(`${input.label}报告不是 ${AB_REPORT_SCHEMA}；历史报告仅可作诊断，不能形成正式性能回执`);
  }
  const config = report.config;
  const completion = report.completion;
  const performance = report.performance;
  if (!isRecord(config) || !isRecord(completion) || !isRecord(performance)) {
    throw new Error(`${input.label}报告缺少 config、completion 或 performance`);
  }
  const candidate = validateFormalConfiguration(config, input.label);
  const sourceBinding = recomputeImplementation(config.evaluationImplementation, input.label);
  const provenance = validateProvenance(report.provenance, config.baseDealBlocks, input.label);
  const telemetry = performance.decisionLatencyByPolicy?.[candidate];
  const triggered = telemetry?.searchTriggered;
  const allAIDecisions = performance.allAIDecisions;
  const hasDiagnosticEnvironmentTelemetry = Object.prototype.hasOwnProperty.call(
    performance,
    'environmentTelemetry',
  ) || (Array.isArray(performance.byRunSegment)
    && performance.byRunSegment.some((entry) => (
      isRecord(entry) && Object.prototype.hasOwnProperty.call(entry, 'environmentTelemetry')
    )));
  if (hasDiagnosticEnvironmentTelemetry) {
    throw new Error(`${input.label}报告包含 diagnostic-only environmentTelemetry；不能形成正式性能回执`);
  }
  if (!isRecord(telemetry) || !isRecord(triggered)) {
    throw new Error(`${input.label}报告缺少 ${candidate} 的显式 searchTriggered 遥测`);
  }
  if (!isRecord(allAIDecisions)) {
    throw new Error(`${input.label}报告缺少全体 AI 决策遥测；不能只凭候选搜索子集证明覆盖率`);
  }
  const segmentAccounting = validateSegmentPerformance(
    performance.byRunSegment,
    provenance,
    candidate,
    allAIDecisions,
    telemetry,
    report.hybrid,
    Number(completion.gamesCompleted),
    input.label,
  );
  const blocks = Number(config.baseDealBlocks);
  const expectedMirrorPairs = blocks * formalLevels.length;
  const expectedGames = expectedMirrorPairs * 2;
  const complete = config.comparison === 'expert'
    && config.deterministic === true
    && config.evaluationDesign === 'same-deal-cross-level-blocks'
    && blocks === formalThresholds.baseDealBlocks
    && Number(config.seedGroups) === expectedMirrorPairs
    && Number(config.gamesPlanned) === expectedGames
    && Number(completion.gamesCompleted) === expectedGames
    && Number(completion.mirrorPairsCompleted) === expectedMirrorPairs
    && Number(completion.baseDealBlocksCompleted) === blocks
    && Number(completion.failures) === 0
    && Number(completion.deadlocks) === 0
    && Number(completion.mirrorMismatches) === 0
    && sourceBinding.complete
    && provenance.complete
    && segmentAccounting.complete;
  const p95 = finiteOrNull(triggered.p95DecisionMs);
  const p99 = finiteOrNull(triggered.p99DecisionMs);
  const triggeredAccounting = telemetryAccounting(triggered);
  const allAIAccounting = telemetryAccounting(allAIDecisions);
  const fallbackRate = triggeredAccounting.timeoutFallbackRate;
  const aggregateFallbackRate = telemetryAccounting(telemetry).timeoutFallbackRate;
  const allAIMissingCounts = {
    missingVariantTurns: nonNegativeInteger(allAIDecisions.missingVariantTurns),
    missingLocalDecisionTurns: nonNegativeInteger(allAIDecisions.missingLocalDecisionTurns),
    missingSearchTelemetryTurns: nonNegativeInteger(allAIDecisions.missingSearchTelemetryTurns),
    missingFallbackKindTurns: nonNegativeInteger(allAIDecisions.missingFallbackKindTurns),
  };
  const allAIIntegrityComplete = allAIDecisions.integrityComplete === true
    && Object.values(allAIMissingCounts).every((count) => count === 0);
  const pass = complete
    && allAIIntegrityComplete
    && allAIAccounting.accountingValid
    && allAIAccounting.measurementCoverage != null
      && allAIAccounting.measurementCoverage >= formalThresholds.searchTriggeredMeasurementCoverage
    && allAIAccounting.fallbackEvaluableCoverage != null
      && allAIAccounting.fallbackEvaluableCoverage >= formalThresholds.searchTriggeredMeasurementCoverage
    && triggeredAccounting.accountingValid
    && triggeredAccounting.decisionTurns >= formalThresholds.searchTriggeredDecisionTurns
    && triggeredAccounting.measurementCoverage != null
      && triggeredAccounting.measurementCoverage >= formalThresholds.searchTriggeredMeasurementCoverage
    && triggeredAccounting.fallbackEvaluableCoverage != null
      && triggeredAccounting.fallbackEvaluableCoverage >= formalThresholds.searchTriggeredMeasurementCoverage
    && segmentAccounting.pass
    && p95 != null && p95 <= formalThresholds.p95SearchTriggeredDecisionMsMax
    && p99 != null && p99 <= formalThresholds.p99SearchTriggeredDecisionMsMax
    && fallbackRate != null && fallbackRate < formalThresholds.timeoutFallbackRateMaxExclusive;
  return {
    engine: candidate,
    label: input.label,
    file: input.file,
    sha256: input.sha256,
    evaluationImplementationSha256: sourceBinding.sha256,
    evaluationEnvironment: provenance.evaluationEnvironment,
    runSegmentsSha256: report.provenance.runSegmentsSha256,
    runSegments: provenance.runSegments.map((segment) => ({
      runSegmentId: segment.runSegmentId,
      ordinal: segment.ordinal,
      resume: segment.resume,
      startBlockIndex: segment.startBlockIndex,
      endBlockIndex: segment.endBlockIndex,
      inputCheckpointSha256: segment.inputCheckpointSha256,
      environmentSha256: segment.environment.environmentSha256,
    })),
    searchTriggeredByRunSegment: segmentAccounting.segments,
    complete,
    sourceBound: sourceBinding.complete,
    provenanceBound: provenance.complete,
    segmentAccountingBound: segmentAccounting.complete,
    gamesCompleted: Number(completion.gamesCompleted) || 0,
    mirrorPairsCompleted: Number(completion.mirrorPairsCompleted) || 0,
    baseDealBlocksCompleted: Number(completion.baseDealBlocksCompleted) || 0,
    failures: Number(completion.failures) || 0,
    deadlocks: Number(completion.deadlocks) || 0,
    mirrorMismatches: Number(completion.mirrorMismatches) || 0,
    decisionTurns: Number(telemetry.decisionTurns) || 0,
    measuredDecisionTurns: Number(telemetry.measuredDecisionTurns) || 0,
    unmeasuredDecisionTurns: Number(telemetry.unmeasuredDecisionTurns) || 0,
    averageDecisionMs: finiteOrNull(telemetry.averageDecisionMs),
    p95DecisionMs: finiteOrNull(telemetry.p95DecisionMs),
    p99DecisionMs: finiteOrNull(telemetry.p99DecisionMs),
    maxDecisionMs: finiteOrNull(telemetry.maxDecisionMs),
    fallbackEvaluableTurns: Number(telemetry.fallbackEvaluableTurns) || 0,
    timeoutFallbacks: Number(telemetry.timeoutFallbacks) || 0,
    timeoutFallbackRate: aggregateFallbackRate,
    allAIDecisions: {
      decisionTurns: allAIAccounting.decisionTurns,
      measuredDecisionTurns: allAIAccounting.measuredDecisionTurns,
      unmeasuredDecisionTurns: allAIAccounting.unmeasuredDecisionTurns,
      measurementCoverage: allAIAccounting.measurementCoverage,
      fallbackEvaluableTurns: allAIAccounting.fallbackEvaluableTurns,
      fallbackEvaluableCoverage: allAIAccounting.fallbackEvaluableCoverage,
      timeoutFallbacks: allAIAccounting.timeoutFallbacks,
      timeoutFallbackRate: allAIAccounting.timeoutFallbackRate,
      accountingValid: allAIAccounting.accountingValid,
      integrityComplete: allAIIntegrityComplete,
      ...allAIMissingCounts,
    },
    searchTriggered: {
      decisionTurns: triggeredAccounting.decisionTurns,
      measuredDecisionTurns: triggeredAccounting.measuredDecisionTurns,
      measurementCoverage: triggeredAccounting.measurementCoverage,
      averageDecisionMs: finiteOrNull(triggered.averageDecisionMs),
      p95DecisionMs: p95,
      p99DecisionMs: p99,
      maxDecisionMs: finiteOrNull(triggered.maxDecisionMs),
      fallbackEvaluableTurns: triggeredAccounting.fallbackEvaluableTurns,
      timeoutFallbacks: triggeredAccounting.timeoutFallbacks,
      timeoutFallbackRate: fallbackRate,
      accountingValid: triggeredAccounting.accountingValid,
      fallbackEvaluableCoverage: triggeredAccounting.fallbackEvaluableCoverage,
    },
    pass,
  };
}

function validateFormalConfiguration(config, label) {
  const candidate = typeof config.candidate === 'string' ? config.candidate : null;
  if (!candidate || !formalCandidates.has(candidate)) {
    throw new Error(`${label}报告候选策略不属于正式搜索候选集：${candidate || '缺失'}`);
  }
  if (!Array.isArray(config.evaluationLevels)
    || !sameStableJson(config.evaluationLevels, formalLevels)) {
    throw new Error(`${label}报告必须精确覆盖有序的 13 级 [2..14]`);
  }
  if (config.evaluationOpponentModelMode !== 'off') {
    throw new Error(`${label}报告未强制 evaluationOpponentModelMode=off`);
  }
  const variant = resolvePolicyVariant(candidate);
  if (variant.name !== candidate) {
    throw new Error(`${label}报告候选策略无法由当前策略定义复算：${candidate}`);
  }
  const expectedSearchConfig = resolveHybridSearchConfig(variant.decisionEngine, {
    deterministic: true,
    timeBudgetMs: 0,
  });
  if (!isRecord(config.candidateSearchConfig)
    || !sameStableJson(config.candidateSearchConfig, expectedSearchConfig)
    || config.candidateSearchConfig.searchMode !== expectedSearchConfig.searchMode) {
    throw new Error(`${label}报告的 candidateSearchConfig 与当前候选/搜索模式不一致`);
  }
  return candidate;
}

function recomputeImplementation(implementation, label) {
  if (!isRecord(implementation) || implementation.schema !== 'guandan-evaluation-implementation-v2'
    || !isSha256(implementation.sha256) || !Array.isArray(implementation.sources)) {
    throw new Error(`${label}报告缺少可复算的 guandan-evaluation-implementation-v2 清单`);
  }
  const expectedFiles = collectEvaluationRuntimeClosure();
  const sources = implementation.sources;
  if (sources.length !== expectedFiles.length) {
    throw new Error(`${label}报告源码清单数量不符；不能只接受 64 位摘要`);
  }
  const receiptFiles = sources.map((source) => source?.file);
  if (!sameStableJson(receiptFiles, expectedFiles)) {
    throw new Error(`${label}报告源码清单不是当前评测依赖闭包`);
  }
  const hash = createHash('sha256');
  for (const source of sources) {
    if (!isRecord(source) || Object.keys(source).length !== 2
      || typeof source.file !== 'string' || !isSha256(source.sha256)) {
      throw new Error(`${label}报告源码条目无效`);
    }
    const actual = createHash('sha256').update(fs.readFileSync(resolveProjectSource(source.file))).digest('hex');
    if (actual !== source.sha256) {
      throw new Error(`${label}报告源码 ${source.file} 与当前字节不一致`);
    }
    hash.update(source.file);
    hash.update('\0');
    hash.update(source.sha256);
    hash.update('\0');
  }
  const sha256 = hash.digest('hex');
  if (sha256 !== implementation.sha256) {
    throw new Error(`${label}报告源码清单聚合摘要不匹配`);
  }
  return { complete: true, sha256, files: expectedFiles };
}

function collectEvaluationRuntimeClosure() {
  const jsDirectory = path.join(projectRoot, 'js');
  const pending = [path.join(jsDirectory, 'ai.ab.simulation.js')];
  const visited = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    const source = fs.readFileSync(file, 'utf8');
    for (const dependencyPath of localModuleReferences(source)) {
      const dependency = path.resolve(path.dirname(file), dependencyPath);
      if (path.extname(dependency) !== '.js' || !(dependency === jsDirectory
        || dependency.startsWith(`${jsDirectory}${path.sep}`)) || !fs.existsSync(dependency)) {
        throw new Error(`当前评测依赖闭包无效：${dependencyPath}`);
      }
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

function resolveProjectSource(receiptFile) {
  if (typeof receiptFile !== 'string' || !/^js\/[A-Za-z0-9_.-]+$/.test(receiptFile)) {
    throw new Error(`非法源码清单路径：${receiptFile}`);
  }
  const resolved = path.resolve(projectRoot, receiptFile);
  const jsDirectory = path.join(projectRoot, 'js');
  if (!(resolved === jsDirectory || resolved.startsWith(`${jsDirectory}${path.sep}`))) {
    throw new Error(`源码清单路径逃逸项目：${receiptFile}`);
  }
  return resolved;
}

function validateProvenance(provenance, baseDealBlocks, label) {
  assertExactFields(provenance, [
    'schema', 'evaluationId', 'runSegments', 'runSegmentsSha256',
  ], `${label}.provenance`);
  if (provenance.schema !== EVALUATION_PROVENANCE_SCHEMA || !isUuid(provenance.evaluationId)
    || !Array.isArray(provenance.runSegments) || !isSha256(provenance.runSegmentsSha256)
    || provenance.runSegmentsSha256 !== sha256Canonical(provenance.runSegments)
    || provenance.runSegments.length === 0) {
    throw new Error(`${label}报告缺少完整运行段 provenance`);
  }
  const runSegments = provenance.runSegments;
  let expectedStart = 0;
  let previousRunSegmentId = null;
  const ids = new Set();
  for (let index = 0; index < runSegments.length; index += 1) {
    const segment = runSegments[index];
    assertExactFields(segment, [
      'schema', 'evaluationId', 'runSegmentId', 'ordinal', 'resume', 'previousRunSegmentId',
      'inputCheckpointSha256', 'startBlockIndex', 'endBlockIndex', 'startedAt', 'completedAt',
      'process', 'environment',
    ], `${label}.runSegments[${index}]`);
    assertExactFields(segment.process, ['pid', 'ppid'], `${label}.runSegments[${index}].process`);
    if (segment.schema !== RUN_SEGMENT_SCHEMA || segment.evaluationId !== provenance.evaluationId
      || !isUuid(segment.runSegmentId) || ids.has(segment.runSegmentId)
      || segment.ordinal !== index + 1 || typeof segment.resume !== 'boolean'
      || segment.resume !== (index > 0) || segment.previousRunSegmentId !== previousRunSegmentId
      || (index === 0 ? segment.inputCheckpointSha256 !== null : !isSha256(segment.inputCheckpointSha256))
      || !Number.isInteger(segment.startBlockIndex) || !Number.isInteger(segment.endBlockIndex)
      || segment.startBlockIndex !== expectedStart || segment.endBlockIndex <= segment.startBlockIndex
      || segment.endBlockIndex > baseDealBlocks || !isIsoTimestamp(segment.startedAt)
      || !isIsoTimestamp(segment.completedAt) || !Number.isInteger(segment.process.pid)
      || segment.process.pid < 1 || !(segment.process.ppid === null
        || (Number.isInteger(segment.process.ppid) && segment.process.ppid >= 0))) {
      throw new Error(`${label}报告运行段链不连续、不完整或存在伪造 resume 语义`);
    }
    validateEnvironment(segment.environment, `${label}.runSegments[${index}].environment`);
    if (!sameStableJson(segment.environment, summarizerEnvironment)) {
      throw new Error(`${label}报告的评测机或 Node 与当前汇总进程不一致；跨机器重汇总只能作诊断`);
    }
    ids.add(segment.runSegmentId);
    expectedStart = segment.endBlockIndex;
    previousRunSegmentId = segment.runSegmentId;
  }
  if (expectedStart !== baseDealBlocks) {
    throw new Error(`${label}报告运行段未精确覆盖全部基础牌区组`);
  }
  return {
    complete: true,
    runSegments,
    evaluationEnvironment: runSegments[0].environment,
  };
}

function validateEnvironment(environment, label) {
  assertExactFields(environment, [
    'schema', 'machine', 'runtime', 'environmentSha256',
  ], label);
  assertExactFields(environment.machine, [
    'hostnameSha256', 'platform', 'release', 'arch', 'cpuModel', 'logicalCores', 'memoryBytes',
  ], `${label}.machine`);
  assertExactFields(environment.runtime, ['node', 'v8'], `${label}.runtime`);
  if (environment.schema !== EVALUATION_ENVIRONMENT_SCHEMA || !environmentHashMatches(environment)
    || !isSha256(environment.machine.hostnameSha256) || typeof environment.machine.platform !== 'string'
    || !environment.machine.platform || typeof environment.machine.release !== 'string'
    || !environment.machine.release || typeof environment.machine.arch !== 'string'
    || !environment.machine.arch || typeof environment.machine.cpuModel !== 'string'
    || !environment.machine.cpuModel || !Number.isInteger(environment.machine.logicalCores)
    || environment.machine.logicalCores < 1 || !Number.isInteger(environment.machine.memoryBytes)
    || environment.machine.memoryBytes < 1 || typeof environment.runtime.node !== 'string'
    || !environment.runtime.node || typeof environment.runtime.v8 !== 'string' || !environment.runtime.v8) {
    throw new Error(`${label}环境摘要无效`);
  }
}

function validateSegmentPerformance(entries, provenance, candidate, allAIDecisions, candidateTelemetry,
  hybrid, expectedGamesCompleted, label) {
  if (!Array.isArray(entries) || entries.length !== provenance.runSegments.length) {
    throw new Error(`${label}报告缺少每个运行段的性能聚合`);
  }
  const byId = new Map();
  for (const entry of entries) {
    if (!isRecord(entry) || entry.schema !== PERFORMANCE_BY_RUN_SEGMENT_SCHEMA
      || !isUuid(entry.runSegmentId) || byId.has(entry.runSegmentId)
      || !Number.isInteger(entry.startBlockIndex) || !Number.isInteger(entry.endBlockIndex)
      || !Number.isInteger(entry.gamesCompleted) || entry.gamesCompleted < 0
      || !isRecord(entry.allAIDecisions) || !isRecord(entry.decisionLatencyByPolicy)
      || !isRecord(entry.hybrid)) {
      throw new Error(`${label}报告运行段性能结构无效`);
    }
    byId.set(entry.runSegmentId, entry);
  }
  const allFields = [
    'decisionTurns', 'measuredDecisionTurns', 'unmeasuredDecisionTurns', 'fallbackEvaluableTurns',
    'timeoutFallbacks', 'missingVariantTurns', 'missingLocalDecisionTurns',
    'missingSearchTelemetryTurns', 'missingFallbackKindTurns',
  ];
  const candidateFields = [
    'decisionTurns', 'measuredDecisionTurns', 'unmeasuredDecisionTurns', 'fallbackEvaluableTurns',
    'timeoutFallbacks',
  ];
  const allTotals = Object.fromEntries(allFields.map((field) => [field, 0]));
  const candidateTotals = Object.fromEntries(candidateFields.map((field) => [field, 0]));
  const triggeredTotals = Object.fromEntries(candidateFields.map((field) => [field, 0]));
  const hybridTotals = { turns: 0, searchModes: {} };
  let gamesCompleted = 0;
  const segments = [];
  let allSegmentsPass = true;
  for (const segment of provenance.runSegments) {
    const entry = byId.get(segment.runSegmentId);
    if (!entry || entry.startBlockIndex !== segment.startBlockIndex
      || entry.endBlockIndex !== segment.endBlockIndex) {
      throw new Error(`${label}报告运行段性能与 provenance 不对应`);
    }
    const expectedGames = (segment.endBlockIndex - segment.startBlockIndex) * formalLevels.length * 2;
    if (entry.gamesCompleted !== expectedGames) {
      throw new Error(`${label}报告运行段 gamesCompleted 未覆盖该段全部镜像对象`);
    }
    const segmentAll = telemetryAccounting(entry.allAIDecisions);
    const segmentCandidate = telemetryAccounting(entry.decisionLatencyByPolicy[candidate]);
    if (!segmentAll.accountingValid || !segmentCandidate.accountingValid
      || !isRecord(entry.decisionLatencyByPolicy[candidate])
      || !isRecord(entry.decisionLatencyByPolicy[candidate].searchTriggered)) {
      throw new Error(`${label}报告运行段缺少完整候选遥测`);
    }
    const segmentTriggered = telemetryAccounting(entry.decisionLatencyByPolicy[candidate].searchTriggered);
    const segmentP95 = finiteOrNull(entry.decisionLatencyByPolicy[candidate].searchTriggered.p95DecisionMs);
    const segmentP99 = finiteOrNull(entry.decisionLatencyByPolicy[candidate].searchTriggered.p99DecisionMs);
    const segmentPass = segmentTriggered.accountingValid
      && segmentTriggered.decisionTurns >= formalThresholds.searchTriggeredDecisionTurns
      && segmentTriggered.measurementCoverage != null
        && segmentTriggered.measurementCoverage >= formalThresholds.searchTriggeredMeasurementCoverage
      && segmentTriggered.fallbackEvaluableCoverage != null
        && segmentTriggered.fallbackEvaluableCoverage >= formalThresholds.searchTriggeredMeasurementCoverage
      && segmentP95 != null && segmentP95 <= formalThresholds.p95SearchTriggeredDecisionMsMax
      && segmentP99 != null && segmentP99 <= formalThresholds.p99SearchTriggeredDecisionMsMax
      && segmentTriggered.timeoutFallbackRate != null
        && segmentTriggered.timeoutFallbackRate < formalThresholds.timeoutFallbackRateMaxExclusive;
    allSegmentsPass &&= segmentPass;
    segments.push({
      runSegmentId: segment.runSegmentId,
      decisionTurns: segmentTriggered.decisionTurns,
      measuredDecisionTurns: segmentTriggered.measuredDecisionTurns,
      measurementCoverage: segmentTriggered.measurementCoverage,
      p95DecisionMs: segmentP95,
      p99DecisionMs: segmentP99,
      timeoutFallbackRate: segmentTriggered.timeoutFallbackRate,
      pass: segmentPass,
    });
    if (!exactSearchModes(entry.hybrid.searchModes, entry.hybrid.turns, candidate)) {
      throw new Error(`${label}报告运行段 hybrid.searchModes 与候选 searchMode 不一致`);
    }
    for (const field of allFields) {
      const value = nonNegativeInteger(entry.allAIDecisions[field]);
      if (value == null) throw new Error(`${label}报告运行段 allAIDecisions.${field} 无效`);
      allTotals[field] += value;
    }
    for (const field of candidateFields) {
      const value = nonNegativeInteger(entry.decisionLatencyByPolicy[candidate][field]);
      if (value == null) throw new Error(`${label}报告运行段候选遥测 ${field} 无效`);
      candidateTotals[field] += value;
    }
    for (const field of candidateFields) {
      const value = nonNegativeInteger(entry.decisionLatencyByPolicy[candidate].searchTriggered[field]);
      if (value == null) throw new Error(`${label}报告运行段 searchTriggered.${field} 无效`);
      triggeredTotals[field] += value;
    }
    hybridTotals.turns += Number(entry.hybrid.turns);
    for (const [mode, value] of Object.entries(entry.hybrid.searchModes)) {
      hybridTotals.searchModes[mode] = (hybridTotals.searchModes[mode] || 0) + Number(value);
    }
    gamesCompleted += entry.gamesCompleted;
  }
  if (gamesCompleted !== expectedGamesCompleted
    || !sameIntegerFields(allTotals, allAIDecisions, allFields)
    || !sameIntegerFields(candidateTotals, candidateTelemetry, candidateFields)
    || !sameIntegerFields(triggeredTotals, candidateTelemetry.searchTriggered, candidateFields)) {
    throw new Error(`${label}报告运行段遥测/对象计数与总体不守恒`);
  }
  if (!isRecord(hybrid) || !exactSearchModes(hybrid.searchModes, hybrid.turns, candidate)
    || Number(hybrid.turns) !== hybridTotals.turns
    || !sameStableJson(hybrid.searchModes, hybridTotals.searchModes)) {
    throw new Error(`${label}报告总体 hybrid.searchModes 与运行段性能不守恒`);
  }
  return { complete: true, gamesCompleted, pass: allSegmentsPass, segments };
}

function exactSearchModes(searchModes, turns, candidate) {
  const variant = resolvePolicyVariant(candidate);
  const expected = resolveHybridSearchConfig(variant.decisionEngine, {
    deterministic: true,
    timeBudgetMs: 0,
  }).searchMode;
  return isRecord(searchModes) && Object.keys(searchModes).length === 1
    && Object.prototype.hasOwnProperty.call(searchModes, expected)
    && Number.isInteger(searchModes[expected]) && searchModes[expected] >= 0
    && Number(searchModes[expected]) === Number(turns);
}

function sameIntegerFields(left, right, fields) {
  return fields.every((field) => left[field] === nonNegativeInteger(right?.[field]));
}

function assertExactFields(record, fields, label) {
  if (!isRecord(record) || Object.keys(record).length !== fields.length
    || fields.some((field) => !Object.prototype.hasOwnProperty.call(record, field))) {
    throw new Error(`${label} 字段不完整或包含未声明字段`);
  }
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sameStableJson(left, right) {
  try {
    return stableJson(left) === stableJson(right);
  } catch {
    return false;
  }
}

function isIsoTimestamp(value) {
  return typeof value === 'string' && value.length >= 20 && Number.isFinite(Date.parse(value));
}

function finiteOrNull(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function telemetryAccounting(telemetry) {
  const decisionTurns = nonNegativeInteger(telemetry?.decisionTurns);
  const measuredDecisionTurns = nonNegativeInteger(telemetry?.measuredDecisionTurns);
  const unmeasuredDecisionTurns = nonNegativeInteger(telemetry?.unmeasuredDecisionTurns);
  const fallbackEvaluableTurns = nonNegativeInteger(telemetry?.fallbackEvaluableTurns);
  const timeoutFallbacks = nonNegativeInteger(telemetry?.timeoutFallbacks);
  const accountingValid = decisionTurns != null
    && measuredDecisionTurns != null
    && unmeasuredDecisionTurns != null
    && fallbackEvaluableTurns != null
    && timeoutFallbacks != null
    && measuredDecisionTurns + unmeasuredDecisionTurns === decisionTurns
    && fallbackEvaluableTurns <= decisionTurns
    && timeoutFallbacks <= fallbackEvaluableTurns;
  return {
    decisionTurns: decisionTurns ?? 0,
    measuredDecisionTurns: measuredDecisionTurns ?? 0,
    unmeasuredDecisionTurns: unmeasuredDecisionTurns ?? 0,
    fallbackEvaluableTurns: fallbackEvaluableTurns ?? 0,
    timeoutFallbacks: timeoutFallbacks ?? 0,
    accountingValid,
    measurementCoverage: accountingValid && decisionTurns > 0
      ? measuredDecisionTurns / decisionTurns : null,
    fallbackEvaluableCoverage: accountingValid && decisionTurns > 0
      ? fallbackEvaluableTurns / decisionTurns : null,
    timeoutFallbackRate: accountingValid && fallbackEvaluableTurns > 0
      ? timeoutFallbacks / fallbackEvaluableTurns : null,
  };
}
