/**
 * 可复现的 AI 策略 A/B 镜像赛。
 *
 * 用法：
 *   node js/ai.ab.simulation.js [种子组数=30] [基础种子=20260801]
 *     [候选策略=expert] [对照策略=baseline]
 *
 * 每个种子发两次完全相同的牌：
 *   1. candidate 坐 0+2，comparison 坐 1+3；
 *   2. comparison 坐 0+2，candidate 坐 1+3。
 * 所有座位都通过 chooseAIPlay，以 master + deterministic 作出决定。
 * 可用策略：expert、baseline、no-p0、no-p1、no-p2、none。
 */
import { performance } from 'node:perf_hooks';

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
  setUpdateCallback,
  PHASE,
  TEAM_OF,
} = await import('./game.js');
const { chooseAIPlay, resolvePolicyVariant, AI_POLICY_VARIANTS } = await import('./ai.js');
const { describeUpgrade, handSignature } = await import('./rules.js');

const groupCount = positiveInteger(process.argv[2], 30);
const baseSeed = finiteUint32(process.argv[3], 20260801);
const candidateName = policyVariantName(process.argv[4], 'expert');
const comparisonName = policyVariantName(process.argv[5], 'baseline');
const jsonOnly = process.argv.includes('--json');
const MAX_ACTIONS = 2000;
const GAME_TIMEOUT_MS = 180_000;
const CANDIDATE = resolvePolicyVariant(candidateName);
const COMPARISON = resolvePolicyVariant(comparisonName);

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
function decisionView(run, seat) {
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
    policyProfile: run.variantBySeat[seat].policyProfile,
    policyFeatures: run.variantBySeat[seat].policyFeatures,
    policyThresholds: run.variantBySeat[seat].policyThresholds,
  };
}

function playSeatZero(run) {
  const state = run.state;
  const decision = chooseAIPlay(decisionView(run, 0));
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

function dealFingerprint(state) {
  const hands = state.roundInitialHands || state.hands;
  return hands.map((hand) => hand.map((card) => (
    `${card.rank}:${card.suit}:${card.deckIndex}`
  )).join(',')).join('|');
}

function fallbackCount(state) {
  return state.trickLog.filter((item) => (
    item.action === 'play'
    && typeof item.decisionMeta?.reason === 'string'
    && item.decisionMeta.reason.includes('兜底')
  )).length;
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
  const fallbacks = fallbackCount(state);
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
  return {
    ok: true,
    seed: run.seed,
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
    actions: state.trickLog.length,
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
      if (state.trickLog.length > MAX_ACTIONS) {
        finishRun(run, {
          ok: false,
          deadlock: true,
          reason: `行动数超过 ${MAX_ACTIONS}`,
          durationMs: performance.now() - run.startedAt,
        });
      } else if (state.phase === PHASE.PLAYING
        && state.currentSeat === 0
        && !state.finishOrder.includes(0)) {
        playSeatZero(run);
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
const heartbeat = globalThis.setInterval(pump, 5);

async function playGame({ seed, candidateTeam }) {
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
  });

  return new Promise((resolve) => {
    const run = {
      state,
      seed,
      candidateTeam,
      variantBySeat,
      resolve,
      done: false,
      startedAt: performance.now(),
      timeoutId: null,
      firstPlayer: null,
      dealFingerprint: null,
    };
    activeRun = run;
    run.timeoutId = realSetTimeout(() => {
      finishRun(run, {
        ok: false,
        deadlock: true,
        reason: `超过 ${GAME_TIMEOUT_MS / 1000} 秒未结束`,
        durationMs: performance.now() - run.startedAt,
      });
    }, GAME_TIMEOUT_MS);
    try {
      startMatch(state);
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

try {
  for (let index = 0; index < groupCount; index++) {
    const seed = (baseSeed + index) >>> 0;
    const candidateEven = await playGame({ seed, candidateTeam: 0 });
    const candidateOdd = await playGame({ seed, candidateTeam: 1 });
    games.push(candidateEven, candidateOdd);

    for (const [leg, result] of [
      ['candidate-even', candidateEven],
      ['candidate-odd', candidateOdd],
    ]) {
      if (!result.ok) failures.push({ group: index + 1, seed, leg, ...result });
    }

    const mirrorMatched = candidateEven.ok
      && candidateOdd.ok
      && candidateEven.firstPlayer === candidateOdd.firstPlayer
      && candidateEven.dealFingerprint === candidateOdd.dealFingerprint;
    if (candidateEven.ok && candidateOdd.ok && !mirrorMatched) {
      failures.push({
        group: index + 1,
        seed,
        leg: 'mirror',
        ok: false,
        deadlock: false,
        reason: '镜像两场的初始牌面或先手不一致',
      });
    }

    pairs.push({
      group: index + 1,
      seed,
      mirrorMatched,
      complete: candidateEven.ok && candidateOdd.ok && mirrorMatched,
      utility: candidateEven.ok && candidateOdd.ok
        ? (candidateEven.utility + candidateOdd.utility) / 2
        : null,
      candidateHeads: Number(!!candidateEven.candidateHead) + Number(!!candidateOdd.candidateHead),
      candidateDoubleUps: Number(!!candidateEven.candidateDoubleUp)
        + Number(!!candidateOdd.candidateDoubleUp),
      orders: [candidateEven.order || null, candidateOdd.order || null],
    });
    if (!jsonOnly) {
      process.stdout.write(
        `${index + 1}/${groupCount}:${candidateEven.ok ? candidateEven.utility : 'E'}`
        + `,${candidateOdd.ok ? candidateOdd.utility : 'E'} `,
      );
    }
  }
} finally {
  globalThis.clearInterval(heartbeat);
  setUpdateCallback(null);
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  Math.random = realRandom;
}

const completedGames = games.filter((game) => game.ok);
const completedPairs = pairs.filter((pair) => pair.complete);
const utilities = completedGames.map((game) => game.utility);
const pairedUtilities = completedPairs.map((pair) => pair.utility);
const candidateHeads = completedGames.filter((game) => game.candidateHead).length;
const comparisonHeads = completedGames.filter((game) => game.comparisonHead).length;
const candidateDoubleUps = completedGames.filter((game) => game.candidateDoubleUp).length;
const comparisonDoubleUps = completedGames.filter((game) => game.comparisonDoubleUp).length;
const durations = games.map((game) => game.durationMs).filter(Number.isFinite);
const actions = completedGames.map((game) => game.actions);
const headRate = completedGames.length ? candidateHeads / completedGames.length : null;
const cappedHeadRate = headRate == null ? null : Math.min(0.999999, Math.max(0.000001, headRate));

if (!jsonOnly) console.log('\n');
console.log(JSON.stringify({
  config: {
    seedGroups: groupCount,
    baseSeed,
    gamesPlanned: groupCount * 2,
    candidate: CANDIDATE.name,
    comparison: COMPARISON.name,
    baseline: COMPARISON.name,
    candidatePolicyProfile: CANDIDATE.policyProfile,
    comparisonPolicyProfile: COMPARISON.policyProfile,
    candidateFeatures: CANDIDATE.policyFeatures,
    comparisonFeatures: COMPARISON.policyFeatures,
    difficulty: 'master',
    deterministic: true,
  },
  completion: {
    gamesCompleted: completedGames.length,
    mirrorPairsCompleted: completedPairs.length,
    mirrorMismatches: failures.filter((failure) => failure.leg === 'mirror').length,
    failures: failures.length,
    deadlocks: failures.filter((failure) => failure.deadlock).length,
  },
  result: {
    candidateUpgradeUtilityTotal: utilities.reduce((sum, value) => sum + value, 0),
    candidateUpgradeUtilityPerGame: rounded(average(utilities)),
    candidatePairedUtilityPerSeed: rounded(average(pairedUtilities)),
    candidatePairedUtilityBootstrap95: roundedPair(
      bootstrapMeanCI(pairedUtilities, baseSeed),
    ),
    candidateHeads,
    comparisonHeads,
    baselineHeads: comparisonHeads,
    candidateHeadRate: rounded(headRate),
    candidateHeadWilson95: roundedPair(wilsonInterval(candidateHeads, completedGames.length)),
    candidateElo: cappedHeadRate == null
      ? null
      : rounded(400 * Math.log10(cappedHeadRate / (1 - cappedHeadRate)), 1),
    candidateDoubleUps,
    comparisonDoubleUps,
    baselineDoubleUps: comparisonDoubleUps,
  },
  performance: {
    totalSeconds: rounded((performance.now() - startedAt) / 1000, 2),
    averageGameMs: rounded(average(durations), 1),
    p95GameMs: rounded(percentile(durations, 0.95), 1),
    averageActions: rounded(average(actions), 1),
    maxActions: actions.length ? Math.max(...actions) : null,
  },
  pairs,
  failures,
}, null, 2));

if (failures.length || completedPairs.length !== groupCount) process.exitCode = 1;
