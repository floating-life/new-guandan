/** 完整一副自动回归：真人位使用最小合法提示，其他座位使用 AI。 */
import {
  createMatch, startMatch, humanPlay, humanPass, humanSelectSet,
  humanPickReturnCard, humanConfirmReturn, getLegalHints, getReturnCandidates,
  setUpdateCallback, setReplayEventObserver, serializeMatchState, PHASE,
} from './game.js';
import { validateLiveEventChain } from './replay-contracts.js';
import {
  convertSealedTrainingBatches,
  getSealedTrainingBatch,
  replaySealedTrainingBatch,
  SEALED_STATE_KEYS,
} from './sealed-training.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
  console.log('  ✓', message);
}

function runMatch({ label, disableCapture = false, verify }) {
  return new Promise((resolve) => {
    const settings = { difficulty: 'easy', aiSpeed: 'fast', coachMode: false };
    if (disableCapture) settings.sealedTraining = false;
    const state = createMatch(settings);
    let pumping = false;
    let finished = false;
    const replayEvents = [];
    const timeout = setTimeout(() => {
      if (finished) return;
      finished = true;
      console.error('  ✗', `${label} 在 45 秒内未结束`);
      process.exit(1);
    }, 45000);

    function finish(failure = null) {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (failure) {
        console.error('  ✗', failure.message);
        process.exit(1);
      }
      try {
        verify(state, replayEvents);
        setReplayEventObserver(null);
        resolve();
      } catch (error) {
        console.error('  ✗', error.message);
        process.exit(1);
      }
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

    function schedulePump() {
      if (pumping || finished) return;
      pumping = true;
      setTimeout(() => {
        pumping = false;
        try { pump(); } catch (error) { finish(error); }
      }, 0);
    }

    setUpdateCallback(schedulePump);
    setReplayEventObserver((event) => replayEvents.push(event));
    startMatch(state);
    schedulePump();
  });
}

function verifyCapturedMatch(state, replayEvents) {
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
    && !('legalCandidates' in event) && event.trainingEligible == null
    && event.cards.every((card) => !('id' in card) && !('deckIndex' in card))
    && event.tribute.every((item) => !('id' in item.card) && !('deckIndex' in item.card))),
  '真实公开事件不包含四家暗牌、终局手牌、实体牌 ID/副本索引或密封训练字段');
  const sealedBatch = getSealedTrainingBatch(state);
  const actionCount = replay.trickLog.filter((line) => line.action === 'play' || line.action === 'pass').length;
  assert(sealedBatch && sealedBatch.trainingEligible === false && sealedBatch.turns.length === actionCount,
    '副末密封批次覆盖全部行动 turn 且不可训练');
  assert(sealedBatch.finishOrder.length === 4 && sealedBatch.teamUtilities[0] === -sealedBatch.teamUtilities[1],
    '密封批次连接真实名次和相反的团队收益');
  assert(replaySealedTrainingBatch(sealedBatch).ok, '完整一副密封批次可规则重放');
  const converted = convertSealedTrainingBatches([sealedBatch]);
  assert(converted.ok && converted.manifest.trainingEligible === false && converted.manifest.acceptedMatchRounds === 1,
    '转换器按完整 match 切分且保持 trainingEligible=false');
  const snapshot = serializeMatchState(state);
  assert(SEALED_STATE_KEYS.every((key) => !(key in snapshot)),
    '进行中存档不保存密封训练内容');
  console.log(`  … 完整一副（捕获开启）${replay.trickLog.length} 手`);
}

function verifyCaptureDisabledMatch(state, replayEvents) {
  assert(state.finishOrder.length === 4, '关闭捕获时完整一副仍正常产生四个名次');
  const actionEvents = replayEvents.filter((event) => ['play', 'pass'].includes(event.eventType));
  assert(actionEvents.length > 0 && new Set(actionEvents.map((event) => event.seat)).size === 4,
    '关闭捕获时公开事件流仍从真实动作边界发出');
  const chain = validateLiveEventChain(replayEvents);
  assert(chain.ok && state.replayEventFailures === 0, '关闭捕获时公开事件链仍连续且无构造失败');
  assert(state.sealedTrainingTurns.length === 0 && getSealedTrainingBatch(state) === null
    && state.sealedTrainingHistory.length === 0,
  '关闭捕获时不记录密封 turn、不生成批次、不留存历史');
  assert(state.sealedTrainingFailures === 0 && state.sealedTrainingLastError === null,
  '关闭捕获时零密封失败、无 turn/动作数量不一致误报');
  const snapshot = serializeMatchState(state);
  assert(SEALED_STATE_KEYS.every((key) => !(key in snapshot)),
    '关闭捕获时存档同样不含任何密封字段（含捕获开关本身）');
  console.log(`  … 完整一副（捕获关闭）${state.trickLog.length} 手`);
}

await runMatch({ label: '完整一副（捕获开启）', verify: verifyCapturedMatch });
await runMatch({ label: '完整一副（捕获关闭）', disableCapture: true, verify: verifyCaptureDisabledMatch });
console.log('\n结果: 完整一副双向回归通过（捕获开启/关闭）');
process.exit(0);
