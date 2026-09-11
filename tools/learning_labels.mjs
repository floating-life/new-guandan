/** Streaming, deal-group-stratified teacher labels for the local learning experiment. */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chooseAIPlay, resolvePolicyFeatures } from '../js/ai.js';
import { buildLearningCandidates } from '../js/ai-learning.js';
import { createPublicAIObservation } from '../js/ai-observation.js';
import { generateLegalPlays } from '../js/rules.js';
import { filterEligibleStrategyActions } from '../js/strategy-core.js';
import { evaluateLearningTeacherCandidates, extractHybridValueFeatures } from '../js/ai-hybrid.js';

const SOURCE_SCHEMA = 'guandan-selfplay-trajectory-v3';
export const LABEL_SCHEMA = 'guandan-learning-labels-v1';
const sha = value => createHash('sha256').update(value).digest('hex');
function integer(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`invalid ${name}`);
  return value;
}
function publicContext(observation) {
  return { ...createPublicAIObservation(observation), difficulty: 'master', deterministic: true,
    decisionEngine: 'expert', policyProfile: 'expert', policyFeatures: resolvePolicyFeatures('expert'),
    opponentModelMode: 'off', timeBudgetMs: 0 };
}
function legalCoverage(context) {
  const plays = generateLegalPlays(context.hand, context.level, context.lastHand)
    .map(play => ({ ...play, action: 'play' }));
  if (context.lastHand) plays.push({ action: 'pass', cards: [], hand: null });
  const eligible = filterEligibleStrategyActions(plays, context, { allowPlacementExceptions: true }).entries || [];
  return { legal: plays.length, eligible: eligible.length };
}

/** Retain the lowest deterministic state-ID hashes among eligible states in each group/level. */
export async function selectLearningStates(dataset, { statesPerLevel = 200, progress = null } = {}) {
  integer(statesPerLevel, 'statesPerLevel', 1, 100000);
  const input = fs.createReadStream(dataset);
  const digest = createHash('sha256');
  input.on('data', chunk => digest.update(chunk));
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const plans = new Map(), groups = new Map(), seedGroups = new Map(), buckets = new Map();
  const seenStates = new Set(), seenGames = new Set();
  let header = null, records = 0, quota = 0;
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      if (!header) {
        header = row;
        if (row.schema !== `${SOURCE_SCHEMA}-header` || !Array.isArray(row.gamePlan)
          || !Array.isArray(row.levels) || !row.levels.length
          || new Set(row.levels).size !== row.levels.length) throw new Error('expected validated v3 header');
        row.levels.forEach(level => integer(level, 'level', 2, 14));
        for (const p of row.gamePlan) {
          if (!Number.isInteger(p.game) || p.game < 1 || plans.has(p.game)
            || !['train', 'validation'].includes(p.split) || typeof p.dealGroupId !== 'string'
            || typeof p.derivedGameId !== 'string' || !row.levels.includes(p.level)) {
            throw new Error('invalid training game plan/split (smoke and external data are not training data)');
          }
          integer(p.baseSeed, 'baseSeed', 1, 0xFFFFFFFF);
          const group = groups.get(p.dealGroupId);
          if (group && (group.split !== p.split || group.baseSeed !== p.baseSeed)) throw new Error('mixed deal-group split');
          if (seedGroups.has(p.baseSeed) && seedGroups.get(p.baseSeed) !== p.dealGroupId) throw new Error('duplicate seed group');
          groups.set(p.dealGroupId, { dealGroupId: p.dealGroupId, baseSeed: p.baseSeed, split: p.split });
          seedGroups.set(p.baseSeed, p.dealGroupId);
          plans.set(p.game, p);
        }
        if (groups.size !== row.dealBlocks || plans.size !== row.games
          || ![...groups.values()].some(g => g.split === 'train')
          || ![...groups.values()].some(g => g.split === 'validation')) throw new Error('incomplete group/split plan');
        const seeds = row.seedManifest?.seeds;
        if (row.seedManifest?.schema !== 'guandan-seed-manifest-v1' || !Array.isArray(seeds)
          || seeds.length !== groups.size || new Set(seeds).size !== groups.size
          || seeds.some(seed => !seedGroups.has(seed))) throw new Error('seed manifest disagrees with groups');
        if (statesPerLevel % groups.size) throw new Error('statesPerLevel must divide evenly across deal groups');
        quota = statesPerLevel / groups.size;
        for (const group of groups.keys()) for (const level of row.levels) buckets.set(`${group}/${level}`, []);
        continue;
      }
      records++;
      const p = plans.get(row.game);
      if (row.schema !== SOURCE_SCHEMA || !p || row.dealGroupId !== p.dealGroupId
        || row.derivedGameId !== p.derivedGameId || row.split !== p.split || row.level !== p.level
        || row.rotation !== p.rotation || row.observation?.level !== p.level
        || row.observation?.seat !== row.seat) throw new Error(`record ${records} disagrees with game plan/split`);
      integer(row.seat, 'seat', 0, 3);
      integer(row.turn, 'turn', 1, Number.MAX_SAFE_INTEGER);
      const stateId = `${row.derivedGameId}:t${row.turn}:s${row.seat}`;
      if (seenStates.has(stateId)) throw new Error(`duplicate state ${stateId}`);
      seenStates.add(stateId);
      seenGames.add(row.game);
      const bucket = buckets.get(`${p.dealGroupId}/${p.level}`);
      const priority = sha(`learning-selection-v1:${stateId}`);
      if (bucket.length < quota || priority < bucket[0].priority) {
        const context = publicContext(row.observation);
        if (legalCoverage(context).eligible >= 2) {
          bucket.push({ stateId, priority, dealGroupId: p.dealGroupId, split: p.split,
            level: p.level, seat: row.seat, context });
          bucket.sort((a, b) => b.priority.localeCompare(a.priority));
          if (bucket.length > quota) bucket.shift();
        }
      }
      if (records % 10000 === 0) progress?.({ stage: 'selection', records });
    }
  } finally { lines.close(); input.destroy(); }
  if (!header || records !== header.recordCount || seenGames.size !== plans.size) throw new Error('incomplete source dataset');
  for (const [key, bucket] of buckets) if (bucket.length !== quota) {
    throw new Error(`insufficient eligible states in ${key}: ${bucket.length}/${quota}`);
  }
  const states = [...buckets.values()].flat().sort((a, b) => a.stateId.localeCompare(b.stateId));
  return { header, datasetSha256: digest.digest('hex'), groups: [...groups.values()], quota, states, records };
}

function sourceFingerprint() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const names = ['tools/learning_labels.mjs', ...fs.readdirSync(path.join(root, 'js'))
    .filter(name => name.endsWith('.js') && !name.includes('.test.')).sort().map(name => `js/${name}`)];
  return names.map(file => ({ file, sha256: sha(fs.readFileSync(path.join(root, file))) }));
}
function fresh(paths) {
  const canonical = paths.map(p => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  if (new Set(canonical).size !== canonical.length) throw new Error('output path collision');
  for (const target of paths) if (fs.existsSync(target)) throw new Error(`output exists: ${target}`);
}

export async function generateLearningLabels({ dataset, output, statesPerLevel = 200,
  worlds = 4, maxPlies = 24, worldSeed = 3500000000, progress = null }) {
  integer(worlds, 'worlds', 1, 32);
  integer(maxPlies, 'maxPlies', 1, 180);
  integer(worldSeed, 'worldSeed', 1, 0xFFFFFFFF);
  dataset = path.resolve(dataset); output = path.resolve(output);
  if (!output.endsWith('.jsonl')) throw new Error('label output must end in .jsonl');
  const prefix = output.slice(0, -6);
  const selectionPath = `${prefix}-selection.json`, summaryPath = `${prefix}-summary.json`, temp = `${output}.tmp`;
  fresh([output, selectionPath, summaryPath, temp]);
  const selected = await selectLearningStates(dataset, { statesPerLevel, progress });
  const selection = { schema: 'guandan-learning-selection-v1', datasetSha256: selected.datasetSha256,
    statesPerLevel, statesPerGroupLevel: selected.quota, groups: selected.groups,
    states: selected.states.map(({ context, ...state }) => state) };
  const selectionBytes = `${JSON.stringify(selection, null, 2)}\n`;
  const implementation = sourceFingerprint();
  const header = { schema: `${LABEL_SCHEMA}-header`, valueSchema: 'guandan-candidate-v1',
    labelKind: 'teacher_estimate', stateCount: selected.states.length,
    dataset: { path: dataset, sha256: selected.datasetSha256, schema: SOURCE_SCHEMA,
      seedManifest: selected.header.seedManifest, groups: selected.groups },
    selection: { path: selectionPath, sha256: sha(selectionBytes) },
    teacher: { name: 'shared-paired-root-rollout-v1', rolloutPolicy: 'chooseRolloutPlay',
      cutoff: 'cutoffUtility', worlds, maxPlies, worldSeed, learnedModelUsed: false, implementation } };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(selectionPath, selectionBytes, { flag: 'wx' });
  fs.writeFileSync(temp, `${JSON.stringify(header)}\n`, { flag: 'wx' });
  let labels = 0, terminalSamples = 0, truncatedSamples = 0;
  const coverage = {};
  for (let index = 0; index < selected.states.length; index++) {
    const state = selected.states[index];
    const expert = chooseAIPlay(state.context);
    const candidates = buildLearningCandidates(state.context, expert);
    const counts = legalCoverage(state.context);
    const result = evaluateLearningTeacherCandidates(state.context, candidates,
      { worlds, maxPlies, seed: worldSeed });
    if (!result.ok) throw new Error(`teacher failed at ${state.stateId}: ${result.reason}`);
    const byId = new Map(result.candidateResults.map(r => [r.candidateId, r]));
    const batch = candidates.map(candidate => {
      const estimate = byId.get(candidate.id);
      const features = Array.from(extractHybridValueFeatures(state.context, candidate));
      if (!estimate || features.length !== 32 || features.some(v => !Number.isFinite(v))) throw new Error('invalid label features/estimate');
      terminalSamples += estimate.terminalCount;
      truncatedSamples += estimate.truncatedCount;
      return { schema: LABEL_SCHEMA, labelKind: 'teacher_estimate', stateId: state.stateId,
        dealGroupId: state.dealGroupId, split: state.split, level: state.level, seat: state.seat,
        candidateId: candidate.id, features, teacherValue: estimate.utility,
        completedSamples: estimate.completedSamples, terminalCount: estimate.terminalCount,
        truncatedCount: estimate.truncatedCount, legalCandidateCount: counts.legal,
        eligibleCandidateCount: counts.eligible, retainedCandidateCount: candidates.length,
        cappedCandidateCount: counts.eligible - candidates.length };
    });
    fs.appendFileSync(temp, `${batch.map(row => JSON.stringify(row)).join('\n')}\n`);
    labels += batch.length;
    const key = `${state.split}/${state.level}`;
    coverage[key] = (coverage[key] || 0) + 1;
    if ((index + 1) % 100 === 0) progress?.({ stage: 'teacher', states: index + 1, planned: selected.states.length, labels });
  }
  fs.renameSync(temp, output);
  const summary = { ok: true, schema: 'guandan-learning-label-summary-v1', output,
    states: selected.states.length, labels, coverage, terminalSamples, truncatedSamples,
    datasetSha256: selected.datasetSha256, selectionSha256: header.selection.sha256,
    teacher: header.teacher, labelKind: 'teacher_estimate', trainingIsNotPromotion: true };
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' });
  return summary;
}

function parseArgs(argv) {
  const known = new Set(['dataset', 'output', 'states-per-level', 'worlds', 'rollout-depth', 'world-seed', 'reuse-labels', 'base-runtime']);
  const values = {};
  for (const arg of argv) {
    const match = /^--([^=]+)=(.+)$/.exec(arg);
    if (!match || !known.has(match[1]) || Object.hasOwn(values, match[1])) throw new Error(`unknown/duplicate argument ${arg}`);
    values[match[1]] = match[2];
  }
  if (!values.dataset || !values.output) throw new Error('--dataset= and --output= are required');
  return { dataset: values.dataset, output: values.output,
    reuseLabels: values['reuse-labels'], baseRuntime: values['base-runtime'],
    statesPerLevel: Number(values['states-per-level'] ?? 200), worlds: Number(values.worlds ?? 4),
    maxPlies: Number(values['rollout-depth'] ?? 24), worldSeed: Number(values['world-seed'] ?? 3500000000) };
}

/** Change only features after reproducing the exact original candidate identities. */
export async function reencodeLearningLabels({ dataset, labels, output, baseRuntime, progress = null }) {
  if (!baseRuntime || !labels) throw new Error('re-encoding requires original labels and frozen base runtime');
  output = path.resolve(output); labels = path.resolve(labels); baseRuntime = path.resolve(baseRuntime);
  if (!output.endsWith('.jsonl')) throw new Error('label output must end in .jsonl');
  const prefix = output.slice(0, -6), selectionPath = `${prefix}-selection.json`, summaryPath = `${prefix}-summary.json`;
  fresh([output, selectionPath, summaryPath]);
  const originalBytes = fs.readFileSync(labels);
  const original = originalBytes.toString('utf8').trim().split(/\r?\n/).map(JSON.parse);
  const header = original.shift();
  if (header.schema !== `${LABEL_SCHEMA}-header` || header.featureEncoder) throw new Error('expected original base feature labels');
  for (const entry of header.teacher.implementation) {
    if (sha(fs.readFileSync(path.join(baseRuntime, entry.file))) !== entry.sha256) {
      throw new Error(`frozen source hash mismatch: ${entry.file}`);
    }
  }
  const selectionBytes = fs.readFileSync(header.selection.path);
  if (sha(selectionBytes) !== header.selection.sha256) throw new Error('original selection mismatch');
  const originalSelection = JSON.parse(selectionBytes);
  const selected = await selectLearningStates(dataset, { statesPerLevel: originalSelection.statesPerLevel, progress });
  if (selected.datasetSha256 !== header.dataset.sha256) throw new Error('original dataset mismatch');
  const expectedStates = originalSelection.states.map(s => s.stateId).sort();
  if (JSON.stringify(selected.states.map(s => s.stateId).sort()) !== JSON.stringify(expectedStates)) {
    throw new Error('re-encoding changed state selection');
  }
  const oldAI = await import(pathToFileURL(path.join(baseRuntime, 'js/ai.js')).href);
  const oldLearning = await import(pathToFileURL(path.join(baseRuntime, 'js/ai-learning.js')).href);
  const oldHybrid = await import(pathToFileURL(path.join(baseRuntime, 'js/ai-hybrid.js')).href);
  const cardKey = candidate => `${candidate.action}:${candidate.cards.map(c => String(c.id)).sort().join(',')}|${candidate.signature || ''}`;
  const byState = new Map();
  for (const row of original) {
    if (!byState.has(row.stateId)) byState.set(row.stateId, new Map());
    const bucket = byState.get(row.stateId);
    if (bucket.has(row.candidateId)) throw new Error('duplicate original label');
    bucket.set(row.candidateId, row);
  }
  const encoded = new Map();
  for (let index = 0; index < selected.states.length; index++) {
    const state = selected.states[index], ctx = state.context;
    const oldExpert = oldAI.chooseAIPlay(ctx), newExpert = chooseAIPlay(ctx);
    if (cardKey({ ...oldExpert, cards: oldExpert.cards || [] }) !== cardKey({ ...newExpert, cards: newExpert.cards || [] })) {
      throw new Error(`expert anchor changed at ${state.stateId}`);
    }
    const previous = oldLearning.buildLearningCandidates(ctx, oldExpert);
    const currentBase = buildLearningCandidates(ctx, newExpert);
    const rich = buildLearningCandidates({ ...ctx, decisionEngine: 'learned-context-v1' }, newExpert);
    const identity = list => JSON.stringify(list.map(c => [c.id, cardKey(c)]));
    if (identity(previous) !== identity(currentBase) || identity(previous) !== identity(rich)) {
      throw new Error(`candidate identities changed at ${state.stateId}`);
    }
    const originals = byState.get(state.stateId);
    if (!originals || originals.size !== previous.length) throw new Error('original candidate coverage mismatch');
    for (let i = 0; i < previous.length; i++) {
      const row = originals.get(previous[i].id);
      const oldFeatures = Array.from(oldHybrid.extractHybridValueFeatures(ctx, previous[i]));
      if (!row || row.dealGroupId !== state.dealGroupId || row.split !== state.split
        || row.features.length !== 32 || row.features.some((v, k) => v !== oldFeatures[k])) {
        throw new Error(`original feature identity mismatch at ${state.stateId}`);
      }
      const features = Array.from(extractHybridValueFeatures(ctx, rich[i]));
      if (features.some(v => !Number.isFinite(v))) throw new Error('nonfinite context features');
      encoded.set(`${state.stateId}/${row.candidateId}`, { ...row, features });
    }
    if ((index + 1) % 100 === 0) progress?.({ stage: 'reencode', states: index + 1, planned: selected.states.length });
  }
  if (encoded.size !== original.length) throw new Error('re-encoding changed label coverage');
  const nextHeader = { ...header, selection: { path: selectionPath, sha256: sha(selectionBytes) },
    featureEncoder: { engine: 'learned-context-v1', originalLabels: { path: labels, sha256: sha(originalBytes) },
      originalRuntime: baseRuntime, candidatesVerified: true, teacherValuesReused: true, implementation: sourceFingerprint() } };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(selectionPath, selectionBytes, { flag: 'wx' });
  const text = [nextHeader, ...original.map(row => encoded.get(`${row.stateId}/${row.candidateId}`))]
    .map(row => JSON.stringify(row)).join('\n') + '\n';
  fs.writeFileSync(output, text, { flag: 'wx' });
  const summary = { ok: true, output, states: selected.states.length, labels: original.length,
    teacherRolloutsRepeated: 0, candidateIdentitiesVerified: true, originalLabelsSha256: sha(originalBytes),
    labelsSha256: sha(text), featureEngine: 'learned-context-v1' };
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' });
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = { ...parseArgs(process.argv.slice(2)), progress: p => process.stderr.write(`${JSON.stringify(p)}\n`) };
    const summary = options.reuseLabels
      ? await reencodeLearningLabels({ ...options, labels: options.reuseLabels })
      : await generateLearningLabels(options);
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
