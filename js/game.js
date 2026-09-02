/**
 * 掼蛋游戏状态机
 * 座位：0 真人(南)  1 东AI  2 北AI(对家队友)  3 西AI
 * 队伍：0+2 vs 1+3
 */

import {
  createDeck, shuffle, sortHand, removeCards, isWild, isBigJoker,
  isJoker, isLevelCard, soloPower, cardLabel, LEVEL_LABEL,
} from './cards.js';
import {
  parseHand, parseHandVariants, isLegalPlay, describeUpgrade, nextLevel, canPassA, formatHand,
  generateLegalPlays, handSignature, HandType,
} from './rules.js';
import {
  chooseAIPlay, chooseTributeCard, chooseReturnCard,
  setAIDifficulty, getAIDifficulty, recommendPlay, getAIConsultation, AI_DIFFICULTY_LABEL,
} from './ai.js';
import { requestAIDecision } from './ai.worker-client.js';
import { createPublicAIObservation } from './ai-observation.js';
import { requestLLMDecision, LLM_POLICY_MODE } from './llm.js';
import { evaluatePlay, summarizeSession, analyzeHandStructure } from './evaluator.js';
import { sha256Hex } from './model-fingerprint.js';
import {
  createLivePublicEvent,
  PUBLIC_REPLAY_DECISION_SOURCES,
  PUBLIC_REPLAY_FALLBACK_KINDS,
  REPLAY_RULE_VERSION,
  REPLAY_CONTRACT_IMPLEMENTATION_SHA256,
} from './replay-contracts.js';
import {
  SEALED_STATE_KEYS,
  appendSealedTrainingTurn,
  finalizeSealedTrainingBatch,
  resetSealedTrainingRound,
  snapshotSealedAction,
} from './sealed-training.js';
import {
  loadSettings, saveSettings, recordRoundResult, saveReplay, loadStats, avgScore,
  unassistedAvgScore, saveActiveMatch, loadActiveMatch, clearActiveMatch,
  sanitizeUserSettings,
} from './stats.js';

export const PHASE = {
  IDLE: 'idle',
  DEALING: 'dealing',
  TRIBUTE: 'tribute',
  RETURN: 'return',
  PLAYING: 'playing',
  TRICK_END: 'trick_end',
  ROUND_END: 'round_end',
  MATCH_END: 'match_end',
};

const SEAT_NAMES = ['你', '下家', '对家', '上家'];
const TEAM_OF = [0, 1, 0, 1]; // seat -> team

function createReplayMatchId() {
  if (globalThis.crypto?.randomUUID) return `match_${globalThis.crypto.randomUUID()}`;
  return `match_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

const AI_SPEED_MS = {
  slow: [900, 700],
  normal: [450, 400],
  fast: [120, 80],
};

// 真实对局按 AI 速度给本地搜索一个思考预算（限时加深）；deterministic 对局
// 返回 0，让 A/B 镜像赛与单测保持逐字节可复现。
export function resolveAISearchBudget(settings = {}) {
  if (settings?.deterministicAI) return 0;
  const speed = settings?.aiSpeed || 'normal';
  const speedBudget = { slow: 600, normal: 250, fast: 60 }[speed] || 250;
  // “快”只应缩短桌面等待，不能把大师模式悄悄降成49ms左右的残缺搜索。
  // 250ms仍明显快于普通动画间隔，同时足以完成基础P1应手树；慢档可继续
  // 利用空闲时间加宽搜索，但大师快档与中档保持同一最低强度。
  return settings?.difficulty === 'master' ? Math.max(250, speedBudget) : speedBudget;
}

function aiSearchBudget(state) {
  return resolveAISearchBudget(state?.settings || {});
}

let _aiRequestSerial = 0;
let _activeAIRequestController = null;

const LLM_REPORT_MAX_RECORDS = 160;
const LLM_REPORT_VERSION = 3;
const LLM_BACKOFF_MS = [5000, 15000, 45000, 120000];
const LLM_CLOUD_CALL_LIMIT = Object.freeze({ cloud: 12, auto: 6 });

function createLLMCircuit() {
  return {
    state: 'closed',
    failureCount: 0,
    retryAt: 0,
    permanent: false,
    lastErrorCode: null,
  };
}

function normalizeLLMCircuit(raw) {
  const base = createLLMCircuit();
  if (!raw || typeof raw !== 'object') return base;
  const permanent = raw.permanent === true || raw.state === 'disabled';
  const retryAt = Math.max(0, Number(raw.retryAt) || 0);
  const expiredTransient = !permanent && raw.state === 'open'
    && retryAt > 0 && retryAt <= Date.now();
  return {
    state: permanent ? 'disabled' : (raw.state === 'open' && !expiredTransient ? 'open' : 'closed'),
    failureCount: Math.max(0, Number(raw.failureCount) || 0),
    retryAt: expiredTransient ? 0 : retryAt,
    permanent,
    lastErrorCode: raw.lastErrorCode ? String(raw.lastErrorCode).slice(0, 80) : null,
  };
}

function createLLMReport(mode = LLM_POLICY_MODE.LOCAL) {
  return {
    version: LLM_REPORT_VERSION,
    mode,
    startedAt: new Date().toISOString(),
    localTurns: 0,
    cloudEligibleTurns: 0,
    cloudCalls: 0,
    successes: 0,
    failures: 0,
    fallbacks: 0,
    skipped: 0,
    totalLatencyMs: 0,
    minLatencyMs: null,
    maxLatencyMs: null,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimatedTokenCalls: 0,
    cloudAgreements: 0,
    cloudOverrides: 0,
    rejectedCloudChoices: 0,
    transientFailures: 0,
    modelOutputFailures: 0,
    permanentFailures: 0,
    backoffSkips: 0,
    budgetSkips: 0,
    strategicSkips: 0,
    latencies: [],
    lastStatus: 'idle',
    lastError: null,
    lastProvider: null,
    lastModel: null,
    fallbackActive: false,
    records: [],
  };
}

function normalizeLLMReport(raw, mode = LLM_POLICY_MODE.LOCAL) {
  const base = createLLMReport(raw?.mode || mode);
  if (!raw || typeof raw !== 'object') return base;
  const numericKeys = [
    'localTurns', 'cloudEligibleTurns', 'cloudCalls', 'successes', 'failures',
    'fallbacks', 'skipped', 'totalLatencyMs', 'minLatencyMs', 'maxLatencyMs',
    'promptTokens', 'completionTokens', 'totalTokens', 'estimatedTokenCalls',
    'cloudAgreements', 'cloudOverrides', 'rejectedCloudChoices',
    'transientFailures', 'modelOutputFailures', 'permanentFailures',
    'backoffSkips', 'budgetSkips', 'strategicSkips',
  ];
  for (const key of numericKeys) {
    if (Number.isFinite(Number(raw[key]))) base[key] = Number(raw[key]);
  }
  base.version = LLM_REPORT_VERSION;
  base.startedAt = raw.startedAt || base.startedAt;
  base.lastStatus = typeof raw.lastStatus === 'string' ? raw.lastStatus : base.lastStatus;
  base.lastError = raw.lastError ? String(raw.lastError).slice(0, 160) : null;
  base.lastProvider = raw.lastProvider ? String(raw.lastProvider).slice(0, 120) : null;
  base.lastModel = raw.lastModel ? String(raw.lastModel).slice(0, 120) : null;
  base.fallbackActive = raw.fallbackActive === true;
  base.latencies = Array.isArray(raw.latencies)
    ? raw.latencies.filter((value) => Number.isFinite(Number(value))).map(Number).slice(-LLM_REPORT_MAX_RECORDS)
    : [];
  base.records = Array.isArray(raw.records)
    ? raw.records.filter((item) => item && typeof item === 'object').slice(-LLM_REPORT_MAX_RECORDS).map((item) => ({
      turn: Number.isFinite(Number(item.turn)) ? Number(item.turn) : null,
      trickNumber: Number.isFinite(Number(item.trickNumber)) ? Number(item.trickNumber) : null,
      seat: Number.isFinite(Number(item.seat)) ? Number(item.seat) : null,
      status: String(item.status || 'unknown'),
      latencyMs: Number.isFinite(Number(item.latencyMs)) ? Number(item.latencyMs) : null,
      candidateCount: Number.isFinite(Number(item.candidateCount)) ? Number(item.candidateCount) : null,
      confidence: Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : null,
      source: item.source ? String(item.source).slice(0, 40) : null,
      reason: item.reason ? String(item.reason).slice(0, 120) : null,
      provider: item.provider ? String(item.provider).slice(0, 120) : null,
      model: item.model ? String(item.model).slice(0, 120) : null,
      usage: item.usage && typeof item.usage === 'object' ? {
        promptTokens: Number(item.usage.promptTokens) || 0,
        completionTokens: Number(item.usage.completionTokens) || 0,
        totalTokens: Number(item.usage.totalTokens) || 0,
        source: item.usage.source === 'provider' ? 'provider' : 'estimate',
        estimated: item.usage.estimated !== false,
      } : null,
      error: item.error ? String(item.error).slice(0, 160) : null,
      errorCode: item.errorCode ? String(item.errorCode).slice(0, 80) : null,
      retryable: typeof item.retryable === 'boolean' ? item.retryable : null,
      requestId: item.requestId ? String(item.requestId).slice(0, 80) : null,
      localCandidateId: item.localCandidateId ? String(item.localCandidateId).slice(0, 80) : null,
      cloudCandidateId: item.cloudCandidateId ? String(item.cloudCandidateId).slice(0, 80) : null,
      executedCandidateId: item.executedCandidateId ? String(item.executedCandidateId).slice(0, 80) : null,
      cloudChangedDecision: item.cloudChangedDecision === true,
    }))
    : [];
  return base;
}

function recordLLMEvent(state, event = {}) {
  if (!state) return;
  const report = normalizeLLMReport(state.llmReport, state.settings?.llmPolicyMode);
  state.llmReport = report;
  const status = String(event.status || 'unknown');
  const latencyMs = Number.isFinite(Number(event.latencyMs)) ? Math.max(0, Math.round(Number(event.latencyMs))) : null;
  if (status === 'skipped') report.skipped += 1;
  else {
    report.cloudCalls += 1;
    if (status === 'success') report.successes += 1;
    if (status === 'failed' || status === 'fallback') report.failures += 1;
    if (status === 'fallback') report.fallbacks += 1;
  }
  if (event.failureClass === 'transient') report.transientFailures += 1;
  if (event.failureClass === 'model_output') report.modelOutputFailures += 1;
  if (event.failureClass === 'configuration') report.permanentFailures += 1;
  if (status === 'skipped' && event.reason === 'circuit_backoff') report.backoffSkips += 1;
  if (status === 'skipped' && event.reason === 'round_budget') report.budgetSkips += 1;
  if (status === 'skipped' && ['stable_local_choice', 'not_critical', 'single_candidate'].includes(event.reason)) {
    report.strategicSkips += 1;
  }
  if (status === 'success') {
    if (event.cloudChangedDecision) report.cloudOverrides += 1;
    else if (event.cloudCandidateId && event.cloudCandidateId === event.localCandidateId) report.cloudAgreements += 1;
    if (event.cloudCandidateId && event.executedCandidateId
      && event.cloudCandidateId !== event.executedCandidateId) report.rejectedCloudChoices += 1;
  }
  if (latencyMs != null) {
    report.totalLatencyMs += latencyMs;
    report.minLatencyMs = report.minLatencyMs == null ? latencyMs : Math.min(report.minLatencyMs, latencyMs);
    report.maxLatencyMs = report.maxLatencyMs == null ? latencyMs : Math.max(report.maxLatencyMs, latencyMs);
    report.latencies.push(latencyMs);
    if (report.latencies.length > LLM_REPORT_MAX_RECORDS) report.latencies.shift();
  }
  const usage = event.usage && typeof event.usage === 'object' ? event.usage : null;
  if (usage) {
    report.promptTokens += Number(usage.promptTokens) || 0;
    report.completionTokens += Number(usage.completionTokens) || 0;
    report.totalTokens += Number(usage.totalTokens) || 0;
    if (usage.estimated || usage.source === 'estimate') report.estimatedTokenCalls += 1;
  }
  report.lastStatus = status;
  report.lastError = event.error ? String(event.error).slice(0, 160) : (status === 'success' ? null : report.lastError);
  report.lastProvider = event.provider ? String(event.provider).slice(0, 120) : report.lastProvider;
  report.lastModel = event.model ? String(event.model).slice(0, 120) : report.lastModel;
  report.records.push({
    turn: state.trickLog.length + 1,
    trickNumber: state.trickNumber,
    seat: state.currentSeat,
    status,
    latencyMs,
    candidateCount: Number.isFinite(Number(event.candidateCount)) ? Number(event.candidateCount) : null,
    confidence: Number.isFinite(Number(event.confidence)) ? Number(event.confidence) : null,
    source: event.source ? String(event.source).slice(0, 40) : null,
    reason: event.reason ? String(event.reason).slice(0, 120) : null,
    provider: event.provider ? String(event.provider).slice(0, 120) : null,
    model: event.model ? String(event.model).slice(0, 120) : null,
    usage: usage ? {
      promptTokens: Number(usage.promptTokens) || 0,
      completionTokens: Number(usage.completionTokens) || 0,
      totalTokens: Number(usage.totalTokens) || 0,
      source: usage.source === 'provider' ? 'provider' : 'estimate',
      estimated: usage.estimated !== false,
    } : null,
    error: event.error ? String(event.error).slice(0, 160) : null,
    errorCode: event.errorCode ? String(event.errorCode).slice(0, 80) : null,
    retryable: typeof event.retryable === 'boolean' ? event.retryable : null,
    requestId: event.requestId ? String(event.requestId).slice(0, 80) : null,
    localCandidateId: event.localCandidateId ? String(event.localCandidateId).slice(0, 80) : null,
    cloudCandidateId: event.cloudCandidateId ? String(event.cloudCandidateId).slice(0, 80) : null,
    executedCandidateId: event.executedCandidateId ? String(event.executedCandidateId).slice(0, 80) : null,
    cloudChangedDecision: event.cloudChangedDecision === true,
  });
  if (report.records.length > LLM_REPORT_MAX_RECORDS) report.records.shift();
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

function llmReportSnapshot(report) {
  const normalized = normalizeLLMReport(report);
  return {
    ...normalized,
    latencies: undefined,
    avgLatencyMs: normalized.cloudCalls ? Math.round(normalized.totalLatencyMs / normalized.cloudCalls) : null,
    p95LatencyMs: percentile(normalized.latencies, 0.95),
    tokenSource: normalized.estimatedTokenCalls ? 'mixed_or_estimate' : 'provider',
    records: normalized.records.map((item) => ({ ...item })),
  };
}

function invalidateAIRequest(state = null) {
  if (_activeAIRequestController) {
    _activeAIRequestController.abort();
    _activeAIRequestController = null;
  }
  const token = ++_aiRequestSerial;
  if (state) {
    state.aiRequestToken = token;
    state.aiThinking = false;
  }
  return token;
}

export function createMatch(preserveSettings = null) {
  const settings = preserveSettings || loadSettings();
  setAIDifficulty(settings.difficulty || 'normal');
  const aiRequestToken = invalidateAIRequest();
  return {
    phase: PHASE.IDLE,
    levels: [2, 2],
    currentLevel: 2,
    levelOwner: 0,
    dealer: 0,
    firstPlayer: 0,
    hands: [[], [], [], []],
    handCounts: [0, 0, 0, 0],
    currentSeat: 0,
    lastHand: null,
    lastSeat: null,
    passCount: 0,
    finishOrder: [],
    tributeState: null,
    lastRoundResult: null,
    prevFinishOrder: null,
    prevHeadTeam: null,
    matchId: createReplayMatchId(),
    replaySequence: 0,
    replayTurn: 0,
    replayPreviousEventSha256: null,
    replayClosedTrick: null,
    replayRoundEndEmitted: false,
    replayPendingTribute: [],
    replayEventFailures: 0,
    replayLastEventError: null,
    replayObserverErrors: 0,
    sealedTrainingTurns: [],
    sealedTrainingBatch: null,
    sealedTrainingHistory: [],
    sealedTrainingFailures: 0,
    sealedTrainingLastError: null,
    sealedPreviousTurnSha256: null,
    sealedSequence: 0,
    trickLog: [],
    round: 0,
    winner: null,
    evalHistory: [],
    lastEval: null,
    reported: [false, false, false, false],
    messages: [],
    selectedIds: new Set(),
    selectedDeclaration: null,
    aFailCount: [0, 0],
    trickNumber: 1,
    currentTrickStartIndex: 0,
    roundSummary: null,
    handTips: [],
    roundInitialHands: null,
    roundStartedAt: null,
    assistanceUsed: [],
    aiThinking: false,
    aiRequestToken,
    llmFallbackActive: false,
    llmCircuit: createLLMCircuit(),
    llmLastError: null,
    llmLastLatencyMs: null,
    llmStatus: 'unknown',
    llmReport: createLLMReport(settings.llmPolicyMode),
    // 由历史公开出牌归纳的真人画像；不持有任何本副暗牌。
    opponentModel: loadStats().opponentModel,
    // 设置
    settings: { ...settings },
    coachTip: null,
    lastReplay: null,
    matchHistory: [], // 每副简报
  };
}

export function applySettings(state, partial) {
  const cleanPartial = sanitizeUserSettings(partial || {});
  const previousLLMMode = state.settings?.llmPolicyMode;
  const previousDifficulty = state.settings?.difficulty;
  const previousLocalEngine = state.settings?.localAiEngine;
  const llmModeChanged = cleanPartial.llmPolicyMode
    && cleanPartial.llmPolicyMode !== previousLLMMode;
  const difficultyChanged = cleanPartial.difficulty
    && cleanPartial.difficulty !== previousDifficulty;
  const localEngineChanged = cleanPartial.localAiEngine
    && cleanPartial.localAiEngine !== previousLocalEngine;
  const decisionSettingsChanged = llmModeChanged || difficultyChanged || localEngineChanged;
  const restartAI = decisionSettingsChanged
    && state.aiThinking
    && state.phase === PHASE.PLAYING
    && state.currentSeat !== 0;
  state.settings = { ...state.settings, ...cleanPartial };
  if (decisionSettingsChanged) {
    invalidateAIRequest(state);
  }
  if (llmModeChanged) {
    state.llmFallbackActive = false;
    state.llmCircuit = createLLMCircuit();
    state.llmLastError = null;
    state.llmStatus = 'unknown';
    state.llmReport = normalizeLLMReport(state.llmReport, cleanPartial.llmPolicyMode);
    state.llmReport.fallbackActive = false;
  }
  saveSettings(state.settings);
  if (cleanPartial.difficulty) setAIDifficulty(cleanPartial.difficulty);
  notify(state);
  if (restartAI) maybeAutoPlay(state);
  return state.settings;
}

/** 明确检测到云端恢复后，由界面调用以解除整局本地回退。 */
export function resetLLMFallback(state) {
  if (!state) return false;
  state.llmFallbackActive = false;
  state.llmCircuit = createLLMCircuit();
  state.llmLastError = null;
  state.llmStatus = 'unknown';
  state.llmReport = normalizeLLMReport(state.llmReport, state.settings?.llmPolicyMode);
  state.llmReport.fallbackActive = false;
  notify(state);
  return true;
}

/** 健康检测已确认不可用时立即切换到整局本地 AI。 */
export function markLLMFallback(state, message = '云端 API 不可用') {
  if (!state || state.llmFallbackActive) return false;
  const error = new Error(message);
  error.code = 'health_configuration_error';
  error.retryable = false;
  error.failureClass = 'configuration';
  activateLLMFallback(state, error);
  notify(state);
  return true;
}

export function getSettings(state) {
  return state.settings;
}

export function teamOf(seat) {
  return TEAM_OF[seat];
}

export function seatName(seat) {
  return SEAT_NAMES[seat];
}

export function startMatch(state) {
  const settings = state.settings ? { ...state.settings } : loadSettings();
  Object.assign(state, createMatch(settings));
  startRound(state);
  return state;
}

export function startRound(state) {
  if (_aiTimer) {
    clearTimeout(_aiTimer);
    _aiTimer = null;
  }
  invalidateAIRequest(state);
  state.round += 1;
  state.phase = PHASE.DEALING;
  state.finishOrder = [];
  state.lastHand = null;
  state.lastSeat = null;
  state.passCount = 0;
  state.trickLog = [];
  state.trickNumber = 1;
  state.currentTrickStartIndex = 0;
  state.replayTurn = 0;
  state.replayClosedTrick = null;
  state.replayRoundEndEmitted = false;
  state.replayPendingTribute = [];
  resetSealedTrainingRound(state);
  state.reported = [false, false, false, false];
  state.selectedIds = new Set();
  state.selectedDeclaration = null;
  state.lastEval = null;
  state.evalHistory = [];
  state.coachTip = null;
  state.lastReplay = null;
  state.roundSummary = null;
  state.handTips = [];
  state.roundInitialHands = null;
  state.roundStartedAt = null;
  state.assistanceUsed = [];
  state.llmCircuit = normalizeLLMCircuit(state.llmCircuit);
  if (!state.llmCircuit.permanent) state.llmCircuit = createLLMCircuit();
  state.llmFallbackActive = state.llmCircuit.permanent;
  state.llmStatus = state.llmCircuit.permanent ? 'fallback' : 'unknown';
  state.llmLastError = state.llmCircuit.permanent ? state.llmLastError : null;
  state.llmReport = createLLMReport(state.settings?.llmPolicyMode || LLM_POLICY_MODE.LOCAL);
  state.llmReport.fallbackActive = state.llmFallbackActive;

  // 当前级牌：上一局赢家的级数；首局 2
  if (state.lastRoundResult) {
    state.currentLevel = state.levels[state.lastRoundResult.winTeam];
    state.levelOwner = state.lastRoundResult.winTeam;
  } else {
    state.currentLevel = 2;
    state.levelOwner = 0;
  }

  const deck = shuffle(createDeck());
  for (let i = 0; i < 4; i++) {
    state.hands[i] = sortHand(deck.slice(i * 27, (i + 1) * 27), state.currentLevel);
    state.handCounts[i] = 27;
  }

  state.messages = [];
  pushMsg(state, `第 ${state.round} 副 · 打 ${LEVEL_LABEL[state.currentLevel]} · 级牌 ${LEVEL_LABEL[state.currentLevel]}（红桃为逢人配）`);
  pushMsg(state, `双方级数：我方 ${LEVEL_LABEL[state.levels[0]]} ｜ 对方 ${LEVEL_LABEL[state.levels[1]]}`);

  // 进贡？
  if (state.prevFinishOrder && state.prevFinishOrder.length === 4) {
    setupTribute(state);
  } else {
    // 首局：随机或固定玩家先出（常见：任意；这里由座位0 或随机）
    state.firstPlayer = Math.floor(Math.random() * 4);
    state.currentSeat = state.firstPlayer;
    state.phase = PHASE.PLAYING;
    captureRoundStart(state);
    pushMsg(state, `${seatName(state.currentSeat)} 先出牌`);
    maybeAutoPlay(state);
  }
  return state;
}

function setupTribute(state) {
  const fo = state.prevFinishOrder;
  const head = fo[0];
  const second = fo[1];
  const third = fo[2];
  const last = fo[3];
  const headTeam = teamOf(head);
  const lastTeam = teamOf(last);

  // 双下：头游队伍拿到 1、2 名
  const doubleDown = teamOf(second) === headTeam;

  const level = state.currentLevel;

  // 抗贡检测：进贡方（输方）合计两张大王
  const losers = doubleDown
    ? fo.filter((s) => teamOf(s) !== headTeam)
    : [last];

  let bigJokerCount = 0;
  for (const s of losers) {
    bigJokerCount += state.hands[s].filter(isBigJoker).length;
  }
  const resist = bigJokerCount >= 2;

  if (resist) {
    pushMsg(state, '抗贡！进贡方持有两张大王，本副不进贡。');
    state.firstPlayer = head;
    state.currentSeat = head;
    state.phase = PHASE.PLAYING;
    state.tributeState = null;
    state.replayPendingTribute = [];
    captureRoundStart(state);
    pushMsg(state, `${seatName(head)}（头游）先出牌`);
    maybeAutoPlay(state);
    return;
  }

  // 构建进贡任务
  const tributes = []; // { from, to }
  if (doubleDown) {
    // 双下：两名输家分别向头游、二游进贡
    const losersOrdered = fo.filter((s) => teamOf(s) !== headTeam);
    // 各选最大牌，大的给头游，小的给二游
    const tributeCards = losersOrdered.map((s) => ({
      seat: s,
      card: chooseTributeCard(state.hands[s], level),
    }));
    tributeCards.sort((a, b) => soloPower(b.card, level) - soloPower(a.card, level));
    // 若相同，顺时针：简化按已排序
    tributes.push({ from: tributeCards[0].seat, to: head, card: tributeCards[0].card });
    tributes.push({ from: tributeCards[1].seat, to: second, card: tributeCards[1].card });
  } else {
    // 单下：末游向头游
    const card = chooseTributeCard(state.hands[last], level);
    tributes.push({ from: last, to: head, card });
  }

  state.tributeState = {
    doubleDown,
    tributes,
    returns: [], // { from: winner, to: loser, card }
    step: 'show', // show -> return -> done
    pendingReturns: tributes.map((t) => ({ from: t.to, to: t.from })),
  };

  // 执行进贡交牌
  for (const t of tributes) {
    state.hands[t.from] = removeCards(state.hands[t.from], [t.card]);
    state.hands[t.to].push(t.card);
    pushMsg(state, `${seatName(t.from)} 进贡 ${cardLabel(t.card)} → ${seatName(t.to)}`);
  }

  // 排序
  for (let i = 0; i < 4; i++) {
    state.hands[i] = sortHand(state.hands[i], level);
    state.handCounts[i] = state.hands[i].length;
  }

  state.phase = PHASE.RETURN;
  // 若还贡方包含真人
  beginReturn(state);
}

function beginReturn(state) {
  const ts = state.tributeState;
  if (!ts.pendingReturns.length) {
    finishTribute(state);
    return;
  }
  const task = ts.pendingReturns[0];
  // AI 自动还贡
  if (task.from !== 0) {
    const card = chooseReturnCard(state.hands[task.from], state.currentLevel, {
      toPartner: TEAM_OF[task.from] === TEAM_OF[task.to],
    });
    applyReturn(state, task.from, task.to, card);
    ts.pendingReturns.shift();
    beginReturn(state);
  } else {
    // 等待真人还贡（先选中预览，再确认）
    state.selectedIds = new Set();
    pushMsg(state, '请从高亮的合规牌中选择一张还贡牌，再点「确认还贡」');
    state.phase = PHASE.RETURN;
    notify(state);
  }
}

/** 还贡：仅选中一张（确认前不交出） */
export function humanPickReturnCard(state, cardId) {
  if (state.phase !== PHASE.RETURN) return { ok: false, reason: '当前不是还贡阶段' };
  const ts = state.tributeState;
  const task = ts.pendingReturns[0];
  if (!task || task.from !== 0) return { ok: false, reason: '无需你还贡' };
  const card = state.hands[0].find((c) => c.id === cardId);
  if (!card) return { ok: false, reason: '牌不在手中' };
  const candidates = getReturnCandidates(state);
  if (!candidates.some((c) => c.id === cardId)) {
    return { ok: false, reason: '有不大于 10 的非级牌时，只能从这些牌中还贡' };
  }
  // 还贡只能选一张：再次点击取消，点其他牌则替换
  if (state.selectedIds.has(cardId) && state.selectedIds.size === 1) {
    state.selectedIds = new Set();
  } else {
    state.selectedIds = new Set([cardId]);
  }
  state.selectedDeclaration = null;
  persistMatch(state);
  return { ok: true };
}

/** 确认还贡 */
export function humanConfirmReturn(state) {
  if (state.phase !== PHASE.RETURN) return { ok: false, reason: '当前不是还贡阶段' };
  const ts = state.tributeState;
  const task = ts.pendingReturns[0];
  if (!task || task.from !== 0) return { ok: false, reason: '无需你还贡' };
  if (state.selectedIds.size !== 1) return { ok: false, reason: '请先点选一张还贡牌，再点确认' };

  const cardId = [...state.selectedIds][0];
  const card = state.hands[0].find((c) => c.id === cardId);
  if (!card) return { ok: false, reason: '牌不在手中' };
  if (!getReturnCandidates(state).some((c) => c.id === cardId)) {
    return { ok: false, reason: '该牌不符合还贡限制，请重新选择' };
  }

  applyReturn(state, 0, task.to, card);
  state.selectedIds = new Set();
  state.selectedDeclaration = null;
  ts.pendingReturns.shift();
  beginReturn(state);
  return { ok: true };
}

/** @deprecated 保留兼容：点选 + 需再确认 */
export function humanReturnCard(state, cardId) {
  return humanPickReturnCard(state, cardId);
}

function applyReturn(state, from, to, card) {
  state.hands[from] = removeCards(state.hands[from], [card]);
  state.hands[to].push(card);
  state.hands[from] = sortHand(state.hands[from], state.currentLevel);
  state.hands[to] = sortHand(state.hands[to], state.currentLevel);
  state.handCounts[from] = state.hands[from].length;
  state.handCounts[to] = state.hands[to].length;
  state.tributeState.returns.push({ from, to, card });
  pushMsg(state, `${seatName(from)} 还贡 ${cardLabel(card)} → ${seatName(to)}`);
}

function finishTribute(state) {
  const ts = state.tributeState;
  // 出牌权：一般由进贡的下游先出；双下由进贡牌大的一家先出
  if (ts.doubleDown) {
    // 进贡牌大的 from 先出
    const sorted = ts.tributes.slice().sort(
      (a, b) => soloPower(b.card, state.currentLevel) - soloPower(a.card, state.currentLevel),
    );
    state.firstPlayer = sorted[0].from;
  } else {
    state.firstPlayer = ts.tributes[0].from;
  }
  state.currentSeat = state.firstPlayer;
  state.phase = PHASE.PLAYING;
  state.replayPendingTribute = [
    ...(ts.tributes || []).map((item) => ({
      kind: 'tribute', from: item.from, to: item.to, card: item.card,
    })),
    ...(ts.returns || []).map((item) => ({
      kind: 'return', from: item.from, to: item.to, card: item.card,
    })),
  ];
  captureRoundStart(state);
  pushMsg(state, `还贡完成，${seatName(state.currentSeat)} 先出牌`);
  maybeAutoPlay(state);
}

export function humanSelectToggle(state, cardId) {
  if (state.selectedIds.has(cardId)) state.selectedIds.delete(cardId);
  else state.selectedIds.add(cardId);
  state.selectedDeclaration = null;
  persistMatch(state);
}

export function humanClearSelect(state) {
  state.selectedIds = new Set();
  state.selectedDeclaration = null;
  persistMatch(state);
}

/** 设置选中集合 */
export function humanSelectSet(state, ids, declaration = null, source = null) {
  state.selectedIds = new Set(ids);
  state.selectedDeclaration = declaration
    ? (typeof declaration === 'string' ? declaration : handSignature(declaration))
    : null;
  if (source) markAssistance(state, source);
  persistMatch(state);
}

/**
 * 快捷选同点数：cycle = 循环张数 1→2→…→全部→清空
 * rankKey: 数字 rank，或 'wild' / 'joker16' / 'joker17'
 */
export function humanSelectRankCycle(state, rankKey) {
  const hand = state.hands[0] || [];
  const group = hand.filter((c) => rankKeyOf(c, state.currentLevel) === rankKey);
  if (!group.length) return;

  const selectedInGroup = group.filter((c) => state.selectedIds.has(c.id));
  const n = selectedInGroup.length;
  // 去掉本组后保留其他选中
  const others = [...state.selectedIds].filter((id) => !group.some((c) => c.id === id));
  let take;
  if (n >= group.length) take = 0;
  else take = n + 1;
  if (take > group.length) take = 0;

  const next = new Set(others);
  for (let i = 0; i < take; i++) next.add(group[i].id);
  state.selectedIds = next;
  state.selectedDeclaration = null;
  persistMatch(state);
}

export function humanSelectAllOfRank(state, rankKey) {
  const hand = state.hands[0] || [];
  const group = hand.filter((c) => rankKeyOf(c, state.currentLevel) === rankKey);
  const allSelected = group.length && group.every((c) => state.selectedIds.has(c.id));
  const next = new Set(state.selectedIds);
  if (allSelected) {
    for (const c of group) next.delete(c.id);
  } else {
    for (const c of group) next.add(c.id);
  }
  state.selectedIds = next;
  state.selectedDeclaration = null;
  persistMatch(state);
}

function rankKeyOf(card, level) {
  if (card.suit === 'H' && card.rank === level) return 'wild';
  if (card.rank === 16) return 'joker16';
  if (card.rank === 17) return 'joker17';
  return String(card.rank);
}

export function getSelectedCards(state) {
  return (state.hands[0] || []).filter((c) => state.selectedIds.has(c.id));
}

/** 基于当前选中，推荐可组成的合法牌型（含补全选中） */
export function getCombosFromSelection(state) {
  if (state.phase !== PHASE.PLAYING || state.currentSeat !== 0) return [];
  const selected = getSelectedCards(state);
  const generated = generateLegalPlays(state.hands[0], state.currentLevel, state.lastHand);
  const flushKeys = new Set(generated
    .filter((play) => play.hand.type === HandType.FLUSH_STRAIGHT)
    .map((play) => `${play.cards.map((c) => c.id).sort().join(',')}|${play.hand.mainRank}`));
  const plays = generated.filter((play) => (
    play.hand.type !== HandType.STRAIGHT
    || !flushKeys.has(`${play.cards.map((c) => c.id).sort().join(',')}|${play.hand.mainRank}`)
  ));
  if (!selected.length) {
    return plays
      .sort((a, b) => b.cards.length - a.cards.length || a.hand.power - b.hand.power)
      .slice(0, 16);
  }
  const selIds = new Set(selected.map((c) => c.id));
  // 优先：恰好等于选中
  const exact = plays.filter((p) => p.cards.length === selected.length
    && p.cards.every((c) => selIds.has(c.id)));
  // 其次：包含全部选中（可多牌凑型）
  const supersets = plays.filter((p) => {
    const ids = new Set(p.cards.map((c) => c.id));
    return [...selIds].every((id) => ids.has(id));
  });
  const merged = [];
  const seen = new Set();
  for (const p of [...exact, ...supersets, ...plays]) {
    // 同一组实体牌可以有多个合法声明（例如顺子/同花顺或不同逢人配点数）。
    const signature = p.signature || handSignature(p.hand);
    const key = `${p.cards.map((c) => c.id).sort().join(',')}::${signature}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // 与选中相关优先
    const overlap = p.cards.filter((c) => selIds.has(c.id)).length;
    if (selected.length && overlap === 0) continue;
    merged.push({
      ...p,
      signature,
      overlap,
      exact: overlap === selected.length && p.cards.length === selected.length,
    });
    if (merged.length >= 20) break;
  }
  merged.sort((a, b) => (b.exact - a.exact) || (b.overlap - a.overlap) || a.hand.power - b.hand.power);
  return merged.slice(0, 14);
}

export function markAssistance(state, source) {
  if (!source) return;
  if (!Array.isArray(state.assistanceUsed)) state.assistanceUsed = [];
  if (!state.assistanceUsed.includes(source)) state.assistanceUsed.push(source);
  persistMatch(state);
}

function decorateEvaluation(state, evaluation, forced = false) {
  const sources = Array.isArray(state.assistanceUsed) ? state.assistanceUsed.slice() : [];
  evaluation.assistanceTypes = sources;
  evaluation.assisted = sources.length > 0;
  evaluation.forced = !!forced;
  return evaluation;
}

/**
 * 出牌落日志前再次执行同花顺强制升级。
 * 规则层已经禁止降级声明，但这道保险可覆盖旧复盘、旧 UI 状态或
 * 外部调用者传入的普通顺子 hand，避免把逢人配补出的同花顺记成顺子。
 */
function normalizePlayedHand(cards, level, hand) {
  if (!hand || hand.type !== 'straight') return hand;
  const flush = parseHandVariants(cards, level).find((variant) => (
    variant.type === 'flush_straight'
      && variant.mainRank === hand.mainRank
      && (variant.meta?.sequence || []).join('-') === (hand.meta?.sequence || []).join('-')
  ));
  return flush || hand;
}

function resetHumanAssistance(state) {
  state.assistanceUsed = [];
}

export function humanPlay(state) {
  if (state.phase !== PHASE.PLAYING) return { ok: false, reason: '非出牌阶段' };
  if (state.currentSeat !== 0) return { ok: false, reason: '未轮到你' };
  if (state.finishOrder.includes(0)) return { ok: false, reason: '你已出完' };

  const cards = state.hands[0].filter((c) => state.selectedIds.has(c.id));
  if (!cards.length) return { ok: false, reason: '请先选择要出的牌' };

  const handBefore = state.hands[0].slice();
  const legal = isLegalPlay(
    cards,
    state.currentLevel,
    state.lastHand,
    state.selectedDeclaration,
  );
  if (!legal.ok) return { ok: false, reason: legal.reason };

  const playedHand = normalizePlayedHand(cards, state.currentLevel, legal.hand);

  // 评价
  const ev = evaluatePlay({
    action: 'play',
    cards,
    handBefore,
    level: state.currentLevel,
    lastHand: state.lastHand,
    lastSeat: state.lastSeat,
    seat: 0,
    teams: TEAM_OF,
    handCounts: state.handCounts.slice(),
    finishOrder: state.finishOrder.slice(),
    playedCards: state.trickLog.flatMap((item) => item.cards || []),
    publicHistory: publicActionHistory(state),
    tributeContext: getPublicTributeContext(state, 0),
    difficulty: state.settings?.difficulty || 'normal',
    leadAfterOwnBomb: isLeadAfterOwnBomb(state, 0),
    playedHand,
    declaration: state.selectedDeclaration,
  });
  decorateEvaluation(state, ev, false);
  state.lastEval = ev;
  state.evalHistory.push(ev);

  applyPlay(state, 0, cards, playedHand, ev, {
    assisted: ev.assisted,
    assistanceTypes: ev.assistanceTypes,
  });
  state.selectedIds = new Set();
  state.selectedDeclaration = null;
  state.coachTip = null;
  resetHumanAssistance(state);
  advanceAfterPlay(state);
  return { ok: true, eval: ev };
}

export function humanPass(state) {
  if (state.phase !== PHASE.PLAYING) return { ok: false, reason: '非出牌阶段' };
  if (state.currentSeat !== 0) return { ok: false, reason: '未轮到你' };
  if (!state.lastHand) return { ok: false, reason: '领出不能过牌' };

  const handBefore = state.hands[0].slice();
  const forced = generateLegalPlays(handBefore, state.currentLevel, state.lastHand).length === 0;
  const ev = evaluatePlay({
    action: 'pass',
    cards: [],
    handBefore,
    level: state.currentLevel,
    lastHand: state.lastHand,
    lastSeat: state.lastSeat,
    seat: 0,
    teams: TEAM_OF,
    handCounts: state.handCounts.slice(),
    finishOrder: state.finishOrder.slice(),
    playedCards: state.trickLog.flatMap((item) => item.cards || []),
    publicHistory: publicActionHistory(state),
    difficulty: state.settings?.difficulty || 'normal',
  });
  decorateEvaluation(state, ev, forced);
  state.lastEval = ev;
  state.evalHistory.push(ev);

  applyPass(state, 0, ev, {
    assisted: ev.assisted,
    assistanceTypes: ev.assistanceTypes,
    forced,
  });
  state.coachTip = null;
  resetHumanAssistance(state);
  advanceAfterPass(state);
  return { ok: true, eval: ev };
}

function captureSealedAction(state, seat, action, cards, hand) {
  try {
    return snapshotSealedAction({
      seat,
      action,
      cards,
      playedHand: hand,
      actingHand: state.hands[seat],
      level: state.currentLevel,
      lastHand: state.lastHand,
      lastSeat: state.lastSeat,
      observation: aiDecisionContext(state, seat),
      turn: (state.trickLog?.length || 0) + 1,
    });
  } catch (error) {
    state.sealedTrainingFailures = (Number(state.sealedTrainingFailures) || 0) + 1;
    state.sealedTrainingLastError = String(error?.message || error || '密封训练快照失败').slice(0, 240);
    return null;
  }
}

function applyPlay(state, seat, cards, hand, evaluation = null, decisionMeta = null) {
  const sealedCapture = captureSealedAction(state, seat, 'play', cards, hand);
  const countsBefore = state.handCounts.slice();
  state.hands[seat] = sortHand(removeCards(state.hands[seat], cards), state.currentLevel);
  state.handCounts[seat] = state.hands[seat].length;
  state.lastHand = hand;
  state.lastSeat = seat;
  state.passCount = 0;
  state.trickLog.push({
    turn: state.trickLog.length + 1,
    trickNumber: state.trickNumber,
    seat,
    action: 'play',
    cards,
    hand,
    signature: handSignature(hand),
    countsBefore,
    countsAfter: state.handCounts.slice(),
    evaluation,
    decisionMeta,
    text: `${seatName(seat)} 出 ${cards.map(cardLabel).join(' ')}（${formatHand(hand)}）`,
  });
  pushMsg(state, state.trickLog[state.trickLog.length - 1].text);

  // 报牌
  if (state.handCounts[seat] <= 10 && state.handCounts[seat] > 0 && !state.reported[seat]) {
    state.reported[seat] = true;
    pushMsg(state, `📢 ${seatName(seat)} 报牌：剩余 ${state.handCounts[seat]} 张`);
  }

  // 出完
  if (state.handCounts[seat] === 0) {
    state.finishOrder.push(seat);
    const place = ['头游', '二游', '三游', '末游'][state.finishOrder.length - 1];
    pushMsg(state, `🏆 ${seatName(seat)} → ${place}`);
  }
  if (seat === 0) state.handTips = analyzeHandStructure(state.hands[0], state.currentLevel);
  emitReplayAction(state, state.trickLog[state.trickLog.length - 1], sealedCapture);
}

function applyPass(state, seat, evaluation = null, decisionMeta = null) {
  const sealedCapture = captureSealedAction(state, seat, 'pass', [], null);
  state.passCount += 1;
  state.trickLog.push({
    turn: state.trickLog.length + 1,
    trickNumber: state.trickNumber,
    seat,
    action: 'pass',
    countsBefore: state.handCounts.slice(),
    countsAfter: state.handCounts.slice(),
    evaluation,
    decisionMeta,
    text: `${seatName(seat)} 过`,
  });
  pushMsg(state, `${seatName(seat)} 过`);
  emitReplayAction(state, state.trickLog[state.trickLog.length - 1], sealedCapture);
}

// 座位视觉：南0 → 东1 → 北2 → 西3。
function nextActiveSeatCW(state, from) {
  let s = from;
  for (let i = 0; i < 4; i++) {
    s = (s + 1) % 4;
    if (!state.finishOrder.includes(s)) return s;
  }
  return null;
}

function countActive(state) {
  return 4 - state.finishOrder.length;
}

/** 出完最后一手后，出完者的对家等待接风，不参与压这手牌。 */
function pendingWindPartner(state) {
  if (state.lastSeat == null || !state.finishOrder.includes(state.lastSeat)) return null;
  const partner = (state.lastSeat + 2) % 4;
  return state.finishOrder.includes(partner) ? null : partner;
}

/** 下一位需要对当前最后一手牌作出响应的在局玩家。 */
function nextRespondingSeatCW(state, from) {
  const windPartner = pendingWindPartner(state);
  let seat = from;
  for (let i = 0; i < 4; i++) {
    seat = (seat + 1) % 4;
    if (!state.finishOrder.includes(seat) && seat !== windPartner) return seat;
  }
  return null;
}

/**
 * 判断本副是否已经产生完整赛果。
 * 头游、二游同队即为双上，余下两名无需继续互相出牌。
 */
function finishRoundIfDecided(state) {
  const doubleUp = state.finishOrder.length >= 2
    && teamOf(state.finishOrder[0]) === teamOf(state.finishOrder[1]);
  if (!doubleUp && state.finishOrder.length < 3) return false;

  // 按当前出牌座位后的顺时针顺序补齐未出完者，保证复盘和下副进贡数据完整。
  let cursor = state.currentSeat;
  while (state.finishOrder.length < 4) {
    const next = nextActiveSeatCW(state, cursor);
    if (next == null) break;
    state.finishOrder.push(next);
    cursor = next;
  }
  endRound(state);
  return true;
}

function advanceAfterPlay(state) {
  // 双上时立即结束；否则已有 3 人出完时自动补末游。
  if (finishRoundIfDecided(state)) return;

  // 若刚出完，需要看是否所有其他人过完这一圈
  const next = nextRespondingSeatCW(state, state.currentSeat);
  if (next == null) {
    endRound(state);
    return;
  }
  state.currentSeat = next;
  maybeAutoPlay(state);
}

function advanceAfterPass(state) {
  const active = countActive(state);
  const windPartner = pendingWindPartner(state);
  // 收圈：自上手出牌后，其余「仍需表态」的在局玩家都过
  // - 出牌者仍在局：需 active-1 次过
  // - 出牌者已出完：其对家等待接风，只需另一队两名玩家表态
  const needPass = state.lastSeat != null && state.finishOrder.includes(state.lastSeat)
    ? active - (windPartner == null ? 0 : 1)
    : Math.max(active - 1, 0);
  if (state.passCount >= needPass && state.lastSeat != null) {
    closeReplayTrick(state);
    // 新一轮领出
    let leader = state.lastSeat;
    // 借风：若领出者已出完，由对家接风
    if (state.finishOrder.includes(leader)) {
      const partner = (leader + 2) % 4;
      if (!state.finishOrder.includes(partner)) {
        leader = partner;
        pushMsg(state, `借风：${seatName(leader)} 接风出牌`);
      } else {
        leader = nextActiveSeatCW(state, leader);
      }
    }
    state.lastHand = null;
    state.lastSeat = null;
    state.passCount = 0;
    state.currentTrickStartIndex = state.trickLog.length;
    state.trickNumber += 1;
    state.currentSeat = leader;
    pushMsg(state, `${seatName(leader)} 领出`);
    maybeAutoPlay(state);
    return;
  }

  const next = nextRespondingSeatCW(state, state.currentSeat);
  if (next == null) {
    endRound(state);
    return;
  }
  // 若 next 是 lastSeat 且所有人都过了 — 已在上面处理
  state.currentSeat = next;
  // 跳过已出完者；接风待定时也跳过出完者的对家。
  maybeAutoPlay(state);
}

let _aiTimer = null;
let _onUpdate = null;
let _aiDecisionObserver = null;
let _replayEventObserver = null;

function cloneCard(card) {
  return card ? {
    id: card.id,
    rank: card.rank,
    suit: card.suit,
    deckIndex: card.deckIndex,
  } : null;
}

function captureRoundStart(state) {
  if (state.roundInitialHands) return;
  state.roundStartedAt = new Date().toISOString();
  state.roundInitialHands = state.hands.map((hand) => hand.map(cloneCard));
  state.handTips = analyzeHandStructure(state.hands[0], state.currentLevel);
}

export function serializeMatchState(state) {
  return JSON.parse(JSON.stringify(state, (key, value) => {
    if (SEALED_STATE_KEYS.includes(key)) return undefined;
    if (value instanceof Set) return [...value];
    return value;
  }));
}

export function persistMatch(state) {
  if (!state || !Object.values(PHASE).includes(state.phase)) return false;
  return saveActiveMatch(serializeMatchState(state));
}

export function restoreMatch() {
  const snapshot = loadActiveMatch();
  if (!snapshot || !Array.isArray(snapshot.hands) || snapshot.hands.length !== 4) return null;
  if (!Object.values(PHASE).includes(snapshot.phase)) {
    clearActiveMatch();
    return null;
  }
  const snapSettings = sanitizeUserSettings(snapshot.settings || {});
  const base = createMatch({ ...loadSettings(), ...snapSettings });
  const state = {
    ...base,
    ...snapshot,
    settings: { ...base.settings, ...snapSettings },
    llmReport: normalizeLLMReport(snapshot.llmReport, snapSettings.llmPolicyMode || base.settings.llmPolicyMode),
    llmCircuit: normalizeLLMCircuit(snapshot.llmCircuit),
    selectedIds: new Set(Array.isArray(snapshot.selectedIds) ? snapshot.selectedIds : []),
    selectedDeclaration: snapshot.selectedDeclaration || null,
    assistanceUsed: Array.isArray(snapshot.assistanceUsed) ? snapshot.assistanceUsed : [],
    aiThinking: false,
    aiRequestToken: invalidateAIRequest(),
  };
  state.llmFallbackActive = state.llmCircuit.permanent;
  state.llmReport.fallbackActive = state.llmFallbackActive;
  setAIDifficulty(state.settings.difficulty || 'normal');
  // 画像以统计库为准。清空/导入后即使旧快照仍带 ±12 偏置，也不能复活。
  state.opponentModel = loadStats().opponentModel;
  return state;
}

export function resumeMatch(state) {
  if (!state) return;
  if (state.phase === PHASE.PLAYING) maybeAutoPlay(state);
  else notify(state);
}

export function setUpdateCallback(fn) {
  _onUpdate = fn;
}

/**
 * 只读评测钩子：向黑盒 A/B 框架暴露 AI 当手的白名单决策输入和最终动作。
 * 不传 state/hands/初始牌面；观察器异常会被隔离，绝不影响正式牌局。
 */
export function setAIDecisionObserver(fn) {
  _aiDecisionObserver = typeof fn === 'function' ? fn : null;
}

/**
 * 真实牌局复盘事件钩子。它与 UI 更新回调完全分离，且只接收 RT-1
 * 白名单公开事件；观察器异常只能记录为缺口，不能阻断出牌状态机。
 */
export function setReplayEventObserver(fn) {
  _replayEventObserver = typeof fn === 'function' ? fn : null;
}

function replayEngine(state, item) {
  if (item?.seat == null) return null;
  if (item.seat === 0) return { name: 'human', version: 'browser-v1' };
  const name = state.settings?.aiDecisionEngineBySeat?.[item.seat]
    || state.settings?.localAiEngine
    || 'expert';
  return { name: String(name), version: 'game-js-v1' };
}

function replayPublicToken(value, allowed) {
  const token = String(value);
  return allowed.includes(token) ? token : 'unknown';
}

function replayDecisionMeta(item) {
  if (!item) return null;
  const source = item.seat === 0
    ? 'human'
    : item.decisionMeta?.localDecision?.source || 'local';
  const input = item.decisionMeta || {};
  const localDecision = input.localDecision || {};
  const result = { source: replayPublicToken(source, PUBLIC_REPLAY_DECISION_SOURCES) };
  if (input.fallbackKind != null && String(input.fallbackKind).length) {
    result.fallbackKind = replayPublicToken(input.fallbackKind, PUBLIC_REPLAY_FALLBACK_KINDS);
  }
  for (const key of ['searchAttempted', 'searchTriggered']) {
    if (typeof input[key] === 'boolean') result[key] = input[key];
  }
  for (const key of ['budgetMs', 'latencyMs']) {
    if (Number.isFinite(Number(localDecision[key])) && Number(localDecision[key]) >= 0) {
      result[key] = Number(localDecision[key]);
    }
  }
  return Object.keys(result).length ? result : null;
}

function deepFreezeReplay(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreezeReplay(item);
  return value;
}

function emitReplayEvent(state, eventType, item = null) {
  const sequence = Number.isSafeInteger(state.replaySequence) ? state.replaySequence : 0;
  const turn = (Number.isSafeInteger(state.replayTurn) ? state.replayTurn : 0) + 1;
  const tribute = eventType === 'play' || eventType === 'pass'
    ? (state.replayPendingTribute || [])
    : [];
  const input = {
    matchId: state.matchId,
    round: state.round,
    trick: state.trickNumber,
    // turn is the ordinal of the emitted public event within this round;
    // boundary events therefore cannot collide with action turns.
    turn,
    eventId: `${state.matchId}:event:${sequence}`,
    sequence,
    occurredAt: new Date().toISOString(),
    ruleVersion: REPLAY_RULE_VERSION,
    implementationSha256: REPLAY_IMPLEMENTATION_SHA256,
    previousEventSha256: state.replayPreviousEventSha256 || null,
    eventType,
    seat: item?.seat ?? null,
    action: item?.action || null,
    cards: item?.cards || [],
    hand: item?.hand || null,
    countsBefore: item?.countsBefore || state.handCounts.slice(),
    countsAfter: item?.countsAfter || state.handCounts.slice(),
    tribute,
    engine: replayEngine(state, item),
    decisionMeta: replayDecisionMeta(item),
  };
  let event;
  try {
    event = deepFreezeReplay(createLivePublicEvent(input));
  } catch (error) {
    // A malformed state must leave an observable sequence gap rather than
    // silently resetting the next event to the same sequence number.
    state.replayEventFailures = (Number(state.replayEventFailures) || 0) + 1;
    state.replayLastEventError = String(error?.message || error || '复盘事件构造失败').slice(0, 240);
    state.replaySequence = sequence + 1;
    state.replayTurn = turn;
    return null;
  }

  state.replaySequence = sequence + 1;
  state.replayTurn = turn;
  state.replayPreviousEventSha256 = event.eventSha256;
  if (tribute.length) state.replayPendingTribute = [];
  if (typeof _replayEventObserver === 'function') {
    try {
      _replayEventObserver(event);
    } catch {
      state.replayObserverErrors = (Number(state.replayObserverErrors) || 0) + 1;
    }
  }
  return event;
}

function emitReplayAction(state, item, sealedCapture = null) {
  const event = emitReplayEvent(state, item?.action || 'play', item);
  if (event && sealedCapture) {
    appendSealedTrainingTurn(state, event, {
      ...sealedCapture,
      turn: item?.turn || sealedCapture.turn,
    });
  }
  return event;
}

function closeReplayTrick(state) {
  if (state.replayClosedTrick === state.trickNumber) return null;
  const event = emitReplayEvent(state, 'trick_end');
  state.replayClosedTrick = state.trickNumber;
  return event;
}

function emitReplayRoundEnd(state) {
  return emitReplayEvent(state, 'round_end');
}

// Browser modules cannot synchronously read their own source files. Fingerprint
// the actual boundary functions and the contract module's complete explicit
// serialization manifest instead of hashing a fixed label.
const REPLAY_IMPLEMENTATION_FUNCTIONS = Object.freeze([
  ['createReplayMatchId', createReplayMatchId],
  ['startRound', startRound],
  ['setupTribute', setupTribute],
  ['finishTribute', finishTribute],
  ['applyPlay', applyPlay],
  ['applyPass', applyPass],
  ['finishRoundIfDecided', finishRoundIfDecided],
  ['advanceAfterPlay', advanceAfterPlay],
  ['advanceAfterPass', advanceAfterPass],
  ['setReplayEventObserver', setReplayEventObserver],
  ['replayEngine', replayEngine],
  ['replayPublicToken', replayPublicToken],
  ['replayDecisionMeta', replayDecisionMeta],
  ['emitReplayEvent', emitReplayEvent],
  ['closeReplayTrick', closeReplayTrick],
  ['emitReplayRoundEnd', emitReplayRoundEnd],
  ['endRound', endRound],
  ['createLivePublicEvent', createLivePublicEvent],
  ['replayContractImplementation', REPLAY_CONTRACT_IMPLEMENTATION_SHA256],
]);

export const REPLAY_IMPLEMENTATION_SHA256 = sha256Hex([
  'guandan-replay-observer-runtime-v2',
  `ruleVersion=${REPLAY_RULE_VERSION}`,
  ...REPLAY_IMPLEMENTATION_FUNCTIONS.map(([name, value]) => (
    `${name}\n${typeof value === 'function' ? value.toString() : String(value)}`
  )),
].join('\n'));

function observeAIDecision(state, context, decision) {
  if (!_aiDecisionObserver) return;
  try {
    _aiDecisionObserver({
      round: state.round,
      turn: state.trickLog.length + 1,
      trickNumber: state.trickNumber,
      seat: context.seat,
      context,
      decision,
    });
  } catch {
    // 评测遥测不得改变出牌流程。
  }
}

function notify(state = null, { persist = true } = {}) {
  if (state && persist) persistMatch(state);
  if (_onUpdate) _onUpdate();
}

function isBombishHand(hand) {
  return !!hand && ['bomb', 'flush_straight', 'joker_bomb'].includes(hand.type);
}

function isLeadAfterOwnBomb(state, seat) {
  if (state.lastHand || state.currentTrickStartIndex <= 0) return false;
  for (let i = Math.min(state.currentTrickStartIndex, state.trickLog.length) - 1; i >= 0; i--) {
    const item = state.trickLog[i];
    if (item.action !== 'play') continue;
    return item.seat === seat && isBombishHand(item.hand);
  }
  return false;
}

/**
 * 牌桌公共行动历史。刻意排除评价、教练提示、AI理由、初始牌面和余牌，
 * 供记牌与行为推断使用，不能成为电脑玩家之间的隐藏通信通道。
 */
function publicActionHistory(state) {
  return state.trickLog.map((item) => ({
    turn: item.turn,
    trickNumber: item.trickNumber,
    seat: item.seat,
    action: item.action,
    cards: item.action === 'play' ? (item.cards || []) : [],
    hand: item.action === 'play' ? item.hand : null,
    countsBefore: Array.isArray(item.countsBefore) ? item.countsBefore.slice() : [],
    countsAfter: Array.isArray(item.countsAfter) ? item.countsAfter.slice() : [],
  }));
}

/** 当前座位可见的贡还信息，不包含任何其他玩家未公开手牌。 */
export function getPublicTributeContext(state, seat) {
  const ts = state.tributeState;
  if (!ts) return null;
  const gave = (ts.tributes || []).find((item) => item.from === seat) || null;
  const received = (ts.returns || []).find((item) => item.to === seat) || null;
  const face = (card) => (card
    ? { rank: card.rank, suit: card.suit, deckIndex: card.deckIndex }
    : null);
  // 进贡与还贡牌面在桌面上公开。把全桌已知转移作为 P0 的按座位证据；
  // 它只描述公开牌，不包含任何当前暗牌或初始牌面。
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
    firstLeadAfterTribute: state.phase === PHASE.PLAYING
      && state.firstPlayer === seat
      && state.trickLog.length === 0,
    doubleDown: !!ts.doubleDown,
    knownTransfers,
  };
}

export function aiDecisionContext(state, seat) {
  const seatDifficulty = state.settings?.aiDifficultyBySeat?.[seat]
    || state.settings?.difficulty
    || 'normal';
  return createPublicAIObservation({
    seat,
    hand: state.hands[seat],
    level: state.currentLevel,
    lastHand: state.lastHand,
    lastSeat: state.lastSeat,
    handCounts: state.handCounts,
    teams: TEAM_OF,
    finishOrder: state.finishOrder,
    playedCards: state.trickLog.flatMap((item) => item.cards || []),
    publicHistory: publicActionHistory(state),
    tributeContext: getPublicTributeContext(state, seat),
    difficulty: seatDifficulty,
    deterministic: !!state.settings?.deterministicAI,
    policyProfile: state.settings?.aiPolicyBySeat?.[seat] || 'expert',
    policyFeatures: state.settings?.aiPolicyFeaturesBySeat?.[seat] || null,
    policyThresholds: state.settings?.aiPolicyThresholdsBySeat?.[seat] || null,
    leadAfterOwnBomb: isLeadAfterOwnBomb(state, seat),
    opponentModel: state.opponentModel,
    opponentModelMode: state.settings?.opponentModelMode || 'adaptive',
    decisionEngine: state.settings?.aiDecisionEngineBySeat?.[seat]
      || state.settings?.localAiEngine
      || 'expert',
  });
}

function llmCardCode(card) {
  if (!card || card.rank == null || !card.suit) return null;
  return `${String(card.suit).slice(0, 1)}${card.rank}`;
}

function llmHandView(hand) {
  if (!hand) return null;
  return {
    type: hand.type,
    mainRank: hand.mainRank,
    size: hand.size,
    power: hand.power,
  };
}

function llmContextView(ctx) {
  // 云端只做本地安全候选的轻量重排，不需要重复上传完整逐手牌史。
  // 牌面改为短编码，保留全部公开已出牌；逐手历史只保留最近24手，
  // 且仅最近8手带具体牌，避免深局上下文膨胀到数千 Token。
  const history = (ctx.publicHistory || []).slice(-12);
  const compactHistory = history.map((item, index) => ({
    turn: item.turn,
    trickNumber: item.trickNumber,
    seat: item.seat,
    action: item.action,
    hand: llmHandView(item.hand),
    countsAfter: Array.isArray(item.countsAfter) ? item.countsAfter.slice(0, 4) : [],
    ...(index >= history.length - 6
      ? { cards: (item.cards || []).map(llmCardCode).filter(Boolean) }
      : {}),
  }));
  const playedRankCounts = {};
  for (const card of (ctx.playedCards || [])) {
    const rank = Number(card?.rank);
    if (!Number.isFinite(rank)) continue;
    playedRankCounts[rank] = (playedRankCounts[rank] || 0) + 1;
  }
  const tribute = ctx.tributeContext;
  return {
    seat: ctx.seat,
    level: ctx.level,
    hand: (ctx.hand || []).map(llmCardCode).filter(Boolean),
    lastHand: llmHandView(ctx.lastHand),
    lastSeat: ctx.lastSeat,
    handCounts: Array.isArray(ctx.handCounts) ? ctx.handCounts.slice(0, 4) : [],
    teams: TEAM_OF.slice(),
    finishOrder: Array.isArray(ctx.finishOrder) ? ctx.finishOrder.slice(0, 4) : [],
    playedRankCounts,
    publicHistory: compactHistory,
    tributeContext: tribute ? {
      ...tribute,
      gaveCard: llmCardCode(tribute.gaveCard),
      receivedReturnCard: llmCardCode(tribute.receivedReturnCard),
    } : null,
    difficulty: ctx.difficulty,
  };
}

function criticalCloudSituation(state, seat) {
  const ownCount = state.handCounts[seat] || state.hands[seat]?.length || 0;
  const activeEnemies = state.handCounts.map((count, index) => (
    index !== seat && !state.finishOrder.includes(index) && TEAM_OF[index] !== TEAM_OF[seat]
      ? count : 99
  ));
  const enemyMin = Math.min(...activeEnemies);
  const partnerSeat = (seat + 2) % 4;
  const partnerCount = state.finishOrder.includes(partnerSeat)
    ? 99 : (state.handCounts[partnerSeat] || 99);
  const criticalHand = state.lastHand && isBombishHand(state.lastHand);
  const criticalSingle = state.lastHand?.type === 'single' && enemyMin <= 6;
  return ownCount <= 12 || enemyMin <= 10 || partnerCount <= 6 || criticalHand || criticalSingle;
}

function llmPreflight(state, seat) {
  const mode = state.settings?.llmPolicyMode || LLM_POLICY_MODE.LOCAL;
  if (mode === LLM_POLICY_MODE.LOCAL) return { eligible: false, reason: 'local_mode' };
  state.llmCircuit = normalizeLLMCircuit(state.llmCircuit);
  if (state.llmCircuit.permanent || state.llmFallbackActive) {
    return { eligible: false, reason: 'permanent_fallback' };
  }
  if (state.llmCircuit.state === 'open' && Date.now() < state.llmCircuit.retryAt) {
    return { eligible: false, reason: 'circuit_backoff' };
  }
  const report = normalizeLLMReport(state.llmReport, mode);
  const limit = LLM_CLOUD_CALL_LIMIT[mode] || LLM_CLOUD_CALL_LIMIT.auto;
  if (report.cloudCalls >= limit) return { eligible: false, reason: 'round_budget' };
  const critical = criticalCloudSituation(state, seat);
  if (mode === LLM_POLICY_MODE.AUTO && !critical) {
    return { eligible: false, reason: 'not_critical' };
  }
  return { eligible: true, reason: state.llmCircuit.state === 'open' ? 'half_open' : 'candidate_check', critical };
}

function llmConsultationGate(state, seat, consultation, preflight) {
  const candidates = consultation?.candidates || [];
  if (candidates.length <= 1) return { eligible: false, reason: 'single_candidate' };
  const local = candidates.find((item) => item.id === consultation.localCandidateId);
  const alternatives = candidates.filter((item) => item.id !== consultation.localCandidateId);
  const playAlternatives = alternatives.filter((item) => item.action === 'play');
  const localScore = Number(local?.localScore);
  const scoredAlternatives = alternatives
    .map((item) => Number(item.localScore))
    .filter(Number.isFinite);
  const nearestGap = Number.isFinite(localScore) && scoredAlternatives.length
    ? Math.min(...scoredAlternatives.map((score) => Math.abs(localScore - score)))
    : null;
  const localPassVsPlay = local?.action === 'pass' && playAlternatives.length > 0;
  const differentTypes = playAlternatives.some((item) => item.hand?.type !== local?.hand?.type);
  const scoreAmbiguous = nearestGap != null && nearestGap <= 180;
  const missingComparableScore = !Number.isFinite(localScore)
    || (playAlternatives.length > 0 && scoredAlternatives.length === 0);
  const ambiguous = localPassVsPlay || scoreAmbiguous || missingComparableScore
    || (differentTypes && nearestGap != null && nearestGap <= 300);
  const firstValidation = (state.llmReport?.cloudCalls || 0) === 0;
  if ((state.settings?.llmPolicyMode || LLM_POLICY_MODE.LOCAL) === LLM_POLICY_MODE.AUTO
    && (!preflight.critical || !ambiguous)) {
    return { eligible: false, reason: 'stable_local_choice', nearestGap };
  }
  if (!firstValidation && !preflight.critical && !ambiguous) {
    return { eligible: false, reason: 'stable_local_choice', nearestGap };
  }
  return { eligible: true, reason: firstValidation ? 'first_validation' : 'strategic_rerank', nearestGap };
}

function resolveLLMDecision(remote, consultation, state, seat) {
  if (!remote || !remote.candidateId) throw new Error('云端未返回候选牌 ID');
  const confidence = Number.isFinite(Number(remote.confidence))
    ? Math.max(0, Math.min(1, Number(remote.confidence)))
    : 0.5;
  const useLocalChoice = confidence < 0.45 && consultation?.localCandidateId;
  const candidateId = useLocalChoice ? consultation.localCandidateId : remote.candidateId;
  const candidate = (consultation?.candidates || []).find((item) => item.id === candidateId);
  if (!candidate) throw new Error('云端选择不在本地候选集中');
  if (candidate.action === 'pass') {
    if (!state.lastHand) throw new Error('领出阶段不能过牌');
    return {
      action: 'pass',
      reason: useLocalChoice ? '云端置信度不足，采用本地 AI：保留牌力' : '云端增强：保留牌力',
      confidence,
      llmCandidateId: candidateId,
      llmRemoteCandidateId: remote.candidateId,
    };
  }
  const byId = new Map((state.hands[seat] || []).map((card) => [String(card.id), card]));
  const cards = (candidate.cards || []).map((card) => byId.get(String(card.id))).filter(Boolean);
  if (cards.length !== (candidate.cards || []).length) throw new Error('云端返回了不属于本家手牌的牌');
  const legal = isLegalPlay(cards, state.currentLevel, state.lastHand, candidate.signature || null);
  if (!legal.ok) throw new Error(`云端返回非法牌型：${legal.reason || '无法压过上手'}`);
  return {
    action: 'play',
    cards,
    hand: legal.hand,
    reason: useLocalChoice
      ? `云端置信度 ${Math.round(confidence * 100)}%，采用本地 AI 候选`
      : `云端增强（置信度 ${Math.round(confidence * 100)}%）`,
    projectedTricks: candidate.projectedTricks ?? null,
    llmCandidateId: candidateId,
    llmRemoteCandidateId: remote.candidateId,
    confidence,
  };
}

function resolveLocalConsultation(consultation, state, seat, reasonPrefix = '本地 AI') {
  if (!consultation?.localCandidateId) return null;
  const decision = resolveLLMDecision(
    { candidateId: consultation.localCandidateId, confidence: 1 },
    consultation,
    state,
    seat,
  );
  decision.reason = `${reasonPrefix}：${consultation.reason || decision.reason || '采用本地候选'}`;
  // 本地咨询已完成的混合搜索并不会因为最终仍采用本地候选而失效。保留
  // 该遥测，才能让 Worker 座位与 0 号同步路径使用同一统计口径；尤其是
  // force-expert 消融臂必须记录 wouldChange，不能悄悄退化成普通 expert。
  decision.hybrid = consultation.hybrid || null;
  return decision;
}

function activateLLMFallback(state, error) {
  if (state.llmFallbackActive) return;
  state.llmCircuit = {
    state: 'disabled',
    failureCount: Math.max(1, Number(state.llmCircuit?.failureCount) || 0),
    retryAt: 0,
    permanent: true,
    lastErrorCode: String(error?.code || 'configuration_error').slice(0, 80),
  };
  state.llmFallbackActive = true;
  state.llmStatus = 'fallback';
  state.llmLastError = String(error?.message || error || '云端 API 不可用').slice(0, 160);
  state.llmReport = normalizeLLMReport(state.llmReport, state.settings?.llmPolicyMode);
  state.llmReport.fallbackActive = true;
  pushMsg(state, `云端 API 配置/协议故障，已使用全场景本地 AI：${state.llmLastError}`);
}

function registerLLMFailure(state, error) {
  let failureClass = error?.failureClass || (error?.retryable === false ? 'configuration' : 'transient');
  const errorCode = String(error?.code || '');
  const hardConfigurationCodes = new Set([
    'provider_auth', 'not_configured', 'gateway_outdated',
    'invalid_config', 'health_configuration_error', 'unsafe_provider_url',
  ]);
  const providerAlreadyWorked = Number(state.llmReport?.successes) > 0;
  const hardConfigurationFailure = failureClass === 'configuration'
    && (!providerAlreadyWorked || hardConfigurationCodes.has(errorCode));
  if (hardConfigurationFailure) {
    activateLLMFallback(state, error);
    return { failureClass: 'configuration', retryAt: 0 };
  }
  // Once the same provider/model has already completed a real decision, one
  // later protocol/HTTP-400 anomaly cannot prove the global configuration is
  // invalid.  Treat it as a recoverable request failure instead of disabling
  // cloud play for the rest of the round.
  if (failureClass === 'configuration') failureClass = 'transient';
  if (failureClass === 'request') {
    state.llmStatus = 'degraded';
    state.llmLastError = String(error?.message || error || '云端请求失败').slice(0, 160);
    return { failureClass: 'request', retryAt: 0 };
  }
  const circuit = normalizeLLMCircuit(state.llmCircuit);
  const failureCount = Math.min(20, circuit.failureCount + 1);
  const delay = LLM_BACKOFF_MS[Math.min(LLM_BACKOFF_MS.length - 1, failureCount - 1)];
  state.llmCircuit = {
    state: 'open',
    failureCount,
    retryAt: Date.now() + delay,
    permanent: false,
    lastErrorCode: String(error?.code || 'transient_error').slice(0, 80),
  };
  state.llmFallbackActive = false;
  state.llmStatus = 'retry_wait';
  state.llmLastError = String(error?.message || error || '云端 API 临时不可用').slice(0, 160);
  state.llmReport = normalizeLLMReport(state.llmReport, state.settings?.llmPolicyMode);
  state.llmReport.fallbackActive = false;
  pushMsg(state, failureClass === 'model_output'
    ? `云端模型本手输出格式异常，已由本地 AI 接管；约 ${Math.ceil(delay / 1000)} 秒后自动重试`
    : `云端 API 临时故障，本手已回退本地 AI；约 ${Math.ceil(delay / 1000)} 秒后在下一关键回合自动重试`);
  return { failureClass, retryAt: state.llmCircuit.retryAt };
}

function registerLLMSuccess(state) {
  state.llmCircuit = createLLMCircuit();
  state.llmFallbackActive = false;
  state.llmStatus = 'online';
  state.llmLastError = null;
  state.llmReport = normalizeLLMReport(state.llmReport, state.settings?.llmPolicyMode);
  state.llmReport.fallbackActive = false;
}

function maybeAutoPlay(state) {
  if (state.phase !== PHASE.PLAYING) {
    notify(state);
    return;
  }
  if (state.aiThinking) return;
  if (state.finishOrder.includes(state.currentSeat)) {
    const n = nextActiveSeatCW(state, state.currentSeat);
    if (n == null) {
      endRound(state);
      return;
    }
    state.currentSeat = n;
    maybeAutoPlay(state);
    return;
  }
  if (state.currentSeat === 0) {
    resetHumanAssistance(state);
    if (state.settings?.coachMode) updateCoachTip(state);
    else state.coachTip = null;
    if (state.settings?.coachMode && state.coachTip) markAssistance(state, 'coach_view');
    notify(state);
    return; // 等人
  }

  notify(state);
  // AI 延迟
  if (_aiTimer) clearTimeout(_aiTimer);
  const speed = state.settings?.aiSpeed || 'normal';
  const [base, spread] = AI_SPEED_MS[speed] || AI_SPEED_MS.normal;
  _aiTimer = setTimeout(() => {
    runAI(state);
  }, base + Math.random() * spread);
}

async function runAI(state) {
  _aiTimer = null;
  if (state.phase !== PHASE.PLAYING) return;
  const seat = state.currentSeat;
  if (seat === 0 || state.finishOrder.includes(seat)) {
    maybeAutoPlay(state);
    return;
  }
  if (state.aiThinking) return;

  const token = ++_aiRequestSerial;
  state.aiRequestToken = token;
  state.aiThinking = true;
  state.llmLastLatencyMs = null;
  const handSnapshot = (state.hands[seat] || []).map((card) => String(card.id)).join(',');
  const context = aiDecisionContext(state, seat);
  context.timeBudgetMs = aiSearchBudget(state);
  const policyModeAtStart = state.settings?.llmPolicyMode || LLM_POLICY_MODE.LOCAL;
  const preflight = llmPreflight(state, seat);
  let cloudEligible = false;
  state.llmReport = normalizeLLMReport(state.llmReport, policyModeAtStart);
  state.llmReport.mode = policyModeAtStart;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const isCurrent = () => (
    state.aiRequestToken === token
    && _aiRequestSerial === token
    && state.phase === PHASE.PLAYING
    && state.currentSeat === seat
    && !state.finishOrder.includes(seat)
    && (state.hands[seat] || []).map((card) => String(card.id)).join(',') === handSnapshot
  );
  let decision = null;
  let consultation = null;
  let cloudAttempted = false;
  let localDecisionLatencyMs = null;
  let localDecisionSource = null;
  let localFallbackKind = 'none';
  try {
    setAIDifficulty(state.settings?.difficulty || 'normal');
    if (preflight.eligible) {
      const localStartedAt = Date.now();
      consultation = getAIConsultation(context);
      localDecisionLatencyMs = Date.now() - localStartedAt;
      localDecisionSource = 'consultation';
      if (!consultation?.candidates?.length) throw new Error('本地没有可提交的合法候选牌');
      const consultationGate = llmConsultationGate(state, seat, consultation, preflight);
      cloudEligible = consultationGate.eligible;
      if (!cloudEligible) {
        state.llmReport.localTurns += 1;
        recordLLMEvent(state, {
          status: 'skipped',
          candidateCount: consultation.candidates.length,
          source: consultationGate.reason,
          reason: consultationGate.reason,
          localCandidateId: consultation.localCandidateId,
          executedCandidateId: consultation.localCandidateId,
        });
        decision = resolveLocalConsultation(
          consultation, state, seat,
          consultationGate.reason === 'single_candidate'
            ? '本地硬策略已确定，跳过云端调用'
            : '本地候选优势明确，跳过云端调用',
        );
      } else {
        state.llmReport.cloudEligibleTurns += 1;
        cloudAttempted = true;
        _activeAIRequestController = controller;
        notify(state, { persist: false });
        const startedAt = Date.now();
        let remote = null;
        let cloudError = null;
        let cloudFailureDisposition = null;
        let cloudLatencyMs = null;
        try {
          remote = await requestLLMDecision({
            context: {
              ...llmContextView(context),
              cloudConstraint: consultation.cloudConstraint || 'soft_rerank',
              localCandidateId: consultation.localCandidateId || null,
            },
            candidates: consultation.candidates,
            mode: policyModeAtStart,
            signal: controller?.signal || null,
          });
        } catch (error) {
          cloudError = error;
          cloudLatencyMs = Date.now() - startedAt;
          if (!isCurrent()) return;
          if (state.settings?.llmPolicyMode === policyModeAtStart) {
            cloudFailureDisposition = registerLLMFailure(state, error);
          }
        }
        if (!isCurrent()) return;
        const policyUnchanged = state.settings?.llmPolicyMode === policyModeAtStart
          && !state.llmFallbackActive;
        if (cloudError) {
          recordLLMEvent(state, {
            status: 'fallback',
            latencyMs: cloudLatencyMs,
            candidateCount: consultation.candidates.length,
            source: 'local_fallback',
            reason: 'cloud_request_failed',
            error: cloudError.message,
            errorCode: cloudError.code,
            retryable: cloudFailureDisposition?.failureClass === 'configuration'
              ? false
              : cloudFailureDisposition
                ? true
                : cloudError.retryable !== false,
            failureClass: cloudFailureDisposition?.failureClass
              || cloudError.failureClass
              || (cloudError.retryable === false ? 'configuration' : 'transient'),
            requestId: cloudError.requestId,
            localCandidateId: consultation.localCandidateId,
            executedCandidateId: consultation.localCandidateId,
            provider: cloudError.provider,
            model: cloudError.model,
            usage: cloudError.usage,
          });
        } else if (remote && policyUnchanged) {
          cloudLatencyMs = Date.now() - startedAt;
          try {
            decision = resolveLLMDecision(remote, consultation, state, seat);
            const llmMeta = remote._llm || {};
            state.llmLastLatencyMs = cloudLatencyMs;
            registerLLMSuccess(state);
            const localCandidateId = consultation.localCandidateId || null;
            const cloudCandidateId = remote.candidateId || null;
            const executedCandidateId = decision.llmCandidateId || localCandidateId;
            const cloudChangedDecision = !!localCandidateId && executedCandidateId !== localCandidateId;
            decision.llm = {
              requestId: llmMeta.requestId || null,
              localCandidateId,
              cloudCandidateId,
              executedCandidateId,
              cloudChangedDecision,
              provider: llmMeta.provider || null,
              model: llmMeta.model || null,
              latencyMs: cloudLatencyMs,
            };
            recordLLMEvent(state, {
              status: 'success',
              latencyMs: cloudLatencyMs,
              candidateCount: consultation.candidates.length,
              confidence: remote.confidence,
              source: Number(remote.confidence) < 0.45 ? 'local_low_confidence' : 'cloud',
              reason: Number(remote.confidence) < 0.45 ? 'low_confidence_local_choice' : 'cloud_choice',
              provider: llmMeta.provider,
              model: llmMeta.model,
              usage: llmMeta.usage,
              requestId: llmMeta.requestId,
              localCandidateId,
              cloudCandidateId,
              executedCandidateId,
              cloudChangedDecision,
            });
          } catch (error) {
            error.code = error.code || 'client_validation_failed';
            error.retryable = true;
            error.failureClass = 'model_output';
            recordLLMEvent(state, {
              status: 'fallback',
              latencyMs: cloudLatencyMs,
              candidateCount: consultation.candidates.length,
              source: 'local_fallback',
              reason: 'cloud_response_invalid',
              error: error.message,
              errorCode: error.code,
              retryable: true,
              failureClass: 'model_output',
              requestId: remote._llm?.requestId,
              localCandidateId: consultation.localCandidateId,
              cloudCandidateId: remote.candidateId,
              executedCandidateId: consultation.localCandidateId,
              provider: remote._llm?.provider,
              model: remote._llm?.model,
              usage: remote._llm?.usage,
            });
            registerLLMFailure(state, error);
          }
        }
      }
    } else {
      state.llmReport.localTurns += 1;
      if (policyModeAtStart !== LLM_POLICY_MODE.LOCAL
        && ['circuit_backoff', 'round_budget', 'not_critical'].includes(preflight.reason)) {
        recordLLMEvent(state, {
          status: 'skipped',
          source: preflight.reason,
          reason: preflight.reason,
          error: preflight.reason === 'circuit_backoff' ? state.llmLastError : null,
          errorCode: state.llmCircuit?.lastErrorCode,
          retryable: preflight.reason === 'circuit_backoff' ? true : null,
        });
      }
    }
    if (!isCurrent()) return;

    // 云端未参与、失败或返回不合法时，复用已经完成的本地咨询，避免整套策略重算。
    if (!decision) {
      try {
        if (consultation) {
          decision = resolveLocalConsultation(
            consultation, state, seat, cloudAttempted ? '云端回退本地 AI' : '本地 AI',
          );
        } else {
          const localStartedAt = Date.now();
          try {
            decision = await requestAIDecision(context, {
              timeoutMs: Math.max(2000, (context.timeBudgetMs || 250) + 1500),
            });
            localDecisionLatencyMs = Date.now() - localStartedAt;
            localDecisionSource = 'worker';
          } catch (error) {
            // Worker timeout/error is still a measured local decision attempt.
            // Preserve its elapsed time and source so strict performance gates
            // cannot silently drop the failed search-triggered turn.
            localDecisionLatencyMs = Date.now() - localStartedAt;
            localDecisionSource = 'worker';
            throw error;
          }
        }
      } catch (error) {
        state.llmLastError = String(error?.message || error || '本地 AI 决策失败').slice(0, 160);
        localFallbackKind = error?.name === 'TimeoutError' || error?.code === 'timeout'
          ? 'local_timeout' : 'local_decision_error';
        decision = state.lastHand ? { action: 'pass', reason: '本地 AI 暂时无法接牌' } : null;
      }
    }
    if (decision?.localFallbackKind && localFallbackKind === 'none') {
      localFallbackKind = decision.localFallbackKind;
    }
    if (!isCurrent()) return;
    const localDecision = {
      budgetMs: context.timeBudgetMs || 0,
      latencyMs: Number.isFinite(localDecisionLatencyMs) ? localDecisionLatencyMs : null,
      source: localDecisionSource,
    };
    observeAIDecision(state, context, decision);
    if (!decision || decision.action === 'pass') {
      if (!state.lastHand) {
        // 必须出 — 兜底出最小单张
        const c = state.hands[seat][state.hands[seat].length - 1];
        const hand = parseHand([c], state.currentLevel);
        applyPlay(state, seat, [c], hand, null, {
          reason: '兜底领出最小单张',
          ...decisionTelemetryMeta(
            decision,
            localFallbackKind !== 'none' ? localFallbackKind : 'forced_lead',
          ),
          localDecision,
        });
        advanceAfterPlay(state);
        return;
      }
      applyPass(state, seat, null, {
        reason: decision?.reason || 'AI 选择过牌',
        projectedTricks: decision?.projectedTricks ?? null,
        llm: decision?.llm || null,
        hybrid: decision?.hybrid || null,
        ...decisionTelemetryMeta(decision, localFallbackKind),
        localDecision,
      });
      advanceAfterPass(state);
      return;
    }

    applyPlay(state, seat, decision.cards, decision.hand, null, {
      reason: decision.reason || '',
      projectedTricks: decision.projectedTricks ?? null,
      llm: decision.llm || null,
      hybrid: decision.hybrid || null,
      ...decisionTelemetryMeta(decision, localFallbackKind),
      localDecision,
    });
    advanceAfterPlay(state);
  } catch (error) {
    if (isCurrent()) {
      state.llmLastError = String(error?.message || error || 'AI 决策失败').slice(0, 160);
    }
  } finally {
    if (_activeAIRequestController === controller) _activeAIRequestController = null;
    if (state.aiRequestToken === token && _aiRequestSerial === token) {
      state.aiThinking = false;
      if (state.phase === PHASE.PLAYING) maybeAutoPlay(state);
      else notify(state);
    }
  }
}

// Every AI turn must carry explicit search/fallback fields.  Non-hybrid
// expert turns are valid no-search decisions; malformed hybrid metadata stays
// unknown so the strict telemetry gate rejects it instead of treating it as a
// clean no-search turn.
function decisionTelemetryMeta(decision, fallbackKind = 'none') {
  const hybrid = decision?.hybrid;
  if (fallbackKind !== 'none') {
    if (hybrid == null) {
      return {
        // A timeout/error means the worker may have entered search before it
        // failed.  Unknown is safer than claiming a clean no-search turn.
        searchAttempted: ['local_timeout', 'local_decision_error'].includes(fallbackKind)
          ? null : false,
        searchTriggered: ['local_timeout', 'local_decision_error'].includes(fallbackKind)
          ? null : false,
        fallbackKind,
      };
    }
    if (typeof hybrid !== 'object'
      || typeof hybrid.searchAttempted !== 'boolean'
      || typeof hybrid.searchTriggered !== 'boolean') {
      return {
        searchAttempted: null,
        searchTriggered: null,
        fallbackKind,
      };
    }
    return {
      searchAttempted: hybrid.searchAttempted,
      searchTriggered: hybrid.searchTriggered,
      fallbackKind,
    };
  }
  if (hybrid == null) {
    return {
      searchAttempted: false,
      searchTriggered: false,
      fallbackKind: 'none',
    };
  }
  if (typeof hybrid !== 'object'
    || typeof hybrid.searchAttempted !== 'boolean'
    || typeof hybrid.searchTriggered !== 'boolean') {
    return {
      searchAttempted: null,
      searchTriggered: null,
      fallbackKind: null,
    };
  }
  return {
    searchAttempted: hybrid.searchAttempted,
    searchTriggered: hybrid.searchTriggered,
    fallbackKind: typeof hybrid.fallbackKind === 'string' && hybrid.fallbackKind
      ? hybrid.fallbackKind : 'none',
  };
}

function evaluationSnapshot(ev) {
  if (!ev) return null;
  return {
    score: ev.score,
    grade: ev.grade,
    stars: ev.stars,
    summary: ev.summary,
    tips: ev.tips || [],
    dimensions: ev.dimensions || {},
    breakdown: ev.breakdown || [],
    mistakeTags: ev.mistakeTags || [],
    assisted: !!ev.assisted,
    assistanceTypes: ev.assistanceTypes || [],
    forced: !!ev.forced,
    betterAlternative: ev.betterAlternative ? {
      label: ev.betterAlternative.label,
      cards: (ev.betterAlternative.cards || []).map(cloneCard),
    } : null,
  };
}

function summarySnapshot(summary) {
  if (!summary) return null;
  return {
    avg: summary.avg,
    count: summary.count,
    advice: summary.advice || [],
    grades: summary.grades || {},
    dimensionAverages: summary.dimensionAverages || {},
    mistakeCounts: summary.mistakeCounts || {},
    best: evaluationSnapshot(summary.best),
    worst: evaluationSnapshot(summary.worst),
  };
}

function endRound(state) {
  if (state.replayRoundEndEmitted) return;
  state.replayRoundEndEmitted = true;
  state.phase = PHASE.ROUND_END;
  closeReplayTrick(state);
  const fo = state.finishOrder;
  const head = fo[0];
  const winTeam = teamOf(head);
  // 升级：双上+3 / 头三+2 / 头末+1
  const upInfo = describeUpgrade(fo, teamOf);
  const up = upInfo.levels;

  const oldLevel = state.levels[winTeam];
  const activeLevelTeam = state.levelOwner;
  const activeLevelName = activeLevelTeam === 0 ? '我方' : '对方';
  const isActiveAAttempt = state.currentLevel === 14
    && state.levels[activeLevelTeam] === 14;

  const teamName = winTeam === 0 ? '我方' : '对方';
  const places = fo.map((s, i) => `${['头', '二', '三', '末'][i]}游 ${seatName(s)}`).join('，');
  pushMsg(state, `本副结束：${places}`);
  pushMsg(state, `升级判定：${upInfo.label}`);

  if (isActiveAAttempt && canPassA(fo, teamOf, activeLevelTeam)) {
    // 只有“本副正在打 A”的级牌归属方可以过 A，不能借对方的级数直接获胜。
    state.winner = activeLevelTeam;
    state.phase = PHASE.MATCH_END;
    pushMsg(
      state,
      `🎉 ${activeLevelName} 本副打 A 成功（本方取得头游且对家为二游/三游），整场胜利！`,
    );
  } else {
    let activeTeamReset = false;
    if (isActiveAAttempt) {
      state.aFailCount[activeLevelTeam] += 1;
      const failed = state.aFailCount[activeLevelTeam];
      pushMsg(
        state,
        `${activeLevelName} 本副正在打 A，但未取得头游+二游/三游，过 A 失败（${failed}/3）`,
      );
      if (failed >= 3) {
        state.levels[activeLevelTeam] = 2;
        state.aFailCount[activeLevelTeam] = 0;
        activeTeamReset = true;
        pushMsg(state, `${activeLevelName} 连续三次在本方 A 级未过关，打回 2 级`);
      }
    }

    // 头游方照常处理自己的级数；但已在 A 的一方只有轮到本方打 A 时才能过关。
    if (!(activeTeamReset && winTeam === activeLevelTeam)) {
      if (oldLevel === 14) {
        state.levels[winTeam] = 14;
        if (!isActiveAAttempt || winTeam !== activeLevelTeam) {
          pushMsg(
            state,
            `${teamName} 本副在对方级数获胜，但本方已到 A；下副轮到本方打 A，不能直接过关`,
          );
        }
      } else {
        const newLevel = nextLevel(oldLevel, up);
        state.levels[winTeam] = newLevel;
        const from = LEVEL_LABEL[oldLevel];
        const to = LEVEL_LABEL[newLevel];
        if (newLevel === 14) {
          pushMsg(state, `${teamName} ${from} → ${to}（升 ${up} 级，下副开始打 A）`);
        } else {
          pushMsg(state, `${teamName} ${from} → ${to}（升 ${up} 级）`);
        }
      }
    }
  }

  pushMsg(state, `当前级数：我方 ${LEVEL_LABEL[state.levels[0]]} ／ 对方 ${LEVEL_LABEL[state.levels[1]]}`);

  state.lastRoundResult = {
    finishOrder: fo.slice(),
    winTeam,
    up,
    upLabel: upInfo.label,
    upCode: upInfo.code,
  };
  state.prevFinishOrder = fo.slice();
  state.prevHeadTeam = winTeam;

  // 局后评价
  state.roundSummary = summarizeSession(state.evalHistory);
  state.handTips = analyzeHandStructure(state.hands[0], state.currentLevel);

  const myPlace = fo.indexOf(0);
  const teamWon = winTeam === 0;
  const matchEnded = state.phase === PHASE.MATCH_END;
  const matchWon = matchEnded && state.winner === 0;

  // 复盘快照
  const replay = {
    id: `${Date.now()}_${state.round}`,
    round: state.round,
    level: state.currentLevel,
    levels: state.levels.slice(),
    finishOrder: fo.slice(),
    places: fo.map((s) => seatName(s)),
    up,
    upLabel: upInfo.label,
    winTeam,
    startedAt: state.roundStartedAt,
    endedAt: new Date().toISOString(),
    initialHands: (state.roundInitialHands || []).map((hand) => hand.map(cloneCard)),
    remainingHands: state.hands.map((hand) => hand.map(cloneCard)),
    trickLog: state.trickLog.map((t) => ({
      turn: t.turn,
      trickNumber: t.trickNumber,
      seat: t.seat,
      action: t.action,
      text: t.text,
      cards: t.cards ? t.cards.map(cloneCard) : null,
      handType: t.hand ? formatHand(t.hand) : null,
      signature: t.signature || null,
      countsBefore: t.countsBefore || null,
      countsAfter: t.countsAfter || null,
      evaluation: evaluationSnapshot(t.evaluation),
      decisionMeta: t.decisionMeta || null,
    })),
    evalHistory: (state.evalHistory || []).map(evaluationSnapshot),
    roundSummary: summarySnapshot(state.roundSummary),
    llmReport: llmReportSnapshot(state.llmReport),
    difficulty: state.settings?.difficulty || 'normal',
    localAiEngine: state.settings?.localAiEngine || 'expert',
    time: new Date().toISOString(),
  };
  state.lastReplay = replay;
  state.matchHistory.push({
    round: state.round,
    myPlace,
    teamWon,
    up,
    avgEval: state.roundSummary?.avg || 0,
  });
  saveReplay(replay);

  const updatedStats = recordRoundResult({
    myPlace,
    teamWon,
    evalHistory: state.evalHistory,
    matchEnded,
    matchWon,
    difficulty: state.settings?.difficulty || 'normal',
    llmReport: state.llmReport,
    publicHistory: publicActionHistory(state),
    userSeat: 0,
    opponentModelMode: state.settings?.opponentModelMode || 'adaptive',
  });
  state.opponentModel = updatedStats.opponentModel;

  finalizeSealedTrainingBatch(state, {
    publicImplementationSha256: REPLAY_IMPLEMENTATION_SHA256,
  });
  emitReplayRoundEnd(state);

  notify(state);
}

function updateCoachTip(state) {
  if (state.phase !== PHASE.PLAYING || state.currentSeat !== 0) {
    state.coachTip = null;
    return;
  }
  if (state.finishOrder.includes(0)) {
    state.coachTip = null;
    return;
  }
  try {
    const d = recommendPlay({
      seat: 0,
      hand: state.hands[0],
      level: state.currentLevel,
      lastHand: state.lastHand,
      lastSeat: state.lastSeat,
      handCounts: state.handCounts,
      teams: TEAM_OF,
      finishOrder: state.finishOrder,
      playedCards: state.trickLog.flatMap((item) => item.cards || []),
      publicHistory: publicActionHistory(state),
      tributeContext: getPublicTributeContext(state, 0),
      difficulty: state.settings?.difficulty || 'normal',
      leadAfterOwnBomb: isLeadAfterOwnBomb(state, 0),
    });
    if (!d) {
      state.coachTip = { action: 'pass', text: '建议：过牌（无合适出法）' };
    } else if (d.action === 'pass') {
      state.coachTip = {
        action: 'pass',
        reason: d.reason || '保留实力',
        alternatives: d.alternatives || [],
        text: `教练建议：过牌。${d.reason || '保留实力'}`,
      };
    } else {
      state.coachTip = {
        action: 'play',
        cards: d.cards,
        hand: d.hand,
        signature: d.signature || handSignature(d.hand),
        reason: d.reason || '',
        projectedTricks: d.projectedTricks ?? null,
        alternatives: d.alternatives || [],
        text: `教练建议：出 ${d.cards.map(cardLabel).join(' ')}（${formatHand(d.hand)}）。${d.reason || ''}`,
      };
    }
  } catch {
    state.coachTip = null;
  }
}

/** 手动刷新教练建议并可选选中 */
export function refreshCoach(state, applySelect = false) {
  markAssistance(state, applySelect ? 'coach_apply' : 'coach_view');
  updateCoachTip(state);
  if (applySelect && state.coachTip?.action === 'play' && state.coachTip.cards) {
    state.selectedIds = new Set(state.coachTip.cards.map((c) => c.id));
    state.selectedDeclaration = state.coachTip.signature || handSignature(state.coachTip.hand);
  }
  notify(state);
  return state.coachTip;
}

export function getSkillStats() {
  const s = loadStats();
  return { ...s, avg: avgScore(s), unassistedAvg: unassistedAvgScore(s) };
}

export { AI_DIFFICULTY_LABEL };

export function nextRound(state) {
  if (state.phase === PHASE.MATCH_END) {
    // 新比赛
    return startMatch(state);
  }
  if (state.phase !== PHASE.ROUND_END) return state;
  startRound(state);
  return state;
}

export function getReturnCandidates(state) {
  if (state.phase !== PHASE.RETURN) return [];
  const ts = state.tributeState;
  if (!ts?.pendingReturns?.length || ts.pendingReturns[0].from !== 0) return [];
  const hand = state.hands[0] || [];
  // 标准训练口径：有 10 以下（含 10）的非级牌时必须从中还贡。
  const preferred = hand.filter((c) => !isJoker(c) && !isLevelCard(c, state.currentLevel) && c.rank <= 10);
  if (preferred.length) return preferred;
  // 没有合规小牌时，只能还当前最小牌（同大小可任选）。
  const nonWild = hand.filter((c) => !isJoker(c) && !isWild(c, state.currentLevel));
  const pool = nonWild.length ? nonWild : hand;
  if (!pool.length) return [];
  const minPower = Math.min(...pool.map((c) => soloPower(c, state.currentLevel)));
  return pool.filter((c) => soloPower(c, state.currentLevel) === minPower);
}

export function getLegalHints(state) {
  if (state.phase !== PHASE.PLAYING || state.currentSeat !== 0) return [];
  markAssistance(state, 'hint');
  return generateLegalPlays(state.hands[0], state.currentLevel, state.lastHand)
    .sort((a, b) => {
      const bombish = (h) => h.type === 'bomb' || h.type === 'flush_straight' || h.type === 'joker_bomb';
      const ab = bombish(a.hand) ? 1 : 0;
      const bb = bombish(b.hand) ? 1 : 0;
      return ab - bb || a.hand.power - b.hand.power || b.cards.length - a.cards.length;
    })
    .slice(0, 12);
}

export function getHandAnalysis(state) {
  return analyzeHandStructure(state.hands[0], state.currentLevel);
}

function pushMsg(state, text) {
  state.messages.push({ text, t: Date.now() });
  if (state.messages.length > 80) state.messages.splice(0, state.messages.length - 80);
}

export { SEAT_NAMES, TEAM_OF };
