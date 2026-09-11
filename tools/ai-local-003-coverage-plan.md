# AI-LOCAL-003 覆盖不变计划

本文件是覆盖不变计划。用户已明示「开工 003-OPT」且 003-PLAN-R PASS 后，**第一刀已落地**：内节点复用本 ply 已生成的合法着法（`reuseGeneratedPlays` 默认开）。
`optimizationAllowed=false`（仍禁止减覆盖/减预算/放宽 500/750）。`implementationAuthorized=true` 仅覆盖该第一刀。不是发布/晋级证据，不解锁 PERF-3。

配套机读门禁：`tools/ai-local-003-coverage-gates.json`（`guandan-ai-local-003-coverage-plan-v1`）。

## 1. 证据（已有，非正式门）

| 来源 | 数字 | 能证明什么 | 不能证明什么 |
|---|---|---|---|
| 128 局诊断 `20269003–20269130` | seat-0 `searchTriggered` **n=185**；子集 P95/P99 **640/996ms**；总体 P95 **184ms** | 样本量够做搜索门审计；总体 P95 被未搜索回合稀释 | 正式失败/晋级；热路径函数 |
| 8 局 `--locate` | seat-0 触发 14；`callSite=js/ai-hybrid.js:runISMCTSSearch`；主导阶段 **rollout** 0.64，sampleWorld 0.25，descend 0.10 | 墙钟热路径在 `rolloutFromSimulationState` | 正式门；rollout 内部哪一行 |
| 003-LOCATE-R | Antigravity **PASS** | locate 默认关、打开不改 visits/applied | Sol PASS；允许砍 rollout |

历史正式臂 `searchTriggered` P95/P99 **619/1022ms** 仍违反 **500/750ms**。那是 PERF-1/S2 账本，不是本计划的放行条件。S2 已排除「61–80 树更大」，later-block overhead 机制仍 untestable，**PERF-3 仍不可实施**。本计划只覆盖 **本机诊断热路径**，不解锁 PERF-3、不消费正式种子、不跑 `-FullData`/`-ReleaseEvidence`。

## 2. 热路径位置

1. 外层：`runISMCTSSearch` 的 v3 sweep，每个根候选一次 `rolloutFromSimulationState`（`js/ai-hybrid.js`）。
2. 内层（推断，locate 未拆）：每个 ply 调用 `chooseRolloutPlay` → `generateLegalPlays`（`js/rules.js`），再 `applySimulationAction`。
3. 次热：`samplePublicInformationSets`（份额 0.25）；`descendTree` / `selectOpenLoopActions`（0.10，内节点也会 `generateLegalPlays` + `chooseRolloutPlay`）。

v3 预算口径（不得改）：`resolveHybridSearchConfig` 确定性 v3 **nodeBudget=1800**、**iterationBudget=72**；默认 **branchLimit=5**、**candidateLimit=6**。`searchTriggered` 在 `iterations>0` 或 `nodes>0` 时为 true。

## 3. 覆盖不变量（未来任何 003-OPT 缺一不可）

同一观察、同一公开种子、同一 `ismcts-v3` 配置下：

1. **触发集合不变**：同一批诊断种子上 `searchTriggered===true` 的决策集合不得变小（不得靠更窄触发「变快」）。
2. **工作量下限不变**：`nodeBudget`、`iterationBudget`、`maxPlies`、`branchLimit`、`treeDepth`、`candidateLimit`、`sampleCount`、`minimumEffectiveVisits` 不得下调。
3. **结果等价**：根 `applied`、`reason`、`iterations` / `pairedSweeps`、各根候选 `visits` 与 `publicActionKey` 序列与改前一致（现有 locate 对照测试的口径）。
4. **rollout 策略等价**：`chooseRolloutPlay` 对同一 `state` 返回同一手（含 ALGO-2 首出不变量：`lastHand=null` 的非空手不得 `null/pass`）。
5. **合法着法等价**：`generateLegalPlays` 对同一 `(hand, level, lastHand)` 产出同一组 `handSignature`。
6. **门禁数字不变**：`searchTriggered` P95≤**500ms**、P99≤**750ms**、触发≥100、覆盖≥99%、可判定超时回退&lt;0.5%。不得用总体 P95 稀释。
7. **产品默认不变**：expert 默认；STRAT-3/4 false；`downloadedReplayGuards` / `downloadedEndgameGuards` 不进 expert；`ismcts-v3` 不进产品选择器。
8. **v2 冻结**：不得顺手改 `ismcts-v2` / PIMC 路径；若微优化落在共享函数，必须对 v2 同样金标等价。

## 4. 明确禁止

- 减搜索触发、减节点/迭代/ply/分支/树深/候选数。
- 启发式提前截断 rollout（改 utility 分布）。
- 放宽 500/750ms，或把总体 P95 写成搜索门。
- rollout 套用 STRAT-3（P2-b 已评估不做：破坏 v2 基线、热路径开销、先验二次计入）。
- 打开 STRAT-3/4；把守卫写入 expert；把 v3 送进选择器。
- 把 locate / 128 局诊断 / 本计划写成 `promoted` 或 `releaseEvidenceReady=true`。
- 新正式种子、DMC、`trainingEligible=true`。
- 更粗的截止时间轮询（每 N ply 才读钟）——会改变近超时 utility，除非有专门的超时等价夹具；默认视为禁止。

## 5. 第一刀（已落地）

**范围：** 同一 ply 内 `selectOpenLoopActions` 把已生成的合法着法交给 `chooseRolloutPlay`，不再生成第二次。不改选着、不改预算。显式 `reuseGeneratedPlays: false` 可恢复双次生成做 A/B。金标：visits / applied / reason / 内节点 actionKeys 与关闭时一致。

已追加：`generateLegalPlays` 单张 `physicalKey` 免 sort、单张 `cards` 免 slice；多张仍 sort+slice。签名序金标在 `js/rules.test.js`。

未做（仍禁止当本包范围）：

1. 改 `chooseRolloutPlay` finishing 检查顺序。
2. 减节点/迭代或放宽 500/750ms。
3. sampleWorld 第二刀。

**验收（授权后的 OPT 包，不是本包）：**

```powershell
node js/ai.hybrid.test.js
node js/ai.test.js
node js/rules.test.js
node tools/test_ai_local_baseline.mjs
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tools\verify.ps1
```

另用固定公开观察：locate 开关对照已有；再加「微优化开/关」visits/applied 对照。诊断复测若跑，只用已用过的 `20269003` 起非保留种子，且只报 `searchTriggered` 子集；不得当正式门。

## 6. 第二刀（仍不授权）

若第一刀后 locate 仍显示 rollout ≥0.5 且内部确认瓶颈在规则生成器而非 `applySimulationAction`：再考虑 `sampleWorld`（0.25）的同种子同手牌加速。不得减少 `sampleCount`。

若第一刀假设错误：先做 **003-LOCATE-2**（仍默认关）：在 `rolloutFromSimulationState` 内对 `chooseRolloutPlay` / `applySimulationAction` / deadline 分段计时，不改搜索。那是诊断包，不是 OPT。

## 7. 本包交付与未交付

**本包交付：** 本计划、机读门禁、门禁测试、活文档注明「计划已写、优化仍阻断」。

**本包不交付：** 任何搜索代码、预算、触发条件、500/750ms、expert 默认、PERF-3、正式评测。

下一审查包：`AI-LOCAL-003-OPT-R`（Antigravity 只读）。
第二刀（sampleWorld / generateLegalPlays 分配）未授权。PERF-3 仍锁。不得把本刀写成搜索门通过。
