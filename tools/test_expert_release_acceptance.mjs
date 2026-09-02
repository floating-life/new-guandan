/** REL-1 脚本化三副验收：升级、贡还、打 A。 */
import { runExpertReleaseAcceptance } from './expert_release_acceptance.mjs';

const report = await runExpertReleaseAcceptance();
let failed = 0;
function assert(condition, message) {
  if (condition) console.log('  ✓', message);
  else {
    failed += 1;
    console.error('  ✗', message);
  }
}

assert(report.schema === 'guandan-expert-release-acceptance-v1', '验收报告 schema 固定');
assert(report.engine === 'expert', '验收使用网页默认专家策略');
assert(report.scenarios.upgrade.finishOrder.length === 4, '普通升级局产生完整名次');
assert(report.scenarios.tribute.hadTribute === true, '在有限副数内出现进贡/还贡');
assert(report.scenarios.playA.startedAtA === true, '打 A 局从级牌 A 开打');
assert(report.scenarios.playA.passedA === true || report.scenarios.playA.failedA === true,
  '打 A 局记录过 A 或不过 A');
assert(report.privacy.replayCollectorDefaultOff && report.privacy.apiKeyNotInLocalStorage,
  '隐私台账记录采集器默认关闭且密钥不进 localStorage');
assert(report.interaction.rollback.length >= 3, '交互台账包含回滚步骤');
assert(report.ok === true, '三副脚本化验收整体通过');

console.log(`\nREL acceptance: ${failed ? 'FAILED' : 'passed'}`);
process.exit(failed ? 1 : 0);
