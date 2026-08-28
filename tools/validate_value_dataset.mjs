/**
 * 自对弈训练数据严格校验。
 * 用法：node tools/validate_value_dataset.mjs <数据.jsonl>
 *
 * 校验不只搜索已知泄漏字段，而是逐层使用允许字段白名单；同时重新执行规则
 * 判断和32维特征提取，防止损坏或手工拼接的数据进入训练。
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const {
  HYBRID_VALUE_FEATURES, HYBRID_VALUE_SCHEMA, extractHybridValueFeatures,
} = await import('../js/ai-hybrid.js');
const { isLegalPlay, parseHandVariants, handSignature } = await import('../js/rules.js');

const DATASET_SCHEMA = 'guandan-selfplay-trajectory-v2';
const SEED_MANIFEST_SCHEMA = 'guandan-seed-manifest-v1';
const input = process.argv[2];
if (!input) throw new Error('请提供 JSONL 文件路径');
const file = path.resolve(input);

const KEYS = Object.freeze({
  header: ['schema', 'valueSchema', 'rounds', 'baseSeed', 'seedManifest', 'recordCount', 'generatedAt', 'fairness', 'labelScope'],
  record: ['schema', 'valueSchema', 'game', 'round', 'turn', 'trickNumber', 'seat', 'observation', 'candidates', 'chosenAction', 'labelScope', 'outcome'],
  observation: ['seat', 'hand', 'level', 'lastHand', 'lastSeat', 'handCounts', 'teams', 'finishOrder', 'playedCards', 'publicHistory', 'tributeContext', 'leadAfterOwnBomb'],
  ownCard: ['id', 'rank', 'suit', 'deckIndex'],
  publicCard: ['rank', 'suit', 'deckIndex'],
  publicHand: ['type', 'mainRank', 'size', 'power', 'meta'],
  handMeta: ['sequence', 'pairRank', 'suit', 'wildAs'],
  history: ['turn', 'trickNumber', 'seat', 'action', 'cards', 'hand', 'countsBefore', 'countsAfter'],
  tribute: ['gaveCard', 'gaveTo', 'receivedReturnCard', 'receivedFrom', 'firstLeadAfterTribute', 'doubleDown', 'knownTransfers'],
  transfer: ['card', 'from', 'to', 'kind'],
  candidate: ['id', 'action', 'cards', 'hand', 'signature', 'localScore', 'projectedTricks', 'responseSearch', 'chosen', 'features'],
  candidateHand: ['type', 'mainRank', 'size', 'power'],
  responseSearch: ['teamControl', 'enemyControl', 'enemyBomb'],
  outcome: ['teamUtility', 'teamWon', 'place', 'finishOrder'],
});

const RANKS = new Set([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17]);
const SUITS = new Set(['S', 'H', 'D', 'C', 'J']);
const errors = [];
const games = new Set();
let header = null;
let records = 0;
let candidates = 0;
let chosenCandidates = 0;
let lineCount = 0;

function errorAt(where, message) {
  if (errors.length < 200) errors.push(`${where}: ${message}`);
}

function isObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function assertShape(value, allowed, where, { nullable = false, requireAll = true } = {}) {
  if (value == null && nullable) return false;
  if (!isObject(value)) {
    errorAt(where, 'expected object');
    return false;
  }
  const expected = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) errorAt(`${where}.${key}`, 'field is not on the training-data whitelist');
  }
  if (requireAll) {
    for (const key of allowed) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) errorAt(`${where}.${key}`, 'required field missing');
    }
  }
  return true;
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function validSeat(value) {
  return Number.isInteger(value) && value >= 0 && value < 4;
}

function validateSeedManifest(value, where, rounds, baseSeed) {
  if (value == null) return;
  if (!assertShape(value, ['schema', 'seeds'], where)) return;
  if (value.schema !== SEED_MANIFEST_SCHEMA) errorAt(`${where}.schema`, 'unexpected seed manifest schema');
  if (!Array.isArray(value.seeds) || value.seeds.length !== rounds) {
    errorAt(`${where}.seeds`, `expected exactly ${rounds} seeds`);
    return;
  }
  const expected = value.seeds.map((seed, index) => (baseSeed + index) >>> 0);
  if (value.seeds.some((seed, index) => !Number.isInteger(seed)
    || seed < 0 || seed > 0xFFFFFFFF || seed !== expected[index])) {
    errorAt(`${where}.seeds`, 'must be the contiguous uint32 seed range starting at baseSeed');
  }
  if (new Set(value.seeds).size !== value.seeds.length) {
    errorAt(`${where}.seeds`, 'must not contain duplicate seeds');
  }
}

function validateCard(card, where, { own = false } = {}) {
  if (!assertShape(card, own ? KEYS.ownCard : KEYS.publicCard, where)) return false;
  const rank = card.rank;
  const deckIndex = card.deckIndex;
  let ok = true;
  if (!RANKS.has(rank)) {
    errorAt(`${where}.rank`, 'invalid rank');
    ok = false;
  }
  if (!SUITS.has(card.suit) || ((rank === 16 || rank === 17) !== (card.suit === 'J'))) {
    errorAt(`${where}.suit`, 'rank/suit combination is not a physical card');
    ok = false;
  }
  if (!Number.isInteger(deckIndex) || deckIndex < 0 || deckIndex > 1) {
    errorAt(`${where}.deckIndex`, 'expected deck index 0 or 1');
    ok = false;
  }
  if (own && (typeof card.id !== 'string' || !card.id)) {
    errorAt(`${where}.id`, 'own card requires a non-empty id');
    ok = false;
  }
  return ok;
}

function validateHandMeta(meta, where) {
  if (!assertShape(meta, KEYS.handMeta, where, { requireAll: false })) return;
  if (!Array.isArray(meta.sequence) && meta.sequence !== undefined) {
    errorAt(`${where}.sequence`, 'expected numeric array');
  } else if (Array.isArray(meta.sequence) && meta.sequence.some((rank) => !finiteNumber(rank))) {
    errorAt(`${where}.sequence`, 'contains non-numeric rank');
  }
  if (meta.pairRank != null && !finiteNumber(meta.pairRank)) errorAt(`${where}.pairRank`, 'expected number or null');
  if (meta.suit != null && typeof meta.suit !== 'string') errorAt(`${where}.suit`, 'expected string or null');
  const wildAs = meta.wildAs;
  if (wildAs != null && !finiteNumber(wildAs)
    && !(Array.isArray(wildAs) && wildAs.every(finiteNumber))) {
    errorAt(`${where}.wildAs`, 'expected number, numeric array, or null');
  }
}

function validatePublicHand(hand, where, { nullable = true } = {}) {
  if (hand == null && nullable) return;
  if (!assertShape(hand, KEYS.publicHand, where)) return;
  if (typeof hand.type !== 'string' || !hand.type) errorAt(`${where}.type`, 'invalid hand type');
  for (const key of ['mainRank', 'size', 'power']) {
    if (hand[key] != null && !finiteNumber(hand[key])) errorAt(`${where}.${key}`, 'expected finite number or null');
  }
  validateHandMeta(hand.meta, `${where}.meta`);
}

function validateCounts(value, where) {
  if (!Array.isArray(value) || value.length !== 4
    || value.some((count) => !Number.isFinite(Number(count)) || Number(count) < 0)) {
    errorAt(where, 'expected four non-negative counts');
  }
}

function validateHistory(history, where, level) {
  if (!Array.isArray(history)) {
    errorAt(where, 'expected array');
    return;
  }
  history.forEach((item, index) => {
    const at = `${where}[${index}]`;
    if (!assertShape(item, KEYS.history, at)) return;
    if (!validSeat(item.seat)) errorAt(`${at}.seat`, 'invalid seat');
    if (!['play', 'pass'].includes(item.action)) errorAt(`${at}.action`, 'invalid action');
    if (!Array.isArray(item.cards)) errorAt(`${at}.cards`, 'expected array');
    else item.cards.forEach((card, cardIndex) => validateCard(card, `${at}.cards[${cardIndex}]`));
    validatePublicHand(item.hand, `${at}.hand`);
    validateCounts(item.countsBefore, `${at}.countsBefore`);
    validateCounts(item.countsAfter, `${at}.countsAfter`);
    if (item.action === 'pass' && ((item.cards || []).length || item.hand != null)) {
      errorAt(at, 'pass history item must not contain cards or a hand');
    }
    if (item.action === 'play' && (!(item.cards || []).length || item.hand == null)) {
      errorAt(at, 'play history item requires cards and a hand');
    }
    if (item.action === 'play' && item.hand && Array.isArray(item.cards) && item.cards.length) {
      const variants = parseHandVariants(item.cards, level);
      if (!variants.some((variant) => handSignature(variant) === handSignature(item.hand))) {
        errorAt(at, 'public history hand does not match its cards');
      }
    }
  });
}

function validateTribute(value, where) {
  if (value == null) return;
  if (!assertShape(value, KEYS.tribute, where)) return;
  for (const key of ['gaveCard', 'receivedReturnCard']) {
    if (value[key] != null) validateCard(value[key], `${where}.${key}`);
  }
  for (const key of ['gaveTo', 'receivedFrom']) {
    if (value[key] != null && !validSeat(value[key])) errorAt(`${where}.${key}`, 'invalid seat');
  }
  if (typeof value.firstLeadAfterTribute !== 'boolean') errorAt(`${where}.firstLeadAfterTribute`, 'expected boolean');
  if (typeof value.doubleDown !== 'boolean') errorAt(`${where}.doubleDown`, 'expected boolean');
  if (!Array.isArray(value.knownTransfers)) errorAt(`${where}.knownTransfers`, 'expected array');
  else value.knownTransfers.forEach((transfer, index) => {
    const at = `${where}.knownTransfers[${index}]`;
    if (!assertShape(transfer, KEYS.transfer, at)) return;
    validateCard(transfer.card, `${at}.card`);
    if (!validSeat(transfer.from) || !validSeat(transfer.to)) errorAt(at, 'invalid transfer seat');
    if (!['tribute', 'return'].includes(transfer.kind)) errorAt(`${at}.kind`, 'invalid transfer kind');
  });
}

function validateObservation(observation, where) {
  if (!assertShape(observation, KEYS.observation, where)) return null;
  if (!validSeat(observation.seat)) errorAt(`${where}.seat`, 'invalid seat');
  if (!RANKS.has(Number(observation.level)) || Number(observation.level) > 14) {
    errorAt(`${where}.level`, 'invalid level rank');
  }
  if (!Array.isArray(observation.hand)) errorAt(`${where}.hand`, 'expected array');
  else observation.hand.forEach((card, index) => validateCard(card, `${where}.hand[${index}]`, { own: true }));
  const handIds = (observation.hand || []).map((card) => String(card.id));
  if (new Set(handIds).size !== handIds.length) errorAt(`${where}.hand`, 'duplicate own-card id');
  validatePublicHand(observation.lastHand, `${where}.lastHand`);
  if (observation.lastSeat != null && !validSeat(observation.lastSeat)) errorAt(`${where}.lastSeat`, 'invalid seat');
  validateCounts(observation.handCounts, `${where}.handCounts`);
  if (Array.isArray(observation.handCounts) && validSeat(observation.seat)
    && observation.hand.length !== Number(observation.handCounts[observation.seat])) {
    errorAt(where, 'own hand/count mismatch');
  }
  if (!Array.isArray(observation.teams) || observation.teams.length !== 4
    || observation.teams.some((team) => !finiteNumber(team))) errorAt(`${where}.teams`, 'expected four team ids');
  if (!Array.isArray(observation.finishOrder) || observation.finishOrder.some((seat) => !validSeat(seat))
    || new Set(observation.finishOrder).size !== observation.finishOrder.length) {
    errorAt(`${where}.finishOrder`, 'invalid finish order');
  }
  if (!Array.isArray(observation.playedCards)) errorAt(`${where}.playedCards`, 'expected array');
  else observation.playedCards.forEach((card, index) => validateCard(card, `${where}.playedCards[${index}]`));
  validateHistory(observation.publicHistory, `${where}.publicHistory`, observation.level);
  validateTribute(observation.tributeContext, `${where}.tributeContext`);
  if (typeof observation.leadAfterOwnBomb !== 'boolean') errorAt(`${where}.leadAfterOwnBomb`, 'expected boolean');
  return new Map((observation.hand || []).map((card) => [String(card.id), card]));
}

function sameNumber(left, right, tolerance = 1e-10) {
  return finiteNumber(left) && finiteNumber(right)
    && Math.abs(Number(left) - Number(right)) <= tolerance;
}

function validateCandidate(candidate, where, observation, ownById) {
  if (!assertShape(candidate, KEYS.candidate, where)) return;
  candidates += 1;
  if (typeof candidate.id !== 'string' || !candidate.id) errorAt(`${where}.id`, 'expected non-empty id');
  if (!['play', 'pass'].includes(candidate.action)) errorAt(`${where}.action`, 'invalid action');
  if (typeof candidate.chosen !== 'boolean') errorAt(`${where}.chosen`, 'expected boolean');
  if (candidate.chosen === true) chosenCandidates += 1;
  if (candidate.localScore != null && !finiteNumber(candidate.localScore)) errorAt(`${where}.localScore`, 'expected finite number or null');
  if (candidate.projectedTricks != null && !finiteNumber(candidate.projectedTricks)) errorAt(`${where}.projectedTricks`, 'expected finite number or null');
  if (candidate.responseSearch != null) {
    if (assertShape(candidate.responseSearch, KEYS.responseSearch, `${where}.responseSearch`)) {
      for (const key of KEYS.responseSearch) {
        if (!finiteNumber(candidate.responseSearch[key])) errorAt(`${where}.responseSearch.${key}`, 'expected finite number');
      }
    }
  }
  if (!Array.isArray(candidate.cards)) errorAt(`${where}.cards`, 'expected array');
  const cardIds = [];
  for (let index = 0; index < (candidate.cards || []).length; index += 1) {
    const card = candidate.cards[index];
    validateCard(card, `${where}.cards[${index}]`, { own: true });
    const id = String(card.id);
    cardIds.push(id);
    const owned = ownById?.get(id);
    if (!owned) errorAt(`${where}.cards[${index}]`, 'candidate card is not in acting hand');
    else if (Number(card.rank) !== Number(owned.rank) || card.suit !== owned.suit
      || Number(card.deckIndex) !== Number(owned.deckIndex)) {
      errorAt(`${where}.cards[${index}]`, 'candidate card does not match the owned physical card');
    }
  }
  if (new Set(cardIds).size !== cardIds.length) errorAt(`${where}.cards`, 'candidate repeats a physical card');

  if (candidate.action === 'pass') {
    if (!observation.lastHand) errorAt(where, 'cannot pass while leading');
    if (cardIds.length || candidate.hand != null || candidate.signature != null) {
      errorAt(where, 'pass candidate must have no cards, hand, or signature');
    }
  } else {
    if (!cardIds.length) errorAt(where, 'play candidate requires cards');
    if (!assertShape(candidate.hand, KEYS.candidateHand, `${where}.hand`)) return;
    if (typeof candidate.signature !== 'string' || !candidate.signature) {
      errorAt(`${where}.signature`, 'play candidate requires a declaration signature');
    } else {
      const declared = parseHandVariants(candidate.cards, observation.level)
        .find((hand) => handSignature(hand) === candidate.signature);
      if (!declared) errorAt(where, 'candidate signature does not describe its cards');
      else {
        for (const key of ['type', 'mainRank', 'size', 'power']) {
          const matches = key === 'type'
            ? candidate.hand[key] === declared[key]
            : sameNumber(candidate.hand[key], declared[key]);
          if (!matches) errorAt(`${where}.hand.${key}`, 'candidate hand metadata differs from rules engine');
        }
      }
      const legality = isLegalPlay(
        candidate.cards, observation.level, observation.lastHand, candidate.signature,
      );
      if (!legality.ok) errorAt(where, `illegal candidate (${legality.reason || 'unknown reason'})`);
    }
  }

  if (!Array.isArray(candidate.features)
    || candidate.features.length !== HYBRID_VALUE_FEATURES.length
    || candidate.features.some((value) => !finiteNumber(value))) {
    errorAt(`${where}.features`, `expected ${HYBRID_VALUE_FEATURES.length} finite values`);
  } else {
    const recomputed = Array.from(extractHybridValueFeatures(observation, candidate));
    for (let index = 0; index < recomputed.length; index += 1) {
      if (!sameNumber(candidate.features[index], recomputed[index], 1e-12)) {
        errorAt(`${where}.features[${index}]`, `does not match recomputed ${HYBRID_VALUE_FEATURES[index]}`);
        break;
      }
    }
  }
}

const reader = readline.createInterface({
  input: fs.createReadStream(file),
  crlfDelay: Infinity,
});

for await (const line of reader) {
  if (!line.trim()) continue;
  const index = lineCount;
  lineCount += 1;
  let row;
  try {
    row = JSON.parse(line);
  } catch (parseError) {
    errorAt(`line ${index + 1}`, `invalid JSON (${parseError.message})`);
    continue;
  }
  const where = `line${index + 1}`;
  if (index === 0) {
    header = row;
    if (!assertShape(row, KEYS.header, where, { requireAll: false })) continue;
    if (row.schema !== `${DATASET_SCHEMA}-header`) errorAt(`${where}.schema`, 'unexpected header schema');
    if (row.valueSchema !== HYBRID_VALUE_SCHEMA) errorAt(`${where}.valueSchema`, 'unexpected value schema');
    if (row.fairness !== 'own_hand_plus_public_history_only') errorAt(`${where}.fairness`, 'unexpected fairness declaration');
    if (row.labelScope !== 'trajectory') errorAt(`${where}.labelScope`, 'unexpected label scope');
    if (!Number.isInteger(row.rounds) || row.rounds <= 0) errorAt(`${where}.rounds`, 'expected positive integer');
    if (!Number.isInteger(row.baseSeed) || row.baseSeed < 0 || row.baseSeed > 0xFFFFFFFF) errorAt(`${where}.baseSeed`, 'expected uint32');
    if (Number.isInteger(row.rounds) && Number.isInteger(row.baseSeed)) {
      validateSeedManifest(row.seedManifest, `${where}.seedManifest`, row.rounds, row.baseSeed);
    }
    if (!Number.isInteger(row.recordCount) || row.recordCount <= 0) errorAt(`${where}.recordCount`, 'expected positive integer');
    if (typeof row.generatedAt !== 'string' || !Number.isFinite(Date.parse(row.generatedAt))) {
      errorAt(`${where}.generatedAt`, 'expected ISO timestamp');
    }
    continue;
  }

  records += 1;
  if (!assertShape(row, KEYS.record, where)) continue;
  if (row.schema !== DATASET_SCHEMA) errorAt(`${where}.schema`, 'unexpected record schema');
  if (row.valueSchema !== HYBRID_VALUE_SCHEMA) errorAt(`${where}.valueSchema`, 'unexpected value schema');
  if (row.labelScope !== 'trajectory') errorAt(`${where}.labelScope`, 'unexpected label scope');
  if (!Number.isInteger(row.game) || row.game <= 0) errorAt(`${where}.game`, 'invalid game id');
  else games.add(row.game);
  for (const key of ['round', 'turn', 'trickNumber']) {
    if (row[key] != null && (!Number.isInteger(row[key]) || row[key] < 0)) {
      errorAt(`${where}.${key}`, 'expected non-negative integer or null');
    }
  }
  if (!validSeat(row.seat)) errorAt(`${where}.seat`, 'invalid seat');
  const ownById = validateObservation(row.observation, `${where}.observation`);
  if (row.seat !== row.observation?.seat) errorAt(where, 'record seat differs from observation seat');
  if (!Array.isArray(row.candidates) || !row.candidates.length) {
    errorAt(`${where}.candidates`, 'no candidates');
    continue;
  }
  const ids = new Set();
  const actionKeys = new Set();
  row.candidates.forEach((candidate, candidateIndex) => {
    const at = `${where}.candidates[${candidateIndex}]`;
    validateCandidate(candidate, at, row.observation, ownById);
    if (ids.has(candidate.id)) errorAt(`${at}.id`, 'duplicate candidate id');
    ids.add(candidate.id);
    const key = candidate.action === 'pass' ? 'pass'
      : `${(candidate.cards || []).map((card) => card.id).sort().join(',')}|${candidate.signature}`;
    if (actionKeys.has(key)) errorAt(at, 'duplicate physical action/declaration');
    actionKeys.add(key);
  });
  const chosen = row.candidates.filter((candidate) => candidate.chosen === true);
  if (chosen.length !== 1) errorAt(`${where}.candidates`, `expected exactly one chosen candidate, got ${chosen.length}`);
  else if (chosen[0].action !== row.chosenAction) errorAt(`${where}.chosenAction`, 'does not match selected candidate');
  if (!['play', 'pass'].includes(row.chosenAction)) errorAt(`${where}.chosenAction`, 'invalid action');

  if (assertShape(row.outcome, KEYS.outcome, `${where}.outcome`)) {
    const utility = Number(row.outcome.teamUtility);
    if (!Number.isFinite(utility) || ![-3, -2, -1, 1, 2, 3].includes(utility)) {
      errorAt(`${where}.outcome.teamUtility`, 'expected non-zero team utility in [-3, 3]');
    }
    if (typeof row.outcome.teamWon !== 'boolean') errorAt(`${where}.outcome.teamWon`, 'expected boolean');
    if (!Number.isInteger(Number(row.outcome.place)) || Number(row.outcome.place) < 1 || Number(row.outcome.place) > 4) {
      errorAt(`${where}.outcome.place`, 'expected place 1..4');
    }
    if (!Array.isArray(row.outcome.finishOrder) || row.outcome.finishOrder.length !== 4
      || row.outcome.finishOrder.some((seat) => !validSeat(seat))
      || new Set(row.outcome.finishOrder).size !== 4) {
      errorAt(`${where}.outcome.finishOrder`, 'expected a permutation of four seats');
    } else if (validSeat(row.seat) && Array.isArray(row.observation?.teams)) {
      const order = row.outcome.finishOrder;
      const expectedPlace = order.indexOf(row.seat) + 1;
      const rootTeam = row.observation.teams[row.seat];
      const winnerTeam = row.observation.teams[order[0]];
      const partner = order.find((seat) => seat !== order[0]
        && row.observation.teams[seat] === winnerTeam);
      const partnerPlace = order.indexOf(partner);
      const upgrade = partnerPlace === 1 ? 3 : partnerPlace === 2 ? 2 : 1;
      const expectedWon = winnerTeam === rootTeam;
      const expectedUtility = expectedWon ? upgrade : -upgrade;
      if (row.outcome.place !== expectedPlace) errorAt(`${where}.outcome.place`, 'does not match finish order');
      if (row.outcome.teamWon !== expectedWon) errorAt(`${where}.outcome.teamWon`, 'does not match finish order and teams');
      if (utility !== expectedUtility) errorAt(`${where}.outcome.teamUtility`, 'does not match Guandan upgrade utility');
    }
  }
}

if (lineCount === 0) throw new Error('数据文件为空');

if (header) {
  if (Number(header.recordCount) !== records) errorAt('line1.recordCount', `declares ${header.recordCount}, found ${records}`);
  if (Number(header.rounds) !== games.size) errorAt('line1.rounds', `declares ${header.rounds}, found ${games.size} game ids`);
  const expectedGames = Array.from({ length: Number(header.rounds) || 0 }, (_, index) => index + 1);
  if (expectedGames.some((game) => !games.has(game))) errorAt('line1.rounds', 'game ids are not contiguous from 1');
}

if (errors.length) {
  console.error(JSON.stringify({
    ok: false, file, records, candidates, chosenCandidates,
    errorCount: errors.length, errors: errors.slice(0, 80),
  }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({
  ok: true, file, records, games: games.size, candidates, chosenCandidates,
  valueSchema: HYBRID_VALUE_SCHEMA,
  seedManifest: header?.seedManifest || null,
  fairness: 'strict recursive whitelist; legal owned candidates; exact feature recomputation',
}, null, 2));
