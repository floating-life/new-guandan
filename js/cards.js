/**
 * 掼蛋 - 牌张与牌组
 * 两副牌 108 张：花色 S/H/D/C + 大小王
 */

export const SUITS = ['S', 'H', 'D', 'C']; // 黑桃 红桃 方块 梅花
export const SUIT_SYMBOL = { S: '♠', H: '♥', D: '♦', C: '♣' };
export const SUIT_COLOR = { S: 'black', H: 'red', D: 'red', C: 'black' };

/** 牌点：2-14(A) + 小王16 大王17；级牌在比较时动态提升 */
export const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
export const RANK_LABEL = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9',
  10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 16: '小王', 17: '大王',
};

export const LEVEL_ORDER = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]; // 2..A
export const LEVEL_LABEL = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9',
  10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A',
};

let _id = 0;

export function createCard(rank, suit, deckIndex = 0) {
  return {
    id: `${rank}_${suit}_${deckIndex}_${_id++}`,
    rank,   // 2-14, 16, 17
    suit,   // S H D C J
    deckIndex,
  };
}

export function isJoker(card) {
  return card.rank === 16 || card.rank === 17;
}

export function isBigJoker(card) {
  return card.rank === 17;
}

export function isSmallJoker(card) {
  return card.rank === 16;
}

/** 红桃级牌 = 逢人配 */
export function isWild(card, level) {
  return card.suit === 'H' && card.rank === level && !isJoker(card);
}

/** 是否为本局级牌（任意花色） */
export function isLevelCard(card, level) {
  return card.rank === level && !isJoker(card);
}

export function cardLabel(card) {
  if (isJoker(card)) return RANK_LABEL[card.rank];
  return `${SUIT_SYMBOL[card.suit]}${RANK_LABEL[card.rank]}`;
}

export function cardShort(card) {
  if (isJoker(card)) return card.rank === 17 ? '大王' : '小王';
  return RANK_LABEL[card.rank];
}

/**
 * 单张比较用的逻辑点数（越大越大）
 * 级牌 > A > K > ... > 2，大小王最大
 * 注意：顺子/连对/钢板中级牌按自然点位，不按「级牌威权」
 */
export function soloPower(card, level) {
  if (card.rank === 17) return 100;
  if (card.rank === 16) return 99;
  if (card.rank === level) return 50 + card.rank; // 级牌仅次于王
  // 2..A 映射到 2..14，但级牌已抽走
  return card.rank;
}

/** 自然顺序用于顺子等：A 可作 1 或 14 */
export function naturalRank(card) {
  return card.rank;
}

export function createDeck() {
  _id = 0;
  const deck = [];
  for (let d = 0; d < 2; d++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        deck.push(createCard(rank, suit, d));
      }
    }
    deck.push(createCard(16, 'J', d)); // 小王
    deck.push(createCard(17, 'J', d)); // 大王
  }
  return deck;
}

export function shuffle(deck) {
  const a = deck.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 按展示顺序排序：王 > 级牌 > A > K ... > 2；同点按花色 */
export function sortHand(cards, level) {
  const suitOrder = { J: 0, H: 1, S: 2, D: 3, C: 4 };
  return cards.slice().sort((a, b) => {
    const pa = soloPower(a, level);
    const pb = soloPower(b, level);
    if (pb !== pa) return pb - pa;
    return (suitOrder[a.suit] || 0) - (suitOrder[b.suit] || 0);
  });
}

export function removeCards(hand, cards) {
  const ids = new Set(cards.map((c) => c.id));
  return hand.filter((c) => !ids.has(c.id));
}

export function cardsByRank(cards) {
  const map = new Map();
  for (const c of cards) {
    if (!map.has(c.rank)) map.set(c.rank, []);
    map.get(c.rank).push(c);
  }
  return map;
}
