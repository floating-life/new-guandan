/**
 * 公平 AI 观察层。
 *
 * 决策器只能看到本家手牌与牌桌公开信息。这个模块采用显式白名单构造观察，
 * 即使调用方误传 state.hands、初始牌面、终局余牌或复盘对象，也不会进入 AI。
 */

function finiteNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function seatNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed < 4 ? parsed : fallback;
}

export function publicCardView(card, { includeId = false } = {}) {
  if (!card || !Number.isFinite(Number(card.rank))) return null;
  const result = {
    rank: Number(card.rank),
    suit: String(card.suit || ''),
    deckIndex: card.deckIndex != null && Number.isFinite(Number(card.deckIndex))
      ? Number(card.deckIndex) : null,
  };
  if (includeId && card.id != null) result.id = String(card.id);
  return result;
}

export function publicHandView(hand) {
  if (!hand || typeof hand !== 'object') return null;
  const meta = hand.meta && typeof hand.meta === 'object' ? hand.meta : {};
  return {
    type: String(hand.type || ''),
    mainRank: finiteNumber(hand.mainRank),
    size: finiteNumber(hand.size, 0),
    power: finiteNumber(hand.power, 0),
    meta: {
      ...(Array.isArray(meta.sequence)
        ? { sequence: meta.sequence.map((rank) => Number(rank)).filter(Number.isFinite) }
        : {}),
      ...(Number.isFinite(Number(meta.pairRank)) ? { pairRank: Number(meta.pairRank) } : {}),
      ...(meta.suit ? { suit: String(meta.suit) } : {}),
      ...(Array.isArray(meta.wildAs)
        ? { wildAs: meta.wildAs.map((rank) => Number(rank)).filter(Number.isFinite) }
        : Number.isFinite(Number(meta.wildAs)) ? { wildAs: Number(meta.wildAs) } : {}),
    },
  };
}

export function sanitizePublicHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.slice(-240).map((item) => ({
    turn: finiteNumber(item?.turn, 0),
    trickNumber: finiteNumber(item?.trickNumber, 0),
    seat: seatNumber(item?.seat),
    action: item?.action === 'play' ? 'play' : 'pass',
    cards: Array.isArray(item?.cards)
      ? item.cards.map((card) => publicCardView(card)).filter(Boolean)
      : [],
    hand: publicHandView(item?.hand),
    countsBefore: Array.isArray(item?.countsBefore)
      ? item.countsBefore.slice(0, 4).map((count) => Math.max(0, finiteNumber(count, 0)))
      : [],
    countsAfter: Array.isArray(item?.countsAfter)
      ? item.countsAfter.slice(0, 4).map((count) => Math.max(0, finiteNumber(count, 0)))
      : [],
  }));
}

export function sanitizePublicTributeContext(value) {
  if (!value || typeof value !== 'object') return null;
  const knownTransfers = Array.isArray(value.knownTransfers)
    ? value.knownTransfers.slice(0, 8).map((item) => ({
        card: publicCardView(item?.card),
        from: seatNumber(item?.from),
        to: seatNumber(item?.to),
        kind: item?.kind === 'return' ? 'return' : 'tribute',
      })).filter((item) => item.card && item.to != null)
    : [];
  return {
    gaveCard: publicCardView(value.gaveCard),
    gaveTo: seatNumber(value.gaveTo),
    receivedReturnCard: publicCardView(value.receivedReturnCard),
    receivedFrom: seatNumber(value.receivedFrom),
    firstLeadAfterTribute: value.firstLeadAfterTribute === true,
    doubleDown: value.doubleDown === true,
    knownTransfers,
  };
}

function scalarMap(value, type) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (type === 'boolean' && typeof item === 'boolean') result[key] = item;
    if (type === 'number' && Number.isFinite(Number(item))) result[key] = Number(item);
  }
  return Object.keys(result).length ? result : null;
}

/**
 * 构造唯一允许进入本地、Worker、云端候选器和未来价值网络的观察对象。
 */
export function createPublicAIObservation(ctx = {}) {
  const seat = seatNumber(ctx.seat, 0);
  const hand = Array.isArray(ctx.hand)
    ? ctx.hand.map((card) => publicCardView(card, { includeId: true })).filter(Boolean)
    : [];
  const counts = Array.isArray(ctx.handCounts)
    ? ctx.handCounts.slice(0, 4).map((count) => Math.max(0, finiteNumber(count, 0)))
    : [0, 0, 0, 0];
  while (counts.length < 4) counts.push(0);
  // 本家张数是确定信息；调用者若传来过期计数，以真实可见手牌为准。
  counts[seat] = hand.length;

  return {
    seat,
    hand,
    level: finiteNumber(ctx.level, 2),
    lastHand: publicHandView(ctx.lastHand),
    lastSeat: seatNumber(ctx.lastSeat),
    handCounts: counts,
    teams: Array.isArray(ctx.teams)
      ? ctx.teams.slice(0, 4).map((team) => finiteNumber(team, 0))
      : [0, 1, 0, 1],
    finishOrder: Array.isArray(ctx.finishOrder)
      ? ctx.finishOrder.map((item) => seatNumber(item)).filter((item) => item != null).slice(0, 4)
      : [],
    playedCards: Array.isArray(ctx.playedCards)
      ? ctx.playedCards.map((card) => publicCardView(card)).filter(Boolean)
      : [],
    publicHistory: sanitizePublicHistory(ctx.publicHistory),
    tributeContext: sanitizePublicTributeContext(ctx.tributeContext),
    difficulty: String(ctx.difficulty || 'normal'),
    deterministic: ctx.deterministic === true,
    timeBudgetMs: Math.max(0, finiteNumber(ctx.timeBudgetMs, 0)),
    policyProfile: ctx.policyProfile === 'baseline' ? 'baseline' : 'expert',
    policyFeatures: scalarMap(ctx.policyFeatures, 'boolean'),
    policyThresholds: scalarMap(ctx.policyThresholds, 'number'),
    leadAfterOwnBomb: ctx.leadAfterOwnBomb === true,
    decisionEngine: ctx.decisionEngine === 'hybrid' ? 'hybrid' : 'expert',
  };
}

export const FORBIDDEN_AI_OBSERVATION_FIELDS = Object.freeze([
  'hands', 'deck', 'initialHands', 'remainingHands', 'lastReplay', 'allHands',
  'opponentHands', 'partnerHand', 'hiddenCards',
]);

export function auditPublicAIObservation(observation) {
  const leaked = FORBIDDEN_AI_OBSERVATION_FIELDS.filter((key) => (
    Object.prototype.hasOwnProperty.call(observation || {}, key)
  ));
  const countTotal = Array.isArray(observation?.handCounts)
    ? observation.handCounts.reduce((sum, count) => sum + (Number(count) || 0), 0)
    : 0;
  return {
    ok: leaked.length === 0
      && Array.isArray(observation?.hand)
      && observation.hand.length === observation.handCounts?.[observation.seat],
    leaked,
    visibleCardCount: observation?.hand?.length || 0,
    publicPlayedCount: observation?.playedCards?.length || 0,
    remainingCardCount: countTotal,
  };
}
