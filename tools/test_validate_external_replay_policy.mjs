import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'guandan-external-policy-'));
const trajectory = path.join(temp, 'trajectory.jsonl');
const status = path.join(temp, 'status.json');
const row = { schema: 'guandan-external-trajectory-v1', trainingEligible: false };
fs.writeFileSync(trajectory, `${JSON.stringify(row)}\n`, 'utf8');
fs.writeFileSync(status, JSON.stringify({ entries: [{ trainingEligible: false }] }), 'utf8');

const run = () => spawnSync(process.execPath, [
  'tools/validate_external_replay_policy.mjs', '--trajectory', trajectory, '--status', status,
], { cwd: root, encoding: 'utf8' });
let result = run();
assert.equal(result.status, 0, result.stderr || result.stdout);
assert.equal(JSON.parse(result.stdout).ok, true, '外部轨迹和状态的隔离标签通过校验');

fs.writeFileSync(trajectory, `${JSON.stringify({ ...row, trainingEligible: true })}\n`, 'utf8');
result = run();
assert.equal(result.status, 1, 'trainingEligible=true 的外部轨迹被硬门拒绝');

fs.rmSync(temp, { recursive: true, force: true });
console.log('外部回放隔离策略: 2 passed, 0 failed');
