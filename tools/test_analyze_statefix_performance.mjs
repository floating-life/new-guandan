#!/usr/bin/env node
/** Synthetic regression for the legacy statefix performance diagnostic. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const analyzer = path.join(root, 'tools', 'analyze_statefix_performance.mjs');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'guandan-statefix-diagnostic-'));

try {
  const fixture = buildFixture();
  const reportPath = path.join(temporary, 'report.json');
  const checkpointPath = path.join(temporary, 'checkpoint.json');
  write(reportPath, fixture.report);
  write(checkpointPath, fixture.checkpoint);
  let result = run(reportPath, checkpointPath);
  assert.equal(result.status, 0, `完整 legacy 诊断应成功：${result.stderr}`);
  const diagnostic = JSON.parse(result.stdout);
  assert.equal(diagnostic.schema, 'guandan-ai-performance-diagnostic-v1');
  assert.equal(diagnostic.evidenceClass, 'historical_diagnostic');
  assert.equal(diagnostic.computationStatus, 'ok');
  assert.equal(diagnostic.formalGateEligible, false);
  assert.equal(Object.prototype.hasOwnProperty.call(diagnostic, 'pass'), false,
    '历史诊断不得输出含义模糊的 pass');
  assert.equal(diagnostic.dimensions.overall.decisionTurns, 80);
  assert.equal(diagnostic.dimensions.overall.p95DecisionMs, 118.0);
  assert.equal(diagnostic.dimensions.overall.p99DecisionMs, 119.0);
  assert.equal(diagnostic.dimensions.everyTenBlocks.length, 2);
  assert.equal(diagnostic.dimensions.historicalRanges.length, 1,
    '不足 60 区组的合成夹具不应伪造第二段');
  assert.equal(diagnostic.runResumeSegments.status, 'unavailable');
  assert.equal(diagnostic.integrityChecks.runResumeProvenance, false);

  const segmentManifestPath = path.join(temporary, 'segments.json');
  write(segmentManifestPath, {
    schema: 'guandan-statefix-segment-manifest-v1',
    reportSha256: sha256File(reportPath),
    checkpointSha256: sha256File(checkpointPath),
    segments: [
      {
        id: 'fresh-declared', startBlock: 1, endBlock: 10, label: 'fresh',
        attribution: 'externally_declared', provenanceVerified: false,
      },
      {
        id: 'resume-declared', startBlock: 11, endBlock: 20, label: 'resume',
        attribution: 'externally_declared', provenanceVerified: false,
      },
    ],
  });
  result = run(reportPath, checkpointPath, null, segmentManifestPath);
  assert.equal(result.status, 0, '绑定当前输入的外部分段 sidecar 应可形成诊断');
  const segmented = JSON.parse(result.stdout);
  assert.equal(segmented.runResumeSegments.status, 'externally_declared');
  assert.equal(segmented.runResumeSegments.provenanceVerified, false);
  assert.deepEqual(segmented.runResumeSegments.segments.map((entry) => entry.label), ['fresh', 'resume']);

  const outputPath = path.join(temporary, 'diagnostic.json');
  result = run(reportPath, checkpointPath, outputPath);
  assert.equal(result.status, 0, '指定 --out 时仍应成功');
  assert.deepEqual(read(outputPath), diagnostic, '标准输出与 --out 载荷必须一致');

  const badProxy = structuredClone(fixture.checkpoint);
  badProxy.games[0].decisionTelemetry[0].nodes = 0;
  const badProxyPath = path.join(temporary, 'bad-proxy.json');
  write(badProxyPath, badProxy);
  result = run(reportPath, badProxyPath);
  assert.notEqual(result.status, 0, 'legacy proxy 四字段不一致必须阻断');

  const badReport = structuredClone(fixture.report);
  badReport.performance.decisionLatencyByPolicy['ismcts-v3'].searchTriggered.p95DecisionMs += 1;
  const badReportPath = path.join(temporary, 'bad-report.json');
  write(badReportPath, badReport);
  result = run(badReportPath, checkpointPath);
  assert.notEqual(result.status, 0, '报告与 checkpoint 的总体分位数不一致必须阻断');

  const badReportCoverage = structuredClone(fixture.report);
  badReportCoverage.performance.decisionLatencyByPolicy['ismcts-v3']
    .searchTriggered.measurementCoverage.measuredRate = 0.99;
  const badReportCoveragePath = path.join(temporary, 'bad-report-coverage.json');
  write(badReportCoveragePath, badReportCoverage);
  result = run(badReportCoveragePath, checkpointPath);
  assert.notEqual(result.status, 0, '报告总体 coverage 篡改必须阻断');

  const badReportTypes = structuredClone(fixture.report);
  badReportTypes.performance.decisionLatencyByPolicy['ismcts-v3']
    .searchTriggered.timeoutFallbacks = '0';
  const badReportTypesPath = path.join(temporary, 'bad-report-types.json');
  write(badReportTypesPath, badReportTypes);
  result = run(badReportTypesPath, checkpointPath);
  assert.notEqual(result.status, 0, '报告计数字段的字符串零值必须阻断');

  const badCoverage = structuredClone(fixture.checkpoint);
  badCoverage.pairs.pop();
  const badCoveragePath = path.join(temporary, 'bad-coverage.json');
  write(badCoveragePath, badCoverage);
  result = run(reportPath, badCoveragePath);
  assert.notEqual(result.status, 0, '镜像 pair 覆盖缺失必须阻断');

  const badSegmentManifest = read(segmentManifestPath);
  badSegmentManifest.checkpointSha256 = 'f'.repeat(64);
  const badSegmentManifestPath = path.join(temporary, 'bad-segments.json');
  write(badSegmentManifestPath, badSegmentManifest);
  result = run(reportPath, checkpointPath, null, badSegmentManifestPath);
  assert.notEqual(result.status, 0, '未绑定当前 checkpoint 的外部分段不得进入诊断');

  const duplicateSegmentManifest = read(segmentManifestPath);
  duplicateSegmentManifest.segments[1].id = duplicateSegmentManifest.segments[0].id;
  const duplicateSegmentManifestPath = path.join(temporary, 'duplicate-segments.json');
  write(duplicateSegmentManifestPath, duplicateSegmentManifest);
  result = run(reportPath, checkpointPath, null, duplicateSegmentManifestPath);
  assert.notEqual(result.status, 0, '外部分段 ID 重复必须阻断');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

console.log('statefix legacy performance diagnostic: OK');

function buildFixture() {
  const blocks = 20;
  const levels = [2, 3];
  const baseSeed = 9000;
  const candidate = 'ismcts-v3';
  const games = [];
  const pairs = [];
  for (let block = 1; block <= blocks; block += 1) {
    const seed = baseSeed + block - 1;
    for (const level of levels) {
      const legs = [0, 1].map((candidateTeam) => {
        const candidateSeat = candidateTeam === 0 ? 0 : 1;
        const nodes = 10 + block;
        const iterations = 2 + (level - 2);
        const latencyMs = 100 + block - 1;
        return {
          ok: true,
          seed,
          level,
          candidateTeam,
          order: candidateTeam === 0 ? [0, 1, 2, 3] : [1, 0, 3, 2],
          decisionTelemetry: [
            {
              seat: candidateSeat,
              policy: candidate,
              engine: candidate,
              latencyMs,
              source: block % 2 ? 'worker' : 'synchronous_simulation',
              fallbackEvaluable: true,
              timeoutFallback: false,
              candidates: 2,
              samples: 1,
              nodes,
              iterations,
            },
            {
              seat: candidateTeam === 0 ? 1 : 0,
              policy: 'expert',
              engine: 'expert',
              latencyMs: 5,
              source: 'worker',
              fallbackEvaluable: true,
              timeoutFallback: false,
              candidates: 0,
              samples: 0,
              nodes: 0,
              iterations: 0,
            },
          ],
          hybrid: {
            turns: 1,
            applied: 1,
            samples: 1,
            nodes,
            iterations,
          },
        };
      });
      games.push(...legs);
      pairs.push({
        seed,
        level,
        complete: true,
        mirrorMatched: true,
        crossLevelMatched: true,
        orders: legs.map((game) => game.order),
      });
    }
  }
  const latencies = games.map((game) => game.decisionTelemetry[0].latencyMs);
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
    hybrid: { applied: games.length },
    performance: {
      decisionLatencyByPolicy: {
        [candidate]: {
          searchTriggered: {
            decisionTurns: latencies.length,
            measuredDecisionTurns: latencies.length,
            unmeasuredDecisionTurns: 0,
            averageDecisionMs: average(latencies),
            p95DecisionMs: percentile(latencies, 0.95),
            p99DecisionMs: percentile(latencies, 0.99),
            maxDecisionMs: Math.max(...latencies),
            fallbackEvaluableTurns: latencies.length,
            timeoutFallbacks: 0,
            timeoutFallbackRate: 0,
            totalCandidates: games.reduce((sum, game) => sum + game.decisionTelemetry[0].candidates, 0),
            totalSamples: games.reduce((sum, game) => sum + game.decisionTelemetry[0].samples, 0),
            totalNodes: games.reduce((sum, game) => sum + game.decisionTelemetry[0].nodes, 0),
            totalIterations: games.reduce((sum, game) => sum + game.decisionTelemetry[0].iterations, 0),
            measurementCoverage: { measuredRate: 1, fallbackEvaluableRate: 1 },
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

function run(report, checkpoint, out = null, segmentManifest = null) {
  const args = [analyzer, '--report', report, '--checkpoint', checkpoint];
  if (segmentManifest) args.push('--segment-manifest', segmentManifest);
  if (out) args.push('--out', out);
  return spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
}

function percentile(values, ratio) {
  const sorted = values.slice().sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * ratio) - 1];
}

function average(values) {
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1));
}

function write(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
function read(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
