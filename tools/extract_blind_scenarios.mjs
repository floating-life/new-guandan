#!/usr/bin/env node
/**
 * Build a strict, no-repeat human blind-evaluation allocation from A/B scenario
 * logs. A scenario identity binds the source-file SHA-256, seed, level,
 * candidate team, and turn. Duplicate lines inside one source keep the last
 * occurrence: appended logs may contain a corrected rerun of the same turn.
 *
 * Usage:
 *   node tools/extract_blind_scenarios.mjs --in=run.ndjson [--in=run2.ndjson]
 *     [--players=10] [--max=200] [--seed=20260830] --out-dir=blind-data
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const options = parseArgs(process.argv.slice(2));
const loaded = loadScenarios(options.inputs);
if (!loaded.scenarios.length) throw new Error('输入日志中没有可用场景');
const selected = selectScenarios(loaded.scenarios, options.max, options.seed);
const allocations = allocateWithoutReplacement(selected, options.players);
fs.mkdirSync(options.outDir, { recursive: true });

// 将实际入题的场景载荷单独冻结为 NDJSON。manifest 只列 ID 不足以证明题目
// 内容没有被替换；M2 发布门会同时校验此文件的字节摘要和每个场景 ID。
const selectedScenarioFile = 'selected-scenarios.ndjson';
const selectedScenarioPath = path.join(options.outDir, selectedScenarioFile);
const selectedScenarioText = selected.map((scenario) => JSON.stringify(scenario)).join('\n')
  + (selected.length ? '\n' : '');
fs.writeFileSync(selectedScenarioPath, selectedScenarioText, 'utf8');
const selectedScenarioSha256 = sha256(Buffer.from(selectedScenarioText, 'utf8'));

const assignmentBindings = [];
for (let player = 1; player <= options.players; player += 1) {
  const rng = seededRandom((options.seed ^ Math.imul(player, 0x9E3779B1)) >>> 0);
  const questions = [];
  const mapping = {};
  for (const scenario of allocations[player - 1]) {
    const proposedIsA = rng() < 0.5;
    const [a, b] = proposedIsA
      ? [scenario.divergence.proposed, scenario.divergence.expert]
      : [scenario.divergence.expert, scenario.divergence.proposed];
    questions.push({ id: scenario.id, observation: scenario.observation, options: { A: a, B: b } });
    mapping[scenario.id] = {
      A: proposedIsA ? 'proposed' : 'expert',
      B: proposedIsA ? 'expert' : 'proposed',
    };
  }
  assignmentBindings.push({
    player,
    assignmentSha256: sha256(Buffer.from(JSON.stringify(questions), 'utf8')),
    mappingSha256: sha256(Buffer.from(JSON.stringify(mapping), 'utf8')),
  });
}

const manifest = {
  schema: 'guandan-blind-eval-manifest-v2',
  generatedAt: new Date().toISOString(),
  sourceFiles: loaded.sourceFiles,
  selectedScenarioFile,
  selectedScenarioSha256,
  totalScenariosInLogs: loaded.scenarios.length,
  selectedScenarios: selected.length,
  players: options.players,
  randomSeed: options.seed,
  scenarioIds: selected.map((item) => item.id),
  allocation: {
    scheme: 'round-robin-without-replacement',
    repeatedScenarioRatings: false,
    playerQuestionCounts: allocations.map((questions, index) => ({
      player: index + 1,
      questions: questions.length,
    })),
    // Keep the immutable scenario IDs in the manifest so a release gate can
    // independently prove that every selected question was assigned exactly
    // once, rather than trusting only aggregate counts.
    playerScenarioIds: allocations.map((questions, index) => ({
      player: index + 1,
      scenarioIds: questions.map((scenario) => scenario.id),
    })),
    // These digests freeze the generated question/key assignment without
    // exposing the A/B answer key in the participant-facing manifest.
    assignmentBindings,
  },
};
fs.writeFileSync(path.join(options.outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

for (let player = 1; player <= options.players; player += 1) {
  const rng = seededRandom((options.seed ^ Math.imul(player, 0x9E3779B1)) >>> 0);
  const questions = [];
  const mapping = {};
  for (const scenario of allocations[player - 1]) {
    const proposedIsA = rng() < 0.5;
    const [a, b] = proposedIsA
      ? [scenario.divergence.proposed, scenario.divergence.expert]
      : [scenario.divergence.expert, scenario.divergence.proposed];
    questions.push({ id: scenario.id, observation: scenario.observation, options: { A: a, B: b } });
    mapping[scenario.id] = {
      A: proposedIsA ? 'proposed' : 'expert',
      B: proposedIsA ? 'expert' : 'proposed',
    };
  }
  const assignmentSha256 = sha256(Buffer.from(JSON.stringify(questions)));
  const questionPayload = {
    schema: 'guandan-blind-eval-questions-v2',
    player,
    assignmentSha256,
    instruction: '每题在不透露来源的情况下二选一；请按牌感选择你认为更强的一手。',
    questions,
  };
  const keyPayload = { schema: 'guandan-blind-eval-key-v2', player, assignmentSha256, mapping };
  fs.writeFileSync(path.join(options.outDir, `player-${player}.json`), `${JSON.stringify(questionPayload, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(options.outDir, `player-${player}.key.json`), `${JSON.stringify(keyPayload, null, 2)}\n`, 'utf8');
}

console.log(`已从 ${loaded.scenarios.length} 个场景选出 ${selected.length} 题，无重复分配给 ${options.players} 名玩家 → ${options.outDir}`);

function parseArgs(args) {
  const result = { inputs: [], players: 10, max: 200, seed: 20260830, outDir: null };
  for (const raw of args) {
    const item = String(raw);
    if (item.startsWith('--in=')) result.inputs.push(item.slice('--in='.length));
    else if (item.startsWith('--players=')) result.players = parsePositiveInt(item, '--players');
    else if (item.startsWith('--max=')) result.max = parsePositiveInt(item, '--max');
    else if (item.startsWith('--seed=')) result.seed = parsePositiveInt(item, '--seed');
    else if (item.startsWith('--out-dir=')) result.outDir = path.resolve(item.slice('--out-dir='.length));
    else throw new Error(`未知参数：${item}`);
  }
  if (!result.inputs.length || !result.outDir) {
    throw new Error('用法：node tools/extract_blind_scenarios.mjs --in=场景.ndjson [--in=…] [--players=10] [--max=200] [--seed=20260830] --out-dir=目录');
  }
  return result;
}

function parsePositiveInt(item, name) {
  const value = Number(item.slice(item.indexOf('=') + 1));
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} 需要正整数`);
  return value;
}

function loadScenarios(inputs) {
  const scenarios = [];
  const sourceFiles = [];
  for (const input of inputs) {
    const file = path.resolve(input);
    if (!fs.existsSync(file)) throw new Error(`场景日志不存在：${file}`);
    const bytes = fs.readFileSync(file);
    const sourceFileSha256 = sha256(bytes);
    const latestByIdentity = new Map();
    let validLines = 0;
    for (const [index, line] of bytes.toString('utf8').split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); }
      catch (error) { throw new Error(`${file} 第 ${index + 1} 行不是有效 JSON：${error.message}`); }
      if (record.schema !== 'guandan-blind-scenario-v1') continue;
      if (!record.observation || !record.divergence?.expert || !record.divergence?.proposed) continue;
      const seed = Number(record.seed);
      const level = Number(record.level);
      const candidateTeam = Number(record.candidateTeam);
      const turn = Number(record.turn);
      if (![seed, level, candidateTeam, turn].every(Number.isFinite)) continue;
      const identity = `${seed}:${level}:${candidateTeam}:${turn}`;
      // Map#set replaces an earlier appended line for this exact source/turn.
      latestByIdentity.set(identity, {
        ...record,
        id: `${sourceFileSha256}:${identity}`,
        sourceFileSha256,
      });
      validLines += 1;
    }
    scenarios.push(...latestByIdentity.values());
    sourceFiles.push({ file, sha256: sourceFileSha256, validScenarioLines: validLines, retainedScenarios: latestByIdentity.size });
  }
  scenarios.sort((a, b) => a.id.localeCompare(b.id));
  return { scenarios, sourceFiles };
}

function selectScenarios(scenarios, max, seed) {
  if (scenarios.length <= max) return scenarios.slice();
  const rng = seededRandom(seed >>> 0);
  const shuffled = scenarios.slice();
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1));
    [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
  }
  return shuffled.slice(0, max).sort((a, b) => a.id.localeCompare(b.id));
}

function allocateWithoutReplacement(scenarios, players) {
  const assignments = Array.from({ length: players }, () => []);
  scenarios.forEach((scenario, index) => assignments[index % players].push(scenario));
  return assignments;
}

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

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
