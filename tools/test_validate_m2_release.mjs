#!/usr/bin/env node
/** Synthetic positive/negative regression for the M2 release gate. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveHybridSearchConfig, resolvePolicyVariant } from '../js/ai.js';
import { modelPayloadSha256 } from '../js/model-fingerprint.js';
import { describeUpgrade } from '../js/rules.js';
import { evaluateValueModelPromotion } from '../js/value-model-gate.js';
import {
  collectEvaluationEnvironment,
  sha256Canonical,
} from '../js/ai.ab.provenance.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const validator = path.join(root, 'tools', 'validate_m2_release.mjs');
const performanceTool = path.join(root, 'tools', 'summarize_ai_performance_baseline.mjs');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'guandan-m2-release-'));
const levels = Array.from({ length: 13 }, (_, index) => index + 2);
const environment = collectEvaluationEnvironment();
const implementation = implementationManifest();
const model = {
  id: 'm2-release-fixture',
  schema: 'guandan-candidate-v1',
  layers: [{ weights: [new Array(32).fill(0)], bias: [0], activation: 'linear' }],
  metadata: {
    trainingSeedManifest: seedManifest(100000, 40),
    trainingDatasetSha256: 'b'.repeat(64),
  },
};
const modelHash = modelPayloadSha256(model);
const modelAudit = {
  id: model.id,
  sha256: modelHash,
  trainingSeedManifest: model.metadata.trainingSeedManifest,
  trainingDatasetSha256: model.metadata.trainingDatasetSha256,
};

try {
  const files = buildFixture();
  const performanceResult = spawnSync(process.execPath, [
    performanceTool, '--report', files.primary, '--checkpoint', files.checkpoint,
    '--raw-telemetry', files.rawTelemetry, '--out', files.performance,
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(performanceResult.status, 0,
    `合成报告应能生成严格性能回执：${performanceResult.stderr}\n${performanceResult.stdout}`);

  let result = run(files, '完整 M2 工件');
  assert.equal(result.status, 0, `完整 M2 工件必须通过：${result.stderr}\n${JSON.stringify(result.report)}`);
  assert.equal(result.report.schema, 'guandan-m2-release-validation-v1');
  assert.equal(result.report.releaseEvidenceReady, true);
  assert.equal(result.report.promotable, true);

  const badModel = read(files.model);
  badModel.metadata.status = 'validated';
  write(path.join(temporary, 'bad-model-status.json'), badModel);
  result = run({ ...files, model: path.join(temporary, 'bad-model-status.json') }, '模型状态降级');
  assert.notEqual(result.status, 0, 'validated 模型不得冒充 M2 promoted 证据');

  const badPerformance = read(files.performance);
  badPerformance.overall.allEnginesPass = false;
  write(path.join(temporary, 'bad-performance.json'), badPerformance);
  result = run({ ...files, performance: path.join(temporary, 'bad-performance.json') }, '性能总门伪造');
  assert.notEqual(result.status, 0, '性能 receipt 仅 formalReceiptReady 而总门失败时必须阻断');

  const badCheckpoint = read(files.checkpoint);
  badCheckpoint.schema = 'guandan-ai-ab-checkpoint-v2';
  write(path.join(temporary, 'bad-checkpoint.json'), badCheckpoint);
  result = run({ ...files, checkpoint: path.join(temporary, 'bad-checkpoint.json') }, 'legacy checkpoint');
  assert.notEqual(result.status, 0, 'legacy v2 checkpoint 不得进入 M2');

  const badRaw = read(files.rawTelemetry);
  badRaw.records[0].latencyMs = null;
  write(path.join(temporary, 'bad-raw.json'), badRaw);
  result = run({ ...files, rawTelemetry: path.join(temporary, 'bad-raw.json') }, '漏测原始遥测');
  assert.notEqual(result.status, 0, '原始遥测计数与报告不一致时必须阻断');

  const badBlind = read(files.blindSummary);
  badBlind.schema = 'guandan-blind-eval-summary-v2';
  write(path.join(temporary, 'bad-blind.json'), badBlind);
  result = run({ ...files, blindSummary: path.join(temporary, 'bad-blind.json') }, 'legacy blind summary');
  assert.notEqual(result.status, 0, '盲评 v2 summary 不得进入 M2');

  const badCI = read(files.primary);
  badCI.result.candidatePairedUtilityBootstrap95 = [-0.01, 0.18];
  write(path.join(temporary, 'bad-ci.json'), badCI);
  result = run({ ...files, report: path.join(temporary, 'bad-ci.json') }, '跨零 CI');
  assert.notEqual(result.status, 0, '配对 CI 下界跨零时必须阻断');

  const badBinding = read(files.blindBinding);
  badBinding.manifestSha256 = 'a'.repeat(64);
  write(path.join(temporary, 'bad-binding.json'), badBinding);
  result = run({ ...files, blindBinding: path.join(temporary, 'bad-binding.json') }, '盲评绑定篡改');
  assert.notEqual(result.status, 0, '盲评 binding 篡改时必须阻断');

  const badGameUtility = read(files.checkpoint);
  badGameUtility.games[0].utility = -badGameUtility.games[0].utility;
  refreshCheckpointIntegrity(badGameUtility);
  const badGameUtilityPath = path.join(temporary, 'bad-game-utility.json');
  write(badGameUtilityPath, badGameUtility);
  result = run({ ...files, checkpoint: badGameUtilityPath }, 'checkpoint utility 篡改');
  assert.notEqual(result.status, 0, 'checkpoint 逐局 utility 篡改必须阻断');

  const badOrder = read(files.checkpoint);
  badOrder.games[0].order = badOrder.games[0].order.slice().reverse();
  refreshCheckpointIntegrity(badOrder);
  const badOrderPath = path.join(temporary, 'bad-order.json');
  write(badOrderPath, badOrder);
  result = run({ ...files, checkpoint: badOrderPath }, 'checkpoint order 篡改');
  assert.notEqual(result.status, 0, 'checkpoint 逐局 order 篡改必须阻断');

  const badCoordinatedOrder = read(files.checkpoint);
  badCoordinatedOrder.games[0].order = badCoordinatedOrder.games[0].order.slice().reverse();
  const coordinatedPair = badCoordinatedOrder.pairs.find((pair) => (
    pair.seed === badCoordinatedOrder.games[0].seed
      && pair.level === badCoordinatedOrder.games[0].level
  ));
  coordinatedPair.orders[0] = badCoordinatedOrder.games[0].order;
  refreshCheckpointIntegrity(badCoordinatedOrder);
  const badCoordinatedOrderPath = path.join(temporary, 'bad-coordinated-order.json');
  write(badCoordinatedOrderPath, badCoordinatedOrder);
  result = run({ ...files, checkpoint: badCoordinatedOrderPath }, '协调篡改 order 与 pair');
  assert.notEqual(result.status, 0, '协调修改 game/pair 的完赛顺序仍必须由 winner 派生门阻断');

  const badDerivedOutcome = read(files.checkpoint);
  const derivedGame = badDerivedOutcome.games[0];
  const derivedPair = badDerivedOutcome.pairs.find((pair) => (
    pair.seed === derivedGame.seed && pair.level === derivedGame.level
  ));
  const otherDerivedGame = badDerivedOutcome.games.find((game) => (
    game.seed === derivedGame.seed && game.level === derivedGame.level
      && game.candidateTeam !== derivedGame.candidateTeam
  ));
  derivedGame.upgrade += 1;
  derivedGame.utility = derivedGame.candidateHead ? derivedGame.upgrade : -derivedGame.upgrade;
  derivedPair.utility = (derivedGame.utility + otherDerivedGame.utility) / 2;
  refreshCheckpointIntegrity(badDerivedOutcome);
  const badDerivedOutcomePath = path.join(temporary, 'bad-derived-outcome.json');
  write(badDerivedOutcomePath, badDerivedOutcome);
  result = run({ ...files, checkpoint: badDerivedOutcomePath }, '协调篡改 upgrade utility 与 pair');
  assert.notEqual(result.status, 0,
    '同步修改 game upgrade/utility 与 pair 后仍必须由 order 派生门阻断');

  const badPairBlock = read(files.checkpoint);
  badPairBlock.pairs[0].block = 2;
  badPairBlock.pairs[0].group = 14;
  refreshCheckpointIntegrity(badPairBlock);
  const badPairBlockPath = path.join(temporary, 'bad-pair-block.json');
  write(badPairBlockPath, badPairBlock);
  result = run({ ...files, checkpoint: badPairBlockPath }, 'pair block seed 解绑');
  assert.notEqual(result.status, 0, 'pair.block 与 seed 解绑必须阻断区组 bootstrap');

  const badDoubleUp = read(files.checkpoint);
  badDoubleUp.games[0].candidateDoubleUp = true;
  refreshCheckpointIntegrity(badDoubleUp);
  const badDoubleUpPath = path.join(temporary, 'bad-double-up.json');
  write(badDoubleUpPath, badDoubleUp);
  result = run({ ...files, checkpoint: badDoubleUpPath }, 'checkpoint double-up 篡改');
  assert.notEqual(result.status, 0, 'checkpoint double-up 派生字段篡改必须阻断');

  const badDecisionTelemetry = read(files.checkpoint);
  badDecisionTelemetry.games[0].decisionTelemetry[0].latencyMs = -1;
  refreshCheckpointIntegrity(badDecisionTelemetry);
  const badDecisionTelemetryPath = path.join(temporary, 'bad-decision-telemetry.json');
  write(badDecisionTelemetryPath, badDecisionTelemetry);
  result = run({ ...files, checkpoint: badDecisionTelemetryPath }, 'checkpoint decision telemetry 篡改');
  assert.notEqual(result.status, 0, 'checkpoint 决策遥测负延迟必须阻断');

  const badRawLatency = read(files.rawTelemetry);
  badRawLatency.records[0].latencyMs = -1;
  const badRawLatencyPath = path.join(temporary, 'bad-raw-latency.json');
  write(badRawLatencyPath, badRawLatency);
  result = run({ ...files, rawTelemetry: badRawLatencyPath }, 'raw negative latency');
  assert.notEqual(result.status, 0, '原始遥测负延迟必须阻断');

  const badSearchMetadata = read(files.checkpoint);
  badSearchMetadata.games[0].decisionTelemetry[0].searchAttempted = false;
  badSearchMetadata.games[0].decisionTelemetry[0].searchTriggered = true;
  refreshCheckpointIntegrity(badSearchMetadata);
  const badSearchMetadataPath = path.join(temporary, 'bad-search-metadata.json');
  write(badSearchMetadataPath, badSearchMetadata);
  result = run({ ...files, checkpoint: badSearchMetadataPath }, 'raw search metadata contradiction');
  assert.notEqual(result.status, 0, 'searchAttempted/searchTriggered 矛盾必须阻断');

  const badPerformanceAggregate = read(files.performance);
  badPerformanceAggregate.runs[0].decisionTurns += 1;
  const badPerformanceAggregatePath = path.join(temporary, 'bad-performance-aggregate.json');
  write(badPerformanceAggregatePath, badPerformanceAggregate);
  result = run({ ...files, performance: badPerformanceAggregatePath }, '性能 aggregate 篡改');
  assert.notEqual(result.status, 0, '性能回执 aggregate 数值篡改必须阻断');

  const badPerformanceSegment = read(files.performance);
  badPerformanceSegment.runs[0].runSegments.pop();
  const badPerformanceSegmentPath = path.join(temporary, 'bad-performance-segment.json');
  write(badPerformanceSegmentPath, badPerformanceSegment);
  result = run({ ...files, performance: badPerformanceSegmentPath }, '性能遗漏运行段');
  assert.notEqual(result.status, 0, '性能回执遗漏运行段必须阻断');

  const badDiagnosticPrimary = read(files.primary);
  badDiagnosticPrimary.performance.byRunSegment[0].environmentTelemetry = {
    schema: 'guandan-evaluation-environment-telemetry-artifact-v1',
    diagnosticOnly: true,
    formalGateEligible: false,
  };
  const badDiagnosticPrimaryPath = path.join(temporary, 'bad-diagnostic-primary.json');
  write(badDiagnosticPrimaryPath, badDiagnosticPrimary);
  const badDiagnosticRaw = read(files.rawTelemetry);
  badDiagnosticRaw.reportSha256 = fileHash(badDiagnosticPrimaryPath);
  const badDiagnosticRawPath = path.join(temporary, 'bad-diagnostic-raw.json');
  write(badDiagnosticRawPath, badDiagnosticRaw);
  result = run({ ...files, report: badDiagnosticPrimaryPath, rawTelemetry: badDiagnosticRawPath },
    '主报告 diagnostic-only environmentTelemetry');
  assert.notEqual(result.status, 0,
    '主报告即使同步更新原始遥测绑定，也不得带诊断环境遥测进入 M2');

  const badRootDiagnosticPrimary = read(files.primary);
  badRootDiagnosticPrimary.performance.environmentTelemetry = {
    schema: 'guandan-evaluation-environment-telemetry-artifact-v1',
    diagnosticOnly: true,
    formalGateEligible: false,
  };
  const badRootDiagnosticPrimaryPath = path.join(temporary, 'bad-root-diagnostic-primary.json');
  write(badRootDiagnosticPrimaryPath, badRootDiagnosticPrimary);
  const badRootDiagnosticRaw = read(files.rawTelemetry);
  badRootDiagnosticRaw.reportSha256 = fileHash(badRootDiagnosticPrimaryPath);
  const badRootDiagnosticRawPath = path.join(temporary, 'bad-root-diagnostic-raw.json');
  write(badRootDiagnosticRawPath, badRootDiagnosticRaw);
  result = run({ ...files, report: badRootDiagnosticPrimaryPath, rawTelemetry: badRootDiagnosticRawPath },
    '主报告性能根部 diagnostic-only environmentTelemetry');
  assert.notEqual(result.status, 0,
    '主报告性能根部即使同步更新原始遥测绑定，也不得静默忽略诊断环境遥测');

  const badContinuousBlocks = read(files.continuousReport);
  badContinuousBlocks.config.baseDealBlocks = 1;
  const badContinuousBlocksPath = path.join(temporary, 'bad-continuous-blocks.json');
  write(badContinuousBlocksPath, badContinuousBlocks);
  result = run({ ...files, continuousReport: badContinuousBlocksPath }, 'continuous block coverage');
  assert.notEqual(result.status, 0, '连续赛区组缩减必须阻断');

  const badContinuousSeed = read(files.continuousReport);
  badContinuousSeed.config.evaluationSeedManifest.seeds[0] += 1;
  const badContinuousSeedPath = path.join(temporary, 'bad-continuous-seed.json');
  write(badContinuousSeedPath, badContinuousSeed);
  result = run({ ...files, continuousReport: badContinuousSeedPath }, 'continuous seed provenance');
  assert.notEqual(result.status, 0, '连续赛 seed provenance 篡改必须阻断');

  const badAllocation = read(files.blindManifest);
  badAllocation.allocation.playerScenarioIds[1].scenarioIds[0] =
    badAllocation.allocation.playerScenarioIds[0].scenarioIds[0];
  const badAllocationPath = path.join(temporary, 'bad-allocation.json');
  write(badAllocationPath, badAllocation);
  result = run({ ...files, blindManifest: badAllocationPath }, '盲评 allocation 重复');
  assert.notEqual(result.status, 0, '盲评 allocation 重复/漏题必须阻断');

  const badBlindGate = read(files.blindSummary);
  badBlindGate.gate.checks.minimumParticipants = false;
  const badBlindGatePath = path.join(temporary, 'bad-blind-gate.json');
  write(badBlindGatePath, badBlindGate);
  result = run({ ...files, blindSummary: badBlindGatePath }, '盲评 gate 伪造');
  assert.notEqual(result.status, 0, '盲评 gate 存在 false 时不得保留 pass');

  const badCatastropheCounts = read(files.blindSummary);
  badCatastropheCounts.totals.catastrophic.reviewed.proposed = 1;
  const badCatastropheCountsPath = path.join(temporary, 'bad-catastrophe-counts.json');
  write(badCatastropheCountsPath, badCatastropheCounts);
  result = run({ ...files, blindSummary: badCatastropheCountsPath }, '盲评 catastrophic 计数伪造');
  assert.notEqual(result.status, 0, '盲评 catastrophic 计数伪造必须阻断');

  const badScenario = fs.readFileSync(files.blindScenarios, 'utf8').trimEnd().split(/\r?\n/)
    .map((line) => JSON.parse(line));
  badScenario[0].evaluationImplementationSha256 = 'd'.repeat(64);
  const badScenarioPath = path.join(temporary, 'bad-scenarios.ndjson');
  fs.writeFileSync(badScenarioPath, `${badScenario.map((item) => JSON.stringify(item)).join('\n')}\n`, 'utf8');
  result = run({ ...files, blindScenarios: badScenarioPath }, '盲评场景 implementation hash 篡改');
  assert.notEqual(result.status, 0, '盲评场景 implementation hash 篡改必须阻断');

  const badSourcePayload = fs.readFileSync(files.blindScenarios, 'utf8').trimEnd().split(/\r?\n/)
    .map((line) => JSON.parse(line));
  badSourcePayload[0].observation.seat = 3;
  const badSourcePayloadPath = path.join(temporary, 'bad-source-payload.ndjson');
  fs.writeFileSync(badSourcePayloadPath,
    `${badSourcePayload.map((item) => JSON.stringify(item)).join('\n')}\n`, 'utf8');
  const badSourceManifest = read(files.blindManifest);
  badSourceManifest.selectedScenarioFile = path.basename(badSourcePayloadPath);
  badSourceManifest.selectedScenarioSha256 = fileHash(badSourcePayloadPath);
  const badSourceManifestPath = path.join(temporary, 'bad-source-manifest.json');
  write(badSourceManifestPath, badSourceManifest);
  const badSourceSummary = read(files.blindSummary);
  badSourceSummary.manifest.selectedScenarioFile = badSourceManifest.selectedScenarioFile;
  badSourceSummary.manifest.selectedScenarioSha256 = badSourceManifest.selectedScenarioSha256;
  const badSourceSummaryPath = path.join(temporary, 'bad-source-summary.json');
  write(badSourceSummaryPath, badSourceSummary);
  const badSourceBinding = read(files.blindBinding);
  badSourceBinding.summarySha256 = fileHash(badSourceSummaryPath);
  badSourceBinding.manifestSha256 = fileHash(badSourceManifestPath);
  badSourceBinding.scenarioPayloadSha256 = badSourceManifest.selectedScenarioSha256;
  const badSourceBindingPath = path.join(temporary, 'bad-source-binding.json');
  write(badSourceBindingPath, badSourceBinding);
  result = run({
    ...files,
    blindSummary: badSourceSummaryPath,
    blindManifest: badSourceManifestPath,
    blindScenarios: badSourcePayloadPath,
    blindBinding: badSourceBindingPath,
  }, '盲评 selected 来源载荷替换');
  assert.notEqual(result.status, 0, '仅替换 selected 场景并同步摘要绑定仍必须阻断');

  const badUnanswered = read(files.blindSummary);
  badUnanswered.players[0].answered = 9;
  badUnanswered.players[0].unanswered = 1;
  badUnanswered.players[0].proposedPreferred = 5;
  badUnanswered.players[0].proposedRate = 0.5556;
  badUnanswered.totals.answered = 99;
  badUnanswered.totals.unanswered = 1;
  badUnanswered.totals.proposedPreferred = 59;
  badUnanswered.totals.proposedRate = Number((59 / 99).toFixed(4));
  badUnanswered.totals.wilson95Diagnostic = wilsonFixture(59, 99, 1.96)
    .map((value) => Number(value.toFixed(4)));
  badUnanswered.totals.playerClusterBootstrap95 = clusterFixture(
    badUnanswered.players, badUnanswered.manifest.randomSeed,
  ).map((value) => Number(value.toFixed(4)));
  badUnanswered.answerLedger[0].choice = null;
  badUnanswered.answerLedger[0].side = null;
  badUnanswered.answerLedgerSha256 = sha256Bytes(
    Buffer.from(JSON.stringify(badUnanswered.answerLedger), 'utf8'),
  );
  badUnanswered.gate.checks.minimumAnswersPerParticipant = true;
  badUnanswered.gate.checks.fullCompletion = true;
  const badUnansweredPath = path.join(temporary, 'bad-unanswered.json');
  write(badUnansweredPath, badUnanswered);
  const badUnansweredBinding = read(files.blindBinding);
  badUnansweredBinding.summarySha256 = fileHash(badUnansweredPath);
  badUnansweredBinding.answerLedgerSha256 = badUnanswered.answerLedgerSha256;
  const badUnansweredBindingPath = path.join(temporary, 'bad-unanswered-binding.json');
  write(badUnansweredBindingPath, badUnansweredBinding);
  result = run({
    ...files, blindSummary: badUnansweredPath, blindBinding: badUnansweredBindingPath,
  }, '盲评未完成伪造 fullCompletion');
  assert.notEqual(result.status, 0, '盲评 unanswered>0 即使伪造 gate 也必须阻断');

  const badLedgerSide = read(files.blindSummary);
  badLedgerSide.answerLedger[0].side = badLedgerSide.answerLedger[0].side === 'expert'
    ? 'proposed' : 'expert';
  badLedgerSide.players[0].proposedPreferred = 5;
  badLedgerSide.players[0].proposedRate = 0.5;
  badLedgerSide.totals.proposedPreferred = 59;
  badLedgerSide.totals.proposedRate = 0.59;
  badLedgerSide.totals.wilson95Diagnostic = wilsonFixture(59, 100, 1.96)
    .map((value) => Number(value.toFixed(4)));
  badLedgerSide.totals.playerClusterBootstrap95 = clusterFixture(
    badLedgerSide.players, badLedgerSide.manifest.randomSeed,
  ).map((value) => Number(value.toFixed(4)));
  badLedgerSide.answerLedgerSha256 = sha256Bytes(
    Buffer.from(JSON.stringify(badLedgerSide.answerLedger), 'utf8'),
  );
  const badLedgerSidePath = path.join(temporary, 'bad-ledger-side.json');
  write(badLedgerSidePath, badLedgerSide);
  const badLedgerSideBinding = read(files.blindBinding);
  badLedgerSideBinding.summarySha256 = fileHash(badLedgerSidePath);
  badLedgerSideBinding.answerLedgerSha256 = badLedgerSide.answerLedgerSha256;
  const badLedgerSideBindingPath = path.join(temporary, 'bad-ledger-side-binding.json');
  write(badLedgerSideBindingPath, badLedgerSideBinding);
  result = run({
    ...files, blindSummary: badLedgerSidePath, blindBinding: badLedgerSideBindingPath,
  }, '盲评 answer ledger side 协调篡改');
  assert.notEqual(result.status, 0,
    '翻转 answer ledger side 并同步聚合/摘要绑定仍必须由冻结 A/B 映射阻断');

  const badCoordinatedLedger = read(files.blindSummary);
  const coordinatedEntry = badCoordinatedLedger.answerLedger[0];
  const originalProposed = Number(coordinatedEntry.side === 'proposed');
  coordinatedEntry.mapping = {
    A: coordinatedEntry.mapping.B,
    B: coordinatedEntry.mapping.A,
  };
  coordinatedEntry.side = coordinatedEntry.mapping[coordinatedEntry.choice];
  const coordinatedDelta = Number(coordinatedEntry.side === 'proposed') - originalProposed;
  badCoordinatedLedger.players[0].proposedPreferred += coordinatedDelta;
  badCoordinatedLedger.players[0].proposedRate = Number(
    (badCoordinatedLedger.players[0].proposedPreferred
      / badCoordinatedLedger.players[0].answered).toFixed(4),
  );
  badCoordinatedLedger.totals.proposedPreferred += coordinatedDelta;
  badCoordinatedLedger.totals.proposedRate = Number(
    (badCoordinatedLedger.totals.proposedPreferred / badCoordinatedLedger.totals.answered)
      .toFixed(4),
  );
  badCoordinatedLedger.totals.wilson95Diagnostic = wilsonFixture(
    badCoordinatedLedger.totals.proposedPreferred,
    badCoordinatedLedger.totals.answered,
    1.96,
  ).map((value) => Number(value.toFixed(4)));
  badCoordinatedLedger.totals.playerClusterBootstrap95 = clusterFixture(
    badCoordinatedLedger.players, badCoordinatedLedger.manifest.randomSeed,
  ).map((value) => Number(value.toFixed(4)));
  badCoordinatedLedger.answerLedgerSha256 = sha256Bytes(
    Buffer.from(JSON.stringify(badCoordinatedLedger.answerLedger), 'utf8'),
  );
  const badCoordinatedLedgerPath = path.join(temporary, 'bad-coordinated-ledger.json');
  write(badCoordinatedLedgerPath, badCoordinatedLedger);
  const badCoordinatedLedgerBinding = read(files.blindBinding);
  badCoordinatedLedgerBinding.summarySha256 = fileHash(badCoordinatedLedgerPath);
  badCoordinatedLedgerBinding.answerLedgerSha256 = badCoordinatedLedger.answerLedgerSha256;
  const badCoordinatedLedgerBindingPath = path.join(
    temporary, 'bad-coordinated-ledger-binding.json',
  );
  write(badCoordinatedLedgerBindingPath, badCoordinatedLedgerBinding);
  result = run({
    ...files,
    blindSummary: badCoordinatedLedgerPath,
    blindBinding: badCoordinatedLedgerBindingPath,
  }, '盲评 mapping+side 协调篡改');
  assert.notEqual(result.status, 0,
    '同时交换 mapping、side、聚合与摘要绑定仍必须由冻结 assignment/key 摘要阻断');

  const out = path.join(temporary, 'receipt.json');
  result = run({ ...files, out }, '完整 M2 工件写回执');
  assert.equal(result.status, 0, '通过的 M2 验证应返回零');
  assert.equal(read(out).releaseEvidenceReady, true, '通过时才允许写回执');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

console.log('M2 unified release gate: strict positive/negative fixtures OK');

function buildFixture() {
  const primaryId = '11111111-1111-4111-8111-111111111111';
  const primarySegments = [
    segment(primaryId, '22222222-2222-4222-8222-222222222222', 1, false, null, 0, 40),
    segment(primaryId, '33333333-3333-4333-8333-333333333333', 2, true,
      'c'.repeat(64), 40, 80),
  ];
  const primaryProvenance = provenance(primaryId, primarySegments);
  const candidate = 'root-pimc-v1';
  const searchConfig = expectedSearchConfig(candidate);
  const primaryConfig = {
    seedGroups: 1040,
    baseDealBlocks: 80,
    baseSeed: 20267001,
    evaluationSeedManifest: seedManifest(20267001, 80),
    gamesPlanned: 2080,
    evaluationLevels: levels,
    evaluationDesign: 'same-deal-cross-level-blocks',
    continuousMatch: false,
    outcomeUnit: 'round upgrade utility (+1..+3)',
    candidate,
    comparison: 'expert',
    deterministic: true,
    difficulty: 'master',
    evaluationOpponentModelMode: 'off',
    valueModel: modelAudit,
    evaluationImplementation: implementation,
    hybridEngineVersion: 1,
    candidateSearchConfig: searchConfig,
  };
  const primaryData = makeGamesAndPairs(
    primaryConfig.baseSeed, 80, levels, primarySegments, primaryConfig,
  );
  const primaryCheckpoint = checkpoint(primaryConfig, primaryProvenance, primaryData);
  const primaryMetrics = reportMetrics(primaryData, primaryConfig, candidate, searchConfig.searchMode);
  const primary = {
    schema: 'guandan-ai-ab-report-v1',
    provenance: primaryProvenance,
    config: primaryConfig,
    ...primaryMetrics,
    performance: performanceAggregate(candidate, searchConfig.searchMode, primarySegments,
      primaryData.games),
  };
  const reportPath = path.join(temporary, 'primary.json');
  const checkpointPath = path.join(temporary, 'primary.checkpoint.json');
  write(reportPath, primary);
  write(checkpointPath, primaryCheckpoint);
  const raw = rawTelemetry(primary, primaryCheckpoint);
  const rawPath = path.join(temporary, 'raw-telemetry.json');
  write(rawPath, raw);

  const continuousId = '44444444-4444-4444-8444-444444444444';
  const continuousSegments = [segment(
    continuousId, '55555555-5555-4555-8555-555555555555', 1, false, null, 0, 4,
  )];
  const continuousProvenance = provenance(continuousId, continuousSegments);
  const continuousConfig = {
    seedGroups: 4,
    baseDealBlocks: 4,
    baseSeed: 30267001,
    evaluationSeedManifest: seedManifest(30267001, 4),
    gamesPlanned: 8,
    evaluationLevels: [2],
    evaluationDesign: 'legacy-level-cycle',
    continuousMatch: true,
    outcomeUnit: 'match win (+1/-1)',
    candidate,
    comparison: 'expert',
    deterministic: true,
    difficulty: 'master',
    evaluationOpponentModelMode: 'off',
    valueModel: modelAudit,
    evaluationImplementation: implementation,
    hybridEngineVersion: 1,
    candidateSearchConfig: searchConfig,
  };
  const continuousData = makeGamesAndPairs(
    continuousConfig.baseSeed, 4, [2], continuousSegments, continuousConfig,
  );
  const continuousMetrics = reportMetrics(
    continuousData, continuousConfig, candidate, searchConfig.searchMode,
  );
  const continuous = {
    schema: 'guandan-ai-ab-report-v1',
    provenance: continuousProvenance,
    config: continuousConfig,
    ...continuousMetrics,
  };
  const continuousCheckpoint = checkpoint(continuousConfig, continuousProvenance, continuousData);
  const continuousPath = path.join(temporary, 'continuous.json');
  const continuousCheckpointPath = path.join(temporary, 'continuous.checkpoint.json');
  write(continuousPath, continuous);
  write(continuousCheckpointPath, continuousCheckpoint);

  const promotion = evaluateValueModelPromotion(primary, modelHash, {
    continuousReport: continuous,
    continuousReportSha256: fileHash(continuousPath),
  });
  assert.equal(promotion.promoted, true, '合成模型必须具备可验证的 promoted 质量回执');
  model.metadata = {
    ...model.metadata,
    status: 'promoted',
    modelSha256: modelHash,
    validation: {
      checkedAt: '2026-08-31T00:00:00.000Z',
      primaryReportSha256: fileHash(reportPath),
      candidate: primary.config.candidate,
      comparison: primary.config.comparison,
      baseSeed: primary.config.baseSeed,
      evaluationSeedManifest: primary.config.evaluationSeedManifest,
      evaluationLevels: primary.config.evaluationLevels,
      ...promotion.metrics,
    },
  };
  write(path.join(temporary, 'model.json'), model);

  const manifest = buildBlindManifest();
  const manifestPath = path.join(temporary, 'blind-manifest.json');
  write(manifestPath, manifest);
  const summary = blindSummary(manifest);
  const summaryPath = path.join(temporary, 'blind-summary.json');
  write(summaryPath, summary);
  const catastrophic = {
    schema: 'guandan-blind-catastrophe-review-v2',
    reviews: manifest.scenarioIds.map((id) => ({ id, expert: false, proposed: false })),
  };
  const catastrophicPath = path.join(temporary, 'blind-catastrophic.json');
  write(catastrophicPath, catastrophic);
  const binding = {
    schema: 'guandan-blind-eval-release-binding-v2',
    summarySha256: fileHash(summaryPath),
    manifestSha256: fileHash(manifestPath),
    scenarioPayloadSha256: manifest.selectedScenarioSha256,
    scenarioIdsSha256: sha256Canonical(manifest.scenarioIds),
    sourceFilesSha256: sha256Canonical(manifest.sourceFiles),
    catastrophicReviewSha256: fileHash(catastrophicPath),
    modelPayloadSha256: modelHash,
    primaryReportSha256: fileHash(reportPath),
    primaryCheckpointSha256: fileHash(checkpointPath),
    evaluationId: primaryId,
    evaluationImplementationSha256: implementation.sha256,
    candidate,
    evaluationSeedManifestSha256: sha256Canonical(primary.config.evaluationSeedManifest),
    answerLedgerSha256: summary.answerLedgerSha256,
  };
  const bindingPath = path.join(temporary, 'blind-binding.json');
  write(bindingPath, binding);
  return {
    model: path.join(temporary, 'model.json'),
    primary: reportPath,
    checkpoint: checkpointPath,
    rawTelemetry: rawPath,
    performance: path.join(temporary, 'performance.json'),
    continuousReport: continuousPath,
    continuousCheckpoint: continuousCheckpointPath,
    blindSummary: summaryPath,
    blindManifest: manifestPath,
    blindScenarios: path.join(temporary, 'selected-scenarios.ndjson'),
    blindCatastrophic: catastrophicPath,
    blindBinding: bindingPath,
  };
}

function performanceAggregate(candidate, searchMode, segments, games) {
  const bySegmentGames = new Map(segments.map((entry) => [entry.runSegmentId,
    games.filter((game) => game.runSegmentId === entry.runSegmentId)]));
  const allAIDecisions = allTelemetry(games.length, games.length, 400, 400);
  return {
    allAIDecisions,
    decisionLatencyByPolicy: {
      [candidate]: telemetry(games.length, games.length, 400, 400),
    },
    byRunSegment: segments.map((entry) => ({
      schema: 'guandan-ai-performance-by-run-segment-v1',
      runSegmentId: entry.runSegmentId,
      startBlockIndex: entry.startBlockIndex,
      endBlockIndex: entry.endBlockIndex,
      gamesCompleted: bySegmentGames.get(entry.runSegmentId).length,
      allAIDecisions: allTelemetry(
        bySegmentGames.get(entry.runSegmentId).length,
        bySegmentGames.get(entry.runSegmentId).length,
        400,
        400,
      ),
      decisionLatencyByPolicy: {
        [candidate]: telemetry(
          bySegmentGames.get(entry.runSegmentId).length,
          bySegmentGames.get(entry.runSegmentId).length,
          400,
          400,
        ),
      },
      hybrid: {
        turns: bySegmentGames.get(entry.runSegmentId).length,
        searchModes: { [searchMode]: bySegmentGames.get(entry.runSegmentId).length },
      },
    })),
  };
}

function telemetry(decisionTurns, triggeredTurns, p95, p99) {
  return {
    decisionTurns, measuredDecisionTurns: decisionTurns, unmeasuredDecisionTurns: 0,
    averageDecisionMs: p95, p95DecisionMs: p95, p99DecisionMs: p99, maxDecisionMs: p99,
    fallbackEvaluableTurns: decisionTurns, timeoutFallbacks: 0, timeoutFallbackRate: 0,
    searchTriggered: {
      decisionTurns: triggeredTurns, measuredDecisionTurns: triggeredTurns,
      unmeasuredDecisionTurns: 0, averageDecisionMs: 400,
      p95DecisionMs: p95, p99DecisionMs: p99, maxDecisionMs: p99,
      fallbackEvaluableTurns: triggeredTurns, timeoutFallbacks: 0, timeoutFallbackRate: 0,
    },
  };
}

function allTelemetry(decisionTurns, triggeredTurns, p95, p99) {
  return {
    schema: 'guandan-evaluation-decision-telemetry-v2',
    ...telemetry(decisionTurns, triggeredTurns, p95, p99),
    integrityComplete: true,
    missingVariantTurns: 0,
    missingLocalDecisionTurns: 0,
    missingSearchTelemetryTurns: 0,
    missingFallbackKindTurns: 0,
  };
}

function rawTelemetry(primary, checkpoint) {
  const records = checkpoint.games.flatMap((game) => game.decisionTelemetry.map((item, index) => ({
    runSegmentId: game.runSegmentId,
    seed: game.seed,
    level: game.level,
    candidateTeam: game.candidateTeam,
    turn: index + 1,
    seat: item.seat,
    policy: item.policy,
    engine: item.engine,
    variantPresent: item.variantPresent,
    localDecisionPresent: item.localDecisionPresent,
    searchTelemetryPresent: item.searchTelemetryPresent,
    fallbackKindPresent: item.fallbackKindPresent,
    telemetryComplete: item.telemetryComplete,
    latencyMs: item.latencyMs,
    source: item.source,
    fallbackKind: item.fallbackKind,
    fallbackEvaluable: item.fallbackEvaluable,
    timeoutFallback: item.timeoutFallback,
    searchAttempted: item.searchAttempted,
    searchTriggered: item.searchTriggered,
    candidates: item.candidates,
    samples: item.samples,
    nodes: item.nodes,
    iterations: item.iterations,
    rolloutBudget: item.rolloutBudget,
    sweepBudget: item.sweepBudget,
    pairedSweeps: item.pairedSweeps,
  })));
  return {
    schema: 'guandan-ai-raw-telemetry-v1',
    evaluationId: primary.provenance.evaluationId,
    reportSha256: fileHash(path.join(temporary, 'primary.json')),
    checkpointSha256: fileHash(path.join(temporary, 'primary.checkpoint.json')),
    candidate: primary.config.candidate,
    evaluationImplementationSha256: primary.config.evaluationImplementation.sha256,
    environmentSha256: environment.environmentSha256,
    records,
    integrityComplete: true,
    missingVariantTurns: 0,
    missingLocalDecisionTurns: 0,
    missingSearchTelemetryTurns: 0,
    missingFallbackKindTurns: 0,
  };
}

function checkpoint(config, provenanceValue, data) {
  const signaturePayload = {
    groupCount: Number(config.baseDealBlocks), baseSeed: Number(config.baseSeed),
    candidate: config.candidate, comparison: 'expert', evaluationLevels: config.evaluationLevels,
    levelBlockDesign: config.continuousMatch ? false : true,
    continuousMatch: config.continuousMatch === true,
    evaluationOpponentModelMode: 'off', valueModelSha256: modelHash,
    evaluationImplementationSha256: implementation.sha256,
    hybridEngineVersion: Number(config.hybridEngineVersion),
    candidateSearchConfig: config.candidateSearchConfig,
  };
  const value = {
    schema: 'guandan-ai-ab-checkpoint-v3',
    signature: JSON.stringify(signaturePayload),
    signaturePayload,
    nextBlockIndex: Number(config.baseDealBlocks),
    complete: true,
    provenance: provenanceValue,
    games: data.games,
    pairs: data.pairs,
    failures: [],
  };
  value.checkpointIntegrity = {
    schema: 'sha256-v1',
    sha256: sha256Bytes(Buffer.from(JSON.stringify({
      schema: value.schema, signature: value.signature, signaturePayload: value.signaturePayload,
      nextBlockIndex: value.nextBlockIndex, complete: value.complete, provenance: value.provenance,
      games: value.games, pairs: value.pairs, failures: value.failures,
    }))),
  };
  return value;
}

function makeGamesAndPairs(baseSeed, blocks, levelValues, segments, config) {
  const games = [];
  const pairs = [];
  let group = 0;
  for (let block = 0; block < blocks; block += 1) {
    const seed = (baseSeed + block) >>> 0;
    const segment = segments.find((entry) => block >= entry.startBlockIndex && block < entry.endBlockIndex);
    for (const level of levelValues) {
      group += 1;
      const fingerprint = `${seed}-deal`;
      const firstPlayer = 0;
      const legs = [0, 1].map((candidateTeam) => {
        const order = candidateTeam === 0 ? [0, 1, 2, 3] : [1, 0, 3, 2];
        const seat = candidateTeam === 0 ? 0 : 1;
        const decisionTelemetry = [{
          seat,
          policy: config.candidate,
          engine: resolvePolicyVariant(config.candidate).decisionEngine,
          variantPresent: true,
          localDecisionPresent: true,
          searchTelemetryPresent: true,
          fallbackKindPresent: true,
          telemetryComplete: true,
          latencyMs: 400,
          source: 'fixture',
          fallbackKind: 'none',
          fallbackEvaluable: true,
          timeoutFallback: false,
          searchAttempted: true,
          searchTriggered: true,
          candidates: 1,
          samples: 1,
          nodes: 1,
          iterations: 1,
          rolloutBudget: 0,
          sweepBudget: 0,
          pairedSweeps: 0,
        }];
        const hybrid = {
          turns: 1,
          applied: 1,
          changed: 0,
          samples: 1,
          nodes: 1,
          iterations: 1,
          forceExpert: 0,
          wouldChange: 0,
          searchModes: { [config.candidateSearchConfig.searchMode]: 1 },
          reasons: { fixture: 1 },
          rejected: {},
        };
        const game = {
          ok: true,
          seed,
          level,
          candidateTeam,
          order,
          firstPlayer,
          dealFingerprint: fingerprint,
          upgrade: config.continuousMatch
            ? 1
            : describeFixtureUpgrade(order),
          utility: config.continuousMatch
            ? 1
            : describeFixtureUpgrade(order),
          candidateHead: true,
          comparisonHead: false,
          baselineHead: false,
          candidateDoubleUp: false,
          comparisonDoubleUp: false,
          baselineDoubleUp: false,
          firstDivergence: null,
          hybrid,
          decisionTelemetry,
          actions: config.continuousMatch ? 240 : 1,
          durationMs: 10,
          runSegmentId: segment.runSegmentId,
        };
        if (config.continuousMatch) {
          game.matchWinner = candidateTeam;
          game.rounds = 2;
          game.roundUpgradeUtility = 4;
          game.roundResults = [1, 2].map((round) => ({
            round,
            level: 2,
            levelsAfter: [2, 2],
            levelOwner: 0,
            order,
            upgrade: describeFixtureUpgrade(order),
            candidateUtility: describeFixtureUpgrade(order),
            aFailCount: [0, 0],
            aAttempt: false,
            aPassed: false,
            aFailed: false,
            aReset: false,
            tribute: round === 1,
            actions: 120,
          }));
        }
        return game;
      });
      games.push(...legs);
      pairs.push({
        group: config.continuousMatch ? block + 1 : group,
        block: block + 1,
        seed,
        level,
        runSegmentId: segment.runSegmentId,
        mirrorMatched: true,
        crossLevelMatched: true,
        dealFingerprint: fingerprint,
        complete: true,
        utility: config.continuousMatch ? 1 : 2,
        candidateHeads: 2,
        candidateDoubleUps: 0,
        comparisonDoubleUps: 0,
        orders: legs.map((game) => game.order),
        firstDivergences: [null, null],
      });
    }
  }
  return { games, pairs };
}

function describeFixtureUpgrade(order) {
  return describeUpgrade(order, (seat) => ([0, 2].includes(seat) ? 0 : 1)).levels;
}

function reportMetrics(data, config, candidate, searchMode) {
  const games = data.games;
  const pairs = data.pairs;
  const blocks = Number(config.baseDealBlocks);
  const continuous = config.continuousMatch === true;
  const completion = {
    gamesCompleted: games.length,
    mirrorPairsCompleted: pairs.length,
    baseDealBlocksCompleted: blocks,
    mirrorMismatches: 0,
    failures: 0,
    deadlocks: 0,
  };
  const result = {
    candidateUpgradeUtilityTotal: games.reduce((sum, game) => sum + game.utility, 0),
    candidateUpgradeUtilityPerGame: continuous ? 1 : 2,
    candidatePairedUtilityPerSeed: continuous ? 1 : 2,
    candidatePairedUtilityBootstrap95: continuous ? [1, 1] : [2, 2],
    candidateBlockedUtilityPerDeal: continuous ? 1 : 2,
    candidateHeads: games.length,
    comparisonHeads: 0,
    baselineHeads: 0,
    candidateHeadRate: 1,
    candidateHeadPairedBootstrap95: [1, 1],
    candidateHeadWilson95: wilsonFixture(games.length, games.length)
      .map((value) => Number(value.toFixed(3))),
    candidateElo: 2400,
    candidateDoubleUps: 0,
    comparisonDoubleUps: 0,
    baselineDoubleUps: 0,
    candidateDoubleUpDifferencePerGame: 0,
    candidateDoubleUpDifferencePairedBootstrap95: [0, 0],
  };
  const byLevel = Object.fromEntries((continuous ? [2] : levels).map((level) => {
    const levelGames = games.filter((game) => game.level === level);
    const levelPairs = pairs.filter((pair) => pair.level === level);
    return [String(level), {
      label: level === 14 ? 'A' : String(level),
      seedGroups: levelPairs.length,
      games: levelGames.length,
      candidateHeads: levelGames.length,
      comparisonHeads: 0,
      candidateHeadRate: 1,
      candidateDoubleUps: 0,
      comparisonDoubleUps: 0,
      candidateUtilityPerGame: continuous ? 1 : 2,
    }];
  }));
  const hybridTurns = games.length;
  const hybrid = {
    turns: hybridTurns,
    applied: hybridTurns,
    changed: 0,
    samples: hybridTurns,
    nodes: hybridTurns,
    iterations: hybridTurns,
    forceExpert: 0,
    wouldChange: 0,
    searchModes: { [searchMode]: hybridTurns },
    reasons: { fixture: hybridTurns },
    rejected: {},
    appliedRate: 1,
    changedRate: 0,
    wouldChangeRate: 0,
    averageSamplesPerTurn: 1,
    averageNodesPerAppliedTurn: 1,
    averageIterationsPerAppliedTurn: 1,
  };
  const continuousMatch = continuous ? {
    enabled: true,
    matches: games.length,
    rounds: 16,
    averageRoundsPerMatch: 2,
    maxRounds: 2,
    tributeRounds: 8,
    aAttempts: 0,
    aFailures: 0,
    aResets: 0,
    longRoundActionThreshold: 120,
    longRounds: 16,
    maxRoundActions: 120,
    candidateRoundUpgradeUtility: 32,
  } : {
    enabled: false,
    matches: 0,
    rounds: 0,
    averageRoundsPerMatch: null,
    maxRounds: null,
    tributeRounds: 0,
    aAttempts: 0,
    aFailures: 0,
    aResets: 0,
    longRoundActionThreshold: 120,
    longRounds: 0,
    maxRoundActions: null,
    candidateRoundUpgradeUtility: 0,
  };
  return { completion, result, byLevel, hybrid, continuousMatch };
}

function wilsonFixture(successes, total, z = 1.959963984540054) {
  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denominator;
  const radius = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total) / denominator;
  return [Math.max(0, center - radius), Math.min(1, center + radius)];
}

function clusterFixture(players, seed, iterations = 5000) {
  const rng = seededRandom((seed ^ 0x51ED270B) >>> 0);
  const rates = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let proposed = 0;
    let answered = 0;
    for (let index = 0; index < players.length; index += 1) {
      const player = players[Math.floor(rng() * players.length)];
      proposed += player.proposedPreferred;
      answered += player.answered;
    }
    rates.push(proposed / answered);
  }
  rates.sort((left, right) => left - right);
  return [rates[Math.floor(iterations * 0.025)], rates[Math.min(iterations - 1, Math.floor(iterations * 0.975))]];
}

function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let mixed = value;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function buildBlindManifest() {
  const sourcePath = path.join(temporary, 'blind-source.ndjson');
  const sourceRecords = Array.from({ length: 100 }, (_, index) => ({
    schema: 'guandan-blind-scenario-v1',
    seed: 500000 + index,
    level: 2 + (index % 13),
    candidateTeam: index % 2,
    turn: index + 1,
    observation: { seat: 0, handCounts: [4, 4, 4, 4], publicHistory: [] },
    divergence: {
      expert: { action: 'pass', cards: [] },
      proposed: { action: 'play', cards: [{ rank: 3, suit: 'S', deckIndex: 0 }], signature: 'single|1' },
    },
    evaluationImplementationSha256: implementation.sha256,
  }));
  const sourceText = `${sourceRecords.map((record) => JSON.stringify(record)).join('\n')}\n`;
  fs.writeFileSync(sourcePath, sourceText, 'utf8');
  const sourceSha256 = fileHash(sourcePath);
  const selected = sourceRecords.map((record) => ({
    ...record,
    id: `${sourceSha256}:${record.seed}:${record.level}:${record.candidateTeam}:${record.turn}`,
    sourceFileSha256: sourceSha256,
    evaluationImplementationSha256: implementation.sha256,
  }));
  const selectedPath = path.join(temporary, 'selected-scenarios.ndjson');
  const selectedText = `${selected.map((record) => JSON.stringify(record)).join('\n')}\n`;
  fs.writeFileSync(selectedPath, selectedText, 'utf8');
  const playerScenarioIds = Array.from({ length: 10 }, (_, index) => ({
    player: index + 1,
    scenarioIds: selected.filter((_, scenarioIndex) => scenarioIndex % 10 === index)
      .map((record) => record.id),
  }));
  const assignments = fixtureAssignments(selected, playerScenarioIds);
  return {
    schema: 'guandan-blind-eval-manifest-v2',
    selectedScenarios: selected.length,
    scenarioIds: selected.map((record) => record.id),
    players: 10,
    randomSeed: 7,
    selectedScenarioFile: path.basename(selectedPath),
    selectedScenarioSha256: fileHash(selectedPath),
    sourceFiles: [{
      file: path.basename(sourcePath),
      sha256: sourceSha256,
      validScenarioLines: sourceRecords.length,
      retainedScenarios: sourceRecords.length,
    }],
    allocation: {
      scheme: 'round-robin-without-replacement',
      repeatedScenarioRatings: false,
      playerQuestionCounts: playerScenarioIds.map((entry) => ({
        player: entry.player,
        questions: entry.scenarioIds.length,
      })),
      playerScenarioIds,
      assignmentBindings: assignments.bindings,
    },
  };
}

function segment(evaluationId, runSegmentId, ordinal, resume, inputCheckpointSha256, startBlockIndex, endBlockIndex) {
  return {
    schema: 'guandan-evaluation-run-segment-v1', evaluationId, runSegmentId, ordinal,
    resume, previousRunSegmentId: resume ? '22222222-2222-4222-8222-222222222222' : null,
    inputCheckpointSha256, startBlockIndex, endBlockIndex,
    startedAt: '2026-08-31T00:00:00.000Z', completedAt: '2026-08-31T00:01:00.000Z',
    process: { pid: 1234 + ordinal, ppid: 123 }, environment: structuredClone(environment),
  };
}

function provenance(evaluationId, runSegments) {
  return {
    schema: 'guandan-evaluation-provenance-v1', evaluationId, runSegments,
    runSegmentsSha256: sha256Canonical(runSegments),
  };
}

function fixtureAssignments(selected, playerScenarioIds) {
  const scenariosById = new Map(selected.map((scenario) => [scenario.id, scenario]));
  const byPlayer = new Map();
  const bindings = [];
  for (const entry of playerScenarioIds) {
    const rng = seededRandom((7 ^ Math.imul(entry.player, 0x9E3779B1)) >>> 0);
    const questions = [];
    const mapping = {};
    for (const id of entry.scenarioIds) {
      const scenario = scenariosById.get(id);
      if (!scenario) throw new Error(`fixture assignment 缺少场景：${id}`);
      const proposedIsA = rng() < 0.5;
      const [a, b] = proposedIsA
        ? [scenario.divergence.proposed, scenario.divergence.expert]
        : [scenario.divergence.expert, scenario.divergence.proposed];
      questions.push({ id, observation: scenario.observation, options: { A: a, B: b } });
      mapping[id] = {
        A: proposedIsA ? 'proposed' : 'expert',
        B: proposedIsA ? 'expert' : 'proposed',
      };
    }
    const assignmentSha256 = sha256Bytes(Buffer.from(JSON.stringify(questions), 'utf8'));
    const mappingSha256 = sha256Bytes(Buffer.from(JSON.stringify(mapping), 'utf8'));
    byPlayer.set(entry.player, { assignmentSha256, mapping });
    bindings.push({ player: entry.player, assignmentSha256, mappingSha256 });
  }
  return { byPlayer, bindings };
}

function blindSummary(manifest) {
  const selectedPath = path.join(temporary, manifest.selectedScenarioFile);
  const selected = fs.readFileSync(selectedPath, 'utf8').trimEnd().split(/\r?\n/)
    .filter(Boolean).map((line) => JSON.parse(line));
  const assignments = fixtureAssignments(
    selected,
    manifest.allocation.playerScenarioIds,
  );
  const players = Array.from({ length: manifest.players }, (_, index) => ({
    player: index + 1,
    submitted: true,
    assigned: manifest.allocation.playerScenarioIds[index].scenarioIds.length,
    answered: manifest.allocation.playerScenarioIds[index].scenarioIds.length,
    unanswered: 0,
    proposedPreferred: 6,
    proposedRate: 0.6,
  }));
  const answered = players.reduce((sum, player) => sum + player.answered, 0);
  const proposedPreferred = players.reduce((sum, player) => sum + player.proposedPreferred, 0);
  const answerLedger = [];
  for (const entry of manifest.allocation.playerScenarioIds) {
    const assignment = assignments.byPlayer.get(entry.player);
    entry.scenarioIds.forEach((id, index) => {
      const mapping = assignment.mapping[id];
      const side = index < 6 ? 'proposed' : 'expert';
      const choice = mapping.A === side ? 'A' : 'B';
      answerLedger.push({
        player: entry.player,
        id,
        choice,
        side,
        mapping,
        assignmentSha256: assignment.assignmentSha256,
      });
    });
  }
  return {
    schema: 'guandan-blind-eval-summary-v3',
    manifest: {
      randomSeed: manifest.randomSeed,
      selectedScenarios: manifest.scenarioIds.length,
      allocatedPlayers: manifest.players,
      sourceFiles: manifest.sourceFiles,
      selectedScenarioFile: manifest.selectedScenarioFile,
      selectedScenarioSha256: manifest.selectedScenarioSha256,
    },
    answerLedger,
    answerLedgerSha256: sha256Bytes(Buffer.from(JSON.stringify(answerLedger), 'utf8')),
    players,
    totals: {
      players: manifest.players,
      submittedPlayers: manifest.players,
      answered,
      unanswered: 0,
      proposedPreferred,
      proposedRate: 0.6,
      wilson95Diagnostic: wilsonFixture(proposedPreferred, answered, 1.96)
        .map((value) => Number(value.toFixed(4))),
      playerClusterBootstrap95: [0.6, 0.6],
      catastrophic: {
        reviewProvided: true,
        reviewedScenarios: manifest.scenarioIds.length,
        reviewComplete: true,
        scenarioDenominator: manifest.scenarioIds.length,
        selectionDiagnostic: { expert: 0, proposed: 0 },
        reviewed: { expert: 0, proposed: 0 },
        expertRate: 0,
        proposedRate: 0,
        proposedNotWorseThanExpert: true,
      },
    },
    invalidAnswers: [],
    gate: {
      criterion: 'fixture',
      checks: {
        minimumParticipants: true,
        minimumAnswersPerParticipant: true,
        fullCompletion: true,
        allocationWithoutRepeat: true,
        playerClusterBootstrap: true,
        catastropheReviewComplete: true,
        proposedCatastrophicNotWorse: true,
      },
      pass: true,
    },
  };
}

function expectedSearchConfig(candidate) {
  const variant = resolvePolicyVariant(candidate);
  return resolveHybridSearchConfig(variant.decisionEngine, { deterministic: true, timeBudgetMs: 0 });
}

function implementationManifest() {
  const jsDirectory = path.join(root, 'js');
  const pending = [path.join(jsDirectory, 'ai.ab.simulation.js')];
  const visited = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    const source = fs.readFileSync(file, 'utf8');
    for (const dependencyPath of [...source.matchAll(
      /\bfrom\s*['"](\.[^'"]+)['"]|\bimport\s*(?:\(\s*)?['"](\.[^'"]+)['"]|\bnew\s+URL\s*\(\s*['"](\.[^'"]+)['"]/g,
    )].map((match) => match[1] || match[2] || match[3])) {
      pending.push(path.resolve(path.dirname(file), dependencyPath));
    }
  }
  const files = [...visited].map((file) => `js/${path.relative(jsDirectory, file).split(path.sep).join('/')}`).sort();
  const sources = files.map((file) => ({ file, sha256: fileHash(path.join(root, file)) }));
  const hash = createHash('sha256');
  for (const source of sources) { hash.update(source.file); hash.update('\0'); hash.update(source.sha256); hash.update('\0'); }
  return { schema: 'guandan-evaluation-implementation-v2', sha256: hash.digest('hex'), sources };
}

function run(files, label) {
  const args = [validator];
  const flags = [
    ['--model', files.model || path.join(temporary, 'model.json')], ['--report', files.report || files.primary],
    ['--checkpoint', files.checkpoint], ['--raw-telemetry', files.rawTelemetry],
    ['--performance', files.performance], ['--continuous-report', files.continuousReport],
    ['--continuous-checkpoint', files.continuousCheckpoint], ['--blind-summary', files.blindSummary],
    ['--blind-manifest', files.blindManifest], ['--blind-scenarios', files.blindScenarios],
    ['--blind-catastrophic', files.blindCatastrophic], ['--blind-binding', files.blindBinding],
  ];
  for (const [flag, value] of flags) args.push(flag, value);
  if (files.out) args.push('--out', files.out);
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
  let report;
  try { report = JSON.parse(result.stdout); } catch (error) {
    throw new Error(`${label} 未输出 JSON：${error.message}\n${result.stdout}\n${result.stderr}`);
  }
  return { status: result.status, report, stderr: result.stderr };
}

function seedManifest(start, count) {
  return { schema: 'guandan-seed-manifest-v1', seeds: Array.from({ length: count }, (_, index) => start + index) };
}

function fileHash(file) { return sha256Bytes(fs.readFileSync(file)); }
function sha256Bytes(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function write(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
function read(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

function refreshCheckpointIntegrity(checkpoint) {
  checkpoint.checkpointIntegrity = {
    schema: 'sha256-v1',
    sha256: sha256Bytes(Buffer.from(JSON.stringify({
      schema: checkpoint.schema,
      signature: checkpoint.signature,
      signaturePayload: checkpoint.signaturePayload,
      nextBlockIndex: checkpoint.nextBlockIndex,
      complete: checkpoint.complete,
      provenance: checkpoint.provenance,
      games: checkpoint.games,
      pairs: checkpoint.pairs,
      failures: checkpoint.failures,
    }))),
  };
  return checkpoint;
}
