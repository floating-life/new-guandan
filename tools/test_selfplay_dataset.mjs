#!/usr/bin/env node
/**
 * LEARN-001: v3 self-play collection contract.
 *
 * Live generation is a single derived game (one level × one rotation), not the
 * parent-owned 52-game smoke. Coverage, resume, and failure modes are checked
 * against the plan builder, synthetic fixtures, and that one real game.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guandan-selfplay-v3-'));

const {
  LEARNING_ALL_LEVELS,
  LEARNING_ALL_ROTATIONS,
  buildV3DealPlan,
  resolveLearningSplit,
  rotateSeatArray,
  rotateSeatIndex,
} = await import('./selfplay_dataset.mjs');

function run(args, { timeout = 30000 } = {}) {
  return spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout,
  });
}

function combined(result) {
  return `${result.stderr || ''}\n${result.stdout || ''}${result.error ? `\n${result.error.message}` : ''}`;
}

function writeJsonl(file, rows) {
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

function assertStatus(result, expected, label) {
  assert.equal(
    result.status,
    expected,
    `${label}: expected exit ${expected}, got ${result.status}\n${combined(result)}`,
  );
}

function loadRegistry(name) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, 'tools', name), 'utf8'));
}

function rangeBounds(entry) {
  const start = entry.start ?? entry.baseSeed;
  const end = entry.end ?? entry.seedEnd ?? entry.baseSeed;
  return [start, end];
}

try {
  // Reproduce failed derived game835 without replaying the834 completed games.
  const executedOutput = path.join(tempRoot, 'executed-action.jsonl');
  const executedResult = run([
    'tools/selfplay_dataset.mjs', '1', '3100000016', executedOutput,
    '--learning-v3', '--deal-blocks', '--levels=2', '--rotations=2',
  ]);
  assertStatus(executedResult, 0, 'actual legal action outside consultation shortlist');
  assertStatus(run(['tools/validate_value_dataset.mjs', executedOutput]), 0, 'executed-action dataset');
  const executedRows = fs.readFileSync(executedOutput, 'utf8').trim().split(/\r?\n/).slice(1).map(JSON.parse);
  const missingCards = ['3_C_0_40', '3_D_1_81', '3_H_1_68', '4_C_1_95', '4_D_0_28'].sort();
  assert(executedRows.some(row => row.candidates.some(candidate => candidate.chosen
    && candidate.signature === 'fullhouse|5|3|4||'
    && JSON.stringify(candidate.cards.map(card => card.id).sort()) === JSON.stringify(missingCards))),
  'the formerly missing full house must be recorded, not silently skipped');

  const learningRegistry = loadRegistry('learning-seed-registry.json');
  const strat6Registry = loadRegistry('strat6-seed-registry.json');
  assert.equal(learningRegistry.schema, 'guandan-learning-seed-registry-v1');

  const learningRanges = learningRegistry.ranges.map((entry) => {
    const [start, end] = rangeBounds(entry);
    return { id: entry.id, split: entry.split, start, end };
  });
  for (const range of learningRegistry.ranges) {
    assert.equal(range.seedEnd, range.baseSeed + range.groupCount - 1, `${range.id} seedEnd must be contiguous`);
    assert.notEqual(range.baseSeed, 0, `${range.id} must not use the zero uint32 alias`);
  }
  for (let i = 0; i < learningRanges.length; i += 1) {
    for (let j = i + 1; j < learningRanges.length; j += 1) {
      const left = learningRanges[i];
      const right = learningRanges[j];
      const overlap = left.start <= right.end && right.start <= left.end;
      assert.equal(overlap, false, `${left.id} overlaps ${right.id}`);
    }
  }

  const strat6Ranges = [
    [strat6Registry.formal.baseSeed, strat6Registry.formal.seedEnd],
    [strat6Registry.smoke.baseSeed, strat6Registry.smoke.seedEnd],
    ...strat6Registry.reservedUnused.map((entry) => [entry.start, entry.end]),
    ...strat6Registry.forbiddenRanges.map((entry) => [entry.start, entry.end]),
  ];
  for (const range of learningRanges) {
    for (const [start, end] of strat6Ranges) {
      const overlap = range.start <= end && start <= range.end;
      assert.equal(overlap, false, `${range.id} overlaps strat6 ${start}-${end}`);
    }
  }

  assert.equal(resolveLearningSplit(3400000000), 'smoke');
  assert.equal(resolveLearningSplit(3100000000), 'train');
  assert.equal(resolveLearningSplit(3100000015), 'train');
  assert.equal(resolveLearningSplit(3100000016), 'validation');
  assert.equal(resolveLearningSplit(3100000019), 'validation');
  assert.equal(resolveLearningSplit(3200000000), 'development');
  assert.equal(resolveLearningSplit(3300000000), 'confirmation');
  assert.throws(() => resolveLearningSplit(3500000000), /not registered/i);
  assert.throws(() => resolveLearningSplit(20260901), /not registered/i);
  assert.throws(() => resolveLearningSplit(0), /not registered|zero/i);

  assert.deepEqual(LEARNING_ALL_LEVELS, Array.from({ length: 13 }, (_, index) => index + 2));
  assert.deepEqual(LEARNING_ALL_ROTATIONS, [0, 1, 2, 3]);

  const smokePlan = buildV3DealPlan({
    dealBlocks: 1,
    baseSeed: 3400000000,
    levels: LEARNING_ALL_LEVELS,
    rotations: LEARNING_ALL_ROTATIONS,
  });
  assert.equal(smokePlan.length, 52);
  assert.equal(new Set(smokePlan.map((item) => item.derivedGameId)).size, 52);
  assert.equal(new Set(smokePlan.map((item) => item.dealGroupId)).size, 1);
  assert.equal(smokePlan[0].dealGroupId, 'learn-v3-3400000000-1');
  assert.equal(smokePlan[0].split, 'smoke');
  assert.deepEqual(
    [...new Set(smokePlan.map((item) => item.level))].sort((left, right) => left - right),
    LEARNING_ALL_LEVELS.slice(),
  );
  assert.deepEqual(
    [...new Set(smokePlan.map((item) => item.rotation))].sort((left, right) => left - right),
    LEARNING_ALL_ROTATIONS.slice(),
  );
  const trainPlan = buildV3DealPlan({
    dealBlocks: 20,
    baseSeed: 3100000000,
    levels: LEARNING_ALL_LEVELS,
    rotations: LEARNING_ALL_ROTATIONS,
  });
  assert.equal(trainPlan.length, 1040);
  assert.equal(trainPlan.filter((item) => item.split === 'train').length, 16 * 13 * 4);
  assert.equal(trainPlan.filter((item) => item.split === 'validation').length, 4 * 13 * 4);
  assert.throws(
    () => buildV3DealPlan({
      dealBlocks: 2,
      baseSeed: 0xFFFFFFFF,
      levels: [2],
      rotations: [0],
    }),
    /zero or duplicate uint32 seed/i,
  );

  assert.deepEqual(rotateSeatArray(['a', 'b', 'c', 'd'], 0), ['a', 'b', 'c', 'd']);
  assert.deepEqual(rotateSeatArray(['a', 'b', 'c', 'd'], 1), ['d', 'a', 'b', 'c']);
  assert.equal(rotateSeatIndex(2, 1), 3);
  assert.equal(rotateSeatIndex(3, 1), 0);

  const missingDealBlocks = run([
    'tools/selfplay_dataset.mjs', '1', '3400000000', path.join(tempRoot, 'no-blocks.jsonl'),
    '--learning-v3',
  ]);
  assert.notEqual(missingDealBlocks.status, 0, combined(missingDealBlocks));
  assert.match(combined(missingDealBlocks), /--learning-v3 and --deal-blocks must be supplied together/);

  const unregistered = run([
    'tools/selfplay_dataset.mjs', '1', '20260901', path.join(tempRoot, 'legacy-seed.jsonl'),
    '--learning-v3', '--deal-blocks', '--levels=2', '--rotations=0',
  ]);
  assert.notEqual(unregistered.status, 0, combined(unregistered));
  assert.match(combined(unregistered), /not registered/i);

  const output = path.join(tempRoot, 'single-game.jsonl');
  const generated = run([
    'tools/selfplay_dataset.mjs', '1', '3400000000', output,
    '--learning-v3', '--deal-blocks', '--levels=8', '--rotations=1',
  ], { timeout: 180000 });
  assertStatus(generated, 0, 'single-game v3 generation');

  const rows = fs.readFileSync(output, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  const header = rows.shift();
  assert.equal(header.schema, 'guandan-selfplay-trajectory-v3-header');
  assert.equal(header.dealBlocks, 1);
  assert.equal(header.games, 1);
  assert.equal(header.rounds, 1);
  assert.deepEqual(header.levels, [8]);
  assert.deepEqual(header.rotations, [1]);
  assert.equal(header.gamePlan.length, 1);
  assert.equal(header.gamePlan[0].dealGroupId, 'learn-v3-3400000000-1');
  assert.equal(header.gamePlan[0].derivedGameId, 'learn-v3-3400000000-1-l8-r1');
  assert.equal(header.gamePlan[0].level, 8);
  assert.equal(header.gamePlan[0].rotation, 1);
  assert.equal(header.gamePlan[0].split, 'smoke');
  assert.equal(header.baseSeed, 3400000000);
  assert.deepEqual(header.seedManifest?.seeds, [3400000000]);
  assert.equal(header.purpose, 'learning-development');
  assert.ok(rows.length > 0, 'the generated game must contain decisions');
  const actingSeats = new Set();
  for (const row of rows) {
    assert.equal(row.schema, 'guandan-selfplay-trajectory-v3');
    assert.equal(row.dealGroupId, header.gamePlan[0].dealGroupId);
    assert.equal(row.derivedGameId, header.gamePlan[0].derivedGameId);
    assert.equal(row.level, 8);
    assert.equal(row.observation.level, 8);
    assert.equal(row.rotation, 1);
    assert.equal(row.split, 'smoke');
    assert.equal(row.sourceSeat, (row.seat - 1 + 4) % 4);
    assert.ok(Number.isInteger(row.startSeat) && row.startSeat >= 0 && row.startSeat < 4);
    actingSeats.add(row.seat);
  }
  assert.deepEqual([...actingSeats].sort((left, right) => left - right), [0, 1, 2, 3]);

  const valid = run(['tools/validate_value_dataset.mjs', output], { timeout: 60000 });
  assertStatus(valid, 0, 'single-game v3 validation');

  const duplicatePath = path.join(tempRoot, 'duplicate.jsonl');
  const duplicate = JSON.parse(JSON.stringify(rows[0]));
  duplicate.game = 2;
  writeJsonl(duplicatePath, [header, ...rows, duplicate]);
  const rejectedDuplicate = run(['tools/validate_value_dataset.mjs', duplicatePath]);
  assert.notEqual(rejectedDuplicate.status, 0, 'a duplicate v3 derived game must be rejected');
  assert.match(combined(rejectedDuplicate), /duplicate derivedGameId/i);

  const missingLevelPath = path.join(tempRoot, 'missing-level.jsonl');
  const missingLevelHeader = JSON.parse(JSON.stringify(header));
  missingLevelHeader.levels = [8, 9];
  writeJsonl(missingLevelPath, [missingLevelHeader, ...rows]);
  const rejectedMissingLevel = run(['tools/validate_value_dataset.mjs', missingLevelPath]);
  assert.notEqual(rejectedMissingLevel.status, 0, 'a v3 header that claims a missing level must be rejected');
  assert.match(combined(rejectedMissingLevel), /missing level/i);

  const badGroupPath = path.join(tempRoot, 'bad-group.jsonl');
  const badGroupRows = JSON.parse(JSON.stringify(rows));
  badGroupRows[0].dealGroupId = 'learn-v3-3400000000-9';
  badGroupRows[0].split = 'train';
  writeJsonl(badGroupPath, [header, ...badGroupRows]);
  const rejectedBadGroup = run(['tools/validate_value_dataset.mjs', badGroupPath]);
  assert.notEqual(rejectedBadGroup.status, 0, 'an inconsistent v3 deal group must be rejected');
  assert.match(combined(rejectedBadGroup), /inconsistent dealGroupId|deal group/i);

  const resumeDir = path.join(tempRoot, 'resume');
  fs.mkdirSync(resumeDir, { recursive: true });
  const resumeOutput = path.join(resumeDir, 'resume.jsonl');
  const resumePlan = buildV3DealPlan({
    dealBlocks: 1,
    baseSeed: 3400000000,
    levels: [8],
    rotations: [1],
  });
  const checkpoint = {
    schema: 'guandan-selfplay-checkpoint-v1',
    outputPath: path.resolve(resumeOutput),
    rounds: 1,
    baseSeed: 3400000000,
    learningV3: true,
    dealBlocks: 1,
    levels: [8],
    rotations: [1],
    gamePlan: resumePlan,
    nextRound: 1,
    recordCount: 0,
    recordBytes: 0,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(`${resumeOutput}.records.tmp`, '', 'utf8');
  fs.writeFileSync(`${resumeOutput}.checkpoint.json`, `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8');
  const crossResume = run([
    'tools/selfplay_dataset.mjs', '1', '3400000000', resumeOutput,
    '--learning-v3', '--deal-blocks', '--levels=8', '--rotations=0',
    '--resume',
  ]);
  assert.notEqual(crossResume.status, 0, 'cross-config v3 resume must fail');
  assert.match(combined(crossResume), /无法恢复/);

  console.log('selfplay dataset v3 tests: PASS');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
