import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createCard } from '../js/cards.js';
import { generateLegalPlays, parseHand } from '../js/rules.js';
import {
  assessDownloadedEndgameIntercept, assessEnemyReportLead, assessPartnerTrickControl,
  isLowSingleLead,
} from '../js/strategy-core.js';
import { validateStrategyCounterexample } from './strategy_counterexamples.mjs';
import {
  EXTERNAL_COUNTEREXAMPLE_SET_SCHEMA,
  inventoryExternalSources,
  mineExternalStrategyCounterexamples,
} from './external_strategy_counterexamples.mjs';

const root = path.resolve(import.meta.dirname, '..');
const fixturePath = path.join(root, 'tools', 'external-strategy-counterexamples.json');

const inventory = inventoryExternalSources(root);
assert.equal(inventory.botzoneOfficialZip.available, false, 'Botzone 官方月度 ZIP 不可用');
assert.equal(inventory.botzoneOfficialZip.archivesAvailable, 0, 'Botzone 官方 ZIP archivesAvailable 必须为 0');
assert.equal(inventory.botzoneOfficialZip.ok, false);
assert.ok(inventory.njuptFairTurns > 0, '南邮公平轨迹必须有可挖掘回合');
assert.equal(inventory.usedProvider, 'njupt-game-ai-competition');
assert.equal(inventory.botzonePublicPages.usedForFixtures, false, '本 TASK 不把 Botzone 公开页当夹具源');

const mined = mineExternalStrategyCounterexamples(root);
assert.equal(mined.schema, EXTERNAL_COUNTEREXAMPLE_SET_SCHEMA);
assert.equal(mined.trainingEligible, false);
assert.equal(mined.inventory.botzoneOfficialZip.available, false);
assert.ok(!JSON.stringify(mined).includes('"trainingEligible":true'));
assert.ok(mined.fixtures.length >= 3, '至少三类可回归反例');
const rules = new Set(mined.fixtures.map((item) => item.rule));
assert.ok(rules.has('AI-DATA-001-enemy-report-lead'), '含报单送低单信号');
assert.ok(rules.has('AI-DATA-001-partner-trick-control'), '含接风被抢信号');
assert.ok(rules.has('AI-DATA-001-endgame-intercept'), '含残局过牌可拦截信号');

const disk = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
assert.equal(disk.schema, EXTERNAL_COUNTEREXAMPLE_SET_SCHEMA);
assert.equal(disk.trainingEligible, false);

for (const fixture of mined.fixtures) {
  const errors = validateStrategyCounterexample(fixture);
  assert.equal(errors.length, 0, `${fixture.id} 校验：${errors.join('；')}`);
  assert.equal(fixture.source.provider, 'njupt-game-ai-competition');
  assert.equal(fixture.source.trainingEligible, false);
  const packed = JSON.stringify(fixture);
  assert.ok(!/"id"\s*:\s*"[A-Z]\d/.test(packed) && !packed.includes('opponentHands') && !packed.includes('undealtCards') && !packed.includes('initialHands'));
  const observation = fixture.observation;
  const hand = observation.hand.map((card) => createCard(Number(card.rank), String(card.suit), Number(card.deckIndex)));
  const latestPlay = observation.publicHistory.slice().reverse().find((event) => event.action === 'play');
  const lastCards = latestPlay?.cards?.map((card) => createCard(Number(card.rank), String(card.suit), Number(card.deckIndex))) || [];
  const lastHand = lastCards.length ? parseHand(lastCards, observation.level) : null;
  const ctx = {
    ...observation,
    hand,
    lastHand,
    policyFeatures: { enemyReportLeadSafety: true, partnerTrickControl: true },
    mode: lastHand ? 'beat' : 'lead',
  };
  const legal = generateLegalPlays(hand, observation.level, lastHand);
  const legalKeys = new Set(legal.map((play) => `play:${play.cards.map((card) => `${card.rank}:${card.suit}:${card.deckIndex}`).sort().join(',')}`));
  if (lastHand) legalKeys.add('pass');
  assert.ok(fixture.candidates.every((candidate) => (
    candidate.action === 'pass' ? legalKeys.has('pass')
      : legalKeys.has(`play:${candidate.cards.map((card) => `${card.rank}:${card.suit}:${card.deckIndex}`).sort().join(',')}`)
  )), `${fixture.id} 候选均合法`);
  if (fixture.rule === 'AI-DATA-001-partner-trick-control') {
    assert.equal(assessPartnerTrickControl(ctx).shouldYield, true, `${fixture.id} 接风门应命中`);
    assert.equal(fixture.expected.preferredAction, 'pass');
  }
  if (fixture.rule === 'AI-DATA-001-endgame-intercept') {
    const ctxEnd = {
      ...ctx,
      policyFeatures: { downloadedEndgameGuards: true },
    };
    const withPass = [
      { action: 'pass', cards: [], hand: null },
      ...legal.map((play) => ({ action: 'play', ...play })),
    ];
    assert.equal(assessDownloadedEndgameIntercept(ctxEnd, withPass).blocked, true,
      `${fixture.id} 残局过牌应被拦截`);
    assert.equal(fixture.expected.blockedActions.includes('pass'), true,
      `${fixture.id} 阻断过牌`);
  }
  if (fixture.rule === 'AI-DATA-001-enemy-report-lead') {
    const chosen = fixture.candidates.find((candidate) => candidate.action === 'play' && isLowSingleLead({
      hand: parseHand(candidate.cards.map((card) => createCard(card.rank, card.suit, card.deckIndex)), observation.level),
      cards: candidate.cards.map((card) => createCard(card.rank, card.suit, card.deckIndex)),
    }, observation.level));
    assert.ok(chosen, `${fixture.id} 必须包含被阻断的低单`);
    const legalPlays = legal.map((play) => ({ action: 'play', ...play }));
    assert.equal(assessEnemyReportLead({
      action: 'play',
      cards: chosen.cards.map((card) => createCard(card.rank, card.suit, card.deckIndex)),
      hand: parseHand(chosen.cards.map((card) => createCard(card.rank, card.suit, card.deckIndex)), observation.level),
    }, ctx, legalPlays).blocked, true, `${fixture.id} 报单低单应被 STRAT-3 信号阻断`);
  }
}

console.log('external strategy counterexamples tests passed');
