#!/usr/bin/env node
/**
 * M2 release gate for a local value-model evidence bundle.
 *
 * This gate deliberately consumes every artifact that can otherwise hide a
 * false green: the normal-arm report/checkpoint, raw decision telemetry, the
 * strict performance receipt, an independently resumed continuous-match run,
 * and the v3 blind-evaluation summary plus its manifest binding.  It is a
 * read-only gate; a receipt is written only when every check passes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { resolveHybridSearchConfig, resolvePolicyVariant } from '../js/ai.js';
import { describeUpgrade } from '../js/rules.js';
import { validateHybridValueModel } from '../js/ai-hybrid.js';
import { modelPayloadSha256 } from '../js/model-fingerprint.js';
import {
  evaluateValueModelPromotion,
  isPromotedValueModel,
  normalizeSeedManifest,
} from '../js/value-model-gate.js';
import {
  AB_REPORT_SCHEMA,
  CHECKPOINT_INTEGRITY_SCHEMA,
  CHECKPOINT_SCHEMA,
  EVALUATION_ENVIRONMENT_SCHEMA,
  EVALUATION_PROVENANCE_SCHEMA,
  RUN_SEGMENT_SCHEMA,
  collectEvaluationEnvironment,
  environmentHashMatches,
  isSha256,
  isUuid,
  sha256Canonical,
  stableJson,
} from '../js/ai.ab.provenance.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEVELS = Object.freeze(Array.from({ length: 13 }, (_, index) => index + 2));
const BLIND_SUMMARY_SCHEMA = 'guandan-blind-eval-summary-v3';
const BLIND_MANIFEST_SCHEMA = 'guandan-blind-eval-manifest-v2';
const BLIND_BINDING_SCHEMA = 'guandan-blind-eval-release-binding-v2';
const RAW_TELEMETRY_SCHEMA = 'guandan-ai-raw-telemetry-v1';
const PERFORMANCE_SCHEMA = 'guandan-ai-performance-baseline-v3';
const M2_SCHEMA = 'guandan-m2-release-validation-v1';
const GROUPS = 80;
const CONTINUOUS_MATCHES = 8;
const CURRENT_ENVIRONMENT = collectEvaluationEnvironment();
const NORMAL_GAME_FIELDS = Object.freeze([
  'ok', 'seed', 'level', 'candidateTeam', 'order', 'firstPlayer',
  'dealFingerprint', 'upgrade', 'utility', 'candidateHead', 'comparisonHead',
  'baselineHead', 'candidateDoubleUp', 'comparisonDoubleUp', 'baselineDoubleUp',
  'firstDivergence', 'hybrid', 'decisionTelemetry', 'actions', 'durationMs',
  'runSegmentId',
]);
const CONTINUOUS_GAME_FIELDS = Object.freeze([
  ...NORMAL_GAME_FIELDS.filter((field) => field !== 'runSegmentId'),
  'matchWinner', 'rounds', 'roundUpgradeUtility', 'roundResults', 'runSegmentId',
]);
const PAIR_FIELDS = Object.freeze([
  'group', 'block', 'seed', 'level', 'runSegmentId', 'mirrorMatched',
  'crossLevelMatched', 'dealFingerprint', 'complete', 'utility',
  'candidateHeads', 'candidateDoubleUps', 'comparisonDoubleUps', 'orders',
  'firstDivergences',
]);
const HYBRID_FIELDS = Object.freeze([
  'turns', 'applied', 'changed', 'samples', 'nodes', 'iterations', 'forceExpert',
  'wouldChange', 'searchModes', 'reasons', 'rejected',
]);
const TELEMETRY_FIELDS = Object.freeze([
  'seat', 'policy', 'engine', 'variantPresent', 'localDecisionPresent',
  'searchTelemetryPresent', 'fallbackKindPresent', 'telemetryComplete',
  'latencyMs', 'source', 'fallbackKind', 'fallbackEvaluable', 'timeoutFallback',
  'searchAttempted', 'searchTriggered', 'candidates', 'samples', 'nodes',
  'iterations',
]);
const CONTINUOUS_ROUND_FIELDS = Object.freeze([
  'round', 'level', 'levelsAfter', 'levelOwner', 'order', 'upgrade',
  'candidateUtility', 'aFailCount', 'aAttempt', 'aPassed', 'aFailed', 'aReset',
  'tribute', 'actions',
]);

function parseArgs(argv) {
  const options = {
    model: null,
    report: null,
    checkpoint: null,
    rawTelemetry: null,
    performance: null,
    continuousReport: null,
    continuousCheckpoint: null,
    blindSummary: null,
    blindManifest: null,
    blindScenarios: null,
    blindCatastrophic: null,
    blindBinding: null,
    out: null,
  };
  const keys = new Map([
    ['--model', 'model'],
    ['--report', 'report'],
    ['--checkpoint', 'checkpoint'],
    ['--raw-telemetry', 'rawTelemetry'],
    ['--performance', 'performance'],
    ['--continuous-report', 'continuousReport'],
    ['--continuous-checkpoint', 'continuousCheckpoint'],
    ['--blind-summary', 'blindSummary'],
    ['--blind-manifest', 'blindManifest'],
    ['--blind-scenarios', 'blindScenarios'],
    ['--blind-catastrophic', 'blindCatastrophic'],
    ['--blind-binding', 'blindBinding'],
    ['--out', 'out'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const target = keys.get(key);
    if (!target) throw new Error(`未知参数：${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${key} 需要文件路径`);
    options[target] = path.resolve(value);
    index += 1;
  }
  const required = Object.entries(options)
    .filter(([key]) => key !== 'out')
    .filter(([, value]) => !value)
    .map(([key]) => `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`);
  if (required.length) {
    throw new Error(`M2 验证器缺少必需工件：${required.join('、')}`);
  }
  return options;
}

function readJson(file, label) {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) throw new Error(`${label}不存在：${resolved}`);
  const bytes = fs.readFileSync(resolved);
  try {
    return {
      file: resolved,
      bytes,
      sha256: sha256Bytes(bytes),
      value: JSON.parse(bytes.toString('utf8')),
    };
  } catch (error) {
    throw new Error(`${label}不是有效 JSON：${error.message}`);
  }
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function assertExactFields(record, fields, label) {
  if (!isRecord(record) || Object.keys(record).length !== fields.length
    || fields.some((field) => !Object.prototype.hasOwnProperty.call(record, field))) {
    throw new Error(`${label} 字段不完整或包含未声明字段`);
  }
}

function sameStableJson(left, right) {
  try { return stableJson(left) === stableJson(right); } catch { return false; }
}

function finiteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function isIsoTimestamp(value) {
  return typeof value === 'string' && value.length >= 20 && Number.isFinite(Date.parse(value));
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = values.slice().sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

// Report/result fields from ai.ab.simulation.js use three decimal places by
// default.  Telemetry is the one deliberate exception and requests one
// decimal explicitly at its call sites below.
function rounded(value, digits = 3) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function roundedPair(values, digits = 3) {
  return values ? values.map((value) => rounded(value, digits)) : null;
}

function safeInteger(value, label, { min = null, max = null } = {}) {
  if (!Number.isSafeInteger(value)
    || (min != null && value < min) || (max != null && value > max)) {
    throw new Error(`${label} 必须是有效整数`);
  }
  return value;
}

function assertOrder(order, label) {
  if (!Array.isArray(order) || order.length !== 4
    || !order.every((seat) => Number.isInteger(seat) && seat >= 0 && seat <= 3)
    || new Set(order).size !== 4) {
    throw new Error(`${label} 必须是 0、1、2、3 的唯一排列`);
  }
}

function validateCountMap(value, label) {
  if (!isRecord(value)) throw new Error(`${label} 必须是对象`);
  for (const [key, count] of Object.entries(value)) {
    if (!key || !Number.isSafeInteger(count) || count < 0) {
      throw new Error(`${label} 含无效计数`);
    }
  }
}

function validateHybrid(hybrid, candidate, label) {
  assertExactFields(hybrid, HYBRID_FIELDS, label);
  for (const field of [
    'turns', 'applied', 'changed', 'samples', 'nodes', 'iterations', 'forceExpert', 'wouldChange',
  ]) safeInteger(hybrid[field], `${label}.${field}`, { min: 0 });
  if (hybrid.turns < 1 || hybrid.applied > hybrid.turns
    || hybrid.changed > hybrid.applied || hybrid.wouldChange > hybrid.applied
    || hybrid.forceExpert > hybrid.applied) {
    throw new Error(`${label} 计数范围无效`);
  }
  validateCountMap(hybrid.searchModes, `${label}.searchModes`);
  validateCountMap(hybrid.reasons, `${label}.reasons`);
  validateCountMap(hybrid.rejected, `${label}.rejected`);
  if (Object.values(hybrid.searchModes).reduce((sum, count) => sum + count, 0) !== hybrid.turns
    || Object.values(hybrid.reasons).reduce((sum, count) => sum + count, 0) !== hybrid.turns) {
    throw new Error(`${label} turns 与 searchModes/reasons 不守恒`);
  }
  const expectedMode = expectedSearchConfig(candidate).searchMode;
  if (Object.keys(hybrid.searchModes).length !== 1
    || hybrid.searchModes[expectedMode] !== hybrid.turns) {
    throw new Error(`${label} searchModes 未严格绑定当前候选搜索配置`);
  }
  // 正常臂的 changed 必须能由 wouldChange 逐回合复算；fxe 机制归因另有
  // 专用分析器，M2 不接受把不同口径的统计塞进正常臂。
  if (hybrid.changed !== hybrid.wouldChange && candidate !== 'ismcts-v3-fxe') {
    throw new Error(`${label} changed 与 wouldChange 不一致`);
  }
}

function validateTelemetry(telemetry, candidate, candidateTeam, label) {
  if (!Array.isArray(telemetry) || telemetry.length < 1) {
    throw new Error(`${label} decisionTelemetry 缺失或为空`);
  }
  const candidateVariant = resolvePolicyVariant(candidate);
  const expertVariant = resolvePolicyVariant('expert');
  for (let index = 0; index < telemetry.length; index += 1) {
    const item = telemetry[index];
    assertExactFields(item, TELEMETRY_FIELDS, `${label}[${index}]`);
    safeInteger(item.seat, `${label}[${index}].seat`, { min: 0, max: 3 });
    const expectedCandidate = [0, 2].includes(item.seat) ? 0 : 1;
    const expectedPolicy = expectedCandidate === candidateTeam ? candidate : 'expert';
    const expectedEngine = expectedPolicy === candidate ? candidateVariant.decisionEngine : expertVariant.decisionEngine;
    if (item.policy !== expectedPolicy || item.engine !== expectedEngine
      || item.variantPresent !== true || item.localDecisionPresent !== true
      || item.searchTelemetryPresent !== true || item.fallbackKindPresent !== true
      || item.telemetryComplete !== true || item.fallbackEvaluable !== true
      || typeof item.timeoutFallback !== 'boolean'
      || typeof item.searchAttempted !== 'boolean'
      || typeof item.searchTriggered !== 'boolean'
      || (item.searchTriggered && !item.searchAttempted)) {
      throw new Error(`${label}[${index}] 策略或完整性字段无效`);
    }
    if (!(typeof item.latencyMs === 'number' && Number.isFinite(item.latencyMs)
      && item.latencyMs >= 0)
      || typeof item.source !== 'string' || !item.source
      || typeof item.fallbackKind !== 'string' || !item.fallbackKind) {
      throw new Error(`${label}[${index}] latency/source/fallback 字段无效`);
    }
    if (item.timeoutFallback !== (item.fallbackKind === 'local_timeout')) {
      throw new Error(`${label}[${index}] timeoutFallback 与 fallbackKind 不一致`);
    }
    for (const field of ['candidates', 'samples', 'nodes', 'iterations']) {
      safeInteger(item[field], `${label}[${index}].${field}`, { min: 0 });
    }
  }
}

function validateContinuousRound(round, candidateTeam, label) {
  assertExactFields(round, CONTINUOUS_ROUND_FIELDS, label);
  safeInteger(round.round, `${label}.round`, { min: 1 });
  safeInteger(round.level, `${label}.level`, { min: 2, max: 14 });
  if (!Array.isArray(round.levelsAfter) || round.levelsAfter.length !== 2
    || !round.levelsAfter.every((level) => Number.isInteger(level) && level >= 2 && level <= 14)) {
    throw new Error(`${label}.levelsAfter 无效`);
  }
  safeInteger(round.levelOwner, `${label}.levelOwner`, { min: 0, max: 1 });
  assertOrder(round.order, `${label}.order`);
  safeInteger(round.upgrade, `${label}.upgrade`, { min: 1, max: 3 });
  const winnerTeam = [0, 2].includes(round.order[0]) ? 0 : 1;
  const expectedUpgrade = describeUpgrade(
    round.order, (seat) => ([0, 2].includes(seat) ? 0 : 1),
  ).levels;
  if (typeof round.candidateUtility !== 'number' || !Number.isFinite(round.candidateUtility)
    || round.upgrade !== expectedUpgrade
    || round.candidateUtility !== (winnerTeam === candidateTeam ? expectedUpgrade : -expectedUpgrade)
    || !Array.isArray(round.aFailCount) || round.aFailCount.length !== 2
    || !round.aFailCount.every((value) => Number.isSafeInteger(value) && value >= 0)
    || ![round.aAttempt, round.aPassed, round.aFailed, round.aReset, round.tribute]
      .every((value) => typeof value === 'boolean')) {
    throw new Error(`${label} 连续赛结果字段无效`);
  }
  if (round.aPassed && (!round.aAttempt || round.aFailed || round.aReset)
    || round.aFailed && (!round.aAttempt || round.aPassed)
    || round.aReset && !round.aFailed) {
    throw new Error(`${label} A 级路径字段自相矛盾`);
  }
  safeInteger(round.actions, `${label}.actions`, { min: 1 });
}

function checkpointContent(checkpoint) {
  return {
    schema: checkpoint.schema,
    signature: checkpoint.signature,
    signaturePayload: checkpoint.signaturePayload,
    nextBlockIndex: checkpoint.nextBlockIndex,
    complete: checkpoint.complete,
    provenance: checkpoint.provenance,
    games: checkpoint.games,
    pairs: checkpoint.pairs,
    failures: checkpoint.failures,
  };
}

function checkpointContentSha256(checkpoint) {
  return sha256Bytes(Buffer.from(JSON.stringify(checkpointContent(checkpoint))));
}

function validateEnvironment(environment, label) {
  assertExactFields(environment, ['schema', 'machine', 'runtime', 'environmentSha256'], label);
  assertExactFields(environment.machine, [
    'hostnameSha256', 'platform', 'release', 'arch', 'cpuModel', 'logicalCores', 'memoryBytes',
  ], `${label}.machine`);
  assertExactFields(environment.runtime, ['node', 'v8'], `${label}.runtime`);
  if (environment.schema !== EVALUATION_ENVIRONMENT_SCHEMA
    || !environmentHashMatches(environment)
    || !isSha256(environment.machine.hostnameSha256)
    || typeof environment.machine.platform !== 'string' || !environment.machine.platform
    || typeof environment.machine.release !== 'string' || !environment.machine.release
    || typeof environment.machine.arch !== 'string' || !environment.machine.arch
    || typeof environment.machine.cpuModel !== 'string' || !environment.machine.cpuModel
    || !Number.isInteger(environment.machine.logicalCores) || environment.machine.logicalCores < 1
    || !Number.isInteger(environment.machine.memoryBytes) || environment.machine.memoryBytes < 1
    || typeof environment.runtime.node !== 'string' || !environment.runtime.node
    || typeof environment.runtime.v8 !== 'string' || !environment.runtime.v8) {
    throw new Error(`${label} 环境摘要无效`);
  }
  if (!sameStableJson(environment, CURRENT_ENVIRONMENT)) {
    throw new Error(`${label} 与当前验证进程的机器或 Node/V8 不一致`);
  }
}

function validateProvenance(provenance, baseBlocks, label) {
  assertExactFields(provenance, ['schema', 'evaluationId', 'runSegments', 'runSegmentsSha256'], label);
  if (provenance.schema !== EVALUATION_PROVENANCE_SCHEMA
    || !isUuid(provenance.evaluationId)
    || !Array.isArray(provenance.runSegments)
    || !isSha256(provenance.runSegmentsSha256)
    || provenance.runSegments.length === 0
    || provenance.runSegmentsSha256 !== sha256Canonical(provenance.runSegments)) {
    throw new Error(`${label} 缺少完整运行段 provenance`);
  }
  const ids = new Set();
  let expectedStart = 0;
  let previous = null;
  for (let index = 0; index < provenance.runSegments.length; index += 1) {
    const segment = provenance.runSegments[index];
    assertExactFields(segment, [
      'schema', 'evaluationId', 'runSegmentId', 'ordinal', 'resume', 'previousRunSegmentId',
      'inputCheckpointSha256', 'startBlockIndex', 'endBlockIndex', 'startedAt', 'completedAt',
      'process', 'environment',
    ], `${label}.runSegments[${index}]`);
    assertExactFields(segment.process, ['pid', 'ppid'], `${label}.runSegments[${index}].process`);
    if (segment.schema !== RUN_SEGMENT_SCHEMA
      || segment.evaluationId !== provenance.evaluationId
      || !isUuid(segment.runSegmentId) || ids.has(segment.runSegmentId)
      || segment.ordinal !== index + 1 || segment.resume !== (index > 0)
      || segment.previousRunSegmentId !== previous
      || (index === 0 ? segment.inputCheckpointSha256 !== null : !isSha256(segment.inputCheckpointSha256))
      || !Number.isInteger(segment.startBlockIndex) || !Number.isInteger(segment.endBlockIndex)
      || segment.startBlockIndex !== expectedStart || segment.endBlockIndex <= segment.startBlockIndex
      || segment.endBlockIndex > baseBlocks || !isIsoTimestamp(segment.startedAt)
      || !isIsoTimestamp(segment.completedAt)
      || !Number.isInteger(segment.process.pid) || segment.process.pid < 1
      || !(segment.process.ppid === null
        || (Number.isInteger(segment.process.ppid) && segment.process.ppid >= 0))) {
      throw new Error(`${label} 运行段链不连续或存在伪造 resume 语义`);
    }
    validateEnvironment(segment.environment, `${label}.runSegments[${index}].environment`);
    ids.add(segment.runSegmentId);
    expectedStart = segment.endBlockIndex;
    previous = segment.runSegmentId;
  }
  if (expectedStart !== baseBlocks) throw new Error(`${label} 未精确覆盖全部基础牌区组`);
  return { ids, runSegments: provenance.runSegments, evaluationId: provenance.evaluationId };
}

function localModuleReferences(source) {
  return [...source.matchAll(
    /\bfrom\s*['"](\.[^'"]+)['"]|\bimport\s*(?:\(\s*)?['"](\.[^'"]+)['"]|\bnew\s+URL\s*\(\s*['"](\.[^'"]+)['"]/g,
  )].map((match) => match[1] || match[2] || match[3]);
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
      if (path.extname(dependency) !== '.js'
        || !(dependency === jsDirectory || dependency.startsWith(`${jsDirectory}${path.sep}`))
        || !fs.existsSync(dependency)) {
        throw new Error(`当前评测依赖闭包无效：${dependencyPath}`);
      }
      pending.push(dependency);
    }
  }
  return [...visited].map((file) => `js/${path.relative(jsDirectory, file).split(path.sep).join('/')}`).sort();
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

function validateImplementation(implementation, label) {
  if (!isRecord(implementation) || implementation.schema !== 'guandan-evaluation-implementation-v2'
    || !isSha256(implementation.sha256) || !Array.isArray(implementation.sources)) {
    throw new Error(`${label} 缺少可复算的 guandan-evaluation-implementation-v2 清单`);
  }
  const expectedFiles = collectEvaluationRuntimeClosure();
  if (implementation.sources.length !== expectedFiles.length) {
    throw new Error(`${label} 源码清单数量与当前评测闭包不符`);
  }
  const files = implementation.sources.map((entry) => entry?.file);
  if (!sameStableJson(files, expectedFiles)) throw new Error(`${label} 源码清单不是当前评测依赖闭包`);
  const hash = createHash('sha256');
  for (const entry of implementation.sources) {
    if (!isRecord(entry) || Object.keys(entry).length !== 2
      || typeof entry.file !== 'string' || !isSha256(entry.sha256)) {
      throw new Error(`${label} 源码条目无效`);
    }
    const actual = sha256Bytes(fs.readFileSync(resolveProjectSource(entry.file)));
    if (actual !== entry.sha256) throw new Error(`${label} ${entry.file} 与当前字节不一致`);
    hash.update(entry.file); hash.update('\0'); hash.update(entry.sha256); hash.update('\0');
  }
  const aggregate = hash.digest('hex');
  if (aggregate !== implementation.sha256) throw new Error(`${label} 聚合摘要不匹配`);
  return { sha256: aggregate, files: expectedFiles };
}

function expectedSearchConfig(candidate) {
  const variant = resolvePolicyVariant(candidate);
  if (variant.name !== candidate) throw new Error(`候选策略无法由当前定义复算：${candidate}`);
  return resolveHybridSearchConfig(variant.decisionEngine, { deterministic: true, timeBudgetMs: 0 });
}

function validateConfiguration(config, modelHash, implementationHash, label, continuous = false) {
  if (!isRecord(config)) throw new Error(`${label} 缺少 config`);
  if (typeof config.candidate !== 'string' || !config.candidate) throw new Error(`${label} 缺少 candidate`);
  if (config.comparison !== 'expert' || config.deterministic !== true
    || config.difficulty !== 'master' || config.evaluationOpponentModelMode !== 'off') {
    throw new Error(`${label} 未固定 expert/master/deterministic/OpponentModelMode=off`);
  }
  const expected = expectedSearchConfig(config.candidate);
  if (!sameStableJson(config.candidateSearchConfig, expected)) {
    throw new Error(`${label} candidateSearchConfig 与当前候选不一致`);
  }
  const valueModelHash = String(config.valueModel?.sha256 || '').toLowerCase();
  if (valueModelHash !== modelHash) throw new Error(`${label} 模型语义摘要不一致`);
  const implementation = validateImplementation(config.evaluationImplementation, `${label}.evaluationImplementation`);
  if (implementation.sha256 !== implementationHash) throw new Error(`${label} 源码摘要不一致`);
  if (continuous) {
    if (config.continuousMatch !== true || config.outcomeUnit !== 'match win (+1/-1)'
      || Number(config.baseDealBlocks) !== CONTINUOUS_MATCHES / 2
      || Number(config.seedGroups) !== CONTINUOUS_MATCHES / 2
      || Number(config.gamesPlanned) !== CONTINUOUS_MATCHES
      || !sameStableJson(config.evaluationLevels, [2])
      || config.evaluationDesign !== 'legacy-level-cycle') {
      throw new Error(`${label} 不是严格连续赛配置`);
    }
  } else if (config.continuousMatch !== false
    || config.evaluationDesign !== 'same-deal-cross-level-blocks'
    || !sameStableJson(config.evaluationLevels, LEVELS)
    || Number(config.baseDealBlocks) !== GROUPS
    || Number(config.seedGroups) !== GROUPS * LEVELS.length
    || Number(config.gamesPlanned) !== GROUPS * LEVELS.length * 2) {
    throw new Error(`${label} 不是完整 80 区组 × 13 级正常臂`);
  }
  return { candidate: config.candidate, expectedSearchConfig: expected };
}

function expectedGameCoordinates(baseSeed, blocks, levels) {
  const result = [];
  for (let block = 0; block < blocks; block += 1) {
    const seed = (Number(baseSeed) + block) >>> 0;
    for (const level of levels) {
      for (const candidateTeam of [0, 1]) result.push(`${seed}/${level}/${candidateTeam}`);
    }
  }
  return result;
}

function validateCoverage(checkpoint, config, provenance, label) {
  if (!Array.isArray(checkpoint.games) || !Array.isArray(checkpoint.pairs)) {
    throw new Error(`${label} games/pairs 必须是数组`);
  }
  const levels = config.continuousMatch ? (config.evaluationLevels || [2]) : LEVELS;
  const blocks = Number(config.baseDealBlocks);
  const baseSeed = Number(config.baseSeed);
  const expectedGames = expectedGameCoordinates(baseSeed, blocks, levels);
  const expectedPairs = expectedGames.filter((key) => key.endsWith('/0'))
    .map((key) => key.slice(0, key.lastIndexOf('/')));
  const games = new Map();
  for (const [index, game] of checkpoint.games.entries()) {
    const expectedFields = config.continuousMatch ? CONTINUOUS_GAME_FIELDS : NORMAL_GAME_FIELDS;
    assertExactFields(game, expectedFields, `${label}.games[${index}]`);
    if (!isRecord(game) || !Number.isSafeInteger(game.seed) || !Number.isSafeInteger(game.level)
      || ![0, 1].includes(game.candidateTeam) || game.ok !== true
      || typeof game.runSegmentId !== 'string' || !provenance.ids.has(game.runSegmentId)) {
      throw new Error(`${label}.games[${index}] 缺少可审计坐标或运行段字段`);
    }
    const key = `${game.seed}/${game.level}/${game.candidateTeam}`;
    if (games.has(key)) throw new Error(`${label} games 存在重复 seed×level×team`);
    const expectedPair = expectedPairs.find((pairKey) => pairKey === `${game.seed}/${game.level}`);
    if (!expectedPair) throw new Error(`${label}.games[${index}] 不属于预登记覆盖`);
    const blockIndex = Number(game.seed) - baseSeed;
    const segment = provenance.runSegments.find((item) => (
      blockIndex >= item.startBlockIndex && blockIndex < item.endBlockIndex
    ));
    if (!segment || segment.runSegmentId !== game.runSegmentId) {
      throw new Error(`${label}.games[${index}] runSegmentId 未覆盖所属区组`);
    }
    validateGameRecord(game, config, `${label}.games[${index}]`);
    games.set(key, game);
  }
  if (games.size !== expectedGames.length || !expectedGames.every((key) => games.has(key))) {
    throw new Error(`${label} games 未精确覆盖 seed×level×team`);
  }
  const pairs = new Map();
  for (const [index, pair] of checkpoint.pairs.entries()) {
    assertExactFields(pair, PAIR_FIELDS, `${label}.pairs[${index}]`);
    if (!isRecord(pair) || !Number.isSafeInteger(pair.seed) || !Number.isSafeInteger(pair.level)
      || typeof pair.runSegmentId !== 'string' || !provenance.ids.has(pair.runSegmentId)) {
      throw new Error(`${label}.pairs[${index}] 缺少完整镜像/运行段字段`);
    }
    const key = `${pair.seed}/${pair.level}`;
    if (pairs.has(key)) throw new Error(`${label} pairs 存在重复 seed×level`);
    const even = games.get(`${key}/0`);
    const odd = games.get(`${key}/1`);
    if (!even || !odd) {
      throw new Error(`${label} pair↔game 的牌面、先手或运行段不一致`);
    }
    validatePairRecord(pair, even, odd, config, `${label}.pairs[${index}]`);
    pairs.set(key, pair);
  }
  if (pairs.size !== expectedPairs.length || !expectedPairs.every((key) => pairs.has(key))) {
    throw new Error(`${label} pairs 未精确覆盖 seed×level`);
  }
  if (!config.continuousMatch) {
    for (let block = 0; block < blocks; block += 1) {
      const seed = (baseSeed + block) >>> 0;
      const fingerprints = levels.map((level) => pairs.get(`${seed}/${level}`)?.dealFingerprint);
      if (fingerprints.some((fingerprint) => !fingerprint)
        || new Set(fingerprints).size !== 1) {
        throw new Error(`${label} 同一基础区组未保持跨级相同牌面指纹`);
      }
    }
  }
  return { games: games.size, pairs: pairs.size };
}

function validateGameRecord(game, config, label) {
  assertOrder(game.order, `${label}.order`);
  safeInteger(game.firstPlayer, `${label}.firstPlayer`, { min: 0, max: 3 });
  const winnerTeam = [0, 2].includes(game.order[0]) ? 0 : 1;
  const doubleUp = [game.order[0], game.order[1]]
    .every((seat) => ([0, 2].includes(seat) ? 0 : 1) === winnerTeam);
  // A continuous-match record summarizes the whole match rather than the
  // final round's order; its winner is independently recorded in matchWinner.
  // Normal-arm records use the round order directly.
  const expectedCandidateHead = config.continuousMatch
    ? game.matchWinner === game.candidateTeam
    : winnerTeam === game.candidateTeam;
  const expectedComparisonHead = !expectedCandidateHead;
  const expectedCandidateDoubleUp = config.continuousMatch ? false : expectedCandidateHead && doubleUp;
  const expectedComparisonDoubleUp = config.continuousMatch ? false : expectedComparisonHead && doubleUp;
  const expectedUpgrade = config.continuousMatch ? 1
    : describeUpgrade(game.order, (seat) => ([0, 2].includes(seat) ? 0 : 1)).levels;
  if (typeof game.dealFingerprint !== 'string' || !game.dealFingerprint
    || !Number.isSafeInteger(game.upgrade) || game.upgrade !== expectedUpgrade
    || typeof game.utility !== 'number' || !Number.isFinite(game.utility) || game.utility === 0
    || typeof game.candidateHead !== 'boolean' || typeof game.comparisonHead !== 'boolean'
    || typeof game.baselineHead !== 'boolean' || typeof game.candidateDoubleUp !== 'boolean'
    || typeof game.comparisonDoubleUp !== 'boolean' || typeof game.baselineDoubleUp !== 'boolean'
    || game.candidateHead !== expectedCandidateHead
    || game.comparisonHead !== expectedComparisonHead
    || game.baselineHead !== expectedComparisonHead
    || game.candidateDoubleUp !== expectedCandidateDoubleUp
    || game.comparisonDoubleUp !== expectedComparisonDoubleUp
    || game.baselineDoubleUp !== expectedComparisonDoubleUp
    || game.candidateHead !== (game.utility > 0)
    || game.utility !== (game.candidateHead ? game.upgrade : -game.upgrade)) {
    throw new Error(`${label} 结果字段无效或自相矛盾`);
  }
  if (game.firstDivergence !== null && !isRecord(game.firstDivergence)) {
    throw new Error(`${label}.firstDivergence 无效`);
  }
  safeInteger(game.actions, `${label}.actions`, { min: 1 });
  if (typeof game.durationMs !== 'number' || !Number.isFinite(game.durationMs) || game.durationMs < 0) {
    throw new Error(`${label}.durationMs 无效`);
  }
  validateHybrid(game.hybrid, config.candidate, `${label}.hybrid`);
  validateTelemetry(game.decisionTelemetry, config.candidate, game.candidateTeam,
    `${label}.decisionTelemetry`);
  if (!config.continuousMatch) return;
  if (!Number.isInteger(game.matchWinner) || ![0, 1].includes(game.matchWinner)
    || game.matchWinner !== (game.candidateHead ? game.candidateTeam : 1 - game.candidateTeam)
    || !Number.isSafeInteger(game.rounds) || game.rounds < 1
    || !Number.isFinite(game.roundUpgradeUtility)
    || !Array.isArray(game.roundResults) || game.roundResults.length !== game.rounds) {
    throw new Error(`${label} 连续赛终局字段无效`);
  }
  let roundUtility = 0;
  for (const [index, round] of game.roundResults.entries()) {
    validateContinuousRound(round, game.candidateTeam, `${label}.roundResults[${index}]`);
    if (round.round !== index + 1) throw new Error(`${label}.roundResults 顺序不连续`);
    roundUtility += round.candidateUtility;
  }
  if (game.roundUpgradeUtility !== roundUtility) {
    throw new Error(`${label}.roundUpgradeUtility 与 roundResults 不一致`);
  }
}

function readNdjson(file, label) {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) throw new Error(`${label}不存在：${resolved}`);
  const bytes = fs.readFileSync(resolved);
  const records = [];
  for (const [index, line] of bytes.toString('utf8').split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`${label}第 ${index + 1} 行不是有效 JSON：${error.message}`);
    }
  }
  return { file: resolved, bytes, sha256: sha256Bytes(bytes), records };
}

function validatePairRecord(pair, even, odd, config, label) {
  const expectedSeed = (Number(config.baseSeed) + pair.block - 1) >>> 0;
  if (!Number.isSafeInteger(pair.group) || pair.group < 1
    || !Number.isSafeInteger(pair.block) || pair.block < 1
    || pair.block > Number(config.baseDealBlocks)
    || pair.seed !== expectedSeed
    // The runner numbers normal-arm pairs from one, while level values start
    // at 2.  Use the level's zero-based offset rather than accidentally
    // shifting every pair group by one.
    || pair.group !== (config.continuousMatch
      ? pair.block
      : (pair.block - 1) * LEVELS.length + (pair.level - LEVELS[0] + 1))
    || pair.seed !== even.seed || pair.level !== even.level
    || pair.runSegmentId !== even.runSegmentId || pair.runSegmentId !== odd.runSegmentId
    || pair.mirrorMatched !== true || pair.crossLevelMatched !== true || pair.complete !== true
    || typeof pair.dealFingerprint !== 'string' || !pair.dealFingerprint
    || !Number.isFinite(pair.utility) || !Number.isSafeInteger(pair.candidateHeads)
    || pair.candidateHeads < 0 || pair.candidateHeads > 2
    || !Number.isSafeInteger(pair.candidateDoubleUps) || pair.candidateDoubleUps < 0
    || pair.candidateDoubleUps > 2 || !Number.isSafeInteger(pair.comparisonDoubleUps)
    || pair.comparisonDoubleUps < 0 || pair.comparisonDoubleUps > 2
    || !Array.isArray(pair.orders) || pair.orders.length !== 2
    || !Array.isArray(pair.firstDivergences) || pair.firstDivergences.length !== 2) {
    throw new Error(`${label} pair 字段无效`);
  }
  if (even.firstPlayer !== odd.firstPlayer || even.dealFingerprint !== odd.dealFingerprint
    || pair.dealFingerprint !== even.dealFingerprint
    || !sameStableJson(pair.orders, [even.order, odd.order])
    || !sameStableJson(pair.firstDivergences, [even.firstDivergence, odd.firstDivergence])
    || pair.candidateHeads !== Number(even.candidateHead) + Number(odd.candidateHead)
    || pair.candidateDoubleUps !== Number(even.candidateDoubleUp) + Number(odd.candidateDoubleUp)
    || pair.comparisonDoubleUps !== Number(even.comparisonDoubleUp) + Number(odd.comparisonDoubleUp)
    || pair.utility !== (even.utility + odd.utility) / 2) {
    throw new Error(`${label} pair 与两条镜像 game 不一致`);
  }
  assertOrder(pair.orders[0], `${label}.orders[0]`);
  assertOrder(pair.orders[1], `${label}.orders[1]`);
  if (pair.firstDivergences.some((item) => item !== null && !isRecord(item))) {
    throw new Error(`${label}.firstDivergences 无效`);
  }
}

function validateCheckpoint(input, config, reportProvenance, modelHash, implementationHash, label) {
  const checkpoint = input.value;
  if (!isRecord(checkpoint) || checkpoint.schema !== CHECKPOINT_SCHEMA) {
    throw new Error(`${label} 必须是完整 ${CHECKPOINT_SCHEMA}，legacy v1/v2 不得进入 M2`);
  }
  assertExactFields(checkpoint, [
    'schema', 'signature', 'signaturePayload', 'nextBlockIndex', 'complete', 'provenance',
    'games', 'pairs', 'failures', 'checkpointIntegrity',
  ], label);
  if (!isRecord(checkpoint.signaturePayload) || typeof checkpoint.signature !== 'string'
    || checkpoint.signature !== JSON.stringify(checkpoint.signaturePayload)) {
    throw new Error(`${label} signature/signaturePayload 不一致`);
  }
  const signature = checkpoint.signaturePayload;
  assertExactFields(signature, [
    'groupCount', 'baseSeed', 'candidate', 'comparison', 'evaluationLevels',
    'levelBlockDesign', 'continuousMatch', 'evaluationOpponentModelMode',
    'valueModelSha256', 'evaluationImplementationSha256', 'hybridEngineVersion',
    'candidateSearchConfig',
  ], `${label}.signaturePayload`);
  const expectedSignature = {
    groupCount: Number(config.baseDealBlocks),
    baseSeed: Number(config.baseSeed),
    candidate: config.candidate,
    comparison: 'expert',
    evaluationLevels: config.continuousMatch ? config.evaluationLevels : LEVELS,
    levelBlockDesign: config.continuousMatch ? false : true,
    continuousMatch: config.continuousMatch === true,
    evaluationOpponentModelMode: 'off',
    valueModelSha256: modelHash,
    evaluationImplementationSha256: implementationHash,
    hybridEngineVersion: Number(config.hybridEngineVersion),
    candidateSearchConfig: config.candidateSearchConfig,
  };
  if (!sameStableJson(signature, expectedSignature)) throw new Error(`${label} 签名载荷与报告配置不一致`);
  if (checkpoint.complete !== true || checkpoint.nextBlockIndex !== Number(config.baseDealBlocks)
    || !Array.isArray(checkpoint.failures) || checkpoint.failures.length !== 0) {
    throw new Error(`${label} 未完成或包含失败记录`);
  }
  if (!isRecord(checkpoint.checkpointIntegrity)
    || Object.keys(checkpoint.checkpointIntegrity).length !== 2
    || checkpoint.checkpointIntegrity.schema !== CHECKPOINT_INTEGRITY_SCHEMA
    || !isSha256(checkpoint.checkpointIntegrity.sha256)
    || checkpoint.checkpointIntegrity.sha256 !== checkpointContentSha256(checkpoint)) {
    throw new Error(`${label} checkpointIntegrity.sha256 无法复算`);
  }
  const provenance = validateProvenance(checkpoint.provenance, Number(config.baseDealBlocks), `${label}.provenance`);
  if (provenance.evaluationId !== reportProvenance.evaluationId
    || !sameStableJson(checkpoint.provenance, reportProvenance)) {
    throw new Error(`${label} 与报告 provenance/evaluationId 不一致`);
  }
  const coverage = validateCoverage(checkpoint, config, provenance, label);
  return {
    sha256: input.sha256,
    integritySha256: checkpoint.checkpointIntegrity.sha256,
    provenance,
    coverage,
    data: checkpoint,
    games: checkpoint.games,
    pairs: checkpoint.pairs,
    failures: checkpoint.failures,
  };
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let mixed = value;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function bootstrapMeanCI(values, seed, iterations = 5000) {
  if (!values.length) return null;
  const rng = seededRandom(seed ^ 0xA5A5A5A5);
  const samples = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let sum = 0;
    for (let index = 0; index < values.length; index += 1) {
      sum += values[Math.floor(rng() * values.length)];
    }
    samples.push(sum / values.length);
  }
  samples.sort((left, right) => left - right);
  return [
    samples[Math.floor(iterations * 0.025)],
    samples[Math.min(iterations - 1, Math.floor(iterations * 0.975))],
  ];
}

function wilsonInterval(successes, total, z = 1.959963984540054) {
  if (!total) return null;
  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denominator;
  const radius = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total) / denominator;
  return [Math.max(0, center - radius), Math.min(1, center + radius)];
}

function summarizeHybridGames(games) {
  const total = {
    turns: 0, applied: 0, changed: 0, samples: 0, nodes: 0, iterations: 0,
    forceExpert: 0, wouldChange: 0, searchModes: {}, reasons: {}, rejected: {},
  };
  for (const game of games) {
    const hybrid = game.hybrid;
    for (const field of [
      'turns', 'applied', 'changed', 'samples', 'nodes', 'iterations', 'forceExpert', 'wouldChange',
    ]) total[field] += hybrid[field];
    for (const [key, count] of Object.entries(hybrid.searchModes)) {
      total.searchModes[key] = (total.searchModes[key] || 0) + count;
    }
    for (const [key, count] of Object.entries(hybrid.reasons)) {
      total.reasons[key] = (total.reasons[key] || 0) + count;
    }
    for (const [key, count] of Object.entries(hybrid.rejected)) {
      total.rejected[key] = (total.rejected[key] || 0) + count;
    }
  }
  return {
    ...total,
    appliedRate: rounded(total.turns ? total.applied / total.turns : NaN, 3),
    changedRate: rounded(total.turns ? total.changed / total.turns : NaN, 3),
    wouldChangeRate: rounded(total.turns ? total.wouldChange / total.turns : NaN, 3),
    averageSamplesPerTurn: rounded(total.turns ? total.samples / total.turns : NaN, 3),
    averageNodesPerAppliedTurn: rounded(total.applied ? total.nodes / total.applied : NaN, 3),
    averageIterationsPerAppliedTurn: rounded(total.applied ? total.iterations / total.applied : NaN, 3),
  };
}

function recomputeCheckpointMetrics(checkpointInfo, config, label) {
  const games = checkpointInfo.games;
  const pairs = checkpointInfo.pairs;
  const blocks = Number(config.baseDealBlocks);
  const completedGames = games.filter((game) => game.ok === true);
  const completedPairs = pairs.filter((pair) => pair.complete === true);
  const candidateHeads = completedGames.filter((game) => game.candidateHead).length;
  const comparisonHeads = completedGames.filter((game) => game.comparisonHead).length;
  const candidateDoubleUps = completedGames.filter((game) => game.candidateDoubleUp).length;
  const comparisonDoubleUps = completedGames.filter((game) => game.comparisonDoubleUp).length;
  const pairedUtilities = completedPairs.map((pair) => pair.utility);
  const pairedHeadRates = completedPairs.map((pair) => pair.candidateHeads / 2);
  const pairedDoubleUpDifferences = completedPairs.map((pair) => (
    (pair.candidateDoubleUps - pair.comparisonDoubleUps) / 2
  ));
  const blockSummaries = Array.from({ length: blocks }, (_, blockIndex) => {
    const seed = (Number(config.baseSeed) + blockIndex) >>> 0;
    const blockPairs = completedPairs.filter((pair) => pair.block === blockIndex + 1);
    const complete = blockPairs.length === (config.continuousMatch ? 1 : LEVELS.length)
      && blockPairs.every((pair) => pair.complete);
    return {
      block: blockIndex + 1,
      seed,
      complete,
      utility: complete ? average(blockPairs.map((pair) => pair.utility)) : null,
      candidateHeadRate: complete ? average(blockPairs.map((pair) => pair.candidateHeads / 2)) : null,
      doubleUpDifference: complete ? average(blockPairs.map((pair) => (
        (pair.candidateDoubleUps - pair.comparisonDoubleUps) / 2
      ))) : null,
    };
  });
  const inferenceUtilities = config.continuousMatch
    ? pairedUtilities : blockSummaries.filter((block) => block.complete).map((block) => block.utility);
  const inferenceHeadRates = config.continuousMatch
    ? pairedHeadRates : blockSummaries.filter((block) => block.complete).map((block) => block.candidateHeadRate);
  const inferenceDoubleUpDifferences = config.continuousMatch
    ? pairedDoubleUpDifferences : blockSummaries.filter((block) => block.complete)
      .map((block) => block.doubleUpDifference);
  const headRate = completedGames.length ? candidateHeads / completedGames.length : null;
  const cappedHeadRate = headRate == null ? null : Math.min(0.999999, Math.max(0.000001, headRate));
  const result = {
    candidateUpgradeUtilityTotal: completedGames.reduce((sum, game) => sum + game.utility, 0),
    candidateUpgradeUtilityPerGame: rounded(average(completedGames.map((game) => game.utility))),
    candidatePairedUtilityPerSeed: rounded(average(pairedUtilities)),
    candidatePairedUtilityBootstrap95: roundedPair(bootstrapMeanCI(inferenceUtilities, Number(config.baseSeed))),
    candidateBlockedUtilityPerDeal: rounded(average(inferenceUtilities)),
    candidateHeads,
    comparisonHeads,
    baselineHeads: comparisonHeads,
    candidateHeadRate: rounded(headRate),
    candidateHeadPairedBootstrap95: roundedPair(
      bootstrapMeanCI(inferenceHeadRates, Number(config.baseSeed) ^ 0x13579BDF),
    ),
    candidateHeadWilson95: roundedPair(wilsonInterval(candidateHeads, completedGames.length), 3),
    candidateElo: cappedHeadRate == null ? null : rounded(
      400 * Math.log10(cappedHeadRate / (1 - cappedHeadRate)), 1,
    ),
    candidateDoubleUps,
    comparisonDoubleUps,
    baselineDoubleUps: comparisonDoubleUps,
    candidateDoubleUpDifferencePerGame: rounded(average(pairedDoubleUpDifferences)),
    candidateDoubleUpDifferencePairedBootstrap95: roundedPair(
      bootstrapMeanCI(inferenceDoubleUpDifferences, Number(config.baseSeed) ^ 0x2468ACE0),
    ),
  };
  const byLevel = Object.fromEntries((config.continuousMatch ? [2] : LEVELS).map((level) => {
    const levelGames = completedGames.filter((game) => game.level === level);
    const levelPairs = completedPairs.filter((pair) => pair.level === level);
    const heads = levelGames.filter((game) => game.candidateHead).length;
    const comparisonLevelHeads = levelGames.filter((game) => game.comparisonHead).length;
    const doubles = levelGames.filter((game) => game.candidateDoubleUp).length;
    const comparisonDoubles = levelGames.filter((game) => game.comparisonDoubleUp).length;
    return [String(level), {
      label: level === 14 ? 'A' : String(level),
      seedGroups: levelPairs.length,
      games: levelGames.length,
      candidateHeads: heads,
      comparisonHeads: comparisonLevelHeads,
      candidateHeadRate: rounded(levelGames.length ? heads / levelGames.length : NaN),
      candidateDoubleUps: doubles,
      comparisonDoubleUps: comparisonDoubles,
      candidateUtilityPerGame: rounded(average(levelGames.map((game) => game.utility))),
    }];
  }));
  const completion = {
    gamesCompleted: completedGames.length,
    mirrorPairsCompleted: completedPairs.length,
    baseDealBlocksCompleted: blockSummaries.filter((block) => block.complete).length,
    mirrorMismatches: 0,
    failures: checkpointInfo.failures.length,
    deadlocks: checkpointInfo.failures.filter((failure) => failure.deadlock === true).length,
  };
  const hybrid = summarizeHybridGames(completedGames);
  let continuousMatch = {
    enabled: config.continuousMatch === true,
    matches: config.continuousMatch ? completedGames.length : 0,
    rounds: 0,
    averageRoundsPerMatch: null,
    maxRounds: null,
    tributeRounds: 0,
    aAttempts: 0,
    aFailures: 0,
    aResets: 0,
    longRoundActionThreshold: 120,
    longRounds: 0,
    maxRoundActions: null,
    candidateRoundUpgradeUtility: 0,
  };
  if (config.continuousMatch) {
    const rounds = completedGames.flatMap((game) => game.roundResults);
    continuousMatch = {
      ...continuousMatch,
      rounds: rounds.length,
      averageRoundsPerMatch: rounded(average(completedGames.map((game) => game.rounds))),
      maxRounds: completedGames.length ? Math.max(...completedGames.map((game) => game.rounds)) : null,
      tributeRounds: rounds.filter((round) => round.tribute).length,
      aAttempts: rounds.filter((round) => round.aAttempt).length,
      aFailures: rounds.filter((round) => round.aFailed).length,
      aResets: rounds.filter((round) => round.aReset).length,
      longRounds: rounds.filter((round) => round.actions >= 120).length,
      maxRoundActions: rounds.length ? Math.max(...rounds.map((round) => round.actions)) : null,
      candidateRoundUpgradeUtility: rounds.reduce((sum, round) => sum + round.candidateUtility, 0),
    };
  }
  return { completion, result, byLevel, hybrid, continuousMatch, blockSummaries };
}

function assertMetricEqual(actual, expected, label) {
  if (!sameStableJson(actual, expected)) {
    throw new Error(`${label} 与 checkpoint 逐对象复算结果不一致`);
  }
}

function validateReportAgainstCheckpoint(report, checkpointInfo, config, label) {
  const metrics = recomputeCheckpointMetrics(checkpointInfo, config, label);
  assertMetricEqual(report.completion, metrics.completion, `${label}.completion`);
  assertMetricEqual(report.result, metrics.result, `${label}.result`);
  assertMetricEqual(report.byLevel, metrics.byLevel, `${label}.byLevel`);
  const hybridFields = [
    'turns', 'applied', 'changed', 'samples', 'nodes', 'iterations', 'forceExpert',
    'wouldChange', 'searchModes', 'reasons', 'rejected', 'appliedRate', 'changedRate',
    'wouldChangeRate', 'averageSamplesPerTurn', 'averageNodesPerAppliedTurn',
    'averageIterationsPerAppliedTurn',
  ];
  for (const field of hybridFields) {
    assertMetricEqual(report.hybrid?.[field], metrics.hybrid[field], `${label}.hybrid.${field}`);
  }
  if (config.continuousMatch) {
    assertMetricEqual(report.continuousMatch, metrics.continuousMatch, `${label}.continuousMatch`);
  }
  return metrics;
}

function telemetryAccounting(records) {
  const decisionTurns = records.length;
  const measured = records.filter((record) => Number.isFinite(record.latencyMs)).length;
  const fallback = records.filter((record) => record.variantPresent && record.localDecisionPresent
    && record.fallbackKindPresent).length;
  const timeout = records.filter((record) => record.timeoutFallback).length;
  const latencies = records.filter((record) => Number.isFinite(record.latencyMs)).map((record) => record.latencyMs);
  return {
    decisionTurns,
    measuredDecisionTurns: measured,
    unmeasuredDecisionTurns: decisionTurns - measured,
    fallbackEvaluableTurns: fallback,
    timeoutFallbacks: timeout,
    averageDecisionMs: rounded(
      latencies.length ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : NaN,
      1,
    ),
    p95DecisionMs: rounded(percentile(latencies, 0.95), 1),
    p99DecisionMs: rounded(percentile(latencies, 0.99), 1),
    maxDecisionMs: rounded(latencies.length ? Math.max(...latencies) : NaN, 1),
  };
}

function compareTelemetry(actual, expected, label) {
  const fields = ['decisionTurns', 'measuredDecisionTurns', 'unmeasuredDecisionTurns',
    'fallbackEvaluableTurns', 'timeoutFallbacks'];
  for (const field of fields) {
    if (Number(actual?.[field]) !== Number(expected[field])) {
      throw new Error(`${label}.${field} 与原始遥测不一致`);
    }
  }
  for (const field of ['averageDecisionMs', 'p95DecisionMs', 'p99DecisionMs', 'maxDecisionMs']) {
    const actualValue = finiteNumber(actual?.[field]);
    if (actualValue !== expected[field]) throw new Error(`${label}.${field} 与原始遥测不一致`);
  }
  const actualTimeoutRate = finiteNumber(actual?.timeoutFallbackRate);
  const expectedTimeoutRate = expected.fallbackEvaluableTurns > 0
    ? rounded(expected.timeoutFallbacks / expected.fallbackEvaluableTurns, 3) : null;
  if (actualTimeoutRate !== expectedTimeoutRate) {
    throw new Error(`${label}.timeoutFallbackRate 与原始遥测不一致`);
  }
}

function requireStrictPerformance(stats, label, requireMinimumTriggers = true, enforceLatency = true) {
  const measuredCoverage = stats.decisionTurns > 0
    ? stats.measuredDecisionTurns / stats.decisionTurns : null;
  const fallbackCoverage = stats.decisionTurns > 0
    ? stats.fallbackEvaluableTurns / stats.decisionTurns : null;
  const timeoutRate = stats.fallbackEvaluableTurns > 0
    ? stats.timeoutFallbacks / stats.fallbackEvaluableTurns : null;
  if ((requireMinimumTriggers && stats.decisionTurns < 100)
    || measuredCoverage == null || measuredCoverage < 0.99
    || fallbackCoverage == null || fallbackCoverage < 0.99
    || (enforceLatency && (stats.p95DecisionMs == null || stats.p95DecisionMs > 500
      || stats.p99DecisionMs == null || stats.p99DecisionMs > 750
      || timeoutRate == null || timeoutRate >= 0.005))) {
    throw new Error(`${label} 未通过真实 search-triggered 性能门`);
  }
}

function validateRawTelemetry(input, report, checkpoint, candidate, implementationHash, label) {
  const raw = input.value;
  if (!isRecord(raw) || raw.schema !== RAW_TELEMETRY_SCHEMA) {
    throw new Error(`${label} 必须是 ${RAW_TELEMETRY_SCHEMA}`);
  }
  assertExactFields(raw, [
    'schema', 'evaluationId', 'reportSha256', 'checkpointSha256', 'candidate',
    'evaluationImplementationSha256', 'environmentSha256', 'records', 'integrityComplete',
    'missingVariantTurns', 'missingLocalDecisionTurns', 'missingSearchTelemetryTurns',
    'missingFallbackKindTurns',
  ], label);
  if (raw.evaluationId !== report.evaluationId
    || raw.reportSha256 !== report.inputSha256
    || raw.checkpointSha256 !== checkpoint.sha256
    || raw.candidate !== candidate
    || raw.evaluationImplementationSha256 !== implementationHash
    || raw.environmentSha256 !== checkpoint.provenance.runSegments[0].environment.environmentSha256
    || !Array.isArray(raw.records) || raw.records.length === 0
    || ![raw.missingVariantTurns, raw.missingLocalDecisionTurns,
      raw.missingSearchTelemetryTurns, raw.missingFallbackKindTurns].every((value) => (
        Number.isSafeInteger(value) && value >= 0
      ))) {
    throw new Error(`${label} provenance 或完整性字段不一致`);
  }
  const rawRecordFields = [
    'runSegmentId', 'seed', 'level', 'candidateTeam', 'turn', 'seat', 'policy', 'engine',
    'variantPresent', 'localDecisionPresent', 'searchTelemetryPresent', 'fallbackKindPresent',
    'telemetryComplete', 'latencyMs', 'source', 'fallbackKind', 'fallbackEvaluable',
    'timeoutFallback', 'searchAttempted', 'searchTriggered', 'candidates', 'samples', 'nodes',
    'iterations',
  ];
  const segmentIds = new Set(checkpoint.provenance.runSegments.map((segment) => segment.runSegmentId));
  const expectedRecords = new Map();
  for (const game of checkpoint.games) {
    for (const [index, item] of game.decisionTelemetry.entries()) {
      const expected = {
        runSegmentId: game.runSegmentId,
        seed: game.seed,
        level: game.level,
        candidateTeam: game.candidateTeam,
        turn: index + 1,
        seat: item.seat,
        policy: item.policy,
        engine: item.engine,
        variantPresent: item.variantPresent,
        localDecisionPresent: item.localDecisionPresent,
        searchTelemetryPresent: item.searchTelemetryPresent,
        fallbackKindPresent: item.fallbackKindPresent,
        telemetryComplete: item.telemetryComplete,
        latencyMs: item.latencyMs,
        source: item.source,
        fallbackKind: item.fallbackKind,
        fallbackEvaluable: item.fallbackEvaluable,
        timeoutFallback: item.timeoutFallback,
        searchAttempted: item.searchAttempted,
        searchTriggered: item.searchTriggered,
        candidates: item.candidates,
        samples: item.samples,
        nodes: item.nodes,
        iterations: item.iterations,
      };
      const key = `${game.seed}/${game.level}/${game.candidateTeam}/${index + 1}/${item.seat}`;
      if (expectedRecords.has(key)) throw new Error(`${label} checkpoint 决策坐标重复`);
      expectedRecords.set(key, expected);
    }
  }
  if (raw.records.length !== expectedRecords.size) {
    throw new Error(`${label} 记录数量与 checkpoint 决策明细不一致`);
  }
  const seen = new Set();
  const records = raw.records.map((record, index) => {
    assertExactFields(record, rawRecordFields, `${label}.records[${index}]`);
    if (!segmentIds.has(record.runSegmentId) || !Number.isSafeInteger(record.seed)
      || !Number.isSafeInteger(record.level) || ![0, 1].includes(record.candidateTeam)
      || !Number.isSafeInteger(record.turn) || record.turn < 1
      || !Number.isSafeInteger(record.seat) || record.seat < 0 || record.seat > 3) {
      throw new Error(`${label}.records[${index}] 坐标无效`);
    }
    const key = `${record.seed}/${record.level}/${record.candidateTeam}/${record.turn}/${record.seat}`;
    if (seen.has(key)) throw new Error(`${label}.records[${index}] 决策坐标重复`);
    seen.add(key);
    const expected = expectedRecords.get(key);
    if (!expected || !sameStableJson(record, expected)) {
      throw new Error(`${label}.records[${index}] 未与 checkpoint 的唯一决策坐标/载荷绑定`);
    }
    if (record.searchTelemetryPresent !== true
      && (record.searchAttempted !== null || record.searchTriggered !== null)) {
      throw new Error(`${label}.records[${index}] 缺失搜索遥测却包含布尔搜索字段`);
    }
    if (record.searchTelemetryPresent === true
      && (typeof record.searchAttempted !== 'boolean' || typeof record.searchTriggered !== 'boolean'
        || (record.searchTriggered && !record.searchAttempted))) {
      throw new Error(`${label}.records[${index}] 搜索遥测字段语义无效`);
    }
    if (record.fallbackKindPresent !== true && record.fallbackKind !== null) {
      throw new Error(`${label}.records[${index}] 缺失 fallbackKind 却包含值`);
    }
    if (record.fallbackEvaluable !== (
      record.variantPresent && record.localDecisionPresent && record.fallbackKindPresent
    )) {
      throw new Error(`${label}.records[${index}] fallbackEvaluable 与存在性字段不一致`);
    }
    if (record.telemetryComplete !== (
      record.variantPresent && record.localDecisionPresent && record.searchTelemetryPresent
      && record.fallbackKindPresent && typeof record.latencyMs === 'number'
      && Number.isFinite(record.latencyMs) && record.latencyMs >= 0
    )) {
      throw new Error(`${label}.records[${index}] telemetryComplete 与字段不一致`);
    }
    return record;
  });
  const missing = {
    missingVariantTurns: records.filter((record) => !record.variantPresent).length,
    missingLocalDecisionTurns: records.filter((record) => !record.localDecisionPresent).length,
    missingSearchTelemetryTurns: records.filter((record) => !record.searchTelemetryPresent).length,
    missingFallbackKindTurns: records.filter((record) => !record.fallbackKindPresent).length,
  };
  if (!sameStableJson(missing, {
    missingVariantTurns: raw.missingVariantTurns,
    missingLocalDecisionTurns: raw.missingLocalDecisionTurns,
    missingSearchTelemetryTurns: raw.missingSearchTelemetryTurns,
    missingFallbackKindTurns: raw.missingFallbackKindTurns,
  }) || raw.integrityComplete !== (records.length > 0 && Object.values(missing).every((value) => value === 0))) {
    throw new Error(`${label} missing 计数或 integrityComplete 不是从原始记录复算`);
  }
  if (!raw.integrityComplete) throw new Error(`${label} 原始遥测不完整`);
  const all = telemetryAccounting(records);
  const candidateRecords = records.filter((record) => record.policy === candidate);
  if (!candidateRecords.length || records.some((record) => ![candidate, 'expert'].includes(record.policy))) {
    throw new Error(`${label} 策略归属不完整`);
  }
  const candidateTelemetry = telemetryAccounting(candidateRecords);
  const triggeredTelemetry = telemetryAccounting(candidateRecords.filter((record) => record.searchTriggered));
  requireStrictPerformance(all, `${label}/allAIDecisions`, false, false);
  requireStrictPerformance(triggeredTelemetry, `${label}/${candidate}/searchTriggered`);
  const performance = report.value.performance;
  compareTelemetry(performance.allAIDecisions, all, `${label}/allAIDecisions`);
  compareTelemetry(performance.decisionLatencyByPolicy[candidate], candidateTelemetry,
    `${label}/${candidate}`);
  compareTelemetry(performance.decisionLatencyByPolicy[candidate].searchTriggered,
    triggeredTelemetry, `${label}/${candidate}/searchTriggered`);
  const bySegment = new Map();
  for (const segment of checkpoint.provenance.runSegments) bySegment.set(segment.runSegmentId, []);
  for (const record of records) bySegment.get(record.runSegmentId).push(record);
  const performanceSegments = new Map();
  if (!Array.isArray(performance.byRunSegment)
    || performance.byRunSegment.length !== checkpoint.provenance.runSegments.length) {
    throw new Error(`${label} 报告运行段数组不完整`);
  }
  for (const entry of performance.byRunSegment) {
    if (performanceSegments.has(entry.runSegmentId)) throw new Error(`${label} 报告运行段重复`);
    performanceSegments.set(entry.runSegmentId, entry);
  }
  const segmentStats = [];
  for (const segment of checkpoint.provenance.runSegments) {
    const entry = performanceSegments.get(segment.runSegmentId);
    if (!entry) throw new Error(`${label} 报告遗漏运行段 ${segment.runSegmentId}`);
    const segmentRecords = bySegment.get(segment.runSegmentId);
    const expectedGames = checkpoint.games.filter((game) => game.runSegmentId === segment.runSegmentId).length;
    if (entry.gamesCompleted !== expectedGames) {
      throw new Error(`${label}/${segment.runSegmentId} gamesCompleted 与 checkpoint 不一致`);
    }
    const segmentAll = telemetryAccounting(segmentRecords);
    const segmentCandidateRecords = segmentRecords.filter((record) => record.policy === candidate);
    compareTelemetry(entry.allAIDecisions, segmentAll, `${label}/${segment.runSegmentId}/allAIDecisions`);
    compareTelemetry(entry.decisionLatencyByPolicy[candidate], telemetryAccounting(segmentCandidateRecords),
      `${label}/${segment.runSegmentId}/${candidate}`);
    const segmentTriggered = telemetryAccounting(segmentCandidateRecords.filter((record) => record.searchTriggered));
    compareTelemetry(entry.decisionLatencyByPolicy[candidate].searchTriggered,
      segmentTriggered, `${label}/${segment.runSegmentId}/${candidate}/searchTriggered`);
    requireStrictPerformance(segmentTriggered, `${label}/${segment.runSegmentId}/${candidate}/searchTriggered`);
    segmentStats.push({ runSegmentId: segment.runSegmentId, all: segmentAll, candidate: segmentCandidateRecords, triggered: segmentTriggered });
  }
  return {
    sha256: input.sha256,
    records: records.length,
    all,
    candidateTelemetry,
    triggeredTelemetry,
    segments: segmentStats,
  };
}

function validateNormalPerformance(input, report, rawTelemetry, checkpoint, candidate, implementationHash, label) {
  const performance = input.value;
  const primaryPerformance = report?.value?.performance;
  if (isRecord(primaryPerformance)
    && (Object.prototype.hasOwnProperty.call(primaryPerformance, 'environmentTelemetry')
      || (Array.isArray(primaryPerformance.byRunSegment)
        && primaryPerformance.byRunSegment.some((entry) => (
          isRecord(entry) && Object.prototype.hasOwnProperty.call(entry, 'environmentTelemetry')
        ))))) {
    throw new Error(`${label} 对应主报告包含 diagnostic-only environmentTelemetry，不得进入正式 M2 门`);
  }
  if (isRecord(performance)
    && (Object.prototype.hasOwnProperty.call(performance, 'environmentTelemetry')
      || (Array.isArray(performance.runs) && performance.runs.some((run) => (
        isRecord(run) && Object.prototype.hasOwnProperty.call(run, 'environmentTelemetry')
      ))))) {
    throw new Error(`${label} 包含 diagnostic-only environmentTelemetry，不得作为正式性能回执`);
  }
  if (!isRecord(performance) || performance.schema !== PERFORMANCE_SCHEMA
    || !isRecord(performance.thresholds)
    || !isRecord(performance.diagnosticOverrides)
    || performance.formalReceiptReady !== true
    || !isRecord(performance.overall) || performance.overall.formalReceiptReady !== true
    || performance.overall.complete !== true
    || performance.overall.allEnginesPass !== true
    || performance.overall.decision !== 'performance_gate_passed'
    || !isRecord(performance.artifactBindings)
    || performance.artifactBindings.reportSha256 !== report.inputSha256
    || performance.artifactBindings.evaluationImplementationSha256 !== implementationHash
    || performance.artifactBindings.checkpointSha256 !== checkpoint.sha256
    || performance.artifactBindings.rawTelemetrySha256 !== rawTelemetry.sha256
    || !Array.isArray(performance.runs) || performance.runs.length !== 1) {
    throw new Error(`${label} 不是无诊断 override 且绑定全部输入的严格性能回执`);
  }
  if (Object.keys(performance.diagnosticOverrides || {}).length !== 0) {
    throw new Error(`${label} 含诊断阈值覆写，不得作为正式门禁`);
  }
  const expectedThresholds = {
    baseDealBlocks: GROUPS,
    searchTriggeredDecisionTurns: 100,
    searchTriggeredMeasurementCoverage: 0.99,
    p95SearchTriggeredDecisionMsMax: 500,
    p99SearchTriggeredDecisionMsMax: 750,
    timeoutFallbackRateMaxExclusive: 0.005,
  };
  if (!sameStableJson(performance.thresholds, expectedThresholds)) {
    throw new Error(`${label} thresholds 与固定发布门不一致`);
  }
  validateEnvironment(performance.summarizerEnvironment, `${label}.summarizerEnvironment`);
  const run = performance.runs[0];
  if (run.engine !== candidate || run.file !== report.file || run.sha256 !== report.inputSha256
    || run.pass !== true || run.complete !== true || run.sourceBound !== true
    || run.provenanceBound !== true || run.segmentAccountingBound !== true
    || !sameStableJson(run.evaluationEnvironment, checkpoint.provenance.runSegments[0].environment)
    || run.runSegments?.length !== checkpoint.provenance.runSegments.length
    || run.runSegments.some((entry, index) => !isRecord(entry)
      || Object.keys(entry).length !== 7
      || entry.runSegmentId !== checkpoint.provenance.runSegments[index].runSegmentId
      || entry.ordinal !== checkpoint.provenance.runSegments[index].ordinal
      || entry.resume !== checkpoint.provenance.runSegments[index].resume
      || entry.startBlockIndex !== checkpoint.provenance.runSegments[index].startBlockIndex
      || entry.endBlockIndex !== checkpoint.provenance.runSegments[index].endBlockIndex
      || entry.inputCheckpointSha256 !== checkpoint.provenance.runSegments[index].inputCheckpointSha256
      || entry.environmentSha256 !== checkpoint.provenance.runSegments[index].environment.environmentSha256)
    || !Array.isArray(run.searchTriggeredByRunSegment)
    || run.searchTriggeredByRunSegment.length !== checkpoint.provenance.runSegments.length
     || run.searchTriggeredByRunSegment.some((segment, index) => segment.pass !== true
       || segment.runSegmentId !== checkpoint.provenance.runSegments[index]?.runSegmentId)) {
    throw new Error(`${label} 未通过候选、源码、运行段或搜索尾延迟门`);
  }
  if (run.evaluationImplementationSha256 !== implementationHash) {
    throw new Error(`${label} 源码摘要与正常臂不一致`);
  }
  if (run.gamesCompleted !== checkpoint.games.length / 1
    || run.mirrorPairsCompleted !== checkpoint.pairs.length
    || run.baseDealBlocksCompleted !== Number(report.value.config.baseDealBlocks)
    || run.failures !== 0 || run.deadlocks !== 0 || run.mirrorMismatches !== 0) {
    throw new Error(`${label} receipt 完成计数与 checkpoint 不一致`);
  }
  const allExpected = rawTelemetry.all;
  const candidateExpected = rawTelemetry.candidateTelemetry;
  const triggeredExpected = rawTelemetry.triggeredTelemetry;
  if (run.decisionTurns !== candidateExpected.decisionTurns
    || run.measuredDecisionTurns !== candidateExpected.measuredDecisionTurns
    || run.unmeasuredDecisionTurns !== candidateExpected.unmeasuredDecisionTurns
    || run.fallbackEvaluableTurns !== candidateExpected.fallbackEvaluableTurns
    || run.timeoutFallbacks !== candidateExpected.timeoutFallbacks
    || run.averageDecisionMs !== candidateExpected.averageDecisionMs
    || run.p95DecisionMs !== candidateExpected.p95DecisionMs
    || run.p99DecisionMs !== candidateExpected.p99DecisionMs
    || run.maxDecisionMs !== candidateExpected.maxDecisionMs
    || run.searchTriggered?.decisionTurns !== triggeredExpected.decisionTurns
    || run.searchTriggered?.measuredDecisionTurns !== triggeredExpected.measuredDecisionTurns
    || run.searchTriggered?.p95DecisionMs !== triggeredExpected.p95DecisionMs
    || run.searchTriggered?.p99DecisionMs !== triggeredExpected.p99DecisionMs
    || run.searchTriggered?.maxDecisionMs !== triggeredExpected.maxDecisionMs
    || run.searchTriggered?.fallbackEvaluableTurns !== triggeredExpected.fallbackEvaluableTurns
    || run.searchTriggered?.timeoutFallbacks !== triggeredExpected.timeoutFallbacks
    || run.allAIDecisions?.decisionTurns !== allExpected.decisionTurns
    || run.allAIDecisions?.measuredDecisionTurns !== allExpected.measuredDecisionTurns
    || run.allAIDecisions?.unmeasuredDecisionTurns !== allExpected.unmeasuredDecisionTurns
    || run.allAIDecisions?.fallbackEvaluableTurns !== allExpected.fallbackEvaluableTurns
    || run.allAIDecisions?.timeoutFallbacks !== allExpected.timeoutFallbacks
    || run.allAIDecisions?.integrityComplete !== true
    || run.allAIDecisions?.missingVariantTurns !== 0
    || run.allAIDecisions?.missingLocalDecisionTurns !== 0
    || run.allAIDecisions?.missingSearchTelemetryTurns !== 0
    || run.allAIDecisions?.missingFallbackKindTurns !== 0) {
    throw new Error(`${label} receipt 数值与原始遥测独立复算不一致`);
  }
  // The summarizer deliberately exposes a compact all-AI accounting object,
  // while candidate/searchTriggered retain latency distributions.  Recheck
  // every field that the receipt publishes instead of trusting its pass bit.
  compareTelemetry(run, candidateExpected, `${label}/candidate`);
  const publishedTriggered = run.searchTriggered;
  if (!isRecord(publishedTriggered)
    || publishedTriggered.decisionTurns !== triggeredExpected.decisionTurns
    || publishedTriggered.measuredDecisionTurns !== triggeredExpected.measuredDecisionTurns
    || publishedTriggered.measurementCoverage !== rounded(
      triggeredExpected.measuredDecisionTurns / triggeredExpected.decisionTurns, 4,
    )
    || publishedTriggered.averageDecisionMs !== triggeredExpected.averageDecisionMs
    || publishedTriggered.p95DecisionMs !== triggeredExpected.p95DecisionMs
    || publishedTriggered.p99DecisionMs !== triggeredExpected.p99DecisionMs
    || publishedTriggered.maxDecisionMs !== triggeredExpected.maxDecisionMs
    || publishedTriggered.fallbackEvaluableTurns !== triggeredExpected.fallbackEvaluableTurns
    || publishedTriggered.fallbackEvaluableCoverage !== rounded(
      triggeredExpected.fallbackEvaluableTurns / triggeredExpected.decisionTurns, 4,
    )
    || publishedTriggered.timeoutFallbacks !== triggeredExpected.timeoutFallbacks
    || publishedTriggered.timeoutFallbackRate !== rounded(
      triggeredExpected.timeoutFallbacks / triggeredExpected.fallbackEvaluableTurns, 3,
    )
    || publishedTriggered.accountingValid !== true) {
    throw new Error(`${label} searchTriggered 回执未与原始遥测逐项一致`);
  }
  if (run.allAIDecisions?.measurementCoverage !== rounded(
    allExpected.measuredDecisionTurns / allExpected.decisionTurns, 4,
  ) || run.allAIDecisions?.fallbackEvaluableCoverage !== rounded(
    allExpected.fallbackEvaluableTurns / allExpected.decisionTurns, 4,
  ) || run.allAIDecisions?.accountingValid !== true) {
    throw new Error(`${label} allAIDecisions 覆盖率/守恒回执无法从原始遥测复算`);
  }
  for (const [index, segment] of rawTelemetry.segments.entries()) {
    const receiptSegment = run.searchTriggeredByRunSegment[index];
    const triggered = segment.triggered;
    if (receiptSegment.runSegmentId !== segment.runSegmentId
      || receiptSegment.decisionTurns !== triggered.decisionTurns
      || receiptSegment.measuredDecisionTurns !== triggered.measuredDecisionTurns
      || receiptSegment.measurementCoverage !== rounded(
        triggered.measuredDecisionTurns / triggered.decisionTurns, 4,
      )
      || receiptSegment.p95DecisionMs !== triggered.p95DecisionMs
      || receiptSegment.p99DecisionMs !== triggered.p99DecisionMs
      || receiptSegment.pass !== true
      || receiptSegment.timeoutFallbackRate !== rounded(
        triggered.timeoutFallbacks / triggered.fallbackEvaluableTurns, 3,
      )) {
      throw new Error(`${label} receipt 分段性能未与原始遥测独立绑定`);
    }
  }
  return { file: input.file, sha256: input.sha256, run };
}

function validateContinuous(input, checkpointInput, primary, modelHash, implementationHash, label) {
  const report = input.value;
  const config = report?.config || {};
  if (report.schema !== AB_REPORT_SCHEMA
    || config.candidate !== primary.candidate
    || String(config.valueModel?.sha256 || '').toLowerCase() !== modelHash
    || report.continuousMatch?.enabled !== true
    || Number(report.continuousMatch?.matches) !== CONTINUOUS_MATCHES
    || Number(report.continuousMatch?.rounds) < 16
    || Number(report.continuousMatch?.tributeRounds) < 1
    || Number(report.continuousMatch?.longRoundActionThreshold) !== 120
    || Number(report.continuousMatch?.longRounds) < 1) {
    throw new Error(`${label} 未通过 8/8、贡还、长局或零故障连续赛门`);
  }
  const configValidation = validateConfiguration(config, modelHash, implementationHash, label, true);
  const seeds = normalizeSeedManifest(config.evaluationSeedManifest);
  if (!seeds || seeds.seeds.length !== Number(config.baseDealBlocks)
    || !sameStableJson(seeds.seeds, Array.from({ length: Number(config.baseDealBlocks) }, (_, index) => (
      (Number(config.baseSeed) + index) >>> 0
    )))) {
    throw new Error(`${label} seed manifest 与 baseSeed 不一致`);
  }
  const provenance = validateProvenance(report.provenance, Number(config.baseDealBlocks), `${label}.provenance`);
  const checkpoint = validateCheckpoint(
    checkpointInput,
    config,
    report.provenance,
    modelHash,
    implementationHash,
    `${label}.checkpoint`,
  );
  if (checkpoint.coverage.games !== CONTINUOUS_MATCHES || checkpoint.coverage.pairs !== CONTINUOUS_MATCHES / 2) {
    throw new Error(`${label}.checkpoint 未覆盖 8 场连续赛`);
  }
  const metrics = validateReportAgainstCheckpoint(report, checkpoint, config, label);
  return {
    file: input.file,
    sha256: input.sha256,
    candidate: configValidation.candidate,
    provenance,
    checkpoint,
    metrics,
  };
}

function validateBlind(
  summaryInput,
  manifestInput,
  scenariosInput,
  catastrophicInput,
  bindingInput,
  primary,
  checkpoint,
  modelHash,
  implementationHash,
  candidate,
) {
  const summary = summaryInput.value;
  const manifest = manifestInput.value;
  const binding = bindingInput.value;
  if (summary?.schema !== BLIND_SUMMARY_SCHEMA) {
    throw new Error('真人盲评必须是 summary v3');
  }
  if (!isRecord(manifest) || manifest.schema !== BLIND_MANIFEST_SCHEMA
    || !Array.isArray(manifest.scenarioIds) || manifest.scenarioIds.length === 0
    || new Set(manifest.scenarioIds).size !== manifest.scenarioIds.length
    || manifest.scenarioIds.some((id) => typeof id !== 'string' || !id)
    || Number(manifest.selectedScenarios) !== manifest.scenarioIds.length
    || !Number.isSafeInteger(manifest.players) || manifest.players < 10
    || !Number.isSafeInteger(manifest.randomSeed) || manifest.randomSeed < 0
    || !Array.isArray(manifest.sourceFiles) || manifest.sourceFiles.length === 0
    || typeof manifest.selectedScenarioFile !== 'string' || !manifest.selectedScenarioFile
    || !isSha256(manifest.selectedScenarioSha256)) {
    throw new Error('盲评 manifest 场景、参与者或来源 provenance 无效');
  }
  const allocation = validateBlindAllocation(manifest);
  const selectedScenarioPath = path.resolve(path.dirname(manifestInput.file), manifest.selectedScenarioFile);
  if (selectedScenarioPath !== scenariosInput.file
    || manifest.selectedScenarioSha256 !== scenariosInput.sha256
    || scenariosInput.records.length !== manifest.scenarioIds.length) {
    throw new Error('盲评 selected scenario 文件未与 manifest 精确绑定');
  }
  const scenarioIds = [];
  const selectedScenarios = [];
  for (const [index, scenario] of scenariosInput.records.entries()) {
    if (!isRecord(scenario) || typeof scenario.id !== 'string' || !scenario.id
      || !Number.isSafeInteger(scenario.seed) || !Number.isSafeInteger(scenario.level)
      || ![0, 1].includes(scenario.candidateTeam) || !Number.isSafeInteger(scenario.turn)
      || !isSha256(scenario.sourceFileSha256)
      || scenario.evaluationImplementationSha256 !== implementationHash
      || !isRecord(scenario.observation) || !isRecord(scenario.divergence)
      || !isRecord(scenario.divergence.expert) || !isRecord(scenario.divergence.proposed)) {
      throw new Error(`盲评场景载荷第 ${index + 1} 条字段无效`);
    }
    const expectedId = `${scenario.sourceFileSha256}:${scenario.seed}:${scenario.level}:${scenario.candidateTeam}:${scenario.turn}`;
    if (scenario.id !== expectedId
      || !allocation.sourceFileHashes.has(scenario.sourceFileSha256)) {
      throw new Error(`盲评场景载荷第 ${index + 1} 条未与来源文件摘要/唯一坐标绑定`);
    }
    if (scenarioIds.includes(scenario.id)) throw new Error(`盲评场景 ID 重复：${scenario.id}`);
    scenarioIds.push(scenario.id);
    selectedScenarios.push(scenario);
  }
  if (!sameStableJson(scenarioIds, manifest.scenarioIds)) {
    throw new Error('盲评场景载荷 ID 顺序或集合与 manifest 不一致');
  }
  const assignments = validateBlindAssignments(manifest, selectedScenarios, allocation);
  const sourceScenariosById = new Map();
  for (const [index, source] of manifest.sourceFiles.entries()) {
    assertExactFields(source, ['file', 'sha256', 'validScenarioLines', 'retainedScenarios'],
      `盲评 manifest.sourceFiles[${index}]`);
    if (typeof source.file !== 'string' || !source.file || !isSha256(source.sha256)
      || !Number.isSafeInteger(source.validScenarioLines) || source.validScenarioLines < 1
      || !Number.isSafeInteger(source.retainedScenarios) || source.retainedScenarios < 1
      || source.retainedScenarios > source.validScenarioLines) {
      throw new Error(`盲评来源文件条目无效：${source.file}`);
    }
    const sourcePath = path.resolve(path.isAbsolute(source.file)
      ? source.file : path.join(path.dirname(manifestInput.file), source.file));
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`盲评来源文件不存在：${source.file}`);
    }
    const sourceBytes = fs.readFileSync(sourcePath);
    if (sha256Bytes(sourceBytes) !== source.sha256) {
      throw new Error(`盲评来源文件摘要无法复算：${source.file}`);
    }
    const extracted = extractBlindSourceScenarios(sourceBytes, source.sha256, source.file);
    if (source.validScenarioLines !== extracted.validScenarioLines
      || source.retainedScenarios !== extracted.retainedScenarios) {
      throw new Error(`盲评来源文件计数无法从 NDJSON 复算：${source.file}`);
    }
    for (const scenario of extracted.scenarios) {
      if (sourceScenariosById.has(scenario.id)) {
        throw new Error(`盲评来源文件产生重复场景 ID：${scenario.id}`);
      }
      sourceScenariosById.set(scenario.id, scenario);
    }
  }
  for (const scenario of selectedScenarios) {
    const sourceScenario = sourceScenariosById.get(scenario.id);
    if (!sourceScenario || !sameStableJson(scenario, sourceScenario)) {
      throw new Error(`盲评 selected 场景载荷未逐条匹配来源文件：${scenario.id}`);
    }
  }
  if (!isRecord(summary.manifest)
    || summary.manifest.randomSeed !== manifest.randomSeed
    || Number(summary.manifest.selectedScenarios) !== manifest.scenarioIds.length
    || Number(summary.manifest.allocatedPlayers) !== manifest.players
    || !sameStableJson(summary.manifest.sourceFiles, manifest.sourceFiles)
    || summary.manifest.selectedScenarioFile !== manifest.selectedScenarioFile
    || summary.manifest.selectedScenarioSha256 !== manifest.selectedScenarioSha256) {
    throw new Error('盲评 summary manifest provenance 未与 manifest 绑定');
  }
  validateBlindSummary(
    summary, manifest, catastrophicInput.value, scenarioIds.length, allocation, assignments,
  );
  assertExactFields(binding, [
    'schema', 'summarySha256', 'manifestSha256', 'scenarioPayloadSha256', 'scenarioIdsSha256',
    'sourceFilesSha256', 'catastrophicReviewSha256', 'modelPayloadSha256',
    'primaryReportSha256', 'primaryCheckpointSha256', 'evaluationId',
    'evaluationImplementationSha256', 'candidate', 'evaluationSeedManifestSha256',
    'answerLedgerSha256',
  ], '盲评 release binding');
  if (binding.schema !== BLIND_BINDING_SCHEMA
    || binding.summarySha256 !== summaryInput.sha256
    || binding.manifestSha256 !== manifestInput.sha256
    || binding.scenarioPayloadSha256 !== scenariosInput.sha256
    || binding.scenarioIdsSha256 !== sha256Canonical(manifest.scenarioIds)
    || binding.sourceFilesSha256 !== sha256Canonical(manifest.sourceFiles)
    || binding.catastrophicReviewSha256 !== catastrophicInput.sha256
    || binding.modelPayloadSha256 !== modelHash
    || binding.primaryReportSha256 !== primary.inputSha256
    || binding.primaryCheckpointSha256 !== checkpoint.sha256
    || binding.evaluationId !== primary.evaluationId
    || binding.evaluationImplementationSha256 !== implementationHash
    || binding.candidate !== candidate
    || binding.evaluationSeedManifestSha256 !== sha256Canonical(primary.seedManifest)
    || binding.answerLedgerSha256 !== summary.answerLedgerSha256) {
    throw new Error('盲评 summary/manifest/场景复核未绑定当前模型、正常臂或源码/种子');
  }
  return {
    summarySha256: summaryInput.sha256,
    manifestSha256: manifestInput.sha256,
    scenarioPayloadSha256: scenariosInput.sha256,
    catastrophicReviewSha256: catastrophicInput.sha256,
  };
}

// Keep the provenance check in lockstep with extract_blind_scenarios.mjs:
// valid scenario lines are counted before identity de-duplication, while the
// last record for an identical source/turn coordinate wins.
function extractBlindSourceScenarios(bytes, sourceFileSha256, label) {
  const latestByIdentity = new Map();
  let validScenarioLines = 0;
  for (const [index, line] of bytes.toString('utf8').split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      throw new Error(`盲评来源文件 ${label} 第 ${index + 1} 行不是有效 JSON：${error.message}`);
    }
    if (!isRecord(record)) {
      throw new Error(`盲评来源文件 ${label} 第 ${index + 1} 行不是对象`);
    }
    if (record.schema !== 'guandan-blind-scenario-v1'
      || !record.observation || !record.divergence?.expert || !record.divergence?.proposed) {
      continue;
    }
    const seed = Number(record.seed);
    const level = Number(record.level);
    const candidateTeam = Number(record.candidateTeam);
    const turn = Number(record.turn);
    if (![seed, level, candidateTeam, turn].every(Number.isFinite)) continue;
    const identity = `${seed}:${level}:${candidateTeam}:${turn}`;
    latestByIdentity.set(identity, {
      ...record,
      id: `${sourceFileSha256}:${identity}`,
      sourceFileSha256,
    });
    validScenarioLines += 1;
  }
  return {
    scenarios: [...latestByIdentity.values()],
    validScenarioLines,
    retainedScenarios: latestByIdentity.size,
  };
}

function validateBlindAllocation(manifest) {
  const allocation = manifest.allocation;
  if (!isRecord(allocation)
    || allocation.scheme !== 'round-robin-without-replacement'
    || allocation.repeatedScenarioRatings !== false
    || !Array.isArray(allocation.playerQuestionCounts)
    || allocation.playerQuestionCounts.length !== manifest.players
    || !Array.isArray(allocation.playerScenarioIds)
    || allocation.playerScenarioIds.length !== manifest.players
    || !Array.isArray(allocation.assignmentBindings)
    || allocation.assignmentBindings.length !== manifest.players) {
    throw new Error('盲评 manifest 缺少可复算的无重复分配清单');
  }
  const byPlayer = new Map();
  const countPlayers = new Set();
  for (const [index, entry] of allocation.playerQuestionCounts.entries()) {
    assertExactFields(entry, ['player', 'questions'], `盲评 allocation.playerQuestionCounts[${index}]`);
    if (!Number.isSafeInteger(entry.player) || entry.player < 1 || entry.player > manifest.players
      || countPlayers.has(entry.player) || !Number.isSafeInteger(entry.questions) || entry.questions < 1) {
      throw new Error('盲评 allocation.playerQuestionCounts 含无效或重复参与者');
    }
    countPlayers.add(entry.player);
  }
  const ids = new Set(manifest.scenarioIds);
  const seen = new Set();
  const scenarioPlayerIds = new Map();
  for (const [index, entry] of allocation.playerScenarioIds.entries()) {
    assertExactFields(entry, ['player', 'scenarioIds'], `盲评 allocation.playerScenarioIds[${index}]`);
    if (!Number.isSafeInteger(entry.player) || entry.player < 1 || entry.player > manifest.players
      || scenarioPlayerIds.has(entry.player) || !Array.isArray(entry.scenarioIds)
      || entry.scenarioIds.length < 1) {
      throw new Error('盲评 allocation.playerScenarioIds 含无效或重复参与者');
    }
    const playerIds = entry.scenarioIds;
    if (new Set(playerIds).size !== playerIds.length
      || playerIds.some((id) => typeof id !== 'string' || !ids.has(id) || seen.has(id))) {
      throw new Error('盲评 allocation 必须将每道题恰好分配给一名参与者');
    }
    for (const id of playerIds) {
      seen.add(id);
      scenarioPlayerIds.set(id, entry.player);
    }
    byPlayer.set(entry.player, playerIds.slice());
  }
  const assignmentBindingsByPlayer = new Map();
  for (const [index, entry] of allocation.assignmentBindings.entries()) {
    assertExactFields(entry, ['player', 'assignmentSha256', 'mappingSha256'],
      `盲评 allocation.assignmentBindings[${index}]`);
    if (!Number.isSafeInteger(entry.player) || entry.player < 1 || entry.player > manifest.players
      || assignmentBindingsByPlayer.has(entry.player)
      || !isSha256(entry.assignmentSha256) || !isSha256(entry.mappingSha256)) {
      throw new Error('盲评 assignmentBindings 含无效或重复参与者');
    }
    assignmentBindingsByPlayer.set(entry.player, entry);
  }
  if (countPlayers.size !== manifest.players || scenarioPlayerIds.size !== ids.size
    || ![...ids].every((id) => scenarioPlayerIds.has(id))
    || assignmentBindingsByPlayer.size !== manifest.players) {
    throw new Error('盲评 allocation 未覆盖全部参与者或场景');
  }
  for (const entry of allocation.playerQuestionCounts) {
    if (entry.questions !== byPlayer.get(entry.player)?.length) {
      throw new Error('盲评 allocation 的题数摘要与场景清单不一致');
    }
  }
  return {
    byPlayer,
    assignmentBindingsByPlayer,
    sourceFileHashes: new Set((manifest.sourceFiles || []).map((source) => source?.sha256)),
  };
}

function validateBlindAssignments(manifest, selectedScenarios, allocation) {
  const scenariosById = new Map(selectedScenarios.map((scenario) => [scenario.id, scenario]));
  const expectedByPlayer = new Map();
  for (let player = 1; player <= manifest.players; player += 1) {
    const ids = allocation.byPlayer.get(player) || [];
    const rng = seededRandom((manifest.randomSeed ^ Math.imul(player, 0x9E3779B1)) >>> 0);
    const questions = [];
    const mapping = {};
    for (const id of ids) {
      const scenario = scenariosById.get(id);
      if (!scenario) throw new Error(`盲评参与者 ${player} 的场景不存在：${id}`);
      const proposedIsA = rng() < 0.5;
      const [a, b] = proposedIsA
        ? [scenario.divergence.proposed, scenario.divergence.expert]
        : [scenario.divergence.expert, scenario.divergence.proposed];
      questions.push({ id, observation: scenario.observation, options: { A: a, B: b } });
      mapping[id] = {
        A: proposedIsA ? 'proposed' : 'expert',
        B: proposedIsA ? 'expert' : 'proposed',
      };
    }
    const assignmentSha256 = sha256Bytes(Buffer.from(JSON.stringify(questions), 'utf8'));
    const mappingSha256 = sha256Bytes(Buffer.from(JSON.stringify(mapping), 'utf8'));
    const binding = allocation.assignmentBindingsByPlayer.get(player);
    if (!binding || binding.assignmentSha256 !== assignmentSha256
      || binding.mappingSha256 !== mappingSha256) {
      throw new Error(`盲评参与者 ${player} 的 assignment/key 摘要无法从冻结场景与种子复算`);
    }
    expectedByPlayer.set(player, { assignmentSha256, mapping });
  }
  return expectedByPlayer;
}

function validateBlindSummary(summary, manifest, catastrophic, scenarioCount, allocation, assignments) {
  if (!Array.isArray(summary.players) || summary.players.length !== manifest.players
    || !Array.isArray(summary.invalidAnswers) || summary.invalidAnswers.length !== 0) {
    throw new Error('盲评参与者或 invalidAnswers 不完整');
  }
  if (!Array.isArray(summary.answerLedger)
    || !isSha256(summary.answerLedgerSha256)
    || summary.answerLedgerSha256 !== sha256Bytes(
      Buffer.from(JSON.stringify(summary.answerLedger), 'utf8'),
    )) {
    throw new Error('盲评 answer ledger 缺失或摘要无法复算');
  }
  const ledgerStats = validateAnswerLedger(
    summary.answerLedger, manifest, allocation, assignments, scenarioCount,
  );
  const playerIds = new Set();
  let answered = 0;
  let unanswered = 0;
  let proposedPreferred = 0;
  for (const [index, player] of summary.players.entries()) {
    assertExactFields(player, [
      'player', 'submitted', 'assigned', 'answered', 'unanswered', 'proposedPreferred', 'proposedRate',
    ], `盲评 players[${index}]`);
    if (!Number.isSafeInteger(player.player) || player.player < 1 || player.player > manifest.players
      || playerIds.has(player.player) || player.submitted !== true
      || !Number.isSafeInteger(player.assigned) || player.assigned !== allocation.byPlayer.get(player.player)?.length
      || !Number.isSafeInteger(player.answered) || player.answered < 10
      || !Number.isSafeInteger(player.unanswered) || player.unanswered < 0
      || player.unanswered !== 0
      || player.answered !== player.assigned
      || player.answered + player.unanswered !== player.assigned
      || !Number.isSafeInteger(player.proposedPreferred) || player.proposedPreferred < 0
      || player.proposedPreferred > player.answered
      || player.proposedRate !== rounded(player.proposedPreferred / player.answered, 4)) {
      throw new Error(`盲评参与者 ${player.player} 的题数或比例无效`);
    }
    playerIds.add(player.player);
    answered += player.answered;
    unanswered += player.unanswered;
    proposedPreferred += player.proposedPreferred;
  }
  for (const player of summary.players) {
    const expected = ledgerStats.byPlayer.get(player.player);
    if (!expected || player.assigned !== expected.assigned
      || player.answered !== expected.answered || player.unanswered !== expected.unanswered
      || player.proposedPreferred !== expected.proposedPreferred) {
      throw new Error(`盲评参与者 ${player.player} 未与逐题 answer ledger 一致`);
    }
  }
  if (answered !== ledgerStats.answered || unanswered !== ledgerStats.unanswered
    || proposedPreferred !== ledgerStats.proposedPreferred) {
    throw new Error('盲评总计未与逐题 answer ledger 一致');
  }
  assertExactFields(summary.totals, [
    'players', 'submittedPlayers', 'answered', 'unanswered', 'proposedPreferred', 'proposedRate',
    'wilson95Diagnostic', 'playerClusterBootstrap95', 'catastrophic',
  ], '盲评 totals');
  if (summary.totals.players !== manifest.players || summary.totals.submittedPlayers !== manifest.players
    || summary.totals.answered !== answered || summary.totals.unanswered !== unanswered
    || summary.totals.proposedPreferred !== proposedPreferred
    || summary.totals.unanswered !== 0
    || summary.totals.answered !== scenarioCount
    || summary.totals.proposedRate !== rounded(proposedPreferred / answered, 4)) {
    throw new Error('盲评 totals 未从参与者逐项复算');
  }
  const wilson = wilson95(proposedPreferred, answered).map((value) => rounded(value, 4));
  if (!sameStableJson(summary.totals.wilson95Diagnostic, wilson)) {
    throw new Error(`盲评 Wilson 诊断未从答案总数复算：actual=${JSON.stringify(summary.totals.wilson95Diagnostic)} expected=${JSON.stringify(wilson)}`);
  }
  const cluster = clusterBootstrapCI(summary.players, manifest.randomSeed)
    ?.map((value) => rounded(value, 4));
  if (!sameStableJson(summary.totals.playerClusterBootstrap95, cluster)
    || !Array.isArray(cluster) || cluster[0] <= 0.5) {
    throw new Error('盲评参与者聚类 bootstrap 未独立复算通过');
  }
  const catastrophe = summary.totals.catastrophic;
  assertExactFields(catastrophe, [
    'reviewProvided', 'reviewedScenarios', 'reviewComplete', 'scenarioDenominator',
    'selectionDiagnostic', 'reviewed', 'expertRate', 'proposedRate', 'proposedNotWorseThanExpert',
  ], '盲评 catastrophic');
  if (catastrophe.reviewProvided !== true || catastrophe.reviewedScenarios !== scenarioCount
    || catastrophe.reviewComplete !== true || catastrophe.scenarioDenominator !== scenarioCount
    || !isRecord(catastrophe.reviewed) || !Number.isSafeInteger(catastrophe.reviewed.expert)
    || !Number.isSafeInteger(catastrophe.reviewed.proposed)
    || catastrophe.reviewed.expert < 0 || catastrophe.reviewed.proposed < 0
    || catastrophe.reviewed.expert > scenarioCount || catastrophe.reviewed.proposed > scenarioCount) {
    throw new Error('盲评灾难复核计数无效');
  }
  if (!isRecord(catastrophe.selectionDiagnostic)
    || !Number.isSafeInteger(catastrophe.selectionDiagnostic.expert)
    || !Number.isSafeInteger(catastrophe.selectionDiagnostic.proposed)
    || catastrophe.selectionDiagnostic.expert < 0
    || catastrophe.selectionDiagnostic.proposed < 0
    || catastrophe.selectionDiagnostic.expert > scenarioCount
    || catastrophe.selectionDiagnostic.proposed > scenarioCount) {
    throw new Error('盲评 selectionDiagnostic 计数无效');
  }
  const review = catastrophic;
  if (!isRecord(review) || review.schema !== 'guandan-blind-catastrophe-review-v2'
    || Object.keys(review).length !== 2
    || !Array.isArray(review.reviews) || review.reviews.length !== scenarioCount) {
    throw new Error('盲评灾难复核载荷不完整');
  }
  const reviewIds = new Set();
  let expertCount = 0;
  let proposedCount = 0;
  for (const item of review.reviews) {
    assertExactFields(item, ['id', 'expert', 'proposed'], '盲评 catastrophe review');
    if (typeof item.id !== 'string' || !manifest.scenarioIds.includes(item.id)
      || reviewIds.has(item.id) || typeof item.expert !== 'boolean'
      || typeof item.proposed !== 'boolean') {
      throw new Error('盲评灾难复核 ID 或布尔字段无效');
    }
    reviewIds.add(item.id);
    expertCount += Number(item.expert);
    proposedCount += Number(item.proposed);
  }
  if (reviewIds.size !== scenarioCount || catastrophe.reviewed.expert !== expertCount
    || catastrophe.reviewed.proposed !== proposedCount
    || catastrophe.expertRate !== rounded(expertCount / scenarioCount, 4)
    || catastrophe.proposedRate !== rounded(proposedCount / scenarioCount, 4)
    || catastrophe.proposedNotWorseThanExpert !== (proposedCount <= expertCount)) {
    throw new Error('盲评灾难率或 proposed 不劣结论无法从复核载荷复算');
  }
  const expectedGateChecks = {
    minimumParticipants: manifest.players >= 10 && summary.players.every((player) => player.submitted),
    minimumAnswersPerParticipant: summary.players.every((player) => player.answered >= 10),
    fullCompletion: summary.players.every((player) => (
      player.unanswered === 0 && player.answered === player.assigned
    )) && answered === scenarioCount && unanswered === 0,
    allocationWithoutRepeat: true,
    playerClusterBootstrap: Array.isArray(cluster) && cluster[0] > 0.5,
    catastropheReviewComplete: catastrophe.reviewProvided === true
      && catastrophe.reviewedScenarios === scenarioCount
      && catastrophe.reviewComplete === true
      && reviewIds.size === scenarioCount,
    proposedCatastrophicNotWorse: catastrophe.proposedNotWorseThanExpert === true,
  };
  assertExactFields(summary.gate, [
    'criterion', 'checks', 'pass',
  ], '盲评 gate');
  assertExactFields(summary.gate.checks, [
    'minimumParticipants', 'minimumAnswersPerParticipant', 'fullCompletion',
    'allocationWithoutRepeat', 'playerClusterBootstrap', 'catastropheReviewComplete',
    'proposedCatastrophicNotWorse',
  ], '盲评 gate.checks');
  if (!sameStableJson(summary.gate.checks, expectedGateChecks)
    || summary.gate.pass !== Object.values(expectedGateChecks).every(Boolean)) {
    throw new Error('盲评 gate 存在未通过检查或被伪造为 pass');
  }
}

function validateAnswerLedger(ledger, manifest, allocation, assignments, scenarioCount) {
  if (ledger.length !== scenarioCount) {
    throw new Error('盲评 answer ledger 未覆盖每道已分配题目');
  }
  const expectedOrder = [];
  for (let player = 1; player <= manifest.players; player += 1) {
    for (const id of allocation.byPlayer.get(player) || []) {
      expectedOrder.push({ player, id });
    }
  }
  const byPlayer = new Map();
  const seen = new Set();
  let answered = 0;
  let unanswered = 0;
  let proposedPreferred = 0;
  for (const [index, entry] of ledger.entries()) {
    assertExactFields(entry, [
      'player', 'id', 'choice', 'side', 'mapping', 'assignmentSha256',
    ], `盲评 answerLedger[${index}]`);
    const expected = expectedOrder[index];
    const mapping = entry.mapping;
    const expectedAssignment = assignments.get(expected?.player);
    const expectedMapping = expectedAssignment?.mapping?.[expected?.id];
    if (!expected || entry.player !== expected.player || entry.id !== expected.id
      || seen.has(entry.id) || !isSha256(entry.assignmentSha256)
      || entry.assignmentSha256 !== expectedAssignment?.assignmentSha256
      || ![null, 'A', 'B'].includes(entry.choice)
      || ![null, 'expert', 'proposed'].includes(entry.side)
      || !isRecord(mapping)
      || Object.keys(mapping).length !== 2
      || !Object.prototype.hasOwnProperty.call(mapping, 'A')
      || !Object.prototype.hasOwnProperty.call(mapping, 'B')
      || !['expert', 'proposed'].includes(mapping.A)
      || !['expert', 'proposed'].includes(mapping.B)
      || mapping.A === mapping.B
      || !expectedMapping
      || !sameStableJson(mapping, expectedMapping)
      || (entry.choice === null) !== (entry.side === null)) {
      throw new Error(`盲评 answer ledger 第 ${index + 1} 条未与 allocation/答案取值绑定`);
    }
    if (entry.choice !== null && entry.side !== mapping[entry.choice]) {
      throw new Error(`盲评 answer ledger 第 ${index + 1} 条的 choice/side 未与冻结 A/B 映射一致`);
    }
    seen.add(entry.id);
    const stats = byPlayer.get(entry.player) || {
      assigned: 0, answered: 0, unanswered: 0, proposedPreferred: 0,
    };
    stats.assigned += 1;
    if (entry.choice === null) stats.unanswered += 1;
    else {
      stats.answered += 1;
      stats.proposedPreferred += Number(entry.side === 'proposed');
      answered += 1;
      proposedPreferred += Number(entry.side === 'proposed');
    }
    unanswered += Number(entry.choice === null);
    byPlayer.set(entry.player, stats);
  }
  if (seen.size !== scenarioCount || byPlayer.size !== manifest.players) {
    throw new Error('盲评 answer ledger 未精确覆盖参与者与场景');
  }
  return { byPlayer, answered, unanswered, proposedPreferred };
}

function wilson95(successes, total, z = 1.96) {
  if (!total) return [null, null];
  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total) / denominator;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

function clusterBootstrapCI(players, seed, iterations = 5000) {
  if (!players.length || players.some((player) => player.answered <= 0)) return null;
  const rng = seededRandom((seed ^ 0x51ED270B) >>> 0);
  const rates = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let proposed = 0;
    let answered = 0;
    for (let index = 0; index < players.length; index += 1) {
      const player = players[Math.floor(rng() * players.length)];
      proposed += player.proposedPreferred;
      answered += player.answered;
    }
    rates.push(proposed / answered);
  }
  rates.sort((left, right) => left - right);
  return [rates[Math.floor(iterations * 0.025)], rates[Math.min(iterations - 1, Math.floor(iterations * 0.975))]];
}

function validateModel(input) {
  const validation = validateHybridValueModel(input.value);
  const semanticHash = modelPayloadSha256(input.value);
  if (!validation.ok || !isSha256(semanticHash)) throw new Error(`模型无效：${validation.reason || 'semantic hash unavailable'}`);
  if (!isPromotedValueModel(input.value)) {
    throw new Error('模型没有绑定当前语义摘要、完整主 A/B、M3 连续赛和正 CI 的 promoted 回执');
  }
  return { semanticHash };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const model = readJson(options.model, '模型');
  const primaryInput = readJson(options.report, '正常臂报告');
  const checkpointInput = readJson(options.checkpoint, '正常臂 checkpoint');
  const rawInput = readJson(options.rawTelemetry, '原始遥测');
  const performanceInput = readJson(options.performance, '严格性能回执');
  const continuousInput = readJson(options.continuousReport, '连续赛报告');
  const continuousCheckpointInput = readJson(options.continuousCheckpoint, '连续赛 checkpoint');
  const blindSummaryInput = readJson(options.blindSummary, '盲评 summary');
  const blindManifestInput = readJson(options.blindManifest, '盲评 manifest');
  const blindScenariosInput = readNdjson(options.blindScenarios, '盲评场景载荷');
  const blindCatastrophicInput = readJson(options.blindCatastrophic, '盲评灾难复核');
  const blindBindingInput = readJson(options.blindBinding, '盲评 binding');

  const modelInfo = validateModel(model);
  const modelHash = modelInfo.semanticHash;
  const primary = primaryInput.value;
  const modelValidationReceipt = model.value?.metadata?.validation;
  if (modelValidationReceipt?.primaryReportSha256 !== primaryInput.sha256) {
    throw new Error('模型 promotion 回执未绑定当前正常臂报告');
  }
  if (primary?.schema !== AB_REPORT_SCHEMA) throw new Error(`正常臂报告必须是 ${AB_REPORT_SCHEMA}`);
  const implementation = validateImplementation(primary.config?.evaluationImplementation, '正常臂源码');
  const configValidation = validateConfiguration(primary.config, modelHash, implementation.sha256, '正常臂');
  const primaryTrainingSeeds = normalizeSeedManifest(
    primary.config.valueModel?.trainingSeedManifest || primary.config.valueModel?.trainingData?.seedManifest,
  );
  const modelTrainingSeeds = normalizeSeedManifest(
    model.value?.metadata?.trainingSeedManifest || model.value?.metadata?.trainingData?.seedManifest,
  );
  const primaryDatasetSha256 = String(
    primary.config.valueModel?.trainingDatasetSha256
      || primary.config.valueModel?.trainingData?.sha256 || '',
  ).toLowerCase();
  const modelDatasetSha256 = String(
    model.value?.metadata?.trainingDatasetSha256
      || model.value?.metadata?.trainingData?.sha256 || '',
  ).toLowerCase();
  if (!primaryTrainingSeeds || !modelTrainingSeeds
    || !sameStableJson(primaryTrainingSeeds, modelTrainingSeeds)
    || !isSha256(primaryDatasetSha256) || modelDatasetSha256 !== primaryDatasetSha256) {
    throw new Error('模型训练 seed/dataset provenance 未与正常臂主报告逐项绑定');
  }
  const primaryProvenance = validateProvenance(primary.provenance, GROUPS, '正常臂.provenance');
  const evaluationSeeds = normalizeSeedManifest(primary.config.evaluationSeedManifest);
  if (!evaluationSeeds || evaluationSeeds.seeds.length !== GROUPS) throw new Error('正常臂种子 manifest 必须精确覆盖 80 区组');
  if (!sameStableJson(evaluationSeeds.seeds, Array.from({ length: GROUPS }, (_, index) => (
    (Number(primary.config.baseSeed) + index) >>> 0
  )))) throw new Error('正常臂 seed manifest 与 baseSeed 不一致');
  const completion = primary.completion || {};
  if (Number(completion.gamesCompleted) !== GROUPS * LEVELS.length * 2
    || Number(completion.mirrorPairsCompleted) !== GROUPS * LEVELS.length
    || Number(completion.baseDealBlocksCompleted) !== GROUPS
    || Number(completion.failures) !== 0 || Number(completion.deadlocks) !== 0
    || Number(completion.mirrorMismatches) !== 0) throw new Error('正常臂完成计数或安全计数失败');
  const primaryRecord = {
    file: primaryInput.file,
    inputSha256: primaryInput.sha256,
    evaluationId: primary.provenance.evaluationId,
    seedManifest: evaluationSeeds,
    candidate: configValidation.candidate,
    value: primary,
    provenance: primaryProvenance,
  };
  const checkpoint = validateCheckpoint(
    checkpointInput,
    primary.config,
    primary.provenance,
    modelHash,
    implementation.sha256,
    '正常臂 checkpoint',
  );
  if (checkpoint.coverage.games !== GROUPS * LEVELS.length * 2
    || checkpoint.coverage.pairs !== GROUPS * LEVELS.length) throw new Error('正常臂 checkpoint 覆盖不完整');
  const primaryMetrics = validateReportAgainstCheckpoint(
    primary,
    checkpoint,
    primary.config,
    '正常臂',
  );
  const rawTelemetry = validateRawTelemetry(
    rawInput,
    primaryRecord,
    checkpoint,
    configValidation.candidate,
    implementation.sha256,
    '原始遥测',
  );
  const performance = validateNormalPerformance(
    performanceInput,
    primaryRecord,
    rawTelemetry,
    checkpoint,
    configValidation.candidate,
    implementation.sha256,
    '严格性能回执',
  );
  const continuous = validateContinuous(
    continuousInput,
    continuousCheckpointInput,
    primaryRecord,
    modelHash,
    implementation.sha256,
    '连续赛',
  );
  if (modelValidationReceipt?.continuousMatch?.reportSha256 !== continuousInput.sha256) {
    throw new Error('模型 promotion 回执未绑定当前连续赛报告');
  }
  const promotion = evaluateValueModelPromotion(primary, modelHash, {
    continuousReport: continuousInput.value,
    continuousReportSha256: continuousInput.sha256,
  });
  if (promotion.promoted !== true) throw new Error(`模型强度/发布质量门未晋级：${promotion.reasons.join(',')}`);
  if (!sameStableJson(modelValidationReceipt?.utilityCI, promotion.metrics.utilityCI)
    || !sameStableJson(modelValidationReceipt?.levelPerformance, promotion.metrics.levelPerformance)
    || !sameStableJson(modelValidationReceipt?.continuousMatch, promotion.metrics.continuousMatch)
    || !sameStableJson(modelValidationReceipt?.evaluationSeedManifest, primary.config.evaluationSeedManifest)
    || (modelValidationReceipt?.trainingSeedManifest != null
      && !sameStableJson(modelValidationReceipt.trainingSeedManifest, primaryTrainingSeeds))
    || (modelValidationReceipt?.trainingDatasetSha256 != null
      && String(modelValidationReceipt.trainingDatasetSha256).toLowerCase() !== primaryDatasetSha256)) {
    throw new Error('模型 promotion receipt 的训练/评测 provenance 或质量指标未与主报告逐项一致');
  }
  const blind = validateBlind(
    blindSummaryInput,
    blindManifestInput,
    blindScenariosInput,
    blindCatastrophicInput,
    blindBindingInput,
    primaryRecord,
    checkpoint,
    modelHash,
    implementation.sha256,
    configValidation.candidate,
  );
  const output = {
    schema: M2_SCHEMA,
    releaseEvidenceReady: true,
    promotable: true,
    status: promotion.status,
    model: { file: model.file, payloadSha256: modelHash },
    normalArm: {
      report: { file: primaryInput.file, sha256: primaryInput.sha256 },
      checkpoint: { file: checkpointInput.file, sha256: checkpoint.sha256, integritySha256: checkpoint.integritySha256 },
      rawTelemetry: { file: rawInput.file, sha256: rawTelemetry.sha256, records: rawTelemetry.records },
      performance: { file: performanceInput.file, sha256: performanceInput.sha256 },
    },
    continuous: {
      report: { file: continuousInput.file, sha256: continuousInput.sha256 },
      checkpoint: { file: continuousCheckpointInput.file, sha256: continuous.checkpoint.sha256 },
    },
    blindEvaluation: blind,
    evaluationId: primaryRecord.evaluationId,
    evaluationImplementationSha256: implementation.sha256,
    promotion,
    reasons: [],
  };
  const serialized = `${JSON.stringify(output, null, 2)}\n`;
  if (options.out) {
    fs.mkdirSync(path.dirname(options.out), { recursive: true });
    fs.writeFileSync(options.out, serialized, 'utf8');
  }
  console.log(serialized.trimEnd());
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({
    schema: M2_SCHEMA,
    releaseEvidenceReady: false,
    promotable: false,
    status: 'blocked',
    reasons: [message, error?.stack || message],
  }, null, 2));
  process.exitCode = 1;
}
