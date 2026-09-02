#!/usr/bin/env node
/**
 * 公开信息失误检测：只用桌面可见信息（各家张数、出牌历史、行动者自己的手牌）
 * 检测上家/下家/对家（座位 1/2/3）的典型战术失误。不看任何暗牌。
 *
 * 检测器：
 *  R1 压对家 —— 队友的牌已赢下当前轮（对手都过牌或已走完），行动者仍出更大的牌抢轮
 *  R2 给报牌对手送单 —— 某对手只剩 1 张时，领出小单张（<=J），大概率送其走完
 *  R3 不压制报牌对手 —— 报牌(<=2张)对手正赢着当前轮，行动者有牌可压却过牌
 *  R4 炸队友已赢的轮 —— 队友已赢当前轮时用炸弹
 *
 * 用法：node tools/detect_public_mistakes.mjs [--date=2026-08-31]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { parseHand, formatHand, generateLegalPlays } = await import(pathToFileURL(path.join(root, 'js/rules.js')).href);

const args = process.argv.slice(2);
const dateFilter = (args.find((a) => a.startsWith('--date=')) || `--date=${new Date().toISOString().slice(0, 10)}`).slice(7);
const inPath = args.find((a) => !a.startsWith('--')) || path.join(root, 'tools/extracted/replays.json');
const outPath = (args.find((a) => a.startsWith('--out=')) || '--out=tools/extracted/today_public_mistakes.json').slice(6);

const SEAT_LABEL = ['你', '下家', '对家', '上家'];
const TEAM_OF = [0, 1, 0, 1];
const SUIT_SYM = { S: '♠', H: '♥', D: '♦', C: '♣' };

const replays = JSON.parse(fs.readFileSync(inPath, 'utf-8'));
const today = replays.filter((r) => String(r.endedAt || r.time || '').slice(0, 10) === dateFilter);
console.log(`${dateFilter}: ${today.length} 副`);

const cardText = (cards) => (cards || []).map((c) => `${SUIT_SYM[c.suit] || ''}${c.rank}`).join(' ');

function detect(replay) {
  const hands = replay.initialHands.map((h) => h.map((c) => ({ ...c })));
  const level = replay.level;
  const log = replay.trickLog;
  const findings = [];
  let lastHand = null;
  let lastSeat = null;
  const finishOrder = [];
  let trickStart = 0;

  const handCounts = () => hands.map((h) => h.length);

  for (let i = 0; i < log.length; i += 1) {
    const entry = log[i];
    const seat = entry.seat;
    if (i === 0 || entry.trickNumber !== log[i - 1].trickNumber) {
      lastHand = null;
      lastSeat = null;
      trickStart = i;
    }

    if (seat !== 0 && entry.action === 'play' && !finishOrder.includes(seat)) {
      const opponents = [0, 1, 2, 3].filter((s) => TEAM_OF[s] !== TEAM_OF[seat]);
      const partner = [0, 1, 2, 3].find((s) => s !== seat && TEAM_OF[s] === TEAM_OF[seat]);
      // R1 压对家：队友正在赢这轮，且两个对手都已过牌或已走完
      if (lastHand && lastSeat === partner) {
        const passedAfter = [];
        for (let j = i - 1; j >= trickStart; j -= 1) {
          if (log[j].action !== 'pass') break;
          passedAfter.push(log[j].seat);
        }
        const opp1Done = finishOrder.includes(opponents[0]);
        const opp2Done = finishOrder.includes(opponents[1]);
        const opp1Passed = passedAfter.includes(opponents[0]);
        const opp2Passed = passedAfter.includes(opponents[1]);
        const oppsNeutral = (opp1Done || opp1Passed) && (opp2Done || opp2Passed);
        if (oppsNeutral) {
          const played = parseHand(entry.cards, level);
          const isBomb = played && /炸弹/.test(formatHand(played));
          findings.push({
            rule: isBomb ? 'R4' : 'R1',
            ruleName: isBomb ? '炸队友已赢的轮' : '压对家（队友已赢这轮仍抢）',
            round: replay.round, turn: entry.turn, trickNumber: entry.trickNumber,
            seat, seatLabel: SEAT_LABEL[seat],
            detail: `队友${SEAT_LABEL[partner]}出的 ${formatHand(lastHand)} 已赢下本轮（对手无响应），${SEAT_LABEL[seat]}仍出 ${formatHand(played)}`,
            counts: entry.countsBefore,
            actualCards: cardText(entry.cards),
            reason: entry.decisionMeta?.reason || null,
          });
        }
      }

      // R2 给报牌对手送单：领出小单张且某对手只剩 1 张
      if (!lastHand) {
        const played = parseHand(entry.cards, level);
        const counts = handCounts();
        for (const opp of opponents) {
          if (counts[opp] === 1 && played && played.type === 'single' && played.mainRank <= 11) {
            findings.push({
              rule: 'R2',
              ruleName: '给报牌对手送单',
              round: replay.round, turn: entry.turn, trickNumber: entry.trickNumber,
              seat, seatLabel: SEAT_LABEL[seat],
              detail: `${SEAT_LABEL[opp]}只剩 1 张，${SEAT_LABEL[seat]}领出单张 ${cardText(entry.cards)}（<=J），送走风险大`,
              counts: entry.countsBefore,
              actualCards: cardText(entry.cards),
              reason: entry.decisionMeta?.reason || null,
            });
          }
        }
      }
    }

    if (seat !== 0 && entry.action === 'pass' && !finishOrder.includes(seat)) {
      // R3 不压制报牌对手：对手正赢本轮且剩牌<=2，行动者有可压的牌却过
      const opponents = [0, 1, 2, 3].filter((s) => TEAM_OF[s] !== TEAM_OF[seat]);
      if (lastHand && opponents.includes(lastSeat)) {
        const counts = handCounts();
        if (counts[lastSeat] <= 2 && hands[seat].length > 0) {
          const beats = generateLegalPlays(hands[seat], level, lastHand)
            .filter((h) => h.cards && h.cards.length);
          if (beats.length) {
            findings.push({
              rule: 'R3',
              ruleName: '不压制报牌对手',
              round: replay.round, turn: entry.turn, trickNumber: entry.trickNumber,
              seat, seatLabel: SEAT_LABEL[seat],
              detail: `报牌的${SEAT_LABEL[lastSeat]}（剩${counts[lastSeat]}张）正赢本轮 ${formatHand(lastHand)}，${SEAT_LABEL[seat]}有 ${beats.length} 种压牌却过牌`,
              counts: entry.countsBefore,
              actualCards: null,
              beatSamples: beats.slice(0, 3).map((b) => formatHand(b)),
              reason: entry.decisionMeta?.reason || null,
            });
          }
        }
      }
    }

    if (entry.action === 'play') {
      const playedIds = new Set(entry.cards.map((c) => c.id));
      hands[seat] = hands[seat].filter((c) => !playedIds.has(c.id));
      try {
        lastHand = parseHand(entry.cards, level);
      } catch {
        lastHand = null;
      }
      lastSeat = seat;
      if (hands[seat].length === 0 && !finishOrder.includes(seat)) finishOrder.push(seat);
    }
  }
  return findings;
}

const all = [];
for (const replay of today) {
  const findings = detect(replay);
  all.push({ id: replay.id, round: replay.round, engine: replay.localAiEngine, places: replay.places, winTeam: replay.winTeam, findings });
}

const summary = { date: dateFilter, games: today.length };
for (const rule of ['R1', 'R2', 'R3', 'R4']) {
  summary[rule] = all.reduce((s, g) => s + g.findings.filter((f) => f.rule === rule).length, 0);
}
fs.writeFileSync(outPath, JSON.stringify({ summary, games: all }, null, 1), 'utf-8');
console.log(JSON.stringify(summary, null, 2));
console.log(`明细 -> ${outPath}`);
