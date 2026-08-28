import { modelPayloadSha256 } from './model-fingerprint.js';

export function makeSeedManifest(start, count = 40) {
  return {
    schema: 'guandan-seed-manifest-v1',
    seeds: Array.from({ length: count }, (_, index) => start + index),
  };
}

/** Build a complete, internally consistent promoted model fixture from actual weights. */
export function makePromotedValueModel(model, options = {}) {
  const trainingSeeds = options.trainingSeeds || makeSeedManifest(100000);
  const evaluationSeeds = options.evaluationSeeds || makeSeedManifest(200000);
  const continuousSeeds = options.continuousSeeds || makeSeedManifest(300000, 4);
  const modelSha256 = modelPayloadSha256(model);
  if (!modelSha256) throw new Error('测试模型无法生成权重摘要');
  const levelPerformance = {
    schema: 'guandan-per-level-release-quality-v1',
    expectedGamesPerLevel: 80,
    minimumUtilityPerGame: -0.1,
    minimumHeadRate: 0.45,
    levels: Array.from({ length: 13 }, (_, index) => ({
      level: index + 2, games: 80, utilityPerGame: 0.02, headRate: 0.5,
    })),
  };
  return {
    ...model,
    metadata: {
      ...(model.metadata || {}),
      status: 'promoted',
      modelSha256,
      trainingData: {
        ...(model.metadata?.trainingData || {}),
        sha256: 'b'.repeat(64),
        seedManifest: trainingSeeds,
      },
      trainingSeedManifest: trainingSeeds,
      validation: {
        primaryReportSha256: 'd'.repeat(64),
        candidate: 'ismcts-v1',
        comparison: 'expert',
        evaluationSeedManifest: evaluationSeeds,
        evaluationLevels: Array.from({ length: 13 }, (_, index) => index + 2),
        evaluationDesign: 'same-deal-cross-level-blocks',
        mirrorPairs: 520,
        gamesPlanned: 1040,
        gamesCompleted: 1040,
        baseDealBlocksPlanned: 40,
        baseDealBlocksCompleted: 40,
        failures: 0,
        deadlocks: 0,
        mirrorMismatches: 0,
        utilityCI: [0.01, 0.1],
        levelPerformance,
        continuousMatch: {
          schema: 'guandan-continuous-match-release-quality-v1',
          reportSha256: 'c'.repeat(64),
          modelSha256,
          candidate: 'ismcts-v1',
          comparison: 'expert',
          continuousSeedManifest: continuousSeeds,
          matchesPlanned: 8,
          matchesCompleted: 8,
          mirrorPairs: 4,
          rounds: 24,
          tributeRounds: 8,
          longRoundActionThreshold: 120,
          longRounds: 4,
          failures: 0,
          deadlocks: 0,
          mirrorMismatches: 0,
        },
      },
    },
  };
}
