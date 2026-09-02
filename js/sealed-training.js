/**
 * RT-5 sealed training capture and conversion.
 *
 * Public live events never carry these objects. The converter replays each
 * turn from the acting seat's hand and public observation, then splits
 * complete matches. Batches stay trainingEligible=false until a later
 * manual approval step that this module does not perform.
 */
import { sha256Hex } from './model-fingerprint.js';
import {
  createPublicAIObservation,
} from './ai-observation.js';
import {
  generateLegalPlays,
  isLegalPlay,
  handSignature,
  describeUpgrade,
} from './rules.js';
import {
  createSealedTrainingTurn,
  validateSealedTrainingTurn,
  REPLAY_RULE_VERSION,
} from './replay-contracts.js';

export const SEALED_TRAINING_BATCH_SCHEMA = 'guandan-sealed-training-batch-v1';
export const SEALED_TRAINING_MANIFEST_SCHEMA = 'guandan-sealed-training-manifest-v1';
export const PASS_CANDIDATE_ID = 'pass';
export const SEALED_SPLITS = Object.freeze(['train', 'validation', 'held-out']);
export const SEALED_TEAM_OF = Object.freeze([0, 1, 0, 1]);
export const SEALED_STATE_KEYS = Object.freeze([
  'sealedTrainingTurns',
  'sealedTrainingBatch',
  'sealedTrainingHistory',
  'sealedTrainingFailures',
  'sealedTrainingLastError',
  'sealedPreviousTurnSha256',
  'sealedSequence',
]);

const SHA256 = /^[a-f0-9]{64}$/;
const FORBIDDEN_LABEL_KEYS = new Set([
  'reward', 'outcome', 'trainingLabel', 'counterfactual', 'advantage',
]);
const BATCH_KEYS = new Set([
  'schema', 'matchId', 'round', 'createdAt', 'ruleVersion',
  'implementationSha256', 'publicImplementationSha256',
  'sourceHeadEventSha256', 'sourceTailEventSha256',
  'finishOrder', 'winTeam', 'upgrade', 'upgradeCode', 'teamUtilities',
  'turns', 'trainingEligible', 'split',
]);

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  return value;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(',')}}`;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('摘要内容不得包含非有限数');
  return JSON.stringify(value);
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

function cardIdentity(card) {
  if (!isRecord(card)) return 'invalid';
  if (card.id != null) return `id:${card.id}`;
  const deckIndex = Number.isSafeInteger(Number(card.deckIndex)) ? Number(card.deckIndex) : 0;
  return `p:${card.rank}:${card.suit}:${deckIndex}`;
}

export function playCandidateId(cards, hand) {
  const physical = (Array.isArray(cards) ? cards : []).map(cardIdentity).sort().join(',');
  return `play:${sha256Hex(`${physical}::${handSignature(hand)}`).slice(0, 32)}`;
}

function assertNoLabelKeys(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoLabelKeys(item, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_LABEL_KEYS.has(key)) {
      throw new TypeError(`${path}.${key} 不得作为反事实或训练标签出现`);
    }
    assertNoLabelKeys(item, `${path}.${key}`);
  }
}

function pickPhysicalCards(hand, publicCards) {
  const remaining = Array.isArray(hand) ? hand.slice() : [];
  const picked = [];
  for (const card of publicCards || []) {
    const index = remaining.findIndex((item) => (
      Number(item.rank) === Number(card.rank) && String(item.suit || '') === String(card.suit || '')
    ));
    if (index < 0) return null;
    picked.push(remaining.splice(index, 1)[0]);
  }
  return picked;
}

function sameHandMultiset(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const counts = new Map();
  for (const card of left) {
    const key = cardIdentity(card);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const card of right) {
    const key = cardIdentity(card);
    const next = (counts.get(key) || 0) - 1;
    if (next < 0) return false;
    counts.set(key, next);
  }
  return [...counts.values()].every((count) => count === 0);
}

export function listLegalTrainingCandidates({
  actingHand, level, lastHand, action, cards, playedHand,
} = {}) {
  if (!Array.isArray(actingHand) || !actingHand.length) {
    throw new TypeError('行动座位手牌不能为空');
  }
  const plays = generateLegalPlays(actingHand, level, lastHand || null);
  const candidates = [];
  const seen = new Set();
  const addPlay = (playCards, playHand) => {
    const candidateId = playCandidateId(playCards, playHand);
    if (seen.has(candidateId)) return;
    seen.add(candidateId);
    candidates.push({
      candidateId,
      cards: playCards,
      hand: playHand,
    });
  };
  for (const play of plays) addPlay(play.cards, play.hand);
  if (lastHand) {
    candidates.push({ candidateId: PASS_CANDIDATE_ID, cards: [], hand: null });
  }
  if (action === 'pass') {
    if (!lastHand) throw new TypeError('领出不得过牌');
    return { candidates, chosenCandidateId: PASS_CANDIDATE_ID };
  }
  if (action !== 'play') throw new TypeError('密封动作必须是 play 或 pass');
  const legal = isLegalPlay(cards, level, lastHand || null, playedHand || null);
  if (!legal.ok) throw new TypeError(`实际动作不合法：${legal.reason || '无法核验'}`);
  const chosenHand = playedHand || legal.hand;
  const chosenId = playCandidateId(cards, chosenHand);
  if (!seen.has(chosenId)) addPlay(cards, chosenHand);
  return { candidates, chosenCandidateId: chosenId };
}

export function snapshotSealedAction(input = {}) {
  const seat = integerValue(Number(input.seat), 'seat', { min: 0, max: 3 });
  const actingHand = Array.isArray(input.actingHand) ? input.actingHand.slice() : [];
  const { candidates, chosenCandidateId } = listLegalTrainingCandidates({
    actingHand,
    level: input.level,
    lastHand: input.lastHand || null,
    action: input.action,
    cards: input.cards || [],
    playedHand: input.playedHand || null,
  });
  const observation = input.observation && isRecord(input.observation)
    ? input.observation
    : createPublicAIObservation({
      seat,
      hand: actingHand,
      level: input.level,
      lastHand: input.lastHand || null,
      lastSeat: input.lastSeat,
      handCounts: input.handCounts,
      finishOrder: input.finishOrder,
    });
  return {
    seat,
    action: input.action,
    actingHand,
    observation,
    candidates,
    chosenCandidateId,
    turn: input.turn || null,
  };
}

function recordSealedFailure(state, error) {
  if (!state) return null;
  state.sealedTrainingFailures = (Number(state.sealedTrainingFailures) || 0) + 1;
  state.sealedTrainingLastError = String(error?.message || error || '密封训练捕获失败').slice(0, 240);
  return null;
}

export function appendSealedTrainingTurn(state, publicEvent, snapshot) {
  try {
    if (!state || !snapshot) throw new TypeError('密封 turn 缺少状态或快照');
    if (!isRecord(publicEvent) || publicEvent.eventType !== snapshot.action) {
      throw new TypeError('密封 turn 必须绑定同动作公开事件');
    }
    if (publicEvent.seat !== snapshot.seat) {
      throw new TypeError('密封 turn 座位必须与公开事件一致');
    }
    const sequence = Number.isSafeInteger(state.sealedSequence) ? state.sealedSequence : 0;
    const turn = createSealedTrainingTurn({
      matchId: publicEvent.matchId,
      round: publicEvent.round,
      trick: publicEvent.trick,
      turn: integerValue(Number(snapshot.turn || publicEvent.turn), 'turn', { min: 1 }),
      eventId: `${publicEvent.matchId}:sealed:${sequence}`,
      sequence,
      occurredAt: publicEvent.occurredAt,
      ruleVersion: publicEvent.ruleVersion || REPLAY_RULE_VERSION,
      implementationSha256: SEALED_TRAINING_IMPLEMENTATION_SHA256,
      previousEventSha256: state.sealedPreviousTurnSha256 || null,
      sourceEventId: publicEvent.eventId,
      seat: snapshot.seat,
      hand: snapshot.actingHand,
      publicObservation: snapshot.observation,
      legalCandidates: snapshot.candidates,
      chosenCandidateId: snapshot.chosenCandidateId,
      trainingEligible: false,
    });
    if (!Array.isArray(state.sealedTrainingTurns)) state.sealedTrainingTurns = [];
    state.sealedTrainingTurns.push(turn);
    state.sealedSequence = sequence + 1;
    state.sealedPreviousTurnSha256 = turn.eventSha256;
    return turn;
  } catch (error) {
    return recordSealedFailure(state, error);
  }
}

export function teamUtilitiesFromFinishOrder(finishOrder, teamOf = (seat) => SEALED_TEAM_OF[seat]) {
  if (!Array.isArray(finishOrder) || finishOrder.length !== 4) {
    throw new TypeError('名次必须是四个座位');
  }
  const upgrade = describeUpgrade(finishOrder, teamOf);
  const winTeam = teamOf(finishOrder[0]);
  const teamUtilities = winTeam === 0
    ? [upgrade.levels, -upgrade.levels]
    : [-upgrade.levels, upgrade.levels];
  return {
    winTeam,
    upgrade: upgrade.levels,
    upgradeCode: upgrade.code,
    teamUtilities,
  };
}

export function createSealedTrainingBatch(input) {
  if (!isRecord(input)) throw new TypeError('密封批次必须是对象');
  assertNoLabelKeys(input);
  const unknown = Object.keys(input).filter((key) => !BATCH_KEYS.has(key) && input[key] !== undefined);
  if (unknown.length) throw new TypeError(`密封批次含未知字段：${unknown.join(',')}`);
  const turnsInput = Array.isArray(input.turns) ? input.turns : [];
  if (!turnsInput.length) throw new TypeError('密封批次不能没有行动 turn');
  const turns = turnsInput.map((turn) => createSealedTrainingTurn({
    ...turn,
    eventSha256: undefined,
    trainingEligible: false,
  }));
  const matchId = stringValue(input.matchId, 'matchId', { max: 120 });
  const round = integerValue(input.round, 'round', { min: 1 });
  for (const [index, turn] of turns.entries()) {
    if (turn.matchId !== matchId) throw new TypeError(`turns[${index}] matchId 串线`);
    if (turn.round !== round) throw new TypeError(`turns[${index}] round 不一致`);
    if (turn.sequence !== index) throw new TypeError(`turns[${index}] sequence 必须从 0 连续`);
    if (index === 0) {
      if (turn.previousEventSha256 != null) throw new TypeError('首个密封 turn 不得有前序摘要');
    } else if (turn.previousEventSha256 !== turns[index - 1].eventSha256) {
      throw new TypeError(`turns[${index}] 前序摘要不匹配`);
    }
    if (turn.trainingEligible !== false) throw new TypeError('密封 turn 必须保持 trainingEligible=false');
  }
  const finishOrder = (Array.isArray(input.finishOrder) ? input.finishOrder : [])
    .map((seat, index) => integerValue(Number(seat), `finishOrder[${index}]`, { min: 0, max: 3 }));
  if (finishOrder.length !== 4 || new Set(finishOrder).size !== 4) {
    throw new TypeError('finishOrder 必须是四个不重复座位');
  }
  const expected = teamUtilitiesFromFinishOrder(finishOrder);
  if (input.winTeam != null && Number(input.winTeam) !== expected.winTeam) {
    throw new TypeError('winTeam 与名次不一致');
  }
  if (input.upgrade != null && Number(input.upgrade) !== expected.upgrade) {
    throw new TypeError('upgrade 与名次不一致');
  }
  const teamUtilities = Array.isArray(input.teamUtilities)
    ? input.teamUtilities.map((value, index) => {
      if (!Number.isSafeInteger(value)) throw new TypeError(`teamUtilities[${index}] 必须是整数`);
      return value;
    })
    : expected.teamUtilities;
  if (teamUtilities.length !== 2
    || teamUtilities[0] !== expected.teamUtilities[0]
    || teamUtilities[1] !== expected.teamUtilities[1]) {
    throw new TypeError('teamUtilities 必须由名次重算且胜负相反');
  }
  const split = input.split == null ? null : stringValue(input.split, 'split', { max: 16 });
  if (split != null && !SEALED_SPLITS.includes(split)) {
    throw new TypeError('split 只能是 train/validation/held-out 或空');
  }
  const result = {
    schema: SEALED_TRAINING_BATCH_SCHEMA,
    matchId,
    round,
    createdAt: stringValue(input.createdAt, 'createdAt', { max: 80 }),
    ruleVersion: stringValue(input.ruleVersion || REPLAY_RULE_VERSION, 'ruleVersion', { max: 80 }),
    implementationSha256: sha256Value(
      input.implementationSha256 || SEALED_TRAINING_IMPLEMENTATION_SHA256,
      'implementationSha256',
    ),
    publicImplementationSha256: sha256Value(
      input.publicImplementationSha256 || input.implementationSha256 || SEALED_TRAINING_IMPLEMENTATION_SHA256,
      'publicImplementationSha256',
    ),
    sourceHeadEventSha256: sha256Value(input.sourceHeadEventSha256 || turns[0].eventSha256, 'sourceHeadEventSha256'),
    sourceTailEventSha256: sha256Value(
      input.sourceTailEventSha256 || turns[turns.length - 1].eventSha256,
      'sourceTailEventSha256',
    ),
    finishOrder,
    winTeam: expected.winTeam,
    upgrade: expected.upgrade,
    upgradeCode: stringValue(input.upgradeCode || expected.upgradeCode, 'upgradeCode', { max: 40 }),
    teamUtilities,
    turns,
    trainingEligible: false,
    split,
  };
  if (result.sourceHeadEventSha256 !== turns[0].eventSha256) {
    throw new TypeError('sourceHeadEventSha256 必须绑定首个密封 turn');
  }
  if (result.sourceTailEventSha256 !== turns[turns.length - 1].eventSha256) {
    throw new TypeError('sourceTailEventSha256 必须绑定末个密封 turn');
  }
  if (input.trainingEligible === true) {
    throw new TypeError('密封批次不得在转换器内批准为可训练');
  }
  return Object.freeze(result);
}

export function validateSealedTrainingBatch(value) {
  if (!isRecord(value)) return { ok: false, errors: ['密封批次必须是对象'] };
  const errors = [];
  const unknown = Object.keys(value).filter((key) => !BATCH_KEYS.has(key));
  if (unknown.length) errors.push(`密封批次含未知字段：${unknown.join(',')}`);
  if (value.schema !== SEALED_TRAINING_BATCH_SCHEMA) errors.push('schema 不匹配');
  if (value.trainingEligible !== false) errors.push('密封批次必须保持 trainingEligible=false');
  try {
    const expected = createSealedTrainingBatch(value);
    if (stableJson(value) !== stableJson(expected)) errors.push('密封批次字段与规范构造不一致');
  } catch (error) {
    errors.push(error.message);
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

export function replaySealedTrainingBatch(batch) {
  const errors = [];
  const validated = validateSealedTrainingBatch(batch);
  if (!validated.ok) return { ok: false, errors: validated.errors };
  const remainingBySeat = new Map();
  for (const [index, turn] of batch.turns.entries()) {
    const turnCheck = validateSealedTrainingTurn(turn);
    if (!turnCheck.ok) {
      errors.push(...turnCheck.errors.map((error) => `turns[${index}] ${error}`));
      continue;
    }
    try { assertNoLabelKeys(turn); } catch (error) {
      errors.push(`turns[${index}] ${error.message}`);
    }
    const observation = turn.publicObservation || {};
    if (Array.isArray(observation.hands) || Array.isArray(observation.initialHands)
      || Array.isArray(observation.remainingHands)) {
      errors.push(`turns[${index}] 公开 observation 泄漏暗牌`);
    }
    if (Array.isArray(observation.handCounts)
      && observation.handCounts[turn.seat] !== turn.hand.length) {
      errors.push(`turns[${index}] 公开余牌数与行动手牌张数不一致`);
    }
    const observedFinish = Array.isArray(observation.finishOrder) ? observation.finishOrder : [];
    if (observedFinish.includes(turn.seat)) {
      errors.push(`turns[${index}] 已出完座位不能再行动`);
    }
    if (!observedFinish.every((seat, finishIndex) => batch.finishOrder[finishIndex] === seat)) {
      errors.push(`turns[${index}] 公开名次不是最终名次前缀`);
    }
    if (index > 0 && turn.seat === batch.turns[index - 1].seat) {
      errors.push(`turns[${index}] 座位轮转失败：同一座位不能连续行动`);
    }
    const previous = remainingBySeat.get(turn.seat);
    if (previous && !sameHandMultiset(previous, turn.hand)) {
      errors.push(`turns[${index}] 牌张守恒失败`);
    }
    const lastHand = observation.lastHand || null;
    const chosen = turn.legalCandidates.find((item) => item.candidateId === turn.chosenCandidateId);
    if (!chosen) {
      errors.push(`turns[${index}] 缺少唯一 chosen`);
      continue;
    }
    const action = chosen.candidateId === PASS_CANDIDATE_ID || (!chosen.cards || !chosen.cards.length)
      ? 'pass' : 'play';
    const generated = generateLegalPlays(turn.hand, observation.level, lastHand);
    const generatedIds = new Set(generated.map((play) => playCandidateId(play.cards, play.hand)));
    const storedIds = new Set(turn.legalCandidates.map((item) => item.candidateId));
    const missingGenerated = [...generatedIds].filter((id) => !storedIds.has(id));
    if (missingGenerated.length) errors.push(`turns[${index}] 合法候选不完整`);
    const hasPass = turn.legalCandidates.some((item) => item.candidateId === PASS_CANDIDATE_ID);
    if (lastHand && !hasPass) errors.push(`turns[${index}] 接牌候选缺少 pass`);
    if (!lastHand && hasPass) errors.push(`turns[${index}] 领出候选不得含 pass`);
    for (const item of turn.legalCandidates) {
      if (item.candidateId === PASS_CANDIDATE_ID) {
        if (item.cards?.length || item.hand) errors.push(`turns[${index}] pass 候选不得带牌或牌型`);
        continue;
      }
      const owned = pickPhysicalCards(turn.hand, item.cards);
      if (!owned) {
        errors.push(`turns[${index}] 候选牌张不属于行动手牌`);
        continue;
      }
      const legal = isLegalPlay(owned, observation.level, lastHand, item.hand);
      if (!legal.ok) errors.push(`turns[${index}] 候选规则重放失败：${legal.reason || '非法'}`);
      if (!generatedIds.has(item.candidateId) && item.candidateId !== turn.chosenCandidateId) {
        errors.push(`turns[${index}] 未选择候选必须来自规则生成集`);
      }
    }
    let physicalCards = [];
    if (action === 'play') {
      const matched = generated.find((play) => playCandidateId(play.cards, play.hand) === chosen.candidateId);
      physicalCards = matched
        ? matched.cards
        : pickPhysicalCards(turn.hand, chosen.cards);
      if (!physicalCards) {
        errors.push(`turns[${index}] chosen 牌张不属于行动手牌`);
        continue;
      }
      const legal = isLegalPlay(physicalCards, observation.level, lastHand, chosen.hand);
      if (!legal.ok) errors.push(`turns[${index}] chosen 规则重放失败：${legal.reason || '非法'}`);
      if (chosen.hand?.type && legal.ok && legal.hand?.type !== chosen.hand.type) {
        errors.push(`turns[${index}] 牌型声明与规则重放不一致`);
      }
    } else if (!lastHand) {
      errors.push(`turns[${index}] 领出不能过牌`);
    }
    const nextHand = action === 'pass'
      ? turn.hand.slice()
      : turn.hand.filter((card) => !physicalCards.some((played) => cardIdentity(played) === cardIdentity(card)));
    remainingBySeat.set(turn.seat, nextHand);
  }
  try {
    const expected = teamUtilitiesFromFinishOrder(batch.finishOrder);
    if (expected.upgrade !== batch.upgrade || expected.winTeam !== batch.winTeam
      || expected.teamUtilities[0] !== batch.teamUtilities[0]
      || expected.teamUtilities[1] !== batch.teamUtilities[1]) {
      errors.push('名次与团队收益无法从 finishOrder 重算');
    }
  } catch (error) {
    errors.push(error.message);
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

export function assignMatchSplit(matchId) {
  const digest = sha256Hex(String(matchId || ''));
  const bucket = Number.parseInt(digest.slice(0, 8), 16) % 10;
  if (bucket < 8) return 'train';
  if (bucket === 8) return 'validation';
  return 'held-out';
}

export function batchFingerprint(batch) {
  return sha256Hex(stableJson({
    matchId: batch?.matchId,
    round: batch?.round,
    turns: (batch?.turns || []).map((turn) => turn.eventSha256),
    finishOrder: batch?.finishOrder,
  }));
}

export function convertSealedTrainingBatches(batches, { now = new Date().toISOString() } = {}) {
  if (!Array.isArray(batches)) {
    return { ok: false, errors: ['转换输入必须是批次数组'], manifest: null, splits: emptySplits() };
  }
  const errors = [];
  const accepted = [];
  const seen = new Set();
  let duplicates = 0;
  batches.forEach((batch, index) => {
    const replay = replaySealedTrainingBatch(batch);
    if (!replay.ok) {
      errors.push(...replay.errors.map((error) => `batch[${index}] ${error}`));
      return;
    }
    const fingerprint = batchFingerprint(batch);
    if (seen.has(fingerprint)) {
      duplicates += 1;
      return;
    }
    seen.add(fingerprint);
    try {
      accepted.push(createSealedTrainingBatch({
        ...batch,
        createdAt: batch.createdAt || now,
        split: assignMatchSplit(batch.matchId),
        trainingEligible: false,
        turns: batch.turns.map((turn) => ({ ...turn, trainingEligible: false })),
      }));
    } catch (error) {
      errors.push(`batch[${index}] ${error.message}`);
    }
  });
  const splits = emptySplits();
  if (!errors.length) {
    for (const batch of accepted) splits[batch.split].push(batch);
  }
  const manifest = Object.freeze({
    schema: SEALED_TRAINING_MANIFEST_SCHEMA,
    createdAt: now,
    trainingEligible: false,
    implementationSha256: SEALED_TRAINING_IMPLEMENTATION_SHA256,
    inputCount: batches.length,
    acceptedMatchRounds: accepted.length,
    duplicateCount: duplicates,
    rejectedCount: batches.length - accepted.length - duplicates,
    turnCount: accepted.reduce((sum, batch) => sum + batch.turns.length, 0),
    splits: {
      train: splits.train.length,
      validation: splits.validation.length,
      'held-out': splits['held-out'].length,
    },
    labelPolicy: 'trajectory_only_no_counterfactual',
  });
  return {
    ok: errors.length === 0,
    errors,
    manifest,
    splits,
  };
}

function emptySplits() {
  return { train: [], validation: [], 'held-out': [] };
}

export function finalizeSealedTrainingBatch(state, {
  publicImplementationSha256,
  createdAt = new Date().toISOString(),
} = {}) {
  try {
    const actions = (state?.trickLog || []).filter((item) => item.action === 'play' || item.action === 'pass');
    const turns = Array.isArray(state?.sealedTrainingTurns) ? state.sealedTrainingTurns : [];
    if (turns.length !== actions.length) {
      throw new TypeError(`密封 turn 数量 ${turns.length} 与公开动作 ${actions.length} 不一致`);
    }
    const ranking = teamUtilitiesFromFinishOrder(state.finishOrder);
    const batch = createSealedTrainingBatch({
      matchId: state.matchId,
      round: state.round,
      createdAt,
      ruleVersion: REPLAY_RULE_VERSION,
      implementationSha256: SEALED_TRAINING_IMPLEMENTATION_SHA256,
      publicImplementationSha256: publicImplementationSha256 || SEALED_TRAINING_IMPLEMENTATION_SHA256,
      sourceHeadEventSha256: turns[0].eventSha256,
      sourceTailEventSha256: turns[turns.length - 1].eventSha256,
      finishOrder: state.finishOrder.slice(),
      winTeam: ranking.winTeam,
      upgrade: ranking.upgrade,
      upgradeCode: ranking.upgradeCode,
      teamUtilities: ranking.teamUtilities,
      turns,
      trainingEligible: false,
      split: null,
    });
    const replay = replaySealedTrainingBatch(batch);
    if (!replay.ok) throw new TypeError(replay.errors[0] || '密封批次规则重放失败');
    state.sealedTrainingBatch = batch;
    if (!Array.isArray(state.sealedTrainingHistory)) state.sealedTrainingHistory = [];
    state.sealedTrainingHistory.push(batch);
    return batch;
  } catch (error) {
    if (state) state.sealedTrainingBatch = null;
    return recordSealedFailure(state, error);
  }
}

export function resetSealedTrainingRound(state) {
  if (!state) return;
  state.sealedTrainingTurns = [];
  state.sealedTrainingBatch = null;
  state.sealedPreviousTurnSha256 = null;
  state.sealedSequence = 0;
  state.sealedTrainingLastError = null;
}

export function initSealedTrainingState(state) {
  resetSealedTrainingRound(state);
  state.sealedTrainingHistory = [];
  state.sealedTrainingFailures = 0;
}

export function getSealedTrainingBatch(state) {
  return state?.sealedTrainingBatch || null;
}

export function getSealedTrainingHistory(state) {
  return Array.isArray(state?.sealedTrainingHistory) ? state.sealedTrainingHistory.slice() : [];
}

export function omitSealedTrainingState(key, value) {
  if (SEALED_STATE_KEYS.includes(key)) return undefined;
  return value;
}

function implementationSource(value) {
  return typeof value === 'function' ? value.toString() : stableJson(value);
}

const SEALED_IMPLEMENTATION_ENTRIES = Object.freeze([
  ['SEALED_TRAINING_BATCH_SCHEMA', SEALED_TRAINING_BATCH_SCHEMA],
  ['PASS_CANDIDATE_ID', PASS_CANDIDATE_ID],
  ['SEALED_SPLITS', SEALED_SPLITS],
  ['SEALED_TEAM_OF', SEALED_TEAM_OF],
  ['SEALED_STATE_KEYS', SEALED_STATE_KEYS],
  ['playCandidateId', playCandidateId],
  ['listLegalTrainingCandidates', listLegalTrainingCandidates],
  ['snapshotSealedAction', snapshotSealedAction],
  ['appendSealedTrainingTurn', appendSealedTrainingTurn],
  ['teamUtilitiesFromFinishOrder', teamUtilitiesFromFinishOrder],
  ['createSealedTrainingBatch', createSealedTrainingBatch],
  ['validateSealedTrainingBatch', validateSealedTrainingBatch],
  ['replaySealedTrainingBatch', replaySealedTrainingBatch],
  ['assignMatchSplit', assignMatchSplit],
  ['convertSealedTrainingBatches', convertSealedTrainingBatches],
  ['finalizeSealedTrainingBatch', finalizeSealedTrainingBatch],
]);

export function computeSealedTrainingImplementationSha256() {
  return sha256Hex([
    'guandan-sealed-training-implementation-v1',
    ...SEALED_IMPLEMENTATION_ENTRIES.map(([name, value]) => `${name}\n${implementationSource(value)}`),
  ].join('\n'));
}

export const SEALED_TRAINING_IMPLEMENTATION_SHA256 = computeSealedTrainingImplementationSha256();
