/** 完整一副自动回归：真人位使用最小合法提示，其他座位使用 AI。 */
import {
  createMatch, startMatch, humanPlay, humanPass, humanSelectSet,
  humanPickReturnCard, humanConfirmReturn, getLegalHints, getReturnCandidates,
  setUpdateCallback, setReplayEventObserver, PHASE,
} from './game.js';
import { validateLiveEventChain } from './replay-contracts.js';

const state = createMatch({ difficulty: 'easy', aiSpeed: 'fast', coachMode: false });
let pumping = false;
let finished = false;
let failure = null;
const replayEvents = [];

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
    assert(replay.trickLog.filter((line) => line.seat !== 0).every((line) => (
      Number.isFinite(line.decisionMeta?.localDecision?.budgetMs)
      && (line.decisionMeta.localDecision.latencyMs == null
        || Number.isFinite(line.decisionMeta.localDecision.latencyMs))
    )), '复盘逐手保存本地AI搜索预算与耗时，便于区分策略问题和超时降级');
    assert(replay.roundSummary?.dimensionAverages, '复盘保存五维总结');
    assert(replay.llmReport && Number.isFinite(replay.llmReport.cloudCalls)
      && Number.isFinite(replay.llmReport.successes), '复盘保存云端 API 调用报告');
    assert(replay.localAiEngine === 'expert', '复盘保存本副使用的本地决策引擎');
    const actionEvents = replayEvents.filter((event) => ['play', 'pass'].includes(event.eventType));
    assert(new Set(actionEvents.map((event) => event.seat)).size === 4,
      '真实一副牌的真人与三个AI均从动作提交边界发出公开事件');
    const chain = validateLiveEventChain(replayEvents);
    assert(chain.ok && state.replayEventFailures === 0,
      `真实事件流 sequence、eventId 与前序摘要链连续且无构造失败${chain.ok && state.replayEventFailures === 0 ? '' : `：${chain.errors.slice(0, 3).join('|')}；序号 ${replayEvents.map((event) => event.sequence).join(',')}；构造失败 ${state.replayEventFailures}（${state.replayLastEventError || '无'}）`}`);
    assert(replayEvents.some((event) => event.eventType === 'trick_end')
      && replayEvents.filter((event) => event.eventType === 'round_end').length === 1,
    '真实事件流覆盖 trick_end 与 round_end，且副末只发一次 round_end');
    assert(replayEvents.every((event) => !('hands' in event)
      && !('initialHands' in event) && !('remainingHands' in event)
      && event.cards.every((card) => !('id' in card) && !('deckIndex' in card))
      && event.tribute.every((item) => !('id' in item.card) && !('deckIndex' in item.card))),
    '真实公开事件不包含四家暗牌、终局手牌或实体牌 ID/副本索引');
    console.log(`\n结果: 完整一副 ${replay.trickLog.length} 手，回归通过`);
    setReplayEventObserver(null);
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
setReplayEventObserver((event) => replayEvents.push(event));
startMatch(state);
schedulePump();
