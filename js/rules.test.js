/**
 * 简单规则自检（Node: node js/rules.test.js）
 */
import { createCard } from './cards.js';
import {
  parseHand, parseHandVariants, handSignature, canBeat, HandType, isLegalPlay,
  generateLegalPlays, formatHand, calcUpgrade, describeUpgrade, nextLevel, canPassA,
} from './rules.js';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log('  ✓', msg);
  } else {
    failed++;
    console.error('  ✗', msg);
  }
}

function C(rank, suit = 'S', d = 0) {
  return createCard(rank, suit, d);
}

console.log('单张/对子/三张');
{
  const level = 2;
  const s = parseHand([C(5)], level);
  assert(s?.type === HandType.SINGLE, '单张');
  const p = parseHand([C(5, 'S'), C(5, 'H')], level);
  assert(p?.type === HandType.PAIR, '对子');
  const t = parseHand([C(8, 'S'), C(8, 'H'), C(8, 'D')], level);
  assert(t?.type === HandType.TRIPLE, '三同张');
}

console.log('逢人配对子');
{
  const level = 5;
  const wild = C(5, 'H');
  const p = parseHand([C(9, 'S'), wild], level);
  assert(p?.type === HandType.PAIR && p.mainRank === 9, '逢人配+9 = 对9');
}

console.log('炸弹与天王炸');
{
  const level = 2;
  const bomb = parseHand([C(7, 'S'), C(7, 'H'), C(7, 'D'), C(7, 'C')], level);
  assert(bomb?.type === HandType.BOMB && bomb.size === 4, '四炸');
  const jokers = parseHand([
    C(16, 'J', 0), C(16, 'J', 1), C(17, 'J', 0), C(17, 'J', 1),
  ], level);
  assert(jokers?.type === HandType.JOKER_BOMB, '天王炸');
  assert(canBeat(jokers, bomb, level), '天王炸 > 四炸');
}

console.log('顺子 A2345 / 10JQKA');
{
  const level = 7;
  // 不同花色，避免被识别为同花顺
  const low = parseHand([C(14, 'S'), C(2, 'H'), C(3, 'D'), C(4, 'C'), C(5, 'S')], level);
  assert(low?.type === HandType.STRAIGHT, 'A2345 顺子');
  const high = parseHand([C(10, 'S'), C(11, 'H'), C(12, 'D'), C(13, 'C'), C(14, 'S')], level);
  assert(high?.type === HandType.STRAIGHT, '10JQKA 顺子');
  assert(canBeat(high, low, level), '10JQKA > A2345');
}

console.log('三带二');
{
  const level = 2;
  const fh = parseHand([C(6), C(6, 'H'), C(6, 'D'), C(3), C(3, 'H')], level);
  assert(fh?.type === HandType.FULLHOUSE && fh.mainRank === 6, '三带二');
}

console.log('钢板 / 三连对');
{
  const level = 2;
  const plate = parseHand([
    C(4), C(4, 'H'), C(4, 'D'), C(5), C(5, 'H'), C(5, 'D'),
  ], level);
  assert(plate?.type === HandType.PLATE, '钢板');
  const tp = parseHand([
    C(3), C(3, 'H'), C(4), C(4, 'H'), C(5), C(5, 'H'),
  ], level);
  assert(tp?.type === HandType.TRIPLE_PAIR, '三连对');
}

console.log('同花顺压五炸');
{
  const level = 2;
  const fs = parseHand([
    C(6, 'H'), C(7, 'H'), C(8, 'H'), C(9, 'H'), C(10, 'H'),
  ], level);
  assert(fs?.type === HandType.FLUSH_STRAIGHT, '同花顺');
  const b5 = parseHand([
    C(3, 'S'), C(3, 'H'), C(3, 'D'), C(3, 'C'), C(3, 'S', 1),
  ], level);
  assert(b5?.type === HandType.BOMB && b5.size === 5, '五炸');
  assert(canBeat(fs, b5, level), '同花顺 > 五炸');
  const b6 = parseHand([
    C(4, 'S'), C(4, 'H'), C(4, 'D'), C(4, 'C'), C(4, 'S', 1), C(4, 'H', 1),
  ], level);
  assert(canBeat(b6, fs, level), '六炸 > 同花顺');
}

console.log('升级');
{
  const team = (s) => (s % 2 === 0 ? 0 : 1);
  // 0 与 2 一队；1 与 3 一队
  // 头游+二游（0,2）升 3
  assert(calcUpgrade([0, 2, 1, 3], team) === 3, '双上（头+二）升3');
  assert(describeUpgrade([0, 2, 1, 3], team).code === 'double_up', '双上 code');
  // 头游+三游（0 头，2 三）升 2
  assert(calcUpgrade([0, 1, 2, 3], team) === 2, '头三升2');
  assert(describeUpgrade([0, 1, 2, 3], team).code === 'head_third', '头三 code');
  // 头游+末游（0 头，2 末）升 1
  assert(calcUpgrade([0, 1, 3, 2], team) === 1, '头末升1');
  assert(describeUpgrade([0, 1, 3, 2], team).code === 'head_last', '头末 code');
  // 对方双上
  assert(calcUpgrade([1, 3, 0, 2], team) === 3, '对方双上升3');
  assert(nextLevel(2, 3) === 5, '2+3=5');
  assert(nextLevel(13, 3) === 14, 'K+3 封顶 A');
  assert(nextLevel(12, 3) === 14, 'Q+3 封顶 A');
  // 过 A：双上、头三可以；头末不可以
  assert(canPassA([0, 2, 1, 3], team, 0) === true, '双上可过A');
  assert(canPassA([0, 1, 2, 3], team, 0) === true, '头三可过A');
  assert(canPassA([0, 1, 3, 2], team, 0) === false, '头末不可过A');
}

console.log('合法接牌');
{
  const level = 2;
  const last = parseHand([C(5)], level);
  const ok = isLegalPlay([C(8)], level, last);
  assert(ok.ok, '单张 8 压 5');
  const no = isLegalPlay([C(8), C(8, 'H')], level, last);
  assert(!no.ok, '对子不能压单张');
}

console.log('逢人配多解顺子与自动接牌');
{
  const level = 9;
  const wild1 = C(9, 'H', 0);
  const wild2 = C(9, 'H', 1);
  const cards = [C(3, 'S'), C(4, 'H'), C(5, 'D'), wild1, wild2];
  const variants = parseHandVariants(cards, level)
    .filter((hand) => hand.type === HandType.STRAIGHT);
  assert(variants.map((hand) => hand.mainRank).join(',') === '5,6,7',
    '3/4/5+两张逢人配可声明 A2345、23456、34567');
  assert(parseHand(cards, level)?.mainRank === 5, 'parseHand 保持稳定的默认低顺解释');
  const automaticLead = isLegalPlay(cards, level, null);
  assert(automaticLead.ok && automaticLead.hand.type === HandType.STRAIGHT
    && automaticLead.hand.mainRank === 7,
  '领出多解牌且未手动声明时，自动采用可比较的最强顺子解释');

  const last = parseHand([
    C(2, 'S'), C(3, 'H'), C(4, 'D'), C(5, 'C'), C(6, 'S'),
  ], level);
  const legal = isLegalPlay(cards, level, last);
  assert(legal.ok && legal.hand.type === HandType.STRAIGHT && legal.hand.mainRank === 7,
    '跟 23456 时自动采用 34567，避免本可压却误判');

  const sixHigh = variants.find((hand) => hand.mainRank === 6);
  const specified = isLegalPlay(cards, level, null, handSignature(sixHigh));
  assert(specified.ok && specified.hand.mainRank === 6, '可用稳定签名显式选择 23456 声明');
  const specifiedObject = isLegalPlay(cards, level, null, sixHigh);
  assert(specifiedObject.ok && specifiedObject.hand.mainRank === 6, '也可用牌型对象显式选择声明');
  assert(!isLegalPlay(cards, level, null, 'straight|5|99|||x').ok,
    '拒绝不属于这组实体牌的声明签名');

  const reversed = parseHandVariants(cards.slice().reverse(), level).map(handSignature);
  assert(reversed.join(',') === parseHandVariants(cards, level).map(handSignature).join(','),
    '多解顺序不受实体牌传入顺序影响');
  assert(formatHand(legal.hand) === '顺子(7高)', '牌型文案可区分顺子的主点');
}

console.log('普通顺子/同花顺双声明');
{
  const level = 9;
  const cards = [
    C(3, 'H'), C(4, 'H'), C(5, 'H'), C(9, 'H', 0), C(9, 'H', 1),
  ];
  const variants = parseHandVariants(cards, level);
  const straights = variants.filter((hand) => hand.type === HandType.STRAIGHT);
  const flushes = variants.filter((hand) => hand.type === HandType.FLUSH_STRAIGHT);
  assert(straights.map((hand) => hand.mainRank).join(',') === '5,6,7',
    '同花实体牌仍保留三个普通顺子声明');
  assert(flushes.map((hand) => hand.mainRank).join(',') === '5,6,7',
    '同一实体牌同时保留三个同花顺声明');
  assert(new Set(variants.map(handSignature)).size === variants.length, '每种声明拥有唯一稳定签名');
  assert(parseHand(cards, level)?.type === HandType.FLUSH_STRAIGHT,
    'parseHand 默认优先同花顺，保持旧行为');
}

console.log('逢人配补同花顺花色');
{
  const level = 7;
  const cards = [C(4, 'S'), C(5, 'S'), C(6, 'S'), C(7, 'H'), C(8, 'S')];
  const variants = parseHandVariants(cards, level);
  const flush = variants.find((hand) => hand.type === HandType.FLUSH_STRAIGHT);
  assert(flush?.mainRank === 8 && flush.meta?.suit === 'S',
    '♠4♠5♠6+红桃级牌7+♠8 识别为 8 高黑桃同花顺');
  assert(parseHand(cards, level)?.type === HandType.FLUSH_STRAIGHT,
    '该组牌默认采用强于普通顺子的同花顺声明');
}

console.log('打3时红桃7不是逢人配');
{
  const level = 3;
  const blackFiveHigh = [
    C(14, 'S'), C(2, 'S'), C(3, 'S'), C(4, 'S'), C(5, 'S'),
  ];
  const mixedEightHigh = [
    C(4, 'S'), C(5, 'S'), C(6, 'S'), C(7, 'H'), C(8, 'S'),
  ];
  const lead = parseHand(blackFiveHigh, level);
  const reply = parseHand(mixedEightHigh, level);
  assert(lead?.type === HandType.FLUSH_STRAIGHT && lead.mainRank === 5,
    '打3时 ♠A♠2♠3♠4♠5 是 5 高黑桃同花顺');
  assert(reply?.type === HandType.STRAIGHT && reply.mainRank === 8,
    '打3时 ♥7 不是逢人配，♠4♠5♠6♥7♠8 只是普通顺子');
  assert(!isLegalPlay(mixedEightHigh, level, lead).ok,
    '8 高普通顺子不能压 5 高同花顺');
}

console.log('逢人配补成同花顺时禁止降级声明');
{
  const level = 2;
  const cards = [
    C(2, 'H'), C(14, 'C'), C(12, 'C'), C(11, 'C'), C(10, 'C'),
  ];
  const variants = parseHandVariants(cards, level);
  const straight = variants.find((hand) => hand.type === HandType.STRAIGHT && hand.mainRank === 14);
  const automatic = isLegalPlay(cards, level, null);
  const explicitlyWeaker = isLegalPlay(cards, level, null, handSignature(straight));
  assert(automatic.ok && automatic.hand.type === HandType.FLUSH_STRAIGHT
    && automatic.hand.mainRank === 14 && automatic.hand.meta?.suit === 'C',
  '♥2补♣K时自动判为A高梅花同花顺');
  assert(explicitlyWeaker.ok && explicitlyWeaker.hand.type === HandType.FLUSH_STRAIGHT,
    '手动选择普通顺子声明也会升级为同花顺');

  const bomb8 = parseHand([
    C(8, 'S'), C(8, 'H'), C(8, 'D'), C(8, 'C'),
  ], level);
  assert(!canBeat(bomb8, automatic.hand, level), '四炸8不能压A高同花顺');
}

console.log('打3时♥3补方块A高同花顺');
{
  const cards = [C(3, 'H'), C(14, 'D'), C(13, 'D'), C(11, 'D'), C(10, 'D')];
  const variants = parseHandVariants(cards, 3);
  const flush = variants.find((hand) => hand.type === HandType.FLUSH_STRAIGHT
    && hand.mainRank === 14 && hand.meta?.suit === 'D');
  const automatic = parseHand(cards, 3);
  const legal = isLegalPlay(cards, 3, null);
  assert(flush?.meta?.wildAs?.includes(12), '♥3补♦Q组成♦10-J-Q-K-A同花顺');
  assert(automatic?.type === HandType.FLUSH_STRAIGHT && automatic.mainRank === 14,
    '打3时自动判定为A高同花顺而不是普通顺子');
  assert(legal.ok && legal.hand.type === HandType.FLUSH_STRAIGHT,
    '同花顺声明经过出牌合法性校验仍保持');
}

console.log('三带二、三连对与钢板多解');
{
  const level = 9;
  const wild = C(9, 'H');
  const fullHouseCards = [C(6, 'S'), C(6, 'D'), C(3, 'S'), C(3, 'D'), wild];
  const fullHouses = parseHandVariants(fullHouseCards, level)
    .filter((hand) => hand.type === HandType.FULLHOUSE);
  assert(fullHouses.map((hand) => hand.mainRank).join(',') === '3,6',
    '两对加逢人配可分别声明三张3或三张6');
  assert(formatHand(fullHouses[1]) === '三带二(三张6)', '三带二文案显示三张主点');

  const twoWildCards = [
    C(3, 'S'), C(3, 'H'), C(4, 'S'), C(4, 'H'), C(9, 'H', 0), C(9, 'H', 1),
  ];
  const variants = parseHandVariants(twoWildCards, level);
  const triplePairs = variants.filter((hand) => hand.type === HandType.TRIPLE_PAIR);
  const plates = variants.filter((hand) => hand.type === HandType.PLATE);
  assert(triplePairs.map((hand) => hand.mainRank).join(',') === '4,5',
    '33/44+两张逢人配可声明 223344 或 334455');
  assert(plates.length === 1 && plates[0].mainRank === 4,
    '同一组牌还可声明 333444 钢板');
  assert(formatHand(triplePairs[1]) === '三连对(5高)' && formatHand(plates[0]) === '钢板(4高)',
    '三连对与钢板文案显示主点');
}

console.log('生成器保留同实体牌的不同声明');
{
  const level = 9;
  const straightCards = [
    C(3, 'S'), C(4, 'H'), C(5, 'D'), C(9, 'H', 0), C(9, 'H', 1),
  ];
  const straightIds = straightCards.map((c) => c.id).sort().join(',');
  const generated = generateLegalPlays(straightCards, level, null)
    .filter((play) => play.cards.map((c) => c.id).sort().join(',') === straightIds
      && play.hand.type === HandType.STRAIGHT);
  assert(generated.map((play) => play.hand.mainRank).join(',') === '5,6,7',
    '生成器不会按牌 ID 错误合并三个顺子声明');
  assert(new Set(generated.map((play) => play.signature)).size === 3,
    '生成结果附带三个不同的声明签名');

  const last = parseHand([
    C(2, 'S'), C(3, 'H'), C(4, 'D'), C(5, 'C'), C(6, 'S'),
  ], level);
  const beating = generateLegalPlays(straightCards, level, last)
    .filter((play) => play.cards.length === 5 && play.hand.type === HandType.STRAIGHT);
  assert(beating.length === 1 && beating[0].hand.mainRank === 7,
    '接牌生成器只保留能压 23456 的 34567 声明');

  const multiCards = [
    C(3, 'S'), C(3, 'H'), C(4, 'S'), C(4, 'H'), C(9, 'H', 0), C(9, 'H', 1),
  ];
  const multiIds = multiCards.map((c) => c.id).sort().join(',');
  const multiGenerated = generateLegalPlays(multiCards, level, null)
    .filter((play) => play.cards.map((c) => c.id).sort().join(',') === multiIds);
  assert(multiGenerated.filter((play) => play.hand.type === HandType.TRIPLE_PAIR).length === 2,
    '生成器保留同实体牌的两个三连对声明');
  assert(multiGenerated.filter((play) => play.hand.type === HandType.PLATE).length === 1,
    '生成器同时保留同实体牌的钢板声明');
}

console.log('纯逢人配默认兼容与最小压牌');
{
  const level = 9;
  const wildPair = [C(9, 'H', 0), C(9, 'H', 1)];
  const variants = parseHandVariants(wildPair, level);
  assert(variants.filter((hand) => hand.type === HandType.PAIR).length === 13,
    '两张逢人配可声明为任意自然点数的对子');
  assert(parseHand(wildPair, level)?.mainRank === level,
    'parseHand 对纯逢人配对子仍默认解释为级牌对子');
  const last = parseHand([C(5, 'S'), C(5, 'D')], level);
  const legal = isLegalPlay(wildPair, level, last);
  assert(legal.ok && legal.hand.mainRank === 6, '自动选择刚好压过对5的对6声明');
}

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
