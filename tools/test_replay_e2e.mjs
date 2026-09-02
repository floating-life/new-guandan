/**
 * RT-6: real HTTP public-event round, dual consumers, sealed isolation,
 * and trainer rejection of unapproved batches.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCard } from '../js/cards.js';
import {
  createMatch, humanSelectSet, humanPlay, setReplayEventObserver, PHASE,
} from '../js/game.js';
import {
  convertSealedTrainingBatches,
  getSealedTrainingBatch,
} from '../js/sealed-training.js';
import { consumeOnce } from './replay_consumer.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'e'.repeat(40);

function C(rank, suit = 'S', deck = 0) {
  return createCard(rank, suit, deck);
}

function finishingRound() {
  const events = [];
  const state = createMatch({ difficulty: 'easy', aiSpeed: 'fast', coachMode: false });
  state.matchId = 'rt6-http-match';
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
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = () => 0;
  try {
    setReplayEventObserver((event) => events.push(event));
    humanSelectSet(state, [state.hands[0][0].id]);
    const result = humanPlay(state);
    setReplayEventObserver(null);
    assert.equal(result.ok, true);
    assert.ok(['round_end', 'match_end'].includes(state.phase) || state.phase === PHASE.ROUND_END);
    return { events, batch: getSealedTrainingBatch(state) };
  } finally {
    setReplayEventObserver(null);
    globalThis.setTimeout = realSetTimeout;
  }
}

function noDarkFields(event) {
  const forbidden = [
    'hands', 'deck', 'initialHands', 'remainingHands', 'allHands',
    'legalCandidates', 'trainingEligible', 'roundInitialHands',
  ];
  assert.ok(forbidden.every((key) => !(key in event)));
  assert.ok((event.cards || []).every((card) => !('id' in card) && !('deckIndex' in card)));
}

async function waitForPort(child) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('e2e harness did not bind a port')), 8000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const line = buffer.split(/\r?\n/).find((item) => item.startsWith('{'));
      if (!line) return;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(error);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (chunk.includes('missing replay')) reject(new Error(chunk.trim()));
    });
    child.on('exit', (code) => {
      if (code) reject(new Error(`e2e harness exited ${code}`));
    });
  });
}

function trainerRejects(batch) {
  const script = `
import json, sys
from pathlib import Path
sys.path.insert(0, r${JSON.stringify(PROJECT_ROOT)})
from training.guandan_env_contract import validate_dataset_manifest
payload = json.loads(sys.stdin.read())
result = validate_dataset_manifest(payload)
print(result.reason)
raise SystemExit(0 if (not result.ok and result.reason == "dataset_not_fair_selfplay") else 1)
`;
  const input = JSON.stringify({
    source: 'human-replay-sealed',
    trainingEligible: batch.trainingEligible,
    sha256: 'a'.repeat(64),
    seedManifest: [1],
  });
  const result = spawnSync('python', ['-c', script], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    input,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /dataset_not_fair_selfplay/);
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'guandan-rt6-'));
const replayRoot = path.join(temporary, 'replays');
fs.mkdirSync(replayRoot, { recursive: true });
const child = spawn('python', ['-u', '-X', 'utf8', path.join(PROJECT_ROOT, 'tools', 'replay_e2e_harness.py')], {
  cwd: PROJECT_ROOT,
  env: {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
    GUANDAN_REPLAY_CAPABILITY: TOKEN,
    GUANDAN_REPLAY_ROOT: replayRoot,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

try {
  const started = await waitForPort(child);
  assert.equal(started.ok, true);
  const endpoint = `http://127.0.0.1:${started.port}/api/replay/events`;
  const { events, batch } = finishingRound();
  assert.ok(events.length >= 3, '完整一副至少发出 play/trick_end/round_end');
  assert.ok(batch && batch.trainingEligible === false);
  events.forEach(noDarkFields);

  for (const event of events) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
    });
    assert.equal(response.ok, true, `POST ${event.eventType} HTTP ${response.status}`);
    const ack = await response.json();
    assert.equal(ack.ok, true);
    assert.equal(ack.eventId, event.eventId);
  }

  const firstDir = path.join(temporary, 'consumer-a');
  const secondDir = path.join(temporary, 'consumer-b');
  fs.mkdirSync(firstDir, { recursive: true });
  fs.mkdirSync(secondDir, { recursive: true });
  const first = await consumeOnce({
    endpoint,
    token: TOKEN,
    cursorPath: path.join(firstDir, 'cursor.json'),
    annotationPath: path.join(firstDir, 'annotations.ndjson'),
    limit: 2,
  });
  assert.equal(first.cursor.sequence, 1);
  assert.equal(first.hasMore, true);
  fs.copyFileSync(path.join(firstDir, 'cursor.json'), path.join(secondDir, 'cursor.json'));
  const second = await consumeOnce({
    endpoint,
    token: TOKEN,
    cursorPath: path.join(secondDir, 'cursor.json'),
    annotationPath: path.join(secondDir, 'annotations.ndjson'),
    limit: 32,
  });
  assert.equal(second.cursor.sequence, events.length - 1);
  assert.equal(second.hasMore, false);
  const converted = convertSealedTrainingBatches([batch]);
  assert.equal(converted.ok, true);
  assert.equal(converted.manifest.trainingEligible, false);
  trainerRejects(batch);

  const status = await (await fetch(`http://127.0.0.1:${started.port}/api/replay/status`)).json();
  assert.equal(status.ok, true);
  assert.equal(status.collector.enabled, true);
  assert.equal(status.collector.lastSequence, events.length - 1);
  assert.equal(status.collector.readerConnected, true);
  assert.ok(!JSON.stringify(status).includes(TOKEN));

  console.log(`replay e2e: HTTP ${events.length} events, dual consumers, sealed reject OK`);
} finally {
  child.kill();
}
