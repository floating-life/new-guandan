/**
 * P0/P1/P2 独立消融：完整 expert 分别对阵只关闭一个模块的 expert。
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
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(currentDir, 'ai.ab.simulation.js');
const ablations = [
  { module: 'P0', comparison: 'no-p0' },
  { module: 'P1', comparison: 'no-p1' },
  { module: 'P2', comparison: 'no-p2' },
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
  if (!jsonOnly) process.stderr.write(`[${item.module}] expert vs ${item.comparison}...\n`);
  const child = spawnSync(process.execPath, [
    runner,
    String(groups),
    String(baseSeed),
    'expert',
    item.comparison,
    '--json',
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
    full: 'expert',
    ablated: item.comparison,
    completion: report.completion,
    effect: {
      upgradeUtilityPerGame: report.result.candidateUpgradeUtilityPerGame,
      pairedUtilityPerSeed: report.result.candidatePairedUtilityPerSeed,
      pairedUtilityBootstrap95: report.result.candidatePairedUtilityBootstrap95,
      fullHeads: report.result.candidateHeads,
      ablatedHeads: report.result.comparisonHeads,
      fullHeadRate: report.result.candidateHeadRate,
      fullHeadWilson95: report.result.candidateHeadWilson95,
      fullDoubleUps: report.result.candidateDoubleUps,
      ablatedDoubleUps: report.result.comparisonDoubleUps,
    },
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
    && item.completion.mirrorPairsCompleted === groups);
const output = {
  config: {
    seedGroupsPerAblation: groups,
    gamesPerAblation: groups * 2,
    totalGamesPlanned: groups * 2 * ablations.length,
    baseSeed,
    fullPolicy: 'expert',
    ablatedPolicies: ablations.map((item) => item.comparison),
    deterministic: true,
    sameSeedsAcrossAblations: true,
  },
  interpretation: '每项只关闭对应 P 模块。no-p0 仅把 P0 的可接概率换为不含本局证据的静态先验；P1/P2 与共享威胁模型保持不变。效用 = expert 减 no-pX，正值表示该模块带来收益。模块可能交互，三项效用不可直接相加。',
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
