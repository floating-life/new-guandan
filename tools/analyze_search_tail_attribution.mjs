#!/usr/bin/env node
/**
 * Attribute the historical searchTriggered tail. This is not a formal
 * performance receipt and never sets formalGateEligible=true.
 *
 * Question: did blocks 61–80 get slower because the trees got bigger, or
 * because the same work cost more wall time?
 *
 * Usage:
 *   node tools/analyze_search_tail_attribution.mjs --report report.json
 *     --checkpoint checkpoint.json [--out attribution.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const ATTRIBUTION_SCHEMA = 'guandan-ai-search-tail-attribution-v1';
const CHECKPOINT_SCHEMA = 'guandan-ai-ab-checkpoint-v2';
const EARLY_END = 60;
const LATE_START = 61;
const NODE_BUCKETS = Object.freeze([
  [0, 800],
  [800, 1200],
  [1200, 1600],
  [1600, 2000],
  [2000, Number.POSITIVE_INFINITY],
]);
const STABLE_NODES_RATIO_SLACK = 0.05;
const HEAVIER_TREES_RATIO = 1.25;
const OVERHEAD_MS_PER_NODE_RATIO = 1.5;
const OVERHEAD_BUCKET_RATIO = 1.5;
const MIN_BUCKET_N = 20;
const STRONG_SPEARMAN = 0.7;

try {
  const options = parseArgs(process.argv.slice(2));
  const report = readJson(options.report, '报告');
  const checkpoint = readJson(options.checkpoint, 'checkpoint');
  const attribution = analyze(report, checkpoint);
  const serialized = `${JSON.stringify(attribution, null, 2)}\n`;
  if (options.out) {
    fs.mkdirSync(path.dirname(options.out), { recursive: true });
    fs.writeFileSync(options.out, serialized, 'utf8');
  }
  process.stdout.write(serialized);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`${JSON.stringify({
    schema: ATTRIBUTION_SCHEMA,
    evidenceClass: 'historical_diagnostic',
    computationStatus: 'blocked',
    formalGateEligible: false,
    reasons: [message],
  }, null, 2)}\n`);
  process.exitCode = 1;
}

function parseArgs(args) {
  const result = { report: null, checkpoint: null, out: null };
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === '--report' || key === '--checkpoint' || key === '--out') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${key} 缺少路径`);
      result[key.slice(2)] = path.resolve(value);
      index += 1;
    } else if (key.startsWith('--report=') || key.startsWith('--checkpoint=') || key.startsWith('--out=')) {
      const split = key.indexOf('=');
      result[key.slice(2, split)] = path.resolve(key.slice(split + 1));
    } else {
      throw new Error(`未知参数：${key}`);
    }
  }
  if (!result.report || !result.checkpoint) {
    throw new Error('用法：node tools/analyze_search_tail_attribution.mjs --report 报告.json --checkpoint checkpoint.json [--out 归因.json]');
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

function analyze(reportInput, checkpointInput) {
  const report = reportInput.value;
  const checkpoint = checkpointInput.value;
  if (!isRecord(report) || !isRecord(report.config)
    || !isRecord(report.completion) || !isRecord(report.performance)) {
    throw new Error('历史报告缺少 config、completion 或 performance');
  }
  if (!isRecord(checkpoint) || checkpoint.schema !== CHECKPOINT_SCHEMA) {
    throw new Error(`只接受 ${CHECKPOINT_SCHEMA}；不得把 v3 正式门工件当作本历史归因输入`);
  }
  const config = report.config;
  const candidate = String(config.candidate || '');
  const levels = Array.isArray(config.evaluationLevels)
    ? config.evaluationLevels.map(Number) : [];
  const blocks = Number(config.baseDealBlocks);
  const baseSeed = Number(config.baseSeed);
  if (!candidate || !levels.length || !Number.isSafeInteger(blocks) || blocks < 1
    || !Number.isSafeInteger(baseSeed) || baseSeed < 0) {
    throw new Error('报告配置的 candidate、levels、baseDealBlocks 或 baseSeed 无效');
  }
  const signature = checkpoint.signaturePayload;
  if (!isRecord(signature) || checkpoint.signature !== JSON.stringify(signature)
    || signature.groupCount !== blocks || signature.baseSeed !== baseSeed
    || signature.candidate !== candidate || signature.comparison !== config.comparison
    || JSON.stringify(signature.evaluationLevels) !== JSON.stringify(levels)
    || checkpoint.complete !== true
    || (checkpoint.nextBlockIndex != null && checkpoint.nextBlockIndex !== blocks)) {
    throw new Error('checkpoint signature/完成状态未与报告配置绑定');
  }
  if (!Array.isArray(checkpoint.failures) || checkpoint.failures.length !== 0) {
    throw new Error('checkpoint 含失败记录，不能形成完整历史归因');
  }
  if (!Array.isArray(checkpoint.games) || checkpoint.games.length !== blocks * levels.length * 2) {
    throw new Error('checkpoint 未精确覆盖区组×级别×双腿');
  }

  const rows = [];
  for (const [index, game] of checkpoint.games.entries()) {
    if (!isRecord(game) || !Number.isSafeInteger(game.seed)
      || !Array.isArray(game.decisionTelemetry)) {
      throw new Error(`checkpoint.games[${index}] 字段无效`);
    }
    const block = game.seed - baseSeed + 1;
    if (block < 1 || block > blocks) throw new Error(`checkpoint.games[${index}] seed 不在 baseSeed 区间`);
    for (const [turn, decision] of game.decisionTelemetry.entries()) {
      if (!isRecord(decision)
        || !['candidates', 'samples', 'nodes', 'iterations'].every((field) => (
          typeof decision[field] === 'number' && Number.isFinite(decision[field]) && decision[field] >= 0
        ))
        || !(decision.latencyMs === null
          || (typeof decision.latencyMs === 'number' && Number.isFinite(decision.latencyMs)
            && decision.latencyMs >= 0))) {
        throw new Error(`checkpoint.games[${index}].decisionTelemetry[${turn}] 字段无效`);
      }
      const positive = ['candidates', 'samples', 'nodes', 'iterations']
        .map((field) => decision[field] > 0);
      if (positive.some(Boolean) && !positive.every(Boolean)) {
        throw new Error(`checkpoint.games[${index}].decisionTelemetry[${turn}] legacy proxy 四字段不一致`);
      }
      const triggered = decision.policy === candidate && positive.every(Boolean);
      if (!triggered) continue;
      if (!Number.isFinite(decision.latencyMs)) {
        throw new Error(`checkpoint.games[${index}].decisionTelemetry[${turn}] 触发行缺少 latencyMs`);
      }
      rows.push({
        block,
        nodes: decision.nodes,
        iterations: decision.iterations,
        candidates: decision.candidates,
        latencyMs: decision.latencyMs,
      });
    }
  }

  const overall = summarize(rows);
  const reportTrigger = report.performance.decisionLatencyByPolicy?.[candidate]?.searchTriggered;
  if (!isRecord(reportTrigger)
    || reportTrigger.decisionTurns !== overall.decisionTurns
    || round1(reportTrigger.p95DecisionMs) !== overall.p95DecisionMs
    || round1(reportTrigger.p99DecisionMs) !== overall.p99DecisionMs
    || reportTrigger.totalNodes !== overall.totalNodes) {
    throw new Error('报告 searchTriggered 总体与 checkpoint 逐条复算不一致');
  }

  const early = rows.filter((row) => row.block <= EARLY_END);
  const late = rows.filter((row) => row.block >= LATE_START);
  const earlyStats = early.length ? summarize(early) : null;
  const lateStats = late.length ? summarize(late) : null;
  const buckets = NODE_BUCKETS.map(([lo, hi]) => compareBucket(early, late, lo, hi));
  const comparableBuckets = buckets.filter((bucket) => bucket.comparable);
  const p99 = overall.p99DecisionMs;
  const tail = Number.isFinite(p99) ? rows.filter((row) => row.latencyMs >= p99) : [];
  const lateTailShare = tail.length ? tail.filter((row) => row.block >= LATE_START).length / tail.length : null;
  const lateTurnShare = rows.length ? late.length / rows.length : null;

  const nodesRatio = ratioOf(lateStats?.nodesPerTurn, earlyStats?.nodesPerTurn);
  const msPerNodeRatio = ratioOf(lateStats?.msPerNode, earlyStats?.msPerNode);
  const bucketRatios = comparableBuckets.map((bucket) => bucket.avgRatio);
  const minBucketRatio = bucketRatios.length ? Math.min(...bucketRatios) : null;

  const heavierLaterTrees = classifyHeavier(nodesRatio, lateStats, earlyStats);
  const laterBlockOverhead = classifyOverhead({
    lateStats, earlyStats, msPerNodeRatio, minBucketRatio, comparableBuckets, heavierLaterTrees,
  });
  const searchSizeExplainsTail = classifySearchSize({
    overall, nodesRatio, heavierLaterTrees, laterBlockOverhead,
  });

  const hypotheses = {
    heavierLaterTrees,
    laterBlockOverhead,
    searchSizeExplainsTail,
    checkpointIoInsideDecision: untestable(
      'v2 决策行没有 checkpoint 分阶段计时；PERF-2b 的保存耗时发生在局间，不能直接记入 searchTriggered',
    ),
    gcPause: untestable('v2 没有 GC 观察；不得把 PERF-2b 另一批种子的 0 次 GC event 外推到本臂'),
    externalLoad: untestable('v2 没有进程/系统 CPU、电源或 loadavg 记录'),
    freshVsResume: untestable('v2 没有 provenance.runSegments / game.runSegmentId，不能把 61–80 标成 resume'),
  };

  const locked = Object.entries(hypotheses)
    .filter(([, value]) => value.status === 'supported')
    .map(([name]) => name);
  const contradicted = Object.entries(hypotheses)
    .filter(([, value]) => value.status === 'contradicted')
    .map(([name]) => name);
  const untestableNames = Object.entries(hypotheses)
    .filter(([, value]) => value.status === 'untestable')
    .map(([name]) => name);

  return {
    schema: ATTRIBUTION_SCHEMA,
    evidenceClass: 'historical_diagnostic',
    computationStatus: 'ok',
    formalGateEligible: false,
    formalGateBlockers: [
      'historical_diagnostic_not_a_performance_receipt',
      'legacy_checkpoint_v2_no_embedded_provenance',
      'search_triggered_is_legacyHybridAppliedProxy_not_explicit',
      'environment_mechanism_untestable_on_v2',
    ],
    inputs: {
      report: { file: reportInput.file, sha256: reportInput.sha256, bytes: reportInput.bytes.length },
      checkpoint: { file: checkpointInput.file, sha256: checkpointInput.sha256, bytes: checkpointInput.bytes.length },
      checkpointSchema: checkpoint.schema,
    },
    extractionContract: {
      name: 'legacyHybridAppliedProxy',
      trigger: `policy === ${JSON.stringify(candidate)} && candidates > 0 && samples > 0 && nodes > 0 && iterations > 0`,
      earlyBlocks: `1-${EARLY_END}`,
      lateBlocks: `${LATE_START}+`,
      latencyPercentile: 'nearest-rank: sorted[ceil(n*q)-1], rounded to 0.1ms after selection',
    },
    ranges: {
      overall,
      early: earlyStats,
      late: lateStats,
    },
    nodeBuckets: buckets,
    tail: {
      p99DecisionMs: p99,
      tailTurns: tail.length,
      lateTailShare: round3(lateTailShare),
      lateTurnShare: round3(lateTurnShare),
    },
    hypotheses,
    rootCause: {
      locked,
      contradicted,
      untestable: untestableNames,
      perf3SearchHotspotOptimizationEligible: false,
      perf3CheckpointStreamingEligible: false,
      reason: laterBlockOverhead.status === 'supported'
        ? '61–80 与 1–60 的 nodes/turn 稳定，但同规模树的墙钟约翻倍；尾延迟不是搜索树变大。机制（resume/GC/外部负载）在 v2 上不可区分，因此不得据此改搜索排序、预算或静默减覆盖，也不得把 checkpoint 流式化写成已证实的 PERF-3。'
        : '未锁定 later-block overhead；保持 PERF-3 停止线，不得改搜索排序、预算或覆盖。',
    },
  };
}

function classifyHeavier(nodesRatio, lateStats, earlyStats) {
  if (!lateStats || !earlyStats || !Number.isFinite(nodesRatio)) {
    return untestable('没有同时存在 1–60 与 61+ 的触发行');
  }
  if (Math.abs(nodesRatio - 1) <= STABLE_NODES_RATIO_SLACK) {
    return {
      status: 'contradicted',
      nodesPerTurnRatio: round3(nodesRatio),
      evidence: `late/early nodesPerTurn=${round3(nodesRatio)}，在 ±${STABLE_NODES_RATIO_SLACK} 内，树规模不是 61–80 变慢的原因`,
    };
  }
  if (nodesRatio >= HEAVIER_TREES_RATIO) {
    return {
      status: 'supported',
      nodesPerTurnRatio: round3(nodesRatio),
      evidence: `late/early nodesPerTurn=${round3(nodesRatio)} ≥ ${HEAVIER_TREES_RATIO}`,
    };
  }
  return {
    status: 'inconclusive',
    nodesPerTurnRatio: round3(nodesRatio),
    evidence: `late/early nodesPerTurn=${round3(nodesRatio)} 既不稳定也不到加重阈值`,
  };
}

function classifyOverhead({
  lateStats, earlyStats, msPerNodeRatio, minBucketRatio, comparableBuckets, heavierLaterTrees,
}) {
  if (!lateStats || !earlyStats || !Number.isFinite(msPerNodeRatio)) {
    return untestable('没有同时存在 1–60 与 61+ 的触发行');
  }
  const bucketsSupport = comparableBuckets.length >= 2
    && Number.isFinite(minBucketRatio)
    && minBucketRatio >= OVERHEAD_BUCKET_RATIO;
  const supported = heavierLaterTrees.status === 'contradicted'
    && msPerNodeRatio >= OVERHEAD_MS_PER_NODE_RATIO
    && bucketsSupport;
  if (supported) {
    return {
      status: 'supported',
      msPerNodeRatio: round3(msPerNodeRatio),
      minComparableBucketAvgRatio: round3(minBucketRatio),
      comparableBuckets: comparableBuckets.length,
      evidence: `ms/node 比 ${round3(msPerNodeRatio)}，${comparableBuckets.length} 个可比节点桶的最小平均比 ${round3(minBucketRatio)}，且树规模稳定`,
    };
  }
  if (heavierLaterTrees.status === 'supported' && msPerNodeRatio < OVERHEAD_MS_PER_NODE_RATIO) {
    return {
      status: 'contradicted',
      msPerNodeRatio: round3(msPerNodeRatio),
      minComparableBucketAvgRatio: round3(minBucketRatio),
      comparableBuckets: comparableBuckets.length,
      evidence: '墙钟增长可由更大的树解释，ms/node 没有跨过 overhead 阈值',
    };
  }
  return {
    status: 'inconclusive',
    msPerNodeRatio: round3(msPerNodeRatio),
    minComparableBucketAvgRatio: round3(minBucketRatio),
    comparableBuckets: comparableBuckets.length,
    evidence: 'later-block overhead 条件未同时满足',
  };
}

function classifySearchSize({ overall, nodesRatio, heavierLaterTrees, laterBlockOverhead }) {
  if (laterBlockOverhead.status === 'supported' && heavierLaterTrees.status === 'contradicted') {
    return {
      status: 'contradicted',
      spearmanLatencyVsNodes: overall.spearmanLatencyVsNodes,
      nodesPerTurnRatio: round3(nodesRatio),
      evidence: '同规模树在 61–80 变慢；区内 latency↔nodes 相关不能解释跨区组台阶',
    };
  }
  if (heavierLaterTrees.status === 'supported' && overall.spearmanLatencyVsNodes >= STRONG_SPEARMAN) {
    return {
      status: 'supported',
      spearmanLatencyVsNodes: overall.spearmanLatencyVsNodes,
      nodesPerTurnRatio: round3(nodesRatio),
      evidence: '树规模与墙钟同向上升，且 latency↔nodes 相关强',
    };
  }
  return {
    status: 'inconclusive',
    spearmanLatencyVsNodes: overall.spearmanLatencyVsNodes,
    nodesPerTurnRatio: round3(nodesRatio),
    evidence: '搜索规模既未锁定也未被 later-block overhead 单独排除以外的形态',
  };
}

function compareBucket(early, late, lo, hi) {
  const earlyRows = early.filter((row) => row.nodes >= lo && row.nodes < hi);
  const lateRows = late.filter((row) => row.nodes >= lo && row.nodes < hi);
  const comparable = earlyRows.length >= MIN_BUCKET_N && lateRows.length >= MIN_BUCKET_N;
  const earlyAvg = average(earlyRows.map((row) => row.latencyMs));
  const lateAvg = average(lateRows.map((row) => row.latencyMs));
  const earlyP95 = percentile(earlyRows.map((row) => row.latencyMs), 0.95);
  const lateP95 = percentile(lateRows.map((row) => row.latencyMs), 0.95);
  return {
    bucket: hi === Number.POSITIVE_INFINITY ? `[${lo},∞)` : `[${lo},${hi})`,
    earlyN: earlyRows.length,
    lateN: lateRows.length,
    comparable,
    earlyAvgMs: round1(earlyAvg),
    lateAvgMs: round1(lateAvg),
    avgRatio: round3(ratioOf(lateAvg, earlyAvg)),
    earlyP95Ms: round1(earlyP95),
    lateP95Ms: round1(lateP95),
    p95Ratio: round3(ratioOf(lateP95, earlyP95)),
  };
}

function summarize(rows) {
  const latencies = rows.map((row) => row.latencyMs);
  const nodes = rows.reduce((sum, row) => sum + row.nodes, 0);
  const iterations = rows.reduce((sum, row) => sum + row.iterations, 0);
  return {
    decisionTurns: rows.length,
    averageDecisionMs: round1(average(latencies)),
    p95DecisionMs: round1(percentile(latencies, 0.95)),
    p99DecisionMs: round1(percentile(latencies, 0.99)),
    maxDecisionMs: round1(latencies.length ? Math.max(...latencies) : null),
    totalNodes: nodes,
    totalIterations: iterations,
    nodesPerTurn: round1(rows.length ? nodes / rows.length : null),
    msPerNode: round4(nodes ? latencies.reduce((sum, value) => sum + value, 0) / nodes : null),
    spearmanLatencyVsNodes: round3(spearman(rows.map((row) => row.nodes), latencies)),
  };
}

function spearman(xs, ys) {
  if (xs.length < 3 || xs.length !== ys.length) return null;
  const rx = ranks(xs);
  const ry = ranks(ys);
  const n = xs.length;
  const mx = average(rx);
  const my = average(ry);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let index = 0; index < n; index += 1) {
    const a = rx[index] - mx;
    const b = ry[index] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

function ranks(values) {
  const order = values.map((value, index) => ({ value, index }))
    .sort((left, right) => left.value - right.value || left.index - right.index);
  const out = Array(values.length);
  for (let start = 0; start < order.length; ) {
    let end = start + 1;
    while (end < order.length && order[end].value === order[start].value) end += 1;
    const rank = (start + end + 1) / 2;
    for (let index = start; index < end; index += 1) out[order[index].index] = rank;
    start = end;
  }
  return out;
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = values.slice().sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function ratioOf(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  return numerator / denominator;
}

function untestable(evidence) {
  return { status: 'untestable', evidence };
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function round1(value) {
  return Number.isFinite(value) ? Number(value.toFixed(1)) : null;
}

function round3(value) {
  return Number.isFinite(value) ? Number(value.toFixed(3)) : null;
}

function round4(value) {
  return Number.isFinite(value) ? Number(value.toFixed(4)) : null;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
