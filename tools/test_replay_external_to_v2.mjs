import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'guandan-external-replay-'));
const njupt = path.join(temp, 'njupt.jsonl');
const botzone = path.join(temp, 'botzone.jsonl');
const output = path.join(temp, 'out');

function card(id, rank, suit, deckIndex = 0) {
  return { id, rank, suit, deckIndex };
}

function njuptGame(label, events) {
  return {
    schema: 'njupt-guandan-archive-v1', kind: 'game', source: { sha256: label, relativePath: `${label}.data` },
    identity: { label }, records: events,
  };
}

const hands = [
  [card('a', 3, 'S')], [card('b', 4, 'H')], [card('c', 5, 'C')], [card('d', 6, 'D')],
];
const acceptedEvents = [
  { round: 1, event: { type: 'round_level', scope: 'current', subject: -1, level: 2 } },
  { round: 1, event: { type: 'round_level', scope: 'team', subject: 0, level: 2 } },
  { round: 1, event: { type: 'round_level', scope: 'team', subject: 1, level: 2 } },
  ...hands.map((cards, seat) => ({ round: 1, event: { type: 'initial_hand', seat, cards } })),
  { round: 1, event: { type: 'action', seat: 0, action: 'play', cards: hands[0] } },
  { round: 1, event: { type: 'action', seat: 1, action: 'play', cards: hands[1] } },
  { round: 1, event: { type: 'action', seat: 2, action: 'play', cards: hands[2] } },
];
const rejectedEvents = acceptedEvents.map((row) => structuredClone(row));
rejectedEvents.at(-1).event = { type: 'action', seat: 2, action: 'pass', cards: [] };
fs.writeFileSync(njupt, [njuptGame('accepted', acceptedEvents), njuptGame('bad-pass', rejectedEvents)]
  .map(JSON.stringify).join('\n'), 'utf8');
fs.writeFileSync(botzone, '', 'utf8');

const run = spawnSync(process.execPath, [
  'tools/replay_external_to_v2.mjs', '--njupt', njupt, '--botzone', botzone, '--output', output,
], { cwd: root, encoding: 'utf8' });
assert.equal(run.status, 1, run.stderr || run.stdout);

const report = JSON.parse(fs.readFileSync(path.join(output, 'external-replay-report.json'), 'utf8'));
assert.equal(report.episodes.accepted, 0, '不完整发牌不能被伪造为通过局');
assert.equal(report.episodes.rejected, 2, '两条不完整夹具均被隔离');
assert.equal(report.failuresByCode.invalid_deal, 2, '双副牌完整性是外部接入的硬门');
const rows = fs.readFileSync(path.join(output, 'external-trajectory-v2.jsonl'), 'utf8');
assert.equal(rows, '', '拒绝局不生成任何公平轨迹');
const rejected = fs.readFileSync(path.join(output, 'external-replay-rejected.jsonl'), 'utf8')
  .trim().split(/\r?\n/).map(JSON.parse);
assert(rejected.every((row) => row.trainingEligible === false && row.code === 'invalid_deal'));
const adapterStatus = JSON.parse(fs.readFileSync(path.join(output, 'external-wind-adapter-status.json'), 'utf8'));
assert.deepEqual(adapterStatus.entries, [], '非接风失败不能伪造适配候选');
assert.equal(fs.existsSync(path.join(output, 'external-wind-adapter-trajectory.jsonl')), false,
  '接风适配实验不得生成训练轨迹文件');
const evidenceStatus = JSON.parse(fs.readFileSync(path.join(output, 'external-wind-evidence-status.json'), 'utf8'));
assert.deepEqual(evidenceStatus.entries, [], '无适配候选时不应生成分支证据候选');
assert.equal(fs.existsSync(path.join(output, 'external-wind-evidence-trajectory.jsonl')), false,
  '分支证据合并不得生成训练轨迹文件');
const actionAuditStatus = JSON.parse(fs.readFileSync(path.join(output, 'external-wind-action-audit-status.json'), 'utf8'));
assert.deepEqual(actionAuditStatus.entries, [], '无分支证据时不应生成动作映射候选');
assert.equal(fs.readFileSync(path.join(output, 'external-adapter-trajectory-v1.jsonl'), 'utf8'), '',
  '未审计通过的局不得进入隔离公平轨迹');

fs.rmSync(temp, { recursive: true, force: true });
console.log('外部回放转换器: 12 passed, 0 failed');
