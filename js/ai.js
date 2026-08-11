/**
 * 掼蛋 AI（多难度）
 * easy   — 随机偏多、常浪费炸/逢人配、少配合
 * normal — 启发式均衡
 * hard   — 候选剪枝后进行一至两步前瞻，兼顾残局手数与牌型结构
 * master — 确定性扩大前瞻，并使用公开牌史与专家策略评分
 */

import { isWild, isJoker, soloPower, removeCards } from './cards.js';
import {
  generateLegalPlays, canBeat, HandType, handSignature,
} from './rules.js';
import {
  completedFlushStraightCount, countDisjointStraights, countPotentialBombs, createStrategicMemo,
  downstreamEnemyNeedsBlock, evaluateStrategicPlay, selectEmergencyBlock,
} from './strategy-core.js';
import {
  estimateThreeStepRoute, inferPublicThreats, createBeatModel, createUnconditionedBeatModel,
  controlEV, bombNetGain,
} from './ai-route.js';

export const AI_DIFFICULTY = {
  easy: 'easy',
  normal: 'normal',
  hard: 'hard',
  master: 'master',
};

export const AI_DIFFICULTY_LABEL = {
  easy: '简单',
  normal: '普通',
  hard: '困难',
  master: '大师',
};

const POLICY_FEATURE_KEYS = ['p0', 'p1', 'p2', 'endgame'];
const EXPERT_POLICY_FEATURES = Object.freeze({
  p0: true,
  p1: true,
  p2: true,
  endgame: true,
});
const BASELINE_POLICY_FEATURES = Object.freeze({
  p0: false,
  p1: false,
  p2: false,
  endgame: false,
});

/**
 * 独立策略消融定义。no-p0/no-p1/no-p2 始终保留 expert 的统一策略权重，
 * 只关闭被测模块，避免旧 baseline 同时关闭多项能力而污染归因。
 */
export const AI_POLICY_VARIANTS = Object.freeze({
  expert: Object.freeze({
    policyProfile: 'expert',
    policyFeatures: EXPERT_POLICY_FEATURES,
  }),
  baseline: Object.freeze({
    policyProfile: 'baseline',
    policyFeatures: BASELINE_POLICY_FEATURES,
  }),
  'no-p0': Object.freeze({
    policyProfile: 'expert',
    policyFeatures: Object.freeze({ ...EXPERT_POLICY_FEATURES, p0: false }),
  }),
  'no-p1': Object.freeze({
    policyProfile: 'expert',
    policyFeatures: Object.freeze({ ...EXPERT_POLICY_FEATURES, p1: false }),
  }),
  'no-p2': Object.freeze({
    policyProfile: 'expert',
    policyFeatures: Object.freeze({ ...EXPERT_POLICY_FEATURES, p2: false }),
  }),
  none: Object.freeze({
    policyProfile: 'expert',
    policyFeatures: Object.freeze({
      ...EXPERT_POLICY_FEATURES,
      p0: false,
      p1: false,
      p2: false,
    }),
  }),
});

export function resolvePolicyFeatures(policyProfile = 'expert', overrides = null) {
  const defaults = policyProfile === 'baseline'
    ? BASELINE_POLICY_FEATURES
    : EXPERT_POLICY_FEATURES;
  const resolved = { ...defaults };
  if (overrides && typeof overrides === 'object') {
    for (const key of POLICY_FEATURE_KEYS) {
      if (typeof overrides[key] === 'boolean') resolved[key] = overrides[key];
    }
  }
  return resolved;
}

export function resolvePolicyVariant(name = 'expert') {
  const normalized = Object.prototype.hasOwnProperty.call(AI_POLICY_VARIANTS, name)
    ? name
    : 'expert';
  const variant = AI_POLICY_VARIANTS[normalized];
  return {
    name: normalized,
    policyProfile: variant.policyProfile,
    policyFeatures: { ...variant.policyFeatures },
  };
}

const SEARCH_CACHE_LIMIT = 160;
const LOOK_AHEAD_ROOT_LIMIT = 10;
const LOOK_AHEAD_FUTURE_BEAM = 4;

/** @type {'easy'|'normal'|'hard'|'master'} */
let _difficulty = AI_DIFFICULTY.normal;

export function setAIDifficulty(d) {
  if (AI_DIFFICULTY[d]) _difficulty = d;
}

export function getAIDifficulty() {
  return _difficulty;
}

function cfg(difficulty = _difficulty) {
  switch (difficulty) {
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
        strategyWeight: 0.2,
        lookAheadRootLimit: 6,
        lookAheadFutureBeam: 3,
        lookAheadDepthHand: 10,
        lookAheadEndgameHand: 0,
        lookAheadEndgameNodes: 0,
        controlLeadRiskPenalty: 8,
        leadBeatRiskPenalty: 2,
        beatBackRiskPenalty: 18,
        controlLossBase: 0,
        controlLossFinishBoost: 0,
        controlLossControlBoost: 0,
        controlLossNearBoost: 0,
        bombNetEnabled: false,
        bombNetResource: 3,
        bombNetPlayThresh: 10,
        bombNetSaveThresh: 10,
        difficulty,
      };
    case 'master':
      return {
        noise: 0,
        bombLeadPenalty: 135,
        simpleLeadPowerPenalty: 1.5,
        bombBeatPenalty: 175,
        wildPenalty: 38,
        teammatePassRate: 1,
        finishFirst: true,
        structureWeight: 1.65,
        aggressiveness: 0.92,
        lookAhead: true,
        randomPass: 0,
        strategyWeight: 1,
        lookAheadRootLimit: 14,
        lookAheadFutureBeam: 5,
        lookAheadDepthHand: 16,
        lookAheadEndgameHand: 8,
        lookAheadEndgameNodes: 30000,
        controlLeadRiskPenalty: 42,
        leadBeatRiskPenalty: 7,
        beatBackRiskPenalty: 48,
        controlLossBase: 22,
        controlLossFinishBoost: 30,
        controlLossControlBoost: 15,
        controlLossNearBoost: 35,
        bombNetEnabled: true,
        bombNetResource: 6,
        bombNetPlayThresh: 14,
        bombNetSaveThresh: 14,
        difficulty,
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
        strategyWeight: 0.72,
        lookAheadRootLimit: LOOK_AHEAD_ROOT_LIMIT,
        lookAheadFutureBeam: LOOK_AHEAD_FUTURE_BEAM,
        lookAheadDepthHand: 12,
        lookAheadEndgameHand: 7,
        lookAheadEndgameNodes: 20000,
        controlLeadRiskPenalty: 34,
        leadBeatRiskPenalty: 6,
        beatBackRiskPenalty: 40,
        controlLossBase: 16,
        controlLossFinishBoost: 25,
        controlLossControlBoost: 12,
        controlLossNearBoost: 30,
        bombNetEnabled: true,
        bombNetResource: 5,
        bombNetPlayThresh: 12,
        bombNetSaveThresh: 12,
        difficulty,
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
        lookAhead: true,
        randomPass: 0.06,
        strategyWeight: 0.4,
        lookAheadRootLimit: 5,
        lookAheadFutureBeam: 2,
        lookAheadDepthHand: 9,
        lookAheadEndgameHand: 0,
        lookAheadEndgameNodes: 0,
        controlLeadRiskPenalty: 22,
        leadBeatRiskPenalty: 4,
        beatBackRiskPenalty: 30,
        controlLossBase: 12,
        controlLossFinishBoost: 20,
        controlLossControlBoost: 10,
        controlLossNearBoost: 25,
        bombNetEnabled: false,
        bombNetResource: 4,
        bombNetPlayThresh: 12,
        bombNetSaveThresh: 12,
        difficulty,
      };
  }
}

/**
 * @param {object} ctx
 */
export function chooseAIPlay(ctx) {
  return chooseAIPlayInternal(ctx, {
    explain: false,
    deterministic: !!ctx?.deterministic,
    difficulty: AI_DIFFICULTY[ctx?.difficulty] || _difficulty,
    timeBudgetMs: Number(ctx?.timeBudgetMs) || 0,
  });
}

/**
 * 限时迭代加深的预算换算：真实对局里 AI 有可感知的思考时间时，把预算
 * 花在更深的残局满深度搜索、更多候选和更宽 beam 上。deterministic 路径
 * （A/B 镜像赛、单测、教练、云端咨询）不会走到这里，保证可复现性。
 */
export function applySearchTimeBudget(c, timeBudgetMs) {
  const budget = Number(timeBudgetMs) || 0;
  if (budget <= 0 || !c) return c;
  if (budget >= 400) {
    c.lookAheadRootLimit += 4;
    c.lookAheadFutureBeam += 1;
    c.lookAheadEndgameHand += 2;
  } else if (budget >= 150) {
    c.lookAheadRootLimit += 4;
    c.lookAheadEndgameHand += 2;
  }
  return c;
}

function publicCard(card) {
  if (!card || !Number.isFinite(card.rank)) return null;
  return {
    rank: card.rank,
    suit: card.suit,
    deckIndex: card.deckIndex != null && Number.isFinite(Number(card.deckIndex))
      ? Number(card.deckIndex) : null,
  };
}

/**
 * AI 只接收本家手牌与牌桌公开信息。这里显式白名单，避免未来调用者误把
 * state.hands、初始牌面、复盘余牌或教练内部信息扩散进策略层。
 */
function sanitizePublicHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.slice(-240).map((item) => ({
    turn: Number(item?.turn) || 0,
    trickNumber: Number(item?.trickNumber) || 0,
    seat: Number(item?.seat),
    action: item?.action === 'play' ? 'play' : 'pass',
    cards: Array.isArray(item?.cards) ? item.cards.map(publicCard).filter(Boolean) : [],
    hand: item?.hand ? {
      type: item.hand.type,
      mainRank: item.hand.mainRank,
      size: item.hand.size,
      power: item.hand.power,
    } : null,
    countsBefore: Array.isArray(item?.countsBefore) ? item.countsBefore.slice(0, 4) : [],
    countsAfter: Array.isArray(item?.countsAfter) ? item.countsAfter.slice(0, 4) : [],
  }));
}

function sanitizeTributeContext(value) {
  if (!value || typeof value !== 'object') return null;
  const knownTransfers = Array.isArray(value.knownTransfers)
    ? value.knownTransfers.slice(0, 8).map((item) => ({
        card: publicCard(item?.card),
        from: item?.from != null && Number.isInteger(Number(item.from))
          ? Number(item.from) : null,
        to: item?.to != null && Number.isInteger(Number(item.to))
          ? Number(item.to) : null,
        kind: item?.kind === 'return' ? 'return' : 'tribute',
      })).filter((item) => item.card && item.to != null)
    : [];
  return {
    gaveCard: publicCard(value.gaveCard),
    gaveTo: value.gaveTo != null && Number.isInteger(Number(value.gaveTo))
      ? Number(value.gaveTo) : null,
    receivedReturnCard: publicCard(value.receivedReturnCard),
    receivedFrom: value.receivedFrom != null && Number.isInteger(Number(value.receivedFrom))
      ? Number(value.receivedFrom) : null,
    firstLeadAfterTribute: !!value.firstLeadAfterTribute,
    doubleDown: !!value.doubleDown,
    knownTransfers,
  };
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
    playedCards = [],
    publicHistory = [],
    tributeContext = null,
    leadAfterOwnBomb = false,
    policyProfile = 'expert',
    policyFeatures = null,
  } = ctx;
  const selectedDifficulty = AI_DIFFICULTY[options.difficulty]
    || AI_DIFFICULTY[ctx.difficulty]
    || _difficulty;
  const c = { ...cfg(selectedDifficulty) };
  if (!options.deterministic && options.timeBudgetMs > 0) {
    applySearchTimeBudget(c, options.timeBudgetMs);
  }
  if (options.deterministic) {
    c.noise = 0;
    c.randomPass = 0;
    c.teammatePassRate = 1;
  }
  const safeHistory = sanitizePublicHistory(publicHistory);
  const normalizedPolicyProfile = policyProfile === 'baseline' ? 'baseline' : 'expert';
  const normalizedPolicyFeatures = resolvePolicyFeatures(
    normalizedPolicyProfile,
    policyFeatures,
  );
  const decisionCtx = {
    seat,
    hand: hand.slice(),
    level,
    lastHand,
    lastSeat,
    handCounts: handCounts.slice(0, 4),
    teams: teams.slice(0, 4),
    finishOrder: finishOrder.slice(0, 4),
    playedCards: playedCards.map(publicCard).filter(Boolean),
    publicHistory: safeHistory,
    tributeContext: sanitizeTributeContext(tributeContext),
    leadAfterOwnBomb: !!leadAfterOwnBomb,
    policyProfile: normalizedPolicyProfile,
    policyFeatures: normalizedPolicyFeatures,
    difficulty: selectedDifficulty,
    strategyWeight: c.strategyWeight,
  };
  decisionCtx.strategyMemo = createStrategicMemo(decisionCtx.hand, level);
  decisionCtx.publicModel = inferPublicThreats(decisionCtx);
  if (normalizedPolicyFeatures.p0) {
    decisionCtx.beatModel = createBeatModel(decisionCtx);
  } else if (normalizedPolicyFeatures.p1 || normalizedPolicyFeatures.p2) {
    // no-p0 只把「P0 的可接概率模型」换成不含本局证据的静态先验
    // （createUnconditionedBeatModel）；P1/P2 仍使用共享威胁模型 publicModel。
    // 两臂唯一差异是 p0 特征本身，归因干净——不会把“关 P0”偷换成“同时关掉 P1/P2”。
    decisionCtx.beatModel = createUnconditionedBeatModel(decisionCtx);
  } else {
    decisionCtx.beatModel = null;
  }
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
    const resourceSafe = ranked.filter((play) => (
      !isBombType(play.hand)
      && !isPremiumNonBombControl(play.hand, level)
      && !play.strategy?.tags?.includes('preserve_wild')
    ));
    const leadPool = c.difficulty !== 'easy' && resourceSafe.length
      ? resourceSafe
      : ranked;
    const best = finish.length && c.finishFirst ? finish[0] : pickByDifficulty(leadPool, c);
    const decision = { action: 'play', cards: best.cards, hand: best.hand };
    return respond(decision, ranked, reasonForCandidate(best, 'lead', decisionCtx), best);
  }

  const myTeam = teams[seat];
  const lastTeam = lastSeat != null ? teams[lastSeat] : -1;
  const isTeammate = lastTeam === myTeam && lastSeat !== seat;
  const partnerSeat = (seat + 2) % 4;
  const partnerFinished = finishOrder.includes(partnerSeat);

  // Finishing the hand has priority over every optional pass/resource rule.
  // Keep this before teammate cooperation, random passing and bomb preservation
  // so a complete bomb/straight-flush is never split instead of going out.
  const finishPlays = plays.filter((play) => play.cards.length === hand.length);
  if (finishPlays.length && c.finishFirst) {
    const ranked = rankPlays(finishPlays, 'beat', hand, level, decisionCtx, c, search);
    const best = ranked[0];
    return respond(
      { action: 'play', cards: best.cards, hand: best.hand },
      ranked,
      isTeammate
        ? '可以一手出完，争取名次优先于让牌'
        : '可以一手出完，直接锁定更好名次',
      best,
    );
  }

  // —— 队友配合 ——
  if (isTeammate && !partnerFinished) {
    if (downstreamEnemyNeedsBlock(lastHand, decisionCtx)) {
      const ranked = rankPlays(plays, 'beat', hand, level, decisionCtx, c, search);
      const best = selectEmergencyBlock(ranked, {
        ...decisionCtx, hand, level, mode: 'beat',
      });
      const downstream = (seat + 1) % 4;
      return respond(
        { action: 'play', cards: best.cards, hand: best.hand },
        ranked,
        `下家只剩${handCounts[downstream]}张，必须用较高控制牌抬高对家的牌，阻止对手直接走完`,
        best,
      );
    }

    // hard：几乎不压队友；easy：经常乱压。
    const forcePass = c.teammatePassRate >= 1
      || (c.teammatePassRate > 0 && Math.random() < c.teammatePassRate);
    if (forcePass || lastHand.power >= 10 || isBombType(lastHand)) {
      const ranked = options.explain
        ? rankPlays(plays, 'beat', hand, level, decisionCtx, c, search)
        : [];
      return respond({ action: 'pass' }, ranked, '队友正在控牌，避免打断搭档节奏');
    }

    if (c.difficulty === 'easy' && Math.random() < 0.45) {
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
    && c.randomPass > 0
    && Math.random() < c.randomPass
    && hand.length > 8
    && !enemyAboutToWin(handCounts, seat, teams, finishOrder)) {
    return respond({ action: 'pass' }, [], '保留牌力，等待更合适的接管时机');
  }

  const scored = rankPlays(plays, 'beat', hand, level, decisionCtx, c, search);
  let best = pickByDifficulty(scored, c);

  const activeEnemyMin = Math.min(...handCounts.map((count, i) => (
    i !== seat && !finishOrder.includes(i) && teams[i] !== teams[seat] ? count : 99
  )));
  const upstreamSeat = (seat + 3) % 4;
  const upstreamThreat = lastSeat === upstreamSeat
    && teams[upstreamSeat] !== teams[seat]
    && !finishOrder.includes(upstreamSeat)
    && handCounts[upstreamSeat] <= 6;
  const canConserveOrdinaryResponse = passOk && activeEnemyMin > 5 && !upstreamThreat;
  if (canConserveOrdinaryResponse && ordinaryResponseTooCostly(best)) {
    return respond(
      { action: 'pass' },
      scored,
      '当前普通接法会消耗逢人配或同时拆散多组关键结构；对手尚未进入五张内残局，保存牌型等待更高收益',
    );
  }
  if (passOk
    && hand.length > 8
    && activeEnemyMin > 5
    && !upstreamThreat
    && !best.strategy?.tags?.includes('stop_opponent_run')
    && isPremiumNonBombControl(best.hand, level)) {
    return respond(
      { action: 'pass' },
      scored,
      '对手尚未进入紧急残局，保留王或级牌控制，避免大牌打空后单吊小牌',
    );
  }


  const preservedStrongControl = scored.find((play) => isBombType(play.hand)
    && (play.strategy?.tags?.includes('survival_preserve_control')
      || (hand.length <= 12
        && play.hand.type === HandType.FLUSH_STRAIGHT
        && play.strategy?.tags?.includes('preserve_strong_control'))));
  const highPriorityBomb = scored.some((play) => isBombType(play.hand)
    && (play.strategy?.createsTwoStepFinish
      || play.strategy?.tags?.includes('bomb_escort')
      || play.strategy?.tags?.includes('timely_bomb')));
  const viableOrdinaryResponse = scored.some((play) => {
    if (isBombType(play.hand)) return false;
    const severeStructureDamage = play.strategy?.score <= -100
      && play.strategy?.tags?.some((tag) => ['split_straight', 'split_bomb'].includes(tag));
    return !severeStructureDamage;
  });
  if (passOk && preservedStrongControl && !highPriorityBomb
    && !viableOrdinaryResponse && activeEnemyMin > 2) {
    const survival = preservedStrongControl.strategy.tags.includes('survival_preserve_control');
    return respond(
      { action: 'pass' },
      scored,
      survival
        ? '对家已头游，允许当前对手争二游；留住唯一强控制去压另一名对手，保住三游并避免末游'
        : `当前接牌需要交出强控制或拆散关键结构，对手尚不紧急，保留${preservedStrongControl.hand.type === HandType.FLUSH_STRAIGHT ? '同花顺' : '炸弹'}等待更高收益`,
      preservedStrongControl,
    );
  }

  const bombCreatesTwoStepFinish = isBombType(best.hand)
    && !!best.strategy?.createsTwoStepFinish;
  // P0 记牌器：最优普通接法被（另一名）对手压回、对方团队继续持权的概率，
  // 用于判断不炸开是否就拦不住其推进。
  const bestNonBomb = scored.find((play) => !isBombType(play.hand));
  const stopRisk = policyFeatureActive(decisionCtx, 'p0')
    ? (bestNonBomb ? candidateBeatRisk(bestNonBomb, decisionCtx) : 1)
    : 0;
  // P2 炸弹净收益：对「现在炸 vs 走普通路线」做前瞻比较，仅信号决定性时覆盖启发式。
  const bombNet = computeBombNetGain(
    best, bestNonBomb, hand, level, decisionCtx, search, c,
  );
  const bombJustified = bombNet != null && bombNet >= c.bombNetPlayThresh;
  if (isBombType(best.hand)
    && !bombCreatesTwoStepFinish
    && !bombJustified
    && !shouldBomb(
      lastHand, lastSeat, hand, handCounts, seat, teams, finishOrder, c, best.strategy,
      options.deterministic, stopRisk, bombNet,
    )) {
    const nonBomb = scored.filter((p) => !isBombType(p.hand));
    if (nonBomb.length) {
      best = pickByDifficulty(nonBomb, c);
      if (canConserveOrdinaryResponse && ordinaryResponseTooCostly(best)) {
        return respond(
          { action: 'pass' },
          scored,
          '炸弹无需在当前交出，而普通接法又会消耗逢人配或严重破坏结构；保存整手牌力更有价值',
          best,
        );
      }
      if (best.score < -50 && hand.length > 10 && lastHand.power < 10
        && !upstreamThreat
        && !best.strategy?.tags?.includes('stop_opponent_run')
        && !best.strategy?.tags?.includes('stop_single_run')) {
        return respond(
          { action: 'pass' },
          scored,
          '普通接法的结构代价过高，当前对手不紧急，保留完整组合等待更高收益',
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
    if (hand.length - best.cards.length === 0
      || handCounts.some((cnt, i) => i !== seat
        && !finishOrder.includes(i)
        && teams[i] !== teams[seat]
        && cnt <= 3)) {
      return respond(
        { action: 'play', cards: best.cards, hand: best.hand },
        scored,
        reasonForCandidate(best, 'beat', decisionCtx),
        best,
      );
    }
    const survivalReserve = scored.find((play) => (
      play.strategy?.tags?.includes('survival_preserve_control')
    ));
    return respond(
      { action: 'pass' },
      scored,
      survivalReserve
        ? '对家已头游，允许当前对手争二游；留住唯一强控制去压另一名对手，保住三游并避免末游'
        : '当前只能用炸弹接牌，保留炸弹更有价值',
      survivalReserve || best,
    );
  }

  if (best.score < -50 && hand.length > 10 && lastHand.power < 10
    && !isBombType(lastHand) && !upstreamThreat
    && !best.strategy?.tags?.includes('stop_opponent_run')
    && !best.strategy?.tags?.includes('stop_single_run')) {
    if (c.difficulty !== 'easy' || Math.random() < 0.7) {
      return respond({ action: 'pass' }, scored, '接牌代价过高，暂时保留牌型结构');
    }
  }

  return respond(
    { action: 'play', cards: best.cards, hand: best.hand },
    scored,
    reasonForCandidate(best, 'beat', decisionCtx),
    best,
  );
}

function pickByDifficulty(scored, c = cfg()) {
  if (!scored.length) return null;
  if (c.difficulty === 'easy') {
    const k = Math.min(5, scored.length);
    return scored[Math.floor(Math.random() * k)];
  }
  // 普通难度只在质量近似的候选间保留少量变化，不能随机跳到明显浪费大牌的出法。
  if (c.difficulty === 'normal'
    && scored.length > 1
    && scored[0].score - scored[1].score <= 2
    && Math.random() < 0.12) {
    return scored[1];
  }
  return scored[0];
}

function enemyAboutToWin(handCounts, seat, teams, finishOrder = []) {
  return handCounts.some((count, i) => (
    i !== seat
    && !finishOrder.includes(i)
    && teams[i] !== teams[seat]
    && count > 0
    && count <= 3
  ));
}

/**
 * P0 记牌器：对手大概率能压过该候选的软概率，聚合所有活跃对手。
 * 策略模块通过显式 feature flag 独立门控；no-p0 只关闭本项，仍保留
 * expert 的统一策略权重以及 P1/P2 所需的共享公开概率模型。
 */
function policyFeatureActive(ctx, feature) {
  return ctx.policyFeatures?.[feature] !== false;
}

function candidateBeatRisk(play, ctx) {
  const beatModel = ctx.beatModel;
  if (!beatModel || !play?.hand) return 0;
  let p = 0;
  for (const enemy of beatModel.enemies) {
    const pr = beatModel.seatTypeBeat(play.hand, enemy.count, enemy.seat);
    p = p + pr - p * pr;
  }
  return p;
}

/**
 * P1 控权期望：出牌后被接回而丢权所承受的损失惩罚 L。
 * 对手临门一脚（finishRisk 高/张数少）或本手是高控牌被废时，丢权代价更大。
 */
function controlLossPenalty(play, ctx, c, level) {
  const model = ctx.publicModel;
  let loss = c.controlLossBase;
  if (model) {
    if ((model.nearestEnemy?.finishRisk || 0) >= 0.72) loss += c.controlLossFinishBoost;
    if (model.activeEnemyMin <= 5) loss += c.controlLossNearBoost;
  }
  if (isPremiumNonBombControl(play.hand, level)) loss += c.controlLossControlBoost;
  return loss;
}

function routeCostOf(hand, level, ctx, search, c) {
  const route = estimateThreeStepRoute(
    hand,
    level,
    { ...ctx, mode: 'lead', publicModel: ctx.publicModel },
    { depth: 3, beam: c.lookAheadFutureBeam + 1, cache: search.route },
  );
  return route.estimatedTricks * 18
    + route.loose * 2.5
    + route.controlsSpent * 1.8
    + (route.bombsSpent || 0) * 4
    - route.adjustment;
}

/**
 * P2 炸弹净收益：比较「不炸、走最优普通接法」与「炸、走炸后路线」的期望成本。
 * 仅在 expert 策略档 + 可接概率模型就绪时计算；无普通接法或整手出完时返回 null。
 * 只作用于残局/威胁语境：自己手牌已短（炸弹用于收官）或对手逼近（炸弹用于拦截），
 * 否则中盘大牌堆的炸弹是长期保险，路线比较不可靠，不应据此覆盖既有启发式。
 */
function computeBombNetGain(bombPlay, nonBombPlay, hand, level, ctx, search, c) {
  if (!c.bombNetEnabled || !policyFeatureActive(ctx, 'p2') || !ctx.beatModel) return null;
  if (!bombPlay || !isBombType(bombPlay.hand) || !nonBombPlay) return null;
  const model = ctx.publicModel;
  const threat = (model?.activeEnemyMin ?? 99) <= 6
    || (model?.nearestEnemy?.finishRisk || 0) >= 0.6;
  if (hand.length > 14 && !threat) return null;
  const remainOrd = removeCards(hand, nonBombPlay.cards);
  const remainBomb = removeCards(hand, bombPlay.cards);
  if (!remainOrd.length || !remainBomb.length) return null;
  const routeOrd = routeCostOf(remainOrd, level, ctx, search, c);
  const routeBomb = routeCostOf(remainBomb, level, ctx, search, c);
  const pLose = candidateBeatRisk(nonBombPlay, ctx);
  const lossPenalty = controlLossPenalty(nonBombPlay, ctx, c, level);
  return bombNetGain(routeOrd, routeBomb, pLose, lossPenalty, c.bombNetResource);
}

function tacticalAdjustment(play, mode, ctx, hand, level) {
  const strategy = evaluateStrategicPlay(play, {
    ...ctx, level, mode,
  });
  play.strategy = strategy;
  const positiveMessages = strategy.events
    .filter((event) => event.delta > 0 && event.message)
    .map((event) => event.message);
  play.tactics = [...new Set(
    positiveMessages.length > 0
      ? positiveMessages
      : strategy.score >= 0 ? strategy.reasons : [],
  )];
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

const RESPONSE_DAMAGE_WEIGHT = {
  split_bomb: 1000,
  split_flush_straight: 700,
  split_straight: 400,
  split_group: 250,
  split_pair: 180,
};

function responseDamage(play, level) {
  const tags = play.strategy?.tags || [];
  let damage = tags.reduce((sum, tag) => sum + (RESPONSE_DAMAGE_WEIGHT[tag] || 0), 0);
  if (!isBombType(play.hand) && play.cards.some((card) => isWild(card, level))) damage += 450;
  if (!isBombType(play.hand)) {
    damage += play.cards.filter((card) => isJoker(card)).length * 160;
  }
  return damage;
}

function hasUrgentStrategy(play) {
  const tags = play.strategy?.tags || [];
  return !!play.strategy?.createsTwoStepFinish
    || tags.some((tag) => [
      'stop_single_run', 'stop_opponent_run', 'bomb_escort', 'timely_bomb',
    ].includes(tag));
}

function enemyWithin(ctx, maximum) {
  return (ctx.handCounts || []).some((count, index) => (
    index !== ctx.seat
    && !(ctx.finishOrder || []).includes(index)
    && ctx.teams?.[index] !== ctx.teams?.[ctx.seat]
    && count <= maximum
  ));
}

/**
 * 普通接牌先比较结构损伤等级，再使用最小充分点数。明确残局拦截、护送或
 * 两手收官仍服从总策略分，不受该常规排序限制。
 */
function compareSafeBeatCandidates(a, b, mode, ctx, level) {
  if (mode === 'beat'
    && !enemyWithin(ctx, 4)
    && !isBombType(a.hand)
    && !isBombType(b.hand)
    && a.hand.type === b.hand.type
    && !hasUrgentStrategy(a)
    && !hasUrgentStrategy(b)) {
    const damageDifference = responseDamage(a, level) - responseDamage(b, level);
    if (damageDifference) return damageDifference;
    if (a.hand.power !== b.hand.power) return a.hand.power - b.hand.power;
    return 0;
  }
  return null;
}

function compareRankedPlays(a, b, mode, ctx, level) {
  const safeOrder = compareSafeBeatCandidates(a, b, mode, ctx, level);
  return safeOrder == null ? b.score - a.score : safeOrder || b.score - a.score;
}

/**
 * beam search 只展开有限候选。先后各归整一次同型候选，确保未展开标记不会
 * 把同组里更伤结构的出法重新顶到前面。
 */
function normalizeSafeBeatGroups(scored, mode, ctx, level) {
  if (mode !== 'beat' || enemyWithin(ctx, 4)) return;
  const positionsByType = new Map();
  for (let index = 0; index < scored.length; index++) {
    const play = scored[index];
    if (isBombType(play.hand) || hasUrgentStrategy(play)) continue;
    if (!positionsByType.has(play.hand.type)) positionsByType.set(play.hand.type, []);
    positionsByType.get(play.hand.type).push(index);
  }
  for (const positions of positionsByType.values()) {
    if (positions.length < 2) continue;
    const group = positions.map((index) => scored[index]).sort((a, b) => {
      const safeOrder = compareSafeBeatCandidates(a, b, mode, ctx, level);
      if (safeOrder) return safeOrder;
      const searchedDifference = Number(!!b.lookAhead) - Number(!!a.lookAhead);
      return searchedDifference || b.score - a.score;
    });
    positions.forEach((position, index) => { scored[position] = group[index]; });
  }
}

function ordinaryResponseTooCostly(play) {
  if (!play || isBombType(play.hand) || hasUrgentStrategy(play)) return false;
  const tags = play.strategy?.tags || [];
  if (tags.some((tag) => [
    'preserve_wild', 'wild_simple_use', 'wild_as_single',
  ].includes(tag))) return true;
  if (tags.includes('split_bomb') && !play.strategy?.productiveRestructure) return true;
  return play.strategy?.score <= -500
    && tags.some((tag) => [
      'split_bomb', 'split_flush_straight', 'split_straight', 'split_group', 'split_pair',
    ].includes(tag));
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
  lastHand, lastSeat, hand, handCounts, seat, teams, finishOrder, c, strategy, deterministic,
  stopRisk = 0, bombNet = null,
) {
  if (strategy?.tags?.includes('bomb_escort')) return true;
  // P0 记牌器：对手剩 5-6 张且本次领出高控牌/大组合（其推进难被普通接法低成本
  // 阻止）时，若连最优普通接法都大概率被压回、无法夺回牌权，则开炸及时拦截，
  // 优先于保留强控制。
  if (stopRisk >= 0.8
    && !isBombType(lastHand)
    && (lastHand?.power >= 11 || lastHand?.size >= 5)) {
    for (let i = 0; i < 4; i++) {
      if (i === seat || finishOrder.includes(i)) continue;
      if (teams[i] !== teams[seat] && handCounts[i] > 4 && handCounts[i] <= 6) return true;
    }
  }
  if (strategy?.tags?.includes('survival_preserve_control')
    || strategy?.tags?.includes('preserve_strong_control')) return false;
  // P2 炸弹净收益：普通路线期望成本显著更优时，即使启发式倾向开炸也保留炸弹。
  if (bombNet != null && bombNet <= -c.bombNetSaveThresh) return false;
  if (strategy?.tags?.includes('timely_bomb')) return true;
  if (isBombType(lastHand)) {
    const enemyMin = Math.min(...handCounts.map((count, i) => (
      i !== seat && !finishOrder.includes(i) && teams[i] !== teams[seat] ? count : 99
    )));
    // 中盘不能因为“能反炸”就自动交掉唯一控制牌；只在对手临近出完，
    // 或自己已进入短手残局时反炸。
    if (enemyMin <= 4) return true;
    if (hand.length <= 8) {
      const chance = 0.35 + c.aggressiveness * 0.45;
      return deterministic ? chance >= 0.5 : Math.random() < chance;
    }
    return c.difficulty === 'easy'
      ? (deterministic ? false : Math.random() < 0.2)
      : false;
  }
  for (let i = 0; i < 4; i++) {
    if (i === seat || finishOrder.includes(i)) continue;
    if (teams[i] !== teams[seat] && handCounts[i] <= 4) return true;
  }
  if (lastHand?.size > 0 && lastSeat != null
    && teams[lastSeat] !== teams[seat]
    && !finishOrder.includes(lastSeat)
    && handCounts[lastSeat] === lastHand.size) return true;
  if (hand.length <= 8) {
    const chance = 0.3 + c.aggressiveness * 0.5 + (stopRisk >= 0.8 ? 0.35 : 0);
    return deterministic ? chance >= 0.5 : Math.random() < chance;
  }
  if (c.difficulty === 'easy') return deterministic ? false : Math.random() < 0.35;
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
  }).sort((a, b) => compareRankedPlays(a, b, mode, ctx, level));
  normalizeSafeBeatGroups(scored, mode, ctx, level);

  if (c.lookAhead && scored.length > 1) {
    applyLookAhead(scored, hand, level, search, c, ctx, mode);
    // 困难模式采用 beam search：最终主选来自已完成前瞻的候选，未展开项仍保留作兜底。
    scored.sort((a, b) => {
      const aSearched = a.lookAhead ? 1 : 0;
      const bSearched = b.lookAhead ? 1 : 0;
      return bSearched - aSearched || compareRankedPlays(a, b, mode, ctx, level);
    });
    normalizeSafeBeatGroups(scored, mode, ctx, level);
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
  const sharedStructureDamage = play.strategy?.tags?.some((tag) => (
    ['split_bomb', 'split_flush_straight', 'split_straight', 'split_group', 'split_pair'].includes(tag)
  ));
  const safeLongCombination = play.cards.length >= 5 && !sharedStructureDamage;
  const splitWeight = play.strategy?.createsTwoStepFinish
    || play.strategy?.productiveRestructure
    || safeLongCombination
    ? 0
    : 1;
  score -= splitPenalty(hand, play.cards, level, search, beforeStructure)
    * 15 * c.structureWeight * splitWeight;
  score -= play.cards.filter((card) => isWild(card, level)).length * c.wildPenalty;
  score += structureBonus(removeCards(hand, play.cards), level, search) * c.structureWeight;

  if (hand.length <= 10) score += play.cards.length * 5;

  if (['hard', 'master'].includes(c.difficulty)
    && !isBombType(h) && play.cards.length >= 3 && h.power <= 9) {
    score += 12;
  }

  // P0 记牌器：仅当领出极大概率（>=0.8）被对手接掉时才压低该领法；
  // 中盘普通领法的可接概率普遍偏高，广谱惩罚只会变成近似常量噪声。
  if (policyFeatureActive(ctx, 'p0') && remain > 0 && !isBombType(h)) {
    const risk = candidateBeatRisk(play, ctx);
    if (risk >= 0.8) {
      score -= risk * c.leadBeatRiskPenalty
        * (isPremiumNonBombControl(h, level) ? 3 : 1);
    }
  }

  score += strategyScore;

  return score + (c.noise ? Math.random() * c.noise : 0);
}

function scoreBeat(play, hand, level, ctx, c, search, beforeStructure) {
  let score = 0;
  const h = play.hand;
  const remain = hand.length - play.cards.length;
  const strategyScore = tacticalAdjustment(play, 'beat', ctx, hand, level);

  if (remain === 0) score += 2000;
  score -= playResourcePower(h) * 2;
  if (isBombType(h) && !play.strategy?.createsTwoStepFinish) score -= c.bombBeatPenalty;

  const conditionalSingleBlock = play.strategy?.tags?.includes('stop_single_run');
  const sharedStructureDamage = play.strategy?.tags?.some((tag) => (
    ['split_bomb', 'split_flush_straight', 'split_straight', 'split_group', 'split_pair'].includes(tag)
  ));
  const safeLongCombination = play.cards.length >= 5 && !sharedStructureDamage;
  const splitWeight = play.strategy?.createsTwoStepFinish
    || play.strategy?.productiveRestructure
    || safeLongCombination
    ? 0
    : conditionalSingleBlock ? 0.18 : 1;
  score -= splitPenalty(hand, play.cards, level, search, beforeStructure)
    * 20 * c.structureWeight * splitWeight;
  score -= play.cards.filter((card) => isWild(card, level)).length * c.wildPenalty;
  score -= play.cards.filter((card) => isJoker(card)).length * 15;
  score += structureBonus(removeCards(hand, play.cards), level, search) * c.structureWeight;
  score += play.cards.length * 2;

  if (ctx.handCounts
    && enemyAboutToWin(ctx.handCounts, ctx.seat, ctx.teams, ctx.finishOrder)) {
    score += 80;
    if (isBombType(h)) score += 60;
  }

  // P0 记牌器：普通接法仅在极大概率（>=0.75）被压回时惩罚先消耗的控制牌；
  // 收官、护送或紧急拦截不受此惩罚。
  if (policyFeatureActive(ctx, 'p0') && remain > 0 && !isBombType(h)
    && !(ctx.handCounts
      && enemyAboutToWin(ctx.handCounts, ctx.seat, ctx.teams, ctx.finishOrder))
    && !play.strategy?.createsTwoStepFinish
    && !(play.strategy?.tags || []).some((tag) => [
      'stop_opponent_run', 'stop_single_run', 'timely_bomb', 'bomb_escort',
      'public_finish_block',
    ].includes(tag))) {
    const risk = candidateBeatRisk(play, ctx);
    if (risk >= 0.75) {
      const controlFactor = isPremiumNonBombControl(h, level) ? 1.6 : h.power >= 12 ? 1.2 : 0.6;
      score -= risk * c.beatBackRiskPenalty * controlFactor;
    }
  }

  score += strategyScore;

  return score + (c.noise ? Math.random() * c.noise : 0);
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
function applyLookAhead(scored, hand, level, search, c, ctx, mode) {
  const selected = selectLookAheadCandidates(scored, hand.length, c.lookAheadRootLimit);
  const projections = [];

  for (const [index, play] of selected.entries()) {
    const remain = removeCards(hand, play.cards);
    // 残局（手牌 ≤ lookAheadEndgameHand）对剩余手牌做满深度自手路线搜索，
    // 仍只搜自己的出牌顺序、不读取暗牌；其余沿用三步/两步轻量前瞻。
    // 残局满深度独立于 P0/P1/P2；独立消融时保持它开启，旧 baseline 则关闭。
    const endgame = policyFeatureActive(ctx, 'endgame')
      && remain.length > 0 && remain.length <= c.lookAheadEndgameHand;
    const depth = index < 8
      ? (remain.length <= 14 ? 3 : remain.length <= c.lookAheadDepthHand ? 2 : 1)
      : (remain.length <= c.lookAheadDepthHand ? 2 : 1);
    const route = estimateThreeStepRoute(
      remain,
      level,
      { ...ctx, mode: 'lead', publicModel: ctx.publicModel },
      endgame
        ? {
            fullDepth: true,
            beam: c.lookAheadFutureBeam + 1,
            cache: search.route,
            nodeBudget: c.lookAheadEndgameNodes,
          }
        : {
            depth,
            beam: c.lookAheadFutureBeam + 1,
            cache: search.route,
          },
    );
    const cost = route.estimatedTricks * 18
      + route.loose * 2.5
      + route.controlsSpent * 1.8
      + (route.bombsSpent || 0) * 4
      - route.adjustment;
    play.lookAhead = {
      projectedTricks: route.estimatedTricks,
      looseCards: route.loose,
      controlsSpent: route.controlsSpent,
      bombsSpent: route.bombsSpent || 0,
      routeTags: route.tags,
      depth,
      cost,
    };
    projections.push({ play, cost });
  }

  if (!projections.length) return;
  const averageCost = projections.reduce((sum, item) => sum + item.cost, 0) / projections.length;
  // P1 控权期望：只在 expert（A/B 对照组 baseline 关闭）与已建可接模型时启用。
  // 仅作用于接牌模式：领出时"难被接"的强牌更该保留（惜大打小），
  // 用 p 奖励强领会与既有领出策略冲突。
  const controlEnabled = policyFeatureActive(ctx, 'p1') && !!ctx.beatModel
    && c.controlLossBase > 0 && mode === 'beat';
  for (const { play, cost } of projections) {
    // 以候选均值为中心，既奖励更短的收尾路线，也惩罚明显拖长手数的路线。
    const routeAdjustment = (averageCost - cost) * 1.35;
    if (controlEnabled && !isBombType(play.hand)) {
      // EV = -C - p·L：p 为另一名对手同型压回（我方丢权）的联集概率；
      // 只有 (1-p) 概率能保持牌权兑现路线优势，否则承受丢权损失 L。
      // 仅当被压回风险极高时才覆盖原均值折减，避免广谱缩水变成噪声。
      const pLose = candidateBeatRisk(play, ctx);
      const lossPenalty = controlLossPenalty(play, ctx, c, level);
      play.lookAhead.adjustment = pLose >= 0.7
        ? controlEV(routeAdjustment, pLose, lossPenalty)
        : routeAdjustment;
      play.lookAhead.pLose = pLose;
      play.lookAhead.lossPenalty = lossPenalty;
    } else {
      play.lookAhead.adjustment = routeAdjustment;
    }
    play.score += play.lookAhead.adjustment;
  }
}

function selectLookAheadCandidates(scored, handSize, rootLimit = LOOK_AHEAD_ROOT_LIMIT) {
  return selectDiverseCandidates(scored, handSize, rootLimit + 2, Math.ceil(rootLimit / 2));
}

function selectDiverseCandidates(scored, handSize, limit, topBudget = Math.ceil(limit / 2)) {
  const selected = [];
  const seen = new Set();
  const add = (play) => {
    if (!play) return;
    const key = playKey(play);
    if (seen.has(key)) return;
    seen.add(key);
    selected.push(play);
  };

  for (const play of scored.filter((p) => p.cards.length === handSize)) add(play);
  for (const play of scored.slice(0, topBudget)) add(play);
  const seenTypes = new Set();
  for (const play of scored) {
    if (seenTypes.has(play.hand.type)) continue;
    seenTypes.add(play.hand.type);
    add(play);
    if (selected.length >= limit) break;
  }
  for (const play of scored
    .filter((p) => !isBombType(p.hand))
    .sort((a, b) => b.cards.length - a.cards.length || a.hand.power - b.hand.power)
    .slice(0, 2)) add(play);
  for (const play of scored) {
    if (selected.length >= limit) break;
    add(play);
  }
  return selected.slice(0, limit);
}

function projectRemainder(hand, level, search, depth, futureBeam = LOOK_AHEAD_FUTURE_BEAM) {
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
      if (future.length >= futureBeam) break;
    }

    let best = null;
    let bestCost = Infinity;
    for (const item of future) {
      const tail = projectRemainder(item.remain, level, search, depth - 1, futureBeam);
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
    const jokerTricks = smallJokers >= 2 && bigJokers >= 2
      ? 1
      : Number(smallJokers > 0) + Number(bigJokers > 0);
    let tricks = counts.size
      + jokerTricks
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
    route: new BoundedCache(SEARCH_CACHE_LIMIT * 2),
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
  if (candidate.tactics?.length) {
    const tactics = candidate.tactics.join('；');
    return candidate.lookAhead
      ? `${tactics}；前瞻后预计还需约 ${candidate.lookAhead.projectedTricks} 手`
      : tactics;
  }
  const costLabels = {
    split_pair: '拆开对子',
    split_group: '拆开三同张',
    split_bomb: '削弱炸弹结构',
    split_flush_straight: '消耗已成型同花顺',
    split_straight: '削弱顺子结构',
    split_ready_fullhouse: '拆开现成三带二结构',
    preserve_wild: '消耗逢人配资源',
    wild_simple_use: '把逢人配用于普通牌型',
  };
  const costs = [...new Set((candidate.strategy?.tags || [])
    .map((tag) => costLabels[tag])
    .filter(Boolean))];
  if (costs.length) {
    const suffix = candidate.lookAhead
      ? `，前瞻后预计还需约 ${candidate.lookAhead.projectedTricks} 手`
      : '';
    return `虽会${costs.join('、')}，但综合当前牌权和后续路线仍采用此手${suffix}`;
  }
  if (isBombType(candidate.hand)
    && enemyAboutToWin(ctx.handCounts, ctx.seat, ctx.teams, ctx.finishOrder)) {
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
  result.candidates = selectDiverseCandidates(
    ranked,
    ctx.hand.length,
    12,
    6,
  ).map((play, index) => ({
    id: `candidate_${index}`,
    action: 'play',
    cards: play.cards.map((card) => ({
      id: card.id,
      rank: card.rank,
      suit: card.suit,
    })),
    hand: play.hand ? {
      type: play.hand.type,
      mainRank: play.hand.mainRank,
      size: play.hand.size,
      power: play.hand.power,
    } : null,
    signature: handSignature(play.hand),
    projectedTricks: play.lookAhead?.projectedTricks ?? null,
    routeTags: play.lookAhead?.routeTags || [],
    tags: play.strategy?.tags || [],
    localScore: Number.isFinite(play.score) ? Math.round(play.score * 10) / 10 : null,
  }));
  if (ctx.lastHand) {
    result.candidates.push({ id: 'pass', action: 'pass', cards: [], hand: null, signature: null });
  }
  result.localCandidateId = decision.action === 'pass'
    ? (ctx.lastHand ? 'pass' : null)
    : result.candidates.find((item) => item.action === 'play'
      && `${cardsKey(item.cards)}|${item.signature}` === chosenKey)?.id || null;
  return result;
}

/**
 * 为可选云端增强生成本地完整候选集。云端只能在这些合法候选中选择，
 * 因此无论模型输出什么，都不会绕过本地规则校验。
 */
export function getAIConsultation(ctx) {
  const consultation = chooseAIPlayInternal({
    ...ctx,
    policyProfile: ctx.policyProfile === 'baseline' ? 'baseline' : 'expert',
  }, {
    explain: true,
    deterministic: true,
    difficulty: AI_DIFFICULTY[ctx?.difficulty] || _difficulty,
  });
  if (!consultation?.candidates?.length) return consultation;
  const localCandidate = consultation.candidates.find(
    (candidate) => candidate.id === consultation.localCandidateId,
  );
  if (!localCandidate) return consultation;

  let cloudConstraint = 'soft_rerank';
  const teammateLead = ctx.lastSeat != null
    && ctx.lastSeat !== ctx.seat
    && ctx.teams?.[ctx.lastSeat] === ctx.teams?.[ctx.seat];
  const emergencyPartnerBlock = teammateLead && downstreamEnemyNeedsBlock(ctx.lastHand, ctx);
  const finishesNow = consultation.action === 'play'
    && consultation.cards?.length === ctx.hand?.length;
  const hardTags = new Set([
    'stop_single_run', 'stop_opponent_run', 'public_finish_block',
    'bomb_escort', 'timely_bomb',
  ]);
  const localHasHardTag = (localCandidate.tags || []).some((tag) => hardTags.has(tag));

  if (finishesNow) cloudConstraint = 'finish_now';
  else if (teammateLead && !emergencyPartnerBlock && consultation.action === 'pass') {
    cloudConstraint = 'yield_to_partner';
  } else if (emergencyPartnerBlock || localHasHardTag) {
    cloudConstraint = 'mandatory_block';
  }

  if (cloudConstraint !== 'soft_rerank') {
    return {
      ...consultation,
      candidates: [localCandidate],
      cloudConstraint,
    };
  }
  // CodingPlan/兼容网关对候选数量和提示长度较敏感。云端只负责在本地
  // 已经筛过的安全路线中做轻量重排，不需要重复接收完整候选池；保留
  // 本地首选、过牌（若存在）和一个最佳替代即可，完整搜索仍留在本地。
  const cloudCandidates = [];
  const addCandidate = (candidate) => {
    if (!candidate || cloudCandidates.some((item) => item.id === candidate.id)) return;
    if (cloudCandidates.length < 3) cloudCandidates.push(candidate);
  };
  const candidateType = (candidate) => candidate.action === 'pass'
    ? 'pass'
    : (candidate.hand?.type || candidate.action || 'unknown');
  addCandidate(localCandidate);
  addCandidate(consultation.candidates.find((candidate) => candidate.action === 'pass'));
  const types = new Set(cloudCandidates.map(candidateType));
  for (const candidate of consultation.candidates) {
    if (candidate.action === 'play' && !types.has(candidateType(candidate))) {
      addCandidate(candidate);
      types.add(candidateType(candidate));
    }
    if (cloudCandidates.length >= 3) break;
  }
  // 若牌型不足三类，再用原排序补齐，仍严格不超过三个候选。
  for (const candidate of consultation.candidates) {
    if (cloudCandidates.length >= 3) break;
    addCandidate(candidate);
  }
  return { ...consultation, candidates: cloudCandidates };
}

/** 教练推荐：用确定性的“大师”策略给出主选、理由与最多三个备选。 */
export function recommendPlay(ctx) {
  return chooseAIPlayInternal({ ...ctx, policyProfile: 'expert' }, {
    explain: true,
    deterministic: true,
    difficulty: AI_DIFFICULTY.master,
  });
}

export function chooseTributeCard(hand, level) {
  const candidates = hand.filter((card) => !isWild(card, level));
  if (!candidates.length) return hand[0];
  const highestPower = Math.max(...candidates.map((card) => soloPower(card, level)));
  return chooseStructureSafeCard(
    candidates.filter((card) => soloPower(card, level) === highestPower),
    hand,
    level,
  );
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
  return chooseStructureSafeCard(final, hand, level, { toPartner, counts });
}

function naturalGroupProfile(cards, level) {
  const counts = new Map();
  for (const card of cards) {
    if (isJoker(card) || isWild(card, level)) continue;
    counts.set(card.rank, (counts.get(card.rank) || 0) + 1);
  }
  return {
    triples: [...counts.values()].filter((count) => count >= 3).length,
    pairs: [...counts.values()].filter((count) => count >= 2).length,
  };
}

function compareVector(left, right) {
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function chooseStructureSafeCard(candidates, hand, level, { toPartner = null, counts = null } = {}) {
  if (candidates.length <= 1) return candidates[0] || null;
  const search = createSearchContext(level);
  const beforeBombs = countPotentialBombs(hand, level);
  const beforeFlushes = completedFlushStraightCount(hand, level);
  const beforeStraights = countDisjointStraights(hand, level);
  const beforeGroups = naturalGroupProfile(hand, level);
  const beforeTricks = fastTrickEstimate(hand, level, search).tricks;
  const rankCounts = counts || hand.reduce((map, card) => {
    if (!isJoker(card) && !isWild(card, level)) {
      map.set(card.rank, (map.get(card.rank) || 0) + 1);
    }
    return map;
  }, new Map());

  return candidates.map((card) => {
    const remaining = removeCards(hand, [card]);
    const groups = naturalGroupProfile(remaining, level);
    const hardStructure = [
      Math.max(0, beforeBombs - countPotentialBombs(remaining, level)),
      Math.max(0, beforeFlushes - completedFlushStraightCount(remaining, level)),
      Math.max(0, beforeStraights - countDisjointStraights(remaining, level)),
    ];
    const softStructure = [
      Math.max(0, beforeGroups.triples - groups.triples),
      Math.max(0, beforeGroups.pairs - groups.pairs),
      Math.max(0, fastTrickEstimate(remaining, level, search).tricks - beforeTricks),
    ];
    const count = rankCounts.get(card.rank) || 0;
    const tactical = toPartner == null ? 0
      : toPartner
        ? Number(!(card.rank < 5 && count === 1))
        : Number(!(card.rank > 5 && count >= 2));
    const rankOrder = toPartner === false ? -card.rank : card.rank;
    return { card, hardStructure, softStructure, tactical, rankOrder };
  }).sort((left, right) => (
    compareVector(left.hardStructure, right.hardStructure)
    || left.tactical - right.tactical
    || compareVector(left.softStructure, right.softStructure)
    || left.rankOrder - right.rankOrder
    || String(left.card.id).localeCompare(String(right.card.id))
  ))[0].card;
}
