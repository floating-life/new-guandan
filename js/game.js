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
  parseHand, isLegalPlay, describeUpgrade, nextLevel, canPassA, formatHand,
  generateLegalPlays, handSignature, HandType,
} from './rules.js';
import {
  chooseAIPlay, chooseTributeCard, chooseReturnCard,
  setAIDifficulty, getAIDifficulty, recommendPlay, AI_DIFFICULTY_LABEL,
} from './ai.js';
import { evaluatePlay, summarizeSession, analyzeHandStructure } from './evaluator.js';
import {
  loadSettings, saveSettings, recordRoundResult, saveReplay, loadStats, avgScore,
  unassistedAvgScore, saveActiveMatch, loadActiveMatch, clearActiveMatch,
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

const AI_SPEED_MS = {
  slow: [900, 700],
  normal: [450, 400],
  fast: [120, 80],
};

export function createMatch(preserveSettings = null) {
  const settings = preserveSettings || loadSettings();
  setAIDifficulty(settings.difficulty || 'normal');
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
    // 设置
    settings: { ...settings },
    coachTip: null,
    lastReplay: null,
    matchHistory: [], // 每副简报
  };
}

export function applySettings(state, partial) {
  state.settings = { ...state.settings, ...partial };
  saveSettings(state.settings);
  if (partial.difficulty) setAIDifficulty(partial.difficulty);
  notify(state);
  return state.settings;
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
  state.round += 1;
  state.phase = PHASE.DEALING;
  state.finishOrder = [];
  state.lastHand = null;
  state.lastSeat = null;
  state.passCount = 0;
  state.trickLog = [];
  state.trickNumber = 1;
  state.currentTrickStartIndex = 0;
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
    leadAfterOwnBomb: isLeadAfterOwnBomb(state, 0),
    playedHand: legal.hand,
    declaration: state.selectedDeclaration,
  });
  decorateEvaluation(state, ev, false);
  state.lastEval = ev;
  state.evalHistory.push(ev);

  applyPlay(state, 0, cards, legal.hand, ev, {
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

function applyPlay(state, seat, cards, hand, evaluation = null, decisionMeta = null) {
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
}

function applyPass(state, seat, evaluation = null, decisionMeta = null) {
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
  const base = createMatch({ ...loadSettings(), ...(snapshot.settings || {}) });
  const state = {
    ...base,
    ...snapshot,
    settings: { ...base.settings, ...(snapshot.settings || {}) },
    selectedIds: new Set(Array.isArray(snapshot.selectedIds) ? snapshot.selectedIds : []),
    selectedDeclaration: snapshot.selectedDeclaration || null,
    assistanceUsed: Array.isArray(snapshot.assistanceUsed) ? snapshot.assistanceUsed : [],
  };
  setAIDifficulty(state.settings.difficulty || 'normal');
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

function notify(state = null) {
  if (state) persistMatch(state);
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

function maybeAutoPlay(state) {
  if (state.phase !== PHASE.PLAYING) {
    notify(state);
    return;
  }
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

function runAI(state) {
  _aiTimer = null;
  if (state.phase !== PHASE.PLAYING) return;
  const seat = state.currentSeat;
  if (seat === 0 || state.finishOrder.includes(seat)) {
    maybeAutoPlay(state);
    return;
  }

  setAIDifficulty(state.settings?.difficulty || 'normal');
  const decision = chooseAIPlay({
    seat,
    hand: state.hands[seat],
    level: state.currentLevel,
    lastHand: state.lastHand,
    lastSeat: state.lastSeat,
    handCounts: state.handCounts,
    teams: TEAM_OF,
    finishOrder: state.finishOrder,
    playedCards: state.trickLog.flatMap((item) => item.cards || []),
    leadAfterOwnBomb: isLeadAfterOwnBomb(state, seat),
  });

  if (!decision || decision.action === 'pass') {
    if (!state.lastHand) {
      // 必须出 — 兜底出最小单张
      const c = state.hands[seat][state.hands[seat].length - 1];
      const hand = parseHand([c], state.currentLevel);
      applyPlay(state, seat, [c], hand, null, { reason: '兜底领出最小单张' });
      advanceAfterPlay(state);
      return;
    }
    applyPass(state, seat, null, {
      reason: decision?.reason || 'AI 选择过牌',
      projectedTricks: decision?.projectedTricks ?? null,
    });
    advanceAfterPass(state);
    return;
  }

  applyPlay(state, seat, decision.cards, decision.hand, null, {
    reason: decision.reason || '',
    projectedTricks: decision.projectedTricks ?? null,
  });
  advanceAfterPlay(state);
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
  state.phase = PHASE.ROUND_END;
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
    difficulty: state.settings?.difficulty || 'normal',
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

  recordRoundResult({
    myPlace,
    teamWon,
    evalHistory: state.evalHistory,
    matchEnded,
    matchWon,
    difficulty: state.settings?.difficulty || 'normal',
  });

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
