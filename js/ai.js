/**
 * 掼蛋 AI（多难度）
 * easy   — 随机偏多、常浪费炸/逢人配、少配合
 * normal — 启发式均衡
 * hard   — 候选剪枝后进行一至两步前瞻，兼顾残局手数与牌型结构
 */

import { isWild, isJoker, soloPower, removeCards } from './cards.js';
import {
  generateLegalPlays, canBeat, HandType, handSignature,
} from './rules.js';
import { evaluateStrategicPlay } from './strategy-core.js';

export const AI_DIFFICULTY = {
  easy: 'easy',
  normal: 'normal',
  hard: 'hard',
};

export const AI_DIFFICULTY_LABEL = {
  easy: '简单',
  normal: '普通',
  hard: '困难',
};

const SEARCH_CACHE_LIMIT = 160;
const LOOK_AHEAD_ROOT_LIMIT = 10;
const LOOK_AHEAD_FUTURE_BEAM = 4;

/** @type {'easy'|'normal'|'hard'} */
let _difficulty = AI_DIFFICULTY.normal;

export function setAIDifficulty(d) {
  if (AI_DIFFICULTY[d]) _difficulty = d;
}

export function getAIDifficulty() {
  return _difficulty;
}

function cfg() {
  switch (_difficulty) {
    case 'easy':
      return {
        noise: 40,
        bombLeadPenalty: 20,
        simpleLeadPowerPenalty: 0.25,
        bombBeatPenalty: 30,
        wildPenalty: 8,
        teammatePassRate: 0.55,
        finishFirst: true,
        structureWeight: 0.4,
        aggressiveness: 0.35,
        lookAhead: false,
        randomPass: 0.18,
      };
    case 'hard':
      return {
        noise: 0.2,
        bombLeadPenalty: 120,
        simpleLeadPowerPenalty: 1.4,
        bombBeatPenalty: 160,
        wildPenalty: 40,
        teammatePassRate: 1,
        finishFirst: true,
        structureWeight: 1.4,
        aggressiveness: 0.85,
        lookAhead: true,
        randomPass: 0,
      };
    default:
      return {
        noise: 6,
        bombLeadPenalty: 80,
        simpleLeadPowerPenalty: 1.1,
        bombBeatPenalty: 100,
        wildPenalty: 28,
        teammatePassRate: 0.88,
        finishFirst: true,
        structureWeight: 1,
        aggressiveness: 0.6,
        // 普通难度保持快速启发式；有界前瞻只用于困难/教练模式。
        lookAhead: false,
        randomPass: 0.06,
      };
  }
}

/**
 * @param {object} ctx
 */
export function chooseAIPlay(ctx) {
  return chooseAIPlayInternal(ctx, { explain: false, deterministic: false });
}

function chooseAIPlayInternal(ctx, options) {
  const {
    seat,
    hand,
    level,
    lastHand,
    lastSeat,
    handCounts = [99, 99, 99, 99],
    teams = [0, 1, 0, 1],
    finishOrder = [],
  } = ctx;
  const c = { ...cfg() };
  if (options.deterministic) {
    c.noise = 0;
    c.randomPass = 0;
    c.teammatePassRate = 1;
  }
  const decisionCtx = {
    ...ctx,
    handCounts,
    teams,
    finishOrder,
  };
  const search = createSearchContext(level);
  const plays = removeWeakerDeclarations(
    generateLegalPlays(hand, level, lastHand),
    level,
  );
  const passOk = !!lastHand;

  const respond = (decision, ranked = [], reason = '', candidate = null) => {
    if (!options.explain || !decision) return decision;
    return explainDecision(decision, ranked, reason, candidate, decisionCtx);
  };

  if (plays.length === 0) {
    return passOk
      ? respond({ action: 'pass' }, [], '没有合法接法，过牌保存实力')
      : null;
  }

  if (!lastHand) {
    const ranked = rankPlays(plays, 'lead', hand, level, decisionCtx, c, search);
    const finish = ranked.filter((play) => play.cards.length === hand.length);
    const best = finish.length && c.finishFirst ? finish[0] : pickByDifficulty(ranked);
    const decision = { action: 'play', cards: best.cards, hand: best.hand };
    return respond(decision, ranked, reasonForCandidate(best, 'lead', decisionCtx), best);
  }

  const myTeam = teams[seat];
  const lastTeam = lastSeat != null ? teams[lastSeat] : -1;
  const isTeammate = lastTeam === myTeam && lastSeat !== seat;
  const partnerSeat = (seat + 2) % 4;
  const partnerFinished = finishOrder.includes(partnerSeat);

  // —— 队友配合 ——
  if (isTeammate && !partnerFinished) {
    const finishPlays = plays.filter((p) => p.cards.length === hand.length);
    if (finishPlays.length) {
      const ranked = rankPlays(finishPlays, 'beat', hand, level, decisionCtx, c, search);
      const best = ranked[0];
      return respond(
        { action: 'play', cards: best.cards, hand: best.hand },
        ranked,
        '可以一手出完，争取名次优先于让牌',
        best,
      );
    }

    // hard：几乎不压队友；easy：经常乱压。
    const forcePass = Math.random() < c.teammatePassRate;
    if (forcePass || lastHand.power >= 10 || isBombType(lastHand)) {
      const ranked = options.explain
        ? rankPlays(plays, 'beat', hand, level, decisionCtx, c, search)
        : [];
      return respond({ action: 'pass' }, ranked, '队友正在控牌，避免打断搭档节奏');
    }

    if (_difficulty === 'easy' && Math.random() < 0.45) {
      const any = plays[Math.floor(Math.random() * plays.length)];
      return respond(
        { action: 'play', cards: any.cards, hand: any.hand },
        plays,
        '尝试接管本轮牌权',
        any,
      );
    }
    const ranked = options.explain
      ? rankPlays(plays, 'beat', hand, level, decisionCtx, c, search)
      : [];
    return respond({ action: 'pass' }, ranked, '让队友继续控牌，保留自己的关键资源');
  }

  // —— 接对手 ——
  if (passOk
    && Math.random() < c.randomPass
    && hand.length > 8
    && !enemyAboutToWin(handCounts, seat, teams)) {
    return respond({ action: 'pass' }, [], '保留牌力，等待更合适的接管时机');
  }

  const scored = rankPlays(plays, 'beat', hand, level, decisionCtx, c, search);
  let best = pickByDifficulty(scored);

  const activeEnemyMin = Math.min(...handCounts.map((count, i) => (
    i !== seat && !finishOrder.includes(i) && teams[i] !== teams[seat] ? count : 99
  )));
  const upstreamSeat = (seat + 3) % 4;
  const upstreamThreat = lastSeat === upstreamSeat
    && teams[upstreamSeat] !== teams[seat]
    && !finishOrder.includes(upstreamSeat)
    && handCounts[upstreamSeat] <= 6;
  if (passOk
    && hand.length > 8
    && activeEnemyMin > 5
    && !upstreamThreat
    && isPremiumNonBombControl(best.hand, level)) {
    return respond(
      { action: 'pass' },
      scored,
      '对手尚未进入紧急残局，保留王或级牌控制，避免大牌打空后单吊小牌',
    );
  }

  const bombCreatesTwoStepFinish = isBombType(best.hand)
    && !!best.strategy?.createsTwoStepFinish;
  if (isBombType(best.hand)
    && !bombCreatesTwoStepFinish
    && !shouldBomb(
      lastHand, hand, handCounts, seat, teams, finishOrder, c, best.strategy,
      options.deterministic,
    )) {
    const nonBomb = scored.filter((p) => !isBombType(p.hand));
    if (nonBomb.length) {
      best = pickByDifficulty(nonBomb);
      return respond(
        { action: 'play', cards: best.cards, hand: best.hand },
        scored,
        reasonForCandidate(best, 'beat', decisionCtx),
        best,
      );
    }
    if (hand.length - best.cards.length === 0
      || handCounts.some((cnt, i) => i !== seat && teams[i] !== teams[seat] && cnt <= 3)) {
      return respond(
        { action: 'play', cards: best.cards, hand: best.hand },
        scored,
        reasonForCandidate(best, 'beat', decisionCtx),
        best,
      );
    }
    return respond({ action: 'pass' }, scored, '当前只能用炸弹接牌，保留炸弹更有价值');
  }

  if (best.score < -50 && hand.length > 10 && lastHand.power < 10
    && !isBombType(lastHand) && !upstreamThreat) {
    if (_difficulty !== 'easy' || Math.random() < 0.7) {
      return respond({ action: 'pass' }, scored, '接牌代价过高，暂时保留牌型结构');
    }
  }

  // 能一手清完始终优先。
  const finish = scored.filter((p) => p.cards.length === hand.length);
  if (finish.length && c.finishFirst) {
    best = finish[0];
    return respond(
      { action: 'play', cards: best.cards, hand: best.hand },
      scored,
      '可以一手出完，直接锁定更好名次',
      best,
    );
  }

  return respond(
    { action: 'play', cards: best.cards, hand: best.hand },
    scored,
    reasonForCandidate(best, 'beat', decisionCtx),
    best,
  );
}

function pickByDifficulty(scored) {
  if (!scored.length) return null;
  if (_difficulty === 'easy') {
    const k = Math.min(5, scored.length);
    return scored[Math.floor(Math.random() * k)];
  }
  // 普通难度只在质量近似的候选间保留少量变化，不能随机跳到明显浪费大牌的出法。
  if (_difficulty === 'normal'
    && scored.length > 1
    && scored[0].score - scored[1].score <= 2
    && Math.random() < 0.12) {
    return scored[1];
  }
  return scored[0];
}

function enemyAboutToWin(handCounts, seat, teams) {
  return handCounts.some((count, i) => i !== seat && teams[i] !== teams[seat] && count <= 3);
}

function tacticalAdjustment(play, mode, ctx, hand, level) {
  const strategy = evaluateStrategicPlay(play, {
    ...ctx, hand, level, mode,
  });
  play.strategy = strategy;
  play.tactics = strategy.reasons;
  return strategy.score;
}

function isBombType(h) {
  return h && (h.type === HandType.BOMB
    || h.type === HandType.FLUSH_STRAIGHT
    || h.type === HandType.JOKER_BOMB);
}

function playResourcePower(hand) {
  if (!isBombType(hand)) return hand?.power || 0;
  if (hand.type === HandType.JOKER_BOMB) return 34;
  if (hand.type === HandType.FLUSH_STRAIGHT) return 24 + (hand.mainRank || 0) * 0.1;
  return 18 + (hand.size || 4) * 2 + (hand.mainRank || 0) * 0.1;
}

function isPremiumNonBombControl(hand, level) {
  if (!hand || isBombType(hand)) return false;
  if (hand.type === HandType.SINGLE && hand.mainRank >= 16) return true;
  return hand.mainRank === level
    && [HandType.SINGLE, HandType.PAIR, HandType.TRIPLE].includes(hand.type);
}

/**
 * 同一组实体牌若存在严格更强的声明，只保留更强声明。
 * 例如级牌为 7 时，♠4 ♠5 ♠6 ♥7 ♠8 同时可解释为顺子和黑桃同花顺；
 * 两者消耗完全相同，AI 声明普通顺子只会无谓降低本手牌力。
 * 钢板/三连对等互相不能比较的声明仍会全部保留。
 */
function removeWeakerDeclarations(plays, level) {
  const groups = new Map();
  for (const play of plays) {
    const key = cardsKey(play.cards);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(play);
  }

  return plays.filter((play) => {
    const equivalents = groups.get(cardsKey(play.cards)) || [];
    return !equivalents.some((other) => (
      other !== play
      && canBeat(other.hand, play.hand, level)
      && !canBeat(play.hand, other.hand, level)
    ));
  });
}

function shouldBomb(
  lastHand, hand, handCounts, seat, teams, finishOrder, c, strategy, deterministic,
) {
  if (strategy?.tags?.includes('bomb_escort')) return true;
  if (isBombType(lastHand)) {
    const enemyMin = Math.min(...handCounts.map((count, i) => (
      i !== seat && !finishOrder.includes(i) && teams[i] !== teams[seat] ? count : 99
    )));
    // 中盘不能因为“能反炸”就自动交掉唯一控制牌；只在对手临近出完，
    // 或自己已进入短手残局时反炸。
    if (enemyMin <= (_difficulty === 'hard' ? 5 : 4)) return true;
    if (hand.length <= 8) {
      const chance = 0.35 + c.aggressiveness * 0.45;
      return deterministic ? chance >= 0.5 : Math.random() < chance;
    }
    return _difficulty === 'easy'
      ? (deterministic ? false : Math.random() < 0.2)
      : false;
  }
  for (let i = 0; i < 4; i++) {
    if (i === seat || finishOrder.includes(i)) continue;
    if (teams[i] !== teams[seat] && handCounts[i] <= (_difficulty === 'hard' ? 5 : 4)) return true;
  }
  if (hand.length <= 8) {
    const chance = 0.3 + c.aggressiveness * 0.5;
    return deterministic ? chance >= 0.5 : Math.random() < chance;
  }
  if (_difficulty === 'easy') return deterministic ? false : Math.random() < 0.35;
  // A high single/joker is not by itself a reason to throw a midgame bomb.
  // Keep it for an urgent block, a planned finish, or partner escort.
  return lastHand.type === HandType.FULLHOUSE && hand.length <= 10;
}

function rankPlays(plays, mode, hand, level, ctx, c, search) {
  const beforeStructure = structureBonus(hand, level, search);
  const scored = plays.map((play) => {
    const score = mode === 'lead'
      ? scoreLead(play, hand, level, ctx, c, search, beforeStructure)
      : scoreBeat(play, hand, level, ctx, c, search, beforeStructure);
    return { ...play, score };
  }).sort((a, b) => b.score - a.score);

  if (c.lookAhead && scored.length > 1) {
    applyLookAhead(scored, hand, level, search);
    // 困难模式采用 beam search：最终主选来自已完成前瞻的候选，未展开项仍保留作兜底。
    scored.sort((a, b) => {
      const aSearched = a.lookAhead ? 1 : 0;
      const bSearched = b.lookAhead ? 1 : 0;
      return bSearched - aSearched || b.score - a.score;
    });
  }
  return scored;
}

function scoreLead(play, hand, level, ctx, c, search, beforeStructure) {
  let score = 0;
  const h = play.hand;
  const remain = hand.length - play.cards.length;
  const strategyScore = tacticalAdjustment(play, 'lead', ctx, hand, level);

  if (remain === 0) score += 1000;
  if (isBombType(h) && !play.strategy?.createsTwoStepFinish) score -= c.bombLeadPenalty;

  score -= playResourcePower(h) * (0.4 + c.aggressiveness * 0.2);
  // 领单张/对子/三张时，高点牌主要用于后续控制；有牌未出完时应明显惜大打小。
  if (remain > 0 && [HandType.SINGLE, HandType.PAIR, HandType.TRIPLE].includes(h.type)) {
    score -= h.power * c.simpleLeadPowerPenalty;
  }
  score += play.cards.length * 3;
  score -= splitPenalty(hand, play.cards, level, search, beforeStructure) * 15 * c.structureWeight;
  score -= play.cards.filter((card) => isWild(card, level)).length * c.wildPenalty;
  score += structureBonus(removeCards(hand, play.cards), level, search) * c.structureWeight;

  if (hand.length <= 10) score += play.cards.length * 5;

  if (_difficulty === 'hard' && !isBombType(h) && play.cards.length >= 3 && h.power <= 9) {
    score += 12;
  }

  score += strategyScore;

  return score + Math.random() * c.noise;
}

function scoreBeat(play, hand, level, ctx, c, search, beforeStructure) {
  let score = 0;
  const h = play.hand;
  const remain = hand.length - play.cards.length;
  const strategyScore = tacticalAdjustment(play, 'beat', ctx, hand, level);

  if (remain === 0) score += 2000;
  score -= playResourcePower(h) * 2;
  if (isBombType(h) && !play.strategy?.createsTwoStepFinish) score -= c.bombBeatPenalty;

  score -= splitPenalty(hand, play.cards, level, search, beforeStructure) * 20 * c.structureWeight;
  score -= play.cards.filter((card) => isWild(card, level)).length * c.wildPenalty;
  score -= play.cards.filter((card) => isJoker(card)).length * 15;
  score += structureBonus(removeCards(hand, play.cards), level, search) * c.structureWeight;
  score += play.cards.length * 2;

  if (ctx.handCounts && enemyAboutToWin(ctx.handCounts, ctx.seat, ctx.teams)) {
    score += 80;
    if (isBombType(h)) score += 60;
  }

  score += strategyScore;

  return score + Math.random() * c.noise;
}

function splitPenalty(hand, used, level, search, beforeStructure) {
  const remain = removeCards(hand, used);
  const after = structureBonus(remain, level, search);
  return Math.max(0, beforeStructure - after - used.length);
}

function structureBonus(hand, level, search) {
  const key = handKey(hand);
  return memo(search.structure, key, () => {
    if (!hand.length) return 50;
    const counts = new Map();
    let wilds = 0;
    for (const card of hand) {
      if (isWild(card, level)) {
        wilds++;
        continue;
      }
      if (isJoker(card)) continue;
      counts.set(card.rank, (counts.get(card.rank) || 0) + 1);
    }
    let bonus = 0;
    for (const count of counts.values()) {
      if (count >= 4) bonus += 30 + count * 5;
      else if (count === 3) bonus += 12;
      else if (count === 2) bonus += 5;
    }
    bonus += wilds * 8;
    bonus -= fastTrickEstimate(hand, level, search).tricks * 4;
    return bonus;
  });
}

/**
 * 只给启发式排名前列和少量战略候选做前瞻，避免为全部出法展开搜索。
 * 前瞻分会直接写回候选总分，因此 hard 的最终选择真实受未来手数影响。
 */
function applyLookAhead(scored, hand, level, search) {
  const selected = selectLookAheadCandidates(scored, hand.length);
  const projections = [];

  for (const play of selected) {
    const remain = removeCards(hand, play.cards);
    const depth = remain.length <= 12 ? 2 : 1;
    const projection = projectRemainder(remain, level, search, depth);
    const cost = projection.tricks * 18 + projection.loose * 2.5;
    play.lookAhead = {
      projectedTricks: projection.tricks,
      looseCards: projection.loose,
      depth,
      cost,
    };
    projections.push({ play, cost });
  }

  if (!projections.length) return;
  const averageCost = projections.reduce((sum, item) => sum + item.cost, 0) / projections.length;
  for (const { play, cost } of projections) {
    // 以候选均值为中心，既奖励更短的收尾路线，也惩罚明显拖长手数的路线。
    play.lookAhead.adjustment = (averageCost - cost) * 1.35;
    play.score += play.lookAhead.adjustment;
  }
}

function selectLookAheadCandidates(scored, handSize) {
  const selected = [];
  const seen = new Set();
  const add = (play) => {
    if (!play) return;
    const key = playKey(play);
    if (seen.has(key)) return;
    seen.add(key);
    selected.push(play);
  };

  for (const play of scored.slice(0, LOOK_AHEAD_ROOT_LIMIT)) add(play);
  for (const play of scored.filter((p) => p.cards.length === handSize)) add(play);
  for (const play of scored
    .filter((p) => !isBombType(p.hand))
    .sort((a, b) => b.cards.length - a.cards.length || a.hand.power - b.hand.power)
    .slice(0, 2)) add(play);
  return selected.slice(0, LOOK_AHEAD_ROOT_LIMIT + 2);
}

function projectRemainder(hand, level, search, depth) {
  if (!hand.length) return { tricks: 0, loose: 0 };
  const key = `${depth}|${handKey(hand)}`;
  return memo(search.projection, key, () => {
    const fast = fastTrickEstimate(hand, level, search);
    if (depth <= 0 || hand.length === 1) return fast;

    const legal = memo(search.freePlays, handKey(hand), () => generateLegalPlays(hand, level, null));
    if (!legal.length) return { tricks: hand.length, loose: hand.length };

    const rankedFuture = legal.map((play) => {
      const remain = removeCards(hand, play.cards);
      let priority = play.cards.length * 14;
      if (remain.length === 0) priority += 10000;
      if (isBombType(play.hand) && remain.length > 2) priority -= 35;
      priority -= play.cards.filter((card) => isWild(card, level)).length * 15;
      priority -= play.cards.filter(isJoker).length * 8;
      priority -= fastTrickEstimate(remain, level, search).tricks * 10;
      return { play, remain, priority };
    }).sort((a, b) => b.priority - a.priority);

    // 同一组实体牌可能有多个逢人配声明；未来手牌相同，只保留优先级最高的一项展开。
    const future = [];
    const seenRemainders = new Set();
    for (const item of rankedFuture) {
      const remainKey = handKey(item.remain);
      if (seenRemainders.has(remainKey)) continue;
      seenRemainders.add(remainKey);
      future.push(item);
      if (future.length >= LOOK_AHEAD_FUTURE_BEAM) break;
    }

    let best = null;
    let bestCost = Infinity;
    for (const item of future) {
      const tail = projectRemainder(item.remain, level, search, depth - 1);
      const candidate = {
        tricks: 1 + tail.tricks,
        loose: tail.loose,
      };
      const bombTax = isBombType(item.play.hand) && item.remain.length > 2 ? 0.35 : 0;
      const candidateCost = candidate.tricks * 10 + candidate.loose + bombTax;
      if (candidateCost < bestCost) {
        bestCost = candidateCost;
        best = candidate;
      }
    }
    return best || fast;
  });
}

function fastTrickEstimate(hand, level, search) {
  const key = handKey(hand);
  return memo(search.fastEstimate, key, () => {
    if (!hand.length) return { tricks: 0, loose: 0 };
    const counts = new Map();
    let wilds = 0;
    let smallJokers = 0;
    let bigJokers = 0;
    for (const card of hand) {
      if (isWild(card, level)) wilds++;
      else if (card.rank === 16) smallJokers++;
      else if (card.rank === 17) bigJokers++;
      else counts.set(card.rank, (counts.get(card.rank) || 0) + 1);
    }

    const values = [...counts.values()];
    const loose = values.filter((count) => count === 1).length
      + (smallJokers === 1 ? 1 : 0)
      + (bigJokers === 1 ? 1 : 0);
    let tricks = counts.size
      + (smallJokers ? 1 : 0)
      + (bigJokers ? 1 : 0)
      + (wilds && !counts.size ? 1 : 0);

    // 组合牌能把多个点数组合成一手；这里只做常数时间近似，深层由有界搜索修正。
    const triples = values.filter((count) => count >= 3).length;
    const pairs = values.filter((count) => count >= 2).length;
    if (triples && pairs >= 2) tricks -= 1; // 三带二
    if (hasSequence(counts, 1, 5, wilds)) tricks -= 3; // 顺子通常合并约 4 组，保守减 3
    if (hasSequence(counts, 2, 3, wilds)) tricks -= 2; // 三连对
    else if (hasSequence(counts, 3, 2, wilds)) tricks -= 1; // 钢板

    return {
      tricks: Math.max(1, tricks),
      loose: Math.max(0, loose - wilds),
    };
  });
}

function hasSequence(counts, needPer, length, wilds) {
  const starts = length === 5 ? [1, ...Array.from({ length: 9 }, (_, i) => i + 2)]
    : length === 3 ? [1, ...Array.from({ length: 11 }, (_, i) => i + 2)]
      : [1, ...Array.from({ length: 12 }, (_, i) => i + 2)];
  for (const start of starts) {
    let missing = 0;
    for (let offset = 0; offset < length; offset++) {
      const rank = start + offset === 1 ? 14 : start + offset;
      missing += Math.max(0, needPer - (counts.get(rank) || 0));
    }
    if (missing <= wilds) return true;
  }
  return false;
}

function createSearchContext(level) {
  return {
    level,
    structure: new BoundedCache(SEARCH_CACHE_LIMIT),
    fastEstimate: new BoundedCache(SEARCH_CACHE_LIMIT),
    projection: new BoundedCache(SEARCH_CACHE_LIMIT),
    freePlays: new BoundedCache(Math.floor(SEARCH_CACHE_LIMIT / 2)),
  };
}

class BoundedCache extends Map {
  constructor(limit) {
    super();
    this.limit = limit;
  }

  set(key, value) {
    if (!this.has(key) && this.size >= this.limit) {
      const oldest = this.keys().next().value;
      this.delete(oldest);
    }
    return super.set(key, value);
  }
}

function memo(cache, key, calculate) {
  if (cache.has(key)) return cache.get(key);
  const value = calculate();
  cache.set(key, value);
  return value;
}

function handKey(hand) {
  return hand.map((card) => card.id).sort().join(',');
}

function cardsKey(cards) {
  return cards.map((card) => card.id).sort().join(',');
}

function playKey(play) {
  return `${cardsKey(play.cards)}|${play.signature || handSignature(play.hand)}`;
}

function reasonForCandidate(candidate, mode, ctx) {
  if (!candidate) return '综合当前牌面选择';
  if (candidate.cards.length === ctx.hand.length) return '可以一手出完，直接争取更好名次';
  if (candidate.tactics?.length) return candidate.tactics.join('；');
  if (isBombType(candidate.hand) && enemyAboutToWin(ctx.handCounts, ctx.seat, ctx.teams)) {
    return '对手已接近出完，用炸弹及时阻断';
  }
  if (candidate.lookAhead) {
    return `前瞻后预计还需约 ${candidate.lookAhead.projectedTricks} 手，兼顾结构与关键资源`;
  }
  return mode === 'lead'
    ? '优先减少散牌并保留关键控制牌'
    : '用较小代价接牌，同时保持后续牌型完整';
}

function explainDecision(decision, ranked, reason, candidate, ctx) {
  const result = { ...decision, reason };
  if (candidate?.lookAhead) {
    result.projectedTricks = candidate.lookAhead.projectedTricks;
  }

  const alternatives = [];
  const chosenKey = decision.action === 'play' && decision.cards
    ? `${cardsKey(decision.cards)}|${handSignature(decision.hand)}`
    : null;
  for (const play of ranked) {
    if (alternatives.length >= 3) break;
    if (chosenKey && playKey(play) === chosenKey) continue;
    const alternative = {
      action: 'play',
      cards: play.cards,
      hand: play.hand,
      reason: reasonForCandidate(play, ctx.lastHand ? 'beat' : 'lead', ctx),
    };
    if (play.lookAhead) alternative.projectedTricks = play.lookAhead.projectedTricks;
    alternatives.push(alternative);
  }
  result.alternatives = alternatives;
  return result;
}

/** 教练推荐：用确定性的 hard 风格给出主选、理由与最多三个备选。 */
export function recommendPlay(ctx) {
  const prev = _difficulty;
  _difficulty = AI_DIFFICULTY.hard;
  try {
    return chooseAIPlayInternal(ctx, { explain: true, deterministic: true });
  } finally {
    _difficulty = prev;
  }
}

export function chooseTributeCard(hand, level) {
  const candidates = hand.filter((card) => !isWild(card, level));
  if (!candidates.length) return hand[0];
  candidates.sort((a, b) => soloPower(b, level) - soloPower(a, level));
  return candidates[0];
}

export function chooseReturnCard(hand, level, { toPartner = false } = {}) {
  const le10 = hand.filter((card) => !isJoker(card) && card.rank <= 10 && card.rank !== level);
  const pool = le10.length ? le10 : hand.filter((card) => !isJoker(card) && !isWild(card, level));
  const final = pool.length ? pool : hand;
  const counts = new Map();
  for (const card of hand) {
    if (isJoker(card) || isWild(card, level)) continue;
    counts.set(card.rank, (counts.get(card.rank) || 0) + 1);
  }
  const tactical = toPartner
    ? final.filter((card) => card.rank < 5 && (counts.get(card.rank) || 0) === 1)
    : final.filter((card) => card.rank > 5 && (counts.get(card.rank) || 0) >= 2);
  if (tactical.length) {
    tactical.sort((a, b) => toPartner ? a.rank - b.rank : b.rank - a.rank);
    return tactical[0];
  }
  final.sort((a, b) => {
    const ca = counts.get(a.rank) || 0;
    const cb = counts.get(b.rank) || 0;
    if (ca === 1 && cb !== 1) return -1;
    if (cb === 1 && ca !== 1) return 1;
    return a.rank - b.rank;
  });
  return final[0];
}
