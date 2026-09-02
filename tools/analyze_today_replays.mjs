#!/usr/bin/env node
/**
 * 今日对局复盘盲评工具：从浏览器导出的 replays.json 重放每副牌，
 * 在每个 AI 座位（1=下家、2=对家、3=上家）决策点，用同样的公开信息
 * （本家手牌 + 桌面历史 + 各家张数）询问专家策略，与实际出牌对比。
 * 不读取其他座位暗牌：initialHands 只用于还原行动者自己的手牌。
 *
 * 用法：node tools/analyze_today_replays.mjs [replays.json] [--out=报告.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chooseAIPlay } = await import(pathToFileURL(path.join(root, 'js/ai.js')).href);
const { aiDecisionContext, PHASE } = await import(pathToFileURL(path.join(root, 'js/game.js')).href);
const { parseHand, formatHand, handSignature } = await import(pathToFileURL(path.join(root, 'js/rules.js')).href);

const args = process.argv.slice(2);
const inPath = args.find((a) => !a.startsWith('--')) || path.join(root, 'tools/extracted/replays.json');
const outPath = (args.find((a) => a.startsWith('--out=')) || '--out=tools/extracted/today_analysis.json').slice(6);

const SEAT_LABEL = ['你', '下家', '对家', '上家'];
const TEAM_OF = [0, 1, 0, 1];

const replays = JSON.parse(fs.readFileSync(inPath, 'utf-8'));
// 只看今天（按 endedAt 日期过滤，参数可传日期）
const dateFilter = (args.find((a) => a.startsWith('--date=')) || `--date=${new Date().toISOString().slice(0, 10)}`).slice(7);
const today = replays.filter((r) => String(r.endedAt || r.time || '').slice(0, 10) === dateFilter);
console.log(`共 ${replays.length} 副复盘，${dateFilter} 有 ${today.length} 副`);

function decisionKey(action, cards) {
  if (action !== 'play') return 'pass';
  return `play:${(cards || []).map((c) => String(c.id)).sort().join(',')}`;
}

function cardText(cards) {
  return (cards || []).map((c) => `${{ S: '♠', H: '♥', D: '♦', C: '♣' }[c.suit] || ''}${c.rank}`).join(' ');
}

function analyzeGame(replay) {
  const hands = replay.initialHands.map((h) => h.map((c) => ({ ...c })));
  const level = replay.level;
  const rebuilt = [];
  let lastHand = null;
  let lastSeat = null;
  const finishOrder = [];
  let currentTrickStartIndex = 0;
  const findings = [];
  let aiDecisions = 0;
  let matchCount = 0;
  let checkedFirstLead = new Set();

  for (const entry of replay.trickLog) {
    const seat = entry.seat;
    if (!rebuilt.length || entry.trickNumber !== rebuilt[rebuilt.length - 1].trickNumber) {
      lastHand = null;
      lastSeat = null;
      currentTrickStartIndex = rebuilt.length;
    }

    if (seat !== 0 && !finishOrder.includes(seat)) {
      aiDecisions += 1;
      const state = {
        round: replay.round,
        trickNumber: entry.trickNumber,
        phase: PHASE.PLAYING,
        settings: {
          difficulty: 'master',
          deterministicAI: true,
          opponentModelMode: 'off',
          localAiEngine: 'expert',
        },
        hands,
        currentLevel: level,
        handCounts: hands.map((h) => h.length),
        lastHand,
        lastSeat,
        finishOrder: finishOrder.slice(),
        trickLog: rebuilt.slice(),
        currentTrickStartIndex,
        opponentModel: null,
      };
      let expert = null;
      try {
        const ctx = aiDecisionContext(state, seat);
        expert = chooseAIPlay({
          ...ctx,
          difficulty: 'master',
          deterministic: true,
          timeBudgetMs: 0,
          decisionEngine: 'expert',
          policyProfile: 'expert',
        });
      } catch (e) {
        expert = { error: String(e && e.message || e) };
      }

      const actualKey = decisionKey(entry.action, entry.cards);
      const expertKey = expert && !expert.error
        ? decisionKey(expert.action, expert.cards)
        : `error:${expert && expert.error}`;
      const agree = actualKey === expertKey;
      if (agree) matchCount += 1;

      if (!agree) {
        // 公开信息规则检测
        const opponentsPassed = [];
        if (lastHand && lastSeat != null && TEAM_OF[lastSeat] === TEAM_OF[seat]) {
          for (let i = rebuilt.length - 1; i >= currentTrickStartIndex; i--) {
            const it = rebuilt[i];
            if (it.action !== 'pass') break;
            if (TEAM_OF[it.seat] !== TEAM_OF[seat]) opponentsPassed.push(it.seat);
          }
        }
        const beatPartner = entry.action === 'play' && lastHand && lastSeat != null
          && TEAM_OF[lastSeat] === TEAM_OF[seat]
          && opponentsPassed.length >= 2;
        const trickActions = rebuilt.slice(currentTrickStartIndex);
        findings.push({
          id: replay.id,
          round: replay.round,
          engine: replay.localAiEngine,
          turn: entry.turn,
          trickNumber: entry.trickNumber,
          seat,
          seatLabel: SEAT_LABEL[seat],
          isPartnerSeat: seat === 2,
          leading: !lastHand,
          lastHand: lastHand ? formatHand(lastHand) : null,
          lastSeat: lastSeat == null ? null : SEAT_LABEL[lastSeat],
          actual: {
            action: entry.action,
            cards: entry.cards ? cardText(entry.cards) : null,
            handType: entry.handType,
            reason: entry.decisionMeta?.reason || null,
          },
          expert: expert && !expert.error ? {
            action: expert.action,
            cards: expert.cards ? cardText(expert.cards) : null,
            handType: expert.hand ? formatHand(expert.hand) : (expert.action === 'pass' ? null : undefined),
          } : { error: expert && expert.error },
          countsBefore: entry.countsBefore,
          beatPartner,
          trickActions: trickActions.map((t) => `${SEAT_LABEL[t.seat]}${t.action === 'play' ? '出' : '过'}${t.cards && t.cards.length ? ` ${cardText(t.cards)}(${formatHand(t.hand)})` : ''}`),
        });
      }
    }

    if (entry.action === 'play') {
      const playedIds = new Set(entry.cards.map((c) => c.id));
      hands[seat] = hands[seat].filter((c) => !playedIds.has(c.id));
      let hand = null;
      try {
        hand = parseHand(entry.cards, level);
      } catch {
        hand = null;
      }
      rebuilt.push({
        turn: entry.turn,
        trickNumber: entry.trickNumber,
        seat,
        action: 'play',
        cards: entry.cards,
        hand,
        countsBefore: entry.countsBefore,
        countsAfter: entry.countsAfter,
      });
      lastHand = hand;
      lastSeat = seat;
      if (hands[seat].length === 0 && !finishOrder.includes(seat)) finishOrder.push(seat);
    } else {
      rebuilt.push({
        turn: entry.turn,
        trickNumber: entry.trickNumber,
        seat,
        action: 'pass',
        cards: [],
        hand: null,
        countsBefore: entry.countsBefore,
        countsAfter: entry.countsAfter,
      });
    }
  }

  return {
    id: replay.id,
    round: replay.round,
    level: replay.level,
    engine: replay.localAiEngine,
    finishOrder: replay.finishOrder,
    places: replay.places,
    winTeam: replay.winTeam,
    aiDecisions,
    divergences: findings.length,
    findings,
  };
}

const analyzed = today.map(analyzeGame);
const summary = {
  date: dateFilter,
  games: analyzed.length,
  aiDecisions: analyzed.reduce((s, g) => s + g.aiDecisions, 0),
  divergences: analyzed.reduce((s, g) => s + g.divergences, 0),
  bySeat: [1, 2, 3].map((seat) => ({
    seat: SEAT_LABEL[seat],
    divergences: analyzed.reduce((s, g) => s + g.findings.filter((f) => f.seat === seat).length, 0),
    beatPartner: analyzed.reduce((s, g) => s + g.findings.filter((f) => f.seat === seat && f.beatPartner).length, 0),
  })),
  byEngine: {},
};
for (const g of analyzed) {
  const k = g.engine || 'unknown';
  summary.byEngine[k] = summary.byEngine[k] || { games: 0, aiDecisions: 0, divergences: 0 };
  summary.byEngine[k].games += 1;
  summary.byEngine[k].aiDecisions += g.aiDecisions;
  summary.byEngine[k].divergences += g.divergences;
}

fs.writeFileSync(outPath, JSON.stringify({ summary, games: analyzed }, null, 1), 'utf-8');
console.log(JSON.stringify(summary, null, 2));
console.log(`明细 -> ${outPath}`);
