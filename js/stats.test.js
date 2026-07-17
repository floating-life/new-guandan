/** 训练统计口径与导入导出测试。 */
import {
  clearStats, recordRoundResult, loadStats, avgScore, unassistedAvgScore,
  exportTrainingData, importTrainingData,
} from './stats.js';

let passed = 0;
let failed = 0;
function assert(condition, message) {
  if (condition) { passed++; console.log('  ✓', message); }
  else { failed++; console.error('  ✗', message); }
}

clearStats();

console.log('综合分与无辅助分分离');
recordRoundResult({
  myPlace: 0,
  teamWon: true,
  difficulty: 'hard',
  matchEnded: false,
  matchWon: false,
  evalHistory: [
    { score: 90, grade: '神来之笔', assisted: false, forced: false, mistakeTags: [] },
    { score: 50, grade: '一般', assisted: true, forced: false, mistakeTags: ['waste_wild'] },
    { score: 80, grade: '优秀', assisted: false, forced: true, mistakeTags: [] },
  ],
});
const stats = loadStats();
assert(avgScore(stats) === 73, '综合均分包含全部已评价操作');
assert(unassistedAvgScore(stats) === 90, '无辅助均分排除辅助和被迫操作');
assert(stats.assistedEvalCount === 1 && stats.forcedEvalCount === 1, '辅助与被迫次数分别统计');
assert(stats.mistakeCounts.waste_wild === 1, '结构化失误标签进入累计统计');
assert(stats.difficulty.hard.rounds === 1 && stats.difficulty.hard.evalCount === 3, '统计按难度分桶');

console.log('数据导入导出');
const exported = exportTrainingData();
assert(exported.version === 2 && exported.stats.totalRounds === 1, '导出包含版本与统计');
const imported = importTrainingData(exported);
assert(imported.ok, '有效训练数据可重新导入');
assert(!importTrainingData({ nope: true }).ok, '拒绝无效训练数据');

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
