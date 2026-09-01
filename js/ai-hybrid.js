/**
 * 混合决策实验层：专家候选 + 可插拔价值模型 + 公平信息集采样/受限终局模拟。
 *
 * 这里从不读取真实暗牌。每个隐藏牌面都由 108 张牌减去本家手牌、公开出牌与
 * 已知贡还后重新采样；采样世界只用于估计候选期望，不会写回真实牌局。
 */

import {
  RANKS, SUITS, isJoker, isWild, removeCards, soloPower,
} from './cards.js';
import {
  HandType, generateLegalPlays, handSignature, parseHandVariants,
} from './rules.js';
import { inferRemainingPool } from './ai-route.js';
import { createPublicAIObservation } from './ai-observation.js';
import {
  VALUE_MODEL_STATUS, isPromotedValueModel, valueModelStatus,
} from './value-model-gate.js';

export const HYBRID_ENGINE_VERSION = 1;
export const HYBRID_VALUE_SCHEMA = 'guandan-candidate-v1';
/**
 * 信息集增强的三个可验证搜索模式：
 * - pimc-v1：每个候选在每个公平采样世界各 rollout 一次（现有基线）。
 * - paired-root-pimc-v1：在相同假想世界成对覆盖全部候选，并用完整世界数
 *   和有效访问数约束改选。世界仍来自当前公开信息集，不会把真实暗牌传入
 *   模拟器。它不是树搜索：每次 iteration 都对应一次实际 rollout。
 * - ismcts-v2：每次 iteration 重新采样一个合法暗牌世界，在只由公开动作
 *   序列索引的开放环树上按动作可用次数修正 UCT；叶节点使用专家 rollout。
 * - ismcts-v3：在 v2 的开放环树与深层 UCT 之上，把每次迭代改为成对 sweep——
 *   同一假想世界按轮转顺序对每个根候选各强制下钻一次（跳过根层 UCT），
 *   消除根候选比较中的“世界难度”混淆；sweep 中途耗尽预算则整批丢弃不回传。
 */
export const HYBRID_SEARCH_MODES = Object.freeze({
  PIMC: 'pimc-v1',
  PAIRED_ROOT_PIMC: 'paired-root-pimc-v1',
  ISMCTS: 'ismcts-v2',
  ISMCTS_V3: 'ismcts-v3',
});

// Availability-aware UCT (Cowling et al.) keeps the action's own visit count
// in the denominator.  Availability is the number of determinizations in
// which that action was legal, so it replaces—not supplements—the parent
// visit count in the exploration numerator.
export function availabilityAwareUctBonus(availability, visits, exploration) {
  return Number(exploration) * Math.sqrt(
    Math.log(Math.max(1, Number(availability) || 0) + 1) / Math.max(1, Number(visits) || 0),
  );
}
export const HYBRID_VALUE_FEATURES = Object.freeze([
  'remaining_fraction', 'played_fraction', 'candidate_size', 'candidate_power',
  'local_score', 'projected_tricks', 'is_pass', 'is_lead', 'is_bomb',
  'is_flush_straight', 'uses_wild', 'uses_joker', 'uses_level', 'team_control',
  'enemy_control', 'enemy_bomb', 'self_count', 'partner_count', 'downstream_count',
  'upstream_count', 'enemy_min', 'partner_finished', 'enemy_finished',
  'finishes_now', 'type_single', 'type_pair', 'type_triple', 'type_fullhouse',
  'type_straight', 'type_triple_pair', 'type_plate', 'main_rank',
]);

const BOMB_TYPES = new Set([
  HandType.BOMB, HandType.FLUSH_STRAIGHT, HandType.JOKER_BOMB,
]);
const IRREVERSIBLE_STRATEGY_TAGS = new Set([
  'split_bomb', 'split_flush_straight', 'split_straight', 'split_group',
  'split_pair', 'wild_as_single', 'wild_simple_use', 'preserve_wild',
  'premium_tribute_opening', 'control_first',
]);
const MODEL_ACTIVATIONS = new Set(['linear', 'relu', 'tanh']);
const MAX_MODEL_WEIGHTS = 100000;
let activeValueModel = null;

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function normalizeSearchMode(value) {
  const mode = String(value || '').toLowerCase();
  if (mode === HYBRID_SEARCH_MODES.ISMCTS) return HYBRID_SEARCH_MODES.ISMCTS;
  if (mode === HYBRID_SEARCH_MODES.ISMCTS_V3) return HYBRID_SEARCH_MODES.ISMCTS_V3;
  // 保留历史保存设置、旧 A/B 报告重放所用标识的读取兼容；运行时遥测
  // 一律使用诚实的 paired-root-pimc-v1 名称；它不能被误标为 ismcts-v2。
  if (mode === 'ismcts' || mode === 'ismcts-root' || mode === 'ismcts-root-v1'
    || mode === HYBRID_SEARCH_MODES.PAIRED_ROOT_PIMC) {
    return HYBRID_SEARCH_MODES.PAIRED_ROOT_PIMC;
  }
  return HYBRID_SEARCH_MODES.PIMC;
}

function physicalKey(card) {
  if (!card || !Number.isFinite(Number(card.rank)) || !card.suit) return '';
  const deck = card.deckIndex != null && Number.isFinite(Number(card.deckIndex))
    ? Number(card.deckIndex) : '?';
  return `${Number(card.rank)}:${String(card.suit)}:${deck}`;
}

function faceKey(card) {
  return `${Number(card?.rank)}:${String(card?.suit || '')}`;
}

function canonicalDeck() {
  const cards = [];
  for (let deckIndex = 0; deckIndex < 2; deckIndex++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        cards.push({
          id: `sim_${rank}_${suit}_${deckIndex}`,
          rank,
          suit,
          deckIndex,
        });
      }
    }
    for (const rank of [16, 17]) {
      cards.push({
        id: `sim_${rank}_J_${deckIndex}`,
        rank,
        suit: 'J',
        deckIndex,
      });
    }
  }
  return cards;
}

function hashString(value) {
  let hash = 2166136261;
  const text = String(value || '');
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function observationSeed(observation, extra = 0) {
  const hand = (observation.hand || []).map(physicalKey).sort().join(',');
  const played = (observation.playedCards || []).map(physicalKey).sort().join(',');
  const history = (observation.publicHistory || []).slice(-12)
    .map((item) => `${item.turn}:${item.seat}:${item.action}:${item.hand?.type || ''}:${item.hand?.power || 0}`)
    .join(';');
  return hashString([
    observation.level, observation.seat, hand, played,
    (observation.handCounts || []).join(','), history, extra,
  ].join('|')) || 1;
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(cards, random) {
  const result = cards.slice();
  for (let index = result.length - 1; index > 0; index--) {
    const target = Math.floor(random() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

function takeKnownCard(pool, known) {
  if (!known) return null;
  const exact = known.deckIndex != null && Number.isFinite(Number(known.deckIndex));
  let index = exact
    ? pool.findIndex((card) => physicalKey(card) === physicalKey(known))
    : -1;
  if (index < 0) index = pool.findIndex((card) => faceKey(card) === faceKey(known));
  if (index < 0) return null;
  return pool.splice(index, 1)[0];
}

function removeVisibleCards(pool, cards) {
  for (const card of cards || []) {
    if (!takeKnownCard(pool, card)) return false;
  }
  return true;
}

function recentPassProbes(observation) {
  const probes = [];
  let target = null;
  for (const item of observation.publicHistory || []) {
    if (item.action === 'play' && item.hand) {
      target = { hand: item.hand, seat: item.seat };
    } else if (item.action === 'pass' && target && item.seat !== observation.seat) {
      probes.push({ seat: item.seat, targetSeat: target.seat, hand: target.hand });
    }
  }
  return probes.slice(-8);
}

function sampleBehaviorScore(hands, observation, probes) {
  let score = 0;
  const teams = observation.teams || [0, 1, 0, 1];
  for (const probe of probes) {
    const hand = hands[probe.seat] || [];
    if (!hand.length || !probe.hand) continue;
    // 当前仍持有的牌是过去手牌的子集；若现在仍可压，当时也具备这条路线。
    // 过牌只是软证据：对家礼让不罚，对敌方保炸/保结构只作轻度降权。
    const couldBeat = generateLegalPlays(hand, observation.level, probe.hand).length > 0;
    if (!couldBeat) score += 0.08;
    else if (teams[probe.seat] !== teams[probe.targetSeat]) score -= 0.28;
  }
  return score;
}

function buildOneInformationSet(observation, random, probes, attempts) {
  let best = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const pool = canonicalDeck();
    if (!removeVisibleCards(pool, observation.hand)
      || !removeVisibleCards(pool, observation.playedCards)) {
      return { ok: false, reason: 'visible_card_mismatch' };
    }

    const hands = Array.from({ length: 4 }, () => []);
    hands[observation.seat] = observation.hand.map((card) => ({ ...card }));
    const inferred = inferRemainingPool(observation);
    for (let seat = 0; seat < 4; seat++) {
      if (seat === observation.seat) continue;
      for (const known of inferred.knownBySeat?.[seat] || []) {
        const card = takeKnownCard(pool, known);
        if (!card) return { ok: false, reason: 'tribute_card_mismatch' };
        hands[seat].push(card);
      }
    }

    const needBySeat = new Array(4).fill(0);
    let totalNeed = 0;
    for (let seat = 0; seat < 4; seat++) {
      if (seat === observation.seat) continue;
      const target = Math.max(0, Number(observation.handCounts?.[seat]) || 0);
      if (hands[seat].length > target) return { ok: false, reason: 'known_card_overflow' };
      needBySeat[seat] = target - hands[seat].length;
      totalNeed += needBySeat[seat];
    }
    if (pool.length !== totalNeed) {
      return {
        ok: false,
        reason: 'remaining_pool_mismatch',
        poolCount: pool.length,
        requiredCount: totalNeed,
      };
    }

    const unknown = shuffled(pool, random);
    let cursor = 0;
    // 从当前行动者的下家开始轮转发牌，避免固定座位总拿到洗牌数组同一区段。
    for (let offset = 1; offset <= 4; offset++) {
      const seat = (observation.seat + offset) % 4;
      if (seat === observation.seat) continue;
      const count = needBySeat[seat];
      hands[seat].push(...unknown.slice(cursor, cursor + count));
      cursor += count;
    }
    const behaviorScore = sampleBehaviorScore(hands, observation, probes);
    if (!best || behaviorScore > best.behaviorScore) {
      best = { ok: true, hands, behaviorScore };
    }
  }
  return best || { ok: false, reason: 'sampling_failed' };
}

/**
 * 公平地采样当前信息集。返回的是“可能牌面”，不是对真实暗牌的重建。
 */
export function samplePublicInformationSets(ctx, options = {}) {
  const observation = createPublicAIObservation(ctx);
  const sampleCount = clamp(Math.floor(Number(options.sampleCount) || 4), 1, 32);
  const attempts = clamp(Math.floor(Number(options.behaviorAttempts) || 2), 1, 6);
  const random = mulberry32(observationSeed(observation, options.seed || 0));
  const probes = recentPassProbes(observation);
  const samples = [];
  let failure = null;
  for (let index = 0; index < sampleCount; index++) {
    const sample = buildOneInformationSet(observation, random, probes, attempts);
    if (!sample.ok) {
      failure = sample;
      break;
    }
    samples.push(sample);
  }
  return {
    ok: !failure && samples.length === sampleCount,
    observation,
    samples,
    sampleCount: samples.length,
    requestedSamples: sampleCount,
    behaviorProbeCount: probes.length,
    failure,
  };
}

function normalizedCount(value) {
  return clamp((Number(value) || 0) / 27, 0, 1);
}

function candidateCards(candidate) {
  return Array.isArray(candidate?.cards) ? candidate.cards : [];
}

export function extractHybridValueFeatures(ctx, candidate) {
  const observation = createPublicAIObservation(ctx);
  const cards = candidateCards(candidate);
  const hand = candidate?.hand || null;
  const seat = observation.seat;
  const partner = (seat + 2) % 4;
  const downstream = (seat + 1) % 4;
  const upstream = (seat + 3) % 4;
  const enemies = [downstream, upstream]
    .filter((enemy) => !observation.finishOrder.includes(enemy));
  const enemyMin = enemies.length
    ? Math.min(...enemies.map((enemy) => observation.handCounts[enemy])) : 0;
  const remaining = Math.max(0, observation.hand.length - cards.length);
  const type = hand?.type;
  return Float64Array.from([
    normalizedCount(remaining),
    clamp((observation.playedCards?.length || 0) / 108, 0, 1),
    clamp(cards.length / 8, 0, 1),
    clamp((Number(hand?.power) || 0) / 100, 0, 1),
    clamp((Number(candidate?.localScore) || 0) / 1000, -2, 2),
    clamp((Number(candidate?.projectedTricks) || 0) / 12, 0, 2),
    Number(candidate?.action === 'pass'),
    Number(!observation.lastHand),
    Number(BOMB_TYPES.has(type)),
    Number(type === HandType.FLUSH_STRAIGHT),
    clamp(cards.filter((card) => isWild(card, observation.level)).length / 2, 0, 1),
    clamp(cards.filter(isJoker).length / 4, 0, 1),
    clamp(cards.filter((card) => card.rank === observation.level).length / 8, 0, 1),
    clamp(Number(candidate?.responseSearch?.teamControl) || 0, 0, 1),
    clamp(Number(candidate?.responseSearch?.enemyControl) || 0, 0, 1),
    clamp(Number(candidate?.responseSearch?.enemyBomb) || 0, 0, 1),
    normalizedCount(observation.handCounts[seat]),
    normalizedCount(observation.handCounts[partner]),
    normalizedCount(observation.handCounts[downstream]),
    normalizedCount(observation.handCounts[upstream]),
    normalizedCount(enemyMin),
    Number(observation.finishOrder.includes(partner)),
    Number(enemies.length < 2),
    Number(candidate?.action === 'play' && cards.length === observation.hand.length),
    Number(type === HandType.SINGLE),
    Number(type === HandType.PAIR),
    Number(type === HandType.TRIPLE),
    Number(type === HandType.FULLHOUSE),
    Number(type === HandType.STRAIGHT),
    Number(type === HandType.TRIPLE_PAIR),
    Number(type === HandType.PLATE),
    clamp((Number(hand?.mainRank) || 0) / 17, 0, 1),
  ]);
}

function normalizeLayer(layer, inputSize) {
  if (!layer || !Array.isArray(layer.weights) || !Array.isArray(layer.bias)) return null;
  const outputSize = layer.weights.length;
  if (!outputSize || outputSize > 128 || layer.bias.length !== outputSize) return null;
  const weights = [];
  for (const row of layer.weights) {
    if (!Array.isArray(row) || row.length !== inputSize) return null;
    const values = row.map(Number);
    if (values.some((value) => !Number.isFinite(value))) return null;
    weights.push(values);
  }
  const bias = layer.bias.map(Number);
  if (bias.some((value) => !Number.isFinite(value))) return null;
  const activation = MODEL_ACTIVATIONS.has(layer.activation) ? layer.activation : 'linear';
  return { inputSize, outputSize, weights, bias, activation };
}

export function validateHybridValueModel(model) {
  if (!model || typeof model !== 'object') return { ok: false, reason: 'model_missing' };
  if (model.schema !== HYBRID_VALUE_SCHEMA) return { ok: false, reason: 'schema_mismatch' };
  if (!Array.isArray(model.layers) || !model.layers.length || model.layers.length > 4) {
    return { ok: false, reason: 'invalid_layers' };
  }
  let inputSize = HYBRID_VALUE_FEATURES.length;
  let weightCount = 0;
  const layers = [];
  for (const layer of model.layers) {
    const normalized = normalizeLayer(layer, inputSize);
    if (!normalized) return { ok: false, reason: 'invalid_layer_shape' };
    weightCount += normalized.inputSize * normalized.outputSize + normalized.outputSize;
    if (weightCount > MAX_MODEL_WEIGHTS) return { ok: false, reason: 'model_too_large' };
    layers.push(normalized);
    inputSize = normalized.outputSize;
  }
  if (inputSize !== 1) return { ok: false, reason: 'output_must_be_scalar' };
  return {
    ok: true,
    model: {
      id: String(model.id || 'unnamed-value-model').slice(0, 80),
      schema: HYBRID_VALUE_SCHEMA,
      layers,
      weightCount,
      metadata: {
        status: valueModelStatus(model),
      },
    },
  };
}

export function configureHybridValueModel(model, options = {}) {
  if (model == null) {
    activeValueModel = null;
    return { ok: true, active: false, modelId: null, status: null };
  }
  const validation = validateHybridValueModel(model);
  if (!validation.ok) return { ...validation, active: !!activeValueModel };
  const status = valueModelStatus(model);
  if (!isPromotedValueModel(model) && options.allowExperimental !== true) {
    return {
      ok: false,
      reason: 'model_not_promoted',
      status,
      requiredStatus: VALUE_MODEL_STATUS.PROMOTED,
      active: !!activeValueModel,
    };
  }
  activeValueModel = validation.model;
  return { ok: true, active: true, modelId: activeValueModel.id, status };
}

export function getHybridValueModelStatus() {
  return activeValueModel
    ? {
        configured: true,
        modelId: activeValueModel.id,
        schema: activeValueModel.schema,
        status: activeValueModel.metadata?.status || VALUE_MODEL_STATUS.EXPERIMENTAL,
      }
    : { configured: false, modelId: null, schema: HYBRID_VALUE_SCHEMA, status: null };
}

function activate(value, activation) {
  if (activation === 'relu') return Math.max(0, value);
  if (activation === 'tanh') return Math.tanh(value);
  return value;
}

export function evaluateHybridValueModel(model, features) {
  const normalized = model?.layers?.[0]?.inputSize != null
    ? { ok: true, model }
    : validateHybridValueModel(model);
  if (!normalized.ok) return null;
  let values = Array.from(features || []);
  if (values.length !== HYBRID_VALUE_FEATURES.length) return null;
  for (const layer of normalized.model.layers) {
    const next = new Array(layer.outputSize).fill(0);
    for (let output = 0; output < layer.outputSize; output++) {
      let sum = layer.bias[output];
      for (let input = 0; input < layer.inputSize; input++) {
        sum += layer.weights[output][input] * values[input];
      }
      next[output] = activate(sum, layer.activation);
    }
    values = next;
  }
  return Number.isFinite(values[0]) ? values[0] : null;
}

function nextSeatWith(state, from, predicate) {
  for (let offset = 1; offset <= 4; offset++) {
    const seat = (from + offset) % 4;
    if (predicate(seat)) return seat;
  }
  return null;
}

function activeSeats(state) {
  return state.hands.map((hand, seat) => ({ seat, count: hand.length }))
    .filter((item) => item.count > 0)
    .map((item) => item.seat);
}

function finishSeat(state, seat) {
  if (!state.finishOrder.includes(seat)) state.finishOrder.push(seat);
}

function completeFinishOrder(state) {
  const missing = [0, 1, 2, 3].filter((seat) => !state.finishOrder.includes(seat));
  missing.sort((left, right) => state.hands[left].length - state.hands[right].length || left - right);
  state.finishOrder.push(...missing);
}

function terminalTeam(state) {
  for (const team of [0, 1]) {
    const seats = [0, 1, 2, 3].filter((seat) => state.teams[seat] === team);
    if (seats.every((seat) => state.finishOrder.includes(seat))) return team;
  }
  return null;
}

function teamUpgradeUtility(finishOrder, teams, rootTeam) {
  if (!finishOrder.length) return 0;
  const winner = teams[finishOrder[0]];
  const partnerSeat = finishOrder.find((seat) => seat !== finishOrder[0] && teams[seat] === winner);
  const partnerPlace = finishOrder.indexOf(partnerSeat);
  const upgrade = partnerPlace === 1 ? 3 : partnerPlace === 2 ? 2 : 1;
  return winner === rootTeam ? upgrade : -upgrade;
}

function isBomb(hand) {
  return BOMB_TYPES.has(hand?.type);
}

function rolloutStructureCost(play, fullHand, level) {
  const cards = play.cards || [];
  let cost = cards.filter((card) => isWild(card, level)).length * 8;
  cost += cards.filter(isJoker).length * 4;
  if (isBomb(play.hand) && cards.length < fullHand.length) cost += 32;
  if ([HandType.SINGLE, HandType.PAIR, HandType.TRIPLE].includes(play.hand?.type)) {
    const rank = play.hand.mainRank;
    const before = fullHand.filter((card) => card.rank === rank && !isWild(card, level)).length;
    if (before > cards.length) cost += (before - cards.length) * 5;
  }
  return cost;
}

function recordRolloutDiagnostic(state, key) {
  if (!state.rolloutDiagnostics) state.rolloutDiagnostics = {};
  state.rolloutDiagnostics[key] = (state.rolloutDiagnostics[key] || 0) + 1;
}

// 领出时规则生成器理论上总会提供至少一个单张。这个独立兜底不依赖其
// 枚举结果：若未来的生成器回归遗漏了所有着法，仍从本家实体牌重建最便宜
// 的单张，避免把领出错误地降格为 pass 并静默丢弃整次 sweep。
function cheapestLeadFallback(hand, level) {
  const candidates = hand.flatMap((card) => parseHandVariants([card], level).map((parsed) => ({
    cards: [card], hand: parsed,
  })));
  return candidates.sort((left, right) => (
    rolloutStructureCost(left, hand, level) - rolloutStructureCost(right, hand, level)
    || left.hand.power - right.hand.power
    || handSignature(left.hand).localeCompare(handSignature(right.hand))
  ))[0] || null;
}

export function chooseRolloutPlay(state, seat, { legalPlayGenerator = generateLegalPlays } = {}) {
  const hand = state.hands[seat];
  const plays = legalPlayGenerator(hand, state.level, state.lastHand);
  if (!plays.length) {
    if (state.lastHand) return null;
    const fallback = cheapestLeadFallback(hand, state.level);
    if (fallback) {
      recordRolloutDiagnostic(state, 'leadFallbackUsed');
      return fallback;
    }
    recordRolloutDiagnostic(state, 'leadFallbackUnavailable');
    return null;
  }
  const finishing = plays.filter((play) => play.cards.length === hand.length);
  if (finishing.length) {
    return finishing.sort((left, right) => (
      Number(isBomb(left.hand)) - Number(isBomb(right.hand))
      || left.hand.power - right.hand.power
    ))[0];
  }

  if (state.lastHand && state.lastSeat != null
    && state.teams[state.lastSeat] === state.teams[seat]) return null;

  const lastEnemyCount = state.lastSeat != null
    && state.teams[state.lastSeat] !== state.teams[seat]
    ? state.hands[state.lastSeat].length : 99;
  const ordinary = plays.filter((play) => !isBomb(play.hand));
  const pool = ordinary.length
    ? ordinary
    : (lastEnemyCount <= 4 || hand.length <= 8 ? plays : []);
  if (!pool.length) return null;

  return pool.slice().sort((left, right) => {
    const leftRemain = hand.length - left.cards.length;
    const rightRemain = hand.length - right.cards.length;
    const leftCost = rolloutStructureCost(left, hand, state.level);
    const rightCost = rolloutStructureCost(right, hand, state.level);
    if (!state.lastHand) {
      return leftRemain - rightRemain
        || leftCost - rightCost
        || Number(isBomb(left.hand)) - Number(isBomb(right.hand))
        || left.hand.power - right.hand.power
        || handSignature(left.hand).localeCompare(handSignature(right.hand));
    }
    return leftCost - rightCost
      || Number(isBomb(left.hand)) - Number(isBomb(right.hand))
      || left.hand.power - right.hand.power
      || handSignature(left.hand).localeCompare(handSignature(right.hand));
  })[0];
}

function respondersForCurrentTrick(state) {
  const active = activeSeats(state);
  if (state.lastSeat == null) return [];
  if (state.hands[state.lastSeat].length > 0) {
    return active.filter((seat) => seat !== state.lastSeat);
  }
  const waitingPartner = (state.lastSeat + 2) % 4;
  return active.filter((seat) => seat !== waitingPartner);
}

function closeTrickIfComplete(state) {
  if (!state.lastHand || state.lastSeat == null) return false;
  const responders = respondersForCurrentTrick(state);
  if (!responders.every((seat) => state.passed.has(seat))) return false;
  const last = state.lastSeat;
  const partner = (last + 2) % 4;
  const leader = state.hands[last].length > 0
    ? last
    : state.hands[partner].length > 0
      ? partner
      : nextSeatWith(state, last, (seat) => state.hands[seat].length > 0);
  state.lastHand = null;
  state.lastSeat = null;
  state.passed.clear();
  state.currentSeat = leader;
  return true;
}

function nextResponder(state, from) {
  const responders = new Set(respondersForCurrentTrick(state));
  return nextSeatWith(state, from, (seat) => (
    state.hands[seat].length > 0
    && responders.has(seat)
    && !state.passed.has(seat)
  ));
}

function historicalPasses(observation) {
  const passed = new Set();
  const history = observation.publicHistory || [];
  let lastPlayIndex = -1;
  for (let index = history.length - 1; index >= 0; index--) {
    if (history[index].action === 'play') {
      lastPlayIndex = index;
      break;
    }
  }
  if (lastPlayIndex < 0) return passed;
  for (let index = lastPlayIndex + 1; index < history.length; index++) {
    if (history[index].action === 'pass' && history[index].seat != null) {
      passed.add(history[index].seat);
    }
  }
  return passed;
}

function resolveCandidateCards(candidate, hand) {
  if (candidate.action === 'pass') return [];
  const byId = new Map(hand.map((card) => [String(card.id), card]));
  const cards = candidateCards(candidate).map((card) => byId.get(String(card.id))).filter(Boolean);
  return cards.length === candidateCards(candidate).length ? cards : null;
}

function cutoffUtility(state, rootTeam) {
  let own = 0;
  let enemy = 0;
  let ownFinished = 0;
  let enemyFinished = 0;
  for (let seat = 0; seat < 4; seat++) {
    if (state.teams[seat] === rootTeam) {
      own += state.hands[seat].length;
      ownFinished += Number(state.finishOrder.includes(seat));
    } else {
      enemy += state.hands[seat].length;
      enemyFinished += Number(state.finishOrder.includes(seat));
    }
  }
  const control = state.lastSeat == null ? 0
    : state.teams[state.lastSeat] === rootTeam ? 0.18 : -0.18;
  return clamp((enemy - own) / 18 + (ownFinished - enemyFinished) * 0.7 + control, -2.5, 2.5);
}

function applyRootCandidate(state, candidate, observation) {
  const seat = observation.seat;
  if (candidate.action === 'pass') {
    state.passed.add(seat);
    if (!closeTrickIfComplete(state)) {
      state.currentSeat = nextResponder(state, seat);
    }
    return true;
  }
  const cards = resolveCandidateCards(candidate, state.hands[seat]);
  if (!cards) return false;
  state.hands[seat] = removeCards(state.hands[seat], cards);
  state.lastHand = candidate.hand;
  state.lastSeat = seat;
  state.passed.clear();
  if (!state.hands[seat].length) finishSeat(state, seat);
  if (terminalTeam(state) != null) return true;
  state.currentSeat = nextResponder(state, seat);
  if (state.currentSeat == null) closeTrickIfComplete(state);
  return true;
}

function simulateCandidate(sample, observation, candidate, limits) {
  const state = {
    hands: sample.hands.map((hand) => hand.map((card) => ({ ...card }))),
    teams: observation.teams.slice(),
    level: observation.level,
    finishOrder: observation.finishOrder.slice(),
    lastHand: observation.lastHand,
    lastSeat: observation.lastSeat,
    passed: historicalPasses(observation),
    currentSeat: null,
  };
  if (!applyRootCandidate(state, candidate, observation)) {
    return { ok: false, utility: null, plies: 0, reason: 'candidate_card_mismatch' };
  }
  const rootTeam = state.teams[observation.seat];
  let plies = 0;

  while (plies < limits.maxPlies && limits.nodes.value < limits.nodeBudget) {
    if (limits.deadlineMs != null && performanceNow() >= limits.deadlineMs) {
      return { ok: true, utility: cutoffUtility(state, rootTeam), plies, timedOut: true };
    }
    const winner = terminalTeam(state);
    if (winner != null || state.finishOrder.length >= 3) {
      completeFinishOrder(state);
      return {
        ok: true,
        utility: teamUpgradeUtility(state.finishOrder, state.teams, rootTeam),
        plies,
        terminal: true,
      };
    }
    if (state.currentSeat == null) {
      if (!closeTrickIfComplete(state)) {
        state.currentSeat = nextSeatWith(state, observation.seat, (seat) => state.hands[seat].length > 0);
      }
      if (state.currentSeat == null) break;
    }
    const seat = state.currentSeat;
    const play = chooseRolloutPlay(state, seat);
    limits.nodes.value += 1;
    plies += 1;
    if (!play) {
      if (!state.lastHand) {
        return { ok: false, utility: null, plies, reason: 'rollout_lead_missing_legal_play' };
      }
      state.passed.add(seat);
      if (!closeTrickIfComplete(state)) state.currentSeat = nextResponder(state, seat);
      continue;
    }
    state.hands[seat] = removeCards(state.hands[seat], play.cards);
    state.lastHand = play.hand;
    state.lastSeat = seat;
    state.passed.clear();
    if (!state.hands[seat].length) finishSeat(state, seat);
    state.currentSeat = nextResponder(state, seat);
    if (state.currentSeat == null) closeTrickIfComplete(state);
  }
  return {
    ok: true,
    utility: cutoffUtility(state, rootTeam),
    plies,
    truncated: true,
  };
}

/**
 * 以下状态机仅服务于 ISMCTS 的假想世界。它与真实牌局隔离，输入来自
 * createPublicAIObservation 和公平采样；任何节点键都不读取这份状态里的
 * 私有手牌。真实牌局的规则真源仍在 game/rules 模块。
 */
function createSimulationState(sample, observation) {
  return {
    hands: sample.hands.map((hand) => hand.map((card) => ({ ...card }))),
    teams: observation.teams.slice(),
    level: observation.level,
    finishOrder: observation.finishOrder.slice(),
    lastHand: observation.lastHand,
    lastSeat: observation.lastSeat,
    passed: historicalPasses(observation),
    currentSeat: observation.seat,
  };
}

function applySimulationAction(state, seat, action) {
  if (state.currentSeat !== seat) return false;
  if (action.action === 'pass') {
    if (!state.lastHand) return false;
    state.passed.add(seat);
    if (!closeTrickIfComplete(state)) state.currentSeat = nextResponder(state, seat);
    return true;
  }
  const cards = resolveCandidateCards(action, state.hands[seat]);
  if (!cards || !cards.length) return false;
  state.hands[seat] = removeCards(state.hands[seat], cards);
  state.lastHand = action.hand;
  state.lastSeat = seat;
  state.passed.clear();
  if (!state.hands[seat].length) finishSeat(state, seat);
  if (terminalTeam(state) != null) return true;
  state.currentSeat = nextResponder(state, seat);
  if (state.currentSeat == null) closeTrickIfComplete(state);
  return true;
}

// 一手打出的实体牌会成为公开历史，因此可安全进入开放环树的边。不要把
// 未出牌、整副隐藏手牌、采样编号或未来状态混进这个 key。
function publicActionKey(action) {
  if (action?.action === 'pass') return 'pass';
  const cards = candidateCards(action).map(physicalKey).filter(Boolean).sort();
  const declared = action?.hand ? handSignature(action.hand) : '';
  return `play:${cards.join(',')}|${declared}`;
}

function actionFromPlay(play) {
  return {
    action: 'play',
    cards: play.cards,
    hand: play.hand,
    signature: handSignature(play.hand),
  };
}

/** Pick a bounded, deterministic expert-oriented branch set for an inner node. */
function selectOpenLoopActions(state, seat, maxBranch) {
  const plays = generateLegalPlays(state.hands[seat], state.level, state.lastHand)
    .map(actionFromPlay);
  const actions = [];
  const add = (action) => {
    if (!action || actions.some((item) => publicActionKey(item) === publicActionKey(action))) return;
    actions.push(action);
  };
  // 先加入专家 rollout 的首选，使扩展与默认安全策略一致；随后只补少量
  // 低结构成本的合法分支，防止信息集树把完整候选空间展开到不可交互。
  const expert = chooseRolloutPlay(state, seat);
  if (expert) add(actionFromPlay(expert));
  if (state.lastHand) add({ action: 'pass', cards: [], hand: null, signature: null });
  const ordered = plays.slice().sort((left, right) => {
    const leftCost = rolloutStructureCost(left, state.hands[seat], state.level);
    const rightCost = rolloutStructureCost(right, state.hands[seat], state.level);
    return leftCost - rightCost
      || Number(isBomb(left.hand)) - Number(isBomb(right.hand))
      || Number(left.cards.length) - Number(right.cards.length)
      || publicActionKey(left).localeCompare(publicActionKey(right));
  });
  for (const action of ordered) {
    if (actions.length >= maxBranch) break;
    add(action);
  }
  return actions.slice(0, maxBranch);
}

function rolloutFromSimulationState(state, rootTeam, limits) {
  let plies = 0;
  while (plies < limits.maxPlies && limits.nodes.value < limits.nodeBudget) {
    if (limits.deadlineMs != null && performanceNow() >= limits.deadlineMs) {
      return { ok: true, utility: cutoffUtility(state, rootTeam), plies, timedOut: true };
    }
    const winner = terminalTeam(state);
    if (winner != null || state.finishOrder.length >= 3) {
      completeFinishOrder(state);
      return {
        ok: true,
        utility: teamUpgradeUtility(state.finishOrder, state.teams, rootTeam),
        plies,
        terminal: true,
      };
    }
    if (state.currentSeat == null) {
      if (!closeTrickIfComplete(state)) {
        state.currentSeat = nextSeatWith(state, state.lastSeat ?? 0, (candidateSeat) => (
          state.hands[candidateSeat].length > 0
        ));
      }
      if (state.currentSeat == null) break;
    }
    const seat = state.currentSeat;
    const play = chooseRolloutPlay(state, seat);
    if (!play && !state.lastHand) {
      return { ok: false, utility: null, plies, reason: 'rollout_lead_missing_legal_play' };
    }
    const action = play ? actionFromPlay(play) : { action: 'pass', cards: [], hand: null };
    limits.nodes.value += 1;
    plies += 1;
    if (!applySimulationAction(state, seat, action)) {
      return { ok: false, utility: null, plies, reason: 'rollout_action_invalid' };
    }
  }
  return {
    ok: true,
    utility: cutoffUtility(state, rootTeam),
    plies,
    truncated: true,
  };
}

function createOpenLoopNode(depth = 0) {
  return {
    depth,
    visits: 0,
    total: 0,
    actions: new Map(),
  };
}

// v3 sweeps stage deep availability/child mutations before every candidate is
// scored.  A failed or interrupted sweep must restore the whole open-loop
// subtree, not just root visits.  The snapshot is deliberately local to one
// sweep; it is bounded by the current tree and keeps limits.nodes consumed so
// a failed rollout cannot evade the search budget.
function cloneOpenLoopNode(node) {
  if (!node) return null;
  const cloneRecord = (record) => ({
    key: record.key,
    action: {
      ...record.action,
      cards: Array.isArray(record.action?.cards)
        ? record.action.cards.map((card) => ({ ...card })) : record.action?.cards,
    },
    availability: record.availability,
    visits: record.visits,
    total: record.total,
    outcomes: record.outcomes.slice(),
    failures: { ...record.failures },
    terminalCount: record.terminalCount,
    truncatedCount: record.truncatedCount,
    child: cloneOpenLoopNode(record.child),
  });
  return {
    depth: node.depth,
    visits: node.visits,
    total: node.total,
    actions: new Map([...node.actions.entries()].map(([key, record]) => [key, cloneRecord(record)])),
  };
}

function restoreOpenLoopNode(target, snapshot) {
  target.depth = snapshot.depth;
  target.visits = snapshot.visits;
  target.total = snapshot.total;
  target.actions = snapshot.actions;
}

function countOpenLoopNodes(node) {
  if (!node) return 0;
  return 1 + [...node.actions.values()].reduce(
    (total, record) => total + countOpenLoopNodes(record.child), 0,
  );
}

// Test-only/diagnostic view of the open-loop tree.  It contains only public
// action keys and mutable search statistics; callers must opt in through
// `includeTreeDigest` so normal decisions never pay for serializing it.
function digestOpenLoopNode(node) {
  if (!node) return null;
  return {
    depth: node.depth,
    visits: node.visits,
    total: node.total,
    actions: [...node.actions.values()]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((record) => ({
        key: record.key,
        availability: record.availability,
        visits: record.visits,
        total: record.total,
        outcomes: record.outcomes.slice(),
        failures: { ...record.failures },
        terminalCount: record.terminalCount,
        truncatedCount: record.truncatedCount,
        child: digestOpenLoopNode(record.child),
      })),
  };
}

function registerOpenLoopAction(node, action) {
  const key = publicActionKey(action);
  let record = node.actions.get(key);
  if (!record) {
    record = {
      key,
      action: { ...action, cards: candidateCards(action).map((card) => ({ ...card })) },
      availability: 0,
      visits: 0,
      total: 0,
      outcomes: [],
      failures: {},
      terminalCount: 0,
      truncatedCount: 0,
      child: null,
    };
    node.actions.set(key, record);
  }
  return record;
}

function selectOpenLoopRecord(node, legalActions, state, rootTeam, exploration, minimumRootVisits = 0) {
  const records = legalActions.map((action) => registerOpenLoopAction(node, action));
  for (const record of records) record.availability += 1;
  // 根动作都来自固定本家手牌，因而在每个假想世界都可用。先用不同的公平
  // determinization 覆盖最小访问数，再交给 UCT 分配剩余预算；否则早期随机
  // 波动会让某个安全候选永远没有足够证据，退化成看似树搜索的单臂赌博机。
  if (node.depth === 0 && minimumRootVisits > 0) {
    const incomplete = records.filter((record) => record.visits < minimumRootVisits);
    if (incomplete.length) {
      return incomplete.sort((left, right) => (
        left.visits - right.visits || left.key.localeCompare(right.key)
      ))[0];
    }
  }
  const unvisited = records.filter((record) => record.visits === 0);
  if (unvisited.length) return unvisited.sort((left, right) => left.key.localeCompare(right.key))[0];
  const maximize = state.teams[state.currentSeat] === rootTeam;
  return records.slice().sort((left, right) => {
    const score = (record) => {
      const mean = record.total / Math.max(1, record.visits);
      const bonus = availabilityAwareUctBonus(record.availability, record.visits, exploration);
      return maximize ? mean + bonus : mean - bonus;
    };
    const difference = score(right) - score(left);
    return maximize ? difference : -difference || left.key.localeCompare(right.key);
  })[0];
}

function runISMCTSSearch(observation, candidates, limits, options) {
  const searchMode = options.searchMode === HYBRID_SEARCH_MODES.ISMCTS_V3
    ? HYBRID_SEARCH_MODES.ISMCTS_V3 : HYBRID_SEARCH_MODES.ISMCTS;
  const root = createOpenLoopNode(0);
  const rootActionByCandidate = new Map(candidates.map((candidate) => [
    candidate.id,
    publicActionKey(candidate),
  ]));
  const treeDepth = clamp(Math.floor(Number(options.treeDepth) || 5), 1, 12);
  const branchLimit = clamp(Math.floor(Number(options.branchLimit) || 5), 2, 10);
  const minimumRootVisits = clamp(
    Math.floor(Number(options.minimumEffectiveVisits) || 3), 2, 12,
  );
  const exploration = clamp(Number(options.exploration) || 1.15, 0.1, 4);
  const seedBase = Number.isFinite(Number(options.seed)) ? Number(options.seed) : 0;
  const rootTeam = observation.teams[observation.seat];
  let iterations = 0;
  let sampledWorlds = 0;
  let pairedSweeps = 0;
  let treeNodes = 1;
  const sampleFailures = {};
  const rollbackDiagnostics = [];
  // A deterministic failure hook is intentionally available only alongside
  // the opt-in tree digest used by unit tests.  Production callers cannot
  // accidentally inject outcomes, and the normal path does not allocate or
  // inspect this hook.
  const forcedOutcomeForTest = options.includeTreeDigest === true
    && typeof options.testHooks?.forcedOutcome === 'function'
    ? options.testHooks.forcedOutcome : null;
  const budgetExhausted = () => (
    limits.nodes.value >= limits.nodeBudget
    || (limits.deadlineMs != null && performanceNow() >= limits.deadlineMs)
  );

  // 单次树内下钻：从根走到首次扩展（或终端/截断），返回路径。v2 根层由
  // availability 修正 UCT 选动作；v3 传 forcedRootAction 强制根候选并跳过
  // 根层 UCT（也不在此时累加根 availability——它只在 sweep 完整回传时与
  // visits 同步 +1，保证严格成对）。
  const descendTree = (state, forcedRootAction = null) => {
    const pathNodes = [root];
    const pathActions = [];
    let node = root;
    let depth = 0;
    let expanded = false;
    let invalidReason = null;

    while (depth < treeDepth && limits.nodes.value < limits.nodeBudget) {
      const winner = terminalTeam(state);
      if (winner != null || state.finishOrder.length >= 3) break;
      if (state.currentSeat == null) {
        if (!closeTrickIfComplete(state)) {
          state.currentSeat = nextSeatWith(state, state.lastSeat ?? observation.seat, (candidateSeat) => (
            state.hands[candidateSeat].length > 0
          ));
        }
        if (state.currentSeat == null) break;
      }
      const seat = state.currentSeat;
      const legalActions = depth === 0
        ? candidates
        : selectOpenLoopActions(state, seat, branchLimit);
      if (!legalActions.length) {
        invalidReason = 'tree_no_legal_action';
        break;
      }
      const record = depth === 0 && forcedRootAction
        ? registerOpenLoopAction(node, forcedRootAction)
        : selectOpenLoopRecord(
          node,
          legalActions,
          state,
          rootTeam,
          exploration,
          minimumRootVisits,
        );
      const chosen = legalActions.find((action) => publicActionKey(action) === record.key);
      if (!chosen || !applySimulationAction(state, seat, chosen)) {
        invalidReason = 'tree_action_invalid';
        break;
      }
      limits.nodes.value += 1;
      pathActions.push(record);
      if (!record.child) {
        record.child = createOpenLoopNode(depth + 1);
        treeNodes += 1;
        expanded = true;
      }
      node = record.child;
      pathNodes.push(node);
      depth += 1;
      if (expanded) break;
    }
    return { pathNodes, pathActions, invalidReason };
  };
  const backpropagate = ({ pathNodes, pathActions }, outcome) => {
    for (const visited of pathNodes) {
      visited.visits += 1;
      visited.total += outcome.utility;
    }
    for (const record of pathActions) {
      record.visits += 1;
      record.total += outcome.utility;
      record.outcomes.push(outcome.utility);
      record.terminalCount += Number(outcome.terminal === true);
      record.truncatedCount += Number(outcome.truncated === true || outcome.timedOut === true);
    }
  };
  const summarizeRootRecords = () => candidates.map((candidate) => {
    const record = root.actions.get(rootActionByCandidate.get(candidate.id));
    if (!record) return summarizeCandidateRollouts(candidate.id, [], {}, 0, 0, 0);
    return {
      ...summarizeCandidateRollouts(
        candidate.id,
        record.outcomes,
        record.failures,
        record.terminalCount,
        record.truncatedCount,
        record.visits,
      ),
      availability: record.availability,
    };
  });

  if (searchMode === HYBRID_SEARCH_MODES.ISMCTS_V3) {
    // v3：iterationBudget 与 v2 同口径（单次触发的 rollout 总预算），内部换算
    // 为 sweep 数（默认量级 max(4, floor(72/候选数))），总算力与 v2 相当。
    // 每次 sweep 采一个世界，同一世界按轮转顺序对每个根候选各强制下钻一次
    // （每候选重建 simulation state）。原子性：sweep 中途耗尽节点预算或截止
    // 时间，或任一候选 rollout 失败 → 整批丢弃不回传（记 partial_sweep_discarded
    // / sweep_outcome_failed），杜绝半成对状态污染根候选比较；对应成对 PIMC
    // 的 baseInterrupted 处理。
    const rolloutBudget = clamp(
      Math.floor(Number(options.iterationBudget) || Math.max(candidates.length * 6, 24)),
      Math.max(candidates.length, 2),
      2000,
    );
    const sweepBudget = clamp(
      Math.floor(rolloutBudget / Math.max(1, candidates.length)),
      1,
      2000,
    );
    let sweeps = 0;
    // 已完成下钻的累计节点消耗：用于 sweep 启动前的保守预算估计。剩余预算
    // 不足以覆盖 1.25 倍估计时不再启动新 sweep——避免把尾段预算烧在注定被
    // 原子丢弃的半成对工作上（尾延迟保护；估计本身是确定性的，不读墙钟）。
    let completedDrills = 0;
    let drillNodeCost = 0;
    while (sweeps < sweepBudget && !budgetExhausted()) {
      if (completedDrills > 0) {
        const estimatedSweepCost = Math.ceil(
          (drillNodeCost / completedDrills) * candidates.length * 1.25,
        );
        if (limits.nodes.value + estimatedSweepCost > limits.nodeBudget) break;
      }
      // 采样种子只来自公开观察和调用方公开种子，与 v2 同规则、按 sweep 计数。
      const sampled = samplePublicInformationSets(observation, {
        sampleCount: 1,
        behaviorAttempts: options.behaviorAttempts,
        seed: seedBase + sweeps * 7919,
      });
      const sweepIndex = sweeps;
      sweeps += 1;
      if (!sampled.ok || !sampled.samples[0]) {
        const reason = sampled.failure?.reason || 'sampling_failed';
        sampleFailures[reason] = (sampleFailures[reason] || 0) + 1;
        continue;
      }
      const sweepSnapshot = cloneOpenLoopNode(root);
      const completed = [];
      let interrupted = false;
      let sweepFailure = null;
      for (let offset = 0; offset < candidates.length; offset++) {
        if (budgetExhausted()) {
          interrupted = true;
          break;
        }
        const candidate = candidates[(sweepIndex + offset) % candidates.length];
        const nodesBefore = limits.nodes.value;
        const state = createSimulationState(sampled.samples[0], observation);
        const descent = descendTree(state, candidate);
        let outcome = descent.invalidReason
          ? { ok: false, utility: null, reason: descent.invalidReason }
          : rolloutFromSimulationState(state, rootTeam, limits);
        if (!descent.invalidReason && forcedOutcomeForTest) {
          let injected = null;
          try {
            injected = forcedOutcomeForTest({ sweepIndex, offset, candidateId: candidate.id });
          } catch (error) {
            injected = { ok: false, reason: `test_hook_failed:${error?.message || String(error)}` };
          }
          if (injected && injected.ok === false) {
            outcome = {
              ok: false,
              utility: null,
              reason: typeof injected.reason === 'string' && injected.reason
                ? injected.reason : 'test_forced_failure',
            };
          }
        }
        completedDrills += 1;
        drillNodeCost += Math.max(0, limits.nodes.value - nodesBefore);
        if (!outcome.ok || !Number.isFinite(outcome.utility)) {
          sweepFailure = outcome.reason || 'invalid_utility';
          const rootRecord = root.actions.get(rootActionByCandidate.get(candidate.id));
          if (rootRecord) {
            rootRecord.failures[sweepFailure] = (rootRecord.failures[sweepFailure] || 0) + 1;
          }
          break;
        }
        completed.push({ descent, outcome, candidateId: candidate.id });
      }
      if (interrupted) {
        const snapshotDigest = options.includeTreeDigest === true
          ? digestOpenLoopNode(sweepSnapshot) : null;
        const mutatedDigest = options.includeTreeDigest === true
          ? digestOpenLoopNode(root) : null;
        restoreOpenLoopNode(root, sweepSnapshot);
        treeNodes = countOpenLoopNodes(root);
        if (options.includeTreeDigest === true) rollbackDiagnostics.push({
          kind: 'interrupted', sweepIndex, snapshotDigest, mutatedDigest,
          restoredDigest: digestOpenLoopNode(root),
        });
        sampleFailures.partial_sweep_discarded = (sampleFailures.partial_sweep_discarded || 0) + 1;
        break;
      }
      if (sweepFailure) {
        const snapshotDigest = options.includeTreeDigest === true
          ? digestOpenLoopNode(sweepSnapshot) : null;
        const mutatedDigest = options.includeTreeDigest === true
          ? digestOpenLoopNode(root) : null;
        restoreOpenLoopNode(root, sweepSnapshot);
        treeNodes = countOpenLoopNodes(root);
        if (options.includeTreeDigest === true) rollbackDiagnostics.push({
          kind: 'failed', sweepIndex, snapshotDigest, mutatedDigest,
          restoredDigest: digestOpenLoopNode(root), reason: sweepFailure,
        });
        sampleFailures.sweep_outcome_failed = (sampleFailures.sweep_outcome_failed || 0) + 1;
        continue;
      }
      pairedSweeps += 1;
      sampledWorlds += 1;
      iterations += completed.length;
      for (const item of completed) {
        backpropagate(item.descent, item.outcome);
        // 根层 availability 与 visits 恒等：只在 sweep 完整回传后 +1。
        root.actions.get(rootActionByCandidate.get(item.candidateId)).availability += 1;
      }
    }
    return {
      searchMode,
      iterations,
      iterationBudget: sweepBudget,
      pairedSweeps,
      sampledWorlds,
      sampleFailures,
      treeNodes,
      ...(options.includeTreeDigest === true ? { rollbackDiagnostics } : {}),
      ...(options.includeTreeDigest === true ? { treeDigest: digestOpenLoopNode(root) } : {}),
      candidateResults: summarizeRootRecords(),
    };
  }

  // ismcts-v2（冻结，保持与既有 A/B 报告可比）：每次迭代独立采样一个世界，
  // UCT 单路径下钻，只回传路径上的记录。
  const iterationBudget = clamp(
    Math.floor(Number(options.iterationBudget) || Math.max(candidates.length * 6, 24)),
    Math.max(candidates.length, 2),
    2000,
  );
  while (iterations < iterationBudget && !budgetExhausted()) {
    // 每一次迭代独立调用公平采样器。种子只来自公开观察和调用方公开种子，
    // 用于可复现实验，不含任何真实暗牌。
    const sampled = samplePublicInformationSets(observation, {
      sampleCount: 1,
      behaviorAttempts: options.behaviorAttempts,
      seed: seedBase + iterations * 7919,
    });
    iterations += 1;
    if (!sampled.ok || !sampled.samples[0]) {
      const reason = sampled.failure?.reason || 'sampling_failed';
      sampleFailures[reason] = (sampleFailures[reason] || 0) + 1;
      continue;
    }
    sampledWorlds += 1;
    const state = createSimulationState(sampled.samples[0], observation);
    const descent = descendTree(state, null);
    const outcome = descent.invalidReason
      ? { ok: false, utility: null, reason: descent.invalidReason }
      : rolloutFromSimulationState(state, rootTeam, limits);
    if (!outcome.ok || !Number.isFinite(outcome.utility)) {
      const reason = outcome.reason || 'invalid_utility';
      for (const record of descent.pathActions) {
        record.failures[reason] = (record.failures[reason] || 0) + 1;
      }
      continue;
    }
    backpropagate(descent, outcome);
  }

  return {
    searchMode,
    iterations,
    iterationBudget,
    sampledWorlds,
    sampleFailures,
    treeNodes,
    ...(options.includeTreeDigest === true ? { rollbackDiagnostics } : {}),
    ...(options.includeTreeDigest === true ? { treeDigest: digestOpenLoopNode(root) } : {}),
    candidateResults: summarizeRootRecords(),
  };
}

function performanceNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function criticalHybridSituation(observation, searchMode = HYBRID_SEARCH_MODES.PIMC) {
  const activeCounts = observation.handCounts.filter((count, seat) => (
    count > 0 && !observation.finishOrder.includes(seat)
  ));
  const total = activeCounts.reduce((sum, count) => sum + count, 0);
  const enemies = observation.handCounts.filter((count, seat) => (
    count > 0
    && observation.teams[seat] !== observation.teams[observation.seat]
    && !observation.finishOrder.includes(seat)
  ));
  const enemyMin = enemies.length ? Math.min(...enemies) : 99;
  const partner = (observation.seat + 2) % 4;
  const baseCritical = total <= 42
      || observation.hand.length <= 10
      || enemyMin <= 7
      || (observation.handCounts[partner] > 0 && observation.handCounts[partner] <= 5);
  // 成对根 PIMC 的价值在“公开信息已足够收缩、但还来得及争牌权”的中残局。
  // 仅对显式根模式放宽一档；原 PIMC 的触发范围不变，避免把较短的
  // 基线 rollout 无证据地扩散到中盘。所有扩展分支仍受同一墙钟/节点预算。
  const extendedRootCritical = [
    HYBRID_SEARCH_MODES.PAIRED_ROOT_PIMC,
    HYBRID_SEARCH_MODES.ISMCTS,
    HYBRID_SEARCH_MODES.ISMCTS_V3,
  ].includes(searchMode)
    && (total <= 56
      || observation.hand.length <= 13
      || enemyMin <= 9
      || (observation.handCounts[partner] > 0 && observation.handCounts[partner] <= 7));
  return {
    active: baseCritical || extendedRootCritical,
    scope: baseCritical ? 'base' : extendedRootCritical ? 'root_extended' : 'none',
    total,
    enemyMin,
  };
}

function centeredAdjustments(values, cap, scale) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return values.map(() => 0);
  const mean = finite.reduce((sum, value) => sum + value, 0) / finite.length;
  return values.map((value) => Number.isFinite(value)
    ? clamp((value - mean) * scale, -cap, cap)
    : 0);
}

function candidateBaseScores(candidates, localCandidateId) {
  const playScores = candidates.map((candidate) => Number(candidate.localScore))
    .filter(Number.isFinite);
  const top = playScores.length ? Math.max(...playScores) : 0;
  // localCandidateId 是专家层经过“资源安全池、搭档礼让、硬残局”等门控后的
  // 最终选择，不一定是未经门控的 raw score 第一名。增强层必须把该结论当
  // 作基线锚点，否则会把专家明确排除的领炸/领王重新捡回来。
  const localAnchor = top + 8;
  return candidates.map((candidate) => {
    if (candidate.id === localCandidateId) return localAnchor;
    if (Number.isFinite(Number(candidate.localScore))) return Number(candidate.localScore);
    return top - 10;
  });
}

function candidateResourceUse(candidate, observation) {
  const cards = candidateCards(candidate);
  return {
    bomb: BOMB_TYPES.has(candidate?.hand?.type),
    jokers: cards.filter(isJoker).length,
    wilds: cards.filter((card) => isWild(card, observation.level)).length,
    levels: cards.filter((card) => card.rank === observation.level).length,
    finishes: candidate?.action === 'play' && cards.length === observation.hand.length,
    irreversibleTags: (candidate?.tags || []).filter((tag) => (
      IRREVERSIBLE_STRATEGY_TAGS.has(tag)
    )),
  };
}

/**
 * 专家安全筛选：混合层只在可逆、资源等级相近的候选之间重排。
 * 这不是重复打分；它阻止低样本 rollout 用“多走几张”的短视收益绕过
 * 专家层已经明确作出的不领炸、不先交王、不浪费逢人配和不拆结构门控。
 */
function hybridCandidateSafety(candidate, localCandidate, observation) {
  if (candidate.id === localCandidate.id) return { eligible: true, reason: 'expert_anchor' };
  if (candidate.action === 'pass') {
    if (localCandidate.action === 'play') {
      return { eligible: false, reason: 'no_new_pass_override' };
    }
    const enemyMin = observation.handCounts.reduce((best, count, seat) => (
      observation.teams[seat] !== observation.teams[observation.seat]
        && !observation.finishOrder.includes(seat)
        && count > 0 ? Math.min(best, count) : best
    ), 99);
    return enemyMin > 6
      ? { eligible: true, reason: 'reversible_pass' }
      : { eligible: false, reason: 'urgent_enemy_no_pass_override' };
  }
  const current = candidateResourceUse(candidate, observation);
  const local = candidateResourceUse(localCandidate, observation);
  const candidateRoute = Number(candidate.projectedTricks);
  const localRoute = Number(localCandidate.projectedTricks);
  const endgameRouteImproves = observation.hand.length <= 10
    && Number.isFinite(candidateRoute)
    && Number.isFinite(localRoute)
    && candidateRoute < localRoute;
  if (current.finishes) return { eligible: true, reason: 'finish_now' };
  if (current.bomb && !local.bomb) {
    return { eligible: false, reason: 'premium_control_escalation' };
  }
  if (current.jokers > local.jokers) {
    return { eligible: false, reason: 'extra_joker_spend' };
  }
  if (current.wilds > local.wilds) {
    return { eligible: false, reason: 'extra_wild_spend' };
  }
  if (current.levels > local.levels) {
    return { eligible: false, reason: 'extra_level_spend' };
  }
  const localTags = new Set(local.irreversibleTags);
  const newDamage = current.irreversibleTags.find((tag) => !localTags.has(tag));
  // 十张内若专家自己的路线估计确认“拆后严格少一手”，可把普通结构重组
  // 交给信息集模拟复核；炸弹、王、逢人配等不可逆资源仍由上面的硬门保护。
  if (newDamage && !endgameRouteImproves) {
    return { eligible: false, reason: `new_${newDamage}` };
  }
  const candidateScore = Number(candidate.localScore);
  const localScore = Number(localCandidate.localScore);
  if (Number.isFinite(candidateScore) && Number.isFinite(localScore)
    && candidateScore < localScore - 16 && !endgameRouteImproves) {
    return { eligible: false, reason: 'expert_score_floor' };
  }
  return { eligible: true, reason: 'safe_rerank' };
}

function summarizeCandidateRollouts(candidateId, outcomes, failures, terminalCount, truncatedCount, visits = outcomes.length) {
  const utility = outcomes.length
    ? outcomes.reduce((sum, value) => sum + value, 0) / outcomes.length : null;
  const variance = outcomes.length > 1 && Number.isFinite(utility)
    ? outcomes.reduce((sum, value) => sum + ((value - utility) ** 2), 0) / (outcomes.length - 1)
    : null;
  const standardError = Number.isFinite(variance) && outcomes.length > 0
    ? Math.sqrt(Math.max(0, variance) / outcomes.length) : null;
  return {
    candidateId,
    utility,
    completedSamples: outcomes.length,
    visits: Math.max(0, Number(visits) || 0),
    terminalCount,
    truncatedCount,
    variance,
    standardError,
    failures,
  };
}

function runPIMCSearch(observation, sampling, candidates, limits) {
  const candidateResults = candidates.map((candidate) => {
    const outcomes = [];
    const failures = {};
    let terminalCount = 0;
    let truncatedCount = 0;
    for (const sample of sampling.samples) {
      if (limits.nodes.value >= limits.nodeBudget
        || (limits.deadlineMs != null && performanceNow() >= limits.deadlineMs)) break;
      const outcome = simulateCandidate(sample, observation, candidate, limits);
      if (!outcome.ok || !Number.isFinite(outcome.utility)) {
        const reason = outcome.reason || 'invalid_utility';
        failures[reason] = (failures[reason] || 0) + 1;
        continue;
      }
      outcomes.push(outcome.utility);
      terminalCount += Number(outcome.terminal === true);
      truncatedCount += Number(outcome.truncated === true || outcome.timedOut === true);
    }
    return summarizeCandidateRollouts(
      candidate.id, outcomes, failures, terminalCount, truncatedCount, outcomes.length,
    );
  });
  return {
    searchMode: HYBRID_SEARCH_MODES.PIMC,
    iterations: candidateResults.reduce((sum, item) => sum + item.visits, 0),
    candidateResults,
  };
}

function runPairedRootPIMCSearch(observation, sampling, candidates, limits, options) {
  const stats = candidates.map((candidate) => ({
    candidateId: candidate.id,
    outcomes: [],
    failures: {},
    terminalCount: 0,
    truncatedCount: 0,
    attempts: 0,
    visits: 0,
    total: 0,
    worldAttempts: new Array(sampling.samples.length).fill(0),
    worldScored: new Array(sampling.samples.length).fill(false),
  }));
  const defaultIterations = Math.max(candidates.length * 2, sampling.samples.length * candidates.length);
  const iterationBudget = clamp(
    Math.floor(Number(options.iterationBudget) || defaultIterations),
    candidates.length,
    2000,
  );
  let iterations = 0;
  let pairedWorlds = 0;
  const canContinue = () => (
    iterations < iterationBudget
    && limits.nodes.value < limits.nodeBudget
    && (limits.deadlineMs == null || performanceNow() < limits.deadlineMs)
  );
  const runAttempt = (candidateIndex, worldIndex) => {
    const item = stats[candidateIndex];
    item.attempts += 1;
    item.worldAttempts[worldIndex] += 1;
    iterations += 1;
    // 每个候选在每个假想世界最多 rollout 一次；不把重复世界伪装成独立样本。
    if (item.worldScored[worldIndex]) return;
    const outcome = simulateCandidate(
      sampling.samples[worldIndex],
      observation,
      candidates[candidateIndex],
      limits,
    );
    if (!outcome.ok || !Number.isFinite(outcome.utility)) {
      const reason = outcome.reason || 'invalid_utility';
      item.failures[reason] = (item.failures[reason] || 0) + 1;
      return;
    }
    item.worldScored[worldIndex] = true;
    item.visits += 1;
    item.total += outcome.utility;
    item.outcomes.push(outcome.utility);
    item.terminalCount += Number(outcome.terminal === true);
    item.truncatedCount += Number(outcome.truncated === true || outcome.timedOut === true);
  };

  // 基础覆盖必须以“世界”为外层：同一个假想牌面依次评估所有候选，
  // 且每个世界轮换首个候选。这样候选差异不会被未知牌面难度混淆。
  const baseWorldBudget = Math.min(
    sampling.samples.length,
    Math.floor(iterationBudget / Math.max(1, candidates.length)),
  );
  let baseInterrupted = false;
  for (let worldIndex = 0; worldIndex < baseWorldBudget; worldIndex++) {
    let attemptedInWorld = 0;
    for (let offset = 0; offset < candidates.length; offset++) {
      if (!canContinue()) {
        baseInterrupted = true;
        break;
      }
      const candidateIndex = (worldIndex + offset) % candidates.length;
      runAttempt(candidateIndex, worldIndex);
      attemptedInWorld += 1;
    }
    if (attemptedInWorld === candidates.length) pairedWorlds += 1;
    if (baseInterrupted) break;
  }

  const candidateResults = stats.map((item) => summarizeCandidateRollouts(
    item.candidateId,
    item.outcomes,
    item.failures,
    item.terminalCount,
    item.truncatedCount,
    item.visits,
  )).map((summary, index) => ({
    ...summary,
    attempts: stats[index].attempts,
    worldAttempts: stats[index].worldAttempts.slice(),
  }));
  return {
    searchMode: HYBRID_SEARCH_MODES.PAIRED_ROOT_PIMC,
    iterations,
    iterationBudget,
    pairedWorlds,
    candidateResults,
  };
}

export function evaluateInformationSetCandidates(ctx, candidates, options = {}) {
  const observation = createPublicAIObservation(ctx);
  const searchMode = normalizeSearchMode(options.searchMode);
  const critical = criticalHybridSituation(observation, searchMode);
  if (!critical.active) {
    return {
      applied: false,
      reason: 'not_critical',
      searchMode,
      searchAttempted: false,
      searchTriggered: false,
      observation,
      candidateResults: [],
    };
  }
  const sampling = samplePublicInformationSets(observation, {
    // ISMCTS 在迭代内部逐次重采样；这里仅作一次公开信息可采样预检。
    sampleCount: [HYBRID_SEARCH_MODES.ISMCTS, HYBRID_SEARCH_MODES.ISMCTS_V3].includes(searchMode)
      ? 1 : options.sampleCount,
    behaviorAttempts: options.behaviorAttempts,
    seed: options.seed,
  });
  if (!sampling.ok) {
    return {
      applied: false,
      reason: sampling.failure?.reason || 'sampling_failed',
      searchMode,
      searchAttempted: true,
      searchTriggered: false,
      observation,
      sampling,
      candidateResults: [],
    };
  }
  const nodes = { value: 0 };
  const limits = {
    maxPlies: clamp(Math.floor(Number(options.maxPlies) || 96), 16, 180),
    nodeBudget: clamp(Math.floor(Number(options.nodeBudget) || 2400), 100, 12000),
    // Number(null) 为 0；若把“无墙钟限制”的 null 当作 0，循环会在第一步前
    // 立即判定超时。只有调用方明确提供有限数值时才启用截止时间。
    deadlineMs: options.deadlineMs != null && Number.isFinite(Number(options.deadlineMs))
      ? Number(options.deadlineMs) : null,
    nodes,
  };
  const search = searchMode === HYBRID_SEARCH_MODES.PAIRED_ROOT_PIMC
    ? runPairedRootPIMCSearch(observation, sampling, candidates, limits, options)
    : [HYBRID_SEARCH_MODES.ISMCTS, HYBRID_SEARCH_MODES.ISMCTS_V3].includes(searchMode)
      ? runISMCTSSearch(observation, candidates, limits, { ...options, searchMode })
      : runPIMCSearch(observation, sampling, candidates, limits);
  const { candidateResults } = search;
  const completeCandidates = candidateResults.filter((item) => item.completedSamples > 0).length;
  const rootMinimumEffectiveVisits = clamp(
    Math.floor(Number(options.minimumEffectiveVisits) || 3), 2, 12,
  );
  // 根搜索至少要有两个完整成对的假想世界。sampleCount=1 时
  // 不可靠在同一世界重复 rollout 伪造信心。
  const requiredPairedWorlds = Math.max(
    2, Math.min(rootMinimumEffectiveVisits, sampling.samples.length),
  );
  // v3 的成对单位是 sweep：每次 sweep 覆盖全部根候选，要求至少完成
  // requiredPairedSweeps 次（与成对 PIMC 的 requiredPairedWorlds 同构）。
  const requiredPairedSweeps = Math.max(
    2, Math.min(rootMinimumEffectiveVisits, Number(search.iterationBudget) || 0),
  );
  const rootEvidenceSufficient = searchMode === HYBRID_SEARCH_MODES.PAIRED_ROOT_PIMC
    ? candidateResults.every((item) => item.visits >= rootMinimumEffectiveVisits)
      && Number(search.pairedWorlds) >= requiredPairedWorlds
    : searchMode === HYBRID_SEARCH_MODES.ISMCTS
      ? candidateResults.every((item) => (
        item.visits >= rootMinimumEffectiveVisits
        && Number(item.availability) >= rootMinimumEffectiveVisits
      )) && Number(search.sampledWorlds) >= candidates.length * rootMinimumEffectiveVisits
      : searchMode === HYBRID_SEARCH_MODES.ISMCTS_V3
        ? candidateResults.every((item) => item.visits >= rootMinimumEffectiveVisits)
          && Number(search.pairedSweeps) >= requiredPairedSweeps
        : true;
  const completed = completeCandidates === candidates.length;
  return {
    applied: completed && candidates.length > 1 && rootEvidenceSufficient,
    reason: !completed ? 'budget_exhausted'
      : rootEvidenceSufficient ? 'completed' : 'insufficient_search_evidence',
    searchMode: search.searchMode,
    searchAttempted: true,
    searchTriggered: Number(search.iterations) > 0 || nodes.value > 0,
    iterations: search.iterations,
    iterationBudget: search.iterationBudget || null,
    pairedWorlds: search.pairedWorlds || 0,
    pairedSweeps: search.pairedSweeps || 0,
    sampledWorlds: search.sampledWorlds || 0,
    sampleFailures: search.sampleFailures || {},
    treeNodes: search.treeNodes || 0,
    rollbackDiagnostics: search.rollbackDiagnostics || [],
    treeDigest: search.treeDigest || null,
    minimumEffectiveVisits: [HYBRID_SEARCH_MODES.PAIRED_ROOT_PIMC, HYBRID_SEARCH_MODES.ISMCTS, HYBRID_SEARCH_MODES.ISMCTS_V3].includes(searchMode)
      ? rootMinimumEffectiveVisits : null,
    requiredPairedWorlds: searchMode === HYBRID_SEARCH_MODES.PAIRED_ROOT_PIMC
      ? requiredPairedWorlds : null,
    requiredPairedSweeps: searchMode === HYBRID_SEARCH_MODES.ISMCTS_V3
      ? requiredPairedSweeps : null,
    observation,
    sampling,
    critical,
    candidateResults,
    nodes: nodes.value,
  };
}

function rootRerankConfidence(informationSet, proposedCandidateId, localCandidateId, options = {}) {
  if (![HYBRID_SEARCH_MODES.PAIRED_ROOT_PIMC, HYBRID_SEARCH_MODES.ISMCTS, HYBRID_SEARCH_MODES.ISMCTS_V3]
    .includes(informationSet?.searchMode)) {
    return { required: false, allowed: true, reason: 'not_root_search' };
  }
  if (proposedCandidateId === localCandidateId) {
    return { required: true, allowed: true, reason: 'expert_anchor_retained' };
  }
  const minimumEffectiveVisits = Number(informationSet.minimumEffectiveVisits) || 3;
  const proposed = (informationSet.candidateResults || []).find(
    (item) => item.candidateId === proposedCandidateId,
  );
  const local = (informationSet.candidateResults || []).find(
    (item) => item.candidateId === localCandidateId,
  );
  if (!informationSet.applied || !proposed || !local
    || proposed.visits < minimumEffectiveVisits || local.visits < minimumEffectiveVisits) {
    return {
      required: true,
      allowed: false,
      reason: 'insufficient_effective_visits',
      minimumEffectiveVisits,
      proposedVisits: proposed?.visits || 0,
      localVisits: local?.visits || 0,
    };
  }
  const proposedError = proposed.standardError;
  const localError = local.standardError;
  if (!Number.isFinite(proposed.utility) || !Number.isFinite(local.utility)
    || !Number.isFinite(proposedError) || !Number.isFinite(localError)) {
    return {
      required: true,
      allowed: false,
      reason: 'uncertainty_unavailable',
      minimumEffectiveVisits,
    };
  }
  const confidenceZ = clamp(
    Number.isFinite(Number(options.confidenceZ)) ? Number(options.confidenceZ) : 1,
    0.25,
    3,
  );
  const minimumUtilityGap = clamp(
    Number.isFinite(Number(options.minimumUtilityGap)) ? Number(options.minimumUtilityGap) : 0.05,
    0,
    1,
  );
  const proposedLowerBound = proposed.utility - confidenceZ * proposedError;
  const localUpperBound = local.utility + confidenceZ * localError;
  const confidenceGap = proposedLowerBound - localUpperBound;
  const allowed = confidenceGap >= minimumUtilityGap;
  return {
    required: true,
    allowed,
    reason: allowed
      ? [HYBRID_SEARCH_MODES.ISMCTS, HYBRID_SEARCH_MODES.ISMCTS_V3]
        .includes(informationSet.searchMode)
        ? 'ismcts_confidence_margin_met' : 'confidence_margin_met'
      : 'confidence_margin_insufficient',
    minimumEffectiveVisits,
    confidenceZ,
    minimumUtilityGap,
    proposedVisits: proposed.visits,
    localVisits: local.visits,
    proposedUtility: proposed.utility,
    localUtility: local.utility,
    proposedStandardError: proposedError,
    localStandardError: localError,
    proposedLowerBound,
    localUpperBound,
    confidenceGap,
  };
}

// 盲评场景用的紧凑选项描述：只含渲染一手候选所需的公开字段。
function compactScenarioOption(candidate) {
  if (!candidate) return null;
  return {
    id: candidate.id,
    action: candidate.action === 'pass' ? 'pass' : 'play',
    cards: candidateCards(candidate).map((card) => ({
      rank: Number(card.rank),
      suit: String(card.suit || ''),
      deckIndex: card.deckIndex != null && Number.isFinite(Number(card.deckIndex))
        ? Number(card.deckIndex) : null,
    })),
    signature: candidate.signature || (candidate.hand ? handSignature(candidate.hand) : null),
  };
}

function decisionFromCandidate(candidate, observation) {
  if (!candidate || candidate.action === 'pass') return { action: 'pass' };
  const cards = resolveCandidateCards(candidate, observation.hand);
  if (!cards) return null;
  // 云端/混合候选为控制体积只携带紧凑 hand，但 signature 保留了逢人配、
  // 顺子和同花顺的完整声明。执行前必须用本家实体牌重建完整牌型，不能把
  // 缺少 meta.sequence / meta.suit 的紧凑对象直接写进正式牌局状态。
  const variants = parseHandVariants(cards, observation.level);
  const declared = variants.find((hand) => handSignature(hand) === candidate.signature);
  if (!declared) return null;
  return {
    action: 'play',
    cards,
    hand: declared,
    signature: handSignature(declared),
    projectedTricks: candidate.projectedTricks ?? null,
  };
}

// An ablation must execute the exact expert decision object, not reconstruct a
// semantically similar candidate.  Reconstruction is necessary for compact
// remote candidates, but it can change a wildcard declaration or card object
// representation and would invalidate a force-expert control arm.
function decisionFromConsultation(consultation) {
  if (!consultation || !consultation.action) return null;
  if (consultation.action === 'pass') {
    return {
      action: 'pass',
      projectedTricks: consultation.projectedTricks ?? null,
    };
  }
  if (!consultation.cards || !consultation.hand) return null;
  return {
    action: 'play',
    cards: consultation.cards,
    hand: consultation.hand,
    signature: consultation.signature || handSignature(consultation.hand),
    projectedTricks: consultation.projectedTricks ?? null,
  };
}

/**
 * 在专家层已经给出的安全候选中进行混合重排。任何错误、预算耗尽、模型缺失或
 * 采样不一致都返回原专家动作，保证这是增强层而不是新的单点故障。
 */
export function chooseHybridFromConsultation(ctx, consultation, options = {}) {
  const observation = createPublicAIObservation(ctx);
  const localCandidate = (consultation?.candidates || []).find(
    (candidate) => candidate.id === consultation?.localCandidateId,
  );
  const fallback = (reason, extra = {}) => ({
    decision: consultation?.action ? {
      action: consultation.action,
      ...(consultation.cards ? {
        cards: consultation.cards,
        hand: consultation.hand,
        signature: consultation.signature || handSignature(consultation.hand),
      } : {}),
      reason: consultation.reason || '专家策略回退',
      projectedTricks: consultation.projectedTricks ?? null,
      hybrid: {
        version: HYBRID_ENGINE_VERSION,
        applied: false,
        reason,
        searchMode: normalizeSearchMode(options.searchMode),
        searchAttempted: false,
        searchTriggered: false,
        fallbackKind: 'expert_safety_fallback',
        iterations: 0,
        localCandidateId: consultation?.localCandidateId || null,
        finalCandidateId: consultation?.localCandidateId || null,
        changedDecision: false,
        model: getHybridValueModelStatus(),
        ...extra,
      },
    } : null,
    telemetry: {
      applied: false,
      reason,
      searchAttempted: false,
      searchTriggered: false,
      fallbackKind: 'expert_safety_fallback',
      ...extra,
    },
  });

  if (!consultation || !localCandidate) return fallback('missing_local_candidate');
  const allCandidates = consultation.candidates || [];
  // 专家最终选择优先进入池，再补入原排序靠前候选。本地模拟不受云端最多
  // 3 个候选的传输限制，但仍限制为 6 个，控制浏览器端时间与组合爆炸。
  const consideredCandidates = [
    localCandidate,
    ...allCandidates.filter((candidate) => candidate.id !== localCandidate.id),
  ];
  const safety = consideredCandidates.map((candidate) => ({
    candidate,
    ...hybridCandidateSafety(candidate, localCandidate, observation),
  }));
  const candidateLimit = clamp(Math.floor(Number(options.candidateLimit) || 6), 2, 8);
  const candidates = safety.filter((item) => item.eligible)
    .map((item) => item.candidate)
    .slice(0, candidateLimit);
  const rejected = safety.filter((item) => !item.eligible);
  const rejectedCandidates = rejected.slice(0, 64).map((item) => ({
    id: item.candidate.id,
    reason: item.reason,
  }));
  const rejectionSummary = rejected.reduce((summary, item) => {
    summary[item.reason] = (summary[item.reason] || 0) + 1;
    return summary;
  }, {});
  if (candidates.length < 2 || consultation.cloudConstraint !== 'soft_rerank') {
    return fallback('hard_constraint_or_single_candidate', {
      rejectedCandidates,
      rejectedCandidateCount: rejected.length,
      rejectionSummary,
    });
  }

  const baseScores = candidateBaseScores(candidates, consultation.localCandidateId);
  const informationSet = evaluateInformationSetCandidates(observation, candidates, {
    sampleCount: options.sampleCount,
    behaviorAttempts: options.behaviorAttempts,
    maxPlies: options.maxPlies,
    nodeBudget: options.nodeBudget,
    iterationBudget: options.iterationBudget,
    minimumEffectiveVisits: options.minimumEffectiveVisits,
    searchMode: options.searchMode,
    deadlineMs: options.deadlineMs,
    seed: options.seed,
  });
  // 模型不是独立于搜索的全局启发式。只有当前关键局面的信息集搜索已获得
  // 足够公平证据时才允许参与；not_critical、采样失败或根置信不足均原样
  // 回退专家，保证网页“仅在关键局面启用”的说明与真实行为一致。
  const model = informationSet.applied ? (options.valueModel || activeValueModel) : null;
  const rawModelValues = candidates.map((candidate) => (
    model ? evaluateHybridValueModel(model, extractHybridValueFeatures(observation, candidate)) : null
  ));
  const modelAdjustments = centeredAdjustments(rawModelValues, 18, 12);
  const utilityById = new Map(
    (informationSet.candidateResults || []).map((item) => [item.candidateId, item.utility]),
  );
  const rolloutResultById = new Map(
    (informationSet.candidateResults || []).map((item) => [item.candidateId, item]),
  );
  const rawUtilities = candidates.map((candidate) => utilityById.get(candidate.id));
  const rolloutAdjustments = informationSet.applied
    ? centeredAdjustments(rawUtilities, 24, 12)
    : candidates.map(() => 0);
  const modelApplied = rawModelValues.some(Number.isFinite);
  if (!informationSet.applied && !modelApplied) {
    return fallback(informationSet.reason || 'no_enhancement_evidence', {
      samples: informationSet.sampling?.sampleCount || 0,
      nodes: informationSet.nodes || 0,
      searchAttempted: informationSet.searchAttempted === true,
      searchTriggered: informationSet.searchTriggered === true,
      fallbackKind: 'search_evidence_insufficient',
    });
  }

  const scores = candidates.map((candidate, index) => ({
    candidate,
    baseScore: baseScores[index],
    modelValue: rawModelValues[index],
    modelAdjustment: modelAdjustments[index],
    rolloutUtility: rawUtilities[index] ?? null,
    rolloutAdjustment: rolloutAdjustments[index],
    rolloutResult: rolloutResultById.get(candidate.id) || null,
    finalScore: baseScores[index] + modelAdjustments[index] + rolloutAdjustments[index],
    local: candidate.id === consultation.localCandidateId,
  })).sort((left, right) => (
    right.finalScore - left.finalScore
    || Number(right.local) - Number(left.local)
    || String(left.candidate.id).localeCompare(String(right.candidate.id))
  ));

  const proposed = scores[0];
  const rerankGate = rootRerankConfidence(
    informationSet,
    proposed.candidate.id,
    consultation.localCandidateId,
    options,
  );
  // 消融臂（-fxe 评测变体）：搜索与门禁照常执行并写入遥测，但最终选择强制
  // 保持专家首选；同一确定性种子下与正常臂的配对差值即“改选”的净贡献。
  const forceExpert = options.forceExpertChoice === true;
  const wouldChange = rerankGate.allowed
    && proposed.candidate.id !== consultation.localCandidateId;
  let selected = proposed;
  if (forceExpert || !rerankGate.allowed) {
    selected = scores.find((item) => item.candidate.id === consultation.localCandidateId) || proposed;
  }
  const decision = forceExpert
    ? decisionFromConsultation(consultation)
    : decisionFromCandidate(selected.candidate, observation);
  if (!decision) {
    return fallback('selected_candidate_invalid', {
      samples: informationSet.sampling?.sampleCount || 0,
      nodes: informationSet.nodes || 0,
      searchAttempted: informationSet.searchAttempted === true,
      searchTriggered: informationSet.searchTriggered === true,
      fallbackKind: 'selected_candidate_invalid',
    });
  }
  const changed = selected.candidate.id !== consultation.localCandidateId;
  decision.reason = forceExpert && wouldChange
    ? '搜索提议改选，消融臂强制保持专家首选'
    : !rerankGate.allowed
    ? '信息集搜索证据不足，保持专家首选'
    : changed
    ? `混合决策：专家安全候选经${model ? '专用价值模型与' : ''}公平信息集模拟后改选`
    : `混合决策：信息集模拟认可专家首选`;
  decision.hybrid = {
    version: HYBRID_ENGINE_VERSION,
    applied: informationSet.applied || modelApplied,
    reason: !rerankGate.allowed ? rerankGate.reason : informationSet.reason,
    localCandidateId: consultation.localCandidateId,
    proposedCandidateId: proposed.candidate.id,
    finalCandidateId: selected.candidate.id,
    changedDecision: changed,
    forceExpertChoice: forceExpert,
    wouldChangeDecision: wouldChange,
    // 改选分歧载荷（仅 when wouldChange）：专家首选与搜索提议的完整选项描述，
    // 供 --hybrid-scenario-log 生成真人盲评题目；正常决策不携带，遥测体积不变。
    divergence: wouldChange ? {
      expert: compactScenarioOption(
        scores.find((item) => item.candidate.id === consultation.localCandidateId)?.candidate
          || localCandidate,
      ),
      proposed: compactScenarioOption(proposed.candidate),
    } : null,
    searchMode: informationSet.searchMode || HYBRID_SEARCH_MODES.PIMC,
    iterations: informationSet.iterations || 0,
    iterationBudget: informationSet.iterationBudget || null,
    pairedWorlds: informationSet.pairedWorlds || 0,
    pairedSweeps: informationSet.pairedSweeps || 0,
    sampledWorlds: informationSet.sampledWorlds || 0,
    treeNodes: informationSet.treeNodes || 0,
    sampleFailures: informationSet.sampleFailures || {},
    minimumEffectiveVisits: informationSet.minimumEffectiveVisits || null,
    requiredPairedWorlds: informationSet.requiredPairedWorlds || null,
    requiredPairedSweeps: informationSet.requiredPairedSweeps || null,
    rerankGate,
    samples: informationSet.sampling?.sampleCount || 0,
    nodes: informationSet.nodes || 0,
    searchAttempted: informationSet.searchAttempted === true,
    searchTriggered: informationSet.searchTriggered === true,
    fallbackKind: forceExpert
      ? 'force_expert_choice'
      : !informationSet.applied ? 'search_evidence_insufficient' : null,
    model: model
      ? { configured: true, modelId: model.id || 'inline-model', schema: model.schema }
      : getHybridValueModelStatus(),
    candidates: scores.map((item) => ({
      id: item.candidate.id,
      baseScore: Math.round(item.baseScore * 10) / 10,
      modelValue: Number.isFinite(item.modelValue)
        ? Math.round(item.modelValue * 1000) / 1000 : null,
      rolloutUtility: Number.isFinite(item.rolloutUtility)
        ? Math.round(item.rolloutUtility * 1000) / 1000 : null,
      completedSamples: item.rolloutResult?.completedSamples || 0,
      attempts: item.rolloutResult?.attempts || 0,
      visits: item.rolloutResult?.visits || 0,
      availability: item.rolloutResult?.availability || null,
      standardError: Number.isFinite(item.rolloutResult?.standardError)
        ? Math.round(item.rolloutResult.standardError * 1000) / 1000 : null,
      failures: item.rolloutResult?.failures || {},
      finalScore: Math.round(item.finalScore * 10) / 10,
    })),
    rejectedCandidates,
    rejectedCandidateCount: rejected.length,
    rejectionSummary,
  };
  return { decision, telemetry: decision.hybrid };
}
