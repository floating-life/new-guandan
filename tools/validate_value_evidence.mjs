#!/usr/bin/env node
/**
 * Audit the local value-model evidence bundle without mutating any artifact.
 *
 * New reports bind config.valueModel.sha256 to the semantic model payload hash.
 * Older reports used a raw model-file hash; this tool verifies that legacy link
 * explicitly, but labels it non-promotable until the A/B run is regenerated.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { validateHybridValueModel } from '../js/ai-hybrid.js';
import { modelPayloadSha256 } from '../js/model-fingerprint.js';
import { normalizeSeedManifest, seedManifestOverlap } from '../js/value-model-gate.js';

function parseArgs(argv) {
  const options = {
    model: null,
    report: null,
    continuousCheckpoint: null,
    requireCompleteCheckpoint: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--require-complete-checkpoint') {
      options.requireCompleteCheckpoint = true;
      continue;
    }
    if (!['--model', '--report', '--continuous-checkpoint'].includes(key)) {
      throw new Error(`未知参数：${key}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${key} 需要文件路径`);
    if (key === '--model') options.model = value;
    if (key === '--report') options.report = value;
    if (key === '--continuous-checkpoint') options.continuousCheckpoint = value;
    index += 1;
  }
  if (!options.model || !options.report) {
    throw new Error('用法：node tools/validate_value_evidence.mjs --model 模型.json --report A-B报告.json [--continuous-checkpoint 检查点.json] [--require-complete-checkpoint]');
  }
  return options;
}

function readRequired(file, label) {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) throw new Error(`${label}不存在：${resolved}`);
  return { file: resolved, bytes: fs.readFileSync(resolved) };
}

function parseJson(bytes, label) {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch (error) { throw new Error(`${label}不是有效 JSON：${error.message}`); }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sameSeedManifest(left, right) {
  if (!left || !right || left.seeds.length !== right.seeds.length) return false;
  return left.seeds.every((seed, index) => seed === right.seeds[index]);
}

function completeLevelCoverage(levels) {
  const normalized = new Set((Array.isArray(levels) ? levels : [])
    .map(Number).filter((level) => Number.isInteger(level) && level >= 2 && level <= 14));
  return normalized.size === 13;
}

function auditCheckpoint(file) {
  const value = parseJson(readRequired(file, '连续赛检查点').bytes, '连续赛检查点');
  const config = typeof value.signature === 'string' ? (() => {
    try { return JSON.parse(value.signature); } catch { return null; }
  })() : null;
  const valid = ['guandan-ai-ab-checkpoint-v1', 'guandan-ai-ab-checkpoint-v2', 'guandan-ai-ab-checkpoint-v3'].includes(value?.schema)
    && Number.isInteger(value?.nextBlockIndex)
    && Number.isInteger(config?.groupCount)
    && config.groupCount > 0
    && value.nextBlockIndex >= 0
    && value.nextBlockIndex <= config.groupCount
    && Array.isArray(value?.games)
    && Array.isArray(value?.pairs)
    && Array.isArray(value?.failures);
  return {
    file: path.resolve(file),
    schema: value?.schema || null,
    valid,
    complete: value?.complete === true,
    completedBlocks: Number.isInteger(value?.nextBlockIndex) ? value.nextBlockIndex : null,
    plannedBlocks: Number.isInteger(config?.groupCount) ? config.groupCount : null,
    gamesRecorded: Array.isArray(value?.games) ? value.games.length : null,
    pairsRecorded: Array.isArray(value?.pairs) ? value.pairs.length : null,
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const modelFile = readRequired(options.model, '模型');
  const reportFile = readRequired(options.report, 'A/B 报告');
  const model = parseJson(modelFile.bytes, '模型');
  const report = parseJson(reportFile.bytes, 'A/B 报告');
  const modelValidation = validateHybridValueModel(model);
  const modelSha256 = modelPayloadSha256(model);
  const fileSha256 = sha256(modelFile.bytes);
  const reportedSha256 = String(report?.config?.valueModel?.sha256 || '').toLowerCase();
  const canonicalMatch = !!modelSha256 && reportedSha256 === modelSha256;
  const legacyFileMatch = reportedSha256 === fileSha256;
  const errors = [];
  const config = report?.config || {};
  const completion = report?.completion || {};
  const evaluationSeeds = normalizeSeedManifest(config.evaluationSeedManifest);
  const modelTrainingSeeds = normalizeSeedManifest(
    model?.metadata?.trainingSeedManifest || model?.metadata?.trainingData?.seedManifest,
  );
  const reportTrainingSeeds = normalizeSeedManifest(
    config?.valueModel?.trainingSeedManifest || config?.valueModel?.trainingData?.seedManifest,
  );
  const blocksPlanned = Number(config.baseDealBlocks);
  const levels = config.evaluationLevels;
  const gamesPlanned = Number(config.gamesPlanned);
  const gamesCompleted = Number(completion.gamesCompleted);
  const pairsCompleted = Number(completion.mirrorPairsCompleted);
  const blocksCompleted = Number(completion.baseDealBlocksCompleted);
  const expectedGames = Number.isInteger(blocksPlanned) && blocksPlanned > 0
    && Array.isArray(levels) ? blocksPlanned * levels.length * 2 : null;
  const expectedPairs = expectedGames == null ? null : expectedGames / 2;
  const evaluationOverlap = seedManifestOverlap(evaluationSeeds, modelTrainingSeeds);
  if (!modelValidation.ok) errors.push(`model_invalid:${modelValidation.reason}`);
  if (!modelSha256) errors.push('model_payload_sha256_unavailable');
  if (!report?.config || !report?.completion || !report?.result) errors.push('ab_report_shape_invalid');
  if (!canonicalMatch && !legacyFileMatch) errors.push('ab_report_model_hash_mismatch');
  if (!evaluationSeeds || evaluationSeeds.seeds.length !== blocksPlanned) {
    errors.push('ab_evaluation_seed_manifest_invalid');
  }
  if (!modelTrainingSeeds || !reportTrainingSeeds || !sameSeedManifest(modelTrainingSeeds, reportTrainingSeeds)) {
    errors.push('ab_training_seed_manifest_mismatch');
  }
  if (evaluationOverlap.length) errors.push('ab_training_evaluation_seed_overlap');
  if (!completeLevelCoverage(levels) || expectedGames == null) errors.push('ab_level_coverage_invalid');
  if (gamesPlanned !== expectedGames || gamesCompleted !== gamesPlanned
    || pairsCompleted !== expectedPairs || blocksCompleted !== blocksPlanned
    || Number(config.seedGroups) !== expectedPairs) {
    errors.push('ab_completion_counts_invalid');
  }
  if (Number(completion.failures) !== 0 || Number(completion.deadlocks) !== 0
    || Number(completion.mirrorMismatches) !== 0) {
    errors.push('ab_safety_counts_invalid');
  }
  if (String(config.evaluationDesign) !== 'same-deal-cross-level-blocks'
    || String(config.comparison) !== 'expert'
    || config.continuousMatch !== false) {
    errors.push('ab_design_invalid');
  }
  if (String(config?.valueModel?.trainingDatasetSha256 || '').toLowerCase()
    !== String(model?.metadata?.trainingDatasetSha256 || model?.metadata?.trainingData?.sha256 || '').toLowerCase()) {
    errors.push('ab_training_dataset_hash_mismatch');
  }
  const checkpoint = options.continuousCheckpoint ? auditCheckpoint(options.continuousCheckpoint) : null;
  if (checkpoint && !checkpoint.valid) errors.push('continuous_checkpoint_invalid');
  if (checkpoint && options.requireCompleteCheckpoint && !checkpoint.complete) {
    errors.push('continuous_checkpoint_incomplete');
  }
  const reportCompletion = report?.completion || {};
  const output = {
    schema: 'guandan-value-evidence-validation-v1',
    // `integrityOk` 只说明声明的历史工件可读且内部一致；它不等同于当前
    // 模型可发布。调用方必须同时检查 releaseCompatible，正式发布则用
    // validate_release_evidence.mjs 的严格互绑门禁。
    integrityOk: errors.length === 0,
    releaseCompatible: canonicalMatch,
    ok: errors.length === 0,
    model: {
      file: modelFile.file,
      schema: model.schema || null,
      valid: modelValidation.ok,
      payloadSha256: modelSha256,
      fileSha256,
    },
    abReport: {
      file: reportFile.file,
      reportedModelSha256: reportedSha256 || null,
      binding: canonicalMatch ? 'canonical_payload_v2' : legacyFileMatch ? 'legacy_file_v1' : 'mismatch',
      releaseCompatible: canonicalMatch,
      gamesCompleted: gamesCompleted || 0,
      gamesPlanned: gamesPlanned || 0,
      mirrorPairsCompleted: pairsCompleted || 0,
      mirrorPairsPlanned: expectedPairs || 0,
      baseDealBlocksCompleted: blocksCompleted || 0,
      baseDealBlocksPlanned: blocksPlanned || 0,
      trainingEvaluationSeedOverlap: evaluationOverlap,
      failures: Number(reportCompletion.failures) || 0,
      deadlocks: Number(reportCompletion.deadlocks) || 0,
      mirrorMismatches: Number(reportCompletion.mirrorMismatches) || 0,
    },
    continuousCheckpoint: checkpoint,
    errors,
  };
  console.log(JSON.stringify(output, null, 2));
  if (!output.integrityOk) process.exitCode = 1;
}

main();
