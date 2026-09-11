import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)));
const gatesPath = join(root, 'ai-local-003-coverage-gates.json');
const planPath = join(root, 'ai-local-003-coverage-plan.md');

function loadGates() {
  return JSON.parse(readFileSync(gatesPath, 'utf8'));
}

const authorizeFlags = new Set([
  '--optimize', '--authorise', '--authorize', '--admit',
  '--release', '--promotion', '--release-evidence', '--full-data',
]);
for (const arg of process.argv.slice(2)) {
  if (authorizeFlags.has(arg) || arg.startsWith('--optimize=') || arg.startsWith('--authorize=')) {
    console.error('AI-LOCAL-003 计划测试拒绝 CLI 授权/优化/发布入口；覆盖门禁不经命令行翻转');
    process.exit(1);
  }
}

const gates = loadGates();
assert.equal(gates.schema, 'guandan-ai-local-003-coverage-plan-v1');
assert.equal(gates.optimizationAllowed, false, '不得打开减覆盖/减预算类优化');
assert.equal(gates.implementationAuthorized, true, '用户已明示开工 003-OPT 第一刀');
assert.equal(gates.firstSliceAuthorized, true);
assert.equal(gates.firstSliceLanded, true);
assert.equal(gates.promotionEvidence, false);
assert.equal(gates.releaseEvidence, false);
assert.equal(gates.formalGateEligible, false);
assert.equal(gates.perf3Unlocked, false, '本计划不解锁 PERF-3');
assert.equal(gates.locateDefaultOff, true);
assert.equal(gates.expertDefaultUnchanged, true);
assert.equal(gates.ismctsV3ProductSelector, false);

assert.equal(gates.hotPath.callSite, 'js/ai-hybrid.js:runISMCTSSearch');
assert.equal(gates.hotPath.function, 'rolloutFromSimulationState');
assert.equal(gates.hotPath.dominantPhase, 'rollout');
assert.equal(gates.hotPath.locateGames8.seat0Triggered, 14);
assert.equal(gates.hotPath.diagnosticGames128.seat0Triggered, 185);
assert.equal(gates.hotPath.diagnosticGames128.cannotUseOverallP95, true);
assert.equal(gates.hotPath.diagnosticGames128.searchTriggeredP95Ms, 640);
assert.equal(gates.hotPath.diagnosticGames128.searchTriggeredP99Ms, 996);

const search = gates.searchTriggeredGates;
assert.equal(search.minTriggered, 100);
assert.equal(search.coverageMin, 0.99);
assert.equal(search.p95Ms, 500, '不得在计划里放宽 P95');
assert.equal(search.p99Ms, 750, '不得在计划里放宽 P99');
assert.equal(search.timeoutFallbackMax, 0.005);

assert.equal(gates.frozenBudgets.deterministicV3NodeBudget, 1800);
assert.equal(gates.frozenBudgets.deterministicIterationBudget, 72);
assert.equal(gates.frozenBudgets.defaultBranchLimit, 5);
assert.equal(gates.frozenBudgets.candidateLimit, 6);

const requiredForbidden = [
  'reduceSearchTriggerRate',
  'reduceNodeBudget',
  'reduceIterationBudget',
  'relaxP95',
  'relaxP99',
  'useOverallP95AsSearchGate',
  'heuristicEarlyRolloutCutoff',
  'applyStrat3InRollout',
  'openStrat3Or4',
  'putIsmctsV3InProductSelector',
  'consumeFormalSeeds',
];
for (const item of requiredForbidden) {
  assert.ok(gates.forbidden.includes(item), `forbidden 缺少 ${item}`);
}

const plan = readFileSync(planPath, 'utf8');
assert.ok(plan.includes('js/ai-hybrid.js:runISMCTSSearch'));
assert.ok(plan.includes('rolloutFromSimulationState'));
assert.ok(plan.includes('implementationAuthorized=true'));
assert.ok(plan.includes('optimizationAllowed=false'));
assert.ok(plan.includes('500'));
assert.ok(plan.includes('750'));
assert.ok(plan.includes('PERF-3'));
assert.equal(gates.planDocument, 'tools/ai-local-003-coverage-plan.md');

console.log('AI-LOCAL-003 coverage plan: first slice landed, coverage still fail-closed, 500/750 unchanged');
