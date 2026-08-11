/** Simulate a deterministic master-coach proxy against three configurable AIs. */
const realSetTimeout = globalThis.setTimeout;
const realRandom = Math.random;
globalThis.setTimeout = (fn) => {
  queueMicrotask(fn);
  return 1;
};
globalThis.clearTimeout = () => {};

const {
  createMatch, startMatch, humanPlay, humanPass, humanSelectSet,
  humanPickReturnCard, humanConfirmReturn, getReturnCandidates,
  setUpdateCallback, PHASE, TEAM_OF,
} = await import('./game.js');
const { recommendPlay, chooseReturnCard } = await import('./ai.js');
const { handSignature } = await import('./rules.js');

const rounds = Math.max(1, Number(process.argv[2]) || 30);
const difficulty = ['easy', 'normal', 'hard', 'master'].includes(process.argv[3])
  ? process.argv[3]
  : 'hard';
const baseSeed = Number.isFinite(Number(process.argv[4]))
  ? (Number(process.argv[4]) >>> 0)
  : 20260730;
const results = [];
let state = null;
let processing = false;
let resolveRound = null;

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

function publicActionHistory() {
  return state.trickLog.map((item) => ({
    turn: item.turn,
    trickNumber: item.trickNumber,
    seat: item.seat,
    action: item.action,
    cards: item.action === 'play' ? (item.cards || []) : [],
    hand: item.action === 'play' ? item.hand : null,
    countsBefore: Array.isArray(item.countsBefore) ? item.countsBefore.slice(0, 4) : [],
    countsAfter: Array.isArray(item.countsAfter) ? item.countsAfter.slice(0, 4) : [],
  }));
}

function publicTributeContext(seat) {
  const ts = state.tributeState;
  if (!ts) return null;
  const gave = (ts.tributes || []).find((item) => item.from === seat) || null;
  const received = (ts.returns || []).find((item) => item.to === seat) || null;
  if (!gave && !received) return null;
  const face = (card) => (card ? { rank: card.rank, suit: card.suit } : null);
  return {
    gaveCard: face(gave?.card),
    gaveTo: gave?.to ?? null,
    receivedReturnCard: face(received?.card),
    receivedFrom: received?.from ?? null,
    firstLeadAfterTribute: state.firstPlayer === seat && state.trickLog.length === 0,
    doubleDown: !!ts.doubleDown,
  };
}

function humanTurn() {
  const leadAfterOwnBomb = (() => {
    if (state.lastHand || state.currentTrickStartIndex <= 0) return false;
    for (let i = Math.min(state.currentTrickStartIndex, state.trickLog.length) - 1; i >= 0; i--) {
      const item = state.trickLog[i];
      if (item.action !== 'play') continue;
      return item.seat === 0
        && ['bomb', 'flush_straight', 'joker_bomb'].includes(item.hand?.type);
    }
    return false;
  })();
  const decision = recommendPlay({
    seat: 0,
    hand: state.hands[0],
    level: state.currentLevel,
    lastHand: state.lastHand,
    lastSeat: state.lastSeat,
    handCounts: state.handCounts,
    teams: TEAM_OF,
    finishOrder: state.finishOrder,
    playedCards: state.trickLog.flatMap((item) => item.cards || []),
    publicHistory: publicActionHistory(),
    tributeContext: publicTributeContext(0),
    leadAfterOwnBomb,
  });
  if (!decision || decision.action === 'pass') return humanPass(state);
  humanSelectSet(
    state,
    decision.cards.map((card) => card.id),
    decision.signature || handSignature(decision.hand),
    null,
  );
  return humanPlay(state);
}

function pump() {
  if (processing || !state) return;
  processing = true;
  queueMicrotask(() => {
    try {
      if (state.phase === PHASE.RETURN) {
        const candidates = getReturnCandidates(state);
        if (candidates.length) {
          const task = state.tributeState?.pendingReturns?.[0];
          const preferred = chooseReturnCard(state.hands[0].slice(), state.currentLevel, {
            toPartner: task ? TEAM_OF[task.from] === TEAM_OF[task.to] : false,
          });
          const card = candidates.find((item) => item.id === preferred?.id) || candidates[0];
          humanPickReturnCard(state, card.id);
          humanConfirmReturn(state);
        }
      } else if (state.phase === PHASE.PLAYING
        && state.currentSeat === 0
        && !state.finishOrder.includes(0)) {
        const result = humanTurn();
        if (!result?.ok) throw new Error(result?.reason || 'human proxy failed');
      } else if (state.phase === PHASE.ROUND_END || state.phase === PHASE.MATCH_END) {
        const done = resolveRound;
        resolveRound = null;
        if (done) done(state);
      }
    } finally {
      processing = false;
    }
  });
}

setUpdateCallback(pump);
const heartbeat = globalThis.setInterval(pump, 1);

async function playRound(index) {
  // 每局独立重置随机源：同一个 seed 下，后续代码改动不会改变下一局发牌，
  // 便于做版本前后的成对对照。
  Math.random = seededRandom((baseSeed + index - 1) >>> 0);
  state = createMatch({ difficulty, aiSpeed: 'fast', coachMode: false });
  const completed = new Promise((resolve) => { resolveRound = resolve; });
  startMatch(state);
  pump();
  const finalState = await completed;
  const order = finalState.finishOrder.slice();
  const replay = finalState.lastReplay;
  const firstPlayByTrick = new Set();
  const bombTypes = new Set(['bomb', 'flush_straight', 'joker_bomb']);
  let aiBombLeads = 0;
  let aiBombResponses = 0;
  for (const item of replay?.trickLog || []) {
    if (item.action !== 'play') continue;
    const isLead = !firstPlayByTrick.has(item.trickNumber);
    firstPlayByTrick.add(item.trickNumber);
    const type = String(item.signature || '').split('|')[0];
    if (item.seat > 0 && bombTypes.has(type)) {
      if (isLead) aiBombLeads += 1;
      else aiBombResponses += 1;
    }
  }
  const record = {
    index,
    order,
    humanRank: order.indexOf(0) + 1,
    partnerRank: order.indexOf(2) + 1,
    headTeam: TEAM_OF[order[0]],
    doubleUp: TEAM_OF[order[0]] === TEAM_OF[order[1]],
    turns: replay?.trickLog?.length || 0,
    aiBombLeads,
    aiBombResponses,
  };
  results.push(record);
  process.stdout.write(`${index}:${order.join('-')} `);
}

for (let i = 1; i <= rounds; i++) await playRound(i);
globalThis.clearInterval(heartbeat);
globalThis.setTimeout = realSetTimeout;
Math.random = realRandom;

const count = (fn) => results.filter(fn).length;
const average = (key) => results.reduce((sum, item) => sum + item[key], 0) / results.length;
const rankDistribution = [1, 2, 3, 4].map(
  (rank) => count((item) => item.humanRank === rank),
);
const seatHeadCounts = [0, 1, 2, 3].map(
  (seat) => count((item) => item.order[0] === seat),
);
console.log('\n');
console.log(JSON.stringify({
  rounds,
  difficulty,
  seed: baseSeed,
  humanHead: count((item) => item.humanRank === 1),
  humanTopTwo: count((item) => item.humanRank <= 2),
  humanTeamHead: count((item) => item.headTeam === 0),
  humanTeamDoubleUp: count((item) => item.headTeam === 0 && item.doubleUp),
  opponentDoubleUp: count((item) => item.headTeam === 1 && item.doubleUp),
  averageHumanRank: Number(average('humanRank').toFixed(2)),
  averagePartnerRank: Number(average('partnerRank').toFixed(2)),
  averageTurns: Number(average('turns').toFixed(1)),
  humanRankDistribution: rankDistribution,
  seatHeadCounts,
  aiBombLeads: results.reduce((sum, item) => sum + item.aiBombLeads, 0),
  aiBombResponses: results.reduce((sum, item) => sum + item.aiBombResponses, 0),
}, null, 2));
