/**
 * AI / 评价系统自检（Node: node js/ai.test.js）
 */
import { performance } from 'node:perf_hooks';
import { createCard, createDeck, soloPower } from './cards.js';
import {
  generateLegalPlays, handSignature, isLegalPlay, parseHand, parseHandVariants,
} from './rules.js';
import {
  chooseAIPlay,
  chooseReturnCard,
  calibratePolicyFusionValues,
  getAIConsultation,
  getAIDifficulty,
  recommendPlay,
  resolvePolicyFeatures,
  resolvePolicyVariant,
  resolveHybridSearchConfig,
  setAIDifficulty,
} from './ai.js';
import { evaluatePlay, summarizeSession } from './evaluator.js';
import { evaluateStrategicPlay } from './strategy-core.js';
import {
  estimateThreeStepRoute, inferPublicThreats, publicCoordinationScore,
  inferRemainingPool, createBeatModel, createUnconditionedBeatModel,
  enemyBeatProbability, hypergeomAtLeast,
  controlEV, bombNetGain, enemyBombExposureProbability,
  orderedTeamControlLossProbability, evaluatePublicResponseTree,
  evaluatePublicEndgameRollout, publicPartnerProtectionValue,
} from './ai-route.js';
import { applySearchTimeBudget } from './ai.js';

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

console.log('接牌时一手出完优先于惜炸');
{
  const level = 2;
  const bomb = [C(8, 'S'), C(8, 'H'), C(8, 'D'), C(8, 'C')];
  const lastHand = parseHand([C(7, 'S', 1)], level);
  setAIDifficulty('normal');
  const decisions = Array.from({ length: 20 }, () => chooseAIPlay(context(bomb, {
    level,
    lastHand,
    lastSeat: 3,
    handCounts: [4, 9, 8, 10],
  })));
  assert(decisions.every((decision) => decision?.action === 'play'
    && decision.cards.length === bomb.length
    && decision.hand.type === 'bomb'),
  '整手四炸可以接牌时始终整手出完，不再因惜炸拆单或拆对');
}

console.log('下家残局时允许抬高对家的牌');
{
  const level = 2;
  const hand = [C(7, 'S'), C(11, 'D')];
  setAIDifficulty('hard');
  const block = recommendPlay(context(hand, {
    level,
    lastHand: parseHand([C(6, 'C')], level),
    lastSeat: 2,
    handCounts: [2, 1, 7, 8],
  }));
  assert(block?.action === 'play' && block.hand.type === 'single',
    '对家领单且下家只剩一张时必须接牌拦截，不能机械让牌');
  assert(block.cards[0].rank === 11,
    '紧急拦截优先用更高的J提高成功率，不再只出刚好能压住的7');
  assert(block.reason.includes('下家只剩'), '教练解释明确标注残局拦截原因');

  const played = evaluatePlay({
    action: 'play',
    cards: block.cards,
    handBefore: hand,
    playedHand: block.hand,
    level,
    lastHand: parseHand([C(6, 'C')], level),
    lastSeat: 2,
    seat: 0,
    teams: TEAMS,
    handCounts: [2, 1, 7, 8],
    finishOrder: [],
  });
  assert(!played.mistakeTags.includes('over_teammate') && played.score >= 70,
    '统一评价认可紧急抬高队友牌，不再标记为压队友失误');

  const passed = evaluatePlay({
    action: 'pass',
    cards: [],
    handBefore: hand,
    level,
    lastHand: parseHand([C(6, 'C')], level),
    lastSeat: 2,
    seat: 0,
    teams: TEAMS,
    handCounts: [2, 1, 7, 8],
    finishOrder: [],
  });
  assert(passed.score <= 30 && passed.betterAlternative?.cards?.[0]?.rank === 11,
    '下家可能立即走完时，评价不再给机械让牌85分，并推荐高牌拦截');

  const preservePair = recommendPlay(context([
    C(11), C(12, 'S'), C(12, 'H'),
  ], {
    level,
    lastHand: parseHand([C(6, 'C')], level),
    lastSeat: 2,
    handCounts: [3, 1, 7, 8],
  }));
  assert(preservePair?.cards[0]?.rank === 11,
    '紧急拦截先用独立J，不为追求更高点数拆开一对Q');

  const bomb = [C(8, 'S'), C(8, 'H'), C(8, 'D'), C(8, 'C')];
  const guaranteedBlock = recommendPlay(context([C(11), ...bomb], {
    level,
    lastHand: parseHand([C(6, 'C')], level),
    lastSeat: 2,
    handCounts: [5, 1, 7, 8],
  }));
  assert(guaranteedBlock?.hand.type === 'bomb',
    '下家只剩一张且普通J不能保证拦住时，及时用最小炸弹完成确定阻断');
}

console.log('下家可能整手走完时扩大拦截牌型');
{
  const level = 2;
  const tripleBlock = recommendPlay(context([
    C(6, 'S'), C(6, 'H'), C(6, 'D'), C(11),
  ], {
    level,
    lastHand: parseHand([C(5, 'S'), C(5, 'H'), C(5, 'D')], level),
    lastSeat: 2,
    handCounts: [4, 3, 8, 7],
  }));
  assert(tripleBlock?.action === 'play'
    && tripleBlock.hand.type === 'triple'
    && tripleBlock.cards.length === 3,
  '对家领三张且下家正好剩三张时，必须抬高阻止其一手走完');

  const fullHouseBlock = recommendPlay(context([
    C(7, 'S'), C(7, 'H'), C(7, 'D'), C(9, 'S'), C(9, 'H'), C(12),
  ], {
    level,
    lastHand: parseHand([
      C(6, 'S'), C(6, 'H'), C(6, 'D'), C(8, 'S'), C(8, 'H'),
    ], level),
    lastSeat: 2,
    handCounts: [6, 5, 8, 7],
  }));
  assert(fullHouseBlock?.action === 'play'
    && fullHouseBlock.hand.type === 'fullhouse'
    && fullHouseBlock.cards.length === 5,
  '对家领三带二且下家正好剩五张时，必须扩大到五张牌型拦截');

  const bomb7 = [C(7, 'S'), C(7, 'H'), C(7, 'D'), C(7, 'C')];
  const bomb9 = [C(9, 'S'), C(9, 'H'), C(9, 'D'), C(9, 'C')];
  const protectBombs = recommendPlay(context([...bomb7, ...bomb9], {
    level,
    lastHand: parseHand([
      C(6, 'S'), C(6, 'H'), C(6, 'D'), C(8, 'S'), C(8, 'H'),
    ], level),
    lastSeat: 2,
    handCounts: [8, 5, 8, 7],
  }));
  assert(protectBombs?.hand.type === 'bomb'
    && protectBombs.cards.every((card) => card.rank === 7),
  '紧急五张拦截不从7777和9999拼三带二，改用最小四炸7并保留四炸9');

  const brokenCards = [
    bomb9[0], bomb9[1], bomb9[2], bomb7[0], bomb7[1],
  ];
  const brokenBombs = evaluatePlay({
    action: 'play',
    cards: brokenCards,
    handBefore: [...bomb7, ...bomb9],
    playedHand: parseHand(brokenCards, level),
    level,
    lastHand: parseHand([
      C(6, 'S'), C(6, 'H'), C(6, 'D'), C(8, 'S'), C(8, 'H'),
    ], level),
    lastSeat: 2,
    seat: 0,
    teams: TEAMS,
    handCounts: [8, 5, 8, 7],
    finishOrder: [],
  });
  assert(brokenBombs.mistakeTags.includes('split_bomb'),
    '评价系统同步识别三带二同时拆掉两个炸弹');

  const triple7 = [C(7, 'S'), C(7, 'D'), C(7, 'C')];
  const triple9 = [C(9, 'S'), C(9, 'D'), C(9, 'C')];
  const wilds = [C(2, 'H', 0), C(2, 'H', 1)];
  const protectWildBombs = recommendPlay(context([
    ...triple7, ...triple9, ...wilds,
  ], {
    level,
    lastHand: parseHand([
      C(6, 'S'), C(6, 'H'), C(6, 'D'), C(8, 'S'), C(8, 'H'),
    ], level),
    lastSeat: 2,
    handCounts: [8, 5, 8, 7],
  }));
  assert(protectWildBombs?.hand.type === 'bomb'
    && protectWildBombs.hand.mainRank === 7,
  '777+999+两张逢人配按两组潜在炸弹保护，使用最低四炸7阻断');
}

console.log('对家已出完后不再误触发炸弹护送');
{
  const level = 2;
  const bomb = [C(8, 'S'), C(8, 'H'), C(8, 'D'), C(8, 'C')];
  const hand = [...bomb, C(3), C(4), C(5), C(6), C(7), C(9), C(10), C(11)];
  const decision = recommendPlay(context(hand, {
    level,
    lastHand: parseHand([C(13, 'S'), C(13, 'H')], level),
    lastSeat: 1,
    handCounts: [hand.length, 10, 0, 11],
    finishOrder: [2],
  }));
  assert(decision?.action === 'pass',
    '对家已经出完时不再把0张误判为需要炸弹护送的残局');
}

console.log('已出完的对手不再以0张触发炸弹紧急拦截');
{
  const level = 2;
  const bomb = [C(7, 'S'), C(7, 'H'), C(7, 'D'), C(7, 'C')];
  const hand = [...bomb, C(3), C(4), C(5), C(6), C(8), C(9), C(10), C(11), C(12)];
  const decision = recommendPlay(context(hand, {
    level,
    lastHand: parseHand([C(17, 'J')], level),
    lastSeat: 3,
    handCounts: [hand.length, 0, 12, 20],
    finishOrder: [1],
    difficulty: 'master',
    deterministic: true,
  }));
  assert(decision?.action === 'pass',
    '一名对手已经出完且另一名仍有20张时，不因已完成者的0张误交唯一炸弹');
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
  assert(result.score >= 60 && result.stars >= 3,
    '独立小单张3领出不因两张逢人配被误扣至一星');
  assert(!result.betterAlternative?.cards.some((card) => card.suit === 'H' && card.rank === level),
    '更优参考不再推荐把两张逢人配当普通对子打出');
  assert(result.betterAlternative?.hand.type === 'pair'
    && result.betterAlternative.cards.every((card) => card.rank === 9),
  '有限分配逢人配后，对9可安全走牌并保留对K加两配的唯一潜在炸弹');
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

console.log('完整顺子出牌不再误判为拆顺子');
{
  const level = 2;
  const straight = [C(3, 'S'), C(4, 'H'), C(5, 'D'), C(6, 'C'), C(7, 'S')];
  const straightResult = evaluatePlay({
    action: 'play',
    cards: straight,
    handBefore: straight,
    playedHand: parseHand(straight, level),
    level,
    lastHand: null,
    lastSeat: null,
    seat: 0,
    teams: TEAMS,
    handCounts: [5, 8, 8, 8],
    finishOrder: [],
  });
  assert(!straightResult.mistakeTags.includes('split_straight'),
    '整手顺子正常出完不标记为拆顺子');
  assert(!straightResult.tips.some((tip) => tip.includes('破坏已存在顺子')),
    '整手顺子不显示错误的结构破坏提示');

  const flushStraight = [
    C(3, 'S'), C(4, 'S'), C(5, 'S'), C(6, 'S'), C(7, 'S'),
  ];
  const flushResult = evaluatePlay({
    action: 'play',
    cards: flushStraight,
    handBefore: [...flushStraight, C(9)],
    playedHand: parseHand(flushStraight, level),
    level,
    lastHand: null,
    lastSeat: null,
    seat: 0,
    teams: TEAMS,
    handCounts: [6, 9, 8, 9],
    finishOrder: [],
  });
  assert(!flushResult.mistakeTags.includes('split_straight'),
    '同花顺作为完整组合打出也不标记为拆顺子');
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

console.log('残局张数口诀作为可被牌面覆盖的软参考');
{
  const routeHand = [
    C(3, 'S'), C(3, 'H'),
    C(4, 'S'), C(4, 'H'), C(4, 'D'),
    C(6, 'S'), C(7, 'H'), C(8, 'D'), C(9, 'C'), C(10, 'S'), C(12), C(13),
  ];
  const expected = new Map([
    [5, routeHand.slice(0, 2)],
    [6, routeHand.slice(2, 5)],
    [7, routeHand.slice(5, 10)],
    [8, routeHand.slice(5, 10)],
    [9, [routeHand[10]]],
    [10, routeHand.slice(0, 2)],
  ]);
  for (const [enemyCount, cards] of expected) {
    const hand = parseHand(cards, 2);
    const strategy = evaluateStrategicPlay({ cards, hand }, context(routeHand, {
      mode: 'lead',
      handCounts: [routeHand.length, enemyCount, 12, enemyCount + 1],
      policyProfile: 'expert',
      strategyWeight: 1,
    }));
    assert(strategy.tags.includes('enemy_count_route'),
      `对手剩${enemyCount}张时把对应牌型计入软参考`);
    assert(strategy.reasons.some((reason) => reason.includes(`剩${enemyCount}张`)
      && reason.includes('软参考')),
    `对手剩${enemyCount}张时明确说明口诀不是硬规则`);
  }
}

console.log('残局口诀不能压过牌型结构');
{
  const level = 2;
  const tripleOnly = [
    C(6, 'S'), C(6, 'H'), C(6, 'D'),
    C(8), C(9), C(10), C(11), C(12),
  ];
  const decision = recommendPlay(context(tripleOnly, {
    level,
    handCounts: [tripleOnly.length, 5, 9, 11],
  }));
  assert(decision?.hand.type !== 'pair' || decision.cards[0].rank !== 6,
    '对手剩5张但手里只有三个6时，不为套用“出对子”口诀拆成66');
  assert(!decision?.reason?.includes('对手剩5张，优先对子'),
    '被结构保护否决的口诀不再出现在教练理由中');
}

console.log('公开牌史、回手路线与逢人配整牌进入统一策略核心');
{
  const runHand = [C(11, 'S'), C(13, 'H')];
  const runCards = [runHand[0]];
  const runPlay = { cards: runCards, hand: parseHand(runCards, 2) };
  const opponentNine = parseHand([C(9, 'D')], 2);
  const stoppedRun = evaluateStrategicPlay(runPlay, context(runHand, {
    mode: 'beat',
    lastHand: opponentNine,
    lastSeat: 3,
    handCounts: [runHand.length, 12, 12, 10],
    publicHistory: [
      { trickNumber: 1, seat: 3, action: 'play', hand: { type: 'single' } },
      { trickNumber: 2, seat: 3, action: 'play', hand: { type: 'single' } },
    ],
    policyProfile: 'expert',
  }));
  assert(stoppedRun.tags.includes('stop_opponent_run'),
    '对手连续取得公开牌权且已剩10张时提高安全拦截优先级');

  const probeHand = [C(3, 'S'), C(3, 'H'), C(8, 'D')];
  const probeCards = probeHand.slice(0, 2);
  const probe = evaluateStrategicPlay(
    { cards: probeCards, hand: parseHand(probeCards, 2) },
    context(probeHand, {
      mode: 'lead',
      publicHistory: [
        { trickNumber: 1, seat: 0, action: 'play', hand: { type: 'pair', size: 2, power: 3 } },
        { trickNumber: 1, seat: 1, action: 'pass' },
        { trickNumber: 1, seat: 3, action: 'pass' },
        { trickNumber: 2, seat: 2, action: 'play', hand: { type: 'pair', size: 2, power: 3 } },
        { trickNumber: 2, seat: 1, action: 'pass' },
      ],
      policyProfile: 'expert',
    }),
  );
  assert(probe.tags.includes('public_type_probe')
    && probe.reasons.some((reason) => reason.includes('不视为一定没有')),
  '对手过牌只作为概率证据，不被误当成确定暗牌信息');

  const retakeHand = [C(3, 'C'), C(9, 'S')];
  const retakeCards = [retakeHand[0]];
  const retake = evaluateStrategicPlay(
    { cards: retakeCards, hand: parseHand(retakeCards, 2) },
    context(retakeHand, { mode: 'lead', policyProfile: 'expert' }),
  );
  assert(retake.tags.includes('self_retake'), '领小牌时识别并奖励更高同型回手路线');

  const level = 7;
  const wildStraight = [
    C(3, 'S'), C(4, 'H'), C(5, 'D'), C(6, 'C'), C(level, 'H'),
  ];
  const consolidated = evaluateStrategicPlay(
    { cards: wildStraight, hand: parseHand(wildStraight, level) },
    context(wildStraight, { level, mode: 'lead', policyProfile: 'expert' }),
  );
  assert(consolidated.tags.includes('wild_consolidation'),
    '逢人配明显减少散张时按实际手数收益加分，而非一律惜配');
}

console.log('公开信息威胁模型与三手牌路搜索');
{
  const level = 2;
  const pairA = [C(3, 'S'), C(3, 'H')];
  const pairB = [C(4, 'S'), C(4, 'H')];
  const publicHistory = [
    {
      trickNumber: 1, seat: 2, action: 'play', cards: pairA,
      hand: { type: 'pair', size: 2, power: 3 },
    },
    { trickNumber: 1, seat: 3, action: 'pass', cards: [] },
    { trickNumber: 1, seat: 0, action: 'pass', cards: [] },
    { trickNumber: 1, seat: 1, action: 'pass', cards: [] },
    {
      trickNumber: 2, seat: 2, action: 'play', cards: pairB,
      hand: { type: 'pair', size: 2, power: 4 },
    },
    { trickNumber: 2, seat: 3, action: 'pass', cards: [] },
    { trickNumber: 2, seat: 0, action: 'pass', cards: [] },
    { trickNumber: 2, seat: 1, action: 'pass', cards: [] },
  ];
  const hand = [
    C(3, 'D'), C(3, 'C'), C(4, 'D'), C(4, 'C'),
    C(5, 'S'), C(6, 'S'), C(7, 'S'), C(8, 'S'), C(9, 'S'),
  ];
  const ctx = {
    seat: 0,
    hand,
    level,
    handCounts: [hand.length, 4, 5, 9],
    teams: TEAMS,
    finishOrder: [],
    publicHistory,
    mode: 'lead',
  };
  const model = inferPublicThreats(ctx);
  assert(model.nearestEnemy?.seat === 1 && model.urgentEnemy,
    '公开信息模型能把剩4张且牌型记录不足的对手识别为高收官威胁');
  assert(model.partner.closing && model.partner.preferredLeadType === 'pair',
    '公开信息模型能识别对家五张内残局和连续对子牌路');

  const pairPlay = { cards: pairA, hand: parseHand(pairA, level) };
  const coordination = publicCoordinationScore(pairPlay, ctx, model);
  assert(coordination.score > 0 && coordination.tags.includes('partner_closing_route'),
    '对家收尾牌路会提高匹配牌型的协同分');
  assert(coordination.tags.includes('public_safe_type'),
    '一个牌型同时得到两个对手公开过牌时，能被识别为安全引入');

  const route = estimateThreeStepRoute(hand, level, {
    ...ctx,
    publicModel: model,
  }, { depth: 3, beam: 4 });
  assert(Number.isFinite(route.estimatedTricks)
    && Number.isFinite(route.controlsSpent)
    && Array.isArray(route.tags),
  '三手牌路搜索返回可解释的手数、控制牌消耗和公开协同标签');
}

console.log('打4时普通顺子谨慎使用逢人配');
{
  const level = 4;
  const lowStraightCards = [
    C(5, 'H'), C(6, 'H'), C(7, 'D'), C(8, 'H'), C(level, 'H'),
  ];
  const lowStraight = parseHandVariants(lowStraightCards, level).find(
    (hand) => hand.type === 'straight' && hand.mainRank === 9,
  );
  const reserveCards = [
    C(10, 'S'), C(10, 'D'), C(12, 'S'), C(12, 'D'), C(14, 'C'), C(14, 'D'),
  ];
  const wasteful = evaluateStrategicPlay(
    { cards: lowStraightCards, hand: lowStraight },
    context([...lowStraightCards, ...reserveCards], {
      level,
      mode: 'lead',
      policyProfile: 'expert',
    }),
  );
  assert(wasteful.tags.includes('preserve_wild')
    && !wasteful.tags.includes('wild_consolidation'),
  '♥5♥6♦7♥8♥4组成普通9高顺时识别为中盘逢人配浪费');

  const leadDecision = recommendPlay(context([...lowStraightCards, ...reserveCards], {
    level,
    handCounts: [11, 12, 12, 12],
  }));
  assert(!(leadDecision?.hand.type === 'straight'
      && leadDecision.cards.some((card) => card.rank === level && card.suit === 'H')),
  '有普通对子等安全领法时，不用逢人配拼普通顺子领出');

  const kingStraightCards = [
    C(9, 'H'), C(10, 'S'), C(11, 'C'), C(13, 'D'), C(level, 'H'),
  ];
  const followHand = [
    ...kingStraightCards,
    C(2, 'S'), C(2, 'H'), C(3, 'S'), C(3, 'H'), C(6, 'S'), C(6, 'D'),
  ];
  const queenStraight = parseHand([
    C(8, 'S', 1), C(9, 'D', 1), C(10, 'H', 1), C(11, 'S', 1), C(12, 'C', 1),
  ], level);
  const followDecision = recommendPlay(context(followHand, {
    level,
    lastHand: queenStraight,
    lastSeat: 3,
    handCounts: [followHand.length, 12, 12, 12],
  }));
  assert(followDecision?.action === 'pass'
    && followDecision.reason.includes('逢人配'),
  '对手不紧急时，不用♥4补Q组成K高普通顺子抢牌权');

  const flushCards = [
    C(5, 'S'), C(6, 'S'), C(7, 'S'), C(8, 'S'), C(level, 'H'),
  ];
  const flushStrategy = evaluateStrategicPlay(
    { cards: flushCards, hand: parseHand(flushCards, level) },
    context(flushCards, { level, mode: 'lead', policyProfile: 'expert' }),
  );
  assert(!flushStrategy.tags.includes('preserve_wild'),
    '逢人配真正组成同花顺并走完时不触发普通顺子保配限制');

  const finishPair = [C(2, 'C'), C(2, 'D')];
  const twoStep = evaluateStrategicPlay(
    { cards: kingStraightCards, hand: parseHand(kingStraightCards, level) },
    context([...kingStraightCards, ...finishPair], {
      level,
      mode: 'lead',
      policyProfile: 'expert',
    }),
  );
  assert(twoStep.tags.includes('wild_consolidation')
    && !twoStep.tags.includes('preserve_wild'),
  '普通顺子若形成明确两手收官，仍允许合理使用逢人配');
}

console.log('单贡返牌按对象选择');
{
  const hand = [C(3), C(6, 'S'), C(6, 'H'), C(10, 'S'), C(10, 'H')];
  const toPartner = chooseReturnCard(hand.slice(), 2, { toPartner: true });
  const toOpponent = chooseReturnCard(hand.slice(), 2, { toPartner: false });
  assert(toPartner.rank === 3, '返给对家时优先5以下的小单张');
  assert(toOpponent.rank === 10, '返给对手时优先5以上、来自组合的大牌');
}

console.log('进贡王并收到小返牌后的首领策略');
{
  const level = 8;
  const returnedSix = C(6, 'H');
  const levelEight = C(8, 'D');
  const hand = [
    returnedSix, levelEight,
    C(3, 'S'), C(3, 'D'), C(10, 'S'), C(10, 'D'),
    C(12, 'S'), C(12, 'D'), C(14, 'S'), C(14, 'D'),
  ];
  const tributeContext = {
    gaveCard: { rank: 17, suit: 'J' },
    gaveTo: 0,
    receivedReturnCard: { rank: 6, suit: 'H' },
    receivedFrom: 0,
    firstLeadAfterTribute: true,
    doubleDown: false,
  };
  const firstLead = recommendPlay(context(hand, {
    seat: 2,
    level,
    handCounts: [27, 27, hand.length, 27],
    tributeContext,
  }));
  assert(firstLead?.hand.type === 'single'
    && firstLead.cards.length === 1
    && firstLead.cards[0].rank === 6
    && firstLead.cards[0].suit === 'H',
  '对家进贡大王并收到♥6后，首领优先打返还的独立♥6');
  assert(firstLead?.reason.includes('小返牌'),
    '教练说明首出♥6来自贡还配合，而不是机械打最小牌');

  const levelOpening = evaluateStrategicPlay(
    { cards: [levelEight], hand: parseHand([levelEight], level) },
    context(hand, {
      seat: 2,
      level,
      mode: 'lead',
      handCounts: [27, 27, hand.length, 27],
      tributeContext,
      policyProfile: 'expert',
    }),
  );
  assert(levelOpening.tags.includes('premium_tribute_opening'),
    '贡还后第一张打级牌8会被统一策略核心识别为过早消耗控制');

  const humanEvaluation = evaluatePlay({
    action: 'play',
    cards: [levelEight],
    handBefore: hand,
    level,
    lastHand: null,
    lastSeat: null,
    seat: 2,
    teams: TEAMS,
    handCounts: [27, 27, hand.length, 27],
    finishOrder: [],
    tributeContext,
    playedHand: parseHand([levelEight], level),
  });
  assert(humanEvaluation.mistakeTags.includes('premium_tribute_opening'),
    '真人评价与电脑选牌共用同一贡还首领规则');

  const pairedSix = C(6, 'S');
  const pairedHand = [returnedSix, pairedSix, levelEight, C(3), C(10), C(12), C(14)];
  const protectedReturn = recommendPlay(context(pairedHand, {
    seat: 2,
    level,
    handCounts: [27, 27, pairedHand.length, 27],
    tributeContext,
  }));
  assert(!(protectedReturn?.hand.type === 'single'
    && protectedReturn.cards[0]?.rank === 6),
  '返还6已经组成对子时不机械拆6，贡还口诀仍服从牌型结构');
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

console.log('两手残局先走组合并把王留到最后');
{
  const level = 5;
  const bigJoker = C(17, 'J');
  const aces = [C(14, 'H'), C(14, 'S'), C(14, 'C')];
  const tens = [C(10, 'D'), C(10, 'C')];
  const hand = [bigJoker, ...aces, ...tens];
  const endgameCtx = context(hand, {
    seat: 3,
    level,
    handCounts: [12, 10, 9, hand.length],
    mode: 'lead',
    policyProfile: 'expert',
  });

  const decision = recommendPlay(endgameCtx);
  assert(decision?.hand.type === 'fullhouse'
    && decision.cards.length === 5
    && decision.cards.filter((card) => card.rank === 14).length === 3
    && decision.cards.filter((card) => card.rank === 10).length === 2,
  '大王+AAA+TT残局先出AAA带TT，不先交大王或拆成三张与对子');

  const jokerFirst = evaluateStrategicPlay(
    { cards: [bigJoker], hand: parseHand([bigJoker], level) },
    endgameCtx,
  );
  assert(jokerFirst.tags.includes('control_first'),
    '先出大王、后留普通三带二会被识别为控制牌顺序错误');

  const fullhouseCards = [...aces, ...tens];
  const combinationFirst = evaluateStrategicPlay(
    { cards: fullhouseCards, hand: parseHand(fullhouseCards, level) },
    endgameCtx,
  );
  assert(combinationFirst.tags.includes('control_last'),
    '先走三带二并把大王留作最后单牌控制获得收官奖励');

  const tripleFirst = evaluateStrategicPlay(
    { cards: aces, hand: parseHand(aces, level) },
    endgameCtx,
  );
  assert(tripleFirst.tags.includes('split_ready_fullhouse'),
    '已有TT可配时，单独打AAA会被识别为拆开现成三带二');
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

console.log('对家头游后切换为保三游生存模式');
{
  const level = 9;
  const hand = [
    C(9, 'D'), C(9, 'C'),
    C(8, 'H'), C(8, 'D'),
    C(7, 'S'), C(7, 'D'), C(7, 'C'),
    C(6, 'D'), C(6, 'C'),
    C(5, 'D'), C(5, 'D', 1),
    C(4, 'S'), C(4, 'D'), C(4, 'C'), C(4, 'C', 1),
  ];
  const decision = recommendPlay(context(hand, {
    seat: 2,
    level,
    handCounts: [0, 8, hand.length, 17],
    finishOrder: [0],
    difficulty: 'master',
    deterministic: true,
  }));
  assert(decision?.action === 'play'
    && decision.hand.type !== 'single'
    && decision.cards.length >= 5,
  '对家已头游后接风的15张结构优先长组合降手数，不拆777领单7');
  assert(decision?.reason?.includes('避免末游'),
    '教练理由明确说明对家头游后的保三游目标');
}

console.log('对家头游后按名次净收益争二游，不为可选双上盲交唯一炸弹');
{
  const level = 9;
  const bomb = [C(4, 'S'), C(4, 'D'), C(4, 'C'), C(4, 'C', 1)];
  const preserveHand = [
    C(8, 'H'), C(8, 'D'),
    C(7, 'S'), C(7, 'D'),
    C(6, 'D'), C(6, 'C'),
    C(5, 'D'), C(5, 'D', 1),
    ...bomb,
  ];
  const preserveDecision = recommendPlay(context(preserveHand, {
    seat: 2,
    level,
    lastHand: parseHand([C(10, 'H', 1), C(10, 'D', 1), C(10, 'C', 1)], level),
    lastSeat: 3,
    handCounts: [0, 8, preserveHand.length, 5],
    finishOrder: [0],
    difficulty: 'master',
    deterministic: true,
  }));
  assert(preserveDecision?.action === 'pass',
    '对手仍有5张且炸后没有短收官路线时，不为可选双上盲交唯一炸弹');
  const preservePass = evaluatePlay({
    action: 'pass', cards: [], handBefore: preserveHand, level,
    lastHand: parseHand([C(10, 'H', 1), C(10, 'D', 1), C(10, 'C', 1)], level),
    lastSeat: 3, seat: 2, teams: TEAMS,
    handCounts: [0, 8, preserveHand.length, 5], finishOrder: [0],
    difficulty: 'master',
  });
  assert(preservePass.score >= 60
      && !preservePass.mistakeTags.includes('missed_double_up'),
    '真人评价同步认可五张区保留唯一炸弹，不机械判成错失双上');

  const closeHand = [
    ...bomb,
    C(8, 'H'), C(8, 'D'), C(8, 'C'), C(7, 'S'), C(7, 'D'),
  ];
  const closeDecision = recommendPlay(context(closeHand, {
    seat: 2,
    level,
    lastHand: parseHand([C(10, 'H', 1), C(10, 'D', 1), C(10, 'C', 1)], level),
    lastSeat: 3,
    handCounts: [0, 8, closeHand.length, 3],
    finishOrder: [0],
    difficulty: 'master', deterministic: true,
  }));
  assert(closeDecision?.action === 'play'
      && ['bomb', 'flush_straight', 'joker_bomb'].includes(closeDecision.hand.type),
    '对手三张内且炸后可一手收尾时及时夺权，争取二游双上');
  assert(closeDecision?.reason?.includes('双上'),
    '安全争双上场景使用统一名次解释，而不是机械惜炸');

  const baselineBomb = chooseAIPlay(context([
    C(7, 'S'), C(7, 'H'), C(7, 'D'), C(7, 'C'), C(3), C(6), C(11),
  ], {
    level,
    lastHand: parseHand([
      C(6, 'S', 1), C(6, 'H', 1), C(6, 'D', 1), C(8, 'S', 1), C(8, 'H', 1),
    ], level),
    lastSeat: 1,
    handCounts: [7, 5, 12, 11],
    difficulty: 'master',
    deterministic: true,
    policyProfile: 'baseline',
  }));
  assert(baselineBomb?.action === 'play' && baselineBomb.hand.type === 'bomb',
    '基线策略也能使用公开的上家座位判断五张整手威胁，不出现运行时参数缺失');
}

console.log('拆潜在炸弹组钢板且保留同花顺的重组净收益');
{
  const level = 9;
  const plate = [
    C(8, 'D'), C(8, 'C'), C(8, 'C', 1),
    C(7, 'H'), C(7, 'S'), C(7, 'D'),
  ];
  const remainder = [
    C(2, 'S'), C(2, 'D'), C(2, 'C'),
    C(10, 'C'), C(14, 'S'),
    C(5, 'S'), C(5, 'C'), C(5, 'C', 1),
    C(9, 'S'), C(12, 'S'), C(11, 'S'), C(10, 'S'), C(8, 'S'),
  ];
  const hand = [...plate, ...remainder];
  const playedHand = parseHand(plate, level);
  const result = evaluatePlay({
    action: 'play',
    cards: plate,
    handBefore: hand,
    playedHand,
    level,
    lastHand: null,
    lastSeat: null,
    seat: 0,
    teams: TEAMS,
    handCounts: [hand.length, 18, 20, 16],
    finishOrder: [],
    difficulty: 'master',
  });
  assert(result.score >= 85 && result.stars >= 4,
    '三张7+多余3张8组成钢板，并留下黑桃8组Q高同花顺应评为优秀重组');
  assert(!result.mistakeTags.includes('split_bomb')
    && !result.mistakeTags.includes('split_straight'),
  '明确降手数且保留成品同花顺时，不再机械标记为拆炸或拆顺');
  assert(result.tips.some((tip) => tip.includes('钢板') && tip.includes('同花顺')),
    '评价说明钢板与保留同花顺两项实际收益');
}

console.log('只有强牌能接时的战略过牌评分');
{
  const level = 9;
  const reserve = [
    C(10, 'C'), C(14, 'S'),
    C(5, 'S'), C(5, 'C'), C(5, 'C', 1),
    C(8, 'S'), C(9, 'S'), C(10, 'S'), C(11, 'S'), C(12, 'S'),
  ];
  const samples = [
    parseHand([C(13, 'H', 1), C(13, 'D', 1), C(13, 'C', 1)], level),
    parseHand([C(7, 'H', 1), C(7, 'C', 1)], level),
  ];
  const results = samples.map((lastHand) => evaluatePlay({
    action: 'pass',
    cards: [],
    handBefore: reserve,
    level,
    lastHand,
    lastSeat: 1,
    seat: 0,
    teams: TEAMS,
    handCounts: [reserve.length, 8, 15, 10],
    finishOrder: [],
    difficulty: 'master',
  }));
  assert(results.every((result) => result.score >= 78 && result.stars >= 4),
    '面对三张K或对7仅能动用同花顺时，非紧急过牌应评为优秀');
  assert(results.every((result) => result.tips.some((tip) => tip.includes('保留')
    && tip.includes('同花顺'))),
  '战略过牌说明保留强控制牌等待更高收益的目的');

  const aiPasses = samples.map((lastHand) => recommendPlay(context(reserve, {
    level,
    lastHand,
    lastSeat: 1,
    handCounts: [reserve.length, 8, 15, 10],
    difficulty: 'master',
    deterministic: true,
  })));
  assert(aiPasses.every((decision) => decision?.action === 'pass'),
    'AI与评分共用同一判断：不用同花顺压三张K，也不拆同花顺里的10组对子压7');
}

console.log('对手连续走单时条件性拆最小对子拦截');
{
  const level = 9;
  const hand = [
    C(7, 'S'), C(7, 'D'),
    C(8, 'S'), C(8, 'D'),
    C(9, 'S'), C(9, 'D'),
    C(10, 'S'), C(10, 'D'),
    C(11, 'S'), C(11, 'D'),
    C(12, 'S'), C(12, 'D'),
  ];
  const history = [];
  let turn = 1;
  for (const [trickNumber, rank, countBefore] of [[1, 3, 11], [2, 4, 10]]) {
    const single = C(rank, 'C', 1);
    history.push({
      turn: turn++, trickNumber, seat: 0, action: 'play', cards: [single],
      hand: parseHand([single], level),
      countsBefore: [countBefore, hand.length, 14, 13],
      countsAfter: [countBefore - 1, hand.length, 14, 13],
    });
    for (const seat of [1, 2, 3]) {
      history.push({
        turn: turn++, trickNumber, seat, action: 'pass',
        countsBefore: [countBefore - 1, hand.length, 14, 13],
        countsAfter: [countBefore - 1, hand.length, 14, 13],
      });
    }
  }
  const currentSingle = C(6, 'C', 1);
  history.push({
    turn: turn++, trickNumber: 3, seat: 0, action: 'play', cards: [currentSingle],
    hand: parseHand([currentSingle], level),
    countsBefore: [9, hand.length, 14, 13],
    countsAfter: [8, hand.length, 14, 13],
  });

  const decision = recommendPlay(context(hand, {
    seat: 1,
    level,
    lastHand: parseHand([currentSingle], level),
    lastSeat: 0,
    handCounts: [8, hand.length, 14, 13],
    publicHistory: history,
    difficulty: 'master',
    deterministic: true,
  }));
  assert(decision?.action === 'play'
    && decision.hand.type === 'single'
    && decision.cards[0].rank === 7,
  '对手已连续三圈走单且剩8张时，拆最小对7顶住，不再整手对子全过');
  assert(decision?.reason?.includes('连续走单'),
    '教练理由标明条件性拆对来自公开连续单张威胁');
}

console.log('8月复盘：逢人配、王与同型接牌保护');
{
  const level = 3;
  const hand = [
    C(3, 'H', 1),
    C(14, 'H', 0), C(14, 'H', 1), C(14, 'C', 0), C(14, 'C', 1),
    C(13, 'S', 1), C(13, 'S', 0), C(13, 'D', 0), C(13, 'C', 0),
    C(10, 'H', 0), C(10, 'D', 1), C(10, 'C', 0), C(10, 'C', 1),
    C(9, 'H', 1), C(8, 'H', 0), C(8, 'C', 1),
    C(7, 'S', 0), C(7, 'D', 1),
    C(4, 'H', 0), C(4, 'S', 1), C(4, 'D', 0),
  ];
  const oldControl = C(11, 'C', 1);
  const lastCard = C(13, 'C', 1);
  const publicHistory = [
    {
      turn: 1, trickNumber: 1, seat: 0, action: 'play', cards: [oldControl],
      hand: parseHand([oldControl], level),
      countsBefore: [24, 21, 22, 22], countsAfter: [23, 21, 22, 22],
    },
    {
      turn: 5, trickNumber: 2, seat: 0, action: 'play', cards: [lastCard],
      hand: parseHand([lastCard], level),
      countsBefore: [12, 21, 22, 22], countsAfter: [11, 21, 22, 22],
    },
  ];
  const decision = recommendPlay(context(hand, {
    seat: 1,
    level,
    lastHand: parseHand([lastCard], level),
    lastSeat: 0,
    handCounts: [11, hand.length, 22, 22],
    publicHistory,
    difficulty: 'master',
    deterministic: true,
  }));
  assert(decision?.action === 'pass'
    || !decision.cards.some((card) => card.suit === 'H' && card.rank === level),
  '对手尚有11张时，即使连续控过两圈，也不把逢人配当单张压K；可用普通A或等待');

  const wildSingleAssessment = evaluatePlay({
    action: 'play',
    cards: [hand[0]],
    playedHand: parseHand([hand[0]], level),
    handBefore: hand,
    level,
    lastHand: parseHand([lastCard], level),
    lastSeat: 0,
    seat: 1,
    teams: TEAMS,
    handCounts: [11, hand.length, 22, 22],
    finishOrder: [],
    publicHistory,
    difficulty: 'master',
  });
  assert(wildSingleAssessment.mistakeTags.includes('wild_as_single'),
    '真人评分与AI共用逢人配单走规则，非紧急单走逢人配会明确标记');
}

{
  const level = 4;
  const hand = [
    C(16, 'J', 1),
    C(4, 'D', 0), C(4, 'D', 1), C(4, 'C', 0), C(14, 'S', 0),
    C(13, 'H', 0), C(13, 'D', 1), C(13, 'C', 1), C(13, 'C', 0),
    C(12, 'H', 1), C(11, 'H', 1), C(11, 'H', 0), C(11, 'C', 1),
    C(10, 'D', 0), C(7, 'H', 1), C(6, 'S', 0), C(6, 'C', 1),
    C(5, 'H', 0), C(5, 'S', 1), C(5, 'D', 1), C(5, 'D', 0),
    C(3, 'S', 0), C(2, 'S', 1), C(2, 'D', 0), C(2, 'C', 0),
  ];
  const pair3 = [C(3, 'S', 1), C(3, 'D', 1)];
  const pair5 = [C(5, 'S', 0), C(5, 'D', 0)];
  const lastCard = C(6, 'H', 0);
  const publicHistory = [
    {
      turn: 1, trickNumber: 1, seat: 1, action: 'play', cards: pair3,
      hand: parseHand(pair3, level),
      countsBefore: [6, 20, 25, 18], countsAfter: [6, 18, 25, 18],
    },
    {
      turn: 5, trickNumber: 2, seat: 1, action: 'play', cards: pair5,
      hand: parseHand(pair5, level),
      countsBefore: [6, 18, 25, 18], countsAfter: [6, 16, 25, 18],
    },
    {
      turn: 9, trickNumber: 3, seat: 1, action: 'play', cards: [lastCard],
      hand: parseHand([lastCard], level),
      countsBefore: [6, 17, 25, 18], countsAfter: [6, 16, 25, 18],
    },
  ];
  const decision = recommendPlay(context(hand, {
    seat: 2,
    level,
    lastHand: parseHand([lastCard], level),
    lastSeat: 1,
    handCounts: [6, 16, hand.length, 18],
    publicHistory,
    difficulty: 'master',
    deterministic: true,
  }));
  assert(decision?.action === 'pass' || decision.cards[0].rank !== 16,
    '对手尚有16张且只连续控两圈时，不用小王接普通6');
}

console.log('8月复盘：灾难性结构损失时允许过牌');
{
  const cases = [
    {
      level: 5,
      seat: 3,
      handCounts: [23, 20, 21, 24],
      hand: [
        C(5, 'H', 0), C(5, 'S', 0), C(5, 'C', 0),
        C(14, 'D', 0), C(14, 'D', 1), C(14, 'C', 0),
        C(12, 'H', 0), C(12, 'C', 1), C(11, 'S', 0), C(11, 'C', 0),
        C(10, 'H', 1), C(10, 'D', 0), C(10, 'C', 1),
        C(9, 'H', 1), C(9, 'S', 1), C(9, 'D', 0),
        C(7, 'H', 0), C(7, 'H', 1), C(7, 'D', 0), C(7, 'C', 0),
        C(6, 'S', 1), C(4, 'H', 0), C(3, 'S', 0), C(3, 'C', 0),
      ],
      lastSeat: 2,
      lastCards: [C(9, 'D', 1), C(10, 'H', 0), C(12, 'H', 1), C(13, 'D', 1), C(5, 'H', 1)],
      label: 'A高顺子同时拆三组潜在炸弹',
    },
    {
      level: 5,
      seat: 2,
      handCounts: [4, 17, 25, 26],
      hand: [
        C(5, 'H', 1), C(5, 'D', 0), C(5, 'C', 0), C(14, 'H', 1), C(14, 'D', 1),
        C(13, 'S', 0), C(13, 'D', 1), C(11, 'H', 0), C(11, 'S', 1),
        C(10, 'H', 1), C(10, 'S', 1), C(10, 'S', 0), C(9, 'D', 0),
        C(8, 'H', 0), C(8, 'D', 1), C(7, 'H', 0), C(7, 'S', 1),
        C(4, 'H', 1), C(4, 'C', 1), C(3, 'H', 0), C(3, 'H', 1), C(3, 'D', 1),
        C(2, 'H', 1), C(2, 'S', 1), C(2, 'C', 0),
      ],
      lastSeat: 1,
      lastCards: [C(13, 'S', 1), C(13, 'D', 0), C(13, 'C', 1)],
      label: '逢人配配AA接三张K并破坏多组结构',
    },
    {
      level: 8,
      seat: 2,
      handCounts: [21, 22, 25, 26],
      hand: [
        C(8, 'H', 1), C(14, 'H', 1), C(14, 'C', 0), C(12, 'H', 0), C(12, 'C', 0),
        C(11, 'H', 0), C(11, 'S', 1), C(11, 'D', 1), C(11, 'C', 0),
        C(10, 'H', 0), C(10, 'H', 1), C(10, 'D', 1), C(10, 'C', 0),
        C(9, 'H', 0), C(9, 'C', 1), C(7, 'H', 1), C(7, 'D', 0), C(7, 'C', 0),
        C(6, 'H', 0), C(6, 'D', 0), C(6, 'C', 0), C(5, 'C', 0),
        C(4, 'S', 0), C(4, 'S', 1), C(4, 'D', 1),
      ],
      lastSeat: 1,
      lastCards: [C(12, 'H', 1), C(12, 'D', 1), C(10, 'S', 1), C(10, 'D', 0), C(8, 'H', 0)],
      lastMainRank: 12,
      label: '逢人配拼A三带二并拆多组现成结构',
    },
    {
      level: 7,
      seat: 1,
      handCounts: [22, 27, 27, 27],
      hand: [
        C(17, 'J', 0), C(16, 'J', 1), C(16, 'J', 0),
        C(7, 'H', 0), C(7, 'H', 1), C(7, 'S', 1), C(7, 'S', 0),
        C(14, 'H', 1), C(14, 'S', 0), C(14, 'D', 1),
        C(13, 'H', 1), C(13, 'D', 0), C(13, 'D', 1), C(13, 'C', 0),
        C(12, 'H', 1), C(12, 'S', 0), C(12, 'C', 1), C(11, 'H', 0), C(11, 'C', 1),
        C(10, 'H', 0), C(9, 'D', 1), C(9, 'D', 0), C(6, 'D', 0),
        C(3, 'H', 0), C(3, 'S', 0), C(3, 'D', 1), C(2, 'D', 1),
      ],
      lastSeat: 0,
      lastCards: [C(6, 'C', 0), C(5, 'C', 0), C(4, 'H', 0), C(3, 'C', 0), C(2, 'C', 0)],
      allowNaturalResponse: true,
      label: '开局接顺子时不使用逢人配拼普通10高顺子',
    },
  ];

  const preservationPassScores = [];
  for (const sample of cases) {
    const lastHand = sample.lastMainRank == null
      ? parseHand(sample.lastCards, sample.level)
      : parseHandVariants(sample.lastCards, sample.level).find((hand) => (
        hand.mainRank === sample.lastMainRank
      ));
    const decision = recommendPlay(context(sample.hand, {
      seat: sample.seat,
      level: sample.level,
      lastHand,
      lastSeat: sample.lastSeat,
      handCounts: sample.handCounts,
      difficulty: 'master',
      deterministic: true,
    }));
    const acceptable = sample.allowNaturalResponse
      ? decision?.action === 'pass'
        || !decision.cards.some((card) => card.suit === 'H' && card.rank === sample.level)
      : decision?.action === 'pass';
    assert(acceptable, sample.allowNaturalResponse
      ? `${sample.label}；若有不耗逢人配的自然顺子可改用自然牌型`
      : `${sample.label}时应保存结构并过牌`);
    if (!sample.allowNaturalResponse) {
      preservationPassScores.push(evaluatePlay({
        action: 'pass',
        cards: [],
        handBefore: sample.hand,
        level: sample.level,
        lastHand,
        lastSeat: sample.lastSeat,
        seat: sample.seat,
        teams: TEAMS,
        handCounts: sample.handCounts,
        finishOrder: [],
        difficulty: 'master',
      }));
    }
  }
  assert(preservationPassScores.every((result) => result.score >= 80
    && result.tips.some((tip) => tip.includes('逢人配') || tip.includes('结构'))),
  '同一策略核心让真人评分同步认可三类灾难性接牌下的保存结构过牌');
}

console.log('8月复盘：同型接牌按结构等级后最小充分点数');
{
  const level = 4;
  const hand = [
    C(3, 'S'), C(3, 'D'), C(5, 'S'), C(5, 'D'),
    C(7, 'S'), C(7, 'D'), C(9, 'S'), C(9, 'D'),
    C(11, 'S'), C(11, 'D'), C(13, 'S'), C(13, 'D'),
  ];
  const lastCards = [C(10, 'H', 0), C(10, 'S', 0)];
  const decision = recommendPlay(context(hand, {
    seat: 1,
    level,
    lastHand: parseHand(lastCards, level),
    lastSeat: 0,
    handCounts: [20, hand.length, 20, 20],
    difficulty: 'master',
    deterministic: true,
  }));
  assert(decision?.action === 'play'
    && decision.hand.type === 'pair'
    && decision.cards.every((card) => card.rank === 11),
  '对10后对J、对K属于同一结构损失等级时，使用最小充分的对J，保留大对K');

  const structureFirstHand = [
    C(7, 'C'),
    C(13, 'S'), C(13, 'D'), C(13, 'C'), C(12, 'H'), C(12, 'D'),
    C(11, 'H'), C(11, 'S'), C(10, 'H'), C(10, 'S'), C(9, 'D'), C(9, 'C'),
    C(8, 'S'), C(8, 'C'), C(6, 'D'), C(6, 'C'),
    C(5, 'H'), C(5, 'D'), C(5, 'C'), C(4, 'C'),
    C(3, 'S'), C(3, 'S', 1), C(3, 'D'), C(3, 'C'), C(3, 'C', 1),
  ];
  const structureFirst = recommendPlay(context(structureFirstHand, {
    seat: 1,
    level: 7,
    lastHand: parseHand([C(10, 'S', 1), C(10, 'C', 1)], 7),
    lastSeat: 0,
    handCounts: [17, structureFirstHand.length, 27, 22],
    difficulty: 'master',
    deterministic: true,
  }));
  assert(structureFirst?.action === 'play'
    && structureFirst.cards.every((card) => card.rank === 13),
  '对K只拆三张而对Q会破坏顺子时，先按结构损失等级选择对K，不被前瞻候选裁剪打乱');
}

console.log('一张逢人配不能同时补成多个潜在炸弹');
{
  const level = 5;
  const played = C(7, 'S');
  const hand = [
    played, C(7, 'H'), C(7, 'D'),
    C(9, 'S'), C(9, 'H'), C(9, 'D'),
    C(5, 'H'),
  ];
  const strategy = evaluateStrategicPlay({
    cards: [played],
    hand: parseHand([played], level),
  }, {
    seat: 0,
    hand,
    level,
    mode: 'beat',
    lastHand: parseHand([C(6, 'C')], level),
    lastSeat: 3,
    handCounts: [hand.length, 12, 12, 12],
    teams: TEAMS,
    finishOrder: [],
    policyProfile: 'expert',
    strategyWeight: 1,
  });
  assert(!strategy.tags.includes('split_bomb'),
    '777、999和一张逢人配只构成一个潜在炸弹；拆一张7后仍保留999炸，不虚报拆炸');
}

console.log('大师难度与公开信息防作弊边界');
{
  setAIDifficulty('master');
  assert(getAIDifficulty() === 'master', '大师难度可以通过统一难度接口设置');

  const level = 7;
  const hand = [
    C(3, 'S'), C(3, 'D'),
    C(4, 'S'), C(4, 'D'),
    C(5, 'S'), C(5, 'D'),
    C(7, 'H'), C(8, 'C'), C(9, 'C'), C(10, 'C'), C(11, 'C'), C(12, 'C'),
  ];
  const publicCards = [C(14, 'S', 1), C(14, 'H', 1)];
  const publicHand = parseHand(publicCards, level);
  const publicAction = {
    turn: 8,
    trickNumber: 3,
    seat: 3,
    action: 'play',
    cards: publicCards,
    hand: publicHand,
    countsBefore: [hand.length, 16, 14, 15],
    countsAfter: [hand.length, 16, 14, 13],
  };
  const common = {
    level,
    handCounts: [hand.length, 16, 14, 13],
    playedCards: publicCards,
    difficulty: 'master',
    deterministic: true,
  };
  const hiddenWorldA = context(hand, {
    ...common,
    opponentHands: [[C(17, 'J')], [C(16, 'J')], [C(2, 'S')]],
    hands: [hand, [C(17, 'J')], [C(16, 'J')], [C(2, 'S')]],
    deck: [C(17, 'J'), C(16, 'J')],
    futureCards: [C(17, 'J'), C(17, 'J', 1)],
    futureActions: [{ seat: 1, cards: [C(17, 'J')] }],
    roundInitialHands: [[...hand], [C(17, 'J')], [], []],
    remainingHands: [hand, [C(17, 'J')], [], []],
    coachTip: { cards: [C(17, 'J')], text: '私有教练提示A' },
    selectedIds: new Set(hand.slice(0, 2).map((card) => card.id)),
    evalHistory: [{ score: 1, privateInference: 'A' }],
    lastReplay: { initialHands: [[...hand], [C(17, 'J')], [], []] },
    dealSeed: 111,
    publicHistory: [{
      ...publicAction,
      evaluation: { score: 1, privateInference: 'A' },
      decisionMeta: { reason: '私有理由A', projectedOpponentHand: [C(17, 'J')] },
      private: { opponentHands: [[C(17, 'J')]], future: [C(16, 'J')] },
    }],
  });
  const hiddenWorldB = context(hand, {
    ...common,
    opponentHands: [[C(3, 'H')], [C(4, 'H')], [C(5, 'H')]],
    hands: [hand, [C(3, 'H')], [C(4, 'H')], [C(5, 'H')]],
    deck: [C(3, 'H'), C(4, 'H'), C(5, 'H')],
    futureCards: [C(3, 'H'), C(4, 'H')],
    futureActions: [{ seat: 2, cards: [C(3, 'H'), C(3, 'C')] }],
    roundInitialHands: [[...hand], [], [C(4, 'H')], [C(5, 'H')]],
    remainingHands: [hand, [], [C(4, 'H')], [C(5, 'H')]],
    coachTip: { cards: [C(3, 'H')], text: '私有教练提示B' },
    selectedIds: new Set(hand.slice(-2).map((card) => card.id)),
    evalHistory: [{ score: 100, privateInference: 'B' }],
    lastReplay: { initialHands: [[...hand], [], [C(4, 'H')], [C(5, 'H')]] },
    dealSeed: 999999,
    publicHistory: [{
      ...publicAction,
      evaluation: { score: 100, privateInference: 'B' },
      decisionMeta: { reason: '私有理由B', projectedOpponentHand: [C(3, 'H')] },
      private: { opponentHands: [[C(3, 'H')]], future: [C(4, 'H')] },
    }],
  });

  const decisionA = chooseAIPlay(hiddenWorldA);
  const decisionB = chooseAIPlay(hiddenWorldB);
  const decisionKey = (decision) => (decision?.action === 'play'
    ? `${decision.cards.map((card) => card.id).sort().join(',')}|${handSignature(decision.hand)}`
    : decision?.action || 'none');
  assert(decisionKey(decisionA) === decisionKey(decisionB),
    '同一本家牌和公共信息下，改变对手手牌、未来牌及私有状态不会改变大师决策');

  const publicPrivateA = chooseAIPlay(context(hand, {
    ...common,
    publicHistory: [{
      ...publicAction,
      evaluation: { score: 0 },
      decisionMeta: { reason: '内部信号A' },
      private: { intendedPlay: 'A' },
    }],
  }));
  const publicPrivateB = chooseAIPlay(context(hand, {
    ...common,
    publicHistory: [{
      ...publicAction,
      evaluation: { score: 100 },
      decisionMeta: { reason: '内部信号B' },
      private: { intendedPlay: 'B' },
    }],
  }));
  assert(decisionKey(publicPrivateA) === decisionKey(publicPrivateB),
    '公共历史中的评价、AI内部理由和私有字段变化不会影响大师决策');

  const ownershipCases = [
    context(hand, { ...common }),
    context([C(8, 'S'), C(9, 'D'), C(11, 'C'), C(11, 'D')], {
      level,
      lastHand: parseHand([C(7, 'C')], level),
      lastSeat: 3,
      handCounts: [4, 10, 9, 8],
      difficulty: 'master',
      deterministic: true,
    }),
    context([C(9, 'S'), C(9, 'D'), C(12, 'C'), C(12, 'D')], {
      level,
      lastHand: parseHand([C(8, 'S'), C(8, 'H')], level),
      lastSeat: 1,
      handCounts: [4, 7, 8, 9],
      difficulty: 'master',
      deterministic: true,
    }),
  ];
  const ownershipResults = ownershipCases.map((sample) => {
    const decision = chooseAIPlay(sample);
    if (decision?.action === 'pass') return !!sample.lastHand;
    const ownIds = new Set(sample.hand.map((card) => card.id));
    const uniqueIds = new Set(decision?.cards?.map((card) => card.id) || []);
    const ownsEveryCard = decision?.cards?.length > 0
      && uniqueIds.size === decision.cards.length
      && decision.cards.every((card) => ownIds.has(card.id));
    const legality = ownsEveryCard
      ? isLegalPlay(decision.cards, sample.level, sample.lastHand, handSignature(decision.hand))
      : { ok: false };
    return ownsEveryCard && legality.ok;
  });
  assert(ownershipResults.every(Boolean), '大师模式所有出牌均来自本家手牌且符合当前牌型规则');

  setAIDifficulty('normal');
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
  // This is a local responsiveness smoke under an unisolated desktop load,
  // not the search-triggered release-latency gate.  Keep enough headroom for
  // filesystem/antivirus scheduling jitter while retaining the measured time.
  assert(maximum < 1500, '有界前瞻在 1.5 秒本地负载容差内完成');
}

console.log('对手五张内连续走两圈单张时提前拦截');
{
  const level = 2;
  const hand = [
    C(7, 'S'), C(8, 'S'), C(8, 'H'), C(9, 'S'), C(9, 'H'),
    C(10, 'S'), C(10, 'H'), C(11, 'S'), C(11, 'H'), C(12, 'S'),
    C(13, 'S'), C(14, 'S'),
  ];
  const publicHistory = [
    { trickNumber: 1, seat: 3, action: 'play', cards: [C(4, 'C')], hand: { type: 'single', size: 1, power: 4 } },
    { trickNumber: 1, seat: 0, action: 'pass', cards: [] },
    { trickNumber: 1, seat: 1, action: 'pass', cards: [] },
    { trickNumber: 1, seat: 2, action: 'pass', cards: [] },
    { trickNumber: 2, seat: 3, action: 'play', cards: [C(5, 'C')], hand: { type: 'single', size: 1, power: 5 } },
    { trickNumber: 2, seat: 0, action: 'pass', cards: [] },
    { trickNumber: 2, seat: 1, action: 'pass', cards: [] },
    { trickNumber: 2, seat: 2, action: 'pass', cards: [] },
  ];
  const ctx = context(hand, {
    level,
    lastHand: parseHand([C(6, 'D')], level),
    lastSeat: 3,
    handCounts: [hand.length, 12, 12, 5],
    publicHistory,
  });
  const single = { cards: [hand[0]], hand: parseHand([hand[0]], level) };
  const strategy = evaluateStrategicPlay(single, {
    ...ctx,
    mode: 'beat',
    policyProfile: 'expert',
  });
  assert(strategy.tags.includes('stop_single_run'),
    '对手剩五张且已连续走两圈单张时，公开信息触发条件性拦截');
  const decision = recommendPlay(ctx);
  assert(decision?.action === 'play' && decision.cards.length === 1,
  '对手五张内单张压力升高时，优先用独立小单截断，不全部过牌');
}

console.log('实体花色候选保留成品同花顺');
{
  const level = 2;
  const spadeRun = [5, 6, 7, 8, 9].map((rank) => C(rank, 'S'));
  const heart7 = C(7, 'H');
  const diamond7 = C(7, 'D');
  const hand = [...spadeRun, heart7, diamond7, C(3, 'C')];
  const lastPair = parseHand([C(6, 'H'), C(6, 'D')], level);
  const pairs7 = generateLegalPlays(hand, level, lastPair).filter((play) => (
    play.hand.type === 'pair' && play.hand.mainRank === 7
  ));
  const safePair = pairs7.find((play) => (
    play.cards.includes(heart7) && play.cards.includes(diamond7)
  ));
  assert(!!safePair && !safePair.cards.includes(spadeRun[2]),
    '同点对子枚举包含不拆黑桃同花顺的♥7♦7');

  const sequenceHand = [
    ...spadeRun,
    C(5, 'H'), C(6, 'D'), C(7, 'D'), C(8, 'D'), C(9, 'D'), C(3, 'C'),
  ];
  const lastStraight = parseHand([C(4, 'C'), C(5, 'C'), C(6, 'H'), C(7, 'H'), C(8, 'H')], level);
  const safeStraight = generateLegalPlays(sequenceHand, level, lastStraight).find((play) => (
    play.hand.type === 'straight'
    && play.hand.mainRank === 9
    && play.cards.some((card) => card.rank === 5 && card.suit === 'H')
    && [6, 7, 8, 9].every((rank) => play.cards.some((card) => card.rank === rank && card.suit === 'D'))
  ));
  assert(!!safeStraight,
    '顺子跨点选牌会采用安全花色实体，保留♠5到♠9同花顺');
}

console.log('顺子资源守恒与王对子限制');
{
  const level = 8;
  const hand = [
    C(8, 'H', 0), C(8, 'H', 1), C(14, 'S'),
    C(11, 'S'), C(11, 'D'), C(10, 'S'), C(10, 'D'), C(3, 'C'), C(2, 'C'),
  ];
  const pair10 = [hand[5], hand[6]];
  const strategy = evaluateStrategicPlay({ cards: pair10, hand: parseHand(pair10, level) }, {
    ...context(hand, { level }),
    mode: 'lead',
    policyProfile: 'expert',
  });
  assert(!strategy.tags.includes('split_straight'),
    '有限逢人配不再被重复分配给重叠顺子，走对10不会虚报拆顺');

  const triple9 = [C(9, 'S'), C(9, 'H'), C(9, 'D')];
  const jokerHand = [...triple9, C(17, 'J', 0), C(17, 'J', 1), C(3, 'C')];
  const jokerStrategy = evaluateStrategicPlay({
    cards: triple9,
    hand: parseHand(triple9, 2),
  }, {
    ...context(jokerHand),
    mode: 'lead',
    policyProfile: 'expert',
  });
  assert(!jokerStrategy.tags.includes('split_ready_fullhouse'),
    '两张大王不能作为三带二的对子，不再误报拆现成三带二');
}

console.log('还贡保护强结构与确定模式零随机');
{
  const returnHand = [
    C(10, 'S'), C(10, 'H'), C(10, 'D'), C(10, 'C'),
    C(6, 'S'), C(6, 'H'), C(3, 'D'),
  ];
  const returned = chooseReturnCard(returnHand, 2, { toPartner: false });
  assert(returned.rank !== 10, '返牌先保护四炸，不因“给对手大牌”拆掉四张10');

  const originalRandom = Math.random;
  let randomCalls = 0;
  Math.random = () => { randomCalls += 1; return 0.5; };
  try {
    recommendPlay(context([C(3, 'S'), C(3, 'H'), C(6, 'D'), C(9, 'C'), C(12, 'S')], {
      difficulty: 'master',
    }));
  } finally {
    Math.random = originalRandom;
  }
  assert(randomCalls === 0, '大师教练的确定性决策不再调用或污染全局随机数');
}

console.log('云端候选服从本地硬边界并保持路线多样性');
{
  const finishHand = [C(3, 'S'), C(3, 'H')];
  const finishConsultation = getAIConsultation(context(finishHand, { difficulty: 'master' }));
  assert(finishConsultation.cloudConstraint === 'finish_now'
    && finishConsultation.candidates.length === 1,
  '可以直接出完时云端只能采用本地完成候选，不能过牌或拆牌');

  const diverseHand = [
    C(14, 'D', 0), C(5, 'C', 0), C(8, 'D', 0), C(9, 'H', 1), C(7, 'H', 1),
    C(7, 'H', 0), C(9, 'D', 1), C(12, 'D', 0), C(14, 'H', 1), C(2, 'D', 0),
    C(6, 'D', 1), C(3, 'C', 0), C(10, 'C', 0), C(13, 'C', 0), C(6, 'C', 1),
    C(12, 'S', 1), C(10, 'C', 1), C(4, 'S', 1), C(2, 'C', 1), C(13, 'S', 1),
    C(3, 'C', 1), C(8, 'S', 0), C(5, 'H', 1), C(6, 'C', 0), C(11, 'D', 0),
    C(14, 'C', 0), C(4, 'D', 1),
  ];
  const diverse = getAIConsultation(context(diverseHand, { level: 7, difficulty: 'master' }));
  const candidateTypes = new Set(diverse.candidates.map((candidate) => candidate.hand?.type).filter(Boolean));
  assert(diverse.candidates.length <= 3,
    '云端只接收本地筛选后的最多三个候选，避免兼容网关超时');
  assert(candidateTypes.size >= 3,
    '宽牌面云端候选覆盖多种牌型，不再被十二个三带二垄断');
}

console.log('统一策略的两手收官不再被AI内部结构罚分覆盖');
{
  const sixes = [];
  for (const deckIndex of [0, 1]) {
    for (const suit of ['S', 'H', 'D', 'C']) sixes.push(C(6, suit, deckIndex));
  }
  const hand = [...sixes.slice(0, 7), C(3, 'S'), C(3, 'H')];
  const decision = recommendPlay(context(hand, {
    level: 9,
    lastHand: parseHand([C(5, 'S'), C(5, 'H'), C(5, 'D')], 9),
    lastSeat: 3,
    handCounts: [9, 20, 20, 20],
    difficulty: 'master',
  }));
  assert(decision?.hand?.type === 'bomb' && decision.cards.length === 4,
    '七张6加对3接三张5时用最小四炸夺权，随后以666带33收完');
}

console.log('非紧急响应不从炸弹拆对子');
{
  const hand = [
    C(11, 'S'), C(11, 'H'), C(11, 'D'), C(11, 'C'),
    ...[3, 4, 5, 6, 7, 8].flatMap((rank) => [C(rank, 'S'), C(rank, 'D')]),
  ];
  const decision = recommendPlay(context(hand, {
    level: 13,
    lastHand: parseHand([C(8, 'H'), C(8, 'C')], 13),
    lastSeat: 3,
    handCounts: [hand.length, 20, 20, 20],
    difficulty: 'master',
  }));
  assert(decision?.action === 'pass',
    '对手不紧急且唯一普通接法是拆四J出对J时，保存炸弹选择过牌');
}

console.log('前瞻分层能选到统一评分认可的安全重组');
{
  const hand = [
    C(12, 'S', 0), C(6, 'C', 0), C(13, 'C', 1), C(5, 'S', 0), C(5, 'D', 1),
    C(14, 'C', 0), C(11, 'S', 0), C(5, 'H', 1), C(4, 'H', 1), C(3, 'D', 0),
    C(8, 'S', 0), C(8, 'S', 1), C(17, 'J', 1), C(5, 'C', 1), C(6, 'S', 1),
    C(13, 'H', 1), C(9, 'C', 1), C(4, 'H', 0), C(8, 'C', 1), C(7, 'D', 0),
    C(5, 'S', 1), C(2, 'H', 1), C(3, 'C', 0), C(7, 'H', 0), C(6, 'H', 1),
    C(13, 'S', 1), C(14, 'S', 1),
  ];
  const decision = recommendPlay(context(hand, {
    level: 5,
    handCounts: [27, 27, 27, 27],
    difficulty: 'master',
  }));
  assert(decision?.hand?.type === 'triple_pair' && decision.cards.length === 6,
    '大师领出选择安全三连对并保留同花顺，不再拆顺子领单9');
}

console.log('跨点实体牌按整条花色路线保护同花顺');
{
  const level = 13;
  const hand = [
    C(3, 'S'), C(3, 'D'), C(3, 'H'), C(4, 'S'), C(4, 'D'),
    C(5, 'D'), C(5, 'S'), C(6, 'S'), C(6, 'D'), C(7, 'D'), C(7, 'S'),
    C(13, 'C'),
  ];
  const legal = generateLegalPlays(hand, level, null);
  const safeStraight = legal.find((play) => (
    play.hand.type === 'straight'
    && play.cards.some((card) => card.rank === 3 && card.suit === 'H')
    && [4, 5, 6, 7].every((rank) => (
      play.cards.some((card) => card.rank === rank && card.suit === 'D')
    ))
  ));
  assert(!!safeStraight,
    '跨点候选包含♥3加方块4到7的整条安全路线');

  const decision = recommendPlay(context(hand, {
    level,
    handCounts: [hand.length, 12, 12, 12],
    difficulty: 'master',
  }));
  const playedIds = new Set(decision?.cards?.map((card) => card.id) || []);
  const remainingSpadeRun = [3, 4, 5, 6, 7].every((rank) => (
    hand.some((card) => card.rank === rank && card.suit === 'S' && !playedIds.has(card.id))
  ));
  assert(decision?.hand?.type === 'straight' && remainingSpadeRun,
    '大师选择保留完整黑桃3到7同花顺的普通顺子，不采用交错花色拆掉两套结构');
}

console.log('\nP0 记牌器：公开剩余牌池');
{
  const pool = inferRemainingPool(context([C(13)], {}));
  assert(pool.counts[13] === 7 && pool.total === 107, '手牌一张K后，牌池K余7张、总数107');
  assert(pool.wilds === 2, '无逢人配被看到时牌池余2张');

  const poolPlayed = inferRemainingPool(context([C(13)], {
    playedCards: [C(14, 'S'), C(16, 'J'), C(16, 'J')],
  }));
  assert(poolPlayed.counts[14] === 7 && poolPlayed.counts[16] === 0 && poolPlayed.total === 104,
    '公开打出A和两张小王后，对应点数从牌池扣除');

  const poolWild = inferRemainingPool(context([C(2, 'H')], { level: 2 }));
  assert(poolWild.wilds === 1, '手中红桃级牌是逢人配，牌池只余1张');

  const poolWildPlayed = inferRemainingPool(context([C(2, 'H')], {
    level: 2, playedCards: [C(2, 'H', 1)],
  }));
  assert(poolWildPlayed.wilds === 0, '两张逢人配都公开后牌池为0');

  const poolTribute = inferRemainingPool(context([], {
    tributeContext: { gaveCard: C(17, 'J') },
  }));
  assert(poolTribute.counts[17] === 1 && poolTribute.total === 107,
    '进贡给对手的大王从牌池扣除（已知在其手中）');

  const poolTributeReturn = inferRemainingPool(context([C(5, 'S')], {
    tributeContext: { receivedReturnCard: C(5, 'S') },
  }));
  assert(poolTributeReturn.counts[5] === 7,
    '还贡收到的牌已在手牌中，不重复从牌池扣除');
}

console.log('P0 记牌器：对手可接概率');
{
  const play = (type, power, size) => ({ type, power, size });
  const modelFull = createBeatModel(context([C(13)], {}));
  const singleHigh = modelFull.seatTypeBeat(play('single', 13, 1), 27);
  assert(singleHigh > 0.9, 'A/级牌/王全在池中时，27张对手压过单K概率很高');

  const exhaustHigh = [...Array(8).fill(0).map((_, i) => C(14, 'S', i)),
    C(2, 'S', 0), C(2, 'S', 1),
    C(2, 'D', 0), C(2, 'D', 1),
    C(2, 'C', 0), C(2, 'C', 1),
    C(2, 'H', 0), C(2, 'H', 1),
    C(16, 'J'), C(16, 'J'), C(17, 'J'), C(17, 'J')];
  const modelExhaust = createBeatModel(context([C(13)], { playedCards: exhaustHigh }));
  const typeRisk = modelExhaust.seatTypeBeat(play('single', 13, 1), 27);
  assert(typeRisk === 0, '比单K更高的点数全部公开后，同型可接概率为0');
  const unconditionedRisk = createUnconditionedBeatModel(context([C(13)], {
    playedCards: exhaustHigh,
  })).seatTypeBeat(play('single', 13, 1), 27);
  assert(unconditionedRisk > 0.9,
    '静态先验仍可作为诊断基线，但独立消融不再用它替换共享公开信息模型');
  assert(modelExhaust.seatBeat(play('single', 13, 1), 27) > typeRisk,
    'seatBeat 含炸弹兜底，高于纯同型概率');

  const modelPair = createBeatModel(context([C(14), C(14)], {}));
  const pairARisk = modelPair.seatTypeBeat(play('pair', 14, 2), 27);
  const pair2Risk = modelPair.seatTypeBeat(play('pair', 2, 2), 27);
  assert(pairARisk < pair2Risk && pair2Risk >= 0.99,
    '对A可接概率显著低于对2（更多点数能压对2）');

  // 仅剩Q作为唯一可压对9的对子来源：有逢人配时能与一张Q凑对，否则为0。
  const exhaustedOthers = [
    ...Array(7).fill(0).map((_, i) => C(12, 'S', i)),
    ...Array(8).fill(0).map((_, i) => C(10, 'S', i)),
    ...Array(8).fill(0).map((_, i) => C(11, 'S', i)),
    ...Array(8).fill(0).map((_, i) => C(13, 'S', i)),
    ...Array(8).fill(0).map((_, i) => C(14, 'S', i)),
    C(2, 'S', 0), C(2, 'S', 1),
    C(2, 'D', 0), C(2, 'D', 1),
    C(2, 'C', 0), C(2, 'C', 1),
    C(16, 'J'), C(16, 'J'), C(17, 'J'), C(17, 'J'),
  ];
  const modelWild = createBeatModel(context([C(9), C(9)], { playedCards: exhaustedOthers, level: 2 }));
  const modelNoWild = createBeatModel(context([C(9), C(9)], {
    playedCards: [...exhaustedOthers, C(2, 'H'), C(2, 'H')], level: 2,
  }));
  const wildRisk = modelWild.seatTypeBeat(play('pair', 9, 2), 12);
  const noWildRisk = modelNoWild.seatTypeBeat(play('pair', 9, 2), 12);
  assert(wildRisk > 0.02 && noWildRisk === 0,
    '逢人配可与一张Q凑对：牌池有逢人配时对9可接概率上升，耗尽后为0');

  const modelTeams = createBeatModel(context([C(13)], {
    handCounts: [1, 0, 27, 5],
    teams: [0, 1, 0, 1],
    finishOrder: [1],
  }));
  assert(modelTeams.enemies.length === 1 && modelTeams.enemies[0].seat === 3,
    '已出完或同队的座位不计入对手');
}

console.log('P0 记牌器：已知贡牌归属与按座位公开证据');
{
  const transferredBig = C(17, 'J', 0);
  const transferredSmall = C(16, 'J', 0);
  const transferPool = inferRemainingPool(context([], {
    tributeContext: {
      knownTransfers: [
        { kind: 'tribute', from: 0, to: 1, card: transferredBig },
        { kind: 'return', from: 1, to: 3, card: transferredSmall },
      ],
    },
  }));
  assert(transferPool.total === 106
      && transferPool.knownBySeat[1][0]?.rank === 17
      && transferPool.knownBySeat[3][0]?.rank === 16,
    '全桌公开的两张贡还牌只从未知池各扣一次，并归到实际持有座位');
  const movedAgain = inferRemainingPool(context([], {
    tributeContext: {
      knownTransfers: [
        { kind: 'tribute', from: 0, to: 1, card: transferredBig },
        { kind: 'return', from: 1, to: 3, card: transferredBig },
      ],
    },
  }));
  assert(movedAgain.total === 107 && movedAgain.knownBySeat[1].length === 0
      && movedAgain.knownBySeat[3][0]?.rank === 17,
    '同一实体牌再次公开转移时只认最后持有者，不重复扣牌或复制确定牌');

  const smallJoker = { type: 'single', power: 99, size: 1 };
  const knownTribute = createBeatModel(context([], {
    handCounts: [0, 12, 12, 12],
    tributeContext: {
      gaveCard: C(17, 'J', 0),
      gaveTo: 1,
    },
  }));
  assert(knownTribute.seatTypeBeat(smallJoker, 12, 1) === 1,
    '已知进贡给上家的大王可确定压过小王，不再按随机牌池稀释');
  assert(knownTribute.seatTypeBeat(smallJoker, 12, 3) < 1,
    '确定贡牌只归属于收贡座位，不会错误复制给另一名对手');

  const playedTribute = createBeatModel(context([], {
    handCounts: [0, 11, 12, 12],
    tributeContext: {
      gaveCard: C(17, 'J', 0),
      gaveTo: 1,
    },
    playedCards: [C(17, 'J', 0)],
  }));
  assert(playedTribute.seatTypeBeat(smallJoker, 11, 1) < 1,
    '已知贡牌公开打出后撤销确定持牌，并且不从剩余池重复扣除');

  const pair9 = { type: 'pair', power: 9, size: 2 };
  const noPassModel = createBeatModel(context([], {
    handCounts: [0, 12, 12, 12],
    publicHistory: [],
  }));
  const teammatePassHistory = [
    { trickNumber: 1, seat: 3, action: 'play', hand: { type: 'pair', power: 3, size: 2 } },
    { trickNumber: 1, seat: 1, action: 'pass' },
    { trickNumber: 2, seat: 3, action: 'play', hand: { type: 'pair', power: 4, size: 2 } },
    { trickNumber: 2, seat: 1, action: 'pass' },
  ];
  const teammatePassModel = createBeatModel(context([], {
    handCounts: [0, 12, 12, 12],
    publicHistory: teammatePassHistory,
  }));
  const baseRisk = noPassModel.seatTypeBeat(pair9, 12, 1);
  const teammatePassRisk = teammatePassModel.seatTypeBeat(pair9, 12, 1);
  assert(Math.abs(baseRisk - teammatePassRisk) < 1e-12,
    '同一座位连续两次礼让队友对子，不降低其压过对9的概率');

  const teammateHistorySummary = inferPublicThreats(context([], {
    handCounts: [0, 12, 3, 12],
    lastHand: pair9,
    lastSeat: 3,
    publicHistory: teammatePassHistory,
  })).history;
  assert(teammateHistorySummary.passEvents[1].length === 2
      && teammateHistorySummary.passEvents[1].every((event) => (
        event.controllerSeat === 3 && event.toTeammate && !event.againstEnemy
        && event.targetType === 'pair' && event.targetSize === 2
        && Number.isFinite(event.targetPower)
      )),
    '公开牌史逐次保存过牌时的控制座位、牌型、点力、尺寸和队友礼让关系');

  const partnerYieldHistory = [
    { trickNumber: 1, seat: 0, action: 'play', hand: { type: 'pair', power: 3, size: 2 } },
    { trickNumber: 1, seat: 2, action: 'pass' },
    { trickNumber: 2, seat: 0, action: 'play', hand: { type: 'pair', power: 4, size: 2 } },
    { trickNumber: 2, seat: 2, action: 'pass' },
  ];
  const partnerYieldModel = inferPublicThreats(context([], {
    handCounts: [0, 12, 12, 12],
    lastHand: pair9,
    lastSeat: 1,
    publicHistory: partnerYieldHistory,
  }));
  assert(partnerYieldModel.partner.passesAgainstLast === 0,
    '对家礼让本方对子不被误记为接不住敌方牌，回手概率证据保持干净');

  const partnerYieldHand = [C(9, 'S'), C(9, 'D'), C(13, 'C')];
  const partnerYieldCards = partnerYieldHand.slice(0, 2);
  const partnerYieldStrategy = evaluateStrategicPlay({
    cards: partnerYieldCards,
    hand: parseHand(partnerYieldCards, 2),
  }, context(partnerYieldHand, {
    level: 2,
    mode: 'lead',
    handCounts: [partnerYieldHand.length, 12, 6, 12],
    publicHistory: partnerYieldHistory,
    policyProfile: 'expert',
  }));
  assert(!partnerYieldStrategy.tags.includes('partner_route_uncertain'),
    '对家连续礼让本方对子，不降低统一策略核心的后续送型评分');

  const enemyLowPassHistory = [
    { trickNumber: 1, seat: 0, action: 'play', hand: { type: 'pair', power: 3, size: 2 } },
      { trickNumber: 1, seat: 1, action: 'pass' },
    { trickNumber: 2, seat: 2, action: 'play', hand: { type: 'pair', power: 4, size: 2 } },
      { trickNumber: 2, seat: 1, action: 'pass' },
  ];
  const enemyLowPassModel = createBeatModel(context([], {
    handCounts: [0, 12, 12, 12],
    publicHistory: enemyLowPassHistory,
  }));
  const enemyLowPassRisk = enemyLowPassModel.seatTypeBeat(pair9, 12, 1);
  assert(enemyLowPassRisk > 0 && enemyLowPassRisk < baseRisk,
    '对敌方较低对子连续过牌只作为压过对9概率的软降证据');

  const enemyHighPassModel = createBeatModel(context([], {
    handCounts: [0, 12, 12, 12],
    publicHistory: [
      { trickNumber: 1, seat: 0, action: 'play', hand: { type: 'pair', power: 14, size: 2 } },
      { trickNumber: 1, seat: 1, action: 'pass' },
      { trickNumber: 2, seat: 2, action: 'play', hand: { type: 'pair', power: 14, size: 2 } },
      { trickNumber: 2, seat: 1, action: 'pass' },
    ],
  }));
  assert(Math.abs(baseRisk - enemyHighPassModel.seatTypeBeat(pair9, 12, 1)) < 1e-12,
    '对敌方更强对子过牌，不误判为无法压过较低的对9');

  const teammateSafeCtx = context([], {
    mode: 'lead',
    handCounts: [0, 12, 3, 12],
    publicHistory: [
      ...teammatePassHistory,
      { trickNumber: 3, seat: 1, action: 'play', hand: { type: 'pair', power: 5, size: 2 } },
      { trickNumber: 3, seat: 3, action: 'pass' },
    ],
  });
  const teammateSafeModel = inferPublicThreats(teammateSafeCtx);
  const teammateSafeScore = publicCoordinationScore(
    { cards: [C(9, 'D'), C(9, 'C')], hand: pair9 }, teammateSafeCtx, teammateSafeModel,
  );
  assert(!teammateSafeScore.tags.includes('public_safe_type'),
    '两名对手各自礼让队友的对子记录，不得伪造“双方都不会接”的安全牌型');
}

console.log('P0-P5 独立消融开关');
{
  const full = resolvePolicyVariant('expert');
  const p2On = resolvePolicyVariant('p2-on');
  const noP0 = resolvePolicyVariant('no-p0');
  const noP1 = resolvePolicyVariant('no-p1');
  const p1Legacy = resolvePolicyVariant('p1-legacy');
  const noP2 = resolvePolicyVariant('no-p2');
  const noP3 = resolvePolicyVariant('no-p3');
  const noP4 = resolvePolicyVariant('no-p4');
  const noP5 = resolvePolicyVariant('no-p5');
  const p1Only = resolvePolicyVariant('p1-only');
  const noControlV2 = resolvePolicyVariant('no-control-v2');
  const riskOnly = resolvePolicyVariant('only-control-risk');
  const coverOnly = resolvePolicyVariant('only-partner-cover');
  assert(full.policyProfile === 'expert' && full.policyFeatures.p0
      && full.policyFeatures.p1 && full.policyFeatures.p1ResponseSearch
      && full.policyFeatures.p2 && full.policyFeatures.p3
      && full.policyFeatures.p4 && full.policyFeatures.p5 && full.policyFeatures.endgame
      && full.policyFeatures.controlV2 && !full.policyFeatures.controlRiskV2
      && full.policyFeatures.cheapControl && !full.policyFeatures.partnerCover
      && full.policyFeatures.placementControl && full.policyFeatures.publicLockLead,
    '正式 expert 显式启用 P0-P5，旧控权V2概率实验仍保持关闭');
  assert(p2On.policyProfile === 'expert' && p2On.policyFeatures.p0
      && p2On.policyFeatures.p1 && p2On.policyFeatures.p2 && p2On.policyFeatures.endgame,
    'p2-on 旧命令继续映射到含新版 P2 的正式策略');
  assert(noP0.policyProfile === 'expert' && !noP0.policyFeatures.p0
      && noP0.policyFeatures.p1 && noP0.policyFeatures.p2 && noP0.policyFeatures.endgame,
    'no-p0 只关闭 P0，保持其它正式模块、残局搜索和 expert 权重');
  assert(noP1.policyProfile === 'expert' && noP1.policyFeatures.p0
      && !noP1.policyFeatures.p1 && !noP1.policyFeatures.p1ResponseSearch
      && noP1.policyFeatures.p2 && noP1.policyFeatures.endgame,
    'no-p1 只关闭 P1，保持其它正式模块、残局搜索和 expert 权重');
  assert(p1Legacy.policyFeatures.p1 && !p1Legacy.policyFeatures.p1ResponseSearch,
    'p1-legacy 保留旧相对控权校正，单独关闭一层公开应手树以支持升级消融');
  assert(noP2.policyProfile === 'expert' && noP2.policyFeatures.p0
      && noP2.policyFeatures.p1 && !noP2.policyFeatures.p2 && noP2.policyFeatures.endgame,
    'no-p2 只关闭新版炸弹/过牌净收益模块');
  assert(noP3.policyFeatures.p2 && !noP3.policyFeatures.p3
      && noP3.policyFeatures.p4 && noP3.policyFeatures.p5,
    'no-p3 只关闭搭档交接与公开风险护牌');
  assert(noP4.policyFeatures.p2 && noP4.policyFeatures.p3
      && !noP4.policyFeatures.p4 && noP4.policyFeatures.p5,
    'no-p4 只关闭受限残局公开情景 rollout');
  assert(noP5.policyFeatures.p2 && noP5.policyFeatures.p3
      && noP5.policyFeatures.p4 && !noP5.policyFeatures.p5,
    'no-p5 只关闭相关策略分的有界融合校准');
  assert(p1Only.policyFeatures.p0 && p1Only.policyFeatures.p1
      && ['p2', 'p3', 'p4', 'p5'].every((key) => !p1Only.policyFeatures[key]),
    'p1-only 保留 P0/P1，供 P2-P5 联合消融与留出集发布门禁');
  assert(noControlV2.policyProfile === 'expert'
      && noControlV2.policyFeatures.p0 && noControlV2.policyFeatures.p1
      && noControlV2.policyFeatures.p2 && noControlV2.policyFeatures.endgame
      && !noControlV2.policyFeatures.controlV2
      && ['controlRiskV2', 'cheapControl', 'partnerCover', 'placementControl', 'publicLockLead']
        .every((key) => !noControlV2.policyFeatures[key]),
    'no-control-v2 仅关闭本轮控权/协同改进，保留P0/P1和全部既有大师能力');
  assert(riskOnly.policyFeatures.controlRiskV2
      && !riskOnly.policyFeatures.cheapControl && !riskOnly.policyFeatures.partnerCover
      && !riskOnly.policyFeatures.placementControl && !riskOnly.policyFeatures.publicLockLead,
    '控权V2五个模块可以单独开关，不再被一个总开关绑在一起');
  assert(coverOnly.policyFeatures.partnerCover
      && !coverOnly.policyFeatures.controlRiskV2 && !coverOnly.policyFeatures.cheapControl,
    '负收益的队友护牌保留为显式实验臂，不进入正式大师策略');
  assert(Object.values(resolvePolicyFeatures('baseline')).every((value) => value === false),
    '旧 baseline 仍关闭全部新增模块，保留原 A/B 兼容口径');
  noP0.policyFeatures.p1 = false;
  assert(resolvePolicyVariant('no-p0').policyFeatures.p1,
    '消融配置每次返回独立副本，单局修改不会污染后续牌局');
}

console.log('强制专家消融臂变体');
{
  const rootFxe = resolvePolicyVariant('root-pimc-v1-fxe');
  const ismctsFxe = resolvePolicyVariant('ismcts-v2-fxe');
  const v3Fxe = resolvePolicyVariant('ismcts-v3-fxe');
  assert(rootFxe.policyProfile === 'expert' && rootFxe.decisionEngine === 'root-pimc-v1-fxe'
    && ismctsFxe.policyProfile === 'expert' && ismctsFxe.decisionEngine === 'ismcts-v2-fxe'
    && v3Fxe.policyProfile === 'expert' && v3Fxe.decisionEngine === 'ismcts-v3-fxe',
  '消融臂保留专家策略权重，仅以独立决策引擎标识驱动强制专家选择');
  assert(rootFxe.policyFeatures.p0 && rootFxe.policyFeatures.endgame
    && ismctsFxe.policyFeatures.p0 && ismctsFxe.policyFeatures.endgame
    && v3Fxe.policyFeatures.p0 && v3Fxe.policyFeatures.endgame,
  '消融臂与正常臂共享完整专家特征集，差异只在最终选择');
}

console.log('ismcts-v3 根候选成对采样变体');
{
  const v3 = resolvePolicyVariant('ismcts-v3');
  const v2 = resolvePolicyVariant('ismcts-v2');
  assert(v3.policyProfile === 'expert' && v3.decisionEngine === 'ismcts-v3'
    && v3.policyFeatures.p0 && v3.policyFeatures.endgame
    && JSON.stringify(v3.policyFeatures) === JSON.stringify(v2.policyFeatures),
  'ismcts-v3 与 v2 共享专家特征集，仅以独立决策引擎标识驱动成对 sweep');
}

console.log('确定性搜索预算配置');
{
  const v3 = resolveHybridSearchConfig('ismcts-v3', { deterministic: true });
  const v2 = resolveHybridSearchConfig('ismcts-v2-fxe', { deterministic: true });
  const v3Fxe = resolveHybridSearchConfig('ismcts-v3-fxe', { deterministic: true });
  assert(v3.searchMode === 'ismcts-v3' && v3.candidateLimit === 6
    && v3.nodeBudget === 1800 && v3.iterationBudget === 72 && v3.maxPlies === 88,
  'v3 确定性评测预算由可导出的单一配置源解析');
  assert(v2.searchMode === 'ismcts-v2' && v2.nodeBudget === 3600,
  '强制专家变体复用对应正常引擎的确定性搜索预算');
  assert(v3Fxe.searchMode === 'ismcts-v3' && v3Fxe.nodeBudget === 1800,
  'v3 强制专家变体复用 v3 的冻结节点预算与成对搜索模式');
}

console.log('实验性锐化阈值变体');
{
  const p0Sharp = resolvePolicyVariant('p0-sharp');
  const p1Sharp = resolvePolicyVariant('p1-sharp');
  const expert = resolvePolicyVariant('expert');
  assert(p0Sharp.policyProfile === 'expert'
      && p0Sharp.policyFeatures.p0 && p0Sharp.policyFeatures.p1
      && p0Sharp.policyFeatures.p2 && p0Sharp.policyFeatures.endgame
      && p0Sharp.policyThresholds.p0LeadGate === 0.9
      && p0Sharp.policyThresholds.p0StopGate === 0.9,
    'p0-sharp 保持全部特征启用，仅抬高 P0 领牌与拦截风险门槛');
  assert(p1Sharp.policyProfile === 'expert'
      && p1Sharp.policyFeatures.p0 && p1Sharp.policyFeatures.p1 && p1Sharp.policyFeatures.p2
      && p1Sharp.policyThresholds.p1SpreadFloor === 0.14
      && p1Sharp.policyThresholds.p0LeadGate === undefined,
    'p1-sharp 只抬高 P1 的风险差起效门槛，不带 P0 门槛覆盖');
  assert(expert.policyThresholds === null,
    '默认 expert 不携带阈值覆盖，沿用内置门槛，行为不变');
}

console.log('实验性 P1 幅度变体');
{
  const p1Soft = resolvePolicyVariant('p1-soft');
  const p1Sharp = resolvePolicyVariant('p1-sharp');
  assert(p1Soft.policyProfile === 'expert'
      && p1Soft.policyFeatures.p0 && p1Soft.policyFeatures.p1
      && p1Soft.policyFeatures.p2 && p1Soft.policyFeatures.endgame
      && p1Soft.policyThresholds.p1LossScale === 0.35
      && p1Soft.policyThresholds.p1SpreadFloor === undefined,
    'p1-soft 只缩放 P1 丢权损失幅度，不改风险差平滑门槛');
  assert(p1Sharp.policyThresholds.p1LossScale === undefined
      && p1Sharp.policyThresholds.p1SpreadFloor === 0.14,
    'p1-sharp 与 p1-soft 覆盖不同的 P1 维度，互不污染');
}

console.log('实验性 P0 幅度变体');
{
  const p0Soft = resolvePolicyVariant('p0-soft');
  const p0Sharp = resolvePolicyVariant('p0-sharp');
  assert(p0Soft.policyProfile === 'expert'
      && p0Soft.policyFeatures.p0 && p0Soft.policyFeatures.p1
      && p0Soft.policyFeatures.p2 && p0Soft.policyFeatures.endgame
      && p0Soft.policyThresholds.p0LeadScale === 0.35
      && p0Soft.policyThresholds.p0LeadGate === undefined,
    'p0-soft 只缩放 P0 高控制领出惩罚幅度，不改默认门槛');
  assert(p0Sharp.policyThresholds.p0LeadScale === undefined
      && p0Sharp.policyThresholds.p0LeadGate === 0.9,
    'p0-sharp 与 p0-soft 覆盖不同的 P0 维度，互不污染');
}

console.log('P0 记牌器：对手领大王单牌时及时拦截');
{
  const hand = [
    C(8, 'S'), C(8, 'H'), C(8, 'D'), C(8, 'C'),
    C(9, 'S'), C(10, 'S'), C(11, 'S'), C(12, 'S'), C(13, 'S'), C(14, 'S'),
    C(3, 'S'), C(3, 'H'), C(5, 'S'), C(5, 'H'), C(6, 'S'), C(6, 'H'),
  ];
  const base = context(hand, {
    level: 2,
    lastHand: parseHand([C(17, 'J')], 2),
    lastSeat: 1,
    handCounts: [16, 6, 12, 6],
    teams: [0, 1, 0, 1],
    difficulty: 'master',
    deterministic: true,
  });
  const expert = chooseAIPlay({ ...base, policyProfile: 'expert' });
  assert(expert?.action === 'play' && ['bomb', 'flush_straight'].includes(expert.hand?.type),
    '对手剩6张领大王、普通牌无法接时，expert 及时出炸弹拦截');
  const baseline = chooseAIPlay({ ...base, policyProfile: 'baseline' });
  assert(baseline?.action === 'pass',
    '同一局面 baseline 保留炸弹（旧逻辑的硬阈值4张不触发）');
}

console.log('P0 记牌器：超几何必抽张数（残局）与进贡不重减');
{
  const close = (a, b) => Math.abs(a - b) < 1e-6;
  // 残局：N=10、c=3、k=8 时至少必抽到 1 张，P(X>=3)=21/45+21/45=14/30≈0.4667。
  assert(close(hypergeomAtLeast(3, 3, 10, 8), 14 / 30),
    '必抽张数 x0=1 时正确重建分布，不再恒返回 1');
  assert(close(hypergeomAtLeast(1, 3, 10, 8), 1),
    '必抽张数满足 n 时概率为 1');
  assert(close(hypergeomAtLeast(2, 3, 10, 8), 28 / 30),
    'P(X>=2)=P(2)+P(3)=(21+21)/45=14/15');
  assert(close(hypergeomAtLeast(4, 4, 15, 10), 462 / 3003),
    'x0=0 与旧实现一致（4 炸残局精确值）');
  // 进贡牌被对手打出后进入 playedCards，不应二次扣减。
  const poolNoPlay = inferRemainingPool(context([], {
    tributeContext: { gaveCard: C(17, 'J') },
    playedCards: [],
  }));
  assert(poolNoPlay.counts[17] === 1, '进贡大王未打出时从牌池扣除一次');
  const poolGavePlayed = inferRemainingPool(context([], {
    tributeContext: { gaveCard: C(17, 'J') },
    playedCards: [C(17, 'J')],
  }));
  assert(poolGavePlayed.counts[17] === 1,
    '进贡大王被对手打出后只经 playedCards 扣一次，不再重减');

  // legacy 无 deckIndex：进贡 1 张大王 + 同牌面打出 1 张 → 不双扣、不记确定持牌
  const legacyBigJoker = { rank: 17, suit: 'J' }; // 故意无 deckIndex
  const poolLegacyOnePlayed = inferRemainingPool(context([], {
    seat: 0,
    tributeContext: {
      knownTransfers: [
        { kind: 'tribute', from: 0, to: 1, card: legacyBigJoker },
      ],
    },
    playedCards: [{ rank: 17, suit: 'J' }],
  }));
  assert(poolLegacyOnePlayed.counts[17] === 1,
    'legacy 贡牌无 deckIndex：同牌面已出 1 张时 counts[17] 恰为 1（不与 played 双扣）');
  assert((poolLegacyOnePlayed.knownBySeat[1] || []).length === 0,
    'legacy 贡牌无 deckIndex：同牌面已出后 knownBySeat 不再记收贡座持牌');

  // 牌面容量 2：1 张已出 + 3 张转移时，1 张由已出牌抵消、1 张占用持牌预算，第 3 张超容量被丢弃
  const poolLegacyBudget = inferRemainingPool(context([], {
    seat: 0,
    tributeContext: {
      knownTransfers: [
        { kind: 'tribute', from: 2, to: 1, card: { rank: 17, suit: 'J' } },
        { kind: 'tribute', from: 2, to: 3, card: { rank: 17, suit: 'J' } },
        { kind: 'tribute', from: 2, to: 3, card: { rank: 17, suit: 'J' } },
      ],
    },
    playedCards: [{ rank: 17, suit: 'J' }],
  }));
  assert(poolLegacyBudget.counts[17] === 0,
    'legacy 牌面持牌预算封顶：1 已出 + 1 持牌后不再多扣（第 3 张转移丢弃）');
  assert((poolLegacyBudget.knownBySeat[1] || []).length
      + (poolLegacyBudget.knownBySeat[3] || []).length === 1,
    'legacy 牌面持牌预算封顶：只有 1 张被记为确定持牌，超出容量部分不归属');
}

console.log('P1 控权期望：EV 公式与门控');
{
  const close = (a, b) => Math.abs(a - b) < 1e-9;
  assert(close(controlEV(10, 0, 5), 10), 'p=0（必不被接回）时保持完整路线优势');
  assert(close(controlEV(10, 1, 5), -5), 'p=1（必被接回）时只承受丢权损失');
  assert(close(controlEV(10, 0.5, 5), 2.5), 'p=0.5 时按期望折减');
  assert(controlEV(10, 0.2, 5) > controlEV(10, 0.8, 5),
    '被接回概率越大，控权期望越低（单调）');
  assert(controlEV(10, 0.5, 5) < controlEV(20, 0.5, 5),
    '保持牌权时路线成本越低（优势越大），期望越高');
  // 必须用 beat 模式覆盖生产分支。新版 P1 会把下家应手、对家回手和上家
  // 反压一起纳入，因此不预设 A 必然优于 K；这里只验证真实执行且严格中心化。
  const controlHand = [
    C(13), C(14), C(8), C(8, 'D'), C(9), C(9, 'D'),
    C(10), C(10, 'D'), C(11), C(11, 'D'), C(3), C(3, 'D'),
  ];
  const controlCtx = context(controlHand, {
    lastHand: parseHand([C(12, 'H')], 2),
    lastSeat: 3,
    handCounts: [12, 12, 12, 4],
    difficulty: 'master', deterministic: true, policyProfile: 'expert',
  });
  const withP1 = recommendPlay(controlCtx);
  const withoutP1 = recommendPlay({
    ...controlCtx,
    policyFeatures: { p0: true, p1: false, p2: true, endgame: true },
  });
  const scoreByRank = (decision) => new Map((decision.candidates || [])
    .filter((candidate) => candidate.hand?.type === 'single')
    .map((candidate) => [candidate.hand.mainRank, candidate.localScore]));
  const onScores = scoreByRank(withP1);
  const offScores = scoreByRank(withoutP1);
  const aceDelta = (onScores.get(14) ?? 0) - (offScores.get(14) ?? 0);
  const kingDelta = (onScores.get(13) ?? 0) - (offScores.get(13) ?? 0);
  assert(aceDelta * kingDelta < 0 && Math.abs(aceDelta + kingDelta) <= 0.2
      && [13, 14].every((rank) => withP1.candidates.find(
        (candidate) => candidate.hand?.mainRank === rank,
      )?.responseSearch?.teamControl != null),
    'P1在真实接牌分支展开座位有序应手树并做零和校正，不给安全候选附加复杂度税');

  const level = 6;
  const lastCard = C(7, 'S', 0);
  const fallbackHand = [
    C(16, 'J', 0), C(8, 'S', 1), C(8, 'H', 1),
    C(12, 'C', 1), C(2, 'S', 0), C(4, 'H', 1),
    C(14, 'D', 0), C(6, 'S', 1), C(17, 'J', 0),
    C(10, 'C', 0), C(4, 'D', 0),
  ];
  const fallbackDecision = chooseAIPlay(context(fallbackHand, {
    level,
    lastHand: parseHand([lastCard], level),
    lastSeat: 3,
    handCounts: [11, 9, 6, 13],
    playedCards: [lastCard],
    difficulty: 'master', deterministic: true, policyProfile: 'expert',
  }));
  assert(fallbackDecision?.action === 'play'
      && fallbackDecision.hand?.type === 'single'
      && fallbackDecision.cards?.[0]?.rank === 10,
    'P1即使抬高A，也不能触发惜大牌后直接过牌；应回退到安全普通10');
}

console.log('P2 炸弹净收益：bombNetGain 公式与门控');
{
  const close = (a, b) => Math.abs(a - b) < 1e-9;
  // netGain = (routeOrd - routeBomb) - bombResource + pLose * lossPenalty
  assert(close(bombNetGain(50, 40, 0, 10, 5), 5),
    '普通路线更差且必不被压回时，净收益为正（应炸）');
  assert(close(bombNetGain(50, 40, 0, 10, 20), -10),
    '炸弹机会成本过高时，净收益转负（应省）');
  assert(close(bombNetGain(40, 40, 1, 30, 5), 25),
    '普通接法必被压回且丢权损失大时，即使路线成本相近也应炸');
  assert(bombNetGain(60, 40, 0.5, 10, 5) > bombNetGain(50, 40, 0.5, 10, 5),
    '普通路线越差，净收益越高（单调）');
  assert(bombNetGain(50, 40, 0.2, 10, 5) < bombNetGain(50, 40, 0.8, 10, 5),
    '被压回概率越大，净收益越高（单调）');
  assert(bombNetGain(50, 40, 0.5, 10, 5) < bombNetGain(50, 40, 0.5, 10, 1),
    '炸弹资源成本越低，净收益越高（单调）');

  const level = 7;
  const tacticalHand = [
    C(3, 'S', 1), C(5, 'H', 1), C(7, 'H', 1),
    C(2, 'C', 0), C(2, 'H', 0), C(8, 'D', 1),
    C(11, 'D', 0), C(14, 'C', 0), C(10, 'H', 1),
    C(10, 'C', 1), C(11, 'H', 0), C(2, 'C', 1),
  ];
  const tacticalContext = context(tacticalHand, {
    level,
    lastHand: parseHand([C(12, 'H')], level),
    lastSeat: 3,
    handCounts: [12, 12, 12, 4],
    difficulty: 'master',
    deterministic: true,
    policyProfile: 'expert',
    policyFeatures: resolvePolicyVariant('p2-on').policyFeatures,
  });
  const withP2 = chooseAIPlay(tacticalContext);
  const withoutP2 = chooseAIPlay({
    ...tacticalContext,
    policyFeatures: { p0: true, p1: true, p2: false, endgame: true },
  });
  assert(withP2?.hand?.type === 'single' && withP2.cards?.[0]?.rank === 14
    && withoutP2?.hand?.type === 'single' && withoutP2.cards?.[0]?.rank === 14,
  'P2 三路成本不能绕过统一评分，把逢人配拼四炸2错误提升到普通A之前');

  const pairedRuns = [5, 6, 7, 8, 9, 10]
    .flatMap((rank) => [C(rank, 'S'), C(rank, 'D')]);
  const runHistory = [3, 4].flatMap((rank, index) => ([
    { trickNumber: index + 1, seat: 3, action: 'play', cards: [C(rank, 'C')],
      hand: { type: 'single', size: 1, power: rank } },
    { trickNumber: index + 1, seat: 0, action: 'pass', cards: [] },
    { trickNumber: index + 1, seat: 1, action: 'pass', cards: [] },
    { trickNumber: index + 1, seat: 2, action: 'pass', cards: [] },
  ]));
  const safeBlock = chooseAIPlay(context(pairedRuns, {
    level: 2,
    lastHand: parseHand([C(4, 'H')], 2),
    lastSeat: 3,
    handCounts: [12, 12, 12, 8],
    publicHistory: runHistory,
    difficulty: 'master',
    deterministic: true,
    policyProfile: 'expert',
  }));
  assert(safeBlock?.hand?.type === 'single' && safeBlock.cards[0].rank === 5,
    '已有最小拆对可中断连续单张时，P2 不把同花顺当免费控制牌误炸');
}

console.log('P3 对家送型：残局送尺寸匹配且能穿过下家拦截的牌');
{
  const level = 2;
  const partner = 2;
  const downstreamEnemy = 1;
  const pairLow = [C(3, 'D'), C(3, 'C')];
  const pairHigh = [C(14, 'D'), C(14, 'C')];
  const straight5 = [C(7, 'S'), C(8, 'S'), C(9, 'S'), C(10, 'S'), C(11, 'S')];
  const publicHistory = [
    { turn: 1, trickNumber: 1, seat: partner, action: 'play', cards: pairLow,
      hand: { type: 'pair', size: 2, power: 3 } },
    { turn: 2, trickNumber: 1, seat: downstreamEnemy, action: 'pass', cards: [] },
    { turn: 3, trickNumber: 1, seat: 3, action: 'pass', cards: [] },
    { turn: 4, trickNumber: 1, seat: 0, action: 'pass', cards: [] },
    { turn: 5, trickNumber: 2, seat: partner, action: 'play', cards: pairHigh,
      hand: { type: 'pair', size: 2, power: 14 } },
    { turn: 6, trickNumber: 2, seat: downstreamEnemy, action: 'pass', cards: [] },
    { turn: 7, trickNumber: 2, seat: 3, action: 'pass', cards: [] },
    { turn: 8, trickNumber: 2, seat: 0, action: 'pass', cards: [] },
  ];
  const ctx = {
    seat: 0,
    hand: [...pairLow, ...pairHigh, ...straight5],
    level,
    handCounts: [10, 6, 3, 9],
    teams: TEAMS,
    finishOrder: [],
    publicHistory,
    mode: 'lead',
  };
  const model = inferPublicThreats(ctx);
  assert(model.partner.closing && model.partner.count === 3,
    '对家剩3张被识别为残局');
  const feedPair = publicCoordinationScore(
    { cards: pairLow, hand: parseHand(pairLow, level) }, ctx, model);
  assert(feedPair.tags.includes('partner_feed_size'),
    '对家剩3张时送对子（张数不超其手数）获得尺寸匹配加分');
  assert(feedPair.tags.includes('partner_feed_low'),
    '低点对子同时获得易接手加分');
  assert(feedPair.tags.includes('partner_feed_clean'),
    '下家对手对该型公开过牌时送型标记为可穿过拦截');
  const feedStraight = publicCoordinationScore(
    { cards: straight5, hand: parseHand(straight5, level) }, ctx, model);
  assert(!feedStraight.tags.includes('partner_feed_size'),
    '对家剩3张时送五张顺子尺寸超限，不获得送型加分');
  assert(feedPair.score > feedStraight.score,
    '残局对家优先送尺寸匹配的小牌而不是大组合');
}

console.log('E 残局满深度路线搜索（只搜自己手牌，不读/采样暗牌）');
{
  const level = 2;
  const endgameHand = [
    C(3, 'S'), C(4, 'H'), C(5, 'S'), C(6, 'H'), C(7, 'S'),
    C(9, 'D'), C(9, 'C'), C(10, 'S'),
  ];
  const routeA = estimateThreeStepRoute(endgameHand, level, {
    mode: 'lead',
    handCounts: [8, 5, 3, 9],
    finishOrder: [],
  }, { fullDepth: true, beam: 6, nodeBudget: 30000 });
  assert(routeA.fullDepth === true, '满深度搜索在返回结果中标记 fullDepth');
  assert(Number.isFinite(routeA.estimatedTricks)
    && Number.isFinite(routeA.loose)
    && Number.isFinite(routeA.controlsSpent)
    && Number.isFinite(routeA.bombsSpent)
    && Array.isArray(routeA.tags)
    && Array.isArray(routeA.reasons),
  '满深度搜索返回可解释的手数、散张、控制与炸弹消耗');

  // 硬约束：残局搜索只依赖（手牌,级牌），改变其它玩家的公开信息不得改变路线本身。
  const routeB = estimateThreeStepRoute(endgameHand, level, {
    mode: 'lead',
    handCounts: [8, 1, 12, 12],
    finishOrder: [1, 3],
  }, { fullDepth: true, beam: 6, nodeBudget: 30000 });
  const coreFields = (route) => [
    route.estimatedTricks, route.loose, route.controlsSpent,
    route.bombsSpent, route.firstType, route.truncated,
  ];
  assert(JSON.stringify(coreFields(routeA)) === JSON.stringify(coreFields(routeB)),
    '改变其它玩家手数/名次不会改变自己手牌的满深度路线（不采样暗牌）');

  // 节点预算防爆炸：超限时退回可用的有限估计而不是崩溃。
  const nineCards = [
    C(3, 'S'), C(4, 'H'), C(5, 'S'), C(6, 'H'), C(7, 'S'),
    C(9, 'D'), C(9, 'C'), C(10, 'S'), C(11, 'H'),
  ];
  const tiny = estimateThreeStepRoute(nineCards, level, {}, {
    fullDepth: true, beam: 6, nodeBudget: 500,
  });
  assert(tiny.truncated === true && Number.isFinite(tiny.estimatedTricks)
    && Number.isFinite(tiny.controlsSpent),
  '节点预算超限时满深度搜索退回下界估计并标记 truncated');

  const started = performance.now();
  estimateThreeStepRoute(endgameHand, level, {}, {
    fullDepth: true, beam: 6, nodeBudget: 30000,
  });
  assert(performance.now() - started < 200,
    '残局满深度搜索在 8 张手牌上保持快速（A/B 实时性不退化）');
}

console.log('G 限时迭代加深：预算换算与 deterministic 隔离');
{
  const base = { lookAheadRootLimit: 14, lookAheadFutureBeam: 5, lookAheadEndgameHand: 8 };
  const scaled = applySearchTimeBudget({ ...base }, 600);
  assert(scaled.lookAheadRootLimit === 18 && scaled.lookAheadFutureBeam === 6
    && scaled.lookAheadEndgameHand === 10,
  '预算≥400ms（slow）时加宽候选/beam 并加深残局门控');
  const mid = applySearchTimeBudget({ ...base }, 200);
  assert(mid.lookAheadRootLimit === 18 && mid.lookAheadEndgameHand === 10
    && mid.lookAheadFutureBeam === 5,
  '预算150-399ms（normal）时加宽候选与残局门控，不动 beam');
  const none = applySearchTimeBudget({ ...base }, 60);
  assert(none.lookAheadRootLimit === 14 && none.lookAheadEndgameHand === 8
    && none.lookAheadFutureBeam === 5,
  '预算<150ms（fast）不加搜索，避免抢 UI 时间片');
  assert(applySearchTimeBudget({ ...base }, 0).lookAheadRootLimit === 14,
    '无预算（deterministic/单测/教练）保持原配置');

  const detHand = [C(3), C(4), C(5), C(6), C(7), C(9), C(10), C(11), C(12), C(13)];
  const detCtx = {
    ...context(detHand, { difficulty: 'master', deterministic: true }),
    handCounts: [10, 9, 8, 12],
  };
  const withoutBudget = chooseAIPlay(detCtx);
  const withBudget = chooseAIPlay({ ...detCtx, timeBudgetMs: 600 });
  assert(JSON.stringify(withoutBudget) === JSON.stringify(withBudget),
    'deterministic 决策忽略 timeBudgetMs（A/B 镜像赛保持逐字节可复现）');
}

console.log('连续小单冲刺不会在中盘无限放行');
{
  const level = 6;
  const hand = [
    C(4, 'S'), C(4, 'H'), C(4, 'D'),
    C(7, 'S'), C(7, 'D'),
    C(8, 'S'), C(8, 'D'),
    C(9, 'S'), C(9, 'D'),
    C(10, 'S'), C(10, 'D'),
  ];
  const publicHistory = [3, 4, 5].flatMap((rank, index) => ([
    {
      turn: index * 4 + 1,
      trickNumber: index + 1,
      seat: 3,
      action: 'play',
      cards: [C(rank, 'C')],
      hand: { type: 'single', size: 1, power: rank },
    },
    { turn: index * 4 + 2, trickNumber: index + 1, seat: 0, action: 'pass', cards: [] },
    { turn: index * 4 + 3, trickNumber: index + 1, seat: 1, action: 'pass', cards: [] },
    { turn: index * 4 + 4, trickNumber: index + 1, seat: 2, action: 'pass', cards: [] },
  ]));
  const lastHand = parseHand([C(5, 'C')], level);
  const ctx = context(hand, {
    level,
    difficulty: 'master',
    deterministic: true,
    lastHand,
    lastSeat: 3,
    handCounts: [hand.length, 20, 20, 20],
    publicHistory,
  });
  const decision = chooseAIPlay(ctx);
  assert(decision?.action === 'play' && decision.hand.type === 'single',
    '对手尚有20张但连续三圈走单时，大师AI会主动截断而非继续机械过牌');
  assert(decision?.cards?.[0]?.rank === 7,
    '没有独立单张时先拆最小可接对子7，不从三张或更大对子中乱拆');
  const passRating = evaluatePlay({
    action: 'pass',
    cards: [],
    handBefore: hand,
    level,
    lastHand,
    lastSeat: 3,
    seat: 0,
    teams: TEAMS,
    handCounts: [hand.length, 20, 20, 20],
    finishOrder: [],
    publicHistory,
    difficulty: 'master',
  });
  assert(passRating.score < 60 && passRating.betterAlternative?.cards?.[0]?.rank === 7,
    '真人评价与电脑共用连续走单压力，继续过牌会被降分并推荐最小拆对7');
}

console.log('P0 控权风险不会反向鼓励大牌先打');
{
  const hand = [
    C(3, 'S'), C(3, 'H'), C(3, 'D'),
    C(6, 'S'), C(6, 'H'), C(6, 'D'),
    C(8, 'S'), C(8, 'D'), C(9, 'S'), C(9, 'D'),
    C(10, 'S'), C(10, 'D'), C(11, 'S'), C(11, 'D'),
    C(12, 'S'), C(12, 'D'), C(13, 'S'),
  ];
  const decision = chooseAIPlay(context(hand, {
    level: 7,
    handCounts: [17, 20, 20, 20],
    difficulty: 'master',
    deterministic: true,
    policyProfile: 'expert',
  }));
  assert(decision?.hand?.type === 'fullhouse' && decision.hand.mainRank === 3,
    '低牌容易被接不再成为扣分理由；有333带66时不先打666带33留小牌');
}

console.log('连续走单只拦截真实小单冲刺，不机械交王或级牌');
{
  const level = 6;
  const hand = [
    C(16, 'J'),
    C(7, 'S'), C(7, 'D'), C(8, 'S'), C(8, 'D'),
    C(9, 'S'), C(9, 'D'), C(10, 'S'), C(10, 'D'),
    C(11, 'S'), C(11, 'D'),
  ];
  const publicHistory = [
    { turn: 1, trickNumber: 1, seat: 3, action: 'play', cards: [C(3, 'C')], hand: { type: 'single', size: 1, power: 3 } },
    { turn: 2, trickNumber: 1, seat: 0, action: 'pass', cards: [] },
    { turn: 3, trickNumber: 1, seat: 1, action: 'pass', cards: [] },
    { turn: 4, trickNumber: 1, seat: 2, action: 'pass', cards: [] },
    { turn: 5, trickNumber: 2, seat: 3, action: 'play', cards: [C(4, 'C')], hand: { type: 'single', size: 1, power: 4 } },
    { turn: 6, trickNumber: 2, seat: 0, action: 'pass', cards: [] },
    { turn: 7, trickNumber: 2, seat: 1, action: 'pass', cards: [] },
    { turn: 8, trickNumber: 2, seat: 2, action: 'pass', cards: [] },
    { turn: 9, trickNumber: 3, seat: 3, action: 'play', cards: [C(14, 'C', 1)], hand: { type: 'single', size: 1, power: 14 } },
  ];
  const lastHand = parseHand([C(14, 'C', 1)], level);
  const ctx = context(hand, {
    level, lastHand, lastSeat: 3,
    handCounts: [hand.length, 20, 20, 20], publicHistory,
    difficulty: 'master', deterministic: true, policyProfile: 'expert',
  });
  const decision = chooseAIPlay(ctx);
  assert(decision?.action === 'pass',
    '对手依次走3、4、A时，A不是清理小单，不强交小王接牌');
  const passRating = evaluatePlay({
    action: 'pass', cards: [], handBefore: hand, level, lastHand, lastSeat: 3,
    seat: 0, teams: TEAMS, handCounts: [hand.length, 20, 20, 20],
    finishOrder: [], publicHistory, difficulty: 'master',
  });
  assert(passRating.score >= 60 && !passRating.mistakeTags.includes('missed_response'),
    '评价系统与AI同步认可保存小王，不再一边判优秀一边标记过早交王');

  const lowRunHistory = publicHistory.map((item) => {
    if (item.turn !== 9) return item;
    return {
      ...item,
      cards: [C(5, 'C', 1)],
      hand: { type: 'single', size: 1, power: 5 },
    };
  });
  const publicModel = inferPublicThreats(context(hand, {
    level,
    lastHand: parseHand([C(5, 'C', 1)], level),
    lastSeat: 3,
    handCounts: [hand.length, 20, 20, 20],
    publicHistory: lowRunHistory,
  }));
  assert(publicModel.history.controlStreak.singlePowers.join(',') === '5,4,3',
    '公开威胁模型保留连续单张点力，顶层决策能区分3、4、5冲刺与3、4、A');
  const lowRunDecision = chooseAIPlay(context(hand, {
    level,
    lastHand: parseHand([C(5, 'C', 1)], level),
    lastSeat: 3,
    handCounts: [hand.length, 20, 20, 20],
    publicHistory: lowRunHistory,
    difficulty: 'master', deterministic: true, policyProfile: 'expert',
  }));
  assert(lowRunDecision?.action === 'play'
      && lowRunDecision.hand?.type === 'single'
      && lowRunDecision.cards?.[0]?.rank === 7,
    '双方仍有十多张时，对手连续清3、4、5也会拆最小对7拦截，不再全程过牌');
}

console.log('P2 炸弹、普通接法与过牌三路正式比较');
{
  const level = 7;
  const hand = [
    C(3, 'S', 1), C(5, 'H', 1), C(7, 'H', 1),
    C(2, 'C', 0), C(2, 'H', 0), C(8, 'D', 1),
    C(11, 'D', 0), C(14, 'C', 0), C(10, 'H', 1),
    C(10, 'C', 1), C(11, 'H', 0), C(2, 'C', 1),
  ];
  const ctx = context(hand, {
    level,
    lastHand: parseHand([C(12, 'H')], level),
    lastSeat: 3,
    handCounts: [hand.length, 12, 12, 4],
    difficulty: 'master', deterministic: true, policyProfile: 'expert',
  });
  const decision = chooseAIPlay(ctx);
  assert(decision?.action === 'play'
      && decision.hand?.type === 'single'
      && decision.cards?.[0]?.rank === 14,
    '有普通A可接Q时，不用逢人配拼四炸2并拆顺子；三路比较选择普通A');
}

console.log('Grok复核：同型控权与炸弹资源风险分离');
{
  const level = 7;
  const cards = [C(17, 'J')];
  const play = { cards, hand: parseHand(cards, level) };
  const ctx = context(cards, {
    level,
    handCounts: [1, 27, 0, 27],
    finishOrder: [2],
    policyProfile: 'expert',
  });
  ctx.publicModel = inferPublicThreats(ctx);
  const model = createBeatModel(ctx);
  const typeRisk = orderedTeamControlLossProbability(play, ctx, model);
  const bombRisk = enemyBombExposureProbability(ctx, model);
  assert(typeRisk === 0 && bombRisk > 0.5,
    '大王没有更高同型普通单张时控权风险为0，敌方潜在炸弹另行保留为资源风险');

  const straight = [C(3, 'S'), C(4, 'D'), C(5, 'C'), C(6, 'H'), C(7, 'S')];
  const straightPlay = { cards: straight, hand: parseHand(straight, level) };
  const shortPartnerCtx = context(straight, {
    level,
    handCounts: [5, 16, 4, 16],
    policyProfile: 'expert',
  });
  shortPartnerCtx.publicModel = inferPublicThreats(shortPartnerCtx);
  const finishedPartnerCtx = {
    ...shortPartnerCtx,
    handCounts: [5, 16, 0, 16],
    finishOrder: [2],
  };
  finishedPartnerCtx.publicModel = inferPublicThreats(finishedPartnerCtx);
  const shortRisk = orderedTeamControlLossProbability(
    straightPlay, shortPartnerCtx, createBeatModel(shortPartnerCtx),
  );
  const noPartnerRisk = orderedTeamControlLossProbability(
    straightPlay, finishedPartnerCtx, createBeatModel(finishedPartnerCtx),
  );
  assert(Math.abs(shortRisk - noPartnerRisk) < 1e-12,
    '对家只剩4张时不再假设其能接回5张顺子，回手概率严格服从尺寸可行性');
}

console.log('P1 一层公开应手树：座位顺序、资源分支与概率守恒');
{
  const level = 7;
  const straight = [C(3, 'S'), C(4, 'D'), C(5, 'C'), C(6, 'H'), C(7, 'S')];
  const play = { cards: straight, hand: parseHand(straight, level) };
  const shortPartnerCtx = context(straight, {
    level,
    handCounts: [5, 12, 4, 12],
    difficulty: 'master', deterministic: true, policyProfile: 'expert',
  });
  shortPartnerCtx.publicModel = inferPublicThreats(shortPartnerCtx);
  const shortTree = evaluatePublicResponseTree(
    play, shortPartnerCtx, createBeatModel(shortPartnerCtx), { ownRemaining: 5 },
  );
  assert(Math.abs(shortTree.selfControl + shortTree.partnerControl
      + shortTree.enemyControl - 1) < 1e-9,
    '下家→对家→上家全部分支概率严格归一，团队与敌方结果不重不漏');
  assert(shortTree.partnerControl === 0,
    '对家只剩4张时，一层应手树不会虚构其接回5张顺子的分支');
  assert(shortTree.enemyBomb >= 0 && shortTree.enemyBomb <= shortTree.enemyControl + 1e-12,
    '敌方炸弹是敌方控权的资源消耗子集，不再与普通应手重复并集');

  const activePartnerCtx = {
    ...shortPartnerCtx,
    handCounts: [5, 12, 8, 12],
  };
  activePartnerCtx.publicModel = inferPublicThreats(activePartnerCtx);
  const activeTree = evaluatePublicResponseTree(
    play, activePartnerCtx, createBeatModel(activePartnerCtx), { ownRemaining: 5 },
  );
  assert(activeTree.partnerControl >= shortTree.partnerControl,
    '对家尺寸足够时才恢复接回分支，并按下一档最低合法应手评估而非固定折扣');

  const hiddenNoiseCtx = {
    ...activePartnerCtx,
    opponentHands: [[C(17, 'J')], [C(16, 'J')]],
    roundInitialHands: [[C(14)]],
  };
  hiddenNoiseCtx.publicModel = inferPublicThreats(hiddenNoiseCtx);
  const hiddenNoiseTree = evaluatePublicResponseTree(
    play, hiddenNoiseCtx, createBeatModel(hiddenNoiseCtx), { ownRemaining: 5 },
  );
  assert(Math.abs(hiddenNoiseTree.teamControl - activeTree.teamControl) < 1e-12,
    '即使调用者误带暗牌字段，公开应手树也完全忽略，决策边界仍只含本家牌与公开信息');
}

console.log('P3 搭档协同2.0：直接交接与公开风险护牌');
{
  const level = 2;
  const hand = [
    C(13, 'S'),
    C(5, 'S'), C(5, 'H'),
    C(6, 'S'), C(6, 'H'),
    C(8, 'S'), C(9, 'D'),
  ];
  const lastCards = [C(3, 'C', 1)];
  const lastHand = parseHand(lastCards, level);
  const ctx = context(hand, {
    level,
    lastHand,
    lastSeat: 2,
    handCounts: [hand.length, 6, 9, 11],
    difficulty: 'master', deterministic: true, policyProfile: 'expert',
    policyFeatures: resolvePolicyVariant('expert').policyFeatures,
  });
  ctx.publicModel = inferPublicThreats(ctx);
  const beatModel = createBeatModel(ctx);
  const king = { cards: [hand[0]], hand: parseHand([hand[0]], level) };
  const protection = publicPartnerProtectionValue(king, ctx, beatModel);
  assert(protection?.eligible && protection.reduction >= 0.16,
    '只有公开同型可接风险确实显著下降时，P3才允许用自然牌保护对家牌权');
  const shortPartnerCtx = {
    ...ctx,
    handCounts: [hand.length, 6, 4, 11],
  };
  shortPartnerCtx.publicModel = inferPublicThreats(shortPartnerCtx);
  assert(publicPartnerProtectionValue(
    king, shortPartnerCtx, createBeatModel(shortPartnerCtx),
  ) === null,
  '对家已经五张内时不机械抢其牌权，P3护牌门自动关闭');

  const expertDecision = chooseAIPlay(ctx);
  const noP3Decision = chooseAIPlay({
    ...ctx,
    publicModel: undefined,
    beatModel: undefined,
    policyFeatures: resolvePolicyVariant('no-p3').policyFeatures,
  });
  assert(expertDecision?.action === 'play' && expertDecision.cards?.[0]?.rank === 13,
    '对手进入推进窗口且K能无损显著降险时，P3用最低成本抬门保护团队牌权');
  assert(noP3Decision?.action === 'pass',
    'no-p3 在同一牌面恢复机械让牌，形成可归因的独立消融对照');
  const passRating = evaluatePlay({
    action: 'pass', cards: [], handBefore: hand, level, lastHand, lastSeat: 2,
    seat: 0, teams: TEAMS, handCounts: [hand.length, 6, 9, 11], finishOrder: [],
    publicHistory: [], difficulty: 'master',
    policyFeatures: resolvePolicyVariant('expert').policyFeatures,
  });
  assert(passRating.mistakeTags.includes('missed_partner_cover'),
    '真人评价与P3电脑决策共用同一公开风险差，不再出现AI和评分相反');

  const pair = [C(9, 'S'), C(9, 'H')];
  const lead = { cards: pair, hand: parseHand(pair, level) };
  const handoffCtx = context(pair, {
    level,
    handCounts: [2, 10, 6, 10],
    policyProfile: 'expert',
  });
  handoffCtx.publicModel = inferPublicThreats(handoffCtx);
  const withoutHandoff = evaluatePublicResponseTree(
    lead, handoffCtx, createBeatModel(handoffCtx), { ownRemaining: 2 },
  );
  const withHandoff = evaluatePublicResponseTree(
    lead, handoffCtx, createBeatModel(handoffCtx), {
      ownRemaining: 2,
      includePartnerHandoff: true,
    },
  );
  assert(withHandoff.branches.partnerDirect > 0
      && withHandoff.partnerControl >= withoutHandoff.partnerControl,
    'P3补齐“下家过牌→对家直接接手→上家反压”的真实座位分支');
}

console.log('P4受限残局rollout与P5置信融合');
{
  const level = 2;
  const fullHand = [
    C(10, 'S'),
    C(3, 'S'), C(3, 'H'),
    C(4, 'S'), C(4, 'H'),
    C(6, 'D'),
  ];
  const opening = { cards: [fullHand[0]], hand: parseHand([fullHand[0]], level) };
  const remain = fullHand.slice(1);
  const ctx = context(fullHand, {
    level,
    handCounts: [fullHand.length, 5, 4, 6],
    policyProfile: 'expert',
  });
  ctx.publicModel = inferPublicThreats(ctx);
  const model = createBeatModel(ctx);
  const rollout = evaluatePublicEndgameRollout(opening, remain, ctx, model, {
    branchLimit: 4,
    nodeBudget: 7,
    includePartnerHandoff: true,
  });
  assert(Number.isFinite(rollout?.expectedUtility) && rollout.nodes <= 7
      && rollout.depth === 2 && !rollout.timedOut,
    'P4只展开本家下一次领出并严格服从节点预算，返回可解释的两层期望');
  const privateNoiseCtx = {
    ...ctx,
    opponentHands: [[C(17, 'J')]],
    roundInitialHands: [[C(16, 'J')]],
  };
  privateNoiseCtx.publicModel = inferPublicThreats(privateNoiseCtx);
  const privateNoise = evaluatePublicEndgameRollout(
    opening,
    remain,
    privateNoiseCtx,
    createBeatModel(privateNoiseCtx),
    { branchLimit: 4, nodeBudget: 7, includePartnerHandoff: true },
  );
  assert(Math.abs(rollout.expectedUtility - privateNoise.expectedUtility) < 1e-12,
    '改变暗牌噪声不会改变P4结果，rollout不采样或读取对手手牌');
  const timedOut = evaluatePublicEndgameRollout(opening, remain, ctx, model, {
    branchLimit: 4, nodeBudget: 7, deadlineMs: 0, now: () => 1,
  });
  assert(timedOut?.timedOut,
    'P4墙钟已到时返回超时标志，调用层可整批丢弃并安全回退P0-P3');

  const fused = calibratePolicyFusionValues([
    { p1: 20, p3: 8, p4: 12 },
    { p1: 0, p3: 0, p4: 0 },
    { p1: -20, p3: -8, p4: -12 },
  ], 24);
  assert(fused.length === 3 && fused[0] > fused[1] && fused[1] > fused[2],
    'P5有界融合保持候选优先级单调，不把正负牌权信号颠倒');
  assert(Math.abs(fused.reduce((sum, value) => sum + value, 0)) < 1e-12
      && fused.every((value) => Math.abs(value) <= 24 + 1e-12),
    'P5重新中心化且限制相关模块叠分幅度，避免P1/P3/P4重复计权失控');
}

console.log('Grok复核：安全自然小牌低成本接管，而非第一圈无条件硬拦');
{
  const level = 2;
  const hand = [
    C(7, 'S'), C(9, 'S'), C(9, 'H'), C(10, 'S'), C(10, 'H'),
    C(12, 'S'), C(12, 'H'), C(13, 'S'), C(13, 'H'), C(14, 'S'), C(14, 'H'),
  ];
  const lastHand = parseHand([C(3, 'C', 1)], level);
  const ctx = context(hand, {
    level, lastHand, lastSeat: 3,
    handCounts: [hand.length, 20, 20, 20],
    difficulty: 'master', deterministic: true, policyProfile: 'expert',
  });
  const decision = recommendPlay(ctx);
  const optional7 = evaluateStrategicPlay(
    { cards: [hand[0]], hand: parseHand([hand[0]], level) },
    {
      hand, level, mode: 'beat', lastHand, lastSeat: 3, seat: 0, teams: TEAMS,
      handCounts: [hand.length, 20, 20, 20], finishOrder: [],
      policyProfile: 'expert', strategyWeight: 1,
    },
  );
  assert(optional7.tags.includes('cheap_control_option')
      && !optional7.tags.includes('cheap_control_take')
      && decision?.action,
    '双方仍有十多张且没有连续压力时，独立7只作零加分候选，不升级为必须接牌');
  const passRating = evaluatePlay({
    action: 'pass', cards: [], handBefore: hand, level, lastHand, lastSeat: 3,
    seat: 0, teams: TEAMS, handCounts: [hand.length, 20, 20, 20], finishOrder: [],
    difficulty: 'master',
  });
  assert(passRating.score >= 60 && !passRating.mistakeTags.includes('missed_response'),
    '评价系统与AI同步认可非紧急中盘保存牌权');

  const urgentCtx = context(hand, {
    level, lastHand, lastSeat: 3,
    handCounts: [hand.length, 20, 20, 8],
    difficulty: 'master', deterministic: true, policyProfile: 'expert',
  });
  const urgentDecision = recommendPlay(urgentCtx);
  assert(urgentDecision?.action === 'play' && urgentDecision.cards?.[0]?.rank === 7,
    '对手进入十张内收官区时用独立7低成本截断，不再把散单全部放过');
  const urgentPassRating = evaluatePlay({
    action: 'pass', cards: [], handBefore: hand, level, lastHand, lastSeat: 3,
    seat: 0, teams: TEAMS, handCounts: [hand.length, 20, 20, 8], finishOrder: [],
    difficulty: 'master',
  });
  assert(urgentPassRating.score < 60
      && urgentPassRating.betterAlternative?.cards?.[0]?.rank === 7,
    '紧急低成本接管时评价系统与AI推荐同一张独立7');

  const readyFullHouse = [
    C(7, 'S'), C(7, 'H'), C(7, 'D'), C(9, 'S'), C(9, 'H'),
  ];
  const triple7 = readyFullHouse.slice(0, 3);
  const pair9 = readyFullHouse.slice(3);
  const sharedFullHouseCtx = {
    hand: readyFullHouse, level, mode: 'beat', lastSeat: 3, seat: 0,
    teams: TEAMS, handCounts: [5, 20, 20, 20], finishOrder: [],
    policyProfile: 'expert', strategyWeight: 1,
  };
  const tripleStrategy = evaluateStrategicPlay(
    { cards: triple7, hand: parseHand(triple7, level) },
    { ...sharedFullHouseCtx, lastHand: parseHand([C(6, 'S'), C(6, 'H'), C(6, 'D')], level) },
  );
  const pairStrategy = evaluateStrategicPlay(
    { cards: pair9, hand: parseHand(pair9, level) },
    { ...sharedFullHouseCtx, lastHand: parseHand([C(8, 'S'), C(8, 'H')], level) },
  );
  assert(tripleStrategy.tags.includes('split_ready_fullhouse')
      && !tripleStrategy.tags.includes('cheap_control_take')
      && !pairStrategy.tags.includes('cheap_control_take'),
    '777加99是现成三带二；三张7或对子9都不能冒充零损伤安全接牌');

  const ace = C(14, 'S');
  const aceStrategy = evaluateStrategicPlay(
    { cards: [ace], hand: parseHand([ace], level) },
    {
      hand: [ace, C(9, 'S'), C(9, 'H')], level, mode: 'beat', lastHand,
      lastSeat: 3, seat: 0, teams: TEAMS, handCounts: [3, 20, 20, 20],
      finishOrder: [], policyProfile: 'expert', strategyWeight: 1,
    },
  );
  assert(!aceStrategy.tags.includes('cheap_control_take'),
    '普通A不会被低成本接管规则误标成必须接，仍交给牌权与资源收益权衡');
  const premiumOnly = [
    C(16, 'J'), C(9, 'S'), C(9, 'H'), C(10, 'S'), C(10, 'H'),
    C(12, 'S'), C(12, 'H'), C(13, 'S'), C(13, 'H'),
  ];
  const premiumDecision = chooseAIPlay(context(premiumOnly, {
    level, lastHand, lastSeat: 3,
    handCounts: [premiumOnly.length, 20, 20, 20],
    difficulty: 'master', deterministic: true, policyProfile: 'expert',
  }));
  assert(premiumDecision?.action === 'pass',
    '只有王或需要拆对子时仍允许保存资源，安全接管不是“第一圈任何牌都必须接”');
}

console.log('Grok复核：短手威胁下以安全普通牌抬高对家牌');
{
  const level = 2;
  const hand = [
    C(10, 'S'), C(6, 'S'), C(6, 'H'), C(8, 'S'), C(8, 'H'),
    C(11, 'S'), C(11, 'H'), C(13, 'S'), C(13, 'H'),
  ];
  const lastHand = parseHand([C(3, 'D', 1)], level);
  const base = context(hand, {
    level, lastHand, lastSeat: 2,
    handCounts: [hand.length, 4, 12, 9],
    difficulty: 'master', deterministic: true, policyProfile: 'expert',
  });
  const defaultDecision = recommendPlay(base);
  assert(defaultDecision?.action === 'pass',
    '正式大师策略维持让对家控牌，不因下家四张就机械抬牌');
  const defaultPass = evaluatePlay({
    action: 'pass', cards: [], handBefore: hand, level, lastHand, lastSeat: 2,
    seat: 0, teams: TEAMS, handCounts: [hand.length, 4, 12, 9], finishOrder: [],
    difficulty: 'master',
  });
  assert(defaultPass.score >= 60 && !defaultPass.mistakeTags.includes('missed_partner_cover'),
    '评价系统与正式策略同步，不把未经验证的护牌实验当成人类失误');

  const coverVariant = resolvePolicyVariant('only-partner-cover');
  const experimental = {
    ...base,
    policyProfile: coverVariant.policyProfile,
    policyFeatures: coverVariant.policyFeatures,
  };
  const cover = recommendPlay(experimental);
  assert(cover?.action === 'play' && cover.cards?.[0]?.rank === 10,
    '独立实验臂仍可测试用散单10抬高对家3的护牌假设');
  const coverPass = evaluatePlay({
    action: 'pass', cards: [], handBefore: hand, level, lastHand, lastSeat: 2,
    seat: 0, teams: TEAMS, handCounts: [hand.length, 4, 12, 9], finishOrder: [],
    difficulty: 'master', policyFeatures: coverVariant.policyFeatures,
  });
  assert(coverPass.score < 50
      && coverPass.mistakeTags.includes('missed_partner_cover'),
    '实验评价臂与实验AI共用同一个护牌开关');
  const noThreat = chooseAIPlay({
    ...experimental, handCounts: [hand.length, 9, 12, 9],
  });
  assert(noThreat?.action === 'pass',
    '下家仍有9张时维持默认让对家控牌，不全局降低队友让牌率');
}

console.log('公开送型尺寸与数清大牌后的锁牌领出');
{
  const level = 9;
  const straight = [C(3), C(4), C(5), C(6), C(7)];
  const oversize = publicCoordinationScore(
    { cards: straight, hand: parseHand(straight, level) },
    context(straight, { level, handCounts: [5, 10, 4, 10] }),
    {
      partner: {
        needsSupport: true, count: 4, closing: true,
        preferredLeadType: 'straight', preferredLeadCount: 3,
      },
      enemies: [],
    },
  );
  assert(!oversize.tags.includes('partner_closing_route'),
    '对家只剩4张时，历史上曾走顺子也不能给5张顺子虚构回手/送型收益');

  const hand = [
    C(3, 'S'), C(6, 'S'), C(6, 'H'), C(8, 'S'), C(8, 'H'),
    C(10, 'S'), C(10, 'H'), C(13, 'D'),
  ];
  const king = hand.find((card) => card.rank === 13);
  const playedCards = createDeck().filter((card) => (
    soloPower(card, level) > soloPower(king, level)
  ));
  const play = { cards: [king], hand: parseHand([king], level) };
  const strategy = evaluateStrategicPlay(play, {
    hand, level, mode: 'lead', seat: 0, teams: TEAMS,
    handCounts: [hand.length, 4, 12, 12], finishOrder: [], playedCards,
    policyProfile: 'expert', strategyWeight: 1,
  });
  assert(strategy.tags.includes('public_lock_lead'),
    '下家五张内且公开牌池已数清更高单张时，允许把K作为角色化锁牌领出');
  const lockLead = chooseAIPlay(context(hand, {
    level, handCounts: [hand.length, 4, 12, 12], playedCards,
    difficulty: 'master', deterministic: true, policyProfile: 'expert',
  }));
  assert(lockLead?.action === 'play' && lockLead.cards?.[0]?.rank === 13,
    '锁牌条件成立时实际选择已数清的K，不再机械永远先出最小单3');
}

console.log('8月25日真实复盘：团队名次下延迟整手强控出完');
{
  const level = 14;
  const flushFinish = [
    C(14, 'H', 1), C(8, 'S'), C(9, 'S'), C(10, 'S', 1), C(11, 'S', 1),
  ];
  const lastHand = parseHand([C(12, 'H'), C(12, 'D'), C(12, 'C')], level);
  const replayCtx = context(flushFinish, {
    level, lastHand, lastSeat: 3,
    handCounts: [5, 12, 20, 15],
    difficulty: 'master', deterministic: true, policyProfile: 'expert',
  });
  const delayed = recommendPlay(replayCtx);
  assert(delayed?.action === 'pass'
      && delayed.tacticalConstraint === 'team_finish_delay',
    '整手同花顺面对普通三张时不再被“一手出完”硬门提前截断，可等待反压帮助对家争名次');
  assert(delayed.reason.includes('团队名次') || delayed.reason.includes('对家'),
    '教练明确说明延迟出完服务于团队名次，而不是无目的惜炸');

  const passRating = evaluatePlay({
    action: 'pass', cards: [], handBefore: flushFinish, level, lastHand, lastSeat: 3,
    seat: 0, teams: TEAMS, handCounts: [5, 12, 20, 15], finishOrder: [],
    difficulty: 'master',
  });
  assert(passRating.score >= 80 && !passRating.mistakeTags.includes('missed_finish'),
    '评价与本地AI共用团队名次判断，不再一边建议过牌、一边判错失出完');

  const consultation = getAIConsultation(replayCtx);
  assert(consultation.cloudConstraint === 'team_finish_delay'
      && consultation.candidates.length === 1
      && consultation.candidates[0].action === 'pass',
    '云端增强不能绕过本地团队名次硬边界，把战略等待改回立即出完');

  const withoutDelay = resolvePolicyVariant('no-team-finish-delay');
  const ablated = recommendPlay({
    ...replayCtx,
    policyFeatures: withoutDelay.policyFeatures,
  });
  assert(ablated?.action === 'play' && ablated.cards.length === flushFinish.length,
    '关闭团队延迟模块后恢复旧的一手出完行为，形成独立可归因消融');
}

console.log('8月25日真实复盘：五张硬残局允许最低损伤拆炸接牌');
{
  const level = 14;
  const hand = [
    C(14, 'H'), C(14, 'C'), C(8, 'C'),
    C(6, 'H'), C(6, 'S'), C(6, 'D'), C(6, 'C'), C(6, 'S', 1),
    C(5, 'C'), C(3, 'C'), C(2, 'S'), C(2, 'C'),
  ];
  const lastHand = parseHand([C(4, 'H'), C(4, 'S'), C(4, 'D')], level);
  const replayCtx = context(hand, {
    seat: 1, level, lastHand, lastSeat: 0,
    handCounts: [5, hand.length, 20, 18],
    difficulty: 'master', deterministic: true, policyProfile: 'expert',
  });
  const block = recommendPlay(replayCtx);
  assert(block?.action === 'play'
      && block.hand.type === 'triple'
      && block.hand.mainRank === 6,
    '对手仅剩五张时从五张6中取最小三张6拦截，不再为保炸弹整手过牌');

  const passRating = evaluatePlay({
    action: 'pass', cards: [], handBefore: hand, level, lastHand, lastSeat: 0,
    seat: 1, teams: TEAMS, handCounts: [5, hand.length, 20, 18], finishOrder: [],
    difficulty: 'master',
  });
  assert(passRating.score < 50
      && passRating.mistakeTags.includes('missed_pressure_response')
      && passRating.betterAlternative?.hand?.mainRank === 6,
    '评价系统同步指出五张压力区的最低损伤三张6，不再把过牌评为保存结构');

  const playRating = evaluatePlay({
    action: 'play', cards: block.cards, handBefore: hand, level, lastHand, lastSeat: 0,
    seat: 1, teams: TEAMS, handCounts: [5, hand.length, 20, 18], finishOrder: [],
    difficulty: 'master',
  });
  assert(playRating.score >= 70 && !playRating.mistakeTags.includes('split_bomb'),
    '为阻断五张对手而条件性拆炸获得战术认可，不再被旧结构规则反向判错');

  const withoutBlock = resolvePolicyVariant('no-emergency-ordinary-block');
  const ablated = recommendPlay({
    ...replayCtx,
    policyFeatures: withoutBlock.policyFeatures,
  });
  assert(ablated?.action === 'pass',
    '关闭五张普通拦截模块后复现旧的死保炸弹过牌，消融边界独立有效');
}

console.log('8月25日真实复盘：同损伤接三张使用最小充分点数');
{
  const level = 14;
  const fives = [C(5, 'S'), C(5, 'H'), C(5, 'D'), C(5, 'C')];
  const queens = [C(12, 'S'), C(12, 'H'), C(12, 'D'), C(12, 'C')];
  const hand = [...fives, ...queens, C(2, 'S'), C(2, 'D')];
  const lastHand = parseHand([C(4, 'S', 1), C(4, 'H', 1), C(4, 'D', 1)], level);
  const decision = recommendPlay(context(hand, {
    seat: 3, level, lastHand, lastSeat: 0,
    handCounts: [5, 12, 20, hand.length],
    difficulty: 'master', deterministic: true, policyProfile: 'expert',
  }));
  assert(decision?.action === 'play'
      && decision.hand.type === 'triple'
      && decision.hand.mainRank === 5,
    '三张5和三张Q都需拆四炸时，严格选择最小充分的三张5，不再先交Q');
}

console.log('8月25日真实复盘：十张软压力保留为独立实验臂');
{
  const level = 2;
  // 2026/8/25 13:36:01 第35手的真实剩余牌：普通5到9顺子必须拆掉
  // 已成型黑桃同花顺，旧策略因此整手过牌。
  const hand = [
    C(2, 'D', 1), C(14, 'D', 1), C(9, 'S'),
    C(8, 'H'), C(8, 'S'), C(7, 'H'), C(7, 'S', 1),
    C(6, 'S', 1), C(5, 'S', 1), C(3, 'S'), C(3, 'S', 1),
  ];
  const lastHand = parseHand([
    C(2, 'D'), C(3, 'H', 1), C(4, 'C'), C(5, 'C'), C(6, 'C', 1),
  ], level);
  const replayCtx = context(hand, {
    seat: 1, level, lastHand, lastSeat: 2,
    handCounts: [10, hand.length, 22, 16],
    difficulty: 'master', deterministic: true, policyProfile: 'expert',
  });
  const formalDecision = recommendPlay(replayCtx);
  assert(formalDecision?.action === 'pass',
    '未见种子镜像赛负向后，正式大师不再把十张软压力作为强制接牌规则');
  const softVariant = resolvePolicyVariant('with-soft-ordinary-pressure');
  const pressurePlay = recommendPlay({
    ...replayCtx,
    policyFeatures: softVariant.policyFeatures,
  });
  assert(pressurePlay?.action === 'play' && pressurePlay.hand.type === 'straight',
    '显式实验臂仍可研究十张压力区的最低损伤普通顺子接法');
  assert(pressurePlay.cards.some((card) => card.suit !== 'S'),
    '压力区使用普通混花顺子，不把成品同花顺直接当炸弹浪费');

  const levelPairOnly = [
    C(2, 'S'), C(2, 'D'), C(3, 'S'), C(3, 'D'), C(6, 'S'), C(9, 'D'),
  ];
  const preserveLevel = recommendPlay(context(levelPairOnly, {
    seat: 3, level,
    lastHand: parseHand([C(4, 'S'), C(4, 'D')], level),
    lastSeat: 2,
    handCounts: [10, 12, 22, levelPairOnly.length],
    difficulty: 'master', deterministic: true, policyProfile: 'expert',
    policyFeatures: softVariant.policyFeatures,
  }));
  const preserveLevelAblated = recommendPlay(context(levelPairOnly, {
    seat: 3, level,
    lastHand: parseHand([C(4, 'S'), C(4, 'D')], level),
    lastSeat: 2,
    handCounts: [10, 12, 22, levelPairOnly.length],
    difficulty: 'master', deterministic: true, policyProfile: 'expert',
  }));
  assert(preserveLevel?.action === preserveLevelAblated?.action
      && (preserveLevel?.cards || []).map((card) => card.id).sort().join(',')
        === (preserveLevelAblated?.cards || []).map((card) => card.id).sort().join(','),
    '即使显式开启软压力实验，也不把非红桃级牌对子当普通小对额外提升');
}

console.log('8月25日真实复盘：跨牌型大量减牌后的控圈截断实验');
{
  const level = 14;
  const hand = [
    C(17, 'J'), C(14, 'H'), C(13, 'H'), C(13, 'S'),
    C(8, 'S'), C(7, 'S'), C(5, 'S'), C(4, 'H'), C(4, 'S'),
  ];
  const steel = [
    C(4, 'H', 1), C(4, 'D'), C(4, 'D', 1),
    C(5, 'H'), C(5, 'S'), C(5, 'C'),
  ];
  const singleTen = [C(10, 'H')];
  const publicHistory = [
    {
      trickNumber: 13, seat: 2, action: 'play', cards: steel,
      hand: parseHand(steel, level),
      countsBefore: [9, 9, 19, 13], countsAfter: [9, 9, 13, 13],
    },
    ...[3, 0, 1].map((seat) => ({
      trickNumber: 13, seat, action: 'pass', cards: [],
      countsBefore: [9, 9, 13, 13], countsAfter: [9, 9, 13, 13],
    })),
    {
      trickNumber: 14, seat: 2, action: 'play', cards: singleTen,
      hand: parseHand(singleTen, level),
      countsBefore: [9, 9, 13, 13], countsAfter: [9, 9, 12, 13],
    },
    ...[3, 0].map((seat) => ({
      trickNumber: 14, seat, action: 'pass', cards: [],
      countsBefore: [9, 9, 12, 13], countsAfter: [9, 9, 12, 13],
    })),
  ];
  const replayCtx = context(hand, {
    seat: 1, level, lastHand: parseHand(singleTen, level), lastSeat: 2,
    handCounts: [9, hand.length, 12, 13], publicHistory,
    difficulty: 'master', deterministic: true, policyProfile: 'expert',
  });
  const formal = recommendPlay(replayCtx);
  assert(formal?.action === 'pass',
    '正式策略仍保留原行为，真实复盘新规则在通过镜像赛前不会偷渡上线');

  const experimental = resolvePolicyVariant('with-high-shed-run-block');
  const blocked = recommendPlay({
    ...replayCtx,
    policyFeatures: experimental.policyFeatures,
  });
  assert(blocked?.action === 'play'
      && blocked.hand.type === 'single'
      && blocked.hand.mainRank === 13
      && blocked.reason.includes('减牌'),
    '对手用钢板加单张连续减掉7张后，实验臂拆最小K对截断，不再继续整手过牌或交大王');
}

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
