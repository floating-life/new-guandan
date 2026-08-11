/**
 * Shared strategic scoring used by AI choice, coaching and human evaluation.
 * Rules in this module describe intent; card legality remains in rules.js.
 */
import { isJoker, isWild, removeCards, soloPower } from './cards.js';
import { HandType, formatHand, parseHand } from './rules.js';
import { inferPublicThreats, publicCoordinationScore } from './ai-route.js';

export function isStrategicBomb(hand) {
  return !!hand && [HandType.BOMB, HandType.FLUSH_STRAIGHT, HandType.JOKER_BOMB]
    .includes(hand.type);
}

export function wholeHandPlay(cards, level) {
  if (!cards?.length) return null;
  const hand = parseHand(cards, level);
  return hand ? { cards, hand } : null;
}

export function preferredTypesForEnemyCount(count) {
  if (count === 2 || count === 9) return [HandType.SINGLE];
  if (count === 5 || count === 10) return [HandType.PAIR];
  if (count === 6) return [HandType.TRIPLE];
  if (count === 7 || count === 8) return [HandType.STRAIGHT, HandType.FULLHOUSE];
  return [];
}

/**
 * 对家正在领牌时，判断下家是否可能在当前牌型上直接或近乎直接走完。
 * 该判断由 AI 与真人评价共用，避免一边建议拦截、一边又把拦截判成压队友。
 */
export function downstreamEnemyNeedsBlock(lastHand, ctx) {
  if (!lastHand) return false;
  const downstream = (ctx.seat + 1) % 4;
  const finishOrder = ctx.finishOrder || [];
  const teams = ctx.teams || [];
  if (finishOrder.includes(downstream) || teams[downstream] === teams[ctx.seat]) return false;
  const count = ctx.handCounts?.[downstream] ?? 99;
  if (lastHand.type === HandType.SINGLE) return count > 0 && count <= 2;
  if (isStrategicBomb(lastHand)) return false;
  return count > 0 && count <= 6 && count === lastHand.size;
}

function activeEnemies(ctx) {
  const finished = ctx.finishOrder || [];
  return (ctx.handCounts || []).map((count, seat) => ({ seat, count }))
    .filter((item) => item.seat !== ctx.seat
      && !finished.includes(item.seat)
      && ctx.teams?.[item.seat] !== ctx.teams?.[ctx.seat]);
}

/**
 * Per-decision cache for values that are identical across every candidate.
 * Keep one memo inside a single AI/evaluator decision only; never reuse it
 * after the hand or public context changes.
 */
export function createStrategicMemo(hand, level) {
  return { hand, level, values: new Map() };
}

function memoValue(ctx, hand, level, key, calculate) {
  const memo = ctx.strategyMemo;
  if (!memo || memo.hand !== hand || memo.level !== level || !(memo.values instanceof Map)) {
    return calculate();
  }
  if (!memo.values.has(key)) memo.values.set(key, calculate());
  return memo.values.get(key);
}

function isSimple(hand) {
  return [HandType.SINGLE, HandType.PAIR, HandType.TRIPLE].includes(hand?.type);
}

function addEvent(result, dimension, delta, tag, message) {
  result.events.push({ dimension, delta, tag: tag || null, message: message || '' });
}

function naturalRankCount(cards, rank, level) {
  return cards.filter((card) => !isJoker(card) && !isWild(card, level) && card.rank === rank).length;
}

/**
 * 统计当前可组成的炸弹数量。逢人配是有限资源：同一张逢人配只能补进
 * 一个点数组，不能同时把多组三张都虚算成炸弹。
 */
export function countPotentialBombs(cards, level) {
  const counts = new Map();
  let wilds = 0;
  let smallJokers = 0;
  let bigJokers = 0;
  for (const card of cards) {
    if (isWild(card, level)) {
      wilds += 1;
      continue;
    }
    if (card.rank === 16) {
      smallJokers += 1;
      continue;
    }
    if (card.rank === 17) {
      bigJokers += 1;
      continue;
    }
    counts.set(card.rank, (counts.get(card.rank) || 0) + 1);
  }
  let rankBombs = 0;
  const deficits = [];
  for (const count of counts.values()) {
    if (count >= 4) rankBombs += 1;
    else if (count > 0) deficits.push(4 - count);
  }
  deficits.sort((a, b) => a - b);
  let availableWilds = wilds;
  for (const needed of deficits) {
    if (needed > availableWilds) continue;
    availableWilds -= needed;
    rankBombs += 1;
  }
  return rankBombs + (smallJokers >= 2 && bigJokers >= 2 ? 1 : 0);
}

function looseSingleCount(cards, level) {
  const counts = new Map();
  for (const card of cards) {
    if (isJoker(card) || isWild(card, level)) continue;
    counts.set(card.rank, (counts.get(card.rank) || 0) + 1);
  }
  return [...counts.values()].filter((count) => count === 1).length;
}

const STRAIGHT_SEQUENCES = Object.freeze([
  Object.freeze([14, 2, 3, 4, 5]),
  ...Array.from({ length: 9 }, (_, index) => Object.freeze([
    index + 2, index + 3, index + 4, index + 5, index + 6,
  ])),
]);
const STRAIGHT_RANK_MASKS = STRAIGHT_SEQUENCES.map((sequence) => (
  sequence.reduce((mask, rank) => mask | (1 << (rank - 2)), 0)
));
const SUIT_INDEX = Object.freeze({ S: 0, H: 1, D: 2, C: 3 });
const DISJOINT_STRAIGHT_CACHE_LIMIT = 640;
const disjointStraightCache = new Map();
const RANK_STATE_WEIGHT = Array(15).fill(0);
for (let rank = 2; rank <= 14; rank++) RANK_STATE_WEIGHT[rank] = 9 ** (rank - 2);

/** Maximum number of five-card straights that can coexist. */
export function countDisjointStraights(cards, level) {
  const counts = Array(15).fill(0);
  let wilds = 0;
  for (const card of cards) {
    if (isWild(card, level)) wilds += 1;
    else if (!isJoker(card)) counts[card.rank] += 1;
  }
  let rankState = 0;
  for (let rank = 2; rank <= 14; rank++) {
    rankState += counts[rank] * RANK_STATE_WEIGHT[rank];
  }
  const handKey = rankState * 3 + wilds;
  if (disjointStraightCache.has(handKey)) {
    const cached = disjointStraightCache.get(handKey);
    disjointStraightCache.delete(handKey);
    disjointStraightCache.set(handKey, cached);
    return cached;
  }
  const memo = new Map();
  const search = (sequenceIndex, remainingState, remainingCounts, remainingWilds) => {
    if (sequenceIndex >= STRAIGHT_SEQUENCES.length) return 0;
    const key = (remainingState * 11 + sequenceIndex) * 3 + remainingWilds;
    if (memo.has(key)) return memo.get(key);
    let best = search(sequenceIndex + 1, remainingState, remainingCounts, remainingWilds);
    let nextState = remainingState;
    const nextCounts = remainingCounts.slice();
    let neededWilds = 0;
    for (const rank of STRAIGHT_SEQUENCES[sequenceIndex]) {
      const weight = RANK_STATE_WEIGHT[rank];
      if (nextCounts[rank] > 0) {
        nextCounts[rank] -= 1;
        nextState -= weight;
      }
      else neededWilds += 1;
    }
    if (neededWilds <= remainingWilds) {
      best = Math.max(
        best,
        1 + search(sequenceIndex, nextState, nextCounts, remainingWilds - neededWilds),
      );
    }
    memo.set(key, best);
    return best;
  };
  const result = search(0, rankState, counts, wilds);
  disjointStraightCache.set(handKey, result);
  if (disjointStraightCache.size > DISJOINT_STRAIGHT_CACHE_LIMIT) {
    disjointStraightCache.delete(disjointStraightCache.keys().next().value);
  }
  return result;
}

function potentialFlushStraightCount(cards, level) {
  let wilds = 0;
  const suitMasks = [0, 0, 0, 0];
  for (const card of cards) {
    if (isWild(card, level)) wilds += 1;
    else if (!isJoker(card) && SUIT_INDEX[card.suit] != null) {
      suitMasks[SUIT_INDEX[card.suit]] |= 1 << (card.rank - 2);
    }
  }
  if (!wilds) return 0;
  let count = 0;
  for (const suitMask of suitMasks) {
    for (const sequenceMask of STRAIGHT_RANK_MASKS) {
      const missing = 5 - popcount13(suitMask & sequenceMask);
      if (missing > 0 && missing <= wilds) count += 1;
    }
  }
  return count;
}

/** 只统计当前已经可以组成的同花顺，不把缺牌当成未来可能。 */
export function completedFlushStraightCount(cards, level) {
  let wilds = 0;
  const suitMasks = [0, 0, 0, 0];
  for (const card of cards) {
    if (isWild(card, level)) wilds += 1;
    else if (!isJoker(card) && SUIT_INDEX[card.suit] != null) {
      suitMasks[SUIT_INDEX[card.suit]] |= 1 << (card.rank - 2);
    }
  }
  let count = 0;
  for (const suitMask of suitMasks) {
    for (const sequenceMask of STRAIGHT_RANK_MASKS) {
      const missing = 5 - popcount13(suitMask & sequenceMask);
      if (missing <= wilds) count += 1;
    }
  }
  return count;
}

function popcount13(value) {
  let count = 0;
  let remaining = value;
  while (remaining) {
    remaining &= remaining - 1;
    count += 1;
  }
  return count;
}

function strongControlCount(cards, level) {
  return countPotentialBombs(cards, level)
    + completedFlushStraightCount(cards, level)
    + cards.filter((card) => isJoker(card) || card.rank === level).length;
}

function expertWeight(ctx) {
  if (ctx.policyProfile === 'baseline') return 0;
  const requested = Number(ctx.strategyWeight);
  return Number.isFinite(requested) ? Math.max(0, Math.min(1.25, requested)) : 1;
}

function addExpertScore(result, ctx, score, dimension, eventDelta, tag, reason, message = reason) {
  const weight = expertWeight(ctx);
  if (weight <= 0 || !score) return;
  result.score += score * weight;
  if (tag && !result.tags.includes(tag)) result.tags.push(tag);
  if (reason && !result.reasons.includes(reason)) result.reasons.push(reason);
  if (dimension && eventDelta) {
    addEvent(result, dimension, Math.round(eventDelta * weight), tag, message);
  }
}

function knownCards(ctx, handBefore) {
  const result = [];
  const seenIds = new Set();
  for (const card of [...handBefore, ...(ctx.playedCards || [])]) {
    if (!card || !Number.isFinite(card.rank)) continue;
    const id = card.id == null ? null : String(card.id);
    if (id != null && seenIds.has(id)) continue;
    if (id != null) seenIds.add(id);
    result.push(card);
  }
  return result;
}

/**
 * 只根据“本家手牌 + 已公开牌”计算牌池里还可能存在多少种更高同型。
 * 它不推断这些牌实际属于哪一家，因此不会读取或还原暗牌。
 */
function unseenHigherSimpleOptions(play, ctx, handBefore, precomputedKnown = null) {
  if (!isSimple(play.hand)) return 0;
  const needed = play.hand.type === HandType.SINGLE
    ? 1 : play.hand.type === HandType.PAIR ? 2 : 3;
  const known = precomputedKnown || knownCards(ctx, handBefore);
  const knownByRank = new Map();
  for (const card of known) {
    knownByRank.set(card.rank, (knownByRank.get(card.rank) || 0) + 1);
  }
  const unseenWilds = Math.max(
    0,
    2 - known.filter((card) => isWild(card, ctx.level)).length,
  );
  const currentPower = Number(play.hand.power) || 0;
  let options = 0;
  for (const rank of [...Array.from({ length: 13 }, (_, i) => i + 2), 16, 17]) {
    const power = soloPower({ rank }, ctx.level);
    if (power <= currentPower) continue;
    const total = rank >= 16 ? 2 : 8;
    const unseenAtRank = Math.max(0, total - (knownByRank.get(rank) || 0));
    const wildcardHelp = rank !== ctx.level && rank < 16 ? unseenWilds : 0;
    if (unseenAtRank + wildcardHelp >= needed) options += 1;
  }
  return options;
}

function canRetakeSameType(play, remaining, level) {
  if (!isSimple(play.hand) || remaining.length === 0) return false;
  const needed = play.hand.type === HandType.SINGLE
    ? 1 : play.hand.type === HandType.PAIR ? 2 : 3;
  const wilds = remaining.filter((card) => isWild(card, level)).length;
  const counts = new Map();
  for (const card of remaining) {
    if (isJoker(card) || isWild(card, level)) continue;
    counts.set(card.rank, (counts.get(card.rank) || 0) + 1);
  }
  if (needed === 1) {
    for (const card of remaining) {
      if (soloPower(card, level) > play.hand.power) return true;
    }
  } else {
    for (const [rank, count] of counts) {
      if (soloPower({ rank }, level) > play.hand.power && count + wilds >= needed) return true;
    }
  }
  return countPotentialBombs(remaining, level) > 0;
}

function summarizePublicHistory(ctx) {
  const leadTypes = Array.from({ length: 4 }, () => new Map());
  const passTypes = Array.from({ length: 4 }, () => new Map());
  const tricks = new Map();
  for (const item of ctx.publicHistory || []) {
    const seat = Number(item?.seat);
    if (!Number.isInteger(seat) || seat < 0 || seat > 3) continue;
    const key = Number.isFinite(Number(item?.trickNumber))
      ? Number(item.trickNumber) : Number(item?.turn) || 0;
    if (!tricks.has(key)) {
      tricks.set(key, {
        targetType: null,
        lastPlayer: null,
        lastType: null,
        lastSize: 0,
        lastCardsShed: 0,
        hasPlay: false,
      });
    }
    const trick = tricks.get(key);
    if (item.action === 'play' && item.hand?.type) {
      if (!trick.hasPlay) {
        leadTypes[seat].set(item.hand.type, (leadTypes[seat].get(item.hand.type) || 0) + 1);
      }
      trick.hasPlay = true;
      trick.targetType = item.hand.type;
      trick.lastPlayer = seat;
      trick.lastType = item.hand.type;
      trick.lastSize = Number(item.hand.size) || item.cards?.length || 0;
      const before = Number(item.countsBefore?.[seat]);
      const after = Number(item.countsAfter?.[seat]);
      trick.lastCardsShed = Number.isFinite(before) && Number.isFinite(after)
        ? Math.max(0, before - after)
        : trick.lastSize;
    } else if (item.action === 'pass' && trick.targetType) {
      passTypes[seat].set(trick.targetType, (passTypes[seat].get(trick.targetType) || 0) + 1);
    }
  }
  const controlledTricks = [...tricks.values()].filter((trick) => trick.hasPlay);
  const recentControllers = controlledTricks.map((trick) => trick.lastPlayer).slice(-3);
  const controlStreak = {
    seat: null,
    count: 0,
    singleCount: 0,
    allSingles: false,
    cardsShed: 0,
  };
  const latest = controlledTricks[controlledTricks.length - 1];
  if (latest) {
    controlStreak.seat = latest.lastPlayer;
    controlStreak.allSingles = true;
    for (let index = controlledTricks.length - 1; index >= 0; index--) {
      const trick = controlledTricks[index];
      if (trick.lastPlayer !== controlStreak.seat) break;
      controlStreak.count += 1;
      controlStreak.cardsShed += trick.lastCardsShed || trick.lastSize || 0;
      if (trick.lastType === HandType.SINGLE) controlStreak.singleCount += 1;
      else controlStreak.allSingles = false;
    }
  }
  return {
    leadTypes, passTypes, recentControllers, controlStreak,
  };
}

function mostFrequentType(typeMap) {
  let best = null;
  let count = 0;
  for (const [type, value] of typeMap || []) {
    if (value > count) {
      best = type;
      count = value;
    }
  }
  return { type: best, count };
}

function ownHandRole(
  cards,
  level,
  bombs = countPotentialBombs(cards, level),
  looseSingles = looseSingleCount(cards, level),
) {
  const controls = cards.filter(
    (card) => isJoker(card) || card.rank === level || card.rank === 14,
  ).length;
  return {
    bombs,
    looseSingles,
    controls,
    weak: cards.length >= 10 && bombs === 0 && looseSingles >= Math.max(4, cards.length / 4),
    strong: bombs >= 2 || (bombs >= 1 && controls >= 4),
  };
}

function isJokerControl(hand) {
  return !!hand
    && [HandType.SINGLE, HandType.PAIR].includes(hand.type)
    && hand.mainRank >= 16;
}

function isPremiumSimpleControl(hand, level) {
  return !!hand
    && [HandType.SINGLE, HandType.PAIR, HandType.TRIPLE].includes(hand.type)
    && (hand.mainRank >= 16 || hand.mainRank === level);
}

function sameCardFace(left, right) {
  return !!left && !!right && left.rank === right.rank && left.suit === right.suit;
}

function hasReadyPair(cards, level) {
  const counts = new Map();
  let wilds = 0;
  for (const card of cards) {
    if (isWild(card, level)) {
      wilds += 1;
      continue;
    }
    if (isJoker(card)) continue;
    counts.set(card.rank, (counts.get(card.rank) || 0) + 1);
  }
  if ([...counts.values()].some((count) => count >= 2)) return true;
  if (wilds >= 2) return true;
  return wilds >= 1 && [...counts.keys()].some((rank) => rank < 16);
}

/**
 * @param {{cards:Array, hand:Object}} play
 * @param {object} ctx hand, level, mode, seat, teams, handCounts, finishOrder,
 * lastHand, lastSeat and playedCards.
 */
export function evaluateStrategicPlay(play, ctx) {
  const handBefore = ctx.hand || ctx.handBefore || [];
  const mode = ctx.mode || (ctx.lastHand ? 'beat' : 'lead');
  const level = ctx.level;
  const enemies = memoValue(ctx, handBefore, level, 'activeEnemies', () => activeEnemies(ctx));
  const nearest = enemies.reduce(
    (best, enemy) => (!best || enemy.count < best.count ? enemy : best),
    null,
  );
  const downstream = (ctx.seat + 1) % 4;
  const upstream = (ctx.seat + 3) % 4;
  const partner = (ctx.seat + 2) % 4;
  const partnerFinished = (ctx.finishOrder || []).includes(partner);
  const result = {
    score: 0,
    tags: [],
    reasons: [],
    events: [],
    remaining: removeCards(handBefore, play.cards),
    followUpFinish: null,
    createsTwoStepFinish: false,
  };
  const publicModel = ctx.publicModel || memoValue(
    ctx,
    handBefore,
    level,
    'publicModel',
    () => inferPublicThreats({ ...ctx, hand: handBefore, level }),
  );
  const publicCoordination = publicCoordinationScore(
    play,
    { ...ctx, hand: handBefore, level, mode },
    publicModel,
  );
  if (publicCoordination.score) {
    const weight = expertWeight(ctx);
    result.score += publicCoordination.score * weight;
    for (const tag of publicCoordination.tags) {
      if (!result.tags.includes(tag)) result.tags.push(tag);
    }
    for (const reason of publicCoordination.reasons) {
      if (!result.reasons.includes(reason)) result.reasons.push(reason);
    }
    addEvent(
      result,
      mode === 'lead' ? 'cooperation' : 'defense',
      Math.round(Math.max(-8, Math.min(8, publicCoordination.score / 3)) * weight),
      publicCoordination.tags[0] || null,
      publicCoordination.reasons[0] || '公开信息模型调整了本手牌权价值',
    );
  }
  result.followUpFinish = wholeHandPlay(result.remaining, level);
  result.createsTwoStepFinish = result.remaining.length > 0 && !!result.followUpFinish;

  const bombsBefore = memoValue(
    ctx, handBefore, level, 'bombsBefore', () => countPotentialBombs(handBefore, level),
  );
  const looseBefore = memoValue(
    ctx, handBefore, level, 'looseBefore', () => looseSingleCount(handBefore, level),
  );
  const bombsAfter = countPotentialBombs(result.remaining, level);
  const looseAfter = looseSingleCount(result.remaining, level);
  const lostPotentialBombs = Math.max(0, bombsBefore - bombsAfter);
  const compositeReorganization = [
    HandType.PLATE, HandType.TRIPLE_PAIR, HandType.FULLHOUSE,
  ].includes(play.hand.type);
  const survivalLongCombo = partnerFinished
    && mode === 'lead'
    && !isStrategicBomb(play.hand)
    && play.cards.length >= 5;
  const productiveRestructure = lostPotentialBombs > 0
    && compositeReorganization
    && completedFlushStraightCount(result.remaining, level) > 0
    && looseAfter <= looseBefore + 1;
  result.productiveRestructure = productiveRestructure;

  // 同一点数的实体牌并不总是等价：例如出一对 7 时，选错花色可能把已经
  // 成型的黑桃同花顺拆掉。按实际剩余花色比较，让 AI、教练与评分共同优先
  // 采用损失更少的实体组合，而不是依赖候选生成顺序。
  const completedFlushesBefore = memoValue(
    ctx,
    handBefore,
    level,
    'completedFlushesBefore',
    () => completedFlushStraightCount(handBefore, level),
  );
  const completedFlushesAfter = completedFlushStraightCount(result.remaining, level);
  const flushStraightLoss = Math.max(
    0,
    completedFlushesBefore - completedFlushesAfter,
  );
  if (completedFlushesBefore > 0
    && completedFlushesAfter === 0
    && !result.createsTwoStepFinish
    && !productiveRestructure
    && !survivalLongCombo
    && play.hand.type !== HandType.FLUSH_STRAIGHT) {
    addExpertScore(
      result,
      ctx,
      -320,
      'structure',
      -12,
      'split_flush_straight',
      `本手会打散全部${flushStraightLoss}组已成型同花顺，应优先使用仍能保留强控牌的同型实体牌`,
    );
  } else if (completedFlushesAfter > 0
    && play.cards.length >= 5
    && !isStrategicBomb(play.hand)
    && !result.createsTwoStepFinish
    && !productiveRestructure) {
    addExpertScore(
      result,
      ctx,
      125,
      'structure',
      8,
      'flush_preserving_combo',
      `一次走掉${play.cards.length}张，同时保留成品同花顺作为后续强控制`,
    );
  }

  if (result.createsTwoStepFinish) {
    result.score += 170;
    result.tags.push('two_step_finish');
    result.reasons.push(`夺权后剩余牌可用${formatHand(result.followUpFinish.hand)}一手收完`);
    addEvent(
      result,
      'endgame',
      20,
      null,
      `本手夺权后，剩余牌可用${formatHand(result.followUpFinish.hand)}一手收完，形成明确的两手收官路线。`,
    );

    const leadsJokerControl = isJokerControl(play.hand)
      && !isStrategicBomb(result.followUpFinish.hand)
      && result.followUpFinish.hand.size >= 2;
    const keepsJokerControl = isJokerControl(result.followUpFinish.hand)
      && play.cards.length >= 2
      && !isStrategicBomb(play.hand);
    if (leadsJokerControl) {
      addExpertScore(
        result,
        ctx,
        -190,
        'resources',
        -12,
        'control_first',
        `两手收官不应先交${formatHand(play.hand)}，应先走组合并把王留作最后单牌控制`,
      );
    } else if (keepsJokerControl) {
      addExpertScore(
        result,
        ctx,
        105,
        'endgame',
        10,
        'control_last',
        `先走${formatHand(play.hand)}，保留${formatHand(result.followUpFinish.hand)}作为最后收尾牌`,
      );
    }
  }

  const straightLoss = Math.max(
    0,
    memoValue(
      ctx,
      handBefore,
      level,
      'straightBefore',
      () => countDisjointStraights(handBefore, level),
    ) - countDisjointStraights(result.remaining, level),
  );
  if (straightLoss > 0
    && !productiveRestructure
    && !survivalLongCombo
    && ![HandType.STRAIGHT, HandType.FLUSH_STRAIGHT].includes(play.hand.type)) {
    result.score -= 220 + (straightLoss - 1) * 40;
    result.tags.push('split_straight');
    result.reasons.push('避免打掉顺子的唯一关键点数');
  }

  // Shared structure protection: do not solve a single-card response by
  // tearing apart a pair/triple/bomb when an independent card can be kept.
  if (play.hand.type === HandType.SINGLE && play.cards.length === 1 && result.remaining.length) {
    const count = naturalRankCount(handBefore, play.cards[0].rank, level);
    if (count === 2) {
      result.score -= 170;
      result.tags.push('split_pair');
      result.reasons.push('避免拆对子后留下第二张单牌');
    } else if (count === 3) {
      result.score -= 100;
      result.tags.push('split_group');
      result.reasons.push('避免从三同张中拆单');
    } else if (count >= 4) {
      result.score -= 280;
      result.tags.push('split_bomb');
      result.reasons.push('避免拆炸弹出单张');
    }
  } else if (play.hand.type === HandType.PAIR && play.cards.length === 2 && result.remaining.length) {
    const count = naturalRankCount(handBefore, play.cards[0].rank, level);
    if (count === 3) {
      result.score -= 110;
      result.tags.push('split_group');
      result.reasons.push('避免从三同张中拆对子');
    } else if (count >= 4) {
      result.score -= 220;
      result.tags.push('split_bomb');
      result.reasons.push('避免拆炸弹出对子');
    }
  }

  if (play.hand.type === HandType.TRIPLE
    && result.remaining.length >= 2
    && hasReadyPair(result.remaining, level)) {
    const pairIsWholeRemainder = result.followUpFinish?.hand?.type === HandType.PAIR;
    addExpertScore(
      result,
      ctx,
      pairIsWholeRemainder ? -105 : -62,
      'structure',
      pairIsWholeRemainder ? -9 : -6,
      'split_ready_fullhouse',
      pairIsWholeRemainder
        ? '现成三带二被拆成“三张后再出对子”，多耗一圈且先交大牌'
        : '手中已有可配对子，优先比较整手三带二，避免孤立打出三张',
    );
  }

  if (productiveRestructure) {
    addExpertScore(
      result,
      ctx,
      125,
      'structure',
      16,
      'productive_restructure',
      `把重复三张整合为${formatHand(play.hand)}，同时保留成品同花顺，实际降低手数的收益高于潜在炸弹损失`,
      `本手组成${formatHand(play.hand)}并保留成品同花顺，是降低手数且保留强控制的有效重组。`,
    );
  } else if (lostPotentialBombs > 0
    && !isStrategicBomb(play.hand)
    && !result.tags.includes('split_bomb')) {
    const expert = expertWeight(ctx) > 0;
    const enemyEmergency = downstreamEnemyNeedsBlock(ctx.lastHand, ctx);
    const splitPenalty = !expert
      ? 320
      : result.createsTwoStepFinish ? 70
        : enemyEmergency ? 130
          : 270;
    result.score -= splitPenalty * lostPotentialBombs;
    result.tags.push('split_bomb');
    result.reasons.push(
      result.createsTwoStepFinish && expert
        ? '拆炸可换取明确两手收完，但仍计入未来控场成本'
        : lostPotentialBombs > 1
          ? `避免普通牌型同时拆掉${lostPotentialBombs}个潜在炸弹`
          : '避免普通牌型拆掉潜在炸弹',
    );
  }

  const tribute = ctx.tributeContext;
  if (mode === 'lead' && tribute?.firstLeadAfterTribute) {
    const received = tribute.receivedReturnCard;
    const gaveJokerToPartner = isJoker(tribute.gaveCard)
      && tribute.gaveTo != null
      && ctx.teams?.[tribute.gaveTo] === ctx.teams?.[ctx.seat];
    const lowReturn = received
      && !isJoker(received)
      && received.rank !== level
      && received.rank <= 6;
    const playsReturnedSingle = lowReturn
      && play.hand.type === HandType.SINGLE
      && play.cards.length === 1
      && sameCardFace(play.cards[0], received);
    const breaksStructure = result.tags.some((tag) => (
      ['split_pair', 'split_group', 'split_bomb', 'split_straight'].includes(tag)
    ));
    if (playsReturnedSingle && !breaksStructure) {
      addExpertScore(
        result,
        ctx,
        gaveJokerToPartner ? 105 : 58,
        'cooperation',
        gaveJokerToPartner ? 9 : 6,
        'returned_single_lead',
        gaveJokerToPartner
          ? `进贡给对家王后收到${received.rank}点小返牌，首领该单张以兑现贡还配合`
          : `首领收到的${received.rank}点独立返牌，优先清理低单张`,
      );
    }
    if (result.remaining.length > 0 && isPremiumSimpleControl(play.hand, level)) {
      addExpertScore(
        result,
        ctx,
        -115,
        'resources',
        -10,
        'premium_tribute_opening',
        '贡还后的首领不应先交王或级牌控制，应优先走返还小牌或普通牌型',
      );
    }
  }

  if (mode === 'lead' && nearest) {
    const preferred = preferredTypesForEnemyCount(nearest.count);
    if (preferred.length) {
      const breaksStructure = result.tags.some((tag) => (
        ['split_pair', 'split_group', 'split_bomb', 'split_straight'].includes(tag)
      ));
      if (preferred.includes(play.hand.type) && !breaksStructure) {
        const label = nearest.count === 5 || nearest.count === 10
          ? '对子' : nearest.count === 6
            ? '三张' : nearest.count === 7 || nearest.count === 8 ? '顺子或三带二' : '单张';
        const routeBonus = nearest.count === 5 ? 35
          : nearest.count === 6 ? 30
            : nearest.count === 7 || nearest.count === 8 ? 25 : 20;
        result.score += expertWeight(ctx) > 0
          ? routeBonus * expertWeight(ctx)
          : nearest.count <= 6 ? 420 : 300;
        result.tags.push('enemy_count_route');
        result.reasons.push(`对手剩${nearest.count}张，${label}仅作残局软参考`);
        addEvent(result, 'defense', 4, 'enemy_count_route', `对手剩${nearest.count}张，本手牌型符合残局控牌参考，但仍服从牌面结构。`);
      } else if (!preferred.includes(play.hand.type) && !isStrategicBomb(play.hand)) {
        result.score -= expertWeight(ctx) > 0
          ? (nearest.count <= 6 ? 10 : 6) * expertWeight(ctx)
          : nearest.count <= 6 ? 35 : 20;
      }
    }
  }

  const downstreamEnemy = enemies.find((item) => item.seat === downstream);
  if (mode === 'lead' && downstreamEnemy?.count <= 5) {
    if (play.hand.type === HandType.SINGLE) {
      result.score += Math.max(-10, (play.hand.power - 8) * 4);
      if (play.hand.power >= 10) {
        result.tags.push('hold_downstream');
        result.reasons.push('下家牌少，用较高单张卡住牌路');
        addEvent(result, 'defense', 5, null, '下家牌少，以较高单张限制其顺牌。');
      }
    }
    if (downstreamEnemy.count === 2 && play.hand.type === HandType.PAIR) result.score -= 38;
  }

  if (mode === 'beat' && ctx.lastSeat === upstream) {
    const upstreamEnemy = enemies.find((item) => item.seat === upstream);
    if (upstreamEnemy?.count <= 10 && !isStrategicBomb(play.hand)) {
      result.score += 28;
      result.tags.push('block_upstream');
      result.reasons.push('顶住上家，避免其连续控圈');
      addEvent(result, 'defense', 5, null, '及时顶住上家，避免其连续控圈。');
    }
  }

  const partnerCount = ctx.handCounts?.[partner] ?? 99;
  const history = memoValue(
    ctx, handBefore, level, 'publicHistory', () => summarizePublicHistory(ctx),
  );
  const role = memoValue(
    ctx,
    handBefore,
    level,
    'handRole',
    () => ownHandRole(handBefore, level, bombsBefore, looseBefore),
  );

  // 对家已经头游/出完后，己方目标从“护送对家”切换为“保住三游”。
  // 此时少打一手比保留一个孤立小组合更重要，但仍不无条件交炸弹。
  if (partnerFinished && mode === 'lead') {
    if (survivalLongCombo) {
      addExpertScore(
        result,
        ctx,
        185,
        'endgame',
        12,
        'survival_shed_combo',
        `对家已出完，优先用${formatHand(play.hand)}长组合降低手数，保住三游并避免末游`,
      );
    }
    const fragmentsGroup = play.hand.type === HandType.SINGLE
      && result.tags.some((tag) => ['split_pair', 'split_group', 'split_bomb'].includes(tag));
    if (fragmentsGroup) {
      addExpertScore(
        result,
        ctx,
        -150,
        'structure',
        -10,
        'survival_fragment',
        '对家已出完后不宜再拆组合领小单张，应优先降低总手数以避免末游',
      );
    }
    if (isStrategicBomb(play.hand) && result.remaining.length > 0
      && !result.createsTwoStepFinish) {
      addExpertScore(
        result,
        ctx,
        -105,
        'resources',
        -8,
        'survival_preserve_control',
        '对家已出完时保留炸弹作为争三游的后手控制，避免无收官路线地领炸',
      );
    }
  }

  if (mode === 'lead' && !partnerFinished
    && partnerCount > 0 && partnerCount <= 5 && handBefore.length >= 10) {
    if (isStrategicBomb(play.hand)) result.score -= 85;
    if (isSimple(play.hand) && play.hand.power <= 9) {
      result.score += 28;
      result.tags.push('help_partner');
      result.reasons.push('己方牌较长，先送较小牌型帮助对家接手');
      addEvent(result, 'cooperation', 5, null, '己方牌较长，先送较小牌型帮助对家接手。');
    }
  }

  if (mode === 'lead' && !partnerFinished && partnerCount > 0 && partnerCount <= 10
    && role.weak && isSimple(play.hand) && play.hand.power <= 9) {
    addExpertScore(
      result,
      ctx,
      22,
      'cooperation',
      5,
      'weak_hand_support',
      '本家结构偏弱，优先用较小牌路协助对家主攻',
    );
  }

  if (mode === 'lead' && result.remaining.length > 0 && isSimple(play.hand)) {
    if (canRetakeSameType(play, result.remaining, level)) {
      addExpertScore(
        result,
        ctx,
        handBefore.length <= 10 ? 32 : 18,
        'endgame',
        5,
        'self_retake',
        '保留更高同型回手牌，形成“谁打谁收”的连续路线',
      );
    } else if (handBefore.length <= 8 && nearest?.count <= 8) {
      addExpertScore(
        result,
        ctx,
        -14,
        'endgame',
        -3,
        'no_retake',
        '残局领出后缺少同型回手，牌权路线较脆弱',
      );
    }
  }

  const partnerLead = mostFrequentType(history.leadTypes[partner]);
  if (mode === 'lead' && !partnerFinished && partnerCount <= 10
    && partnerLead.count >= 2 && partnerLead.type === play.hand.type
    && (!isSimple(play.hand) || play.hand.power <= 10)) {
    addExpertScore(
      result,
      ctx,
      role.weak ? 24 : 14,
      'cooperation',
      4,
      'public_partner_route',
      `公开出牌记录显示对家多次主动走${formatHand(play.hand)}类牌路，可尝试配合`,
    );
  }

  const partnerPasses = history.passTypes[partner].get(play.hand.type) || 0;
  if (mode === 'lead' && !partnerFinished && partnerCount <= 8 && partnerPasses >= 2) {
    addExpertScore(
      result,
      ctx,
      -8,
      'cooperation',
      -2,
      'partner_route_uncertain',
      '对家曾多次在该牌型上过牌，只降低接牌概率，不作确定判断',
    );
  }

  const enemyPassEvidence = enemies.reduce(
    (sum, enemy) => sum + (history.passTypes[enemy.seat].get(play.hand.type) || 0),
    0,
  );
  if (mode === 'lead' && enemyPassEvidence >= 3 && !isStrategicBomb(play.hand)) {
    addExpertScore(
      result,
      ctx,
      Math.min(16, 6 + enemyPassEvidence * 2),
      'defense',
      3,
      'public_type_probe',
      '对手公开过牌记录显示该牌型概率偏弱，可作试探，但不视为一定没有',
    );
  }

  const lastTwoControllers = history.recentControllers.slice(-2);
  const controllingEnemy = enemies.find((enemy) => enemy.seat === ctx.lastSeat);
  if (mode === 'beat' && ctx.lastSeat != null
    && ctx.teams?.[ctx.lastSeat] !== ctx.teams?.[ctx.seat]
    && controllingEnemy?.count <= 10
    && lastTwoControllers.length === 2
    && lastTwoControllers.every((seat) => seat === ctx.lastSeat)) {
    addExpertScore(
      result,
      ctx,
      isStrategicBomb(play.hand) ? 38 : 30,
      'defense',
      6,
      'stop_opponent_run',
      '对手已连续取得公开牌权，本手提高拦截优先级',
    );
  }

  const streak = history.controlStreak;
  const runningEnemy = enemies.find((enemy) => enemy.seat === ctx.lastSeat);
  const repeatedSingleThreat = mode === 'beat'
    && ctx.lastHand?.type === HandType.SINGLE
    && runningEnemy?.count <= 10
    && streak.seat === ctx.lastSeat
    && streak.allSingles
    && streak.singleCount >= 2
    // 对手剩 5 张以内时，两圈连续走单就已足以形成明确收尾威胁；
    // 其他中盘情形仍要求三圈或本家进入十张残局，避免无谓拆牌。
    && (streak.singleCount >= 3
      || handBefore.length <= 10
      || (runningEnemy.count <= 5 && streak.singleCount >= 2));
  if (repeatedSingleThreat && play.hand.type === HandType.SINGLE) {
    const splitTag = result.tags.includes('split_pair')
      ? 'split_pair' : result.tags.includes('split_group') ? 'split_group' : null;
    // 继续整手过牌会让对手免费清理所有单张。先使用独立单张，
    // 没有时才拆最小对子，再次才考虑三张；炸弹仍不在此处拆。
    const interceptScore = splitTag === 'split_pair'
      ? 300 : splitTag === 'split_group' ? 190 : 180;
    addExpertScore(
      result,
      ctx,
      interceptScore,
      'defense',
      splitTag ? 10 : 12,
      'stop_single_run',
      splitTag === 'split_pair'
        ? `对手已连续走单${streak.singleCount}圈且剩${runningEnemy.count}张，条件性拆最小对子拦截`
        : splitTag === 'split_group'
          ? `对手已连续走单${streak.singleCount}圈且剩${runningEnemy.count}张，无对子可拆时才从三张中拦截`
          : `对手已连续走单${streak.singleCount}圈且剩${runningEnemy.count}张，优先用独立单张中断其牌路`,
    );
  }

  const usesWild = play.cards.some((card) => isWild(card, level));
  const wildTargetEnemy = enemies.find((enemy) => enemy.seat === ctx.lastSeat);
  const urgentWildBlock = mode === 'beat' && !!wildTargetEnemy && wildTargetEnemy.count <= 4;
  const spendsWildWithoutFinish = usesWild
    && !isStrategicBomb(play.hand)
    && result.remaining.length > 0
    && !result.createsTwoStepFinish
    && !urgentWildBlock;
  if (spendsWildWithoutFinish) {
    const wildAsSingle = play.hand.type === HandType.SINGLE;
    addExpertScore(
      result,
      ctx,
      wildAsSingle ? -210 : -90,
      'resources',
      wildAsSingle ? -14 : -8,
      wildAsSingle ? 'wild_as_single' : 'wild_simple_use',
      wildAsSingle
        ? '非紧急情况下不要把逢人配当单张控制牌，优先用普通牌或等待更高收益'
        : `非紧急情况下用逢人配组成${formatHand(play.hand)}会消耗最灵活的组牌资源`,
    );
  }
  const ordinaryWildType = [
    HandType.STRAIGHT, HandType.TRIPLE_PAIR, HandType.PLATE, HandType.FULLHOUSE,
  ].includes(play.hand.type);
  const singlesReduced = looseBefore - looseAfter;
  if (usesWild && ordinaryWildType) {
    const urgentBlock = mode === 'beat' && !!wildTargetEnemy && wildTargetEnemy.count <= 5;
    const clearFinishRoute = result.remaining.length === 0 || result.createsTwoStepFinish;
    const premiumOpportunity = memoValue(
      ctx,
      handBefore,
      level,
      'flushStraightBefore',
      () => potentialFlushStraightCount(handBefore, level),
    ) > 0 || bombsBefore > bombsAfter;
    if (clearFinishRoute && singlesReduced >= 2) {
      addExpertScore(
        result,
        ctx,
        26,
        'endgame',
        6,
        'wild_consolidation',
        result.remaining.length === 0
          ? '逢人配用于普通组合但可整手走完，收官优先'
          : `逢人配用于普通组合后形成明确两手收官，并减少${singlesReduced}个散张`,
      );
    } else if (!urgentBlock) {
      addExpertScore(
        result,
        ctx,
        premiumOpportunity ? -96 : -64,
        'resources',
        premiumOpportunity ? -10 : -8,
        'preserve_wild',
        premiumOpportunity
          ? '逢人配可保留用于潜在炸弹或同花顺，不宜中盘拼普通牌型'
          : '没有明确收官或紧急阻断时，避免用逢人配拼普通顺子或组合',
      );
    }
  }

  if (isStrategicBomb(play.hand)) {
    const targetEnemy = enemies.find((enemy) => enemy.seat === ctx.lastSeat);
    const otherEnemyCritical = enemies.some((enemy) => (
      enemy.seat !== ctx.lastSeat && enemy.count <= 4
    ));
    const targetImmediate = !!targetEnemy && (targetEnemy.count <= 4
      || targetEnemy.count === ctx.lastHand?.size);
    const retainsAnotherControl = strongControlCount(result.remaining, level) > 0;
    const quickClose = result.createsTwoStepFinish || result.remaining.length <= 3;
    const bombHasSurvivalGain = quickClose || retainsAnotherControl || otherEnemyCritical;
    const preserveForThird = mode === 'beat'
      && partnerFinished
      && !!targetEnemy
      && !bombHasSurvivalGain;

    if (preserveForThird) {
      addExpertScore(
        result,
        ctx,
        -210,
        'resources',
        -12,
        'survival_preserve_control',
        '对家已头游，可允许当前对手争二游；保留唯一强控制去压另一名对手，才能保住三游、避免末游',
      );
    } else if (targetImmediate || otherEnemyCritical || result.createsTwoStepFinish) {
      addExpertScore(
        result,
        ctx,
        targetImmediate || otherEnemyCritical ? 70 : 45,
        'defense',
        8,
        'timely_bomb',
        otherEnemyCritical && !targetImmediate
          ? '另一名对手已进入4张内残局，及时炸开抢回牌权'
          : targetImmediate
            ? '当前对手进入真正可走完区间，及时用炸弹夺权'
            : '炸后已有明确两手收官路线',
      );
    } else if (mode === 'beat' && result.remaining.length > 0) {
      addExpertScore(
        result,
        ctx,
        -58,
        'resources',
        -6,
        'preserve_strong_control',
        `当前只能动用${formatHand(play.hand)}接牌，对手未进入紧急收官，保留强控制等待更高收益`,
      );
    } else if (mode === 'lead' && handBefore.length > 10 && nearest?.count > 8) {
      addExpertScore(
        result,
        ctx,
        -36,
        'resources',
        -5,
        'premature_bomb',
        '中盘威胁不紧迫且炸后无收官路线，保留未来控场选择',
      );
    }
  }

  if (mode === 'lead' && ctx.leadAfterOwnBomb) {
    const loose = looseBefore;
    const independentSingle = play.hand.type === HandType.SINGLE
      && play.cards.length === 1
      && naturalRankCount(handBefore, play.cards[0].rank, level) === 1;
    if (loose > 0 && independentSingle) {
      result.score += expertWeight(ctx) > 0 ? 58 * expertWeight(ctx) : 300;
      result.tags.push('single_after_bomb');
      result.reasons.push('炸弹夺权后先放独立单张，保留组合继续控制');
      addEvent(result, 'structure', 10, null, '炸弹夺权后先清理独立单张，保留组合牌继续控制。');
    } else if (loose > 0 && !isStrategicBomb(play.hand)) {
      result.score -= expertWeight(ctx) > 0 ? 24 * expertWeight(ctx) : 75;
    }
  }

  if (isStrategicBomb(play.hand) && !partnerFinished
    && partnerCount > 0 && partnerCount <= 2 && ctx.lastSeat != null
    && ctx.teams?.[ctx.lastSeat] !== ctx.teams?.[ctx.seat]) {
    result.score += 95;
    result.tags.push('bomb_escort');
    result.reasons.push('炸开夺权，准备护送只剩两张的对家');
  }

  const played = ctx.playedCards || [];
  if (isSimple(play.hand) && play.hand.power >= 13) {
    if (expertWeight(ctx) > 0) {
      const visibleCards = memoValue(
        ctx, handBefore, level, 'knownCards', () => knownCards(ctx, handBefore),
      );
      const higherOptions = unseenHigherSimpleOptions(play, ctx, handBefore, visibleCards);
      if (higherOptions === 0) {
        addExpertScore(
          result,
          ctx,
          handBefore.length <= 8 ? 38 : 28,
          'resources',
          7,
          'counted_controls',
          '公开牌池中更高同型大牌已现尽，该控制牌成功率高',
        );
      } else if (higherOptions === 1) {
        addExpertScore(
          result,
          ctx,
          16,
          'resources',
          4,
          'counted_controls',
          '多数更高同型大牌已现，仅余一种公开牌池可能',
        );
      } else if (higherOptions <= 3) {
        addExpertScore(
          result,
          ctx,
          7,
          'resources',
          2,
          'counted_controls',
          '大牌已现较多，当前控制牌风险下降',
        );
      } else if (mode === 'lead' && handBefore.length > 8) {
        addExpertScore(
          result,
          ctx,
          -14,
          'resources',
          -3,
          'unseen_controls',
          `公开牌池仍有${higherOptions}种更高同型可能，中盘谨慎裸打大牌`,
        );
      }
    } else if (played.length) {
      const controlsSeen = played.filter(
        (card) => isJoker(card) || card.rank === level || card.rank >= 13,
      ).length;
      if (Math.min(1, controlsSeen / 28) >= 0.55) {
        result.score += 14;
        result.tags.push('counted_controls');
        result.reasons.push('多数王、级牌和大牌已现，控制成功率较高');
        addEvent(result, 'resources', 5, null, '多数王、级牌和大牌已现，当前控制牌成功率较高。');
      } else if (mode === 'lead' && handBefore.length > 8) {
        result.score -= 12;
      }
    }
  }

  return result;
}

/** 紧急拦截先保护现有结构，再在安全候选中使用更高控制牌。 */
export function selectEmergencyBlock(plays, ctx) {
  if (!plays?.length) return null;
  const downstream = (ctx.seat + 1) % 4;
  const downstreamCount = ctx.handCounts?.[downstream] ?? 99;
  const bombs = plays.filter((play) => isStrategicBomb(play.hand));
  const nonBomb = plays.filter((play) => !isStrategicBomb(play.hand));
  const damageWeight = {
    split_bomb: 1000,
    split_straight: 400,
    split_group: 250,
    split_pair: 180,
  };
  const rankedNonBomb = nonBomb.map((play) => {
    const strategy = play.strategy || evaluateStrategicPlay(play, ctx);
    const damage = (strategy.tags || []).reduce(
      (sum, tag) => sum + (damageWeight[tag] || 0),
      0,
    );
    return { play, strategy, damage };
  }).sort((a, b) => (
    a.damage - b.damage
    || b.play.hand.power - a.play.hand.power
    || b.strategy.score - a.strategy.score
  ));

  const bestNonBomb = rankedNonBomb[0]?.play || null;
  const absoluteOrdinaryControl = bestNonBomb && (
    ([HandType.SINGLE, HandType.PAIR].includes(ctx.lastHand?.type)
      && bestNonBomb.hand.mainRank === 17)
    || (ctx.lastHand?.type === HandType.TRIPLE
      && bestNonBomb.hand.mainRank === ctx.level)
  );
  if (downstreamCount <= 3 && bombs.length && !absoluteOrdinaryControl) {
    return bombs.slice().sort((a, b) => a.hand.power - b.hand.power)[0];
  }
  if (bombs.length && (rankedNonBomb[0]?.damage || 0) >= damageWeight.split_bomb) {
    return bombs.slice().sort((a, b) => a.hand.power - b.hand.power)[0];
  }
  return bestNonBomb || bombs.slice().sort((a, b) => a.hand.power - b.hand.power)[0];
}

export function strategicCandidateScore(play, ctx) {
  const result = evaluateStrategicPlay(play, ctx);
  const finish = play.cards.length === (ctx.hand || ctx.handBefore || []).length ? 1200 : 0;
  // Bomb power contains a cross-type comparison offset (1000+), not a resource
  // cost. Normalize it before using the value for strategic references.
  const comparablePower = isStrategicBomb(play.hand)
    ? 15 + Math.min(10, play.hand.size || play.cards.length)
    : (play.hand?.power || 0);
  const basic = play.cards.length * 3 - comparablePower * 0.35;
  return { ...result, total: finish + basic + result.score };
}
