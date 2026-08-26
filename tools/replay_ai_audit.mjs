/**
 * 对导出的真实牌局做逐手、公开信息边界内的本地 AI 审计。
 *
 * 用法：
 *   node tools/replay_ai_audit.mjs "C:\\...\\掼蛋训练数据_YYYY-MM-DD.json" [副数=8]
 *   追加 --json 可输出机器可读报告。
 *
 * 这是逐手反事实审计：每次都沿用真实牌局在该手之前已经发生的公开历史，
 * 比较正式 expert、关闭本轮真实复盘模块的 no-replay-v2 与实际动作；不会
 * 读取推荐座位以外任何玩家的手牌来作决策。
 */
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { removeCards } from '../js/cards.js';
import { chooseAIPlay, recommendPlay, resolvePolicyVariant } from '../js/ai.js';
import { evaluatePlay } from '../js/evaluator.js';
import { handSignature, parseHand, parseHandVariants } from '../js/rules.js';

const inputPath = path.resolve(String(process.argv[2] || ''));
const replayLimit = positiveInteger(process.argv[3], 8);
const jsonOnly = process.argv.includes('--json');
const TEAMS = [0, 1, 0, 1];

if (!process.argv[2] || !fs.existsSync(inputPath)) {
  console.error('请提供存在的训练数据 JSON 路径。');
  process.exit(2);
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function publicCard(card) {
  return {
    id: String(card.id),
    rank: Number(card.rank),
    suit: String(card.suit),
    deckIndex: Number(card.deckIndex) || 0,
  };
}

function cardsKey(cards = []) {
  return cards.map((card) => String(card.id)).sort().join(',');
}

function resolveLoggedHand(item, level) {
  if (item.action !== 'play' || !item.cards?.length) return null;
  const variants = parseHandVariants(item.cards, level);
  if (item.signature) {
    const declared = variants.find((hand) => handSignature(hand) === item.signature);
    if (declared) return declared;
  }
  return variants[0] || parseHand(item.cards, level);
}

function sameDecision(decision, item, level) {
  if ((decision?.action || 'pass') !== item.action) return false;
  if (item.action === 'pass') return true;
  if (cardsKey(decision.cards) !== cardsKey(item.cards)) return false;
  return !item.signature || handSignature(decision.hand) === item.signature
    || handSignature(resolveLoggedHand(item, level)) === handSignature(decision.hand);
}

function decisionLabel(decision) {
  if (!decision || decision.action === 'pass') return '过牌';
  return `${decision.hand?.type || 'play'}:${decision.hand?.mainRank ?? ''}`;
}

function loggedLabel(item, level) {
  if (item.action === 'pass') return '过牌';
  const hand = resolveLoggedHand(item, level);
  return `${hand?.type || item.handType || 'play'}:${hand?.mainRank ?? ''}`;
}

function evaluationSnapshot(result) {
  return {
    score: result?.score ?? null,
    tags: result?.mistakeTags || [],
    summary: result?.summary || '',
    betterAlternative: result?.betterAlternative
      ? {
          label: result.betterAlternative.label || decisionLabel({
            action: 'play',
            cards: result.betterAlternative.cards,
            hand: result.betterAlternative.hand,
          }),
          cards: (result.betterAlternative.cards || []).map(publicCard),
        }
      : null,
  };
}

function contextFor(replay, state, item, seat, variant) {
  return {
    seat,
    hand: state.hands[seat].map(publicCard),
    level: replay.level,
    lastHand: state.lastHand ? { ...state.lastHand } : null,
    lastSeat: state.lastSeat,
    handCounts: Array.isArray(item.countsBefore)
      ? item.countsBefore.slice(0, 4) : state.hands.map((hand) => hand.length),
    teams: TEAMS,
    finishOrder: state.finishOrder.slice(),
    playedCards: state.playedCards.map(publicCard),
    publicHistory: state.publicHistory.slice(),
    difficulty: 'master',
    deterministic: true,
    policyProfile: variant.policyProfile,
    policyFeatures: variant.policyFeatures,
    policyThresholds: variant.policyThresholds,
  };
}

function publicHistoryItem(item, hand) {
  return {
    turn: item.turn,
    trickNumber: item.trickNumber,
    seat: item.seat,
    action: item.action,
    cards: item.action === 'play' ? (item.cards || []).map(publicCard) : [],
    hand: hand ? {
      type: hand.type,
      mainRank: hand.mainRank,
      size: hand.size,
      power: hand.power,
    } : null,
    countsBefore: Array.isArray(item.countsBefore) ? item.countsBefore.slice(0, 4) : [],
    countsAfter: Array.isArray(item.countsAfter) ? item.countsAfter.slice(0, 4) : [],
  };
}

function auditReplay(replay, index, expert, ablated) {
  const state = {
    hands: replay.initialHands.map((hand) => hand.map(publicCard)),
    finishOrder: [],
    playedCards: [],
    publicHistory: [],
    lastHand: null,
    lastSeat: null,
    trickNumber: null,
  };
  const report = {
    index,
    round: replay.round,
    time: replay.time,
    level: replay.level,
    finishOrder: replay.finishOrder || [],
    aiTurns: 0,
    actualMatchesExpert: 0,
    humanTurns: 0,
    humanMatchesExpert: 0,
    humanDivergences: [],
    currentDivergences: [],
    interventions: [],
    lowRatedAI: [],
  };

  for (let logIndex = 0; logIndex < (replay.trickLog || []).length; logIndex++) {
    const item = replay.trickLog[logIndex];
    if (state.trickNumber !== item.trickNumber) {
      state.trickNumber = item.trickNumber;
      state.lastHand = null;
      state.lastSeat = null;
    }
    const seat = Number(item.seat);
    const ctx = contextFor(replay, state, item, seat, expert);
    const expertDecision = recommendPlay(ctx);
    if (seat !== 0) {
      const oldDecision = recommendPlay({
        ...ctx,
        policyProfile: ablated.policyProfile,
        policyFeatures: ablated.policyFeatures,
        policyThresholds: ablated.policyThresholds,
      });
      report.aiTurns += 1;
      if (sameDecision(expertDecision, item, replay.level)) report.actualMatchesExpert += 1;
      else {
        // 真实页面的“快”速度只给本地搜索60ms。仅在完整大师与实战动作不同时
        // 追加两档限时重算，避免给全部841手重复做三遍搜索。
        const fastDecision = chooseAIPlay({
          ...ctx, deterministic: false, timeBudgetMs: 60,
        });
        const normalDecision = chooseAIPlay({
          ...ctx, deterministic: false, timeBudgetMs: 250,
        });
        report.currentDivergences.push({
          turn: item.turn ?? logIndex + 1,
          seat,
          counts: item.countsBefore || [],
          lastSeat: state.lastSeat,
          lastHand: state.lastHand ? {
            type: state.lastHand.type,
            mainRank: state.lastHand.mainRank,
            size: state.lastHand.size,
            power: state.lastHand.power,
          } : null,
          actual: loggedLabel(item, replay.level),
          fast60ms: decisionLabel(fastDecision),
          normal250ms: decisionLabel(normalDecision),
          currentRecommendation: decisionLabel(expertDecision),
          currentReason: expertDecision?.reason || '',
        });
      }
      if (!sameDecision(expertDecision, {
        ...item,
        action: oldDecision?.action || 'pass',
        cards: oldDecision?.cards || [],
        signature: oldDecision?.hand ? handSignature(oldDecision.hand) : null,
      }, replay.level)) {
        report.interventions.push({
          turn: item.turn ?? logIndex + 1,
          seat,
          counts: item.countsBefore || [],
          actual: loggedLabel(item, replay.level),
          before: decisionLabel(oldDecision),
          after: decisionLabel(expertDecision),
          reason: expertDecision?.reason || '',
        });
      }

      const rating = evaluatePlay({
        ...ctx,
        action: item.action,
        cards: item.cards || [],
        handBefore: state.hands[seat],
      });
      if (rating.score < 60) {
        report.lowRatedAI.push({
          turn: item.turn ?? logIndex + 1,
          seat,
          counts: item.countsBefore || [],
          lastSeat: state.lastSeat,
          lastHand: state.lastHand ? {
            type: state.lastHand.type,
            mainRank: state.lastHand.mainRank,
            size: state.lastHand.size,
            power: state.lastHand.power,
          } : null,
          handBefore: state.hands[seat].map(publicCard),
          actual: loggedLabel(item, replay.level),
          currentRecommendation: decisionLabel(expertDecision),
          currentReason: expertDecision?.reason || '',
          currentCandidates: (expertDecision?.candidates || []).map((candidate) => ({
            id: candidate.id,
            action: candidate.action,
            label: candidate.action === 'pass'
              ? '过牌' : `${candidate.hand?.type || 'play'}:${candidate.hand?.mainRank ?? ''}`,
            cards: (candidate.cards || []).map(publicCard),
            score: candidate.localScore ?? null,
            projectedTricks: candidate.projectedTricks ?? null,
            tags: candidate.tags || [],
          })),
          ...evaluationSnapshot(rating),
        });
      }
    } else {
      report.humanTurns += 1;
      if (sameDecision(expertDecision, item, replay.level)) {
        report.humanMatchesExpert += 1;
      } else {
        const rating = item.evaluation || evaluatePlay({
          ...ctx,
          action: item.action,
          cards: item.cards || [],
          handBefore: state.hands[seat],
        });
        report.humanDivergences.push({
          turn: item.turn ?? logIndex + 1,
          counts: item.countsBefore || [],
          lastSeat: state.lastSeat,
          lastHand: state.lastHand ? {
            type: state.lastHand.type,
            mainRank: state.lastHand.mainRank,
            size: state.lastHand.size,
            power: state.lastHand.power,
          } : null,
          handBefore: state.hands[seat].map(publicCard),
          actual: loggedLabel(item, replay.level),
          currentRecommendation: decisionLabel(expertDecision),
          currentReason: expertDecision?.reason || '',
          ...evaluationSnapshot(rating),
        });
      }
    }

    const loggedHand = resolveLoggedHand(item, replay.level);
    if (item.action === 'play' && loggedHand) {
      state.hands[seat] = removeCards(state.hands[seat], item.cards);
      state.playedCards.push(...item.cards.map(publicCard));
      state.lastHand = loggedHand;
      state.lastSeat = seat;
      if (state.hands[seat].length === 0 && !state.finishOrder.includes(seat)) {
        state.finishOrder.push(seat);
      }
    }
    state.publicHistory.push(publicHistoryItem(item, loggedHand));
  }
  report.expertMatchRate = report.aiTurns
    ? report.actualMatchesExpert / report.aiTurns : null;
  report.humanMatchRate = report.humanTurns
    ? report.humanMatchesExpert / report.humanTurns : null;
  return report;
}

const raw = JSON.parse(fs.readFileSync(inputPath, 'utf8').replace(/^\uFEFF/, ''));
const replays = (raw.replays || []).slice(0, replayLimit);
const expert = resolvePolicyVariant('expert');
const ablated = resolvePolicyVariant('no-replay-v2');
const startedAt = performance.now();
const reports = replays.map((replay, index) => auditReplay(replay, index, expert, ablated));
const summary = {
  source: inputPath,
  replayCount: reports.length,
  aiTurns: reports.reduce((sum, replay) => sum + replay.aiTurns, 0),
  actualMatchesExpert: reports.reduce((sum, replay) => sum + replay.actualMatchesExpert, 0),
  humanTurns: reports.reduce((sum, replay) => sum + replay.humanTurns, 0),
  humanMatchesExpert: reports.reduce((sum, replay) => sum + replay.humanMatchesExpert, 0),
  interventions: reports.reduce((sum, replay) => sum + replay.interventions.length, 0),
  lowRatedAI: reports.reduce((sum, replay) => sum + replay.lowRatedAI.length, 0),
  elapsedMs: Math.round((performance.now() - startedAt) * 10) / 10,
};
summary.expertMatchRate = summary.aiTurns
  ? summary.actualMatchesExpert / summary.aiTurns : null;
summary.humanMatchRate = summary.humanTurns
  ? summary.humanMatchesExpert / summary.humanTurns : null;
const output = {
  summary,
  note: '逐手反事实审计沿用真实公开历史；interventions 表示本轮模块相对 no-replay-v2 的直接改选，不等同于整局因果胜率。',
  replays: reports,
};

if (jsonOnly) {
  console.log(JSON.stringify(output, null, 2));
} else {
  console.log(`复盘 ${summary.replayCount} 副，AI ${summary.aiTurns} 手`);
  console.log(`当前策略复现实际动作 ${summary.actualMatchesExpert}/${summary.aiTurns}（${(summary.expertMatchRate * 100).toFixed(1)}%）`);
  console.log(`本轮真实复盘模块直接介入 ${summary.interventions} 手；旧动作低于60分 ${summary.lowRatedAI} 手`);
  console.log(`耗时 ${summary.elapsedMs}ms`);
  for (const replay of reports) {
    console.log(`\n${replay.time || `复盘${replay.index + 1}`} · 打${replay.level} · 介入${replay.interventions.length}手`);
    for (const item of replay.interventions.slice(0, 12)) {
      console.log(`  第${item.turn}手 座位${item.seat}：${item.before} → ${item.after}（实际 ${item.actual}）`);
    }
  }
}
