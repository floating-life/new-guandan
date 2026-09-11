/**
 * LEARN-002 离线模型路径的定向验收：候选 API、座位调用、回退计数，
 * 以及通过 spawn 包装既有 A/B runner 的跨级双腿 smoke。不得停在 helper-only。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCard } from '../js/cards.js';
import { generateLegalPlays, parseHand } from '../js/rules.js';
import { chooseAIPlay, resolvePolicyVariant } from '../js/ai.js';
import { createPublicAIObservation } from '../js/ai-observation.js';
import { extractHybridValueFeatures } from '../js/ai-hybrid.js';
import { createMatch, aiDecisionContext, PHASE } from '../js/game.js';
import {
  LEARNING_CANDIDATE_LIMIT,
  LEARNING_DECISION_ENGINE,
  buildLearningCandidates,
  chooseLearningPlay,
  configureOfflineLearningModel,
} from '../js/ai-learning.js';
import {
  parseArenaArgs,
  runLocalLearningArena,
} from './local_learning_arena.mjs';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(toolsDir, '..');
const arenaCli = path.join(toolsDir, 'local_learning_arena.mjs');
const SMOKE_TIMEOUT_MS = 90000;

const card = (rank, suit, deckIndex = 0) => createCard(rank, suit, deckIndex);

function makeLinearModel(id, weightAt = {}) {
  return {
    schema: 'guandan-candidate-v1',
    id,
    layers: [{
      weights: [Array.from({ length: 32 }, (_, index) => Number(weightAt[index]) || 0)],
      bias: [0],
      activation: 'linear',
    }],
  };
}

function playIds(decision) {
  return (decision?.cards || []).map((item) => String(item.id)).sort();
}

function legalKeys(hand, level, lastHand) {
  const keys = new Set(
    generateLegalPlays(hand, level, lastHand).map((play) => (
      `${play.cards.map((item) => String(item.id)).sort().join(',')}|${play.signature}`
    )),
  );
  if (lastHand) keys.add('pass');
  return keys;
}

function decisionKey(decision) {
  if (!decision || decision.action === 'pass') return 'pass';
  return `${playIds(decision).join(',')}|${decision.signature || ''}`;
}

const context = {
  seat: 0,
  hand: [card(3, 'S'), card(7, 'H'), card(10, 'D')],
  level: 2,
  lastHand: parseHand([card(6, 'C', 1)], 2),
  lastSeat: 1,
  handCounts: [3, 5, 5, 5],
  teams: [0, 1, 0, 1],
  finishOrder: [],
  publicHistory: [],
  deterministic: true,
  difficulty: 'master',
  timeBudgetMs: 0,
};
const expertDecision = {
  action: 'play',
  cards: [context.hand[2]],
  hand: parseHand([context.hand[2]], 2),
  signature: 'single:10',
};
const changeModel = makeLinearModel('learning-unit-fixture', { 3: -1, 6: -100 });
const highPowerModel = makeLinearModel('learning-high-power-fixture', { 3: 8, 6: -100 });

const candidates = buildLearningCandidates(context, expertDecision);
assert(candidates.length >= 2, '离线路径保留多个合法候选供模型排序');

// Context features must not alter the base pool or silently change old models.
const richContext = { ...context, decisionEngine: 'learned-context-v1' };
const richCandidates = buildLearningCandidates(richContext, expertDecision);
assert.deepEqual(richCandidates.map(decisionKey), candidates.map(decisionKey));
assert(richCandidates.every(c => Number.isFinite(c.projectedTricks)), 'remaining-hand route features must be populated');
assert(richCandidates.some(c => c.action === 'play' && c.localScore !== 0), 'public strategic scores cannot remain all zero');
const featureSet = ctx => buildLearningCandidates(ctx, expertDecision)
  .map(c => JSON.stringify(Array.from(extractHybridValueFeatures(ctx, c)))).sort();
assert.notDeepEqual(featureSet({ ...richContext, lastSeat: 2 }), featureSet({ ...richContext, lastSeat: 1 }),
  'context encoder must distinguish partner control from enemy control');
assert.deepEqual(featureSet({ ...context, lastSeat: 2 }), featureSet({ ...context, lastSeat: 1 }),
  'base encoder remains unchanged');
configureOfflineLearningModel(changeModel);
assert.equal(chooseLearningPlay(richContext, expertDecision).fallbackReason, 'feature_engine_mismatch');
configureOfflineLearningModel({ ...changeModel, metadata: { featureEngine: 'learned-context-v1' } });
assert.equal(chooseLearningPlay(richContext, expertDecision).fallback, false);
assert.equal(resolvePolicyVariant('learned-context-v1').decisionEngine, 'learned-context-v1');
assert.equal(createPublicAIObservation(richContext).decisionEngine, 'learned-context-v1');
assert(chooseAIPlay(richContext).modelCalls > 0, 'context engine must reach model inference through the actual AI route');
assert.equal(chooseLearningPlay(context, expertDecision).fallbackReason, 'feature_engine_mismatch');
configureOfflineLearningModel(null);
assert(candidates.length <= LEARNING_CANDIDATE_LIMIT, '候选上限与标签接口共用 8 个');
assert(candidates.some((item) => item.action === 'pass'), '跟牌时候选集保留过牌');

configureOfflineLearningModel(changeModel);
const learned = chooseLearningPlay(context, expertDecision);
assert.equal(learned.action, 'play', '非恒定固定模型从合法候选中选择出牌');
assert.notEqual(learned.cards[0].id, expertDecision.cards[0].id,
  '非恒定固定模型可以改变 expert 的选择');
assert(learned.modelCalls >= 2, '一次决策评估每个受限合法候选');
assert.equal(learned.changed, true, '改选显式记录 changed 元数据');
assert.equal(learned.fallback, false, '有效模型不回退 expert');
assert(legalKeys(context.hand, context.level, context.lastHand).has(decisionKey(learned)),
  '模型选出的动作必须合法');

configureOfflineLearningModel({ broken: true });
const fallback = chooseLearningPlay(context, expertDecision);
assert.deepEqual(fallback.cards.map((item) => item.id), expertDecision.cards.map((item) => item.id),
  '损坏模型严格回退 expert 决策');
assert.equal(fallback.fallback, true, '损坏模型回退必须被明确计数');
assert.equal(fallback.changed, false, '回退不得记为改选');
assert.equal(fallback.modelCalls, 0, '损坏模型在配置失败后不得继续计调用');

configureOfflineLearningModel(null);
const unconfigured = chooseLearningPlay(context, expertDecision);
assert.equal(unconfigured.fallback, true, '未配置模型回退 expert');
assert.equal(unconfigured.modelCalls, 0, '未配置模型不得计调用');

const overflowModel = makeLinearModel('learning-overflow-fixture');
overflowModel.layers[0].weights[0] = Array.from({ length: 32 }, () => Number.MAX_VALUE);
overflowModel.layers[0].bias = [Number.MAX_VALUE];
const overflowConfigured = configureOfflineLearningModel(overflowModel);
assert.equal(overflowConfigured.ok, true, '有限巨大权重仍可通过模型校验');
const overflow = chooseLearningPlay(context, expertDecision);
assert.equal(overflow.fallback, true, '预测溢出必须回退 expert');
assert.equal(overflow.fallbackReason, 'model_evaluation_invalid', '预测溢出记为 evaluation invalid');
assert(overflow.modelCalls >= 1, '有限巨大权重预测失败必须保留实际尝试次数');
assert.notEqual(overflow.modelCalls, 0, '预测失败不得把已发生的 modelCalls 清零');
configureOfflineLearningModel(null);
console.log('local learning helper contract: OK');

{
  const variant = resolvePolicyVariant('learned-value-v1');
  assert.equal(variant.decisionEngine, LEARNING_DECISION_ENGINE,
    'variant resolver 暴露 learned-value-v1 实验引擎');
  assert.equal(variant.policyProfile, 'expert', '学习臂仍使用 expert 特征，不改默认策略权重');
  assert.equal(resolvePolicyVariant('expert').decisionEngine, 'expert',
    '默认 expert 变体不是学习臂');
  const observed = createPublicAIObservation({
    ...context,
    decisionEngine: LEARNING_DECISION_ENGINE,
  });
  assert.equal(observed.decisionEngine, LEARNING_DECISION_ENGINE,
    '公开观察白名单保留 learned-value-v1');
  const unknown = createPublicAIObservation({
    ...context,
    decisionEngine: 'learned-value-typo',
  });
  assert.equal(unknown.decisionEngine, 'expert', '未知引擎不得伪装成学习臂');
  const productHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert(!productHtml.includes('learned-value-v1'), '产品选择器不暴露 learned-value-v1');
}

{
  configureOfflineLearningModel(changeModel);
  try {
    const expertOff = chooseAIPlay({
      ...context,
      decisionEngine: 'expert',
      deterministic: true,
      difficulty: 'master',
      timeBudgetMs: 0,
    });
    configureOfflineLearningModel(highPowerModel);
    const learnedPlay = chooseAIPlay({
      ...context,
      decisionEngine: LEARNING_DECISION_ENGINE,
      deterministic: true,
      difficulty: 'master',
      timeBudgetMs: 0,
    });
    assert.equal(learnedPlay.action, 'play', '关闭搜索时学习路径仍能选牌');
    assert.equal(learnedPlay.hybrid, undefined, '学习路径不走混合搜索');
    assert(learnedPlay.modelCalls >= 2, 'chooseAIPlay 学习臂实际调用模型');
    assert.notDeepEqual(playIds(learnedPlay), playIds(expertOff),
      '非恒定夹具经 chooseAIPlay 可改选');
    configureOfflineLearningModel(changeModel);
    const lowPowerPlay = chooseAIPlay({
      ...context,
      decisionEngine: LEARNING_DECISION_ENGINE,
      deterministic: true,
      difficulty: 'master',
      timeBudgetMs: 0,
    });
    assert.notDeepEqual(playIds(lowPowerPlay), playIds(learnedPlay),
      '不同非恒定夹具产生不同选择');
    assert.equal(expertOff.fallback, undefined, 'expert 控制侧不读取全局学习模型');
    assert.equal(expertOff.modelCalls, undefined, 'expert 决策不计入模型调用');

    configureOfflineLearningModel(null);
    const expertCleared = chooseAIPlay({
      ...context,
      decisionEngine: 'expert',
      deterministic: true,
      difficulty: 'master',
    });
    configureOfflineLearningModel(changeModel);
    const expertWithModel = chooseAIPlay({
      ...context,
      decisionEngine: 'expert',
      deterministic: true,
      difficulty: 'master',
    });
    assert.deepEqual(playIds(expertWithModel), playIds(expertCleared),
      '全局学习模型不得改变 expert 控制侧出牌');
  } finally {
    configureOfflineLearningModel(null);
  }
}

{
  const state = createMatch({
    difficulty: 'master',
    aiSpeed: 'fast',
    coachMode: false,
    deterministicAI: true,
    sealedTraining: false,
    opponentModelMode: 'off',
    aiDifficultyBySeat: ['master', 'master', 'master', 'master'],
    aiPolicyBySeat: ['expert', 'expert', 'expert', 'expert'],
    aiDecisionEngineBySeat: [
      LEARNING_DECISION_ENGINE,
      LEARNING_DECISION_ENGINE,
      'expert',
      'expert',
    ],
  });
  const last = card(6, 'C', 1);
  state.phase = PHASE.PLAYING;
  state.currentLevel = 2;
  state.hands = [
    [card(3, 'S'), card(7, 'H'), card(10, 'D')],
    [card(4, 'S'), card(8, 'H'), card(9, 'D')],
    [card(5, 'S'), card(5, 'H'), card(5, 'D')],
    [card(11, 'S'), card(12, 'H'), card(13, 'D')],
  ];
  state.handCounts = state.hands.map((hand) => hand.length);
  state.lastHand = parseHand([last], 2);
  state.lastSeat = 3;
  state.trickLog = [];
  state.finishOrder = [];

  configureOfflineLearningModel(changeModel);
  try {
    const seatZeroCtx = aiDecisionContext(state, 0);
    const seatOneCtx = aiDecisionContext(state, 1);
    const expertSeatCtx = aiDecisionContext(state, 2);
    assert.equal(seatZeroCtx.decisionEngine, LEARNING_DECISION_ENGINE,
      '0 号同步路径的公开观察保留学习引擎');
    assert.equal(seatOneCtx.decisionEngine, LEARNING_DECISION_ENGINE,
      '电脑座位的公开观察保留学习引擎');
    assert.equal(expertSeatCtx.decisionEngine, 'expert',
      '对照座位仍是 expert，不受候选引擎污染');

    const seatZeroPlay = chooseAIPlay({ ...seatZeroCtx, deterministic: true, timeBudgetMs: 0 });
    const seatOnePlay = chooseAIPlay({ ...seatOneCtx, deterministic: true, timeBudgetMs: 0 });
    const expertSeatPlay = chooseAIPlay({ ...expertSeatCtx, deterministic: true, timeBudgetMs: 0 });
    assert(seatZeroPlay.modelCalls >= 2, '0 号同步路径经 game.aiDecisionContext 实际调用模型');
    assert(seatOnePlay.modelCalls >= 2, '电脑座位经 game.aiDecisionContext 实际调用模型');
    assert.equal(seatZeroPlay.fallback, false, '有效模型下 0 号路径不回退');
    assert.equal(seatOnePlay.fallback, false, '有效模型下电脑座位不回退');
    assert.equal(expertSeatPlay.modelCalls, undefined, '对照座位不消费全局学习模型');
    assert(legalKeys(state.hands[0], 2, state.lastHand).has(decisionKey(seatZeroPlay)),
      '0 号学习动作合法');
    assert(legalKeys(state.hands[1], 2, state.lastHand).has(decisionKey(seatOnePlay)),
      '电脑座位学习动作合法');
  } finally {
    configureOfflineLearningModel(null);
  }
}

{
  const arenaSource = fs.readFileSync(arenaCli, 'utf8');
  assert.match(arenaSource, /spawn\(|spawnSync\(/, 'arena 必须 spawn 既有 A/B CLI');
  assert.doesNotMatch(arenaSource, /(?:import\s*\(|from)\s*['"][^'"]*ai\.ab\.simulation\.js['"]/,
    'arena 不得直接 import 会自动开赛的 A/B 脚本');
}

function assertThrowsParse(argv, pattern, message) {
  assert.throws(() => parseArenaArgs(argv), pattern, message);
}

{
  assertThrowsParse(['--blocks=0'], /正整数|blocks/i, '--blocks=0 必须拒绝，不得静默变成 1');
  assertThrowsParse(['--blocks=bad'], /正整数|blocks/i, '--blocks=bad 必须拒绝，不得静默变成 1');
  assertThrowsParse(['--blocks=-1'], /正整数|blocks/i, '--blocks=-1 必须拒绝，不得交给 runner 替换成 30');
  assertThrowsParse(['--base-seed=4294967296'], /uint32|seed/i, '--base-seed=4294967296 必须拒绝，不得回绕成 0');
  assertThrowsParse(['--base-seed=0'], /uint32|seed/i, '--base-seed=0 必须拒绝');
  assertThrowsParse(['--base-seed=4294967295', '--blocks=2'], /回绕|uint32/i,
    '种子区组整体不得跨过 uint32 上界');
  assertThrowsParse(['--levels=2,foo'], /级牌|levels/i, '畸形级牌必须拒绝，不得静默丢掉无效项');
  assertThrowsParse(['--levels='], /级牌|levels/i, '空级牌必须拒绝');
  assertThrowsParse(['--unknown'], /未知/i, '未知旗标必须拒绝');
  assertThrowsParse(['--json=true'], /未知|布尔/i, '布尔旗标不得带值后静默忽略');
  const valid = parseArenaArgs(['--blocks=1', '--base-seed=3400000000', '--levels=2,3']);
  assert.equal(valid.blocks, 1, '合法正整数 blocks 原样保留');
  assert.equal(valid.baseSeed, 3400000000, '合法非零 uint32 seed 原样保留');
  parseArenaArgs(['--base-seed=4294967295', '--blocks=1']);
}

{
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'guandan-learn-002-fix1-'));
  const modelPath = path.join(temporary, 'synthetic-linear.json');
  const reportPath = path.join(temporary, 'arena-report.json');
  const checkpointPath = path.join(temporary, 'arena.checkpoint.json');
  const sentinel = Buffer.from('LEARN-002-FIX1-ORIGINAL\n', 'utf8');
  fs.writeFileSync(modelPath, `${JSON.stringify(changeModel, null, 2)}\n`, 'utf8');
  const modelBytes = fs.readFileSync(modelPath);
  const common = [
    '--candidate=learned-value-v1',
    '--comparison=expert',
    `--model=${modelPath}`,
    '--levels=2',
    '--no-level-blocks',
    '--json',
  ];

  function assertNoChild(argv, message) {
    let spawned = false;
    assert.throws(() => runLocalLearningArena(argv, {
      cwd: root,
      spawnSync(...spawnArgs) {
        spawned = true;
        throw new Error(`不应启动子进程：${spawnArgs.slice(0, 6).join(' ')}`);
      },
      print: false,
    }), message);
    assert.equal(spawned, false, `${message}：拒绝后不得 spawn 子进程`);
  }

  assertNoChild(['--blocks=0', ...common, `--report=${reportPath}`], '--blocks=0');
  assertNoChild(['--blocks=-1', ...common, `--report=${reportPath}`], '--blocks=-1');
  assertNoChild(['--blocks=bad', ...common, `--report=${reportPath}`], '--blocks=bad');
  assertNoChild(['--blocks=1', '--base-seed=4294967296', ...common, `--report=${reportPath}`],
    '--base-seed=4294967296');
  assertNoChild(['--blocks=2', '--base-seed=4294967295', ...common, `--report=${reportPath}`],
    'uint32 区组回绕');
  assertNoChild([
    '--blocks=1', '--base-seed=3400000000',
    '--candidate=learned-value-v1', '--comparison=expert',
    `--model=${modelPath}`, '--levels=2,foo', '--no-level-blocks', '--json',
    `--report=${reportPath}`,
  ], '畸形 levels');
  assertNoChild(['--blocks=1', '--mystery', ...common, `--report=${reportPath}`],
    '未知旗标');

  fs.writeFileSync(reportPath, sentinel);
  fs.writeFileSync(checkpointPath, sentinel);
  assertNoChild(['--blocks=1', '--base-seed=3400000000', ...common, `--report=${reportPath}`],
    '已存在 report');
  assert.deepEqual(fs.readFileSync(reportPath), sentinel, '已存在 report 字节不得被改写');
  assertNoChild([
    '--blocks=1', '--base-seed=3400000000', ...common,
    `--checkpoint=${checkpointPath}`,
  ], '已存在 checkpoint');
  assert.deepEqual(fs.readFileSync(checkpointPath), sentinel, '已存在 checkpoint 字节不得被改写');
  assertNoChild([
    '--blocks=1', '--base-seed=3400000000',
    '--candidate=learned-value-v1', '--comparison=expert',
    `--model=${modelPath}`, `--report=${modelPath}`,
    '--levels=2', '--no-level-blocks', '--json',
  ], 'report 与 model 路径别名');
  assert.deepEqual(fs.readFileSync(modelPath), modelBytes, '模型文件不得被 report 别名覆盖');

  const cliRejects = [
    ['--blocks=0', `--report=${path.join(temporary, 'cli-blocks-0.json')}`],
    ['--base-seed=4294967296', `--report=${path.join(temporary, 'cli-seed-wrap.json')}`],
    ['--unknown-flag', `--report=${path.join(temporary, 'cli-unknown.json')}`],
  ];
  for (const extra of cliRejects) {
    const target = extra.find((item) => item.startsWith('--report=')).slice('--report='.length);
    const before = fs.existsSync(target) ? fs.readFileSync(target) : null;
    const result = spawnSync(process.execPath, [
      arenaCli,
      '--candidate=learned-value-v1',
      '--comparison=expert',
      `--model=${modelPath}`,
      '--levels=2',
      '--no-level-blocks',
      ...extra,
    ], { cwd: root, encoding: 'utf8', timeout: 15000 });
    assert.notEqual(result.status, 0, `CLI 必须拒绝 ${extra[0]}：${result.stderr || result.stdout}`);
    if (before == null) {
      assert.equal(fs.existsSync(target), false, `拒绝 ${extra[0]} 后不得新建 report`);
    } else {
      assert.deepEqual(fs.readFileSync(target), before, `拒绝 ${extra[0]} 后原 report 字节不变`);
    }
    assert.deepEqual(fs.readFileSync(modelPath), modelBytes, `拒绝 ${extra[0]} 后模型字节不变`);
    assert.deepEqual(fs.readFileSync(reportPath), sentinel, `拒绝 ${extra[0]} 后已有 sentinel report 不变`);
  }
}

{
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'guandan-learn-002-'));
  const modelPath = path.join(temporary, 'synthetic-linear.json');
  const reportPath = path.join(temporary, 'arena-smoke.json');
  fs.writeFileSync(modelPath, `${JSON.stringify(changeModel, null, 2)}\n`, 'utf8');
  const result = spawnSync(process.execPath, [
    arenaCli,
    '--candidate=learned-value-v1',
    '--comparison=expert',
    `--model=${modelPath}`,
    '--blocks=1',
    '--base-seed=3400000000',
    '--levels=2,3',
    '--level-blocks',
    `--report=${reportPath}`,
    '--json',
  ], {
    cwd: root,
    encoding: 'utf8',
    timeout: SMOKE_TIMEOUT_MS,
  });
  assert.equal(result.status, 0,
    `arena 跨级双腿 smoke 必须完成：${String(result.stderr || result.stdout).slice(-1600)}`);
  assert.equal(fs.existsSync(reportPath), true, 'arena 必须写出报告文件');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.equal(report.purpose, 'learning-development', '研发输出标记 purpose=learning-development');
  assert.notEqual(report.promoted, true, '不得产生 promoted 回执');
  assert.notEqual(report.config?.valueModel?.promoted, true, 'valueModel 回执不得标 promoted');
  assert.equal(report.config?.valueModel?.purpose, 'learning-development',
    '模型回执必须声明学习研发用途');
  assert.equal(report.config?.candidate, 'learned-value-v1', '候选策略为 learned-value-v1');
  assert.equal(report.config?.comparison, 'expert', '对照策略保持 expert');
  assert.equal(report.completion?.gamesCompleted, 4, '1 底牌组 × 2 级 × 双腿 = 4 局');
  assert.equal(report.completion?.mirrorPairsCompleted, 2, '跨级双腿必须产出两对镜像');
  assert.equal(report.completion?.failures, 0, 'smoke 不得失败');
  assert.equal(report.completion?.deadlocks, 0, 'smoke 不得死锁');
  assert.equal(report.completion?.mirrorMismatches, 0, '相同发牌的镜像对照必须等价');
  assert(Number(report.learning?.modelCalls) >= 8, 'A/B 包装必须累计模型调用');
  assert(Number(report.learning?.turns) >= 4, 'A/B 包装必须累计学习决策手数');
  assert(Number.isInteger(report.learning?.changed), '必须记录 changed 计数');
  assert(Number.isInteger(report.learning?.fallback), '必须记录 fallback 计数');
  assert.equal(report.learning?.fallback, 0, '有效合成模型不得回退');
  const artifactDir = path.join(root, 'data', 'learn-v1');
  const artifactPath = path.join(artifactDir, 'arena-smoke.json');
  fs.mkdirSync(artifactDir, { recursive: true });
  if (!fs.existsSync(artifactPath)) {
    fs.copyFileSync(reportPath, artifactPath);
  } else {
    const existing = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    assert.equal(existing.purpose, 'learning-development',
      '已有 arena-smoke.json 必须仍是研发标记，禁止覆盖历史原件');
  }
}

{
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'guandan-context-smoke-'));
  try {
    const model = path.join(temporary, 'context.json'), reportPath = path.join(temporary, 'context-report.json');
    fs.writeFileSync(model, JSON.stringify({ ...changeModel, metadata: { featureEngine: 'learned-context-v1' } }));
    const args = [arenaCli, '--candidate=learned-context-v1', '--comparison=expert', `--model=${model}`,
      '--blocks=1', '--base-seed=3400000000', '--levels=2', `--report=${reportPath}`];
    const run = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: SMOKE_TIMEOUT_MS });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    assert.equal(report.completion.gamesCompleted, 2);
    assert.equal(report.config.valueModel.featureEngine, 'learned-context-v1');
    assert(report.learning.modelCalls > 0);
    assert.equal(report.learning.fallback, 0);
    const mismatchReport = path.join(temporary, 'mismatch.json');
    const mismatch = spawnSync(process.execPath, args.map(a => a === '--candidate=learned-context-v1'
      ? '--candidate=learned-value-v1' : a === `--report=${reportPath}` ? `--report=${mismatchReport}` : a),
    { cwd: root, encoding: 'utf8', timeout: 15000 });
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /featureEngine/);
    assert.equal(fs.existsSync(mismatchReport), false);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
console.log('local learning arena directed tests: OK');
