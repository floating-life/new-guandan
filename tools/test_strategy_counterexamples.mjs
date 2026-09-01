/** STRAT-1 脱敏反例夹具、源码绑定与合法候选回归。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCard } from '../js/cards.js';
import { generateLegalPlays, parseHand } from '../js/rules.js';
import { assessPartnerTrickControl } from '../js/strategy-core.js';
import {
  STRATEGY_COUNTEREXAMPLE_SCHEMA, STRATEGY_RULE_VERSION,
  fingerprintFiles, validateStrategyCounterexample,
} from './strategy_counterexamples.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = path.join(root, 'tools', 'strategy-counterexamples.json');
const fixtureSet = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed += 1;
    console.log('  ✓', message);
  } else {
    failed += 1;
    console.error('  ✗', message);
  }
}

function cardKey(card) {
  return `${Number(card.rank)}:${card.suit}:${Number(card.deckIndex)}`;
}

function fixtureCard(value) {
  return createCard(Number(value.rank), String(value.suit), Number(value.deckIndex));
}

function candidateKey(candidate) {
  if (candidate.action === 'pass') return 'pass';
  return `play:${candidate.cards.map(cardKey).sort().join(',')}`;
}

assert(fixtureSet.schema === 'guandan-strategy-counterexample-set-v1', 'STRAT-1 夹具集 schema 固定');
assert(fixtureSet.ruleVersion === STRATEGY_RULE_VERSION, 'STRAT-1 夹具集绑定规则版本');
const sensitiveProbe = {
  schema: STRATEGY_COUNTEREXAMPLE_SCHEMA,
  id: 'sensitive-probe',
  rule: 'STRAT-1',
  ruleVersion: STRATEGY_RULE_VERSION,
  sourceFingerprint: { sha256: fixtureSet.sourceFingerprint?.sha256 },
  observation: {
    hand: [{ rank: 7, suit: 'S', deckIndex: 0 }],
    publicHistory: [],
    opponentHands: [],
    undealtCards: [],
  },
  candidates: [{ action: 'pass', cards: [], signature: null, tags: [] }],
  expected: { invariants: ['probe'], preferredAction: 'pass', blockedActions: [] },
};
assert(validateStrategyCounterexample(sensitiveProbe).some((error) => error.includes('opponentHands')),
  'STRAT-1 observation 顶层白名单拒绝换名暗牌字段');
const declaredFiles = fixtureSet.sourceFingerprint?.files || [];
const actualFingerprint = fingerprintFiles(root, declaredFiles.map((item) => item.file));
assert(JSON.stringify(actualFingerprint) === JSON.stringify(fixtureSet.sourceFingerprint),
  'STRAT-1 源码文件列表、字节摘要和聚合摘要可独立复算');

for (const fixture of fixtureSet.fixtures || []) {
  const errors = validateStrategyCounterexample(fixture);
  assert(errors.length === 0, `${fixture.id} 只含脱敏公开观察且结构完整${errors.length ? `：${errors.join('；')}` : ''}`);
  assert(fixture.schema === STRATEGY_COUNTEREXAMPLE_SCHEMA
      && fixture.ruleVersion === STRATEGY_RULE_VERSION
      && fixture.sourceFingerprint?.sha256 === fixtureSet.sourceFingerprint.sha256,
  `${fixture.id} 绑定同一规则/实现摘要`);

  const observation = fixture.observation;
  const hand = observation.hand.map(fixtureCard);
  const latestPlay = observation.publicHistory.slice().reverse().find((event) => event.action === 'play');
  const lastCards = latestPlay?.cards?.map(fixtureCard)
    || (observation.lastHand?.type === 'single'
      ? [createCard(Number(observation.lastHand.mainRank), 'C', 0)] : []);
  const lastHand = lastCards.length ? parseHand(lastCards, observation.level) : null;
  const signal = assessPartnerTrickControl({
    ...observation,
    hand,
    lastHand,
    policyFeatures: { partnerTrickControl: true },
  });
  const expectsYield = fixture.expected.preferredAction === 'pass';
  assert(signal.shouldYield === expectsYield, `${fixture.id} 接风不变量与预期一致`);

  const legal = generateLegalPlays(hand, observation.level, lastHand);
  const legalKeys = new Set(legal.map((play) => `play:${play.cards.map(cardKey).sort().join(',')}`));
  if (lastHand) legalKeys.add('pass');
  assert(fixture.candidates.every((candidate) => candidate.action === 'pass'
    ? legalKeys.has('pass') : legalKeys.has(candidateKey(candidate))),
  `${fixture.id} 候选集全部能由当前规则合法生成`);
  assert(fixture.expected.blockedActions.every((key) => fixture.candidates.some(
    (candidate) => candidateKey(candidate) === key,
  )), `${fixture.id} 预期阻断动作均在夹具候选集中有明确记录`);
}

console.log(`\nSTRAT-1 counterexamples: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
