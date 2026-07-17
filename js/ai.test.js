/**
 * AI / 评价系统自检（Node: node js/ai.test.js）
 */
import { performance } from 'node:perf_hooks';
import { createCard, createDeck } from './cards.js';
import { parseHand } from './rules.js';
import {
  chooseAIPlay,
  chooseReturnCard,
  getAIDifficulty,
  recommendPlay,
  setAIDifficulty,
} from './ai.js';
import { evaluatePlay, summarizeSession } from './evaluator.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log('  ✓', message);
  } else {
    failed++;
    console.error('  ✗', message);
  }
}

function C(rank, suit = 'S', deckIndex = 0) {
  return createCard(rank, suit, deckIndex);
}

const TEAMS = [0, 1, 0, 1];

function context(hand, overrides = {}) {
  return {
    seat: 0,
    hand,
    level: 2,
    lastHand: null,
    lastSeat: null,
    handCounts: [hand.length, 12, 12, 12],
    teams: TEAMS,
    finishOrder: [],
    ...overrides,
  };
}

console.log('困难前瞻与教练解释');
{
  const hand = [
    C(3, 'S'), C(3, 'H'),
    C(4, 'S'), C(4, 'H'),
    C(5, 'S'), C(5, 'H'),
    C(9, 'D'), C(10, 'C'),
  ];
  setAIDifficulty('easy');
  const recommendation = recommendPlay(context(hand));

  assert(recommendation?.action === 'play', '教练推荐保持原有 action/cards/hand 调用兼容');
  assert(typeof recommendation?.reason === 'string' && recommendation.reason.length > 0, '主推荐带简洁理由');
  assert(Array.isArray(recommendation?.alternatives) && recommendation.alternatives.length <= 3, '备选出法不超过 3 个');
  assert(recommendation.alternatives.every((item) => typeof item.reason === 'string'), '每个备选均带理由');
  assert(Number.isFinite(recommendation.projectedTricks) && recommendation.reason.includes('前瞻'), '困难前瞻产出并使用剩余手数估计');
  assert(getAIDifficulty() === 'easy', '教练推荐结束后恢复原 AI 难度');

  setAIDifficulty('normal');
  const ordinary = chooseAIPlay(context(hand));
  assert(ordinary?.action === 'play' && ordinary.cards && ordinary.hand, 'chooseAIPlay 的原有返回结构不变');

  const jokerBomb = [C(16, 'J', 0), C(16, 'J', 1), C(17, 'J', 0), C(17, 'J', 1)];
  const finishingLead = recommendPlay(context(jokerBomb));
  assert(finishingLead.cards.length === jokerBomb.length, '领出时即使是高价值天王炸也优先一手出完');
}

console.log('领出对子时惜大打小');
{
  const level = 11;
  const hand = [C(3, 'S'), C(3, 'C'), C(14, 'H'), C(14, 'C')];
  setAIDifficulty('normal');
  const decisions = Array.from({ length: 40 }, () => chooseAIPlay(context(hand, {
    level,
    handCounts: [4, 8, 8, 8],
  })));
  assert(decisions.every((decision) => decision?.hand.type === 'pair' && decision.hand.mainRank === 3),
    '同时持有33和AA时，普通AI稳定领出较小的33');

  const recommendation = recommendPlay(context(hand, {
    level,
    handCounts: [4, 8, 8, 8],
  }));
  assert(recommendation?.hand.type === 'pair' && recommendation.hand.mainRank === 3,
    '困难AI与教练建议同样保留AA控制力');
}

console.log('中盘不盲目反炸');
{
  const level = 11;
  const lastBomb = parseHand([
    C(3, 'S'), C(3, 'H'), C(3, 'D'), C(3, 'C'),
  ], level);
  const hand = [
    C(7, 'S'), C(7, 'H'), C(7, 'D'), C(7, 'C'),
    C(2, 'S'), C(4, 'S'), C(5, 'S'), C(6, 'S'),
    C(8, 'S'), C(9, 'S'), C(10, 'S'), C(12, 'S'),
    C(13, 'S'), C(14, 'S'), C(16, 'J'), C(17, 'J'),
  ];
  const preserve = recommendPlay(context(hand, {
    seat: 3,
    level,
    lastHand: lastBomb,
    lastSeat: 2,
    handCounts: [19, 10, 12, 16],
  }));
  assert(preserve?.action === 'pass',
    '自己尚有16张且对手不紧急时，不用四炸7盲目反压四炸3');

  const emergency = recommendPlay(context(hand, {
    seat: 3,
    level,
    lastHand: lastBomb,
    lastSeat: 2,
    handCounts: [4, 10, 12, 16],
  }));
  assert(emergency?.action === 'play'
    && ['bomb', 'flush_straight', 'joker_bomb'].includes(emergency.hand.type),
    '对手只剩4张时允许反炸阻断出完');
}

console.log('中后盘保留王与级牌控制');
{
  const level = 11;
  const lastAce = parseHand([C(14, 'D')], level);
  const hand = [
    C(16, 'J'), C(17, 'J'),
    C(13, 'H'), C(13, 'C'), C(2, 'H'), C(2, 'C'),
    C(9, 'D'), C(6, 'D'), C(4, 'S'),
  ];
  const preserveJoker = recommendPlay(context(hand, {
    seat: 3,
    level,
    lastHand: lastAce,
    lastSeat: 2,
    handCounts: [18, 7, 8, 9],
  }));
  assert(preserveJoker?.action === 'pass',
    '尚有9张且对手不紧急时，不用小王强压A后留下小单张');

  const lastKingPair = parseHand([C(13, 'S'), C(13, 'D')], level);
  const levelPairHand = [
    C(11, 'S'), C(11, 'D'),
    C(9, 'S'), C(9, 'D'), C(6, 'S'), C(6, 'D'),
    C(4, 'S'), C(3, 'S'), C(2, 'S'),
  ];
  const preserveLevelPair = recommendPlay(context(levelPairHand, {
    seat: 3,
    level,
    lastHand: lastKingPair,
    lastSeat: 2,
    handCounts: [16, 10, 12, 9],
  }));
  assert(preserveLevelPair?.action === 'pass',
    '中盘不使用级牌对子强接K对子');

  const emergency = recommendPlay(context(hand, {
    seat: 3,
    level,
    lastHand: lastAce,
    lastSeat: 2,
    handCounts: [4, 7, 8, 9],
  }));
  assert(emergency?.action === 'play' && emergency.hand.type === 'single',
    '对手进入4张残局时允许用王阻断');
}

console.log('结构化评价维度与错误标签');
{
  const wild = C(6, 'H');
  const hand = [wild, C(3), C(4), C(5), C(8), C(9), C(10)];
  const result = evaluatePlay({
    action: 'play',
    cards: [wild],
    handBefore: hand,
    level: 6,
    lastHand: null,
    lastSeat: null,
    seat: 0,
    teams: TEAMS,
    handCounts: [7, 12, 12, 12],
    finishOrder: [],
  });
  const expectedDimensions = ['cooperation', 'resources', 'structure', 'endgame', 'defense'];

  assert(expectedDimensions.every((key) => result.dimensions?.[key]), '评价包含配合/资源/结构/残局/防守五个维度');
  assert(Array.isArray(result.breakdown) && result.breakdown.length > 0, '评价包含可追溯的 breakdown');
  assert(result.mistakeTags.includes('waste_wild'), '逢人配浪费产生稳定 mistakeTag');
  assert(result.dimensions.resources.score < 70, '资源维度反映逢人配损耗');
}

console.log('更优参考避免拆对子');
{
  const level = 3;
  const king = C(13, 'D');
  const pairNine = [C(9, 'H'), C(9, 'S')];
  const hand = [king, ...pairNine, C(5, 'C')];
  const lastHand = parseHand([C(7, 'C')], level);
  const result = evaluatePlay({
    action: 'play',
    cards: [king],
    handBefore: hand,
    level,
    lastHand,
    lastSeat: 3,
    seat: 0,
    teams: TEAMS,
    handCounts: [4, 10, 10, 10],
    finishOrder: [],
  });
  assert(!result.betterAlternative?.cards.some((card) => card.rank === 9),
    '出单张K时不再推荐拆一对9作为更优参考');
  assert(!result.mistakeTags.includes('overpower'),
    '没有同等结构代价的更小牌时，不误判单张K用牌过大');

  const splitResult = evaluatePlay({
    action: 'play',
    cards: [pairNine[0]],
    handBefore: hand,
    level,
    lastHand,
    lastSeat: 3,
    seat: 0,
    teams: TEAMS,
    handCounts: [4, 10, 10, 10],
    finishOrder: [],
  });
  assert(splitResult.mistakeTags.includes('split_pair'),
    '确实拆对子出单张时计入结构损失');
}

console.log('领出参考不浪费两张逢人配');
{
  const level = 7;
  const singleThree = C(3, 'D');
  const wildPair = [C(7, 'H', 0), C(7, 'H', 1)];
  const hand = [
    singleThree, ...wildPair,
    C(13, 'S'), C(13, 'D'), C(9, 'S'), C(9, 'D'), C(17, 'J'),
  ];
  const result = evaluatePlay({
    action: 'play',
    cards: [singleThree],
    handBefore: hand,
    level,
    lastHand: null,
    lastSeat: null,
    seat: 0,
    teams: TEAMS,
    handCounts: [8, 12, 12, 12],
    finishOrder: [],
  });
  assert(result.score >= 70 && result.stars >= 3,
    '独立小单张3领出不因两张逢人配被误扣至一星');
  assert(!result.betterAlternative?.cards.some((card) => card.suit === 'H' && card.rank === level),
    '更优参考不再推荐把两张逢人配当普通对子打出');
  assert(!result.mistakeTags.includes('inefficient_lead'),
    '没有安全小组合时不误标低效领出');
}

console.log('压对家时不推荐拆三张成对子');
{
  const level = 7;
  const pairNine = [C(9, 'H'), C(9, 'D')];
  const tripleSix = [C(6, 'S'), C(6, 'H'), C(6, 'D')];
  const hand = [...pairNine, ...tripleSix, C(3, 'C')];
  const teammatePair = parseHand([C(4, 'H'), C(4, 'C')], level);
  const result = evaluatePlay({
    action: 'play',
    cards: pairNine,
    handBefore: hand,
    level,
    lastHand: teammatePair,
    lastSeat: 2,
    seat: 0,
    teams: TEAMS,
    handCounts: [6, 12, 12, 12],
    finishOrder: [],
  });
  assert(result.mistakeTags.includes('over_teammate'),
    '出99压对家的44仍正确识别为配合问题');
  assert(!result.mistakeTags.includes('overpower'),
    '压对家时不再额外评价应改用更小对子');
  assert(!result.betterAlternative?.cards.some((card) => card.rank === 6),
    '更优参考不再推荐从三个6中拆出66');

  const splitPair = evaluatePlay({
    action: 'play',
    cards: tripleSix.slice(0, 2),
    handBefore: hand,
    level,
    lastHand: parseHand([C(4, 'S'), C(4, 'D')], level),
    lastSeat: 1,
    seat: 0,
    teams: TEAMS,
    handCounts: [6, 12, 12, 12],
    finishOrder: [],
  });
  assert(splitPair.mistakeTags.includes('split_group'),
    '确实从三张6中拆出66时计入结构损失');
}

console.log('更优参考保护唯一顺子关键牌');
{
  const level = 2;
  const seven = C(7, 'S');
  const eights = [C(8, 'H'), C(8, 'D'), C(8, 'C')];
  const nine = C(9, 'S');
  const ten = C(10, 'D');
  const jacks = [C(11, 'S'), C(11, 'D')];
  const hand = [seven, ...eights, nine, ten, ...jacks];
  const result = evaluatePlay({
    action: 'play',
    cards: [jacks[0]],
    handBefore: hand,
    level,
    lastHand: parseHand([C(4, 'C')], level),
    lastSeat: 3,
    seat: 0,
    teams: TEAMS,
    handCounts: [8, 12, 12, 12],
    finishOrder: [],
  });
  assert(!result.betterAlternative?.cards.some((card) => card.rank === 7),
    '出一张J后仍保留另一张J时，不再推荐打掉顺子唯一的7');
  assert(result.betterAlternative?.cards.every((card) => card.rank === 8),
    '更小参考改为从三张8中出一张，仍保留一对8和完整顺子');

  const broken = evaluatePlay({
    action: 'play',
    cards: [seven],
    handBefore: hand,
    level,
    lastHand: parseHand([C(4, 'C')], level),
    lastSeat: 3,
    seat: 0,
    teams: TEAMS,
    handCounts: [8, 12, 12, 12],
    finishOrder: [],
  });
  assert(broken.mistakeTags.includes('split_straight'),
    '真正打掉唯一7时识别为破坏顺子结构');
}

console.log('一手出完压队友不误扣配合分');
{
  const level = 2;
  const lastHand = parseHand([C(5)], level);
  const card = C(6);
  const result = evaluatePlay({
    action: 'play',
    cards: [card],
    handBefore: [card],
    level,
    lastHand,
    lastSeat: 2,
    seat: 0,
    teams: TEAMS,
    handCounts: [1, 8, 8, 8],
    finishOrder: [],
  });

  assert(!result.mistakeTags.includes('over_teammate'), '一手出完不标记为压队友失误');
  assert(!result.tips.some((tip) => tip.includes('压了队友的牌')), '一手出完不出现固定压队友扣分文案');
  assert(result.dimensions.cooperation.delta === 0 && result.dimensions.endgame.delta > 0, '评价归入残局收益而非配合惩罚');

  const bomb = [C(7, 'S'), C(7, 'H'), C(7, 'D'), C(7, 'C')];
  const bombFinish = evaluatePlay({
    action: 'play',
    cards: bomb,
    handBefore: bomb,
    level,
    lastHand,
    lastSeat: 2,
    seat: 0,
    teams: TEAMS,
    handCounts: [4, 8, 8, 8],
    finishOrder: [],
  });
  assert(!bombFinish.mistakeTags.includes('waste_bomb'), '以炸弹一手出完也不会被资源规则反向扣分');
}

console.log('对家控牌时保留整手同花顺的过牌评价');
{
  const level = 3;
  const hand = [
    C(6, 'S'), C(7, 'S'), C(8, 'S'), C(9, 'S'), C(10, 'S'),
  ];
  const teammateLead = parseHand([
    C(14, 'D'), C(2, 'D'), C(3, 'D'), C(4, 'D'), C(5, 'C'),
  ], level);
  const result = evaluatePlay({
    action: 'pass',
    cards: [],
    handBefore: hand,
    level,
    lastHand: teammateLead,
    lastSeat: 2,
    seat: 0,
    teams: TEAMS,
    handCounts: [5, 7, 9, 8],
    finishOrder: [],
  });
  assert(result.score >= 85 && result.stars >= 4,
    '对家控牌时保留一手同花顺不再被评为待改进');
  assert(!result.mistakeTags.includes('missed_finish'),
    '诱敌并准备接风不误标为错失出完');
  assert(result.tips.some((tip) => tip.includes('接风') && tip.includes('反压')),
    '评价解释反压与对家接风的战术价值');
}

console.log('整手同花顺放过普通牌等待诱炸');
{
  const level = 2;
  const flushFinish = [
    C(14, 'S'), C(5, 'S'), C(4, 'S'), C(3, 'S'), C(2, 'S'),
  ];
  const result = evaluatePlay({
    action: 'pass',
    cards: [],
    handBefore: flushFinish,
    level,
    lastHand: parseHand([C(10, 'D')], level),
    lastSeat: 3,
    seat: 0,
    teams: TEAMS,
    handCounts: [5, 9, 8, 10],
    finishOrder: [],
  });
  assert(result.score >= 80 && result.stars >= 4,
    '剩五张同花顺时放过普通单张不再被评为25分');
  assert(!result.mistakeTags.includes('missed_finish'),
    '保留整手同花顺诱炸不误标为错失出完');
  assert(result.tips.some((tip) => tip.includes('诱炸') && tip.includes('反制')),
    '评价解释等待对手交炸后反制的战术目的');

  const urgent = evaluatePlay({
    action: 'pass',
    cards: [],
    handBefore: flushFinish,
    level,
    lastHand: parseHand([C(10, 'D')], level),
    lastSeat: 3,
    seat: 0,
    teams: TEAMS,
    handCounts: [5, 2, 8, 10],
    finishOrder: [],
  });
  assert(urgent.mistakeTags.includes('missed_finish') && urgent.score < 50,
    '对手只剩两张时仍应立即用同花顺出完');
}

console.log('残局炸弹领出文案一致');
{
  const bomb = [C(7, 'S'), C(7, 'H'), C(7, 'D'), C(7, 'C')];
  const closing = evaluatePlay({
    action: 'play',
    cards: bomb,
    handBefore: bomb,
    level: 2,
    lastHand: null,
    lastSeat: null,
    seat: 0,
    teams: TEAMS,
    handCounts: [4, 4, 4, 4],
    finishOrder: [],
  });

  assert(!closing.mistakeTags.includes('waste_bomb'), '直接出完的领炸不标记为浪费炸弹');
  assert(closing.tips.some((tip) => tip.includes('收官')) && !closing.tips.some((tip) => tip.includes('通常不利')), '残局领炸只给出一致的正向收官文案');

  const middleHand = [...bomb, C(3), C(9), C(11)];
  const middle = evaluatePlay({
    action: 'play',
    cards: bomb,
    handBefore: middleHand,
    level: 2,
    lastHand: null,
    lastSeat: null,
    seat: 0,
    teams: TEAMS,
    handCounts: [7, 12, 12, 12],
    finishOrder: [],
  });
  assert(middle.mistakeTags.includes('waste_bomb'), '非残局无故领炸仍会被识别');
}

console.log('AI 对同组实体牌采用更强声明');
{
  const level = 7;
  const lastHand = parseHand([
    C(14, 'S'), C(2, 'S'), C(3, 'S'), C(4, 'S'), C(5, 'S'),
  ], level);
  const hand = [C(4, 'S'), C(5, 'S'), C(6, 'S'), C(7, 'H'), C(8, 'S')];
  setAIDifficulty('normal');
  const decision = chooseAIPlay(context(hand, {
    level,
    lastHand,
    lastSeat: 1,
    handCounts: [5, 8, 8, 8],
  }));
  assert(decision?.action === 'play' && decision.hand.type === 'flush_straight',
    '♠4♠5♠6+红桃级牌7+♠8 对顺子时声明为同花顺');
  assert(decision?.hand.mainRank === 8 && decision.hand.meta?.suit === 'S',
    'AI 记录为 8 高黑桃同花顺，而不是普通顺子');
}

console.log('打3时同花顺声明与后手限制');
{
  const level = 3;
  const flushCards = [
    C(14, 'S'), C(2, 'S'), C(3, 'S'), C(4, 'S'), C(5, 'S'),
  ];
  setAIDifficulty('normal');
  const leadDecision = chooseAIPlay(context(flushCards, {
    level,
    handCounts: [5, 8, 8, 8],
  }));
  assert(leadDecision?.hand.type === 'flush_straight' && leadDecision.hand.mainRank === 5,
    'AI 将 ♠A♠2♠3♠4♠5 声明为 5 高黑桃同花顺');

  const mixedReply = [
    C(4, 'S'), C(5, 'S'), C(6, 'S'), C(7, 'H'), C(8, 'S'),
  ];
  const replyDecision = chooseAIPlay(context(mixedReply, {
    level,
    lastHand: leadDecision.hand,
    lastSeat: 1,
    handCounts: [5, 8, 8, 8],
  }));
  assert(replyDecision?.action === 'pass',
    '打3时混花 8 高顺子无法接 5 高黑桃同花顺，AI 必须过牌');
}

console.log('局后总结使用结构化错误标签');
{
  const bombA = [C(8, 'S'), C(8, 'H'), C(8, 'D'), C(8, 'C')];
  const good = evaluatePlay({
    action: 'play',
    cards: bombA,
    handBefore: bombA,
    level: 2,
    lastHand: null,
    lastSeat: null,
    seat: 0,
    teams: TEAMS,
    handCounts: [4, 8, 8, 8],
    finishOrder: [],
  });
  const summary = summarizeSession([good, good]);
  assert(!summary.advice.some((item) => item.includes('炸弹使用偏随意')), '正向炸弹文案不会被误统计为炸弹失误');
  assert(summary.dimensionAverages?.endgame && summary.mistakeCounts, '局后总结包含维度均值与错误计数');
}

console.log('口诀残局路线按对手余牌数触发');
{
  const routeHand = [
    C(3, 'S'), C(3, 'H'),
    C(4, 'S'), C(4, 'H'), C(4, 'D'),
    C(6), C(7), C(8), C(9), C(10), C(12), C(13),
  ];
  const expected = new Map([
    [5, ['pair']],
    [6, ['triple']],
    [7, ['straight', 'fullhouse']],
    [8, ['straight', 'fullhouse']],
    [9, ['single']],
    [10, ['pair']],
  ]);
  for (const [enemyCount, types] of expected) {
    const decision = recommendPlay(context(routeHand, {
      handCounts: [routeHand.length, enemyCount, 12, enemyCount + 1],
    }));
    assert(types.includes(decision?.hand.type),
      `对手剩${enemyCount}张时优先选择口诀对应牌型`);
    assert(decision?.reason?.includes(`剩${enemyCount}张`),
      `对手剩${enemyCount}张时解释触发的控牌战术`);
  }
}

console.log('单贡返牌按对象选择');
{
  const hand = [C(3), C(6, 'S'), C(6, 'H'), C(10, 'S'), C(10, 'H')];
  const toPartner = chooseReturnCard(hand.slice(), 2, { toPartner: true });
  const toOpponent = chooseReturnCard(hand.slice(), 2, { toPartner: false });
  assert(toPartner.rank === 3, '返给对家时优先5以下的小单张');
  assert(toOpponent.rank === 10, '返给对手时优先5以上、来自组合的大牌');
}

console.log('顶住上家与已出控制牌记忆');
{
  const level = 7;
  const last = parseHand([C(9, 'C')], level);
  const hand = [C(10, 'S'), C(11, 'S'), C(12, 'S'), C(13, 'S')];
  const blocking = recommendPlay(context(hand, {
    seat: 0,
    level,
    lastHand: last,
    lastSeat: 3,
    handCounts: [4, 12, 12, 6],
  }));
  assert(blocking?.action === 'play' && blocking.reason.includes('顶住上家'),
    '上家进入6张残局时用安全牌顶住，不随意放其连控');

  const seenControls = [
    C(16, 'J', 0), C(16, 'J', 1), C(17, 'J', 0), C(17, 'J', 1),
    C(7, 'S', 0), C(7, 'H', 0), C(7, 'D', 0), C(7, 'C', 0),
    C(14, 'S', 0), C(14, 'H', 0), C(14, 'D', 0), C(14, 'C', 0),
    C(13, 'S', 0), C(13, 'H', 0), C(13, 'D', 0), C(13, 'C', 0),
  ];
  const controlHand = [C(13, 'S', 1), C(13, 'H', 1), C(14, 'S', 1), C(14, 'H', 1)];
  const counted = recommendPlay(context(controlHand, {
    level,
    playedCards: seenControls,
  }));
  assert(counted?.reason?.includes('大牌已现'),
    '多数王、级牌和A/K已出现后，电脑会提高现有控制牌的可信度');
}

console.log('炸弹必须带有明确的收官或护送目的');
{
  const level = 2;
  const bomb = [C(8, 'S'), C(8, 'H'), C(8, 'D'), C(8, 'C')];
  const triplePair = [
    C(3, 'S'), C(3, 'H'), C(4, 'S'), C(4, 'H'), C(5, 'S'), C(5, 'H'),
  ];
  const twoStep = recommendPlay(context([...bomb, ...triplePair], {
    level,
    lastHand: parseHand([C(13, 'S'), C(13, 'H')], level),
    lastSeat: 1,
    handCounts: [10, 12, 12, 12],
  }));
  assert(twoStep?.action === 'play' && ['bomb', 'flush_straight'].includes(twoStep.hand.type),
    '炸后剩余牌可一手走完时立即炸开，不把炸弹留死');

  const escortHand = [...bomb, C(3), C(6), C(9), C(11), C(12), C(13), C(14)];
  const escort = recommendPlay(context(escortHand, {
    level,
    lastHand: parseHand([C(6, 'S'), C(7, 'H'), C(8, 'D', 1), C(9, 'C'), C(10, 'S')], level),
    lastSeat: 1,
    handCounts: [escortHand.length, 9, 2, 10],
  }));
  assert(escort?.action === 'play' && ['bomb', 'flush_straight'].includes(escort.hand.type),
    '对家只剩两张且对手控圈时允许炸开护送对家');
}

console.log('同花顺夺权后接一手收尾的两步路线');
{
  const level = 14;
  const flush = [C(14, 'H'), C(7, 'S'), C(5, 'S'), C(4, 'S'), C(3, 'S')];
  const kings = [C(13, 'H'), C(13, 'S'), C(13, 'D')];
  const lastFullHouse = parseHand([
    C(5, 'H', 1), C(5, 'D', 1), C(5, 'C', 1), C(10, 'D'), C(10, 'C'),
  ], level);
  const result = evaluatePlay({
    action: 'play',
    cards: flush,
    handBefore: [...flush, ...kings],
    playedHand: parseHand(flush, level),
    level,
    lastHand: lastFullHouse,
    lastSeat: 3,
    seat: 0,
    teams: TEAMS,
    handCounts: [8, 9, 8, 8],
    finishOrder: [],
  });
  assert(result.score >= 85 && result.stars >= 4,
    '同花顺夺权后剩KKK可领出收完，应评价为优秀的两手收官');
  assert(!result.betterAlternative,
    '不再错误推荐KKK加两张组成三带二后留下四张散牌');
  assert(result.tips.some((tip) => tip.includes('两手收官')),
    '评价明确说明同花顺夺权再以三张K收尾的路线');

  const unifiedCoach = recommendPlay(context([...flush, ...kings], {
    level,
    lastHand: lastFullHouse,
    lastSeat: 3,
    handCounts: [8, 9, 8, 8],
  }));
  assert(unifiedCoach?.hand.type === 'flush_straight'
    && unifiedCoach.reason.includes('一手收完'),
  '共享策略核心让AI与评价同时认可同花顺夺权的两手收官');

  const finish = recommendPlay(context(kings, { level, handCounts: [3, 9, 8, 8] }));
  assert(finish?.cards.length === 3 && finish.hand.type === 'triple',
    '夺权成功后教练继续建议三个K一手出完');
}

console.log('中盘惜炸、炸后放单与对子保护');
{
  const level = 2;
  const bombQ = [C(12, 'S'), C(12, 'H'), C(12, 'D'), C(12, 'C')];
  const middleHand = [
    ...bombQ,
    C(8, 'S'), C(8, 'H'), C(8, 'D'),
    C(9, 'S'), C(9, 'H'), C(9, 'D'),
    C(6, 'S'), C(6, 'H'), C(10), C(11),
  ];
  const preserve = recommendPlay(context(middleHand, {
    level,
    lastHand: parseHand([C(17, 'J')], level),
    lastSeat: 3,
    handCounts: [middleHand.length, 11, 10, 12],
  }));
  assert(preserve?.action === 'pass',
    '对手中盘出大王时不再仅因牌点高就交掉四炸Q');

  const afterBombHand = [
    C(8, 'S'), C(8, 'H'), C(8, 'D'),
    C(9, 'S'), C(9, 'H'), C(9, 'D'),
    C(6, 'S'), C(6, 'H'), C(10), C(11),
  ];
  const unload = recommendPlay(context(afterBombHand, {
    level,
    handCounts: [afterBombHand.length, 12, 11, 13],
    leadAfterOwnBomb: true,
  }));
  assert(unload?.hand.type === 'single' && unload.cards[0].rank === 10,
    '炸弹收圈后先放较小独立单张，不先清空三张和对子');
  assert(unload?.reason.includes('炸弹夺权后'),
    '教练解释炸后放单、保留组合继续控制的目的');

  const pairTens = [C(10, 'S'), C(10, 'D')];
  const protectPair = recommendPlay(context([
    ...pairTens, C(11, 'C'), C(6, 'S'), C(6, 'H'), C(7, 'S'), C(7, 'H'),
  ], {
    level,
    lastHand: parseHand([C(8, 'C')], level),
    lastSeat: 3,
    handCounts: [7, 10, 9, 11],
  }));
  assert(protectPair?.action === 'play' && protectPair.cards[0].rank === 11,
    '接单张时宁用独立J，也不拆一对10留下两张散牌');
}

console.log('困难模式耗时基准');
{
  const deck = createDeck();
  const hands = [0, 1, 2, 3].map((seat) => deck.filter((_, index) => index % 4 === seat).slice(0, 27));
  const times = [];
  for (let i = 0; i < 4; i++) {
    const started = performance.now();
    const result = recommendPlay(context(hands[i], {
      seat: i,
      level: 7,
      handCounts: [27, 27, 27, 27],
    }));
    times.push(performance.now() - started);
    assert(!!result, `27 张手牌样本 ${i + 1} 能正常给出建议`);
  }
  const average = times.reduce((sum, value) => sum + value, 0) / times.length;
  const maximum = Math.max(...times);
  console.log(`  基准：平均 ${average.toFixed(2)}ms，最慢 ${maximum.toFixed(2)}ms`);
  assert(maximum < 1000, '有界前瞻在宽松的 1 秒上限内完成');
}

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
