#!/usr/bin/env node
/** Minimal end-to-end regression for the A/B runner and its decision telemetry. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  collectDecisionTelemetry,
  summarizeAllAIDecisionTelemetry,
} from '../js/ai.ab.telemetry.js';
import { sha256Canonical } from '../js/ai.ab.provenance.js';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(toolsDir, '..');
const runner = path.join(root, 'js', 'ai.ab.simulation.js');
// These child processes exercise deterministic multi-game search closures on
// an unisolated desktop.  This is a completion watchdog only; product latency
// is evaluated separately from the emitted decision telemetry.
const TEST_RUNNER_TIMEOUT_MS = 90000;

function localModuleReferences(source) {
  return [...source.matchAll(
    /\bfrom\s*['"](\.[^'"]+)['"]|\bimport\s*(?:\(\s*)?['"](\.[^'"]+)['"]|\bnew\s+URL\s*\(\s*['"](\.[^'"]+)['"]/g,
  )].map((match) => match[1] || match[2] || match[3]);
}

function collectEvaluationRuntimeClosure(entryFile) {
  const jsDirectory = path.join(root, 'js');
  const pending = [path.resolve(entryFile)];
  const visited = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    const source = fs.readFileSync(file, 'utf8');
    // The production manifest is deliberately explicit.  This independent,
    // test-only traversal covers ESM static/dynamic imports and the Worker
    // module URL so a future dependency cannot silently escape the receipt.
    for (const dependencyPath of localModuleReferences(source)) {
      const dependency = path.resolve(path.dirname(file), dependencyPath);
      assert.equal(path.extname(dependency), '.js',
        `评测本地依赖必须显式指向 .js：${dependencyPath}`);
      assert(dependency === jsDirectory || dependency.startsWith(`${jsDirectory}${path.sep}`),
        `评测依赖不得逃出 js 目录：${dependencyPath}`);
      assert(fs.existsSync(dependency), `评测依赖不存在：${dependencyPath}`);
      pending.push(dependency);
    }
  }
  return [...visited]
    .map((file) => `js/${path.relative(jsDirectory, file).split(path.sep).join('/')}`)
    .sort();
}

assert.deepEqual(localModuleReferences([
  "import './side-effect.js';",
  "import value from './static.js';",
  "await import('./dynamic.js');",
  "new URL('./ai.worker.js', import.meta.url);",
].join('\n')), [
  './side-effect.js', './static.js', './dynamic.js', './ai.worker.js',
], '闭包扫描必须覆盖副作用/静态/动态 import 与 Worker URL');

function completeMeta(overrides = {}) {
  return {
    localDecision: { latencyMs: 12, source: 'fixture' },
    searchAttempted: false,
    searchTriggered: false,
    fallbackKind: 'none',
    hybrid: {},
    ...overrides,
  };
}

function checkpointContent(checkpoint) {
  return {
    schema: checkpoint.schema,
    signature: checkpoint.signature,
    signaturePayload: checkpoint.signaturePayload,
    nextBlockIndex: checkpoint.nextBlockIndex,
    complete: checkpoint.complete,
    provenance: checkpoint.provenance,
    games: checkpoint.games,
    pairs: checkpoint.pairs,
    failures: checkpoint.failures,
  };
}

function refreshCheckpointIntegrity(checkpoint) {
  checkpoint.checkpointIntegrity = {
    schema: 'sha256-v1',
    sha256: createHash('sha256')
      .update(JSON.stringify(checkpointContent(checkpoint)))
      .digest('hex'),
  };
  return checkpoint;
}

function refreshProvenance(checkpoint) {
  checkpoint.provenance.runSegmentsSha256 = sha256Canonical(checkpoint.provenance.runSegments);
  return checkpoint;
}

function checkpointGameKeys(checkpoint) {
  return new Set((checkpoint.games || []).map((game) => (
    `${game.seed}/${game.level}/${game.candidateTeam}`
  )));
}

function fileSha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function runCheckpointResume(args) {
  return spawnSync(process.execPath, [...args, '--resume'], {
    cwd: root,
    encoding: 'utf8',
    timeout: TEST_RUNNER_TIMEOUT_MS,
  });
}

function writeCheckpointCopies(checkpointPath, checkpoint) {
  const text = `${JSON.stringify(checkpoint)}\n`;
  fs.writeFileSync(checkpointPath, text, 'utf8');
  fs.writeFileSync(`${checkpointPath}.last-valid`, text, 'utf8');
}

function waitForExit(child, timeoutMs, label) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} 超时`));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function waitForOutput(child, pattern, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      reject(new Error(`${label} 未在时限内输出 ${pattern}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
      const match = output.match(pattern);
      if (match) {
        clearTimeout(timer);
        resolve(match);
      }
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`${label} 提前退出（${code}）：${output}`));
    });
  });
}

function waitForCheckpointProgress(checkpointPath, minimumNextBlockIndex, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      try {
        const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
        if (Number(checkpoint?.nextBlockIndex) >= minimumNextBlockIndex) {
          resolve(checkpoint);
          return;
        }
      } catch {
        // The writer uses atomic replacement; retry until a complete snapshot appears.
      }
      if (Date.now() >= deadline) {
        reject(new Error(`${label} 未在时限内写出第 ${minimumNextBlockIndex} 个区组 checkpoint`));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

console.log('生产者负例：缺元数据的决策仍须进入总账');
{
  const variantBySeat = {
    0: { name: 'expert', decisionEngine: 'expert' },
    1: { name: 'ismcts-v3', decisionEngine: 'ismcts-v3' },
    2: { name: 'expert', decisionEngine: 'expert' },
  };
  const state = {
    trickLog: [
      { seat: 0, decisionMeta: completeMeta() },
      {
        seat: 1,
        decisionMeta: completeMeta({
          localDecision: { latencyMs: 240, source: 'fixture' },
          searchAttempted: true,
          searchTriggered: true,
        }),
      },
      { seat: 2, decisionMeta: { searchAttempted: false, searchTriggered: false, fallbackKind: 'none' } },
      { seat: 3, decisionMeta: completeMeta({ localDecision: { latencyMs: 30, source: 'fixture' } }) },
      { seat: 0, decisionMeta: { localDecision: { latencyMs: 14, source: 'fixture' }, fallbackKind: 'none' } },
      {
        seat: 1,
        decisionMeta: {
          localDecision: { latencyMs: 16, source: 'fixture' },
          searchAttempted: false,
          searchTriggered: false,
        },
      },
    ],
  };
  const records = collectDecisionTelemetry(state, variantBySeat);
  const allAIDecisions = summarizeAllAIDecisionTelemetry(records);
  assert.equal(records.length, state.trickLog.length,
    'trickLog 每一手都必须入账，缺策略或本地耗时不得被丢弃');
  assert.equal(allAIDecisions.decisionTurns, state.trickLog.length,
    '全体 AI 总账分母必须等于逐手记录数');
  assert.equal(allAIDecisions.missingVariantTurns, 1, '缺座位策略必须计入 missingVariantTurns');
  assert.equal(allAIDecisions.missingLocalDecisionTurns, 1,
    '缺 localDecision 必须计入 missingLocalDecisionTurns');
  assert.equal(allAIDecisions.missingSearchTelemetryTurns, 1,
    '缺 searchAttempted/searchTriggered 必须计入 missingSearchTelemetryTurns');
  assert.equal(allAIDecisions.missingFallbackKindTurns, 1,
    '缺 fallbackKind 必须计入 missingFallbackKindTurns');
  assert.equal(allAIDecisions.unmeasuredDecisionTurns, 2,
    '缺 variant 或 localDecision 的两手必须计入未测量，不得混入 0ms');
  assert.equal(allAIDecisions.measuredDecisionTurns, 4,
    '有耗时的决策仍计入已测量，即使搜索或回退字段缺失');
  assert.equal(allAIDecisions.searchTriggered.decisionTurns, 1,
    '回归前提：候选 searchTriggered 子集仍只有一手且完整');
  assert.equal(allAIDecisions.searchTriggered.measuredDecisionTurns, 1,
    '回归前提：searchTriggered 子集覆盖率仍为 100%');
  assert.equal(allAIDecisions.integrityComplete, false,
    '任一缺失元数据都必须使 integrityComplete=false');
  assert.equal(records.filter((item) => item.policy === '__unattributed__').length, 1,
    '缺策略的决策必须保留为未归属，而不是从分母消失');
}
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'guandan-ab-checkpoint-'));
const result = spawnSync(process.execPath, [
  runner,
  '1',
  '990001',
  'root-pimc-v1',
  'expert',
  '--levels=2',
  '--summary-only',
  '--json',
], {
  cwd: root,
  encoding: 'utf8',
  timeout: TEST_RUNNER_TIMEOUT_MS,
});

assert.equal(result.status, 0,
  `A/B smoke 应完成：${String(result.stderr || result.stdout).slice(-1200)}`);
let report;
try {
  report = JSON.parse(result.stdout);
} catch (error) {
  throw new Error(`A/B smoke 未输出有效 JSON：${error.message}\n${result.stdout.slice(-1200)}`);
}

assert.equal(report.completion?.gamesCompleted, 2, '一组双腿镜像必须完整完成两局');
assert.equal(report.completion?.mirrorPairsCompleted, 1, '一组双腿镜像必须产出一对镜像');
assert.equal(report.completion?.failures, 0, 'A/B smoke 不得有运行失败');
assert.equal(report.completion?.deadlocks, 0, 'A/B smoke 不得死锁');
assert.equal(report.schema, 'guandan-ai-ab-report-v1', 'A/B 报告必须声明 provenance 绑定 schema');
const reportProvenance = report.provenance;
assert.equal(reportProvenance?.schema, 'guandan-evaluation-provenance-v1',
  'A/B 报告必须包含运行 provenance');
assert.match(reportProvenance?.evaluationId || '', /^[0-9a-f-]{36}$/i,
  '评测必须生成持久化 evaluationId');
assert.equal(reportProvenance?.runSegments?.length, 1,
  '新鲜 smoke 必须形成一个运行段');
const smokeSegment = reportProvenance?.runSegments?.[0];
assert.equal(smokeSegment?.resume, false, '第一运行段不得伪装为 resume');
assert.equal(smokeSegment?.startBlockIndex, 0, '第一运行段必须从第一个区组开始');
assert.equal(smokeSegment?.endBlockIndex, 1, '第一运行段必须精确覆盖 smoke 区组');
assert.equal(smokeSegment?.environment?.runtime?.node, process.version,
  '机器与 Node provenance 必须由评测进程写入');
assert.match(smokeSegment?.environment?.machine?.hostnameSha256 || '', /^[a-f0-9]{64}$/,
  '评测机标识必须只记录稳定哈希，不泄露原始 hostname');
assert.match(reportProvenance?.runSegmentsSha256 || '', /^[a-f0-9]{64}$/,
  '报告必须绑定整个运行段链摘要');
const evaluationImplementation = report.config?.evaluationImplementation;
assert.equal(evaluationImplementation?.schema, 'guandan-evaluation-implementation-v2',
  '评测回执必须声明完整依赖闭包的 v2 实现摘要');
const receiptSources = (evaluationImplementation?.sources || []).map((source) => source.file).sort();
assert.deepEqual(receiptSources, collectEvaluationRuntimeClosure(runner),
  '评测回执源码清单必须精确覆盖 runner、game.js 及其 Worker/评价/存储闭包');
assert.equal(receiptSources.length, 22, '当前评测依赖闭包必须包含运行环境遥测、实时复盘契约与密封训练捕获在内的 22 个源码文件');
for (const source of evaluationImplementation.sources) {
  assert.match(source.sha256, /^[a-f0-9]{64}$/,
    `评测依赖必须记录有效 SHA-256：${source.file}`);
}

const byPolicy = report.performance?.decisionLatencyByPolicy || {};
const summaries = Object.values(byPolicy);
assert(summaries.length > 0, 'A/B report 必须包含按策略聚合的决策遥测');
for (const summary of summaries) {
  assert(Number.isInteger(summary.decisionTurns) && summary.decisionTurns > 0,
    '每个策略必须记录至少一次决策');
  assert(Number.isInteger(summary.measuredDecisionTurns)
    && Number.isInteger(summary.unmeasuredDecisionTurns)
    && summary.measuredDecisionTurns + summary.unmeasuredDecisionTurns === summary.decisionTurns,
  '已测量与未测量决策数必须完整分账');
  assert.equal(summary.measuredDecisionTurns, summary.decisionTurns,
    '同步 0 号位与 worker 座位均须记录真实决策耗时');
  assert(summary.searchTriggered && typeof summary.searchTriggered === 'object'
    && summary.searchTriggered.decisionTurns <= summary.decisionTurns
    && summary.searchTriggered.measuredDecisionTurns <= summary.searchTriggered.decisionTurns,
  '报告必须单列 search-triggered 回合及其测量覆盖率');
  assert(Number.isInteger(summary.fallbackEvaluableTurns)
    && summary.fallbackEvaluableTurns <= summary.decisionTurns,
  '回退率分母必须只包含可判定回合');
  assert(summary.timeoutFallbackRate == null
    || (summary.timeoutFallbackRate >= 0 && summary.timeoutFallbackRate <= 1),
  '回退率必须是空值或合法概率');
}
const allAIDecisions = report.performance?.allAIDecisions;
assert(allAIDecisions && typeof allAIDecisions === 'object',
  'A/B report 必须同时保留所有 AI 决策的遥测总账');
assert.equal(allAIDecisions.schema, 'guandan-evaluation-decision-telemetry-v2',
  '全体 AI 决策遥测必须声明可审计的 schema');
assert(Number.isInteger(allAIDecisions.decisionTurns) && allAIDecisions.decisionTurns > 0,
  '全体 AI 决策遥测必须记录至少一次决策');
assert.equal(allAIDecisions.measuredDecisionTurns + allAIDecisions.unmeasuredDecisionTurns,
  allAIDecisions.decisionTurns,
  '全体 AI 决策遥测的已测量与未测量回合必须守恒');
assert.equal(allAIDecisions.decisionTurns,
  summaries.reduce((total, summary) => total + summary.decisionTurns, 0),
  '健康路径的全体 AI 决策总账必须等于按策略分账之和');
assert.equal(allAIDecisions.measuredDecisionTurns, allAIDecisions.decisionTurns,
  '健康路径不能让全体 AI 决策中出现未测量回合');
assert.equal(allAIDecisions.integrityComplete, true,
  '健康路径的全体 AI 决策遥测必须完整');
for (const field of [
  'missingVariantTurns',
  'missingLocalDecisionTurns',
  'missingSearchTelemetryTurns',
  'missingFallbackKindTurns',
]) {
  assert.equal(allAIDecisions[field], 0,
    `健康路径的全体 AI 决策遥测不得出现 ${field}`);
}
const smokeSegmentPerformance = report.performance?.byRunSegment;
assert.equal(smokeSegmentPerformance?.length, 1,
  '报告必须为每个运行段单列性能聚合');
assert.equal(smokeSegmentPerformance?.[0]?.runSegmentId, smokeSegment?.runSegmentId,
  '段性能必须与 provenance 的 runSegmentId 一一对应');
assert.equal(smokeSegmentPerformance?.[0]?.gamesCompleted, 2,
  '段性能必须可归属全部镜像游戏对象');

// A mirror pair with the exact same policy on both sides is a state-isolation
// control, not strength evidence.  It catches evaluation state leaking from
// the first leg (for example a persisted adaptive opponent profile) into the
// second leg: all paired outcome components must cancel exactly.
const selfControl = spawnSync(process.execPath, [
  runner,
  '1',
  '990003',
  'expert',
  'expert',
  '--levels=2',
  '--level-blocks',
  '--json',
], {
  cwd: root,
  encoding: 'utf8',
  timeout: TEST_RUNNER_TIMEOUT_MS,
});
assert.equal(selfControl.status, 0,
  `同策略镜像状态隔离控制必须完成：${String(selfControl.stderr || selfControl.stdout).slice(-1200)}`);
let selfControlReport;
try {
  selfControlReport = JSON.parse(selfControl.stdout);
} catch (error) {
  throw new Error(`同策略镜像状态隔离控制未输出有效 JSON：${error.message}`);
}
assert.equal(selfControlReport.completion?.failures, 0, '同策略镜像控制不得有运行失败');
assert.equal(selfControlReport.completion?.deadlocks, 0, '同策略镜像控制不得死锁');
assert.equal(selfControlReport.result?.candidateUpgradeUtilityTotal, 0,
  '同策略镜像的配对效用必须严格为零');
assert.equal(selfControlReport.result?.candidateHeads, selfControlReport.result?.comparisonHeads,
  '同策略镜像的头游计数必须严格相等');
assert.equal(selfControlReport.result?.candidateDoubleUps,
  selfControlReport.result?.comparisonDoubleUps,
  '同策略镜像的双上计数必须严格相等');

// The force-expert arm still runs the production ISMCTS path, but it must be
// mechanically indistinguishable from expert at the outcome level.  Pair it
// with the normal arm on one fresh deterministic block so the telemetry is
// checked object-by-object on the actual evaluator path rather than by a
// synthetic fixture only.
const fxeCheckpoint = path.join(temporary, 'fxe-isolation.checkpoint.json');
const normalCheckpoint = path.join(temporary, 'normal-isolation.checkpoint.json');
const fxeArgs = [
  runner,
  '1',
  '990004',
  'ismcts-v3-fxe',
  'expert',
  '--levels=2',
  '--level-blocks',
  '--summary-only',
  '--json',
  `--checkpoint=${fxeCheckpoint}`,
];
const fxeControl = spawnSync(process.execPath, fxeArgs, {
  cwd: root,
  encoding: 'utf8',
  timeout: TEST_RUNNER_TIMEOUT_MS,
});
assert.equal(fxeControl.status, 0,
  `强制专家正式路径控制必须完成：${String(fxeControl.stderr || fxeControl.stdout).slice(-1200)}`);
const normalControl = spawnSync(process.execPath, [
  runner,
  '1',
  '990004',
  'ismcts-v3',
  'expert',
  '--levels=2',
  '--level-blocks',
  '--summary-only',
  '--json',
  `--checkpoint=${normalCheckpoint}`,
], {
  cwd: root,
  encoding: 'utf8',
  timeout: TEST_RUNNER_TIMEOUT_MS,
});
assert.equal(normalControl.status, 0,
  `正常 v3 正式路径控制必须完成：${String(normalControl.stderr || normalControl.stdout).slice(-1200)}`);
let fxeReport;
let normalControlReport;
let fxeCheckpointReport;
let normalCheckpointReport;
try {
  fxeReport = JSON.parse(fxeControl.stdout);
  normalControlReport = JSON.parse(normalControl.stdout);
  fxeCheckpointReport = JSON.parse(fs.readFileSync(fxeCheckpoint, 'utf8'));
  normalCheckpointReport = JSON.parse(fs.readFileSync(normalCheckpoint, 'utf8'));
} catch (error) {
  throw new Error(`强制专家正式路径控制未输出有效 JSON：${error.message}`);
}
assert.equal(fxeReport.result?.candidateUpgradeUtilityTotal, 0,
  'fxe 相对 expert 的镜像配对效用必须严格为零');
assert.equal(fxeReport.result?.candidateHeads, fxeReport.result?.comparisonHeads,
  'fxe 相对 expert 的头游计数必须严格相等');
assert.equal(fxeReport.result?.candidateDoubleUps, fxeReport.result?.comparisonDoubleUps,
  'fxe 相对 expert 的双上计数必须严格相等');
assert.equal(fxeCheckpointReport.complete, true, 'fxe 控制检查点必须完整结束');
for (const pair of fxeCheckpointReport.pairs || []) {
  assert.equal(pair.utility, 0, '每个 fxe 镜像配对的效用必须严格为零');
  assert.equal(pair.candidateHeads, 1, '每个 fxe 镜像配对必须恰好一次候选头游');
  assert.equal(pair.candidateDoubleUps, pair.comparisonDoubleUps,
    '每个 fxe 镜像配对的双上必须严格相等');
}
const normalGames = new Map((normalCheckpointReport.games || [])
  .map((game) => [`${game.seed}/${game.level}/${game.candidateTeam}`, game]));
const fxeGames = fxeCheckpointReport.games || [];
assert.equal(normalGames.size, fxeGames.length,
  '正常与 fxe 控制必须产出完全相同的游戏对象集合');
for (const fxeGame of fxeGames) {
  const key = `${fxeGame.seed}/${fxeGame.level}/${fxeGame.candidateTeam}`;
  const normalGame = normalGames.get(key);
  assert(normalGame, `正常臂缺少 fxe 遥测对象 ${key}`);
  assert.equal(Number(normalGame?.hybrid?.changed) || 0,
    Number(fxeGame?.hybrid?.wouldChange) || 0,
    `normal changed 与 forced wouldChange 必须逐对象一致：${key}`);
}

try {
  const checkpoint = path.join(temporary, 'smoke.checkpoint.json');
  const checkpointRun = spawnSync(process.execPath, [
    runner, '1', '990002', 'root-pimc-v1', 'expert', '--levels=2', '--summary-only', '--json',
    `--checkpoint=${checkpoint}`,
  ], { cwd: root, encoding: 'utf8', timeout: TEST_RUNNER_TIMEOUT_MS });
  assert.equal(checkpointRun.status, 0, '带 v2 检查点的 A/B 烟囱必须完成');
  const saved = JSON.parse(fs.readFileSync(checkpoint, 'utf8'));
  const original = structuredClone(saved);
  assert.equal(saved.schema, 'guandan-ai-ab-checkpoint-v3', '检查点必须声明 v3 provenance/源码/预算绑定 schema');
  assert.equal(typeof saved.signaturePayload?.evaluationImplementationSha256, 'string',
    '检查点签名必须包含评测源码指纹');
  assert.equal(saved.signaturePayload?.candidateSearchConfig?.nodeBudget, 3600,
    '检查点签名必须包含已解析的搜索预算');
  assert.equal(saved.signaturePayload?.evaluationOpponentModelMode, 'off',
    '检查点签名必须绑定镜像赛禁用的自适应对手画像状态');
  assert.equal(saved.provenance?.schema, 'guandan-evaluation-provenance-v1',
    'checkpoint 必须持久化运行 provenance 链');
  assert.equal(saved.provenance?.runSegments?.length, 1,
    '单进程 checkpoint 必须保存一个运行段');
  assert.equal(saved.games.every((game) => game.runSegmentId === saved.provenance.runSegments[0].runSegmentId),
    true, '每局 checkpoint 对象必须可精确归属到覆盖它的运行段');

  saved.signaturePayload.evaluationImplementationSha256 = '0'.repeat(64);
  saved.signature = JSON.stringify(saved.signaturePayload);
  writeCheckpointCopies(checkpoint, saved);
  const staleResume = spawnSync(process.execPath, [
    runner, '1', '990002', 'root-pimc-v1', 'expert', '--levels=2', '--summary-only', '--json',
    `--checkpoint=${checkpoint}`, '--resume',
  ], { cwd: root, encoding: 'utf8', timeout: TEST_RUNNER_TIMEOUT_MS });
  assert.notEqual(staleResume.status, 0, '源码指纹或预算签名变化时必须拒绝继续旧检查点');
  assert.match(`${staleResume.stderr}${staleResume.stdout}`, /源码指纹|搜索预算|不一致/,
    '拒绝信息必须说明检查点绑定范围');

  const staleBudget = structuredClone(original);
  staleBudget.signaturePayload.candidateSearchConfig.nodeBudget = 1;
  staleBudget.signature = JSON.stringify(staleBudget.signaturePayload);
  writeCheckpointCopies(checkpoint, staleBudget);
  const budgetResume = spawnSync(process.execPath, [
    runner, '1', '990002', 'root-pimc-v1', 'expert', '--levels=2', '--summary-only', '--json',
    `--checkpoint=${checkpoint}`, '--resume',
  ], { cwd: root, encoding: 'utf8', timeout: TEST_RUNNER_TIMEOUT_MS });
  assert.notEqual(budgetResume.status, 0, '搜索预算签名变化时必须拒绝继续旧检查点');

  // 使用完整源码副本，避免测试期间触及用户工作树。先验证同字节闭包可以恢复，
  // 再逐一改变原先遗漏的 Worker、评价、存储和 LLM 路径；每一项都必须让旧
  // checkpoint 在真正重新计算 implementation SHA 后被拒绝。
  writeCheckpointCopies(checkpoint, original);
  const closureFixtureRoot = path.join(temporary, 'evaluation-closure-fixture');
  const fixtureJs = path.join(closureFixtureRoot, 'js');
  for (const sourceFile of receiptSources) {
    const source = path.join(root, sourceFile);
    const destination = path.join(closureFixtureRoot, sourceFile);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
  const fixtureRunner = path.join(fixtureJs, 'ai.ab.simulation.js');
  const resumeArgs = [
    fixtureRunner, '1', '990002', 'root-pimc-v1', 'expert', '--levels=2', '--summary-only', '--json',
    `--checkpoint=${checkpoint}`, '--resume',
  ];
  const compatibleResume = spawnSync(process.execPath, resumeArgs, {
    cwd: closureFixtureRoot,
    encoding: 'utf8',
    timeout: TEST_RUNNER_TIMEOUT_MS,
  });
  assert.equal(compatibleResume.status, 0,
    `同字节的完整依赖闭包必须可以恢复：${String(compatibleResume.stderr || compatibleResume.stdout).slice(-1200)}`);
  for (const relativeFile of [
    'ai.worker-client.js', 'ai.worker.js', 'evaluator.js', 'llm.js', 'replay-contracts.js', 'sealed-training.js', 'stats.js',
  ]) {
    const dependency = path.join(fixtureJs, relativeFile);
    const originalSource = fs.readFileSync(dependency, 'utf8');
    try {
      fs.appendFileSync(dependency, '\n// EVID-3 dependency-fingerprint regression fixture\n', 'utf8');
      const staleDependencyResume = spawnSync(process.execPath, resumeArgs, {
        cwd: closureFixtureRoot,
        encoding: 'utf8',
        timeout: TEST_RUNNER_TIMEOUT_MS,
      });
      assert.notEqual(staleDependencyResume.status, 0,
        `改变间接评测依赖 ${relativeFile} 后必须拒绝旧 checkpoint`);
      assert.match(`${staleDependencyResume.stderr}${staleDependencyResume.stdout}`, /源码指纹|不一致/,
        `改变 ${relativeFile} 的拒绝信息必须说明源码绑定`);
    } finally {
      fs.writeFileSync(dependency, originalSource, 'utf8');
    }
  }

  console.log('EVID-4：检查点原子写入、完整性和恢复回归');
  const resilientCheckpoint = path.join(temporary, 'resilient.checkpoint.json');
  const resilientArgs = [
    runner, '2', '990006', 'root-pimc-v1', 'expert', '--levels=2', '--summary-only', '--json',
    `--checkpoint=${resilientCheckpoint}`,
  ];
  const resilientRun = spawnSync(process.execPath, resilientArgs, {
    cwd: root,
    encoding: 'utf8',
    timeout: TEST_RUNNER_TIMEOUT_MS,
  });
  assert.equal(resilientRun.status, 0,
    `可恢复 checkpoint 烟囱必须完成：${String(resilientRun.stderr || resilientRun.stdout).slice(-1200)}`);
  const healthyCheckpoint = JSON.parse(fs.readFileSync(resilientCheckpoint, 'utf8'));
  const healthyBackup = JSON.parse(fs.readFileSync(`${resilientCheckpoint}.last-valid`, 'utf8'));
  assert.equal(healthyCheckpoint.checkpointIntegrity?.schema, 'sha256-v1',
    '新 checkpoint 必须声明内容 SHA-256 完整性回执');
  const recomputedHealthy = refreshCheckpointIntegrity(structuredClone(healthyCheckpoint));
  assert.equal(healthyCheckpoint.checkpointIntegrity.sha256, recomputedHealthy.checkpointIntegrity.sha256,
    '健康 checkpoint 的内容 SHA-256 必须可独立复算');
  assert.equal(healthyBackup.checkpointIntegrity?.schema, 'sha256-v1',
    '多区组安全写入后必须保留带完整性回执的 last-valid 备份');
  assert(healthyBackup.nextBlockIndex < healthyCheckpoint.nextBlockIndex,
    'last-valid 必须是当前主 checkpoint 的前一个有效版本，而非报告后的重复写入副本');
  assert.notEqual(healthyBackup.checkpointIntegrity.sha256, healthyCheckpoint.checkpointIntegrity.sha256,
    'last-valid 与当前主 checkpoint 必须代表不同的写入版本');
  assert.equal(fs.readdirSync(temporary).filter((name) => name.endsWith('.tmp')).length, 0,
    '正常写入完成后不得残留本次临时 checkpoint');

  const healthyGameKeys = checkpointGameKeys(healthyCheckpoint);
  const sameBytesResume = runCheckpointResume(resilientArgs);
  assert.equal(sameBytesResume.status, 0,
    `同字节 checkpoint 必须可恢复：${String(sameBytesResume.stderr || sameBytesResume.stdout).slice(-1200)}`);
  assert.deepEqual(checkpointGameKeys(JSON.parse(fs.readFileSync(resilientCheckpoint, 'utf8'))), healthyGameKeys,
    '同字节恢复不得改变精确 game 覆盖集合');

  // 进程在替换前中断时可能留下半写临时文件；它既不能覆盖主文件，也不得被 resume 读取。
  const staleTemporary = path.join(temporary, `${path.basename(resilientCheckpoint)}.primary-crash.tmp`);
  fs.writeFileSync(staleTemporary, '{"halfWritten":', 'utf8');
  const staleTemporaryResume = runCheckpointResume(resilientArgs);
  assert.equal(staleTemporaryResume.status, 0,
    '残留半写临时文件不得阻断对健康主 checkpoint 的恢复');
  assert.equal(fs.existsSync(staleTemporary), true,
    '恢复不得把未归属的崩溃残留误当作可删除的主 checkpoint');

  // 主文件截断后只能从同配置且内容自洽的最后有效版本恢复；双坏时必须 fail-closed。
  fs.writeFileSync(resilientCheckpoint, '{"truncated":', 'utf8');
  const recoveredFromBackup = runCheckpointResume(resilientArgs);
  assert.equal(recoveredFromBackup.status, 0,
    `主文件损坏时应从 last-valid 恢复：${String(recoveredFromBackup.stderr || recoveredFromBackup.stdout).slice(-1200)}`);
  assert.match(`${recoveredFromBackup.stderr}${recoveredFromBackup.stdout}`, /已从 .*last-valid.*恢复/,
    '备用恢复必须留下明确的 stderr 证据');
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(resilientCheckpoint, 'utf8')),
    '备用恢复后的下一次安全写入必须重新建立可解析主 checkpoint');
  fs.writeFileSync(resilientCheckpoint, '{"truncated":', 'utf8');
  fs.writeFileSync(`${resilientCheckpoint}.last-valid`, '{"truncated":', 'utf8');
  const bothBrokenResume = runCheckpointResume(resilientArgs);
  assert.notEqual(bothBrokenResume.status, 0, '主备均坏时不得继续评测');
  assert.match(`${bothBrokenResume.stderr}${bothBrokenResume.stdout}`, /找不到可恢复|不可恢复|不是可解析 JSON/,
    '主备均坏的拒绝必须说明恢复证据缺失');

  const assertMutationRejected = (label, mutate, refreshIntegrity = false) => {
    const mutated = structuredClone(healthyCheckpoint);
    mutate(mutated);
    if (refreshIntegrity) refreshCheckpointIntegrity(mutated);
    writeCheckpointCopies(resilientCheckpoint, mutated);
    const rejected = runCheckpointResume(resilientArgs);
    assert.notEqual(rejected.status, 0, `${label} 必须拒绝继续 checkpoint`);
    assert.match(`${rejected.stderr}${rejected.stdout}`, /检查点|完整性|不一致|无效|找不到可恢复/,
      `${label} 的拒绝必须留下可审计原因`);
  };
  assertMutationRejected('缺失运行段 provenance', (checkpoint) => {
    checkpoint.provenance.runSegments = [];
    refreshProvenance(checkpoint);
  }, true);
  assertMutationRejected('跨机器的 checkpoint 环境', (checkpoint) => {
    const environment = checkpoint.provenance.runSegments[0].environment;
    environment.machine.hostnameSha256 = '0'.repeat(64);
    environment.environmentSha256 = sha256Canonical({
      schema: environment.schema,
      machine: environment.machine,
      runtime: environment.runtime,
    });
    refreshProvenance(checkpoint);
  }, true);
  assertMutationRejected('game 缺少运行段归属', (checkpoint) => {
    checkpoint.games[0].runSegmentId = null;
  }, true);
  assertMutationRejected('未重算摘要的可解析篡改', (checkpoint) => {
    checkpoint.pairs[0].utility += 1;
  });
  assertMutationRejected('complete/nextBlockIndex 矛盾', (checkpoint) => {
    checkpoint.nextBlockIndex = 0;
  }, true);
  assertMutationRejected('重复 game', (checkpoint) => {
    checkpoint.games.push(structuredClone(checkpoint.games[0]));
  }, true);
  assertMutationRejected('错误 candidateTeam', (checkpoint) => {
    checkpoint.games[0].candidateTeam = 1;
  }, true);
  assertMutationRejected('pair 与 game 的 utility 不一致', (checkpoint) => {
    checkpoint.pairs[0].utility += 1;
  }, true);
  assertMutationRejected('孤立 failure', (checkpoint) => {
    checkpoint.failures.push({
      group: 1,
      block: 1,
      seed: 990006,
      level: 2,
      leg: 'candidate-even',
      ok: false,
      deadlock: false,
      reason: 'fixture',
    });
  }, true);

  // 数组顺序本身不是语义：恢复时按 seed/level/team 索引并规范化，避免旧的
  // “pair 下标切 games”实现把两条镜像腿静默接错。
  const reordered = refreshCheckpointIntegrity(structuredClone(healthyCheckpoint));
  reordered.games.reverse();
  reordered.pairs.reverse();
  refreshCheckpointIntegrity(reordered);
  writeCheckpointCopies(resilientCheckpoint, reordered);
  const reorderedResume = runCheckpointResume(resilientArgs);
  assert.equal(reorderedResume.status, 0,
    `重排但内容一致的 checkpoint 必须按键安全恢复：${String(reorderedResume.stderr || reorderedResume.stdout).slice(-1200)}`);
  assert.deepEqual(checkpointGameKeys(JSON.parse(fs.readFileSync(resilientCheckpoint, 'utf8'))), healthyGameKeys,
    '按键恢复后 game 覆盖必须与健康 checkpoint 相同');

  if (process.platform === 'win32') {
    // Windows 的 FileShare.None 是真实的 rename/read 写锁：在第一块 checkpoint
    // 已提交后锁住主文件，第二块保存必须失败，且不能删除或改写第一个有效版本。
    const lockedCheckpoint = path.join(temporary, 'locked.checkpoint.json');
    const lockScript = path.join(temporary, 'hold-checkpoint-lock.ps1');
    fs.writeFileSync(lockScript, [
      'param([string]$CheckpointPath)',
      '$deadline = [DateTime]::UtcNow.AddSeconds(30)',
      '$stream = $null',
      'while ([DateTime]::UtcNow -lt $deadline) {',
      '  try {',
      '    if (-not (Test-Path -LiteralPath $CheckpointPath)) { Start-Sleep -Milliseconds 10; continue }',
      '    $stream = [System.IO.File]::Open($CheckpointPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)',
      '    $sha = [System.Security.Cryptography.SHA256]::Create()',
      '    try { $hash = ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "").ToLowerInvariant() } finally { $sha.Dispose() }',
      '    [Console]::Out.WriteLine("LOCKED:$hash")',
      '    Start-Sleep -Seconds 20',
      '    $stream.Dispose()',
      '    exit 0',
      '  } catch {',
      '    if ($stream) { $stream.Dispose(); $stream = $null }',
      '    Start-Sleep -Milliseconds 10',
      '  }',
      '}',
      'exit 2',
    ].join('\n'), 'utf8');
    const lockedArgs = [
      runner, '2', '990007', 'root-pimc-v1', 'expert', '--levels=2', '--summary-only', '--json',
      `--checkpoint=${lockedCheckpoint}`,
    ];
    // First create a verified but incomplete checkpoint, then stop the writer
    // before its second block.  Starting a locker and writer concurrently was
    // racy: on a fast machine the evaluator could finish both blocks before
    // PowerShell acquired FileShare.None, turning this into a false green.
    const initialWriter = spawn(process.execPath, lockedArgs, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const partial = await waitForCheckpointProgress(
        lockedCheckpoint, 1, TEST_RUNNER_TIMEOUT_MS, 'Windows checkpoint 初始写入',
      );
      assert.equal(partial.nextBlockIndex, 1,
        '写锁回归必须从恰好一个已提交区组的未完成 checkpoint 继续');
    } finally {
      if (initialWriter.exitCode === null) initialWriter.kill();
      await waitForExit(initialWriter, 10000, '初始 checkpoint 评测进程清理');
    }
    const locker = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', lockScript, lockedCheckpoint,
    ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let writerOutput = '';
    let lockedMatch;
    let writer = null;
    try {
      lockedMatch = await waitForOutput(locker, /LOCKED:([a-f0-9]{64})/, 30000, 'Windows checkpoint 写锁');
      writer = spawn(process.execPath, [...lockedArgs, '--resume'], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      writer.stdout.on('data', (chunk) => { writerOutput += String(chunk); });
      writer.stderr.on('data', (chunk) => { writerOutput += String(chunk); });
      const writerExit = await waitForExit(writer, 60000, '被锁 checkpoint 的评测进程');
      assert.notEqual(writerExit.code, 0,
        `主 checkpoint 被锁时保存必须失败：${writerOutput.slice(-1200)}`);
    } finally {
      if (writer?.exitCode === null) writer.kill();
      if (locker.exitCode === null) locker.kill();
      await Promise.allSettled([
        writer ? waitForExit(writer, 10000, '被锁 checkpoint 的评测进程清理') : Promise.resolve(),
        waitForExit(locker, 10000, 'Windows checkpoint 写锁清理'),
      ]);
    }
    assert.equal(fileSha256(lockedCheckpoint), lockedMatch[1],
      '写锁失败后第一个有效主 checkpoint 的字节必须完全不变');
    const lockedResume = runCheckpointResume(lockedArgs);
    assert.equal(lockedResume.status, 0,
      `释放写锁后旧 checkpoint 必须可恢复：${String(lockedResume.stderr || lockedResume.stdout).slice(-1200)}`);
    const resumedCheckpoint = JSON.parse(fs.readFileSync(lockedCheckpoint, 'utf8'));
    assert.equal(resumedCheckpoint.provenance?.runSegments?.length, 2,
      '真正 resume 后 checkpoint 必须追加独立运行段');
    assert.equal(resumedCheckpoint.provenance?.runSegments?.[0]?.resume, false,
      '第一运行段必须仍是 fresh');
    assert.equal(resumedCheckpoint.provenance?.runSegments?.[1]?.resume, true,
      '恢复进程必须显式标记 resume');
    assert.equal(resumedCheckpoint.provenance?.runSegments?.[1]?.previousRunSegmentId,
      resumedCheckpoint.provenance?.runSegments?.[0]?.runSegmentId,
    '恢复段必须链接到上一段');
    assert.match(resumedCheckpoint.provenance?.runSegments?.[1]?.inputCheckpointSha256 || '', /^[a-f0-9]{64}$/,
      '恢复段必须记录输入 checkpoint 摘要');
    const resumedGameSegments = new Set(resumedCheckpoint.games.map((game) => game.runSegmentId));
    assert.deepEqual(resumedGameSegments,
      new Set(resumedCheckpoint.provenance.runSegments.map((segment) => segment.runSegmentId)),
    '恢复后每局必须能归属到覆盖它的 fresh 或 resume 段');
  }
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

console.log('A/B simulation smoke: 1 mirror pair, telemetry schema OK');
