#!/usr/bin/env node
/** Synthetic regression for v2 blind-evaluation identity/allocation and v3 gates. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extract = path.join(root, 'tools', 'extract_blind_scenarios.mjs');
const summarize = path.join(root, 'tools', 'summarize_blind_eval.mjs');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'guandan-blind-v2-'));
try {
  const source = path.join(temporary, 'scenarios.ndjson');
  const dataDir = path.join(temporary, 'data');
  const answersDir = path.join(temporary, 'answers');
  fs.mkdirSync(answersDir);
  const lines = Array.from({ length: 100 }, (_, index) => JSON.stringify(scenario(index)));
  lines.push(JSON.stringify(scenario(0, 17))); // Same source identity: this last record must replace the first.
  fs.writeFileSync(source, `${lines.join('\n')}\n`);
  let result = spawnSync(process.execPath, [extract, `--in=${source}`, '--players=10', '--max=100', '--seed=88', `--out-dir=${dataDir}`], {
    cwd: root, encoding: 'utf8',
  });
  assert.equal(result.status, 0, `严格出题必须成功：${result.stderr}`);
  const manifest = read(path.join(dataDir, 'manifest.json'));
  assert.equal(manifest.schema, 'guandan-blind-eval-manifest-v2', 'manifest 必须升级为严格 v2');
  assert.equal(manifest.selectedScenarios, 100, '同源重复行不得增加场景数量');
  assert.equal(manifest.sourceFiles[0].retainedScenarios, 100, '同源重复场景保留最后一行');
  assert.equal(manifest.allocation.assignmentBindings.length, 10,
    'manifest 必须冻结每位参与者的 assignment/key 摘要');
  assert(manifest.allocation.assignmentBindings.every((entry) => (
    /^[0-9a-f]{64}$/.test(entry.assignmentSha256)
      && /^[0-9a-f]{64}$/.test(entry.mappingSha256)
  )), 'assignment/key 摘要必须是合法 SHA-256');
  const ids = [];
  let foundReplacement = false;
  for (let player = 1; player <= 10; player += 1) {
    const question = read(path.join(dataDir, `player-${player}.json`));
    const key = read(path.join(dataDir, `player-${player}.key.json`));
    assert.equal(question.questions.length, 10, '每位玩家在本合成样本中恰获 10 个不重复题目');
    ids.push(...question.questions.map((item) => item.id));
    foundReplacement ||= question.questions.some((item) => item.options.A.cards?.some((card) => card.rank === 17)
      || item.options.B.cards?.some((card) => card.rank === 17));
    const answers = question.questions.map((item) => ({
      id: item.id,
      choice: key.mapping[item.id].A === 'proposed' ? 'A' : 'B',
    }));
    fs.writeFileSync(path.join(answersDir, `player-${player}.answers.json`), JSON.stringify({
      schema: 'guandan-blind-eval-answers-v2', player, assignmentSha256: question.assignmentSha256, answers,
    }));
  }
  assert.equal(new Set(ids).size, 100, '默认分配不得让同一场景被多个玩家重复评分');
  assert.equal(foundReplacement, true, '同源重复场景必须采用最后一条记录');
  const review = {
    schema: 'guandan-blind-catastrophe-review-v2',
    reviews: manifest.scenarioIds.map((id) => ({ id, expert: false, proposed: false })),
  };
  const reviewFile = path.join(temporary, 'review.json');
  fs.writeFileSync(reviewFile, JSON.stringify(review));
  result = summarizeRun(dataDir, answersDir, reviewFile);
  assert.equal(result.status, 0, `完整严格盲评应通过：${result.stderr}`);
  let receipt = JSON.parse(result.stdout);
  assert.equal(receipt.schema, 'guandan-blind-eval-summary-v3', '灾难双臂口径变化必须升级总结器 schema');
  assert.equal(receipt.gate.pass, true, '参与者聚类、全完成和灾难性复核都满足时可通过');
  assert.equal(receipt.answerLedger.length, 100,
    '总结器必须输出覆盖每道分配题目的匿名 answer ledger');
  assert.equal(typeof receipt.answerLedgerSha256, 'string',
    'answer ledger 必须带可复算摘要');
  assert(receipt.answerLedger.every((entry) => (
    entry.mapping?.A !== entry.mapping?.B
      && ['expert', 'proposed'].includes(entry.mapping?.A)
      && ['expert', 'proposed'].includes(entry.mapping?.B)
      && entry.side === entry.mapping?.[entry.choice]
  )), 'answer ledger 必须逐题保留并遵守冻结 A/B→策略映射');
  assert(receipt.totals.playerClusterBootstrap95[0] > 0.5, '通过必须使用玩家聚类 bootstrap 下界');
  assert.equal(receipt.totals.catastrophic.scenarioDenominator, 100,
    '灾难性错误率必须使用 manifest 全部题目的共同分母');
  assert.deepEqual(receipt.totals.catastrophic.reviewed, { expert: 0, proposed: 0 },
    '灾难性复核必须分别暴露两臂全题计数');

  const incompleteReview = structuredClone(review);
  incompleteReview.reviews.pop();
  fs.writeFileSync(reviewFile, JSON.stringify(incompleteReview));
  result = summarizeRun(dataDir, answersDir, reviewFile);
  assert.notEqual(result.status, 0, '缺少一题灾难复核时必须阻断');
  receipt = JSON.parse(result.stdout);
  assert.equal(receipt.totals.catastrophic.reviewComplete, false,
    '不完整灾难复核必须显式标记');
  assert.equal(receipt.totals.catastrophic.expertRate, null,
    '不完整灾难复核不得伪造正式 expert 率');
  assert.equal(receipt.totals.catastrophic.proposedRate, null,
    '不完整灾难复核不得伪造正式 proposed 率');
  fs.writeFileSync(reviewFile, JSON.stringify(review));

  const playerOne = read(path.join(answersDir, 'player-1.answers.json'));
  playerOne.answers.pop();
  fs.writeFileSync(path.join(answersDir, 'player-1.answers.json'), JSON.stringify(playerOne));
  result = summarizeRun(dataDir, answersDir, reviewFile);
  assert.notEqual(result.status, 0, '任一参与者未完成分配题目时必须阻断');
  receipt = JSON.parse(result.stdout);
  assert.equal(receipt.gate.checks.fullCompletion, false, '回执必须明确标识完成度门禁失败');

  playerOne.answers = read(path.join(dataDir, 'player-1.json')).questions.map((item) => ({
    id: item.id,
    choice: read(path.join(dataDir, 'player-1.key.json')).mapping[item.id].A === 'proposed' ? 'A' : 'B',
  }));
  fs.writeFileSync(path.join(answersDir, 'player-1.answers.json'), JSON.stringify(playerOne));
  review.reviews[0].proposed = true;
  fs.writeFileSync(reviewFile, JSON.stringify(review));
  result = summarizeRun(dataDir, answersDir, reviewFile);
  assert.notEqual(result.status, 0, '搜索提议的灾难性错误率更高时必须阻断');
  receipt = JSON.parse(result.stdout);
  assert.equal(receipt.gate.checks.proposedCatastrophicNotWorse, false, '灾难性错误对照必须进入最终 pass');

  // The participant chooses expert for this scenario, so the proposed arm is
  // deliberately unselected. It must still be counted by the catastrophe gate.
  review.reviews[0].proposed = false;
  fs.writeFileSync(reviewFile, JSON.stringify(review));
  const unselectedScenarioId = manifest.scenarioIds[0];
  let unselectedOwner = null;
  for (let player = 1; player <= 10; player += 1) {
    const key = read(path.join(dataDir, `player-${player}.key.json`));
    if (!key.mapping[unselectedScenarioId]) continue;
    const answerFile = path.join(answersDir, `player-${player}.answers.json`);
    const answerPayload = read(answerFile);
    const answer = answerPayload.answers.find((item) => item.id === unselectedScenarioId);
    const mapping = key.mapping[unselectedScenarioId];
    assert(answer, '分配给玩家的场景必须存在作答记录');
    answer.choice = mapping.A === 'expert' ? 'A' : 'B';
    fs.writeFileSync(answerFile, JSON.stringify(answerPayload));
    unselectedOwner = player;
    break;
  }
  assert(unselectedOwner, '合成题目必须能找到首题的分配玩家');
  result = summarizeRun(dataDir, answersDir, reviewFile);
  assert.equal(result.status, 0,
    '只翻转玩家选择而不改变灾难复核时，完整双臂统计不应改变门禁');
  receipt = JSON.parse(result.stdout);
  assert.deepEqual(receipt.totals.catastrophic.reviewed, { expert: 0, proposed: 0 },
    '完整双臂灾难统计不得随玩家选择改变');
  review.reviews[0].proposed = true;
  fs.writeFileSync(reviewFile, JSON.stringify(review));
  result = summarizeRun(dataDir, answersDir, reviewFile);
  assert.notEqual(result.status, 0,
    '未被选择的 proposed 是灾难选项时仍必须阻断');
  receipt = JSON.parse(result.stdout);
  assert.deepEqual(receipt.totals.catastrophic.selectionDiagnostic, { expert: 0, proposed: 0 },
    '该反例必须证明被选侧没有灾难记录');
  assert.deepEqual(receipt.totals.catastrophic.reviewed, { expert: 0, proposed: 1 },
    '该反例必须计入未被选择的 proposed 灾难');
  assert.equal(receipt.gate.checks.proposedCatastrophicNotWorse, false,
    '未被选择的 proposed 灾难也必须阻断');

  const originalManifest = structuredClone(manifest);
  const duplicateManifest = structuredClone(manifest);
  duplicateManifest.scenarioIds[1] = duplicateManifest.scenarioIds[0];
  fs.writeFileSync(path.join(dataDir, 'manifest.json'), JSON.stringify(duplicateManifest));
  result = summarizeRun(dataDir, answersDir, reviewFile);
  assert.notEqual(result.status, 0, 'manifest 重复场景 ID 不得静默缩小灾难分母');
  assert.match(`${result.stderr}${result.stdout}`, /场景 ID.*唯一/,
    '重复场景 ID 的拒绝原因必须可审计');
  fs.writeFileSync(path.join(dataDir, 'manifest.json'), JSON.stringify(originalManifest));

  const mismatchedManifest = structuredClone(manifest);
  mismatchedManifest.selectedScenarios = 99;
  fs.writeFileSync(path.join(dataDir, 'manifest.json'), JSON.stringify(mismatchedManifest));
  result = summarizeRun(dataDir, answersDir, reviewFile);
  assert.notEqual(result.status, 0, 'manifest selectedScenarios 不一致不得形成盲评回执');
  assert.match(`${result.stderr}${result.stdout}`, /selectedScenarios.*scenarioIds/,
    'manifest 数量不一致的拒绝原因必须可审计');
  fs.writeFileSync(path.join(dataDir, 'manifest.json'), JSON.stringify(originalManifest));
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

console.log('blind evaluation strict v3 gates: OK');

function summarizeRun(dataDir, answersDir, review) {
  return spawnSync(process.execPath, [summarize, `--data-dir=${dataDir}`, `--answers-dir=${answersDir}`, `--catastrophic=${review}`], {
    cwd: root, encoding: 'utf8',
  });
}

function scenario(index, replacementRank = null) {
  const level = 2 + (index % 13);
  return {
    schema: 'guandan-blind-scenario-v1',
    seed: 800000 + index,
    level,
    candidateTeam: index % 2,
    turn: 1,
    observation: { seat: 0, level, hand: [], handCounts: [4, 4, 4, 4], lastHand: null, lastSeat: null, publicHistory: [] },
    divergence: {
      expert: { action: 'pass', cards: [] },
      proposed: { action: 'play', cards: [{ rank: replacementRank || 3, suit: 'S', deckIndex: 0 }], signature: 'single|1' },
    },
  };
}

function read(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
