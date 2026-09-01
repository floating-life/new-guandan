#!/usr/bin/env node
/**
 * Recompute the historical statefix search-latency diagnosis from a legacy
 * v2 checkpoint. This is deliberately not a formal performance receipt:
 * v2 has no embedded run-segment provenance or explicit searchTriggered bit.
 *
 * Usage:
 *   node tools/analyze_statefix_performance.mjs --report report.json
 *     --checkpoint checkpoint.json [--out diagnostic.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const DIAGNOSTIC_SCHEMA = 'guandan-ai-performance-diagnostic-v1';
const CHECKPOINT_SCHEMA = 'guandan-ai-ab-checkpoint-v2';
const FORMAL_PERFORMANCE_SCHEMA = 'guandan-ai-performance-baseline-v3';
const LEVELS = Object.freeze(Array.from({ length: 13 }, (_, index) => index + 2));

try {
  const options = parseArgs(process.argv.slice(2));
  const report = readJson(options.report, '报告');
  const checkpoint = readJson(options.checkpoint, 'checkpoint');
  const segmentManifest = options.segmentManifest
    ? readJson(options.segmentManifest, 'segment manifest') : null;
  const diagnostic = analyze(report, checkpoint, segmentManifest);
  const serialized = `${JSON.stringify(diagnostic, null, 2)}\n`;
  if (options.out) {
    fs.mkdirSync(path.dirname(options.out), { recursive: true });
    fs.writeFileSync(options.out, serialized, 'utf8');
  }
  process.stdout.write(serialized);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`${JSON.stringify({
    schema: DIAGNOSTIC_SCHEMA,
    evidenceClass: 'historical_diagnostic',
    computationStatus: 'blocked',
    formalGateEligible: false,
    reasons: [message],
  }, null, 2)}\n`);
  process.exitCode = 1;
}

function parseArgs(args) {
  const result = { report: null, checkpoint: null, segmentManifest: null, out: null };
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === '--report' || key === '--checkpoint' || key === '--segment-manifest' || key === '--out') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${key} 缺少路径`);
      const target = key === '--segment-manifest' ? 'segmentManifest' : key.slice(2);
      result[target] = path.resolve(value);
      index += 1;
    } else if (key.startsWith('--report=') || key.startsWith('--checkpoint=')
      || key.startsWith('--segment-manifest=') || key.startsWith('--out=')) {
      const split = key.indexOf('=');
      const rawTarget = key.slice(2, split);
      const target = rawTarget === 'segment-manifest' ? 'segmentManifest' : rawTarget;
      result[target] = path.resolve(key.slice(split + 1));
    } else {
      throw new Error(`未知参数：${key}`);
    }
  }
  if (!result.report || !result.checkpoint) {
    throw new Error('用法：node tools/analyze_statefix_performance.mjs --report 报告.json --checkpoint checkpoint.json [--out 诊断.json]');
  }
  return result;
}

function readJson(file, label) {
  if (!fs.existsSync(file)) throw new Error(`${label}不存在：${file}`);
  const bytes = fs.readFileSync(file);
  try {
    return {
      value: JSON.parse(bytes.toString('utf8')),
      file,
      bytes,
      sha256: sha256(bytes),
    };
  } catch (error) {
    throw new Error(`${label}不是有效 JSON：${error.message}`);
  }
}

function analyze(reportInput, checkpointInput, segmentManifestInput = null) {
  const report = reportInput.value;
  const checkpoint = checkpointInput.value;
  if (!isRecord(report) || !isRecord(report.config)
    || !isRecord(report.completion) || !isRecord(report.performance)
    || !isRecord(report.hybrid)) {
    throw new Error('历史报告缺少 config、completion、hybrid 或 performance');
  }
  if (!isRecord(checkpoint) || checkpoint.schema !== CHECKPOINT_SCHEMA) {
    throw new Error(`只接受 ${CHECKPOINT_SCHEMA}；v3 checkpoint 应走正式性能回执`);
  }
  const config = report.config;
  const candidate = String(config.candidate || '');
  const levels = normalizeLevels(config.evaluationLevels);
  const blocks = safeInteger(config.baseDealBlocks, 'config.baseDealBlocks');
  const baseSeed = safeInteger(config.baseSeed, 'config.baseSeed');
  if (!candidate || !levels.length || blocks < 1 || baseSeed < 0) {
    throw new Error('报告配置的 candidate、levels、baseDealBlocks 或 baseSeed 无效');
  }
  const signature = checkpoint.signaturePayload;
  if (!isRecord(signature) || checkpoint.signature !== JSON.stringify(signature)
    || signature.groupCount !== blocks || signature.baseSeed !== baseSeed
    || signature.candidate !== candidate || signature.comparison !== config.comparison
    || !sameJson(signature.evaluationLevels, levels)
    || checkpoint.complete !== true
    || (checkpoint.nextBlockIndex != null && checkpoint.nextBlockIndex !== blocks)) {
    throw new Error('checkpoint signature/完成状态未与报告配置绑定');
  }
  if (!Array.isArray(checkpoint.failures) || checkpoint.failures.length !== 0) {
    throw new Error('checkpoint 含失败记录，不能形成完整历史诊断');
  }
  const games = checkpoint.games;
  const pairs = checkpoint.pairs;
  const expectedGames = blocks * levels.length * 2;
  const expectedPairs = blocks * levels.length;
  if (!Array.isArray(games) || games.length !== expectedGames
    || !Array.isArray(pairs) || pairs.length !== expectedPairs) {
    throw new Error(`checkpoint 未精确覆盖 ${blocks}×${levels.length}×双腿游戏/镜像对`);
  }
  const parsed = validateGames(games, pairs, config, candidate, levels, blocks, baseSeed);
  const overall = stats(parsed.rows);
  const reportTrigger = report.performance.decisionLatencyByPolicy?.[candidate]?.searchTriggered;
  validateReportTrigger(reportTrigger, overall);
  if (Number(report.hybrid.applied) !== overall.decisionTurns) {
    throw new Error('报告 hybrid.applied 与 checkpoint 逐条复算不一致');
  }
  if (Number(report.completion.gamesCompleted) !== games.length
    || Number(report.completion.mirrorPairsCompleted) !== pairs.length
    || Number(report.completion.baseDealBlocksCompleted) !== blocks
    || Number(report.completion.failures) !== 0
    || Number(report.completion.deadlocks) !== 0
    || Number(report.completion.mirrorMismatches) !== 0) {
    throw new Error('报告 completion 与 checkpoint 覆盖不一致');
  }
  const runResumeSegments = validateSegmentManifest(
    segmentManifestInput, reportInput, checkpointInput, parsed.rows, blocks,
  );
  const dimensions = {
    overall,
    everyTenBlocks: makeSlices(parsed.rows, blocks, 10),
    historicalRanges: [
      makeRangeSlice(parsed.rows, 1, Math.min(60, blocks), 'blocks-1-60'),
      ...(blocks > 60 ? [makeRangeSlice(parsed.rows, 61, blocks, `blocks-61-${blocks}`)] : []),
    ],
    seat: makeCategoricalSlices(parsed.rows, 'seat', [0, 1, 2, 3]),
    source: makeCategoricalSlices(parsed.rows, 'source', [...parsed.sources].sort()),
    level: makeCategoricalSlices(parsed.rows, 'level', levels),
    candidateTeam: makeCategoricalSlices(parsed.rows, 'candidateTeam', [0, 1]),
  };
  return {
    schema: DIAGNOSTIC_SCHEMA,
    evidenceClass: 'historical_diagnostic',
    computationStatus: 'ok',
    formalGateEligible: false,
    formalGateBlockers: [
      'legacy_checkpoint_v2_no_embedded_provenance',
      'search_triggered_is_legacyHybridAppliedProxy_not_explicit',
      'run_segment_and_environment_provenance_unavailable',
      `not_${FORMAL_PERFORMANCE_SCHEMA}`,
    ],
    inputs: {
      report: { file: reportInput.file, sha256: reportInput.sha256, bytes: reportInput.bytes.length },
      checkpoint: { file: checkpointInput.file, sha256: checkpointInput.sha256, bytes: checkpointInput.bytes.length },
      reportSchema: report.schema || null,
      checkpointSchema: checkpoint.schema,
      segmentManifest: segmentManifestInput
        ? { file: segmentManifestInput.file, sha256: segmentManifestInput.sha256, bytes: segmentManifestInput.bytes.length }
        : null,
    },
    extractionContract: {
      name: 'legacyHybridAppliedProxy',
      trigger: `policy === ${JSON.stringify(candidate)} && candidates > 0 && samples > 0 && nodes > 0 && iterations > 0`,
      allFourPositiveRequired: true,
      explicitSearchTriggeredFieldPresent: false,
      latencyPercentile: 'nearest-rank: sorted[ceil(n*q)-1], rounded to 0.1ms after selection',
    },
    integrityChecks: {
      signatureBound: true,
      completeCheckpoint: true,
      exactCoverage: true,
      uniqueSeedLevelTeam: true,
      pairGameBinding: true,
      zeroFailures: true,
      proxyFieldsConsistent: true,
      reportOverallBound: true,
      runResumeProvenance: false,
    },
    runResumeSegments,
    dimensions,
  };
}

function validateSegmentManifest(input, reportInput, checkpointInput, rows, blocks) {
  if (!input) {
    return {
      status: 'unavailable',
      provenanceVerified: false,
      reason: 'legacy v2 checkpoint 没有 provenance.runSegments 或 game.runSegmentId；不能把 1–60/61–80 反推为 fresh/resume',
      segments: [],
    };
  }
  const value = input.value;
  if (!isRecord(value) || value.schema !== 'guandan-statefix-segment-manifest-v1'
    || value.reportSha256 !== reportInput.sha256
    || value.checkpointSha256 !== checkpointInput.sha256
    || !Array.isArray(value.segments) || value.segments.length === 0) {
    throw new Error('外部 segment manifest 必须绑定当前报告/checkpoint 且包含分段');
  }
  let nextStart = 1;
  const ids = new Set();
  const segments = [];
  for (const [index, segment] of value.segments.entries()) {
    if (!isRecord(segment)
      || !Number.isSafeInteger(segment.startBlock) || !Number.isSafeInteger(segment.endBlock)
      || segment.startBlock !== nextStart || segment.endBlock < segment.startBlock
      || segment.endBlock > blocks || typeof segment.id !== 'string' || !segment.id
      || ids.has(segment.id)
      || !['fresh', 'resume'].includes(segment.label)
      || segment.attribution !== 'externally_declared'
      || segment.provenanceVerified !== false) {
      throw new Error(`外部 segment manifest 第 ${index + 1} 段范围/标签/provenance 无效`);
    }
    ids.add(segment.id);
    const segmentRows = rows.filter((row) => (
      row.block >= segment.startBlock && row.block <= segment.endBlock
    ));
    segments.push({
      id: segment.id,
      label: segment.label,
      attribution: segment.attribution,
      provenanceVerified: false,
      startBlock: segment.startBlock,
      endBlock: segment.endBlock,
      stats: stats(segmentRows),
    });
    nextStart = segment.endBlock + 1;
  }
  if (nextStart !== blocks + 1) throw new Error('外部 segment manifest 未覆盖完整区组且不能形成分段诊断');
  return {
    status: 'externally_declared',
    provenanceVerified: false,
    reason: '分段标签来自外部 sidecar；legacy v2 checkpoint 没有内生运行段证明，标签仅作诊断',
    segments,
  };
}

function validateGames(games, pairs, config, candidate, levels, blocks, baseSeed) {
  const expectedKeys = new Set();
  const byKey = new Map();
  const rows = [];
  const sources = new Set();
  for (const [index, game] of games.entries()) {
    if (!isRecord(game) || !Number.isSafeInteger(game.seed)
      || !Number.isSafeInteger(game.level) || !levels.includes(game.level)
      || ![0, 1].includes(game.candidateTeam)
      || !Array.isArray(game.decisionTelemetry) || !isRecord(game.hybrid)) {
      throw new Error(`checkpoint.games[${index}] 字段无效`);
    }
    const block = game.seed - baseSeed + 1;
    if (block < 1 || block > blocks) throw new Error(`checkpoint.games[${index}] seed 不在 baseSeed 区间`);
    const key = `${game.seed}/${game.level}/${game.candidateTeam}`;
    if (byKey.has(key)) throw new Error(`checkpoint games 坐标重复：${key}`);
    byKey.set(key, game);
    const candidateDecisions = game.decisionTelemetry.filter((decision) => decision?.policy === candidate);
    if (!Number.isSafeInteger(game.hybrid.turns) || game.hybrid.turns !== candidateDecisions.length
      || !['applied', 'samples', 'nodes', 'iterations'].every((field) => (
        Number.isSafeInteger(game.hybrid[field]) && game.hybrid[field] >= 0
      ))) {
      throw new Error(`checkpoint.games[${index}] hybrid 汇总无效`);
    }
    let proxyCount = 0;
    let proxySamples = 0;
    let proxyNodes = 0;
    let proxyIterations = 0;
    for (const [turn, decision] of game.decisionTelemetry.entries()) {
      if (!isRecord(decision) || !Number.isSafeInteger(decision.seat)
        || decision.seat < 0 || decision.seat > 3
        || typeof decision.policy !== 'string' || typeof decision.engine !== 'string'
        || typeof decision.source !== 'string' || !decision.source
        || typeof decision.fallbackEvaluable !== 'boolean'
        || typeof decision.timeoutFallback !== 'boolean'
        || !(decision.latencyMs === null
          || (typeof decision.latencyMs === 'number' && Number.isFinite(decision.latencyMs)
            && decision.latencyMs >= 0))
        || !['candidates', 'samples', 'nodes', 'iterations'].every((field) => (
          typeof decision[field] === 'number' && Number.isFinite(decision[field]) && decision[field] >= 0
        ))) {
        throw new Error(`checkpoint.games[${index}].decisionTelemetry[${turn}] 字段无效`);
      }
      const positive = ['candidates', 'samples', 'nodes', 'iterations']
        .map((field) => decision[field] > 0);
      if (positive.some(Boolean) && !positive.every(Boolean)) {
        throw new Error(`checkpoint.games[${index}].decisionTelemetry[${turn}] legacy proxy 四字段不一致`);
      }
      const triggered = decision.policy === candidate && positive.every(Boolean);
      if (positive.every(Boolean) && decision.policy !== candidate) {
        throw new Error(`checkpoint.games[${index}].decisionTelemetry[${turn}] 非候选策略触发 legacy proxy`);
      }
      if (!triggered) continue;
      proxyCount += 1;
      proxySamples += decision.samples;
      proxyNodes += decision.nodes;
      proxyIterations += decision.iterations;
      rows.push({
        block,
        seed: game.seed,
        level: game.level,
        candidateTeam: game.candidateTeam,
        seat: decision.seat,
        source: decision.source,
        latencyMs: decision.latencyMs,
        fallbackEvaluable: decision.fallbackEvaluable,
        timeoutFallback: decision.timeoutFallback,
        candidates: decision.candidates,
        samples: decision.samples,
        nodes: decision.nodes,
        iterations: decision.iterations,
      });
      sources.add(decision.source);
    }
    if (proxyCount !== game.hybrid.applied || proxySamples !== game.hybrid.samples
      || proxyNodes !== game.hybrid.nodes || proxyIterations !== game.hybrid.iterations) {
      throw new Error(`checkpoint.games[${index}] legacy proxy 与 hybrid 汇总不一致`);
    }
    expectedKeys.add(`${game.seed}/${game.level}`);
  }
  for (let block = 1; block <= blocks; block += 1) {
    for (const level of levels) {
      const seed = (baseSeed + block - 1) >>> 0;
      const pairKey = `${seed}/${level}`;
      const pair = pairs.find((item) => item?.seed === seed && item?.level === level);
      if (!pair || pair.complete !== true || pair.mirrorMatched !== true
        || pair.crossLevelMatched !== true || !Array.isArray(pair.orders)
        || pair.orders.length !== 2) {
        throw new Error(`checkpoint pair 未绑定完整镜像：${pairKey}`);
      }
      const even = byKey.get(`${pairKey}/0`);
      const odd = byKey.get(`${pairKey}/1`);
      if (!even || !odd || !sameJson(pair.orders, [even.order, odd.order])) {
        throw new Error(`checkpoint pair/game 镜像绑定不一致：${pairKey}`);
      }
    }
  }
  if (byKey.size !== expectedKeys.size * 2 || expectedKeys.size !== blocks * levels.length) {
    throw new Error('checkpoint seed×level×team 未精确覆盖');
  }
  return { rows, sources };
}

function makeSlices(rows, blocks, width) {
  const slices = [];
  for (let start = 1; start <= blocks; start += width) {
    const end = Math.min(blocks, start + width - 1);
    slices.push(makeRangeSlice(rows, start, end, `blocks-${start}-${end}`));
  }
  return slices;
}

function makeRangeSlice(rows, start, end, name) {
  return { name, startBlock: start, endBlock: end, stats: stats(rows.filter((row) => row.block >= start && row.block <= end)) };
}

function makeCategoricalSlices(rows, field, values) {
  return values.map((value) => ({ value, stats: stats(rows.filter((row) => row[field] === value)) }));
}

function stats(rows) {
  const measured = rows.filter((row) => Number.isFinite(row.latencyMs));
  const latencies = measured.map((row) => row.latencyMs);
  const decisionTurns = rows.length;
  return {
    decisionTurns,
    measuredDecisionTurns: measured.length,
    unmeasuredDecisionTurns: decisionTurns - measured.length,
    fallbackEvaluableTurns: rows.filter((row) => row.fallbackEvaluable === true).length,
    timeoutFallbacks: rows.filter((row) => row.timeoutFallback === true).length,
    measurementCoverage: decisionTurns ? round3(measured.length / decisionTurns) : null,
    fallbackEvaluableCoverage: decisionTurns
      ? round3(rows.filter((row) => row.fallbackEvaluable === true).length / decisionTurns) : null,
    averageDecisionMs: latencies.length ? round1(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) : null,
    p95DecisionMs: round1(percentile(latencies, 0.95)),
    p99DecisionMs: round1(percentile(latencies, 0.99)),
    maxDecisionMs: latencies.length ? round1(Math.max(...latencies)) : null,
    totalCandidates: rows.reduce((sum, row) => sum + row.candidates, 0),
    totalSamples: rows.reduce((sum, row) => sum + row.samples, 0),
    totalNodes: rows.reduce((sum, row) => sum + row.nodes, 0),
    totalIterations: rows.reduce((sum, row) => sum + row.iterations, 0),
  };
}

function validateReportTrigger(reportTrigger, overall) {
  if (!isRecord(reportTrigger) || !isRecord(reportTrigger.measurementCoverage)) {
    throw new Error('报告 searchTriggered 缺少完整计数或 measurementCoverage');
  }
  const integerFields = new Set([
    'decisionTurns', 'measuredDecisionTurns', 'unmeasuredDecisionTurns',
    'fallbackEvaluableTurns', 'timeoutFallbacks', 'totalCandidates',
    'totalSamples', 'totalNodes', 'totalIterations',
  ]);
  const latencyFields = new Set([
    'averageDecisionMs', 'p95DecisionMs', 'p99DecisionMs', 'maxDecisionMs',
  ]);
  const expected = {
    decisionTurns: overall.decisionTurns,
    measuredDecisionTurns: overall.measuredDecisionTurns,
    unmeasuredDecisionTurns: overall.unmeasuredDecisionTurns,
    averageDecisionMs: overall.averageDecisionMs,
    p95DecisionMs: overall.p95DecisionMs,
    p99DecisionMs: overall.p99DecisionMs,
    maxDecisionMs: overall.maxDecisionMs,
    fallbackEvaluableTurns: overall.fallbackEvaluableTurns,
    timeoutFallbacks: overall.timeoutFallbacks,
    timeoutFallbackRate: overall.fallbackEvaluableTurns
      ? round3(overall.timeoutFallbacks / overall.fallbackEvaluableTurns) : null,
    totalCandidates: overall.totalCandidates,
    totalSamples: overall.totalSamples,
    totalNodes: overall.totalNodes,
    totalIterations: overall.totalIterations,
  };
  for (const [field, expectedValue] of Object.entries(expected)) {
    const actual = reportTrigger[field];
    let equal = actual === null && expectedValue === null;
    if (expectedValue !== null) {
      const validNumber = typeof actual === 'number' && Number.isFinite(actual);
      const validInteger = validNumber && Number.isSafeInteger(actual) && actual >= 0;
      equal = (integerFields.has(field) && validInteger && actual === expectedValue)
        || (latencyFields.has(field) && validNumber && round1(actual) === expectedValue)
        || (field === 'timeoutFallbackRate' && validNumber
          && round3(actual) === expectedValue);
    }
    if (!equal) throw new Error(`报告 searchTriggered.${field} 与 checkpoint 逐条复算不一致`);
  }
  const coverage = reportTrigger.measurementCoverage;
  if (typeof coverage.measuredRate !== 'number' || !Number.isFinite(coverage.measuredRate)
    || typeof coverage.fallbackEvaluableRate !== 'number'
    || !Number.isFinite(coverage.fallbackEvaluableRate)
    || round3(coverage.measuredRate) !== overall.measurementCoverage
    || round3(coverage.fallbackEvaluableRate) !== overall.fallbackEvaluableCoverage) {
    throw new Error('报告 searchTriggered.measurementCoverage 与 checkpoint 逐条复算不一致');
  }
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = values.slice().sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

function normalizeLevels(value) {
  if (!Array.isArray(value) || !value.length) return [];
  const levels = value.map(Number);
  if (!levels.every((level) => Number.isSafeInteger(level) && LEVELS.includes(level))
    || new Set(levels).size !== levels.length
    || levels.some((level, index) => index > 0 && level <= levels[index - 1])) return [];
  return levels;
}

function safeInteger(value, label) {
  if (!Number.isSafeInteger(Number(value))) throw new Error(`${label} 必须是安全整数`);
  return Number(value);
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function round1(value) {
  return Number.isFinite(value) ? Number(value.toFixed(1)) : null;
}

function round3(value) {
  return Number.isFinite(value) ? Number(value.toFixed(3)) : null;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
