/**
 * 出牌评价系统
 * 对真人每次出牌/过牌打分，并给出可操作的改进建议
 */

import { isWild, isJoker, removeCards, cardLabel } from './cards.js';
import {
  generateLegalPlays, HandType, formatHand, parseHand, handSignature,
} from './rules.js';
import {
  analyzeSingleRunPressure, countDisjointStraights, countPotentialBombs, createStrategicMemo,
  downstreamEnemyNeedsBlock, evaluateStrategicPlay, selectEmergencyBlock,
  strategicCandidateScore, wholeHandPlay, assessTeamFinishDelay,
  selectPressureOrdinaryResponse,
} from './strategy-core.js';
import {
  createBeatModel, inferPublicThreats, publicPartnerProtectionValue,
} from './ai-route.js';

const GRADE = [
  { min: 90, label: '神来之笔', star: 5, color: '#f5c542' },
  { min: 75, label: '优秀', star: 4, color: '#6bcb77' },
  { min: 60, label: '良好', star: 3, color: '#4d96ff' },
  { min: 40, label: '一般', star: 2, color: '#a0aec0' },
  { min: 0, label: '待改进', star: 1, color: '#ff6b6b' },
];

const DIMENSION_DEFS = {
  cooperation: '配合',
  resources: '资源',
  structure: '结构',
  endgame: '残局',
  defense: '防守',
};

/**
 * 评价一次操作
 * @returns {{score, grade, stars, tips[], summary, betterAlternative?, dimensions, breakdown, mistakeTags}}
 */
export function evaluatePlay(ctx) {
  const {
    action, // 'play' | 'pass'
    cards,
    handBefore,
    level,
    lastHand,
    lastSeat,
    seat,
    teams = [0, 1, 0, 1],
    handCounts = [99, 99, 99, 99],
    finishOrder = [],
    playedCards = [],
    publicHistory = [],
    tributeContext = null,
    difficulty = 'master',
    leadAfterOwnBomb = false,
    policyFeatures = null,
  } = ctx;

  const tips = [];
  let score = 70; // 基准分
  let betterAlternative = null;
  const assessment = createAssessment();
  const apply = (dimension, delta, tag, message) => {
    score += recordImpact(assessment, tips, dimension, delta, tag, message);
  };

  const legal = generateLegalPlays(handBefore, level, lastHand);
  const myTeam = teams[seat];
  const isTeammateLead = lastSeat != null && teams[lastSeat] === myTeam && lastSeat !== seat;

  if (action === 'pass') {
    return evaluatePass({
      legal, lastHand, lastSeat, isTeammateLead, handBefore, handCounts, seat, teams, tips, score,
      finishOrder, assessment, level, playedCards, publicHistory, difficulty, policyFeatures,
    });
  }

  // 出牌
  const parsed = ctx.playedHand || parseHand(cards, level);
  if (!parsed) {
    const invalidAssessment = createAssessment();
    const invalidTips = [];
    recordImpact(
      invalidAssessment,
      invalidTips,
      'structure',
      -70,
      'invalid_play',
      '非法牌型，不符合掼蛋规则。',
    );
    return makeResult(0, invalidTips, '无效出牌', invalidAssessment);
  }

  const strategyCtx = {
    hand: handBefore,
    level,
    mode: lastHand ? 'beat' : 'lead',
    lastHand,
    lastSeat,
    seat,
    teams,
    handCounts,
    finishOrder,
    playedCards,
    publicHistory,
    tributeContext,
    difficulty,
    policyProfile: 'expert',
    policyFeatures,
    strategyWeight: 1,
    leadAfterOwnBomb,
    strategyMemo: createStrategicMemo(handBefore, level),
  };
  const sharedStrategy = evaluateStrategicPlay({ cards, hand: parsed }, strategyCtx);
  const createsTwoStepFinish = sharedStrategy.createsTwoStepFinish;
  score += applyEvents(assessment, tips, sharedStrategy.events);

  // The parser/game legality check is authoritative. The candidate generator
  // is intentionally heuristic, so a legal edge-case play missing from its
  // shortlist must not receive a silent structure penalty.

  // 1) 能一次出完却没出完
  const finishOpts = legal.filter((p) => p.cards.length === handBefore.length);
  if (finishOpts.length && cards.length < handBefore.length) {
    apply(
      'endgame',
      -35,
      'missed_finish',
      '你本可以一次出完手牌争上游，却选择了拆出部分牌。优先出完是硬道理。',
    );
    betterAlternative = finishOpts[0];
  }

  // 2) 炸弹使用时机
  if (isBombType(parsed)) {
    const bombEval = evalBombTiming(
      parsed, lastHand, handBefore, handCounts, seat, teams, legal, createsTwoStepFinish,
    );
    score += applyEvents(assessment, tips, bombEval.events);
    if (bombEval.better) betterAlternative = betterAlternative || bombEval.better;
  }

  // 3) 压队友
  if (isTeammateLead && lastHand) {
    const urgentBlock = downstreamEnemyNeedsBlock(lastHand, {
      seat, teams, handCounts, finishOrder,
    });
    if (cards.length === handBefore.length) {
      apply(
        'endgame',
        12,
        null,
        '虽然接了队友的牌，但本手可以直接出完；此时争取名次更重要。',
      );
    } else if (urgentBlock) {
      const downstream = (seat + 1) % 4;
      apply(
        'defense',
        10,
        null,
        `下家只剩 ${handCounts[downstream]} 张，及时抬高对家的牌可阻止对手直接走完。`,
      );
    } else {
      apply(
        'cooperation',
        -25,
        'over_teammate',
        '压了队友的牌，容易打断对家节奏。除非你能出完或有明确控牌需要，否则应选择过牌。',
      );
    }
  }

  // 4) 用牌效率：是否存在更小的同型可压
  if (lastHand && !isBombType(parsed) && !isTeammateLead) {
    const playedStructureCost = structureCost(handBefore, cards, level);
    const sameType = legal
      .filter((p) => p.hand.type === parsed.type
        && !isBombType(p.hand)
        // “更小”不能以拆对子、三张或炸弹为代价。
        && structureCost(handBefore, p.cards, level) <= playedStructureCost)
      .sort((a, b) => (
        structureCost(handBefore, a.cards, level) - structureCost(handBefore, b.cards, level)
        || a.hand.power - b.hand.power
      ));
    const efficient = sameType[0];
    if (efficient && efficient.hand.power < parsed.power - 0.5) {
      const waste = parsed.power - efficient.hand.power;
      if (waste >= 2) {
        apply(
          'resources',
          -Math.min(20, waste * 3),
          'overpower',
          `存在不增加拆牌损失的更小牌也可压上家（${formatCards(efficient.cards)}），大牌应留作关键控制。`,
        );
        betterAlternative = betterAlternative || efficient;
      }
    }
  }

  // 5) 逢人配浪费
  const wildUsed = cards.filter((c) => isWild(c, level));
  if (wildUsed.length) {
    const withoutWildAlt = legal.find(
      (p) => p.hand.type === parsed.type
        && p.hand.power >= (lastHand ? lastHand.power + 0.01 : 0)
        && !p.cards.some((c) => isWild(c, level))
        && (!lastHand || p.hand.power > lastHand.power || isBombType(p.hand)),
    );
    if (isBombType(parsed)) {
      apply('resources', 5, null, '用逢人配组成炸弹/同花顺，属于合理的强力用法。');
    // 领出用逢人配配普通小牌
    } else if (!lastHand) {
      apply(
        'resources',
        -15 * wildUsed.length,
        'waste_wild',
        '领出时使用逢人配较浪费，建议保留逢人配用于凑炸弹、同花顺或关键承接。',
      );
    } else if (withoutWildAlt && !isBombType(parsed)) {
      apply(
        'resources',
        -12 * wildUsed.length,
        'waste_wild',
        '本手本可不用逢人配，万能牌是整局最灵活的资源。',
      );
      betterAlternative = betterAlternative || withoutWildAlt;
    }
  }

  // 6) 拆牌结构
  const struct = evalStructure(handBefore, cards, level, parsed, sharedStrategy);
  score += applyEvents(assessment, tips, struct.events);

  // 7) 领出策略
  if (!lastHand) {
    const lead = evalLead(parsed, cards, handBefore, level, legal);
    score += applyEvents(assessment, tips, lead.events);
    if (lead.better) betterAlternative = betterAlternative || lead.better;
  }

  // 8) 残局意识
  const enemyMin = Math.min(
    ...handCounts.map((c, i) => (
      teams[i] !== myTeam && !finishOrder.includes(i) ? c : 99
    )),
  );
  if (enemyMin <= 3 && !isBombType(parsed) && lastHand && parsed.power < 12) {
    // 应该更积极或准备炸弹
    const bombs = legal.filter((p) => isBombType(p.hand));
    if (bombs.length && enemyMin <= 2) {
      apply(
        'defense',
        -8,
        'weak_defense',
        `对方仅剩 ${enemyMin} 张，应考虑用炸弹阻断其出完。`,
      );
    }
  }

  // 9) 王的使用
  const jokers = cards.filter(isJoker);
  if (jokers.length && !isBombType(parsed) && handBefore.length > 8) {
    if (parsed.type === HandType.SINGLE && parsed.mainRank >= 16) {
      apply(
        'resources',
        -10,
        'premature_joker',
        '过早打出王牌，中盘王是防炸与收圈的重要手段。',
      );
    }
  }

  // 10) 过牌本可轻松接却选择了出超大牌
  if (lastHand && isBombType(parsed) && !isBombType(lastHand) && !createsTwoStepFinish) {
    const easy = legal.filter((p) => !isBombType(p.hand) && p.hand.type === lastHand.type);
    if (easy.length) {
      // 炸弹时机已经在 evalBombTiming 中计分；这里只补充最便宜的参考，避免重复扣分/重复文案。
      betterAlternative = betterAlternative || easy.sort((a, b) => a.hand.power - b.hand.power)[0];
    }
  }

  if (createsTwoStepFinish && betterAlternative) {
    const alternativeRemain = removeCards(handBefore, betterAlternative.cards);
    const alternativeAlsoFinishesNext = wholeHandPlay(alternativeRemain, level);
    if (alternativeRemain.length > 0 && !alternativeAlsoFinishesNext) betterAlternative = null;
  }

  // A high-confidence shared tactic has final say over references generated by
  // legacy dimension checks, keeping coach, AI and evaluation aligned.
  const actualStrategic = strategicCandidateScore({ cards, hand: parsed }, strategyCtx);
  const rankedStrategic = legal.map((play) => ({
    play,
    strategy: strategicCandidateScore(play, strategyCtx),
  })).sort((a, b) => b.strategy.total - a.strategy.total);
  const sharedBest = rankedStrategic[0];
  if (betterAlternative) {
    const referenceStrategic = strategicCandidateScore(betterAlternative, strategyCtx);
    if (actualStrategic.total >= referenceStrategic.total + 40) betterAlternative = null;
  }
  if (sharedBest
    && !sameCards(sharedBest.play.cards, cards)
    && sharedBest.strategy.total >= actualStrategic.total + 120) {
    betterAlternative = sharedBest.play;
  }

  score = clamp(Math.round(score), 0, 100);

  // 默认正面反馈
  if (tips.length === 0) {
    if (score >= 75) tips.push('出牌合理，兼顾了牌力与牌型结构。');
    else tips.push('出牌合法，可继续关注留牌与配合。');
  }

  // 若有更好选择，附加说明
  const summary = buildSummary(score, action, parsed);
  if (betterAlternative && !sameCards(betterAlternative.cards, cards)) {
    tips.push(`可参考：${formatCards(betterAlternative.cards)}（${formatHand(betterAlternative.hand)}）`);
  }

  return {
    ...makeResult(score, tips, summary, assessment),
    betterAlternative: betterAlternative && !sameCards(betterAlternative.cards, cards)
      ? {
        cards: betterAlternative.cards,
        hand: betterAlternative.hand,
        label: formatHand(betterAlternative.hand),
      }
      : null,
    played: { cards, hand: parsed, label: formatHand(parsed) },
  };
}

function evaluatePass({
  legal, lastHand, lastSeat, isTeammateLead, handBefore, handCounts, seat, teams, tips, score,
  finishOrder, assessment, level, playedCards = [], publicHistory = [], difficulty = 'master',
  policyFeatures = null,
}) {
  const setScore = (target, dimension, tag, message) => {
    const delta = target - score;
    score = target;
    recordImpact(assessment, tips, dimension, delta, tag, message);
  };

  if (!lastHand) {
    setScore(0, 'defense', 'invalid_pass', '领出时不能过牌。');
    return makeResult(0, tips, '无效操作', assessment);
  }

  // 队友牌：过是好的
  if (isTeammateLead) {
    const urgentBlock = downstreamEnemyNeedsBlock(lastHand, {
      seat, teams, handCounts, finishOrder,
    });
    if (urgentBlock && legal.length) {
      const downstream = (seat + 1) % 4;
      setScore(
        30,
        'defense',
        'weak_defense',
        `下家只剩 ${handCounts[downstream]} 张且可能按当前牌型直接走完，应抬高对家的牌实施拦截。`,
      );
      const best = selectEmergencyBlock(legal, {
        hand: handBefore,
        level,
        mode: 'beat',
        lastHand,
        seat,
        teams,
        handCounts,
        finishOrder,
      });
      return {
        ...makeResult(score, tips, '错失紧急拦截', assessment),
        betterAlternative: {
          cards: best.cards,
          hand: best.hand,
          label: formatHand(best.hand),
        },
      };
    }

    const downstream = (seat + 1) % 4;
    if (legal.length && policyFeatures?.p3 !== false) {
      const p3Ctx = {
        hand: handBefore,
        level,
        lastHand,
        lastSeat,
        seat,
        teams,
        handCounts,
        finishOrder,
        playedCards,
        publicHistory,
        policyProfile: 'expert',
        policyFeatures,
      };
      p3Ctx.publicModel = inferPublicThreats(p3Ctx);
      const p3BeatModel = createBeatModel(p3Ctx);
      const p3Memo = createStrategicMemo(handBefore, level);
      const p3Cover = legal.map((play) => ({
        play,
        strategy: evaluateStrategicPlay(play, {
          ...p3Ctx,
          mode: 'beat',
          difficulty,
          strategyWeight: 1,
          strategyMemo: p3Memo,
        }),
      })).filter(({ play, strategy }) => (
        !isBombType(play.hand)
        && !play.cards.some((card) => isWild(card, level) || isJoker(card))
        && !strategy.tags.some((tag) => [
          'split_bomb', 'split_flush_straight', 'split_straight', 'split_group',
          'split_pair', 'preserve_wild', 'wild_simple_use', 'wild_as_single',
        ].includes(tag))
      )).map((item) => ({
        ...item,
        signal: publicPartnerProtectionValue(item.play, p3Ctx, p3BeatModel),
      })).filter((item) => item.signal?.eligible)
        .sort((left, right) => (
          right.signal.reduction - left.signal.reduction
          || left.play.hand.power - right.play.hand.power
          || right.strategy.score - left.strategy.score
        ))[0];
      if (p3Cover) {
        setScore(
          42,
          'cooperation',
          'missed_partner_cover',
          `公开应手模型显示下家接走对家牌权的风险可降低约${Math.round(p3Cover.signal.reduction * 100)}%；有不拆结构、不用王或逢人配的最低成本护牌时，不宜机械让牌。`,
        );
        return {
          ...makeResult(score, tips, '错失公开风险护牌', assessment),
          betterAlternative: {
            cards: p3Cover.play.cards,
            hand: p3Cover.play.hand,
            label: formatHand(p3Cover.play.hand),
          },
        };
      }
    }

    if (legal.length && handCounts[downstream] <= 5 && handCounts[lastSeat] > 5) {
      const coverMemo = createStrategicMemo(handBefore, level);
      const partnerCover = legal.map((play) => ({
        play,
        strategy: evaluateStrategicPlay(play, {
          hand: handBefore,
          level,
          mode: 'beat',
          lastHand,
          lastSeat,
          seat,
          teams,
          handCounts,
          finishOrder,
          playedCards,
          publicHistory,
          difficulty,
          policyProfile: 'expert',
          policyFeatures,
          strategyWeight: 1,
          strategyMemo: coverMemo,
        }),
      })).filter(({ strategy }) => strategy.tags.includes('partner_cover'))
        .sort((left, right) => (
          left.play.hand.power - right.play.hand.power
          || right.strategy.score - left.strategy.score
        ))[0];
      if (partnerCover) {
        setScore(
          38,
          'cooperation',
          'missed_partner_cover',
          `下家只剩 ${handCounts[downstream]} 张；此时可用不拆结构的普通牌安全抬高对家牌，降低对手顺走概率。`,
        );
        return {
          ...makeResult(score, tips, '错失安全护牌', assessment),
          betterAlternative: {
            cards: partnerCover.play.cards,
            hand: partnerCover.play.hand,
            label: formatHand(partnerCover.play.hand),
          },
        };
      }
    }

    const finish = legal.filter((p) => p.cards.length === handBefore.length);
    if (finish.length) {
      const strongFinish = finish.find((p) => isBombType(p.hand));
      const activeEnemyAboutToWin = handCounts.some(
        (count, i) => teams[i] !== teams[seat]
          && !finishOrder.includes(i)
          && count <= 2,
      );

      // 对家正在控牌，整手同花顺/炸弹既可等待反压，也可在出完后让对家接风。
      // 只要对手尚未进入一两张的紧急残局，这是一种合理的主动战术，而非错失出完。
      const finishDelay = strongFinish ? assessTeamFinishDelay(strongFinish, {
        hand: handBefore, level, lastHand, lastSeat, seat, teams, handCounts,
        finishOrder, policyFeatures,
      }) : { shouldDelay: false };
      if (finishDelay.shouldDelay && !activeEnemyAboutToWin) {
        setScore(
          88,
          'cooperation',
          null,
          `${finishDelay.reason}；后续出完仍可形成接风配合。`,
        );
        recordImpact(
          assessment,
          tips,
          'endgame',
          8,
          null,
          '残局牌型完整，没有拆牌；后续仍保留一手出完能力。',
        );
        return makeResult(score, tips, '诱敌与接风准备', assessment);
      }

      if (!activeEnemyAboutToWin) {
        setScore(
          68,
          'cooperation',
          null,
          '对家正在控牌，选择不抢牌权有配合价值；但你也已具备一手出完能力，需要结合名次判断。',
        );
        return makeResult(score, tips, '配合与名次权衡', assessment);
      }

      setScore(
        42,
        'endgame',
        'missed_finish',
        '虽然对家正在控牌，但对手已接近出完；此时你本可以一手走完，应优先锁定名次。',
      );
      return {
        ...makeResult(score, tips, '残局过牌偏险', assessment),
        betterAlternative: {
          cards: finish[0].cards,
          hand: finish[0].hand,
          label: formatHand(finish[0].hand),
        },
      };
    }
    setScore(85, 'cooperation', null, '队友出牌选择放过，有利于对家继续控牌，配合意识良好。');
    return makeResult(score, tips, '配合得当', assessment);
  }

  // 对手牌
  const canBeatEasy = legal.filter((p) => !isBombType(p.hand));
  const mustBomb = legal.length > 0 && canBeatEasy.length === 0;

  if (legal.length === 0) {
    setScore(80, 'defense', null, '无牌可接，过牌正确。');
    return makeResult(score, tips, '被迫过牌', assessment);
  }

  const enemyAboutToWin = handCounts.some(
    (c, i) => teams[i] !== teams[seat] && !finishOrder.includes(i) && c <= 2,
  );

  // 能出完却过
  const finish = legal.filter((p) => p.cards.length === handBefore.length);
  if (finish.length) {
    const strongFinish = finish.find((play) => isBombType(play.hand));
    // 整手炸弹/同花顺可以直接走完，但在对手尚不紧急时，放过普通牌等待诱炸，
    // 能先消耗对方核心资源再反制，属于合理但有风险的团队战术。
    const finishDelay = strongFinish ? assessTeamFinishDelay(strongFinish, {
      hand: handBefore, level, lastHand, lastSeat, seat, teams, handCounts,
      finishOrder, policyFeatures,
    }) : { shouldDelay: false };
    if (finishDelay.shouldDelay && !enemyAboutToWin) {
      setScore(
        84,
        'resources',
        null,
        `${finishDelay.reason}，具有诱炸与团队名次价值。`,
      );
      recordImpact(
        assessment,
        tips,
        'endgame',
        6,
        null,
        '仍保持一手出完能力；需注意对手若接近走完，应立即锁定名次。',
      );
      return makeResult(score, tips, '保留整手强牌诱炸', assessment);
    }

    setScore(25, 'endgame', 'missed_finish', '你有牌可接且能一次出完，过牌会丢掉名次。');
    return {
      ...makeResult(score, tips, '错失出完', assessment),
      betterAlternative: {
        cards: finish[0].cards,
        hand: finish[0].hand,
        label: formatHand(finish[0].hand),
      },
    };
  }

  // 当普通牌无法承接，唯一办法是交出炸弹/同花顺时，
  // 用与 AI 相同的策略核心判断这个强控制是否应该保留。
  const strategyMemo = createStrategicMemo(handBefore, level);
  const assessedResponses = legal.map((play) => ({
      play,
      strategy: evaluateStrategicPlay(play, {
        hand: handBefore,
        level,
        mode: 'beat',
        lastHand,
        lastSeat,
        seat,
        teams,
        handCounts,
        finishOrder,
        playedCards,
        publicHistory,
        difficulty,
        policyProfile: 'expert',
        policyFeatures,
        strategyWeight: 1,
        strategyMemo,
      }),
    }));
  const ordinaryResponses = assessedResponses
    .filter(({ play }) => !isBombType(play.hand));
  const placementBlock = assessedResponses.find(({ strategy }) => (
    strategy.tags.includes('double_up_block')
      || strategy.tags.includes('avoid_double_down')
  ));
  if (placementBlock) {
    const ownPartnerHead = placementBlock.strategy.tags.includes('double_up_block');
    setScore(
      28,
      'endgame',
      ownPartnerHead ? 'missed_double_up' : 'risk_double_down',
      ownPartnerHead
        ? '对家已经头游，当前对手进入五张内收官区；继续过牌会主动放弃争二游和双上的机会。'
        : '对手一方已经头游，其对家进入五张内收官区；继续过牌可能直接被双上。',
    );
    return {
      ...makeResult(score, tips, ownPartnerHead ? '错失双上拦截' : '双下风险', assessment),
      betterAlternative: {
        cards: placementBlock.play.cards,
        hand: placementBlock.play.hand,
        label: formatHand(placementBlock.play.hand),
      },
    };
  }
  const singleRunPressure = analyzeSingleRunPressure({
    hand: handBefore,
    level,
    mode: 'beat',
    lastHand,
    lastSeat,
    seat,
    teams,
    handCounts,
    finishOrder,
    publicHistory,
  });
  const singleRunResponses = assessedResponses
    .filter(({ play, strategy }) => play.hand.type === HandType.SINGLE
      && strategy.tags.includes('stop_single_run'))
    .sort((left, right) => {
      const damage = (item) => {
        const tags = item.strategy.tags;
        return Number(tags.includes('split_bomb')) * 1000
          + Number(tags.includes('split_flush_straight')) * 700
          + Number(tags.includes('split_straight')) * 400
          + Number(tags.includes('split_group')) * 250
          + Number(tags.includes('split_pair')) * 180;
      };
      return damage(left) - damage(right)
        || left.play.hand.power - right.play.hand.power
        || right.strategy.score - left.strategy.score;
    });
  if (singleRunPressure.active && singleRunResponses.length) {
    const best = singleRunResponses[0].play;
    setScore(
      singleRunPressure.hard ? 25 : 38,
      'defense',
      'missed_response',
      `对手已连续${singleRunPressure.streakCount}圈走单，继续整手过牌会被稳定清理单张；应以结构损失最小的单张及时截断。`,
    );
    return {
      ...makeResult(score, tips, '连续单张防守不足', assessment),
      betterAlternative: {
        cards: best.cards,
        hand: best.hand,
        label: formatHand(best.hand),
      },
    };
  }
  const cheapControlResponse = assessedResponses
    .filter(({ strategy }) => strategy.tags.includes('cheap_control_take'))
    .sort((left, right) => (
      left.play.hand.power - right.play.hand.power
      || right.strategy.score - left.strategy.score
    ))[0];
  if (cheapControlResponse) {
    setScore(
      45,
      'defense',
      'missed_response',
      '有不拆组合、不用王和逢人配的自然小牌可以低成本接管；完全放过会让对手免费清理散牌。',
    );
    return {
      ...makeResult(score, tips, '低成本可接未接', assessment),
      betterAlternative: {
        cards: cheapControlResponse.play.cards,
        hand: cheapControlResponse.play.hand,
        label: formatHand(cheapControlResponse.play.hand),
      },
    };
  }
  const pressureOrdinary = selectPressureOrdinaryResponse(assessedResponses, {
    hand: handBefore, level, mode: 'beat', lastHand, lastSeat, seat, teams,
    handCounts, finishOrder, policyFeatures,
  });
  if (pressureOrdinary) {
    setScore(
      pressureOrdinary.pressure.hard ? 30 : 45,
      'defense',
      'missed_pressure_response',
      `${pressureOrdinary.reason}；此时继续过牌会让对手方低成本推进。`,
    );
    return {
      ...makeResult(score, tips, '压力区防守不足', assessment),
      betterAlternative: {
        cards: pressureOrdinary.play.cards,
        hand: pressureOrdinary.play.hand,
        label: formatHand(pressureOrdinary.play.hand),
      },
    };
  }
  const ordinaryResponsesCostly = ordinaryResponses.length > 0
    && ordinaryResponses.every(({ strategy }) => strategy.score <= -100
      && strategy.tags.some((tag) => ['split_straight', 'split_bomb'].includes(tag)));
  const strategicReserve = !enemyAboutToWin && (mustBomb || ordinaryResponsesCostly)
    ? assessedResponses.find(({ play, strategy }) => strategy.tags.includes('survival_preserve_control')
      || (handBefore.length <= 12
        && play.hand.type === HandType.FLUSH_STRAIGHT
        && strategy.tags.includes('preserve_strong_control')))
    : null;
  if (strategicReserve) {
    const survival = strategicReserve.strategy.tags.includes('survival_preserve_control');
    setScore(
      survival ? 88 : 82,
      survival ? 'endgame' : 'resources',
      null,
      survival
        ? `对家已头游，保留${formatHand(strategicReserve.play.hand)}去压另一名对手，有利于保住三游、避免末游。`
        : `当前接牌需要交出${formatHand(strategicReserve.play.hand)}或拆散关键结构，而对手尚未进入紧急收官；保留同花顺等强控制等待更高收益，战略过牌合理。`,
    );
    return makeResult(score, tips, survival ? '保三游控制' : '保留强控制', assessment);
  }

  const catastrophicOrdinaryResponses = ordinaryResponses.length > 0
    && ordinaryResponses.every(({ strategy }) => (
      strategy.tags.some((tag) => [
        'preserve_wild', 'wild_simple_use', 'wild_as_single',
      ].includes(tag))
      || (strategy.score <= -500
        && strategy.tags.some((tag) => [
          'split_bomb', 'split_straight', 'split_group', 'split_pair',
        ].includes(tag)))
    ));
  const activeEnemyMin = Math.min(...handCounts.map((count, index) => (
    index !== seat && teams[index] !== teams[seat] && !finishOrder.includes(index)
      ? count : 99
  )));
  if (catastrophicOrdinaryResponses && activeEnemyMin > 5) {
    setScore(
      86,
      'resources',
      null,
      '所有普通接法都会消耗逢人配或同时拆散多组关键结构；对手尚未进入五张内残局，保存牌型过牌更合理。',
    );
    return makeResult(score, tips, '保存结构过牌', assessment);
  }

  // 对手要出完
  if (enemyAboutToWin && legal.length) {
    setScore(30, 'defense', 'weak_defense', '对方牌已极少，应尽可能压制，避免其出完。');
    const best = legal.sort((a, b) => {
      const ab = isBombType(a.hand) ? 0 : 1;
      const bb = isBombType(b.hand) ? 0 : 1;
      return ab - bb || a.hand.power - b.hand.power;
    })[0];
    return {
      ...makeResult(score, tips, '防守不足', assessment),
      betterAlternative: {
        cards: best.cards,
        hand: best.hand,
        label: formatHand(best.hand),
      },
    };
  }

  // 有小牌可接却过 — 视情况
  if (canBeatEasy.length) {
    const cheapest = canBeatEasy.sort((a, b) => a.hand.power - b.hand.power)[0];
    // 上家很大，保留合理
    if (lastHand.power >= 14 || isBombType(lastHand)) {
      setScore(78, 'resources', null, '上家牌力较强，选择保留实力过牌，合理。');
    } else if (cheapest.hand.power <= lastHand.power + 3 && handBefore.length <= 12) {
      setScore(50, 'defense', 'missed_response', '有较小的牌可以承接并争取控权，完全过掉略亏。');
      return {
        ...makeResult(score, tips, '可接未接', assessment),
        betterAlternative: {
          cards: cheapest.cards,
          hand: cheapest.hand,
          label: formatHand(cheapest.hand),
        },
      };
    } else {
      tips.push('过牌可以，但注意不要让对手连控过多轮。');
    }
  } else if (mustBomb) {
    // 只能炸
    if (handBefore.length > 15) {
      setScore(82, 'resources', null, '仅能出炸弹承接，中盘保留炸弹是正确选择。');
    } else {
      setScore(60, 'endgame', 'passive_endgame', '残局仅能炸弹承接时，需权衡名次与炸弹价值。');
    }
  }

  return makeResult(clamp(score, 0, 100), tips, '过牌', assessment);
}

function evalBombTiming(
  parsed, lastHand, handBefore, handCounts, seat, teams, legal, createsTwoStepFinish = false,
) {
  const events = [];
  let better = null;

  const nonBomb = legal.filter((p) => !isBombType(p.hand));
  const remain = handBefore.length - parsed.size;
  const isClosingBomb = remain <= 2;

  if (createsTwoStepFinish) {
    events.push({
      dimension: 'resources',
      delta: 10,
      tag: null,
      message: '强牌用于夺回牌权，且下一手可以直接收完，不属于浪费炸弹。',
    });
    return { events, better };
  }

  if (isClosingBomb) {
    events.push({
      dimension: 'endgame',
      delta: 20,
      tag: null,
      message: remain === 0
        ? (lastHand
          ? '本手炸弹可以直接出完，名次优先。'
          : '残局以炸弹领出并直接出完，收官时机正确。')
        : (lastHand
          ? '残局甩炸弹后仅剩少量手牌，有利于快速收官。'
          : '残局以炸弹领出后仅剩少量手牌，有利于快速收官。'),
    });
    if (lastHand && isBombType(lastHand)) {
      events.push({
        dimension: 'defense',
        delta: 10,
        tag: null,
        message: '同时完成了对上家炸弹的有效反制。',
      });
    }
    return { events, better };
  }

  if (!lastHand) {
    events.push({
      dimension: 'resources',
      delta: -25,
      tag: 'waste_bomb',
      message: '用炸弹领出通常不利，炸弹应作为反击与收官武器。',
    });
  } else if (nonBomb.length && !isBombType(lastHand)) {
    events.push({
      dimension: 'resources',
      delta: -20,
      tag: 'waste_bomb',
      message: '有非炸弹接法时优先用普通牌，炸弹留着更有威慑。',
    });
    better = nonBomb.sort((a, b) => a.hand.power - b.hand.power)[0];
  } else if (isBombType(lastHand)) {
    events.push({
      dimension: 'defense',
      delta: 10,
      tag: null,
      message: '用更大的炸弹/同花顺反制，正确。',
    });
  }

  return { events, better };
}

function evalStructure(handBefore, cards, level, playedHand = null, sharedStrategy = null) {
  const events = [];
  const remain = removeCards(handBefore, cards);
  const actualHand = playedHand || parseHand(cards, level);
  const productiveRestructure = sharedStrategy?.tags?.includes('productive_restructure');
  const urgentOrdinaryBlock = sharedStrategy?.tags?.includes('urgent_ordinary_block');

  const straightLoss = Math.max(
    0,
    countDisjointStraights(handBefore, level) - countDisjointStraights(remain, level),
  );
  if (straightLoss > 0
    && !productiveRestructure
    && !urgentOrdinaryBlock
    && ![HandType.STRAIGHT, HandType.FLUSH_STRAIGHT].includes(actualHand?.type)) {
    events.push({
      dimension: 'structure',
      delta: -Math.min(15, 5 + straightLoss * 5),
      tag: 'split_straight',
      message: '这张牌是潜在顺子的关键点数，打出后会破坏已有顺子结构。',
    });
  }

  // 是否拆了炸弹
  const beforeBombs = countPotentialBombs(handBefore, level);
  const afterBombs = countPotentialBombs(remain, level);
  if (afterBombs < beforeBombs && !isBombType(actualHand)
    && !productiveRestructure && !urgentOrdinaryBlock) {
    events.push({
      dimension: 'structure',
      delta: -15,
      tag: 'split_bomb',
      message: beforeBombs - afterBombs > 1
        ? `此出牌同时拆散了 ${beforeBombs - afterBombs} 个潜在炸弹，结构损失很大。`
        : '此出牌拆散了潜在炸弹，损失中长期牌力。',
    });
  }

  // 是否拆了对子/三张
  const beforeGroups = countGroups(handBefore, level);
  const afterGroups = countGroups(remain, level);
  if (beforeGroups.pairs > afterGroups.pairs && cards.length === 1) {
    events.push({
      dimension: 'structure',
      delta: -8,
      tag: 'split_pair',
      message: '从对子中拆出单牌，会增加后续手数；有独立单张可用时应优先保留对子。',
    });
  }
  if (beforeGroups.triples > afterGroups.triples && cards.length < 3) {
    events.push({
      dimension: 'structure',
      delta: cards.length === 2 ? -10 : -8,
      tag: 'split_group',
      message: cards.length === 2
        ? '从三同张中拆出对子会留下单张，增加后续手数。'
        : '从三同张中拆出单牌，可能影响钢板/三带二。',
    });
  }

  if (remain.length && afterGroups.singles > beforeGroups.singles + 1) {
    events.push({
      dimension: 'structure',
      delta: -5,
      tag: 'fragmentation',
      message: '出牌后散牌变多，后续手数可能增加。',
    });
  } else if (cards.length >= 3) {
    events.push({
      dimension: 'structure',
      delta: 6,
      tag: null,
      message: null,
    });
  }

  return { events };
}

/** 计算一次出牌造成的结构损失，用于筛选真正更优的参考牌。 */
function structureCost(handBefore, cards, level) {
  return evalStructure(handBefore, cards, level).events.reduce(
    (total, event) => total + Math.max(0, -(event.delta || 0)),
    0,
  );
}

function evalLead(parsed, cards, handBefore, level, legal) {
  const events = [];
  let better = null;

  // 优先出组合而非单张（有组合时）
  if (parsed.type === HandType.SINGLE && handBefore.length > 6) {
    const currentCost = structureCost(handBefore, cards, level);
    const combos = legal.filter(
      (p) => p.cards.length >= 2
        && !isBombType(p.hand)
        && p.hand.power <= 10
        // 逢人配是关键资源，不能为了“多出一张”就当普通对子消耗。
        && !p.cards.some((card) => isWild(card, level))
        // 更优参考不能比当前出法造成更大的拆牌损失。
        && structureCost(handBefore, p.cards, level) <= currentCost,
    );
    if (combos.length) {
      events.push({
        dimension: 'structure',
        delta: -8,
        tag: 'inefficient_lead',
        message: '手牌较多时，领出优先考虑对子/顺子等组合以降低手数。',
      });
      better = combos.sort((a, b) => (
        structureCost(handBefore, a.cards, level) - structureCost(handBefore, b.cards, level)
        || a.hand.power - b.hand.power
      ))[0];
    }
  }

  // 领出过大
  if (!isBombType(parsed) && parsed.power >= 50 && handBefore.length > 10) {
    events.push({
      dimension: 'resources',
      delta: -12,
      tag: 'premature_high',
      message: '开局过早甩级牌/大牌，不利于中盘控制。',
    });
  }

  // 领出小组合好
  if (!isBombType(parsed) && parsed.power <= 8 && cards.length >= 2) {
    events.push({
      dimension: 'structure',
      delta: 10,
      tag: null,
      message: '以较小组合领出，利于探路并保留火力。',
    });
  }

  return { events, better };
}

function countGroups(hand, level) {
  const m = new Map();
  for (const c of hand) {
    if (isJoker(c) || isWild(c, level)) continue;
    m.set(c.rank, (m.get(c.rank) || 0) + 1);
  }
  let pairs = 0;
  let triples = 0;
  let singles = 0;
  for (const cnt of m.values()) {
    if (cnt >= 3) triples++;
    else if (cnt === 2) pairs++;
    else singles++;
  }
  return { pairs, triples, singles };
}

function isBombType(h) {
  return h && (h.type === HandType.BOMB || h.type === HandType.FLUSH_STRAIGHT || h.type === HandType.JOKER_BOMB);
}

function sameCards(a, b) {
  if (a.length !== b.length) return false;
  const sa = a.map((c) => c.id).sort().join(',');
  const sb = b.map((c) => c.id).sort().join(',');
  return sa === sb;
}

function formatCards(cards) {
  return cards.map(cardLabel).join(' ');
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function gradeOf(score) {
  return GRADE.find((g) => score >= g.min) || GRADE[GRADE.length - 1];
}

function buildSummary(score, action, parsed) {
  const g = gradeOf(score);
  if (action === 'pass') return `${g.label}的过牌`;
  return `${g.label} · ${formatHand(parsed)}`;
}

function createAssessment() {
  return {
    deltas: Object.fromEntries(Object.keys(DIMENSION_DEFS).map((key) => [key, 0])),
    breakdown: [],
    mistakeTags: new Set(),
  };
}

function recordImpact(assessment, tips, dimension, delta, tag, message) {
  const key = DIMENSION_DEFS[dimension] ? dimension : 'structure';
  assessment.deltas[key] += delta;
  if (delta !== 0 || message) {
    assessment.breakdown.push({
      dimension: key,
      label: DIMENSION_DEFS[key],
      delta,
      tag: tag || null,
      message: message || '',
    });
  }
  if (delta < 0 && tag) assessment.mistakeTags.add(tag);
  if (message) tips.push(message);
  return delta;
}

function applyEvents(assessment, tips, events) {
  let delta = 0;
  for (const event of events || []) {
    delta += recordImpact(
      assessment,
      tips,
      event.dimension,
      event.delta,
      event.tag,
      event.message,
    );
  }
  return delta;
}

function makeResult(score, tips, summary, assessment = createAssessment()) {
  const g = gradeOf(score);
  const dimensions = {};
  for (const [key, label] of Object.entries(DIMENSION_DEFS)) {
    const delta = assessment.deltas[key] || 0;
    dimensions[key] = {
      label,
      score: clamp(70 + delta, 0, 100),
      delta,
    };
  }
  return {
    score,
    grade: g.label,
    stars: g.star,
    color: g.color,
    tips: tips.filter(Boolean),
    summary,
    dimensions,
    breakdown: assessment.breakdown.slice(),
    mistakeTags: [...assessment.mistakeTags],
  };
}

/**
 * 局后总结
 */
export function summarizeSession(history) {
  if (!history.length) {
    return { avg: 0, count: 0, best: null, worst: null, advice: ['暂无出牌记录'] };
  }
  const avg = Math.round(history.reduce((s, h) => s + h.score, 0) / history.length);
  const best = history.reduce((a, b) => (a.score >= b.score ? a : b));
  const worst = history.reduce((a, b) => (a.score <= b.score ? a : b));

  const advice = [];
  const hasMistake = (item, tags, legacyWord) => {
    if (Array.isArray(item.mistakeTags)) return tags.some((tag) => item.mistakeTags.includes(tag));
    return (item.tips || []).some((tip) => tip.includes(legacyWord));
  };
  const lowWild = history.filter((item) => hasMistake(item, [
    'waste_wild', 'preserve_wild', 'wild_simple_use', 'wild_as_single',
  ], '逢人配'));
  const bombWaste = history.filter((item) => hasMistake(item, ['waste_bomb', 'split_bomb'], '炸弹'));
  const teammate = history.filter((item) => hasMistake(item, ['over_teammate'], '队友'));

  if (avg >= 75) advice.push('本局整体出牌质量较高，继续保持控牌与配合意识。');
  else if (avg >= 60) advice.push('本局中规中矩，可在「留炸」「不拆组合」上再精细一些。');
  else advice.push('本局失误偏多，建议放慢节奏：先想清牌型再出，优先不拆炸弹。');

  if (lowWild.length >= 2) advice.push('多次涉及逢人配使用问题：把它当成「最后的粘合剂」，不要轻易领出。');
  if (bombWaste.length >= 2) advice.push('炸弹使用偏随意：默认保留，仅在反制、阻断或残局清牌时甩出。');
  if (teammate.length >= 1) advice.push('注意与对家配合：队友的牌尽量不压，让对家多控圈。');

  const grades = { 神来之笔: 0, 优秀: 0, 良好: 0, 一般: 0, 待改进: 0 };
  for (const h of history) grades[h.grade] = (grades[h.grade] || 0) + 1;

  const dimensionAverages = {};
  for (const [key, label] of Object.entries(DIMENSION_DEFS)) {
    const values = history
      .map((item) => item.dimensions?.[key]?.score)
      .filter(Number.isFinite);
    dimensionAverages[key] = {
      label,
      score: values.length
        ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
        : 70,
    };
  }

  const mistakeCounts = {};
  for (const item of history) {
    for (const tag of item.mistakeTags || []) {
      mistakeCounts[tag] = (mistakeCounts[tag] || 0) + 1;
    }
  }

  return {
    avg,
    count: history.length,
    best,
    worst,
    advice,
    grades,
    dimensionAverages,
    mistakeCounts,
  };
}

/** 手牌结构提示（开局/可随时查看） */
export function analyzeHandStructure(hand, level) {
  const tips = [];
  const bombs = countPotentialBombs(hand, level);
  const g = countGroups(hand, level);
  const wilds = hand.filter((c) => isWild(c, level)).length;
  const jokers = hand.filter(isJoker).length;

  if (bombs) tips.push(`潜在炸弹约 ${bombs} 个，注意保护，避免拆炸。`);
  if (wilds) tips.push(`逢人配 ×${wilds}：优先留给炸弹/同花顺/关键牌型。`);
  if (jokers) tips.push(`王牌 ×${jokers}：适合收圈、压级牌或拼天王炸。`);
  if (g.triples) tips.push(`三同张 ×${g.triples}：可组钢板、三带二。`);
  if (g.singles >= 8) tips.push('散牌偏多，领出时尽量出组合，减少手数。');
  if (!tips.length) tips.push('牌面较均衡，灵活应对即可。');

  return tips;
}
