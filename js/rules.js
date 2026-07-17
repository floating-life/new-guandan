/**
 * 掼蛋规则引擎
 * 牌型识别、大小比较、合法出牌生成（含逢人配）
 */

import {
  isJoker, isWild, soloPower, RANK_LABEL,
} from './cards.js';

/** 牌型枚举 */
export const HandType = {
  SINGLE: 'single',
  PAIR: 'pair',
  TRIPLE: 'triple',
  TRIPLE_PAIR: 'triple_pair',   // 三连对 6张
  PLATE: 'plate',               // 钢板 二连三 6张
  FULLHOUSE: 'fullhouse',       // 三带二
  STRAIGHT: 'straight',         // 顺子 5
  BOMB: 'bomb',                 // 炸弹 4+
  FLUSH_STRAIGHT: 'flush_straight', // 同花顺
  JOKER_BOMB: 'joker_bomb',     // 天王炸
};

export const HAND_TYPE_NAME = {
  single: '单张',
  pair: '对子',
  triple: '三同张',
  triple_pair: '三连对',
  plate: '钢板',
  fullhouse: '三带二',
  straight: '顺子',
  bomb: '炸弹',
  flush_straight: '同花顺',
  joker_bomb: '天王炸',
};

/** 普通牌型（第一类）集合 */
const NORMAL_TYPES = new Set([
  HandType.SINGLE, HandType.PAIR, HandType.TRIPLE,
  HandType.TRIPLE_PAIR, HandType.PLATE, HandType.FULLHOUSE, HandType.STRAIGHT,
]);

const NATURAL_RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
const STRAIGHT_SEQUENCES = [
  [1, 2, 3, 4, 5],
  ...Array.from({ length: 9 }, (_, i) => {
    const start = i + 2;
    return [start, start + 1, start + 2, start + 3, start + 4];
  }),
];
const TRIPLE_PAIR_SEQUENCES = [
  [1, 2, 3],
  ...Array.from({ length: 11 }, (_, i) => {
    const start = i + 2;
    return [start, start + 1, start + 2];
  }),
];
const PLATE_SEQUENCES = [
  [1, 2],
  ...Array.from({ length: 12 }, (_, i) => {
    const start = i + 2;
    return [start, start + 1];
  }),
];

// 保持旧 parseHand 的牌型优先级；同一牌型默认取点数最小的稳定解释。
const DEFAULT_TYPE_PRIORITY = new Map([
  [HandType.JOKER_BOMB, 0],
  [HandType.BOMB, 1],
  [HandType.FLUSH_STRAIGHT, 2],
  [HandType.SINGLE, 3],
  [HandType.PAIR, 4],
  [HandType.TRIPLE, 5],
  [HandType.FULLHOUSE, 6],
  [HandType.STRAIGHT, 7],
  [HandType.TRIPLE_PAIR, 8],
  [HandType.PLATE, 9],
]);

/**
 * 返回只描述“牌型声明”的稳定签名，不依赖实体牌 id 或输入顺序。
 * 可直接把该签名传给 isLegalPlay 的第四个参数来指定解释。
 */
export function handSignature(hand) {
  if (!hand) return '';
  const meta = hand.meta || {};
  const sequence = Array.isArray(meta.sequence) ? meta.sequence.join('-') : '';
  return [
    hand.type || '',
    Number.isFinite(hand.size) ? hand.size : '',
    Number.isFinite(hand.mainRank) ? hand.mainRank : '',
    Number.isFinite(meta.pairRank) ? meta.pairRank : '',
    meta.suit || '',
    sequence,
  ].join('|');
}

/**
 * 枚举同一组实体牌的全部合法声明。
 * 例如逢人配可让同一组牌声明为多个不同点数的顺子；同花牌同时保留
 * “普通顺子”和“同花顺”两种声明。
 *
 * @returns {Array<{type, mainRank, size, power, cards, meta}>}
 */
export function parseHandVariants(cards, level) {
  if (!Array.isArray(cards) || cards.length === 0) return [];

  const n = cards.length;
  const wilds = cards.filter((c) => isWild(c, level));
  const normals = cards.filter((c) => !isWild(c, level));
  const variants = [];
  const seen = new Set();
  const add = (type, mainRank, power, meta = {}) => {
    const hand = { type, mainRank, size: n, power, cards, meta };
    const signature = handSignature(hand);
    if (!seen.has(signature)) {
      seen.add(signature);
      variants.push(hand);
    }
  };

  // 天王炸
  if (n === 4) {
    const big = cards.filter((c) => c.rank === 17).length;
    const small = cards.filter((c) => c.rank === 16).length;
    if (big === 2 && small === 2) {
      add(HandType.JOKER_BOMB, 17, 10000);
    }
  }

  // 单张逢人配仍按它本身的级牌点数使用，不能把单牌任意变点。
  if (n === 1) {
    const card = cards[0];
    add(HandType.SINGLE, card.rank, soloPower(card, level));
  }

  if (n === 2) {
    addSameRankVariants(cards, level, HandType.PAIR, 2, add);
  }

  if (n === 3) {
    addSameRankVariants(cards, level, HandType.TRIPLE, 3, add);
  }

  // 炸弹可和三带二等声明并存，不能因优先识别炸弹而丢掉其他解释。
  if (n >= 4 && !normals.some(isJoker)) {
    const groups = groupByRank(normals);
    if (groups.size <= 1) {
      const targetRanks = groups.size === 1 ? [...groups.keys()] : NATURAL_RANKS;
      for (const rank of targetRanks) {
        add(HandType.BOMB, rank, bombPower(n, rank, level), {
          ...(wilds.length ? { wildAs: rank } : {}),
          ...(groups.size === 0 ? { defaultInterpretation: rank === level } : {}),
        });
      }
    }
  }

  if (n === 5 && !normals.some(isJoker)) {
    const normalSuits = [...new Set(normals.map((c) => c.suit))];
    for (const sequence of STRAIGHT_SEQUENCES) {
      if (!canFormMulti(normals, wilds.length, sequence, 1)) continue;
      const high = sequenceHigh(sequence);
      const meta = { sequence: sequence.slice(), ...(wilds.length ? { wildAs: missingRanks(normals, sequence, 1) } : {}) };
      add(HandType.STRAIGHT, high, high, meta);

      if (normalSuits.length <= 1) {
        const suit = normalSuits[0] || 'H';
        add(HandType.FLUSH_STRAIGHT, high, 1500 + high, { ...meta, suit });
      }
    }

    addFullHouseVariants(cards, level, normals, wilds, add);
  }

  if (n === 6 && !normals.some(isJoker)) {
    for (const sequence of TRIPLE_PAIR_SEQUENCES) {
      if (canFormMulti(normals, wilds.length, sequence, 2)) {
        const high = sequenceHigh(sequence);
        add(HandType.TRIPLE_PAIR, high, high, {
          sequence: sequence.slice(),
          ...(wilds.length ? { wildAs: missingRanks(normals, sequence, 2) } : {}),
        });
      }
    }
    for (const sequence of PLATE_SEQUENCES) {
      if (canFormMulti(normals, wilds.length, sequence, 3)) {
        const high = sequenceHigh(sequence);
        add(HandType.PLATE, high, high, {
          sequence: sequence.slice(),
          ...(wilds.length ? { wildAs: missingRanks(normals, sequence, 3) } : {}),
        });
      }
    }
  }

  return variants.sort(compareDefaultVariants);
}

/**
 * 向后兼容的单一解析结果。默认解释确定且不受实体牌传入顺序影响。
 */
export function parseHand(cards, level) {
  return parseHandVariants(cards, level)[0] || null;
}

function compareDefaultVariants(a, b) {
  const typeDiff = (DEFAULT_TYPE_PRIORITY.get(a.type) ?? 99) - (DEFAULT_TYPE_PRIORITY.get(b.type) ?? 99);
  if (typeDiff) return typeDiff;
  const preferredDiff = Number(Boolean(b.meta?.defaultInterpretation))
    - Number(Boolean(a.meta?.defaultInterpretation));
  if (preferredDiff) return preferredDiff;
  if (a.power !== b.power) return a.power - b.power;
  if (a.mainRank !== b.mainRank) return a.mainRank - b.mainRank;
  return handSignature(a).localeCompare(handSignature(b));
}

function addSameRankVariants(cards, level, type, required, add) {
  if (cards.length !== required) return;
  const wilds = cards.filter((c) => isWild(c, level));
  const normals = cards.filter((c) => !isWild(c, level));

  if (normals.some(isJoker)) {
    if (type === HandType.PAIR
      && wilds.length === 0
      && normals.length === 2
      && normals[0].rank === normals[1].rank) {
      const rank = normals[0].rank;
      add(type, rank, rankPowerForCompare(rank, level));
    }
    return;
  }

  const groups = groupByRank(normals);
  if (groups.size > 1) return;
  const targetRanks = groups.size === 1 ? [...groups.keys()] : NATURAL_RANKS;
  for (const rank of targetRanks) {
    add(type, rank, rankPowerForCompare(rank, level), {
      ...(wilds.length ? { wildAs: rank } : {}),
      ...(groups.size === 0 ? { defaultInterpretation: rank === level } : {}),
    });
  }
}

function addFullHouseVariants(cards, level, normals, wilds, add) {
  const groups = groupByRank(normals);
  for (const tripleRank of NATURAL_RANKS) {
    for (const pairRank of NATURAL_RANKS) {
      if (tripleRank === pairRank) continue;
      let valid = true;
      for (const [rank, group] of groups) {
        const limit = rank === tripleRank ? 3 : rank === pairRank ? 2 : 0;
        if (group.length > limit) {
          valid = false;
          break;
        }
      }
      if (!valid) continue;
      const tripleHave = groups.get(tripleRank)?.length || 0;
      const pairHave = groups.get(pairRank)?.length || 0;
      if ((3 - tripleHave) + (2 - pairHave) !== wilds.length) continue;
      add(HandType.FULLHOUSE, tripleRank, rankPowerForCompare(tripleRank, level), {
        pairRank,
        ...(wilds.length ? {
          wildAs: [
            ...Array(3 - tripleHave).fill(tripleRank),
            ...Array(2 - pairHave).fill(pairRank),
          ],
        } : {}),
      });
    }
  }
}

function rankPowerForCompare(rank, level) {
  if (rank === 17) return 100;
  if (rank === 16) return 99;
  if (rank === level) return 50 + rank;
  return rank;
}

function bombPower(size, rank, level) {
  // 6+ 炸 > 同花顺(1500) > 5炸 > 4炸
  // size 6 -> 2600+, size 5 -> 1400, size 4 -> 1200
  if (size >= 6) return 2000 + size * 100 + rankPowerForCompare(rank, level);
  if (size === 5) return 1400 + rankPowerForCompare(rank, level);
  return 1200 + rankPowerForCompare(rank, level);
}

/** 连续多组，每组 needPer 张 */
function canFormMulti(normals, wildCount, seq, needPer) {
  const groups = groupByRank(normals);
  let wildLeft = wildCount;
  const usedRanks = new Set();

  for (const r of seq) {
    // r=1 表示 A
    const actualRank = r === 1 ? 14 : r;
    const have = groups.get(actualRank)?.length || 0;
    // 注意：A 只对应 rank 14，不会有 rank 1 的牌
    if (have > needPer) return false;
    const need = needPer - have;
    if (need > wildLeft) return false;
    wildLeft -= need;
    usedRanks.add(actualRank);
  }

  // 不能有多余的非序列实体牌
  for (const [r, arr] of groups) {
    if (!usedRanks.has(r)) return false;
  }
  return wildLeft === 0;
}

function sequenceHigh(sequence) {
  return sequence[sequence.length - 1];
}

function missingRanks(normals, sequence, needPer) {
  const groups = groupByRank(normals);
  const result = [];
  for (const rank of sequence) {
    const actualRank = rank === 1 ? 14 : rank;
    const missing = needPer - (groups.get(actualRank)?.length || 0);
    for (let i = 0; i < missing; i++) result.push(actualRank);
  }
  return result;
}

function groupByRank(cards) {
  const m = new Map();
  for (const c of cards) {
    if (!m.has(c.rank)) m.set(c.rank, []);
    m.get(c.rank).push(c);
  }
  return m;
}

/**
 * 比较两手牌：a 能否压 b
 * @returns {boolean}
 */
export function canBeat(a, b, level) {
  if (!a || !b) return false;

  // 天王炸最大
  if (a.type === HandType.JOKER_BOMB) return true;
  if (b.type === HandType.JOKER_BOMB) return false;

  const aBombish = a.type === HandType.BOMB || a.type === HandType.FLUSH_STRAIGHT;
  const bBombish = b.type === HandType.BOMB || b.type === HandType.FLUSH_STRAIGHT;

  if (aBombish && !bBombish) return true;
  if (!aBombish && bBombish) return false;

  if (aBombish && bBombish) {
    // 用 power 统一比较
    return a.power > b.power;
  }

  // 普通牌型必须同类型
  if (a.type !== b.type) return false;
  if (a.size !== b.size) return false;
  return a.power > b.power;
}

/**
 * 判断出牌是否可压上家（上家为 null 表示领出）。
 * declaration 可传 handSignature 字符串、牌型对象，或 { signature }。
 * 未指定声明时，跟牌会优先选择“同型且刚好能压住”的最小解释。
 */
export function isLegalPlay(cards, level, lastHand, declaration = null) {
  const variants = parseHandVariants(cards, level);
  if (variants.length === 0) return { ok: false, reason: '不是合法牌型', variants };

  let candidates = variants;
  if (declaration != null) {
    const requestedSignature = typeof declaration === 'string'
      ? declaration
      : declaration.signature || handSignature(declaration);
    candidates = variants.filter((hand) => handSignature(hand) === requestedSignature);
    if (candidates.length === 0) {
      return {
        ok: false,
        reason: '指定的牌型声明无效',
        hand: variants[0],
        variants,
      };
    }

    // 同一序列已经组成同花顺时，不允许通过手动声明降级为普通顺子。
    // 例如打2：♥2 + ♣10♣J♣Q♣A 必须按 A 高梅花同花顺结算。
    candidates = candidates.map((hand) => {
      if (hand.type !== HandType.STRAIGHT) return hand;
      return variants.find((variant) => (
        variant.type === HandType.FLUSH_STRAIGHT
        && variant.size === hand.size
        && variant.mainRank === hand.mainRank
        && (variant.meta?.sequence || []).join('-') === (hand.meta?.sequence || []).join('-')
      )) || hand;
    });
  }

  if (!lastHand) {
    return { ok: true, hand: candidates[0], variants };
  }

  const beating = candidates
    .filter((hand) => canBeat(hand, lastHand, level))
    .sort((a, b) => compareBeatingVariants(a, b, lastHand));
  if (beating.length > 0) {
    return { ok: true, hand: beating[0], variants };
  }

  const displayHand = candidates.find((hand) => (
    hand.type === lastHand.type && hand.size === lastHand.size
  )) || candidates[0];
  return { ok: false, reason: '压不过上家', hand: displayHand, variants };
}

function compareBeatingVariants(a, b, lastHand) {
  const aSameType = a.type === lastHand.type && a.size === lastHand.size ? 0 : 1;
  const bSameType = b.type === lastHand.type && b.size === lastHand.size ? 0 : 1;
  if (aSameType !== bSameType) return aSameType - bSameType;
  if (a.power !== b.power) return a.power - b.power;
  return handSignature(a).localeCompare(handSignature(b));
}

/**
 * 生成手牌所有合法出牌（用于 AI 与提示）
 * 采用启发式枚举，控制组合爆炸
 */
export function generateLegalPlays(hand, level, lastHand) {
  const plays = [];
  const seen = new Set();

  const add = (cards) => {
    if (!cards.length) return;
    const physicalKey = cards.map((c) => c.id).sort().join(',');
    for (const parsed of parseHandVariants(cards, level)) {
      if (lastHand && !canBeat(parsed, lastHand, level)) continue;
      const key = `${physicalKey}::${handSignature(parsed)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      plays.push({ cards: cards.slice(), hand: parsed, signature: handSignature(parsed) });
    }
  };

  // 领出：生成各类基础组合
  if (!lastHand) {
    generateFreePlays(hand, level, add);
    return plays;
  }

  // 接牌：同型更大，或炸弹/同花顺/天王
  generateBeatPlays(hand, level, lastHand, add);
  return plays;
}

function generateFreePlays(hand, level, add) {
  // 单张
  for (const c of hand) add([c]);

  // 按 rank 分组 + wilds
  const wilds = hand.filter((c) => isWild(c, level));
  const nonWild = hand.filter((c) => !isWild(c, level));
  const groups = groupByRank(nonWild);

  // 对子、三张、炸弹
  for (const [rank, cards] of groups) {
    for (let n = 2; n <= cards.length; n++) {
      add(cards.slice(0, n));
    }
    // 用 wild 补
    for (let w = 1; w <= wilds.length; w++) {
      for (let n = 1; n <= cards.length; n++) {
        if (n + w >= 2 && n + w <= 10) {
          add([...cards.slice(0, n), ...wilds.slice(0, w)]);
        }
      }
    }
  }
  // 纯 wild 组合
  for (let w = 1; w <= wilds.length; w++) {
    add(wilds.slice(0, w));
  }

  // 对王
  const smallJ = hand.filter((c) => c.rank === 16);
  const bigJ = hand.filter((c) => c.rank === 17);
  if (smallJ.length >= 2) add(smallJ.slice(0, 2));
  if (bigJ.length >= 2) add(bigJ.slice(0, 2));
  if (smallJ.length >= 2 && bigJ.length >= 2) {
    add([...smallJ.slice(0, 2), ...bigJ.slice(0, 2)]);
  }

  // 三带二
  generateFullHouses(hand, level, groups, wilds, add);

  // 顺子 / 同花顺
  generateStraights(hand, level, wilds, add);

  // 三连对 / 钢板
  generateTriplePairs(hand, level, wilds, add);
  generatePlates(hand, level, wilds, add);
}

function generateBeatPlays(hand, level, lastHand, add) {
  const wilds = hand.filter((c) => isWild(c, level));
  const nonWild = hand.filter((c) => !isWild(c, level));
  const groups = groupByRank(nonWild);

  // 炸弹、同花顺、天王（可压普通或更小炸弹）
  generateBombs(hand, level, groups, wilds, add);
  generateStraights(hand, level, wilds, add); // includes flush check via parse
  const smallJ = hand.filter((c) => c.rank === 16);
  const bigJ = hand.filter((c) => c.rank === 17);
  if (smallJ.length >= 2 && bigJ.length >= 2) {
    add([...smallJ.slice(0, 2), ...bigJ.slice(0, 2)]);
  }

  if (NORMAL_TYPES.has(lastHand.type)) {
    switch (lastHand.type) {
      case HandType.SINGLE:
        for (const c of hand) add([c]);
        break;
      case HandType.PAIR:
        for (const [rank, cards] of groups) {
          if (cards.length >= 2) add(cards.slice(0, 2));
          if (cards.length >= 1 && wilds.length >= 1) add([cards[0], wilds[0]]);
        }
        if (wilds.length >= 2) add(wilds.slice(0, 2));
        {
          const sj = hand.filter((c) => c.rank === 16);
          const bj = hand.filter((c) => c.rank === 17);
          if (sj.length >= 2) add(sj.slice(0, 2));
          if (bj.length >= 2) add(bj.slice(0, 2));
        }
        break;
      case HandType.TRIPLE:
        for (const [rank, cards] of groups) {
          if (cards.length >= 3) add(cards.slice(0, 3));
          if (cards.length >= 2 && wilds.length >= 1) add([...cards.slice(0, 2), wilds[0]]);
          if (cards.length >= 1 && wilds.length >= 2) add([cards[0], ...wilds.slice(0, 2)]);
        }
        break;
      case HandType.FULLHOUSE:
        generateFullHouses(hand, level, groups, wilds, add);
        break;
      case HandType.STRAIGHT:
        generateStraights(hand, level, wilds, add);
        break;
      case HandType.TRIPLE_PAIR:
        generateTriplePairs(hand, level, wilds, add);
        break;
      case HandType.PLATE:
        generatePlates(hand, level, wilds, add);
        break;
      default:
        break;
    }
  } else {
    // 上家是炸弹类，只需更大炸弹
    // already generated bombs
  }
}

function generateBombs(hand, level, groups, wilds, add) {
  for (const [rank, cards] of groups) {
    for (let n = 4; n <= cards.length; n++) {
      add(cards.slice(0, n));
    }
    for (let w = 1; w <= wilds.length; w++) {
      const total = cards.length + w;
      if (total >= 4) {
        // 取 cards 全部 + w wild，或 cards 部分
        for (let take = Math.max(1, 4 - w); take <= cards.length; take++) {
          if (take + w >= 4) add([...cards.slice(0, take), ...wilds.slice(0, w)]);
        }
      }
    }
  }
  if (wilds.length >= 4) {
    for (let w = 4; w <= wilds.length; w++) add(wilds.slice(0, w));
  }
}

function generateFullHouses(hand, level, groups, wilds, add) {
  const ranks = [...groups.keys()];
  for (let i = 0; i < ranks.length; i++) {
    for (let j = 0; j < ranks.length; j++) {
      if (i === j) continue;
      const tr = ranks[i];
      const pr = ranks[j];
      const tCards = groups.get(tr);
      const pCards = groups.get(pr);
      for (let tw = 0; tw <= wilds.length; tw++) {
        for (let pw = 0; pw <= wilds.length - tw; pw++) {
          const tc = 3 - tw;
          const pc = 2 - pw;
          if (tc < 0 || pc < 0) continue;
          if (tc > tCards.length || pc > pCards.length) continue;
          if (tc + tw !== 3 || pc + pw !== 2) continue;
          const usedWilds = wilds.slice(0, tw + pw);
          add([...tCards.slice(0, tc), ...pCards.slice(0, pc), ...usedWilds]);
        }
      }
    }
  }
  // triple + wild pair
  for (const [tr, tCards] of groups) {
    if (tCards.length >= 3 && wilds.length >= 2) {
      add([...tCards.slice(0, 3), ...wilds.slice(0, 2)]);
    }
    if (tCards.length >= 2 && wilds.length >= 3) {
      add([...tCards.slice(0, 2), ...wilds.slice(0, 3)]);
    }
  }
}

function generateStraights(hand, level, wilds, add) {
  const nonJoker = hand.filter((c) => !isJoker(c));
  const sequences = [[1, 2, 3, 4, 5]];
  for (let s = 2; s <= 10; s++) sequences.push([s, s + 1, s + 2, s + 3, s + 4]);

  for (const seq of sequences) {
    const picks = pickSequence(nonJoker, wilds, seq, 1, level);
    for (const p of picks) add(p);
  }
}

function generateTriplePairs(hand, level, wilds, add) {
  const nonJoker = hand.filter((c) => !isJoker(c) && !isWild(c, level));
  const wildList = hand.filter((c) => isWild(c, level));
  const sequences = [[1, 2, 3]];
  for (let s = 2; s <= 12; s++) {
    if (s + 2 <= 14) sequences.push([s, s + 1, s + 2]);
  }
  for (const seq of sequences) {
    const picks = pickSequence(nonJoker, wildList, seq, 2, level);
    for (const p of picks) add(p);
  }
}

function generatePlates(hand, level, wilds, add) {
  const nonJoker = hand.filter((c) => !isJoker(c) && !isWild(c, level));
  const wildList = hand.filter((c) => isWild(c, level));
  const sequences = [[1, 2]];
  for (let s = 2; s <= 13; s++) {
    if (s + 1 <= 14) sequences.push([s, s + 1]);
  }
  for (const seq of sequences) {
    const picks = pickSequence(nonJoker, wildList, seq, 3, level);
    for (const p of picks) add(p);
  }
}

/**
 * 从手牌中为序列每点取 needPer 张（可用 wild）
 * 返回最多若干种取法
 */
function pickSequence(nonWildCards, wilds, seq, needPer, level) {
  // 简化：贪心取每种 rank 的牌
  // 重新：nonWildCards 可能仍含 wild 如果传入的是 nonJoker
  const real = nonWildCards.filter((c) => !isWild(c, level));
  const g = groupByRank(real);
  let wildLeft = wilds.length;
  const chosen = [];
  const wildUsed = [];

  for (const r of seq) {
    const actual = r === 1 ? 14 : r;
    const pool = (g.get(actual) || []).slice();
    const take = Math.min(needPer, pool.length);
    chosen.push(...pool.slice(0, take));
    const need = needPer - take;
    if (need > wildLeft) return [];
    for (let i = 0; i < need; i++) {
      wildUsed.push(wilds[wilds.length - wildLeft]);
      wildLeft--;
    }
  }

  // 检查没有用到的实体牌问题：OK 我们只取需要的
  // 但同花顺需要同花：额外尝试
  const result = [[...chosen, ...wildUsed]];

  // 尝试同花：按花色筛选
  if (needPer === 1 && seq.length === 5) {
    for (const suit of ['S', 'H', 'D', 'C']) {
      const suited = real.filter((c) => c.suit === suit);
      const sg = groupByRank(suited);
      let w = wilds.length;
      const ch = [];
      const wu = [];
      let ok = true;
      for (const r of seq) {
        const actual = r === 1 ? 14 : r;
        const pool = sg.get(actual) || [];
        if (pool.length >= 1) {
          ch.push(pool[0]);
        } else if (w > 0) {
          wu.push(wilds[wilds.length - w]);
          w--;
        } else {
          ok = false;
          break;
        }
      }
      if (ok && ch.length + wu.length === 5) {
        result.push([...ch, ...wu]);
      }
    }
  }

  return result;
}

/**
 * 升级规则（头游方）：
 * - 头游 + 二游（双上）→ 升 3 级
 * - 头游 + 三游       → 升 2 级
 * - 头游 + 末游       → 升 1 级
 *
 * @param {number[]} finishOrder 出完顺序 [头游, 二游, 三游, 末游] 座位号
 * @param {(seat:number)=>number} teamOf
 * @returns {number} 升级级数 1|2|3
 */
export function calcUpgrade(finishOrder, teamOf) {
  return describeUpgrade(finishOrder, teamOf).levels;
}

/**
 * 升级详情（供界面文案使用）
 * @returns {{ levels: 1|2|3, code: 'double_up'|'head_third'|'head_last', label: string, partnerPlace: number }}
 */
export function describeUpgrade(finishOrder, teamOf) {
  const head = finishOrder[0];
  const headTeam = teamOf(head);
  // 头游方另一人（对家）的名次
  const partner = finishOrder.find((s, i) => i > 0 && teamOf(s) === headTeam);
  const partnerPlace = partner == null ? 3 : finishOrder.indexOf(partner); // 1=二游 2=三游 3=末游

  if (partnerPlace === 1) {
    return {
      levels: 3,
      code: 'double_up',
      label: '双上（头游+二游）升 3 级',
      partnerPlace,
    };
  }
  if (partnerPlace === 2) {
    return {
      levels: 2,
      code: 'head_third',
      label: '头游+三游 升 2 级',
      partnerPlace,
    };
  }
  return {
    levels: 1,
    code: 'head_last',
    label: '头游+末游 升 1 级',
    partnerPlace: 3,
  };
}

export function nextLevel(current, up) {
  const idx = LEVEL_ORDER_SAFE.indexOf(current);
  if (idx < 0) return current;
  const ni = Math.min(idx + up, LEVEL_ORDER_SAFE.length - 1);
  return LEVEL_ORDER_SAFE[ni];
}

const LEVEL_ORDER_SAFE = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

/**
 * 打 A 过关：己方必须头游，且搭档不能是末游
 * （即双上或头三可过 A；头末不过 A）
 */
export function canPassA(finishOrder, teamOf, levelTeam) {
  const head = finishOrder[0];
  if (teamOf(head) !== levelTeam) return false;
  const info = describeUpgrade(finishOrder, teamOf);
  // 升 2 或 3 级的情形（搭档非末游）可过 A
  return info.levels >= 2;
}

export function formatHand(hand) {
  if (!hand) return '';
  const name = HAND_TYPE_NAME[hand.type] || hand.type;
  if (hand.type === HandType.BOMB) return `${hand.size}炸(${RANK_LABEL[hand.mainRank] || hand.mainRank})`;
  if (hand.type === HandType.JOKER_BOMB) return '天王炸';
  if ([
    HandType.STRAIGHT,
    HandType.FLUSH_STRAIGHT,
    HandType.TRIPLE_PAIR,
    HandType.PLATE,
  ].includes(hand.type)) {
    return `${name}(${RANK_LABEL[hand.mainRank] || hand.mainRank}高)`;
  }
  if (hand.type === HandType.FULLHOUSE) {
    return `${name}(三张${RANK_LABEL[hand.mainRank] || hand.mainRank})`;
  }
  return `${name}`;
}

export { NORMAL_TYPES };
