/**
 * 可复现的 AI 策略 A/B 镜像赛。
 *
 * 用法：
 *   node js/ai.ab.simulation.js [种子组数=30] [基础种子=20260801]
 *     [候选策略=expert] [对照策略=baseline] [--levels=all|2,3,...,A]
 *     [--level-blocks] [--continuous-match] [--trace-divergence] [--summary-only]
 *     [--value-model=C:\路径\实验模型.json]
 *     [--report=C:\路径\A-B报告.json]
 *
 * 每个种子发两次完全相同的牌：
 *   1. candidate 坐 0+2，comparison 坐 1+3；
 *   2. comparison 坐 0+2，candidate 坐 1+3。
 * 所有座位都通过 chooseAIPlay，以 master + deterministic 作出决定。
 * 可用策略还包括 no-control-v2 与五个 only-* 控制策略独立消融臂。
 */
import { performance } from 'node:perf_hooks';
import fs from 'node:fs';
import path from 'node:path';

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realRandom = Math.random;

// 跳过界面动画等待，但仍通过 game.js 的正式状态推进流程。
globalThis.setTimeout = (fn) => {
  queueMicrotask(fn);
  return 1;
};
globalThis.clearTimeout = () => {};

const {
  createMatch,
  startMatch,
  humanPlay,
  humanPass,
  humanSelectSet,
  humanPickReturnCard,
  humanConfirmReturn,
  getReturnCandidates,
  nextRound,
  setUpdateCallback,
  setAIDecisionObserver,
  PHASE,
  TEAM_OF,
} = await import('./game.js');
const {
  chooseAIPlay, chooseReturnCard, resolvePolicyVariant, AI_POLICY_VARIANTS,
} = await import('./ai.js');
const { describeUpgrade, handSignature } = await import('./rules.js');
const { sortHand } = await import('./cards.js');
const {
  configureHybridValueModel, validateHybridValueModel,
} = await import('./ai-hybrid.js');
const {
  createSeedManifest, seedManifestOverlap, valueModelStatus,
} = await import('./value-model-gate.js');
const { modelPayloadSha256 } = await import('./model-fingerprint.js');

const groupCount = positiveInteger(process.argv[2], 30);
const baseSeed = finiteUint32(process.argv[3], 20260801);
const evaluationSeedManifest = createSeedManifest(Array.from(
  { length: groupCount }, (_, index) => (baseSeed + index) >>> 0,
));
const candidateName = policyVariantName(process.argv[4], 'expert');
const comparisonName = policyVariantName(process.argv[5], 'baseline');
const jsonOnly = process.argv.includes('--json');
const evaluationLevels = parseEvaluationLevels(process.argv);
const levelBlockDesign = process.argv.includes('--level-blocks');
const continuousMatch = process.argv.includes('--continuous-match');
const traceDivergence = process.argv.includes('--trace-divergence');
// 大样本门禁只需要汇总量。省略逐副明细可显著降低子进程 JSON 序列化、
// 内存复制和父进程解析成本，不改变任何对局或统计口径。
const summaryOnly = process.argv.includes('--summary-only');
const MAX_ACTIONS = continuousMatch ? 30_000 : 2000;
const MAX_MATCH_ROUNDS = 80;
const GAME_TIMEOUT_MS = 180_000;
// M3 发布质量报告将一副至少 120 次行动的牌局视为“长局”。阈值写入
// 报告本身，避免后续按不同口径回看同一场连续赛。
const LONG_ROUND_ACTIONS = 120;
const CANDIDATE = resolvePolicyVariant(candidateName);
const COMPARISON = resolvePolicyVariant(comparisonName);
const valueModelFlag = process.argv.find((item) => String(item).startsWith('--value-model='));
const valueModelPath = valueModelFlag
  ? path.resolve(String(valueModelFlag).slice('--value-model='.length)) : null;
const reportFlag = process.argv.find((item) => String(item).startsWith('--report='));
const reportPath = reportFlag
  ? path.resolve(String(reportFlag).slice('--report='.length)) : null;
const checkpointFlag = process.argv.find((item) => String(item).startsWith('--checkpoint='));
const checkpointPath = checkpointFlag
  ? path.resolve(String(checkpointFlag).slice('--checkpoint='.length)) : null;
const resumeCheckpoint = process.argv.includes('--resume');
let valueModelAudit = null;
if (valueModelPath) {
  if (!['hybrid', 'ismcts'].includes(CANDIDATE.decisionEngine)) {
    throw new Error('--value-model 只可用于 hybrid-v1 或 root-pimc-v1 候选策略（ismcts-v1 仅为历史兼容别名）');
  }
  // 当前价值模型是进程级配置。为保证对照组绝不读取候选权重，带模型的
  // 发布赛强制以稳定 expert 为对照；同引擎无模型消融应另起独立进程实现。
  if (COMPARISON.name !== 'expert') {
    throw new Error('--value-model 的对照策略必须是 expert，避免权重污染对照组');
  }
  const model = JSON.parse(fs.readFileSync(valueModelPath, 'utf8'));
  const validation = validateHybridValueModel(model);
  if (!validation.ok) throw new Error(`价值模型格式无效：${validation.reason}`);
  const trainingSeedManifest = model.metadata?.trainingSeedManifest
    || model.metadata?.trainingData?.seedManifest || null;
  const overlappingSeeds = seedManifestOverlap(evaluationSeedManifest, trainingSeedManifest);
  if (overlappingSeeds.length) {
    throw new Error(`评测种子与训练种子重叠（${overlappingSeeds.slice(0, 8).join(', ')}${
      overlappingSeeds.length > 8 ? '…' : ''}）；请改用未见种子后再启动 A/B`);
  }
  const configured = configureHybridValueModel(model, { allowExperimental: true });
  if (!configured.ok) throw new Error(`价值模型无法用于离线A/B：${configured.reason}`);
  valueModelAudit = {
    id: validation.model.id,
    status: valueModelStatus(model),
    sha256: modelPayloadSha256(model),
    trainingSeedManifest,
    trainingDatasetSha256: model.metadata?.trainingData?.sha256 || null,
  };
}

let activeRun = null;
let processing = false;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function finiteUint32(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed >>> 0 : fallback >>> 0;
}

function policyVariantName(value, fallback) {
  const name = String(value || fallback).trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(AI_POLICY_VARIANTS, name)) {
    throw new Error(
      `未知策略“${name}”；可选：${Object.keys(AI_POLICY_VARIANTS).join('、')}`,
    );
  }
  return name;
}

function parseEvaluationLevels(args) {
  const flag = args.find((item) => String(item).startsWith('--levels='));
  const raw = flag ? String(flag).slice('--levels='.length).trim() : 'all';
  if (!raw || raw.toLowerCase() === 'all') {
    return Array.from({ length: 13 }, (_, index) => index + 2);
  }
  const rank = (token) => {
    const normalized = String(token).trim().toUpperCase();
    if (normalized === 'A') return 14;
    if (normalized === 'K') return 13;
    if (normalized === 'Q') return 12;
    if (normalized === 'J') return 11;
    const value = Number(normalized);
    return Number.isInteger(value) && value >= 2 && value <= 14 ? value : null;
  };
  const levels = [...new Set(raw.split(',').map(rank).filter(Number.isInteger))];
  if (!levels.length) throw new Error(`无有效评测级牌：${raw}`);
  return levels;
}

function forceEvaluationLevel(state, level) {
  state.currentLevel = level;
  state.levels = [level, level];
  state.levelOwner = 0;
  state.hands = state.hands.map((hand) => sortHand(hand, level));
  state.handCounts = state.hands.map((hand) => hand.length);
}

function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let mixed = value;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function publicCard(card) {
  return {
    id: String(card.id),
    rank: card.rank,
    suit: card.suit,
    deckIndex: card.deckIndex,
  };
}

/** 仅返回牌桌上所有玩家都能看到的行动，不带评价、理由、暗牌或初始牌面。 */
function publicActionHistory(state) {
  return state.trickLog.map((item) => ({
    turn: item.turn,
    trickNumber: item.trickNumber,
    seat: item.seat,
    action: item.action,
    cards: item.action === 'play' ? (item.cards || []).map(publicCard) : [],
    hand: item.action === 'play' && item.hand ? {
      type: item.hand.type,
      mainRank: item.hand.mainRank,
      size: item.hand.size,
      power: item.hand.power,
    } : null,
    countsBefore: Array.isArray(item.countsBefore) ? item.countsBefore.slice(0, 4) : [],
    countsAfter: Array.isArray(item.countsAfter) ? item.countsAfter.slice(0, 4) : [],
  }));
}

function publicTributeContext(state, seat) {
  const ts = state.tributeState;
  if (!ts) return null;
  const gave = (ts.tributes || []).find((item) => item.from === seat) || null;
  const received = (ts.returns || []).find((item) => item.to === seat) || null;
  const face = (card) => (card
    ? { rank: card.rank, suit: card.suit, deckIndex: card.deckIndex }
    : null);
  const knownTransfers = [
    ...(ts.tributes || []).map((item) => ({
      kind: 'tribute', from: item.from, to: item.to, card: face(item.card),
    })),
    ...(ts.returns || []).map((item) => ({
      kind: 'return', from: item.from, to: item.to, card: face(item.card),
    })),
  ].filter((item) => item.card);
  if (!gave && !received && !knownTransfers.length) return null;
  return {
    gaveCard: face(gave?.card),
    gaveTo: gave?.to ?? null,
    receivedReturnCard: face(received?.card),
    receivedFrom: received?.from ?? null,
    firstLeadAfterTribute: state.firstPlayer === seat && state.trickLog.length === 0,
    doubleDown: !!ts.doubleDown,
    knownTransfers,
  };
}

function isBombish(hand) {
  return !!hand && ['bomb', 'flush_straight', 'joker_bomb'].includes(hand.type);
}

function leadAfterOwnBomb(state, seat) {
  if (state.lastHand || state.currentTrickStartIndex <= 0) return false;
  for (let i = Math.min(state.currentTrickStartIndex, state.trickLog.length) - 1; i >= 0; i--) {
    const item = state.trickLog[i];
    if (item.action !== 'play') continue;
    return item.seat === seat && isBombish(item.hand);
  }
  return false;
}

/** AI 的白名单视图：只有自己的手牌和公开牌桌信息。 */
function decisionView(run, seat, variant = run.variantBySeat[seat]) {
  const state = run.state;
  return {
    seat,
    hand: state.hands[seat].map(publicCard),
    level: state.currentLevel,
    lastHand: state.lastHand ? { ...state.lastHand } : null,
    lastSeat: state.lastSeat,
    handCounts: state.handCounts.slice(0, 4),
    teams: TEAM_OF.slice(0, 4),
    finishOrder: state.finishOrder.slice(0, 4),
    playedCards: state.trickLog.flatMap((item) => (
      item.action === 'play' ? (item.cards || []).map(publicCard) : []
    )),
    publicHistory: publicActionHistory(state),
    tributeContext: publicTributeContext(state, seat),
    leadAfterOwnBomb: leadAfterOwnBomb(state, seat),
    difficulty: 'master',
    deterministic: true,
    policyProfile: variant.policyProfile,
    policyFeatures: variant.policyFeatures,
    policyThresholds: variant.policyThresholds,
    decisionEngine: variant.decisionEngine,
  };
}

function decisionKey(decision) {
  if (!decision || decision.action === 'pass') return 'pass';
  const cards = (decision.cards || []).map((card) => String(card.id)).sort().join(',');
  return `play:${cards}|${decision.signature || handSignature(decision.hand)}`;
}

function compactDecision(decision) {
  if (!decision) return { action: 'pass' };
  const compact = {
    action: decision.action === 'pass' ? 'pass' : 'play',
    ...(decision.hybrid ? {
      hybrid: {
        applied: decision.hybrid.applied === true,
        reason: decision.hybrid.reason || null,
        localCandidateId: decision.hybrid.localCandidateId || null,
        finalCandidateId: decision.hybrid.finalCandidateId || null,
        changedDecision: decision.hybrid.changedDecision === true,
        searchMode: decision.hybrid.searchMode || null,
        iterations: Number(decision.hybrid.iterations) || 0,
        samples: Number(decision.hybrid.samples) || 0,
        nodes: Number(decision.hybrid.nodes) || 0,
        candidates: Array.isArray(decision.hybrid.candidates)
          ? decision.hybrid.candidates.slice(0, 3) : [],
      },
    } : {}),
  };
  if (decision.action === 'pass') return compact;
  return {
    ...compact,
    cards: (decision.cards || []).map((card) => String(card.id)).sort(),
    hand: decision.hand ? {
      type: decision.hand.type,
      mainRank: decision.hand.mainRank,
      size: decision.hand.size,
      power: decision.hand.power,
    } : null,
    signature: decision.signature || handSignature(decision.hand),
  };
}

function createHybridCounters() {
  return {
    turns: 0,
    applied: 0,
    changed: 0,
    samples: 0,
    nodes: 0,
    iterations: 0,
    searchModes: {},
    reasons: {},
    rejected: {},
  };
}

function recordHybridDecision(run, decision) {
  const hybrid = decision?.hybrid;
  if (!hybrid || !run?.hybrid) return;
  run.hybrid.turns += 1;
  run.hybrid.applied += Number(hybrid.applied === true);
  run.hybrid.changed += Number(hybrid.changedDecision === true);
  run.hybrid.samples += Number(hybrid.samples) || 0;
  run.hybrid.nodes += Number(hybrid.nodes) || 0;
  run.hybrid.iterations += Number(hybrid.iterations) || 0;
  const searchMode = String(hybrid.searchMode || 'none');
  run.hybrid.searchModes[searchMode] = (run.hybrid.searchModes[searchMode] || 0) + 1;
  const reason = String(hybrid.reason || 'unknown');
  run.hybrid.reasons[reason] = (run.hybrid.reasons[reason] || 0) + 1;
  const rejectionEntries = hybrid.rejectionSummary
    ? Object.entries(hybrid.rejectionSummary)
    : (hybrid.rejectedCandidates || []).map((item) => [item?.reason || 'unknown', 1]);
  for (const [key, count] of rejectionEntries) {
    const rejectedReason = String(key || 'unknown');
    run.hybrid.rejected[rejectedReason] = (run.hybrid.rejected[rejectedReason] || 0)
      + (Number(count) || 0);
  }
}

/** 在完全相同的本家牌与公开信息上做影子策略比较，不执行影子动作。 */
function traceFirstDivergence(run, seat, baseContext = null, actualDecision = null) {
  if (!traceDivergence || run.firstDivergence) return;
  const publicContext = baseContext || decisionView(run, seat);
  const candidateDecision = chooseAIPlay({
    ...publicContext,
    deterministic: true,
    timeBudgetMs: 0,
    policyProfile: CANDIDATE.policyProfile,
    policyFeatures: CANDIDATE.policyFeatures,
    policyThresholds: CANDIDATE.policyThresholds,
    decisionEngine: CANDIDATE.decisionEngine,
  });
  const comparisonDecision = chooseAIPlay({
    ...publicContext,
    deterministic: true,
    timeBudgetMs: 0,
    policyProfile: COMPARISON.policyProfile,
    policyFeatures: COMPARISON.policyFeatures,
    policyThresholds: COMPARISON.policyThresholds,
    decisionEngine: COMPARISON.decisionEngine,
  });
  if (decisionKey(candidateDecision) === decisionKey(comparisonDecision)) return;
  run.firstDivergence = {
    round: run.state.round,
    turn: run.state.trickLog.length + 1,
    trickNumber: run.state.trickNumber,
    seat,
    level: run.state.currentLevel,
    lastHand: publicContext.lastHand ? {
      type: publicContext.lastHand.type,
      mainRank: publicContext.lastHand.mainRank,
      size: publicContext.lastHand.size,
      power: publicContext.lastHand.power,
    } : null,
    lastSeat: publicContext.lastSeat,
    handCounts: publicContext.handCounts.slice(0, 4),
    publicActions: publicContext.publicHistory.length,
    actualPolicy: run.variantBySeat[seat].name,
    actual: compactDecision(actualDecision),
    candidate: compactDecision(candidateDecision),
    comparison: compactDecision(comparisonDecision),
  };
}

function playSeatZero(run) {
  const state = run.state;
  const view = decisionView(run, 0);
  const decision = chooseAIPlay(view);
  recordHybridDecision(run, decision);
  traceFirstDivergence(run, 0, view, decision);
  if (!decision) throw new Error('chooseAIPlay 在领出时没有返回出牌');
  if (decision.action === 'pass') {
    if (!state.lastHand) throw new Error('chooseAIPlay 在领出时错误地选择过牌');
    const result = humanPass(state);
    if (!result?.ok) throw new Error(result?.reason || '0号位过牌失败');
    return;
  }
  humanSelectSet(
    state,
    decision.cards.map((card) => card.id),
    decision.signature || handSignature(decision.hand),
    null,
  );
  const result = humanPlay(state);
  if (!result?.ok) throw new Error(result?.reason || '0号位出牌失败');
}

function handleReturn(state) {
  const task = state.tributeState?.pendingReturns?.[0];
  if (!task || task.from !== 0) return;
  const candidates = getReturnCandidates(state);
  if (!candidates.length) throw new Error('0号位没有可用还贡牌');
  const preferred = chooseReturnCard(state.hands[0].slice(), state.currentLevel, {
    toPartner: TEAM_OF[task.from] === TEAM_OF[task.to],
  });
  const card = candidates.find((item) => item.id === preferred?.id) || candidates[0];
  const pick = humanPickReturnCard(state, card.id);
  if (!pick?.ok) throw new Error(pick?.reason || '0号位选择还贡牌失败');
  const confirm = humanConfirmReturn(state);
  if (!confirm?.ok) throw new Error(confirm?.reason || '0号位确认还贡失败');
}

function dealFingerprint(state) {
  const hands = state.roundInitialHands || state.hands;
  return hands.map((hand) => hand.map((card) => (
    `${card.rank}:${card.suit}:${card.deckIndex}`
  )).sort().join(',')).join('|');
}

function fallbackCount(state) {
  return state.trickLog.filter((item) => (
    item.action === 'play'
    && typeof item.decisionMeta?.reason === 'string'
    && item.decisionMeta.reason.includes('兜底')
  )).length;
}

function recordCompletedRound(run) {
  const state = run.state;
  if (run.lastRecordedRound === state.round) return;
  const order = state.finishOrder.slice();
  if (order.length !== 4 || new Set(order).size !== 4) return;
  const headTeam = TEAM_OF[order[0]];
  const upgrade = describeUpgrade(order, (seat) => TEAM_OF[seat]).levels;
  const aAttempt = state.currentLevel === 14;
  const aPassed = aAttempt && state.phase === PHASE.MATCH_END;
  const aFailed = aAttempt && !aPassed;
  run.totalActions += state.trickLog.length;
  run.totalFallbacks += fallbackCount(state);
  run.roundResults.push({
    round: state.round,
    level: state.currentLevel,
    levelsAfter: state.levels.slice(0, 2),
    levelOwner: state.levelOwner,
    order,
    upgrade,
    candidateUtility: headTeam === run.candidateTeam ? upgrade : -upgrade,
    aFailCount: state.aFailCount.slice(0, 2),
    aAttempt,
    aPassed,
    aFailed,
    aReset: aFailed && state.aFailCount[state.levelOwner] === 0,
    tribute: !!state.tributeState,
    actions: state.trickLog.length,
  });
  run.lastRecordedRound = state.round;
}

function finishRun(run, result) {
  if (activeRun !== run || run.done) return;
  run.done = true;
  realClearTimeout(run.timeoutId);
  activeRun = null;
  run.resolve(result);
}

function successfulResult(run) {
  const { state, candidateTeam } = run;
  const order = state.finishOrder.slice();
  if (order.length !== 4 || new Set(order).size !== 4) {
    return {
      ok: false,
      deadlock: false,
      reason: `终局名次无效：${order.join('-')}`,
      durationMs: performance.now() - run.startedAt,
    };
  }
  recordCompletedRound(run);
  const fallbacks = run.totalFallbacks;
  if (fallbacks > 0) {
    return {
      ok: false,
      deadlock: false,
      reason: `出现 ${fallbacks} 次非 chooseAIPlay 兜底出牌`,
      durationMs: performance.now() - run.startedAt,
    };
  }
  const headTeam = TEAM_OF[order[0]];
  const upgrade = describeUpgrade(order, (seat) => TEAM_OF[seat]).levels;
  const doubleUp = TEAM_OF[order[0]] === TEAM_OF[order[1]];
  if (continuousMatch) {
    if (state.phase !== PHASE.MATCH_END || ![0, 1].includes(state.winner)) {
      return {
        ok: false,
        deadlock: false,
        reason: '连续比赛未产生合法胜方',
        durationMs: performance.now() - run.startedAt,
      };
    }
    const candidateWon = state.winner === candidateTeam;
    return {
      ok: true,
      seed: run.seed,
      level: run.level,
      candidateTeam,
      order,
      firstPlayer: run.firstPlayer,
      dealFingerprint: run.dealFingerprint,
      upgrade: 1,
      utility: candidateWon ? 1 : -1,
      candidateHead: candidateWon,
      comparisonHead: !candidateWon,
      baselineHead: !candidateWon,
      candidateDoubleUp: false,
      comparisonDoubleUp: false,
      baselineDoubleUp: false,
      matchWinner: state.winner,
      rounds: run.roundResults.length,
      roundUpgradeUtility: run.roundResults.reduce(
        (sum, item) => sum + item.candidateUtility, 0,
      ),
      roundResults: run.roundResults,
      firstDivergence: run.firstDivergence,
      hybrid: run.hybrid,
      actions: run.totalActions,
      durationMs: performance.now() - run.startedAt,
    };
  }
  return {
    ok: true,
    seed: run.seed,
    level: run.level,
    candidateTeam,
    order,
    firstPlayer: run.firstPlayer,
    dealFingerprint: run.dealFingerprint,
    upgrade,
    utility: headTeam === candidateTeam ? upgrade : -upgrade,
    candidateHead: headTeam === candidateTeam,
    comparisonHead: headTeam !== candidateTeam,
    baselineHead: headTeam !== candidateTeam,
    candidateDoubleUp: doubleUp && headTeam === candidateTeam,
    comparisonDoubleUp: doubleUp && headTeam !== candidateTeam,
    baselineDoubleUp: doubleUp && headTeam !== candidateTeam,
    firstDivergence: run.firstDivergence,
    hybrid: run.hybrid,
    actions: run.totalActions,
    durationMs: performance.now() - run.startedAt,
  };
}

function pump() {
  if (processing || !activeRun) return;
  processing = true;
  queueMicrotask(() => {
    const run = activeRun;
    try {
      if (!run) return;
      const state = run.state;
      if (run.totalActions + state.trickLog.length > MAX_ACTIONS) {
        finishRun(run, {
          ok: false,
          deadlock: true,
          reason: `行动数超过 ${MAX_ACTIONS}`,
          durationMs: performance.now() - run.startedAt,
        });
      } else if (state.phase === PHASE.RETURN) {
        handleReturn(state);
      } else if (state.phase === PHASE.PLAYING
        && state.currentSeat === 0
        && !state.finishOrder.includes(0)) {
        playSeatZero(run);
      } else if (state.phase === PHASE.ROUND_END && continuousMatch) {
        recordCompletedRound(run);
        if (run.roundResults.length >= MAX_MATCH_ROUNDS) {
          finishRun(run, {
            ok: false,
            deadlock: true,
            reason: `连续比赛超过 ${MAX_MATCH_ROUNDS} 副仍未结束`,
            durationMs: performance.now() - run.startedAt,
          });
        } else {
          nextRound(state);
        }
      } else if (state.phase === PHASE.ROUND_END || state.phase === PHASE.MATCH_END) {
        finishRun(run, successfulResult(run));
      }
    } catch (error) {
      finishRun(run, {
        ok: false,
        deadlock: false,
        reason: error instanceof Error ? error.message : String(error),
        durationMs: performance.now() - run.startedAt,
      });
    } finally {
      processing = false;
      if (activeRun) pump();
    }
  });
}

setUpdateCallback(pump);
setAIDecisionObserver(({ seat, context, decision }) => {
  if (activeRun) {
    recordHybridDecision(activeRun, decision);
    traceFirstDivergence(activeRun, seat, context, decision);
  }
});
const heartbeat = globalThis.setInterval(pump, 5);

async function playGame({ seed, candidateTeam, level }) {
  Math.random = seededRandom(seed);
  const variantBySeat = TEAM_OF.map((team) => (
    team === candidateTeam ? CANDIDATE : COMPARISON
  ));
  const state = createMatch({
    difficulty: 'master',
    aiSpeed: 'fast',
    coachMode: false,
    deterministicAI: true,
    aiDifficultyBySeat: ['master', 'master', 'master', 'master'],
    aiPolicyBySeat: variantBySeat.map((variant) => variant.policyProfile),
    aiPolicyFeaturesBySeat: variantBySeat.map((variant) => ({ ...variant.policyFeatures })),
    aiPolicyThresholdsBySeat: variantBySeat.map((variant) => (
      variant.policyThresholds ? { ...variant.policyThresholds } : null
    )),
    aiDecisionEngineBySeat: variantBySeat.map((variant) => variant.decisionEngine),
  });

  return new Promise((resolve) => {
    const run = {
      state,
      seed,
      level,
      candidateTeam,
      variantBySeat,
      resolve,
      done: false,
      startedAt: performance.now(),
      timeoutId: null,
      firstPlayer: null,
      dealFingerprint: null,
      firstDivergence: null,
      roundResults: [],
      lastRecordedRound: 0,
      totalActions: 0,
      totalFallbacks: 0,
      hybrid: createHybridCounters(),
    };
    activeRun = run;
    run.timeoutId = realSetTimeout(() => {
      finishRun(run, {
        ok: false,
        deadlock: true,
        reason: `超过 ${GAME_TIMEOUT_MS / 1000} 秒未结束`,
        durationMs: performance.now() - run.startedAt,
      });
    }, continuousMatch ? GAME_TIMEOUT_MS * 3 : GAME_TIMEOUT_MS);
    try {
      startMatch(state);
      // startMatch 的正式首局固定打2；评测在首个自动出牌微任务执行前切换级牌，
      // 同一组镜像仍保留完全相同的牌面与先手，且不需要读取任何暗牌。
      forceEvaluationLevel(state, level);
      run.firstPlayer = state.firstPlayer;
      run.dealFingerprint = dealFingerprint(state);
      pump();
    } catch (error) {
      finishRun(run, {
        ok: false,
        deadlock: false,
        reason: error instanceof Error ? error.message : String(error),
        durationMs: performance.now() - run.startedAt,
      });
    }
  });
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

function wilsonInterval(successes, total, z = 1.959963984540054) {
  if (!total) return null;
  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denominator;
  const radius = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total) / denominator;
  return [Math.max(0, center - radius), Math.min(1, center + radius)];
}

function bootstrapMeanCI(values, seed, iterations = 5000) {
  if (!values.length) return null;
  const rng = seededRandom(seed ^ 0xA5A5A5A5);
  const samples = [];
  for (let n = 0; n < iterations; n++) {
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[Math.floor(rng() * values.length)];
    }
    samples.push(sum / values.length);
  }
  samples.sort((a, b) => a - b);
  return [
    samples[Math.floor(iterations * 0.025)],
    samples[Math.min(iterations - 1, Math.floor(iterations * 0.975))],
  ];
}

function rounded(value, digits = 3) {
  return value == null ? null : Number(value.toFixed(digits));
}

function roundedPair(values, digits = 3) {
  return values ? values.map((value) => rounded(value, digits)) : null;
}

const games = [];
const pairs = [];
const failures = [];
const startedAt = performance.now();
const plannedPairs = groupCount * (levelBlockDesign ? evaluationLevels.length : 1);
const checkpointSignature = JSON.stringify({
  groupCount, baseSeed, candidate: CANDIDATE.name, comparison: COMPARISON.name,
  evaluationLevels, levelBlockDesign, continuousMatch,
  valueModelSha256: valueModelAudit?.sha256 || null,
});
let resumeBlockIndex = 0;

function writeCheckpoint(nextBlockIndex) {
  if (!checkpointPath) return;
  fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });
  fs.writeFileSync(checkpointPath, `${JSON.stringify({
    schema: 'guandan-ai-ab-checkpoint-v1',
    signature: checkpointSignature,
    nextBlockIndex,
    complete: nextBlockIndex >= groupCount,
    games,
    pairs,
    failures,
  })}\n`, 'utf8');
}

if (resumeCheckpoint) {
  if (!checkpointPath || !fs.existsSync(checkpointPath)) {
    throw new Error('--resume 需要现有 --checkpoint 文件');
  }
  const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
  if (checkpoint.schema !== 'guandan-ai-ab-checkpoint-v1'
    || checkpoint.signature !== checkpointSignature) {
    throw new Error('检查点与当前评测配置或模型哈希不一致');
  }
  if (!Number.isInteger(checkpoint.nextBlockIndex)
    || checkpoint.nextBlockIndex < 0 || checkpoint.nextBlockIndex > groupCount
    || !Array.isArray(checkpoint.games) || !Array.isArray(checkpoint.pairs)
    || !Array.isArray(checkpoint.failures)) {
    throw new Error('检查点内容无效');
  }
  const expectedPairs = checkpoint.nextBlockIndex * (levelBlockDesign ? evaluationLevels.length : 1);
  if (checkpoint.pairs.length !== expectedPairs || checkpoint.games.length !== expectedPairs * 2) {
    throw new Error('检查点的已完成区组不完整');
  }
  games.push(...checkpoint.games);
  pairs.push(...checkpoint.pairs);
  failures.push(...checkpoint.failures);
  resumeBlockIndex = checkpoint.nextBlockIndex;
}

try {
  let pairIndex = pairs.length;
  for (let blockIndex = resumeBlockIndex; blockIndex < groupCount; blockIndex++) {
    const seed = (baseSeed + blockIndex) >>> 0;
    const levelsForSeed = levelBlockDesign
      ? evaluationLevels
      : [evaluationLevels[blockIndex % evaluationLevels.length]];
    for (const level of levelsForSeed) {
      pairIndex += 1;
      const candidateEven = await playGame({ seed, candidateTeam: 0, level });
      const candidateOdd = await playGame({ seed, candidateTeam: 1, level });
      games.push(candidateEven, candidateOdd);

      for (const [leg, result] of [
        ['candidate-even', candidateEven],
        ['candidate-odd', candidateOdd],
      ]) {
        if (!result.ok) failures.push({
          group: pairIndex, block: blockIndex + 1, seed, level, leg, ...result,
        });
      }

      const mirrorMatched = candidateEven.ok
        && candidateOdd.ok
        && candidateEven.firstPlayer === candidateOdd.firstPlayer
        && candidateEven.dealFingerprint === candidateOdd.dealFingerprint;
      if (candidateEven.ok && candidateOdd.ok && !mirrorMatched) {
        failures.push({
          group: pairIndex,
          block: blockIndex + 1,
          seed,
          level,
          leg: 'mirror',
          ok: false,
          deadlock: false,
          reason: '镜像两场的初始牌面或先手不一致',
        });
      }

      pairs.push({
        group: pairIndex,
        block: blockIndex + 1,
        seed,
        level,
        mirrorMatched,
        crossLevelMatched: true,
        dealFingerprint: candidateEven.dealFingerprint || candidateOdd.dealFingerprint || null,
        complete: candidateEven.ok && candidateOdd.ok && mirrorMatched,
        utility: candidateEven.ok && candidateOdd.ok
          ? (candidateEven.utility + candidateOdd.utility) / 2
          : null,
        candidateHeads: Number(!!candidateEven.candidateHead)
          + Number(!!candidateOdd.candidateHead),
        candidateDoubleUps: Number(!!candidateEven.candidateDoubleUp)
          + Number(!!candidateOdd.candidateDoubleUp),
        comparisonDoubleUps: Number(!!candidateEven.comparisonDoubleUp)
          + Number(!!candidateOdd.comparisonDoubleUp),
        orders: [candidateEven.order || null, candidateOdd.order || null],
        firstDivergences: [
          candidateEven.firstDivergence || null,
          candidateOdd.firstDivergence || null,
        ],
      });
      if (!jsonOnly) {
        process.stdout.write(
          `${pairIndex}/${plannedPairs}[${level === 14 ? 'A' : level}]:${candidateEven.ok ? candidateEven.utility : 'E'}`
          + `,${candidateOdd.ok ? candidateOdd.utility : 'E'} `,
        );
      }
    }
    if (levelBlockDesign) {
      const blockPairs = pairs.filter((pair) => pair.block === blockIndex + 1);
      const fingerprints = new Set(blockPairs.map((pair) => pair.dealFingerprint).filter(Boolean));
      if (fingerprints.size !== 1 || blockPairs.length !== evaluationLevels.length) {
        for (const pair of blockPairs) {
          pair.crossLevelMatched = false;
          pair.complete = false;
        }
        failures.push({
          group: `block-${blockIndex + 1}`,
          block: blockIndex + 1,
          seed,
          leg: 'cross-level-block',
          ok: false,
          deadlock: false,
          reason: '同一基础种子跨级牌未复用完全相同的实体牌面',
        });
      }
    }
    writeCheckpoint(blockIndex + 1);
  }
} finally {
  globalThis.clearInterval(heartbeat);
  setUpdateCallback(null);
  setAIDecisionObserver(null);
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  Math.random = realRandom;
}

const completedPairs = pairs.filter((pair) => pair.complete);
// 只有镜像两腿都成功且牌面/先手一致的种子，才进入任何胜负统计。
// 单腿成功不能混入分子或分母，否则会破坏配对设计。
const completedGames = pairs.flatMap((pair, index) => (
  pair.complete ? games.slice(index * 2, index * 2 + 2) : []
));
const utilities = completedGames.map((game) => game.utility);
const pairedUtilities = completedPairs.map((pair) => pair.utility);
const pairedHeadRates = completedPairs.map((pair) => pair.candidateHeads / 2);
const pairedDoubleUpDifferences = completedPairs.map((pair) => (
  (pair.candidateDoubleUps - pair.comparisonDoubleUps) / 2
));
const blocks = Array.from({ length: groupCount }, (_, blockIndex) => {
  const blockPairs = pairs.filter((pair) => pair.block === blockIndex + 1);
  const expected = levelBlockDesign ? evaluationLevels.length : 1;
  const complete = blockPairs.length === expected && blockPairs.every((pair) => pair.complete);
  return {
    block: blockIndex + 1,
    seed: (baseSeed + blockIndex) >>> 0,
    complete,
    levelPairs: blockPairs.length,
    utility: complete ? average(blockPairs.map((pair) => pair.utility)) : null,
    candidateHeadRate: complete
      ? average(blockPairs.map((pair) => pair.candidateHeads / 2)) : null,
    doubleUpDifference: complete
      ? average(blockPairs.map((pair) => (
        (pair.candidateDoubleUps - pair.comparisonDoubleUps) / 2
      ))) : null,
  };
});
const completedBlocks = blocks.filter((block) => block.complete);
// 跨级区组内的13个观测共享同一副基础牌，正式置信区间必须按 seed block
// 重采样，不能把它们错误当作13个独立样本。
const inferenceUtilities = levelBlockDesign
  ? completedBlocks.map((block) => block.utility)
  : pairedUtilities;
const inferenceHeadRates = levelBlockDesign
  ? completedBlocks.map((block) => block.candidateHeadRate)
  : pairedHeadRates;
const inferenceDoubleUpDifferences = levelBlockDesign
  ? completedBlocks.map((block) => block.doubleUpDifference)
  : pairedDoubleUpDifferences;
const candidateHeads = completedGames.filter((game) => game.candidateHead).length;
const comparisonHeads = completedGames.filter((game) => game.comparisonHead).length;
const candidateDoubleUps = completedGames.filter((game) => game.candidateDoubleUp).length;
const comparisonDoubleUps = completedGames.filter((game) => game.comparisonDoubleUp).length;
const durations = games.map((game) => game.durationMs).filter(Number.isFinite);
const actions = completedGames.map((game) => game.actions);
const headRate = completedGames.length ? candidateHeads / completedGames.length : null;
const cappedHeadRate = headRate == null ? null : Math.min(0.999999, Math.max(0.000001, headRate));
const byLevel = Object.fromEntries(evaluationLevels.map((level) => {
  const levelGames = completedGames.filter((game) => game.level === level);
  const levelPairs = completedPairs.filter((pair) => pair.level === level);
  const heads = levelGames.filter((game) => game.candidateHead).length;
  const comparisonLevelHeads = levelGames.filter((game) => game.comparisonHead).length;
  const doubles = levelGames.filter((game) => game.candidateDoubleUp).length;
  const comparisonDoubles = levelGames.filter((game) => game.comparisonDoubleUp).length;
  return [String(level), {
    label: level === 14 ? 'A' : String(level),
    seedGroups: levelPairs.length,
    games: levelGames.length,
    candidateHeads: heads,
    comparisonHeads: comparisonLevelHeads,
    candidateHeadRate: rounded(levelGames.length ? heads / levelGames.length : null),
    candidateDoubleUps: doubles,
    comparisonDoubleUps: comparisonDoubles,
    candidateUtilityPerGame: rounded(average(levelGames.map((game) => game.utility))),
  }];
}));
const firstDivergences = completedGames
  .map((game) => game.firstDivergence)
  .filter(Boolean);
const divergenceBySeat = Object.fromEntries(Array.from({ length: 4 }, (_, seat) => [
  String(seat), firstDivergences.filter((item) => item.seat === seat).length,
]));
const continuousRounds = completedGames.flatMap((game) => game.roundResults || []);
const hybridTotals = completedGames.reduce((total, game) => {
  const report = game.hybrid || createHybridCounters();
  total.turns += report.turns || 0;
  total.applied += report.applied || 0;
  total.changed += report.changed || 0;
  total.samples += report.samples || 0;
  total.nodes += report.nodes || 0;
  total.iterations += report.iterations || 0;
  for (const [key, value] of Object.entries(report.searchModes || {})) {
    total.searchModes[key] = (total.searchModes[key] || 0) + value;
  }
  for (const [key, value] of Object.entries(report.reasons || {})) {
    total.reasons[key] = (total.reasons[key] || 0) + value;
  }
  for (const [key, value] of Object.entries(report.rejected || {})) {
    total.rejected[key] = (total.rejected[key] || 0) + value;
  }
  return total;
}, createHybridCounters());

if (!jsonOnly) console.log('\n');
const finalReport = {
  config: {
    seedGroups: plannedPairs,
    baseDealBlocks: groupCount,
    baseSeed,
    evaluationSeedManifest,
    gamesPlanned: plannedPairs * 2,
    evaluationLevels,
    evaluationDesign: levelBlockDesign ? 'same-deal-cross-level-blocks' : 'legacy-level-cycle',
    levelAssignment: levelBlockDesign
      ? 'every base deal is replayed at every evaluation level'
      : 'seed groups cycle evenly through evaluationLevels',
    continuousMatch,
    outcomeUnit: continuousMatch ? 'match win (+1/-1)' : 'round upgrade utility (+1..+3)',
    traceDivergence,
    summaryOnly,
    candidate: CANDIDATE.name,
    comparison: COMPARISON.name,
    baseline: COMPARISON.name,
    candidatePolicyProfile: CANDIDATE.policyProfile,
    comparisonPolicyProfile: COMPARISON.policyProfile,
    candidateFeatures: CANDIDATE.policyFeatures,
    comparisonFeatures: COMPARISON.policyFeatures,
    candidateThresholds: CANDIDATE.policyThresholds,
    comparisonThresholds: COMPARISON.policyThresholds,
    valueModel: valueModelAudit,
    difficulty: 'master',
    deterministic: true,
  },
  completion: {
    gamesCompleted: completedGames.length,
    mirrorPairsCompleted: completedPairs.length,
    baseDealBlocksCompleted: completedBlocks.length,
    mirrorMismatches: failures.filter((failure) => failure.leg === 'mirror').length,
    failures: failures.length,
    deadlocks: failures.filter((failure) => failure.deadlock).length,
  },
  result: {
    candidateUpgradeUtilityTotal: utilities.reduce((sum, value) => sum + value, 0),
    candidateUpgradeUtilityPerGame: rounded(average(utilities)),
    candidatePairedUtilityPerSeed: rounded(average(pairedUtilities)),
    candidatePairedUtilityBootstrap95: roundedPair(
      bootstrapMeanCI(inferenceUtilities, baseSeed),
    ),
    candidateBlockedUtilityPerDeal: rounded(average(inferenceUtilities)),
    candidateHeads,
    comparisonHeads,
    baselineHeads: comparisonHeads,
    candidateHeadRate: rounded(headRate),
    candidateHeadPairedBootstrap95: roundedPair(
      bootstrapMeanCI(inferenceHeadRates, baseSeed ^ 0x13579BDF),
    ),
    // 保留旧字段供现有脚本读取；配对镜像赛的正式不确定性应看上面的 bootstrap。
    candidateHeadWilson95: roundedPair(wilsonInterval(candidateHeads, completedGames.length)),
    candidateElo: cappedHeadRate == null
      ? null
      : rounded(400 * Math.log10(cappedHeadRate / (1 - cappedHeadRate)), 1),
    candidateDoubleUps,
    comparisonDoubleUps,
    baselineDoubleUps: comparisonDoubleUps,
    candidateDoubleUpDifferencePerGame: rounded(average(pairedDoubleUpDifferences)),
    candidateDoubleUpDifferencePairedBootstrap95: roundedPair(
      bootstrapMeanCI(inferenceDoubleUpDifferences, baseSeed ^ 0x2468ACE0),
    ),
  },
  byLevel,
  divergence: {
    enabled: traceDivergence,
    gamesWithFirstDivergence: firstDivergences.length,
    rate: rounded(completedGames.length
      ? firstDivergences.length / completedGames.length : null),
    bySeat: divergenceBySeat,
    samples: firstDivergences.slice(0, 40),
  },
  hybrid: {
    ...hybridTotals,
    appliedRate: rounded(hybridTotals.turns ? hybridTotals.applied / hybridTotals.turns : null),
    changedRate: rounded(hybridTotals.turns ? hybridTotals.changed / hybridTotals.turns : null),
    averageSamplesPerTurn: rounded(hybridTotals.turns
      ? hybridTotals.samples / hybridTotals.turns : null),
    averageNodesPerAppliedTurn: rounded(hybridTotals.applied
      ? hybridTotals.nodes / hybridTotals.applied : null),
    averageIterationsPerAppliedTurn: rounded(hybridTotals.applied
      ? hybridTotals.iterations / hybridTotals.applied : null),
  },
  continuousMatch: {
    enabled: continuousMatch,
    matches: continuousMatch ? completedGames.length : 0,
    rounds: continuousRounds.length,
    averageRoundsPerMatch: rounded(continuousMatch
      ? average(completedGames.map((game) => game.rounds)) : null),
    maxRounds: continuousRounds.length
      ? Math.max(...completedGames.map((game) => game.rounds)) : null,
    tributeRounds: continuousRounds.filter((round) => round.tribute).length,
    aAttempts: continuousRounds.filter((round) => round.aAttempt).length,
    aFailures: continuousRounds.filter((round) => round.aFailed).length,
    aResets: continuousRounds.filter((round) => round.aReset).length,
    longRoundActionThreshold: LONG_ROUND_ACTIONS,
    longRounds: continuousRounds.filter((round) => round.actions >= LONG_ROUND_ACTIONS).length,
    maxRoundActions: continuousRounds.length
      ? Math.max(...continuousRounds.map((round) => round.actions)) : null,
    candidateRoundUpgradeUtility: continuousRounds.reduce(
      (sum, round) => sum + round.candidateUtility, 0,
    ),
  },
  performance: {
    totalSeconds: rounded((performance.now() - startedAt) / 1000, 2),
    averageGameMs: rounded(average(durations), 1),
    p95GameMs: rounded(percentile(durations, 0.95), 1),
    averageActions: rounded(average(actions), 1),
    maxActions: actions.length ? Math.max(...actions) : null,
  },
  ...(summaryOnly ? {} : { pairs, blocks }),
  failures,
};
const serializedReport = JSON.stringify(finalReport, null, 2);
if (reportPath) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${serializedReport}\n`, 'utf8');
}
writeCheckpoint(groupCount);
console.log(serializedReport);

if (failures.length || completedPairs.length !== plannedPairs
  || completedBlocks.length !== groupCount) process.exitCode = 1;
