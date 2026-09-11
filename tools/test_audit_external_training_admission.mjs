import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  AUDIT_SCHEMA,
  auditExternalTrainingAdmission,
  FORBIDDEN_OBSERVATION_KEYS,
} from './audit_external_training_admission.mjs';

const root = path.resolve(import.meta.dirname, '..');

assert.throws(
  () => auditExternalTrainingAdmission(root, { argv: ['--admit'] }),
  /拒绝/,
  '拒绝 --admit / 训练入口',
);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'guandan-admission-'));
const traj = path.join(temp, 'trajectory.jsonl');
const status = path.join(temp, 'status.json');
const zip = path.join(temp, 'download-summary.json');
fs.writeFileSync(zip, JSON.stringify({ ok: false, archivesAvailable: 0 }), 'utf8');
fs.writeFileSync(status, JSON.stringify({
  entries: [{ trainingEligible: false, projectRuleReplay: 'passed', provider: 'njupt-game-ai-competition' }],
}), 'utf8');
fs.writeFileSync(traj, `${JSON.stringify({
  schema: 'guandan-external-trajectory-v1',
  provider: 'njupt-game-ai-competition',
  trainingEligible: false,
  fairness: 'own_hand_plus_public_history_only',
  observation: { seat: 0, hand: [{ rank: 3, suit: 'S', deckIndex: 0 }], publicHistory: [] },
  chosen: { action: 'play', cards: [{ rank: 3, suit: 'S', deckIndex: 0 }] },
})}\n`, 'utf8');

const synthetic = auditExternalTrainingAdmission(temp, {
  trajectoryPath: traj,
  statusPath: status,
  botzoneZipReportPath: zip,
  write: false,
});
assert.equal(synthetic.admitted, false, '无许可/删除台账时不得准入');
assert.equal(synthetic.trainingEligible, false);
assert.equal(synthetic.gates.license.status, 'fail');
assert.equal(synthetic.gates.redistribution.status, 'fail');
assert.equal(synthetic.gates.commercialUse.status, 'fail');
assert.equal(synthetic.gates.deletion.status, 'fail');
assert.equal(synthetic.gates.trainingEligibleIsolation.status, 'pass');
assert.equal(synthetic.gates.actingSeat.status, 'pass');
assert.equal(synthetic.gates.hiddenCards.status, 'pass');
assert.equal(synthetic.botzoneOfficialZip.archivesAvailable, 0);
assert.equal(synthetic.wouldAdmitIfPolicyAllowed, false);

fs.writeFileSync(traj, `${JSON.stringify({
  schema: 'guandan-external-trajectory-v1',
  provider: 'njupt-game-ai-competition',
  trainingEligible: true,
  fairness: 'own_hand_plus_public_history_only',
  observation: { seat: 0, hand: [{ rank: 3, suit: 'S', deckIndex: 0 }], opponentHands: [[]] },
  chosen: { action: 'pass', cards: [] },
})}\n`, 'utf8');
const leaked = auditExternalTrainingAdmission(temp, {
  trajectoryPath: traj,
  statusPath: status,
  botzoneZipReportPath: zip,
  write: false,
});
assert.equal(leaked.admitted, false);
assert.equal(leaked.trainingEligible, false);
assert.equal(leaked.gates.trainingEligibleIsolation.status, 'fail');
assert.equal(leaked.gates.hiddenCards.status, 'fail');
assert.ok(FORBIDDEN_OBSERVATION_KEYS.includes('opponentHands'));

const live = auditExternalTrainingAdmission(root, { write: false });
assert.equal(live.schema, AUDIT_SCHEMA);
assert.equal(live.admitted, false, '当前已下载档案不得准入训练');
assert.equal(live.trainingEligible, false);
assert.equal(live.neverSetsTrainingEligibleTrue, true);
assert.equal(live.wouldAdmitIfPolicyAllowed, false);
assert.equal(live.botzoneOfficialZip.available, false);
assert.ok(live.gates.license.status !== 'pass');
assert.ok(live.gates.redistribution.status !== 'pass');
assert.ok(live.gates.commercialUse.status !== 'pass');
assert.ok(live.gates.deletion.status !== 'pass');
assert.ok(!JSON.stringify(live).includes('"trainingEligible":true'));
assert.ok(!JSON.stringify(live).includes('"admitted":true'));

const out = path.join(temp, 'audit.json');
const written = auditExternalTrainingAdmission(root, { write: true, outputPath: out });
assert.equal(written.admitted, false);
const disk = JSON.parse(fs.readFileSync(out, 'utf8'));
assert.equal(disk.schema, AUDIT_SCHEMA);
assert.equal(disk.admitted, false);
assert.equal(disk.trainingEligible, false);
assert.equal(disk.neverSetsTrainingEligibleTrue, true);

const admitCli = spawnSync(process.execPath, [
  'tools/audit_external_training_admission.mjs', '--admit',
], { cwd: root, encoding: 'utf8' });
assert.notEqual(admitCli.status, 0, 'CLI 拒绝 --admit');
assert.match(admitCli.stderr, /拒绝/);

const okCli = spawnSync(process.execPath, [
  'tools/audit_external_training_admission.mjs',
], { cwd: root, encoding: 'utf8' });
assert.equal(okCli.status, 0, okCli.stderr || okCli.stdout);
const cliReport = JSON.parse(okCli.stdout);
assert.equal(cliReport.admitted, false);
assert.equal(cliReport.trainingEligible, false);

fs.rmSync(temp, { recursive: true, force: true });
console.log('external training admission audit tests passed');
