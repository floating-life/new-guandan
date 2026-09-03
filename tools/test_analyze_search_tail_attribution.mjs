#!/usr/bin/env node
/** Synthetic regression for historical search-tail attribution. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const analyzer = path.join(root, 'tools', 'analyze_search_tail_attribution.mjs');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'guandan-search-tail-'));

try {
  const overhead = buildFixture({
    mode: 'overhead',
  });
  const overheadReport = path.join(temporary, 'overhead-report.json');
  const overheadCheckpoint = path.join(temporary, 'overhead-checkpoint.json');
  write(overheadReport, overhead.report);
  write(overheadCheckpoint, overhead.checkpoint);

  let result = run(overheadReport, overheadCheckpoint);
  assert.equal(result.status, 0, `同规模变慢夹具应成功：${result.stderr}`);
  const attributed = JSON.parse(result.stdout);
  assert.equal(attributed.schema, 'guandan-ai-search-tail-attribution-v1');
  assert.equal(attributed.evidenceClass, 'historical_diagnostic');
  assert.equal(attributed.computationStatus, 'ok');
  assert.equal(attributed.formalGateEligible, false);
  assert.equal(Object.prototype.hasOwnProperty.call(attributed, 'pass'), false,
    '历史归因不得输出含义模糊的 pass');
  assert.equal(attributed.hypotheses.heavierLaterTrees.status, 'contradicted');
  assert.equal(attributed.hypotheses.laterBlockOverhead.status, 'supported');
  assert.equal(attributed.hypotheses.searchSizeExplainsTail.status, 'contradicted');
  assert.equal(attributed.hypotheses.freshVsResume.status, 'untestable');
  assert.equal(attributed.rootCause.perf3SearchHotspotOptimizationEligible, false);
  assert.equal(attributed.rootCause.perf3CheckpointStreamingEligible, false);
  assert.ok(attributed.rootCause.locked.includes('laterBlockOverhead'));
  assert.ok(attributed.rootCause.contradicted.includes('heavierLaterTrees'));

  const outPath = path.join(temporary, 'attribution.json');
  result = run(overheadReport, overheadCheckpoint, outPath);
  assert.equal(result.status, 0, '指定 --out 时仍应成功');
  assert.deepEqual(read(outPath), attributed, '标准输出与 --out 载荷必须一致');

  const heavier = buildFixture({ mode: 'heavier' });
  const heavierReport = path.join(temporary, 'heavier-report.json');
  const heavierCheckpoint = path.join(temporary, 'heavier-checkpoint.json');
  write(heavierReport, heavier.report);
  write(heavierCheckpoint, heavier.checkpoint);
  result = run(heavierReport, heavierCheckpoint);
  assert.equal(result.status, 0, `更大树夹具应成功：${result.stderr || result.stdout}`);
  const heavierAttributed = JSON.parse(result.stdout);
  assert.equal(heavierAttributed.formalGateEligible, false);
  assert.equal(heavierAttributed.hypotheses.heavierLaterTrees.status, 'supported');
  assert.equal(heavierAttributed.hypotheses.laterBlockOverhead.status, 'contradicted');

  const short = buildFixture({ mode: 'overhead', blocks: 20 });
  const shortReport = path.join(temporary, 'short-report.json');
  const shortCheckpoint = path.join(temporary, 'short-checkpoint.json');
  write(shortReport, short.report);
  write(shortCheckpoint, short.checkpoint);
  result = run(shortReport, shortCheckpoint);
  assert.equal(result.status, 0, '不足 61 区组的夹具仍应成功但 overhead 不可测');
  const shortAttributed = JSON.parse(result.stdout);
  assert.equal(shortAttributed.hypotheses.laterBlockOverhead.status, 'untestable');
  assert.equal(shortAttributed.formalGateEligible, false);

  const badReport = structuredClone(overhead.report);
  badReport.performance.decisionLatencyByPolicy['ismcts-v3'].searchTriggered.p95DecisionMs += 1;
  const badReportPath = path.join(temporary, 'bad-report.json');
  write(badReportPath, badReport);
  result = run(badReportPath, overheadCheckpoint);
  assert.notEqual(result.status, 0, '报告与 checkpoint 的总体分位数不一致必须阻断');
  const blocked = JSON.parse(result.stdout);
  assert.equal(blocked.computationStatus, 'blocked');
  assert.equal(blocked.formalGateEligible, false);

  const v3 = { schema: 'guandan-ai-ab-checkpoint-v3', games: [], pairs: [], failures: [] };
  const v3Path = path.join(temporary, 'v3.json');
  write(v3Path, v3);
  result = run(overheadReport, v3Path);
  assert.notEqual(result.status, 0, 'v3 checkpoint 不得作为本历史归因输入');
  const v3Blocked = JSON.parse(result.stdout);
  assert.equal(v3Blocked.computationStatus, 'blocked');
  assert.equal(v3Blocked.formalGateEligible, false);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

console.log('search-tail attribution diagnostic: OK');

function buildFixture({ mode, blocks = 80 }) {
  const levels = [2];
  const baseSeed = 9000;
  const candidate = 'ismcts-v3';
  const games = [];
  const pairs = [];
  let earlyIndex = 0;
  let lateIndex = 0;
  for (let block = 1; block <= blocks; block += 1) {
    const seed = baseSeed + block - 1;
    const late = block >= 61;
    const legs = [0, 1].map((candidateTeam) => {
      const slot = late ? lateIndex++ : earlyIndex++;
      const nodes = nodesFor(mode, late, slot);
      const latencyMs = latencyFor(mode, late, nodes);
      return {
        ok: true,
        seed,
        level: 2,
        candidateTeam,
        order: candidateTeam === 0 ? [0, 1, 2, 3] : [1, 0, 3, 2],
        decisionTelemetry: [
          {
            seat: candidateTeam === 0 ? 0 : 1,
            policy: candidate,
            engine: candidate,
            latencyMs,
            source: 'worker',
            fallbackEvaluable: true,
            timeoutFallback: false,
            candidates: 2,
            samples: 1,
            nodes,
            iterations: 4,
          },
        ],
      };
    });
    games.push(...legs);
    pairs.push({
      seed,
      level: 2,
      complete: true,
      mirrorMatched: true,
      crossLevelMatched: true,
      orders: legs.map((game) => game.order),
    });
  }
  const triggered = games.map((game) => game.decisionTelemetry[0]);
  const latencies = triggered.map((decision) => decision.latencyMs);
  const report = {
    config: {
      baseDealBlocks: blocks,
      baseSeed,
      evaluationLevels: levels,
      candidate,
      comparison: 'expert',
    },
    completion: {
      gamesCompleted: games.length,
      mirrorPairsCompleted: pairs.length,
      baseDealBlocksCompleted: blocks,
      mirrorMismatches: 0,
      failures: 0,
      deadlocks: 0,
    },
    performance: {
      decisionLatencyByPolicy: {
        [candidate]: {
          searchTriggered: {
            decisionTurns: latencies.length,
            p95DecisionMs: percentile(latencies, 0.95),
            p99DecisionMs: percentile(latencies, 0.99),
            totalNodes: triggered.reduce((sum, decision) => sum + decision.nodes, 0),
          },
        },
      },
    },
  };
  const signaturePayload = {
    groupCount: blocks,
    baseSeed,
    candidate,
    comparison: 'expert',
    evaluationLevels: levels,
  };
  return {
    report,
    checkpoint: {
      schema: 'guandan-ai-ab-checkpoint-v2',
      signature: JSON.stringify(signaturePayload),
      signaturePayload,
      nextBlockIndex: blocks,
      complete: true,
      games,
      pairs,
      failures: [],
    },
  };
}

function nodesFor(mode, late, slot) {
  if (mode === 'heavier') return late ? 1800 : 1000;
  // Split both ranges across two node buckets so overhead can require ≥2
  // comparable buckets.
  return slot % 2 === 0 ? 900 : 1500;
}

function latencyFor(mode, late, nodes) {
  if (mode === 'heavier') return late ? 200 : 100;
  const base = nodes === 900 ? 80 : 120;
  return late ? base * 2 : base;
}

function run(report, checkpoint, out = null) {
  const args = [analyzer, '--report', report, '--checkpoint', checkpoint];
  if (out) args.push('--out', out);
  return spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
}

function percentile(values, ratio) {
  const sorted = values.slice().sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * ratio) - 1];
}

function write(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
function read(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
