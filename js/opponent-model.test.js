/** 公开信息对手模型：隐私边界、平滑预测与候选软偏置。 */
import {
  OPPONENT_MODEL_SCHEMA, OPPONENT_MODEL_VERSION, OPPONENT_MODEL_MIN_SAMPLES,
  emptyOpponentProfile, normalizeOpponentProfile, observePublicRound,
  opponentPlayAdjustment, predictOpponentProfile,
} from './opponent-model.js';

let passed = 0;
let failed = 0;
function assert(condition, message) {
  if (condition) { passed += 1; console.log('  ✓', message); }
  else { failed += 1; console.error('  ✗', message); }
}

function item(turn, trickNumber, seat, action, type, count = 12) {
  return {
    turn,
    trickNumber,
    seat,
    action,
    hand: action === 'play' ? { type, mainRank: 8, size: 1, power: 8 } : null,
    countsBefore: [count, 14, 14, 14],
    countsAfter: [count - Number(action === 'play'), 14, 14, 14],
  };
}

console.log('公开行动画像');
{
  const history = [];
  for (let index = 0; index < 8; index += 1) {
    const trick = index + 1;
    history.push(item(trick * 2 - 1, trick, 1, 'play', 'pair', 14));
    history.push(item(trick * 2, trick, 0, 'pass', null, 14));
  }
  for (let index = 0; index < 6; index += 1) {
    const trick = index + 20;
    history.push(item(trick * 2 - 1, trick, 0, 'play', 'single', 11));
    history.push(item(trick * 2, trick, 1, 'pass', null, 14));
  }
  const raw = { hands: [['绝不能保存']], initialHands: ['secret'] };
  const profile = observePublicRound(raw, history, { userSeat: 0 });
  const prediction = predictOpponentProfile(profile, 'pair', 'response');
  assert(profile.schema === OPPONENT_MODEL_SCHEMA
    && profile.decisions === 14 && profile.rounds === 1,
  '只统计真人座位已公开的出牌和过牌次数');
  assert(prediction.passRate > 0.8 && prediction.samples === 8,
    '同牌型应手过牌倾向经平滑后可被预测');
  assert(!JSON.stringify(profile).includes('绝不能保存')
    && !('hands' in profile) && !('initialHands' in profile),
  '暗牌和初始牌字段不会进入持久化画像');
}

console.log('候选偏置受样本与上限约束');
{
  let profile = emptyOpponentProfile();
  profile.decisions = OPPONENT_MODEL_MIN_SAMPLES;
  profile.typeStats.pair.response = { play: 0, pass: 60 };
  profile.pressure.open = { play: 0, pass: 60 };
  const context = {
    seat: 1,
    teams: [0, 1, 0, 1],
    handCounts: [14, 12, 12, 12],
    lastHand: null,
  };
  const candidate = { action: 'play', hand: { type: 'pair' } };
  const adjustment = opponentPlayAdjustment(profile, context, candidate);
  assert(adjustment.applied && adjustment.score > 0 && adjustment.score <= 12,
    '敌方 AI 只在领出时偏向真人更常过牌的牌型，幅度被严格封顶');
  const teammate = opponentPlayAdjustment(profile, { ...context, seat: 2 }, candidate);
  assert(teammate.score < 0 && teammate.score >= -12,
    '对家 AI 使用同一公开画像时只作对称的小幅交接偏置');
  const response = opponentPlayAdjustment(profile, { ...context, lastHand: { type: 'pair' } }, candidate);
  assert(response.score === 0 && response.reason === 'response_context',
    '当前接牌回合不使用画像，避免循环解释和过度干预');
  const normalized = normalizeOpponentProfile({
    decisions: -1,
    typeStats: { pair: { response: { pass: 99999999 } } },
    responseStyles: { byTarget: { pair: { plays: 2, bombPlays: 99, nonBombPlays: 99 } } },
  });
  assert(normalized.decisions === 0 && normalized.typeStats.pair.response.pass <= 1000000
    && normalized.responseStyles.byTarget.pair.bombPlays === 2
    && normalized.responseStyles.byTarget.pair.nonBombPlays === 0,
    '导入的对手模型统计会被归一化和上限保护');
}

console.log('v1画像可无损升级');
{
  const old = emptyOpponentProfile();
  old.version = 1;
  old.decisions = 17;
  old.typeStats.pair.response = { play: 3, pass: 9 };
  delete old.responsePositions;
  delete old.responsePositionTypes;
  delete old.responseStyles;
  const upgraded = normalizeOpponentProfile(old);
  assert(upgraded.version === OPPONENT_MODEL_VERSION
    && upgraded.decisions === 17
    && upgraded.typeStats.pair.response.pass === 9,
  '旧版累计样本迁移到v2时不丢失');
  assert(upgraded.responsePositions.upper.play === 0
    && upgraded.responsePositionTypes.upper.pair.pass === 0
    && upgraded.responseStyles.byTarget.pair.bombPlays === 0,
  '新增座次和应手风格字段以安全零值补齐');
}

console.log('领牌偏好、实际应手牌型与座次均来自公开记录');
{
  const history = [];
  let trick = 100;
  for (let index = 0; index < 8; index += 1) {
    history.push(item(index, trick++, 0, 'play', 'single', 16));
  }
  for (let index = 0; index < 4; index += 1) {
    history.push(item(index + 20, trick++, 0, 'play', 'pair', 13));
  }
  for (let index = 0; index < 6; index += 1) {
    const current = trick++;
    history.push(item(index * 2 + 40, current, 3, 'play', 'pair', 12));
    history.push(item(index * 2 + 41, current, 0, 'play', 'bomb', 8));
  }
  for (let index = 0; index < 4; index += 1) {
    const current = trick++;
    history.push(item(index * 2 + 60, current, 1, 'play', 'straight', 12));
    history.push(item(index * 2 + 61, current, 0, 'pass', null, 8));
  }
  const profile = observePublicRound({ hiddenHand: ['secret-card'] }, history, { userSeat: 0 });
  const pair = predictOpponentProfile(profile, 'pair', 'response', 'mid', 'upper');
  const single = predictOpponentProfile(profile, 'single', 'response');
  assert(pair.bombUseSamples === 6 && pair.bombUseRate > 0.7
    && pair.bombUseTendency === 'uses_readily'
    && pair.actualResponseTypes.bomb === 6,
  '记录真人实际以炸弹应对普通对子，不把目标牌型误当成应手牌型');
  assert(profile.responsePositions.upper.play === 6
    && profile.responsePositions.lower.pass === 4
    && profile.responsePositionTypes.upper.pair.play === 6
    && profile.responsePositionTypes.lower.straight.pass === 4,
  '公开来源座位被区分为上家与下家');
  assert(single.leadPreference > 0 && single.leadSamples === 12,
  '真人常领的单张形成独立于应手率的领牌偏好');
  assert(!JSON.stringify(profile).includes('secret-card'),
  '升级后的画像仍拒绝保存注入的暗牌字段');
}

console.log('领牌偏好真实参与敌我不同的领出排序');
{
  const profile = emptyOpponentProfile();
  profile.decisions = 24;
  profile.leads = 16;
  profile.typeStats.single.lead.play = 12;
  profile.typeStats.pair.lead.play = 4;
  profile.typeStats.single.response = { play: 3, pass: 3 };
  profile.typeStats.pair.response = { play: 3, pass: 3 };
  profile.pressure.open = { play: 6, pass: 6 };
  const base = {
    teams: [0, 1, 0, 1], handCounts: [14, 12, 12, 12], lastHand: null,
  };
  const single = { action: 'play', hand: { type: 'single' } };
  const pair = { action: 'play', hand: { type: 'pair' } };
  const enemySingle = opponentPlayAdjustment(profile, { ...base, seat: 3 }, single);
  const enemyPair = opponentPlayAdjustment(profile, { ...base, seat: 3 }, pair);
  const partnerSingle = opponentPlayAdjustment(profile, { ...base, seat: 2 }, single);
  const partnerPair = opponentPlayAdjustment(profile, { ...base, seat: 2 }, pair);
  assert(enemySingle.components.lead < 0 && enemySingle.score < enemyPair.score,
    '敌家小幅避开真人经常整理并领出的牌型');
  assert(partnerSingle.components.lead > 0 && partnerSingle.score > partnerPair.score,
    '对家小幅顺着真人经常领出的牌型做交接');
}

console.log('炸弹倾向和相对座位只作保守软调整');
{
  const profile = emptyOpponentProfile();
  profile.decisions = 30;
  profile.typeStats.pair.response = { play: 5, pass: 5 };
  profile.pressure.end = { play: 5, pass: 5 };
  profile.responsePositions.upper = { play: 1, pass: 9 };
  profile.responsePositions.lower = { play: 9, pass: 1 };
  profile.responsePositionTypes.upper.pair = { play: 1, pass: 9 };
  profile.responsePositionTypes.lower.pair = { play: 9, pass: 1 };
  profile.responseStyles.byTarget.pair = {
    plays: 10, passes: 0, bombPlays: 8, nonBombPlays: 2,
  };
  const candidate = { action: 'play', hand: { type: 'pair' } };
  const base = {
    teams: [0, 1, 0, 1], handCounts: [5, 12, 12, 12], lastHand: null,
  };
  const upper = opponentPlayAdjustment(profile, { ...base, seat: 3 }, candidate);
  const lower = opponentPlayAdjustment(profile, { ...base, seat: 1 }, candidate);
  assert(upper.relativePosition === 'upper' && lower.relativePosition === 'lower'
    && upper.positionWeight > lower.positionWeight
    && upper.predictedPositionPassRate > lower.predictedPositionPassRate
    && upper.score > lower.score,
  '同牌型按上家/下家的公开应手历史分别预测，且隔位下家采用保守折扣');
  assert(upper.components.bomb < 0 && upper.bombUseTendency === 'uses_readily'
    && upper.score >= -12 && upper.score <= 12,
  '敌家识别真人公开的高用炸率，但只施加小幅风险项并保持总上限');
}

console.log('v3 衰减与模式边界');
{
  const history = [
    item(1, 1, 1, 'play', 'pair', 14),
    item(2, 1, 0, 'pass', null, 14),
  ];
  const once = observePublicRound(emptyOpponentProfile(), history, { userSeat: 0 });
  const twice = observePublicRound(once, history, { userSeat: 0 });
  assert(twice.version === OPPONENT_MODEL_VERSION
    && twice.roundsObserved === 2
    && twice.decisions > 1 && twice.decisions < 2,
  '每副公开行动加入前按100副半衰期衰减旧证据，同时保留实际观察副数');

  const profile = emptyOpponentProfile();
  profile.decisions = 80;
  profile.typeStats.pair.response = { play: 0, pass: 40 };
  profile.pressure.open = { play: 0, pass: 40 };
  const context = {
    seat: 1, teams: [0, 1, 0, 1], handCounts: [14, 12, 12, 12], lastHand: null,
  };
  const candidate = { action: 'play', hand: { type: 'pair' } };
  const observing = opponentPlayAdjustment(profile, {
    ...context, opponentModelMode: 'observe',
  }, candidate);
  const off = opponentPlayAdjustment(profile, { ...context, opponentModelMode: 'off' }, candidate);
  const adaptive = opponentPlayAdjustment(profile, {
    ...context, opponentModelMode: 'adaptive',
  }, candidate);
  assert(observing.score === 0 && observing.reason === 'opponent_model_observe_only'
    && off.score === 0 && off.reason === 'opponent_model_off'
    && adaptive.applied && adaptive.confidence > 0,
  'off/observe/adaptive 分别关闭、只积累和在安全候选内启用公开画像信号');
}

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
