/** 完整一副自动回归：真人位使用最小合法提示，其他座位使用 AI。 */
import {
  createMatch, startMatch, humanPlay, humanPass, humanSelectSet,
  humanPickReturnCard, humanConfirmReturn, getLegalHints, getReturnCandidates,
  setUpdateCallback, PHASE,
} from './game.js';

const state = createMatch({ difficulty: 'easy', aiSpeed: 'fast', coachMode: false });
let pumping = false;
let finished = false;
let failure = null;

function schedulePump() {
  if (pumping || finished) return;
  pumping = true;
  setTimeout(() => {
    pumping = false;
    try { pump(); } catch (error) { failure = error; finish(); }
  }, 0);
}

function pump() {
  if (state.phase === PHASE.RETURN) {
    const candidates = getReturnCandidates(state);
    if (candidates.length) {
      const picked = humanPickReturnCard(state, candidates[0].id);
      if (!picked.ok) throw new Error(picked.reason);
      const confirmed = humanConfirmReturn(state);
      if (!confirmed.ok) throw new Error(confirmed.reason);
    }
    return;
  }

  if (state.phase === PHASE.PLAYING && state.currentSeat === 0 && !state.finishOrder.includes(0)) {
    const hints = getLegalHints(state);
    if (hints.length) {
      const play = hints[0];
      humanSelectSet(state, play.cards.map((card) => card.id), play.signature, 'integration_hint');
      const result = humanPlay(state);
      if (!result.ok) throw new Error(result.reason);
    } else {
      const result = humanPass(state);
      if (!result.ok) throw new Error(result.reason);
    }
    return;
  }

  if (state.phase === PHASE.ROUND_END || state.phase === PHASE.MATCH_END) finish();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
  console.log('  ✓', message);
}

function finish() {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  if (failure) {
    console.error('  ✗', failure.message);
    process.exit(1);
  }
  try {
    const replay = state.lastReplay;
    assert(state.finishOrder.length === 4, '完整产生四个名次');
    assert(replay?.initialHands?.length === 4, '复盘保存四家初始牌面');
    assert(replay?.trickLog?.length > 0, '复盘保存逐手时间线');
    assert(replay.trickLog.every((line) => line.turn && line.trickNumber && line.countsAfter), '每手保存圈号与剩余张数');
    assert(replay.trickLog.some((line) => line.seat === 0 && line.evaluation), '真人动作与评价一一关联');
    assert(replay.roundSummary?.dimensionAverages, '复盘保存五维总结');
    console.log(`\n结果: 完整一副 ${replay.trickLog.length} 手，回归通过`);
    process.exit(0);
  } catch (error) {
    console.error('  ✗', error.message);
    process.exit(1);
  }
}

const timeout = setTimeout(() => {
  failure = new Error('完整一副在 45 秒内未结束');
  finish();
}, 45000);

setUpdateCallback(schedulePump);
startMatch(state);
schedulePump();
