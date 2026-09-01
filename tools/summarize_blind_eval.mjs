#!/usr/bin/env node
/**
 * Strict human blind-evaluation receipt. Passing requires at least ten allocated
 * participants, ten answers each, complete allocation/answers, player-cluster
 * bootstrap lower bound > 0.5, complete catastrophe review, and proposed
 * catastrophe rate no higher than expert.
 *
 * Catastrophe review:
 * { schema: 'guandan-blind-catastrophe-review-v2',
 *   reviews: [{ id, expert: false, proposed: false }] }
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const MIN_PLAYERS = 10;
const MIN_ANSWERS_PER_PLAYER = 10;
const options = parseArgs(process.argv.slice(2));
const manifest = readJson(path.join(options.dataDir, 'manifest.json'));
if (manifest.schema !== 'guandan-blind-eval-manifest-v2') throw new Error('题目目录不是严格盲评 v2 manifest');
const expectedPlayers = Number(manifest.players);
if (!Number.isInteger(expectedPlayers) || expectedPlayers < 1) throw new Error('manifest.players 无效');
if (!Array.isArray(manifest.scenarioIds) || !manifest.scenarioIds.length
  || !Number.isInteger(manifest.selectedScenarios)
  || manifest.selectedScenarios !== manifest.scenarioIds.length) {
  throw new Error('manifest.selectedScenarios 与 scenarioIds 数量不一致或无效');
}
const selectedIds = new Set();
for (const id of manifest.scenarioIds) {
  if (typeof id !== 'string' || !id || selectedIds.has(id)) {
    throw new Error(`manifest 场景 ID 必须是非空字符串且唯一：${String(id)}`);
  }
  selectedIds.add(id);
}
const allocation = validateAllocation(manifest, selectedIds);

const receivedPlayers = new Set(fs.existsSync(options.answersDir)
  ? fs.readdirSync(options.answersDir)
    .filter((name) => /^player-\d+\.answers\.json$/.test(name))
    .map((name) => Number(name.match(/\d+/)[0]))
  : []);
const allocationOwners = new Map();
const players = [];
const invalidAnswers = [];
const allSelections = [];
const answerLedger = [];

for (let playerNo = 1; playerNo <= expectedPlayers; playerNo += 1) {
  const keyFile = path.join(options.dataDir, `player-${playerNo}.key.json`);
  if (!fs.existsSync(keyFile)) throw new Error(`缺少答案键：${keyFile}`);
  const keyPayload = readJson(keyFile);
  if (keyPayload.schema !== 'guandan-blind-eval-key-v2' || keyPayload.player !== playerNo) {
    throw new Error(`答案键格式无效：${keyFile}`);
  }
  const mapping = keyPayload.mapping || {};
  const expectedScenarioIds = allocation.byPlayer.get(playerNo) || [];
  if (!sameArray(Object.keys(mapping), expectedScenarioIds)) {
    throw new Error(`答案键 ${playerNo} 的题目集合与 manifest allocation 不一致`);
  }
  for (const id of Object.keys(mapping)) {
    if (!selectedIds.has(id)) throw new Error(`答案键包含 manifest 外题目：${id}`);
    if (allocationOwners.has(id)) {
      invalidAnswers.push({ type: 'scenario_allocated_to_multiple_players', id, players: [allocationOwners.get(id), playerNo] });
    } else allocationOwners.set(id, playerNo);
  }

  let answerPayload = null;
  const answerFile = path.join(options.answersDir, `player-${playerNo}.answers.json`);
  if (fs.existsSync(answerFile)) {
    answerPayload = readJson(answerFile);
    if (answerPayload.schema !== 'guandan-blind-eval-answers-v2'
      || Number(answerPayload.player) !== playerNo
      || answerPayload.assignmentSha256 !== keyPayload.assignmentSha256) {
      invalidAnswers.push({ type: 'answer_payload_binding_invalid', player: playerNo });
      answerPayload = null;
    }
  }
  const byId = new Map();
  for (const record of Array.isArray(answerPayload?.answers) ? answerPayload.answers : []) {
    const id = String(record?.id || '');
    if (!Object.prototype.hasOwnProperty.call(mapping, id)) {
      invalidAnswers.push({ type: 'answer_not_assigned_to_player', player: playerNo, id });
    } else if (byId.has(id)) {
      invalidAnswers.push({ type: 'duplicate_answer', player: playerNo, id });
    } else byId.set(id, record);
  }
  let proposed = 0;
  let answered = 0;
  let unanswered = 0;
  for (const [id, choices] of Object.entries(mapping)) {
    const choice = byId.get(id)?.choice;
    if (choice !== 'A' && choice !== 'B') {
      answerLedger.push({
        player: playerNo, id, choice: null, side: null,
        mapping: { A: choices.A, B: choices.B },
        assignmentSha256: keyPayload.assignmentSha256,
      });
      unanswered += 1;
      continue;
    }
    const side = choices[choice];
    if (!['expert', 'proposed'].includes(side)) {
      invalidAnswers.push({ type: 'answer_key_side_invalid', player: playerNo, id });
      answerLedger.push({
        player: playerNo, id, choice, side: null,
        mapping: { A: choices.A, B: choices.B },
        assignmentSha256: keyPayload.assignmentSha256,
      });
      unanswered += 1;
      continue;
    }
    answerLedger.push({
      player: playerNo, id, choice, side,
      mapping: { A: choices.A, B: choices.B },
      assignmentSha256: keyPayload.assignmentSha256,
    });
    answered += 1;
    proposed += Number(side === 'proposed');
    allSelections.push({ player: playerNo, id, side });
  }
  players.push({
    player: playerNo,
    submitted: receivedPlayers.has(playerNo),
    assigned: Object.keys(mapping).length,
    answered,
    unanswered,
    proposedPreferred: proposed,
    proposedRate: answered ? rounded(proposed / answered, 4) : null,
  });
}
for (const id of selectedIds) {
  if (!allocationOwners.has(id)) invalidAnswers.push({ type: 'scenario_not_allocated', id });
}

const review = loadCatastropheReview(options.catastrophic, selectedIds);
const chosenCatastrophicCount = { expert: 0, proposed: 0 };
for (const selection of allSelections) {
  if (review.byId.get(selection.id)?.[selection.side] === true) chosenCatastrophicCount[selection.side] += 1;
}
const reviewedCatastrophicCount = { expert: 0, proposed: 0 };
for (const id of selectedIds) {
  const scenarioReview = review.byId.get(id);
  if (scenarioReview?.expert === true) reviewedCatastrophicCount.expert += 1;
  if (scenarioReview?.proposed === true) reviewedCatastrophicCount.proposed += 1;
}
const totalAnswers = allSelections.length;
const totalProposed = allSelections.filter((item) => item.side === 'proposed').length;
const rate = totalAnswers ? totalProposed / totalAnswers : null;
const [wilsonLower, wilsonUpper] = totalAnswers ? wilson95(totalProposed, totalAnswers) : [null, null];
const clusterBootstrap95 = clusterBootstrapCI(players, Number(manifest.randomSeed) || 0);
const catastropheScenarioDenominator = selectedIds.size;
const catastrophic = {
  reviewProvided: review.provided,
  reviewedScenarios: review.byId.size,
  reviewComplete: review.complete,
  scenarioDenominator: catastropheScenarioDenominator,
  // Diagnostic only: this is the arm selected by a participant and may omit
  // the unselected arm for a given scenario.
  selectionDiagnostic: chosenCatastrophicCount,
  // Gate source: both arms are counted for every manifest scenario.
  reviewed: reviewedCatastrophicCount,
  expertRate: review.complete
    ? reviewedCatastrophicCount.expert / catastropheScenarioDenominator : null,
  proposedRate: review.complete
    ? reviewedCatastrophicCount.proposed / catastropheScenarioDenominator : null,
};
catastrophic.proposedNotWorseThanExpert = review.complete
  && reviewedCatastrophicCount.proposed <= reviewedCatastrophicCount.expert;
const gateChecks = {
  minimumParticipants: players.length >= MIN_PLAYERS && players.every((player) => player.submitted),
  minimumAnswersPerParticipant: players.every((player) => player.answered >= MIN_ANSWERS_PER_PLAYER),
  fullCompletion: players.every((player) => player.unanswered === 0),
  allocationWithoutRepeat: invalidAnswers.length === 0 && allocationOwners.size === selectedIds.size,
  playerClusterBootstrap: clusterBootstrap95 != null && clusterBootstrap95[0] > 0.5,
  catastropheReviewComplete: review.complete,
  proposedCatastrophicNotWorse: catastrophic.proposedNotWorseThanExpert,
};
const receipt = {
  schema: 'guandan-blind-eval-summary-v3',
  generatedAt: new Date().toISOString(),
  answersDir: path.resolve(options.answersDir),
  dataDir: path.resolve(options.dataDir),
  manifest: {
    randomSeed: manifest.randomSeed,
    selectedScenarios: selectedIds.size,
    allocatedPlayers: expectedPlayers,
    sourceFiles: manifest.sourceFiles || [],
    selectedScenarioFile: manifest.selectedScenarioFile || null,
    selectedScenarioSha256: manifest.selectedScenarioSha256 || null,
  },
  answerLedger,
  answerLedgerSha256: sha256(Buffer.from(JSON.stringify(answerLedger), 'utf8')),
  players,
  totals: {
    players: players.length,
    submittedPlayers: players.filter((player) => player.submitted).length,
    answered: totalAnswers,
    unanswered: players.reduce((sum, player) => sum + player.unanswered, 0),
    proposedPreferred: totalProposed,
    proposedRate: rounded(rate, 4),
    wilson95Diagnostic: [rounded(wilsonLower, 4), rounded(wilsonUpper, 4)],
    playerClusterBootstrap95: clusterBootstrap95?.map((value) => rounded(value, 4)) || null,
    catastrophic: {
      ...catastrophic,
      expertRate: rounded(catastrophic.expertRate, 4),
      proposedRate: rounded(catastrophic.proposedRate, 4),
    },
  },
  invalidAnswers,
  gate: {
    criterion: '参与者聚类 bootstrap 95% 下界严格 > 0.5，且完成度、无重复分配、灾难性错误对照全部通过',
    checks: gateChecks,
    pass: Object.values(gateChecks).every(Boolean),
  },
};
const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
if (options.out) {
  fs.mkdirSync(path.dirname(options.out), { recursive: true });
  fs.writeFileSync(options.out, serialized, 'utf8');
}
console.log(serialized.trimEnd());
if (!receipt.gate.pass) process.exitCode = 1;

function parseArgs(args) {
  const result = { dataDir: null, answersDir: null, catastrophic: null, out: null };
  for (const raw of args) {
    const item = String(raw);
    if (item.startsWith('--data-dir=')) result.dataDir = path.resolve(item.slice('--data-dir='.length));
    else if (item.startsWith('--answers-dir=')) result.answersDir = path.resolve(item.slice('--answers-dir='.length));
    else if (item.startsWith('--catastrophic=')) result.catastrophic = path.resolve(item.slice('--catastrophic='.length));
    else if (item.startsWith('--out=')) result.out = path.resolve(item.slice('--out='.length));
    else throw new Error(`未知参数：${item}`);
  }
  if (!result.dataDir || !result.answersDir) {
    throw new Error('用法：node tools/summarize_blind_eval.mjs --data-dir=题目目录 --answers-dir=作答目录 --catastrophic=复核.json [--out=回执.json]');
  }
  return result;
}

function validateAllocation(value, selectedIds) {
  const allocation = value?.allocation;
  if (!allocation || allocation.scheme !== 'round-robin-without-replacement'
    || allocation.repeatedScenarioRatings !== false
    || !Array.isArray(allocation.playerQuestionCounts)
    || allocation.playerQuestionCounts.length !== expectedPlayers
    || !Array.isArray(allocation.playerScenarioIds)
    || allocation.playerScenarioIds.length !== expectedPlayers) {
    throw new Error('manifest 缺少可复核的无重复分配清单');
  }
  const byPlayer = new Map();
  const seen = new Set();
  for (const entry of allocation.playerScenarioIds) {
    if (!Number.isInteger(entry?.player) || entry.player < 1 || entry.player > expectedPlayers
      || byPlayer.has(entry.player) || !Array.isArray(entry.scenarioIds)
      || entry.scenarioIds.length < MIN_ANSWERS_PER_PLAYER
      || new Set(entry.scenarioIds).size !== entry.scenarioIds.length
      || entry.scenarioIds.some((id) => !selectedIds.has(id) || seen.has(id))) {
      throw new Error('manifest allocation 必须将每道题恰好分配给一名参与者');
    }
    for (const id of entry.scenarioIds) seen.add(id);
    byPlayer.set(entry.player, entry.scenarioIds.slice());
  }
  if (byPlayer.size !== expectedPlayers || seen.size !== selectedIds.size) {
    throw new Error('manifest allocation 未覆盖全部参与者或场景');
  }
  const counts = new Map();
  for (const entry of allocation.playerQuestionCounts) {
    if (!Number.isInteger(entry?.player) || entry.player < 1 || entry.player > expectedPlayers
      || counts.has(entry.player) || !Number.isInteger(entry.questions)
      || entry.questions !== byPlayer.get(entry.player)?.length) {
      throw new Error('manifest allocation 题数摘要与场景清单不一致');
    }
    counts.set(entry.player, entry.questions);
  }
  if (counts.size !== expectedPlayers) throw new Error('manifest allocation 参与者不完整');
  return { byPlayer };
}

function sameArray(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => value === right[index]);
}

function loadCatastropheReview(file, selectedIds) {
  if (!file) return { provided: false, byId: new Map(), complete: false };
  const payload = readJson(file);
  const reviews = payload?.schema === 'guandan-blind-catastrophe-review-v2' ? payload.reviews : null;
  if (!Array.isArray(reviews)) throw new Error('灾难性错误复核必须是 guandan-blind-catastrophe-review-v2');
  const byId = new Map();
  for (const review of reviews) {
    const id = String(review?.id || '');
    if (!selectedIds.has(id) || byId.has(id)
      || typeof review.expert !== 'boolean' || typeof review.proposed !== 'boolean') {
      throw new Error(`灾难性错误复核条目无效或重复：${id || '(missing id)'}`);
    }
    byId.set(id, { expert: review.expert, proposed: review.proposed });
  }
  return { provided: true, byId, complete: byId.size === selectedIds.size };
}

function clusterBootstrapCI(players, seed, iterations = 5000) {
  if (!players.length || players.some((player) => player.answered <= 0)) return null;
  const rng = seededRandom((seed ^ 0x51ED270B) >>> 0);
  const rates = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let proposed = 0;
    let answered = 0;
    for (let index = 0; index < players.length; index += 1) {
      const player = players[Math.floor(rng() * players.length)];
      proposed += player.proposedPreferred;
      answered += player.answered;
    }
    rates.push(proposed / answered);
  }
  rates.sort((a, b) => a - b);
  return [rates[Math.floor(iterations * 0.025)], rates[Math.min(iterations - 1, Math.floor(iterations * 0.975))]];
}

function readJson(file) {
  if (!fs.existsSync(file)) throw new Error(`文件不存在：${file}`);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`${file} 不是有效 JSON：${error.message}`); }
}

function rounded(value, digits = 3) { return Number.isFinite(value) ? Number(value.toFixed(digits)) : null; }

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function wilson95(successes, total, z = 1.96) {
  const p = successes / total;
  const z2 = z * z;
  const center = (p + z2 / (2 * total)) / (1 + z2 / total);
  const margin = (z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total)) / (1 + z2 / total);
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
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
