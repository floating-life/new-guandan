/**
 * A/B 评测决策遥测的记账与汇总。生产者必须对 trickLog 中的每一手生成记录：
 * 缺策略或本地耗时计入未测量，缺搜索/回退字段计入完整性失败，不得丢弃后得到
 * 虚假的 100% 覆盖率。
 */

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

function rounded(value, digits = 3) {
  return value == null ? null : Number(value.toFixed(digits));
}

export function collectDecisionTelemetry(state, variantBySeat) {
  return (state?.trickLog || []).map((item) => {
    const variant = variantBySeat?.[item.seat];
    const variantPresent = !!variant;
    const meta = item?.decisionMeta || null;
    const local = meta?.localDecision;
    const localDecisionPresent = !!local && typeof local === 'object';
    const hybrid = meta?.hybrid || null;
    const searchTelemetryPresent = typeof meta?.searchAttempted === 'boolean'
      && typeof meta?.searchTriggered === 'boolean';
    const fallbackKind = typeof meta?.fallbackKind === 'string' && meta.fallbackKind
      ? meta.fallbackKind : null;
    const measurable = variantPresent && localDecisionPresent;
    const latencyMs = measurable && Number.isFinite(Number(local?.latencyMs))
      ? Number(local.latencyMs) : null;
    const telemetryComplete = measurable
      && searchTelemetryPresent
      && fallbackKind != null
      && Number.isFinite(latencyMs);
    return {
      seat: item.seat,
      policy: variantPresent ? variant.name : '__unattributed__',
      engine: variantPresent ? variant.decisionEngine : null,
      variantPresent,
      localDecisionPresent,
      searchTelemetryPresent,
      fallbackKindPresent: fallbackKind != null,
      telemetryComplete,
      latencyMs,
      source: measurable ? (local?.source || null) : null,
      fallbackKind,
      fallbackEvaluable: measurable && fallbackKind != null,
      timeoutFallback: fallbackKind === 'local_timeout',
      searchAttempted: searchTelemetryPresent ? meta.searchAttempted : null,
      searchTriggered: searchTelemetryPresent ? meta.searchTriggered : null,
      candidates: Array.isArray(hybrid?.candidates) ? hybrid.candidates.length : 0,
      samples: Number(hybrid?.samples) || 0,
      nodes: Number(hybrid?.nodes) || 0,
      iterations: Number(hybrid?.iterations) || 0,
      rolloutBudget: Number(hybrid?.rolloutBudget) || 0,
      sweepBudget: Number(hybrid?.sweepBudget) || 0,
      pairedSweeps: Number(hybrid?.pairedSweeps) || 0,
    };
  });
}

function summarizeDecisionTelemetrySlice(items) {
  const measuredLatencies = items
    .map((item) => item.latencyMs)
    .filter(Number.isFinite);
  const measuredCount = measuredLatencies.length;
  const total = items.length;
  const fallbackEvaluable = items.filter((item) => item.fallbackEvaluable);
  const summed = (key) => items.reduce((sum, item) => sum + (Number(item[key]) || 0), 0);
  return {
    decisionTurns: total,
    measuredDecisionTurns: measuredCount,
    unmeasuredDecisionTurns: total - measuredCount,
    averageDecisionMs: rounded(average(measuredLatencies), 1),
    p95DecisionMs: rounded(percentile(measuredLatencies, 0.95), 1),
    p99DecisionMs: rounded(percentile(measuredLatencies, 0.99), 1),
    maxDecisionMs: rounded(measuredLatencies.length ? Math.max(...measuredLatencies) : null, 1),
    fallbackEvaluableTurns: fallbackEvaluable.length,
    timeoutFallbacks: fallbackEvaluable.filter((item) => item.timeoutFallback).length,
    timeoutFallbackRate: rounded(fallbackEvaluable.length
      ? fallbackEvaluable.filter((item) => item.timeoutFallback).length / fallbackEvaluable.length : null),
    totalCandidates: summed('candidates'),
    totalSamples: summed('samples'),
    totalNodes: summed('nodes'),
    totalIterations: summed('iterations'),
  };
}

export function summarizeDecisionTelemetry(items) {
  const summary = summarizeDecisionTelemetrySlice(items);
  const searchTriggered = items.filter((item) => item.searchTriggered === true);
  const triggeredSummary = summarizeDecisionTelemetrySlice(searchTriggered);
  return {
    ...summary,
    measurementCoverage: {
      measuredRate: rounded(summary.decisionTurns
        ? summary.measuredDecisionTurns / summary.decisionTurns : null, 4),
      fallbackEvaluableRate: rounded(summary.decisionTurns
        ? summary.fallbackEvaluableTurns / summary.decisionTurns : null, 4),
    },
    // Aggregate fields above remain for diagnostics.  The performance gate
    // must consume this distribution only: fast no-search turns are not
    // evidence that triggered search meets its latency budget.
    searchTriggered: {
      ...triggeredSummary,
      measurementCoverage: {
        measuredRate: rounded(triggeredSummary.decisionTurns
          ? triggeredSummary.measuredDecisionTurns / triggeredSummary.decisionTurns : null, 4),
        fallbackEvaluableRate: rounded(triggeredSummary.decisionTurns
          ? triggeredSummary.fallbackEvaluableTurns / triggeredSummary.decisionTurns : null, 4),
      },
    },
  };
}

export function summarizeAllAIDecisionTelemetry(items) {
  const summary = summarizeDecisionTelemetry(items);
  const count = (predicate) => items.filter(predicate).length;
  return {
    schema: 'guandan-evaluation-decision-telemetry-v2',
    ...summary,
    missingVariantTurns: count((item) => !item.variantPresent),
    missingLocalDecisionTurns: count((item) => !item.localDecisionPresent),
    missingSearchTelemetryTurns: count((item) => !item.searchTelemetryPresent),
    missingFallbackKindTurns: count((item) => !item.fallbackKindPresent),
    integrityComplete: summary.decisionTurns > 0 && items.every((item) => item.telemetryComplete),
  };
}
