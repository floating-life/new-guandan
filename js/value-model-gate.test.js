import {
  VALUE_MODEL_STATUS, evaluateValueModelPromotion,
  createSeedManifest, evaluateContinuousMatchReleaseQuality, evaluatePerLevelReleaseQuality,
  hasPromotionReceipt, isPromotedValueModel, valueModelStatus,
} from './value-model-gate.js';
import { makePromotedValueModel } from './value-model.test-fixture.js';

let failed = 0;
let total = 0;
function assert(condition, message) {
  total += 1;
  if (condition) console.log('  ✓', message);
  else { failed += 1; console.error('  ✗', message); }
}

const evaluationSeeds = createSeedManifest(Array.from({ length: 40 }, (_, index) => 900000 + index));
const trainingSeeds = createSeedManifest(Array.from({ length: 40 }, (_, index) => 100000 + index));
const continuousSeeds = createSeedManifest(Array.from({ length: 4 }, (_, index) => 800000 + index));
const levelPerformance = {
  schema: 'guandan-per-level-release-quality-v1',
  expectedGamesPerLevel: 80,
  minimumUtilityPerGame: -0.1,
  minimumHeadRate: 0.45,
  levels: Array.from({ length: 13 }, (_, index) => ({
    level: index + 2, games: 80, utilityPerGame: 0.02, headRate: 0.5,
  })),
};
const continuousMatch = {
  schema: 'guandan-continuous-match-release-quality-v1',
  reportSha256: 'c'.repeat(64), modelSha256: 'a'.repeat(64),
  candidate: 'ismcts-v1', comparison: 'expert', continuousSeedManifest: continuousSeeds,
  matchesPlanned: 8, matchesCompleted: 8, mirrorPairs: 4,
  rounds: 24, tributeRounds: 8, longRoundActionThreshold: 120, longRounds: 4,
  failures: 0, deadlocks: 0, mirrorMismatches: 0,
};
const receipt = {
  candidate: 'ismcts-v1', comparison: 'expert',
  evaluationSeedManifest: evaluationSeeds,
  evaluationLevels: Array.from({ length: 13 }, (_, index) => index + 2),
  evaluationDesign: 'same-deal-cross-level-blocks',
  mirrorPairs: 520, gamesPlanned: 1040, gamesCompleted: 1040,
  baseDealBlocksPlanned: 40, baseDealBlocksCompleted: 40,
  failures: 0, deadlocks: 0, mirrorMismatches: 0,
  utilityCI: [0.01, 0.18], overlappingSeeds: [],
  levelPerformance,
  continuousMatch,
};
const promotedFixture = makePromotedValueModel({
  id: 'gate-fixture',
  schema: 'guandan-candidate-v1',
  layers: [{ weights: [new Array(32).fill(0)], bias: [0], activation: 'linear' }],
}, { trainingSeeds, evaluationSeeds, continuousSeeds });

function report(overrides = {}) {
  return {
    config: {
      candidate: 'ismcts-v1', comparison: 'expert',
      evaluationLevels: Array.from({ length: 13 }, (_, index) => index + 2),
      evaluationDesign: 'same-deal-cross-level-blocks',
      evaluationSeedManifest: evaluationSeeds,
      valueModel: {
        sha256: 'abc123', id: 'unit-model', trainingSeedManifest: trainingSeeds,
        trainingDatasetSha256: 'b'.repeat(64),
      },
      gamesPlanned: 1040, baseDealBlocks: 40, deterministic: true, difficulty: 'master',
      ...(overrides.config || {}),
    },
    completion: {
      gamesCompleted: 1040, mirrorPairsCompleted: 520, baseDealBlocksCompleted: 40,
      failures: 0, deadlocks: 0, mirrorMismatches: 0,
      ...(overrides.completion || {}),
    },
    result: {
      candidatePairedUtilityBootstrap95: [0.01, 0.18],
      ...(overrides.result || {}),
    },
    byLevel: Object.fromEntries(levelPerformance.levels.map((level) => [String(level.level), {
      games: level.games,
      candidateUtilityPerGame: level.utilityPerGame,
      candidateHeadRate: level.headRate,
    }])),
    ...(overrides.byLevel ? { byLevel: overrides.byLevel } : {}),
  };
}

function continuousReport(overrides = {}) {
  return {
    config: {
      seedGroups: 4, baseDealBlocks: 4, baseSeed: 800000,
      evaluationSeedManifest: continuousSeeds,
      gamesPlanned: 8, continuousMatch: true, outcomeUnit: 'match win (+1/-1)',
      candidate: 'ismcts-v1', comparison: 'expert', deterministic: true, difficulty: 'master',
      valueModel: {
        sha256: 'abc123', id: 'unit-model', trainingSeedManifest: trainingSeeds,
        trainingDatasetSha256: 'b'.repeat(64),
      },
      ...(overrides.config || {}),
    },
    completion: {
      gamesCompleted: 8, mirrorPairsCompleted: 4,
      failures: 0, deadlocks: 0, mirrorMismatches: 0,
      ...(overrides.completion || {}),
    },
    continuousMatch: {
      enabled: true, matches: 8, rounds: 24, tributeRounds: 8,
      longRoundActionThreshold: 120, longRounds: 4,
      ...(overrides.continuousMatch || {}),
    },
  };
}

function promotionOptions() {
  return {
    continuousReport: continuousReport(),
    continuousReportSha256: 'c'.repeat(64),
  };
}

console.log('价值模型发布状态');
assert(valueModelStatus({}) === VALUE_MODEL_STATUS.EXPERIMENTAL,
  '缺少状态的模型默认视为未验证，不会绕过门禁');
assert(!isPromotedValueModel({ metadata: { status: 'promoted' } }),
  '仅写入promoted状态的模型不能绕过发布回执门禁');
assert(hasPromotionReceipt(promotedFixture) && isPromotedValueModel(promotedFixture),
  '带模型哈希、完整A/B指标和种子清单的发布回执才可进入正式对局');
const tamperedFixture = structuredClone(promotedFixture);
tamperedFixture.layers[0].weights[0][0] = 1;
assert(!hasPromotionReceipt(tamperedFixture) && !isPromotedValueModel(tamperedFixture),
  '修改任一权重后，移植的发布回执不能继续加载');
const transplantedReceipt = makePromotedValueModel({
  id: 'different-weights',
  schema: 'guandan-candidate-v1',
  layers: [{ weights: [new Array(32).fill(1)], bias: [0], activation: 'linear' }],
});
transplantedReceipt.metadata = structuredClone(promotedFixture.metadata);
assert(!hasPromotionReceipt(transplantedReceipt),
  '另一模型不能复用已晋级模型的完整回执');

console.log('未见种子A/B晋级门禁');
{
  const levelQuality = evaluatePerLevelReleaseQuality(report());
  assert(levelQuality.ok && levelQuality.levels.length === 13,
    '完整跨级报告逐级满足发布最低表现线');
  const passed = evaluateValueModelPromotion(report(), 'abc123', promotionOptions());
  assert(passed.promoted && passed.status === VALUE_MODEL_STATUS.PROMOTED,
    '足量全级牌镜像赛、M3覆盖完整且收益置信下界为正时晋级');
  const rootPimc = evaluateValueModelPromotion(report({
    config: { candidate: 'root-pimc-v1' },
  }), 'abc123', {
    continuousReport: continuousReport({ config: { candidate: 'root-pimc-v1' } }),
    continuousReportSha256: 'c'.repeat(64),
  });
  assert(rootPimc.promoted && rootPimc.status === VALUE_MODEL_STATUS.PROMOTED,
    '成对根 PIMC 可作为新模型的正式评测与连续赛候选');
  const mismatchedContinuousCandidate = evaluateValueModelPromotion(report({
    config: { candidate: 'root-pimc-v1' },
  }), 'abc123', {
    continuousReport: continuousReport({ config: { candidate: 'hybrid-v1' } }),
    continuousReportSha256: 'c'.repeat(64),
  });
  assert(!mismatchedContinuousCandidate.promoted
    && mismatchedContinuousCandidate.reasons.includes('m3_continuous_candidate_mismatch'),
  '连续赛必须对应同一候选策略，历史 ismcts 别名按成对根 PIMC 等价处理');
  const weak = evaluateValueModelPromotion(report({
    result: { candidatePairedUtilityBootstrap95: [-0.02, 0.11] },
  }), 'abc123', promotionOptions());
  assert(weak.ok && !weak.promoted && weak.status === VALUE_MODEL_STATUS.VALIDATED,
    '安全验证通过但强度下界不为正时只标记validated');
  const small = evaluateValueModelPromotion(report({
    completion: { mirrorPairsCompleted: 30 },
  }), 'abc123', promotionOptions());
  assert(!small.ok && small.status === VALUE_MODEL_STATUS.EXPERIMENTAL
    && small.reasons.includes('insufficient_mirror_pairs'),
  '小样本烟雾赛不能晋级模型');
  const wrongHash = evaluateValueModelPromotion(report(), 'different', promotionOptions());
  assert(!wrongHash.ok && wrongHash.reasons.includes('model_hash_mismatch'),
    '报告必须绑定当前模型哈希');
  const partialLevels = evaluateValueModelPromotion(report({
    config: { evaluationLevels: [2, 3, 4] },
  }), 'abc123', promotionOptions());
  assert(!partialLevels.ok && partialLevels.reasons.includes('incomplete_level_coverage'),
    '缺少级牌覆盖时不能晋级');
  const incomplete = evaluateValueModelPromotion(report({
    completion: { gamesCompleted: 998, baseDealBlocksCompleted: 39 },
  }), 'abc123', promotionOptions());
  assert(!incomplete.ok && incomplete.reasons.includes('incomplete_planned_games')
    && incomplete.reasons.includes('incomplete_base_deal_blocks'),
  '报告必须完整跑完计划局数和基础牌区组');
  const malformedCI = evaluateValueModelPromotion(report({
    result: { candidatePairedUtilityBootstrap95: [0.2] },
  }), 'abc123', promotionOptions());
  assert(malformedCI.ok && !malformedCI.promoted
    && malformedCI.status === VALUE_MODEL_STATUS.VALIDATED,
  '缺损置信区间不能凭单个正数误晋级');
  const cycling = evaluateValueModelPromotion(report({
    config: { evaluationDesign: 'legacy-level-cycle' },
  }), 'abc123', promotionOptions());
  assert(!cycling.ok && cycling.reasons.includes('evaluation_design_not_same_deal_blocks'),
    '轮换级牌设计不能晋级，必须是同一副牌跨13级区组');
  const aliasedBlocks = evaluateValueModelPromotion(report({
    config: { gamesPlanned: 1000, baseDealBlocks: 500 },
    completion: {
      gamesCompleted: 1000, mirrorPairsCompleted: 500, baseDealBlocksCompleted: 500,
    },
  }), 'abc123', promotionOptions());
  assert(!aliasedBlocks.ok && aliasedBlocks.reasons.includes('base_deal_blocks_not_cross_level'),
    '基础牌区组不能用一对一镜像冒充跨级复评');
  const overlap = evaluateValueModelPromotion(report({
    config: {
      valueModel: {
        sha256: 'abc123', id: 'unit-model', trainingSeedManifest: evaluationSeeds,
        trainingDatasetSha256: 'b'.repeat(64),
      },
    },
  }), 'abc123', promotionOptions());
  assert(!overlap.ok && overlap.reasons.includes('evaluation_training_seed_overlap'),
    '训练与评估种子重叠时不能把结果当作未见种子证据');
  const missing = evaluateValueModelPromotion(report({
    config: { evaluationSeedManifest: null },
  }), 'abc123', promotionOptions());
  assert(!missing.ok && missing.reasons.includes('evaluation_seed_provenance_missing'),
    '缺少显式评估种子清单时不能晋级');
  const missingDatasetHash = evaluateValueModelPromotion(report({
    config: {
      valueModel: { sha256: 'abc123', id: 'unit-model', trainingSeedManifest: trainingSeeds },
    },
  }), 'abc123', promotionOptions());
  assert(!missingDatasetHash.ok && missingDatasetHash.reasons.includes('training_dataset_provenance_missing'),
    '缺少训练数据哈希时不能晋级');

  const missingM3 = evaluateValueModelPromotion(report(), 'abc123');
  assert(!missingM3.promoted && missingM3.status === VALUE_MODEL_STATUS.VALIDATED
    && missingM3.reasons.includes('m3_continuous_report_missing'),
  '未提交连续对局证据时最多停在validated');
  const badLevelReport = report({
    byLevel: {
      ...Object.fromEntries(levelPerformance.levels.map((level) => [String(level.level), {
        games: level.games,
        candidateUtilityPerGame: level.utilityPerGame,
        candidateHeadRate: level.headRate,
      }])),
      5: { games: 80, candidateUtilityPerGame: -0.125, candidateHeadRate: 0.5 },
    },
  });
  const badLevel = evaluateValueModelPromotion(badLevelReport, 'abc123', promotionOptions());
  assert(!badLevel.promoted && badLevel.status === VALUE_MODEL_STATUS.VALIDATED
    && badLevel.reasons.includes('per_level_release_floor_not_met'),
  '任一级牌跌破最低效用线时不能晋级');
  const missingTribute = evaluateContinuousMatchReleaseQuality(
    continuousReport({ continuousMatch: { tributeRounds: 0 } }),
    'abc123', evaluationSeeds, 'c'.repeat(64),
  );
  assert(!missingTribute.ok && missingTribute.reasons.includes('continuous_tribute_coverage_insufficient'),
    '连续赛未覆盖贡还时不能作为发布证据');
  const missingLongRound = evaluateContinuousMatchReleaseQuality(
    continuousReport({ continuousMatch: { longRounds: 0 } }),
    'abc123', evaluationSeeds, 'c'.repeat(64),
  );
  assert(!missingLongRound.ok && missingLongRound.reasons.includes('continuous_long_round_coverage_insufficient'),
    '连续赛未覆盖长局时不能作为发布证据');
}

console.log(`\n结果: ${total - failed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
