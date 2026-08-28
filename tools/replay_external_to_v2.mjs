#!/usr/bin/env node
/**
 * 将外部标准化回放严格重放为本项目的公平座位轨迹。
 *
 * 不执行来源代码，不修改原始 JSONL，也不会猜测缺失事件。每一副仅在
 * 牌权、持牌、牌型、压制、接风和终局均可由项目规则解释时才写入轨迹。
 *
 * 用法：
 *   node tools/replay_external_to_v2.mjs --output "训练数据/验证"
 *   node tools/replay_external_to_v2.mjs --njupt path --botzone path --output path
 */
import fs from 'node:fs';
import path from 'node:path';

import { TEAM_OF, getReturnCandidates } from '../js/game.js';
import { removeCards } from '../js/cards.js';
import {
  calcUpgrade, handSignature, isLegalPlay, parseHandVariants,
} from '../js/rules.js';
import {
  auditPublicAIObservation, createPublicAIObservation, publicHandView,
} from '../js/ai-observation.js';

const EXTERNAL_SCHEMA = 'guandan-external-trajectory-v1';
const REPORT_SCHEMA = 'guandan-external-replay-report-v1';
const ADAPTER_REPORT_SCHEMA = 'guandan-external-wind-adapter-report-v1';
const EVIDENCE_REPORT_SCHEMA = 'guandan-external-wind-evidence-report-v1';
const ACTION_AUDIT_REPORT_SCHEMA = 'guandan-external-wind-action-audit-report-v1';
const DEFAULT_NJUPT = '训练数据/标准化/njupt.jsonl';
const DEFAULT_BOTZONE = '训练数据/Botzone/normalized/botzone_matches.jsonl';
const WIND_ADAPTER_MODES = ['partner_can_respond', 'partner_catch_marker'];
const MAX_WIND_BRANCH_PATHS = 16;
const MAX_WIND_BRANCH_DECISIONS = 4;

class ReplayFailure extends Error {
  constructor(code, message, eventIndex = null, diagnostics = null) {
    super(message);
    this.code = code;
    this.eventIndex = eventIndex;
    this.diagnostics = diagnostics;
  }
}

function parseArgs(argv) {
  const options = {
    njupt: DEFAULT_NJUPT,
    botzone: DEFAULT_BOTZONE,
    output: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!['--njupt', '--botzone', '--output'].includes(key)) {
      throw new Error(`未知参数：${key}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${key} 需要路径参数`);
    options[key.slice(2)] = value;
    index += 1;
  }
  if (!options.output) throw new Error('请提供 --output，例如 --output "训练数据/验证"');
  return options;
}

function readJsonl(file) {
  if (!fs.existsSync(file)) throw new Error(`找不到输入文件：${file}`);
  return fs.readFileSync(file, 'utf8').split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      try { return JSON.parse(line); }
      catch (error) { throw new Error(`${file}:${index + 1} 不是有效 JSON：${error.message}`); }
    });
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
}

function levelNumber(value) {
  const labels = { J: 11, Q: 12, K: 13, A: 14 };
  const normalized = String(value ?? '').trim().toUpperCase();
  const number = labels[normalized] || Number(normalized);
  if (!Number.isInteger(number) || number < 2 || number > 14) {
    throw new ReplayFailure('invalid_level', `无法识别级牌：${value}`);
  }
  return number;
}

function cardId(card) {
  const id = card?.id ?? card?.physicalId;
  if (id == null || id === '') throw new ReplayFailure('card_missing_id', '来源牌缺少稳定物理编号');
  return String(id);
}

function cardView(card) {
  return {
    id: cardId(card), rank: Number(card.rank), suit: String(card.suit),
    deckIndex: Number(card.deckIndex) || 0,
  };
}

function normalizedHand(cards) {
  if (!Array.isArray(cards) || !cards.length) throw new ReplayFailure('invalid_initial_hand', '初始牌为空');
  const result = cards.map(cardView);
  const ids = result.map(cardId);
  if (ids.length !== new Set(ids).size) throw new ReplayFailure('duplicate_initial_card', '初始牌含重复实体牌');
  return result;
}

function teamOf(seat) {
  const team = TEAM_OF[seat];
  if (team == null) throw new ReplayFailure('invalid_seat', `非法座位：${seat}`);
  return team;
}

function nextActiveSeat(state, from) {
  for (let offset = 1; offset <= 4; offset += 1) {
    const seat = (from + offset) % 4;
    if (!state.finishOrder.includes(seat)) return seat;
  }
  return null;
}

function windPartner(state) {
  if (state.lastSeat == null || !state.finishOrder.includes(state.lastSeat)) return null;
  const partner = (state.lastSeat + 2) % 4;
  return state.finishOrder.includes(partner) ? null : partner;
}

function allowsWindPartnerResponse(state) {
  return state.windAdapterMode === 'partner_can_respond' || state.windResponseActive;
}

function nextRespondingSeat(state, from) {
  const wind = windPartner(state);
  for (let offset = 1; offset <= 4; offset += 1) {
    const seat = (from + offset) % 4;
    if (!state.finishOrder.includes(seat) && (allowsWindPartnerResponse(state) || seat !== wind)) return seat;
  }
  return null;
}

function publicHistoryItem(state, action, hand, countsBefore) {
  return {
    turn: state.history.length + 1,
    trickNumber: state.trickNumber,
    seat: action.seat,
    action: action.kind === 'play' ? 'play' : 'pass',
    cards: action.kind === 'play' ? action.cards.map(cardView) : [],
    hand: action.kind === 'play' ? publicHandView(hand) : null,
    countsBefore,
    countsAfter: state.hands.map((cards) => cards.length),
  };
}

function publicTributeContext(state, seat) {
  if (!state.transfers.length) return null;
  const knownTransfers = state.transfers.map((item) => ({
    card: cardView(item.card), from: item.from, to: item.to, kind: item.kind,
  }));
  const gave = state.transfers.find((item) => item.from === seat && item.kind === 'tribute');
  const received = state.transfers.find((item) => item.to === seat && item.kind === 'return');
  return {
    gaveCard: gave ? cardView(gave.card) : null,
    gaveTo: gave?.to ?? null,
    receivedReturnCard: received ? cardView(received.card) : null,
    receivedFrom: received?.from ?? null,
    firstLeadAfterTribute: state.history.length === 0 && state.transfers.length > 0,
    doubleDown: state.transfers.filter((item) => item.kind === 'tribute').length === 2,
    knownTransfers,
  };
}

function actionObservation(state, seat) {
  const observation = createPublicAIObservation({
    seat,
    hand: state.hands[seat],
    level: state.level,
    lastHand: state.lastHand,
    lastSeat: state.lastSeat,
    handCounts: state.hands.map((hand) => hand.length),
    teams: TEAM_OF,
    finishOrder: state.finishOrder,
    playedCards: state.playedCards,
    publicHistory: state.history,
    tributeContext: publicTributeContext(state, seat),
    difficulty: 'master',
    deterministic: true,
    decisionEngine: 'expert',
  });
  const audit = auditPublicAIObservation(observation);
  if (!audit.ok) throw new ReplayFailure('public_observation_leak', `公开观察审计失败：${audit.leaked.join(',')}`);
  return observation;
}

function turnDiagnostics(state, event) {
  let sourceActionProjectLegality = null;
  if (event.kind === 'play') {
    try {
      const cards = findOwnedCards(state.hands[Number(event.seat)], event.cards || [], null);
      const legal = isLegalPlay(cards, state.level, state.lastHand, event.declaration || null);
      sourceActionProjectLegality = { ok: !!legal.ok, reason: legal.reason || null };
    } catch (error) {
      sourceActionProjectLegality = { ok: false, reason: error.message || String(error) };
    }
  }
  return {
    expectedSeat: state.currentSeat,
    actualSeat: Number(event.seat),
    eventKind: event.kind,
    trickNumber: state.trickNumber,
    historyLength: state.history.length,
    lastSeat: state.lastSeat,
    lastHand: state.lastHand ? publicHandView(state.lastHand) : null,
    passCount: state.passCount,
    finishOrder: state.finishOrder.slice(),
    handCounts: state.hands.map((hand) => hand.length),
    windPartner: windPartner(state),
    sourceActionProjectLegality,
    recentPublicActions: state.history.slice(-6).map((item) => ({
      turn: item.turn,
      trickNumber: item.trickNumber,
      seat: item.seat,
      action: item.action,
      hand: item.hand,
    })),
  };
}

function findOwnedCards(hand, cards, eventIndex) {
  const byId = new Map(hand.map((card) => [cardId(card), card]));
  const selected = cards.map((card) => {
    const found = byId.get(cardId(card));
    if (!found) throw new ReplayFailure('card_not_owned', `出牌不属于当前座位：${cardId(card)}`, eventIndex);
    return found;
  });
  const ids = selected.map(cardId);
  if (ids.length !== new Set(ids).size) throw new ReplayFailure('duplicate_card_action', '同一实体牌重复出现在动作中', eventIndex);
  return selected;
}

function appendFinish(state, seat) {
  if (!state.finishOrder.includes(seat)) state.finishOrder.push(seat);
}

function finishIfDecided(state) {
  const doubleUp = state.finishOrder.length >= 2
    && teamOf(state.finishOrder[0]) === teamOf(state.finishOrder[1]);
  if (!doubleUp && state.finishOrder.length < 3) return false;
  let cursor = state.currentSeat;
  while (state.finishOrder.length < 4) {
    const next = nextActiveSeat(state, cursor);
    if (next == null) break;
    appendFinish(state, next);
    cursor = next;
  }
  state.ended = true;
  return true;
}

function advanceAfterPlay(state) {
  if (finishIfDecided(state)) return;
  const next = nextRespondingSeat(state, state.currentSeat);
  if (next == null) {
    state.ended = true;
    return;
  }
  state.currentSeat = next;
}

function advanceAfterPass(state) {
  const active = 4 - state.finishOrder.length;
  const wind = windPartner(state);
  const requiredPasses = state.lastSeat != null && state.finishOrder.includes(state.lastSeat)
    ? (allowsWindPartnerResponse(state)
      ? active
      : active - (wind == null ? 0 : 1))
    : Math.max(active - 1, 0);
  if (state.passCount >= requiredPasses && state.lastSeat != null) {
    let leader = state.lastSeat;
    if (state.finishOrder.includes(leader)) {
      const partner = (leader + 2) % 4;
      leader = state.finishOrder.includes(partner) ? nextActiveSeat(state, leader) : partner;
    }
    if (leader == null) {
      state.ended = true;
      return;
    }
    state.lastHand = null;
    state.lastSeat = null;
    state.passCount = 0;
    state.windResponseActive = false;
    state.trickNumber += 1;
    state.currentSeat = leader;
    return;
  }
  const next = nextRespondingSeat(state, state.currentSeat);
  if (next == null) {
    state.ended = true;
    return;
  }
  state.currentSeat = next;
}

function applyTransfer(state, event, eventIndex) {
  const from = Number(event.fromSeat);
  const to = Number(event.toSeat);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from > 3 || to < 0 || to > 3 || from === to) {
    throw new ReplayFailure('invalid_transfer_seats', '贡还座位无效', eventIndex);
  }
  const card = findOwnedCards(state.hands[from], [event.card], eventIndex)[0];
  if (event.kind === 'return') {
    const candidateState = {
      phase: 'return', currentLevel: state.level,
      hands: [state.hands[from], [], [], []],
      tributeState: { pendingReturns: [{ from: 0, to: 1 }] },
    };
    const legalReturns = getReturnCandidates(candidateState).map(cardId);
    if (!legalReturns.includes(cardId(card))) {
      throw new ReplayFailure('illegal_return_card', `还贡牌不符合本项目还贡约束：${cardId(card)}`, eventIndex);
    }
  }
  state.hands[from] = removeCards(state.hands[from], [card]);
  state.hands[to] = [...state.hands[to], card];
  state.transfers.push({ kind: event.kind, from, to, card });
}

function replayEpisode(episode, {
  windAdapterMode = 'project', windAdapterPlan = null, collectRecords = true,
} = {}) {
  if (!Array.isArray(episode.initialHands) || episode.initialHands.length !== 4) {
    throw new ReplayFailure('invalid_initial_hands', '必须有四家初始牌');
  }
  const hands = episode.initialHands.map(normalizedHand);
  const allIds = hands.flat().map(cardId);
  if (allIds.length !== 108 || new Set(allIds).size !== 108 || hands.some((hand) => hand.length !== 27)) {
    throw new ReplayFailure('invalid_deal', '初始牌必须为四家各 27 张的完整双副牌');
  }
  const state = {
    level: episode.level,
    hands,
    currentSeat: null,
    lastHand: null,
    lastSeat: null,
    passCount: 0,
    finishOrder: [],
    trickNumber: 1,
    history: [],
    playedCards: [],
    transfers: [],
    ended: false,
    records: [],
    collectRecords,
    windAdapterMode,
    windResponseActive: false,
    windAdapterEvents: [],
  };

  for (let eventIndex = 0; eventIndex < episode.events.length; eventIndex += 1) {
    const event = episode.events[eventIndex];
    if (event.kind === 'tribute' || event.kind === 'return') {
      if (state.history.length) throw new ReplayFailure('late_transfer', '贡还发生在出牌阶段之后', eventIndex);
      applyTransfer(state, event, eventIndex);
      continue;
    }
    if (event.kind !== 'play' && event.kind !== 'pass') {
      throw new ReplayFailure('unsupported_event', `不支持的事件：${event.kind}`, eventIndex);
    }
    const seat = Number(event.seat);
    if (!Number.isInteger(seat) || seat < 0 || seat > 3) {
      throw new ReplayFailure('invalid_seat', '动作座位无效', eventIndex);
    }
    if (state.ended) throw new ReplayFailure('action_after_end', '终局后仍有动作', eventIndex);
    if (state.currentSeat == null) {
      if (event.kind !== 'play') throw new ReplayFailure('opening_pass', '首手不能过牌', eventIndex);
      state.currentSeat = seat;
    }
    const wind = windPartner(state);
    const plannedMode = windAdapterPlan?.get(eventIndex) || state.windAdapterMode;
    if (state.currentSeat !== seat
      && plannedMode === 'partner_can_respond'
      && seat === wind) {
      state.windResponseActive = true;
      state.currentSeat = seat;
    }
    if (state.currentSeat !== seat
      && plannedMode === 'partner_catch_marker'
      && seat === wind) {
      state.windAdapterEvents.push({
        type: 'wind_partner_catch_marker', eventIndex, seat, action: event.kind,
      });
      state.lastHand = null;
      state.lastSeat = null;
      state.passCount = 0;
      state.windResponseActive = false;
      state.trickNumber += 1;
      state.currentSeat = seat;
      // 来源将这一手过牌作为接风标记；它不属于本项目可学习的决策动作。
      if (event.kind === 'pass') continue;
    }
    if (state.currentSeat !== seat) {
      const code = state.windAdapterMode === 'branch_evidence' && seat === wind
        ? 'wind_branch_required'
        : 'turn_order_mismatch';
      throw new ReplayFailure(
        code,
        `预期座位 ${state.currentSeat}，实际座位 ${seat}`,
        eventIndex,
        turnDiagnostics(state, event),
      );
    }
    if (state.finishOrder.includes(seat)) throw new ReplayFailure('finished_seat_action', '已出完座位继续行动', eventIndex);

    if (allowsWindPartnerResponse(state)
      && state.lastSeat != null
      && state.finishOrder.includes(state.lastSeat)
      && seat === windPartner(state)) {
      state.windAdapterEvents.push({
        type: 'wind_partner_response', eventIndex, seat, action: event.kind,
      });
    }

    const observation = state.collectRecords ? actionObservation(state, seat) : null;
    const countsBefore = state.hands.map((hand) => hand.length);
    if (event.kind === 'pass') {
      if (!state.lastHand) throw new ReplayFailure('illegal_pass_lead', '领出状态不能过牌', eventIndex);
      state.passCount += 1;
      state.history.push(publicHistoryItem(state, event, null, countsBefore));
      if (state.collectRecords) {
        state.records.push({ observation, action: { action: 'pass', cards: [], signature: null, hand: null } });
      }
      advanceAfterPass(state);
      continue;
    }

    const cards = findOwnedCards(state.hands[seat], event.cards, eventIndex);
    const legal = isLegalPlay(cards, state.level, state.lastHand, event.declaration || null);
    if (!legal.ok || !legal.hand) {
      throw new ReplayFailure('illegal_play', legal.reason || '项目规则拒绝该出牌', eventIndex);
    }
    state.hands[seat] = removeCards(state.hands[seat], cards);
    state.lastHand = legal.hand;
    state.lastSeat = seat;
    state.passCount = 0;
    state.windResponseActive = false;
    state.playedCards.push(...cards);
    if (!state.hands[seat].length) appendFinish(state, seat);
    const action = {
      kind: 'play', seat, cards,
      action: 'play', signature: handSignature(legal.hand), hand: publicHandView(legal.hand),
    };
    state.history.push(publicHistoryItem(state, action, legal.hand, countsBefore));
    if (state.collectRecords) {
      state.records.push({ observation, action: {
        action: 'play', cards: cards.map(cardView), signature: action.signature, hand: action.hand,
      } });
    }
    advanceAfterPlay(state);
  }

  if (!state.ended || state.finishOrder.length !== 4) {
    throw new ReplayFailure('incomplete_round', '来源动作结束但本项目规则未形成完整终局');
  }
  const winningTeam = teamOf(state.finishOrder[0]);
  const upgrade = calcUpgrade(state.finishOrder, teamOf);
  return {
    finishOrder: state.finishOrder,
    winningTeam,
    upgrade,
    windAdapterEvents: state.windAdapterEvents,
    records: state.collectRecords ? state.records.map((record) => ({
      ...record,
      outcome: {
        teamUtility: teamOf(record.observation.seat) === winningTeam ? upgrade : -upgrade,
        teamWon: teamOf(record.observation.seat) === winningTeam,
        place: state.finishOrder.indexOf(record.observation.seat) + 1,
        finishOrder: state.finishOrder.slice(),
      },
    })) : [],
  };
}

function njuptEpisodes(row) {
  const episodes = [];
  let current = null;
  for (const record of row.records || []) {
    const event = record.event || {};
    if (event.type === 'round_level' && event.scope === 'current') {
      if (current) episodes.push(current);
      current = {
        provider: 'njupt-game-ai-competition',
        sourceGameId: row.source?.sha256 || row.identity?.label || 'njupt-unknown',
        sourceRound: Number(record.round) || episodes.length + 1,
        source: row.source || {}, level: levelNumber(event.level), initialHands: [[], [], [], []],
        events: [], providerTeamLevels: [null, null], finalLevels: row.finalLevels || null,
      };
      continue;
    }
    if (!current) continue;
    if (event.type === 'round_level' && event.scope === 'team') {
      current.providerTeamLevels[event.subject] = levelNumber(event.level);
    } else if (event.type === 'initial_hand') {
      current.initialHands[event.seat] = event.cards || [];
    } else if (event.type === 'tribute' || event.type === 'return') {
      current.events.push({
        kind: event.type, fromSeat: event.fromSeat, toSeat: event.toSeat, card: event.card,
      });
    } else if (event.type === 'action') {
      current.events.push({ kind: event.action, seat: event.seat, cards: event.cards || [] });
    }
  }
  if (current) episodes.push(current);
  return episodes;
}

function botzoneEpisodes(row) {
  const level = levelNumber(row.rules?.level);
  const events = [];
  for (const event of row.events || []) {
    if (event.stage !== 'play') {
      events.push({ kind: `botzone_${event.stage}`, seat: event.seat });
      continue;
    }
    const action = event.action || {};
    events.push({
      kind: action.kind === 'play' ? 'play' : 'pass',
      seat: event.seat,
      cards: action.actual || [],
    });
  }
  return [{
    provider: 'botzone', sourceGameId: String(row.match?.id || row.source?.rawSha256 || 'botzone-unknown'),
    sourceRound: 1, source: row.source || {}, level, initialHands: row.initialHands || [], events,
    providerOutcome: row.outcome?.providerFinish ?? null,
  }];
}

function trajectoryRows(episode, result) {
  return result.records.map((record, index) => ({
    schema: EXTERNAL_SCHEMA,
    provider: episode.provider,
    sourceGameId: episode.sourceGameId,
    sourceRound: episode.sourceRound,
    source: {
      sha256: episode.source.rawSha256 || episode.source.sha256 || null,
      relativePath: episode.source.relativePath || episode.source.sourceFile || null,
    },
    recordIndex: index + 1,
    labelScope: 'trajectory',
    fairness: 'own_hand_plus_public_history_only',
    // 外部来源即使能被项目规则完整重放，也必须先经过单独的授权、标签和
    // OOD 评估门禁；它不能自动进入当前 self-play 训练器。
    trainingEligible: false,
    observation: record.observation,
    chosenAction: record.action.action,
    chosen: record.action,
    outcome: record.outcome,
  }));
}

function splitFor(groupId) {
  let hash = 2166136261;
  for (const char of String(groupId)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  const bucket = (hash >>> 0) % 20;
  return bucket < 14 ? 'train' : bucket < 17 ? 'validation' : 'held_out';
}

function summarizeFailures(rejected) {
  const byCode = {};
  for (const row of rejected) byCode[row.code] = (byCode[row.code] || 0) + 1;
  return byCode;
}

function providerSummary(status) {
  const summary = {};
  for (const entry of status) {
    const provider = entry.provider;
    if (!summary[provider]) summary[provider] = { accepted: 0, rejected: 0, failuresByCode: {} };
    if (entry.projectRuleReplay === 'passed') summary[provider].accepted += 1;
    else {
      summary[provider].rejected += 1;
      const code = entry.code || 'unknown_failure';
      summary[provider].failuresByCode[code] = (summary[provider].failuresByCode[code] || 0) + 1;
    }
  }
  return summary;
}

function adapterSummary(entries) {
  const summary = {};
  for (const entry of entries) {
    const mode = entry.adapterMode;
    if (!summary[mode]) {
      summary[mode] = {
        examined: 0, candidates: 0, rejected: 0,
        candidatesByProvider: {}, failuresByCode: {},
        windEventsByAction: {}, episodesWithMultipleWindEvents: 0,
      };
    }
    const item = summary[mode];
    item.examined += 1;
    if (entry.projectRuleReplay === 'adapter_candidate') {
      item.candidates += 1;
      item.candidatesByProvider[entry.provider] = (item.candidatesByProvider[entry.provider] || 0) + 1;
      if ((entry.windAdapterEvents || []).length > 1) item.episodesWithMultipleWindEvents += 1;
      for (const event of entry.windAdapterEvents || []) {
        item.windEventsByAction[event.action] = (item.windEventsByAction[event.action] || 0) + 1;
      }
    } else {
      item.rejected += 1;
      const code = entry.code || 'unknown_failure';
      item.failuresByCode[code] = (item.failuresByCode[code] || 0) + 1;
    }
  }
  return summary;
}

function branchPlanKey(plan) {
  return plan.map((item) => `${item.eventIndex}:${item.mode}`).join('|');
}

function replayWindEvidence(episode) {
  const pending = [[]];
  const seen = new Set([branchPlanKey([])]);
  const successes = [];
  const terminalFailures = [];
  let budgetExhausted = false;

  while (pending.length) {
    const plan = pending.shift();
    try {
      const result = replayEpisode(episode, {
        windAdapterMode: 'branch_evidence',
        windAdapterPlan: new Map(plan.map((item) => [item.eventIndex, item.mode])),
        collectRecords: false,
      });
      successes.push({
        plan, finishOrder: result.finishOrder, winningTeam: result.winningTeam,
        upgrade: result.upgrade, windAdapterEvents: result.windAdapterEvents,
      });
    } catch (error) {
      const failure = error instanceof ReplayFailure
        ? error : new ReplayFailure('unexpected_replay_error', error.message || String(error));
      if (failure.code !== 'wind_branch_required') {
        terminalFailures.push({ plan, code: failure.code, eventIndex: failure.eventIndex, error: failure.message });
        continue;
      }
      if (plan.length >= MAX_WIND_BRANCH_DECISIONS) {
        budgetExhausted = true;
        terminalFailures.push({ plan, code: 'wind_branch_decision_limit', eventIndex: failure.eventIndex, error: failure.message });
        continue;
      }
      for (const mode of WIND_ADAPTER_MODES) {
        const nextPlan = [...plan, { eventIndex: failure.eventIndex, mode }];
        const key = branchPlanKey(nextPlan);
        if (seen.has(key)) continue;
        if (seen.size >= MAX_WIND_BRANCH_PATHS) {
          budgetExhausted = true;
          continue;
        }
        seen.add(key);
        pending.push(nextPlan);
      }
    }
  }

  const outcomes = new Map();
  for (const success of successes) {
    const key = `${success.finishOrder.join(',')}|${success.winningTeam}|${success.upgrade}`;
    if (!outcomes.has(key)) {
      outcomes.set(key, {
        finishOrder: success.finishOrder, winningTeam: success.winningTeam,
        upgrade: success.upgrade, branches: [],
      });
    }
    outcomes.get(key).branches.push({ plan: success.plan, windAdapterEvents: success.windAdapterEvents });
  }
  return {
    branchesExamined: seen.size,
    budgetExhausted,
    successes,
    terminalFailures,
    outcomes: [...outcomes.values()],
  };
}

function evidenceEntry(episode, evidence) {
  const key = `${episode.provider}:${episode.sourceGameId}:round:${episode.sourceRound}`;
  const base = {
    key, provider: episode.provider, sourceGameId: episode.sourceGameId,
    sourceRound: episode.sourceRound, trainingEligible: false,
    branchBudget: {
      maxPaths: MAX_WIND_BRANCH_PATHS,
      maxDecisions: MAX_WIND_BRANCH_DECISIONS,
      branchesExamined: evidence.branchesExamined,
      exhausted: evidence.budgetExhausted,
    },
    successfulBranches: evidence.successes.length,
    terminalFailures: evidence.terminalFailures,
    outcomes: evidence.outcomes,
  };
  if (evidence.budgetExhausted) {
    return { ...base, projectRuleReplay: 'adapter_evidence_incomplete' };
  }
  if (!evidence.successes.length) {
    return { ...base, projectRuleReplay: 'failed' };
  }
  return {
    ...base,
    projectRuleReplay: evidence.outcomes.length === 1
      ? 'adapter_evidence_candidate'
      : 'adapter_evidence_ambiguous',
  };
}

function evidenceSummary(entries) {
  const summary = {
    examined: entries.length, candidates: 0, ambiguous: 0, incomplete: 0, rejected: 0,
    candidatesByProvider: {}, failuresByCode: {},
  };
  for (const entry of entries) {
    if (entry.projectRuleReplay === 'adapter_evidence_candidate') {
      summary.candidates += 1;
      summary.candidatesByProvider[entry.provider] = (summary.candidatesByProvider[entry.provider] || 0) + 1;
    } else if (entry.projectRuleReplay === 'adapter_evidence_ambiguous') {
      summary.ambiguous += 1;
    } else if (entry.projectRuleReplay === 'adapter_evidence_incomplete') {
      summary.incomplete += 1;
    } else {
      summary.rejected += 1;
      for (const failure of entry.terminalFailures || []) {
        summary.failuresByCode[failure.code] = (summary.failuresByCode[failure.code] || 0) + 1;
      }
    }
  }
  return summary;
}

function sourceActionCount(episode) {
  return (episode.events || []).filter((event) => event.kind === 'play' || event.kind === 'pass').length;
}

function adapterTrajectoryRows(episode, result) {
  const groupId = `${episode.provider}:${episode.sourceGameId}`;
  return result.records.map((record, index) => ({
    schema: 'guandan-external-adapter-trajectory-v1',
    provider: episode.provider,
    sourceGameId: episode.sourceGameId,
    sourceRound: episode.sourceRound,
    source: {
      sha256: episode.source.rawSha256 || episode.source.sha256 || null,
      relativePath: episode.source.relativePath || episode.source.sourceFile || null,
    },
    recordIndex: index + 1,
    split: splitFor(groupId),
    labelScope: 'trajectory',
    fairness: 'own_hand_plus_public_history_only',
    projectRuleReplay: 'adapter_action_audited',
    actionMapping: 'resolved_unique_branch',
    trainingEligible: false,
    observation: record.observation,
    chosenAction: record.action.action,
    chosen: record.action,
    outcome: record.outcome,
  }));
}

function auditWindActionMapping(episode, evidence) {
  const base = {
    key: evidence.key, provider: episode.provider, sourceGameId: episode.sourceGameId,
    sourceRound: episode.sourceRound, trainingEligible: false,
  };
  if (evidence.projectRuleReplay !== 'adapter_evidence_candidate') {
    return { ...base, projectRuleReplay: 'failed', actionMapping: 'no_evidence_candidate' };
  }
  if (evidence.successfulBranches !== 1) {
    return {
      ...base, projectRuleReplay: 'adapter_evidence_candidate',
      actionMapping: 'ambiguous_successful_branch',
      successfulBranches: evidence.successfulBranches,
    };
  }
  const branch = evidence.outcomes[0]?.branches?.[0];
  if (!branch) throw new ReplayFailure('missing_evidence_branch', '证据候选缺少成功分支');
  const result = replayEpisode(episode, {
    windAdapterMode: 'branch_evidence',
    windAdapterPlan: new Map(branch.plan.map((item) => [item.eventIndex, item.mode])),
    collectRecords: true,
  });
  const ignoredWindMarkers = result.windAdapterEvents
    .filter((event) => event.type === 'wind_partner_catch_marker' && event.action === 'pass').length;
  const expectedRecords = sourceActionCount(episode) - ignoredWindMarkers;
  if (result.records.length !== expectedRecords) {
    throw new ReplayFailure(
      'action_mapping_count_mismatch',
      `来源动作 ${sourceActionCount(episode)}，接风标记过牌 ${ignoredWindMarkers}，实际轨迹 ${result.records.length}`,
    );
  }
  return {
    ...base,
    projectRuleReplay: 'adapter_action_audited',
    actionMapping: 'resolved_unique_branch',
    actionRecords: result.records.length,
    ignoredWindMarkers,
    windAdapterEvents: result.windAdapterEvents,
    finishOrder: result.finishOrder,
    upgrade: result.upgrade,
    trajectoryRows: adapterTrajectoryRows(episode, result),
  };
}

function actionAuditSummary(entries) {
  const summary = { examined: entries.length, resolved: 0, ambiguous: 0, rejected: 0, resolvedByProvider: {}, actionRecords: 0 };
  for (const entry of entries) {
    if (entry.actionMapping === 'resolved_unique_branch') {
      summary.resolved += 1;
      summary.actionRecords += entry.actionRecords || 0;
      summary.resolvedByProvider[entry.provider] = (summary.resolvedByProvider[entry.provider] || 0) + 1;
    } else if (entry.actionMapping === 'ambiguous_successful_branch') {
      summary.ambiguous += 1;
    } else {
      summary.rejected += 1;
    }
  }
  return summary;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const njuptRows = readJsonl(path.resolve(options.njupt)).filter((row) => row.kind === 'game');
  const botzoneRows = readJsonl(path.resolve(options.botzone));
  const accepted = [];
  const rejected = [];
  const sourceStatus = [];
  const adapterStatus = [];
  const adapterRejected = [];
  const episodesByKey = new Map();

  const replayWindAdapters = (episode, strictFailure) => {
    for (const adapterMode of WIND_ADAPTER_MODES) {
      const key = `${episode.provider}:${episode.sourceGameId}:round:${episode.sourceRound}`;
      try {
        const result = replayEpisode(episode, { windAdapterMode: adapterMode });
        adapterStatus.push({
          key, provider: episode.provider, sourceGameId: episode.sourceGameId,
          sourceRound: episode.sourceRound, adapterMode,
          projectRuleReplay: 'adapter_candidate', trainingEligible: false,
          strictFailure: { code: strictFailure.code, eventIndex: strictFailure.eventIndex },
          actionRecords: result.records.length, finishOrder: result.finishOrder,
          upgrade: result.upgrade, windAdapterEvents: result.windAdapterEvents,
        });
      } catch (error) {
        const failure = error instanceof ReplayFailure
          ? error : new ReplayFailure('unexpected_replay_error', error.message || String(error));
        const row = {
          schema: 'guandan-external-wind-adapter-rejection-v1', key,
          provider: episode.provider, sourceGameId: episode.sourceGameId,
          sourceRound: episode.sourceRound, adapterMode,
          projectRuleReplay: 'failed', trainingEligible: false,
          strictFailure: { code: strictFailure.code, eventIndex: strictFailure.eventIndex },
          code: failure.code, eventIndex: failure.eventIndex, error: failure.message,
          diagnostics: failure.diagnostics,
        };
        adapterStatus.push(row);
        adapterRejected.push(row);
      }
    }
  };

  const replay = (episode) => {
    const key = `${episode.provider}:${episode.sourceGameId}:round:${episode.sourceRound}`;
    episodesByKey.set(key, episode);
    try {
      const result = replayEpisode(episode);
      const rows = trajectoryRows(episode, result);
      accepted.push(...rows);
      sourceStatus.push({
        key, provider: episode.provider, sourceGameId: episode.sourceGameId,
        sourceRound: episode.sourceRound, projectRuleReplay: 'passed', trainingEligible: false,
        actionRecords: rows.length, finishOrder: result.finishOrder, upgrade: result.upgrade,
      });
    } catch (error) {
      const failure = error instanceof ReplayFailure
        ? error : new ReplayFailure('unexpected_replay_error', error.message || String(error));
      if (failure.code === 'turn_order_mismatch') replayWindAdapters(episode, failure);
      rejected.push({
        schema: 'guandan-external-replay-rejection-v1', key, provider: episode.provider,
        sourceGameId: episode.sourceGameId, sourceRound: episode.sourceRound,
        projectRuleReplay: 'failed', trainingEligible: false,
        code: failure.code, eventIndex: failure.eventIndex, error: failure.message,
        diagnostics: failure.diagnostics,
      });
      sourceStatus.push({
        key, provider: episode.provider, sourceGameId: episode.sourceGameId,
        sourceRound: episode.sourceRound, projectRuleReplay: 'failed', trainingEligible: false,
        code: failure.code, eventIndex: failure.eventIndex,
      });
    }
  };

  for (const row of njuptRows) for (const episode of njuptEpisodes(row)) replay(episode);
  for (const row of botzoneRows) for (const episode of botzoneEpisodes(row)) replay(episode);

  const evidenceCandidateKeys = new Set(adapterStatus
    .filter((entry) => entry.projectRuleReplay === 'adapter_candidate')
    .map((entry) => entry.key));
  const windEvidenceStatus = [...evidenceCandidateKeys].sort().map((key) => (
    evidenceEntry(episodesByKey.get(key), replayWindEvidence(episodesByKey.get(key)))
  ));
  const windEvidenceRejected = windEvidenceStatus
    .filter((entry) => entry.projectRuleReplay !== 'adapter_evidence_candidate')
    .map((entry) => ({ schema: 'guandan-external-wind-evidence-rejection-v1', ...entry }));
  const actionAuditStatus = [];
  const actionAuditRejected = [];
  const adapterTrajectories = [];
  for (const evidence of windEvidenceStatus) {
    const episode = episodesByKey.get(evidence.key);
    try {
      const audited = auditWindActionMapping(episode, evidence);
      const { trajectoryRows: rows = [], ...status } = audited;
      actionAuditStatus.push(status);
      if (status.actionMapping === 'resolved_unique_branch') adapterTrajectories.push(...rows);
      else actionAuditRejected.push({ schema: 'guandan-external-wind-action-audit-rejection-v1', ...status });
    } catch (error) {
      const failure = error instanceof ReplayFailure
        ? error : new ReplayFailure('unexpected_replay_error', error.message || String(error));
      const status = {
        key: evidence.key, provider: evidence.provider, sourceGameId: evidence.sourceGameId,
        sourceRound: evidence.sourceRound, projectRuleReplay: 'failed', trainingEligible: false,
        actionMapping: 'replay_failed', code: failure.code, eventIndex: failure.eventIndex, error: failure.message,
      };
      actionAuditStatus.push(status);
      actionAuditRejected.push({ schema: 'guandan-external-wind-action-audit-rejection-v1', ...status });
    }
  }

  const grouped = new Map();
  for (const row of accepted) {
    const key = `${row.provider}:${row.sourceGameId}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  const splits = { schema: 'guandan-external-splits-v1', unit: 'source_game', groups: [] };
  for (const [groupId, rows] of [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const split = splitFor(groupId);
    rows.forEach((row) => { row.split = split; });
    splits.groups.push({ groupId, split, provider: rows[0].provider, records: rows.length });
  }

  const output = path.resolve(options.output);
  writeJsonl(path.join(output, 'external-trajectory-v2.jsonl'), accepted);
  writeJsonl(path.join(output, 'external-replay-rejected.jsonl'), rejected);
  writeJson(path.join(output, 'external-replay-status.json'), {
    schema: 'guandan-external-replay-status-v1', generatedAt: new Date().toISOString(), entries: sourceStatus,
  });
  writeJson(path.join(output, 'external-splits.json'), splits);
  writeJsonl(path.join(output, 'external-wind-adapter-rejected.jsonl'), adapterRejected);
  writeJson(path.join(output, 'external-wind-adapter-status.json'), {
    schema: 'guandan-external-wind-adapter-status-v1', generatedAt: new Date().toISOString(),
    note: '来源接风适配实验；所有条目均不可训练，不能替代项目规则回放。',
    entries: adapterStatus,
  });
  const windAdapterReport = {
    schema: ADAPTER_REPORT_SCHEMA,
    generatedAt: new Date().toISOString(),
    examinedStrictMismatches: adapterStatus.length / WIND_ADAPTER_MODES.length,
    modes: adapterSummary(adapterStatus),
    output: {
      status: 'external-wind-adapter-status.json',
      rejected: 'external-wind-adapter-rejected.jsonl',
    },
    note: '适配成功仅表示来源接风语义下的候选闭合；不生成训练轨迹，trainingEligible 固定为 false。',
  };
  writeJson(path.join(output, 'external-wind-adapter-report.json'), windAdapterReport);
  writeJsonl(path.join(output, 'external-wind-evidence-rejected.jsonl'), windEvidenceRejected);
  writeJson(path.join(output, 'external-wind-evidence-status.json'), {
    schema: 'guandan-external-wind-evidence-status-v1', generatedAt: new Date().toISOString(),
    note: '逐接风窗口分支证据；所有条目不可训练，只有穷尽且赛果一致的分支才标记为候选。',
    entries: windEvidenceStatus,
  });
  const windEvidenceReport = {
    schema: EVIDENCE_REPORT_SCHEMA,
    generatedAt: new Date().toISOString(),
    source: '仅来自至少一种接风适配语义可闭合的局',
    summary: evidenceSummary(windEvidenceStatus),
    output: {
      status: 'external-wind-evidence-status.json',
      rejected: 'external-wind-evidence-rejected.jsonl',
    },
    note: '不生成训练轨迹；trainingEligible 固定为 false。',
  };
  writeJson(path.join(output, 'external-wind-evidence-report.json'), windEvidenceReport);
  writeJsonl(path.join(output, 'external-adapter-trajectory-v1.jsonl'), adapterTrajectories);
  writeJsonl(path.join(output, 'external-wind-action-audit-rejected.jsonl'), actionAuditRejected);
  writeJson(path.join(output, 'external-wind-action-audit-status.json'), {
    schema: 'guandan-external-wind-action-audit-status-v1', generatedAt: new Date().toISOString(),
    note: '仅唯一成功分支写入隔离公平轨迹；所有记录均不可训练。',
    entries: actionAuditStatus,
  });
  const windActionAuditReport = {
    schema: ACTION_AUDIT_REPORT_SCHEMA,
    generatedAt: new Date().toISOString(),
    source: '仅来自逐窗口接风证据候选',
    summary: actionAuditSummary(actionAuditStatus),
    output: {
      trajectory: 'external-adapter-trajectory-v1.jsonl',
      status: 'external-wind-action-audit-status.json',
      rejected: 'external-wind-action-audit-rejected.jsonl',
    },
    note: '轨迹只用于后续公平与标签审计；trainingEligible 固定为 false。',
  };
  writeJson(path.join(output, 'external-wind-action-audit-report.json'), windActionAuditReport);
  const report = {
    schema: REPORT_SCHEMA,
    generatedAt: new Date().toISOString(),
    input: { njuptGames: njuptRows.length, botzoneGames: botzoneRows.length },
    episodes: { accepted: sourceStatus.filter((row) => row.projectRuleReplay === 'passed').length, rejected: rejected.length },
    trajectoryRecords: accepted.length,
    trainingEligible: false,
    byProvider: providerSummary(sourceStatus),
    failuresByCode: summarizeFailures(rejected),
    output: {
      trajectory: 'external-trajectory-v2.jsonl', rejected: 'external-replay-rejected.jsonl',
      status: 'external-replay-status.json', splits: 'external-splits.json',
      windAdapter: 'external-wind-adapter-report.json',
      windEvidence: 'external-wind-evidence-report.json',
      windActionAudit: 'external-wind-action-audit-report.json',
    },
    note: '只接受可被项目规则完整重放的局；拒绝记录不会被修复、猜测或写入训练轨迹。',
  };
  writeJson(path.join(output, 'external-replay-report.json'), report);
  console.log(JSON.stringify(report, null, 2));
  if (!accepted.length) process.exitCode = 1;
}

main();
