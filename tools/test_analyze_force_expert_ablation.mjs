#!/usr/bin/env node
/** Regression: fxe accepts only a complete, paired v3 checkpoint contract. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveHybridSearchConfig } from '../js/ai.js';
import { sha256Canonical } from '../js/ai.ab.provenance.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tool = path.join(root, 'tools', 'analyze_force_expert_ablation.mjs');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'guandan-fxe-gate-'));

try {
  const normalPath = path.join(temporary, 'normal.json');
  const forcedPath = path.join(temporary, 'forced.json');
  const normal = checkpoint('ismcts-v3', 1, 1);
  const forced = checkpoint('ismcts-v3-fxe', 0, 1);
  write(normalPath, normal);
  write(forcedPath, forced);

  let receipt = run(normalPath, forcedPath);
  assert.equal(receipt.mechanicalGates.pass, true,
    '完整 v3、严格专家等价和逐对象改选计数均通过时才允许归因');
  assert.equal(receipt.causalInferenceEligible, true,
    '通过机械门后才可解释区组差值');
  assert.equal(receipt.verdict, 'changed_decisions_net_positive',
    '正 CI 在合格对照下可标记为正向归因');

  const rejectCases = [
    ['legacy v1', (value) => { value.schema = 'guandan-ai-ab-checkpoint-v1'; }],
    ['legacy v2', (value) => { value.schema = 'guandan-ai-ab-checkpoint-v2'; }],
    ['implementation summary missing', (value) => {
      delete value.signaturePayload.evaluationImplementationSha256;
      refreshSignature(value);
    }],
    ['opponent mode missing', (value) => {
      delete value.signaturePayload.evaluationOpponentModelMode;
      refreshSignature(value);
    }],
    ['opponent mode inconsistent', (value) => {
      value.signaturePayload.evaluationOpponentModelMode = 'adaptive';
      refreshSignature(value);
    }],
    ['search config missing', (value) => {
      delete value.signaturePayload.candidateSearchConfig;
      refreshSignature(value);
    }],
    ['search config tampered', (value) => {
      value.signaturePayload.candidateSearchConfig.nodeBudget = 1;
      refreshSignature(value);
    }],
    ['pair duplicate', (value) => {
      value.pairs.push(structuredClone(value.pairs[0]));
      refreshIntegrity(value);
    }],
    ['game missing', (value) => {
      value.games.pop();
      refreshIntegrity(value);
    }],
    ['game duplicate', (value) => {
      value.games[1].candidateTeam = 0;
      refreshIntegrity(value);
    }],
    ['changed missing', (value) => {
      delete value.games[0].hybrid.changed;
      refreshIntegrity(value);
    }],
    ['wouldChange missing', (value) => {
      delete value.games[0].hybrid.wouldChange;
      refreshIntegrity(value);
    }],
    ['deal fingerprint missing', (value) => {
      value.games[0].dealFingerprint = '';
      refreshIntegrity(value);
    }],
    ['first player missing', (value) => {
      delete value.games[0].firstPlayer;
      refreshIntegrity(value);
    }],
    ['provenance chain broken', (value) => {
      value.provenance.runSegments[0].endBlockIndex = 0;
      refreshProvenance(value);
      refreshIntegrity(value);
    }],
    ['checkpoint integrity tampered', (value) => {
      value.checkpointIntegrity.sha256 = '0'.repeat(64);
    }],
  ];
  for (const [label, mutate] of rejectCases) {
    const candidate = structuredClone(normal);
    mutate(candidate);
    const candidatePath = path.join(temporary, `${label.replaceAll(' ', '-')}.json`);
    write(candidatePath, candidate);
    assertRejected(candidatePath, forcedPath, label);
  }

  // Structural validation of each arm precedes cross-arm comparison.  This
  // case updates the affected pair's own fields and integrity so it reaches
  // the object-level mirror gate instead of failing only on a stale hash.
  const mismatchedDeal = structuredClone(forced);
  for (const game of mismatchedDeal.games) game.dealFingerprint = 'different-deal';
  mismatchedDeal.pairs[0].dealFingerprint = 'different-deal';
  refreshIntegrity(mismatchedDeal);
  const mismatchedDealPath = path.join(temporary, 'mismatched-deal.json');
  write(mismatchedDealPath, mismatchedDeal);
  assertRejected(mismatchedDealPath, normalPath, 'cross-arm deal mismatch');

  const mismatchedFirstPlayer = structuredClone(forced);
  for (const game of mismatchedFirstPlayer.games) game.firstPlayer = 1;
  refreshIntegrity(mismatchedFirstPlayer);
  const mismatchedFirstPlayerPath = path.join(temporary, 'mismatched-first-player.json');
  write(mismatchedFirstPlayerPath, mismatchedFirstPlayer);
  assertRejected(mismatchedFirstPlayerPath, normalPath, 'cross-arm first-player mismatch');

  const mismatchedImplementation = structuredClone(forced);
  mismatchedImplementation.signaturePayload.evaluationImplementationSha256 = 'c'.repeat(64);
  refreshSignature(mismatchedImplementation);
  const mismatchedImplementationPath = path.join(temporary, 'mismatched-implementation.json');
  write(mismatchedImplementationPath, mismatchedImplementation);
  assertRejected(mismatchedImplementationPath, normalPath, 'cross-arm implementation mismatch');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

console.log('force-expert v3 contract gate: OK');

function run(normalPath, forcedPath) {
  const outPath = path.join(temporary, 'accepted-receipt.json');
  const result = spawnSync(process.execPath, [
    tool, '--normal', normalPath, '--forced', forcedPath, '--out', outPath,
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `有效 v3 checkpoint 应输出回执：${result.stderr}`);
  assert.equal(fs.existsSync(outPath), true, '有效输入应写出回执');
  return JSON.parse(result.stdout);
}

function assertRejected(normalPath, forcedPath, label) {
  const outPath = path.join(temporary, `${label.replaceAll(' ', '-')}-out.json`);
  const result = spawnSync(process.execPath, [
    tool, '--normal', normalPath, '--forced', forcedPath, '--out', outPath,
  ], { cwd: root, encoding: 'utf8' });
  assert.notEqual(result.status, 0, `${label} 必须在 bootstrap 前以非零退出`);
  assert.equal(fs.existsSync(outPath), false, `${label} 拒绝时不得写出 out`);
}

function write(file, value) {
  fs.writeFileSync(file, JSON.stringify(value), 'utf8');
}

function signaturePayload(candidate) {
  return {
    groupCount: 1,
    baseSeed: 20265101,
    candidate,
    comparison: 'expert',
    evaluationLevels: [2],
    levelBlockDesign: true,
    continuousMatch: false,
    evaluationOpponentModelMode: 'off',
    valueModelSha256: null,
    evaluationImplementationSha256: 'a'.repeat(64),
    hybridEngineVersion: 1,
    candidateSearchConfig: resolveHybridSearchConfig('ismcts-v3', {
      deterministic: true,
      timeBudgetMs: 0,
    }),
  };
}

function fixtureEnvironment() {
  const payload = {
    schema: 'guandan-evaluation-environment-v1',
    machine: {
      hostnameSha256: 'b'.repeat(64),
      platform: 'fixture',
      release: 'fixture-release',
      arch: 'fixture-arch',
      cpuModel: 'fixture-cpu',
      logicalCores: 8,
      memoryBytes: 1024 * 1024 * 1024,
    },
    runtime: { node: 'v24.14.0', v8: 'fixture-v8' },
  };
  return { ...payload, environmentSha256: sha256Canonical(payload) };
}

function fixtureProvenance() {
  const evaluationId = '11111111-1111-4111-8111-111111111111';
  const runSegment = {
    schema: 'guandan-evaluation-run-segment-v1',
    evaluationId,
    runSegmentId: '22222222-2222-4222-8222-222222222222',
    ordinal: 1,
    resume: false,
    previousRunSegmentId: null,
    inputCheckpointSha256: null,
    startBlockIndex: 0,
    endBlockIndex: 1,
    startedAt: '2026-08-31T00:00:00.000Z',
    completedAt: '2026-08-31T00:01:00.000Z',
    process: { pid: 1234, ppid: 1 },
    environment: fixtureEnvironment(),
  };
  return {
    schema: 'guandan-evaluation-provenance-v1',
    evaluationId,
    runSegments: [runSegment],
    runSegmentsSha256: sha256Canonical([runSegment]),
  };
}

function telemetry(candidate, candidateTeam, seat) {
  const candidateSeat = [0, 2].includes(seat) ? 0 : 1;
  const policy = candidateSeat === candidateTeam ? candidate : 'expert';
  return {
    seat,
    policy,
    engine: policy,
    variantPresent: true,
    localDecisionPresent: true,
    searchTelemetryPresent: true,
    fallbackKindPresent: true,
    telemetryComplete: true,
    latencyMs: 1,
    source: 'fixture',
    fallbackKind: 'none',
    fallbackEvaluable: true,
    timeoutFallback: false,
    searchAttempted: false,
    searchTriggered: false,
    candidates: 0,
    samples: 0,
    nodes: 0,
    iterations: 0,
    rolloutBudget: 0,
    sweepBudget: 0,
    pairedSweeps: 0,
  };
}

function hybrid(candidate, changed, wouldChange) {
  return {
    turns: 1,
    applied: 1,
    changed,
    samples: 1,
    nodes: 1,
    iterations: 1,
    forceExpert: candidate === 'ismcts-v3-fxe' ? 1 : 0,
    wouldChange,
    searchModes: { 'ismcts-v3': 1 },
    reasons: { completed: 1 },
    rejected: {},
  };
}

function game(candidate, candidateTeam, utility, changed, wouldChange, runSegmentId) {
  const candidateHead = utility > 0;
  return {
    ok: true,
    seed: 20265101,
    level: 2,
    candidateTeam,
    order: candidateHead
      ? (candidateTeam === 0 ? [0, 2, 1, 3] : [1, 3, 0, 2])
      : (candidateTeam === 0 ? [1, 3, 0, 2] : [0, 2, 1, 3]),
    firstPlayer: 0,
    dealFingerprint: 'fixture-deal',
    upgrade: 1,
    utility,
    candidateHead,
    comparisonHead: !candidateHead,
    baselineHead: !candidateHead,
    candidateDoubleUp: false,
    comparisonDoubleUp: false,
    baselineDoubleUp: false,
    firstDivergence: null,
    hybrid: hybrid(candidate, changed, wouldChange),
    decisionTelemetry: [telemetry(candidate, candidateTeam, candidateTeam === 0 ? 0 : 1)],
    actions: 1,
    durationMs: 1,
    runSegmentId,
  };
}

function checkpoint(candidate, utility, changed) {
  const signature = signaturePayload(candidate);
  const runSegmentId = '22222222-2222-4222-8222-222222222222';
  const games = candidate === 'ismcts-v3'
    ? [
      game(candidate, 0, utility, changed, changed, runSegmentId),
      game(candidate, 1, utility, 0, 0, runSegmentId),
    ]
    : [
      game(candidate, 0, 1, 0, changed, runSegmentId),
      game(candidate, 1, -1, 0, 0, runSegmentId),
    ];
  const orders = games.map((item) => item.order);
  const divergences = games.map((item) => item.firstDivergence);
  const checkpoint = {
    schema: 'guandan-ai-ab-checkpoint-v3',
    signature: JSON.stringify(signature),
    signaturePayload: signature,
    nextBlockIndex: 1,
    complete: true,
    provenance: fixtureProvenance(),
    games,
    pairs: [{
      group: 1,
      block: 1,
      seed: 20265101,
      level: 2,
      runSegmentId,
      mirrorMatched: true,
      crossLevelMatched: true,
      dealFingerprint: 'fixture-deal',
      complete: true,
      utility: candidate === 'ismcts-v3' ? utility : 0,
      candidateHeads: candidate === 'ismcts-v3' ? 2 : 1,
      candidateDoubleUps: 0,
      comparisonDoubleUps: 0,
      orders,
      firstDivergences: divergences,
    }],
    failures: [],
  };
  return refreshIntegrity(checkpoint);
}

function refreshSignature(value) {
  value.signature = JSON.stringify(value.signaturePayload);
  refreshIntegrity(value);
  return value;
}

function checkpointContent(value) {
  return {
    schema: value.schema,
    signature: value.signature,
    signaturePayload: value.signaturePayload,
    nextBlockIndex: value.nextBlockIndex,
    complete: value.complete,
    provenance: value.provenance,
    games: value.games,
    pairs: value.pairs,
    failures: value.failures,
  };
}

function refreshIntegrity(value) {
  value.checkpointIntegrity = {
    schema: 'sha256-v1',
    sha256: createHash('sha256').update(JSON.stringify(checkpointContent(value))).digest('hex'),
  };
  return value;
}

function refreshProvenance(value) {
  value.provenance.runSegmentsSha256 = sha256Canonical(value.provenance.runSegments);
  return value;
}
