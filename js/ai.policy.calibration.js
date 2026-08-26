/**
 * P5 离线策略校准与发布门禁。
 *
 * 用法：
 *   node js/ai.policy.calibration.js [训练基础牌区组=4] [验证基础牌区组=20]
 *     [基础种子=20260825] [--levels=all|2,3,...,A] [--json]
 *
 * 训练阶段只在固定的三个预注册幅度臂中选一个；验证阶段换用未见种子，
 * 与 p1-only（只保留 P0/P1）做同牌、换座、跨级比较。脚本只输出报告，
 * 不修改源码、配置或浏览器数据，避免把验证集结果反写成过拟合权重。
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const trainBlocks = positiveInteger(process.argv[2], 4);
const validationBlocks = positiveInteger(process.argv[3], 20);
const baseSeed = finiteUint32(process.argv[4], 20260825);
const jsonOnly = process.argv.includes('--json');
const levelsFlag = process.argv.find((item) => String(item).startsWith('--levels='))
  || '--levels=all';
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(currentDir, 'ai.ab.simulation.js');
const TRAINING_ARMS = Object.freeze(['expert', 'p5-soft', 'p5-wide']);
const REFERENCE = 'p1-only';
const VALIDATION_SEED_OFFSET = 1_000_003;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function finiteUint32(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed >>> 0 : fallback >>> 0;
}

function runAB(groups, seed, candidate, comparison) {
  if (!jsonOnly) process.stderr.write(
    `[P5] ${candidate} vs ${comparison} · ${groups}基础牌区组 · seed=${seed}\n`,
  );
  const child = spawnSync(process.execPath, [
    runner,
    String(groups),
    String(seed),
    candidate,
    comparison,
    '--json',
    '--summary-only',
    '--level-blocks',
    levelsFlag,
  ], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60 * 60 * 1000,
  });
  if (child.error) throw child.error;
  if (child.status !== 0) {
    throw new Error(`${candidate} A/B 失败（exit ${child.status}）：${String(
      child.stderr || child.stdout || '',
    ).trim()}`);
  }
  return JSON.parse(String(child.stdout || '').trim());
}

function summary(report) {
  return {
    completion: report.completion,
    config: report.config,
    utilityPerGame: report.result.candidateUpgradeUtilityPerGame,
    pairedUtilityPerSeed: report.result.candidatePairedUtilityPerSeed,
    pairedUtilityBootstrap95: report.result.candidatePairedUtilityBootstrap95,
    candidateHeads: report.result.candidateHeads,
    comparisonHeads: report.result.comparisonHeads,
    candidateHeadRate: report.result.candidateHeadRate,
    candidateDoubleUps: report.result.candidateDoubleUps,
    comparisonDoubleUps: report.result.comparisonDoubleUps,
    doubleUpDifferencePerGame: report.result.candidateDoubleUpDifferencePerGame,
    performance: report.performance,
  };
}

function selectionValue(report) {
  const result = report.result;
  return Number(result.candidatePairedUtilityPerSeed || 0)
    + Number(result.candidateDoubleUpDifferencePerGame || 0) * 0.35
    + (Number(result.candidateHeadRate || 0) - 0.5) * 0.2;
}

let output;
try {
  const training = TRAINING_ARMS.map((arm) => {
    const report = runAB(trainBlocks, baseSeed, arm, REFERENCE);
    return { arm, selectionValue: selectionValue(report), report, summary: summary(report) };
  }).sort((left, right) => right.selectionValue - left.selectionValue
    || left.arm.localeCompare(right.arm));
  const selected = training[0];
  const validationSeed = (baseSeed + VALIDATION_SEED_OFFSET) >>> 0;
  const validationReport = runAB(
    validationBlocks,
    validationSeed,
    selected.arm,
    REFERENCE,
  );
  const validation = summary(validationReport);
  const interval = validation.pairedUtilityBootstrap95 || [Number.NEGATIVE_INFINITY, 0];
  const complete = validation.completion?.failures === 0
    && validation.completion?.mirrorPairsCompleted === validation.config?.seedGroups;
  const evidenceGames = Number(validation.config?.gamesPlanned) || 0;
  // “建议发布”要求未见牌局的主效用不为负，且区间下界只容许极小的
  // Monte-Carlo 抖动；否则一律保持实验，不以训练集冠军冒充升级成功。
  const promote = complete
    && evidenceGames >= 500
    && Number(validation.utilityPerGame) >= 0
    && Number(interval[0]) >= -0.05;
  output = {
    config: {
      trainBlocks,
      validationBlocks,
      baseSeed,
      validationSeed,
      levels: levelsFlag.slice('--levels='.length),
      trainingArms: TRAINING_ARMS,
      reference: REFERENCE,
      deterministic: true,
      levelBlocks: true,
      mutatesPolicy: false,
    },
    training: training.map(({ arm, selectionValue: value, summary: item }) => ({
      arm,
      selectionValue: value,
      ...item,
    })),
    selectedArm: selected.arm,
    validation,
    promotion: {
      decision: promote ? 'promote' : 'hold',
      reason: promote
        ? '未见种子留出集完成，升级效用非负且配对区间通过预注册门槛。'
        : '未见种子证据不足或区间仍含明显负收益；保持实验，不自动改正式权重。',
      threshold: {
        utilityPerGameAtLeast: 0,
        pairedBootstrapLowerAtLeast: -0.05,
        validationGamesAtLeast: 500,
        zeroFailures: true,
      },
    },
    integrity: {
      publicInformationOnly: true,
      hiddenHandsSampled: false,
      trainingValidationSeedsDisjoint: true,
      reportOnlyNoSourceMutation: true,
    },
  };
} catch (error) {
  output = {
    error: error instanceof Error ? error.message : String(error),
    promotion: { decision: 'hold', reason: '校准流程未完整完成。' },
  };
  process.exitCode = 1;
}

console.log(JSON.stringify(output, null, 2));
