/** STRAT-6 预登记种子、重叠拒绝与分层汇总。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadStrat6Registry, validateStrat6Registry, summarizeStrat6Arm, decidePromotion,
  ablationCommand, STRAT6_REGISTRY_SCHEMA,
} from './strat6_ablation.mjs';

let passed = 0;
let failed = 0;
function assert(condition, message) {
  if (condition) {
    passed += 1;
    console.log('  ✓', message);
  } else {
    failed += 1;
    console.error('  ✗', message);
  }
}

const registry = loadStrat6Registry();
assert(registry.schema === STRAT6_REGISTRY_SCHEMA, '登记表 schema 固定');
assert(validateStrat6Registry(registry).length === 0, '当前登记表通过未见种子与规模校验');
assert(registry.formal.baseSeed === 20268111 && registry.formal.groupCount === 40,
  '正式臂预登记 20268111 起 40 区组');
assert(registry.smoke.baseSeed === 20268101 && registry.smoke.groupCount === 2,
  'smoke 使用独立 20268101–20268102');
assert(registry.formal.groupCount * 13 >= 500, '正式臂镜像对数达到 500 对硬门');
assert(registry.arms.map((arm) => arm.candidate).join(',')
  === 'with-reserved-high-control-lead,with-enemy-report-lead-safety,with-partner-trick-control',
  '三条规则各用独立候选变体对照 expert');

const overlapping = {
  ...registry,
  formal: { ...registry.formal, baseSeed: 20261001, groupCount: 40 },
};
assert(validateStrat6Registry(overlapping).some((error) => error.includes('重叠')),
  '与历史 root-pimc/ismcts 区组重叠时拒绝');

const tiny = { ...registry, formal: { ...registry.formal, groupCount: 20 } };
assert(validateStrat6Registry(tiny).some((error) => error.includes('500')),
  '少于 40 区组不能当作可晋级正式臂');

const command = ablationCommand(registry.arms[0], { ...registry.smoke, role: 'smoke' }, os.tmpdir());
assert(command.args.includes('--level-blocks') && command.args.includes('--levels=all')
  && command.args.includes('with-reserved-high-control-lead')
  && command.args.includes('expert'),
  '启动命令复用 A/B runner、全级牌区组和 expert 对照');

const passingReport = {
  config: { baseDealBlocks: 40, evaluationLevels: Array.from({ length: 13 }, (_, i) => i + 2), comparison: 'expert' },
  completion: {
    gamesCompleted: 1040, mirrorPairsCompleted: 520, baseDealBlocksCompleted: 40,
    failures: 0, deadlocks: 0, mirrorMismatches: 0,
  },
  result: {
    candidateUpgradeUtilityPerGame: 0.02,
    candidatePairedUtilityBootstrap95: [0.001, 0.04],
    candidateHeadRate: 0.51,
    candidateDoubleUps: 120,
    comparisonDoubleUps: 110,
  },
  games: [
    {
      ok: true, candidateTeam: 0, firstPlayer: 0, utility: 1,
      candidateHead: true, candidateDoubleUp: false, comparisonDoubleUp: false,
      tributeDoubleDown: false,
    },
    {
      ok: true, candidateTeam: 1, firstPlayer: 2, utility: -1,
      candidateHead: false, candidateDoubleUp: false, comparisonDoubleUp: true,
      tributeDoubleDown: true,
    },
  ],
};
const passSummary = summarizeStrat6Arm(passingReport, registry.arms[0]);
assert(passSummary.promote === true && passSummary.gates.utilityLowerBoundPositive,
  '完整正 CI、零失败且灾难不更差时允许讨论打开该规则');
assert(passSummary.strata.byFirstPlayerRole.self.games === 1
  && passSummary.strata.tributeStrataIdentified === false,
  '按先手角色分层；单副 A/B 不声称贡还层可识别');

const shapedReport = {
  ...passingReport,
  performance: {
    decisionLatencyByPolicy: {
      'with-reserved-high-control-lead': {
        searchTriggered: { decisionTurns: 12 },
      },
    },
    allAIDecisions: { searchTriggered: { decisionTurns: 12 } },
  },
};
assert(summarizeStrat6Arm(shapedReport, registry.arms[0]).searchTriggered === 12,
  'searchTriggered 读取正式报告 performance.decisionLatencyByPolicy[].searchTriggered.decisionTurns');

const failingReport = {
  ...passingReport,
  result: {
    ...passingReport.result,
    candidatePairedUtilityBootstrap95: [-0.01, 0.02],
    comparisonDoubleUps: 200,
  },
};
const failSummary = summarizeStrat6Arm(failingReport, registry.arms[1]);
assert(failSummary.promote === false && failSummary.keepClosed === true,
  'CI 下界跨 0 或双下变多时保持关闭');
assert(decidePromotion([passSummary, failSummary]).strat3.keepClosed === true
  && decidePromotion([passSummary, failSummary]).strat2.promote === true,
  '三条规则独立决定，不捆绑晋级');

const tmp = path.join(os.tmpdir(), `strat6-registry-${process.pid}.json`);
fs.writeFileSync(tmp, JSON.stringify({ ...registry, comparison: 'baseline' }));
try {
  loadStrat6Registry(tmp);
  assert(false, '对照不是 expert 的登记表必须拒绝');
} catch (error) {
  assert(String(error.message).includes('expert'), '对照不是 expert 的登记表必须拒绝');
}

console.log(`\nSTRAT-6 registry: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
