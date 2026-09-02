/**
 * 可复现的 AI 策略 A/B 镜像赛。
 *
 * 用法：
 *   node js/ai.ab.simulation.js [种子组数=30] [基础种子=20260801]
 *     [候选策略=expert] [对照策略=baseline] [--levels=all|2,3,...,A]
 *     [--level-blocks] [--continuous-match] [--trace-divergence] [--summary-only]
 *     [--value-model=C:\路径\实验模型.json]
 *     [--report=C:\路径\A-B报告.json] [--checkpoint=C:\路径\检查点.json] [--resume]
 *     [--hybrid-turn-log=C:\路径\回合日志.ndjson]
 *     [--hybrid-scenario-log=C:\路径\盲评场景.ndjson]
 *     [--raw-telemetry=C:\路径\原始遥测.json]
 *     [--environment-telemetry=C:\路径\运行环境遥测.json]
 *
 * 每个种子发两次完全相同的牌：
 *   1. candidate 坐 0+2，comparison 坐 1+3；
 *   2. comparison 坐 0+2，candidate 坐 1+3。
 * 所有座位都通过 chooseAIPlay，以 master + deterministic 作出决定。
 * 可用策略还包括 no-control-v2 与五个 only-* 控制策略独立消融臂。
 */
import { performance } from 'node:perf_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realRandom = Math.random;

// 跳过界面动画等待，但仍通过 game.js 的正式状态推进流程。
globalThis.setTimeout = (fn) => {
  queueMicrotask(fn);
  return 1;
};
globalThis.clearTimeout = () => {};

const {
  createMatch,
  startMatch,
  humanPlay,
  humanPass,
  humanSelectSet,
  humanPickReturnCard,
  humanConfirmReturn,
  getReturnCandidates,
  nextRound,
  setUpdateCallback,
  setAIDecisionObserver,
  PHASE,
  TEAM_OF,
} = await import('./game.js');
const {
  chooseAIPlay, chooseReturnCard, resolvePolicyVariant, AI_POLICY_VARIANTS,
  resolveHybridSearchConfig,
} = await import('./ai.js');
const { describeUpgrade, handSignature } = await import('./rules.js');
const { sortHand } = await import('./cards.js');
const {
  configureHybridValueModel, validateHybridValueModel, HYBRID_ENGINE_VERSION,
} = await import('./ai-hybrid.js');
const {
  createSeedManifest, seedManifestOverlap, valueModelStatus,
} = await import('./value-model-gate.js');
const { modelPayloadSha256 } = await import('./model-fingerprint.js');
const {
  collectDecisionTelemetry,
  summarizeDecisionTelemetry,
  summarizeAllAIDecisionTelemetry,
} = await import('./ai.ab.telemetry.js');
const {
  AB_REPORT_SCHEMA,
  CHECKPOINT_INTEGRITY_SCHEMA,
  CHECKPOINT_SCHEMA,
  EVALUATION_PROVENANCE_SCHEMA,
  PERFORMANCE_BY_RUN_SEGMENT_SCHEMA,
  RUN_SEGMENT_SCHEMA,
  collectEvaluationEnvironment,
  environmentHashMatches,
  isSha256,
  isUuid,
  sha256Canonical,
  stableJson,
} = await import('./ai.ab.provenance.js');
const {
  ENVIRONMENT_TELEMETRY_ARTIFACT_SCHEMA,
  ENVIRONMENT_TELEMETRY_SIDECAR_SCHEMA,
  createEnvironmentTelemetryCollector,
  readPowerState,
  unavailableEnvironmentTelemetry,
  validateEnvironmentTelemetryArtifact,
} = await import('./ai.ab.environment-telemetry.js');

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
// A/B 通过 game.js 的正式状态机推进，不能只绑定“直接出牌”的策略文件。
// 清单覆盖 runner 的静态/动态 import 与 game.js 可达的 Worker、评价、存储
// 和 LLM 路径；即使 Node 评测当前走同步 Worker 回退，也必须使其字节变化
// 令旧 checkpoint 失效。测试独立复算此闭包，防止以后新增依赖却漏入清单。
const EVALUATION_IMPLEMENTATION_SOURCES = Object.freeze([
  'ai.ab.simulation.js',
  'ai.ab.environment-telemetry.js',
  'ai.ab.telemetry.js',
  'ai.ab.provenance.js',
  'ai-hybrid.js',
  'ai-observation.js',
  'ai-route.js',
  'ai.js',
  'ai.worker-client.js',
  'ai.worker.js',
  'cards.js',
  'evaluator.js',
  'game.js',
  'llm.js',
  'model-fingerprint.js',
  'opponent-model.js',
  'replay-contracts.js',
  'rules.js',
  'stats.js',
  'strategy-core.js',
  'value-model-gate.js',
]);
const evaluationImplementation = fingerprintEvaluationImplementation(
  EVALUATION_IMPLEMENTATION_SOURCES,
);
const evaluationEnvironment = collectEvaluationEnvironment();

const groupCount = positiveInteger(process.argv[2], 30);
const baseSeed = finiteUint32(process.argv[3], 20260801);
assertEvaluationSeedRange(groupCount, baseSeed);
const evaluationSeedManifest = createSeedManifest(Array.from(
  { length: groupCount }, (_, index) => (baseSeed + index) >>> 0,
));
const candidateName = policyVariantName(process.argv[4], 'expert');
const comparisonName = policyVariantName(process.argv[5], 'baseline');
const jsonOnly = process.argv.includes('--json');
const evaluationLevels = parseEvaluationLevels(process.argv);
const levelBlockDesign = process.argv.includes('--level-blocks');
const continuousMatch = process.argv.includes('--continuous-match');
const traceDivergence = process.argv.includes('--trace-divergence');
// 大样本门禁只需要汇总量。省略逐副明细可显著降低子进程 JSON 序列化、
// 内存复制和父进程解析成本，不改变任何对局或统计口径。
const summaryOnly = process.argv.includes('--summary-only');
const MAX_ACTIONS = continuousMatch ? 30_000 : 2000;
const MAX_MATCH_ROUNDS = 80;
const GAME_TIMEOUT_MS = 180_000;
// A/B legs must start from the same policy state.  `createMatch` normally
// loads and updates a player-specific, persistent opponent profile after each
// round.  That makes the second mirror leg depend on the first leg even when
// both policies are identical, so evaluation explicitly keeps that adaptive
// feature off.  The profile remains available to the product's normal play.
const EVALUATION_OPPONENT_MODEL_MODE = 'off';
// M3 发布质量报告将一副至少 120 次行动的牌局视为“长局”。阈值写入
// 报告本身，避免后续按不同口径回看同一场连续赛。
const LONG_ROUND_ACTIONS = 120;
const CANDIDATE = resolvePolicyVariant(candidateName);
const COMPARISON = resolvePolicyVariant(comparisonName);
// These are the exact deterministic settings that chooseAIPlay resolves for
// this evaluation.  Keep them explicit in every immutable artifact.
const candidateSearchConfig = resolveHybridSearchConfig(CANDIDATE.decisionEngine, {
  deterministic: true,
  timeBudgetMs: 0,
});
const valueModelFlag = process.argv.find((item) => String(item).startsWith('--value-model='));
const valueModelPath = valueModelFlag
  ? path.resolve(String(valueModelFlag).slice('--value-model='.length)) : null;
const reportFlag = process.argv.find((item) => String(item).startsWith('--report='));
const reportPath = reportFlag
  ? path.resolve(String(reportFlag).slice('--report='.length)) : null;
const checkpointFlag = process.argv.find((item) => String(item).startsWith('--checkpoint='));
const checkpointPath = checkpointFlag
  ? path.resolve(String(checkpointFlag).slice('--checkpoint='.length)) : null;
// 正式性能门使用的逐决策原始遥测。只有显式请求时写出，避免改变旧评测的
// 默认输出；请求时必须同时提供报告和 v3 checkpoint，以便在同一运行中绑定。
const rawTelemetryFlag = process.argv.find((item) => String(item).startsWith('--raw-telemetry='));
const rawTelemetryPath = rawTelemetryFlag
  ? path.resolve(String(rawTelemetryFlag).slice('--raw-telemetry='.length)) : null;
if (rawTelemetryPath && (!reportPath || !checkpointPath)) {
  throw new Error('--raw-telemetry 需要同时提供 --report 和 --checkpoint');
}
// PERF-2 is explicitly opt-in so ordinary A/B runs do not launch diagnostic
// observers or power-profile queries and therefore do not perturb performance.
// The sidecar is separate from the v3 checkpoint schema and is atomically
// rewritten after each checkpoint when this flag is supplied.
const environmentTelemetryFlag = process.argv.find((item) => (
  String(item).startsWith('--environment-telemetry=')
));
const comparablePath = (value) => {
  let resolved = path.resolve(value);
  // Resolve an existing target or its nearest existing parent so a junction,
  // symlink, or Windows short-name alias cannot bypass the protected-path
  // comparison.  The final basename may not exist yet (normal sidecar case),
  // hence the small suffix walk instead of realpathSync on the whole target.
  const suffix = [];
  let existing = resolved;
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) {
    suffix.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  try { existing = fs.realpathSync.native(existing); } catch { /* lexical fallback */ }
  resolved = path.join(existing, ...suffix);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};
const environmentTelemetryPath = environmentTelemetryFlag
  ? path.resolve(String(environmentTelemetryFlag).slice('--environment-telemetry='.length)) : null;
if (environmentTelemetryFlag
  && !String(environmentTelemetryFlag).slice('--environment-telemetry='.length).trim()) {
  throw new Error('--environment-telemetry 需要非空文件路径');
}
if (environmentTelemetryPath && !checkpointPath) {
  throw new Error('--environment-telemetry 需要同时提供 --checkpoint');
}
if (environmentTelemetryPath) {
  const forbiddenArtifactPaths = [
    checkpointPath,
    checkpointPath ? `${checkpointPath}.last-valid` : null,
    reportPath,
    rawTelemetryPath,
  ].filter(Boolean).map((value) => path.resolve(value));
  if (forbiddenArtifactPaths.some((value) => comparablePath(value) === comparablePath(environmentTelemetryPath))) {
    throw new Error('--environment-telemetry 路径不得覆盖 checkpoint、last-valid、report 或 raw telemetry');
  }
}
// 逐回合 NDJSON 日志（追加写）：只记录搜索实际触发的回合，供改选归因与盲评
// 场景提取使用；默认关闭，不影响报告字节。
const hybridTurnLogFlag = process.argv.find((item) => String(item).startsWith('--hybrid-turn-log='));
const hybridTurnLogPath = hybridTurnLogFlag
  ? path.resolve(String(hybridTurnLogFlag).slice('--hybrid-turn-log='.length)) : null;
// 盲评场景日志（追加写，默认关闭）：只在“搜索提议经门禁后改选专家首选”的回合
// 记录完整公开观察与双选项载荷，供 WP5 真人盲评题目集提取；与逐回合计数日志
// 分离，避免大批量评测的报告/日志体积膨胀。
const hybridScenarioLogFlag = process.argv.find((item) => String(item).startsWith('--hybrid-scenario-log='));
const hybridScenarioLogPath = hybridScenarioLogFlag
  ? path.resolve(String(hybridScenarioLogFlag).slice('--hybrid-scenario-log='.length)) : null;
const resumeCheckpoint = process.argv.includes('--resume');
let valueModelAudit = null;
if (valueModelPath) {
  if (!['hybrid', 'ismcts'].includes(CANDIDATE.decisionEngine)) {
    throw new Error('--value-model 只可用于 hybrid-v1 或 root-pimc-v1 候选策略（ismcts-v1 仅为历史兼容别名）');
  }
  // 当前价值模型是进程级配置。为保证对照组绝不读取候选权重，带模型的
  // 发布赛强制以稳定 expert 为对照；同引擎无模型消融应另起独立进程实现。
  if (COMPARISON.name !== 'expert') {
    throw new Error('--value-model 的对照策略必须是 expert，避免权重污染对照组');
  }
  const model = JSON.parse(fs.readFileSync(valueModelPath, 'utf8'));
  const validation = validateHybridValueModel(model);
  if (!validation.ok) throw new Error(`价值模型格式无效：${validation.reason}`);
  const trainingSeedManifest = model.metadata?.trainingSeedManifest
    || model.metadata?.trainingData?.seedManifest || null;
  const overlappingSeeds = seedManifestOverlap(evaluationSeedManifest, trainingSeedManifest);
  if (overlappingSeeds.length) {
    throw new Error(`评测种子与训练种子重叠（${overlappingSeeds.slice(0, 8).join(', ')}${
      overlappingSeeds.length > 8 ? '…' : ''}）；请改用未见种子后再启动 A/B`);
  }
  const configured = configureHybridValueModel(model, { allowExperimental: true });
  if (!configured.ok) throw new Error(`价值模型无法用于离线A/B：${configured.reason}`);
  valueModelAudit = {
    id: validation.model.id,
    status: valueModelStatus(model),
    sha256: modelPayloadSha256(model),
    trainingSeedManifest,
    trainingDatasetSha256: model.metadata?.trainingData?.sha256 || null,
  };
}

let activeRun = null;
let processing = false;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function finiteUint32(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed >>> 0 : fallback >>> 0;
}

function assertEvaluationSeedRange(count, firstSeed) {
  // 检查点将 seed 作为唯一覆盖键的一部分。允许 uint32 回绕会让“下一区组”
  // 与预登记的原始种子序列不再一一对应，因此在启动前直接拒绝。
  if (count > (0x1_0000_0000 - firstSeed)) {
    throw new Error('评测种子范围发生 uint32 回绕，无法建立唯一的 checkpoint 覆盖键');
  }
}

function fingerprintEvaluationImplementation(relativeFiles) {
  const sourceFiles = [...new Set(relativeFiles)].sort();
  if (sourceFiles.length !== relativeFiles.length) {
    throw new Error('评测源码依赖清单包含重复路径');
  }
  const sources = sourceFiles.map((relativeFile) => {
    const file = path.resolve(moduleDirectory, relativeFile);
    const bytes = fs.readFileSync(file);
    return {
      file: `js/${relativeFile}`,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  });
  const hash = createHash('sha256');
  for (const source of sources) {
    hash.update(source.file);
    hash.update('\0');
    hash.update(source.sha256);
    hash.update('\0');
  }
  return {
    schema: 'guandan-evaluation-implementation-v2',
    sha256: hash.digest('hex'),
    sources,
  };
}

function policyVariantName(value, fallback) {
  const name = String(value || fallback).trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(AI_POLICY_VARIANTS, name)) {
    throw new Error(
      `未知策略“${name}”；可选：${Object.keys(AI_POLICY_VARIANTS).join('、')}`,
    );
  }
  return name;
}

function parseEvaluationLevels(args) {
  const flag = args.find((item) => String(item).startsWith('--levels='));
  const raw = flag ? String(flag).slice('--levels='.length).trim() : 'all';
  if (!raw || raw.toLowerCase() === 'all') {
    return Array.from({ length: 13 }, (_, index) => index + 2);
  }
  const rank = (token) => {
    const normalized = String(token).trim().toUpperCase();
    if (normalized === 'A') return 14;
    if (normalized === 'K') return 13;
    if (normalized === 'Q') return 12;
    if (normalized === 'J') return 11;
    const value = Number(normalized);
    return Number.isInteger(value) && value >= 2 && value <= 14 ? value : null;
  };
  const levels = [...new Set(raw.split(',').map(rank).filter(Number.isInteger))];
  if (!levels.length) throw new Error(`无有效评测级牌：${raw}`);
  return levels;
}

function forceEvaluationLevel(state, level) {
  state.currentLevel = level;
  state.levels = [level, level];
  state.levelOwner = 0;
  state.hands = state.hands.map((hand) => sortHand(hand, level));
  state.handCounts = state.hands.map((hand) => hand.length);
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

function publicCard(card) {
  return {
    id: String(card.id),
    rank: card.rank,
    suit: card.suit,
    deckIndex: card.deckIndex,
  };
}

/** 仅返回牌桌上所有玩家都能看到的行动，不带评价、理由、暗牌或初始牌面。 */
function publicActionHistory(state) {
  return state.trickLog.map((item) => ({
    turn: item.turn,
    trickNumber: item.trickNumber,
    seat: item.seat,
    action: item.action,
    cards: item.action === 'play' ? (item.cards || []).map(publicCard) : [],
    hand: item.action === 'play' && item.hand ? {
      type: item.hand.type,
      mainRank: item.hand.mainRank,
      size: item.hand.size,
      power: item.hand.power,
    } : null,
    countsBefore: Array.isArray(item.countsBefore) ? item.countsBefore.slice(0, 4) : [],
    countsAfter: Array.isArray(item.countsAfter) ? item.countsAfter.slice(0, 4) : [],
  }));
}

function publicTributeContext(state, seat) {
  const ts = state.tributeState;
  if (!ts) return null;
  const gave = (ts.tributes || []).find((item) => item.from === seat) || null;
  const received = (ts.returns || []).find((item) => item.to === seat) || null;
  const face = (card) => (card
    ? { rank: card.rank, suit: card.suit, deckIndex: card.deckIndex }
    : null);
  const knownTransfers = [
    ...(ts.tributes || []).map((item) => ({
      kind: 'tribute', from: item.from, to: item.to, card: face(item.card),
    })),
    ...(ts.returns || []).map((item) => ({
      kind: 'return', from: item.from, to: item.to, card: face(item.card),
    })),
  ].filter((item) => item.card);
  if (!gave && !received && !knownTransfers.length) return null;
  return {
    gaveCard: face(gave?.card),
    gaveTo: gave?.to ?? null,
    receivedReturnCard: face(received?.card),
    receivedFrom: received?.from ?? null,
    firstLeadAfterTribute: state.firstPlayer === seat && state.trickLog.length === 0,
    doubleDown: !!ts.doubleDown,
    knownTransfers,
  };
}

function isBombish(hand) {
  return !!hand && ['bomb', 'flush_straight', 'joker_bomb'].includes(hand.type);
}

function leadAfterOwnBomb(state, seat) {
  if (state.lastHand || state.currentTrickStartIndex <= 0) return false;
  for (let i = Math.min(state.currentTrickStartIndex, state.trickLog.length) - 1; i >= 0; i--) {
    const item = state.trickLog[i];
    if (item.action !== 'play') continue;
    return item.seat === seat && isBombish(item.hand);
  }
  return false;
}

/** AI 的白名单视图：只有自己的手牌和公开牌桌信息。 */
function decisionView(run, seat, variant = run.variantBySeat[seat]) {
  const state = run.state;
  return {
    seat,
    hand: state.hands[seat].map(publicCard),
    level: state.currentLevel,
    lastHand: state.lastHand ? { ...state.lastHand } : null,
    lastSeat: state.lastSeat,
    handCounts: state.handCounts.slice(0, 4),
    teams: TEAM_OF.slice(0, 4),
    finishOrder: state.finishOrder.slice(0, 4),
    playedCards: state.trickLog.flatMap((item) => (
      item.action === 'play' ? (item.cards || []).map(publicCard) : []
    )),
    publicHistory: publicActionHistory(state),
    tributeContext: publicTributeContext(state, seat),
    leadAfterOwnBomb: leadAfterOwnBomb(state, seat),
    difficulty: 'master',
    deterministic: true,
    policyProfile: variant.policyProfile,
    policyFeatures: variant.policyFeatures,
    policyThresholds: variant.policyThresholds,
    opponentModelMode: EVALUATION_OPPONENT_MODEL_MODE,
    decisionEngine: variant.decisionEngine,
  };
}

function decisionKey(decision) {
  if (!decision || decision.action === 'pass') return 'pass';
  const cards = (decision.cards || []).map((card) => String(card.id)).sort().join(',');
  return `play:${cards}|${decision.signature || handSignature(decision.hand)}`;
}

function compactDecision(decision) {
  if (!decision) return { action: 'pass' };
  const compact = {
    action: decision.action === 'pass' ? 'pass' : 'play',
    ...(decision.hybrid ? {
      hybrid: {
        applied: decision.hybrid.applied === true,
        reason: decision.hybrid.reason || null,
        localCandidateId: decision.hybrid.localCandidateId || null,
        finalCandidateId: decision.hybrid.finalCandidateId || null,
        changedDecision: decision.hybrid.changedDecision === true,
        searchMode: decision.hybrid.searchMode || null,
        iterations: Number(decision.hybrid.iterations) || 0,
        samples: Number(decision.hybrid.samples) || 0,
        nodes: Number(decision.hybrid.nodes) || 0,
        candidates: Array.isArray(decision.hybrid.candidates)
          ? decision.hybrid.candidates.slice(0, 3) : [],
      },
    } : {}),
  };
  if (decision.action === 'pass') return compact;
  return {
    ...compact,
    cards: (decision.cards || []).map((card) => String(card.id)).sort(),
    hand: decision.hand ? {
      type: decision.hand.type,
      mainRank: decision.hand.mainRank,
      size: decision.hand.size,
      power: decision.hand.power,
    } : null,
    signature: decision.signature || handSignature(decision.hand),
  };
}

function createHybridCounters() {
  return {
    turns: 0,
    applied: 0,
    changed: 0,
    samples: 0,
    nodes: 0,
    iterations: 0,
    forceExpert: 0,
    wouldChange: 0,
    searchModes: {},
    reasons: {},
    rejected: {},
  };
}

function recordHybridDecision(run, decision, context = null) {
  const hybrid = decision?.hybrid;
  if (!hybrid || !run?.hybrid) return;
  run.hybrid.turns += 1;
  run.hybrid.applied += Number(hybrid.applied === true);
  run.hybrid.changed += Number(hybrid.changedDecision === true);
  run.hybrid.samples += Number(hybrid.samples) || 0;
  run.hybrid.nodes += Number(hybrid.nodes) || 0;
  run.hybrid.iterations += Number(hybrid.iterations) || 0;
  run.hybrid.forceExpert += Number(hybrid.applied === true && hybrid.forceExpertChoice === true);
  run.hybrid.wouldChange += Number(hybrid.applied === true && hybrid.wouldChangeDecision === true);
  if (hybridTurnLogPath && hybrid.applied === true) {
    // 遥测日志绝不能反过来判负对局：云同步目录上的瞬时写锁曾导致
    // "unknown error, write" 把一局标记为失败。写失败只计数，不进游戏结果。
    try {
      fs.appendFileSync(hybridTurnLogPath, `${JSON.stringify({
        seed: run.seed,
        level: run.level,
        candidateTeam: run.candidateTeam,
        turn: run.hybrid.turns,
        localCandidateId: hybrid.localCandidateId || null,
        proposedCandidateId: hybrid.proposedCandidateId || null,
        finalCandidateId: hybrid.finalCandidateId || null,
        changedDecision: hybrid.changedDecision === true,
        forceExpertChoice: hybrid.forceExpertChoice === true,
        wouldChangeDecision: hybrid.wouldChangeDecision === true,
        confidenceGap: Number.isFinite(hybrid.rerankGate?.confidenceGap)
          ? hybrid.rerankGate.confidenceGap : null,
      })}\n`);
    } catch {
      run.hybrid.turnLogWriteFailures = (run.hybrid.turnLogWriteFailures || 0) + 1;
    }
  }
  if (hybridScenarioLogPath && hybrid.wouldChangeDecision === true) {
    // 与 turn-log 同理：盲评场景写失败只计数，绝不影响对局结果。
    try {
      const view = context && typeof context === 'object' ? context : {};
      const observation = { ...view };
      // 策略内部开关与渲染无关，剔除以控制场景文件体积。
      delete observation.policyFeatures;
      delete observation.policyThresholds;
      delete observation.policyProfile;
      delete observation.decisionEngine;
      fs.appendFileSync(hybridScenarioLogPath, `${JSON.stringify({
        schema: 'guandan-blind-scenario-v1',
        evaluationImplementationSha256: evaluationImplementation.sha256,
        seed: run.seed,
        level: run.level,
        candidateTeam: run.candidateTeam,
        turn: run.hybrid.turns,
        confidenceGap: Number.isFinite(hybrid.rerankGate?.confidenceGap)
          ? hybrid.rerankGate.confidenceGap : null,
        observation,
        divergence: hybrid.divergence || null,
      })}\n`);
    } catch {
      run.hybrid.scenarioLogWriteFailures = (run.hybrid.scenarioLogWriteFailures || 0) + 1;
    }
  }
  const searchMode = String(hybrid.searchMode || 'none');
  run.hybrid.searchModes[searchMode] = (run.hybrid.searchModes[searchMode] || 0) + 1;
  const reason = String(hybrid.reason || 'unknown');
  run.hybrid.reasons[reason] = (run.hybrid.reasons[reason] || 0) + 1;
  const rejectionEntries = hybrid.rejectionSummary
    ? Object.entries(hybrid.rejectionSummary)
    : (hybrid.rejectedCandidates || []).map((item) => [item?.reason || 'unknown', 1]);
  for (const [key, count] of rejectionEntries) {
    const rejectedReason = String(key || 'unknown');
    run.hybrid.rejected[rejectedReason] = (run.hybrid.rejected[rejectedReason] || 0)
      + (Number(count) || 0);
  }
}

/** 在完全相同的本家牌与公开信息上做影子策略比较，不执行影子动作。 */
function traceFirstDivergence(run, seat, baseContext = null, actualDecision = null) {
  if (!traceDivergence || run.firstDivergence) return;
  const publicContext = baseContext || decisionView(run, seat);
  const candidateDecision = chooseAIPlay({
    ...publicContext,
    deterministic: true,
    timeBudgetMs: 0,
    policyProfile: CANDIDATE.policyProfile,
    policyFeatures: CANDIDATE.policyFeatures,
    policyThresholds: CANDIDATE.policyThresholds,
    decisionEngine: CANDIDATE.decisionEngine,
  });
  const comparisonDecision = chooseAIPlay({
    ...publicContext,
    deterministic: true,
    timeBudgetMs: 0,
    policyProfile: COMPARISON.policyProfile,
    policyFeatures: COMPARISON.policyFeatures,
    policyThresholds: COMPARISON.policyThresholds,
    decisionEngine: COMPARISON.decisionEngine,
  });
  const actualVariant = run.variantBySeat[seat];
  const expectedDecision = actualVariant === CANDIDATE ? candidateDecision : comparisonDecision;
  const actualMatchesExpected = actualDecision == null
    || decisionKey(actualDecision) === decisionKey(expectedDecision);
  // 评测路径、影子路径和强制专家路径必须落到同一对象级动作。此前仅比较
  // candidate 与 comparison，会漏掉“实际执行动作与重新求得的候选不同、但
  // 两个影子策略恰好相同”的状态污染/序列化问题。
  if (actualMatchesExpected && decisionKey(candidateDecision) === decisionKey(comparisonDecision)) return;
  run.firstDivergence = {
    kind: actualMatchesExpected ? 'candidate_vs_comparison' : 'actual_vs_expected',
    round: run.state.round,
    turn: run.state.trickLog.length + 1,
    trickNumber: run.state.trickNumber,
    seat,
    level: run.state.currentLevel,
    lastHand: publicContext.lastHand ? {
      type: publicContext.lastHand.type,
      mainRank: publicContext.lastHand.mainRank,
      size: publicContext.lastHand.size,
      power: publicContext.lastHand.power,
    } : null,
    lastSeat: publicContext.lastSeat,
    handCounts: publicContext.handCounts.slice(0, 4),
    publicActions: publicContext.publicHistory.length,
    actualPolicy: actualVariant.name,
    actual: compactDecision(actualDecision),
    expected: compactDecision(expectedDecision),
    candidate: compactDecision(candidateDecision),
    comparison: compactDecision(comparisonDecision),
  };
}

function playSeatZero(run) {
  const state = run.state;
  const view = decisionView(run, 0);
  const decisionStartedAt = performance.now();
  const decision = chooseAIPlay(view);
  recordHybridDecision(run, decision, view);
  traceFirstDivergence(run, 0, view, decision);
  if (!decision) throw new Error('chooseAIPlay 在领出时没有返回出牌');
  if (decision.action === 'pass') {
    if (!state.lastHand) throw new Error('chooseAIPlay 在领出时错误地选择过牌');
    const result = humanPass(state);
    if (!result?.ok) throw new Error(result?.reason || '0号位过牌失败');
    attachSeatZeroDecisionTelemetry(state, decision, decisionStartedAt);
    return;
  }
  humanSelectSet(
    state,
    decision.cards.map((card) => card.id),
    decision.signature || handSignature(decision.hand),
    null,
  );
  const result = humanPlay(state);
  if (!result?.ok) throw new Error(result?.reason || '0号位出牌失败');
  attachSeatZeroDecisionTelemetry(state, decision, decisionStartedAt);
}

// Seat 0 uses the synchronous human-entry path so it can share the exact game
// state machine with the browser.  Attach telemetry after that path records
// its action, preserving its human evaluation fields rather than replacing
// them.  This makes latency coverage symmetric with worker seats 1–3.
function attachSeatZeroDecisionTelemetry(state, decision, decisionStartedAt) {
  const item = state.trickLog[state.trickLog.length - 1];
  if (!item || item.seat !== 0) throw new Error('0号位决策后未找到对应逐手记录');
  const existing = item.decisionMeta || {};
  item.decisionMeta = {
    ...existing,
    reason: decision?.reason || existing.reason || '',
    hybrid: decision?.hybrid || existing.hybrid || null,
    localDecision: {
      budgetMs: 0,
      latencyMs: performance.now() - decisionStartedAt,
      source: 'synchronous_simulation',
    },
    ...decisionSearchTelemetry(decision),
    fallbackKind: decisionFallbackKind(decision),
  };
}

function decisionSearchTelemetry(decision) {
  const hybrid = decision?.hybrid;
  if (hybrid == null) return { searchAttempted: false, searchTriggered: false };
  if (typeof hybrid !== 'object'
    || typeof hybrid.searchAttempted !== 'boolean'
    || typeof hybrid.searchTriggered !== 'boolean') {
    return { searchAttempted: null, searchTriggered: null };
  }
  return {
    searchAttempted: hybrid.searchAttempted,
    searchTriggered: hybrid.searchTriggered,
  };
}

function decisionFallbackKind(decision) {
  const fallbackKind = decision?.hybrid?.fallbackKind;
  return typeof fallbackKind === 'string' && fallbackKind ? fallbackKind : 'none';
}

function handleReturn(state) {
  const task = state.tributeState?.pendingReturns?.[0];
  if (!task || task.from !== 0) return;
  const candidates = getReturnCandidates(state);
  if (!candidates.length) throw new Error('0号位没有可用还贡牌');
  const preferred = chooseReturnCard(state.hands[0].slice(), state.currentLevel, {
    toPartner: TEAM_OF[task.from] === TEAM_OF[task.to],
  });
  const card = candidates.find((item) => item.id === preferred?.id) || candidates[0];
  const pick = humanPickReturnCard(state, card.id);
  if (!pick?.ok) throw new Error(pick?.reason || '0号位选择还贡牌失败');
  const confirm = humanConfirmReturn(state);
  if (!confirm?.ok) throw new Error(confirm?.reason || '0号位确认还贡失败');
}

function dealFingerprint(state) {
  const hands = state.roundInitialHands || state.hands;
  return hands.map((hand) => hand.map((card) => (
    `${card.rank}:${card.suit}:${card.deckIndex}`
  )).sort().join(',')).join('|');
}

function fallbackCount(state) {
  return state.trickLog.filter((item) => (
    item.action === 'play'
    && item.decisionMeta?.fallbackKind === 'forced_lead'
  )).length;
}

function recordCompletedRound(run) {
  const state = run.state;
  if (run.lastRecordedRound === state.round) return;
  const order = state.finishOrder.slice();
  if (order.length !== 4 || new Set(order).size !== 4) return;
  const headTeam = TEAM_OF[order[0]];
  const upgrade = describeUpgrade(order, (seat) => TEAM_OF[seat]).levels;
  const aAttempt = state.currentLevel === 14;
  const aPassed = aAttempt && state.phase === PHASE.MATCH_END;
  const aFailed = aAttempt && !aPassed;
  run.totalActions += state.trickLog.length;
  run.totalFallbacks += fallbackCount(state);
  // 连续赛会在每副结束后清空 trickLog；必须在此处累计，不能只在整场
  // 结束时读取最后一副，否则性能报告会悄悄丢失前面各副的决策记录。
  run.decisionTelemetry.push(...collectDecisionTelemetry(state, run.variantBySeat));
  run.roundResults.push({
    round: state.round,
    level: state.currentLevel,
    levelsAfter: state.levels.slice(0, 2),
    levelOwner: state.levelOwner,
    order,
    upgrade,
    candidateUtility: headTeam === run.candidateTeam ? upgrade : -upgrade,
    aFailCount: state.aFailCount.slice(0, 2),
    aAttempt,
    aPassed,
    aFailed,
    aReset: aFailed && state.aFailCount[state.levelOwner] === 0,
    tribute: !!state.tributeState,
    actions: state.trickLog.length,
  });
  environmentTelemetryByRunSegmentId
    .get(activeRunSegment?.runSegmentId)?.sample('round');
  run.lastRecordedRound = state.round;
}

function finishRun(run, result) {
  if (activeRun !== run || run.done) return;
  run.done = true;
  realClearTimeout(run.timeoutId);
  activeRun = null;
  run.resolve(result);
}

function successfulResult(run) {
  const { state, candidateTeam } = run;
  const order = state.finishOrder.slice();
  if (order.length !== 4 || new Set(order).size !== 4) {
    return {
      ok: false,
      deadlock: false,
      reason: `终局名次无效：${order.join('-')}`,
      durationMs: performance.now() - run.startedAt,
    };
  }
  recordCompletedRound(run);
  const fallbacks = run.totalFallbacks;
  if (fallbacks > 0) {
    return {
      ok: false,
      deadlock: false,
      reason: `出现 ${fallbacks} 次非 chooseAIPlay 兜底出牌`,
      durationMs: performance.now() - run.startedAt,
    };
  }
  const headTeam = TEAM_OF[order[0]];
  const upgrade = describeUpgrade(order, (seat) => TEAM_OF[seat]).levels;
  const doubleUp = TEAM_OF[order[0]] === TEAM_OF[order[1]];
  if (continuousMatch) {
    if (state.phase !== PHASE.MATCH_END || ![0, 1].includes(state.winner)) {
      return {
        ok: false,
        deadlock: false,
        reason: '连续比赛未产生合法胜方',
        durationMs: performance.now() - run.startedAt,
      };
    }
    const candidateWon = state.winner === candidateTeam;
    return {
      ok: true,
      seed: run.seed,
      level: run.level,
      candidateTeam,
      order,
      firstPlayer: run.firstPlayer,
      dealFingerprint: run.dealFingerprint,
      upgrade: 1,
      utility: candidateWon ? 1 : -1,
      candidateHead: candidateWon,
      comparisonHead: !candidateWon,
      baselineHead: !candidateWon,
      candidateDoubleUp: false,
      comparisonDoubleUp: false,
      baselineDoubleUp: false,
      matchWinner: state.winner,
      rounds: run.roundResults.length,
      roundUpgradeUtility: run.roundResults.reduce(
        (sum, item) => sum + item.candidateUtility, 0,
      ),
      roundResults: run.roundResults,
      firstDivergence: run.firstDivergence,
      hybrid: run.hybrid,
      decisionTelemetry: run.decisionTelemetry.slice(),
      actions: run.totalActions,
      durationMs: performance.now() - run.startedAt,
    };
  }
  return {
    ok: true,
    seed: run.seed,
    level: run.level,
    candidateTeam,
    order,
    firstPlayer: run.firstPlayer,
    dealFingerprint: run.dealFingerprint,
    upgrade,
    utility: headTeam === candidateTeam ? upgrade : -upgrade,
    candidateHead: headTeam === candidateTeam,
    comparisonHead: headTeam !== candidateTeam,
    baselineHead: headTeam !== candidateTeam,
    candidateDoubleUp: doubleUp && headTeam === candidateTeam,
    comparisonDoubleUp: doubleUp && headTeam !== candidateTeam,
    baselineDoubleUp: doubleUp && headTeam !== candidateTeam,
    firstDivergence: run.firstDivergence,
    hybrid: run.hybrid,
    decisionTelemetry: run.decisionTelemetry.slice(),
    actions: run.totalActions,
    durationMs: performance.now() - run.startedAt,
  };
}

function pump() {
  if (processing || !activeRun) return;
  processing = true;
  queueMicrotask(() => {
    const run = activeRun;
    try {
      if (!run) return;
      const state = run.state;
      if (run.totalActions + state.trickLog.length > MAX_ACTIONS) {
        finishRun(run, {
          ok: false,
          deadlock: true,
          reason: `行动数超过 ${MAX_ACTIONS}`,
          durationMs: performance.now() - run.startedAt,
        });
      } else if (state.phase === PHASE.RETURN) {
        handleReturn(state);
      } else if (state.phase === PHASE.PLAYING
        && state.currentSeat === 0
        && !state.finishOrder.includes(0)) {
        playSeatZero(run);
      } else if (state.phase === PHASE.ROUND_END && continuousMatch) {
        recordCompletedRound(run);
        if (run.roundResults.length >= MAX_MATCH_ROUNDS) {
          finishRun(run, {
            ok: false,
            deadlock: true,
            reason: `连续比赛超过 ${MAX_MATCH_ROUNDS} 副仍未结束`,
            durationMs: performance.now() - run.startedAt,
          });
        } else {
          nextRound(state);
        }
      } else if (state.phase === PHASE.ROUND_END || state.phase === PHASE.MATCH_END) {
        finishRun(run, successfulResult(run));
      }
    } catch (error) {
      finishRun(run, {
        ok: false,
        deadlock: false,
        reason: error instanceof Error ? error.message : String(error),
        durationMs: performance.now() - run.startedAt,
      });
    } finally {
      processing = false;
      if (activeRun) pump();
    }
  });
}

setUpdateCallback(pump);
setAIDecisionObserver(({ seat, context, decision }) => {
  if (activeRun) {
    recordHybridDecision(activeRun, decision, context);
    traceFirstDivergence(activeRun, seat, context, decision);
  }
});
const heartbeat = globalThis.setInterval(pump, 5);

async function playGame({ seed, candidateTeam, level }) {
  Math.random = seededRandom(seed);
  const variantBySeat = TEAM_OF.map((team) => (
    team === candidateTeam ? CANDIDATE : COMPARISON
  ));
  const state = createMatch({
    difficulty: 'master',
    aiSpeed: 'fast',
    coachMode: false,
    deterministicAI: true,
    aiDifficultyBySeat: ['master', 'master', 'master', 'master'],
    aiPolicyBySeat: variantBySeat.map((variant) => variant.policyProfile),
    aiPolicyFeaturesBySeat: variantBySeat.map((variant) => ({ ...variant.policyFeatures })),
    aiPolicyThresholdsBySeat: variantBySeat.map((variant) => (
      variant.policyThresholds ? { ...variant.policyThresholds } : null
    )),
    aiDecisionEngineBySeat: variantBySeat.map((variant) => variant.decisionEngine),
    opponentModelMode: EVALUATION_OPPONENT_MODEL_MODE,
  });

  return new Promise((resolve) => {
    const run = {
      state,
      seed,
      level,
      candidateTeam,
      variantBySeat,
      resolve,
      done: false,
      startedAt: performance.now(),
      timeoutId: null,
      firstPlayer: null,
      dealFingerprint: null,
      firstDivergence: null,
      roundResults: [],
      lastRecordedRound: 0,
      totalActions: 0,
      totalFallbacks: 0,
      decisionTelemetry: [],
      hybrid: createHybridCounters(),
    };
    activeRun = run;
    run.timeoutId = realSetTimeout(() => {
      finishRun(run, {
        ok: false,
        deadlock: true,
        reason: `超过 ${GAME_TIMEOUT_MS / 1000} 秒未结束`,
        durationMs: performance.now() - run.startedAt,
      });
    }, continuousMatch ? GAME_TIMEOUT_MS * 3 : GAME_TIMEOUT_MS);
    try {
      startMatch(state);
      // startMatch 的正式首局固定打2；评测在首个自动出牌微任务执行前切换级牌，
      // 同一组镜像仍保留完全相同的牌面与先手，且不需要读取任何暗牌。
      forceEvaluationLevel(state, level);
      run.firstPlayer = state.firstPlayer;
      run.dealFingerprint = dealFingerprint(state);
      pump();
    } catch (error) {
      finishRun(run, {
        ok: false,
        deadlock: false,
        reason: error instanceof Error ? error.message : String(error),
        durationMs: performance.now() - run.startedAt,
      });
    }
  });
}

function attachGameCoordinates(result, expected) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('评测对局未返回可校验的结果对象');
  }
  for (const [field, value] of Object.entries(expected)) {
    if (Object.prototype.hasOwnProperty.call(result, field) && result[field] !== value) {
      throw new Error(`评测对局返回的 ${field} 与预登记坐标不一致`);
    }
  }
  // 失败路径过去只记录 reason/duration，导致 checkpoint 无法证明其属于哪条
  // 镜像腿。无论成功或失败都写入不可变的坐标，供恢复时精确验证。
  return { ...result, ...expected };
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

function wilsonInterval(successes, total, z = 1.959963984540054) {
  if (!total) return null;
  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denominator;
  const radius = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total) / denominator;
  return [Math.max(0, center - radius), Math.min(1, center + radius)];
}

function bootstrapMeanCI(values, seed, iterations = 5000) {
  if (!values.length) return null;
  const rng = seededRandom(seed ^ 0xA5A5A5A5);
  const samples = [];
  for (let n = 0; n < iterations; n++) {
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[Math.floor(rng() * values.length)];
    }
    samples.push(sum / values.length);
  }
  samples.sort((a, b) => a - b);
  return [
    samples[Math.floor(iterations * 0.025)],
    samples[Math.min(iterations - 1, Math.floor(iterations * 0.975))],
  ];
}

function rounded(value, digits = 3) {
  return value == null ? null : Number(value.toFixed(digits));
}

function roundedPair(values, digits = 3) {
  return values ? values.map((value) => rounded(value, digits)) : null;
}

const games = [];
const pairs = [];
const failures = [];
const startedAt = performance.now();
const plannedPairs = groupCount * (levelBlockDesign ? evaluationLevels.length : 1);
const checkpointSignaturePayload = {
  groupCount, baseSeed, candidate: CANDIDATE.name, comparison: COMPARISON.name,
  evaluationLevels, levelBlockDesign, continuousMatch,
  evaluationOpponentModelMode: EVALUATION_OPPONENT_MODEL_MODE,
  valueModelSha256: valueModelAudit?.sha256 || null,
  evaluationImplementationSha256: evaluationImplementation.sha256,
  hybridEngineVersion: HYBRID_ENGINE_VERSION,
  candidateSearchConfig,
};
const checkpointSignature = JSON.stringify(checkpointSignaturePayload);
const checkpointBackupPath = checkpointPath ? `${checkpointPath}.last-valid` : null;
let resumeBlockIndex = 0;
let evaluationId = randomUUID();
const runSegments = [];
// PERF-2 telemetry is kept outside the checkpoint's strict v3 provenance
// fields.  The sidecar is bound to the checkpoint bytes and keyed by the
// immutable runSegmentId, so resume can carry earlier fresh-segment samples
// without widening the checkpoint contract.
const environmentTelemetryByRunSegmentId = new Map();
let environmentTelemetrySidecarError = null;
let activeRunSegment = null;
let resumeInputCheckpointSha256 = null;
let resumeLoadTiming = null;

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

function checkpointContentSha256(checkpoint) {
  return createHash('sha256')
    .update(JSON.stringify(checkpointContent(checkpoint)))
    .digest('hex');
}

function currentEvaluationProvenance() {
  const segments = structuredClone(runSegments);
  return {
    schema: EVALUATION_PROVENANCE_SCHEMA,
    evaluationId,
    runSegments: segments,
    runSegmentsSha256: sha256Canonical(segments),
  };
}

function beginRunSegment(startBlockIndex, { resume, previousRunSegmentId, inputCheckpointSha256 }) {
  if (!Number.isInteger(startBlockIndex) || startBlockIndex < 0 || startBlockIndex >= groupCount) {
    throw new Error(`无效的运行段起点：${startBlockIndex}`);
  }
  const segment = {
    schema: RUN_SEGMENT_SCHEMA,
    evaluationId,
    runSegmentId: randomUUID(),
    ordinal: runSegments.length + 1,
    resume: resume === true,
    previousRunSegmentId: previousRunSegmentId || null,
    inputCheckpointSha256: inputCheckpointSha256 || null,
    startBlockIndex,
    endBlockIndex: startBlockIndex,
    startedAt: new Date().toISOString(),
    completedAt: null,
    process: {
      pid: process.pid,
      ppid: Number.isInteger(process.ppid) ? process.ppid : null,
    },
    environment: structuredClone(evaluationEnvironment),
  };
  if (environmentTelemetryPath) {
    const collector = createEnvironmentTelemetryCollector({
      resume: resume === true,
      resumeLoad: resume === true ? resumeLoadTiming : null,
      powerStateReader: readPowerState,
    });
    collector.start();
    environmentTelemetryByRunSegmentId.set(segment.runSegmentId, collector);
  }
  runSegments.push(segment);
  activeRunSegment = segment;
  return segment;
}

function recordRunSegmentProgress(nextBlockIndex) {
  if (!activeRunSegment) return;
  if (!Number.isInteger(nextBlockIndex)
    || nextBlockIndex <= activeRunSegment.endBlockIndex || nextBlockIndex > groupCount) return;
  activeRunSegment.endBlockIndex = nextBlockIndex;
  activeRunSegment.completedAt = new Date().toISOString();
}

function environmentTelemetryForSegment(segment, { finish = false } = {}) {
  const value = environmentTelemetryByRunSegmentId.get(segment.runSegmentId);
  if (value?.finish && finish) return value.finish();
  if (value?.snapshot) return value.snapshot();
  if (value && typeof value === 'object') {
    try { return validateEnvironmentTelemetryArtifact(value, `runSegment ${segment.runSegmentId}`); } catch { /* fall through */ }
  }
  return unavailableEnvironmentTelemetry({
    resume: segment.resume,
    reason: environmentTelemetrySidecarError || 'checkpoint_sidecar_missing_or_unavailable',
  });
}

function environmentTelemetryArtifactContent() {
  let checkpointSha256 = null;
  let checkpointIntegritySha256 = null;
  let nextBlockIndex = null;
  if (checkpointPath && fs.existsSync(checkpointPath)) {
    try {
      const checkpointBytes = fs.readFileSync(checkpointPath);
      checkpointSha256 = createHash('sha256').update(checkpointBytes).digest('hex');
      const checkpoint = JSON.parse(checkpointBytes.toString('utf8'));
      checkpointIntegritySha256 = checkpoint?.checkpointIntegrity?.sha256 || null;
      nextBlockIndex = Number.isInteger(checkpoint?.nextBlockIndex)
        ? checkpoint.nextBlockIndex : null;
    } catch {
      // The primary checkpoint itself remains governed by its own validator;
      // a diagnostic sidecar must not make a valid checkpoint unrecoverable.
    }
  }
  const segments = runSegments.map((segment) => ({
    runSegmentId: segment.runSegmentId,
    ordinal: segment.ordinal,
    resume: segment.resume,
    startBlockIndex: segment.startBlockIndex,
    endBlockIndex: segment.endBlockIndex,
    telemetry: environmentTelemetryForSegment(segment),
  }));
  return {
    schema: ENVIRONMENT_TELEMETRY_SIDECAR_SCHEMA,
    diagnosticOnly: true,
    formalGateEligible: false,
    evaluationId,
    checkpointSha256,
    checkpointIntegritySha256,
    nextBlockIndex,
    segments,
  };
}

function environmentTelemetryArtifactSha256(content) {
  return sha256Canonical(content);
}

function writeEnvironmentTelemetrySidecar() {
  if (!environmentTelemetryPath) return;
  const content = environmentTelemetryArtifactContent();
  const artifact = {
    ...content,
    artifactSha256: environmentTelemetryArtifactSha256(content),
  };
  const temporaryPath = `${environmentTelemetryPath}.${process.pid}-${randomUUID()}.tmp`;
  let replaced = false;
  try {
    fs.mkdirSync(path.dirname(environmentTelemetryPath), { recursive: true });
    fs.writeFileSync(temporaryPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    const parsed = JSON.parse(fs.readFileSync(temporaryPath, 'utf8'));
    if (parsed.artifactSha256 !== environmentTelemetryArtifactSha256({
      schema: parsed.schema,
      diagnosticOnly: parsed.diagnosticOnly,
      formalGateEligible: parsed.formalGateEligible,
      evaluationId: parsed.evaluationId,
      checkpointSha256: parsed.checkpointSha256,
      checkpointIntegritySha256: parsed.checkpointIntegritySha256,
      nextBlockIndex: parsed.nextBlockIndex,
      segments: parsed.segments,
    })) throw new Error('environment telemetry sidecar 摘要复算失败');
    fs.renameSync(temporaryPath, environmentTelemetryPath);
    replaced = true;
  } catch (error) {
    environmentTelemetrySidecarError = `sidecar_write_failed:${error instanceof Error ? error.message : String(error)}`;
    const collector = activeRunSegment
      ? environmentTelemetryByRunSegmentId.get(activeRunSegment.runSegmentId) : null;
    collector?.recordError(environmentTelemetrySidecarError);
  } finally {
    if (!replaced) {
      try { if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath); } catch { /* keep evidence */ }
    }
  }
}

function loadEnvironmentTelemetrySidecar(
  expectedCheckpointSha256,
  expectedCheckpointIntegritySha256,
  expectedNextBlockIndex,
) {
  if (!environmentTelemetryPath || !fs.existsSync(environmentTelemetryPath)) return;
  let artifact;
  try {
    artifact = JSON.parse(fs.readFileSync(environmentTelemetryPath, 'utf8'));
  } catch (error) {
    environmentTelemetrySidecarError = `sidecar_parse_failed:${error instanceof Error ? error.message : String(error)}`;
    return;
  }
  if (!isRecord(artifact) || artifact.schema !== ENVIRONMENT_TELEMETRY_SIDECAR_SCHEMA
    || artifact.diagnosticOnly !== true || artifact.formalGateEligible !== false
    || artifact.evaluationId !== evaluationId
    || artifact.checkpointSha256 !== expectedCheckpointSha256
    || artifact.checkpointIntegritySha256 !== expectedCheckpointIntegritySha256
    || artifact.nextBlockIndex !== expectedNextBlockIndex
    || !isSha256(artifact.artifactSha256) || !Array.isArray(artifact.segments)
    || artifact.artifactSha256 !== environmentTelemetryArtifactSha256({
      schema: artifact.schema,
      diagnosticOnly: artifact.diagnosticOnly,
      formalGateEligible: artifact.formalGateEligible,
      evaluationId: artifact.evaluationId,
      checkpointSha256: artifact.checkpointSha256,
      checkpointIntegritySha256: artifact.checkpointIntegritySha256,
      nextBlockIndex: artifact.nextBlockIndex,
      segments: artifact.segments,
    })) {
    environmentTelemetrySidecarError = 'sidecar_checkpoint_mismatch';
    return;
  }
  const known = new Set(runSegments.map((segment) => segment.runSegmentId));
  const seen = new Set();
  const staged = [];
  for (const entry of artifact.segments) {
    if (!isRecord(entry) || !known.has(entry.runSegmentId)
      || !Number.isInteger(entry.ordinal) || !Number.isInteger(entry.startBlockIndex)
      || !Number.isInteger(entry.endBlockIndex) || typeof entry.resume !== 'boolean'
      || seen.has(entry.runSegmentId)) {
      environmentTelemetrySidecarError = 'sidecar_segment_coordinates_invalid';
      return;
    }
    seen.add(entry.runSegmentId);
    const segment = runSegments.find((item) => item.runSegmentId === entry.runSegmentId);
    if (entry.ordinal !== segment.ordinal || entry.resume !== segment.resume
      || entry.startBlockIndex !== segment.startBlockIndex
      || entry.endBlockIndex !== segment.endBlockIndex) {
      environmentTelemetrySidecarError = 'sidecar_segment_range_mismatch';
      return;
    }
    try {
      staged.push([
        entry.runSegmentId,
        validateEnvironmentTelemetryArtifact(entry.telemetry, `runSegment ${entry.runSegmentId}`),
      ]);
    } catch (error) {
      environmentTelemetrySidecarError = `sidecar_telemetry_invalid:${error instanceof Error ? error.message : String(error)}`;
      return;
    }
  }
  if (seen.size !== runSegments.length) {
    environmentTelemetrySidecarError = 'sidecar_segment_missing';
    return;
  }
  // Treat sidecar recovery as a transaction: no segment is visible until all
  // coordinates and telemetry payloads have passed validation.  A malformed
  // later entry therefore cannot leave an earlier segment looking measured.
  for (const [runSegmentId, telemetry] of staged) {
    environmentTelemetryByRunSegmentId.set(runSegmentId, telemetry);
  }
}

function checkpointPairKey(seed, level) {
  return `${seed}/${level}`;
}

function checkpointGameKey(seed, level, candidateTeam) {
  return `${seed}/${level}/${candidateTeam}`;
}

function checkpointFailureKey(failure) {
  return `${failure.block}/${failure.leg === 'cross-level-block' ? '*' : failure.level}/${failure.leg}`;
}

function checkpointInvalid(reason) {
  return new Error(`检查点内容无效：${reason}`);
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sameJsonValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameStableJson(left, right) {
  try {
    return stableJson(left) === stableJson(right);
  } catch {
    return false;
  }
}

function isIsoTimestamp(value) {
  return typeof value === 'string' && value.length >= 20 && Number.isFinite(Date.parse(value));
}

function assertExactFields(record, fields, label) {
  if (!isRecord(record) || Object.keys(record).length !== fields.length
    || fields.some((field) => !Object.prototype.hasOwnProperty.call(record, field))) {
    throw checkpointInvalid(`${label} 字段不完整或包含未声明字段`);
  }
}

function validateEvaluationEnvironment(environment, label) {
  assertExactFields(environment, [
    'schema', 'machine', 'runtime', 'environmentSha256',
  ], label);
  assertExactFields(environment.machine, [
    'hostnameSha256', 'platform', 'release', 'arch', 'cpuModel', 'logicalCores', 'memoryBytes',
  ], `${label}.machine`);
  assertExactFields(environment.runtime, ['node', 'v8'], `${label}.runtime`);
  if (!environmentHashMatches(environment)
    || !isSha256(environment.machine.hostnameSha256)
    || typeof environment.machine.platform !== 'string' || !environment.machine.platform
    || typeof environment.machine.release !== 'string' || !environment.machine.release
    || typeof environment.machine.arch !== 'string' || !environment.machine.arch
    || !(typeof environment.machine.cpuModel === 'string' && environment.machine.cpuModel)
    || !Number.isInteger(environment.machine.logicalCores) || environment.machine.logicalCores < 1
    || !Number.isInteger(environment.machine.memoryBytes) || environment.machine.memoryBytes < 1
    || typeof environment.runtime.node !== 'string' || !environment.runtime.node
    || typeof environment.runtime.v8 !== 'string' || !environment.runtime.v8) {
    throw checkpointInvalid(`${label} 环境摘要无效`);
  }
  if (!sameStableJson(environment, evaluationEnvironment)) {
    throw new Error('检查点评测机器、Node 或运行环境与当前进程不一致');
  }
}

function validateRunSegments(provenance, nextBlockIndex) {
  assertExactFields(provenance, [
    'schema', 'evaluationId', 'runSegments', 'runSegmentsSha256',
  ], 'provenance');
  if (provenance.schema !== EVALUATION_PROVENANCE_SCHEMA || !isUuid(provenance.evaluationId)
    || !Array.isArray(provenance.runSegments) || !isSha256(provenance.runSegmentsSha256)
    || provenance.runSegmentsSha256 !== sha256Canonical(provenance.runSegments)) {
    throw checkpointInvalid('provenance schema、评测标识或运行段摘要无效');
  }
  if (provenance.runSegments.length === 0) {
    if (nextBlockIndex !== 0) throw checkpointInvalid('已完成区组缺少运行段 provenance');
    return { runSegments: [], runSegmentsById: new Map() };
  }
  const expectedFields = [
    'schema', 'evaluationId', 'runSegmentId', 'ordinal', 'resume', 'previousRunSegmentId',
    'inputCheckpointSha256', 'startBlockIndex', 'endBlockIndex', 'startedAt', 'completedAt',
    'process', 'environment',
  ];
  const runSegmentsById = new Map();
  let expectedStartBlockIndex = 0;
  let previousRunSegmentId = null;
  for (let index = 0; index < provenance.runSegments.length; index += 1) {
    const segment = provenance.runSegments[index];
    assertExactFields(segment, expectedFields, `runSegment[${index}]`);
    assertExactFields(segment.process, ['pid', 'ppid'], `runSegment[${index}].process`);
    if (segment.schema !== RUN_SEGMENT_SCHEMA || segment.evaluationId !== provenance.evaluationId
      || !isUuid(segment.runSegmentId) || runSegmentsById.has(segment.runSegmentId)
      || segment.ordinal !== index + 1 || typeof segment.resume !== 'boolean'
      || segment.resume !== (index > 0)
      || segment.previousRunSegmentId !== previousRunSegmentId
      || (index === 0
        ? segment.inputCheckpointSha256 !== null
        : !isSha256(segment.inputCheckpointSha256))
      || !Number.isInteger(segment.startBlockIndex)
      || !Number.isInteger(segment.endBlockIndex)
      || segment.startBlockIndex !== expectedStartBlockIndex
      || segment.endBlockIndex <= segment.startBlockIndex
      || segment.endBlockIndex > nextBlockIndex
      || !isIsoTimestamp(segment.startedAt) || !isIsoTimestamp(segment.completedAt)
      || !Number.isInteger(segment.process.pid) || segment.process.pid < 1
      || !(segment.process.ppid === null
        || (Number.isInteger(segment.process.ppid) && segment.process.ppid >= 0))) {
      throw checkpointInvalid(`runSegment[${index}] 链或范围无效`);
    }
    validateEvaluationEnvironment(segment.environment, `runSegment[${index}].environment`);
    runSegmentsById.set(segment.runSegmentId, segment);
    expectedStartBlockIndex = segment.endBlockIndex;
    previousRunSegmentId = segment.runSegmentId;
  }
  if (expectedStartBlockIndex !== nextBlockIndex) {
    throw checkpointInvalid('运行段范围没有精确覆盖已完成区组');
  }
  return { runSegments: provenance.runSegments, runSegmentsById };
}

function assertGameRunSegment(game, expectedPair, runSegmentsById) {
  if (!isUuid(game.runSegmentId)) {
    throw checkpointInvalid(`game ${expectedPair.key} 缺少 runSegmentId`);
  }
  const segment = runSegmentsById.get(game.runSegmentId);
  const blockIndex = expectedPair.block - 1;
  if (!segment || blockIndex < segment.startBlockIndex || blockIndex >= segment.endBlockIndex) {
    throw checkpointInvalid(`game ${expectedPair.key} 的 runSegmentId 未覆盖所属区组`);
  }
}

function assertCheckpointFields(record, expectedFields, label) {
  for (const [field, expected] of Object.entries(expectedFields)) {
    if (!Object.prototype.hasOwnProperty.call(record, field)
      || !sameJsonValue(record[field], expected)) {
      throw checkpointInvalid(`${label}.${field} 与镜像对局内容不一致`);
    }
  }
}

function expectedCheckpointPairs(nextBlockIndex) {
  const expected = [];
  let group = 0;
  for (let blockIndex = 0; blockIndex < nextBlockIndex; blockIndex++) {
    const seed = (baseSeed + blockIndex) >>> 0;
    const levels = levelBlockDesign
      ? evaluationLevels
      : [evaluationLevels[blockIndex % evaluationLevels.length]];
    for (const level of levels) {
      group += 1;
      expected.push({
        group,
        block: blockIndex + 1,
        seed,
        level,
        key: checkpointPairKey(seed, level),
      });
    }
  }
  return expected;
}

function assertGameShape(game, expected) {
  if (!isRecord(game)) throw checkpointInvalid(`game ${expected.key} 不是对象`);
  if (game.seed !== expected.seed || game.level !== expected.level
    || ![0, 1].includes(game.candidateTeam)) {
    throw checkpointInvalid(`game ${expected.key} 的 seed、level 或 candidateTeam 无效`);
  }
  if (typeof game.ok !== 'boolean') {
    throw checkpointInvalid(`game ${expected.key} 缺少 ok 布尔值`);
  }
  if (!game.ok) {
    if (typeof game.deadlock !== 'boolean' || typeof game.reason !== 'string' || !game.reason) {
      throw checkpointInvalid(`失败 game ${expected.key} 缺少可审计失败原因`);
    }
    return;
  }
  if (!Number.isFinite(game.utility)
    || typeof game.candidateHead !== 'boolean'
    || typeof game.comparisonHead !== 'boolean'
    || game.comparisonHead === game.candidateHead
    || game.baselineHead !== game.comparisonHead
    || typeof game.candidateDoubleUp !== 'boolean'
    || typeof game.comparisonDoubleUp !== 'boolean'
    || game.baselineDoubleUp !== game.comparisonDoubleUp
    || !Number.isInteger(game.firstPlayer) || game.firstPlayer < 0 || game.firstPlayer > 3
    || !Array.isArray(game.order) || game.order.length !== 4
    || new Set(game.order).size !== 4
    || typeof game.dealFingerprint !== 'string' || !game.dealFingerprint) {
    throw checkpointInvalid(`成功 game ${expected.key} 的镜像结果字段无效`);
  }
  if (game.candidateHead !== (game.utility > 0)
    || game.candidateDoubleUp && !game.candidateHead
    || game.comparisonDoubleUp && game.candidateHead) {
    throw checkpointInvalid(`成功 game ${expected.key} 的胜负结果自相矛盾`);
  }
}

function expectedFailureRecords(pairChecks, crossLevelMatchedByBlock) {
  const expected = [];
  for (const check of pairChecks) {
    const { expectedPair, even, odd, mirrorMatched } = check;
    if (!even.ok) {
      expected.push({
        group: expectedPair.group,
        block: expectedPair.block,
        seed: expectedPair.seed,
        level: expectedPair.level,
        leg: 'candidate-even',
        ...even,
      });
    }
    if (!odd.ok) {
      expected.push({
        group: expectedPair.group,
        block: expectedPair.block,
        seed: expectedPair.seed,
        level: expectedPair.level,
        leg: 'candidate-odd',
        ...odd,
      });
    }
    if (even.ok && odd.ok && !mirrorMatched) {
      expected.push({
        group: expectedPair.group,
        block: expectedPair.block,
        seed: expectedPair.seed,
        level: expectedPair.level,
        runSegmentId: even.runSegmentId,
        leg: 'mirror',
        ok: false,
        deadlock: false,
        reason: '镜像两场的初始牌面或先手不一致',
      });
    }
  }
  if (levelBlockDesign) {
    for (let block = 1; block <= Math.max(0, ...crossLevelMatchedByBlock.keys()); block++) {
      if (crossLevelMatchedByBlock.get(block)) continue;
      const first = pairChecks.find((check) => check.expectedPair.block === block)?.expectedPair;
      if (!first) continue;
      expected.push({
        group: `block-${block}`,
        block,
        seed: first.seed,
        runSegmentId: pairChecks.find((check) => check.expectedPair.block === block)?.pair.runSegmentId || null,
        leg: 'cross-level-block',
        ok: false,
        deadlock: false,
        reason: '同一基础种子跨级牌未复用完全相同的实体牌面',
      });
    }
  }
  return expected;
}

function validateCheckpoint(checkpoint) {
  if (!isRecord(checkpoint)) throw checkpointInvalid('根节点不是对象');
  const expectedTopLevelFields = new Set([
    'schema', 'signature', 'signaturePayload', 'nextBlockIndex', 'complete',
    'provenance', 'games', 'pairs', 'failures', 'checkpointIntegrity',
  ]);
  for (const field of Object.keys(checkpoint)) {
    if (!expectedTopLevelFields.has(field)) {
      throw checkpointInvalid(`包含未声明字段 ${field}`);
    }
  }
  if (checkpoint.schema !== CHECKPOINT_SCHEMA || !isRecord(checkpoint.signaturePayload)
    || typeof checkpoint.signature !== 'string') {
    throw checkpointInvalid('schema 或签名载荷无效');
  }
  if (checkpoint.signature !== JSON.stringify(checkpoint.signaturePayload)
    || checkpoint.signature !== checkpointSignature) {
    throw new Error('检查点与当前评测配置、源码指纹、搜索预算或模型哈希不一致');
  }
  if (!Number.isInteger(checkpoint.nextBlockIndex)
    || checkpoint.nextBlockIndex < 0 || checkpoint.nextBlockIndex > groupCount
    || typeof checkpoint.complete !== 'boolean'
    || checkpoint.complete !== (checkpoint.nextBlockIndex === groupCount)
    || !Array.isArray(checkpoint.games) || !Array.isArray(checkpoint.pairs)
    || !Array.isArray(checkpoint.failures)) {
    throw checkpointInvalid('nextBlockIndex、complete 或结果数组无效');
  }
  const validatedProvenance = validateRunSegments(checkpoint.provenance, checkpoint.nextBlockIndex);
  const integrity = checkpoint.checkpointIntegrity;
  if (!isRecord(integrity)
    || Object.keys(integrity).length !== 2
    || integrity.schema !== CHECKPOINT_INTEGRITY_SCHEMA
    || typeof integrity.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(integrity.sha256)
    || integrity.sha256 !== checkpointContentSha256(checkpoint)) {
    throw checkpointInvalid('内容 SHA-256 完整性回执不匹配');
  }

  const expectedPairs = expectedCheckpointPairs(checkpoint.nextBlockIndex);
  if (checkpoint.pairs.length !== expectedPairs.length
    || checkpoint.games.length !== expectedPairs.length * 2) {
    throw checkpointInvalid('已完成区组的 pair 或 game 数量不正确');
  }
  const expectedPairsByKey = new Map(expectedPairs.map((item) => [item.key, item]));
  const gamesByKey = new Map();
  for (const game of checkpoint.games) {
    if (!isRecord(game) || !Number.isInteger(game.seed) || !Number.isInteger(game.level)
      || ![0, 1].includes(game.candidateTeam)) {
      throw checkpointInvalid('game 缺少可索引的 seed、level 或 candidateTeam');
    }
    const pairKey = checkpointPairKey(game.seed, game.level);
    const expectedPair = expectedPairsByKey.get(pairKey);
    const key = checkpointGameKey(game.seed, game.level, game.candidateTeam);
    if (!expectedPair) throw checkpointInvalid(`game ${key} 不属于已完成区组`);
    if (gamesByKey.has(key)) throw checkpointInvalid(`game ${key} 重复`);
    assertGameShape(game, { ...expectedPair, key });
    assertGameRunSegment(game, expectedPair, validatedProvenance.runSegmentsById);
    gamesByKey.set(key, game);
  }
  const pairsByKey = new Map();
  for (const pair of checkpoint.pairs) {
    if (!isRecord(pair) || !Number.isInteger(pair.seed) || !Number.isInteger(pair.level)) {
      throw checkpointInvalid('pair 缺少可索引的 seed 或 level');
    }
    const key = checkpointPairKey(pair.seed, pair.level);
    if (!expectedPairsByKey.has(key)) throw checkpointInvalid(`pair ${key} 不属于已完成区组`);
    if (pairsByKey.has(key)) throw checkpointInvalid(`pair ${key} 重复`);
    pairsByKey.set(key, pair);
  }

  const pairChecks = expectedPairs.map((expectedPair) => {
    const even = gamesByKey.get(checkpointGameKey(expectedPair.seed, expectedPair.level, 0));
    const odd = gamesByKey.get(checkpointGameKey(expectedPair.seed, expectedPair.level, 1));
    const pair = pairsByKey.get(expectedPair.key);
    if (!even || !odd || !pair) {
      throw checkpointInvalid(`镜像 pair ${expectedPair.key} 缺少一条腿或 pair 对象`);
    }
    const mirrorMatched = even.ok && odd.ok
      && even.firstPlayer === odd.firstPlayer
      && even.dealFingerprint === odd.dealFingerprint;
    return { expectedPair, even, odd, pair, mirrorMatched };
  });

  const crossLevelMatchedByBlock = new Map();
  for (let block = 1; block <= checkpoint.nextBlockIndex; block++) {
    const blockChecks = pairChecks.filter((check) => check.expectedPair.block === block);
    const fingerprint = blockChecks[0]?.pair.dealFingerprint || null;
    crossLevelMatchedByBlock.set(block, !levelBlockDesign || (
      !!fingerprint && blockChecks.length === evaluationLevels.length
      && blockChecks.every((check) => check.pair.dealFingerprint === fingerprint)
    ));
  }
  for (const check of pairChecks) {
    const { expectedPair, even, odd, pair, mirrorMatched } = check;
    const crossLevelMatched = crossLevelMatchedByBlock.get(expectedPair.block);
    assertCheckpointFields(pair, {
      group: expectedPair.group,
      block: expectedPair.block,
      seed: expectedPair.seed,
      level: expectedPair.level,
      runSegmentId: even.runSegmentId,
      mirrorMatched,
      crossLevelMatched,
      dealFingerprint: even.dealFingerprint || odd.dealFingerprint || null,
      complete: even.ok && odd.ok && mirrorMatched && crossLevelMatched,
      utility: even.ok && odd.ok ? (even.utility + odd.utility) / 2 : null,
      candidateHeads: Number(!!even.candidateHead) + Number(!!odd.candidateHead),
      candidateDoubleUps: Number(!!even.candidateDoubleUp) + Number(!!odd.candidateDoubleUp),
      comparisonDoubleUps: Number(!!even.comparisonDoubleUp) + Number(!!odd.comparisonDoubleUp),
      orders: [even.order || null, odd.order || null],
      firstDivergences: [even.firstDivergence || null, odd.firstDivergence || null],
    }, `pair ${expectedPair.key}`);
  }

  const expectedFailures = expectedFailureRecords(pairChecks, crossLevelMatchedByBlock);
  if (checkpoint.failures.length !== expectedFailures.length) {
    throw checkpointInvalid('failure 数量与已记录的失败镜像腿不一致');
  }
  const failuresByKey = new Map();
  for (const failure of checkpoint.failures) {
    if (!isRecord(failure) || !Number.isInteger(failure.block)
      || typeof failure.leg !== 'string' || !failure.leg) {
      throw checkpointInvalid('failure 缺少 block 或 leg');
    }
    const key = checkpointFailureKey(failure);
    if (failuresByKey.has(key)) throw checkpointInvalid(`failure ${key} 重复`);
    failuresByKey.set(key, failure);
  }
  for (const expectedFailure of expectedFailures) {
    const key = checkpointFailureKey(expectedFailure);
    const actual = failuresByKey.get(key);
    if (!actual || !sameJsonValue(actual, expectedFailure)) {
      throw checkpointInvalid(`failure ${key} 与失败对局不一致`);
    }
  }

  return {
    games: expectedPairs.flatMap((pair) => [
      gamesByKey.get(checkpointGameKey(pair.seed, pair.level, 0)),
      gamesByKey.get(checkpointGameKey(pair.seed, pair.level, 1)),
    ]),
    pairs: expectedPairs.map((pair) => pairsByKey.get(pair.key)),
    failures: checkpoint.failures.slice(),
    provenance: checkpoint.provenance,
  };
}

function buildCheckpoint(nextBlockIndex) {
  const checkpoint = {
    schema: CHECKPOINT_SCHEMA,
    signature: checkpointSignature,
    signaturePayload: checkpointSignaturePayload,
    nextBlockIndex,
    complete: nextBlockIndex === groupCount,
    provenance: currentEvaluationProvenance(),
    games,
    pairs,
    failures,
  };
  checkpoint.checkpointIntegrity = {
    schema: CHECKPOINT_INTEGRITY_SCHEMA,
    sha256: checkpointContentSha256(checkpoint),
  };
  return checkpoint;
}

function readValidatedCheckpoint(filePath, label, timing = null) {
  let text;
  const readStartedAt = performance.now();
  try {
    text = fs.readFileSync(filePath, 'utf8');
    if (timing) {
      timing.bytes = Buffer.byteLength(text, 'utf8');
      timing.readMs = Math.max(0, performance.now() - readStartedAt);
    }
  } catch (error) {
    throw new Error(`${label} 无法读取：${error instanceof Error ? error.message : String(error)}`);
  }
  let checkpoint;
  const parseStartedAt = performance.now();
  try {
    checkpoint = JSON.parse(text);
    if (timing) timing.parseMs = Math.max(0, performance.now() - parseStartedAt);
  } catch (error) {
    throw new Error(`${label} 不是可解析 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  const validateStartedAt = performance.now();
  try {
    const result = {
      checkpoint,
      text,
      sha256: createHash('sha256').update(text).digest('hex'),
      normalized: validateCheckpoint(checkpoint),
    };
    if (timing) {
      timing.validateMs = Math.max(0, performance.now() - validateStartedAt);
      timing.totalMs = Math.max(0, performance.now() - readStartedAt);
      timing.inputCheckpointSha256 = checkpoint.checkpointIntegrity?.sha256 || null;
    }
    return result;
  } catch (error) {
    throw new Error(`${label} 校验失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function inspectCheckpoint(filePath, label) {
  if (!filePath || !fs.existsSync(filePath)) return { exists: false, value: null, error: null };
  try {
    return { exists: true, value: readValidatedCheckpoint(filePath, label), error: null };
  } catch (error) {
    return { exists: true, value: null, error };
  }
}

function checkpointTemporaryPath(targetPath, kind) {
  return `${targetPath}.${kind}-${process.pid}-${randomUUID()}.tmp`;
}

function removeOwnedTemporary(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // 进程崩溃或外部锁住临时文件时保留证据；其文件名唯一，后续恢复不会读取它。
  }
}

function stageValidatedCheckpoint(targetPath, text, kind, timing = null) {
  const temporaryPath = checkpointTemporaryPath(targetPath, kind);
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    const writeStartedAt = performance.now();
    fs.writeFileSync(descriptor, text, 'utf8');
    if (timing) timing[`${kind}WriteMs`] += Math.max(0, performance.now() - writeStartedAt);
    const fsyncStartedAt = performance.now();
    fs.fsyncSync(descriptor);
    if (timing) timing[`${kind}FsyncMs`] += Math.max(0, performance.now() - fsyncStartedAt);
    fs.closeSync(descriptor);
    descriptor = null;
    const readbackStartedAt = performance.now();
    readValidatedCheckpoint(temporaryPath, '临时 checkpoint');
    if (timing) timing[`${kind}ReadbackMs`] += Math.max(0, performance.now() - readbackStartedAt);
    return temporaryPath;
  } catch (error) {
    if (descriptor != null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // 原始写入错误比关闭错误更有诊断价值。
      }
    }
    removeOwnedTemporary(temporaryPath);
    throw new Error(`无法持久化并校验临时 checkpoint：${error instanceof Error ? error.message : String(error)}`);
  }
}

function replaceCheckpointAtomically(temporaryPath, targetPath, label, timing = null, field = 'renameMs') {
  try {
    // 临时文件和目标严格同目录。绝不采用“先删除目标再 rename”的 Windows
    // 回退；替换若因写锁失败，旧 checkpoint 必须原样保留。
    const renameStartedAt = performance.now();
    fs.renameSync(temporaryPath, targetPath);
    if (timing) timing[field] += Math.max(0, performance.now() - renameStartedAt);
  } catch (error) {
    throw new Error(`${label} 原子替换失败，旧 checkpoint 未被删除：${
      error instanceof Error ? error.message : String(error)
    }`);
  }
}

function writeBackupFromPrimary(primary, timing = null) {
  const temporaryPath = stageValidatedCheckpoint(checkpointBackupPath, primary.text, 'backup', timing);
  try {
    replaceCheckpointAtomically(
      temporaryPath,
      checkpointBackupPath,
      '最后有效 checkpoint 备份',
      timing,
      'backupRenameMs',
    );
  } catch (error) {
    removeOwnedTemporary(temporaryPath);
    throw error;
  }
}

function writeCheckpoint(nextBlockIndex) {
  if (!checkpointPath) return;
  fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });
  const timing = {
    nextBlockIndex,
    bytes: 0,
    buildMs: 0,
    serializationMs: 0,
    primaryWriteMs: 0,
    primaryFsyncMs: 0,
    primaryReadbackMs: 0,
    backupWriteMs: 0,
    backupFsyncMs: 0,
    backupReadbackMs: 0,
    backupRenameMs: 0,
    renameMs: 0,
    totalMs: 0,
  };
  const startedAt = performance.now();
  const checkpoint = buildCheckpoint(nextBlockIndex);
  validateCheckpoint(checkpoint);
  timing.buildMs = Math.max(0, performance.now() - startedAt);
  const serializationStartedAt = performance.now();
  const text = `${JSON.stringify(checkpoint)}\n`;
  timing.serializationMs = Math.max(0, performance.now() - serializationStartedAt);
  timing.bytes = Buffer.byteLength(text, 'utf8');
  const temporaryPath = stageValidatedCheckpoint(checkpointPath, text, 'primary', timing);
  let replaced = false;
  try {
    const primary = inspectCheckpoint(checkpointPath, '现有主 checkpoint');
    if (primary.exists && primary.value) {
      // 先完成上一个有效版本的可恢复备份；这一步失败时绝不触碰主文件。
      writeBackupFromPrimary(primary.value, timing);
    } else if (primary.exists) {
      const backup = inspectCheckpoint(checkpointBackupPath, '最后有效 checkpoint 备份');
      if (!backup.value) {
        throw new Error(`现有主 checkpoint 已损坏，拒绝覆盖；${
          backup.error?.message || '没有同配置的最后有效备份'
        }`);
      }
      process.stderr.write(`现有主 checkpoint 不可用，保留 ${path.basename(checkpointBackupPath)} 后再写入新版本\n`);
    }
    replaceCheckpointAtomically(temporaryPath, checkpointPath, '主 checkpoint', timing, 'renameMs');
    replaced = true;
  } finally {
    if (!replaced) removeOwnedTemporary(temporaryPath);
  }
  timing.totalMs = Math.max(0, performance.now() - startedAt);
  const collector = activeRunSegment
    ? environmentTelemetryByRunSegmentId.get(activeRunSegment.runSegmentId) : null;
  if (collector && !collector.finished) collector.recordCheckpoint(timing);
  writeEnvironmentTelemetrySidecar();
}

function loadCheckpointForResume() {
  const read = (filePath, label, source) => {
    const timing = {
      source,
      bytes: 0,
      readMs: 0,
      parseMs: 0,
      validateMs: 0,
      totalMs: 0,
      inputCheckpointSha256: null,
    };
    try {
      const value = readValidatedCheckpoint(filePath, label, timing);
      resumeLoadTiming = timing;
      return value;
    } catch {
      return null;
    }
  };
  const primary = read(checkpointPath, '主 checkpoint', 'primary');
  if (primary) return primary;
  const backup = read(checkpointBackupPath, '最后有效 checkpoint 备份', 'last-valid');
  if (backup) {
    process.stderr.write(`主 checkpoint 不可恢复，已从 ${path.basename(checkpointBackupPath)} 恢复：${
      '主文件不存在或校验失败'
    }\n`);
    return backup;
  }
  const primaryInspection = inspectCheckpoint(checkpointPath, '主 checkpoint');
  const backupInspection = inspectCheckpoint(checkpointBackupPath, '最后有效 checkpoint 备份');
  throw new Error(`--resume 找不到可恢复 checkpoint：${
    primaryInspection.error?.message || '主文件不存在'
  }；${backupInspection.error?.message || '最后有效备份不存在'}`);
}

if (resumeCheckpoint) {
  if (!checkpointPath) throw new Error('--resume 需要 --checkpoint 文件路径');
  const resumed = loadCheckpointForResume();
  games.push(...resumed.normalized.games);
  pairs.push(...resumed.normalized.pairs);
  failures.push(...resumed.normalized.failures);
  evaluationId = resumed.normalized.provenance.evaluationId;
  runSegments.push(...resumed.normalized.provenance.runSegments);
  resumeBlockIndex = resumed.checkpoint.nextBlockIndex;
  resumeInputCheckpointSha256 = resumed.checkpoint.checkpointIntegrity.sha256;
  loadEnvironmentTelemetrySidecar(
    resumed.sha256,
    resumed.checkpoint.checkpointIntegrity?.sha256 || null,
    resumed.checkpoint.nextBlockIndex,
  );
}

if (resumeBlockIndex < groupCount) {
  const previousSegment = runSegments.at(-1) || null;
  beginRunSegment(resumeBlockIndex, {
    resume: resumeCheckpoint,
    previousRunSegmentId: previousSegment?.runSegmentId || null,
    inputCheckpointSha256: resumeInputCheckpointSha256,
  });
}

try {
  let pairIndex = pairs.length;
  for (let blockIndex = resumeBlockIndex; blockIndex < groupCount; blockIndex++) {
    const seed = (baseSeed + blockIndex) >>> 0;
    const levelsForSeed = levelBlockDesign
      ? evaluationLevels
      : [evaluationLevels[blockIndex % evaluationLevels.length]];
    for (const level of levelsForSeed) {
      pairIndex += 1;
      const candidateEven = attachGameCoordinates(
        await playGame({ seed, candidateTeam: 0, level }),
        { seed, level, candidateTeam: 0, runSegmentId: activeRunSegment?.runSegmentId },
      );
      const candidateOdd = attachGameCoordinates(
        await playGame({ seed, candidateTeam: 1, level }),
        { seed, level, candidateTeam: 1, runSegmentId: activeRunSegment?.runSegmentId },
      );
      games.push(candidateEven, candidateOdd);

      for (const [leg, result] of [
        ['candidate-even', candidateEven],
        ['candidate-odd', candidateOdd],
      ]) {
        if (!result.ok) failures.push({
          group: pairIndex, block: blockIndex + 1, seed, level, leg, ...result,
        });
      }

      const mirrorMatched = candidateEven.ok
        && candidateOdd.ok
        && candidateEven.firstPlayer === candidateOdd.firstPlayer
        && candidateEven.dealFingerprint === candidateOdd.dealFingerprint;
      if (candidateEven.ok && candidateOdd.ok && !mirrorMatched) {
        failures.push({
          group: pairIndex,
          block: blockIndex + 1,
          seed,
          level,
          runSegmentId: activeRunSegment?.runSegmentId || null,
          leg: 'mirror',
          ok: false,
          deadlock: false,
          reason: '镜像两场的初始牌面或先手不一致',
        });
      }

      pairs.push({
        group: pairIndex,
        block: blockIndex + 1,
        seed,
        level,
        runSegmentId: activeRunSegment?.runSegmentId || null,
        mirrorMatched,
        crossLevelMatched: true,
        dealFingerprint: candidateEven.dealFingerprint || candidateOdd.dealFingerprint || null,
        complete: candidateEven.ok && candidateOdd.ok && mirrorMatched,
        utility: candidateEven.ok && candidateOdd.ok
          ? (candidateEven.utility + candidateOdd.utility) / 2
          : null,
        candidateHeads: Number(!!candidateEven.candidateHead)
          + Number(!!candidateOdd.candidateHead),
        candidateDoubleUps: Number(!!candidateEven.candidateDoubleUp)
          + Number(!!candidateOdd.candidateDoubleUp),
        comparisonDoubleUps: Number(!!candidateEven.comparisonDoubleUp)
          + Number(!!candidateOdd.comparisonDoubleUp),
        orders: [candidateEven.order || null, candidateOdd.order || null],
        firstDivergences: [
          candidateEven.firstDivergence || null,
          candidateOdd.firstDivergence || null,
        ],
      });
      if (!jsonOnly) {
        process.stdout.write(
          `${pairIndex}/${plannedPairs}[${level === 14 ? 'A' : level}]:${candidateEven.ok ? candidateEven.utility : 'E'}`
          + `,${candidateOdd.ok ? candidateOdd.utility : 'E'} `,
        );
      }
    }
    if (levelBlockDesign) {
      const blockPairs = pairs.filter((pair) => pair.block === blockIndex + 1);
      const fingerprint = blockPairs[0]?.dealFingerprint || null;
      const crossLevelMatched = !!fingerprint
        && blockPairs.length === evaluationLevels.length
        && blockPairs.every((pair) => pair.dealFingerprint === fingerprint);
      if (!crossLevelMatched) {
        for (const pair of blockPairs) {
          pair.crossLevelMatched = false;
          pair.complete = false;
        }
        failures.push({
          group: `block-${blockIndex + 1}`,
          block: blockIndex + 1,
          seed,
          runSegmentId: activeRunSegment?.runSegmentId || null,
          leg: 'cross-level-block',
          ok: false,
          deadlock: false,
          reason: '同一基础种子跨级牌未复用完全相同的实体牌面',
        });
      }
    }
    recordRunSegmentProgress(blockIndex + 1);
    writeCheckpoint(blockIndex + 1);
  }
} finally {
  globalThis.clearInterval(heartbeat);
  setUpdateCallback(null);
  setAIDecisionObserver(null);
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  Math.random = realRandom;
}

const completedPairs = pairs.filter((pair) => pair.complete);
// 只有镜像两腿都成功且牌面/先手一致的种子，才进入任何胜负统计。
// 单腿成功不能混入分子或分母，否则会破坏配对设计。
const gamesByCheckpointKey = new Map(games.map((game) => [
  checkpointGameKey(game.seed, game.level, game.candidateTeam), game,
]));
const completedGames = completedPairs.flatMap((pair) => (
  [0, 1].map((candidateTeam) => gamesByCheckpointKey.get(
    checkpointGameKey(pair.seed, pair.level, candidateTeam),
  )).filter(Boolean)
));
const utilities = completedGames.map((game) => game.utility);
const pairedUtilities = completedPairs.map((pair) => pair.utility);
const pairedHeadRates = completedPairs.map((pair) => pair.candidateHeads / 2);
const pairedDoubleUpDifferences = completedPairs.map((pair) => (
  (pair.candidateDoubleUps - pair.comparisonDoubleUps) / 2
));
const blocks = Array.from({ length: groupCount }, (_, blockIndex) => {
  const blockPairs = pairs.filter((pair) => pair.block === blockIndex + 1);
  const segment = runSegments.find((item) => (
    blockIndex >= item.startBlockIndex && blockIndex < item.endBlockIndex
  )) || null;
  const expected = levelBlockDesign ? evaluationLevels.length : 1;
  const complete = blockPairs.length === expected && blockPairs.every((pair) => pair.complete);
  return {
    block: blockIndex + 1,
    seed: (baseSeed + blockIndex) >>> 0,
    runSegmentId: segment?.runSegmentId || null,
    complete,
    levelPairs: blockPairs.length,
    utility: complete ? average(blockPairs.map((pair) => pair.utility)) : null,
    candidateHeadRate: complete
      ? average(blockPairs.map((pair) => pair.candidateHeads / 2)) : null,
    doubleUpDifference: complete
      ? average(blockPairs.map((pair) => (
        (pair.candidateDoubleUps - pair.comparisonDoubleUps) / 2
      ))) : null,
  };
});
const completedBlocks = blocks.filter((block) => block.complete);
// 跨级区组内的13个观测共享同一副基础牌，正式置信区间必须按 seed block
// 重采样，不能把它们错误当作13个独立样本。
const inferenceUtilities = levelBlockDesign
  ? completedBlocks.map((block) => block.utility)
  : pairedUtilities;
const inferenceHeadRates = levelBlockDesign
  ? completedBlocks.map((block) => block.candidateHeadRate)
  : pairedHeadRates;
const inferenceDoubleUpDifferences = levelBlockDesign
  ? completedBlocks.map((block) => block.doubleUpDifference)
  : pairedDoubleUpDifferences;
const candidateHeads = completedGames.filter((game) => game.candidateHead).length;
const comparisonHeads = completedGames.filter((game) => game.comparisonHead).length;
const candidateDoubleUps = completedGames.filter((game) => game.candidateDoubleUp).length;
const comparisonDoubleUps = completedGames.filter((game) => game.comparisonDoubleUp).length;
const durations = games.map((game) => game.durationMs).filter(Number.isFinite);
const actions = completedGames.map((game) => game.actions);
const decisionTelemetry = completedGames.flatMap((game) => game.decisionTelemetry || []);
const decisionPerformanceByPolicy = Object.fromEntries(
  [...new Set(decisionTelemetry.map((item) => item.policy))]
    .sort()
    .map((policy) => [
      policy,
      summarizeDecisionTelemetry(decisionTelemetry.filter((item) => item.policy === policy)),
    ]),
);
const allAIDecisions = summarizeAllAIDecisionTelemetry(decisionTelemetry);
const headRate = completedGames.length ? candidateHeads / completedGames.length : null;
const cappedHeadRate = headRate == null ? null : Math.min(0.999999, Math.max(0.000001, headRate));
const byLevel = Object.fromEntries(evaluationLevels.map((level) => {
  const levelGames = completedGames.filter((game) => game.level === level);
  const levelPairs = completedPairs.filter((pair) => pair.level === level);
  const heads = levelGames.filter((game) => game.candidateHead).length;
  const comparisonLevelHeads = levelGames.filter((game) => game.comparisonHead).length;
  const doubles = levelGames.filter((game) => game.candidateDoubleUp).length;
  const comparisonDoubles = levelGames.filter((game) => game.comparisonDoubleUp).length;
  return [String(level), {
    label: level === 14 ? 'A' : String(level),
    seedGroups: levelPairs.length,
    games: levelGames.length,
    candidateHeads: heads,
    comparisonHeads: comparisonLevelHeads,
    candidateHeadRate: rounded(levelGames.length ? heads / levelGames.length : null),
    candidateDoubleUps: doubles,
    comparisonDoubleUps: comparisonDoubles,
    candidateUtilityPerGame: rounded(average(levelGames.map((game) => game.utility))),
  }];
}));
const firstDivergences = completedGames
  .map((game) => game.firstDivergence)
  .filter(Boolean);
const divergenceBySeat = Object.fromEntries(Array.from({ length: 4 }, (_, seat) => [
  String(seat), firstDivergences.filter((item) => item.seat === seat).length,
]));
const continuousRounds = completedGames.flatMap((game) => game.roundResults || []);
function summarizeHybridGames(items) {
  return items.reduce((total, game) => {
    const gameHybrid = game.hybrid || createHybridCounters();
    total.turns += gameHybrid.turns || 0;
    total.applied += gameHybrid.applied || 0;
    total.changed += gameHybrid.changed || 0;
    total.samples += gameHybrid.samples || 0;
    total.nodes += gameHybrid.nodes || 0;
    total.iterations += gameHybrid.iterations || 0;
    total.forceExpert += gameHybrid.forceExpert || 0;
    total.wouldChange += gameHybrid.wouldChange || 0;
    for (const [key, value] of Object.entries(gameHybrid.searchModes || {})) {
      total.searchModes[key] = (total.searchModes[key] || 0) + value;
    }
    for (const [key, value] of Object.entries(gameHybrid.reasons || {})) {
      total.reasons[key] = (total.reasons[key] || 0) + value;
    }
    for (const [key, value] of Object.entries(gameHybrid.rejected || {})) {
      total.rejected[key] = (total.rejected[key] || 0) + value;
    }
    return total;
  }, createHybridCounters());
}

const hybridTotals = summarizeHybridGames(completedGames);
const finalizedEnvironmentTelemetry = environmentTelemetryPath
  ? new Map(runSegments.map((segment) => [
    segment.runSegmentId,
    environmentTelemetryForSegment(segment, { finish: true }),
  ]))
  : null;
if (environmentTelemetryPath) {
  // Persist the final segment-end sample and all checkpoint timings before the
  // report is emitted.  A missing/partial artifact remains explicit in the
  // sidecar and is never promoted to a performance pass.
  writeEnvironmentTelemetrySidecar();
}
const performanceByRunSegment = runSegments.map((segment) => {
  const segmentGames = completedGames.filter((game) => game.runSegmentId === segment.runSegmentId);
  const segmentTelemetry = segmentGames.flatMap((game) => game.decisionTelemetry || []);
  return {
    schema: PERFORMANCE_BY_RUN_SEGMENT_SCHEMA,
    runSegmentId: segment.runSegmentId,
    startBlockIndex: segment.startBlockIndex,
    endBlockIndex: segment.endBlockIndex,
    gamesCompleted: segmentGames.length,
    allAIDecisions: summarizeAllAIDecisionTelemetry(segmentTelemetry),
    decisionLatencyByPolicy: Object.fromEntries(
      [...new Set(segmentTelemetry.map((item) => item.policy))]
        .sort()
        .map((policy) => [
          policy,
          summarizeDecisionTelemetry(segmentTelemetry.filter((item) => item.policy === policy)),
        ]),
    ),
    hybrid: summarizeHybridGames(segmentGames),
    ...(environmentTelemetryPath ? {
      environmentTelemetry: finalizedEnvironmentTelemetry.get(segment.runSegmentId)
        || unavailableEnvironmentTelemetry({
          resume: segment.resume,
          reason: 'segment_telemetry_unavailable',
        }),
    } : {}),
  };
});

if (!jsonOnly) console.log('\n');
const finalReport = {
  schema: AB_REPORT_SCHEMA,
  provenance: currentEvaluationProvenance(),
  config: {
    seedGroups: plannedPairs,
    baseDealBlocks: groupCount,
    baseSeed,
    evaluationSeedManifest,
    gamesPlanned: plannedPairs * 2,
    evaluationLevels,
    evaluationDesign: levelBlockDesign ? 'same-deal-cross-level-blocks' : 'legacy-level-cycle',
    levelAssignment: levelBlockDesign
      ? 'every base deal is replayed at every evaluation level'
      : 'seed groups cycle evenly through evaluationLevels',
    continuousMatch,
    outcomeUnit: continuousMatch ? 'match win (+1/-1)' : 'round upgrade utility (+1..+3)',
    traceDivergence,
    summaryOnly,
    candidate: CANDIDATE.name,
    comparison: COMPARISON.name,
    baseline: COMPARISON.name,
    candidatePolicyProfile: CANDIDATE.policyProfile,
    comparisonPolicyProfile: COMPARISON.policyProfile,
    candidateFeatures: CANDIDATE.policyFeatures,
    comparisonFeatures: COMPARISON.policyFeatures,
    candidateThresholds: CANDIDATE.policyThresholds,
    comparisonThresholds: COMPARISON.policyThresholds,
    evaluationOpponentModelMode: EVALUATION_OPPONENT_MODEL_MODE,
    valueModel: valueModelAudit,
    evaluationImplementation,
    hybridEngineVersion: HYBRID_ENGINE_VERSION,
    candidateSearchConfig,
    difficulty: 'master',
    deterministic: true,
  },
  completion: {
    gamesCompleted: completedGames.length,
    mirrorPairsCompleted: completedPairs.length,
    baseDealBlocksCompleted: completedBlocks.length,
    mirrorMismatches: failures.filter((failure) => failure.leg === 'mirror').length,
    failures: failures.length,
    deadlocks: failures.filter((failure) => failure.deadlock).length,
  },
  result: {
    candidateUpgradeUtilityTotal: utilities.reduce((sum, value) => sum + value, 0),
    candidateUpgradeUtilityPerGame: rounded(average(utilities)),
    candidatePairedUtilityPerSeed: rounded(average(pairedUtilities)),
    candidatePairedUtilityBootstrap95: roundedPair(
      bootstrapMeanCI(inferenceUtilities, baseSeed),
    ),
    candidateBlockedUtilityPerDeal: rounded(average(inferenceUtilities)),
    candidateHeads,
    comparisonHeads,
    baselineHeads: comparisonHeads,
    candidateHeadRate: rounded(headRate),
    candidateHeadPairedBootstrap95: roundedPair(
      bootstrapMeanCI(inferenceHeadRates, baseSeed ^ 0x13579BDF),
    ),
    // 保留旧字段供现有脚本读取；配对镜像赛的正式不确定性应看上面的 bootstrap。
    candidateHeadWilson95: roundedPair(wilsonInterval(candidateHeads, completedGames.length)),
    candidateElo: cappedHeadRate == null
      ? null
      : rounded(400 * Math.log10(cappedHeadRate / (1 - cappedHeadRate)), 1),
    candidateDoubleUps,
    comparisonDoubleUps,
    baselineDoubleUps: comparisonDoubleUps,
    candidateDoubleUpDifferencePerGame: rounded(average(pairedDoubleUpDifferences)),
    candidateDoubleUpDifferencePairedBootstrap95: roundedPair(
      bootstrapMeanCI(inferenceDoubleUpDifferences, baseSeed ^ 0x2468ACE0),
    ),
  },
  byLevel,
  divergence: {
    enabled: traceDivergence,
    gamesWithFirstDivergence: firstDivergences.length,
    rate: rounded(completedGames.length
      ? firstDivergences.length / completedGames.length : null),
    bySeat: divergenceBySeat,
    samples: firstDivergences.slice(0, 40),
  },
  hybrid: {
    ...hybridTotals,
    appliedRate: rounded(hybridTotals.turns ? hybridTotals.applied / hybridTotals.turns : null),
    changedRate: rounded(hybridTotals.turns ? hybridTotals.changed / hybridTotals.turns : null),
    // 消融臂口径：wouldChange/turns 与正常臂 changedRate 直接可比。
    wouldChangeRate: rounded(hybridTotals.turns
      ? hybridTotals.wouldChange / hybridTotals.turns : null),
    averageSamplesPerTurn: rounded(hybridTotals.turns
      ? hybridTotals.samples / hybridTotals.turns : null),
    averageNodesPerAppliedTurn: rounded(hybridTotals.applied
      ? hybridTotals.nodes / hybridTotals.applied : null),
    averageIterationsPerAppliedTurn: rounded(hybridTotals.applied
      ? hybridTotals.iterations / hybridTotals.applied : null),
  },
  continuousMatch: {
    enabled: continuousMatch,
    matches: continuousMatch ? completedGames.length : 0,
    rounds: continuousRounds.length,
    averageRoundsPerMatch: rounded(continuousMatch
      ? average(completedGames.map((game) => game.rounds)) : null),
    maxRounds: continuousRounds.length
      ? Math.max(...completedGames.map((game) => game.rounds)) : null,
    tributeRounds: continuousRounds.filter((round) => round.tribute).length,
    aAttempts: continuousRounds.filter((round) => round.aAttempt).length,
    aFailures: continuousRounds.filter((round) => round.aFailed).length,
    aResets: continuousRounds.filter((round) => round.aReset).length,
    longRoundActionThreshold: LONG_ROUND_ACTIONS,
    longRounds: continuousRounds.filter((round) => round.actions >= LONG_ROUND_ACTIONS).length,
    maxRoundActions: continuousRounds.length
      ? Math.max(...continuousRounds.map((round) => round.actions)) : null,
    candidateRoundUpgradeUtility: continuousRounds.reduce(
      (sum, round) => sum + round.candidateUtility, 0,
    ),
  },
  performance: {
    totalSeconds: rounded((performance.now() - startedAt) / 1000, 2),
    averageGameMs: rounded(average(durations), 1),
    p95GameMs: rounded(percentile(durations, 0.95), 1),
    averageActions: rounded(average(actions), 1),
    maxActions: actions.length ? Math.max(...actions) : null,
    allAIDecisions,
    decisionLatencyByPolicy: decisionPerformanceByPolicy,
    byRunSegment: performanceByRunSegment,
  },
  ...(summaryOnly ? {} : { pairs, blocks }),
  failures,
};
const serializedReport = JSON.stringify(finalReport, null, 2);
if (reportPath) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${serializedReport}\n`, 'utf8');
}
if (rawTelemetryPath) writeRawTelemetry(finalReport, rawTelemetryPath);
console.log(serializedReport);

if (failures.length || completedPairs.length !== plannedPairs
  || completedBlocks.length !== groupCount) process.exitCode = 1;

function writeRawTelemetry(report, outputPath) {
  if (!reportPath || !checkpointPath) {
    throw new Error('原始遥测缺少可绑定的报告或 checkpoint 路径');
  }
  const records = completedGames.flatMap((game) => (
    (Array.isArray(game.decisionTelemetry) ? game.decisionTelemetry : [])
      .map((item, index) => ({
        // turn 是该局决策序列中的稳定索引；seed/level/team/seat/turn 联合后
        // 唯一定位一条决策，即使同一座位在一局中多次出牌也不会折叠。
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
      }))
  ));
  const missingVariantTurns = records.filter((item) => !item.variantPresent).length;
  const missingLocalDecisionTurns = records.filter((item) => !item.localDecisionPresent).length;
  const missingSearchTelemetryTurns = records.filter((item) => !item.searchTelemetryPresent).length;
  const missingFallbackKindTurns = records.filter((item) => !item.fallbackKindPresent).length;
  const checkpointBytes = fs.readFileSync(checkpointPath);
  const reportBytes = fs.readFileSync(reportPath);
  const payload = {
    schema: 'guandan-ai-raw-telemetry-v1',
    evaluationId: report.provenance.evaluationId,
    reportSha256: createHash('sha256').update(reportBytes).digest('hex'),
    checkpointSha256: createHash('sha256').update(checkpointBytes).digest('hex'),
    candidate: report.config.candidate,
    evaluationImplementationSha256: report.config.evaluationImplementation.sha256,
    environmentSha256: report.provenance.runSegments[0].environment.environmentSha256,
    records,
    integrityComplete: records.length > 0 && records.every((item) => item.telemetryComplete === true),
    missingVariantTurns,
    missingLocalDecisionTurns,
    missingSearchTelemetryTurns,
    missingFallbackKindTurns,
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}
