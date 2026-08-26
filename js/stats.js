/**
 * 训练统计、复盘与进行中牌局持久化（localStorage）。
 * 所有写入均安全降级，隐私模式或空间不足时不会中断对局。
 */

const KEY = 'guandan_skill_stats_v1';
const SETTINGS_KEY = 'guandan_settings_v1';
const REPLAY_KEY = 'guandan_replays_v1';
const ACTIVE_MATCH_KEY = 'guandan_active_match_v2';
const DATA_VERSION = 2;
const REPLAY_LIMIT = 100;

/** 浏览器 localStorage；Node 下用内存 mock，避免测试崩溃 */
const memoryStore = new Map();
function storage() {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch { /* ignore */ }
  return {
    getItem: (k) => (memoryStore.has(k) ? memoryStore.get(k) : null),
    setItem: (k, v) => { memoryStore.set(k, String(v)); },
    removeItem: (k) => { memoryStore.delete(k); },
  };
}

function safeSet(key, value) {
  try {
    storage().setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function safeRemove(key) {
  try {
    storage().removeItem(key);
    return true;
  } catch {
    return false;
  }
}

const emptyDifficulty = () => ({
  easy: { rounds: 0, evalCount: 0, evalSum: 0 },
  normal: { rounds: 0, evalCount: 0, evalSum: 0 },
  hard: { rounds: 0, evalCount: 0, evalSum: 0 },
  master: { rounds: 0, evalCount: 0, evalSum: 0 },
});

const emptyLLMStats = () => ({
  rounds: 0,
  eligibleTurns: 0,
  localTurns: 0,
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
});

const defaultStats = () => ({
  version: DATA_VERSION,
  totalRounds: 0,
  winsAsHead: 0,
  finishes: [0, 0, 0, 0],
  teamWins: 0,
  teamLosses: 0,
  evalCount: 0,
  evalSum: 0,
  unassistedEvalCount: 0,
  unassistedEvalSum: 0,
  assistedEvalCount: 0,
  forcedEvalCount: 0,
  gradeCounts: { 神来之笔: 0, 优秀: 0, 良好: 0, 一般: 0, 待改进: 0 },
  mistakeCounts: {},
  difficulty: emptyDifficulty(),
  llm: emptyLLMStats(),
  scoreTrend: [],
  matchWins: 0,
  matchLosses: 0,
  lastUpdated: null,
});

function mergeStats(raw) {
  const base = defaultStats();
  const parsed = raw && typeof raw === 'object' ? raw : {};
  const difficulty = emptyDifficulty();
  for (const key of Object.keys(difficulty)) {
    difficulty[key] = { ...difficulty[key], ...(parsed.difficulty?.[key] || {}) };
  }
  return {
    ...base,
    ...parsed,
    version: DATA_VERSION,
    finishes: Array.isArray(parsed.finishes) ? [...parsed.finishes.slice(0, 4), 0, 0, 0, 0].slice(0, 4) : base.finishes,
    gradeCounts: { ...base.gradeCounts, ...(parsed.gradeCounts || {}) },
    mistakeCounts: { ...(parsed.mistakeCounts || {}) },
    difficulty,
    llm: { ...base.llm, ...(parsed.llm || {}) },
    scoreTrend: Array.isArray(parsed.scoreTrend) ? parsed.scoreTrend.slice(-100) : [],
  };
}

export function loadStats() {
  try {
    const raw = storage().getItem(KEY);
    return raw ? mergeStats(JSON.parse(raw)) : defaultStats();
  } catch {
    return defaultStats();
  }
}

export function saveStats(stats) {
  const next = mergeStats(stats);
  next.lastUpdated = new Date().toISOString();
  const ok = safeSet(KEY, next);
  if (ok) Object.assign(stats, next);
  return ok;
}

export function recordRoundResult({
  myPlace,
  teamWon,
  evalHistory,
  matchEnded,
  matchWon,
  difficulty = 'normal',
  llmReport = null,
}) {
  const s = loadStats();
  s.totalRounds += 1;
  if (myPlace >= 0 && myPlace < 4) s.finishes[myPlace] += 1;
  if (myPlace === 0) s.winsAsHead += 1;
  if (teamWon) s.teamWins += 1;
  else s.teamLosses += 1;

  const bucket = s.difficulty[difficulty] || s.difficulty.normal;
  bucket.rounds += 1;
  const decisions = evalHistory || [];
  let roundSum = 0;
  let cleanSum = 0;
  let cleanCount = 0;

  for (const ev of decisions) {
    const score = Number(ev.score) || 0;
    s.evalCount += 1;
    s.evalSum += score;
    roundSum += score;
    bucket.evalCount += 1;
    bucket.evalSum += score;
    if (ev.grade && s.gradeCounts[ev.grade] != null) s.gradeCounts[ev.grade] += 1;

    if (ev.forced) s.forcedEvalCount += 1;
    if (ev.assisted) s.assistedEvalCount += 1;
    if (!ev.forced && !ev.assisted) {
      s.unassistedEvalCount += 1;
      s.unassistedEvalSum += score;
      cleanCount += 1;
      cleanSum += score;
    }
    for (const tag of ev.mistakeTags || []) {
      s.mistakeCounts[tag] = (s.mistakeCounts[tag] || 0) + 1;
    }
  }

  if (matchEnded) {
    if (matchWon) s.matchWins += 1;
    else s.matchLosses += 1;
  }

  const report = llmReport && typeof llmReport === 'object' ? llmReport : null;
  const llm = s.llm || emptyLLMStats();
  if (report) {
    llm.rounds += 1;
    llm.eligibleTurns += Number(report.cloudEligibleTurns) || 0;
    llm.localTurns += Number(report.localTurns) || 0;
    llm.cloudCalls += Number(report.cloudCalls) || 0;
    llm.successes += Number(report.successes) || 0;
    llm.failures += Number(report.failures) || 0;
    llm.fallbacks += Number(report.fallbacks) || 0;
    llm.skipped += Number(report.skipped) || 0;
    llm.totalLatencyMs += Number(report.totalLatencyMs) || 0;
    llm.promptTokens += Number(report.promptTokens) || 0;
    llm.completionTokens += Number(report.completionTokens) || 0;
    llm.totalTokens += Number(report.totalTokens) || 0;
    llm.estimatedTokenCalls += Number(report.estimatedTokenCalls) || 0;
    llm.cloudAgreements += Number(report.cloudAgreements) || 0;
    llm.cloudOverrides += Number(report.cloudOverrides) || 0;
    llm.rejectedCloudChoices += Number(report.rejectedCloudChoices) || 0;
    llm.transientFailures += Number(report.transientFailures) || 0;
    llm.modelOutputFailures += Number(report.modelOutputFailures) || 0;
    llm.permanentFailures += Number(report.permanentFailures) || 0;
    llm.backoffSkips += Number(report.backoffSkips) || 0;
    llm.budgetSkips += Number(report.budgetSkips) || 0;
    llm.strategicSkips += Number(report.strategicSkips) || 0;
    if (Number.isFinite(Number(report.minLatencyMs))) {
      llm.minLatencyMs = llm.minLatencyMs == null
        ? Number(report.minLatencyMs)
        : Math.min(llm.minLatencyMs, Number(report.minLatencyMs));
    }
    if (Number.isFinite(Number(report.maxLatencyMs))) {
      llm.maxLatencyMs = llm.maxLatencyMs == null
        ? Number(report.maxLatencyMs)
        : Math.max(llm.maxLatencyMs, Number(report.maxLatencyMs));
    }
  }
  s.llm = llm;

  s.scoreTrend.push({
    time: new Date().toISOString(),
    difficulty,
    avg: decisions.length ? Math.round(roundSum / decisions.length) : 0,
    unassistedAvg: cleanCount ? Math.round(cleanSum / cleanCount) : null,
    assisted: decisions.filter((ev) => ev.assisted).length,
    forced: decisions.filter((ev) => ev.forced).length,
  });
  s.scoreTrend = s.scoreTrend.slice(-100);

  saveStats(s);
  return s;
}

export function avgScore(stats) {
  if (!stats.evalCount) return 0;
  return Math.round(stats.evalSum / stats.evalCount);
}

export function unassistedAvgScore(stats) {
  if (!stats.unassistedEvalCount) return 0;
  return Math.round(stats.unassistedEvalSum / stats.unassistedEvalCount);
}

/** 用户可持久化设置中剥离 A/B 模拟器专用实验字段（浅拷贝，其余原样）。 */
export function sanitizeUserSettings(settings) {
  if (!settings || typeof settings !== 'object') return {};
  const {
    aiPolicyBySeat,
    aiPolicyFeaturesBySeat,
    aiPolicyThresholdsBySeat,
    aiDifficultyBySeat,
    aiDecisionEngineBySeat,
    ...rest
  } = settings;
  return rest;
}

export function loadSettings() {
  const defaults = {
    difficulty: 'normal',
    aiSpeed: 'normal',
    llmPolicyMode: 'local',
    localAiEngine: 'expert',
    coachMode: false,
    autoHint: false,
    reducedMotion: false,
    largeText: false,
  };
  try {
    const raw = storage().getItem(SETTINGS_KEY);
    const parsed = raw ? { ...defaults, ...JSON.parse(raw) } : defaults;
    if (!['local', 'auto', 'cloud'].includes(parsed.llmPolicyMode)) parsed.llmPolicyMode = 'local';
    if (!['expert', 'hybrid'].includes(parsed.localAiEngine)) parsed.localAiEngine = 'expert';
    return parsed;
  } catch {
    return defaults;
  }
}

export function saveSettings(settings) {
  return safeSet(SETTINGS_KEY, settings);
}

/** 保存最近若干副复盘 */
export function saveReplay(replay) {
  const list = loadReplays();
  list.unshift(replay);
  while (list.length > REPLAY_LIMIT) list.pop();
  while (list.length) {
    if (safeSet(REPLAY_KEY, list)) return list;
    list.pop();
  }
  return [];
}

export function loadReplays() {
  try {
    const raw = storage().getItem(REPLAY_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function clearReplays() {
  return safeRemove(REPLAY_KEY);
}

export function saveActiveMatch(snapshot) {
  return safeSet(ACTIVE_MATCH_KEY, { version: DATA_VERSION, savedAt: new Date().toISOString(), snapshot });
}

export function loadActiveMatch() {
  try {
    const raw = storage().getItem(ACTIVE_MATCH_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.version !== DATA_VERSION || !parsed.snapshot) return null;
    return parsed.snapshot;
  } catch {
    return null;
  }
}

export function clearActiveMatch() {
  return safeRemove(ACTIVE_MATCH_KEY);
}

export function exportTrainingData() {
  return {
    version: DATA_VERSION,
    exportedAt: new Date().toISOString(),
    stats: loadStats(),
    settings: loadSettings(),
    replays: loadReplays(),
  };
}

export function importTrainingData(data) {
  if (!data || typeof data !== 'object' || !data.stats || !Array.isArray(data.replays)) {
    return { ok: false, reason: '文件不是有效的掼蛋训练数据' };
  }
  const statsOk = safeSet(KEY, mergeStats(data.stats));
  // 剥离 A/B 模拟器实验字段，避免导入后正式对局某座被永久钉死 baseline/no-pX
  const settingsOk = safeSet(SETTINGS_KEY, sanitizeUserSettings({
    ...loadSettings(),
    ...(data.settings || {}),
  }));
  const replayOk = safeSet(REPLAY_KEY, data.replays.slice(0, REPLAY_LIMIT));
  return statsOk && settingsOk && replayOk
    ? { ok: true }
    : { ok: false, reason: '浏览器存储空间不足，导入未完成' };
}

export function clearStats() {
  safeRemove(KEY);
  return defaultStats();
}
