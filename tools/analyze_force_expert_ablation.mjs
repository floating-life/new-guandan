#!/usr/bin/env node
/**
 * WP1 改选价值归因：配对比较正常臂与 forceExpertChoice 消融臂（-fxe）的同种子
 * A/B checkpoint。两臂在每一副基础牌上面对完全相同的局面序列，直到第一次改选
 * 分歧；[正常]−[强制] 的区组级效用差即“搜索改选决策”的净贡献。
 *
 * 推断单元与正式晋级门一致：基础牌区组（pairs 按 block 聚合平均），bootstrap
 * 95% CI 复用 ai.ab.simulation.js 的确定性算法（mulberry32，5000 次重采样，
 * 种子 baseSeed ^ 0xA5A5A5A5），同一对输入永远得到同一份回执。
 *
 * 用法：
 *   node tools/analyze_force_expert_ablation.mjs --normal 正常臂.checkpoint.json --forced 消融臂.checkpoint.json [--out 回执.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveHybridSearchConfig } from '../js/ai.js';
import {
  CHECKPOINT_INTEGRITY_SCHEMA,
  CHECKPOINT_SCHEMA,
  EVALUATION_PROVENANCE_SCHEMA,
  RUN_SEGMENT_SCHEMA,
  environmentHashMatches,
  isSha256,
  isUuid,
  sha256Canonical,
  stableJson,
} from '../js/ai.ab.provenance.js';

function run() {
  const options = parseArgs(process.argv.slice(2));
  const normal = readCheckpoint(options.normal, '正常臂');
  const forced = readCheckpoint(options.forced, '消融臂');
  validatePair(normal, forced);

const { groupCount, baseSeed, evaluationLevels } = parseSignature(normal.data) || {};
const levelCount = evaluationLevels.length;
const perBlock = [];
for (let block = 1; block <= groupCount; block += 1) {
  const normalPairs = pairsOfBlock(normal.data, block);
  const forcedPairs = pairsOfBlock(forced.data, block);
  if (normalPairs.length !== levelCount || forcedPairs.length !== levelCount
    || !normalPairs.every((pair) => pair.complete) || !forcedPairs.every((pair) => pair.complete)) {
    throw new Error(`区组 ${block} 不完整：正常臂 ${normalPairs.length} 对、消融臂 ${forcedPairs.length} 对（预期各 ${levelCount} 对且全部 complete）`);
  }
  const normalUtility = average(normalPairs.map((pair) => pair.utility));
  const forcedUtility = average(forcedPairs.map((pair) => pair.utility));
  perBlock.push({
    block,
    seed: (baseSeed + block - 1) >>> 0,
    normalUtility: rounded(normalUtility),
    forcedUtility: rounded(forcedUtility),
    difference: rounded(normalUtility - forcedUtility),
  });
}
const differences = perBlock.map((item) => item.difference);
const meanDifference = average(differences);
const ci = bootstrapMeanCI(differences, baseSeed);
const changedDecisions = countDecisions(normal.data, 'changed');
const wouldChangeDecisions = countDecisions(forced.data, 'wouldChange');
// 不能只看总改选次数：强制臂必须在每个镜像对象上都是专家的严格副本，
// 且与正常臂逐对象拥有相同的“本会改选”计数。否则 normal - forced
// 同时混入了控制臂实现误差，bootstrap 即使为正也不能解释为改选净贡献。
const forcedExpertEquivalence = validateForcedExpertEquivalence(forced.data);
const changedDecisionParity = compareChangedDecisionParity(normal.data, forced.data);
const mechanicalGatesPass = forcedExpertEquivalence.pass && changedDecisionParity.pass;

const receipt = {
  schema: 'guandan-fxe-ablation-v1',
  generatedAt: new Date().toISOString(),
  inputs: {
    normal: { file: path.resolve(options.normal), sha256: normal.sha256, candidate: parseSignature(normal.data)?.candidate },
    forced: { file: path.resolve(options.forced), sha256: forced.sha256, candidate: parseSignature(forced.data)?.candidate },
  },
  design: {
    baseSeed,
    baseDealBlocks: groupCount,
    evaluationLevels,
    inferenceUnit: 'base-deal-block paired difference (normal - forced)',
    bootstrapIterations: 5000,
  },
  changedDecisions,
  wouldChangeDecisions,
  mechanicalGates: {
    forcedExpertEquivalence,
    changedDecisionParity,
    pass: mechanicalGatesPass,
  },
  meanDifference: rounded(meanDifference),
  bootstrap95: ci ? ci.map((value) => rounded(value)) : null,
  causalInferenceEligible: mechanicalGatesPass,
  verdict: !mechanicalGatesPass
    ? 'invalid_forced_expert_control'
    : ci && ci[0] > 0
      ? 'changed_decisions_net_positive'
      : ci && ci[1] < 0
        ? 'changed_decisions_net_negative'
        : 'changed_decisions_inconclusive',
  perBlock,
};

const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
if (options.out) {
  fs.mkdirSync(path.dirname(options.out), { recursive: true });
  fs.writeFileSync(options.out, serialized, 'utf8');
}
  console.log(serialized.trimEnd());
}

function parseArgs(args) {
  const result = { normal: null, forced: null, out: null };
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!['--normal', '--forced', '--out'].includes(key)) throw new Error(`未知参数：${key}`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${key} 需要一个值`);
    if (key === '--normal') result.normal = value;
    if (key === '--forced') result.forced = value;
    if (key === '--out') result.out = path.resolve(value);
    index += 1;
  }
  if (!result.normal || !result.forced) {
    throw new Error('用法：node tools/analyze_force_expert_ablation.mjs --normal 正常臂.checkpoint.json --forced 消融臂.checkpoint.json [--out 回执.json]');
  }
  return result;
}

function readCheckpoint(file, label) {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) throw new Error(`${label} checkpoint 不存在：${resolved}`);
  const bytes = fs.readFileSync(resolved);
  let data;
  try {
    data = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`${label} checkpoint 不是有效 JSON：${error.message}`);
  }
  validateCheckpoint(data, label);
  return { data, sha256: createHash('sha256').update(bytes).digest('hex') };
}

const CHECKPOINT_FIELDS = [
  'schema', 'signature', 'signaturePayload', 'nextBlockIndex', 'complete',
  'provenance', 'games', 'pairs', 'failures', 'checkpointIntegrity',
];
const SIGNATURE_FIELDS = [
  'groupCount', 'baseSeed', 'candidate', 'comparison', 'evaluationLevels',
  'levelBlockDesign', 'continuousMatch', 'evaluationOpponentModelMode',
  'valueModelSha256', 'evaluationImplementationSha256', 'hybridEngineVersion',
  'candidateSearchConfig',
];
const PROVENANCE_FIELDS = [
  'schema', 'evaluationId', 'runSegments', 'runSegmentsSha256',
];
const RUN_SEGMENT_FIELDS = [
  'schema', 'evaluationId', 'runSegmentId', 'ordinal', 'resume',
  'previousRunSegmentId', 'inputCheckpointSha256', 'startBlockIndex',
  'endBlockIndex', 'startedAt', 'completedAt', 'process', 'environment',
];
const ENVIRONMENT_FIELDS = ['schema', 'machine', 'runtime', 'environmentSha256'];
const MACHINE_FIELDS = [
  'hostnameSha256', 'platform', 'release', 'arch', 'cpuModel',
  'logicalCores', 'memoryBytes',
];
const RUNTIME_FIELDS = ['node', 'v8'];
const PROCESS_FIELDS = ['pid', 'ppid'];
const INTEGRITY_FIELDS = ['schema', 'sha256'];
const PAIR_FIELDS = [
  'group', 'block', 'seed', 'level', 'runSegmentId', 'mirrorMatched',
  'crossLevelMatched', 'dealFingerprint', 'complete', 'utility',
  'candidateHeads', 'candidateDoubleUps', 'comparisonDoubleUps', 'orders',
  'firstDivergences',
];
const GAME_FIELDS = [
  'ok', 'seed', 'level', 'candidateTeam', 'order', 'firstPlayer',
  'dealFingerprint', 'upgrade', 'utility', 'candidateHead', 'comparisonHead',
  'baselineHead', 'candidateDoubleUp', 'comparisonDoubleUp', 'baselineDoubleUp',
  'firstDivergence', 'hybrid', 'decisionTelemetry', 'actions', 'durationMs',
  'runSegmentId',
];
const HYBRID_FIELDS = [
  'turns', 'applied', 'changed', 'samples', 'nodes', 'iterations', 'forceExpert',
  'wouldChange', 'searchModes', 'reasons', 'rejected',
];
const TELEMETRY_FIELDS = [
  'seat', 'policy', 'engine', 'variantPresent', 'localDecisionPresent',
  'searchTelemetryPresent', 'fallbackKindPresent', 'telemetryComplete',
  'latencyMs', 'source', 'fallbackKind', 'fallbackEvaluable', 'timeoutFallback',
  'searchAttempted', 'searchTriggered', 'candidates', 'samples', 'nodes',
  'iterations', 'rolloutBudget', 'sweepBudget', 'pairedSweeps',
];

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function assertExactFields(record, fields, label) {
  if (!isRecord(record) || Object.keys(record).length !== fields.length
    || fields.some((field) => !Object.prototype.hasOwnProperty.call(record, field))) {
    throw new Error(`${label} 字段不完整或包含未声明字段`);
  }
}

function assertRequiredFields(record, fields, label) {
  if (!isRecord(record) || fields.some((field) => (
    !Object.prototype.hasOwnProperty.call(record, field)
  ))) {
    throw new Error(`${label} 缺少必要字段`);
  }
}

function sameStableJson(left, right) {
  try {
    return stableJson(left) === stableJson(right);
  } catch {
    return false;
  }
}

function withoutCandidate(signature) {
  const { candidate, ...rest } = signature;
  return rest;
}

function finiteInteger(value, label, { min = null, max = null } = {}) {
  if (!Number.isSafeInteger(value)
    || (min != null && value < min) || (max != null && value > max)) {
    throw new Error(`${label} 必须是有效整数`);
  }
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} 必须是非负整数`);
  }
}

function isIsoTimestamp(value) {
  return typeof value === 'string' && value.length >= 20 && Number.isFinite(Date.parse(value));
}

function assertOrder(order, label) {
  if (!Array.isArray(order) || order.length !== 4
    || !order.every((seat) => Number.isInteger(seat) && seat >= 0 && seat <= 3)
    || new Set(order).size !== 4) {
    throw new Error(`${label} 必须是 0、1、2、3 的唯一排列`);
  }
}

function expectedSearchConfig() {
  return resolveHybridSearchConfig('ismcts-v3', {
    deterministic: true,
    timeBudgetMs: 0,
  });
}

function expectedPairsFor(signature) {
  const expected = [];
  let group = 0;
  for (let blockIndex = 0; blockIndex < signature.groupCount; blockIndex += 1) {
    const seed = signature.baseSeed + blockIndex;
    for (const level of signature.evaluationLevels) {
      group += 1;
      expected.push({
        group,
        block: blockIndex + 1,
        seed,
        level,
        key: `${seed}/${level}`,
      });
    }
  }
  return expected;
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
  return createHash('sha256')
    .update(JSON.stringify(checkpointContent(checkpoint)))
    .digest('hex');
}

function validateSignaturePayload(data, label) {
  if (data.schema !== CHECKPOINT_SCHEMA || typeof data.signature !== 'string'
    || !isRecord(data.signaturePayload)) {
    throw new Error(`${label} 不是完整的 ${CHECKPOINT_SCHEMA}`);
  }
  assertExactFields(data.signaturePayload, SIGNATURE_FIELDS, `${label}.signaturePayload`);
  if (data.signature !== JSON.stringify(data.signaturePayload)) {
    throw new Error(`${label} signature 与 signaturePayload 不一致`);
  }
  const signature = parseSignature(data);
  if (!signature) throw new Error(`${label} signature 无法解析`);
  finiteInteger(signature.groupCount, `${label}.groupCount`, { min: 1 });
  finiteInteger(signature.baseSeed, `${label}.baseSeed`, { min: 0, max: 0xFFFF_FFFF });
  if (signature.groupCount > 0x1_0000_0000 - signature.baseSeed) {
    throw new Error(`${label} 种子范围发生 uint32 回绕`);
  }
  if (!['ismcts-v3', 'ismcts-v3-fxe'].includes(signature.candidate)
    || signature.comparison !== 'expert') {
    throw new Error(`${label} 候选或对照不属于 fxe v3 契约`);
  }
  if (!Array.isArray(signature.evaluationLevels) || signature.evaluationLevels.length < 1
    || signature.evaluationLevels.length > 13
    || !signature.evaluationLevels.every((level) => (
      Number.isInteger(level) && level >= 2 && level <= 14
    ))
    || new Set(signature.evaluationLevels).size !== signature.evaluationLevels.length) {
    throw new Error(`${label} evaluationLevels 不完整或含重复级别`);
  }
  if (signature.levelBlockDesign !== true || signature.continuousMatch !== false
    || signature.evaluationOpponentModelMode !== 'off') {
    throw new Error(`${label} 必须是 level-block、非连续赛且显式 off 模式`);
  }
  if (signature.valueModelSha256 !== null && !isSha256(signature.valueModelSha256)) {
    throw new Error(`${label} valueModelSha256 无效`);
  }
  if (!isSha256(signature.evaluationImplementationSha256)) {
    throw new Error(`${label} 缺少合法 evaluationImplementationSha256`);
  }
  if (signature.hybridEngineVersion !== 1) {
    throw new Error(`${label} hybridEngineVersion 不符`);
  }
  assertExactFields(signature.candidateSearchConfig, Object.keys(expectedSearchConfig()),
    `${label}.candidateSearchConfig`);
  if (!sameStableJson(signature.candidateSearchConfig, expectedSearchConfig())) {
    throw new Error(`${label} candidateSearchConfig 不是当前确定性 v3 配置`);
  }
  return signature;
}

function validateEnvironment(environment, label) {
  assertExactFields(environment, ENVIRONMENT_FIELDS, label);
  assertExactFields(environment.machine, MACHINE_FIELDS, `${label}.machine`);
  assertExactFields(environment.runtime, RUNTIME_FIELDS, `${label}.runtime`);
  if (!environmentHashMatches(environment)
    || !isSha256(environment.machine.hostnameSha256)
    || typeof environment.machine.platform !== 'string' || !environment.machine.platform
    || typeof environment.machine.release !== 'string' || !environment.machine.release
    || typeof environment.machine.arch !== 'string' || !environment.machine.arch
    || typeof environment.machine.cpuModel !== 'string' || !environment.machine.cpuModel
    || !Number.isSafeInteger(environment.machine.logicalCores)
    || environment.machine.logicalCores < 1
    || !Number.isSafeInteger(environment.machine.memoryBytes)
    || environment.machine.memoryBytes < 1
    || typeof environment.runtime.node !== 'string' || !environment.runtime.node
    || typeof environment.runtime.v8 !== 'string' || !environment.runtime.v8) {
    throw new Error(`${label} 环境摘要无效`);
  }
}

function validateProvenance(provenance, groupCount, label) {
  assertExactFields(provenance, PROVENANCE_FIELDS, `${label}.provenance`);
  if (provenance.schema !== EVALUATION_PROVENANCE_SCHEMA
    || !isUuid(provenance.evaluationId)
    || !Array.isArray(provenance.runSegments)
    || provenance.runSegments.length < 1
    || !isSha256(provenance.runSegmentsSha256)
    || provenance.runSegmentsSha256 !== sha256Canonical(provenance.runSegments)) {
    throw new Error(`${label} provenance 标识、链或摘要无效`);
  }
  const runSegmentsById = new Map();
  const environments = [];
  let expectedStart = 0;
  let previousId = null;
  let previousCompletedAt = null;
  for (let index = 0; index < provenance.runSegments.length; index += 1) {
    const segment = provenance.runSegments[index];
    assertExactFields(segment, RUN_SEGMENT_FIELDS, `${label}.runSegments[${index}]`);
    assertExactFields(segment.process, PROCESS_FIELDS, `${label}.runSegments[${index}].process`);
    if (segment.schema !== RUN_SEGMENT_SCHEMA
      || segment.evaluationId !== provenance.evaluationId
      || !isUuid(segment.runSegmentId)
      || runSegmentsById.has(segment.runSegmentId)
      || segment.ordinal !== index + 1
      || typeof segment.resume !== 'boolean'
      || segment.resume !== (index > 0)
      || segment.previousRunSegmentId !== previousId
      || (index === 0
        ? segment.inputCheckpointSha256 !== null
        : !isSha256(segment.inputCheckpointSha256))
      || !Number.isSafeInteger(segment.startBlockIndex)
      || !Number.isSafeInteger(segment.endBlockIndex)
      || segment.startBlockIndex !== expectedStart
      || segment.endBlockIndex <= segment.startBlockIndex
      || segment.endBlockIndex > groupCount
      || !isIsoTimestamp(segment.startedAt)
      || !isIsoTimestamp(segment.completedAt)
      || Date.parse(segment.completedAt) < Date.parse(segment.startedAt)
      || (previousCompletedAt != null && Date.parse(segment.startedAt) < previousCompletedAt)
      || !Number.isSafeInteger(segment.process.pid)
      || segment.process.pid < 1
      || !(segment.process.ppid === null
        || (Number.isSafeInteger(segment.process.ppid) && segment.process.ppid >= 0))) {
      throw new Error(`${label}.runSegments[${index}] 链或范围无效`);
    }
    validateEnvironment(segment.environment, `${label}.runSegments[${index}].environment`);
    runSegmentsById.set(segment.runSegmentId, segment);
    environments.push(segment.environment);
    expectedStart = segment.endBlockIndex;
    previousId = segment.runSegmentId;
    previousCompletedAt = Date.parse(segment.completedAt);
  }
  if (expectedStart !== groupCount) {
    throw new Error(`${label} provenance 运行段没有精确覆盖全部区组`);
  }
  if (environments.some((environment) => !sameStableJson(environment, environments[0]))) {
    throw new Error(`${label} provenance 运行环境在运行段之间不一致`);
  }
  return { runSegmentsById, environments };
}

function validateNumericCounter(value, label) {
  nonNegativeInteger(value, label);
}

function validateCountMap(value, label) {
  if (!isRecord(value)) throw new Error(`${label} 必须是对象`);
  for (const [key, count] of Object.entries(value)) {
    if (!key || !Number.isSafeInteger(count) || count < 0) {
      throw new Error(`${label} 含无效计数`);
    }
  }
}

function validateHybrid(hybrid, signature, label) {
  assertRequiredFields(hybrid, HYBRID_FIELDS, label);
  for (const field of [
    'turns', 'applied', 'changed', 'samples', 'nodes', 'iterations', 'forceExpert', 'wouldChange',
  ]) validateNumericCounter(hybrid[field], `${label}.${field}`);
  if (hybrid.turns < 1 || hybrid.applied > hybrid.turns || hybrid.changed > hybrid.applied
    || hybrid.wouldChange > hybrid.applied || hybrid.forceExpert > hybrid.applied) {
    throw new Error(`${label} 计数范围无效`);
  }
  validateCountMap(hybrid.searchModes, `${label}.searchModes`);
  validateCountMap(hybrid.reasons, `${label}.reasons`);
  validateCountMap(hybrid.rejected, `${label}.rejected`);
  if (Object.values(hybrid.searchModes).reduce((sum, count) => sum + count, 0) !== hybrid.turns
    || Object.values(hybrid.reasons).reduce((sum, count) => sum + count, 0) !== hybrid.turns) {
    throw new Error(`${label} turns 与 searchModes/reasons 不守恒`);
  }
  if (signature.candidate === 'ismcts-v3-fxe' && hybrid.changed !== 0) {
    throw new Error(`${label} fxe 强制臂 changed 必须为零`);
  }
  if (signature.candidate === 'ismcts-v3' && hybrid.changed !== hybrid.wouldChange) {
    throw new Error(`${label} 正常臂 changed 与 wouldChange 不一致`);
  }
}

function validateTelemetry(telemetry, signature, candidateTeam, label) {
  if (!Array.isArray(telemetry) || telemetry.length < 1) {
    throw new Error(`${label} decisionTelemetry 缺失或为空`);
  }
  for (let index = 0; index < telemetry.length; index += 1) {
    const item = telemetry[index];
    assertRequiredFields(item, TELEMETRY_FIELDS, `${label}[${index}]`);
    finiteInteger(item.seat, `${label}[${index}].seat`, { min: 0, max: 3 });
    const expectedCandidate = [0, 2].includes(item.seat) ? 0 : 1;
    const expectedPolicy = expectedCandidate === candidateTeam ? signature.candidate : 'expert';
    if (item.policy !== expectedPolicy || item.engine !== expectedPolicy
      || item.variantPresent !== true || item.localDecisionPresent !== true
      || item.searchTelemetryPresent !== true || item.fallbackKindPresent !== true
      || item.fallbackEvaluable !== true || typeof item.telemetryComplete !== 'boolean'
      || typeof item.timeoutFallback !== 'boolean'
      || typeof item.searchAttempted !== 'boolean'
      || typeof item.searchTriggered !== 'boolean') {
      throw new Error(`${label}[${index}] 策略或完整性字段无效`);
    }
    if (!(item.latencyMs === null
      || (typeof item.latencyMs === 'number' && Number.isFinite(item.latencyMs)
        && item.latencyMs >= 0))
      || typeof item.source !== 'string' || !item.source
      || typeof item.fallbackKind !== 'string' || !item.fallbackKind) {
      throw new Error(`${label}[${index}] latency/source/fallback 字段无效`);
    }
    for (const field of ['candidates', 'samples', 'nodes', 'iterations',
      'rolloutBudget', 'sweepBudget', 'pairedSweeps']) {
      validateNumericCounter(item[field], `${label}[${index}].${field}`);
    }
  }
}

function validateGame(game, expected, signature, runSegmentsById, label) {
  assertExactFields(game, GAME_FIELDS, label);
  if (game.ok !== true || game.seed !== expected.seed || game.level !== expected.level
    || ![0, 1].includes(game.candidateTeam)) {
    throw new Error(`${label} 坐标或完成状态无效`);
  }
  if (!isUuid(game.runSegmentId) || !runSegmentsById.has(game.runSegmentId)) {
    throw new Error(`${label} 缺少有效 runSegmentId`);
  }
  const segment = runSegmentsById.get(game.runSegmentId);
  if (expected.block - 1 < segment.startBlockIndex
    || expected.block - 1 >= segment.endBlockIndex) {
    throw new Error(`${label} runSegmentId 未覆盖所属区组`);
  }
  assertOrder(game.order, `${label}.order`);
  finiteInteger(game.firstPlayer, `${label}.firstPlayer`, { min: 0, max: 3 });
  if (typeof game.dealFingerprint !== 'string' || !game.dealFingerprint
    || !Number.isSafeInteger(game.upgrade) || game.upgrade < 1 || game.upgrade > 3
    || typeof game.utility !== 'number' || !Number.isFinite(game.utility)
    || game.utility === 0
    || typeof game.candidateHead !== 'boolean'
    || typeof game.comparisonHead !== 'boolean'
    || typeof game.baselineHead !== 'boolean'
    || typeof game.candidateDoubleUp !== 'boolean'
    || typeof game.comparisonDoubleUp !== 'boolean'
    || typeof game.baselineDoubleUp !== 'boolean'
    || game.comparisonHead === game.candidateHead
    || game.baselineHead !== game.comparisonHead
    || game.candidateHead !== (game.utility > 0)) {
    throw new Error(`${label} 结果字段无效`);
  }
  if (game.candidateDoubleUp && !game.candidateHead
    || game.comparisonDoubleUp && game.candidateHead
    || game.baselineDoubleUp !== game.comparisonDoubleUp
    || game.utility !== (game.candidateHead ? game.upgrade : -game.upgrade)) {
    throw new Error(`${label} 胜负/升级/双上字段自相矛盾`);
  }
  if (game.firstDivergence !== null && !isRecord(game.firstDivergence)) {
    throw new Error(`${label}.firstDivergence 无效`);
  }
  if (!Number.isSafeInteger(game.actions) || game.actions < 1
    || typeof game.durationMs !== 'number' || !Number.isFinite(game.durationMs)
    || game.durationMs < 0) {
    throw new Error(`${label} actions/durationMs 无效`);
  }
  validateHybrid(game.hybrid, signature, `${label}.hybrid`);
  validateTelemetry(game.decisionTelemetry, signature, game.candidateTeam,
    `${label}.decisionTelemetry`);
}

function validatePairRecord(pair, expected, games, signature, runSegmentsById, label) {
  assertExactFields(pair, PAIR_FIELDS, label);
  if (pair.group !== expected.group || pair.block !== expected.block
    || pair.seed !== expected.seed || pair.level !== expected.level
    || !isUuid(pair.runSegmentId) || !runSegmentsById.has(pair.runSegmentId)
    || pair.mirrorMatched !== true || pair.crossLevelMatched !== true
    || pair.complete !== true || typeof pair.dealFingerprint !== 'string'
    || !pair.dealFingerprint || typeof pair.utility !== 'number'
    || !Number.isFinite(pair.utility)
    || !Number.isSafeInteger(pair.candidateHeads) || pair.candidateHeads < 0
    || pair.candidateHeads > 2 || !Number.isSafeInteger(pair.candidateDoubleUps)
    || pair.candidateDoubleUps < 0 || pair.candidateDoubleUps > 2
    || !Number.isSafeInteger(pair.comparisonDoubleUps)
    || pair.comparisonDoubleUps < 0 || pair.comparisonDoubleUps > 2
    || !Array.isArray(pair.orders) || pair.orders.length !== 2
    || !Array.isArray(pair.firstDivergences) || pair.firstDivergences.length !== 2) {
    throw new Error(`${label} pair 字段无效`);
  }
  const [even, odd] = games;
  if (pair.runSegmentId !== even.runSegmentId || pair.runSegmentId !== odd.runSegmentId
    || even.firstPlayer !== odd.firstPlayer
    || even.dealFingerprint !== odd.dealFingerprint
    || pair.dealFingerprint !== even.dealFingerprint
    || !sameStableJson(pair.orders, [even.order, odd.order])
    || !sameStableJson(pair.firstDivergences, [even.firstDivergence, odd.firstDivergence])
    || pair.candidateHeads !== Number(even.candidateHead) + Number(odd.candidateHead)
    || pair.candidateDoubleUps !== Number(even.candidateDoubleUp) + Number(odd.candidateDoubleUp)
    || pair.comparisonDoubleUps !== Number(even.comparisonDoubleUp)
      + Number(odd.comparisonDoubleUp)
    || pair.utility !== (even.utility + odd.utility) / 2) {
    throw new Error(`${label} pair 与两条镜像 game 不一致`);
  }
  assertOrder(pair.orders[0], `${label}.orders[0]`);
  assertOrder(pair.orders[1], `${label}.orders[1]`);
  for (const [index, divergence] of pair.firstDivergences.entries()) {
    if (divergence !== null && !isRecord(divergence)) {
      throw new Error(`${label}.firstDivergences[${index}] 无效`);
    }
  }
}

function validateCheckpoint(data, label) {
  assertExactFields(data, CHECKPOINT_FIELDS, label);
  const signature = validateSignaturePayload(data, label);
  if (data.complete !== true || data.nextBlockIndex !== signature.groupCount
    || !Array.isArray(data.games) || !Array.isArray(data.pairs)
    || !Array.isArray(data.failures) || data.failures.length !== 0) {
    throw new Error(`${label} 必须是 complete=true 的完整 checkpoint 且 failures=[]`);
  }
  const integrity = data.checkpointIntegrity;
  assertExactFields(integrity, INTEGRITY_FIELDS, `${label}.checkpointIntegrity`);
  if (integrity.schema !== CHECKPOINT_INTEGRITY_SCHEMA
    || !isSha256(integrity.sha256)
    || integrity.sha256 !== checkpointContentSha256(data)) {
    throw new Error(`${label} checkpointIntegrity 内容 SHA-256 不可复算`);
  }
  const { runSegmentsById } = validateProvenance(data.provenance, signature.groupCount, label);
  const expectedPairs = expectedPairsFor(signature);
  if (data.pairs.length !== expectedPairs.length || data.games.length !== expectedPairs.length * 2) {
    throw new Error(`${label} pairs/games 数量不符`);
  }
  const expectedByKey = new Map(expectedPairs.map((item) => [item.key, item]));
  const gamesByKey = new Map();
  for (const game of data.games) {
    if (!isRecord(game) || !Number.isSafeInteger(game.seed)
      || !Number.isSafeInteger(game.level) || ![0, 1].includes(game.candidateTeam)) {
      throw new Error(`${label} 存在不可索引 game`);
    }
    const key = `${game.seed}/${game.level}`;
    const expected = expectedByKey.get(key);
    const gameKey = `${key}/${game.candidateTeam}`;
    if (!expected || gamesByKey.has(gameKey)) {
      throw new Error(`${label} game 坐标重复或不属于预登记覆盖`);
    }
    validateGame(game, expected, signature, runSegmentsById, `${label}.game ${gameKey}`);
    gamesByKey.set(gameKey, game);
  }
  const pairsByKey = new Map();
  for (const pair of data.pairs) {
    if (!isRecord(pair) || !Number.isSafeInteger(pair.seed)
      || !Number.isSafeInteger(pair.level)) {
      throw new Error(`${label} 存在不可索引 pair`);
    }
    const key = `${pair.seed}/${pair.level}`;
    const expected = expectedByKey.get(key);
    if (!expected || pairsByKey.has(key)) {
      throw new Error(`${label} pair 坐标重复或不属于预登记覆盖`);
    }
    pairsByKey.set(key, pair);
  }
  for (const expected of expectedPairs) {
    const key = expected.key;
    const even = gamesByKey.get(`${key}/0`);
    const odd = gamesByKey.get(`${key}/1`);
    const pair = pairsByKey.get(key);
    if (!even || !odd || !pair) throw new Error(`${label} 缺少完整 seed×level×team 对象：${key}`);
    validatePairRecord(pair, expected, [even, odd], signature, runSegmentsById,
      `${label}.pair ${key}`);
  }
  for (let block = 1; block <= signature.groupCount; block += 1) {
    const blockPairs = expectedPairs
      .filter((expected) => expected.block === block)
      .map((expected) => pairsByKey.get(expected.key));
    const fingerprint = blockPairs[0].dealFingerprint;
    if (!fingerprint || !blockPairs.every((pair) => pair.dealFingerprint === fingerprint)) {
      throw new Error(`${label} 区组 ${block} 未通过 same-deal-cross-level 校验`);
    }
  }
  return signature;
}

function environmentOf(data) {
  return data.provenance.runSegments[0].environment;
}

function validatePair(normal, forced) {
  // checkpoint 的 signature 是为 resume 精确比对而序列化的字符串，先解析。
  const a = parseSignature(normal.data);
  const b = parseSignature(forced.data);
  if (!a || !b) throw new Error('checkpoint 缺少有效 signature');
  if (a.candidate !== 'ismcts-v3' || b.candidate !== 'ismcts-v3-fxe') {
    throw new Error(`fxe 只接受 ismcts-v3/ismcts-v3-fxe 候选：${a.candidate} vs ${b.candidate}`);
  }
  if (a.comparison !== 'expert' || b.comparison !== 'expert') {
    throw new Error(`两臂对照都必须是 expert：${a.comparison} vs ${b.comparison}`);
  }
  if (a.evaluationOpponentModelMode !== 'off'
    || b.evaluationOpponentModelMode !== 'off') {
    throw new Error('两臂必须显式使用 evaluationOpponentModelMode=off');
  }
  if (!isSha256(a.evaluationImplementationSha256)
    || !isSha256(b.evaluationImplementationSha256)
    || a.evaluationImplementationSha256 !== b.evaluationImplementationSha256) {
    throw new Error('两臂必须使用相同且完整的源码指纹');
  }
  if (!sameStableJson(withoutCandidate(a), withoutCandidate(b))) {
    throw new Error('除 candidate 外两臂 signaturePayload 必须完全相同');
  }
  if (!sameStableJson(environmentOf(normal.data), environmentOf(forced.data))) {
    throw new Error('两臂 provenance 环境不一致，无法配对');
  }
  const expectedPairs = a.groupCount * a.evaluationLevels.length;
  if (normal.data.pairs.length !== expectedPairs || forced.data.pairs.length !== expectedPairs) {
    throw new Error(`pairs 数量不符：${normal.data.pairs.length} / ${forced.data.pairs.length}，预期 ${expectedPairs}`);
  }
}

function validateForcedExpertEquivalence(data) {
  const violations = {
    incompletePairs: 0,
    mirrorMismatchPairs: 0,
    crossLevelMismatchPairs: 0,
    nonZeroUtilityPairs: 0,
    headMismatchPairs: 0,
    doubleUpMismatchPairs: 0,
  };
  const examples = [];
  for (const pair of data.pairs) {
    const failed = [];
    if (pair?.complete !== true) {
      violations.incompletePairs += 1;
      failed.push('incomplete');
    }
    if (pair?.mirrorMatched !== true) {
      violations.mirrorMismatchPairs += 1;
      failed.push('mirrorMismatch');
    }
    if (pair?.crossLevelMatched !== true) {
      violations.crossLevelMismatchPairs += 1;
      failed.push('crossLevelMismatch');
    }
    if (Number(pair?.utility) !== 0) {
      violations.nonZeroUtilityPairs += 1;
      failed.push('nonZeroUtility');
    }
    // 每组有两条换座腿。控制臂与专家完全等价时，候选方恰好一次头游。
    if (Number(pair?.candidateHeads) !== 1) {
      violations.headMismatchPairs += 1;
      failed.push('headMismatch');
    }
    if (Number(pair?.candidateDoubleUps) !== Number(pair?.comparisonDoubleUps)) {
      violations.doubleUpMismatchPairs += 1;
      failed.push('doubleUpMismatch');
    }
    if (failed.length && examples.length < 12) {
      examples.push({
        block: pair?.block,
        seed: pair?.seed,
        level: pair?.level,
        failures: failed,
        utility: pair?.utility,
        candidateHeads: pair?.candidateHeads,
        candidateDoubleUps: pair?.candidateDoubleUps,
        comparisonDoubleUps: pair?.comparisonDoubleUps,
      });
    }
  }
  const pass = Object.values(violations).every((count) => count === 0);
  return { pass, checkedPairs: data.pairs.length, violations, examples };
}

function compareChangedDecisionParity(normal, forced) {
  const keyOf = (game) => `${game?.seed}/${game?.level}/${game?.candidateTeam}`;
  const index = (games) => {
    const byKey = new Map();
    const duplicates = [];
    for (const game of games) {
      const key = keyOf(game);
      if (byKey.has(key)) duplicates.push(key);
      else byKey.set(key, game);
    }
    return { byKey, duplicates };
  };
  const normalIndex = index(normal.games);
  const forcedIndex = index(forced.games);
  const missingForcedObjects = [];
  const missingNormalObjects = [];
  const mismatchedObjects = [];
  const dealFingerprintMismatches = [];
  const firstPlayerMismatches = [];
  let normalChanged = 0;
  let forcedWouldChange = 0;
  let dealFingerprintMismatchCount = 0;
  let firstPlayerMismatchCount = 0;
  for (const [key, normalGame] of normalIndex.byKey) {
    const changed = normalGame.hybrid.changed;
    normalChanged += changed;
    const forcedGame = forcedIndex.byKey.get(key);
    if (!forcedGame) {
      if (missingForcedObjects.length < 12) missingForcedObjects.push(key);
      continue;
    }
    const wouldChange = forcedGame.hybrid.wouldChange;
    if (normalGame.dealFingerprint !== forcedGame.dealFingerprint) {
      dealFingerprintMismatchCount += 1;
      if (dealFingerprintMismatches.length < 12) {
        dealFingerprintMismatches.push({
          key,
          normalDealFingerprint: normalGame.dealFingerprint,
          forcedDealFingerprint: forcedGame.dealFingerprint,
        });
      }
    }
    if (normalGame.firstPlayer !== forcedGame.firstPlayer) {
      firstPlayerMismatchCount += 1;
      if (firstPlayerMismatches.length < 12) {
        firstPlayerMismatches.push({
          key,
          normalFirstPlayer: normalGame.firstPlayer,
          forcedFirstPlayer: forcedGame.firstPlayer,
        });
      }
    }
    if (changed !== wouldChange && mismatchedObjects.length < 12) {
      mismatchedObjects.push({ key, normalChanged: changed, forcedWouldChange: wouldChange });
    }
  }
  for (const [key, forcedGame] of forcedIndex.byKey) {
    forcedWouldChange += Number(forcedGame?.hybrid?.wouldChange) || 0;
    if (!normalIndex.byKey.has(key) && missingNormalObjects.length < 12) {
      missingNormalObjects.push(key);
    }
  }
  const mismatchCount = [...normalIndex.byKey].filter(([key, normalGame]) => {
    const forcedGame = forcedIndex.byKey.get(key);
    return forcedGame && (
      normalGame.dealFingerprint !== forcedGame.dealFingerprint
      || normalGame.firstPlayer !== forcedGame.firstPlayer
      || normalGame.hybrid.changed !== forcedGame.hybrid.wouldChange
    );
  }).length;
  const pass = normalIndex.duplicates.length === 0
    && forcedIndex.duplicates.length === 0
    && missingForcedObjects.length === 0
    && missingNormalObjects.length === 0
    && mismatchCount === 0
    && normalChanged === forcedWouldChange;
  return {
    pass,
    normalChanged,
    forcedWouldChange,
    comparedGameObjects: Math.min(normalIndex.byKey.size, forcedIndex.byKey.size),
    mismatchedGameObjects: mismatchCount,
    dealFingerprintMismatchedGameObjects: dealFingerprintMismatchCount,
    firstPlayerMismatchedGameObjects: firstPlayerMismatchCount,
    duplicateNormalObjects: normalIndex.duplicates.length,
    duplicateForcedObjects: forcedIndex.duplicates.length,
    missingForcedObjects,
    missingNormalObjects,
    dealFingerprintMismatches,
    firstPlayerMismatches,
    examples: mismatchedObjects,
  };
}

function parseSignature(data) {
  const raw = data?.signature;
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return typeof raw === 'object' ? raw : null;
}

function pairsOfBlock(data, block) {
  return data.pairs
    .filter((pair) => pair.block === block)
    .sort((left, right) => left.level - right.level);
}

function countDecisions(data, field) {
  let total = 0;
  for (const game of data.games) {
    total += Number(game?.hybrid?.[field]) || 0;
  }
  return total;
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function rounded(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

// 与 ai.ab.simulation.js 的 seededRandom/bootstrapMeanCI 逐字节同算法，
// 保证消融回执与正式 A/B 报告的重采样分布同源、可复现。
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
  for (let n = 0; n < iterations; n += 1) {
    let sum = 0;
    for (let i = 0; i < values.length; i += 1) {
      sum += values[Math.floor(rng() * values.length)];
    }
    samples.push(sum / values.length);
  }
  samples.sort((a, b) => a - b);
  return [
    samples[Math.floor(iterations * 0.025)],
    samples[Math.min(iterations - 1, Math.floor(iterations * 0.975))],
  ];
}

run();
