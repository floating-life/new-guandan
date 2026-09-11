import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_ENGINES, RESERVED_SEED_RANGES, ROUND_TIMEOUT_MS, controlledDecisionTelemetry, diagnosticExitCode, diagnosticRandomSample, parseDiagnosticArgs, publicDecisionSummary, publicGameResultSummary, runLocalDiagnostic, summarizeBucket, validateDiagnosticConfig, validateReservedSeedRanges } from './ai_local_baseline.mjs';
assert.match(readFileSync(new URL('./verify.ps1', import.meta.url), 'utf8'), /tools\/test_ai_local_baseline\.mjs/);
assert.equal(ROUND_TIMEOUT_MS, 180_000, '一局诊断超时必须覆盖 deterministic v3 的 1800 节点搜索，不能只用桌面动画的 30s');
assert.deepEqual(DEFAULT_ENGINES, ['expert', 'ismcts-v3']);
for (const [first, last] of RESERVED_SEED_RANGES) { assert.throws(() => parseDiagnosticArgs([`--base-seed=${first}`]), /保留正式种子/); assert.throws(() => parseDiagnosticArgs([`--base-seed=${last}`]), /保留正式种子/); }
const registry = JSON.parse(readFileSync(new URL('./strat6-seed-registry.json', import.meta.url), 'utf8'));
const registryReserved = [
  ...registry.forbiddenRanges.map((item) => [item.start, item.end]),
  [registry.formal.baseSeed, registry.formal.seedEnd],
  [registry.smoke.baseSeed, registry.smoke.seedEnd],
  ...registry.reservedUnused.map((item) => [item.start, item.end]),
];
for (const [first, last] of registryReserved) {
  assert.throws(() => parseDiagnosticArgs([`--base-seed=${first}`]), /保留正式种子/, `registry start ${first}`);
  assert.throws(() => parseDiagnosticArgs([`--base-seed=${last}`]), /保留正式种子/, `registry end ${last}`);
}
assert.throws(() => parseDiagnosticArgs(['--base-seed=20260903']), /保留正式种子/);
assert.throws(() => parseDiagnosticArgs(['--base-seed=20260941']), /保留正式种子/);
const defaults = parseDiagnosticArgs([]);
assert.equal(defaults.baseSeed, 20269003);
assert.doesNotThrow(() => validateDiagnosticConfig({ games: 8, baseSeed: defaults.baseSeed, engines: DEFAULT_ENGINES }));
assert.doesNotThrow(() => validateDiagnosticConfig({ games: 16, baseSeed: defaults.baseSeed, engines: DEFAULT_ENGINES }));
assert.doesNotThrow(() => validateDiagnosticConfig({ games: 32, baseSeed: defaults.baseSeed, engines: DEFAULT_ENGINES }));
assert.doesNotThrow(() => validateDiagnosticConfig({ games: 64, baseSeed: defaults.baseSeed, engines: DEFAULT_ENGINES }));
assert.doesNotThrow(() => validateDiagnosticConfig({ games: 128, baseSeed: defaults.baseSeed, engines: DEFAULT_ENGINES }));
assert.throws(() => validateDiagnosticConfig({ games: 129, baseSeed: defaults.baseSeed, engines: DEFAULT_ENGINES }), /1-128/);
assert.throws(() => parseDiagnosticArgs(['--base-seed=20268102', '--games=2']), /保留正式种子/); assert.doesNotThrow(() => parseDiagnosticArgs(['--base-seed=20268099'])); assert.doesNotThrow(() => parseDiagnosticArgs(['--base-seed=4294967295'])); assert.throws(() => validateDiagnosticConfig({ games: 2, baseSeed: 4294967295, engines: DEFAULT_ENGINES }), /超出 uint32/); assert.throws(() => validateReservedSeedRanges([[1, 4], [4, 5]]), /碰撞/); assert.throws(() => validateReservedSeedRanges([[5, 4]]), /不折返/); assert.notEqual(diagnosticRandomSample(0), diagnosticRandomSample(1), 'seed 0 不得与 seed 1 静默别名'); assert.throws(() => parseDiagnosticArgs(['--release-evidence']), /拒绝发布、晋级或非默认诊断入口/); assert.throws(() => parseDiagnosticArgs(['--shadow']), /拒绝发布、晋级或非默认诊断入口/);
assert.equal(defaults.locate, false, '定位切片默认关闭');
assert.equal(parseDiagnosticArgs(['--locate']).locate, true);
assert.throws(() => parseDiagnosticArgs(['--locate', '--release-evidence']), /拒绝发布、晋级或非默认诊断入口/);
const config = parseDiagnosticArgs(['--games=1', '--base-seed=20269003', '--json']);
function bucket(engine = 'expert') { return { engine, requestedGames: 1, gameResults: [{ seed: 1, status: 'completed', result: { finishOrder: [0, 2, 1, 3], winTeam: 0, status: 'observed' } }], latencyMs: [1, 4], searchTriggeredLatencyMs: [], nonSearchLatencyMs: [1, 4], latencyUnmeasured: 1, decisions: 3, searchAttempted: { true: 2, unknown: 1 }, searchTriggered: { false: 2, unknown: 1 }, fallbackTypes: { none: 2, unknown: 1 }, sources: { local: 2, unknown: 1 }, fallbackUnavailable: 1, failureLabels: {}, decisionExceptions: 0, gamesCompleted: 1, gameExceptions: 0, timeouts: 0, unavailable: ['fallback observer unavailable: decision metadata absent'] }; }
const metrics = summarizeBucket(bucket()); assert(metrics.games.conserved && metrics.latency.conserved && metrics.fallback.conserved); assert.equal(metrics.fallback.types.unknown, 1); assert.equal(metrics.fallback.unavailable, 1); assert(!('divergences' in metrics.diagnosticSamples));
assert.equal(metrics.latency.measuredDirectSeat0.p95, 4); assert.equal(metrics.latency.observerUnmeasured, 1); assert(metrics.search.attemptedConserved && metrics.search.triggeredConserved); assert.equal(metrics.search.attempted.unknown, 1);
assert.equal(metrics.hotPath.optimizationAllowed, false, '001/003 诊断不得自行打开搜索优化');
assert.equal(metrics.hotPath.located, false);
const mixed = bucket('ismcts-v3');
mixed.latencyMs = Array(100).fill(1).concat([600]);
mixed.nonSearchLatencyMs = Array(100).fill(1);
mixed.searchTriggeredLatencyMs = [600];
mixed.decisions = 101;
mixed.searchTriggered = { true: 1, false: 100 };
mixed.searchAttempted = { true: 1, false: 100 };
const mixedMetrics = summarizeBucket(mixed);
assert.equal(mixedMetrics.latency.measuredDirectSeat0.p95, 1, '总体 P95 会被未搜索回合稀释');
assert.equal(mixedMetrics.searchTriggeredLatency.p95, 600, 'searchTriggered 子集必须单独审计尾延迟');
assert.equal(mixedMetrics.searchTriggeredLatency.count, 1);
assert.equal(mixedMetrics.hotPath.optimizationAllowed, false);
assert.equal(mixedMetrics.hotPath.cannotUseOverallP95, true);
assert.equal(mixedMetrics.hotPath.located, false, '无调用点样本时不得宣称已定位');
const locatedBucket = bucket('ismcts-v3');
locatedBucket.searchTriggeredLatencyMs = [600];
locatedBucket.locateSamples = [{
  enabled: true,
  callSite: 'js/ai-hybrid.js:runISMCTSSearch',
  phases: { sampleWorld: 10, cloneRoot: 5, createState: 20, descend: 40, rollout: 400, backup: 15, restore: 10 },
  totalMs: 500,
  dominantPhase: 'rollout',
  dominantShare: 0.8,
}];
const locatedMetrics = summarizeBucket(locatedBucket);
assert.equal(locatedMetrics.hotPath.located, true, '主导阶段+调用点才算定位');
assert.equal(locatedMetrics.hotPath.dominantPhase, 'rollout');
assert.equal(locatedMetrics.hotPath.callSite, 'js/ai-hybrid.js:runISMCTSSearch');
assert.equal(locatedMetrics.hotPath.optimizationAllowed, false, '定位不等于允许优化');
assert.deepEqual(controlledDecisionTelemetry({ action: 'play' }), { attempted: false, triggered: false, fallback: 'none', source: 'controlled' }); assert.deepEqual(controlledDecisionTelemetry({ action: 'play', hybrid: { searchAttempted: true, searchTriggered: true, fallbackKind: 'search_evidence_insufficient' } }), { attempted: true, triggered: true, fallback: 'search_evidence_insufficient', source: 'controlled' });
const safe = publicDecisionSummary({ seat: 0, level: 2, lastHand: { type: 'single', mainRank: 3, size: 1, power: 3 }, handCounts: [8, 9, 10, 11], publicHistory: [], hand: [{ id: 'secret' }], hands: [['secret']], private: { cards: ['secret'] } }, { action: 'play', cards: [{ id: 'secret' }], hand: { type: 'single', mainRank: 4, size: 1, power: 4 }, decisionMeta: { projectedOpponentHand: ['secret'] } }, 3); assert(!/secret|\"hand\"\s*:\s*\[|\"hands\"|\"cards\"|projectedOpponentHand|private/.test(JSON.stringify(safe)));
const result = publicGameResultSummary({ finishOrder: [0, 2, 1, 3], winTeam: 0, reward: 99, initialHands: [['secret']] }); assert.deepEqual(result, { finishOrder: [0, 2, 1, 3], winTeam: 0, status: 'observed' }); assert(!/reward|secret|initialHands/.test(JSON.stringify(result))); assert.equal(publicGameResultSummary({ finishOrder: [0, 0], winTeam: 3 }).status, 'unavailable');
function fakeApi({ throwDecision = false, neverFinish = false, observerDecision = { action: 'pass' } } = {}) { let update = null; let replayObserver = null; const calls = []; const api = { PHASE: { PLAYING: 'playing', ROUND_END: 'round_end', MATCH_END: 'match_end' }, setUpdateCallback(fn) { update = fn; calls.push(['update', fn]); }, setAIDecisionObserver(fn) { calls.push(['observer', fn]); }, setReplayEventObserver(fn) { replayObserver = fn; calls.push(['replay', fn]); }, resolvePolicyVariant() { return { policyProfile: 'expert', policyFeatures: {}, policyThresholds: null, decisionEngine: 'local' }; }, createMatch() { return { phase: 'playing', currentSeat: 0, aiThinking: false, lastRoundResult: { finishOrder: [0, 2, 1, 3], winTeam: 0, reward: 99 } }; }, startMatch(state) { if (!neverFinish) { replayObserver?.({ eventType: 'pass', seat: 1, decisionMeta: { source: 'local', searchAttempted: false, searchTriggered: false, fallbackKind: 'none' } }); if (!throwDecision) state.phase = 'round_end'; update?.(); } }, aiDecisionContext() { return { seat: 0, handCounts: [1, 1, 1, 1], publicHistory: [] }; }, chooseAIPlay() { if (throwDecision) throw new Error('injected decision fault'); return { action: 'pass', localFallbackKind: 'none' }; }, humanPass() { replayObserver?.({ eventType: 'pass', seat: 0, decisionMeta: null }); return { ok: true }; }, humanSelectSet() {}, humanPlay() { return { ok: true }; } }; return { api, calls, invokeLate: () => { update?.(); replayObserver?.({ eventType: 'pass', seat: 1, decisionMeta: observerDecision.decisionMeta || null }); } }; }
const originalRandom = Math.random; const originalSetTimeout = globalThis.setTimeout; const originalClearTimeout = globalThis.clearTimeout; const normal = fakeApi(); const normalReport = await runLocalDiagnostic(config, { api: normal.api, implementation: { algorithm: 'fixture', sha256: 'fixture', sources: [] } }); assert.equal(normalReport.runStatus, 'completed'); assert.equal(diagnosticExitCode(normalReport), 0); assert.equal(normalReport.totals.requested, 2); assert.equal(normalReport.totals.completed, 2); assert.equal(normalReport.totals.failed, 0); assert.equal(normalReport.totals.errors, 0); assert(normalReport.observedMetrics.every((item) => item.games.resultCount === 1 && item.gameResults[0].result.status === 'observed')); assert(normalReport.observedMetrics.every((item) => item.latency.conserved && item.fallback.conserved && item.search.attemptedConserved && item.search.triggeredConserved)); assert(normalReport.observedMetrics.flatMap((item) => item.diagnosticSamples.unavailable).every((reason) => reason.length <= 120)); assert(!/releaseEvidenceReady|promoted/.test(JSON.stringify(normalReport)));
assert.equal(normalReport.hotPath.optimizationAllowed, false, '诊断报告不得允许搜索优化');
assert.equal(normalReport.hotPath.located, false);
assert.equal(normalReport.config.locate, false); assert.equal(Math.random, originalRandom); assert.equal(globalThis.setTimeout, originalSetTimeout); assert.equal(globalThis.clearTimeout, originalClearTimeout); assert(normal.calls.filter(([kind, value]) => kind === 'update' && value === null).length >= 2); assert(normal.calls.filter(([kind, value]) => kind === 'observer' && value === null).length >= 2); assert(normal.calls.filter(([kind, value]) => kind === 'replay' && value === null).length >= 2); const decisionsBeforeLate = normalReport.totals.decisions; normal.invokeLate(); assert.equal(normalReport.totals.decisions, decisionsBeforeLate);
const failure = fakeApi({ throwDecision: true }); const failed = await runLocalDiagnostic(config, { api: failure.api, implementation: { algorithm: 'fixture', sha256: 'fixture', sources: [] } }); assert.equal(failed.runStatus, 'failed'); assert.equal(diagnosticExitCode(failed), 1, '被测 CLI 的 failed 状态必须是非零语义'); assert.equal(failed.totals.failed, 2); assert.equal(failed.totals.completed, 0); assert.equal(failed.totals.errors, 2);
const timeout = fakeApi({ neverFinish: true }); let armedTimeoutMs = null; const timedOut = await runLocalDiagnostic(config, { api: timeout.api, scheduleTimeout: (callback, ms) => { armedTimeoutMs = ms; queueMicrotask(callback); return 1; }, cancelTimeout: () => {}, implementation: { algorithm: 'fixture', sha256: 'fixture', sources: [] } }); assert.equal(armedTimeoutMs, 180_000); assert.equal(timedOut.runStatus, 'failed'); assert.equal(timedOut.totals.failed, 2); assert.equal(timedOut.totals.errors, 2); assert(timedOut.observedMetrics.every((item) => item.stability.timeouts === 1));
console.log('ai local baseline tests passed');
