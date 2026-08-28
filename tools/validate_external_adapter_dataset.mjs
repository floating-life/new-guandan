#!/usr/bin/env node
/** Validate isolated, action-audited external trajectories without promoting them to training. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TEAM_OF } from '../js/game.js';
import { calcUpgrade, isLegalPlay } from '../js/rules.js';
import { auditPublicAIObservation } from '../js/ai-observation.js';

const DEFAULT_TRAJECTORY = '训练数据/验证/external-adapter-trajectory-v1.jsonl';
const DEFAULT_STATUS = '训练数据/验证/external-wind-action-audit-status.json';

function parseArgs(argv) {
  const options = { trajectory: DEFAULT_TRAJECTORY, status: DEFAULT_STATUS, output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!['--trajectory', '--status', '--output'].includes(key)) throw new Error(`未知参数：${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${key} 需要路径参数`);
    options[key.slice(2)] = value;
    index += 1;
  }
  return options;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

function fail(errors, where, message) {
  errors.push({ where, message });
}

function cardIds(cards) {
  return new Set((cards || []).map((card) => String(card.id)));
}

function validSeat(value) {
  return Number.isInteger(value) && value >= 0 && value < 4;
}

function validateRow(row, index, errors) {
  const where = `row ${index + 1}`;
  if (row.schema !== 'guandan-external-adapter-trajectory-v1') fail(errors, where, 'unexpected schema');
  if (row.trainingEligible !== false) fail(errors, where, 'external adapter rows must remain trainingEligible=false');
  if (row.projectRuleReplay !== 'adapter_action_audited') fail(errors, where, 'missing action-audited status');
  if (row.actionMapping !== 'resolved_unique_branch') fail(errors, where, 'action mapping is not uniquely resolved');
  if (row.fairness !== 'own_hand_plus_public_history_only') fail(errors, where, 'unexpected fairness declaration');
  const audit = auditPublicAIObservation(row.observation);
  if (!audit.ok) fail(errors, where, `public observation leak: ${audit.leaked.join(',')}`);
  const observation = row.observation || {};
  const chosen = row.chosen || {};
  if (row.chosenAction !== chosen.action) fail(errors, where, 'chosenAction does not match chosen.action');
  if (chosen.action === 'pass') {
    if ((chosen.cards || []).length) fail(errors, where, 'pass contains cards');
    if (!observation.lastHand) fail(errors, where, 'pass is illegal without a last hand');
  } else if (chosen.action === 'play') {
    const owned = cardIds(observation.hand);
    if (!(chosen.cards || []).every((card) => owned.has(String(card.id)))) fail(errors, where, 'chosen cards are not all owned');
    const legal = isLegalPlay(chosen.cards || [], observation.level, observation.lastHand, chosen.signature || null);
    if (!legal.ok || !legal.hand) fail(errors, where, `chosen play is illegal: ${legal.reason || 'unknown'}`);
  } else {
    fail(errors, where, 'unknown chosen action');
  }
  const outcome = row.outcome || {};
  const finishOrder = outcome.finishOrder || [];
  const validFinishOrder = Array.isArray(finishOrder)
    && finishOrder.length === 4 && finishOrder.every(validSeat)
    && new Set(finishOrder).size === 4;
  if (!validFinishOrder) {
    fail(errors, where, 'invalid finish order');
  } else if (!validSeat(observation.seat)) {
    fail(errors, where, 'observation seat is invalid');
  } else {
    const winningTeam = TEAM_OF[finishOrder[0]];
    const expectedUpgrade = calcUpgrade(finishOrder, (seat) => TEAM_OF[seat]);
    const expectedWon = TEAM_OF[observation.seat] === winningTeam;
    const expectedUtility = expectedWon ? expectedUpgrade : -expectedUpgrade;
    const utility = Number(outcome.teamUtility);
    if (!Number.isFinite(utility) || utility !== expectedUtility) {
      fail(errors, where, 'team utility sign/value does not match acting seat and finish order');
    }
    if (outcome.teamWon !== expectedWon) fail(errors, where, 'teamWon does not match finish order');
    const expectedPlace = finishOrder.indexOf(observation.seat) + 1;
    if (outcome.place !== expectedPlace) fail(errors, where, 'place does not match finish order');
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const trajectoryFile = path.resolve(options.trajectory);
  const statusFile = path.resolve(options.status);
  const rows = readJsonl(trajectoryFile);
  const status = readJson(statusFile).entries || [];
  const errors = [];
  const resolvedKeys = new Set(status
    .filter((entry) => entry.actionMapping === 'resolved_unique_branch')
    .map((entry) => entry.key));
  const groups = new Map();
  const records = new Map();
  for (const [index, row] of rows.entries()) {
    validateRow(row, index, errors);
    const key = `${row.provider}:${row.sourceGameId}:round:${row.sourceRound}`;
    if (!resolvedKeys.has(key)) fail(errors, `row ${index + 1}`, 'row has no matching resolved action audit');
    const groupKey = `${row.provider}:${row.sourceGameId}`;
    const split = groups.get(groupKey);
    if (split && split !== row.split) fail(errors, `row ${index + 1}`, 'source game crosses dataset splits');
    groups.set(groupKey, row.split);
    const previous = records.get(key) || 0;
    if (row.recordIndex !== previous + 1) fail(errors, `row ${index + 1}`, 'recordIndex is not contiguous within episode');
    records.set(key, row.recordIndex);
  }
  if (!rows.length) fail(errors, 'dataset', 'no adapter trajectory rows');
  if (records.size !== resolvedKeys.size) fail(errors, 'dataset', 'not every resolved audit has trajectory records');
  const report = {
    schema: 'guandan-external-adapter-dataset-validation-v1',
    trajectory: path.basename(trajectoryFile),
    status: path.basename(statusFile),
    ok: errors.length === 0,
    records: rows.length,
    episodes: records.size,
    sourceGames: groups.size,
    splits: Object.fromEntries([...groups.values()].reduce((map, split) => map.set(split, (map.get(split) || 0) + 1), new Map())),
    trainingEligible: false,
    errors,
  };
  if (options.output) fs.writeFileSync(path.resolve(options.output), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) main();

export { main, validateRow };
