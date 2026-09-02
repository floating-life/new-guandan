import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCard } from '../js/cards.js';
import {
  createMatch, humanSelectSet, humanPlay, setReplayEventObserver, PHASE,
} from '../js/game.js';
import { getSealedTrainingBatch } from '../js/sealed-training.js';
import {
  SealedTrainingConverterError,
  assertSafeOutputDirectory,
  convertSealedTrainingFile,
} from './sealed_training_converter.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function C(rank, suit = 'S', deck = 0) {
  return createCard(rank, suit, deck);
}

function finishingState() {
  const state = createMatch({ difficulty: 'easy', aiSpeed: 'fast', coachMode: false });
  state.matchId = 'sealed-converter-match';
  state.round = 1;
  state.phase = PHASE.PLAYING;
  state.currentLevel = 2;
  state.currentSeat = 0;
  state.finishOrder = [2];
  state.trickLog = [];
  state.trickNumber = 1;
  state.lastHand = null;
  state.lastSeat = null;
  state.hands = [[C(4)], [C(8), C(9)], [], [C(10), C(11)]];
  state.handCounts = state.hands.map((hand) => hand.length);
  return state;
}

function captureBatch() {
  const state = finishingState();
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = () => 0;
  try {
    setReplayEventObserver(() => {});
    humanSelectSet(state, [state.hands[0][0].id]);
    humanPlay(state);
    setReplayEventObserver(null);
    return getSealedTrainingBatch(state);
  } finally {
    setReplayEventObserver(null);
    globalThis.setTimeout = realSetTimeout;
  }
}

const batch = captureBatch();
assert.equal(batch?.trainingEligible, false, 'captured batch stays ineligible');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guandan-sealed-'));
const inputPath = path.join(tempRoot, 'batches.ndjson');
const outputDir = path.join(tempRoot, 'out');
fs.writeFileSync(inputPath, `${JSON.stringify(batch)}\n${JSON.stringify(batch)}\n`, 'utf8');

const result = convertSealedTrainingFile({ inputPath, outputDir });
assert.equal(result.ok, true);
assert.equal(result.trainingEligible, false);
assert.equal(result.manifest.trainingEligible, false);
assert.equal(result.manifest.acceptedMatchRounds, 1);
assert.equal(result.manifest.duplicateCount, 1);

const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
assert.equal(manifest.trainingEligible, false);
assert.equal(manifest.labelPolicy, 'trajectory_only_no_counterfactual');

const splitName = Object.entries(manifest.splits).find(([, count]) => count === 1)[0];
const splitRows = fs.readFileSync(path.join(outputDir, `${splitName}.ndjson`), 'utf8')
  .trim()
  .split(/\n/);
assert.equal(splitRows.length, 1);
const written = JSON.parse(splitRows[0]);
assert.equal(written.trainingEligible, false);
assert.equal(written.split, splitName);
assert.ok(written.turns.every((turn) => (
  turn.trainingEligible === false
  && !('reward' in turn)
  && !('outcome' in turn)
  && turn.legalCandidates.every((item) => !('reward' in item) && !('chosen' in item))
)));

assert.throws(
  () => assertSafeOutputDirectory(path.join(PROJECT_ROOT, 'data', 'sealed-training')),
  (error) => error instanceof SealedTrainingConverterError && error.code === 'unsafe_path',
);
assert.throws(
  () => assertSafeOutputDirectory(path.join(os.tmpdir(), 'GuandanTrainer', 'replays', 'sealed')),
  (error) => error instanceof SealedTrainingConverterError && error.code === 'unsafe_path',
);

const badInput = path.join(tempRoot, 'eligible.ndjson');
fs.writeFileSync(badInput, `${JSON.stringify({ ...batch, trainingEligible: true })}\n`, 'utf8');
const badOutput = path.join(tempRoot, 'bad-out');
assert.throws(
  () => convertSealedTrainingFile({ inputPath: badInput, outputDir: badOutput }),
  (error) => error instanceof SealedTrainingConverterError && error.code === 'convert_failed',
);
assert.equal(fs.existsSync(path.join(badOutput, 'manifest.json')), false, '失败时不写切分产物');

console.log('sealed training converter: 8 passed');
