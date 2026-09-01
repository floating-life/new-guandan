/**
 * STRAT-1 最小公开反例夹具。
 * 夹具只保存行动座位手牌和当时公开信息；不接受四家初始牌、未来牌或
 * 原始浏览器复盘对象。规则/实现摘要绑定后才能作为回归输入。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const STRATEGY_COUNTEREXAMPLE_SCHEMA = 'guandan-strategy-counterexample-v1';
export const STRATEGY_RULE_VERSION = 'guandan-rules-v1';
const HEX64 = /^[0-9a-f]{64}$/;
const ACTIONS = new Set(['play', 'pass']);
const REQUIRED_PUBLIC_KEYS = new Set([
  'turn', 'trickNumber', 'seat', 'action', 'cards', 'hand', 'countsBefore', 'countsAfter',
]);
const OBSERVATION_KEYS = new Set([
  'level', 'seat', 'hand', 'lastHand', 'lastSeat', 'teams', 'finishOrder',
  'handCounts', 'publicHistory',
]);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function fingerprintFiles(root, files) {
  const normalized = [...new Set(files)].map((file) => String(file).replaceAll('\\', '/')).sort();
  const sources = normalized.map((file) => {
    const absolute = path.resolve(root, file);
    const bytes = fs.readFileSync(absolute);
    return { file, sha256: sha256(bytes), bytes: bytes.length };
  });
  return {
    files: sources,
    sha256: sha256(Buffer.from(JSON.stringify(sources), 'utf8')),
  };
}

function publicCard(card) {
  if (!card || !Number.isFinite(Number(card.rank)) || typeof card.suit !== 'string') return null;
  return {
    rank: Number(card.rank),
    suit: card.suit,
    deckIndex: Number.isInteger(Number(card.deckIndex)) ? Number(card.deckIndex) : null,
  };
}

function publicHand(hand) {
  if (!hand || typeof hand !== 'object') return null;
  return {
    type: String(hand.type || ''),
    mainRank: Number.isFinite(Number(hand.mainRank)) ? Number(hand.mainRank) : null,
    size: Number.isFinite(Number(hand.size)) ? Number(hand.size) : null,
    power: Number.isFinite(Number(hand.power)) ? Number(hand.power) : null,
  };
}

function publicEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const output = {
    turn: Number(event.turn),
    trickNumber: Number(event.trickNumber),
    seat: Number(event.seat),
    action: ACTIONS.has(event.action) ? event.action : null,
    cards: Array.isArray(event.cards) ? event.cards.map(publicCard).filter(Boolean) : [],
    hand: publicHand(event.hand),
    countsBefore: Array.isArray(event.countsBefore) ? event.countsBefore.map(Number) : [],
    countsAfter: Array.isArray(event.countsAfter) ? event.countsAfter.map(Number) : [],
  };
  return output;
}

function publicCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  return {
    action: ACTIONS.has(candidate.action) ? candidate.action : null,
    cards: Array.isArray(candidate.cards) ? candidate.cards.map(publicCard).filter(Boolean) : [],
    signature: candidate.signature == null ? null : String(candidate.signature),
    tags: Array.isArray(candidate.tags) ? candidate.tags.map(String).sort() : [],
  };
}

export function buildStrategyCounterexample({
  id, rule, level, seat, hand, lastHand = null, lastSeat = null,
  teams, finishOrder = [], handCounts, publicHistory = [], candidates,
  expected, sourceFingerprint,
}) {
  const observation = {
    level: Number(level),
    seat: Number(seat),
    hand: hand.map(publicCard).filter(Boolean),
    lastHand: publicHand(lastHand),
    lastSeat: lastSeat == null ? null : Number(lastSeat),
    teams: teams.map(Number),
    finishOrder: finishOrder.map(Number),
    handCounts: handCounts.map(Number),
    publicHistory: publicHistory.map(publicEvent).filter(Boolean),
  };
  return {
    schema: STRATEGY_COUNTEREXAMPLE_SCHEMA,
    id: String(id),
    rule: String(rule),
    ruleVersion: STRATEGY_RULE_VERSION,
    sourceFingerprint,
    observation,
    candidates: candidates.map(publicCandidate).filter(Boolean),
    expected: {
      invariants: Array.isArray(expected?.invariants) ? expected.invariants.map(String) : [],
      preferredAction: expected?.preferredAction || null,
      blockedActions: Array.isArray(expected?.blockedActions)
        ? expected.blockedActions.map(String) : [],
    },
  };
}

export function validateStrategyCounterexample(value) {
  const errors = [];
  if (!value || typeof value !== 'object') return ['夹具必须是对象'];
  if (value.schema !== STRATEGY_COUNTEREXAMPLE_SCHEMA) errors.push('schema 不匹配');
  if (!value.id || !value.rule) errors.push('缺少 id/rule');
  if (value.ruleVersion !== STRATEGY_RULE_VERSION) errors.push('ruleVersion 不匹配');
  const fingerprint = value.sourceFingerprint;
  if (!fingerprint || !HEX64.test(String(fingerprint.sha256 || ''))) {
    errors.push('缺少 sourceFingerprint.sha256');
  }
  const observation = value.observation;
  if (!observation || !Array.isArray(observation.hand) || !observation.hand.length) {
    errors.push('observation 必须包含行动座位非空手牌');
  }
  if (observation && typeof observation === 'object') {
    for (const key of Object.keys(observation)) {
      if (!OBSERVATION_KEYS.has(key)) errors.push(`observation 含非白名单字段 ${key}`);
    }
  }
  if (Array.isArray(observation?.publicHistory)) {
    observation.publicHistory.forEach((event, index) => {
      const keys = Object.keys(event || {});
      for (const key of keys) if (!REQUIRED_PUBLIC_KEYS.has(key)) {
        errors.push(`publicHistory[${index}] 含非公开字段 ${key}`);
      }
      if (!ACTIONS.has(event?.action)) errors.push(`publicHistory[${index}] action 非法`);
    });
  } else errors.push('缺少 publicHistory');
  if (!Array.isArray(value.candidates) || !value.candidates.length) errors.push('缺少候选集');
  if (!Array.isArray(value.expected?.invariants) || !value.expected.invariants.length) {
    errors.push('缺少预期不变量');
  }
  return errors;
}

export function validateCounterexampleFile(file) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  return validateStrategyCounterexample(value);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const input = process.argv[2];
  if (!input) {
    console.error('用法：node tools/strategy_counterexamples.mjs <fixture.json>');
    process.exit(2);
  }
  const errors = validateCounterexampleFile(input);
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exit(1);
  }
  console.log(`strategy counterexample OK: ${input}`);
}
