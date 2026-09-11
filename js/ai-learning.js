/**
 * 离线学习候选层。它不加载文件、不接触产品设置；调用者必须在本进程中
 * 显式配置模型，且所有输入先经过公共观察白名单。
 */
import { generateLegalPlays, handSignature, HandType } from './rules.js';
import { filterEligibleStrategyActions, strategicCandidateScore, createStrategicMemo } from './strategy-core.js';
import { removeCards, isWild, isJoker } from './cards.js';
import { inferPublicThreats, createBeatModel, evaluatePublicResponseTree,
  estimateThreeStepRoute, publicCoordinationScore } from './ai-route.js';
import {
  evaluateHybridValueModel,
  extractHybridValueFeatures,
  validateHybridValueModel,
} from './ai-hybrid.js';

export const LEARNING_DECISION_ENGINE = 'learned-value-v1';
export const LEARNING_CONTEXT_ENGINE = 'learned-context-v1';
export const LEARNING_CONTEXT_V2_ENGINE = 'learned-context-v2';
export const isLearningDecisionEngine = engine => [
  LEARNING_DECISION_ENGINE,
  LEARNING_CONTEXT_ENGINE,
  LEARNING_CONTEXT_V2_ENGINE,
].includes(engine);
export const LEARNING_CANDIDATE_LIMIT = 8;

let offlineModel = null;
let offlineFeatureEngine = LEARNING_DECISION_ENGINE;

function playKey(play) {
  if (!play || play.action === 'pass') return 'pass';
  return `${(play.cards || []).map((card) => String(card.id)).sort().join(',')}|${play.signature || handSignature(play.hand)}`;
}

function stableCandidateOrder(left, right) {
  const leftFinishes = left.cards.length === left.fullHandSize;
  const rightFinishes = right.cards.length === right.fullHandSize;
  return Number(rightFinishes) - Number(leftFinishes)
    || right.cards.length - left.cards.length
    || Number(left.hand?.power || 0) - Number(right.hand?.power || 0)
    || playKey(left).localeCompare(playKey(right));
}

/** Build the shared, capped legal action set for training labels and inference. */
export function buildLearningCandidates(context = {}, expertDecision = null) {
  const hand = Array.isArray(context.hand) ? context.hand : [];
  if (!hand.length) return [];
  const legal = generateLegalPlays(hand, context.level, context.lastHand)
    .map((play) => ({ ...play, action: 'play', fullHandSize: hand.length }));
  if (context.lastHand) legal.push({
    action: 'pass', cards: [], hand: null, signature: null, fullHandSize: hand.length,
  });
  const eligible = filterEligibleStrategyActions(legal, context, {
    allowPlacementExceptions: true,
  }).entries || [];
  const expertKey = playKey(expertDecision);
  const required = new Map();
  for (const candidate of eligible) {
    const key = playKey(candidate);
    if (key === expertKey || candidate.action === 'pass'
      || candidate.cards.length === hand.length) required.set(key, candidate);
  }
  const ordered = eligible.slice().sort(stableCandidateOrder);
  const selected = [...required.values()];
  for (const candidate of ordered) {
    if (selected.length >= LEARNING_CANDIDATE_LIMIT) break;
    if (!required.has(playKey(candidate))) selected.push(candidate);
  }
  const result = selected.slice(0, LEARNING_CANDIDATE_LIMIT).map((candidate, index) => ({
    ...candidate,
    id: `learning_${index}`,
    localScore: Number(candidate.localScore) || 0,
  }));
  if (context.decisionEngine !== LEARNING_CONTEXT_ENGINE && context.decisionEngine !== LEARNING_CONTEXT_V2_ENGINE) return result;
  const isV2 = context.decisionEngine === LEARNING_CONTEXT_V2_ENGINE;
  const planning = { ...context, strategyMemo: createStrategicMemo(hand, context.level),
    publicModel: inferPublicThreats(context) };
  const beatModel = createBeatModel(planning);
  const cache = new Map(); // Route cache belongs to this decision only.
  const initialRoute = isV2 ? estimateThreeStepRoute(hand, context.level, planning, { depth: 1, beam: 3, cache }) : null;
  return result.map(candidate => {
    const remaining = removeCards(hand, candidate.cards);
    const route = estimateThreeStepRoute(remaining, context.level, planning, { depth: 1, beam: 3, cache });
    const pass = candidate.action === 'pass';
    const enriched = { ...candidate,
      localScore: pass ? publicCoordinationScore(candidate, planning, planning.publicModel).score
        : strategicCandidateScore(candidate, planning).total,
      projectedTricks: route.estimatedTricks,
      responseSearch: pass ? null : evaluatePublicResponseTree(candidate, planning, beatModel,
        { ownRemaining: remaining.length }) };
    if (!isV2) return enriched;
    const residualControls = remaining.filter(c => isJoker(c) || isWild(c, context.level) || c.rank === 14 || c.rank === context.level).length;
    const legalPlays = generateLegalPlays(remaining, context.level, null);
    const residualBombs = new Set(legalPlays.filter(p => [HandType.BOMB, HandType.FLUSH_STRAIGHT, HandType.JOKER_BOMB].includes(p.hand?.type)).map(p => p.cards.map(c => c.id).sort().join(','))).size;
    return {
      ...enriched,
      residualTricks: route.tricks,
      residualLoose: route.loose,
      residualControls,
      residualBombs,
      trickDelta: (initialRoute?.tricks || 0) - route.tricks,
    };
  });
}

/** Configure only process-local experimental inference; invalid input clears it. */
export function configureOfflineLearningModel(model) {
  if (model == null) {
    offlineModel = null;
    offlineFeatureEngine = LEARNING_DECISION_ENGINE;
    return { ok: true, active: false, modelId: null };
  }
  const validation = validateHybridValueModel(model);
  if (!validation.ok) {
    offlineModel = null;
    return { ok: false, active: false, reason: validation.reason };
  }
  const featureEngine = model.metadata?.featureEngine || LEARNING_DECISION_ENGINE;
  if (!isLearningDecisionEngine(featureEngine)) {
    offlineModel = null;
    return { ok: false, active: false, reason: 'unknown_feature_engine' };
  }
  offlineModel = validation.model;
  offlineFeatureEngine = featureEngine;
  return { ok: true, active: true, modelId: offlineModel.id, featureEngine };
}

/** Select a legal action from the capped set, falling back to the expert action on any uncertainty. */
export function chooseLearningPlay(context = {}, expertDecision = null) {
  const fallback = (reason) => ({
    ...expertDecision,
    modelCalls: 0,
    changed: false,
    fallback: true,
    fallbackReason: reason,
  });
  if (!expertDecision?.action) return fallback('expert_missing');
  if (!offlineModel) return fallback('model_unconfigured');
  const requestedEngine = isLearningDecisionEngine(context.decisionEngine)
    ? context.decisionEngine : LEARNING_DECISION_ENGINE;
  if (requestedEngine !== offlineFeatureEngine) return fallback('feature_engine_mismatch');
  const candidates = buildLearningCandidates(context, expertDecision);
  if (!candidates.length) return fallback('no_eligible_candidates');
  let winner = null;
  let modelCalls = 0;
  const expertKey = playKey(expertDecision);
  for (const candidate of candidates) {
    const score = evaluateHybridValueModel(
      offlineModel,
      extractHybridValueFeatures(context, candidate, requestedEngine),
    );
    modelCalls += 1;
    if (!Number.isFinite(score)) {
      return { ...fallback('model_evaluation_invalid'), modelCalls };
    }
    const isExpert = playKey(candidate) === expertKey;
    if (!winner || score > winner.score
      || (score === winner.score && isExpert && !winner.isExpert)
      || (score === winner.score && isExpert === winner.isExpert
        && playKey(candidate).localeCompare(playKey(winner.candidate)) < 0)) {
      winner = { candidate, score, isExpert };
    }
  }
  if (!winner) return fallback('model_no_winner');
  const changed = playKey(winner.candidate) !== expertKey;
  return {
    action: winner.candidate.action,
    ...(winner.candidate.action === 'play' ? {
      cards: winner.candidate.cards,
      hand: winner.candidate.hand,
      signature: winner.candidate.signature,
    } : { cards: [], hand: null, signature: null }),
    modelCalls,
    changed,
    fallback: false,
    fallbackReason: null,
    learning: {
      candidateCount: candidates.length,
      selectedCandidateId: winner.candidate.id,
      selectedScore: winner.score,
    },
  };
}
