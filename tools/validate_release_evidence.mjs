#!/usr/bin/env node
/**
 * Strict, read-only release-evidence gate for a local value model.
 *
 * This differs from validate_value_evidence.mjs: historical reports using a
 * raw model-file hash may still be internally readable, but cannot prove that
 * the current semantic model payload was evaluated. A release receipt needs a
 * canonical payload hash on both reports and a mutually bound M3 report.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { validateHybridValueModel } from '../js/ai-hybrid.js';
import { modelPayloadSha256 } from '../js/model-fingerprint.js';
import { evaluateValueModelPromotion } from '../js/value-model-gate.js';

function parseArgs(argv) {
  const options = { model: null, report: null, continuousReport: null };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!['--model', '--report', '--continuous-report'].includes(key)) {
      throw new Error(`未知参数：${key}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${key} 需要文件路径`);
    if (key === '--model') options.model = value;
    if (key === '--report') options.report = value;
    if (key === '--continuous-report') options.continuousReport = value;
    index += 1;
  }
  if (!options.model || !options.report || !options.continuousReport) {
    throw new Error('用法：node tools/validate_release_evidence.mjs --model 模型.json --report 主A-B报告.json --continuous-report 连续赛报告.json');
  }
  return options;
}

function readJson(file, label) {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) throw new Error(`${label}不存在：${resolved}`);
  const bytes = fs.readFileSync(resolved);
  try {
    return { file: resolved, bytes, value: JSON.parse(bytes.toString('utf8')) };
  } catch (error) {
    throw new Error(`${label}不是有效 JSON：${error.message}`);
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function reportBinding(report, semanticHash) {
  const reported = String(report?.config?.valueModel?.sha256 || '').toLowerCase();
  return {
    reportedSha256: reported || null,
    semanticMatch: !!semanticHash && reported === semanticHash,
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const model = readJson(options.model, '模型');
  const primary = readJson(options.report, '主 A/B 报告');
  const continuous = readJson(options.continuousReport, '连续赛报告');
  const validation = validateHybridValueModel(model.value);
  const semanticHash = modelPayloadSha256(model.value);
  const primaryBinding = reportBinding(primary.value, semanticHash);
  const continuousBinding = reportBinding(continuous.value, semanticHash);
  const integrityReasons = [];
  if (!validation.ok) integrityReasons.push(`model_invalid:${validation.reason}`);
  if (!semanticHash) integrityReasons.push('model_payload_sha256_unavailable');
  if (!primaryBinding.semanticMatch) integrityReasons.push('primary_model_hash_mismatch');
  if (!continuousBinding.semanticMatch) integrityReasons.push('continuous_model_hash_mismatch');

  const promotion = semanticHash
    ? evaluateValueModelPromotion(primary.value, semanticHash, {
      continuousReport: continuous.value,
      continuousReportSha256: sha256(continuous.bytes),
    })
    : {
      ok: false,
      promoted: false,
      status: 'experimental',
      reasons: ['model_payload_sha256_unavailable'],
      metrics: null,
    };
  // `ok` only means the evidence is internally complete.  A release gate must
  // additionally require a strictly positive strength conclusion.
  const promoted = promotion.promoted === true;
  const releaseEvidenceReady = integrityReasons.length === 0 && promoted;
  const promotable = releaseEvidenceReady;
  const output = {
    schema: 'guandan-release-evidence-validation-v1',
    releaseEvidenceReady,
    promotable,
    status: promotion.status,
    model: {
      file: model.file,
      schema: model.value?.schema || null,
      valid: validation.ok,
      payloadSha256: semanticHash,
    },
    primaryReport: {
      file: primary.file,
      sha256: sha256(primary.bytes),
      ...primaryBinding,
      candidate: primary.value?.config?.candidate || null,
    },
    continuousReport: {
      file: continuous.file,
      sha256: sha256(continuous.bytes),
      ...continuousBinding,
      candidate: continuous.value?.config?.candidate || null,
      complete: continuous.value?.completion?.gamesCompleted === continuous.value?.config?.gamesPlanned,
    },
    reasons: [...integrityReasons, ...promotion.reasons],
    promotion,
  };
  console.log(JSON.stringify(output, null, 2));
  if (!releaseEvidenceReady) process.exitCode = 1;
}

main();
