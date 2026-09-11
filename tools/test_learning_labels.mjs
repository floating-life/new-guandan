import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDeck } from '../js/cards.js';
import { parseHand, handSignature } from '../js/rules.js';
import { chooseAIPlay } from '../js/ai.js';
import { buildLearningCandidates } from '../js/ai-learning.js';
import * as hybrid from '../js/ai-hybrid.js';

assert.equal(typeof hybrid.evaluateLearningTeacherCandidates, 'function',
  'offline teacher must evaluate noncritical positions without changing the online gate');
const deck = createDeck();
const context = {
  seat: 0, hand: deck.slice(0, 27), level: 2, lastHand: null, lastSeat: null,
  handCounts: [27, 27, 27, 27], teams: [0, 1, 0, 1], finishOrder: [],
  playedCards: [], publicHistory: [], difficulty: 'master', deterministic: true,
  decisionEngine: 'expert', opponentModelMode: 'off', timeBudgetMs: 0,
};
const expert = chooseAIPlay(context);
const candidates = buildLearningCandidates(context, expert).slice(0, 3);
assert(candidates.length >= 2);
assert.equal(hybrid.evaluateInformationSetCandidates(context, candidates).reason, 'not_critical');
const options = { worlds: 2, maxPlies: 4, seed: 3500000000 };
const estimate = hybrid.evaluateLearningTeacherCandidates(context, candidates, options);
assert.equal(estimate.ok, true);
assert.equal(estimate.labelKind, 'teacher_estimate');
assert(estimate.candidateResults.every(r => r.completedSamples === 2 && Number.isFinite(r.utility)));
const reversed = hybrid.evaluateLearningTeacherCandidates(context, candidates.slice().reverse(), options);
const values = r => Object.fromEntries(r.candidateResults.map(c => [c.candidateId, c.utility]));
assert.deepEqual(values(estimate), values(reversed), 'candidate order cannot alter shared-world labels');
assert.equal(hybrid.evaluateInformationSetCandidates(context, candidates).reason, 'not_critical');
const hidden = hybrid.evaluateLearningTeacherCandidates({ ...context, hands: [['secret']] }, candidates, options);
assert.deepEqual(values(estimate), values(hidden), 'hidden fields cannot affect the teacher');
assert.throws(() => hybrid.evaluateLearningTeacherCandidates(context, candidates, { worlds: 0 }), /worlds/);

const own = deck.find(c => c.rank === 14 && c.suit === 'S' && c.deckIndex === 0);
const other = deck.filter(c => c.rank === 6 && c.suit === 'C');
const remain = new Set([own.id, ...other.map(c => c.id)]);
const last = deck.find(c => c.rank === 3 && c.suit === 'D');
const terminal = {
  ...context, hand: [own], handCounts: [1, 1, 0, 1], finishOrder: [2],
  playedCards: deck.filter(c => !remain.has(c.id)), lastHand: parseHand([last], 2), lastSeat: 1,
};
const finish = { id: 'finish', action: 'play', cards: [own], hand: parseHand([own], 2) };
finish.signature = handSignature(finish.hand);
const result = hybrid.evaluateLearningTeacherCandidates(terminal,
  [finish, { id: 'pass', action: 'pass', cards: [], hand: null }], { worlds: 2, maxPlies: 4 });
assert.equal(result.ok, true);
assert.equal(result.candidateResults.find(c => c.candidateId === 'finish').utility, 3,
  'finishing directly behind partner gives the exact double-up utility');
assert.equal(result.candidateResults.find(c => c.candidateId === 'finish').terminalCount, 2);
console.log('learning teacher behavior: OK');

const labels = await import('./learning_labels.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
assert.equal(typeof labels.selectLearningStates, 'function', 'streaming selection must preserve deal-group splits');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-label-test-'));
try {
  const gamePlan = [
    { game: 1, dealGroupId: 'train-group', derivedGameId: 'train-l2-r0', baseSeed: 3100000015, level: 2, rotation: 0, split: 'train' },
    { game: 2, dealGroupId: 'validation-group', derivedGameId: 'validation-l2-r0', baseSeed: 3100000016, level: 2, rotation: 0, split: 'validation' },
  ];
  const rows = gamePlan.flatMap(p => Array.from({ length: 4 }, (_, i) => ({
    schema: 'guandan-selfplay-trajectory-v3', ...p, turn: i + 1, seat: 0,
    observation: context,
  })));
  const header = { schema: 'guandan-selfplay-trajectory-v3-header', dealBlocks: 2,
    games: 2, rounds: 2, levels: [2], rotations: [0], recordCount: rows.length, gamePlan,
    seedManifest: { schema: 'guandan-seed-manifest-v1', seeds: [3100000015, 3100000016] } };
  const dataset = path.join(temp, 'synthetic.jsonl');
  const write = data => fs.writeFileSync(dataset, [JSON.stringify(header), ...data.map(JSON.stringify)].join('\n') + '\n');
  write(rows);
  const selection = await labels.selectLearningStates(dataset, { statesPerLevel: 4 });
  assert.equal(selection.states.length, 4);
  assert.equal(selection.states.filter(s => s.split === 'train').length, 2);
  assert.equal(selection.states.filter(s => s.split === 'validation').length, 2);
  const ids = selection.states.map(s => s.stateId).sort();
  write(rows.slice().reverse());
  assert.deepEqual((await labels.selectLearningStates(dataset, { statesPerLevel: 4 })).states.map(s => s.stateId).sort(), ids);
  write([rows[0], rows[0], ...rows.slice(2)]);
  await assert.rejects(labels.selectLearningStates(dataset, { statesPerLevel: 4 }), /duplicate/);
  write(rows.map((r, i) => i === 0 ? { ...r, split: 'validation' } : r));
  await assert.rejects(labels.selectLearningStates(dataset, { statesPerLevel: 4 }), /plan|split/);
  write(rows);
  await assert.rejects(labels.selectLearningStates(dataset, { statesPerLevel: 20 }), /insufficient/);
  const output = path.join(temp, 'labels.jsonl');
  const made = await labels.generateLearningLabels({ dataset, output, statesPerLevel: 4, worlds: 2, maxPlies: 4, worldSeed: 3500000000 });
  assert.equal(made.states, 4);
  const outputRows = fs.readFileSync(output, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(outputRows[0].schema, 'guandan-learning-labels-v1-header');
  assert(outputRows.slice(1).every(r => r.labelKind === 'teacher_estimate' && r.features.length === 32 && Number.isFinite(r.teacherValue)));
  assert.equal(new Set(outputRows.slice(1).map(r => r.stateId + '/' + r.candidateId)).size, made.labels);
  const original = fs.readFileSync(output);
  await assert.rejects(labels.generateLearningLabels({ dataset, output, statesPerLevel: 4 }), /exists/);
  assert.deepEqual(fs.readFileSync(output), original);
  assert.equal(typeof labels.reencodeLearningLabels, 'function', 'verified feature re-encoding must preserve existing rollout labels');
  const snapshot = path.join(temp, 'base-runtime');
  fs.cpSync(path.resolve('js'), path.join(snapshot, 'js'), { recursive: true });
  fs.mkdirSync(path.join(snapshot, 'tools'), { recursive: true });
  fs.copyFileSync(path.resolve('tools/learning_labels.mjs'), path.join(snapshot, 'tools/learning_labels.mjs'));
  const enrichedPath = path.join(temp, 'context.jsonl');
  const enriched = await labels.reencodeLearningLabels({ dataset, labels: output, output: enrichedPath, baseRuntime: snapshot });
  assert.equal(enriched.labels, made.labels);
  const encodedRows = fs.readFileSync(enrichedPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(encodedRows[0].featureEncoder.engine, 'learned-context-v1');
  assert.deepEqual(encodedRows.slice(1).map(r => r.teacherValue), outputRows.slice(1).map(r => r.teacherValue));
  assert(encodedRows.slice(1).some(r => r.features[5] !== 0));
  assert.deepEqual(fs.readFileSync(output), original);
  console.log('learning selection and label pipeline: OK');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
