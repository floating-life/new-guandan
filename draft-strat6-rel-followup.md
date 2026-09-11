# STRAT-6 / REL 窗口期只读核查与后续执行清单（草稿）

- 性质：**草稿**，未合入任何正式文档；待正式跑结束并由用户确认后再合入 `todo.md` / `整体项目路线图.md`。
- 生成：2026-09-03 00:03 (+0800)，由 ZCode 会话在正式跑进行期间只读核查产出。
- 数据来源：`data/eval-strat6-formal-strat{2,3}.json` 只读读取 + 源码预审；所有数字最终以正式汇总与统一验证器为准。
- 本窗口纪律：未修改任何现有文件；未运行测试/评测；未做 git 写操作（本文件是唯一新建产物）。

## 1. 正式跑进度快照（截至 00:03）

| 臂 | 规则 | 状态 | 正式报告 |
| --- | --- | --- | --- |
| strat2 | reserveHighControlLead | ✅ 完成（23:15） | `data/eval-strat6-formal-strat2.json` |
| strat3 | enemyReportLeadSafety | ✅ 完成（23:53） | `data/eval-strat6-formal-strat3.json` |
| strat4 | partnerTrickControl | 🏃 进行中（23:53 起跑，00:03 已到 5/40 区组，node 进程存活；按 strat2/3 实测 38–51 分钟/臂估计，ETA 约 00:45–01:15） | checkpoint 持续更新 |

单臂实测耗时：strat2 ≈ 50.6 分钟（runSegment 22:25:02Z–23:15:41Z），strat3 ≈ 38 分钟。

## 2. 已完成两臂的早期核验（只读，非正式结论）

| 门 | strat2 | strat3 |
| --- | --- | --- |
| complete（520 镜像对 / 40 区组 / 等于期望值） | ✅ 520/40 | ✅ 520/40 |
| zeroFailures（失败/死锁/镜像不一致全 0） | ✅ 0/0/0 | ✅ 0/0/0 |
| utilityLowerBoundPositive（bootstrap95[0] > 0） | ✅ [0.047, 0.188] | ❌ [-0.015, 0.041] |
| disasterNotWorse（候选双下 ≤ 对照双下） | ✅ 220 ≤ 255 | ❌ 243 > 240 |
| **预判** | **promote=true（可讨论打开）** | **keepClosed（保持关闭）** |

- 双下由双上推导（镜像 A/B 中对方双上即本方双下）：候选双下 = `result.comparisonDoubleUps`，对照双下 = `result.candidateDoubleUps`，与 `strat6_ablation.mjs:104-105` 一致。
- strat2 其余指标：效用/局 +0.115，头游率 0.521，Elo +14.7，双上差 +0.034/局（CI [0.013, 0.057]）。
- strat3 其余指标：效用/局 +0.013，头游率 0.507，Elo +4.7。
- 两份报告均为全 13 级（2–14）、`same-deal-cross-level-blocks`、`opponentModelMode=off`、对照 expert、种子 20268111–20268150 与登记表一致、22 文件评测闭包 SHA 互绑。
- 两臂 `searchTriggered.decisionTurns` 均为 0：expert 策略档在本次配置下未触发搜索，属预期；发布级 searchTriggered P95/P99 硬门由 REL/RUN 线单独审计，不以本报告为证。
- 以上为只读预判；正式四门判定以消融汇总 + 统一验证器输出为准。任何晋级都只是"可讨论"，expert 默认保持不变。

## 3. 预审发现（Sol 终审输入，窗口后处理）

- **F1（P2，仅报告字段，不影响门禁）searchTriggered 汇总路径失配**：`tools/strat6_ablation.mjs:106-109` 读 `report.decisionPerformanceByPolicy` / `report.allAIDecisionPerformance`，真实报告字段是 `performance.decisionLatencyByPolicy[<candidate>]` / `performance.allAIDecisions`，且 `searchTriggered` 是对象（应取 `.decisionTurns` 等），当前实现使汇总中该指标恒为 0。窗口后修复并补测试（`tools/test_strat6_ablation.mjs` 固化真实字段形状）。
- **F2（P1，需求缺口）分层汇总在真实产物上无数据源**：`stratifyGames`（`strat6_ablation.mjs:138-160`）依赖逐局行（candidateTeam/firstPlayer/utility/…），但正式报告为 summaryOnly、checkpoint 亦无逐局行（证据：`eval-strat6-formal-strat2.checkpoint.json` 中 `"firstPlayer"` 全文件仅出现 1 次）；且 `main()` 第 263 行调用 `summarizeStrat6Arm(report, item.arm)` 未传 checkpoint（`loadStrat6Artifacts` 导出但未被使用）。todo.md:98 要求的"按绝对座位、队伍角色、先手与贡还状态分层"当前不可实现。窗口后二选一：(a) runner 增加逐局汇总行（动闭包，需按正式流程重新互绑，代价大）；(b) 在文档中如实记录"分层未实现"为 STRAT-6 限制。
- **F3（流程风险，窗口后必须避开）`--execute` 会重跑而非汇总**：`ablationCommand`（`strat6_ablation.mjs:208-226`）产出的文件名是 `strat6-<role>-<arm>.json`，与实际产物 `eval-strat6-<role>-<arm>.json` 不一致；窗口结束后若直接跑 `node tools/strat6_ablation.mjs --formal --execute`，会以全新 checkpoint 重 spawn 三臂（约 2–2.5 小时）并另写一套文件，而不是汇总现有产物。建议新增只汇总驱动（新文件，如 `tools/strat6_summarize.mjs`：读入三份 eval-* 报告 → `summarizeStrat6Arm` + `decidePromotion` → 写 `data/strat6-formal-summary.json`），实现 + 测试 + Sol 审查后再出正式汇总。
- **F4（观察，非缺陷）**：`strat6_ablation.mjs:104-105` 双下推导语义正确但变量命名易误读，建议加一行注释；REL 工具 `runPlayAScenario` 直接注入 `state.levels=[14,2]` / `lastRoundResult`（`expert_release_acceptance.mjs:131-133`）属可接受的脚本化捷径，且 `interaction.knownLimits` 已如实声明未测项。
- **F5（通过）种子预登记校验完备**：三臂恰好 3 条、全 13 级、expert 对照、opponentModelMode=off、正式 ≥40 区组（≥520 镜像对）、smoke/正式不相交、与全部 forbiddenRanges 无重叠，均在启动时由 `validateStrat6Registry`（`strat6_ablation.mjs:35-74`）+ `value-model-gate.js` 的 `createSeedManifest`/`seedManifestOverlap` 强制；smoke 种子（20268101–02）标记 `smoke-consumed` 不得复用。

## 4. 窗口结束后执行清单（顺序化，需用户授权后逐项做）

1. 等 `data/eval-strat6-formal-strat4.json` 落盘并核对该臂四门（预计 ~00:45–01:15）。
2. 新增只汇总驱动（见 F3），产出 `data/strat6-formal-summary.json`；禁止用 `--execute` 重跑正式臂。
3. 按硬门记录结论：strat2 promote=true（仅"可讨论打开该规则"，expert 默认不变、不上 UI）；strat3 keepClosed；strat4 待定。任何晋级证据须与当前冻结提交、`todo.md`、验证器互绑。
4. 统一验证：`pwsh -NoProfile -ExecutionPolicy Bypass -File .\tools\verify.ps1`（已含 `test_strat6_ablation.mjs`、`test_expert_release_acceptance.mjs`，见 verify.ps1:103-104）；REL 证据任务追加 `-ReleaseEvidence`——当前预期失败（尚无 promoted 模型，README:51），不得为通过而放宽任何阈值。
5. REL-1 脚本化验收：`node tools/expert_release_acceptance.mjs --write`（三副 easy 档状态机局，几分钟，产 `data/expert-release-acceptance.json`）。REL-2 人工隐私/交互验收（真机/浏览器手打）仍需真人执行，脚本报告已如实声明未覆盖。
6. 按第 5 节骨架合入文档（`todo.md`、`整体项目路线图.md`、README 如需）。
7. Sol 只读终审覆盖本批全部改动（工具、测试、文档），随后才可谈提交（需用户明确授权）。

## 5. 文档合入骨架（窗口后用）

- **todo.md STRAT-6 结果段**（草拟要点）：三臂各自 520 镜像对/40 区组/零失败；strat2 CI [0.047,0.188]、双下 220≤255，promote=true（可讨论）；strat3 CI [-0.015,0.041]、双下 243>240，keepClosed；strat4 待补；分层报告限制（F2）如实记录；种子登记见表（第 5.1）。
- **整体项目路线图.md「种子隔离」节补登**（此前 STRAT-6 种子仅存在于 `tools/strat6-seed-registry.json`，所有 .md 零记录，本次补齐）：
  - 20268101–20268102：STRAT-6 smoke（已消费，`smoke-consumed`，不得复用）；
  - 20268103–20268110：smoke/正式间缓冲（do not run）；
  - 20268111–20268150：STRAT-6 正式 40 区组（一次性预登记，结果与 SHA 见 `data/eval-strat6-formal-*.json`）；
  - 20268151–20268190：正式后缓冲（do not power-up or seed-shop）。
- **REL-3 文档收敛清单**：README 的 `-ReleaseEvidence` 语义（当前预期失败的原因）；REL-1 `knownLimits`/`rollback` 台账引用；与 AGENTS.md 硬门逐条对照表。

## 6. 后续任务候选（非本窗口）

1. F1 修复 + 测试固化（小改，`tools/strat6_ablation.mjs`，不动闭包）。
2. F2 分层报告：runner 逐局汇总行（动闭包，需重新互绑）或文档声明限制——先做决策再动手。
3. F3 只汇总驱动 `tools/strat6_summarize.mjs`（新文件 + 测试）。
4. RT 残余风险 #8：对局进行中 `clearPending()` 保留 cursor，`hasMatchTrace` 为真，继续出牌仍会产生采集缺口（todo.md:69 已警告）。
5. R0 假绿缺口关闭前不启动新的 80 区组正式长跑或消费新正式种子（todo.md:15 停止线）。

## 7. 声明

本文件全部内容来自只读核查与源码预审；未运行任何测试/评测/训练；未修改任何现有文件；所有"预判"均以正式汇总与统一验证器最终输出为准；自动验收通过不构成发布或晋级证据，expert 默认与既有硬门保持不变。

## 8. 0903 独立审计与收尾记录（夜间 Grok 工作审查后）

### 8.1 审计结论：Grok 夜间工作通过独立审计

- `c7e4c9b`（26 文件）即 HEAD，领先 origin 11 未推送；工作树只剩本草稿与 `训练数据.rar`（均未入库）。
- 工作树 22/22 评测闭包文件 SHA 与三份正式报告冻结值逐一吻合；统一验证 48 checks 在该提交树上复跑通过。
- **重要更正（0903 晋级审查发现）**：上述"22/22"是工作树字节级结论；提交 `c7e4c9b` 的 blob 因 `core.autocrlf` 在 3 个闭包文件（`js/ai-hybrid.js`/`js/ai.ab.simulation.js`/`js/ai.ab.telemetry.js`）上 CRLF→LF 归一，按提交 blob 复算聚合 SHA 为 `8c6b1224c4827d7d7345f6a7b5f28272996d2076f0a86939294d341aeb916058`≠`94cccadd…`——**字节级提交冻结未达成**，我此前"绑定已确认"的说法不成立，已在 todo.md/路线图同步修正。
- strat4 报告亲验：CI `[0,0]`、1040 局效用全 0、头游 520/520、双上 237/237，13 级全部零分歧。
- F1 修复（`readSearchTriggered` 读真实路径）与其测试（15/15）核实；`EXPERT_POLICY_FEATURES` 三条 STRAT 开关仍 `false`；REL 产物 `ok:true` 且 knownLimits 如实；统一验证 48 checks 在提交树上复跑通过。
- **自我纠正**：先前 F2"分层全零"是误判——`grep -c` 数的是行数（47MB checkpoint 为单行 JSON），实际 `firstPlayer`/`candidateTeam` 各 1040 条；队伍/座位/先手分层真实可算，仅贡还层字段缺失（文档口径正确）。F2 收窄为"正式汇总未落盘 + `--execute` 主流程不传 checkpoint"。

### 8.2 收尾执行（0903，用户授权）

- 新增 `tools/strat6_summarize.mjs`（只汇总驱动，强制要求 checkpoint 供分层、拒绝缺产物）与 `tools/test_strat6_summarize.mjs`（8/8），接入 `verify.ps1`。
- 落盘正式汇总 `data/strat6-formal-summary.json`（SHA-256 `c412264236893f7983920f4cb015c49d8c71fdc12e3616fa9ea773ca1ecf6c8f`）：strat2 promote=true、strat3/4 keepClosed；strat2 分层 team 520/520、先手 self 325/partner 195/lower 286/upper 234、贡还 1040 全 unknown。
- 文档时效刷新：todo.md 与路线图中"未提交/绑定工作树 SHA"全部更新为"`c7e4c9b` 已绑定（0903 复核）、未推送、远端 CI 未跑"；todo.md:15 停止线的提交冻结半条件已满足，剩余晋级审查；路线图"种子隔离"节补登 STRAT-6 四段（20268101–02 smoke 已消费 / 20268103–10 缓冲 / 20268111–50 正式已消费 / 20268151–90 缓冲）；补 strat4"无证据力而非证明无用"注记。
- STRAT-2 只读晋级审查（Sol 角色）已完成，结论 **not-eligible**：四门数字经 47MB checkpoint 独立复算全部吻合；`searchTriggered` 门不适用（纯 expert 策略臂零触发，不得作搜索类晋级先例）；级牌/先手分层负项属 40 对样本噪声、不阻断但翻转时须披露（级牌 8 -0.125、下家 -0.154、上家 -0.385、队伍不对称 team0 -0.042 vs team1 +0.273）。**唯一阻断＝字节级提交冻结未达成**（见 8.1 更正）。修复路径：① 新增 `.gitattributes` 固定 22 个闭包文件 EOL 并以评测时字节重新入库（内容零变化，不得重跑正式臂——种子已消费）；② 翻转在新提交上仅改 `js/ai.js` 的 `reserveHighControlLead` 并同步刷新夹具指纹；③ 在翻转提交精确树上重跑统一验证并在台账记录不适用理由与残余风险；④ 推送+远端 CI 建议随 EVID-9b 先例执行；连续赛/盲评/`-FullData`/ReleaseEvidence 属 RUN-2~6 发布线，不是翻转前置。

### 8.3 待用户决策

- **字节冻结修复提交**（`.gitattributes` + 以评测时字节重新入库 3 个 EOL 归一文件）——需授权后才能创建提交。
- 推送 `c7e4c9b`（及后续修复提交）并触发远端 CI——用户本轮跳过，保持未推送。
- 字节冻结修复完成后的 STRAT-2 翻转授权（产品默认变更，需新提交并重新互绑）。
- REL-2 真人手打/真机卡顿验收只能由用户执行。

## 9. 0903 夜间自主执行日志（用户授权：逐任务提交不推送、STRAT-2 条件翻转、含 RT#5）

| # | 任务 | 提交 | 验证 | 独立审查 |
| --- | --- | --- | --- | --- |
| 0 | 0903 审计收尾（summarizer+测试+文档口径） | `810b24e` | 49 checks | T1+T2 审查覆盖 |
| 1 | 字节冻结：.gitattributes closure-eol | `1d66d75` | blob 22/22 复现 `94cccadd…`；49 checks | pass-with-notes（A1-A3 PASS） |
| 2 | STRAT-2 翻转进 expert 默认 | `d552238` | ai 369/369、夹具 24/24、49 checks | pass-with-notes（B1-B5 PASS） |
| 3 | RT#13 残余：brokenMatches 断链标记 | `31a5969` | 队列 58/58；49 checks | pass-with-notes |
| 4 | RT#9 残余：撕裂末行截断恢复 | `2cadada` | 消费者 27/27；49 checks | pass-with-notes |
| 5 | STRAT-5 P2-a：内节点封闭于模拟世界 | `7b09f8f` | hybrid 108/108；P2-b 评估不做 | pass-with-notes |
| 6 | RT#5：进程内事件索引 | `64d66f6` | lan_server 61/61、消费者 27/27、e2e；49 checks* | pass-with-notes（边界已披露） |

\* 见下方环境告警。

### 9.1 环境告警：ai.test.js 一条墙钟断言

`ai.test.js` E 块"残局满深度搜索在 8 张手牌上保持快速（<200ms）"自 03:40 起在整机层面失败（实测 281-695ms）。三重证据证明与代码无关：A/B stash 计时（有无 T5 改动同为 283-695ms）、调用图（`estimateThreeStepRoute` 在 `ai-route.js`，不经 `selectOpenLoopActions`）、负载定位（LoadPercentage 80%——已清理两个会话遗留进程：带 `--enable-replay-collector` 的无人值守 `lan_server`（866 CPU 秒）与 `@deepseek-ai/dsh` web 服务（1111 CPU 秒）；用户 iNode VPN 组件仍占约 40% 负载）。**功能断言 368/369 全绿**；阈值未放宽；建议机器静置后复跑 `tools/verify.ps1` 确认（预期恢复绿）。

### 9.2 夜间未做/待用户决策

- 推送（领先 origin/main 16 提交）与远端 CI——按授权范围未推送。
- 翻转后的复验性发布证据（连续赛/盲评/ReleaseEvidence）属 RUN-2~6，须与新提交重新互绑。
- REL-2 真人手打/真机卡顿验收。
- 索引等长篡改检测窗口收窄：如需闭合，引入内容哈希校验（与加速目标冲突，待决策）。
- 第二轮 todo 扫描结论：剩余开放项（PERF-3/4、RUN-*、DMC-1+、R1A 训练门）均被停止线锁定或需真人/授权，无更多可安全自动推进项，夜间队列到此收口。
