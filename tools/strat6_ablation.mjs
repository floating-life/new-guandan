/**
 * STRAT-6 预登记种子校验、分层汇总与（可选）消融启动。
 * 正式镜像必须走 js/ai.ab.simulation.js，不得另写评测状态机。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createSeedManifest, seedManifestOverlap } from '../js/value-model-gate.js';

export const STRAT6_REGISTRY_SCHEMA = 'guandan-strat6-seed-registry-v1';
export const STRAT6_SUMMARY_SCHEMA = 'guandan-strat6-ablation-summary-v1';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultRegistryPath = path.join(root, 'tools', 'strat6-seed-registry.json');

export function loadStrat6Registry(registryPath = defaultRegistryPath) {
  const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const errors = validateStrat6Registry(parsed);
  if (errors.length) throw new TypeError(errors.join('；'));
  return parsed;
}

function inclusiveSeeds(start, count) {
  return Array.from({ length: count }, (_, index) => (start + index) >>> 0);
}

function rangeSeeds(range) {
  const start = Number(range.start);
  const end = Number(range.end);
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) return [];
  return inclusiveSeeds(start, end - start + 1);
}

export function validateStrat6Registry(registry) {
  const errors = [];
  if (registry?.schema !== STRAT6_REGISTRY_SCHEMA) errors.push('registry schema 不匹配');
  if (registry?.comparison !== 'expert') errors.push('对照必须是 expert');
  if (registry?.opponentModelMode !== 'off') errors.push('必须 opponentModelMode=off');
  if (registry?.levels !== 'all' || registry?.levelBlocks !== true) {
    errors.push('必须全 13 级且 same-deal-cross-level-blocks');
  }
  const arms = Array.isArray(registry?.arms) ? registry.arms : [];
  if (arms.length !== 3) errors.push('必须恰好三条独立规则臂');
  const ids = new Set(arms.map((arm) => arm?.id));
  if (ids.size !== arms.length) errors.push('臂 id 必须唯一');
  for (const role of ['formal', 'smoke']) {
    const block = registry?.[role];
    if (!block || !Number.isInteger(block.baseSeed) || !Number.isInteger(block.groupCount)) {
      errors.push(`${role} 缺少 baseSeed/groupCount`);
      continue;
    }
    if (block.groupCount < 1) errors.push(`${role} groupCount 无效`);
  }
  if (registry?.formal?.groupCount < 40) {
    errors.push('正式臂至少 40 个基础牌区组才能达到 500 镜像对（40×13=520）');
  }
  const forbidden = (registry?.forbiddenRanges || []).flatMap(rangeSeeds);
  const reserved = [
    ...inclusiveSeeds(registry.formal?.baseSeed, registry.formal?.groupCount || 0),
    ...inclusiveSeeds(registry.smoke?.baseSeed, registry.smoke?.groupCount || 0),
  ];
  const overlap = seedManifestOverlap(
    createSeedManifest(reserved),
    createSeedManifest(forbidden),
  );
  if (overlap.length) errors.push(`预登记种子与禁用区间重叠：${overlap.slice(0, 8).join(',')}`);
  const formalSmoke = seedManifestOverlap(
    createSeedManifest(inclusiveSeeds(registry.formal?.baseSeed, registry.formal?.groupCount || 0)),
    createSeedManifest(inclusiveSeeds(registry.smoke?.baseSeed, registry.smoke?.groupCount || 0)),
  );
  if (formalSmoke.length) errors.push('smoke 种子不得进入正式清单');
  return errors;
}

function teamOf(seat) {
  return seat % 2;
}

export function loadStrat6Artifacts(reportPath, checkpointPath = null) {
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  let checkpoint = null;
  if (checkpointPath && fs.existsSync(checkpointPath)) {
    checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
  }
  return { report, checkpoint };
}

function readSearchTriggered(report, arm) {
  const performance = report?.performance || {};
  const byPolicy = performance.decisionLatencyByPolicy
    || report?.decisionPerformanceByPolicy
    || {};
  const search = byPolicy[arm?.candidate]
    || performance.allAIDecisions
    || report?.allAIDecisionPerformance
    || null;
  const triggered = search?.searchTriggered;
  if (triggered && typeof triggered === 'object') {
    return Number(triggered.decisionTurns) || 0;
  }
  return Number(triggered) || 0;
}

export function summarizeStrat6Arm(report, arm, checkpoint = null) {
  const games = Array.isArray(report?.games)
    ? report.games
    : Array.isArray(checkpoint?.games) ? checkpoint.games : [];
  const completion = report?.completion || {};
  const result = report?.result || {};
  const ci = result.candidatePairedUtilityBootstrap95;
  const lower = Array.isArray(ci) ? Number(ci[0]) : null;
  const failures = Number(completion.failures) || 0;
  const deadlocks = Number(completion.deadlocks) || 0;
  const mismatches = Number(completion.mirrorMismatches) || 0;
  const pairs = Number(completion.mirrorPairsCompleted) || 0;
  const blocks = Number(completion.baseDealBlocksCompleted) || 0;
  const expectedPairs = (report?.config?.baseDealBlocks || 0)
    * (Array.isArray(report?.config?.evaluationLevels) ? report.config.evaluationLevels.length : 0);
  // 镜像 A/B 中对照双上 = 候选双下；灾难门比较原始计数，不比较比率。
  const candidateDoubleDowns = Number(result.comparisonDoubleUps) || 0;
  const comparisonDoubleDowns = Number(result.candidateDoubleUps) || 0;
  const searchTriggered = readSearchTriggered(report, arm);
  const gates = {
    complete: pairs >= 500 && blocks >= 40 && expectedPairs > 0 && pairs === expectedPairs,
    zeroFailures: failures === 0 && deadlocks === 0 && mismatches === 0,
    utilityLowerBoundPositive: lower != null && Number.isFinite(lower) && lower > 0,
    disasterNotWorse: candidateDoubleDowns <= comparisonDoubleDowns,
  };
  const promote = Object.values(gates).every(Boolean);
  return {
    schema: STRAT6_SUMMARY_SCHEMA,
    arm: arm?.id || null,
    rule: arm?.rule || null,
    candidate: arm?.candidate || report?.config?.candidate || null,
    comparison: report?.config?.comparison || 'expert',
    completion,
    utilityPerGame: result.candidateUpgradeUtilityPerGame ?? null,
    pairedUtilityBootstrap95: ci || null,
    headRate: result.candidateHeadRate ?? null,
    candidateDoubleUps: result.candidateDoubleUps ?? null,
    comparisonDoubleUps: result.comparisonDoubleUps ?? null,
    candidateDoubleDowns,
    searchTriggered,
    gates,
    promote,
    keepClosed: !promote,
    strata: stratifyGames(games),
  };
}

function stratifyGames(games) {
  const buckets = {
    byCandidateTeam: { 0: emptyBucket(), 1: emptyBucket() },
    byFirstPlayerSeat: {
      0: emptyBucket(), 1: emptyBucket(), 2: emptyBucket(), 3: emptyBucket(),
    },
    byFirstPlayerRole: { self: emptyBucket(), lower: emptyBucket(), partner: emptyBucket(), upper: emptyBucket() },
    byTributeDoubleDown: { yes: emptyBucket(), no: emptyBucket(), unknown: emptyBucket() },
    tributeStrataIdentified: false,
  };
  for (const game of games) {
    if (!game || game.ok === false) continue;
    addGame(buckets.byCandidateTeam[Number(game.candidateTeam)] || null, game);
    addGame(buckets.byFirstPlayerSeat[Number(game.firstPlayer)] || null, game);
    const role = firstPlayerRole(game);
    addGame(buckets.byFirstPlayerRole[role], game);
    const tribute = game.tributeDoubleDown === true
      ? 'yes'
      : game.tributeDoubleDown === false ? 'no' : 'unknown';
    addGame(buckets.byTributeDoubleDown[tribute], game);
  }
  return buckets;
}

function firstPlayerRole(game) {
  const seat = Number(game.firstPlayer);
  const candidateTeam = Number(game.candidateTeam);
  if (!Number.isInteger(seat) || (candidateTeam !== 0 && candidateTeam !== 1)) return 'self';
  if (teamOf(seat) === candidateTeam) return seat === candidateTeam ? 'self' : 'partner';
  return (seat === ((candidateTeam + 1) % 4)) ? 'lower' : 'upper';
}

function emptyBucket() {
  return { games: 0, utilitySum: 0, heads: 0, doubleUps: 0, doubleDowns: 0 };
}

function addGame(bucket, game) {
  if (!bucket) return;
  bucket.games += 1;
  bucket.utilitySum += Number(game.utility) || 0;
  if (game.candidateHead) bucket.heads += 1;
  if (game.candidateDoubleUp) bucket.doubleUps += 1;
  if (game.comparisonDoubleUp) bucket.doubleDowns += 1;
}

export function decidePromotion(summaries) {
  return Object.fromEntries((summaries || []).map((item) => [
    item.arm,
    {
      promote: item.promote === true,
      keepClosed: item.promote !== true,
      feature: item.rule || null,
    },
  ]));
}

function parseArgs(argv) {
  const options = { registry: defaultRegistryPath, role: 'smoke', execute: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--execute') options.execute = true;
    else if (arg === '--formal') options.role = 'formal';
    else if (arg === '--smoke') options.role = 'smoke';
    else if (arg === '--registry' && argv[index + 1]) options.registry = argv[++index];
    else if (arg === '--report-dir' && argv[index + 1]) options.reportDir = argv[++index];
    else if (arg === '--help' || arg === '-h') options.help = true;
  }
  return options;
}

export function ablationCommand(arm, block, reportDir) {
  const report = path.join(reportDir, `strat6-${block.role}-${arm.id}.json`);
  const checkpoint = path.join(reportDir, `strat6-${block.role}-${arm.id}.checkpoint.json`);
  return {
    args: [
      path.join(root, 'js', 'ai.ab.simulation.js'),
      String(block.groupCount),
      String(block.baseSeed),
      arm.candidate,
      'expert',
      '--levels=all',
      '--level-blocks',
      `--report=${report}`,
      `--checkpoint=${checkpoint}`,
    ],
    report,
    checkpoint,
  };
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log('用法：node tools/strat6_ablation.mjs [--smoke|--formal] [--execute] [--report-dir DIR]');
    return 0;
  }
  const registry = loadStrat6Registry(options.registry);
  const block = registry[options.role];
  const reportDir = options.reportDir || path.join(root, 'data');
  const plan = registry.arms.map((arm) => ({ arm, ...ablationCommand(arm, { ...block, role: options.role }, reportDir) }));
  if (!options.execute) {
    console.log(JSON.stringify({
      schema: STRAT6_REGISTRY_SCHEMA,
      role: options.role,
      baseSeed: block.baseSeed,
      groupCount: block.groupCount,
      expectedPairs: block.groupCount * 13,
      execute: false,
      commands: plan.map((item) => ({ arm: item.arm.id, args: item.args.slice(1) })),
    }, null, 2));
    return 0;
  }
  fs.mkdirSync(reportDir, { recursive: true });
  const summaries = [];
  for (const item of plan) {
    const child = spawnSync(process.execPath, item.args, {
      encoding: 'utf8',
      cwd: root,
      stdio: 'inherit',
      timeout: 8 * 60 * 60 * 1000,
    });
    if (child.status !== 0) {
      throw new Error(`${item.arm.id} 消融失败（exit ${child.status}）`);
    }
    const report = JSON.parse(fs.readFileSync(item.report, 'utf8'));
    summaries.push(summarizeStrat6Arm(report, item.arm));
  }
  const output = {
    schema: STRAT6_SUMMARY_SCHEMA,
    role: options.role,
    promotion: decidePromotion(summaries),
    summaries,
  };
  const summaryPath = path.join(reportDir, `strat6-${options.role}-summary.json`);
  fs.writeFileSync(summaryPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`STRAT-6 ${options.role} 汇总写入 ${summaryPath}`);
  console.log(JSON.stringify(output.promotion, null, 2));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
