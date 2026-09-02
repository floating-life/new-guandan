/** STRAT-6 只汇总驱动：读既有报告 + checkpoint（含逐局分层），不重跑评测。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadStrat6Registry } from './strat6_ablation.mjs';
import { summarizeStrat6Artifacts } from './strat6_summarize.mjs';

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

function writeArmFixtures(reportDir, arm, { ci, comparisonDoubleUps, candidateDoubleUps }) {
  const report = {
    config: {
      baseDealBlocks: 40,
      evaluationLevels: Array.from({ length: 13 }, (_, i) => i + 2),
      comparison: 'expert',
      candidate: arm.candidate,
    },
    completion: {
      gamesCompleted: 1040,
      mirrorPairsCompleted: 520,
      baseDealBlocksCompleted: 40,
      failures: 0,
      deadlocks: 0,
      mirrorMismatches: 0,
    },
    result: {
      candidateUpgradeUtilityPerGame: 0.02,
      candidatePairedUtilityBootstrap95: ci,
      candidateHeadRate: 0.51,
      candidateDoubleUps,
      comparisonDoubleUps,
    },
    performance: {
      decisionLatencyByPolicy: {
        [arm.candidate]: { searchTriggered: { decisionTurns: 0 } },
      },
      allAIDecisions: { searchTriggered: { decisionTurns: 0 } },
    },
  };
  const checkpoint = {
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
      {
        ok: true, candidateTeam: 0, firstPlayer: 2, utility: 0,
        candidateHead: false, candidateDoubleUp: false, comparisonDoubleUp: false,
      },
    ],
  };
  const reportPath = path.join(reportDir, `eval-strat6-formal-${arm.id}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report));
  fs.writeFileSync(reportPath.replace(/\.json$/, '.checkpoint.json'), JSON.stringify(checkpoint));
}

const registry = loadStrat6Registry();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'strat6-summarize-'));
for (const arm of registry.arms) {
  if (arm.id === 'strat2') {
    writeArmFixtures(tmp, arm, { ci: [0.001, 0.04], comparisonDoubleUps: 110, candidateDoubleUps: 120 });
  } else if (arm.id === 'strat3') {
    writeArmFixtures(tmp, arm, { ci: [-0.01, 0.02], comparisonDoubleUps: 200, candidateDoubleUps: 120 });
  } else {
    writeArmFixtures(tmp, arm, { ci: [0, 0], comparisonDoubleUps: 120, candidateDoubleUps: 120 });
  }
}

const summary = summarizeStrat6Artifacts(registry, 'formal', tmp);
assert(summary.schema === 'guandan-strat6-ablation-summary-v1', '汇总 schema 固定');
assert(summary.role === 'formal' && summary.baseSeed === 20268111 && summary.groupCount === 40,
  '汇总绑定正式角色与预登记种子区间');
assert(summary.promotion.strat2.promote === true
  && summary.promotion.strat3.keepClosed === true
  && summary.promotion.strat4.keepClosed === true,
  '三条规则独立判定，不捆绑晋级');
assert(summary.summaries[0].searchTriggered === 0,
  'searchTriggered 从真实 performance.decisionLatencyByPolicy 路径读取');
assert(summary.summaries[0].strata.byCandidateTeam['0'].games === 2
  && summary.summaries[0].strata.byFirstPlayerRole.self.games === 1
  && summary.summaries[0].strata.byFirstPlayerRole.partner.games === 1
  && summary.summaries[0].strata.byFirstPlayerRole.lower.games === 1,
  '队伍/先手角色分层来自 checkpoint 逐局对象');
assert(summary.summaries[0].strata.byTributeDoubleDown.yes.games === 1
  && summary.summaries[0].strata.byTributeDoubleDown.no.games === 1
  && summary.summaries[0].strata.byTributeDoubleDown.unknown.games === 1
  && summary.summaries[0].strata.tributeStrataIdentified === false,
  '贡还层字段缺失时归入 unknown，不声称可识别');

const missingReportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strat6-summarize-empty-'));
let threwMissing = false;
try {
  summarizeStrat6Artifacts(registry, 'formal', missingReportDir);
} catch (error) {
  threwMissing = String(error.message).includes('缺少');
}
assert(threwMissing, '缺少任一臂报告时拒绝汇总');

const noCheckpointDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strat6-summarize-nock-'));
for (const arm of registry.arms) {
  const reportPath = path.join(noCheckpointDir, `eval-strat6-formal-${arm.id}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({ completion: {}, result: {} }));
}
let threwNoCheckpoint = false;
try {
  summarizeStrat6Artifacts(registry, 'formal', noCheckpointDir);
} catch (error) {
  threwNoCheckpoint = String(error.message).includes('checkpoint');
}
assert(threwNoCheckpoint, '缺少 checkpoint（分层无数据源）时拒绝汇总');

fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(missingReportDir, { recursive: true, force: true });
fs.rmSync(noCheckpointDir, { recursive: true, force: true });

console.log(`\nSTRAT-6 summarize: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
