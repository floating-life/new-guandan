/**
 * Public-information belief and shallow route search.
 *
 * This module deliberately accepts only the current player's hand, public
 * cards, public action history and public hand counts. It never reconstructs
 * or samples an opponent hand directly.
 */
import { isJoker, isWild, removeCards, soloPower } from './cards.js';
import { generateLegalPlays, HandType, parseHand } from './rules.js';

const SIMPLE_TYPES = [HandType.SINGLE, HandType.PAIR, HandType.TRIPLE];
const BOMB_TYPES = [HandType.BOMB, HandType.FLUSH_STRAIGHT, HandType.JOKER_BOMB];

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function typeMap() {
  return new Map();
}

function bump(map, key, amount = 1) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + amount);
}

function mostFrequent(map) {
  let type = null;
  let count = 0;
  for (const [key, value] of map || []) {
    if (value > count) {
      type = key;
      count = value;
    }
  }
  return { type, count };
}

function publicHistorySummary(ctx) {
  const leads = Array.from({ length: 4 }, typeMap);
  const passes = Array.from({ length: 4 }, typeMap);
  const passesAgainstEnemy = Array.from({ length: 4 }, typeMap);
  const passesToTeammate = Array.from({ length: 4 }, typeMap);
  const passEvents = Array.from({ length: 4 }, () => []);
  const responses = Array.from({ length: 4 }, typeMap);
  const teams = ctx.teams || [0, 1, 0, 1];
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
        lastPower: null,
        lastSize: null,
        hasPlay: false,
      });
    }
    const trick = tricks.get(key);
    if (item.action === 'play' && item.hand?.type) {
      if (!trick.hasPlay) bump(leads[seat], item.hand.type);
      else bump(responses[seat], item.hand.type);
      trick.hasPlay = true;
      trick.targetType = item.hand.type;
      trick.lastPlayer = seat;
      trick.lastType = item.hand.type;
      trick.lastPower = item.hand.power != null && Number.isFinite(Number(item.hand.power))
        ? Number(item.hand.power) : null;
      trick.lastSize = item.hand.size != null && Number.isFinite(Number(item.hand.size))
        ? Number(item.hand.size)
        : (Array.isArray(item.cards) ? item.cards.length : null);
    } else if (item.action === 'pass' && trick.targetType) {
      bump(passes[seat], trick.targetType);
      const controllerSeat = Number(trick.lastPlayer);
      const hasController = Number.isInteger(controllerSeat)
        && controllerSeat >= 0 && controllerSeat < 4;
      const againstEnemy = hasController && teams[seat] !== teams[controllerSeat];
      const toTeammate = hasController && seat !== controllerSeat
        && teams[seat] === teams[controllerSeat];
      if (againstEnemy) bump(passesAgainstEnemy[seat], trick.targetType);
      else if (toTeammate) bump(passesToTeammate[seat], trick.targetType);
      passEvents[seat].push({
        trickNumber: key,
        controllerSeat: hasController ? controllerSeat : null,
        targetType: trick.lastType,
        targetPower: trick.lastPower,
        targetSize: trick.lastSize,
        againstEnemy,
        toTeammate,
      });
    }
  }
  const controlledTricks = [...tricks.values()].filter((item) => item.hasPlay);
  const recentControllers = controlledTricks.map((item) => item.lastPlayer).slice(-4);
  let controlStreak = {
    seat: null, count: 0, singleCount: 0, allSingles: false, singlePowers: [],
  };
  const latest = controlledTricks.at(-1);
  if (latest) {
    controlStreak = {
      seat: latest.lastPlayer, count: 0, singleCount: 0, allSingles: true,
      singlePowers: [],
    };
    for (let i = controlledTricks.length - 1; i >= 0; i--) {
      const item = controlledTricks[i];
      if (item.lastPlayer !== controlStreak.seat) break;
      controlStreak.count += 1;
      if (item.lastType === HandType.SINGLE) {
        controlStreak.singleCount += 1;
        controlStreak.singlePowers.push(item.lastPower);
      } else controlStreak.allSingles = false;
    }
  }
  return {
    leads,
    // Keep the legacy aggregate for callers that only need raw action counts.
    passes,
    passesAgainstEnemy,
    passesToTeammate,
    passEvents,
    responses,
    recentControllers,
    controlStreak,
  };
}

function historicalTargetNoStronger(event, hand) {
  if (!event?.againstEnemy || !hand || event.targetType !== hand.type) return false;
  if (event.targetPower == null || hand.power == null) return false;
  const targetPower = Number(event.targetPower);
  const currentPower = Number(hand.power);
  if (!Number.isFinite(targetPower) || !Number.isFinite(currentPower)) return false;
  const targetSize = event.targetSize == null ? null : Number(event.targetSize);
  const currentSize = hand.size == null ? null : Number(hand.size);
  if (hand.type === HandType.BOMB
    && Number.isFinite(targetSize) && Number.isFinite(currentSize)
    && targetSize !== currentSize) {
    return targetSize < currentSize;
  }
  if (Number.isFinite(targetSize) && Number.isFinite(currentSize)
    && targetSize !== currentSize) return false;
  return targetPower <= currentPower;
}

export function relevantEnemyPassCount(history, seat, hand) {
  if (!Number.isInteger(Number(seat)) || Number(seat) < 0 || !hand) return 0;
  return (history?.passEvents?.[Number(seat)] || [])
    .filter((event) => historicalTargetNoStronger(event, hand)).length;
}

function countRisk(count) {
  if (count <= 0) return 0;
  if (count <= 2) return 1;
  if (count <= 5) return 0.82;
  if (count <= 8) return 0.56;
  if (count <= 10) return 0.36;
  if (count <= 15) return 0.16;
  return 0.05;
}

function countControls(cards, level) {
  return cards.filter((card) => isJoker(card) || isWild(card, level) || card.rank === 14
    || card.rank === level).length;
}

function lowerBound(cards, level) {
  if (!cards.length) return { tricks: 0, loose: 0 };
  const counts = new Map();
  let wilds = 0;
  let smallJokers = 0;
  let bigJokers = 0;
  for (const card of cards) {
    if (isWild(card, level)) wilds += 1;
    else if (card.rank === 16) smallJokers += 1;
    else if (card.rank === 17) bigJokers += 1;
    else counts.set(card.rank, (counts.get(card.rank) || 0) + 1);
  }
  const values = [...counts.values()];
  const jokerTricks = smallJokers >= 2 && bigJokers >= 2
    ? 1
    : Number(smallJokers > 0) + Number(bigJokers > 0);
  let tricks = counts.size + jokerTricks + (wilds && !counts.size ? 1 : 0);
  if (values.some((count) => count >= 3) && values.filter((count) => count >= 2).length >= 2) {
    tricks -= 1;
  }
  const loose = values.filter((count) => count === 1).length
    + Number(smallJokers === 1) + Number(bigJokers === 1);
  return { tricks: Math.max(1, tricks), loose: Math.max(0, loose - wilds) };
}

/**
 * Estimate threats from public evidence. The values are intentionally soft:
 * a pass is evidence of a weaker response, never proof of a hidden hand.
 */
export function inferPublicThreats(ctx) {
  const history = publicHistorySummary(ctx);
  const seat = ctx.seat ?? 0;
  const teams = ctx.teams || [0, 1, 0, 1];
  const finishOrder = ctx.finishOrder || [];
  const partner = (seat + 2) % 4;
  const enemies = (ctx.handCounts || []).map((count, enemySeat) => ({
    seat: enemySeat,
    count,
  })).filter((item) => item.seat !== seat
    && !finishOrder.includes(item.seat)
    && teams[item.seat] !== teams[seat]);
  const lastType = ctx.lastHand?.type || null;
  const lastSeat = ctx.lastSeat;
  const partnerLead = mostFrequent(history.leads[partner]);
  // 只把对家面对敌方控制牌的过牌视为“可能接不住”的公开证据；
  // 对家礼让本方牌权的过牌不能降低其后续回手概率。
  const partnerPass = lastType
    ? relevantEnemyPassCount(history, partner, ctx.lastHand) : 0;

  const enemyProfiles = enemies.map((enemy) => {
    const passesAgainstLast = lastType
      ? relevantEnemyPassCount(history, enemy.seat, ctx.lastHand) : 0;
    const leadType = mostFrequent(history.leads[enemy.seat]);
    const recentControlCount = history.recentControllers
      .filter((controller) => controller === enemy.seat).length;
    const directFinish = lastSeat === enemy.seat && ctx.lastHand
      && enemy.count === ctx.lastHand.size ? 0.32 : 0;
    const repeatedControl = recentControlCount >= 2 ? 0.12 : 0;
    const passRelief = passesAgainstLast >= 2 ? 0.14 : passesAgainstLast ? 0.05 : 0;
    const finishRisk = clamp(countRisk(enemy.count) + directFinish + repeatedControl - passRelief);
    return {
      ...enemy,
      finishRisk,
      controlRisk: clamp((enemy.count <= 10 ? 0.4 : 0.08) + repeatedControl - passRelief),
      passesAgainstLast,
      leadType,
      recentControlCount,
      passesByType: history.passesAgainstEnemy[enemy.seat],
      passEvents: history.passEvents[enemy.seat],
      responsesByType: history.responses[enemy.seat],
    };
  });
  const nearest = enemyProfiles.slice().sort((a, b) => b.finishRisk - a.finishRisk)[0] || null;
  const partnerCount = ctx.handCounts?.[partner] ?? 99;
  return {
    history,
    enemies: enemyProfiles,
    nearestEnemy: nearest,
    activeEnemyMin: Math.min(...enemyProfiles.map((item) => item.count), 99),
    urgentEnemy: enemyProfiles.some((item) => item.count <= 4 || item.finishRisk >= 0.8),
    partner: {
      seat: partner,
      count: partnerCount,
      needsSupport: !partnerFinished(ctx) && partnerCount > 0 && partnerCount <= 10,
      closing: !partnerFinished(ctx) && partnerCount > 0 && partnerCount <= 5,
      preferredLeadType: partnerLead.type,
      preferredLeadCount: partnerLead.count,
      passesAgainstLast: partnerPass,
    },
  };
}

function partnerFinished(ctx) {
  const partner = (ctx.seat ?? 0) + 2;
  const seat = partner % 4;
  return (ctx.finishOrder || []).includes(seat);
}

/* ------------------------------------------------------------------ *
 * P0 记牌器：公开剩余牌池 + 对手可接概率（软模型）
 * 只使用本家手牌、公开打出的牌、进贡已知牌；不重建、不采样暗牌。
 * ------------------------------------------------------------------ */

const NORMAL_RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
const JOKER_RANKS = [16, 17];
const STRAIGHT_WINDOWS = [
  [14, 2, 3, 4, 5],
  ...Array.from({ length: 9 }, (_, index) => [
    index + 2, index + 3, index + 4, index + 5, index + 6,
  ]),
];

function isWildCard(card, level) {
  return !!card && card.suit === 'H' && card.rank === level && !isJoker(card);
}

/**
 * 计算公开剩余牌池：108 张减去本家手牌、公开打出的牌与进贡给对手的牌。
 * 还贡收到的牌已在本家手牌中，不重复扣除。
 */
export function inferRemainingPool(ctx) {
  const counts = new Array(19).fill(0);
  for (const rank of NORMAL_RANKS) counts[rank] = 8;
  counts[16] = 2;
  counts[17] = 2;
  const naturalCounts = counts.slice();
  const level = ctx.level;
  // 两张红桃级牌既属于该点数，也属于有限逢人配资源。概率计算时把它们
  // 从自然点数池拆出，避免同一张牌同时补多个点数或又作自然级牌。
  naturalCounts[level] = Math.max(0, naturalCounts[level] - 2);
  let wilds = 2;
  const noteKnown = (card) => {
    if (!card || !Number.isFinite(card.rank)) return;
    if (counts[card.rank] > 0) counts[card.rank] -= 1;
    if (isWildCard(card, level)) wilds = Math.max(0, wilds - 1);
    else if (naturalCounts[card.rank] > 0) naturalCounts[card.rank] -= 1;
  };
  const tribute = ctx.tributeContext;
  const hand = ctx.hand || [];
  for (const card of hand) noteKnown(card);
  const played = ctx.playedCards || [];
  for (const card of played) noteKnown(card);

  const knownBySeat = Array.from({ length: 4 }, () => []);
  const exactKey = (card) => (
    card && card.deckIndex != null && Number.isFinite(Number(card.deckIndex))
      ? `${card.rank}:${card.suit}:${Number(card.deckIndex)}`
      : null
  );
  const faceKey = (card) => `${card?.rank}:${card?.suit}`;
  const handExact = new Set(hand.map(exactKey).filter(Boolean));
  const playedExact = new Set(played.map(exactKey).filter(Boolean));
  const handFaces = new Map();
  const playedFaces = new Map();
  for (const card of hand) bump(handFaces, faceKey(card));
  for (const card of played) bump(playedFaces, faceKey(card));

  const publicTransfers = Array.isArray(tribute?.knownTransfers)
    && tribute.knownTransfers.length
    ? tribute.knownTransfers
    : tribute?.gaveCard
      ? [{ card: tribute.gaveCard, to: tribute.gaveTo, kind: 'tribute' }]
      : [];
  // 同一张实体牌若先进贡、后又被还贡，以最后一次公开转移的座位为准。
  const latestTransfers = new Map();
  publicTransfers.forEach((item, index) => {
    const card = item?.card;
    if (!card || !Number.isFinite(card.rank)) return;
    latestTransfers.set(exactKey(card) || `legacy:${index}`, item);
  });
  // 无 deckIndex 的公开转移：按牌面 F=rank:suit 处理（容量 C=2，两副各一；王同面亦 2）。
  // 1) 同牌面已出牌优先与 legacy 转移一一抵消（无实体 ID 时取最大重叠，避免与 playedCards 双扣）；
  // 2) 抵消后剩余转移占用 holdBudget=max(0,C-handFaces-playedFaces)，耗尽则不再 noteKnown/归属。
  // 有 deckIndex 的精确路径保持不变。
  const LEGACY_FACE_CAP = 2;
  const legacyPlayExplain = new Map();
  for (const [fk, n] of playedFaces) legacyPlayExplain.set(fk, n);
  const legacyHoldBudget = new Map();
  for (const item of latestTransfers.values()) {
    const card = item.card;
    const to = Number.isInteger(Number(item.to)) ? Number(item.to) : null;
    const key = exactKey(card);
    const alreadyInOwnHand = key
      ? handExact.has(key)
      : to === Number(ctx.seat) && (handFaces.get(faceKey(card)) || 0) > 0;
    if (key) {
      // 有 deckIndex：精确路径，只认实际打出的实体牌。
      if (playedExact.has(key)) continue;
      if (!alreadyInOwnHand) noteKnown(card);
      if (to != null && to >= 0 && to < 4 && to !== Number(ctx.seat)
        && !alreadyInOwnHand) {
        knownBySeat[to].push({
          rank: card.rank,
          suit: card.suit,
          deckIndex: card.deckIndex != null && Number.isFinite(Number(card.deckIndex))
            ? Number(card.deckIndex) : null,
        });
      }
      continue;
    }
    // 无 deckIndex：身份不明，同一张牌可能在已出牌里出现过。
    if (alreadyInOwnHand) continue;
    const fk = faceKey(card);
    const explain = legacyPlayExplain.get(fk) || 0;
    if (explain > 0) {
      // 该牌面已有公开打出的牌，优先抵消这张转移牌，不再重复扣池或归属。
      legacyPlayExplain.set(fk, explain - 1);
      continue;
    }
    if (!legacyHoldBudget.has(fk)) {
      legacyHoldBudget.set(
        fk,
        Math.max(0, LEGACY_FACE_CAP - (handFaces.get(fk) || 0) - (playedFaces.get(fk) || 0)),
      );
    }
    const budget = legacyHoldBudget.get(fk);
    if (budget <= 0) continue;
    legacyHoldBudget.set(fk, budget - 1);
    noteKnown(card);
    if (to != null && to >= 0 && to < 4 && to !== Number(ctx.seat)) {
      knownBySeat[to].push({
        rank: card.rank,
        suit: card.suit,
        deckIndex: null,
      });
    }
  }
  // 兼容旧复盘/测试中只保留点数、花色不精确的公开牌。无论牌面对象是否仍
  // 标成红桃，剩余逢人配不可能多于剩余级牌总数；同时维持
  // naturalCounts[level] + wilds === counts[level] 的资源守恒。
  wilds = Math.min(wilds, counts[level] || 0);
  naturalCounts[level] = Math.max(0, (counts[level] || 0) - wilds);
  let total = 0;
  for (const count of counts) total += count;
  return {
    counts,
    naturalCounts,
    total,
    wilds,
    knownBySeat,
    level,
  };
}

/**
 * P(X >= n)，X ~ Hypergeom(N, c, k)：从 N 张池中抽 k 张，含至少 n 张该点数。
 * 从必抽到的张数 x0 = max(0, k-(N-c)) 起递推；旧实现从 P(X=0) 起算，
 * 在 x0>0（残局池子变小）时概率链退化为 0，恒返回 1。
 */
export function hypergeomAtLeast(n, c, N, k) {
  if (n <= 0) return 1;
  if (k <= 0 || c < n) return 0;
  if (c >= N) return 1;
  const draw = Math.min(k, N);
  const fail = N - c;
  const x0 = Math.max(0, draw - fail);
  if (x0 >= n) return 1;
  // P(X = x0)：先抽 x0 张该点数、其余为其他点数（一种排列）× 排列数 C(draw, x0)。
  let p = chooseWays(draw, x0);
  for (let j = 0; j < x0; j++) p *= (c - j) / (N - j);
  for (let j = 0; j < draw - x0; j++) p *= (fail - j) / (N - x0 - j);
  let prob = p;
  for (let x = x0; x < n - 1 && x < c; x++) {
    p = p * (c - x) / (x + 1) * (k - x) / (fail - k + x + 1);
    prob += p;
  }
  return 1 - prob;
}

function chooseWays(n, r) {
  if (r < 0 || r > n) return 0;
  if (r === 0 || r === n) return 1;
  r = Math.min(r, n - r);
  let result = 1;
  for (let i = 0; i < r; i++) result = result * (n - i) / (i + 1);
  return result;
}

function hypergeomExactly(x, c, N, k) {
  const draw = Math.min(Math.max(0, k), Math.max(0, N));
  if (x < 0 || x > c || x > draw || draw - x > N - c) return 0;
  const denominator = chooseWays(N, draw);
  if (!denominator) return x === 0 && draw === 0 ? 1 : 0;
  return chooseWays(c, x) * chooseWays(N - c, draw - x) / denominator;
}

function unionProbability(p, q) {
  return p + q - p * q;
}

function activeEnemySeats(ctx) {
  const teams = ctx.teams || [0, 1, 0, 1];
  const finishOrder = ctx.finishOrder || [];
  const seat = ctx.seat ?? 0;
  const enemies = [];
  for (let i = 0; i < 4; i++) {
    if (i === seat || finishOrder.includes(i)) continue;
    if (teams[i] === teams[seat]) continue;
    const count = ctx.handCounts?.[i] ?? 0;
    if (count > 0) enemies.push({ seat: i, count });
  }
  return enemies;
}

/**
 * 每次决策构建一次。seatBeat(hand, k) 返回单名持 k 张的活跃对手能压过该手的软概率。
 * 概率按“公开池中还需存在的更高点数”做超几何估计，逢人配作为有限弹性补张。
 */
export function createBeatModel(ctx) {
  const pool = inferRemainingPool(ctx);
  const enemies = activeEnemySeats(ctx);
  const N = pool.total;
  const nonWildN = Math.max(0, N - pool.wilds);
  const level = pool.level;
  const bombByK = new Map();
  const seatCache = new Map();
  const profileCache = new Map();
  const allocationCache = new Map();
  const history = ctx.publicModel?.history || publicHistorySummary(ctx);
  const rankPower = (rank) => soloPower({ rank }, level);

  const knownProfile = (seat) => {
    const key = Number.isInteger(Number(seat)) ? Number(seat) : -1;
    if (profileCache.has(key)) return profileCache.get(key);
    const cards = key >= 0 ? (pool.knownBySeat?.[key] || []) : [];
    const natural = new Array(19).fill(0);
    let wilds = 0;
    for (const card of cards) {
      if (isWildCard(card, level)) wilds += 1;
      else if (Number.isFinite(card?.rank)) natural[card.rank] += 1;
    }
    const profile = {
      cards,
      natural,
      wilds,
      signature: cards.map((card) => `${card.rank}:${card.suit}:${card.deckIndex ?? '?'}`).sort().join(','),
    };
    profileCache.set(key, profile);
    return profile;
  };

  const unknownDraw = (k, known) => Math.max(0, Math.min(N, Number(k) - known.cards.length));

  const conditionedOnWilds = (k, known, evaluate) => {
    const draw = unknownDraw(k, known);
    let probability = 0;
    const maximumWilds = Math.min(pool.wilds, draw);
    for (let drawnWilds = 0; drawnWilds <= maximumWilds; drawnWilds++) {
      const pWilds = hypergeomExactly(drawnWilds, pool.wilds, N, draw);
      if (!pWilds) continue;
      probability += pWilds * evaluate({
        wilds: known.wilds + drawnWilds,
        nonWildDraw: draw - drawnWilds,
      });
    }
    return clamp(probability);
  };

  const rankUnionProbability = (ranks, needed, k, known) => conditionedOnWilds(
    k,
    known,
    ({ wilds, nonWildDraw }) => {
      let p = 0;
      for (const rank of ranks) {
        const canUseWild = NORMAL_RANKS.includes(rank)
          && (needed > 1 || rank === level);
        const requiredNatural = Math.max(
          0,
          needed - (known.natural[rank] || 0) - (canUseWild ? wilds : 0),
        );
        const q = requiredNatural <= 0
          ? 1
          : hypergeomAtLeast(
              requiredNatural,
              pool.naturalCounts[rank] || 0,
              nonWildN,
              nonWildDraw,
            );
        p = unionProbability(p, q);
      }
      return clamp(p);
    },
  );

  const simpleProbability = (needed, power, k, known) => {
    const higherRanks = [...NORMAL_RANKS, ...JOKER_RANKS]
      .filter((rank) => rankPower(rank) > power);
    return rankUnionProbability(higherRanks, needed, k, known);
  };

  const wildAllocations = (length, budget) => {
    const key = `${length}|${budget}`;
    if (allocationCache.has(key)) return allocationCache.get(key);
    const result = [];
    const current = new Array(length).fill(0);
    const visit = (index, remaining) => {
      if (index >= length) {
        result.push(current.slice());
        return;
      }
      for (let used = 0; used <= remaining; used++) {
        current[index] = used;
        visit(index + 1, remaining - used);
      }
    };
    visit(0, budget);
    allocationCache.set(key, result);
    return result;
  };

  const windowProbability = (window, perRank, k, known) => conditionedOnWilds(
    k,
    known,
    ({ wilds, nonWildDraw }) => {
      let best = 0;
      for (const allocation of wildAllocations(window.length, wilds)) {
        let p = 1;
        for (let index = 0; index < window.length; index++) {
          const rank = window[index];
          const requiredNatural = Math.max(
            0,
            perRank - (known.natural[rank] || 0) - allocation[index],
          );
          if (requiredNatural > 0) {
            p *= hypergeomAtLeast(
              requiredNatural,
              pool.naturalCounts[rank] || 0,
              nonWildN,
              nonWildDraw,
            );
          }
        }
        best = Math.max(best, p);
      }
      return clamp(best);
    },
  );

  const fixedRanksProbability = (requirements, k, known) => conditionedOnWilds(
    k,
    known,
    ({ nonWildDraw }) => {
      let p = 1;
      for (const { rank, needed } of requirements) {
        const requiredNatural = Math.max(0, needed - (known.natural[rank] || 0));
        if (requiredNatural > 0) {
          p *= hypergeomAtLeast(
            requiredNatural,
            pool.naturalCounts[rank] || 0,
            nonWildN,
            nonWildDraw,
          );
        }
      }
      return clamp(p);
    },
  );

  const bombProbability = (k, seat = null) => {
    const known = knownProfile(seat);
    const key = `${k}|${known.signature}`;
    if (bombByK.has(key)) return bombByK.get(key);
    let p = rankUnionProbability(NORMAL_RANKS, 4, k, known);
    const pJokers = fixedRanksProbability([
      { rank: 16, needed: 2 }, { rank: 17, needed: 2 },
    ], k, known);
    p = unionProbability(p, pJokers);
    bombByK.set(key, clamp(p));
    return bombByK.get(key);
  };

  const fullHouseProbability = (power, k, known) => conditionedOnWilds(
    k,
    known,
    ({ wilds, nonWildDraw }) => {
      let p = 0;
      for (const tripleRank of NORMAL_RANKS) {
        if (rankPower(tripleRank) <= power) continue;
        for (const pairRank of NORMAL_RANKS) {
          if (pairRank === tripleRank) continue;
          let combination = 0;
          for (let tripleWilds = 0; tripleWilds <= wilds; tripleWilds++) {
            const pairWilds = wilds - tripleWilds;
            const tripleNeed = Math.max(
              0, 3 - (known.natural[tripleRank] || 0) - tripleWilds,
            );
            const pairNeed = Math.max(
              0, 2 - (known.natural[pairRank] || 0) - pairWilds,
            );
            const qTriple = tripleNeed <= 0 ? 1 : hypergeomAtLeast(
              tripleNeed, pool.naturalCounts[tripleRank] || 0, nonWildN, nonWildDraw,
            );
            const qPair = pairNeed <= 0 ? 1 : hypergeomAtLeast(
              pairNeed, pool.naturalCounts[pairRank] || 0, nonWildN, nonWildDraw,
            );
            combination = Math.max(combination, qTriple * qPair);
          }
          p = unionProbability(p, combination);
        }
      }
      return clamp(p);
    },
  );

  const straightHigh = (window) => (
    window.includes(14) && window.includes(2) ? 5 : Math.max(...window)
  );

  const otherProbability = (type, power, size, k, known, seat) => {
    if (type === HandType.JOKER_BOMB) return 0;
    if (type === HandType.BOMB || type === HandType.FLUSH_STRAIGHT) {
      // 自己出炸弹时，对手须持更强炸弹；天王炸可视为不可被压。
      const floor = bombProbability(k, seat);
      const factor = type === HandType.FLUSH_STRAIGHT ? 0.5 : size >= 5 ? 0.6 : 0.8;
      return floor * factor;
    }
    if (type === HandType.STRAIGHT) {
      let p = 0;
      for (const window of STRAIGHT_WINDOWS) {
        if (straightHigh(window) <= power) continue;
        p = unionProbability(p, windowProbability(window, 1, k, known));
      }
      return clamp(p);
    }
    if (type === HandType.FULLHOUSE) {
      return fullHouseProbability(power, k, known);
    }
    if (type === HandType.TRIPLE_PAIR || type === HandType.PLATE) {
      const perRank = type === HandType.PLATE ? 3 : 2;
      let p = 0;
      for (let start = 2; start <= 12; start++) {
        const window = [start, start + 1, start + 2];
        if (Math.max(...window) <= power) continue;
        p = unionProbability(p, windowProbability(window, perRank, k, known));
      }
      return clamp(p);
    }
    return 0;
  };

  const typeProbability = (hand, k, seat = null) => {
    const known = knownProfile(seat);
    if (hand.type === HandType.SINGLE) return simpleProbability(1, hand.power, k, known);
    if (hand.type === HandType.PAIR) return simpleProbability(2, hand.power, k, known);
    if (hand.type === HandType.TRIPLE) return simpleProbability(3, hand.power, k, known);
    return otherProbability(hand.type, hand.power, hand.size, k, known, seat);
  };

  const evidenceFactor = (seat, hand) => {
    if (!Number.isInteger(Number(seat)) || Number(seat) < 0) return 1;
    const passes = relevantEnemyPassCount(history, Number(seat), hand);
    const responses = history.responses?.[Number(seat)]?.get(hand?.type) || 0;
    return clamp(1 - Math.min(0.28, passes * 0.07) + Math.min(0.05, responses * 0.02), 0.72, 1.05);
  };

  const seatRawTypeBeat = (hand, k, seat = null) => {
    if (!hand || k <= 0) return 0;
    const key = `${hand.type}|${hand.power}|${hand.size || 0}|${k}|${seat ?? '-'}|R`;
    if (seatCache.has(key)) return seatCache.get(key);
    const result = clamp(typeProbability(hand, k, seat));
    seatCache.set(key, result);
    return result;
  };

  // 只考虑同型更高可接（不含炸弹）：对手用炸弹压我们反而消耗其资源，
  // 打牌评分与“能否低成本阻止推进”的判断用该信号更精确。
  const seatTypeBeat = (hand, k, seat = null) => {
    if (!hand || k <= 0) return 0;
    const key = `${hand.type}|${hand.power}|${hand.size || 0}|${k}|${seat ?? '-'}|T`;
    if (seatCache.has(key)) return seatCache.get(key);
    const raw = seatRawTypeBeat(hand, k, seat);
    const known = knownProfile(seat);
    const guaranteed = known.cards.length > 0
      && typeProbability(hand, known.cards.length, seat) >= 1 - 1e-12;
    const result = guaranteed ? 1 : clamp(raw * evidenceFactor(seat, hand));
    seatCache.set(key, result);
    return result;
  };

  const seatBeat = (hand, k, seat = null) => {
    if (!hand || k <= 0) return 0;
    const key = `${hand.type}|${hand.power}|${hand.size || 0}|${k}|${seat ?? '-'}|B`;
    if (seatCache.has(key)) return seatCache.get(key);
    const result = clamp(unionProbability(
      seatTypeBeat(hand, k, seat),
      bombProbability(k, seat),
    ));
    seatCache.set(key, result);
    return result;
  };

  return {
    pool,
    enemies,
    seatBeat,
    seatTypeBeat,
    seatRawTypeBeat,
    bombProbability,
  };
}

/**
 * 未观测静态先验：保留牌型、级牌和对手公开张数这些基础规则，但故意不读取
 * 本家手牌、已出牌、贡还归属或行为历史。仅用于诊断模型边界；正式 no-pX
 * 独立消融始终复用同一个公开信息模型，避免替换输入分布污染归因。
 */
export function createUnconditionedBeatModel(ctx) {
  return createBeatModel({
    seat: ctx.seat,
    level: ctx.level,
    hand: [],
    handCounts: (ctx.handCounts || []).slice(0, 4),
    teams: (ctx.teams || [0, 1, 0, 1]).slice(0, 4),
    finishOrder: (ctx.finishOrder || []).slice(0, 4),
    playedCards: [],
    publicHistory: [],
    tributeContext: null,
    publicModel: null,
  });
}

/**
 * P1 控权期望：routeAdjustment 为保持牌权时的路线优势（相对候选均值），
 * pLose 为被对手同型压回而丢权的概率，lossPenalty 为丢权损失。
 * 期望增量 = (1-p)·routeAdjustment - p·lossPenalty。
 */
export function controlEV(routeAdjustment, pLose, lossPenalty) {
  return routeAdjustment * (1 - pLose) - pLose * lossPenalty;
}

/**
 * P2 炸弹净收益：比较「现在不炸、走普通路线」与「现在炸、走炸后路线」的期望成本。
 * 成本约定与 applyLookAhead 一致（越大越差）：
 *   routeOrdCost  不炸时普通接法后剩余手牌的路线成本
 *   routeBombCost 炸后剩余手牌的路线成本
 *   pLose         普通接法被压回而丢权的概率（越大越该炸）
 *   lossPenalty   丢权损失（对手临门一脚/高控牌被废时更大）
 *   bombResource  现在消耗炸弹的机会成本
 * 净收益 > 0 表示炸更划算；> playThresh 应炸，< -saveThresh 应省。
 */
export function bombNetGain(routeOrdCost, routeBombCost, pLose, lossPenalty, bombResource) {
  return (routeOrdCost - routeBombCost) - bombResource + pLose * lossPenalty;
}

/** 至少一名活跃对手能同型压过该手的软概率（P0 记牌器的“可接概率”）。 */
export function enemyBeatProbability(play, ctx, model) {
  const beatModel = model || createBeatModel(ctx);
  if (!play?.hand) return 0;
  let p = 0;
  for (const enemy of beatModel.enemies) {
    p = unionProbability(p, beatModel.seatTypeBeat(play.hand, enemy.count, enemy.seat));
  }
  return p;
}

/**
 * 按真实座位顺序估算「本手打出后，敌方最终保住牌权」的软概率。
 *
 * 这里只计算同型普通接牌；炸弹概率单独留给炸弹净收益模块，避免一名对手
 * 牌多时“可能有任意炸弹”把所有候选都压成接近 100%，从而淹没 K/A、
 * 对J/对K之间真正有用的控权差异。下家先接、对家再尝试接回、上家最后
 * 反压，因此不能用两个敌方概率的简单并集。
 *
 * 对家回手同样只使用公开信息，并且必须满足牌型尺寸：对家剩余张数少于
 * 本手尺寸时，回手概率严格为 0。seatTypeBeat 只表示能压过当前候选，
 * 实际还要压过下家的更高出牌，所以再乘保守折扣，避免固定常数幻觉。
 */
export function orderedTeamControlLossProbability(play, ctx, model) {
  const beatModel = model || createBeatModel(ctx);
  if (!play?.hand || !beatModel) return 0;
  const active = new Map(beatModel.enemies.map((enemy) => [enemy.seat, enemy]));
  const downstreamSeat = (ctx.seat + 1) % 4;
  const upstreamSeat = (ctx.seat + 3) % 4;
  const enemyTypeBeat = (seat) => {
    const enemy = active.get(seat);
    return enemy
      ? beatModel.seatTypeBeat(play.hand, enemy.count, enemy.seat)
      : 0;
  };
  const downstreamBeat = enemyTypeBeat(downstreamSeat);
  const upstreamBeat = enemyTypeBeat(upstreamSeat);

  const partnerSeat = (ctx.seat + 2) % 4;
  const partnerCount = ctx.handCounts?.[partnerSeat] ?? 0;
  const partnerActive = !(ctx.finishOrder || []).includes(partnerSeat)
    && partnerCount >= (play.hand.size || play.cards?.length || 1);
  let partnerRetake = 0;
  if (partnerActive) {
    // 能压当前候选只是回手的上界；下家若接牌，其牌力必然更高。
    partnerRetake = beatModel.seatTypeBeat(play.hand, partnerCount, partnerSeat) * 0.55;
    if (ctx.publicModel?.partner?.preferredLeadType === play.hand.type) {
      partnerRetake *= 1.06;
    }
    if ((ctx.publicModel?.partner?.passesAgainstLast || 0) >= 2) {
      partnerRetake *= 0.82;
    }
    partnerRetake = clamp(partnerRetake, 0, 0.45);
  }

  return clamp(
    upstreamBeat + (1 - upstreamBeat) * downstreamBeat * (1 - partnerRetake),
  );
}

function nextComparableResponseHand(hand, level) {
  if (!hand || BOMB_TYPES.includes(hand.type)) return null;
  let powers;
  if (SIMPLE_TYPES.includes(hand.type) || hand.type === HandType.FULLHOUSE) {
    const ranks = hand.type === HandType.SINGLE || hand.type === HandType.PAIR
      ? [...NORMAL_RANKS, ...JOKER_RANKS]
      : NORMAL_RANKS;
    powers = ranks
      .map((rank) => ({ rank, power: soloPower({ rank }, level) }))
      .filter((item, index, values) => (
        values.findIndex((other) => other.power === item.power) === index
      ));
  } else {
    // 顺子、三连对和钢板都按最高点比较；A23 三连对为3高、A2钢板为2高。
    const minimum = hand.type === HandType.PLATE ? 2
      : hand.type === HandType.TRIPLE_PAIR ? 3 : 5;
    powers = Array.from({ length: 15 - minimum }, (_, index) => ({
      rank: index + minimum,
      power: index + minimum,
    }));
  }
  const next = powers
    .filter((item) => item.power > Number(hand.power))
    .sort((left, right) => left.power - right.power)[0];
  return next ? { ...hand, mainRank: next.rank, power: next.power } : null;
}

function responseBombUseProbability(handCount, opposingRemaining) {
  // bombProbability 表示“可能持有”，不是“本手必定会用”。只在敌方即将走完、
  // 或持炸者自己已进入短手时提高投入率，普通中盘保持明显低于一半。
  const ownUrgency = handCount <= 5 ? 0.3 : handCount <= 9 ? 0.16 : 0;
  const blockUrgency = opposingRemaining <= 3 ? 0.42 : opposingRemaining <= 6 ? 0.2 : 0;
  return clamp(0.08 + ownUrgency + blockUrgency, 0.08, 0.8);
}

function partnerRetakeIntent(partnerCount, playSize, activeEnemyMin) {
  if (partnerCount === playSize) return 1;
  if (partnerCount <= 6) return 0.86;
  if (activeEnemyMin <= 5) return 0.78;
  if (partnerCount <= 10) return 0.7;
  return 0.58;
}

/**
 * P1 一层公开应手树：自己出牌后，仅展开
 *   下家普通接/炸/过 → 对家能否接回 → 上家普通反压/炸/过。
 *
 * 返回的是公开信息下的软概率，不重建、抽样或读取任何一家真实暗牌。
 * 同型反压使用“下一档最低合法应手”作为门槛：对家要接下家，至少要压过
 * 下一档；上家要再压对家，至少要压过再下一档，避免旧固定 0.55 折扣把
 * 不同牌型都当成同一个难度。
 */
export function evaluatePublicResponseTree(play, ctx, model, options = {}) {
  const beatModel = model || createBeatModel(ctx);
  if (!play?.hand || !beatModel) return null;
  const seat = Number(ctx.seat) || 0;
  const teams = ctx.teams || [0, 1, 0, 1];
  const finishOrder = ctx.finishOrder || [];
  const handCounts = ctx.handCounts || [];
  const playSize = play.hand.size || play.cards?.length || 1;
  const ownRemaining = Math.max(0, Number(options.ownRemaining) || 0);
  const activeEnemyMin = ctx.publicModel?.activeEnemyMin
    ?? Math.min(...handCounts.map((count, index) => (
      index !== seat && !finishOrder.includes(index) && teams[index] !== teams[seat]
        ? count : 99
    )));
  const activeCount = (target) => (
    target >= 0 && target < 4 && !finishOrder.includes(target)
      ? Math.max(0, Number(handCounts[target]) || 0)
      : 0
  );
  const isEnemy = (target) => teams[target] !== teams[seat];
  const bombType = BOMB_TYPES.includes(play.hand.type);
  const minimumResponse = nextComparableResponseHand(play.hand, ctx.level);
  const secondResponse = minimumResponse
    ? nextComparableResponseHand(minimumResponse, ctx.level)
    : null;

  const response = (target, threshold = play.hand) => {
    const count = activeCount(target);
    if (!count || !isEnemy(target)) return { type: 0, bomb: 0, pass: 1 };
    const type = count >= playSize
      ? clamp(beatModel.seatTypeBeat(threshold, count, target))
      : 0;
    // 对炸弹候选，seatTypeBeat 已经表示更强炸弹，不能再并一次“任意炸弹”。
    const bomb = bombType || count < 4
      ? 0
      : clamp((1 - type) * beatModel.bombProbability(count, target)
        * responseBombUseProbability(count, ownRemaining));
    return { type, bomb, pass: clamp(1 - type - bomb) };
  };

  const downstreamSeat = (seat + 1) % 4;
  const partnerSeat = (seat + 2) % 4;
  const upstreamSeat = (seat + 3) % 4;
  const downstream = response(downstreamSeat, play.hand);
  const upstreamDirect = response(upstreamSeat, play.hand);
  const partnerCount = activeCount(partnerSeat);
  const partnerCanRetake = minimumResponse
    && partnerCount >= playSize
    && teams[partnerSeat] === teams[seat];
  const partnerRetake = partnerCanRetake
    ? clamp(
        beatModel.seatTypeBeat(minimumResponse, partnerCount, partnerSeat)
          * partnerRetakeIntent(partnerCount, playSize, activeEnemyMin),
      )
    : 0;
  // P3 才展开“下家过 → 对家直接接手”的分支。旧 P1 只模拟下家先接后
  // 对家反接，漏掉了真实座位顺序中最常见的送牌路径；通过显式选项保持
  // no-p3 消融只改变这一项。
  const partnerDirect = options.includePartnerHandoff && partnerCanRetake
    ? clamp(
        beatModel.seatTypeBeat(play.hand, partnerCount, partnerSeat)
          * partnerRetakeIntent(partnerCount, playSize, activeEnemyMin),
      )
    : 0;
  // 已无第三档同型牌时，仍保留上家用炸弹反压的分支；null 门槛只令
  // seatTypeBeat 为0，不会抹掉独立的炸弹资源投入概率。
  const upstreamAfterPartner = minimumResponse
    ? response(upstreamSeat, secondResponse)
    : { type: 0, bomb: 0, pass: 1 };
  const upstreamAfterPartnerResponse = upstreamAfterPartner.type
    + upstreamAfterPartner.bomb;
  const upstreamDirectResponse = upstreamDirect.type + upstreamDirect.bomb;

  const partnerTakes = downstream.type * partnerRetake
    + downstream.pass * partnerDirect;
  const partnerControl = partnerTakes * (1 - upstreamAfterPartnerResponse);
  const enemyAfterPartner = partnerTakes
    * upstreamAfterPartnerResponse;
  const enemyFromDownstream = downstream.type * (1 - partnerRetake) + downstream.bomb;
  const enemyFromUpstream = downstream.pass * (1 - partnerDirect)
    * upstreamDirectResponse;
  const selfControl = downstream.pass * (1 - partnerDirect)
    * (1 - upstreamDirectResponse);
  const enemyControl = enemyFromDownstream + enemyAfterPartner + enemyFromUpstream;
  const enemyBomb = downstream.bomb
    + partnerTakes * upstreamAfterPartner.bomb
    + downstream.pass * (1 - partnerDirect) * upstreamDirect.bomb;
  const total = selfControl + partnerControl + enemyControl;
  const normalize = total > 0 ? 1 / total : 1;

  return {
    selfControl: clamp(selfControl * normalize),
    partnerControl: clamp(partnerControl * normalize),
    enemyControl: clamp(enemyControl * normalize),
    enemyBomb: clamp(enemyBomb * normalize),
    teamControl: clamp((selfControl + partnerControl) * normalize),
    seats: { downstream: downstreamSeat, partner: partnerSeat, upstream: upstreamSeat },
    branches: {
      downstream,
      partnerRetake,
      partnerDirect,
      upstreamDirect,
      upstreamAfterPartner,
    },
  };
}

/** P3 共享护牌信号：AI 与真人评价使用完全相同的公开风险差。 */
export function publicPartnerProtectionValue(play, ctx, model) {
  if (!play?.hand || !ctx?.lastHand || BOMB_TYPES.includes(ctx.lastHand.type)) return null;
  const beatModel = model || createBeatModel(ctx);
  const seat = Number(ctx.seat) || 0;
  const downstream = (seat + 1) % 4;
  const partner = (seat + 2) % 4;
  if ((ctx.finishOrder || []).includes(downstream)
    || ctx.teams?.[downstream] === ctx.teams?.[seat]) return null;
  const downstreamCount = ctx.handCounts?.[downstream] ?? 99;
  const partnerCount = (ctx.finishOrder || []).includes(partner)
    ? 0 : (ctx.handCounts?.[partner] ?? 99);
  const activeEnemyMin = ctx.publicModel?.activeEnemyMin ?? 99;
  if (partnerCount <= 5 || (downstreamCount > 8 && activeEnemyMin > 5)) return null;
  const currentRisk = beatModel.seatTypeBeat(ctx.lastHand, downstreamCount, downstream);
  const protectedRisk = beatModel.seatTypeBeat(play.hand, downstreamCount, downstream);
  const reduction = currentRisk - protectedRisk;
  return {
    eligible: currentRisk >= 0.38 && reduction >= 0.16,
    downstream,
    downstreamCount,
    partnerCount,
    currentRisk,
    protectedRisk,
    reduction,
  };
}

function rolloutRoutePenalty(route) {
  if (!route) return 80;
  return route.estimatedTricks * 15
    + route.loose * 2.2
    + route.controlsSpent * 1.4
    + (route.bombsSpent || 0) * 3.5
    - (route.adjustment || 0) * 0.35;
}

/**
 * P4 受限残局公开情景 rollout。
 *
 * 只展开当前候选的公开应手结果；若本家继续持权，再枚举本家下一次领出。
 * 对家/对手分支只使用公开牌池软概率与公开张数作为终值，不生成、更不读取
 * 任一真实暗牌。节点或墙钟预算耗尽时返回 timedOut，由调用者完整丢弃本次
 * 未完成结果并保留 P0-P3 排名。
 */
export function evaluatePublicEndgameRollout(
  play,
  remainingHand,
  ctx,
  model,
  options = {},
) {
  if (!play?.hand || !Array.isArray(remainingHand)) return null;
  const beatModel = model || createBeatModel(ctx);
  const nodeBudget = Math.max(4, Number(options.nodeBudget) || 30);
  const branchLimit = Math.max(2, Math.min(8, Number(options.branchLimit) || 4));
  const deadlineMs = Number.isFinite(options.deadlineMs) ? options.deadlineMs : null;
  const now = typeof options.now === 'function'
    ? options.now
    : () => globalThis.performance?.now?.() ?? Date.now();
  let nodes = 0;
  let timedOut = false;
  const takeNode = () => {
    nodes += 1;
    if (nodes > nodeBudget || (deadlineMs != null && now() >= deadlineMs)) {
      timedOut = true;
      return false;
    }
    return true;
  };
  if (!takeNode()) return { timedOut: true, nodes };

  const includePartnerHandoff = !!options.includePartnerHandoff;
  const first = evaluatePublicResponseTree(play, ctx, beatModel, {
    ownRemaining: remainingHand.length,
    includePartnerHandoff,
  });
  if (!first) return null;
  if (!remainingHand.length) {
    return {
      expectedUtility: 140,
      selfContinuation: 140,
      first,
      nodes,
      timedOut: false,
      depth: 2,
    };
  }

  const routeCtx = { ...ctx, mode: 'lead', publicModel: ctx.publicModel };
  const fallbackRoute = options.baseRoute || estimateThreeStepRoute(
    remainingHand,
    ctx.level,
    routeCtx,
    {
      depth: 3,
      beam: branchLimit,
      cache: options.cache || new Map(),
    },
  );
  const activeEnemyMin = ctx.publicModel?.activeEnemyMin ?? 99;
  const finishRisk = ctx.publicModel?.nearestEnemy?.finishRisk || 0;
  const enemyLoss = 26
    + Math.max(0, 7 - activeEnemyMin) * 7
    + finishRisk * 34;
  const partnerSeat = ((Number(ctx.seat) || 0) + 2) % 4;
  const partnerCount = (ctx.finishOrder || []).includes(partnerSeat)
    ? 0 : (ctx.handCounts?.[partnerSeat] ?? 99);
  const partnerGain = partnerCount <= 2 ? 72
    : partnerCount <= 5 ? 52
      : partnerCount <= 8 ? 34 : 20;
  let selfContinuation = 34 - rolloutRoutePenalty(fallbackRoute);
  let bestNext = null;

  const nextLeads = routeCandidates(remainingHand, ctx.level, branchLimit)
    .slice(0, branchLimit);
  for (const next of nextLeads) {
    if (!takeNode()) break;
    const tail = removeCards(remainingHand, next.cards);
    const tailRoute = estimateThreeStepRoute(tail, ctx.level, routeCtx, {
      // 第二层的核心问题是“下一手能否站住”；尾部牌数沿用一手路线下界，
      // 不再在每个分支重复展开两手搜索。
      depth: 1,
      beam: branchLimit,
      cache: options.cache || new Map(),
    });
    const nextResponse = evaluatePublicResponseTree(next, ctx, beatModel, {
      ownRemaining: tail.length,
      includePartnerHandoff,
    });
    if (!nextResponse) continue;
    const finishBonus = tail.length === 0 ? 120 : 0;
    const nextValue = finishBonus
      - rolloutRoutePenalty(tailRoute)
      + nextResponse.selfControl * (tail.length <= 3 ? 48 : 28)
      + nextResponse.partnerControl * partnerGain * 0.65
      - nextResponse.enemyControl * enemyLoss
      + nextResponse.enemyBomb * 4;
    if (!bestNext || nextValue > bestNext.value) {
      bestNext = {
        value: nextValue,
        type: next.hand.type,
        size: next.hand.size,
        power: next.hand.power,
        teamControl: nextResponse.teamControl,
      };
      selfContinuation = nextValue;
    }
  }
  if (timedOut) return { timedOut: true, nodes };

  const expectedUtility = first.selfControl * selfContinuation
    + first.partnerControl * partnerGain
    - first.enemyControl * enemyLoss
    + first.enemyBomb * 5;
  return {
    expectedUtility,
    selfContinuation,
    partnerGain,
    enemyLoss,
    first,
    bestNext,
    nodes,
    timedOut: false,
    depth: 2,
  };
}

/** 活跃对手至少一家具备任意炸弹的公开信息软概率，供炸弹模块单独折价。 */
export function enemyBombExposureProbability(ctx, model) {
  const beatModel = model || createBeatModel(ctx);
  let probability = 0;
  for (const enemy of beatModel.enemies) {
    probability = unionProbability(
      probability,
      beatModel.bombProbability(enemy.count, enemy.seat),
    );
  }
  return clamp(probability);
}

/** Public-information coordination value shared by AI and evaluator. */
export function publicCoordinationScore(play, ctx, model = inferPublicThreats(ctx)) {
  const mode = ctx.mode || (ctx.lastHand ? 'beat' : 'lead');
  let score = 0;
  const tags = [];
  const reasons = [];
  const lastIsEnemy = ctx.lastSeat != null
    && ctx.teams?.[ctx.lastSeat] !== ctx.teams?.[ctx.seat];
  if (mode === 'beat' && lastIsEnemy && model.nearestEnemy) {
    const enemy = model.enemies.find((item) => item.seat === ctx.lastSeat)
      || model.nearestEnemy;
    if (enemy?.finishRisk >= 0.72) {
      const matchesSize = !!ctx.lastHand && play.cards.length === ctx.lastHand.size;
      if (matchesSize || BOMB_TYPES.includes(play.hand?.type)) {
        score += 24;
        tags.push('public_finish_block');
        reasons.push(`公开牌面推断对手剩${enemy.count}张，优先保留本手的确定拦截价值`);
      } else if (enemy.count <= 5) {
        score -= 28;
        tags.push('weak_public_block');
        reasons.push('公开牌面显示对手接近收官，普通不同型接法拦截把握不足');
      }
    }
    if (enemy?.recentControlCount >= 2 && enemy.count <= 10) {
      score += 14;
      if (!tags.includes('public_finish_block')) tags.push('public_control_block');
      reasons.push('对手近期连续拿到牌权，公开信息支持提高拦截优先级');
    }
  }
  if (mode === 'lead' && model.partner.needsSupport) {
    const partnerCount = model.partner.count;
    // 对家手牌 ≤3 时只有张数不超其手数的牌才可能被其接住；
    // 残局型匹配与大牌路加成都不应对超尺寸的长组合生效。
    const sizeOk = play.cards.length <= partnerCount;
    if (model.partner.preferredLeadType === play.hand?.type
      && model.partner.preferredLeadCount >= 2 && sizeOk) {
      score += model.partner.closing ? 28 : 16;
      tags.push('partner_closing_route');
      reasons.push(`对家剩${partnerCount}张且公开牌路偏向${play.hand.type}，优先送入对家熟悉的牌路`);
    }
    if (model.partner.closing && SIMPLE_TYPES.includes(play.hand?.type)
      && (play.hand.power || 0) <= 9) {
      score += 12;
      if (!tags.includes('partner_closing_route')) tags.push('partner_support_lead');
      reasons.push('对家进入五张内残局，首领优先提供小而容易接手的牌型');
    }
    // P3 对家送型：残局张数越少，越只送小尺寸、低点且能穿过下家拦截的牌。
    if (model.partner.closing && partnerCount <= 3
      && !BOMB_TYPES.includes(play.hand?.type)) {
      if (sizeOk) {
        score += 22;
        tags.push('partner_feed_size');
        reasons.push(`对家剩${partnerCount}张，只有${play.cards.length}张以内的牌才可能被其接住，抵消长组合偏好`);
      }
      if (sizeOk && SIMPLE_TYPES.includes(play.hand?.type)
        && (play.hand.power || 0) <= 9) {
        score += 10;
        tags.push('partner_feed_low');
        reasons.push('对家残局张数极少，送低点单/对/三更易被顺手接住');
      }
    }
    if (model.partner.closing && !BOMB_TYPES.includes(play.hand?.type)) {
      const downstream = (ctx.seat + 1) % 4;
      const downstreamEnemy = model.enemies.find((enemy) => (
        enemy.seat === downstream && enemy.count > 0
      ));
      if (downstreamEnemy
        && (downstreamEnemy.passesByType?.get(play.hand?.type) || 0) > 0
        && (downstreamEnemy.responsesByType?.get(play.hand?.type) || 0) === 0) {
        score += 14;
        tags.push('partner_feed_clean');
        reasons.push('下家对手公开对该牌型过牌，送型更可能穿过其拦截送到对家手里');
      }
    }
  }
  if (mode === 'lead' && !BOMB_TYPES.includes(play.hand?.type)) {
    const type = play.hand?.type;
    const enemies = (model.enemies || []).filter((enemy) => enemy.count > 0);
    const passedBy = enemies.filter((enemy) => (
      relevantEnemyPassCount(model.history, enemy.seat, play.hand) > 0
    ));
    const respondedBy = enemies.filter((enemy) => (
      (enemy.responsesByType?.get(type) || 0) > 0
    ));
    // 两个对手都曾在该牌型上过牌，且没有公开打出过同型响应时，
    // 该牌型更可能是“对家能接、对手不想接”的合作入口；只给软加分。
    if (enemies.length === 2 && passedBy.length === 2 && respondedBy.length === 0) {
      score += model.partner.closing ? 18 : 10;
      tags.push('public_safe_type');
      reasons.push(`两个对手都曾对${type}过牌，公开牌史支持将其作为低风险领牌试探`);
    } else if (enemies.length && passedBy.length === enemies.length
      && respondedBy.length < passedBy.length) {
      score += 5;
      tags.push('public_type_probe');
      reasons.push(`对手公开牌史对${type}的响应较少，仅作轻量试探加分`);
    }
  }
  return { score, tags, reasons };
}

function routeCandidates(cards, level, beam) {
  const legal = generateLegalPlays(cards, level, null);
  const seen = new Set();
  const ranked = legal.filter((play) => {
    // The source hand is fixed inside this search node, so two plays leave the
    // same remainder exactly when they consume the same physical cards. Using
    // the consumed ids avoids rebuilding and sorting the much larger remainder
    // for every declaration variant.
    const usedKey = play.cards.map((card) => String(card.id)).sort().join(',');
    if (seen.has(usedKey)) return false;
    seen.add(usedKey);
    return true;
  }).sort((a, b) => {
    const aFinish = a.cards.length === cards.length ? 1 : 0;
    const bFinish = b.cards.length === cards.length ? 1 : 0;
    const aBomb = BOMB_TYPES.includes(a.hand.type) ? 1 : 0;
    const bBomb = BOMB_TYPES.includes(b.hand.type) ? 1 : 0;
    return bFinish - aFinish
      || b.cards.length - a.cards.length
      || aBomb - bBomb
      || a.hand.power - b.hand.power;
  });
  const selected = [];
  const selectedKeys = new Set();
  const add = (play) => {
    if (!play) return;
    const key = `${play.hand.type}|${play.cards.map((card) => String(card.id)).sort().join(',')}`;
    if (selectedKeys.has(key)) return;
    selectedKeys.add(key);
    selected.push(play);
  };
  for (const play of ranked.filter((play) => play.cards.length === cards.length)) add(play);
  for (const play of ranked.slice(0, Math.ceil(beam / 2))) add(play);
  const seenTypes = new Set();
  for (const play of ranked) {
    if (seenTypes.has(play.hand.type)) continue;
    seenTypes.add(play.hand.type);
    add(play);
    if (selected.length >= beam) break;
  }
  for (const play of ranked) {
    if (selected.length >= beam) break;
    add(play);
  }
  return selected.slice(0, beam);
}

/**
 * Search the player's own next three lead routes. It estimates the route
 * after a possible control change; it does not pretend to know opponents'
 * hidden cards.
 * options.fullDepth=true 时对手牌 ≤ 残局阈值的小手牌做满深度路线搜索
 * （只搜自己手牌的全部出牌顺序，仍不读取/采样任何暗牌），节点超限退回下界估计。
 */
export function estimateThreeStepRoute(hand, level, ctx = {}, options = {}) {
  const fullDepth = !!options.fullDepth;
  const depth = fullDepth
    ? Number.POSITIVE_INFINITY
    : Math.max(1, Math.min(3, options.depth || 3));
  const beam = Math.max(3, Math.min(8, options.beam || 6));
  const cache = options.cache || new Map();
  const nodeBudget = fullDepth ? Math.max(1000, options.nodeBudget || 30000) : 0;
  const stats = { nodes: 0, truncated: false };
  const search = (cards, remainingDepth) => {
    if (!cards.length) {
      return {
        tricks: 0, loose: 0, controlsSpent: 0, bombsSpent: 0, firstType: null,
      };
    }
    if (fullDepth) {
      stats.nodes += 1;
      if (stats.nodes > nodeBudget) {
        stats.truncated = true;
        const fallback = {
          ...lowerBound(cards, level), controlsSpent: 0, bombsSpent: 0, firstType: null,
        };
        cache.set(`${remainingDepth}|${cards.map((card) => card.id).sort().join(',')}`, fallback);
        return fallback;
      }
    }
    const key = `${remainingDepth}|${cards.map((card) => card.id).sort().join(',')}`;
    if (cache.has(key)) return cache.get(key);
    const whole = parseHand(cards, level);
    if (whole && cards.length > 1) {
      const result = {
        tricks: 1, loose: 0, controlsSpent: 0, bombsSpent: 0, firstType: whole.type,
      };
      cache.set(key, result);
      return result;
    }
    if (remainingDepth <= 0) {
      const result = {
        ...lowerBound(cards, level), controlsSpent: 0, bombsSpent: 0, firstType: null,
      };
      cache.set(key, result);
      return result;
    }
    const candidates = routeCandidates(cards, level, beam);
    let best = null;
    for (const play of candidates) {
      const remain = removeCards(cards, play.cards);
      const tail = search(remain, remainingDepth - 1);
      const controlsSpent = tail.controlsSpent
        + countControls(play.cards, level);
      const bombsSpent = (tail.bombsSpent || 0) + Number(BOMB_TYPES.includes(play.hand.type));
      const candidate = {
        tricks: 1 + tail.tricks,
        loose: tail.loose,
        controlsSpent,
        bombsSpent,
        firstType: play.hand.type,
      };
      const cost = candidate.tricks * 10
        + candidate.loose * 1.6
        + candidate.controlsSpent * 0.55
        + candidate.bombsSpent * 3.5
        - play.cards.length * 0.2
        - (play.cards.length === cards.length ? 100 : 0);
      if (!best || cost < best.cost) best = { ...candidate, cost };
    }
    const result = best || {
      ...lowerBound(cards, level), controlsSpent: 0, bombsSpent: 0, firstType: null,
    };
    cache.set(key, result);
    return result;
  };
  const route = search(hand, depth);
  const model = ctx.publicModel || inferPublicThreats({ ...ctx, hand, level });
  const horizon = fullDepth ? '残局满深度' : '三手';
  let adjustment = 0;
  const tags = [];
  const reasons = [];
  if (ctx.mode === 'lead' && model.partner.needsSupport
    && model.partner.preferredLeadType === route.firstType) {
    adjustment += model.partner.closing ? 18 : 10;
    tags.push('route_partner_match');
    reasons.push(`${horizon}牌路前瞻与对家公开熟悉牌型一致`);
  }
  if (route.tricks <= 2 && route.controlsSpent === 0) {
    adjustment += 14;
    tags.push('route_two_step');
    reasons.push(`${horizon}前瞻显示后续可在不交控制牌的情况下快速收尾`);
  }
  if (model.urgentEnemy && ctx.mode === 'beat') {
    adjustment += model.nearestEnemy?.finishRisk >= 0.8 ? 12 : 0;
  }
  return {
    ...route,
    estimatedTricks: route.tricks,
    fullDepth,
    truncated: stats.truncated,
    adjustment,
    tags,
    reasons,
    publicModel: model,
  };
}
