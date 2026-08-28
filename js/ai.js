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
  analyzeSingleRunPressure, completedFlushStraightCount, countDisjointStraights,
  countPotentialBombs, createStrategicMemo, downstreamEnemyNeedsBlock,
  evaluateStrategicPlay, selectEmergencyBlock, assessTeamFinishDelay,
  RESPONSE_DAMAGE_WEIGHT, selectPressureOrdinaryResponse, strategicResponseDamage,
} from './strategy-core.js';
import {
  estimateThreeStepRoute, inferPublicThreats, createBeatModel,
  enemyBombExposureProbability, orderedTeamControlLossProbability,
  evaluatePublicResponseTree, evaluatePublicEndgameRollout,
  publicPartnerProtectionValue,
} from './ai-route.js';
import { chooseHybridFromConsultation } from './ai-hybrid.js';
import { opponentPlayAdjustment } from './opponent-model.js';

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

const CONTROL_V2_FEATURE_KEYS = Object.freeze([
  'controlRiskV2',
  'cheapControl',
  'partnerCover',
  'placementControl',
  'publicLockLead',
]);
const POLICY_FEATURE_KEYS = [
  'p0', 'p1', 'p1ResponseSearch', 'p2', 'p3', 'p4', 'p5',
  'endgame', 'controlV2', 'teamFinishDelay', 'emergencyOrdinaryBlock',
  'softOrdinaryPressure', 'highShedRunBlock',
  ...CONTROL_V2_FEATURE_KEYS,
];
const EXPERT_POLICY_FEATURES = Object.freeze({
  p0: true,
  p1: true,
  // P1 升级为一层公开应手树；p1-legacy 变体可单独关闭该搜索，保留旧控权校正。
  p1ResponseSearch: true,
  // P2 v2 只在公开威胁/短手语境下比较炸、普通接与过牌，并把有序应手树
  // 纳入净收益；P3/P4/P5 分别负责搭档交接、残局情景 rollout 与模块融合校准。
  p2: true,
  p3: true,
  p4: true,
  p5: true,
  endgame: true,
  controlV2: true,
  // 两批跨级独立消融中，新有序控权概率一批中性、一批负向；
  // 保留 only-control-risk 实验臂，未达到发布证据前不改变正式 P0/P1。
  controlRiskV2: false,
  cheapControl: true,
  // 独立跨级消融显示“只因下家短手就机械抬高对家牌”有负收益；
  // 保留实验臂和共享标签，但正式策略继续让对家控牌。
  partnerCover: false,
  placementControl: true,
  publicLockLead: true,
  teamFinishDelay: true,
  emergencyOrdinaryBlock: true,
  // 十张软压力在首批未见种子镜像赛显著负向；保留显式实验臂，正式大师
  // 只发布五张硬残局拦截。
  softOrdinaryPressure: false,
  // 真实复盘实验：对手跨牌型连续控圈且短时间大量减牌时，允许用最低损伤
  // 普通牌截断。先保留为独立实验臂，镜像赛通过后再发布到大师默认策略。
  highShedRunBlock: false,
});
const EXPERIMENTAL_P2_POLICY_FEATURES = Object.freeze({
  ...EXPERT_POLICY_FEATURES,
  p2: true,
});
const BASELINE_POLICY_FEATURES = Object.freeze({
  p0: false,
  p1: false,
  p1ResponseSearch: false,
  p2: false,
  p3: false,
  p4: false,
  p5: false,
  endgame: false,
  controlV2: false,
  controlRiskV2: false,
  cheapControl: false,
  partnerCover: false,
  placementControl: false,
  publicLockLead: false,
  teamFinishDelay: false,
  emergencyOrdinaryBlock: false,
  softOrdinaryPressure: false,
  highShedRunBlock: false,
});

function withControlV2Features(features, enabled) {
  return Object.freeze({
    ...features,
    controlV2: enabled,
    ...Object.fromEntries(CONTROL_V2_FEATURE_KEYS.map((key) => [key, enabled])),
  });
}

function withOnlyControlV2Feature(key) {
  return Object.freeze({
    ...EXPERT_POLICY_FEATURES,
    controlV2: true,
    ...Object.fromEntries(CONTROL_V2_FEATURE_KEYS.map((item) => [item, item === key])),
  });
}

const PAIRED_ROOT_PIMC_POLICY_VARIANT = Object.freeze({
  policyProfile: 'expert',
  policyFeatures: EXPERT_POLICY_FEATURES,
  decisionEngine: 'ismcts',
});

/**
 * 独立策略消融定义。no-p0/no-p1/no-p2 始终保留 expert 的统一策略权重，
 * 只关闭被测模块，避免旧 baseline 同时关闭多项能力而污染归因。
 */
export const AI_POLICY_VARIANTS = Object.freeze({
  expert: Object.freeze({
    policyProfile: 'expert',
    policyFeatures: EXPERT_POLICY_FEATURES,
    decisionEngine: 'expert',
  }),
  'hybrid-v1': Object.freeze({
    policyProfile: 'expert',
    policyFeatures: EXPERT_POLICY_FEATURES,
    decisionEngine: 'hybrid',
  }),
  // 成对根 PIMC 实验引擎：仍受专家候选安全门保护，在同一公平世界池中
  // 覆盖全部根候选；正式默认仍是 expert。
  'root-pimc-v1': PAIRED_ROOT_PIMC_POLICY_VARIANT,
  // 旧报告/命令的兼容别名；新评测和文档使用 root-pimc-v1。
  'ismcts-v1': PAIRED_ROOT_PIMC_POLICY_VARIANT,
  'p2-on': Object.freeze({
    policyProfile: 'expert',
    policyFeatures: EXPERIMENTAL_P2_POLICY_FEATURES,
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
    policyFeatures: Object.freeze({
      ...EXPERT_POLICY_FEATURES,
      p1: false,
      p1ResponseSearch: false,
    }),
  }),
  'p1-legacy': Object.freeze({
    policyProfile: 'expert',
    policyFeatures: Object.freeze({ ...EXPERT_POLICY_FEATURES, p1ResponseSearch: false }),
  }),
  'no-p2': Object.freeze({
    policyProfile: 'expert',
    policyFeatures: Object.freeze({ ...EXPERT_POLICY_FEATURES, p2: false }),
  }),
  'no-p3': Object.freeze({
    policyProfile: 'expert',
    policyFeatures: Object.freeze({ ...EXPERT_POLICY_FEATURES, p3: false }),
  }),
  'no-p4': Object.freeze({
    policyProfile: 'expert',
    policyFeatures: Object.freeze({ ...EXPERT_POLICY_FEATURES, p4: false }),
  }),
  'no-p5': Object.freeze({
    policyProfile: 'expert',
    policyFeatures: Object.freeze({ ...EXPERT_POLICY_FEATURES, p5: false }),
  }),
  'p1-only': Object.freeze({
    policyProfile: 'expert',
    policyFeatures: Object.freeze({
      ...EXPERT_POLICY_FEATURES,
      p2: false,
      p3: false,
      p4: false,
      p5: false,
    }),
  }),
  'none': Object.freeze({
    policyProfile: 'expert',
    policyFeatures: Object.freeze({
      ...EXPERT_POLICY_FEATURES,
      p0: false,
      p1: false,
      p1ResponseSearch: false,
      p2: false,
      p3: false,
      p4: false,
      p5: false,
    }),
  }),
  'no-control-v2': Object.freeze({
    policyProfile: 'expert',
    policyFeatures: withControlV2Features(EXPERT_POLICY_FEATURES, false),
  }),
  'only-control-risk': Object.freeze({
    policyProfile: 'expert',
    policyFeatures: withOnlyControlV2Feature('controlRiskV2'),
  }),
  'only-cheap-control': Object.freeze({
    policyProfile: 'expert',
    policyFeatures: withOnlyControlV2Feature('cheapControl'),
  }),
  'only-partner-cover': Object.freeze({
    policyProfile: 'expert',
    policyFeatures: withOnlyControlV2Feature('partnerCover'),
  }),
  'only-placement-control': Object.freeze({
    policyProfile: 'expert',
    policyFeatures: withOnlyControlV2Feature('placementControl'),
  }),
  'only-public-lock': Object.freeze({
    policyProfile: 'expert',
    policyFeatures: withOnlyControlV2Feature('publicLockLead'),
  }),
  // 8 月真实牌局复盘形成的两个独立发布门：一个只处理团队名次下的延迟
  // 出完，一个只处理十/五张压力区的最低损伤普通接牌，便于逐项消融。
  'no-team-finish-delay': Object.freeze({
    policyProfile: 'expert',
    policyFeatures: Object.freeze({ ...EXPERT_POLICY_FEATURES, teamFinishDelay: false }),
  }),
  'no-emergency-ordinary-block': Object.freeze({
    policyProfile: 'expert',
    policyFeatures: Object.freeze({ ...EXPERT_POLICY_FEATURES, emergencyOrdinaryBlock: false }),
  }),
  'no-replay-v2': Object.freeze({
    policyProfile: 'expert',
    policyFeatures: Object.freeze({
      ...EXPERT_POLICY_FEATURES,
      teamFinishDelay: false,
      emergencyOrdinaryBlock: false,
    }),
  }),
  'with-soft-ordinary-pressure': Object.freeze({
    policyProfile: 'expert',
    policyFeatures: Object.freeze({ ...EXPERT_POLICY_FEATURES, softOrdinaryPressure: true }),
  }),
  'with-high-shed-run-block': Object.freeze({
    policyProfile: 'expert',
    policyFeatures: Object.freeze({ ...EXPERT_POLICY_FEATURES, highShedRunBlock: true }),
  }),
  // 实验性锐化变体：仅在 head-to-head A/B 中使用，不改默认 expert 行为。
  // 默认 expert 的 P0/P1 阈值是 p0LeadGate=0.8 / p0StopGate=0.8 /
  // p1SpreadFloor=0.04；锐化变体用于验证模块只在风险差更明显时介入的灵敏度。
  'p0-sharp': Object.freeze({
    policyProfile: 'expert',
    policyFeatures: Object.freeze({ ...EXPERT_POLICY_FEATURES }),
    policyThresholds: Object.freeze({
      p0LeadGate: 0.9,
      p0StopGate: 0.9,
    }),
  }),
  // 实验性幅度变体：保留默认门槛，只缩放 P0 高控制领出的风险惩罚，供消融与
  // 灵敏度分析使用；不作为默认 expert 的隐式配置。
  'p0-soft': Object.freeze({
    policyProfile: 'expert',
    policyFeatures: Object.freeze({ ...EXPERT_POLICY_FEATURES }),
    policyThresholds: Object.freeze({
      p0LeadScale: 0.35,
    }),
  }),
  'p1-sharp': Object.freeze({
    policyProfile: 'expert',
    policyFeatures: Object.freeze({ ...EXPERT_POLICY_FEATURES }),
    policyThresholds: Object.freeze({
      p1SpreadFloor: 0.14,
    }),
  }),
  // 实验性幅度变体：保留 P1 默认触发门，只缩放相对控权差的影响，供
  // 独立灵敏度分析使用。
  'p1-soft': Object.freeze({
    policyProfile: 'expert',
    policyFeatures: Object.freeze({ ...EXPERT_POLICY_FEATURES }),
    policyThresholds: Object.freeze({
      p1LossScale: 0.35,
    }),
  }),
  // P5 离线校准候选。只有显式 A/B/校准脚本会选择这些幅度臂；正式档
  // 使用上面的保守默认值，脚本不会在运行时自改权重。
  'p5-soft': Object.freeze({
    policyProfile: 'expert',
    policyFeatures: Object.freeze({ ...EXPERT_POLICY_FEATURES }),
    policyThresholds: Object.freeze({
      p2ControlScale: 0.8,
      p3Scale: 0.75,
      p4Scale: 0.72,
      p5FusionCap: 22,
    }),
  }),
  'p5-wide': Object.freeze({
    policyProfile: 'expert',
    policyFeatures: Object.freeze({ ...EXPERT_POLICY_FEATURES }),
    policyThresholds: Object.freeze({
      p2ControlScale: 1.08,
      p3Scale: 1,
      p4Scale: 0.92,
      p5FusionCap: 36,
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
    policyThresholds: variant.policyThresholds ? { ...variant.policyThresholds } : null,
    decisionEngine: ['hybrid', 'ismcts'].includes(variant.decisionEngine)
      ? variant.decisionEngine : 'expert',
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
        controlLossBase: 0,
        controlLossFinishBoost: 0,
        controlLossControlBoost: 0,
        controlLossNearBoost: 0,
        responseSearchRootLimit: 0,
        responseSearchMaxAdjustment: 0,
        partnerSearchRootLimit: 0,
        partnerSearchMaxAdjustment: 0,
        rolloutRootLimit: 0,
        rolloutBranchLimit: 0,
        rolloutEndgameHand: 0,
        rolloutMaxAdjustment: 0,
        policyFusionCap: 0,
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
        controlLossBase: 22,
        controlLossFinishBoost: 30,
        controlLossControlBoost: 15,
        controlLossNearBoost: 35,
        responseSearchRootLimit: 8,
        responseSearchMaxAdjustment: 28,
        partnerSearchRootLimit: 6,
        partnerSearchMaxAdjustment: 18,
        rolloutRootLimit: 3,
        rolloutBranchLimit: 3,
        rolloutEndgameHand: 8,
        rolloutMaxAdjustment: 17,
        policyFusionCap: 28,
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
        controlLossBase: 16,
        controlLossFinishBoost: 25,
        controlLossControlBoost: 12,
        controlLossNearBoost: 30,
        responseSearchRootLimit: 6,
        responseSearchMaxAdjustment: 22,
        partnerSearchRootLimit: 4,
        partnerSearchMaxAdjustment: 14,
        rolloutRootLimit: 3,
        rolloutBranchLimit: 2,
        rolloutEndgameHand: 7,
        rolloutMaxAdjustment: 13,
        policyFusionCap: 24,
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
        controlLossBase: 12,
        controlLossFinishBoost: 20,
        controlLossControlBoost: 10,
        controlLossNearBoost: 25,
        responseSearchRootLimit: 4,
        responseSearchMaxAdjustment: 14,
        partnerSearchRootLimit: 3,
        partnerSearchMaxAdjustment: 10,
        rolloutRootLimit: 2,
        rolloutBranchLimit: 2,
        rolloutEndgameHand: 6,
        rolloutMaxAdjustment: 10,
        policyFusionCap: 18,
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
  const selectedDifficulty = AI_DIFFICULTY[ctx?.difficulty] || _difficulty;
  if (['hybrid', 'ismcts'].includes(ctx?.decisionEngine)
    && selectedDifficulty === AI_DIFFICULTY.master) {
    const consultation = getAIConsultation(ctx, {
      deterministic: !!ctx?.deterministic,
      timeBudgetMs: Number(ctx?.timeBudgetMs) || 0,
      applyHybrid: true,
    });
    if (!consultation?.action) return null;
    return {
      action: consultation.action,
      ...(consultation.action === 'play'
        ? {
            cards: consultation.cards,
            hand: consultation.hand,
            signature: consultation.signature || handSignature(consultation.hand),
          }
        : {}),
      reason: consultation.reason || '',
      projectedTricks: consultation.projectedTricks ?? null,
      hybrid: consultation.hybrid || null,
    };
  }
  return chooseAIPlayInternal(ctx, {
    explain: false,
    deterministic: !!ctx?.deterministic,
    difficulty: selectedDifficulty,
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
    c.responseSearchRootLimit += 2;
    c.partnerSearchRootLimit += 1;
    c.rolloutRootLimit += 1;
    c.rolloutBranchLimit += 1;
  } else if (budget >= 150) {
    c.lookAheadRootLimit += 4;
    c.lookAheadEndgameHand += 2;
    c.responseSearchRootLimit += 1;
    c.rolloutRootLimit += 1;
  }
  return c;
}

function monotonicNow() {
  return globalThis.performance?.now?.() ?? Date.now();
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
    policyThresholds = null,
    decisionEngine = 'expert',
    opponentModel = null,
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
    policyThresholds: policyThresholds ? { ...policyThresholds } : null,
    decisionEngine: ['hybrid', 'ismcts'].includes(decisionEngine) ? decisionEngine : 'expert',
    opponentModel: opponentModel || null,
    difficulty: selectedDifficulty,
    strategyWeight: c.strategyWeight,
    // 真实对局严格受思考预算约束；超时只跳过尚未完成的 P1 扩展，沿用已经
    // 排好的本地候选。确定性单测/A-B 不设墙钟截止点，保证完全可复现。
    searchDeadlineMs: !options.deterministic && options.timeBudgetMs > 0
      ? monotonicNow() + Math.max(12, options.timeBudgetMs * 0.82)
      : null,
  };
  decisionCtx.strategyMemo = createStrategicMemo(decisionCtx.hand, level);
  decisionCtx.publicModel = inferPublicThreats(decisionCtx);
  if (normalizedPolicyFeatures.p0
    || normalizedPolicyFeatures.p1
    || normalizedPolicyFeatures.p1ResponseSearch
    || normalizedPolicyFeatures.p2
    || normalizedPolicyFeatures.p3
    || normalizedPolicyFeatures.p4) {
    // 可接概率是 P0-P4 共用的公开信息输入，不属于某一个 feature 的开关。
    // no-p0 只关闭 P0 的领出/接牌/拦截分支，其它模块仍读取完全相同的模型，
    // 才能保证消融两臂只有一个变量。
    decisionCtx.beatModel = createBeatModel(decisionCtx);
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

  // 一手出完通常优先；但整手强控制在团队名次仍未确定时可以延迟一次，
  // 避免“个人先走”硬门越过对家争头游/双上的判断。
  const finishPlays = plays.filter((play) => play.cards.length === hand.length);
  if (finishPlays.length && c.finishFirst) {
    const ranked = rankPlays(finishPlays, 'beat', hand, level, decisionCtx, c, search);
    const best = ranked[0];
    const finishDelay = assessTeamFinishDelay(best, decisionCtx);
    if (finishDelay.shouldDelay) {
      return respond(
        { action: 'pass', tacticalConstraint: 'team_finish_delay' },
        ranked,
        finishDelay.reason,
        best,
      );
    }
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

    const downstream = (seat + 1) % 4;
    if (policyFeatureActive(decisionCtx, 'p3') && c.difficulty !== 'easy') {
      const protectionRanked = rankPlays(
        plays,
        'beat',
        hand,
        level,
        decisionCtx,
        { ...c, lookAhead: false },
        search,
      );
      const partnerProtection = selectPartnerProtection(
        protectionRanked,
        decisionCtx,
        level,
      );
      if (partnerProtection) {
        return respond(
          { action: 'play', cards: partnerProtection.cards, hand: partnerProtection.hand },
          protectionRanked,
          `公开应手模型显示下家接走对家牌权的风险可由${partnerProtection.riskReductionPercent}%降到更低，且本手不拆组合、不用王或逢人配；用最低成本抬门保护团队牌权`,
          partnerProtection,
        );
      }
    }

    if (c.difficulty !== 'easy'
      && handCounts[downstream] <= 5
      && (handCounts[lastSeat] ?? 99) > 5
      && lastHand.power <= 9
      && !isBombType(lastHand)) {
      // 仅在明确短手威胁下做一次无前瞻的共享策略评分；普通队友回合仍零额外搜索。
      const coverRanked = rankPlays(
        plays,
        'beat',
        hand,
        level,
        decisionCtx,
        { ...c, lookAhead: false },
        search,
      );
      const partnerCover = selectTaggedSafeControl(coverRanked, 'partner_cover', level);
      if (partnerCover) {
        return respond(
          { action: 'play', cards: partnerCover.cards, hand: partnerCover.hand },
          coverRanked,
          `下家只剩${handCounts[downstream]}张，用不拆结构的普通牌安全抬高门槛，协助对家守住牌权`,
          partnerCover,
        );
      }
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
    && c.difficulty === 'easy'
    && Math.random() < c.randomPass
    && hand.length > 8
    && !enemyAboutToWin(handCounts, seat, teams, finishOrder)) {
    return respond({ action: 'pass' }, [], '保留牌力，等待更合适的接管时机');
  }

  const scored = rankPlays(plays, 'beat', hand, level, decisionCtx, c, search);
  let best = pickByDifficulty(scored, c);
  const cheapControlTake = c.difficulty !== 'easy'
    ? selectTaggedSafeControl(scored, 'cheap_control_take', level)
    : null;
  if (cheapControlTake) best = cheapControlTake;

  const activeEnemyMin = Math.min(...handCounts.map((count, i) => (
    i !== seat && !finishOrder.includes(i) && teams[i] !== teams[seat] ? count : 99
  )));
  const upstreamSeat = (seat + 3) % 4;
  const upstreamThreat = lastSeat === upstreamSeat
    && teams[upstreamSeat] !== teams[seat]
    && !finishOrder.includes(upstreamSeat)
    && handCounts[upstreamSeat] <= 6;
  const singleRunPressure = analyzeSingleRunPressure(
    { ...decisionCtx, mode: 'beat' },
    decisionCtx.publicModel?.history,
  );
  const singleRunBlock = singleRunPressure.active
    ? selectSingleRunBlock(scored, level)
    : null;
  if (singleRunBlock) best = singleRunBlock;
  const mustTakeCheapControl = !!cheapControlTake && !singleRunBlock;
  const bestNonBomb = scored.find((play) => !isBombType(play.hand));
  const bestBomb = scored.find((play) => isBombType(play.hand));
  const pressureOrdinary = policyFeatureActive(decisionCtx, 'emergencyOrdinaryBlock')
    ? selectPressureOrdinaryResponse(scored, decisionCtx)
    : null;
  // P2 同时比较最优普通接法、最优炸弹与过牌。旧实现只在“当前第一名本来
  // 就是炸弹”时计算，既不能把次优炸弹提升上来，也无法判断只能炸时是否该过。
  const bombChoice = computeBombActionChoice(
    bestBomb, bestNonBomb, hand, level, decisionCtx, search, c,
  );
  const bombNet = bombChoice?.bombNet ?? null;
  // P2 v2 允许公开应手净收益在小范围内覆盖基础排名，但仍设结构分护栏；
  // 不能因为一个噪声概率把明显更差、拆结构的炸弹强行抬成第一名。
  const p2ScoreMargin = policyThreshold(decisionCtx, 'p2ScoreMargin', 18);
  const bombScoreAligned = !bestNonBomb || !bestBomb
    || bestBomb.score >= bestNonBomb.score - p2ScoreMargin;
  const bombJustified = !singleRunBlock
    && !mustTakeCheapControl
    && bombChoice?.action === 'bomb'
    && bombChoice.advantage >= c.bombNetPlayThresh
    && bombScoreAligned;
  if (bombJustified && bestBomb) best = bestBomb;
  else if (!singleRunBlock
    && bombChoice?.action === 'ordinary'
    && bombChoice.advantage >= c.bombNetSaveThresh
    && bestNonBomb) best = bestNonBomb;
  if (!bombJustified && pressureOrdinary?.play) best = pressureOrdinary.play;
  const p2PassPreferred = !singleRunBlock
    && !mustTakeCheapControl
    && !pressureOrdinary
    && bombChoice?.action === 'pass'
    && bombChoice.advantage >= c.bombNetSaveThresh
    && activeEnemyMin > 5;
  if (p2PassPreferred) {
    return respond(
      { action: 'pass' },
      scored,
      '炸弹、普通接法与过牌三路比较后，当前交牌的资源代价高于暂时让权；保留控制等待更关键牌权',
      bestBomb || bestNonBomb,
    );
  }
  const canConserveOrdinaryResponse = passOk && activeEnemyMin > 5
    && !upstreamThreat && !pressureOrdinary;
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
    && !pressureOrdinary
    && !upstreamThreat
    && !best.strategy?.tags?.includes('stop_opponent_run')
    && !best.strategy?.tags?.includes('stop_single_run')
    && !best.strategy?.tags?.includes('cheap_control_take')
    && isPremiumNonBombControl(best.hand, level)) {
    const ordinaryFallback = scored.filter((play) => (
      !isBombType(play.hand)
      && !isPremiumNonBombControl(play.hand, level)
      && responseDamage(play, level) === 0
      && !ordinaryResponseTooCostly(play)
    )).sort((left, right) => (
      playResourcePower(left.hand) - playResourcePower(right.hand)
      || right.score - left.score
    ))[0];
    if (ordinaryFallback) {
      // P1 可能把A/王抬到第一名；“保留高控制”不能因此直接把整轮变成过牌。
      // 还有安全普通接法时回退该接法，避免再次暴露“所有单牌都放行”的漏洞。
      best = ordinaryFallback;
    } else {
      return respond(
        { action: 'pass' },
        scored,
        '对手尚未进入紧急残局，且没有安全普通接法；保留王或级牌控制，避免大牌打空后单吊小牌',
      );
    }
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
    && !viableOrdinaryResponse && activeEnemyMin > 2 && !pressureOrdinary) {
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
  const stopRisk = policyFeatureActive(decisionCtx, 'p0')
    ? (bestNonBomb ? candidateBeatRisk(bestNonBomb, decisionCtx) : 1)
    : 0;
  if (isBombType(best.hand)
    && !bombCreatesTwoStepFinish
    && !bombJustified
    && !shouldBomb(
      lastHand, lastSeat, hand, handCounts, seat, teams, finishOrder, c, best.strategy,
      options.deterministic, stopRisk, bombNet,
      policyThreshold(decisionCtx, 'p0StopGate', 0.8),
    )) {
    const nonBomb = scored.filter((p) => !isBombType(p.hand));
    if (nonBomb.length) {
      best = pressureOrdinary?.play || pickByDifficulty(nonBomb, c);
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
        && !pressureOrdinary
        && !best.strategy?.tags?.includes('stop_opponent_run')
        && !best.strategy?.tags?.includes('stop_single_run')
        && !best.strategy?.tags?.includes('cheap_control_take')) {
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
    && !isBombType(lastHand) && !upstreamThreat && !pressureOrdinary
    && !best.strategy?.tags?.includes('stop_opponent_run')
    && !best.strategy?.tags?.includes('stop_single_run')
    && !best.strategy?.tags?.includes('cheap_control_take')) {
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

/** 实验性锐化变体按 key 抬高门槛；默认 expert/常规路径无覆盖则返回 fallback。 */
function policyThreshold(ctx, key, fallback) {
  const overrides = ctx?.policyThresholds;
  if (overrides && typeof overrides[key] === 'number') return overrides[key];
  return fallback;
}

function candidateBeatRisk(play, ctx) {
  if (!ctx.beatModel || !play?.hand) return 0;
  if (!policyFeatureActive(ctx, 'controlV2')
    || !policyFeatureActive(ctx, 'controlRiskV2')) return legacyCandidateBeatRisk(play, ctx);
  const typeRisk = orderedTeamControlLossProbability(play, ctx, ctx.beatModel);
  // 炸弹不能和普通同型接牌等价，否则27张中盘几乎所有候选都会饱和到1；
  // 但完全忽略又会高估A、王等牌的稳定牌权。P0/P1只折算12%的资源暴露。
  const bombExposure = enemyBombExposureProbability(ctx, ctx.beatModel);
  return Math.max(0, Math.min(1,
    typeRisk + (1 - typeRisk) * bombExposure * 0.12,
  ));
}

/** 仅供 no-control-v2 对照臂复现旧的“同型∪炸弹+固定对家回手”口径。 */
function legacyCandidateBeatRisk(play, ctx) {
  const beatModel = ctx.beatModel;
  const active = new Map(beatModel.enemies.map((enemy) => [enemy.seat, enemy]));
  const downstreamSeat = (ctx.seat + 1) % 4;
  const upstreamSeat = (ctx.seat + 3) % 4;
  const probability = (seat) => {
    const enemy = active.get(seat);
    return enemy ? beatModel.seatBeat(play.hand, enemy.count, enemy.seat) : 0;
  };
  const downstreamBeat = probability(downstreamSeat);
  const upstreamBeat = probability(upstreamSeat);
  const partnerSeat = (ctx.seat + 2) % 4;
  const partnerActive = !(ctx.finishOrder || []).includes(partnerSeat)
    && (ctx.handCounts?.[partnerSeat] ?? 0) > 0;
  let partnerRetake = partnerActive ? 0.34 : 0;
  if (ctx.publicModel?.partner?.preferredLeadType === play.hand.type) partnerRetake += 0.1;
  if ((ctx.publicModel?.partner?.passesAgainstLast || 0) >= 2) partnerRetake -= 0.08;
  partnerRetake = partnerActive ? Math.max(0.12, Math.min(0.5, partnerRetake)) : 0;
  return Math.max(0, Math.min(1,
    upstreamBeat + (1 - upstreamBeat) * downstreamBeat * (1 - partnerRetake),
  ));
}

/**
 * 炸弹是敌方额外付出的强资源，不能与同型普通接牌等价计入 P0/P1。
 * 仅在实验性 P2 比较“普通接法/现在开炸”时，以 25% 权重单独折价。
 */
function candidateBombAdjustedRisk(play, ctx) {
  if (!ctx.beatModel) return 0;
  if (!policyFeatureActive(ctx, 'controlV2')
    || !policyFeatureActive(ctx, 'controlRiskV2')) return legacyCandidateBeatRisk(play, ctx);
  const typeRisk = orderedTeamControlLossProbability(play, ctx, ctx.beatModel);
  const bombExposure = enemyBombExposureProbability(ctx, ctx.beatModel);
  return Math.max(0, Math.min(1,
    typeRisk + (1 - typeRisk) * bombExposure * 0.25,
  ));
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
  if (play && isPremiumNonBombControl(play.hand, level)) loss += c.controlLossControlBoost;
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
 * P2 炸弹净收益：把炸弹、最优普通接法和过牌作为三个正式动作比较期望成本。
 * 仅在 expert 策略档 + 可接概率模型就绪时计算；整手出完由更高优先级直接处理。
 * 只作用于残局/威胁语境：自己手牌已短（炸弹用于收官）或对手逼近（炸弹用于拦截），
 * 否则中盘大牌堆的炸弹是长期保险，路线比较不可靠，不应据此覆盖既有启发式。
 */
function bombResourceOpportunityCost(play, ctx, c) {
  if (!play || !isBombType(play.hand)) return Infinity;
  if (play.strategy?.createsTwoStepFinish) return 0;
  let cost;
  if (play.hand.type === HandType.JOKER_BOMB) cost = 64;
  else if (play.hand.type === HandType.FLUSH_STRAIGHT) cost = 48;
  else cost = Math.max(18, 34 - Math.max(0, (play.hand.size || 4) - 4) * 4);

  const tags = play.strategy?.tags || [];
  // 紧急标签只表示“值得纳入比较”，不是把炸弹当成近乎免费。尤其逢人配拼炸、
  // 同时拆顺子的接法，必须把真实结构机会成本带入三路比较。
  if (play.cards.some((card) => isWild(card, ctx.level))) cost += 18;
  if (tags.includes('split_straight')) cost += 22;
  if (tags.includes('split_flush_straight')) cost += 30;
  if (tags.includes('bomb_escort')) cost *= 0.35;
  else if (tags.includes('timely_bomb')) cost *= 0.75;
  const enemyMin = ctx.publicModel?.activeEnemyMin ?? 99;
  if (enemyMin <= 3) cost *= 0.55;
  else if (enemyMin <= 5) cost *= 0.72;
  else if ((ctx.hand || []).length <= 8) cost *= 0.7;
  return Math.max(c.bombNetResource, cost);
}

function passControlOpportunityCost(ctx) {
  const model = ctx.publicModel;
  const enemyMin = model?.activeEnemyMin ?? 99;
  const finishRisk = model?.nearestEnemy?.finishRisk || 0;
  let cost = 5 + finishRisk * 22;
  if (enemyMin <= 3) cost += 28;
  else if (enemyMin <= 5) cost += 16;
  else if (enemyMin <= 8) cost += 7;
  if ((ctx.lastHand?.size || 0) >= 5) cost += 6;
  return cost;
}

function computeBombActionChoice(bombPlay, nonBombPlay, hand, level, ctx, search, c) {
  if (!c.bombNetEnabled || !policyFeatureActive(ctx, 'p2') || !ctx.beatModel) return null;
  if (!bombPlay || !isBombType(bombPlay.hand)) return null;
  if ((bombPlay.strategy?.tags || []).some((tag) => [
    'survival_preserve_control', 'preserve_strong_control',
  ].includes(tag))) return null;
  const model = ctx.publicModel;
  const threat = (model?.activeEnemyMin ?? 99) <= 6
    || (model?.nearestEnemy?.finishRisk || 0) >= 0.6;
  if (hand.length > 14 && !threat) return null;
  const remainBomb = removeCards(hand, bombPlay.cards);
  if (!remainBomb.length) return null;
  // rankPlays 已为入围候选算过相同单位的路线成本；P2 直接复用，避免在
  // 每个接牌回合重复展开两次三手搜索。过牌不消耗实体牌，用快速下界即可。
  const routeCostFor = (play, remain) => Number.isFinite(play?.lookAhead?.cost)
    ? play.lookAhead.cost
    : routeCostOf(remain, level, ctx, search, c);
  const passEstimate = fastTrickEstimate(hand, level, search);
  const passCost = passEstimate.tricks * 18 + passEstimate.loose * 2.5
    + passControlOpportunityCost(ctx);
  const controlScale = policyThreshold(ctx, 'p2ControlScale', 1);
  const expectedPlayCost = (play, remain, resourceCost = 0) => {
    const routeCost = routeCostFor(play, remain);
    const response = evaluatePublicResponseTree(play, ctx, ctx.beatModel, {
      ownRemaining: remain.length,
      includePartnerHandoff: policyFeatureActive(ctx, 'p3'),
    });
    if (!response) return routeCost + resourceCost;
    const weights = responsePlacementWeights(ctx, c, level, remain.length);
    // 同一套团队名次权重同时约束普通接法和炸弹。旧 P2 把炸弹视为必然站住，
    // 会漏掉被更大炸弹反压的代价；v2 显式计入该公开概率，并把逼出敌炸作为
    // 很小的补偿，而不是把“对手可能有炸”当成确定事件。
    return routeCost + resourceCost
      + response.enemyControl * weights.enemyControlLoss * controlScale
      - response.selfControl * weights.selfControl * 0.28 * controlScale
      - response.partnerControl * weights.partnerControl * 0.2 * controlScale
      - response.enemyBomb * weights.enemyBombBurn;
  };
  let ordinaryCost = Infinity;
  if (nonBombPlay) {
    const remainOrd = removeCards(hand, nonBombPlay.cards);
    if (remainOrd.length) {
      ordinaryCost = expectedPlayCost(nonBombPlay, remainOrd);
    }
  }
  const bombCost = expectedPlayCost(
    bombPlay,
    remainBomb,
    bombResourceOpportunityCost(bombPlay, ctx, c),
  );
  const choices = [
    { action: 'bomb', cost: bombCost },
    { action: 'pass', cost: passCost },
  ];
  if (Number.isFinite(ordinaryCost)) choices.push({ action: 'ordinary', cost: ordinaryCost });
  choices.sort((left, right) => left.cost - right.cost);
  const best = choices[0];
  const runnerUp = choices[1] || best;
  return {
    action: best.action,
    advantage: Math.max(0, runnerUp.cost - best.cost),
    bombNet: Math.min(passCost, ordinaryCost) - bombCost,
    costs: { bomb: bombCost, ordinary: ordinaryCost, pass: passCost },
  };
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

function leadControlExposureFactor(hand, level) {
  if (!hand || isBombType(hand)) return 0;
  if (isPremiumNonBombControl(hand, level)) return 1;
  if (![HandType.SINGLE, HandType.PAIR, HandType.TRIPLE].includes(hand.type)) return 0;
  if (hand.power >= 14) return 0.45;
  if (hand.power >= 12) return 0.2;
  return 0;
}

function responseDamage(play, level) {
  return strategicResponseDamage(play, level);
}

function hardResponseDamage(play, level) {
  const tags = play.strategy?.tags || [];
  let damage = Number(tags.includes('split_bomb')) * RESPONSE_DAMAGE_WEIGHT.split_bomb
    + Number(tags.includes('split_flush_straight'))
      * RESPONSE_DAMAGE_WEIGHT.split_flush_straight
    + Number(tags.includes('split_straight')) * RESPONSE_DAMAGE_WEIGHT.split_straight;
  if (!isBombType(play.hand) && play.cards.some((card) => isWild(card, level))) damage += 450;
  if (!isBombType(play.hand)) {
    damage += play.cards.filter((card) => isJoker(card)).length * 160;
  }
  return damage;
}

/**
 * 连续走单压力已经成立时，不再让“结构分低于阈值就过牌”的硬门覆盖防守。
 * 候选仍严格遵循：独立单张优先，其次结构损失更小的拆牌，并使用最小充分点数；
 * 拆炸弹/拆同花顺的候选不会获得 stop_single_run 标签，因而不会被这里强选。
 */
function selectSingleRunBlock(scored, level) {
  return scored
    .filter((play) => play.hand?.type === HandType.SINGLE
      && !isBombType(play.hand)
      && play.strategy?.tags?.includes('stop_single_run'))
    .sort((a, b) => (
      responseDamage(a, level) - responseDamage(b, level)
      || a.hand.power - b.hand.power
      || b.score - a.score
    ))[0] || null;
}

/** 共享策略核心已确认无结构代价后，仍按损伤与最小充分点数稳定选牌。 */
function selectTaggedSafeControl(scored, tag, level) {
  return scored
    .filter((play) => !isBombType(play.hand)
      && play.strategy?.tags?.includes(tag))
    .sort((a, b) => (
      responseDamage(a, level) - responseDamage(b, level)
      || a.hand.power - b.hand.power
      || b.score - a.score
    ))[0] || null;
}

/**
 * P3 搭档协同 2.0：只有公开模型显示下家很可能接走对家的牌，并且一张
 * 不拆结构、不动逢人配/王的普通牌能显著降低该概率时才抬牌。它替代
 * “下家一短就机械压队友”的旧规则，不推断任何暗牌。
 */
function selectPartnerProtection(scored, ctx, level) {
  if (!ctx.beatModel || !ctx.lastHand || isBombType(ctx.lastHand)) return null;
  const candidates = scored
    .filter((play) => !isBombType(play.hand)
      && responseDamage(play, level) === 0
      && !ordinaryResponseTooCostly(play)
      && !isPremiumNonBombControl(play.hand, level)
      && !play.cards.some((card) => isWild(card, level) || isJoker(card)))
    .map((play) => ({
      play,
      signal: publicPartnerProtectionValue(play, ctx, ctx.beatModel),
    }))
    .filter((item) => item.signal?.eligible)
    .sort((left, right) => (
      right.signal.reduction - left.signal.reduction
      || left.play.hand.power - right.play.hand.power
      || right.play.score - left.play.score
    ));
  if (!candidates.length) return null;
  const selected = candidates[0].play;
  selected.partnerProtection = candidates[0].signal;
  selected.riskReductionPercent = Math.round(candidates[0].signal.reduction * 100);
  return selected;
}

function hasUrgentStrategy(play) {
  const tags = play.strategy?.tags || [];
  return !!play.strategy?.createsTwoStepFinish
    || tags.some((tag) => [
      'stop_single_run', 'stop_opponent_run', 'bomb_escort', 'timely_bomb',
      'cheap_control_take', 'partner_cover', 'double_up_block', 'avoid_double_down',
      'urgent_ordinary_block',
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
function rankedSafetyScore(play, mode, ctx, level) {
  if (mode !== 'beat' || enemyWithin(ctx, 4)
    || isBombType(play.hand) || hasUrgentStrategy(play)) return play.score;
  const hardDamage = hardResponseDamage(play, level);
  const softDamage = Math.max(0, responseDamage(play, level) - hardDamage);
  // 使用单一标量键，避免“同型按结构、跨型按总分”形成非传递比较器。
  // 这里只做温和安全校正；主要结构代价仍来自统一策略核心，避免重复重罚。
  return play.score - hardDamage * 0.25 - Math.min(24, softDamage * 0.1);
}

function compareRankedPlays(a, b, mode, ctx, level) {
  const scoreDifference = rankedSafetyScore(b, mode, ctx, level)
    - rankedSafetyScore(a, mode, ctx, level);
  if (scoreDifference) return scoreDifference;
  // 后续键对所有牌型一视同仁，形成稳定的全序；旧实现只在同牌型时比较
  // 点数/损伤，可能出现 A~B、B~C 但 A<C 的非传递等价关系。
  const damageDifference = responseDamage(a, level) - responseDamage(b, level);
  if (damageDifference) return damageDifference;
  const resourceDifference = playResourcePower(a.hand) - playResourcePower(b.hand);
  if (resourceDifference) return resourceDifference;
  if (a.cards.length !== b.cards.length) return b.cards.length - a.cards.length;
  const typeDifference = String(a.hand.type).localeCompare(String(b.hand.type));
  if (typeDifference) return typeDifference;
  const powerDifference = (Number(a.hand.power) || 0) - (Number(b.hand.power) || 0);
  if (powerDifference) return powerDifference;
  return cardsKey(a.cards).localeCompare(cardsKey(b.cards));
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
  stopRisk = 0, bombNet = null, p0StopGate = 0.8,
) {
  if (strategy?.tags?.includes('bomb_escort')) return true;
  // P0 记牌器：对手剩 5-6 张且本次领出高控牌/大组合（其推进难被普通接法低成本
  // 阻止）时，若连最优普通接法都大概率被压回、无法夺回牌权，则开炸及时拦截，
  // 优先于保留强控制。
  if (stopRisk >= p0StopGate
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
    const chance = 0.3 + c.aggressiveness * 0.5 + (stopRisk >= p0StopGate ? 0.35 : 0);
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
    const opponentModel = c.difficulty === 'master'
      ? opponentPlayAdjustment(ctx.opponentModel, ctx, { ...play, action: 'play' })
      : null;
    return {
      ...play,
      score: score + (opponentModel?.score || 0),
      opponentModel,
    };
  }).sort((a, b) => compareRankedPlays(a, b, mode, ctx, level));

  if (c.lookAhead && scored.length > 1) {
    applyLookAhead(scored, hand, level, search, c, ctx, mode);
    // 未展开候选只承担小幅不确定性折价。过去把所有已搜索项硬排在未搜索项
    // 之前，会让一个前瞻后已经明显变差的候选仍压住统一评分更高的安全路线。
    const fallbackPenalty = c.difficulty === 'master' ? 6 : 4;
    for (const play of scored) {
      if (!play.lookAhead) play.score -= fallbackPenalty;
    }
    scored.sort((a, b) => compareRankedPlays(a, b, mode, ctx, level));
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
    : sharedStructureDamage ? 0.45 : 1;
  score -= splitPenalty(hand, play.cards, level, search, beforeStructure)
    * 15 * c.structureWeight * splitWeight;
  score -= play.cards.filter((card) => isWild(card, level)).length * c.wildPenalty;
  score += structureBonus(removeCards(hand, play.cards), level, search) * c.structureWeight;

  if (hand.length <= 10) score += play.cards.length * 5;

  if (['hard', 'master'].includes(c.difficulty)
    && !isBombType(h) && play.cards.length >= 3 && h.power <= 9) {
    score += 12;
  }

  // P0 记牌器只衡量“高控制牌打空”的代价。低牌本来就用于试探和清理，
  // 若仅因容易被接就扣分，会反向鼓励先打大牌、最后单吊小牌。
  if (policyFeatureActive(ctx, 'p0') && remain > 0 && !isBombType(h)) {
    const risk = candidateBeatRisk(play, ctx);
    const exposure = leadControlExposureFactor(h, level);
    if (exposure > 0 && risk >= policyThreshold(ctx, 'p0LeadGate', 0.8)) {
      score -= risk * c.controlLeadRiskPenalty * exposure
        * policyThreshold(ctx, 'p0LeadScale', 1);
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
    : conditionalSingleBlock ? 0.12 : sharedStructureDamage ? 0.4 : 1;
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

function responsePlacementWeights(ctx, c, level, ownRemaining) {
  const seat = ctx.seat;
  const partnerSeat = (seat + 2) % 4;
  const partnerFinished = (ctx.finishOrder || []).includes(partnerSeat);
  const partnerCount = partnerFinished ? 0 : (ctx.handCounts?.[partnerSeat] ?? 99);
  const headSeat = ctx.finishOrder?.[0];
  const ownTeam = ctx.teams?.[seat];
  const headIsPartner = headSeat != null && ctx.teams?.[headSeat] === ownTeam;
  const headIsEnemy = headSeat != null && ctx.teams?.[headSeat] !== ownTeam;
  let selfControl = ownRemaining <= 2 ? 34
    : ownRemaining <= 5 ? 25
      : ownRemaining <= 8 ? 17 : 10;
  let partnerControl = partnerFinished ? 4
    : partnerCount <= 2 ? 31
      : partnerCount <= 5 ? 23
        : partnerCount <= 8 ? 15 : 8;
  let enemyControlLoss = controlLossPenalty(null, ctx, c, level);
  if (headIsPartner) {
    // 对家已经头游：自己的牌权直接决定双上/头三，团队升级价值提高。
    selfControl += 16;
    enemyControlLoss += 10;
  } else if (headIsEnemy) {
    // 对手已经头游：当前目标转为阻止双下并争取三游。
    selfControl += 8;
    partnerControl += 6;
    enemyControlLoss += 14;
  }
  return {
    selfControl,
    partnerControl,
    enemyControlLoss,
    enemyBombBurn: (ctx.publicModel?.activeEnemyMin ?? 99) <= 6 ? 4 : 7,
  };
}

function applyPublicResponseSearch(projections, hand, level, search, c, ctx, mode) {
  if (!policyFeatureActive(ctx, 'p1')
    || !policyFeatureActive(ctx, 'p1ResponseSearch')
    || !ctx.beatModel
    || c.responseSearchRootLimit <= 0) return false;
  // 只在同一“安全普通接法”层内比较控权。若把王、逢人配、拆炸候选也放进
  // 同一均值，它们的高控权会给所有正常小牌附加负税，最终反而诱发整轮过牌。
  const candidates = projections
    .filter(({ play }) => !isBombType(play.hand)
      && responseDamage(play, level) === 0
      && !ordinaryResponseTooCostly(play))
    .slice(0, c.responseSearchRootLimit);
  if (candidates.length < 2) return false;

  const evaluations = [];
  for (const item of candidates) {
    if (ctx.searchDeadlineMs != null && monotonicNow() >= ctx.searchDeadlineMs) {
      search.responseSearch = { evaluated: 0, timedOut: true };
      return false;
    }
    const ownRemaining = hand.length - item.play.cards.length;
    const response = evaluatePublicResponseTree(item.play, ctx, ctx.beatModel, {
      ownRemaining,
    });
    if (!response) continue;
    const weights = responsePlacementWeights(ctx, c, level, ownRemaining);
    const expectedUtility = response.selfControl * weights.selfControl
      + response.partnerControl * weights.partnerControl
      - response.enemyControl * weights.enemyControlLoss
      + response.enemyBomb * weights.enemyBombBurn;
    evaluations.push({ ...item, response, weights, expectedUtility });
  }
  if (evaluations.length < 2) return false;
  const values = evaluations.map((item) => item.expectedUtility);
  const averageUtility = values.reduce((sum, value) => sum + value, 0) / values.length;
  const spread = Math.max(...values) - Math.min(...values);
  const lossScale = Math.max(1, controlLossPenalty(null, ctx, c, level));
  const normalizedSpread = spread / lossScale;
  if (normalizedSpread < policyThreshold(ctx, 'p1SpreadFloor', 0.04)) return false;

  const activeEnemyMin = ctx.publicModel?.activeEnemyMin ?? 99;
  const partnerSeat = (ctx.seat + 2) % 4;
  const partnerCount = (ctx.finishOrder || []).includes(partnerSeat)
    ? 0 : (ctx.handCounts?.[partnerSeat] ?? 99);
  const ownBestRemaining = Math.min(...evaluations.map((item) => (
    hand.length - item.play.cards.length
  )));
  // 领出时降低控权项幅度，防止重新退化成“先打A/王”；残局、送对家和接牌
  // 才放大应手树。基础结构分与 P0 惜大牌仍然完整保留。
  const urgentControl = activeEnemyMin <= 6 || partnerCount <= 3
    || ownBestRemaining <= 6 || (ctx.finishOrder || []).length > 0;
  const modeScale = mode === 'beat'
    ? (urgentControl ? 1 : 0.12)
    : (urgentControl ? 0.62 : 0.28);
  const featureScale = policyThreshold(ctx, 'p1LossScale', 1);
  const maxAdjustment = c.responseSearchMaxAdjustment * modeScale * featureScale;
  for (const item of evaluations) {
    const relative = Math.max(-maxAdjustment, Math.min(
      maxAdjustment,
      (item.expectedUtility - averageUtility) * modeScale * featureScale,
    ));
    item.play.lookAhead.responseSearch = {
      ...item.response,
      expectedUtility: item.expectedUtility,
      relativeAdjustment: relative,
      depth: 1,
    };
    item.play.lookAhead.adjustment += relative;
    item.play.score += relative;
  }
  search.responseSearch = {
    evaluated: evaluations.length,
    timedOut: false,
    spread,
  };
  return true;
}

function applyPartnerCoordinationSearch(projections, hand, level, c, ctx, mode) {
  if (!policyFeatureActive(ctx, 'p3') || mode !== 'lead' || !ctx.beatModel
    || c.partnerSearchRootLimit <= 0) return false;
  const partnerSeat = (ctx.seat + 2) % 4;
  if ((ctx.finishOrder || []).includes(partnerSeat)) return false;
  const partnerCount = ctx.handCounts?.[partnerSeat] ?? 99;
  if (partnerCount <= 0 || partnerCount > 8) return false;
  const candidates = projections
    .filter(({ play }) => !isBombType(play.hand)
      && play.cards.length <= partnerCount
      && responseDamage(play, level) === 0
      && !ordinaryResponseTooCostly(play))
    .slice(0, c.partnerSearchRootLimit);
  if (candidates.length < 2) return false;

  const evaluated = [];
  for (const item of candidates) {
    if (ctx.searchDeadlineMs != null && monotonicNow() >= ctx.searchDeadlineMs) return false;
    const response = evaluatePublicResponseTree(item.play, ctx, ctx.beatModel, {
      ownRemaining: hand.length - item.play.cards.length,
      includePartnerHandoff: true,
    });
    if (!response) continue;
    // 只计团队交接的增量，不再重复 P1 已经计过的敌方失权与本家控权。
    const sizeFit = Math.max(0, 1 - Math.abs(partnerCount - item.play.cards.length) / 8);
    const utility = response.partnerControl
      * (partnerCount <= 3 ? 58 : partnerCount <= 5 ? 44 : 28)
      * (0.72 + sizeFit * 0.28);
    evaluated.push({ ...item, response, utility });
  }
  if (evaluated.length < 2) return false;
  const average = evaluated.reduce((sum, item) => sum + item.utility, 0) / evaluated.length;
  const scale = policyThreshold(ctx, 'p3Scale', 1);
  const cap = c.partnerSearchMaxAdjustment * scale;
  for (const item of evaluated) {
    const relative = Math.max(-cap, Math.min(cap, (item.utility - average) * scale));
    item.play.lookAhead.partnerSearch = {
      partnerControl: item.response.partnerControl,
      directHandoff: item.response.branches?.partnerDirect || 0,
      expectedUtility: item.utility,
      relativeAdjustment: relative,
    };
    item.play.lookAhead.adjustment += relative;
    item.play.score += relative;
  }
  return true;
}

function applyEndgameRolloutSearch(projections, hand, level, search, c, ctx) {
  if (!policyFeatureActive(ctx, 'p4') || !ctx.beatModel
    || c.rolloutRootLimit <= 0 || hand.length > 14) return false;
  const partnerSeat = (ctx.seat + 2) % 4;
  const partnerCount = (ctx.finishOrder || []).includes(partnerSeat)
    ? 0 : (ctx.handCounts?.[partnerSeat] ?? 99);
  const activeEnemyMin = ctx.publicModel?.activeEnemyMin ?? 99;
  const urgent = hand.length <= c.rolloutEndgameHand
    || (hand.length <= 10 && (
      activeEnemyMin <= 4
      || partnerCount <= 3
      || (ctx.finishOrder || []).length > 0
    ));
  if (!urgent) return false;

  const candidates = projections
    .filter(({ play }) => responseDamage(play, level) < RESPONSE_DAMAGE_WEIGHT.split_bomb)
    .slice(0, c.rolloutRootLimit);
  if (candidates.length < 2) return false;
  const evaluated = [];
  for (const item of candidates) {
    if (ctx.searchDeadlineMs != null && monotonicNow() >= ctx.searchDeadlineMs) return false;
    const remain = removeCards(hand, item.play.cards);
    const rollout = evaluatePublicEndgameRollout(
      item.play,
      remain,
      ctx,
      ctx.beatModel,
      {
        branchLimit: c.rolloutBranchLimit,
        nodeBudget: c.rolloutBranchLimit + 3,
        deadlineMs: ctx.searchDeadlineMs,
        cache: search.route,
        baseRoute: {
          estimatedTricks: item.play.lookAhead.projectedTricks,
          loose: item.play.lookAhead.looseCards,
          controlsSpent: item.play.lookAhead.controlsSpent,
          bombsSpent: item.play.lookAhead.bombsSpent,
          adjustment: 0,
        },
        includePartnerHandoff: policyFeatureActive(ctx, 'p3'),
      },
    );
    // 任何根候选超时都丢弃整批 P4，不把半批结果写回排名。
    if (rollout?.timedOut) {
      search.endgameRollout = { evaluated: 0, timedOut: true };
      return false;
    }
    if (rollout && Number.isFinite(rollout.expectedUtility)) {
      evaluated.push({ ...item, rollout });
    }
  }
  if (evaluated.length < 2) return false;
  const average = evaluated.reduce(
    (sum, item) => sum + item.rollout.expectedUtility,
    0,
  ) / evaluated.length;
  const scale = policyThreshold(ctx, 'p4Scale', 0.82);
  const cap = c.rolloutMaxAdjustment * scale;
  for (const item of evaluated) {
    const relative = Math.max(-cap, Math.min(
      cap,
      (item.rollout.expectedUtility - average) * 0.55 * scale,
    ));
    item.play.lookAhead.endgameRollout = {
      expectedUtility: item.rollout.expectedUtility,
      selfContinuation: item.rollout.selfContinuation,
      teamControl: item.rollout.first?.teamControl ?? null,
      bestNext: item.rollout.bestNext,
      nodes: item.rollout.nodes,
      depth: item.rollout.depth,
      relativeAdjustment: relative,
    };
    item.play.lookAhead.adjustment += relative;
    item.play.score += relative;
  }
  search.endgameRollout = { evaluated: evaluated.length, timedOut: false };
  return true;
}

export function calibratePolicyFusionValues(components, cap) {
  if (!Array.isArray(components) || !components.length) return [];
  const safeCap = Math.max(1, Number(cap) || 1);
  const values = components.map((item) => safeCap * Math.tanh((
    (Number(item?.p1) || 0)
    + (Number(item?.p3) || 0) * 0.86
    + (Number(item?.p4) || 0) * 0.9
  ) / safeCap));
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.map((value) => value - mean);
}

/**
 * P5 置信融合：P1/P3/P4 都描述牌权，直接相加会重复计分。先保留各模块
 * 独立输出，再用有界函数合并并重新中心化；no-p5 可恢复原始相加做消融。
 */
function applyPolicyFusionCalibration(projections, c, ctx) {
  if (!policyFeatureActive(ctx, 'p5') || c.policyFusionCap <= 0) return false;
  const rows = projections.map(({ play }) => {
    const p1 = play.lookAhead?.responseSearch?.relativeAdjustment || 0;
    const p3 = play.lookAhead?.partnerSearch?.relativeAdjustment || 0;
    const p4 = play.lookAhead?.endgameRollout?.relativeAdjustment || 0;
    return { play, raw: p1 + p3 + p4, p1, p3, p4 };
  }).filter((item) => Math.abs(item.raw) > 1e-9);
  if (rows.length < 2) return false;
  const activeEnemyMin = ctx.publicModel?.activeEnemyMin ?? 99;
  const urgencyScale = activeEnemyMin <= 5 || (ctx.finishOrder || []).length > 0 ? 1 : 0.78;
  const cap = Math.max(8, policyThreshold(ctx, 'p5FusionCap', c.policyFusionCap))
    * urgencyScale;
  const calibratedValues = calibratePolicyFusionValues(rows, cap);
  for (const [index, item] of rows.entries()) {
    const calibrated = calibratedValues[index];
    const delta = calibrated - item.raw;
    item.play.score += delta;
    item.play.lookAhead.adjustment += delta;
    item.play.lookAhead.policyFusion = {
      rawAdjustment: item.raw,
      calibratedAdjustment: calibrated,
      cap,
      components: { p1: item.p1, p3: item.p3, p4: item.p4 },
    };
  }
  return true;
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
  for (const { play, cost } of projections) {
    // 以候选均值为中心，既奖励更短的收尾路线，也惩罚明显拖长手数的路线。
    const routeAdjustment = (averageCost - cost) * 1.35;
    play.lookAhead.adjustment = routeAdjustment;
    play.score += routeAdjustment;
  }

  // P1-P4 都先保留独立分量，再由 P5 对相关的牌权分做有界融合。任一超时
  // 模块只回退自己，已经完成的更浅层结果仍然有效。
  const p1Applied = applyPublicResponseSearch(projections, hand, level, search, c, ctx, mode);
  applyPartnerCoordinationSearch(projections, hand, level, c, ctx, mode);
  applyEndgameRolloutSearch(projections, hand, level, search, c, ctx);
  applyPolicyFusionCalibration(projections, c, ctx);
  if (p1Applied || policyFeatureActive(ctx, 'p1ResponseSearch')) return;

  // P1 控权期望：只在 expert（A/B 对照组 baseline 关闭）与已建可接模型时启用。
  // 仅作用于接牌模式：领出时"难被接"的强牌更该保留（惜大打小），
  // 用 p 奖励强领会与既有领出策略冲突。
  const controlCandidates = projections.filter(({ play }) => !isBombType(play.hand));
  const controlRisks = new Map(controlCandidates.map(({ play }) => [
    play,
    candidateBeatRisk(play, ctx),
  ]));
  const averageRisk = controlRisks.size
    ? [...controlRisks.values()].reduce((sum, value) => sum + value, 0) / controlRisks.size
    : 0;
  const maximumRisk = controlRisks.size ? Math.max(...controlRisks.values()) : 0;
  const minimumRisk = controlRisks.size ? Math.min(...controlRisks.values()) : 0;
  const riskSpread = maximumRisk - minimumRisk;
  const minimumProjectedTricks = controlCandidates.length
    ? Math.min(...controlCandidates.map(({ play }) => play.lookAhead?.projectedTricks ?? 99))
    : 99;
  const activeEnemyMin = ctx.publicModel?.activeEnemyMin ?? 99;
  const controlContext = activeEnemyMin <= 8 || minimumProjectedTricks <= 2;
  const spreadFloor = policyThreshold(ctx, 'p1SpreadFloor', 0.04);
  const controlSignal = Math.max(0, Math.min(1,
    (riskSpread - spreadFloor) / Math.max(0.1, 0.4 - spreadFloor),
  ));
  const enemyUrgency = Math.max(0, Math.min(1, (10 - activeEnemyMin) / 6));
  const routeUrgency = minimumProjectedTricks <= 2 ? 0.5 : 0;
  const controlUrgency = Math.max(enemyUrgency, routeUrgency);
  const controlEnabled = policyFeatureActive(ctx, 'p1') && !!ctx.beatModel
    && c.controlLossBase > 0 && mode === 'beat' && controlContext
    && controlSignal > 0;
  // 所有候选使用同一个损失尺度，确保 sum(avgRisk - pLose) 严格为0；
  // 旧实现按候选是否为高控制牌改变尺度，会重新给整组候选附加净奖惩。
  const commonControlScale = Math.min(32,
    controlLossPenalty(null, ctx, c, level) * 0.75
      * policyThreshold(ctx, 'p1LossScale', 1));
  for (const { play, cost } of projections) {
    if (controlEnabled && !isBombType(play.hand)) {
      // P1 只比较同一候选集里的相对控权能力：风险高于均值的牌受罚，低于
      // 均值的牌获奖，整体保持中心化，不再给整组候选附加“复杂度税”。
      const pLose = controlRisks.get(play) ?? candidateBeatRisk(play, ctx);
      const lossPenalty = commonControlScale;
      const relativeControl = (averageRisk - pLose)
        * commonControlScale * controlSignal * controlUrgency;
      play.lookAhead.adjustment += relativeControl;
      play.lookAhead.pLose = pLose;
      play.lookAhead.lossPenalty = lossPenalty;
      play.lookAhead.controlRelative = relativeControl;
      play.score += relativeControl;
    }
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
    if (candidate.lookAhead.responseSearch) {
      const teamControl = Math.round(candidate.lookAhead.responseSearch.teamControl * 100);
      return `公开应手搜索估计我方可保有牌权约 ${teamControl}%，前瞻后还需约 ${candidate.lookAhead.projectedTricks} 手`;
    }
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
  // 云端只需要少量多样候选；本地混合引擎则在专家已经完成打分的全部
  // “规则生成候选”上先做安全筛选，不能沿用云端的三选一窄瓶颈。
  const consultationPlays = ['hybrid', 'ismcts'].includes(ctx.decisionEngine)
    ? ranked
    : selectDiverseCandidates(ranked, ctx.hand.length, 24, 10);
  result.candidates = consultationPlays.map((play, index) => ({
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
    responseSearch: play.lookAhead?.responseSearch ? {
      teamControl: play.lookAhead.responseSearch.teamControl,
      selfControl: play.lookAhead.responseSearch.selfControl,
      partnerControl: play.lookAhead.responseSearch.partnerControl,
      enemyControl: play.lookAhead.responseSearch.enemyControl,
      enemyBomb: play.lookAhead.responseSearch.enemyBomb,
      expectedUtility: play.lookAhead.responseSearch.expectedUtility,
      relativeAdjustment: play.lookAhead.responseSearch.relativeAdjustment,
    } : null,
    partnerSearch: play.lookAhead?.partnerSearch ? {
      partnerControl: play.lookAhead.partnerSearch.partnerControl,
      directHandoff: play.lookAhead.partnerSearch.directHandoff,
      expectedUtility: play.lookAhead.partnerSearch.expectedUtility,
      relativeAdjustment: play.lookAhead.partnerSearch.relativeAdjustment,
    } : null,
    endgameRollout: play.lookAhead?.endgameRollout ? {
      expectedUtility: play.lookAhead.endgameRollout.expectedUtility,
      teamControl: play.lookAhead.endgameRollout.teamControl,
      bestNext: play.lookAhead.endgameRollout.bestNext,
      nodes: play.lookAhead.endgameRollout.nodes,
      relativeAdjustment: play.lookAhead.endgameRollout.relativeAdjustment,
    } : null,
    policyFusion: play.lookAhead?.policyFusion ? {
      rawAdjustment: play.lookAhead.policyFusion.rawAdjustment,
      calibratedAdjustment: play.lookAhead.policyFusion.calibratedAdjustment,
      cap: play.lookAhead.policyFusion.cap,
    } : null,
    opponentModel: play.opponentModel?.applied ? {
      adjustment: Math.round(play.opponentModel.score * 10) / 10,
      reason: play.opponentModel.reason,
      samples: play.opponentModel.samples,
      type: play.opponentModel.type,
      pressure: play.opponentModel.pressure,
      relativePosition: play.opponentModel.relativePosition || null,
      leadPreference: Number.isFinite(play.opponentModel.leadPreference)
        ? Math.round(play.opponentModel.leadPreference * 1000) / 1000 : null,
      bombUseRate: Number.isFinite(play.opponentModel.bombUseRate)
        ? Math.round(play.opponentModel.bombUseRate * 1000) / 1000 : null,
      components: play.opponentModel.components ? Object.fromEntries(
        Object.entries(play.opponentModel.components).map(([key, value]) => [
          key, Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0,
        ]),
      ) : null,
    } : null,
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
export function getAIConsultation(ctx, options = {}) {
  const startedAt = monotonicNow();
  const deterministic = options.deterministic !== false;
  const timeBudgetMs = Math.max(0, Number(options.timeBudgetMs ?? ctx?.timeBudgetMs) || 0);
  const consultation = chooseAIPlayInternal({
    ...ctx,
    policyProfile: ctx.policyProfile === 'baseline' ? 'baseline' : 'expert',
  }, {
    explain: true,
    deterministic,
    difficulty: AI_DIFFICULTY[ctx?.difficulty] || _difficulty,
    timeBudgetMs,
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
    'bomb_escort', 'timely_bomb', 'cheap_control_take', 'partner_cover',
    'double_up_block', 'avoid_double_down', 'urgent_ordinary_block',
  ]);
  const localHasHardTag = (localCandidate.tags || []).some((tag) => hardTags.has(tag));

  if (consultation.tacticalConstraint === 'team_finish_delay') {
    cloudConstraint = 'team_finish_delay';
  } else if (finishesNow) cloudConstraint = 'finish_now';
  else if (teammateLead && !emergencyPartnerBlock && consultation.action === 'pass') {
    cloudConstraint = 'yield_to_partner';
  } else if (emergencyPartnerBlock || localHasHardTag) {
    cloudConstraint = 'mandatory_block';
  }

  const applyHybrid = (result) => {
    if (!['hybrid', 'ismcts'].includes(ctx?.decisionEngine)
      || options.applyHybrid === false) return result;
    try {
      const deterministicSearch = deterministic || timeBudgetMs <= 0;
      const deadlineMs = deterministicSearch
        ? null
        : startedAt + clampHybridBudget(timeBudgetMs);
      const hybridInput = result.cloudConstraint === 'soft_rerank'
        ? { ...result, candidates: consultation.candidates }
        : result;
      const hybrid = chooseHybridFromConsultation(ctx, hybridInput, {
        candidateLimit: 6,
        sampleCount: deterministicSearch ? 6 : timeBudgetMs >= 500 ? 8 : 4,
        behaviorAttempts: 2,
        maxPlies: timeBudgetMs >= 500 ? 120 : 88,
        nodeBudget: deterministicSearch ? 3600 : timeBudgetMs >= 500 ? 5200 : 2400,
        iterationBudget: deterministicSearch ? 72 : timeBudgetMs >= 500 ? 96 : 48,
        searchMode: ctx?.decisionEngine === 'ismcts' ? 'paired-root-pimc-v1' : 'pimc-v1',
        deadlineMs,
      });
      const decision = hybrid?.decision;
      if (!decision?.action) return result;
      const finalCandidateId = decision.hybrid?.finalCandidateId || result.localCandidateId;
      let returnedCandidates = result.candidates || [];
      if (finalCandidateId && !returnedCandidates.some((candidate) => candidate.id === finalCandidateId)) {
        const selected = consultation.candidates.find((candidate) => candidate.id === finalCandidateId);
        if (selected) returnedCandidates = [selected, ...returnedCandidates].slice(0, 3);
      }
      return {
        ...result,
        ...decision,
        candidates: returnedCandidates,
        localCandidateId: finalCandidateId,
        hybrid: decision.hybrid || null,
      };
    } catch (error) {
      return {
        ...result,
        hybrid: {
          version: 1,
          applied: false,
          reason: 'hybrid_exception',
          error: String(error?.message || error).slice(0, 120),
        },
      };
    }
  };

  if (cloudConstraint !== 'soft_rerank') {
    return applyHybrid({
      ...consultation,
      candidates: [localCandidate],
      cloudConstraint,
    });
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
  return applyHybrid({ ...consultation, candidates: cloudCandidates, cloudConstraint });
}

function clampHybridBudget(timeBudgetMs) {
  const budget = Number(timeBudgetMs) || 250;
  return Math.max(400, Math.min(1200, budget * 2));
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
