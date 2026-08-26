/** 训练统计口径与导入导出测试。 */
import {
  clearStats, recordRoundResult, loadStats, avgScore, unassistedAvgScore,
  exportTrainingData, importTrainingData, loadSettings, saveSettings,
  clearReplays, loadReplays, saveReplay,
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
  llmReport: {
    cloudEligibleTurns: 3,
    localTurns: 2,
    cloudCalls: 2,
    successes: 1,
    failures: 1,
    fallbacks: 1,
    skipped: 1,
    totalLatencyMs: 240,
    minLatencyMs: 90,
    maxLatencyMs: 150,
    promptTokens: 300,
    completionTokens: 60,
    totalTokens: 360,
    estimatedTokenCalls: 1,
    cloudAgreements: 1,
    cloudOverrides: 2,
    rejectedCloudChoices: 1,
    transientFailures: 1,
    modelOutputFailures: 1,
    permanentFailures: 0,
    backoffSkips: 3,
  },
});
const stats = loadStats();
assert(avgScore(stats) === 73, '综合均分包含全部已评价操作');
assert(unassistedAvgScore(stats) === 90, '无辅助均分排除辅助和被迫操作');
assert(stats.assistedEvalCount === 1 && stats.forcedEvalCount === 1, '辅助与被迫次数分别统计');
assert(stats.mistakeCounts.waste_wild === 1, '结构化失误标签进入累计统计');
assert(stats.difficulty.hard.rounds === 1 && stats.difficulty.hard.evalCount === 3, '统计按难度分桶');

console.log('大师难度设置与统计');
saveSettings({ ...loadSettings(), difficulty: 'master', localAiEngine: 'hybrid' });
assert(loadSettings().difficulty === 'master', '大师难度设置可持久化');
assert(loadSettings().localAiEngine === 'hybrid', '实验性混合决策引擎可由用户显式持久化');
saveSettings({ ...loadSettings(), localAiEngine: 'unknown-engine' });
assert(loadSettings().localAiEngine === 'expert', '未知本地决策引擎安全回退专家策略');
recordRoundResult({
  myPlace: 0,
  teamWon: true,
  difficulty: 'master',
  matchEnded: false,
  matchWon: false,
  evalHistory: [],
});
const masterStats = loadStats();
const llmStats = loadStats().llm;
assert(llmStats.cloudCalls === 2 && llmStats.successes === 1 && llmStats.fallbacks === 1,
  '浜戠璋冪敤鎴愬姛涓庡洖閫€璁板叆绱');
assert(llmStats.totalLatencyMs === 240 && llmStats.minLatencyMs === 90 && llmStats.maxLatencyMs === 150,
  '浜戠寤惰繜缁熻姝ｇ‘');
assert(llmStats.promptTokens === 300 && llmStats.completionTokens === 60 && llmStats.totalTokens === 360,
  'Token 使用量累计正确');
assert(llmStats.cloudAgreements === 1 && llmStats.cloudOverrides === 2
  && llmStats.rejectedCloudChoices === 1, '云端一致、改选和低置信拒绝均记入累计');
assert(llmStats.transientFailures === 1 && llmStats.modelOutputFailures === 1
  && llmStats.backoffSkips === 3, '临时、模型输出故障与断路退避统计正确');
assert(masterStats.difficulty.master.rounds === 1, '大师难度拥有独立对局统计分桶');
assert(masterStats.difficulty.master.evalCount === 0, '无评价操作不会虚增大师难度评价数');

console.log('数据导入导出');
const exported = exportTrainingData();
assert(exported.version === 2 && exported.stats.totalRounds === 2, '导出包含版本与统计');
assert(exported.stats.difficulty.master.rounds === 1, '导出保留大师难度统计');
const imported = importTrainingData(exported);
assert(imported.ok, '有效训练数据可重新导入');
assert(!importTrainingData({ nope: true }).ok, '拒绝无效训练数据');

console.log('导入时剥离 A/B 实验座位策略字段');
{
  const base = exportTrainingData();
  const dirtyPayload = {
    ...base,
    settings: {
      ...base.settings,
      difficulty: 'hard',
      aiPolicyBySeat: ['baseline', 'no-p0', 'expert', 'expert'],
      aiPolicyFeaturesBySeat: [{ p0: false }, {}, {}, {}],
      aiPolicyThresholdsBySeat: [null, { p0LeadGate: 0.9 }, null, null],
      aiDifficultyBySeat: ['master', 'easy', 'easy', 'easy'],
      aiDecisionEngineBySeat: ['hybrid', 'expert', 'expert', 'expert'],
    },
  };
  assert(importTrainingData(dirtyPayload).ok, '含实验座位策略字段的训练数据可导入');
  const settings = loadSettings();
  assert(settings.aiPolicyBySeat === undefined
    && settings.aiPolicyFeaturesBySeat === undefined
    && settings.aiPolicyThresholdsBySeat === undefined
    && settings.aiDifficultyBySeat === undefined
    && settings.aiDecisionEngineBySeat === undefined,
    'importTrainingData 后 loadSettings 不含策略、难度或引擎的座位实验字段');
  assert(settings.difficulty === 'hard', 'importTrainingData 仍合并合法设置字段');
}

console.log('完整复盘保留100副');
clearReplays();
for (let index = 0; index < 105; index++) saveReplay({ id: `replay-${index}` });
const savedReplays = loadReplays();
assert(savedReplays.length === 100, '连续保存105副后保留最近100副完整复盘');
assert(savedReplays[0]?.id === 'replay-104' && savedReplays[99]?.id === 'replay-5',
  '超过上限时仅淘汰最早复盘，顺序保持正确');

const importPayload = {
  ...exported,
  replays: Array.from({ length: 105 }, (_, index) => ({ id: `import-${index}` })),
};
assert(importTrainingData(importPayload).ok, '包含105副复盘的训练数据可导入');
const importedReplays = loadReplays();
assert(importedReplays.length === 100, '导入时同样保留最近100副完整复盘');
assert(importedReplays[0]?.id === 'import-0' && importedReplays[99]?.id === 'import-99',
  '导入复盘保持导出文件中的新旧顺序');

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
