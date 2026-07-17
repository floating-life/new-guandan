/**
 * Shared strategic scoring used by AI choice, coaching and human evaluation.
 * Rules in this module describe intent; card legality remains in rules.js.
 */
import { isJoker, isWild, removeCards } from './cards.js';
import { HandType, formatHand, parseHand } from './rules.js';

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

function activeEnemies(ctx) {
  const finished = ctx.finishOrder || [];
  return (ctx.handCounts || []).map((count, seat) => ({ seat, count }))
    .filter((item) => item.seat !== ctx.seat
      && !finished.includes(item.seat)
      && ctx.teams?.[item.seat] !== ctx.teams?.[ctx.seat]);
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

function looseSingleCount(cards, level) {
  const counts = new Map();
  for (const card of cards) {
    if (isJoker(card) || isWild(card, level)) continue;
    counts.set(card.rank, (counts.get(card.rank) || 0) + 1);
  }
  return [...counts.values()].filter((count) => count === 1).length;
}

function potentialStraightCount(cards, level) {
  const ranks = new Set();
  let wilds = 0;
  for (const card of cards) {
    if (isWild(card, level)) wilds += 1;
    else if (!isJoker(card)) ranks.add(card.rank);
  }
  const sequences = [[14, 2, 3, 4, 5]];
  for (let start = 2; start <= 10; start++) {
    sequences.push([start, start + 1, start + 2, start + 3, start + 4]);
  }
  return sequences.filter(
    (sequence) => sequence.filter((rank) => !ranks.has(rank)).length <= wilds,
  ).length;
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
  const result = {
    score: 0,
    tags: [],
    reasons: [],
    events: [],
    remaining: removeCards(handBefore, play.cards),
    followUpFinish: null,
    createsTwoStepFinish: false,
  };
  result.followUpFinish = wholeHandPlay(result.remaining, level);
  result.createsTwoStepFinish = result.remaining.length > 0 && !!result.followUpFinish;

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
  }

  const straightLoss = Math.max(
    0,
    potentialStraightCount(handBefore, level) - potentialStraightCount(result.remaining, level),
  );
  if (straightLoss > 0
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

  const enemies = activeEnemies(ctx);
  const nearest = enemies.slice().sort((a, b) => a.count - b.count)[0];
  const downstream = (ctx.seat + 1) % 4;
  const upstream = (ctx.seat + 3) % 4;
  const partner = (ctx.seat + 2) % 4;

  if (mode === 'lead' && nearest) {
    const preferred = preferredTypesForEnemyCount(nearest.count);
    if (preferred.length) {
      if (preferred.includes(play.hand.type)) {
        result.score += nearest.count <= 6 ? 420 : 300;
        const label = nearest.count === 5 || nearest.count === 10
          ? '对子' : nearest.count === 6
            ? '三张' : nearest.count === 7 || nearest.count === 8 ? '顺子或三带二' : '单张';
        result.tags.push('enemy_count_route');
        result.reasons.push(`对手剩${nearest.count}张，优先${label}控牌`);
        addEvent(result, 'defense', 6, null, `对手剩${nearest.count}张，本手牌型符合控牌路线。`);
      } else if (!isStrategicBomb(play.hand)) {
        result.score -= nearest.count <= 6 ? 35 : 20;
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
  if (mode === 'lead' && partnerCount <= 5 && handBefore.length >= 10) {
    if (isStrategicBomb(play.hand)) result.score -= 85;
    if (isSimple(play.hand) && play.hand.power <= 9) {
      result.score += 28;
      result.tags.push('help_partner');
      result.reasons.push('己方牌较长，先送较小牌型帮助对家接手');
      addEvent(result, 'cooperation', 5, null, '己方牌较长，先送较小牌型帮助对家接手。');
    }
  }

  if (mode === 'lead' && ctx.leadAfterOwnBomb) {
    const loose = looseSingleCount(handBefore, level);
    const independentSingle = play.hand.type === HandType.SINGLE
      && play.cards.length === 1
      && naturalRankCount(handBefore, play.cards[0].rank, level) === 1;
    if (loose > 0 && independentSingle) {
      result.score += 300;
      result.tags.push('single_after_bomb');
      result.reasons.push('炸弹夺权后先放独立单张，保留组合继续控制');
      addEvent(result, 'structure', 10, null, '炸弹夺权后先清理独立单张，保留组合牌继续控制。');
    } else if (loose > 0 && !isStrategicBomb(play.hand)) {
      result.score -= 75;
    }
  }

  if (isStrategicBomb(play.hand) && partnerCount <= 2 && ctx.lastSeat != null
    && ctx.teams?.[ctx.lastSeat] !== ctx.teams?.[ctx.seat]) {
    result.score += 95;
    result.tags.push('bomb_escort');
    result.reasons.push('炸开夺权，准备护送只剩两张的对家');
  }

  const played = ctx.playedCards || [];
  if (played.length && isSimple(play.hand) && play.hand.power >= 13) {
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

  return result;
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
