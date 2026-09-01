/**
 * 公开信息对手模型（第四阶段实验）。
 *
 * 模型只统计指定真人座位在已公开逐手记录中的“领出/应手/过牌”频率，
 * 不保存、不读取任何暗牌、初始牌面、评价理由或 AI 私有信息。它的作用
 * 只是给候选排序一个很小的软偏置，样本不足时完全不介入。
 */

export const OPPONENT_MODEL_SCHEMA = 'guandan-opponent-v1';
// v3 在不改变 schema 名称的前提下增加每 100 副半衰期的证据衰减、实际
// 观察副数和模式契约。保留 v1/v2 的领出、应手、牌型、实际用炸、残局压力
// 和相对座次统计；normalize 会逐字段迁移旧 localStorage 数据。
export const OPPONENT_MODEL_VERSION = 3;
export const OPPONENT_MODEL_MIN_SAMPLES = 12;
export const OPPONENT_MODEL_HALF_LIFE_ROUNDS = 100;
export const OPPONENT_MODEL_MODES = Object.freeze(['off', 'observe', 'adaptive']);

const TYPES = Object.freeze([
  'single', 'pair', 'triple', 'fullhouse', 'straight', 'triple_pair', 'plate',
  'bomb', 'flush_straight', 'joker_bomb', 'unknown',
]);
const PRESSURE_BUCKETS = Object.freeze(['open', 'mid', 'end']);
const POSITIONS = Object.freeze(['upper', 'partner', 'lower', 'unknown']);
const BOMB_TYPES = new Set(['bomb', 'flush_straight', 'joker_bomb']);

function emptyCounts() {
  return { play: 0, pass: 0 };
}

function emptyTypeStats() {
  return Object.fromEntries(TYPES.map((type) => [type, {
    lead: emptyCounts(),
    response: emptyCounts(),
  }]));
}

function emptyPressureStats() {
  return Object.fromEntries(PRESSURE_BUCKETS.map((bucket) => [bucket, emptyCounts()]));
}

function emptyPositionStats() {
  return Object.fromEntries(POSITIONS.map((position) => [position, emptyCounts()]));
}

function emptyPositionTypeStats() {
  return Object.fromEntries(POSITIONS.map((position) => [position,
    Object.fromEntries(TYPES.map((type) => [type, emptyCounts()])),
  ]));
}

function emptyTypeCounts() {
  return Object.fromEntries(TYPES.map((type) => [type, 0]));
}

function emptyResponseTargetStats() {
  return Object.fromEntries(TYPES.map((type) => [type, {
    plays: 0,
    passes: 0,
    bombPlays: 0,
    nonBombPlays: 0,
  }]));
}

function emptyResponseStyles() {
  return {
    actualTypes: emptyTypeCounts(),
    byTarget: emptyResponseTargetStats(),
  };
}

export function emptyOpponentProfile() {
  return {
    schema: OPPONENT_MODEL_SCHEMA,
    version: OPPONENT_MODEL_VERSION,
    userSeat: 0,
    halfLifeRounds: OPPONENT_MODEL_HALF_LIFE_ROUNDS,
    rounds: 0,
    roundsObserved: 0,
    decisions: 0,
    leads: 0,
    responses: 0,
    plays: 0,
    passes: 0,
    typeStats: emptyTypeStats(),
    pressure: emptyPressureStats(),
    responsePositions: emptyPositionStats(),
    responsePositionTypes: emptyPositionTypeStats(),
    responseStyles: emptyResponseStyles(),
    lastUpdated: null,
  };
}

function boundedCount(value) {
  return Math.max(0, Math.min(1000000, Number(value) || 0));
}

function normalizeCounts(raw) {
  return {
    play: boundedCount(raw?.play),
    pass: boundedCount(raw?.pass),
  };
}

function normalizeTypeStats(raw) {
  const result = emptyTypeStats();
  for (const type of TYPES) {
    result[type] = {
      lead: normalizeCounts(raw?.[type]?.lead),
      response: normalizeCounts(raw?.[type]?.response),
    };
  }
  return result;
}

function normalizePressure(raw) {
  const result = emptyPressureStats();
  for (const bucket of PRESSURE_BUCKETS) result[bucket] = normalizeCounts(raw?.[bucket]);
  return result;
}

function normalizePositionStats(raw) {
  const result = emptyPositionStats();
  for (const position of POSITIONS) result[position] = normalizeCounts(raw?.[position]);
  return result;
}

function normalizePositionTypeStats(raw) {
  const result = emptyPositionTypeStats();
  for (const position of POSITIONS) {
    for (const type of TYPES) {
      result[position][type] = normalizeCounts(raw?.[position]?.[type]);
    }
  }
  return result;
}

function normalizeTypeCounts(raw) {
  const result = emptyTypeCounts();
  for (const type of TYPES) result[type] = boundedCount(raw?.[type]);
  return result;
}

function normalizeResponseStyles(raw) {
  const result = emptyResponseStyles();
  result.actualTypes = normalizeTypeCounts(raw?.actualTypes);
  for (const type of TYPES) {
    const source = raw?.byTarget?.[type];
    const plays = boundedCount(source?.plays);
    const bombPlays = Math.min(plays, boundedCount(source?.bombPlays));
    result.byTarget[type] = {
      plays,
      passes: boundedCount(source?.passes),
      bombPlays,
      nonBombPlays: Math.min(plays - bombPlays, boundedCount(source?.nonBombPlays)),
    };
  }
  return result;
}

export function normalizeOpponentProfile(raw) {
  const base = emptyOpponentProfile();
  if (!raw || typeof raw !== 'object') return base;
  return {
    ...base,
    schema: OPPONENT_MODEL_SCHEMA,
    version: OPPONENT_MODEL_VERSION,
    userSeat: Number.isInteger(Number(raw.userSeat))
      && Number(raw.userSeat) >= 0 && Number(raw.userSeat) < 4 ? Number(raw.userSeat) : 0,
    halfLifeRounds: OPPONENT_MODEL_HALF_LIFE_ROUNDS,
    rounds: boundedCount(raw.rounds),
    // 老版本没有物理观察副数；以旧的累计 rounds 作为可解释的迁移下界。
    roundsObserved: boundedCount(raw.roundsObserved ?? raw.rounds),
    decisions: boundedCount(raw.decisions),
    leads: boundedCount(raw.leads),
    responses: boundedCount(raw.responses),
    plays: boundedCount(raw.plays),
    passes: boundedCount(raw.passes),
    typeStats: normalizeTypeStats(raw.typeStats),
    pressure: normalizePressure(raw.pressure),
    responsePositions: normalizePositionStats(raw.responsePositions),
    responsePositionTypes: normalizePositionTypeStats(raw.responsePositionTypes),
    responseStyles: normalizeResponseStyles(raw.responseStyles),
    lastUpdated: raw.lastUpdated ? String(raw.lastUpdated).slice(0, 40) : null,
  };
}

function typeOf(hand) {
  return TYPES.includes(String(hand?.type)) ? String(hand.type) : 'unknown';
}

function pressureBucket(count) {
  const value = Number(count);
  if (Number.isFinite(value) && value <= 5) return 'end';
  if (Number.isFinite(value) && value <= 10) return 'mid';
  return 'open';
}

function relativePosition(sourceSeat, userSeat) {
  const source = Number(sourceSeat);
  const user = Number(userSeat);
  if (!Number.isInteger(source) || !Number.isInteger(user)) return 'unknown';
  const delta = (source - user + 4) % 4;
  // 固定出牌顺序为 0→1→2→3：3 是上家，1 是下家，2 是对家。
  if (delta === 3) return 'upper';
  if (delta === 2) return 'partner';
  if (delta === 1) return 'lower';
  return 'unknown';
}

function isBombType(type) {
  return BOMB_TYPES.has(String(type));
}

function cloneProfile(profile) {
  return normalizeOpponentProfile(profile);
}

function decayCounts(counts, factor) {
  counts.play *= factor;
  counts.pass *= factor;
}

/** 对一副新公开牌局开始前衰减旧证据。只衰减统计值，不触及用户座位或元数据。 */
function decayProfile(profile) {
  const factor = 2 ** (-1 / OPPONENT_MODEL_HALF_LIFE_ROUNDS);
  for (const key of ['rounds', 'decisions', 'leads', 'responses', 'plays', 'passes']) {
    profile[key] *= factor;
  }
  for (const type of TYPES) {
    decayCounts(profile.typeStats[type].lead, factor);
    decayCounts(profile.typeStats[type].response, factor);
    profile.responseStyles.actualTypes[type] *= factor;
    const style = profile.responseStyles.byTarget[type];
    for (const key of ['plays', 'passes', 'bombPlays', 'nonBombPlays']) style[key] *= factor;
  }
  for (const bucket of PRESSURE_BUCKETS) decayCounts(profile.pressure[bucket], factor);
  for (const position of POSITIONS) {
    decayCounts(profile.responsePositions[position], factor);
    for (const type of TYPES) decayCounts(profile.responsePositionTypes[position][type], factor);
  }
}

function latestPlayInTrick(history, index, trickNumber) {
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    const item = history[cursor];
    if (item?.trickNumber !== trickNumber) break;
    if (item.action === 'play' && item.hand) return item;
  }
  return null;
}

/**
 * 用一副已经结束的公开牌局更新画像。传入值会先经过白名单式归一化，
 * 返回新对象，不修改调用方 profile，便于回放和测试保持纯函数。
 */
export function observePublicRound(profile, publicHistory, options = {}) {
  const next = cloneProfile(profile);
  const userSeat = Number.isInteger(Number(options.userSeat))
    && Number(options.userSeat) >= 0 && Number(options.userSeat) < 4
    ? Number(options.userSeat) : next.userSeat;
  next.userSeat = userSeat;
  if (!Array.isArray(publicHistory) || !publicHistory.length) return next;

  decayProfile(next);

  let observed = 0;
  for (let index = 0; index < publicHistory.length; index++) {
    const item = publicHistory[index];
    if (!item || Number(item.seat) !== userSeat) continue;
    if (item.action !== 'play' && item.action !== 'pass') continue;
    const target = latestPlayInTrick(publicHistory, index, item.trickNumber);
    const isLead = !target;
    // 公开日志中的无目标过牌不是有效决策，不把损坏/截断数据写入画像。
    if (isLead && item.action !== 'play') continue;
    const mode = isLead ? 'lead' : 'response';
    const type = typeOf(isLead ? item.hand : target.hand);
    const action = item.action === 'play' ? 'play' : 'pass';
    const countsBefore = Array.isArray(item.countsBefore) ? item.countsBefore[userSeat] : null;
    const bucket = pressureBucket(countsBefore);
    next.typeStats[type][mode][action] += 1;
    next.pressure[bucket][action] += 1;
    if (!isLead) {
      const position = relativePosition(target.seat, userSeat);
      next.responsePositions[position][action] += 1;
      next.responsePositionTypes[position][type][action] += 1;
      const style = next.responseStyles.byTarget[type];
      style[action === 'play' ? 'plays' : 'passes'] += 1;
      if (action === 'play') {
        const actualType = typeOf(item.hand);
        next.responseStyles.actualTypes[actualType] += 1;
        style[isBombType(actualType) ? 'bombPlays' : 'nonBombPlays'] += 1;
      }
    }
    next.decisions += 1;
    next.plays += Number(action === 'play');
    next.passes += Number(action === 'pass');
    next[isLead ? 'leads' : 'responses'] += 1;
    observed += 1;
  }
  if (observed) {
    next.rounds += 1;
    next.roundsObserved += 1;
  }
  next.lastUpdated = new Date().toISOString();
  return next;
}

function smoothedRate(counts, key, prior = 0.5, alpha = 2) {
  const play = boundedCount(counts?.play);
  const pass = boundedCount(counts?.pass);
  const total = play + pass;
  if (!total) return prior;
  return (counts[key] + alpha * prior) / (total + alpha);
}

function smoothedRatio(numerator, total, prior = 0.2, alpha = 3) {
  const safeTotal = boundedCount(total);
  const safeNumerator = Math.min(safeTotal, boundedCount(numerator));
  return (safeNumerator + alpha * prior) / (safeTotal + alpha);
}

function leadTypePreference(profile, type) {
  const observedTypes = TYPES.filter((candidateType) => candidateType !== 'unknown'
    && boundedCount(profile.typeStats[candidateType]?.lead?.play) > 0);
  const total = TYPES.reduce((sum, candidateType) => (
    sum + boundedCount(profile.typeStats[candidateType]?.lead?.play)
  ), 0);
  const count = boundedCount(profile.typeStats[type]?.lead?.play);
  // 单一牌型样本无法区分“偏好”与“这一副只拿到这种结构”；至少观察到两种
  // 领牌类型后才建立相对偏好，且低频类型不作激进负面推断。
  if (total < 6 || observedTypes.length < 2 || count < 2) return {
    preference: 0,
    share: total ? count / total : 0,
    samples: total,
    typeSamples: count,
    activeTypes: observedTypes.length,
  };
  const baseline = 1 / observedTypes.length;
  const priorWeight = 2;
  const share = (count + priorWeight * baseline) / (total + priorWeight);
  const reliability = Math.min(1, total / 20) * Math.min(1, count / 4);
  return {
    preference: Math.max(-1, Math.min(1, ((share - baseline) / baseline) * reliability)),
    share,
    samples: total,
    typeSamples: count,
    activeTypes: observedTypes.length,
  };
}

export function predictOpponentProfile(
  profile, type, mode = 'response', pressure = null, position = null,
) {
  const normalized = profile?.schema === OPPONENT_MODEL_SCHEMA
    && profile?.version === OPPONENT_MODEL_VERSION
    && profile?.typeStats && profile?.pressure
    && profile?.responsePositions && profile?.responsePositionTypes && profile?.responseStyles
    ? profile : normalizeOpponentProfile(profile);
  const safeType = TYPES.includes(String(type)) ? String(type) : 'unknown';
  const safeMode = mode === 'lead' ? 'lead' : 'response';
  const counts = normalized.typeStats[safeType][safeMode];
  const source = pressure && PRESSURE_BUCKETS.includes(pressure)
    ? normalized.pressure[pressure] : null;
  const total = counts.play + counts.pass;
  const pressureTotal = source ? source.play + source.pass : 0;
  const playRate = smoothedRate(counts, 'play');
  const passRate = smoothedRate(counts, 'pass');
  const safePosition = POSITIONS.includes(position) ? position : null;
  const positionCounts = safePosition ? normalized.responsePositions[safePosition] : null;
  const positionSamples = positionCounts ? positionCounts.play + positionCounts.pass : 0;
  const positionTypeCounts = safePosition
    ? normalized.responsePositionTypes[safePosition][safeType] : null;
  const positionTypeSamples = positionTypeCounts
    ? positionTypeCounts.play + positionTypeCounts.pass : 0;
  const style = normalized.responseStyles.byTarget[safeType];
  const bombUseSamples = style.plays;
  const bombUseRate = smoothedRatio(style.bombPlays, bombUseSamples);
  const lead = leadTypePreference(normalized, safeType);
  const bombUseTendency = bombUseSamples < 6 ? 'insufficient'
    : bombUseRate >= 0.45 ? 'uses_readily'
      : bombUseRate <= 0.12 ? 'conservative_observed' : 'mixed';
  return {
    type: safeType,
    mode: safeMode,
    playRate,
    passRate,
    samples: total,
    pressure,
    pressurePlayRate: source ? smoothedRate(source, 'play') : null,
    pressurePassRate: source ? smoothedRate(source, 'pass') : null,
    pressureSamples: pressureTotal,
    position: safePosition,
    positionPlayRate: positionCounts ? smoothedRate(positionCounts, 'play') : null,
    positionPassRate: positionCounts ? smoothedRate(positionCounts, 'pass') : null,
    positionSamples,
    positionTypePlayRate: positionTypeCounts ? smoothedRate(positionTypeCounts, 'play') : null,
    positionTypePassRate: positionTypeCounts ? smoothedRate(positionTypeCounts, 'pass') : null,
    positionTypeSamples,
    leadPreference: lead.preference,
    leadShare: lead.share,
    leadSamples: lead.samples,
    leadTypeSamples: lead.typeSamples,
    bombUseRate,
    bombUseSamples,
    bombUseTendency,
    actualResponseTypes: { ...normalized.responseStyles.actualTypes },
  };
}

/**
 * 返回候选的软调整（约 ±12 分）。AI 不能因此绕过规则/安全门；样本少于
 * OPPONENT_MODEL_MIN_SAMPLES、非领出回合或候选不是可执行牌时均返回 0。
 */
export function opponentPlayAdjustment(profile, ctx = {}, candidate = {}) {
  // 排序一手候选时会多次调用本函数。公开观察层已经把已持久化画像归一化，
  // 这里直接复用该只读对象，避免每张候选重复深拷贝统计表。
  const normalized = profile?.schema === OPPONENT_MODEL_SCHEMA
    && profile?.version === OPPONENT_MODEL_VERSION
    && profile?.typeStats && profile?.pressure
    && profile?.responsePositions && profile?.responsePositionTypes && profile?.responseStyles
    ? profile : normalizeOpponentProfile(profile);
  const mode = OPPONENT_MODEL_MODES.includes(ctx?.opponentModelMode)
    ? ctx.opponentModelMode : 'adaptive';
  if (mode !== 'adaptive') return {
    score: 0,
    applied: false,
    reason: mode === 'off' ? 'opponent_model_off' : 'opponent_model_observe_only',
    samples: normalized.decisions,
  };
  if (normalized.decisions < OPPONENT_MODEL_MIN_SAMPLES
    || candidate.action === 'pass' || !candidate.hand) return {
    score: 0, applied: false, reason: 'insufficient_public_samples', samples: normalized.decisions,
  };
  const userSeat = normalized.userSeat;
  const seat = Number(ctx.seat);
  const teams = Array.isArray(ctx.teams) ? ctx.teams : [0, 1, 0, 1];
  if (!Number.isInteger(seat) || seat === userSeat || teams[seat] == null) return {
    score: 0, applied: false, reason: 'not_ai_opponent', samples: normalized.decisions,
  };
  // 只在 AI 领出时使用画像，避免对当前人类已出的牌产生循环解释，且让偏置
  // 直接回答“这手牌人类更可能接还是过”的问题。
  if (ctx.lastHand) return {
    score: 0, applied: false, reason: 'response_context', samples: normalized.decisions,
  };
  const type = typeOf(candidate.hand);
  const counts = Array.isArray(ctx.handCounts) ? ctx.handCounts[userSeat] : null;
  const bucket = pressureBucket(counts);
  const position = relativePosition(seat, userSeat);
  const prediction = predictOpponentProfile(
    normalized, type, 'response', bucket, position,
  );
  const sameTeam = teams[seat] === teams[userSeat];
  // 应手率回答“这手能否交给真人/能否让真人过牌”；领牌偏好则回答真人
  // 通常在整理什么结构。两者是独立信号：队友顺着真人常领牌型送牌，敌手
  // 小幅避开这些牌型。上家直达真人，权重最高；下家中间还隔着两家，采用
  // 更保守的折扣，避免把座次相关的过牌误当成稳定能力。
  const typeRate = sameTeam ? prediction.playRate : prediction.passRate;
  const positionTypeRate = sameTeam
    ? prediction.positionTypePlayRate : prediction.positionTypePassRate;
  const samples = prediction.samples;
  const positionTypeSamples = prediction.positionTypeSamples;
  const positionWeight = position === 'upper' ? 1
    : position === 'partner' ? 0.82 : position === 'lower' ? 0.68 : 0.6;
  const hasTypeEvidence = samples >= 3;
  const hasPositionTypeEvidence = positionTypeSamples >= 3
    && Number.isFinite(positionTypeRate);
  const relevantRate = hasTypeEvidence && hasPositionTypeEvidence
    ? typeRate * 0.7 + positionTypeRate * 0.3
    : hasTypeEvidence ? typeRate : hasPositionTypeEvidence ? positionTypeRate : 0.5;
  const responseEvidence = hasTypeEvidence || hasPositionTypeEvidence;
  const responseAdjustment = responseEvidence
    ? (relevantRate - 0.5) * (sameTeam ? 16 : 18) * positionWeight : 0;
  const pressureWeight = prediction.pressureSamples >= 6 ? 0.65 : 0.35;
  const pressureRate = sameTeam ? prediction.pressurePlayRate : prediction.pressurePassRate;
  const pressureAdjustment = responseEvidence && Number.isFinite(pressureRate)
    ? (pressureRate - 0.5) * (sameTeam ? 4 : 5) * pressureWeight * positionWeight : 0;
  const leadAdjustment = prediction.leadSamples >= 6
    ? prediction.leadPreference * (sameTeam ? 3.2 : -3) * positionWeight : 0;

  // “过牌”不能证明真人手里有炸弹，因此绝不从一次过牌推断舍炸。这里只在
  // 至少六次真实应手中观察到实际用炸，才给普通领牌加极小风险/交接信号；
  // 低使用率只作为复盘统计，不反向假定真人一定藏炸。
  const phaseWeight = bucket === 'end' ? 1 : bucket === 'mid' ? 0.7 : 0.35;
  const bombSignal = !isBombType(type) && prediction.bombUseSamples >= 6
    ? Math.max(0, prediction.bombUseRate - 0.25) : 0;
  const bombAdjustment = bombSignal
    * (sameTeam ? 2.5 : -3) * phaseWeight * positionWeight;
  const rawScore = responseAdjustment + pressureAdjustment + leadAdjustment + bombAdjustment;
  // 冷启动、低样本或长时间未复现的习惯都自动降低影响；不以旧画像压过
  // 当前专家安全候选。100 副半衰期已体现在有效样本，置信系数再避免刚越过
  // 最小阈值就给满幅偏置。
  const confidence = 0.35 + 0.65 * Math.max(0, Math.min(1,
    (normalized.decisions - OPPONENT_MODEL_MIN_SAMPLES)
      / Math.max(1, OPPONENT_MODEL_MIN_SAMPLES * 3),
  ));
  const score = Math.max(-12, Math.min(12, rawScore * confidence));
  const evidence = responseEvidence || Math.abs(leadAdjustment) > 0.01
    || Math.abs(bombAdjustment) > 0.01;
  return {
    score,
    applied: evidence && Math.abs(score) > 0.01,
    reason: !evidence ? 'type_samples_low'
      : sameTeam ? 'human_handoff_preference' : 'human_pass_preference',
    samples: normalized.decisions,
    roundsObserved: normalized.roundsObserved,
    confidence,
    typeSamples: samples,
    positionTypeSamples,
    type,
    pressure: bucket,
    relativePosition: position,
    positionWeight,
    predictedPlayRate: prediction.playRate,
    predictedPassRate: prediction.passRate,
    predictedPositionPlayRate: prediction.positionTypePlayRate,
    predictedPositionPassRate: prediction.positionTypePassRate,
    leadPreference: prediction.leadPreference,
    leadSamples: prediction.leadSamples,
    bombUseRate: prediction.bombUseRate,
    bombUseSamples: prediction.bombUseSamples,
    bombUseTendency: prediction.bombUseTendency,
    components: {
      response: responseAdjustment,
      pressure: pressureAdjustment,
      lead: leadAdjustment,
      bomb: bombAdjustment,
    },
  };
}

export const OPPONENT_MODEL_TYPES = TYPES;
export const OPPONENT_MODEL_PRESSURE_BUCKETS = PRESSURE_BUCKETS;
export const OPPONENT_MODEL_POSITIONS = POSITIONS;
