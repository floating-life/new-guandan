#!/usr/bin/env node
/** Regression: release evidence exits successfully only for promoted evidence. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { modelPayloadSha256 } from '../js/model-fingerprint.js';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(toolsDir, '..');
const validator = path.join(root, 'tools', 'validate_release_evidence.mjs');

function parseOutput(result, label) {
  assert.equal(result.error, undefined, `${label} 应正常启动`);
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${label} 未输出有效 JSON：${error.message}\n${result.stdout}\n${result.stderr}`);
  }
}

function invoke(args, label) {
  const result = spawnSync(process.execPath, [validator, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10000,
  });
  return { result, report: parseOutput(result, label) };
}

function seedManifest(start, count) {
  return {
    schema: 'guandan-seed-manifest-v1',
    seeds: Array.from({ length: count }, (_, index) => start + index),
  };
}

function releaseFixture(utilityCI) {
  const model = {
    id: 'release-evidence-fixture',
    schema: 'guandan-candidate-v1',
    layers: [{ weights: [new Array(32).fill(0)], bias: [0], activation: 'linear' }],
  };
  const semanticHash = modelPayloadSha256(model);
  assert(semanticHash, '合成模型必须有语义哈希');
  const trainingSeeds = seedManifest(100000, 40);
  const evaluationSeeds = seedManifest(200000, 40);
  const continuousSeeds = seedManifest(300000, 4);
  const audit = {
    sha256: semanticHash,
    id: model.id,
    trainingSeedManifest: trainingSeeds,
    trainingDatasetSha256: 'b'.repeat(64),
  };
  const levels = Array.from({ length: 13 }, (_, index) => index + 2);
  const primary = {
    config: {
      candidate: 'ismcts-v1',
      comparison: 'expert',
      evaluationLevels: levels,
      evaluationDesign: 'same-deal-cross-level-blocks',
      evaluationSeedManifest: evaluationSeeds,
      valueModel: audit,
      gamesPlanned: 1040,
      baseDealBlocks: 40,
      deterministic: true,
      difficulty: 'master',
    },
    completion: {
      gamesCompleted: 1040,
      mirrorPairsCompleted: 520,
      baseDealBlocksCompleted: 40,
      failures: 0,
      deadlocks: 0,
      mirrorMismatches: 0,
    },
    result: { candidatePairedUtilityBootstrap95: utilityCI },
    byLevel: Object.fromEntries(levels.map((level) => [String(level), {
      games: 80,
      candidateUtilityPerGame: 0.02,
      candidateHeadRate: 0.5,
    }])),
  };
  const continuous = {
    config: {
      seedGroups: 4,
      baseDealBlocks: 4,
      baseSeed: 300000,
      evaluationSeedManifest: continuousSeeds,
      gamesPlanned: 8,
      continuousMatch: true,
      outcomeUnit: 'match win (+1/-1)',
      candidate: 'ismcts-v1',
      comparison: 'expert',
      deterministic: true,
      difficulty: 'master',
      valueModel: audit,
    },
    completion: {
      gamesCompleted: 8,
      mirrorPairsCompleted: 4,
      failures: 0,
      deadlocks: 0,
      mirrorMismatches: 0,
    },
    continuousMatch: {
      enabled: true,
      matches: 8,
      rounds: 24,
      tributeRounds: 8,
      longRoundActionThreshold: 120,
      longRounds: 4,
    },
  };
  return { model, primary, continuous };
}

function writeFixture(directory, fixture) {
  fs.mkdirSync(directory, { recursive: true });
  const modelFile = path.join(directory, 'model.json');
  const primaryFile = path.join(directory, 'primary.json');
  const continuousFile = path.join(directory, 'continuous.json');
  for (const [file, value] of [[modelFile, fixture.model], [primaryFile, fixture.primary], [continuousFile, fixture.continuous]]) {
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }
  return ['--model', modelFile, '--report', primaryFile, '--continuous-report', continuousFile];
}

const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'guandan-release-evidence-'));
try {
  console.log('严格发布证据：主 A/B 绑定旧文件哈希时必须被拒绝');
  {
    const fixture = releaseFixture([0.01, 0.18]);
    fixture.primary.config.valueModel = {
      ...fixture.primary.config.valueModel,
      sha256: 'a'.repeat(64),
    };
    const { result, report } = invoke(
      writeFixture(path.join(fixtureDirectory, 'legacy-file-hash'), fixture),
      '历史旧工件口径',
    );
    assert.equal(result.status, 1, '主 A/B 使用旧文件哈希时必须返回非零退出码');
    assert.equal(report.releaseEvidenceReady, false, '旧文件哈希工件不能标记为可发布');
    assert.equal(report.promotable, false, '旧文件哈希工件不能晋级模型');
    assert.equal(report.primaryReport.semanticMatch, false, '主 A/B 不得被当成语义哈希匹配');
    assert.equal(report.continuousReport.semanticMatch, true,
      '独立连续赛应仍能绑定当前模型语义哈希');
    assert(report.reasons.includes('primary_model_hash_mismatch'),
      '严格门禁必须指出主 A/B 使用了旧文件哈希');
    assert.equal(report.promotion.promoted, false,
      'CI 下界为正也不能用旧文件哈希主报告晋级');
  }

  console.log('严格发布证据：完整但 CI 下界不正的工件必须被拒绝');
  {
    const { result, report } = invoke(
      writeFixture(path.join(fixtureDirectory, 'non-promoted'), releaseFixture([-0.01, 0.18])),
      '完整但未晋级工件',
    );
    assert.equal(report.primaryReport.semanticMatch, true, '主 A/B 必须绑定模型语义哈希');
    assert.equal(report.continuousReport.semanticMatch, true, '连续赛必须绑定模型语义哈希');
    assert.equal(report.promotion.ok, true, '完整工件应通过完整性和 M3 质量检查');
    assert.equal(report.promotion.promoted, false, 'CI 下界不正时不得晋级');
    assert.equal(report.releaseEvidenceReady, false, '未晋级工件不得标记为发布就绪');
    assert.equal(report.promotable, false, '未晋级工件不得标记为可发布');
    assert.equal(result.status, 1, '未晋级工件必须返回非零退出码');
  }

  console.log('严格发布证据：完整可晋级工件必须通过');
  {
    const { result, report } = invoke(
      writeFixture(path.join(fixtureDirectory, 'promoted'), releaseFixture([0.01, 0.18])),
      '完整可晋级工件',
    );
    assert.equal(report.promotion.ok, true, '完整可晋级工件应通过完整性和 M3 质量检查');
    assert.equal(report.promotion.promoted, true, 'CI 下界为正的完整工件必须晋级');
    assert.equal(report.releaseEvidenceReady, true, '已晋级工件必须标记为发布就绪');
    assert.equal(report.promotable, true, '已晋级工件必须标记为可发布');
    assert.equal(result.status, 0, '已晋级工件必须返回零退出码');
  }
} finally {
  fs.rmSync(fixtureDirectory, { recursive: true, force: true });
}

console.log('Strict release evidence: promoted state exclusively controls successful exit');
