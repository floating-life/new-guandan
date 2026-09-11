/**
 * AI-DATA-001: turn already-downloaded fair external turns into STRAT-1
 * public-info counterexamples. Never training. Botzone official ZIP is empty.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCard } from '../js/cards.js';
import { generateLegalPlays, parseHand, handSignature } from '../js/rules.js';
import {
  assessDownloadedEndgameIntercept, assessEnemyReportLead, assessPartnerTrickControl,
  isLowSingleLead, isSafeEndgameOrdinary,
} from '../js/strategy-core.js';
import {
  buildStrategyCounterexample, fingerprintFiles, validateStrategyCounterexample,
} from './strategy_counterexamples.mjs';

export const EXTERNAL_COUNTEREXAMPLE_SET_SCHEMA = 'guandan-external-strategy-counterexample-set-v1';
export const USED_PROVIDER = 'njupt-game-ai-competition';
const FINGERPRINT_FILES = Object.freeze(['js/cards.js', 'js/rules.js', 'js/strategy-core.js']);

const rootDefault = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function countNonEmptyLines(file) {
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file, 'utf8').split(/\n/).filter((line) => line.trim()).length;
}

function asCards(list) {
  return (list || []).map((card) => createCard(
    Number(card.rank),
    String(card.suit),
    Number.isInteger(Number(card.deckIndex)) ? Number(card.deckIndex) : 0,
  ));
}

function playKey(play) {
  if (!play || play.action === 'pass') return 'pass';
  return `play:${(play.cards || []).map((card) => `${card.rank}:${card.suit}:${card.deckIndex}`).sort().join(',')}`;
}

function compactHistory(history, lastHand) {
  const events = Array.isArray(history) ? history : [];
  if (!lastHand) return [];
  const lastPlay = [...events].reverse().find((event) => event.action === 'play');
  if (!lastPlay) return events.slice(-4);
  return events.slice(events.lastIndexOf(lastPlay));
}

export function inventoryExternalSources(root = rootDefault) {
  const zipPath = path.join(root, '训练数据', 'Botzone', 'reports', 'download-summary.json');
  const zip = fs.existsSync(zipPath) ? readJson(zipPath) : { ok: false, archivesAvailable: 0 };
  const botzoneMatches = countNonEmptyLines(path.join(root, '训练数据', 'Botzone', 'normalized', 'botzone_matches.jsonl'));
  const njuptLines = countNonEmptyLines(path.join(root, '训练数据', '标准化', 'njupt.jsonl'));
  const trajPath = path.join(root, '训练数据', '验证', 'external-trajectory-v2.jsonl');
  let njuptFairTurns = 0;
  let botzoneFairTurns = 0;
  if (fs.existsSync(trajPath)) {
    for (const line of fs.readFileSync(trajPath, 'utf8').split(/\n/)) {
      if (!line.trim()) continue;
      const rec = JSON.parse(line);
      if (rec.provider === USED_PROVIDER) njuptFairTurns += 1;
      if (rec.provider === 'botzone') botzoneFairTurns += 1;
    }
  }
  return {
    botzoneOfficialZip: {
      available: zip.ok === true && Number(zip.archivesAvailable) > 0,
      ok: zip.ok === true,
      archivesAvailable: Number(zip.archivesAvailable) || 0,
      reason: 'official monthly ZIP download empty or failed; do not treat Botzone as a complete archive source',
    },
    botzonePublicPages: {
      matchRecords: botzoneMatches,
      usedForFixtures: false,
      reason: 'public-page structural matches exist but this TASK does not mine Botzone; ZIP is empty',
    },
    njuptArchiveLines: njuptLines,
    njuptFairTurns,
    botzoneFairTurns,
    usedProvider: USED_PROVIDER,
    trajectoryPath: '训练数据/验证/external-trajectory-v2.jsonl',
    trainingEligible: false,
  };
}

function toCandidate(play) {
  if (!play) return { action: 'pass', cards: [], signature: null, tags: [] };
  if (play.action === 'pass' || !play.cards?.length) {
    return { action: 'pass', cards: [], signature: null, tags: [] };
  }
  return {
    action: 'play',
    cards: play.cards,
    signature: play.signature || (play.hand ? handSignature(play.hand) : null),
    tags: [],
  };
}

function buildFixture({ rec, rule, invariants, preferredAction, blockedPlay, extraCandidates, fingerprint }) {
  const obs = rec.observation;
  const lastHand = obs.lastHand || null;
  const candidates = [
    lastHand ? toCandidate({ action: 'pass' }) : null,
    toCandidate(rec.chosen),
    ...(extraCandidates || []).map(toCandidate),
  ].filter(Boolean);
  const unique = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const key = playKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }
  const fixture = buildStrategyCounterexample({
    id: `${rule}:${rec.sourceGameId.slice(0, 12)}:r${rec.sourceRound}:i${rec.recordIndex}`,
    rule,
    level: obs.level,
    seat: obs.seat,
    hand: obs.hand,
    lastHand,
    lastSeat: obs.lastSeat,
    teams: obs.teams,
    finishOrder: obs.finishOrder || [],
    handCounts: obs.handCounts,
    publicHistory: compactHistory(obs.publicHistory, lastHand),
    candidates: unique,
    expected: {
      invariants,
      preferredAction,
      blockedActions: blockedPlay ? [playKey(blockedPlay)] : [],
    },
    sourceFingerprint: { sha256: fingerprint.sha256 },
  });
  fixture.source = {
    provider: rec.provider,
    sourceGameId: rec.sourceGameId,
    sourceRound: rec.sourceRound,
    recordIndex: rec.recordIndex,
    fairness: rec.fairness || 'own_hand_plus_public_history_only',
    trainingEligible: false,
  };
  return fixture;
}

function hitReportLead(rec) {
  const obs = rec.observation;
  const chosen = rec.chosen;
  if (obs.lastHand || chosen?.action !== 'play' || !isLowSingleLead(chosen, obs.level)) return null;
  const hand = asCards(obs.hand);
  const legal = generateLegalPlays(hand, obs.level, null);
  const ctx = {
    ...obs,
    hand,
    lastHand: null,
    policyFeatures: { enemyReportLeadSafety: true },
    mode: 'lead',
  };
  const signal = assessEnemyReportLead(chosen, ctx, legal.map((play) => ({ action: 'play', ...play })));
  if (!signal.blocked) return null;
  const safer = legal.find((play) => play.cards.length >= 2 && play.hand?.type !== 'bomb');
  return { extraCandidates: safer ? [safer] : [], blockedPlay: chosen };
}

function hitEndgameIntercept(rec) {
  const obs = rec.observation;
  const chosen = rec.chosen;
  if (!obs.lastHand || chosen?.action !== 'pass') return null;
  const hand = asCards(obs.hand);
  const lastCards = compactHistory(obs.publicHistory, obs.lastHand)
    .find((event) => event.action === 'play')?.cards;
  const lastHand = lastCards?.length ? parseHand(asCards(lastCards), obs.level) : obs.lastHand;
  const legal = generateLegalPlays(hand, obs.level, lastHand);
  const candidates = [
    { action: 'pass', cards: [], hand: null },
    ...legal.map((play) => ({ action: 'play', ...play })),
  ];
  const ctx = {
    ...obs,
    hand,
    lastHand,
    policyFeatures: { downloadedEndgameGuards: true },
  };
  if (!assessDownloadedEndgameIntercept(ctx, candidates).blocked) return null;
  const safer = legal.find((play) => isSafeEndgameOrdinary(play));
  return {
    extraCandidates: safer ? [safer] : [],
    blockedPlay: { action: 'pass', cards: [] },
  };
}

function hitPartnerYield(rec) {
  const obs = rec.observation;
  const chosen = rec.chosen;
  if (!obs.lastHand || chosen?.action !== 'play') return null;
  const hand = asCards(obs.hand);
  const lastCards = compactHistory(obs.publicHistory, obs.lastHand)
    .find((event) => event.action === 'play')?.cards;
  const lastHand = lastCards?.length ? parseHand(asCards(lastCards), obs.level) : obs.lastHand;
  const ctx = {
    ...obs,
    hand,
    lastHand,
    policyFeatures: { partnerTrickControl: true },
  };
  const finishing = (chosen.cards || []).length === hand.length;
  if (finishing || !assessPartnerTrickControl(ctx).shouldYield) return null;
  return { extraCandidates: [], blockedPlay: chosen };
}

export function mineExternalStrategyCounterexamples(root = rootDefault, options = {}) {
  const inventory = inventoryExternalSources(root);
  if (inventory.botzoneOfficialZip.available) {
    throw new Error('Botzone official ZIP unexpectedly available; refuse silent mix-in');
  }
  const trajPath = path.join(root, inventory.trajectoryPath);
  if (!fs.existsSync(trajPath)) throw new Error(`缺少公平轨迹: ${inventory.trajectoryPath}`);
  const fingerprint = fingerprintFiles(root, FINGERPRINT_FILES);
  let reportHit = null;
  let partnerHit = null;
  let endgameHit = null;
  for (const line of fs.readFileSync(trajPath, 'utf8').split(/\n/)) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line);
    if (rec.provider !== USED_PROVIDER || rec.trainingEligible === true) continue;
    if (!reportHit) {
      const hit = hitReportLead(rec);
      if (hit) reportHit = { rec, ...hit };
    }
    if (!partnerHit) {
      const hit = hitPartnerYield(rec);
      if (hit) partnerHit = { rec, ...hit };
    }
    if (!endgameHit) {
      const hit = hitEndgameIntercept(rec);
      if (hit) endgameHit = { rec, ...hit };
    }
    if (reportHit && partnerHit && endgameHit) break;
  }
  if (!reportHit || !partnerHit) {
    throw new Error('南邮公平轨迹未找到报单送低单与接风被抢两类信号');
  }
  if (!endgameHit) {
    throw new Error('南邮公平轨迹未找到残局过牌可拦截信号');
  }
  const fixtures = [
    buildFixture({
      rec: reportHit.rec,
      rule: 'AI-DATA-001-enemy-report-lead',
      invariants: ['enemy_reporting', 'low_single_lead', 'safer_non_single_available'],
      preferredAction: null,
      blockedPlay: reportHit.blockedPlay,
      extraCandidates: reportHit.extraCandidates,
      fingerprint,
    }),
    buildFixture({
      rec: partnerHit.rec,
      rule: 'AI-DATA-001-partner-trick-control',
      invariants: [
        'partner_current_trick_winner',
        'all_active_enemies_passed_or_finished',
        'prefer_pass_with_tactical_constraint',
      ],
      preferredAction: 'pass',
      blockedPlay: partnerHit.blockedPlay,
      extraCandidates: partnerHit.extraCandidates,
      fingerprint,
    }),
    buildFixture({
      rec: endgameHit.rec,
      rule: 'AI-DATA-001-endgame-intercept',
      invariants: [
        'last_enemy_short_hand',
        'safe_ordinary_response_available',
        'block_pass',
      ],
      preferredAction: 'play',
      blockedPlay: endgameHit.blockedPlay,
      extraCandidates: endgameHit.extraCandidates,
      fingerprint,
    }),
  ];
  for (const fixture of fixtures) {
    const errors = validateStrategyCounterexample(fixture);
    if (errors.length) throw new Error(`${fixture.id}: ${errors.join('；')}`);
  }
  const set = {
    schema: EXTERNAL_COUNTEREXAMPLE_SET_SCHEMA,
    ruleVersion: 'guandan-rules-v1',
    trainingEligible: false,
    diagnosticOnly: true,
    sourceFingerprint: fingerprint,
    inventory,
    findings: [
      'Botzone official monthly ZIP is empty (archivesAvailable=0); skipped as a fixture source.',
      'NJUPT fair trajectories contain enemy-report low-single leads, partner-trick-control overplays, and short-enemy passes with a safe ordinary response.',
    ],
    fixtures,
  };
  const outputPath = options.outputPath || path.join(root, 'tools', 'external-strategy-counterexamples.json');
  if (options.write !== false) {
    fs.writeFileSync(outputPath, `${JSON.stringify(set, null, 2)}\n`);
  }
  return set;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.some((arg) => /^--(?:release|promotion|train|full-data)/i.test(arg))) {
    throw new Error(`拒绝发布或训练入口: ${argv.join(' ')}`);
  }
  const set = mineExternalStrategyCounterexamples();
  process.stdout.write(`${JSON.stringify({
    schema: set.schema,
    trainingEligible: set.trainingEligible,
    fixtureCount: set.fixtures.length,
    rules: set.fixtures.map((item) => item.rule),
    inventory: set.inventory,
  })}\n`);
  return set;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.name}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
