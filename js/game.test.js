/** 游戏状态、还贡限制、辅助标记与恢复测试。 */
import { createCard } from './cards.js';
import { parseHand } from './rules.js';
import {
  createMatch, startRound, getReturnCandidates, humanPickReturnCard, humanPass,
  humanSelectSet, humanPlay, markAssistance, persistMatch, restoreMatch, PHASE,
} from './game.js';

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

console.log('严格还贡限制');
{
  const state = createMatch({ difficulty: 'normal', aiSpeed: 'fast', coachMode: false });
  state.phase = PHASE.RETURN;
  state.currentLevel = 7;
  const small = C(5);
  const ten = C(10);
  const level = C(7, 'S');
  const king = C(13);
  const joker = C(17, 'J');
  state.hands[0] = [joker, king, level, ten, small];
  state.handCounts[0] = state.hands[0].length;
  state.tributeState = { pendingReturns: [{ from: 0, to: 1 }], returns: [] };
  const candidates = getReturnCandidates(state);
  assert(candidates.length === 2 && candidates.includes(small) && candidates.includes(ten), '有小牌时只允许不大于10的非级牌');
  assert(!humanPickReturnCard(state, king.id).ok, '禁止选择大牌还贡');
  assert(humanPickReturnCard(state, small.id).ok, '允许选择合规小牌');
}

console.log('无小牌时只能还最小牌');
{
  const state = createMatch({ difficulty: 'normal', aiSpeed: 'fast', coachMode: false });
  state.phase = PHASE.RETURN;
  state.currentLevel = 7;
  const jack = C(11);
  const queen = C(12);
  const king = C(13);
  state.hands[0] = [king, queen, jack];
  state.handCounts[0] = 3;
  state.tributeState = { pendingReturns: [{ from: 0, to: 1 }], returns: [] };
  const candidates = getReturnCandidates(state);
  assert(candidates.length === 1 && candidates[0].id === jack.id, '没有小牌时仅最小牌可还');
}

console.log('新副状态清理');
{
  const state = createMatch({ difficulty: 'normal', aiSpeed: 'fast', coachMode: false });
  state.roundSummary = { avg: 99 };
  state.handTips = ['旧分析'];
  state.trickLog = [{ text: '旧动作' }];
  state.currentTrickStartIndex = 1;
  state.selectedDeclaration = 'old';
  startRound(state);
  assert(state.roundSummary === null, '新副清空上一副总结');
  assert(state.trickLog.length === 0 && state.currentTrickStartIndex === 0, '新副清空旧圈动作');
  assert(state.selectedDeclaration === null, '新副清空牌型声明');
  assert(Array.isArray(state.handTips) && state.handTips.length > 0, '新副生成当前手牌分析');
}

console.log('辅助与被迫过牌口径');
{
  const state = createMatch({ difficulty: 'normal', aiSpeed: 'fast', coachMode: false });
  state.phase = PHASE.PLAYING;
  state.currentSeat = 0;
  state.currentLevel = 2;
  state.hands = [[C(3)], [C(9)], [C(4)], [C(5)]];
  state.handCounts = [1, 1, 1, 1];
  state.lastHand = parseHand([C(17, 'J')], 2);
  state.lastSeat = 1;
  markAssistance(state, 'hint');
  const result = humanPass(state);
  assert(result.ok && result.eval.forced, '无合法接牌时标记为被迫过牌');
  assert(result.eval.assisted && result.eval.assistanceTypes.includes('hint'), '评价记录本手使用过提示');
}

console.log('进行中牌局保存与恢复');
{
  const state = createMatch({ difficulty: 'hard', aiSpeed: 'fast', coachMode: false });
  state.phase = PHASE.PLAYING;
  state.round = 3;
  state.hands[0] = [C(8), C(9)];
  state.handCounts[0] = 2;
  state.selectedIds = new Set([state.hands[0][0].id]);
  assert(persistMatch(state), '进行中牌局可保存');
  const restored = restoreMatch();
  assert(restored?.round === 3 && restored.hands[0].length === 2, '恢复牌局保留轮次与手牌');
  assert(restored.selectedIds instanceof Set && restored.selectedIds.size === 1, '恢复牌局重建选牌集合');
}

console.log('双上立即结束');
{
  const state = createMatch({ difficulty: 'normal', aiSpeed: 'fast', coachMode: false });
  state.phase = PHASE.PLAYING;
  state.currentSeat = 0;
  state.currentLevel = 2;
  state.finishOrder = [2];
  state.hands = [[C(3)], [C(8), C(9)], [], [C(10), C(11)]];
  state.handCounts = state.hands.map((hand) => hand.length);
  humanSelectSet(state, [state.hands[0][0].id]);
  const result = humanPlay(state);
  assert(result.ok, '二游可正常出完最后一张牌');
  assert(state.phase === PHASE.ROUND_END, '头游和二游同队后立即结束本副');
  assert(state.finishOrder.length === 4 && state.finishOrder[0] === 2 && state.finishOrder[1] === 0,
    '双上结束时自动补齐两名下游，保留完整赛果');
  assert(state.lastRoundResult?.up === 3, '双上按升 3 级结算');
  assert(state.lastReplay?.remainingHands?.[1]?.length === 2
    && state.lastReplay?.remainingHands?.[3]?.length === 2,
  '复盘保存双下两名输家的终局余牌');
}

console.log('过A必须绑定本副级牌归属');
{
  const state = createMatch({ difficulty: 'normal', aiSpeed: 'slow', coachMode: false });
  state.phase = PHASE.PLAYING;
  state.currentSeat = 0;
  state.currentLevel = 3;
  state.levelOwner = 1;
  state.levels = [14, 3];
  state.finishOrder = [2];
  state.hands = [[C(4)], [C(8), C(9)], [], [C(10), C(11)]];
  state.handCounts = state.hands.map((hand) => hand.length);
  humanSelectSet(state, [state.hands[0][0].id]);
  const result = humanPlay(state);
  assert(result.ok && state.phase === PHASE.ROUND_END && state.winner === null,
    '我方已到A但本副打对方3时，双上不能借级直接获胜');
  assert(state.levels[0] === 14 && state.aFailCount[0] === 0,
    '在对方级数获胜只保留我方A，下副才轮到我方正式打A');
  assert(state.messages.some((item) => item.text.includes('不能直接过关')),
    '结算日志明确说明不能借对方级数过A');
}

{
  const state = createMatch({ difficulty: 'normal', aiSpeed: 'slow', coachMode: false });
  state.phase = PHASE.PLAYING;
  state.currentSeat = 0;
  state.currentLevel = 14;
  state.levelOwner = 0;
  state.levels = [14, 3];
  state.finishOrder = [2];
  state.hands = [[C(4)], [C(8), C(9)], [], [C(10), C(11)]];
  state.handCounts = state.hands.map((hand) => hand.length);
  humanSelectSet(state, [state.hands[0][0].id]);
  humanPlay(state);
  assert(state.phase === PHASE.MATCH_END && state.winner === 0,
    '本副确实由我方打A且我方双上时，才判定整场胜利');
}

{
  const state = createMatch({ difficulty: 'normal', aiSpeed: 'slow', coachMode: false });
  state.phase = PHASE.PLAYING;
  state.currentSeat = 0;
  state.currentLevel = 14;
  state.levelOwner = 0;
  state.levels = [14, 3];
  state.aFailCount = [2, 0];
  state.finishOrder = [1, 3];
  state.hands = [[C(4)], [], [C(8), C(9)], []];
  state.handCounts = state.hands.map((hand) => hand.length);
  humanSelectSet(state, [state.hands[0][0].id]);
  humanPlay(state);
  assert(state.phase === PHASE.ROUND_END && state.winner === null,
    '本方打A未取得头游加二游/三游时不结束整场');
  assert(state.levels[0] === 2 && state.aFailCount[0] === 0,
    '连续第三次在本方A级失败后轮回打2');
}

console.log('出完后的接风判定');
{
  const state = createMatch({ difficulty: 'normal', aiSpeed: 'slow', coachMode: false });
  state.phase = PHASE.PLAYING;
  state.currentLevel = 3;
  state.finishOrder = [3];
  state.lastSeat = 3;
  state.lastHand = parseHand([C(13, 'S'), C(13, 'D')], 3);
  state.currentSeat = 0;
  state.passCount = 0;
  state.hands = [[C(9, 'S'), C(9, 'D')], [C(6)], [C(8, 'S'), C(8, 'D')], []];
  state.handCounts = state.hands.map((hand) => hand.length);

  const firstPass = humanPass(state);
  assert(firstPass.ok, '一名对手可对出完者的最后一手选择过牌');
  assert(state.currentSeat === 2,
    '等待接风的对家不参与压牌，出牌顺序直接轮到另一名对手');
}

{
  const state = createMatch({ difficulty: 'normal', aiSpeed: 'slow', coachMode: false });
  state.phase = PHASE.PLAYING;
  state.currentLevel = 3;
  state.finishOrder = [1];
  state.lastSeat = 1;
  state.lastHand = parseHand([C(13, 'S'), C(13, 'D')], 3);
  state.currentSeat = 0;
  state.passCount = 1; // 另一名对手已经过牌
  state.hands = [[C(9, 'S'), C(9, 'D')], [], [C(8, 'S'), C(8, 'D')], [C(6)]];
  state.handCounts = state.hands.map((hand) => hand.length);

  const secondPass = humanPass(state);
  assert(secondPass.ok, '第二名对手也可选择过牌');
  assert(state.lastHand === null && state.currentSeat === 3,
    '两名对手都过牌后，由出完者的对家直接接风领出');
  assert(state.messages.some((message) => String(message.text || message).includes('接风')),
    '牌局日志明确记录接风');
}

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
