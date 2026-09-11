/**
 * Small, stdout-only AI diagnostic. This is never a release or promotion runner.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
export const DEFAULT_ENGINES = Object.freeze(['expert', 'ismcts-v3']);
export const DEFAULT_GAMES = 1;
export const DEFAULT_BASE_SEED = 20269003;
function mergeSeedRanges(ranges) {
  const ordered = ranges
    .map((pair) => [pair[0], pair[1]])
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged = [];
  for (const [first, last] of ordered) {
    const previous = merged[merged.length - 1];
    if (previous && first <= previous[1] + 1) previous[1] = Math.max(previous[1], last);
    else merged.push([first, last]);
  }
  return Object.freeze(merged.map((pair) => Object.freeze(pair)));
}
function loadReservedSeedRanges() {
  const registry = JSON.parse(fs.readFileSync(path.join(here, 'strat6-seed-registry.json'), 'utf8'));
  return mergeSeedRanges([
    ...registry.forbiddenRanges.map((item) => [item.start, item.end]),
    [registry.formal.baseSeed, registry.formal.seedEnd],
    [registry.smoke.baseSeed, registry.smoke.seedEnd],
    ...registry.reservedUnused.map((item) => [item.start, item.end]),
  ]);
}
// Merged union of strat6-seed-registry forbidden/formal/smoke/reservedUnused.
// Adjacent or overlapping registry rows are collapsed so validation stays disjoint.
export const RESERVED_SEED_RANGES = loadReservedSeedRanges();
const MAX_GAMES = 128;
// Desktop AI_SPEED_MS waits are not decision latency. 30s cannot cover a
// deterministic ismcts-v3 1800-node round, so the fail-closed timer is 3 min.
export const ROUND_TIMEOUT_MS = 180_000;
const REASON_LIMIT = 120;
export class LocalDiagnosticError extends Error {}

export function seedIsReserved(seed) { return RESERVED_SEED_RANGES.some(([first, last]) => seed >= first && seed <= last); }
export function validateReservedSeedRanges(ranges = RESERVED_SEED_RANGES) {
  const ordered = [...ranges].sort((left, right) => left[0] - right[0]);
  for (let index = 0; index < ordered.length; index += 1) {
    const [first, last] = ordered[index];
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 0 || last > 0xffffffff || first > last) throw new LocalDiagnosticError('保留 seed 区间必须为不折返的 uint32 区间');
    if (index && ordered[index - 1][1] >= first) throw new LocalDiagnosticError('保留 seed 区间不得重叠或碰撞');
  }
  return true;
}
export function parseDiagnosticArgs(argv = process.argv.slice(2)) {
  const config = { games: DEFAULT_GAMES, baseSeed: DEFAULT_BASE_SEED, engines: [...DEFAULT_ENGINES], json: false, shadow: false, locate: false };
  for (const arg of argv) {
    if (arg === '--json') { config.json = true; continue; }
    if (arg === '--locate') { config.locate = true; continue; }
    if (arg.startsWith('--games=')) { config.games = Number(arg.slice(8)); continue; }
    if (arg.startsWith('--base-seed=')) { config.baseSeed = Number(arg.slice(12)); continue; }
    if (arg.startsWith('--engines=')) { config.engines = arg.slice(10).split(',').filter(Boolean); continue; }
    if (/^--(?:release|promotion|release-evidence|full-data|shadow)(?:=|$)/i.test(arg)) throw new LocalDiagnosticError(`拒绝发布、晋级或非默认诊断入口: ${arg}`);
    throw new LocalDiagnosticError(`未知参数: ${arg}`);
  }
  validateDiagnosticConfig(config); return config;
}
export function validateDiagnosticConfig(config) {
  validateReservedSeedRanges();
  if (!Number.isInteger(config.games) || config.games < 1 || config.games > MAX_GAMES) throw new LocalDiagnosticError(`--games 必须是 1-${MAX_GAMES} 的整数`);
  if (!Number.isSafeInteger(config.baseSeed) || config.baseSeed < 0 || config.baseSeed > 0xffffffff) throw new LocalDiagnosticError('--base-seed 必须是 uint32 安全整数');
  if (!Array.isArray(config.engines) || config.engines.length !== DEFAULT_ENGINES.length || DEFAULT_ENGINES.some((name) => !config.engines.includes(name))) throw new LocalDiagnosticError('本地诊断固定比较 expert 与 ismcts-v3');
  for (let offset = 0; offset < config.games; offset += 1) {
    const seed = config.baseSeed + offset;
    if (!Number.isSafeInteger(seed) || seed > 0xffffffff) throw new LocalDiagnosticError(`派生 seed 超出 uint32: ${seed}`);
    if (seedIsReserved(seed)) throw new LocalDiagnosticError(`拒绝保留正式种子: ${seed}`);
  }
}
// No xorshift all-zero alias: seed zero gets its own deterministic stream.
function seededRandom(seed) { let value = seed >>> 0; return () => { value = (value + 0x6D2B79F5) >>> 0; let mixed = value; mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1); mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61); return ((mixed ^ (mixed >>> 14)) >>> 0) / 0x100000000; }; }
export function diagnosticRandomSample(seed) { if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new LocalDiagnosticError('seed 必须是 uint32'); return seededRandom(seed)(); }
function percentile(samples, ratio) { if (!samples.length) return null; const sorted = [...samples].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))]; }
function compactHand(hand) { return !hand || typeof hand !== 'object' ? null : { type: hand.type ?? null, mainRank: hand.mainRank ?? null, size: hand.size ?? null, power: hand.power ?? null }; }
function compactDecision(decision) { return { action: decision?.action ?? null, hand: compactHand(decision?.hand) }; }
export function publicDecisionSummary(context, decision, elapsedMs) { return { seat: Number.isInteger(context?.seat) ? context.seat : null, level: Number.isInteger(context?.level) ? context.level : null, lastSeat: Number.isInteger(context?.lastSeat) ? context.lastSeat : null, lastHand: compactHand(context?.lastHand), handCounts: Array.isArray(context?.handCounts) ? context.handCounts.slice(0, 4).map(Number) : null, publicActions: Array.isArray(context?.publicHistory) ? context.publicHistory.length : null, decision: compactDecision(decision), latencyMs: Number.isFinite(elapsedMs) ? elapsedMs : null }; }
export function publicGameResultSummary(result) {
  const finishOrder = Array.isArray(result?.finishOrder) && result.finishOrder.length === 4
    && result.finishOrder.every((seat) => Number.isInteger(seat) && seat >= 0 && seat < 4)
    && new Set(result.finishOrder).size === 4 ? [...result.finishOrder] : null;
  const winTeam = result?.winTeam === 0 || result?.winTeam === 1 ? result.winTeam : null;
  return { finishOrder, winTeam, status: finishOrder && winTeam != null ? 'observed' : 'unavailable' };
}
function limitedReason(value) { return String(value?.message || value || 'unknown').replace(/[\r\n]+/g, ' ').slice(0, REASON_LIMIT); }
function telemetryOf(decisionMeta) { const meta = decisionMeta?.decisionMeta || decisionMeta || {}; const hybrid = meta?.hybrid && typeof meta.hybrid === 'object' ? meta.hybrid : null; const fallback = typeof meta.fallbackKind === 'string' ? meta.fallbackKind : typeof hybrid?.fallbackKind === 'string' ? hybrid.fallbackKind : 'unknown'; return { attempted: typeof meta.searchAttempted === 'boolean' ? meta.searchAttempted : typeof hybrid?.searchAttempted === 'boolean' ? hybrid.searchAttempted : 'unknown', triggered: typeof meta.searchTriggered === 'boolean' ? meta.searchTriggered : typeof hybrid?.searchTriggered === 'boolean' ? hybrid.searchTriggered : 'unknown', fallback, source: typeof meta.source === 'string' ? meta.source : 'unknown' }; }
export function controlledDecisionTelemetry(decision) {
  const telemetry = telemetryOf(decision);
  const isCleanNonHybrid = decision && decision.hybrid == null
    && decision.localFallbackKind == null
    && telemetry.attempted === 'unknown'
    && telemetry.triggered === 'unknown'
    && telemetry.fallback === 'unknown';
  const locate = decision?.hybrid?.hotPathLocate;
  return {
    attempted: isCleanNonHybrid ? false : telemetry.attempted,
    triggered: isCleanNonHybrid ? false : telemetry.triggered,
    fallback: isCleanNonHybrid ? 'none' : telemetry.fallback,
    source: 'controlled',
    ...(locate?.enabled === true ? { locate } : {}),
  };
}
function increment(map, key) { map[key] = (map[key] || 0) + 1; }
const LOCATE_PHASES = Object.freeze(['sampleWorld', 'cloneRoot', 'createState', 'descend', 'rollout', 'backup', 'restore']);
function newBucket(engine, requestedGames) { return { engine, requestedGames, gameResults: [], latencyMs: [], searchTriggeredLatencyMs: [], nonSearchLatencyMs: [], latencyUnmeasured: 0, decisions: 0, searchAttempted: {}, searchTriggered: {}, fallbackTypes: {}, sources: {}, fallbackUnavailable: 0, failureLabels: {}, decisionExceptions: 0, gamesCompleted: 0, gameExceptions: 0, timeouts: 0, unavailable: [], locateSamples: [] }; }
function summarizeLocate(bucket, triggeredSampleCount) {
  const samples = Array.isArray(bucket.locateSamples) ? bucket.locateSamples : [];
  const phaseTotals = Object.fromEntries(LOCATE_PHASES.map((phase) => [phase, 0]));
  const callSites = [];
  for (const sample of samples) {
    if (sample?.callSite) callSites.push(sample.callSite);
    for (const phase of LOCATE_PHASES) phaseTotals[phase] += Number(sample?.phases?.[phase]) || 0;
  }
  const totalMs = LOCATE_PHASES.reduce((sum, phase) => sum + phaseTotals[phase], 0);
  let dominantPhase = null;
  let dominantMs = -1;
  for (const phase of LOCATE_PHASES) {
    if (phaseTotals[phase] > dominantMs) {
      dominantPhase = phase;
      dominantMs = phaseTotals[phase];
    }
  }
  const uniqueSites = [...new Set(callSites)];
  const located = samples.length > 0 && totalMs > 0 && uniqueSites.length === 1 && (dominantMs / totalMs) >= 0.5;
  return {
    located,
    optimizationAllowed: false,
    cannotUseOverallP95: true,
    triggeredSampleCount,
    locateSampleCount: samples.length,
    callSite: uniqueSites.length === 1 ? uniqueSites[0] : null,
    dominantPhase: totalMs > 0 ? dominantPhase : null,
    dominantShare: totalMs > 0 ? dominantMs / totalMs : 0,
    ...(samples.length ? { phaseTotals } : {}),
    reason: located
      ? `searchTriggered hot path at ${uniqueSites[0]} phase ${dominantPhase}; optimizationAllowed remains false`
      : 'AI-LOCAL-003 remains blocked until a searchTriggered-only profile locates a hot path; overall p95 must not dilute search tails, and coverage/budget/500/750ms must not change',
  };
}
function latencySummary(samples) {
  const count = samples.length;
  return {
    count,
    mean: count ? samples.reduce((sum, value) => sum + value, 0) / count : null,
    p50: percentile(samples, .5),
    p95: percentile(samples, .95),
    p99: percentile(samples, .99),
    max: count ? Math.max(...samples) : null,
  };
}
export function summarizeBucket(bucket) {
  const count = bucket.latencyMs.length; const completed = bucket.gamesCompleted; const failed = bucket.gameExceptions + bucket.timeouts; const fallbackAccounted = Object.values(bucket.fallbackTypes).reduce((sum, value) => sum + value, 0);
  const searchAccounted = (map) => Object.values(map).reduce((sum, value) => sum + value, 0);
  const triggeredSamples = Array.isArray(bucket.searchTriggeredLatencyMs) ? bucket.searchTriggeredLatencyMs : [];
  const nonSearchSamples = Array.isArray(bucket.nonSearchLatencyMs) ? bucket.nonSearchLatencyMs : [];
  return { engine: bucket.engine, games: { requested: bucket.requestedGames, completed, failed, errors: failed, resultCount: bucket.gameResults.length, conserved: bucket.requestedGames === completed + failed && bucket.requestedGames === bucket.gameResults.length }, gameResults: bucket.gameResults, decisions: bucket.decisions, latency: { measuredDirectSeat0: { count, mean: count ? bucket.latencyMs.reduce((sum, value) => sum + value, 0) / count : null, p50: percentile(bucket.latencyMs, .5), p95: percentile(bucket.latencyMs, .95), p99: percentile(bucket.latencyMs, .99), max: count ? Math.max(...bucket.latencyMs) : null }, observerUnmeasured: bucket.latencyUnmeasured, decisionCount: bucket.decisions, conserved: count + bucket.latencyUnmeasured === bucket.decisions, scope: 'p95/p99 are only direct seat-0 wall-clock samples; observer events have no public start time' }, searchTriggeredLatency: { ...latencySummary(triggeredSamples), scope: 'seat-0 wall-clock where searchTriggered===true only' }, nonSearchLatency: { ...latencySummary(nonSearchSamples), scope: 'seat-0 wall-clock where searchTriggered===false' }, search: { attempted: bucket.searchAttempted, triggered: bucket.searchTriggered, attemptedConserved: searchAccounted(bucket.searchAttempted) === bucket.decisions, triggeredConserved: searchAccounted(bucket.searchTriggered) === bucket.decisions }, fallback: { types: bucket.fallbackTypes, sources: bucket.sources, unavailable: bucket.fallbackUnavailable, accountedDecisions: fallbackAccounted, conserved: fallbackAccounted === bucket.decisions }, stability: { completedGames: completed, gameExceptions: bucket.gameExceptions, timeouts: bucket.timeouts, decisionExceptions: bucket.decisionExceptions }, diagnosticSamples: { failureLabels: bucket.failureLabels, unavailable: bucket.unavailable, qualitySignals: { status: 'unavailable', reason: 'No independently validated strength or score scalar is exposed by the public decision API.' } }, hotPath: summarizeLocate(bucket, triggeredSamples.length) };
}
function fingerprintImplementation() { const files = ['js/ai.js', 'js/game.js', 'js/ai-observation.js']; const hash = createHash('sha256'); for (const file of files) hash.update(`${file}\0${fs.readFileSync(path.join(root, file))}\0`); return { algorithm: 'sha256', sha256: hash.digest('hex'), sources: files }; }
async function loadGameApi() { return { ...(await import(pathToFileURL(path.join(root, 'js/game.js')).href)), ...(await import(pathToFileURL(path.join(root, 'js/ai.js')).href)) }; }

export async function playOne({ api, engine, seed, bucket, timeoutMs = ROUND_TIMEOUT_MS, scheduleTimeout = null, cancelTimeout = null }) {
  const realRandom = Math.random;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const armTimeout = scheduleTimeout || realSetTimeout;
  const armCancelTimeout = cancelTimeout || realClearTimeout;
  let state = null; let active = true; let settled = false; let timer = null;
  let pendingSeat0Latency = null; let pendingSeat0Telemetry = null;
  // Collapse animation waits so seat-1..3 autoplay does not dominate the
  // 3-minute fail-closed budget. Round timeout still uses the unpatched timer.
  globalThis.setTimeout = (fn, _ms, ...args) => realSetTimeout(fn, 0, ...args);
  globalThis.clearTimeout = realClearTimeout;
  const cleanup = () => { active = false; state = null; pendingSeat0Latency = null; pendingSeat0Telemetry = null; if (timer !== null) armCancelTimeout(timer); timer = null; api.setUpdateCallback?.(null); api.setAIDecisionObserver?.(null); api.setReplayEventObserver?.(null); globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout; Math.random = realRandom; };
  try {
    Math.random = seededRandom(seed);
    return await new Promise((resolve) => {
      const finish = (result) => { if (settled) return; settled = true; bucket.gameResults.push({ seed, status: result.ok ? 'completed' : result.timeout ? 'timeout' : 'error', result: result.ok ? publicGameResultSummary(result.publicResult) : null }); cleanup(); resolve(result); };
      const recordFailure = (label) => increment(bucket.failureLabels, label);
      const recordPublicEvent = (event) => { if (!active || !['play', 'pass'].includes(event?.eventType) || !Number.isInteger(event.seat)) return; const controlled = event.seat === 0 && pendingSeat0Telemetry; const telemetry = controlled || telemetryOf(event.decisionMeta); bucket.decisions += 1; if (controlled) { increment(bucket.searchAttempted, String(telemetry.attempted)); increment(bucket.searchTriggered, String(telemetry.triggered)); increment(bucket.fallbackTypes, telemetry.fallback); increment(bucket.sources, telemetry.source); pendingSeat0Telemetry = null; } else { increment(bucket.searchAttempted, String(telemetry.attempted)); increment(bucket.searchTriggered, String(telemetry.triggered)); increment(bucket.fallbackTypes, telemetry.fallback); increment(bucket.sources, telemetry.source); } if (event.seat === 0 && Number.isFinite(pendingSeat0Latency)) { bucket.latencyMs.push(pendingSeat0Latency); if (telemetry.triggered === true) { bucket.searchTriggeredLatencyMs.push(pendingSeat0Latency); if (telemetry.locate) bucket.locateSamples.push(telemetry.locate); } else if (telemetry.triggered === false) bucket.nonSearchLatencyMs.push(pendingSeat0Latency); pendingSeat0Latency = null; } else bucket.latencyUnmeasured += 1; if (telemetry.fallback === 'unknown') { bucket.fallbackUnavailable += 1; if (bucket.unavailable.length < 6) bucket.unavailable.push('fallbackKind unavailable in public replay decisionMeta'); } if (telemetry.attempted === 'unknown' || telemetry.triggered === 'unknown' || telemetry.source === 'unknown') { if (bucket.unavailable.length < 6) bucket.unavailable.push('public replay decisionMeta has an observability gap'); } };
      const pump = () => { try { if (!active || !state) return; if (state.phase === api.PHASE.ROUND_END || state.phase === api.PHASE.MATCH_END) { bucket.gamesCompleted += 1; finish({ ok: true, publicResult: state.lastRoundResult }); return; } if (state.phase !== api.PHASE.PLAYING || state.currentSeat !== 0 || state.aiThinking) return; const context = api.aiDecisionContext(state, 0); pendingSeat0Latency = null; pendingSeat0Telemetry = null; const started = performance.now(); const decision = api.chooseAIPlay(context); pendingSeat0Latency = performance.now() - started; pendingSeat0Telemetry = controlledDecisionTelemetry(decision); if (!decision) throw new Error('seat 0 returned no decision'); const outcome = decision.action === 'pass' ? api.humanPass(state) : (api.humanSelectSet(state, decision.cards.map((card) => card.id), decision.signature || null, null), api.humanPlay(state)); if (!outcome?.ok) throw new Error(outcome?.reason || 'seat 0 action rejected'); } catch (error) { if (!active) return; bucket.decisionExceptions += 1; bucket.gameExceptions += 1; recordFailure('decision_error'); finish({ ok: false, error: limitedReason(error) }); } };
      api.setUpdateCallback(pump); api.setAIDecisionObserver?.(null);
      api.setReplayEventObserver?.(recordPublicEvent);
      timer = armTimeout(() => { if (!active) return; bucket.timeouts += 1; recordFailure('round_timeout'); finish({ ok: false, timeout: true }); }, timeoutMs);
      try { const variant = api.resolvePolicyVariant(engine); state = api.createMatch({ difficulty: 'master', aiSpeed: 'fast', deterministicAI: true, sealedTraining: false, llmPolicyMode: 'local', opponentModelMode: 'off', aiDifficultyBySeat: ['master', 'master', 'master', 'master'], aiPolicyBySeat: Array(4).fill(variant.policyProfile), aiPolicyFeaturesBySeat: Array.from({ length: 4 }, () => ({ ...variant.policyFeatures })), aiPolicyThresholdsBySeat: Array.from({ length: 4 }, () => variant.policyThresholds ? { ...variant.policyThresholds } : null), aiDecisionEngineBySeat: Array(4).fill(variant.decisionEngine) }); api.startMatch(state); pump(); } catch (error) { if (!active) return; bucket.gameExceptions += 1; recordFailure('game_start_error'); finish({ ok: false, error: limitedReason(error) }); }
    });
  } finally { cleanup(); }
}
export function buildDiagnosticReport(config, buckets, implementation = fingerprintImplementation()) {
  const observedMetrics = config.engines.map((engine) => summarizeBucket(buckets.get(engine))); const requested = observedMetrics.reduce((sum, item) => sum + item.games.requested, 0); const completed = observedMetrics.reduce((sum, item) => sum + item.games.completed, 0); const failed = observedMetrics.reduce((sum, item) => sum + item.games.failed, 0); const decisions = observedMetrics.reduce((sum, item) => sum + item.decisions, 0); const errors = observedMetrics.reduce((sum, item) => sum + item.games.errors, 0); const conserved = requested === completed + failed && observedMetrics.every((item) => item.games.conserved && item.latency.conserved && item.fallback.conserved);
  const v3HotPath = observedMetrics.find((item) => item.engine === 'ismcts-v3')?.hotPath
    || { located: false, optimizationAllowed: false, cannotUseOverallP95: true };
  return { schema: 'guandan-ai-local-baseline-v2', runStatus: failed || !conserved ? 'failed' : 'completed', diagnosticStatus: { diagnosticOnly: true, localDiagnostic: true, releaseEvidence: false, promotionEvidence: false, label: 'local diagnostic only; not release or promotion evidence' }, config: { gamesPerEngine: config.games, seeds: Array.from({ length: config.games }, (_, index) => config.baseSeed + index), engines: [...config.engines], deterministic: true, opponentModelMode: 'off', shadow: { enabled: false, reason: 'disabled by default to avoid perturbing real-engine timing and stability' }, locate: config.locate === true, output: 'stdout-only' }, implementation, totals: { requested, completed, failed, decisions, errors, conserved }, observedMetrics, hotPath: { ...v3HotPath, optimizationAllowed: false, cannotUseOverallP95: true }, limitations: ['Small non-formal sample. Quality and strength are unavailable.', 'Observer decisions have no public wall-clock start time; latency and fallback metadata unavailable from the observer are explicitly counted as unavailable/unknown.', 'Timeout is fail-closed. This in-process diagnostic does not claim to safely terminate arbitrary synchronous work.', 'searchTriggered latency is isolated from overall p95; overall p95 must not be used as a search-performance gate.', 'locateHotPath is diagnostic-only; it does not change search coverage, budgets, or 500/750ms.'] };
}
export function diagnosticExitCode(report) { return report?.runStatus === 'completed' ? 0 : 1; }
export async function runLocalDiagnostic(config, dependencies = {}) {
  validateDiagnosticConfig(config);
  let locateModule = null;
  if (config.locate === true) {
    locateModule = await import(pathToFileURL(path.join(root, 'js/ai-hybrid.js')).href);
    locateModule.setHybridHotPathLocate(true);
  }
  try {
    const api = dependencies.api || await loadGameApi();
    const buckets = new Map(config.engines.map((engine) => [engine, newBucket(engine, config.games)]));
    for (const engine of config.engines) for (let index = 0; index < config.games; index += 1) await playOne({ api, engine, seed: config.baseSeed + index, bucket: buckets.get(engine), ...dependencies });
    return buildDiagnosticReport(config, buckets, dependencies.implementation || fingerprintImplementation());
  } finally {
    locateModule?.setHybridHotPathLocate(false);
  }
}
export async function main(argv = process.argv.slice(2)) { const config = parseDiagnosticArgs(argv); const report = await runLocalDiagnostic(config); process.stdout.write(`${JSON.stringify(report)}\n`); return report; }
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then((report) => { process.exitCode = diagnosticExitCode(report); }).catch((error) => { process.stderr.write(`${error.name}: ${error.message}\n`); process.exitCode = 1; });
