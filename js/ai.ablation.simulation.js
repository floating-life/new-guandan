/**
 * P0-P5 独立消融：每一臂都从同一个正式 expert 中只关闭被测模块。
 * 另加 expert vs p1-only 的 P2-P5 联合消融，检查新阶段整体交互；各结果
 * 不能机械相加。P5 是运行时置信融合，离线选型/留出集门禁见
 * ai.policy.calibration.js。
 *
 * 用法：
 *   node js/ai.ablation.simulation.js [每项种子组数=30] [基础种子=20260811]
 *
 * 每项沿用相同种子并交换双方座位；正的效用表示被恢复的模块对完整策略有利。
 * no-pX 保持其它 P 模块、残局搜索和 expert 统一策略权重不变。
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const groups = positiveInteger(process.argv[2], 30);
const baseSeed = finiteUint32(process.argv[3], 20260811);
const jsonOnly = process.argv.includes('--json');
const levelsFlag = process.argv.find((item) => String(item).startsWith('--levels=')) || '--levels=all';
const forwardedFlags = ['--level-blocks', '--continuous-match', '--trace-divergence']
  .filter((flag) => process.argv.includes(flag));
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(currentDir, 'ai.ab.simulation.js');
const ablations = [
  { module: 'P0', candidate: 'expert', comparison: 'no-p0' },
  { module: 'P1', candidate: 'expert', comparison: 'no-p1' },
  { module: 'P2', candidate: 'expert', comparison: 'no-p2' },
  { module: 'P3', candidate: 'expert', comparison: 'no-p3' },
  { module: 'P4', candidate: 'expert', comparison: 'no-p4' },
  { module: 'P5', candidate: 'expert', comparison: 'no-p5' },
  { module: 'P2-P5', candidate: 'expert', comparison: 'p1-only' },
];

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function finiteUint32(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed >>> 0 : fallback >>> 0;
}

function runAblation(item) {
  if (!jsonOnly) process.stderr.write(
    `[${item.module}] ${item.candidate} vs ${item.comparison}...\n`,
  );
  const child = spawnSync(process.execPath, [
    runner,
    String(groups),
    String(baseSeed),
    item.candidate,
    item.comparison,
    '--json',
    '--summary-only',
    levelsFlag,
    ...forwardedFlags,
  ], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30 * 60 * 1000,
  });
  if (child.error) throw child.error;
  if (child.status !== 0) {
    const detail = String(child.stderr || child.stdout || '').trim();
    throw new Error(`${item.module} 消融失败（exit ${child.status}）：${detail}`);
  }
  let report;
  try {
    report = JSON.parse(String(child.stdout || '').trim());
  } catch (error) {
    throw new Error(`${item.module} 消融输出不是有效 JSON：${error.message}`);
  }
  return {
    module: item.module,
    full: item.candidate,
    ablated: item.comparison,
    completion: report.completion,
    evaluationConfig: report.config,
    effect: {
      upgradeUtilityPerGame: report.result.candidateUpgradeUtilityPerGame,
      pairedUtilityPerSeed: report.result.candidatePairedUtilityPerSeed,
      pairedUtilityBootstrap95: report.result.candidatePairedUtilityBootstrap95,
      fullHeads: report.result.candidateHeads,
      ablatedHeads: report.result.comparisonHeads,
      fullHeadRate: report.result.candidateHeadRate,
      fullHeadWilson95: report.result.candidateHeadWilson95,
      fullHeadPairedBootstrap95: report.result.candidateHeadPairedBootstrap95,
      fullDoubleUps: report.result.candidateDoubleUps,
      ablatedDoubleUps: report.result.comparisonDoubleUps,
      doubleUpDifferencePerGame: report.result.candidateDoubleUpDifferencePerGame,
      doubleUpDifferencePairedBootstrap95:
        report.result.candidateDoubleUpDifferencePairedBootstrap95,
    },
    byLevel: report.byLevel,
    performance: report.performance,
  };
}

const results = [];
let error = null;
try {
  for (const item of ablations) results.push(runAblation(item));
} catch (caught) {
  error = caught instanceof Error ? caught.message : String(caught);
}

const allComplete = !error && results.length === ablations.length
  && results.every((item) => item.completion.failures === 0
    && item.completion.mirrorPairsCompleted === item.evaluationConfig.seedGroups
    && item.completion.baseDealBlocksCompleted === groups);
const output = {
  config: {
    seedGroupsPerAblation: groups,
    gamesPerAblation: results[0]?.evaluationConfig?.gamesPlanned || groups * 2,
    totalGamesPlanned: (results[0]?.evaluationConfig?.gamesPlanned || groups * 2)
      * ablations.length,
    baseSeed,
    evaluationLevels: levelsFlag.slice('--levels='.length),
    fullPolicy: 'expert（P0-P5）',
    ablatedPolicies: ablations.map((item) => item.comparison),
    deterministic: true,
    sameSeedsAcrossAblations: true,
    forwardedFlags,
  },
  interpretation: 'P0-P5 单项各只关闭对应模块；P2-P5 为新阶段联合消融。使用 --level-blocks 时，同一副基础牌会跨全部指定级牌复用，并按基础牌区组重采样；保持相同公开信息模型、expert权重、其它生产模块与残局搜索。正值表示完整侧更优；模块存在交互，单项与联合结果不可机械相加。',
  validity: {
    allComplete,
    independentFeatureGates: true,
    expertWeightsHeldConstant: true,
    otherPModulesHeldConstant: true,
    error,
  },
  ablations: results,
};

console.log(JSON.stringify(output, null, 2));
if (!allComplete) process.exitCode = 1;
