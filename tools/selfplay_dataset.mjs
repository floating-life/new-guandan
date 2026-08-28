/**
 * 公平自对弈轨迹数据生成器。
 *
 * 用法：
 *   node tools/selfplay_dataset.mjs [副数=20] [基础种子=20260826] <输出.jsonl> [--resume]
 *
 * 每条记录只含当手可见观察、规则合法候选、专家选中动作与本副最终团队收益。
 * 这是“轨迹价值/行为数据”，不是给所有未选候选伪造反事实胜负标签；训练前请
 * 先运行 tools/validate_value_dataset.mjs 检查公开信息边界。生成过程按副落盘，
 * 中断后可用 --resume 从最后一个完整检查点继续，不把全部记录留在内存中。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realRandom = Math.random;
globalThis.setTimeout = (fn) => {
  queueMicrotask(fn);
  return 1;
};
globalThis.clearTimeout = () => {};

const {
  createMatch, startMatch, humanPlay, humanPass, humanSelectSet,
  humanPickReturnCard, humanConfirmReturn, getReturnCandidates,
  setUpdateCallback, setAIDecisionObserver, aiDecisionContext, PHASE, TEAM_OF,
} = await import('../js/game.js');
const { chooseAIPlay, chooseReturnCard, getAIConsultation } = await import('../js/ai.js');
const {
  createPublicAIObservation, publicCardView, publicHandView,
  sanitizePublicHistory, sanitizePublicTributeContext,
} = await import('../js/ai-observation.js');
const { extractHybridValueFeatures, HYBRID_VALUE_SCHEMA } = await import('../js/ai-hybrid.js');
const { handSignature } = await import('../js/rules.js');
const { emptyOpponentProfile } = await import('../js/opponent-model.js');
const { createSeedManifest } = await import('../js/value-model-gate.js');

const DATASET_SCHEMA = 'guandan-selfplay-trajectory-v2';
const CHECKPOINT_SCHEMA = 'guandan-selfplay-checkpoint-v1';
const positionalArgs = process.argv.slice(2).filter((arg) => arg !== '--resume');
const resume = process.argv.slice(2).includes('--resume');
const rounds = positiveInteger(positionalArgs[0], 20);
const baseSeed = finiteUint32(positionalArgs[1], 20260826);
const rawOutput = positionalArgs[2];
if (!rawOutput) {
  throw new Error('请提供输出文件，例如 node tools/selfplay_dataset.mjs 20 20260826 data/selfplay.jsonl');
}
const outputPath = path.resolve(rawOutput);
const recordTempPath = `${outputPath}.records.tmp`;
const outputTempPath = `${outputPath}.tmp`;
const checkpointPath = `${outputPath}.checkpoint.json`;
const checkpointTempPath = `${checkpointPath}.tmp`;

let state = null;
let processing = false;
let resolveRound = null;
let currentRecords = [];
let recordCount = 0;
let recordBytes = 0;
let nextRound = 1;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function finiteUint32(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed >>> 0 : fallback >>> 0;
}

function replaceFile(tempPath, targetPath) {
  try {
    fs.renameSync(tempPath, targetPath);
  } catch (error) {
    // Windows does not replace an existing destination with renameSync. The
    // target is always an exact generated artifact path, never a directory
    // traversal or a broad cleanup target.
    if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error?.code)) throw error;
    fs.rmSync(targetPath, { force: true });
    fs.renameSync(tempPath, targetPath);
  }
}

function writeCheckpoint() {
  const checkpoint = {
    schema: CHECKPOINT_SCHEMA,
    outputPath,
    rounds,
    baseSeed,
    nextRound,
    recordCount,
    recordBytes,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(checkpointTempPath, `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8');
  replaceFile(checkpointTempPath, checkpointPath);
}

function loadCheckpoint() {
  if (!fs.existsSync(checkpointPath) || !fs.existsSync(recordTempPath)) {
    throw new Error('无法恢复：缺少 checkpoint 或增量记录文件');
  }
  let checkpoint;
  try {
    checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
  } catch (error) {
    throw new Error(`无法恢复：checkpoint JSON 无效 (${error.message})`);
  }
  if (!checkpoint || checkpoint.schema !== CHECKPOINT_SCHEMA
    || checkpoint.outputPath !== outputPath
    || checkpoint.rounds !== rounds || checkpoint.baseSeed !== baseSeed
    || !Number.isInteger(checkpoint.nextRound)
    || checkpoint.nextRound < 1 || checkpoint.nextRound > rounds + 1
    || !Number.isInteger(checkpoint.recordCount) || checkpoint.recordCount < 0
    || !Number.isInteger(checkpoint.recordBytes) || checkpoint.recordBytes < 0) {
    throw new Error('无法恢复：checkpoint 与当前副数/种子/输出路径不匹配');
  }
  const stat = fs.statSync(recordTempPath);
  if (!stat.isFile() || stat.size < checkpoint.recordBytes) {
    throw new Error('无法恢复：增量记录文件短于 checkpoint 声明的安全位置');
  }
  // If the process was interrupted after a partial append but before the
  // checkpoint commit, discard the uncommitted tail before replaying the round.
  if (stat.size > checkpoint.recordBytes) fs.truncateSync(recordTempPath, checkpoint.recordBytes);
  recordCount = checkpoint.recordCount;
  recordBytes = checkpoint.recordBytes;
  nextRound = checkpoint.nextRound;
}

async function appendRecordFile() {
  await pipeline(
    fs.createReadStream(recordTempPath),
    fs.createWriteStream(outputTempPath, { flags: 'a' }),
  );
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

function cardView(card) {
  return {
    id: String(card.id), rank: Number(card.rank), suit: String(card.suit),
    deckIndex: Number.isFinite(Number(card.deckIndex)) ? Number(card.deckIndex) : null,
  };
}

function trainingObservation(observation) {
  // 训练文件只保留32维特征真正依赖的公开状态。运行时策略开关、真人画像等
  // 即使也是公开统计，也不应悄悄成为训练数据中的旁路输入。
  return {
    seat: observation.seat,
    hand: (observation.hand || []).map(cardView),
    level: observation.level,
    lastHand: publicHandView(observation.lastHand),
    lastSeat: observation.lastSeat,
    handCounts: (observation.handCounts || []).slice(0, 4),
    teams: (observation.teams || []).slice(0, 4),
    finishOrder: (observation.finishOrder || []).slice(0, 4),
    playedCards: (observation.playedCards || [])
      .map((card) => publicCardView(card)).filter(Boolean),
    publicHistory: sanitizePublicHistory(observation.publicHistory),
    tributeContext: sanitizePublicTributeContext(observation.tributeContext),
    leadAfterOwnBomb: observation.leadAfterOwnBomb === true,
  };
}

function decisionKey(decision) {
  if (!decision || decision.action === 'pass') return 'pass';
  const cards = (decision.cards || []).map((card) => String(card.id)).sort().join(',');
  return `play:${cards}|${decision.signature || handSignature(decision.hand)}`;
}

function candidateKey(candidate) {
  if (!candidate || candidate.action === 'pass') return 'pass';
  const cards = (candidate.cards || []).map((card) => String(card.id)).sort().join(',');
  return `play:${cards}|${candidate.signature || handSignature(candidate.hand)}`;
}

function compactCandidate(observation, candidate, decision) {
  const hand = candidate.hand || null;
  const ownCards = new Map((observation.hand || []).map((card) => [String(card.id), card]));
  const compact = {
    id: String(candidate.id || ''),
    action: candidate.action === 'pass' ? 'pass' : 'play',
    cards: (candidate.cards || []).map((card) => cardView(
      ownCards.get(String(card.id)) || card,
    )),
    hand: hand ? {
      type: String(hand.type || ''), mainRank: Number(hand.mainRank) || null,
      size: Number(hand.size) || 0, power: Number(hand.power) || 0,
    } : null,
    signature: candidate.signature || (hand ? handSignature(hand) : null),
    localScore: Number.isFinite(Number(candidate.localScore)) ? Number(candidate.localScore) : null,
    projectedTricks: Number.isFinite(Number(candidate.projectedTricks))
      ? Number(candidate.projectedTricks) : null,
    responseSearch: candidate.responseSearch ? {
      teamControl: Number(candidate.responseSearch.teamControl) || 0,
      enemyControl: Number(candidate.responseSearch.enemyControl) || 0,
      enemyBomb: Number(candidate.responseSearch.enemyBomb) || 0,
    } : null,
    chosen: candidateKey(candidate) === decisionKey(decision),
  };
  // 只对最终写盘的紧凑对象提取特征，保证校验器可从文件本身精确重算。
  compact.features = Array.from(extractHybridValueFeatures(observation, compact));
  return compact;
}

function recordDecision(context, decision) {
  if (!context || !decision?.action) return;
  const publicObservation = createPublicAIObservation(context);
  const consultation = getAIConsultation({
    ...publicObservation,
    // 数据基线是专家自对弈；实验搜索/真人画像不能隐式污染训练轨迹。
    decisionEngine: 'expert',
    opponentModel: emptyOpponentProfile(),
    deterministic: true,
    timeBudgetMs: 0,
  }, { deterministic: true, applyHybrid: false, timeBudgetMs: 0 });
  const selectedKey = decisionKey(decision);
  const unique = [];
  const seen = new Set();
  for (const candidate of consultation?.candidates || []) {
    const key = candidateKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }
  const selected = unique.find((candidate) => candidateKey(candidate) === selectedKey);
  if (!selected) {
    throw new Error(`self-play chosen candidate missing: ${selectedKey}`);
  }
  const retained = unique.slice(0, 24);
  if (!retained.some((candidate) => candidateKey(candidate) === selectedKey)) {
    if (retained.length >= 24) retained[retained.length - 1] = selected;
    else retained.push(selected);
  }
  const observation = trainingObservation(publicObservation);
  const candidates = retained.map((candidate) => compactCandidate(observation, candidate, decision));
  const chosenCount = candidates.filter((candidate) => candidate.chosen).length;
  if (chosenCount !== 1) {
    throw new Error(`self-play expected exactly one chosen candidate, got ${chosenCount}`);
  }
  currentRecords.push({
    schema: DATASET_SCHEMA,
    valueSchema: HYBRID_VALUE_SCHEMA,
    game: null,
    round: Number(context.round) || 1,
    turn: Number(context.turn) || null,
    trickNumber: Number(context.trickNumber) || null,
    seat: observation.seat,
    observation,
    candidates,
    chosenAction: decision.action === 'pass' ? 'pass' : 'play',
    // 标签在本副结束后写入；它只描述实际自对弈轨迹的团队结果。
    labelScope: 'trajectory',
    outcome: null,
  });
}

function finishUtility(order, seat) {
  const rootTeam = TEAM_OF[seat];
  const winner = TEAM_OF[order[0]];
  const partnerSeat = order.find((item) => item !== order[0] && TEAM_OF[item] === winner);
  const partnerPlace = order.indexOf(partnerSeat);
  const upgrade = partnerPlace === 1 ? 3 : partnerPlace === 2 ? 2 : 1;
  return winner === rootTeam ? upgrade : -upgrade;
}

function humanTurn() {
  const context = aiDecisionContext(state, 0);
  context.deterministic = true;
  context.timeBudgetMs = 0;
  context.decisionEngine = 'expert';
  context.opponentModel = emptyOpponentProfile();
  const decision = chooseAIPlay(context);
  recordDecision({ ...context, round: state.round, turn: state.trickLog.length + 1, trickNumber: state.trickNumber }, decision);
  if (!decision || decision.action === 'pass') return humanPass(state);
  humanSelectSet(
    state,
    decision.cards.map((card) => card.id),
    decision.signature || handSignature(decision.hand),
    null,
  );
  return humanPlay(state);
}

function pump() {
  if (processing || !state) return;
  processing = true;
  queueMicrotask(() => {
    try {
      if (state.phase === PHASE.RETURN) {
        const candidates = getReturnCandidates(state);
        if (candidates.length) {
          const task = state.tributeState?.pendingReturns?.[0];
          const preferred = chooseReturnCard(state.hands[0].slice(), state.currentLevel, {
            toPartner: task ? TEAM_OF[task.from] === TEAM_OF[task.to] : false,
          });
          const card = candidates.find((item) => item.id === preferred?.id) || candidates[0];
          humanPickReturnCard(state, card.id);
          humanConfirmReturn(state);
        }
      } else if (state.phase === PHASE.PLAYING
        && state.currentSeat === 0 && !state.finishOrder.includes(0)) {
        const result = humanTurn();
        if (!result?.ok) throw new Error(result?.reason || 'self-play seat 0 failed');
      } else if (state.phase === PHASE.ROUND_END || state.phase === PHASE.MATCH_END) {
        const done = resolveRound;
        resolveRound = null;
        if (done) done(state);
      }
    } finally {
      processing = false;
    }
  });
}

setUpdateCallback(pump);
setAIDecisionObserver(({ round, turn, trickNumber, context, decision }) => {
  recordDecision({ ...context, round, turn, trickNumber }, decision);
});
const heartbeat = globalThis.setInterval(pump, 1);

async function playRound(index) {
  Math.random = seededRandom((baseSeed + index - 1) >>> 0);
  currentRecords = [];
  state = createMatch({
    difficulty: 'master', aiSpeed: 'fast', coachMode: false,
    deterministicAI: true, localAiEngine: 'expert', llmPolicyMode: 'local',
  });
  state.opponentModel = emptyOpponentProfile();
  const completed = new Promise((resolve) => { resolveRound = resolve; });
  startMatch(state);
  pump();
  const finalState = await completed;
  const order = finalState.finishOrder.slice();
  for (const record of currentRecords) {
    record.game = index;
    record.outcome = {
      teamUtility: finishUtility(order, record.seat),
      teamWon: TEAM_OF[order[0]] === TEAM_OF[record.seat],
      place: order.indexOf(record.seat) + 1,
      finishOrder: order.slice(),
    };
  }
  const roundText = currentRecords.length
    ? `${currentRecords.map((record) => JSON.stringify(record)).join('\n')}\n`
    : '';
  fs.appendFileSync(recordTempPath, roundText, 'utf8');
  recordCount += currentRecords.length;
  recordBytes = fs.statSync(recordTempPath).size;
  nextRound = index + 1;
  writeCheckpoint();
  process.stderr.write(`[${index}/${rounds}] ${currentRecords.length} decisions\n`);
}

try {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  if (resume) {
    loadCheckpoint();
    process.stderr.write(`[resume] next round ${nextRound}/${rounds}; ${recordCount} records\n`);
  } else {
    for (const generatedPath of [recordTempPath, outputTempPath, checkpointPath, checkpointTempPath]) {
      fs.rmSync(generatedPath, { force: true });
    }
    fs.writeFileSync(recordTempPath, '', 'utf8');
    recordBytes = 0;
    nextRound = 1;
  }
  for (let index = nextRound; index <= rounds; index += 1) await playRound(index);
  const header = {
    schema: `${DATASET_SCHEMA}-header`,
    valueSchema: HYBRID_VALUE_SCHEMA,
    rounds,
    baseSeed,
    seedManifest: createSeedManifest(Array.from(
      { length: rounds }, (_, index) => (baseSeed + index) >>> 0,
    )),
    recordCount,
    generatedAt: new Date().toISOString(),
    fairness: 'own_hand_plus_public_history_only',
    labelScope: 'trajectory',
  };
  fs.writeFileSync(outputTempPath, `${JSON.stringify(header)}\n`, 'utf8');
  await appendRecordFile();
  replaceFile(outputTempPath, outputPath);
  for (const generatedPath of [recordTempPath, checkpointPath, checkpointTempPath]) {
    fs.rmSync(generatedPath, { force: true });
  }
  console.log(JSON.stringify({
    ok: true, output: outputPath, rounds, records: recordCount,
    schema: DATASET_SCHEMA, valueSchema: HYBRID_VALUE_SCHEMA,
  }, null, 2));
} finally {
  globalThis.clearInterval(heartbeat);
  setUpdateCallback(null);
  setAIDecisionObserver(null);
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  Math.random = realRandom;
}
