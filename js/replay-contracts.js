/**
 * R1A replay contracts.
 *
 * This module only defines and validates the data boundary. It deliberately
 * does not read game state, localStorage, or the network. RT-2/RT-5 may use
 * these constructors at their respective commit boundaries.
 */

import { sha256Hex } from './model-fingerprint.js';

export const LIVE_PUBLIC_EVENT_SCHEMA = 'guandan-live-public-event-v1';
export const SEALED_TRAINING_TURN_SCHEMA = 'guandan-sealed-training-turn-v1';
export const AGENT_ANNOTATION_SCHEMA = 'guandan-agent-annotation-v1';
export const REPLAY_RULE_VERSION = 'guandan-rules-v1';

const SHA256 = /^[a-f0-9]{64}$/;
const PUBLIC_EVENT_TYPES = new Set(['play', 'pass', 'trick_end', 'round_end']);
const PUBLIC_ACTIONS = new Set(['play', 'pass']);
// Public decision metadata is an audit token, not a free-form explanation.
// Keep the accepted vocabulary deliberately small; unknown producer values
// are normalized to a fixed token before they can cross the public boundary.
export const PUBLIC_REPLAY_DECISION_SOURCES = Object.freeze([
  'human', 'local', 'consultation', 'worker', 'unknown',
]);
export const PUBLIC_REPLAY_FALLBACK_KINDS = Object.freeze([
  'none', 'forced_lead', 'local_timeout', 'local_decision_error',
  'expert_safety_fallback', 'search_evidence_insufficient',
  'selected_candidate_invalid', 'force_expert_choice', 'hybrid_exception',
  'unknown',
]);
const PUBLIC_DECISION_SOURCES = new Set(PUBLIC_REPLAY_DECISION_SOURCES);
const PUBLIC_FALLBACK_KINDS = new Set(PUBLIC_REPLAY_FALLBACK_KINDS);
const FORBIDDEN_KEYS = new Set([
  'hands', 'deck', 'initialHands', 'remainingHands', 'allHands',
  'opponentHands', 'partnerHand', 'hiddenCards', 'roundInitialHands',
  'lastReplay', 'trainingLabel', 'reward', 'outcome',
]);

const PUBLIC_OBSERVATION_KEYS = new Set([
  'seat', 'hand', 'level', 'lastHand', 'lastSeat', 'handCounts', 'teams',
  'finishOrder', 'playedCards', 'publicHistory', 'tributeContext',
  'difficulty', 'deterministic', 'timeBudgetMs', 'policyProfile',
  'policyFeatures', 'policyThresholds', 'opponentModel', 'opponentModelMode',
  'leadAfterOwnBomb', 'decisionEngine',
]);

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value, name, { min = 1, max = 160 } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw new TypeError(`${name} 必须是 ${min}..${max} 个字符的字符串`);
  }
  return value;
}

function integerValue(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} 必须是 ${min}..${max} 的安全整数`);
  }
  return value;
}

function sha256Value(value, name) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new TypeError(`${name} 必须是小写 64 位 SHA-256`);
  }
  return value;
}

function publicToken(value, allowed) {
  const token = String(value);
  return allowed.has(token) ? token : 'unknown';
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  return value;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  )).join(',')}}`;
  if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('摘要内容不得包含非有限数');
  return JSON.stringify(value);
}

function eventDigest(event) {
  const { eventSha256, ...payload } = event;
  return sha256Hex(stableJson(payload));
}

function finalizeEvent(result, suppliedEventSha256) {
  const computed = eventDigest(result);
  if (suppliedEventSha256 != null) {
    sha256Value(suppliedEventSha256, 'eventSha256');
    if (suppliedEventSha256 !== computed) throw new TypeError('eventSha256 与事件内容不匹配');
  }
  result.eventSha256 = computed;
  return Object.freeze(result);
}

function assertNoForbiddenKeys(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenKeys(item, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) throw new TypeError(`${path}.${key} 不得出现在复盘契约中`);
    assertNoForbiddenKeys(item, `${path}.${key}`);
  }
}

function publicCard(card, { allowId = false } = {}) {
  if (!isRecord(card)) throw new TypeError('牌必须是对象');
  const result = {
    rank: integerValue(Number(card.rank), 'card.rank', { min: 2, max: 17 }),
    suit: stringValue(String(card.suit || ''), 'card.suit', { max: 8 }),
  };
  // The physical duplicate index is private identity in a two-deck game.
  // Keep it only for sealed action-seat hands; public projections must leave
  // identical rank+suit cards indistinguishable.
  if (allowId) {
    result.deckIndex = integerValue(Number(card.deckIndex), 'card.deckIndex', { min: 0, max: 1 });
    if (card.id != null) result.id = stringValue(String(card.id), 'card.id', { max: 120 });
  }
  return result;
}

function publicCards(cards, options) {
  if (!Array.isArray(cards)) throw new TypeError('cards 必须是数组');
  return cards.map((card) => publicCard(card, options));
}

function publicHand(hand) {
  if (hand == null) return null;
  if (!isRecord(hand)) throw new TypeError('hand 必须是对象或 null');
  const result = {
    type: stringValue(String(hand.type || ''), 'hand.type', { max: 40 }),
    mainRank: hand.mainRank == null ? null : integerValue(Number(hand.mainRank), 'hand.mainRank', { min: 2, max: 17 }),
    size: integerValue(Number(hand.size || 0), 'hand.size', { min: 0, max: 27 }),
    power: Number.isFinite(Number(hand.power)) ? Number(hand.power) : 0,
  };
  if (hand.meta != null) {
    if (!isRecord(hand.meta)) throw new TypeError('hand.meta 必须是对象');
    const meta = {};
    // A-low straights use rank 1 in rules.js; it is a public shape marker,
    // not a physical card rank, so retain that one additional value here.
    if (Array.isArray(hand.meta.sequence)) meta.sequence = hand.meta.sequence.map((rank) => integerValue(Number(rank), 'hand.meta.sequence', { min: 1, max: 14 }));
    if (hand.meta.pairRank != null) meta.pairRank = integerValue(Number(hand.meta.pairRank), 'hand.meta.pairRank', { min: 2, max: 17 });
    if (hand.meta.suit != null) meta.suit = stringValue(String(hand.meta.suit), 'hand.meta.suit', { max: 8 });
    if (hand.meta.wildAs != null) meta.wildAs = Array.isArray(hand.meta.wildAs)
      ? hand.meta.wildAs.map((rank) => integerValue(Number(rank), 'hand.meta.wildAs', { min: 2, max: 17 }))
      : integerValue(Number(hand.meta.wildAs), 'hand.meta.wildAs', { min: 2, max: 17 });
    result.meta = meta;
  }
  return result;
}

function cardList(value, name, { allowId = false } = {}) {
  try {
    return publicCards(value, { allowId });
  } catch (error) {
    throw new TypeError(`${name} 无效：${error.message}`);
  }
}

function seatValue(value, name, { nullable = false } = {}) {
  if (nullable && value == null) return null;
  return integerValue(Number(value), name, { min: 0, max: 3 });
}

function counts(value, name) {
  if (!Array.isArray(value) || value.length !== 4) throw new TypeError(`${name} 必须是 4 个座位的数组`);
  return value.map((item) => integerValue(Number(item), `${name}[]`, { min: 0, max: 27 }));
}

function sanitizeTribute(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new TypeError('tribute 必须是数组');
  return value.map((item) => {
    if (!isRecord(item)) throw new TypeError('tribute 项必须是对象');
    return {
      kind: item.kind === 'return' ? 'return' : 'tribute',
      from: seatValue(item.from, 'tribute.from'),
      to: seatValue(item.to, 'tribute.to'),
      card: publicCard(item.card),
    };
  });
}

function sanitizeEngine(value) {
  if (value == null) return null;
  if (!isRecord(value)) throw new TypeError('engine 必须是对象或 null');
  return {
    name: stringValue(String(value.name || ''), 'engine.name', { max: 80 }),
    version: stringValue(String(value.version || ''), 'engine.version', { max: 80 }),
  };
}

function sanitizeDecisionMeta(value) {
  if (value == null) return null;
  if (!isRecord(value)) throw new TypeError('decisionMeta 必须是对象或 null');
  const result = {};
  // Free-text decision reasons can describe private hand structure. Public
  // events expose only stable, separately auditable metadata fields.
  if (value.source != null) result.source = publicToken(value.source, PUBLIC_DECISION_SOURCES);
  if (value.fallbackKind != null) result.fallbackKind = publicToken(value.fallbackKind, PUBLIC_FALLBACK_KINDS);
  for (const key of ['searchAttempted', 'searchTriggered']) {
    if (value[key] != null) {
      if (typeof value[key] !== 'boolean') throw new TypeError(`decisionMeta.${key} 必须是布尔值`);
      result[key] = value[key];
    }
  }
  for (const key of ['budgetMs', 'latencyMs']) {
    if (value[key] != null) {
      if (!Number.isFinite(Number(value[key])) || Number(value[key]) < 0) {
        throw new TypeError(`decisionMeta.${key} 必须是非负有限数`);
      }
      result[key] = Number(value[key]);
    }
  }
  return result;
}

function identity(input) {
  if (!isRecord(input)) throw new TypeError('复盘事件必须是对象');
  return {
    matchId: stringValue(input.matchId, 'matchId', { max: 120 }),
    round: integerValue(input.round, 'round', { min: 1 }),
    trick: integerValue(input.trick, 'trick', { min: 1 }),
    turn: integerValue(input.turn, 'turn', { min: 1 }),
    eventId: stringValue(input.eventId, 'eventId', { max: 160 }),
    sequence: integerValue(input.sequence, 'sequence', { min: 0 }),
    occurredAt: stringValue(input.occurredAt, 'occurredAt', { max: 80 }),
    ruleVersion: stringValue(input.ruleVersion || REPLAY_RULE_VERSION, 'ruleVersion', { max: 80 }),
    implementationSha256: sha256Value(input.implementationSha256, 'implementationSha256'),
    previousEventSha256: input.previousEventSha256 == null
      ? null : sha256Value(input.previousEventSha256, 'previousEventSha256'),
  };
}

function validateExactKeys(value, allowed, name) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  return unknown.length ? [`${name} 含未知字段：${unknown.join(',')}`] : [];
}

function validateIdentity(value) {
  const errors = [];
  try { identity(value); } catch (error) { errors.push(error.message); }
  return errors;
}

export function createLivePublicEvent(input) {
  assertNoForbiddenKeys(input);
  const base = identity(input);
  const suppliedEventSha256 = input.eventSha256;
  const eventType = stringValue(input.eventType, 'eventType', { max: 20 });
  if (!PUBLIC_EVENT_TYPES.has(eventType)) throw new TypeError('eventType 不在公开事件白名单中');
  const action = input.action == null ? null : stringValue(input.action, 'action', { max: 12 });
  if (eventType === 'play' && action !== 'play') throw new TypeError('play 事件必须是 play action');
  if (eventType === 'pass' && action !== 'pass') throw new TypeError('pass 事件必须是 pass action');
  if (eventType !== 'play' && eventType !== 'pass' && action != null) throw new TypeError('结束事件不得携带 action');
  const result = {
    schema: LIVE_PUBLIC_EVENT_SCHEMA,
    ...base,
    eventSha256: null,
    eventType,
    seat: seatValue(input.seat, 'seat', { nullable: true }),
    action,
    cards: cardList(input.cards || [], 'cards'),
    hand: publicHand(input.hand),
    countsBefore: counts(input.countsBefore, 'countsBefore'),
    countsAfter: counts(input.countsAfter, 'countsAfter'),
    tribute: sanitizeTribute(input.tribute),
    engine: sanitizeEngine(input.engine),
    decisionMeta: sanitizeDecisionMeta(input.decisionMeta),
  };
  if (eventType === 'play' && (result.seat == null || !result.cards.length || !result.hand)) {
    throw new TypeError('play 事件必须有座位、牌和牌型');
  }
  if (eventType === 'pass' && (result.seat == null || result.cards.length || result.hand)) {
    throw new TypeError('pass 事件必须有座位且不得有牌/牌型');
  }
  if ((eventType === 'trick_end' || eventType === 'round_end')
    && (result.seat != null
      || result.action != null
      || result.cards.length
      || result.hand != null
      || result.tribute.length
      || result.engine != null
      || result.decisionMeta != null)) {
    throw new TypeError(`${eventType} 事件只能携带边界身份、余牌数和空动作载荷`);
  }
  return finalizeEvent(result, suppliedEventSha256);
}

function sanitizeObservation(value) {
  if (!isRecord(value)) throw new TypeError('publicObservation 必须是对象');
  const unknown = Object.keys(value).filter((key) => !PUBLIC_OBSERVATION_KEYS.has(key));
  if (unknown.length) throw new TypeError(`publicObservation 含非白名单字段：${unknown.join(',')}`);
  assertNoForbiddenKeys(value, 'publicObservation');
  const result = clone(value);
  if (Array.isArray(result.hand)) result.hand = cardList(result.hand, 'publicObservation.hand');
  if (Array.isArray(result.playedCards)) result.playedCards = cardList(result.playedCards, 'publicObservation.playedCards');
  if (Array.isArray(result.handCounts)) result.handCounts = counts(result.handCounts, 'publicObservation.handCounts');
  return result;
}

function candidate(value, index) {
  if (!isRecord(value)) throw new TypeError(`legalCandidates[${index}] 必须是对象`);
  return {
    candidateId: stringValue(value.candidateId, `legalCandidates[${index}].candidateId`, { max: 160 }),
    cards: cardList(value.cards || [], `legalCandidates[${index}].cards`),
    hand: publicHand(value.hand),
  };
}

export function createSealedTrainingTurn(input) {
  assertNoForbiddenKeys(input);
  const base = identity(input);
  const suppliedEventSha256 = input.eventSha256;
  const candidates = (Array.isArray(input.legalCandidates) ? input.legalCandidates : []).map(candidate);
  if (!candidates.length) throw new TypeError('legalCandidates 不能为空');
  const ids = candidates.map((item) => item.candidateId);
  if (new Set(ids).size !== ids.length) throw new TypeError('legalCandidates.candidateId 必须唯一');
  const chosen = stringValue(input.chosenCandidateId, 'chosenCandidateId', { max: 160 });
  if (!ids.includes(chosen)) throw new TypeError('chosenCandidateId 必须唯一对应一个合法候选');
  const result = {
    schema: SEALED_TRAINING_TURN_SCHEMA,
    ...base,
    eventSha256: null,
    sourceEventId: stringValue(input.sourceEventId, 'sourceEventId', { max: 160 }),
    seat: seatValue(input.seat, 'seat'),
    hand: cardList(input.hand, 'hand', { allowId: true }),
    publicObservation: sanitizeObservation(input.publicObservation),
    legalCandidates: candidates,
    chosenCandidateId: chosen,
    trainingEligible: false,
  };
  return finalizeEvent(result, suppliedEventSha256);
}

function annotationContent(value) {
  if (!isRecord(value)) throw new TypeError('content 必须是对象');
  assertNoForbiddenKeys(value, 'content');
  const allowed = new Set(['summary', 'tags', 'recommendations', 'confidence']);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new TypeError(`content 含未知字段：${unknown.join(',')}`);
  if (typeof value.summary !== 'string') throw new TypeError('content.summary 必须存在');
  const result = {
    summary: stringValue(value.summary, 'content.summary', { max: 4000 }),
    tags: Array.isArray(value.tags) ? value.tags.map((tag) => stringValue(String(tag), 'content.tags[]', { max: 80 })) : [],
    recommendations: Array.isArray(value.recommendations)
      ? value.recommendations.map((item) => stringValue(String(item), 'content.recommendations[]', { max: 1000 })) : [],
    confidence: value.confidence == null ? null : Number(value.confidence),
  };
  if (result.confidence != null && (!Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1)) {
    throw new TypeError('content.confidence 必须在 0..1');
  }
  return result;
}

export function createAgentAnnotation(input, sourceEvent) {
  assertNoForbiddenKeys(input);
  if (!isRecord(sourceEvent)) throw new TypeError('annotation 必须提供源公开事件');
  const source = createLivePublicEvent(sourceEvent);
  const base = identity(source);
  const eventSha256 = source.eventSha256;
  const sourceEventSha256 = sha256Value(input.sourceEventSha256 || eventSha256, 'sourceEventSha256');
  if (sourceEventSha256 !== eventSha256) throw new TypeError('annotation 源事件摘要不一致');
  return Object.freeze({
    schema: AGENT_ANNOTATION_SCHEMA,
    ...base,
    eventSha256,
    annotationId: stringValue(input.annotationId, 'annotationId', { max: 160 }),
    createdAt: stringValue(input.createdAt, 'createdAt', { max: 80 }),
    model: stringValue(input.model, 'model', { max: 160 }),
    promptVersion: stringValue(input.promptVersion, 'promptVersion', { max: 160 }),
    sourceEventSha256,
    content: annotationContent(input.content),
  });
}

export function validateLivePublicEvent(value) {
  if (!isRecord(value)) return { ok: false, errors: ['公开事件必须是对象'] };
  const errors = validateExactKeys(value, new Set([
    'schema', 'matchId', 'round', 'trick', 'turn', 'eventId', 'sequence',
    'occurredAt', 'ruleVersion', 'implementationSha256', 'eventSha256', 'previousEventSha256',
    'eventType', 'seat', 'action', 'cards', 'hand', 'countsBefore', 'countsAfter',
    'tribute', 'engine', 'decisionMeta',
  ]), '公开事件');
  if (value.schema !== LIVE_PUBLIC_EVENT_SCHEMA) errors.push('schema 不匹配');
  errors.push(...validateIdentity(value));
  try { createLivePublicEvent(value); } catch (error) { errors.push(error.message); }
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

export function validateSealedTrainingTurn(value) {
  if (!isRecord(value)) return { ok: false, errors: ['密封 turn 必须是对象'] };
  const errors = validateExactKeys(value, new Set([
    'schema', 'matchId', 'round', 'trick', 'turn', 'eventId', 'sequence',
    'occurredAt', 'ruleVersion', 'implementationSha256', 'eventSha256', 'previousEventSha256',
    'sourceEventId', 'seat', 'hand', 'publicObservation', 'legalCandidates',
    'chosenCandidateId', 'trainingEligible',
  ]), '密封 turn');
  if (value.schema !== SEALED_TRAINING_TURN_SCHEMA) errors.push('schema 不匹配');
  if (value.trainingEligible !== false) errors.push('密封 turn 必须保持 trainingEligible=false');
  errors.push(...validateIdentity(value));
  try { createSealedTrainingTurn(value); } catch (error) { errors.push(error.message); }
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

export function validateAgentAnnotation(value, sourceEvent) {
  if (!isRecord(value)) return { ok: false, errors: ['annotation 必须是对象'] };
  const errors = validateExactKeys(value, new Set([
    'schema', 'matchId', 'round', 'trick', 'turn', 'eventId', 'sequence',
    'occurredAt', 'ruleVersion', 'implementationSha256', 'eventSha256', 'previousEventSha256',
    'annotationId', 'createdAt', 'model', 'promptVersion', 'sourceEventSha256', 'content',
  ]), 'annotation');
  if (value.schema !== AGENT_ANNOTATION_SCHEMA) errors.push('schema 不匹配');
  if (!isRecord(sourceEvent)) {
    errors.push('annotation 必须提供源公开事件核对绑定身份');
  } else {
    try {
      const expected = createAgentAnnotation(value, sourceEvent);
      if (stableJson(value) !== stableJson(expected)) errors.push('annotation 与源公开事件绑定字段不一致');
    } catch (error) { errors.push(error.message); }
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

/** Validate a contiguous public-event chain without mutating or persisting it. */
export function validateLiveEventChain(events) {
  if (!Array.isArray(events) || !events.length) return { ok: false, errors: ['事件链不能为空'] };
  const errors = [];
  const ids = new Set();
  let previous = null;
  events.forEach((event, index) => {
    const result = validateLivePublicEvent(event);
    if (!result.ok) errors.push(...result.errors.map((error) => `事件[${index}] ${error}`));
    if (ids.has(event?.eventId)) errors.push(`事件[${index}] eventId 重复`);
    ids.add(event?.eventId);
    if (previous) {
      if (!isRecord(event) || event.matchId !== previous.matchId) errors.push(`事件[${index}] matchId 串线`);
      if (!isRecord(event) || event.sequence !== previous.sequence + 1) errors.push(`事件[${index}] sequence 不连续`);
      if (!isRecord(event) || event.previousEventSha256 !== previous.eventSha256) errors.push(`事件[${index}] 前序摘要不匹配`);
    } else {
      if (!isRecord(event) || event.sequence !== 0) errors.push('事件[0] 首事件 sequence 必须为 0');
      if (event?.previousEventSha256 != null) errors.push('事件[0] 首事件不得有前序摘要');
    }
    previous = event;
  });
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

// Browser code cannot synchronously read its own source file. Keep an explicit
// manifest of every helper and policy value that participates in public-event
// serialization/validation, so the runtime digest changes with the real
// boundary implementation rather than with a fixed version label or only the
// top-level constructor's source.
const REPLAY_IMPLEMENTATION_ENTRIES = Object.freeze([
  ['LIVE_PUBLIC_EVENT_SCHEMA', LIVE_PUBLIC_EVENT_SCHEMA],
  ['SEALED_TRAINING_TURN_SCHEMA', SEALED_TRAINING_TURN_SCHEMA],
  ['AGENT_ANNOTATION_SCHEMA', AGENT_ANNOTATION_SCHEMA],
  ['REPLAY_RULE_VERSION', REPLAY_RULE_VERSION],
  ['SHA256', SHA256.source],
  ['PUBLIC_EVENT_TYPES', [...PUBLIC_EVENT_TYPES].sort()],
  ['PUBLIC_ACTIONS', [...PUBLIC_ACTIONS].sort()],
  ['PUBLIC_REPLAY_DECISION_SOURCES', PUBLIC_REPLAY_DECISION_SOURCES],
  ['PUBLIC_REPLAY_FALLBACK_KINDS', PUBLIC_REPLAY_FALLBACK_KINDS],
  ['FORBIDDEN_KEYS', [...FORBIDDEN_KEYS].sort()],
  ['PUBLIC_OBSERVATION_KEYS', [...PUBLIC_OBSERVATION_KEYS].sort()],
  ['sha256Hex', sha256Hex],
  ['isRecord', isRecord],
  ['stringValue', stringValue],
  ['integerValue', integerValue],
  ['sha256Value', sha256Value],
  ['publicToken', publicToken],
  ['clone', clone],
  ['stableJson', stableJson],
  ['eventDigest', eventDigest],
  ['finalizeEvent', finalizeEvent],
  ['assertNoForbiddenKeys', assertNoForbiddenKeys],
  ['publicCard', publicCard],
  ['publicCards', publicCards],
  ['publicHand', publicHand],
  ['cardList', cardList],
  ['seatValue', seatValue],
  ['counts', counts],
  ['sanitizeTribute', sanitizeTribute],
  ['sanitizeEngine', sanitizeEngine],
  ['sanitizeDecisionMeta', sanitizeDecisionMeta],
  ['identity', identity],
  ['validateExactKeys', validateExactKeys],
  ['validateIdentity', validateIdentity],
  ['sanitizeObservation', sanitizeObservation],
  ['candidate', candidate],
  ['annotationContent', annotationContent],
  ['createLivePublicEvent', createLivePublicEvent],
  ['createSealedTrainingTurn', createSealedTrainingTurn],
  ['createAgentAnnotation', createAgentAnnotation],
  ['validateLivePublicEvent', validateLivePublicEvent],
  ['validateSealedTrainingTurn', validateSealedTrainingTurn],
  ['validateAgentAnnotation', validateAgentAnnotation],
  ['validateLiveEventChain', validateLiveEventChain],
  ['implementationSource', implementationSource],
  ['computeReplayContractImplementationSha256', computeReplayContractImplementationSha256],
]);

export const REPLAY_CONTRACT_IMPLEMENTATION_MANIFEST = Object.freeze(
  REPLAY_IMPLEMENTATION_ENTRIES.map(([name]) => name),
);

function implementationSource(value) {
  return typeof value === 'function' ? value.toString() : stableJson(value);
}

export function computeReplayContractImplementationSha256(overrides = {}) {
  if (!isRecord(overrides)) throw new TypeError('实现摘要覆盖项必须是对象');
  const unknown = Object.keys(overrides).filter(
    (name) => !REPLAY_CONTRACT_IMPLEMENTATION_MANIFEST.includes(name),
  );
  if (unknown.length) throw new TypeError(`未知实现摘要覆盖项：${unknown.join(',')}`);
  return sha256Hex([
    'guandan-replay-contract-implementation-v2',
    ...REPLAY_IMPLEMENTATION_ENTRIES.map(([name, value]) => (
      `${name}\n${Object.prototype.hasOwnProperty.call(overrides, name)
        ? String(overrides[name]) : implementationSource(value)}`
    )),
  ].join('\n'));
}

export const REPLAY_CONTRACT_IMPLEMENTATION_SHA256 = computeReplayContractImplementationSha256();
