import { modelPayloadSha256 } from './model-fingerprint.js';

/**
 * 本地价值模型的发布门禁。
 *
 * experimental_unvalidated：仅可离线校验/训练，不得进入正式对局。
 * validated：完成足量公平镜像赛且无安全故障，但尚未证明强于稳定专家。
 * promoted：足量镜像赛的升级收益置信下界为正，可由网页加载。
 */

export const VALUE_MODEL_STATUS = Object.freeze({
  EXPERIMENTAL: 'experimental_unvalidated',
  VALIDATED: 'validated',
  PROMOTED: 'promoted',
});

const MODEL_CAPABLE_CANDIDATES = Object.freeze(['hybrid-v1', 'root-pimc-v1', 'ismcts-v1']);

function canonicalModelCandidate(value) {
  // `ismcts-v1` 只保留给既有报告的读取兼容；新证据统一标记为 root-pimc-v1。
  const candidate = String(value || '');
  return candidate === 'ismcts-v1' ? 'root-pimc-v1' : candidate;
}

export const SEED_MANIFEST_SCHEMA = 'guandan-seed-manifest-v1';

// M3 发布质量下限。它们不是“证明更强”的阈值（强度仍由总样本置信下界
// 判断），而是防止总体平均值掩盖单一级牌灾难性退化，并确保连续赛实际覆盖
// 贡还和长局路径。
export const VALUE_MODEL_RELEASE_QUALITY = Object.freeze({
  perLevelSchema: 'guandan-per-level-release-quality-v1',
  continuousSchema: 'guandan-continuous-match-release-quality-v1',
  minUtilityPerGame: -0.1,
  minHeadRate: 0.45,
  minContinuousMatches: 8,
  minContinuousRounds: 16,
  minTributeRounds: 1,
  minLongRounds: 1,
  longRoundActionThreshold: 120,
});

/**
 * 将实验报告/模型中的种子清单归一化为可比较的 uint32 数组。
 * 晋级门禁只接受显式清单；不能从一个“看起来像范围”的字符串猜测种子。
 */
export function normalizeSeedManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schema !== SEED_MANIFEST_SCHEMA || !Array.isArray(value.seeds)) {
    return null;
  }
  const seeds = [];
  for (const seed of value.seeds) {
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xFFFFFFFF) return null;
    seeds.push(seed >>> 0);
  }
  if (!seeds.length || new Set(seeds).size !== seeds.length) return null;
  return { schema: SEED_MANIFEST_SCHEMA, seeds };
}

export function createSeedManifest(seeds) {
  const normalized = [...new Set((Array.isArray(seeds) ? seeds : [])
    .filter((seed) => Number.isInteger(seed) && seed >= 0 && seed <= 0xFFFFFFFF)
    .map((seed) => seed >>> 0))].sort((left, right) => left - right);
  return { schema: SEED_MANIFEST_SCHEMA, seeds: normalized };
}

export function seedManifestOverlap(left, right) {
  const a = normalizeSeedManifest(left);
  const b = normalizeSeedManifest(right);
  if (!a || !b) return [];
  const rightSeeds = new Set(b.seeds);
  return a.seeds.filter((seed) => rightSeeds.has(seed));
}

export function normalizeValueModelStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  return Object.values(VALUE_MODEL_STATUS).includes(status)
    ? status : VALUE_MODEL_STATUS.EXPERIMENTAL;
}

export function valueModelStatus(model) {
  return normalizeValueModelStatus(model?.metadata?.status);
}

function validSha256(value) {
  return /^[a-f0-9]{64}$/i.test(String(value || ''));
}

function validPerLevelQualityReceipt(value, blocksPlanned) {
  if (!value || value.schema !== VALUE_MODEL_RELEASE_QUALITY.perLevelSchema
    || Number(value.expectedGamesPerLevel) !== blocksPlanned * 2
    || Number(value.minimumUtilityPerGame) < VALUE_MODEL_RELEASE_QUALITY.minUtilityPerGame
    || Number(value.minimumHeadRate) < VALUE_MODEL_RELEASE_QUALITY.minHeadRate
    || !Array.isArray(value.levels) || value.levels.length !== 13) return false;
  const seen = new Set();
  return value.levels.every((entry) => {
    const level = Number(entry?.level);
    const games = Number(entry?.games);
    const utility = Number(entry?.utilityPerGame);
    const headRate = Number(entry?.headRate);
    if (!Number.isInteger(level) || level < 2 || level > 14 || seen.has(level)) return false;
    seen.add(level);
    return Number.isFinite(games) && games >= blocksPlanned * 2
      && Number.isFinite(utility) && utility >= VALUE_MODEL_RELEASE_QUALITY.minUtilityPerGame
      && Number.isFinite(headRate) && headRate >= VALUE_MODEL_RELEASE_QUALITY.minHeadRate;
  });
}

function validContinuousQualityReceipt(value, modelSha256, trainingSeeds, primarySeeds) {
  const seeds = normalizeSeedManifest(value?.continuousSeedManifest);
  return value?.schema === VALUE_MODEL_RELEASE_QUALITY.continuousSchema
    && validSha256(value?.reportSha256)
    && String(value?.modelSha256 || '').toLowerCase() === String(modelSha256 || '').toLowerCase()
    && MODEL_CAPABLE_CANDIDATES.includes(String(value?.candidate))
    && String(value?.comparison) === 'expert'
    && !!seeds
    && Number(value?.matchesPlanned) >= VALUE_MODEL_RELEASE_QUALITY.minContinuousMatches
    && Number(value?.matchesCompleted) === Number(value?.matchesPlanned)
    && Number(value?.mirrorPairs) * 2 === Number(value?.matchesCompleted)
    && Number(value?.rounds) >= VALUE_MODEL_RELEASE_QUALITY.minContinuousRounds
    && Number(value?.tributeRounds) >= VALUE_MODEL_RELEASE_QUALITY.minTributeRounds
    && Number(value?.longRoundActionThreshold) === VALUE_MODEL_RELEASE_QUALITY.longRoundActionThreshold
    && Number(value?.longRounds) >= VALUE_MODEL_RELEASE_QUALITY.minLongRounds
    && Number(value?.failures) === 0 && Number(value?.deadlocks) === 0
    && Number(value?.mirrorMismatches) === 0
    && seedManifestOverlap(seeds, trainingSeeds).length === 0
    && seedManifestOverlap(seeds, primarySeeds).length === 0;
}

/**
 * promoted 不是一个可由调用方手写的开关。它必须带有 promote_value_model.mjs
 * 生成的、绑定模型哈希和完整 A/B 指标的发布回执。
 */
export function hasPromotionReceipt(model) {
  const metadata = model?.metadata || {};
  const receipt = metadata.validation || {};
  const actualModelSha256 = modelPayloadSha256(model);
  const recordedModelSha256 = String(metadata.modelSha256 || '').toLowerCase();
  const levels = Array.isArray(receipt.evaluationLevels)
    ? receipt.evaluationLevels.map(Number) : [];
  const ci = Array.isArray(receipt.utilityCI) ? receipt.utilityCI.map(Number) : [];
  const gamesPlanned = Number(receipt.gamesPlanned);
  const gamesCompleted = Number(receipt.gamesCompleted);
  const blocksPlanned = Number(receipt.baseDealBlocksPlanned);
  const blocksCompleted = Number(receipt.baseDealBlocksCompleted);
  const pairs = Number(receipt.mirrorPairs);
  const failures = Number(receipt.failures);
  const deadlocks = Number(receipt.deadlocks);
  const mirrorMismatches = Number(receipt.mirrorMismatches);
  const receiptEvaluationSeeds = normalizeSeedManifest(receipt.evaluationSeedManifest);
  const receiptTrainingSeeds = normalizeSeedManifest(
    metadata.trainingSeedManifest || metadata.trainingData?.seedManifest,
  );
  const trainingDatasetSha256 = metadata.trainingDatasetSha256
    || metadata.trainingData?.sha256;
  const receiptOverlaps = seedManifestOverlap(receiptEvaluationSeeds, receiptTrainingSeeds);
  const validLevels = validPerLevelQualityReceipt(receipt.levelPerformance, blocksPlanned);
  const validContinuous = validContinuousQualityReceipt(
    receipt.continuousMatch,
    actualModelSha256,
    receiptTrainingSeeds,
    receiptEvaluationSeeds,
  );
  return validSha256(actualModelSha256)
    && validSha256(recordedModelSha256)
    && recordedModelSha256 === actualModelSha256
    && validSha256(receipt.primaryReportSha256)
    && validSha256(trainingDatasetSha256)
    && String(receipt.candidate || '') !== ''
    && MODEL_CAPABLE_CANDIDATES.includes(String(receipt.candidate))
    && String(receipt.comparison || '') === 'expert'
    && completeLevelCoverage(levels)
    && String(receipt.evaluationDesign || '') === 'same-deal-cross-level-blocks'
    && Number.isFinite(pairs) && pairs >= 500
    && Number.isFinite(gamesPlanned) && gamesPlanned > 0 && gamesCompleted === gamesPlanned
    && Number.isFinite(blocksPlanned) && blocksPlanned > 0 && blocksCompleted === blocksPlanned
    && gamesPlanned === blocksPlanned * 13 * 2
    && pairs === gamesPlanned / 2 && pairs === blocksPlanned * 13
    && !!receiptEvaluationSeeds && receiptEvaluationSeeds.seeds.length === blocksPlanned
    && Number.isFinite(failures) && failures === 0
    && Number.isFinite(deadlocks) && deadlocks === 0
    && Number.isFinite(mirrorMismatches) && mirrorMismatches === 0
    && ci.length === 2 && ci.every(Number.isFinite) && ci[0] <= ci[1]
    && ci[0] > 0
    && receiptOverlaps.length === 0
    && !!receiptTrainingSeeds
    && validLevels
    && validContinuous;
}

export function isPromotedValueModel(model) {
  return valueModelStatus(model) === VALUE_MODEL_STATUS.PROMOTED && hasPromotionReceipt(model);
}

function completeLevelCoverage(levels) {
  const covered = new Set((Array.isArray(levels) ? levels : [])
    .map(Number).filter((level) => Number.isInteger(level) && level >= 2 && level <= 14));
  return covered.size === 13;
}

function fullReleaseLevels() {
  return Array.from({ length: 13 }, (_, index) => index + 2);
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 对完整跨级 A/B 的每一级做单独的安全下限审计。总样本效果可为正，某一级
 * 仍可能明显退化；这份结构化结果会被写入发布回执。
 */
export function evaluatePerLevelReleaseQuality(report) {
  const config = report?.config || {};
  const byLevel = report?.byLevel || {};
  const blocks = Math.max(0, Number(config.baseDealBlocks) || 0);
  const expectedGames = blocks * 2;
  const levels = fullReleaseLevels().map((level) => {
    const summary = byLevel[String(level)] || byLevel[level] || {};
    const games = Math.max(0, Number(summary.games) || 0);
    const utilityPerGame = numberOrNull(summary.candidateUtilityPerGame);
    const headRate = numberOrNull(summary.candidateHeadRate);
    const ok = games >= expectedGames && utilityPerGame != null && headRate != null
      && utilityPerGame >= VALUE_MODEL_RELEASE_QUALITY.minUtilityPerGame
      && headRate >= VALUE_MODEL_RELEASE_QUALITY.minHeadRate;
    return {
      level,
      games,
      utilityPerGame,
      headRate,
      ok,
    };
  });
  const failedLevels = levels.filter((level) => !level.ok).map((level) => level.level);
  return {
    schema: VALUE_MODEL_RELEASE_QUALITY.perLevelSchema,
    expectedGamesPerLevel: expectedGames,
    minimumUtilityPerGame: VALUE_MODEL_RELEASE_QUALITY.minUtilityPerGame,
    minimumHeadRate: VALUE_MODEL_RELEASE_QUALITY.minHeadRate,
    levels,
    failedLevels,
    ok: expectedGames > 0 && failedLevels.length === 0,
  };
}

/**
 * 审核独立连续对局报告。连续赛必须使用不同于训练和主 A/B 的种子，并完整
 * 跑过至少一次贡还和长局路径；它的强度统计不与主跨级 A/B 混合。
 */
export function evaluateContinuousMatchReleaseQuality(
  report,
  expectedSha256,
  primaryEvaluationSeeds = null,
  reportSha256 = null,
) {
  const reasons = [];
  const config = report?.config || {};
  const completion = report?.completion || {};
  const continuous = report?.continuousMatch || {};
  const audit = config.valueModel || {};
  const continuousSeeds = normalizeSeedManifest(config.evaluationSeedManifest);
  const trainingSeeds = normalizeSeedManifest(
    audit.trainingSeedManifest || audit.trainingData?.seedManifest,
  );
  const primarySeeds = normalizeSeedManifest(primaryEvaluationSeeds);
  const expectedHash = String(expectedSha256 || '').toLowerCase();
  const actualHash = String(audit.sha256 || '').toLowerCase();
  const matches = Math.max(0, Number(continuous.matches) || 0);
  const rounds = Math.max(0, Number(continuous.rounds) || 0);
  const tributeRounds = Math.max(0, Number(continuous.tributeRounds) || 0);
  const longRounds = Math.max(0, Number(continuous.longRounds) || 0);
  const longRoundActionThreshold = Number(continuous.longRoundActionThreshold);
  const gamesPlanned = Math.max(0, Number(config.gamesPlanned) || 0);
  const gamesCompleted = Math.max(0, Number(completion.gamesCompleted) || 0);
  const pairsCompleted = Math.max(0, Number(completion.mirrorPairsCompleted) || 0);
  const failures = Math.max(0, Number(completion.failures) || 0);
  const deadlocks = Math.max(0, Number(completion.deadlocks) || 0);
  const mirrorMismatches = Math.max(0, Number(completion.mirrorMismatches) || 0);
  const overlapTraining = seedManifestOverlap(continuousSeeds, trainingSeeds);
  const overlapPrimary = seedManifestOverlap(continuousSeeds, primarySeeds);

  if (config.continuousMatch !== true) reasons.push('continuous_mode_not_enabled');
  if (String(config.outcomeUnit || '') !== 'match win (+1/-1)') reasons.push('continuous_outcome_unit_invalid');
  if (!MODEL_CAPABLE_CANDIDATES.includes(String(config.candidate || ''))) {
    reasons.push('continuous_candidate_engine_invalid');
  }
  if (String(config.comparison || '') !== 'expert') reasons.push('continuous_comparison_not_expert');
  if (config.deterministic !== true) reasons.push('continuous_nondeterministic');
  if (String(config.difficulty || '') !== 'master') reasons.push('continuous_difficulty_not_master');
  if (!expectedHash || actualHash !== expectedHash) reasons.push('continuous_model_hash_mismatch');
  if (!validSha256(reportSha256)) reasons.push('continuous_report_provenance_missing');
  if (!continuousSeeds) reasons.push('continuous_seed_provenance_missing');
  if (!trainingSeeds) reasons.push('continuous_training_seed_provenance_missing');
  if (overlapTraining.length) reasons.push('continuous_training_seed_overlap');
  if (primarySeeds && overlapPrimary.length) reasons.push('continuous_primary_seed_overlap');
  if (gamesPlanned < VALUE_MODEL_RELEASE_QUALITY.minContinuousMatches
    || gamesCompleted !== gamesPlanned || matches !== gamesCompleted
    || pairsCompleted * 2 !== gamesCompleted) {
    reasons.push('continuous_matches_incomplete');
  }
  if (matches < VALUE_MODEL_RELEASE_QUALITY.minContinuousMatches) {
    reasons.push('continuous_matches_insufficient');
  }
  if (failures > 0) reasons.push('continuous_failures');
  if (deadlocks > 0) reasons.push('continuous_deadlocks');
  if (mirrorMismatches > 0) reasons.push('continuous_mirror_mismatches');
  if (rounds < VALUE_MODEL_RELEASE_QUALITY.minContinuousRounds) {
    reasons.push('continuous_round_coverage_insufficient');
  }
  if (tributeRounds < VALUE_MODEL_RELEASE_QUALITY.minTributeRounds) {
    reasons.push('continuous_tribute_coverage_insufficient');
  }
  if (longRoundActionThreshold !== VALUE_MODEL_RELEASE_QUALITY.longRoundActionThreshold
    || longRounds < VALUE_MODEL_RELEASE_QUALITY.minLongRounds) {
    reasons.push('continuous_long_round_coverage_insufficient');
  }

  return {
    schema: VALUE_MODEL_RELEASE_QUALITY.continuousSchema,
    reportSha256: validSha256(reportSha256) ? String(reportSha256).toLowerCase() : null,
    modelSha256: actualHash || null,
    candidate: String(config.candidate || '') || null,
    comparison: String(config.comparison || '') || null,
    continuousSeedManifest: continuousSeeds,
    matchesPlanned: gamesPlanned,
    matchesCompleted: matches,
    mirrorPairs: pairsCompleted,
    rounds,
    tributeRounds,
    longRoundActionThreshold: Number.isFinite(longRoundActionThreshold)
      ? longRoundActionThreshold : null,
    longRounds,
    failures,
    deadlocks,
    mirrorMismatches,
    reasons,
    ok: reasons.length === 0,
  };
}

/**
 * 根据 ai.ab.simulation.js 的 JSON 报告判断模型晋级状态。
 * expectedSha256 绑定报告与权重，防止拿别的模型报告冒充当前模型。
 */
export function evaluateValueModelPromotion(report, expectedSha256, options = {}) {
  const minMirrorPairs = Math.max(1, Math.floor(Number(options.minMirrorPairs) || 500));
  const reasons = [];
  const completion = report?.completion || {};
  const config = report?.config || {};
  const result = report?.result || {};
  const reportModel = config.valueModel || {};
  const pairs = Math.max(0, Number(completion.mirrorPairsCompleted) || 0);
  const gamesPlanned = Math.max(0, Number(config.gamesPlanned) || 0);
  const gamesCompleted = Math.max(0, Number(completion.gamesCompleted) || 0);
  const blocksPlanned = Math.max(0, Number(config.baseDealBlocks) || 0);
  const blocksCompleted = Math.max(0, Number(completion.baseDealBlocksCompleted) || 0);
  const failures = Math.max(0, Number(completion.failures) || 0);
  const deadlocks = Math.max(0, Number(completion.deadlocks) || 0);
  const mirrorMismatches = Math.max(0, Number(completion.mirrorMismatches) || 0);
  const utilityCI = Array.isArray(result.candidatePairedUtilityBootstrap95)
    ? result.candidatePairedUtilityBootstrap95.map(Number) : [];
  const validUtilityCI = utilityCI.length === 2
    && utilityCI.every(Number.isFinite) && utilityCI[0] <= utilityCI[1];
  const utilityLower = validUtilityCI ? utilityCI[0] : null;
  const expectedHash = String(expectedSha256 || '').toLowerCase();
  const actualHash = String(reportModel.sha256 || '').toLowerCase();
  const evaluationSeedManifest = normalizeSeedManifest(config.evaluationSeedManifest);
  const trainingSeedManifest = normalizeSeedManifest(
    reportModel.trainingSeedManifest || reportModel.trainingData?.seedManifest,
  );
  const trainingDatasetSha256 = reportModel.trainingDatasetSha256
    || reportModel.trainingData?.sha256;
  const overlap = seedManifestOverlap(evaluationSeedManifest, trainingSeedManifest);

  if (!expectedHash || actualHash !== expectedHash) reasons.push('model_hash_mismatch');
  if (!MODEL_CAPABLE_CANDIDATES.includes(String(config.candidate || ''))) {
    reasons.push('candidate_engine_not_model_capable');
  }
  if (String(config.comparison || '') !== 'expert') reasons.push('comparison_not_expert');
  if (!completeLevelCoverage(config.evaluationLevels)) reasons.push('incomplete_level_coverage');
  if (String(config.evaluationDesign || '') !== 'same-deal-cross-level-blocks') {
    reasons.push('evaluation_design_not_same_deal_blocks');
  }
  if (pairs < minMirrorPairs) reasons.push('insufficient_mirror_pairs');
  if (!gamesPlanned || gamesCompleted !== gamesPlanned) reasons.push('incomplete_planned_games');
  if (!blocksPlanned || blocksCompleted !== blocksPlanned) reasons.push('incomplete_base_deal_blocks');
  if (gamesPlanned > 0 && pairs !== gamesPlanned / 2) reasons.push('mirror_pairs_not_matching_games');
  if (blocksPlanned > 0 && pairs !== blocksPlanned * 13) reasons.push('mirror_pairs_not_cross_level');
  if (completeLevelCoverage(config.evaluationLevels)
    && blocksPlanned > 0
    && gamesPlanned !== blocksPlanned * 13 * 2) {
    reasons.push('base_deal_blocks_not_cross_level');
  }
  if (config.deterministic !== true) reasons.push('nondeterministic_evaluation');
  if (String(config.difficulty || '') !== 'master') reasons.push('difficulty_not_master');
  if (failures > 0) reasons.push('simulation_failures');
  if (deadlocks > 0) reasons.push('simulation_deadlocks');
  if (mirrorMismatches > 0) reasons.push('mirror_mismatches');
  if (!evaluationSeedManifest) reasons.push('evaluation_seed_provenance_missing');
  if (!trainingSeedManifest) reasons.push('training_seed_provenance_missing');
  if (!validSha256(trainingDatasetSha256)) reasons.push('training_dataset_provenance_missing');
  if (overlap.length) reasons.push('evaluation_training_seed_overlap');

  const safetyReady = reasons.length === 0;
  const levelPerformance = evaluatePerLevelReleaseQuality(report);
  if (!levelPerformance.ok) reasons.push('per_level_release_floor_not_met');
  let continuousMatch = options.continuousReport
    ? evaluateContinuousMatchReleaseQuality(
      options.continuousReport,
      expectedHash,
      evaluationSeedManifest,
      options.continuousReportSha256,
    )
    : {
      schema: VALUE_MODEL_RELEASE_QUALITY.continuousSchema,
      reasons: ['continuous_report_missing'],
      ok: false,
    };
  if (continuousMatch.ok
    && canonicalModelCandidate(continuousMatch.candidate) !== canonicalModelCandidate(config.candidate)) {
    continuousMatch = {
      ...continuousMatch,
      reasons: [...continuousMatch.reasons, 'continuous_candidate_mismatch'],
      ok: false,
    };
  }
  if (!continuousMatch.ok) {
    for (const reason of continuousMatch.reasons) reasons.push(`m3_${reason}`);
  }
  const releaseQualityReady = levelPerformance.ok && continuousMatch.ok;
  const stronger = safetyReady && releaseQualityReady && utilityLower != null && utilityLower > 0;
  if (safetyReady && releaseQualityReady && !stronger) {
    reasons.push('strength_lower_bound_not_positive');
  }
  const status = stronger
    ? VALUE_MODEL_STATUS.PROMOTED
    : safetyReady
      ? VALUE_MODEL_STATUS.VALIDATED
      : VALUE_MODEL_STATUS.EXPERIMENTAL;

  return {
    ok: safetyReady && releaseQualityReady,
    promoted: stronger,
    status,
    reasons,
    metrics: {
      mirrorPairs: pairs,
      minMirrorPairs,
      utilityCI: validUtilityCI ? utilityCI : null,
      utilityLower,
      fullLevelCoverage: completeLevelCoverage(config.evaluationLevels),
      failures,
      deadlocks,
      mirrorMismatches,
      gamesPlanned,
      gamesCompleted,
      baseDealBlocksPlanned: blocksPlanned,
      baseDealBlocksCompleted: blocksCompleted,
      evaluationDesign: String(config.evaluationDesign || '') || null,
      evaluationSeedCount: evaluationSeedManifest?.seeds.length || 0,
      trainingSeedCount: trainingSeedManifest?.seeds.length || 0,
      trainingDatasetSha256: validSha256(trainingDatasetSha256) ? trainingDatasetSha256 : null,
      overlappingSeeds: overlap,
      levelPerformance,
      continuousMatch,
    },
  };
}
