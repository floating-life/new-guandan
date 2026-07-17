/** Simulate a strong control-oriented human against three hard AIs. */
const realSetTimeout = globalThis.setTimeout;
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

const rounds = Math.max(1, Number(process.argv[2]) || 30);
const results = [];
let state = null;
let processing = false;
let resolveRound = null;

function humanTurn() {
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
  });
  if (!decision || decision.action === 'pass') return humanPass(state);
  humanSelectSet(state, decision.cards.map((card) => card.id), decision.signature, null);
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
  state = createMatch({ difficulty: 'hard', aiSpeed: 'fast', coachMode: false });
  const completed = new Promise((resolve) => { resolveRound = resolve; });
  startMatch(state);
  pump();
  const finalState = await completed;
  const order = finalState.finishOrder.slice();
  const replay = finalState.lastReplay;
  const aiActions = (replay?.trickLog || []).filter((item) => item.seat > 0);
  const aiBombLeads = aiActions.filter((item) => item.action === 'play'
    && ['bomb', 'flush_straight', 'joker_bomb'].includes(item.hand?.type)
    && !item.lastHand).length;
  const record = {
    index,
    order,
    humanRank: order.indexOf(0) + 1,
    partnerRank: order.indexOf(2) + 1,
    headTeam: TEAM_OF[order[0]],
    doubleUp: TEAM_OF[order[0]] === TEAM_OF[order[1]],
    turns: replay?.trickLog?.length || 0,
    aiBombLeads,
  };
  results.push(record);
  process.stdout.write(`${index}:${order.join('-')} `);
}

for (let i = 1; i <= rounds; i++) await playRound(i);
globalThis.clearInterval(heartbeat);
globalThis.setTimeout = realSetTimeout;

const count = (fn) => results.filter(fn).length;
const average = (key) => results.reduce((sum, item) => sum + item[key], 0) / results.length;
console.log('\n');
console.log(JSON.stringify({
  rounds,
  humanHead: count((item) => item.humanRank === 1),
  humanTopTwo: count((item) => item.humanRank <= 2),
  humanTeamHead: count((item) => item.headTeam === 0),
  humanTeamDoubleUp: count((item) => item.headTeam === 0 && item.doubleUp),
  opponentDoubleUp: count((item) => item.headTeam === 1 && item.doubleUp),
  averageHumanRank: Number(average('humanRank').toFixed(2)),
  averagePartnerRank: Number(average('partnerRank').toFixed(2)),
  averageTurns: Number(average('turns').toFixed(1)),
  aiBombLeads: results.reduce((sum, item) => sum + item.aiBombLeads, 0),
}, null, 2));
