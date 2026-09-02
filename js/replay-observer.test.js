import { createCard } from './cards.js';
import { parseHand } from './rules.js';
import {
  createMatch, startRound, humanSelectSet, humanPlay, humanPass,
  humanPickReturnCard, humanConfirmReturn, getReturnCandidates,
  setReplayEventObserver, PHASE,
} from './game.js';
import { validateLiveEventChain } from './replay-contracts.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log('  ✓', message);
  } else {
    failed++;
    console.error('  ✗', message);
  }
}

function C(rank, suit = 'S', deck = 0) {
  return createCard(rank, suit, deck);
}

function playingState({ level = 2 } = {}) {
  const state = createMatch({ difficulty: 'easy', aiSpeed: 'fast', coachMode: false });
  state.matchId = 'observer-test-match';
  state.round = 1;
  state.phase = PHASE.PLAYING;
  state.currentLevel = level;
  state.currentSeat = 0;
  state.finishOrder = [];
  state.trickLog = [];
  state.trickNumber = 1;
  state.currentTrickStartIndex = 0;
  state.lastHand = null;
  state.lastSeat = null;
  state.passCount = 0;
  state.hands = [[C(4)], [C(8)], [C(9)], [C(10)]];
  state.handCounts = state.hands.map((hand) => hand.length);
  return state;
}

console.log('RT-2 真实动作提交边界');

{
  const events = [];
  const state = playingState();
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = () => 0;
  try {
    setReplayEventObserver((event) => events.push(event));
    humanSelectSet(state, [state.hands[0][0].id]);
    const result = humanPlay(state);
    setReplayEventObserver(null);
    assert(result.ok && events.length === 1 && events[0].eventType === 'play',
      '成功真人出牌在 applyPlay 后发出一次 play 事件');
    assert(events[0]?.seat === 0 && events[0]?.action === 'play'
      && events[0]?.cards.length === 1 && !('id' in events[0].cards[0])
      && !('deckIndex' in events[0].cards[0]),
    '真人事件只含公开牌面，不带实体牌 ID 或副本索引');
  } finally {
    setReplayEventObserver(null);
    globalThis.setTimeout = realSetTimeout;
  }
}

{
  const events = [];
  const state = playingState();
  state.finishOrder = [2];
  state.hands = [[C(4)], [C(8), C(9)], [], [C(10), C(11)]];
  state.handCounts = state.hands.map((hand) => hand.length);
  setReplayEventObserver((event) => events.push(event));
  humanSelectSet(state, [state.hands[0][0].id]);
  const result = humanPlay(state);
  setReplayEventObserver(null);
  assert(result.ok && state.phase === PHASE.ROUND_END, '双上提前结束仍完成真实动作提交后状态收束');
  assert(events.map((event) => event.eventType).join(',') === 'play,trick_end,round_end'
    && validateLiveEventChain(events).ok,
  '双上提前结束按 play → trick_end → round_end 发出连续事件链');
  assert(events[2]?.eventType === 'round_end' && events[2]?.previousEventSha256 === events[1]?.eventSha256,
    'round_end 绑定最后一个 trick_end 摘要而不重复发送');
}

{
  const events = [];
  const state = playingState();
  state.lastHand = parseHand([C(13, 'S'), C(13, 'D')], 2);
  state.lastSeat = 3;
  state.currentSeat = 0;
  state.finishOrder = [3];
  state.passCount = 1;
  state.hands = [[C(9, 'S'), C(9, 'D')], [C(6)], [C(8, 'S'), C(8, 'D')], []];
  state.handCounts = state.hands.map((hand) => hand.length);
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = () => 0;
  try {
    setReplayEventObserver((event) => events.push(event));
    const result = humanPass(state);
    setReplayEventObserver(null);
    assert(result.ok && state.currentSeat === 1, '接风分支仍在真实过牌成功后推进到出完者对家');
    assert(events.map((event) => event.eventType).join(',') === 'pass,trick_end'
      && events[1]?.trick === 1 && validateLiveEventChain(events).ok,
    '接风前完成 pass 与 trick_end，未把 UI 更新回调当作事件来源');
  } finally {
    setReplayEventObserver(null);
    globalThis.setTimeout = realSetTimeout;
  }
}

{
  const events = [];
  const realRandom = Math.random;
  const realSetTimeout = globalThis.setTimeout;
  Math.random = () => 0.3;
  globalThis.setTimeout = () => 0;
  try {
    const state = createMatch({ difficulty: 'easy', aiSpeed: 'fast', coachMode: false });
    state.matchId = 'tribute-observer-match';
    state.prevFinishOrder = [0, 2, 1, 3];
    setReplayEventObserver((event) => events.push(event));
    // 固定洗牌只为稳定地进入真实 setupTribute/beginReturn/finishTribute 路径；
    // 不读取或输出任何其他座位的暗牌。
    startRound(state);
    const candidates = getReturnCandidates(state);
    const picked = candidates[0];
    const pickResult = humanPickReturnCard(state, picked.id);
    const confirmResult = humanConfirmReturn(state);
    assert(state.phase === PHASE.PLAYING && pickResult.ok && confirmResult.ok,
      '真实 setupTribute 与 humanConfirmReturn 完成贡还后进入出牌阶段');

    state.currentSeat = 0;
    const lead = state.hands[0][0];
    setReplayEventObserver((event) => events.push(event));
    humanSelectSet(state, [lead.id]);
    const playResult = humanPlay(state);
    setReplayEventObserver(null);
    const firstAction = events.find((event) => event.eventType === 'play');
    assert(playResult.ok && firstAction?.tribute?.length >= 2,
      '贡还转移在第一手真实公开动作事件中按白名单携带');
    assert(firstAction?.tribute?.every((item) => !('id' in item.card) && !('deckIndex' in item.card))
      && validateLiveEventChain(events).ok,
    '贡还公开转移不泄露实体牌 ID/副本索引且事件链摘要连续');
  } finally {
    setReplayEventObserver(null);
    Math.random = realRandom;
    globalThis.setTimeout = realSetTimeout;
  }
}

{
  const state = playingState({ level: 14 });
  state.levelOwner = 0;
  state.levels = [14, 3];
  state.finishOrder = [2];
  state.hands = [[C(4)], [C(8), C(9)], [], [C(10), C(11)]];
  state.handCounts = state.hands.map((hand) => hand.length);
  const events = [];
  setReplayEventObserver((event) => events.push(event));
  humanSelectSet(state, [state.hands[0][0].id]);
  const result = humanPlay(state);
  setReplayEventObserver(null);
  assert(result.ok && state.phase === PHASE.MATCH_END && events.at(-1)?.eventType === 'round_end',
    '打 A 终局在最终动作后发出 round_end 事件');
}

{
  const state = playingState();
  state.finishOrder = [2];
  state.hands = [[C(4)], [C(8)], [], [C(10)]];
  state.handCounts = state.hands.map((hand) => hand.length);
  let observerCalls = 0;
  setReplayEventObserver(() => {
    observerCalls++;
    throw new Error('模拟观察器故障');
  });
  humanSelectSet(state, [state.hands[0][0].id]);
  const result = humanPlay(state);
  setReplayEventObserver(null);
  assert(result.ok && state.phase === PHASE.ROUND_END && observerCalls === 3,
    '观察器抛错不阻断 play/trick_end/round_end 状态推进，并记录三次尝试');
}

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
