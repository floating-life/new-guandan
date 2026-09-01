# 掼蛋训练大师：近期待办

> 更新：2026-09-01
> 规划总纲：[整体项目路线图.md](./整体项目路线图.md)；历史证据：[PROJECT_EXECUTION_PLAN.md](./PROJECT_EXECUTION_PLAN.md)。
> 当前结论：**expert 保持默认；没有 `promoted` 模型；最新 v3 正常臂收益 CI 为正但性能门失败；浏览器原始导出、WPSDrive 同步历史与回收站均已按安全流程处置，待冻结提交与远端 CI。**

## 当前停止线

- [x] 不在 `20265401–20265480` 上继续 `ismcts-v3-fxe`；该正常臂整体 search-triggered P95/P99 为 `619/1022ms`，已违反固定 `500/750ms` 门。
- [x] 不用前 60 区组、10 区组探针或总体正 CI 绕过完整性能失败。
- [x] expert 继续作为网页默认；`ismcts-v3` 仅保留为离线候选。
- [x] 暂不启动正式 DMC/DanZero 训练，不把 `trainingEligible=false` 的外部轨迹并入训练。
- [ ] R0 证据假绿缺口关闭前，不启动新的 80 区组正式长跑或消费新的正式种子。
- [x] SEC-1～3 已完成：不在聊天、日志或文档中展示抽取到的令牌值；EVID-9b 仅提交已验证候选快照。

## P0-A：浏览器导出安全处置与产品诚实性

- [x] **SEC-1：撤销/轮换可能受影响的第三方控制台会话。** 用户已确认对应第三方平台的相关会话或令牌已撤销/轮换；本任务未尝试恢复、输出或记录令牌值。
- [x] **SEC-2：处置本地与同步副本。** 已删除工作区 `tools/extracted/` 的 6 个原始导出文件（含原始批次、回放、设置、统计与分析产物），并复核目录不存在；`.gitignore` 已覆盖 `/tools/extracted/`。用户已确认 WPSDrive 同步历史版本和回收站也已按策略清除；不保留原始导出副本。
- [x] **SEC-3：最小化浏览器抽取器。** `read_browser_replays.py` 现要求显式 `--profile-dir`、`--origin` 与输出目录，只接受 `http://localhost` / `http://127.0.0.1` 的精确 origin 加固定 `guandan_replays_v1` 键；LevelDB log 只解析 put 项，不再因批次含 `guandan` 而写出原始 batch。输出日志只含数量和 SHA-256。合成 write-batch 回归证明第三方 origin、相邻键和值不会进入文件；测试未读取原始导出。
- [x] **UI-0：移除虚假的 DMC 选择项。** 已从 `index.html`、设置白名单、提示与复盘标签移除 `dmc-v1`；遗留设置经 `normalizeLocalAiEngine` 迁移为 expert，并由 stats/UI 回归证明不会以 DMC 标签伪装 expert 执行。

## P0-B：证据门加固（SEC/UI/VERIFY 关闭后进入 EVID-9b；需要冻结提交与远端 CI 授权）

- [x] **EVID-1：修正 ReleaseEvidence 退出语义。** `validate_release_evidence.mjs` 现在只有在 `promotion.promoted=true` 时才允许 `releaseEvidenceReady=true` 和退出 0；已覆盖模型哈希一致但 CI 下界≤0 的拒绝负例、主 A/B 绑定旧文件哈希的合成拒绝负例，以及完整正例。当前真实命令仍因旧主报告哈希不匹配返回 1，符合停止线。
- [x] **EVID-2：修正遥测覆盖率分母。** `collectDecisionTelemetry` 现在对每个 AI 决策生成记录；缺少 `variant` 或 `localDecision` 时保留 `latencyMs=null` 并计入未测量。搜索/回退采用显式 `searchAttempted / searchTriggered / fallbackKind`；普通 expert 回合也明确记录“未搜索/无回退”，本地超时和决策错误保留真实 fallback 类型。`tools/test_ai_ab_simulation.mjs` 的生产者负例证明漏记仍须入账：搜索子集即使 100% 覆盖，缺一座策略/本地耗时也会拉低测量覆盖率，缺搜索或回退字段则令 `integrityComplete=false`；性能门从原始计数重算覆盖率并拒绝矛盾回执。
- [x] **EVID-3：绑定完整评测依赖闭包。** `guandan-evaluation-implementation-v2` 已绑定 runner、`game.js` 及其 Worker、评价、存储和 LLM 路径共 20 个源码文件（含环境遥测模块）；测试独立复算静态/动态/副作用 import 与 Worker URL 闭包，并逐一变异此前遗漏的间接依赖，确认 implementation SHA 改变且旧 checkpoint `--resume` 被拒绝。
- [x] **EVID-4：checkpoint 原子与可恢复。** `guandan-ai-ab-checkpoint-v3` 现要求 `checkpointIntegrity.sha256`；按同目录唯一临时文件写入 → `fsync` → 重读全量校验 → 不删除目标的原子替换，并保留 `.last-valid`。resume 严格校验 `complete/nextBlockIndex`、配置签名、精确 seed×level×team 覆盖、pair↔game 及 failure 派生一致；主坏仅可从同配置有效备份恢复，主备均坏拒绝。已回归截断/残留临时文件、可解析篡改、重复或错配对象、数组重排和 Windows `FileShare.None` 写锁；不保证同一路径多 writer 互斥，也不把 SHA-256 视为带密钥认证。
- [x] **EVID-5：加固性能回执 provenance（本地代码门已关闭）。** `guandan-ai-ab-report-v1` / `guandan-ai-ab-checkpoint-v3` 绑定 `evaluationId`、机器/Node/V8、PID/PPID、fresh/resume 段链和输入 checkpoint 摘要；每局与镜像对象归属运行段，resume 只接受同机同 Node/V8。汇总器按本机字节复算完整依赖闭包、逐文件及聚合 SHA，并固定要求 80 区组、精确 `[2..14]`、`opponentModelMode=off` 与候选/当前 `searchMode` 一致。每个运行段的 `searchTriggered` 必须独立通过固定门，且 decision/measured/unmeasured/fallback-evaluable/timeout 五项与总体严格守恒；跨机器或运行时、旧报告/v2 checkpoint、伪造摘要、缺失/断裂运行段或不守恒均 fail closed。边界：这是本地可审计完整性，不是远程可信硬件证明；不能为历史 statefix 产物生成正式回执，也不改变 expert 默认。
- [x] **EVID-6：修正盲评灾难门（本地代码门已关闭）。** `summarize_blind_eval.mjs` 升级 `guandan-blind-eval-summary-v3`；严格校验 manifest 的非空唯一 `scenarioIds` 与 `selectedScenarios` 数量，按全部题目分别统计 expert/proposed 灾难数，并以同一 manifest 场景数为分母。灾难门直接比较未舍入原始计数；不完整复核时两率为 `null` 且 fail closed。新增“玩家选择 expert、未选 proposed 却为灾难”反例、翻转选择不改变双臂统计、缺复核、重复 ID 和数量不一致回归。
- [x] **EVID-7：收紧 fxe 契约（本地代码门已关闭）。** `analyze_force_expert_ablation.mjs` 只接受完整 `guandan-ai-ab-checkpoint-v3`：先校验签名载荷、内容 SHA-256、完整 provenance/运行段环境、精确 seed×level×team 覆盖、same-deal-cross-level、镜像 pair↔game 一致性与当前 resolver 生成的确定性 v3 搜索配置；正常/强制臂必须分别为 `ismcts-v3` / `ismcts-v3-fxe`、对照为 expert、显式 `evaluationOpponentModelMode=off`，并共享合法且相同的 `evaluationImplementationSha256`。逐对象要求 `changed` / `wouldChange` 可审计且一致，fxe `changed=0`；legacy v1/v2、缺字段、模式/配置/摘要不一致、重复或篡改对象均在 bootstrap 前非零拒绝且不写回执。回归：本轮 `node tools/test_analyze_force_expert_ablation.mjs` 与目标语法检查通过；统一 `verify.ps1` 的 31 项通过仅是 0831 历史记录。新增跨臂牌面指纹、先手和合法但不一致源码摘要拒绝路径。边界：仅关闭 fxe 回执的本地假绿路径，不构成强度/性能/发布证据，expert 默认与同批 fxe 停止线不变。
- [x] **EVID-8：建立 M2 统一发布验证器（本地代码门已关闭）。** `tools/validate_m2_release.mjs` 现在互绑正常臂报告/checkpoint/原始遥测、严格性能回执、当前源码连续赛和真人盲评的场景载荷/灾难复核；逐对象复算完整性、真实测量覆盖、源码/机器 provenance、CI 下界、连续赛和盲评 gate。盲评 allocation 的 `assignmentSha256/mappingSha256` 会按冻结场景顺序、`randomSeed` 和参与者分支确定性重建，答案 ledger 逐题核对 mapping 与 `side === mapping[choice]`；同步篡改 mapping、side、聚合和摘要绑定的负例仍返回非 0。`tools/test_validate_m2_release.mjs` 以完整合成正例和 20 余类缺失/篡改/矛盾/跨零 CI 负例回归，均要求非 0；`verify.ps1` 的 ReleaseEvidence 入口已显式传入 selected scenarios 与 catastrophic review。fxe 仍只作机制归因，不能替代正常臂门禁。**本地代码门通过不等于真实发布证据通过。**
- [x] **EVID-9a：形成无冲突、可验证的候选快照。** 逐侧核对后以无冲突的现行工作文件解决 `js/ai.ab.simulation.js`、`js/ai.hybrid.test.js`、`tools/analyze_force_expert_ablation.mjs`、`tools/test_ai_ab_simulation.mjs`、`tools/test_analyze_force_expert_ablation.mjs` 五个未合并索引路径，未用旧暂存版本覆盖实现；清除了 7 个 EOF 空白行，并将评测运行时模块、验证器和其回归文件纳入候选快照。`verify.ps1` 新增 staged diff 格式检查及 `git ls-files -u` 零结果门。`git ls-files -u`、工作区/staged `git diff --check` 均为零，完整统一验证 **36/36** 通过。边界：这只是本地可验证快照，不是冻结提交或远端 CI。
- [x] **VERIFY-1：恢复 `-FullData` 独立契约。** `verify.ps1` 将 FullData 与 ReleaseEvidence 的输入解析拆分：前者只保留历史完整性所需的 checkpoint，后者才要求连续赛报告及 M2 专属工件。`tools/test_verify_full_data_contract.mjs` 固定这一分支契约；以故意不存在的 `-ContinuousReport` 执行 `-FullData` 仍完整通过，证明不依赖本机恰有默认报告。
- [ ] **EVID-9b：代码门同一提交与远端 CI 闭环。** 仅在 SEC-1～3、UI-0 和 VERIFY-1 关闭后冻结精确提交，运行默认验证、`-FullData` 及自包含的 ReleaseEvidence/M2 正负例测试，推送并记录该提交的远端 CI。真实 ReleaseEvidence/M2 工件要到 RUN-2～6 后才可能形成，不作为 R0 代码门的循环前置；未获提交/推送授权且没有同一冻结提交前，不把 8 月 28 日旧 CI 当作 9 月代码证据，也不消费新的正式种子。

### 0901 本轮 EVID-8 / EVID-9a / DMC-0 证据记录

- 目标实现：`tools/validate_m2_release.mjs`、`tools/test_validate_m2_release.mjs`、`tools/summarize_ai_performance_baseline.mjs`、`tools/test_summarize_ai_performance_baseline.mjs`、`tools/test_environment_telemetry.mjs`、`tools/verify.ps1`、`js/game.js`；保留其他既有用户改动，不提交、不推送。
- 通过：5 个未合并索引路径均已清零，7 个 EOF 空白行已清除；`verify.ps1` 同时检查工作区与 staged diff，并显式拒绝 unmerged index。SEC-3、UI-0 与 VERIFY-1 后，默认统一验证为 **38/38**、`-FullData` 为 **44/44** 通过（后者以不存在的连续赛报告路径复验；含 JS/MJS、`tools/` 与 `training/` Python 语法、严格自对弈/模型/历史 A-B/外部隔离检查），性能 provenance、M2 正负例、环境遥测和 Windows 目录别名冲突回归均通过。
- 独立复算：直接读取 43,653,388 字节 legacy v2 checkpoint，确认 2,080 局 / 1,040 镜像组 / 80 区组、无重复/缺失/失败，效用 `+0.028/局`、区组 bootstrap 95% CI `[+0.005,+0.051]`；6,677 个搜索代理回合 P95/P99 `619/1022ms`，1–60 为 `421.8/550ms`，61–80 为 `942/1481ms`。报告/checkpoint SHA-256 分别为 `3b4ebd543d56af0d9c860eef1c07d5fc294b3817a7da006612f3b0e04161762a` / `1a8ed1de8a4a67d6b474bd0bbf1a16f38cebcbff2f1294edd12c91aa26f9a887`。
- 未通过/未完成：真实 M2 所需 checkpoint、raw telemetry、正式性能回执和盲评工件均不存在；严格旧价值模型发布校验按预期退出 1。没有同一冻结提交或远端 CI，expert 默认和现有性能停止线保持不变。
- 代码审计边界：EVID-1～9a、SEC-1～3、UI-0 和 VERIFY-1 的本地回归通过；当前可进入 EVID-9b 冻结提交与远端 CI。预算遥测语义缺口仍待 TEL-1；炸弹首出非法过牌未复现，不列为现存发布 bug。GC 仅能证明基本计数关系，不能把没有原始 GC duration 的汇总宣称为完整可复算。DMC-0 已关闭格式/畸形输入假绿路径，仍不构成 Python 独立规则环境或训练准入。

## P1：定位并修复搜索尾延迟

- [x] **PERF-1：固化分段复算器（历史诊断已完成，正式性能门仍阻断）。** 新增只读 `tools/analyze_statefix_performance.mjs` 与自包含 `tools/test_analyze_statefix_performance.mjs`；仅接受 legacy v2 checkpoint，按每 10 区组、1–60/61–80、座位、来源、级牌和 candidateTeam 重算，并将外部分段 sidecar 明确标为 `externally_declared/provenanceVerified=false`。报告与 checkpoint 的 search-triggered 总体计数、均值/P95/P99、最大值、回退、四项资源计数及 coverage 均逐项绑定；不得输出含义模糊的 `pass`，`formalGateEligible=false`。真实 statefix 复算得到总体 `6677`、P95/P99 `619/1022ms`，1–60 为 `5058`、`421.8/550ms`，61–80 为 `1619`、`942/1481ms`；run/resume provenance unavailable，因此仅作历史诊断，不能生成正式性能回执或晋级证据。
- [x] **PERF-2a：接通运行环境遥测与短 fresh→resume smoke。** `--environment-telemetry` 仅显式 opt-in；每段记录 RSS/heap、GC 暂停、checkpoint 构建+校验、序列化、写入/fsync、临时重读+校验、备份/rename及总耗时、进程与系统 CPU、频率、电源方案和外部负载。Windows `os.loadavg()` 的无效 0 值保持 unavailable，并以 `os.cpus()` 累计时序/频率作为明确标注的外部负载代理；sidecar 与 checkpoint、`.last-valid`、report、raw telemetry 路径冲突时启动前拒绝。artifact 状态、peaks、系统 CPU/外部负载摘要和 checkpoint 序号由内容复算，sidecar 损坏/缺段只降级 unavailable，不阻断核心 checkpoint resume。`tools/test_environment_telemetry.mjs` 已覆盖完整性负例、路径保护、短 fresh→中断→resume、损坏/缺段 sidecar 和唯一递增 checkpoint 计时。
- [ ] **PERF-2b：真实大 checkpoint 诊断。** 仍待在 R0 假绿缺口关闭且获授权后，对比从零运行与加载大 checkpoint 后 resume，按运行段审计大对象恢复/GC、云盘 I/O、系统负载和热/电源状态；短 smoke 不能替代正式性能门证据，也不能据此归因于算法。
- [ ] **PERF-3：只做有证据的优化。** 若根因是 checkpoint 体积或 GC，改为分块/流式保存并保持可复算；若根因在搜索，先用 profile 锁定热点再优化。不得通过放宽阈值或静默减少搜索覆盖过门。
- [x] **ALGO-1：修正失败 sweep 的深层事务语义。** v3 每个 sweep 在完整候选集合完成前暂存整棵开放环树；中断或后置候选 rollout 失败时恢复 depth、节点、availability、visits、reward、outcomes、failures 和终端/截断计数。`includeTreeDigest` 下的回归先形成成功深树，再注入后置候选失败并继续下一成功 sweep，逐字段证明 snapshot/mutated/restored 一致；普通决策不启用测试 hook 或树序列化。
- [ ] **ALGO-2：固定 rollout 首出不变量。** 外评所称“9+ 张且首出只剩炸弹”在当前规则中不可达：任意非空首出手牌都会生成单张；代表性 9 张牌探针得到 14 个非炸弹与 3 个炸弹类着法。仍应补自动回归，要求 `lastHand=null` 时 `chooseRolloutPlay` 不得返回 pass/null；若未来生成器异常则回退最便宜合法着法并显式记诊断，不把整次 sweep 静默丢弃。
- [ ] **ALGO-3：量化炸弹分支覆盖。** 当前 `branchLimit=5`、专家动作/pass 先占槽且炸弹成本 +32，确会让非专家炸弹分支靠后；先建立含紧急阻断、收官、无目的领炸的牌面集，比较“预留一个最小炸弹槽”对合法动作覆盖、灾难率、节点数和 P95/P99 的影响。未通过收益与性能证据前不直接改排序。
- [ ] **TEL-1：澄清 v3 预算遥测。** 输入 `iterationBudget` 保持 rollout 总预算；输出新增/改名为 `rolloutBudget`、`sweepBudget` 与实际 `pairedSweeps`，不得把 `floor(rolloutBudget/candidateCount)` 继续标成同名 `iterationBudget`。补 2～6 个候选的兼容与跨引擎回归，并同步 checkpoint/report schema。
- [ ] **PERF-4：全新诊断种子性能探针。** R0 和 PERF-1～3 完成后，预登记仅供诊断的新种子，跑 10 区组 × 全 13 级 × 双腿；要求整体及每个足量运行段均满足 ≥100 触发、覆盖≥99%、P95≤500ms、P99≤750ms、回退<0.5%。收益与 CI 只记录，不作强度主张。

## P2：重新进入 v3 正式跑道

- [ ] **RUN-1：预登记正式正常臂。** 只有 PERF-4 通过后，冻结代码、完整依赖摘要、1800 节点或经批准的新预算、运行环境、checkpoint v3、全新未见种子和所有验收规则；不得边跑边改。
- [ ] **RUN-2：执行 80 区组正常臂。** 必须完成 2,080 局 / 1,040 镜像组，零失败/死锁/镜像不一致，同时通过完整性、真实覆盖率、整体及分段性能和区组 bootstrap CI 下界>0。任一失败即停止。
- [ ] **RUN-3：条件式 fxe。** 仅 RUN-2 全部门通过后，按预登记在同批区组运行 fxe；逐镜像组 expert 等价且逐对局 `changed == wouldChange` 后才允许因果分析。
- [ ] **RUN-4：当前源码连续赛。** 使用与主 A/B、训练和盲评不重叠的预登记种子，完成 8/8 场、4/4 镜像组、贡还和 ≥120 动作长局覆盖，且零失败/死锁/镜像不一致；必须与主报告源码和配置互绑。
- [ ] **RUN-5：严格真人盲评。** 使用修复后的 summary v3 工具（题目/作答仍为 v2），至少 10 人 × 10 题、100% 完成、无重复分配、参与者聚类 bootstrap 下界>0.5，并通过全题灾难性复核。
- [ ] **RUN-6：统一发布验收。** M2 发布验证器、默认验证、`-FullData`、远端 CI、浏览器人工性能与版本回滚记录必须绑定同一提交；全部通过后才讨论把 v3 暴露到 UI。

## P3：可并行的专家版封版

- [ ] **REL-1：三副人工验收。** 覆盖普通升级、贡还、打 A / 不过 A；保存版本和结果。
- [ ] **REL-2：隐私与交互验收。** 核对本地/云端数据边界，记录笔记本与手机 UI 卡顿、已知限制和回滚步骤。
- [ ] **REL-3：文档与复盘标签收敛。** README 只保留当前摘要并链接总纲；修正对手画像迁移版本和 v3 仅离线评测的边界；复盘将 `ismcts-v3` 正确显示为 ISMCTS v3/成对 sweep，但不把它加入产品选择器；把 `ai.js` 的 Probe 历史移入证据台账，并把 `ai-hybrid.js` 的“三个模式”改为“四个”。

## P4：后续路线（当前不启动长训）

- [x] **DMC-0：加固 guandan-env / preflight 硬门。** `_is_finite_number` 现拒绝 `NaN`、`Infinity` 和布尔值；手牌按每座 `0..108`、总数 `≤108`、严格整数校验，转换回执计数和 seed manifest 均要求范围、类型和唯一性，dataset/receipt 的 SHA-256 均要求 64 位小写十六进制。`dmc_preflight.py` 对非对象 JSON、坏摘要/seed/许可记录输出结构化非零结果，`verify_conformance.py` 不再因畸形 receipt 抛异常；统一验证也编译 `training/*.py`。`tools/test_guandan_env_contract.py` 覆盖上述负例及 CLI 畸形输入，完整统一验证 36/36 通过。边界：仍缺独立 Python 规则环境与 10 万条零差异，未获训练准入。
- [ ] **DMC-1：独立 Python 规则环境与 10 万条 JS↔Python 差分。** 转换、合法动作、状态推进和终局收益要求零差异。
- [ ] **DMC-2：外部数据准入。** 在 `trainingEligible=false` 下完成许可、再分发、商业使用、删除、acting-seat、规则版本和暗牌边界审计；未通过不得训练。
- [ ] **DMC-3：PyTorch DMC / ONNX / Worker 安全加载。** 仅在 R2 正向基线和 DMC-1 完成后启动；模型包绑定数据、种子、schema、环境和评测回执。
- [ ] **OPP-1：对手画像留出门。** 增加漂移检测、冷启动降权、个性化采样权重与独立长期留出；只允许公开行动特征，失败时回退 `observe/off`。

## 已核验但不再列为活跃任务

- availability-aware UCT 已改为 `log(availability + 1) / visits`；旧错误实现报告全部退出正式证据集。
- A/B 已显式设置 `opponentModelMode=off`，当前状态隔离 smoke 通过；旧两轮 fxe 因控制臂不等价均作废。
- statefix 10 区组探针性能通过；statefix 80 区组正常臂完整且正 CI，但因完整性能失败不得晋级。
- 默认验证在 0831 审核时为 31 项通过；0901 最新工作树统一入口 **38/38**、`-FullData` **44/44** 通过，`git ls-files -u` 与工作区/staged 差异检查均为零。SEC-1～3 均已完成；仍缺冻结提交和该提交的远端 CI。严格价值模型发布校验当前按预期返回 1，专家默认未改变。
