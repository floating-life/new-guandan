import { createCard } from './cards.js';
import { parseHand } from './rules.js';
import {
  createMatch, humanSelectSet, humanPlay, humanPass,
  setReplayEventObserver, serializeMatchState, PHASE,
} from './game.js';
import { createLivePublicEvent } from './replay-contracts.js';
import {
  PASS_CANDIDATE_ID,
  SEALED_STATE_KEYS,
  SEALED_TRAINING_BATCH_SCHEMA,
  appendSealedTrainingTurn,
  assignMatchSplit,
  convertSealedTrainingBatches,
  createSealedTrainingBatch,
  getSealedTrainingBatch,
  listLegalTrainingCandidates,
  replaySealedTrainingBatch,
  snapshotSealedAction,
  teamUtilitiesFromFinishOrder,
  validateSealedTrainingBatch,
} from './sealed-training.js';

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

function C(rank, suit = 'S', deck = 0) {
  return createCard(rank, suit, deck);
}

function sha(char = 'a') {
  return char.repeat(64);
}

function publicEvent({ sequence = 0, seat = 0, action = 'play', cards = [C(5)], hand = null } = {}) {
  return createLivePublicEvent({
    matchId: 'sealed-test-match',
    round: 1,
    trick: 1,
    turn: sequence + 1,
    eventId: `sealed-test-match:event:${sequence}`,
    sequence,
    occurredAt: '2026-09-02T00:00:00.000Z',
    ruleVersion: 'guandan-rules-v1',
    implementationSha256: sha(),
    previousEventSha256: null,
    eventType: action,
    seat,
    action,
    cards: action === 'play' ? cards : [],
    hand: action === 'play' ? (hand || { type: 'single', mainRank: cards[0].rank, size: 1, power: cards[0].rank }) : null,
    countsBefore: [2, 2, 2, 2],
    countsAfter: action === 'play' ? [1, 2, 2, 2] : [2, 2, 2, 2],
    tribute: [],
    engine: null,
    decisionMeta: null,
  });
}

function playingState({ finish = false } = {}) {
  const state = createMatch({ difficulty: 'easy', aiSpeed: 'fast', coachMode: false });
  state.matchId = 'sealed-test-match';
  state.round = 1;
  state.phase = PHASE.PLAYING;
  state.currentLevel = 2;
  state.currentSeat = 0;
  state.finishOrder = finish ? [2] : [];
  state.trickLog = [];
  state.trickNumber = 1;
  state.lastHand = null;
  state.lastSeat = null;
  state.passCount = 0;
  state.hands = finish
    ? [[C(4)], [C(8), C(9)], [], [C(10), C(11)]]
    : [[C(4)], [C(8)], [C(9)], [C(10)]];
  state.handCounts = state.hands.map((hand) => hand.length);
  return state;
}

console.log('RT-5 合法候选与唯一 chosen');
{
  const hand = [C(4), C(6), C(9)];
  const listed = listLegalTrainingCandidates({
    actingHand: hand,
    level: 2,
    lastHand: null,
    action: 'play',
    cards: [hand[0]],
    playedHand: parseHand([hand[0]], 2),
  });
  assert(listed.candidates.length >= 3, '领出包含全部规则生成的合法候选');
  assert(listed.candidates.some((item) => item.candidateId === listed.chosenCandidateId),
    'chosen 唯一对应一个合法候选');
  assert(!listed.candidates.some((item) => item.candidateId === PASS_CANDIDATE_ID),
    '领出候选不含过牌');
}

{
  const hand = [C(4), C(6)];
  const last = parseHand([C(13)], 2);
  const listed = listLegalTrainingCandidates({
    actingHand: hand,
    level: 2,
    lastHand: last,
    action: 'pass',
    cards: [],
    playedHand: null,
  });
  assert(listed.chosenCandidateId === PASS_CANDIDATE_ID, '接牌过牌的 chosen 是 pass');
  assert(listed.candidates.some((item) => item.candidateId === PASS_CANDIDATE_ID),
    '存在上手牌时候选包含过牌');
}

{
  let rejected = false;
  try {
    listLegalTrainingCandidates({
      actingHand: [C(4)],
      level: 2,
      lastHand: null,
      action: 'pass',
      cards: [],
    });
  } catch { rejected = true; }
  assert(rejected, '领出过牌 fail closed');
}

{
  let rejected = false;
  try {
    listLegalTrainingCandidates({
      actingHand: [C(4)],
      level: 2,
      lastHand: parseHand([C(13)], 2),
      action: 'play',
      cards: [C(4)],
      playedHand: parseHand([C(4)], 2),
    });
  } catch { rejected = true; }
  assert(rejected, '压不过上家的实际动作 fail closed');
}

console.log('RT-5 密封批次、名次收益与 fail-closed');
{
  const state = playingState({ finish: true });
  const events = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = () => 0;
  try {
    setReplayEventObserver((event) => events.push(event));
    humanSelectSet(state, [state.hands[0][0].id]);
    const result = humanPlay(state);
    setReplayEventObserver(null);
    const batch = getSealedTrainingBatch(state);
    assert(result.ok && state.phase === PHASE.ROUND_END, '双上提前结束能副末收束');
    assert(batch && batch.schema === SEALED_TRAINING_BATCH_SCHEMA && batch.trainingEligible === false,
      '副末生成密封批次且 trainingEligible=false');
    assert(batch.turns.length === state.trickLog.filter((item) => item.action === 'play' || item.action === 'pass').length,
      '每个行动 turn 都有密封记录');
    assert(batch.turns.every((turn) => turn.sourceEventId && events.some((event) => event.eventId === turn.sourceEventId)),
      '密封 turn 绑定公开事件 sourceEventId');
    assert(events.every((event) => !('legalCandidates' in event) && !('trainingEligible' in event)
      && !('hand' in event && Array.isArray(event.hand))),
    '公开事件不含密封候选或训练标签');
    assert(validateSealedTrainingBatch(batch).ok && replaySealedTrainingBatch(batch).ok,
      '副末批次可通过构造校验和规则重放');
    const ranking = teamUtilitiesFromFinishOrder(batch.finishOrder);
    assert(ranking.teamUtilities[0] === -ranking.teamUtilities[1] && ranking.upgrade === batch.upgrade,
      '团队收益由名次重算且胜负相反');
  } finally {
    setReplayEventObserver(null);
    globalThis.setTimeout = realSetTimeout;
  }
}

{
  const state = playingState();
  state.lastHand = parseHand([C(13)], 2);
  state.lastSeat = 3;
  state.hands = [[C(4), C(6)], [C(8)], [C(9)], [C(10)]];
  state.handCounts = state.hands.map((hand) => hand.length);
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = () => 0;
  try {
    const result = humanPass(state);
    const turn = state.sealedTrainingTurns[0];
    assert(result.ok && turn?.chosenCandidateId === PASS_CANDIDATE_ID, '过牌写入 pass 候选');
    assert(turn.legalCandidates.some((item) => item.candidateId === PASS_CANDIDATE_ID),
      '过牌 turn 的候选集包含 pass');
    assert(!turn.publicObservation.hand.some((card) => 'id' in card || 'deckIndex' in card),
      '公开 observation 手牌不含实体 ID 或副本索引');
    assert(turn.hand[0].id && Number.isInteger(turn.hand[0].deckIndex),
      '密封行动手牌保留物理身份');
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
}

{
  const state = playingState();
  state.sealedTrainingTurns = [{ schema: 'leak' }];
  state.sealedTrainingBatch = { schema: 'leak-batch' };
  const snapshot = serializeMatchState(state);
  assert(SEALED_STATE_KEYS.every((key) => !(key in snapshot)),
    '进行中存档序列化剥离密封字段');
}

{
  const ranking = teamUtilitiesFromFinishOrder([0, 2, 1, 3]);
  assert(ranking.winTeam === 0 && ranking.upgrade === 3 && ranking.teamUtilities[0] === 3,
    '双上 +3 团队收益');
  const headThird = teamUtilitiesFromFinishOrder([1, 0, 3, 2]);
  assert(headThird.winTeam === 1 && headThird.upgrade === 2 && headThird.teamUtilities[1] === 2,
    '头游+三游 +2 且按获胜队记账');
}

{
  let rejected = false;
  try {
    createSealedTrainingBatch({
      matchId: 'x', round: 1, createdAt: '2026-09-02T00:00:00.000Z',
      implementationSha256: sha(), publicImplementationSha256: sha(),
      sourceHeadEventSha256: sha('b'), sourceTailEventSha256: sha('c'),
      finishOrder: [0, 2, 1, 3], winTeam: 0, upgrade: 3, upgradeCode: 'double_up',
      teamUtilities: [3, -3], turns: [], trainingEligible: false, split: null,
    });
  } catch { rejected = true; }
  assert(rejected, '空 turn 批次 fail closed');
}

console.log('RT-5 转换器切分、去重与反事实拒绝');
{
  const state = playingState({ finish: true });
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = () => 0;
  try {
    humanSelectSet(state, [state.hands[0][0].id]);
    humanPlay(state);
    const batch = getSealedTrainingBatch(state);
    const converted = convertSealedTrainingBatches([batch, batch]);
    assert(converted.ok && converted.manifest.trainingEligible === false, '转换器保持不可训练');
    assert(converted.manifest.duplicateCount === 1 && converted.manifest.acceptedMatchRounds === 1,
      '完整 match 去重后只保留一份');
    assert(converted.manifest.labelPolicy === 'trajectory_only_no_counterfactual',
      '转换器声明不为未选动作伪造反事实标签');
    const split = assignMatchSplit(batch.matchId);
    assert(converted.splits[split].length === 1 && converted.splits[split][0].split === split,
      '按完整 matchId 切分 train/validation/held-out');
    assert(converted.splits[split][0].turns.every((turn) => (
      !('reward' in turn) && !('outcome' in turn)
      && turn.legalCandidates.every((item) => !('reward' in item) && !('outcome' in item) && !('chosen' in item))
    )), '未选择候选没有反事实标签');
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
}

{
  const state = playingState({ finish: true });
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = () => 0;
  try {
    humanSelectSet(state, [state.hands[0][0].id]);
    humanPlay(state);
    const batch = {
      ...getSealedTrainingBatch(state),
      trainingEligible: true,
    };
    const converted = convertSealedTrainingBatches([batch]);
    assert(!converted.ok && converted.splits.train.length === 0,
      '擅自标记可训练的批次被拒绝且不写入切分');
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
}

{
  const state = playingState({ finish: true });
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = () => 0;
  try {
    humanSelectSet(state, [state.hands[0][0].id]);
    humanPlay(state);
    const original = getSealedTrainingBatch(state);
    const leaked = {
      ...original,
      turns: original.turns.map((turn, index) => (
        index === 0
          ? { ...turn, publicObservation: { ...turn.publicObservation, hands: [[C(3)], [C(4)], [C(5)], [C(6)]] } }
          : turn
      )),
    };
    const converted = convertSealedTrainingBatches([leaked]);
    assert(!converted.ok, '公开 observation 暗牌泄漏 fail closed');
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
}

{
  const state = playingState({ finish: true });
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = () => 0;
  try {
    humanSelectSet(state, [state.hands[0][0].id]);
    humanPlay(state);
    const original = getSealedTrainingBatch(state);
    const injected = {
      ...original,
      turns: original.turns.map((turn, index) => (
        index === 0
          ? {
            ...turn,
            legalCandidates: [
              ...turn.legalCandidates,
              {
                candidateId: 'play:deadbeefdeadbeefdeadbeefdeadbeef',
                cards: [{ rank: 14, suit: 'H' }],
                hand: { type: 'single', mainRank: 14, size: 1, power: 14 },
              },
            ],
          }
          : turn
      )),
    };
    const converted = convertSealedTrainingBatches([injected]);
    assert(!converted.ok && converted.splits.train.length === 0
      && converted.splits.validation.length === 0
      && converted.splits['held-out'].length === 0,
    '未选择的外来候选和失败批次不得进入任何切分');
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
}

{
  const snapshot = snapshotSealedAction({
    seat: 0,
    action: 'play',
    cards: [C(7)],
    playedHand: parseHand([C(7)], 2),
    actingHand: [C(7), C(8)],
    level: 2,
    lastHand: null,
  });
  const event = publicEvent({ cards: snapshot.actingHand.slice(0, 1) });
  assert(snapshot.candidates.length >= 2 && snapshot.chosenCandidateId.startsWith('play:'),
    '快照保留完整候选并给 chosen 确定性 ID');
  assert(event.eventType === 'play' && !('legalCandidates' in event),
    '用于绑定的公开事件仍不含密封字段');
}

{
  const state = playingState({ finish: true });
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = () => 0;
  try {
    humanSelectSet(state, [state.hands[0][0].id]);
    humanPlay(state);
    const original = getSealedTrainingBatch(state);
    let rejected = false;
    try {
      createSealedTrainingBatch({ ...original, upgradeCode: 'head_last' });
    } catch { rejected = true; }
    assert(rejected, '错误 upgradeCode 与名次不一致时 fail closed');
    assert(!validateSealedTrainingBatch({ ...original, upgradeCode: 'head_last' }).ok,
      'validate 拒绝 upgradeCode 与 finishOrder 不一致');
    assert(original.upgradeCode === teamUtilitiesFromFinishOrder(original.finishOrder).upgradeCode,
      '批次持久化由名次重算的 upgradeCode');
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
}

{
  const shared = C(4);
  const other = C(8);
  const snap0 = snapshotSealedAction({
    seat: 0,
    action: 'play',
    cards: [shared],
    playedHand: parseHand([shared], 2),
    actingHand: [shared],
    level: 2,
    lastHand: null,
    handCounts: [1, 2, 1, 1],
  });
  const snap1 = snapshotSealedAction({
    seat: 1,
    action: 'play',
    cards: [other],
    playedHand: parseHand([other], 2),
    actingHand: [{ ...shared }, other],
    level: 2,
    lastHand: parseHand([shared], 2),
    handCounts: [0, 2, 1, 1],
  });
  const sealedState = {
    matchId: 'sealed-test-match',
    sealedSequence: 0,
    sealedTrainingTurns: [],
    sealedPreviousTurnSha256: null,
    sealedTrainingFailures: 0,
  };
  appendSealedTrainingTurn(sealedState, publicEvent({ sequence: 0, seat: 0, cards: [shared] }), snap0);
  appendSealedTrainingTurn(sealedState, publicEvent({ sequence: 1, seat: 1, cards: [other] }), snap1);
  const forged = createSealedTrainingBatch({
    matchId: 'sealed-test-match',
    round: 1,
    createdAt: '2026-09-02T00:00:00.000Z',
    implementationSha256: sha(),
    publicImplementationSha256: sha(),
    finishOrder: [0, 2, 1, 3],
    turns: sealedState.sealedTrainingTurns,
    trainingEligible: false,
    split: null,
  });
  const replay = replaySealedTrainingBatch(forged);
  assert(!replay.ok && replay.errors.some((error) => error.includes('物理牌身份')),
    '同一物理牌身份出现在两个座位时 fail closed');
}

console.log(`\n结果: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
