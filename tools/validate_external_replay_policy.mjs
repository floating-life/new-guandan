#!/usr/bin/env node
/** Assert that external replay outputs remain isolated from the self-play trainer. */
import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const options = { trajectory: null, status: null };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!['--trajectory', '--status'].includes(key)) throw new Error(`未知参数：${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${key} 需要路径参数`);
    options[key.slice(2)] = value;
    index += 1;
  }
  if (!options.trajectory || !options.status) {
    throw new Error('用法：node tools/validate_external_replay_policy.mjs --trajectory path --status path');
  }
  return options;
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch (error) { throw new Error(`${file}:${index + 1} JSON 无效：${error.message}`); }
  });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const trajectoryFile = path.resolve(options.trajectory);
  const statusFile = path.resolve(options.status);
  const rows = readJsonl(trajectoryFile);
  const status = JSON.parse(fs.readFileSync(statusFile, 'utf8')).entries || [];
  const errors = [];
  rows.forEach((row, index) => {
    if (row.schema !== 'guandan-external-trajectory-v1') {
      errors.push(`trajectory[${index}] schema mismatch`);
    }
    if (row.trainingEligible !== false) {
      errors.push(`trajectory[${index}] trainingEligible must be false`);
    }
  });
  status.forEach((entry, index) => {
    if (entry.trainingEligible !== false) errors.push(`status[${index}] trainingEligible must be false`);
  });
  const report = {
    schema: 'guandan-external-replay-policy-validation-v1',
    trajectory: path.basename(trajectoryFile),
    status: path.basename(statusFile),
    ok: errors.length === 0,
    trajectoryRecords: rows.length,
    statusEntries: status.length,
    trainingEligible: false,
    errors: errors.slice(0, 100),
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

main();
