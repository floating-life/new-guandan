# 掼蛋训练大师：近期待办

> 更新：2026-09-01
> 规划总纲：[整体项目路线图.md](./整体项目路线图.md)；历史证据：[PROJECT_EXECUTION_PLAN.md](./PROJECT_EXECUTION_PLAN.md)。
> 当前结论：**expert 保持默认；没有 `promoted` 模型；最新 v3 正常臂收益 CI 为正但性能门失败；浏览器原始导出、WPSDrive 同步历史与回收站均已按安全流程处置。EVID-9b 冻结提交 `585f099` 的远端 Windows CI（run `33470270032`）已通过。实时复盘智能体桥仅部分满足。STRAT-1/3/4 已完成脱敏夹具、共享代码门和跨入口回归，但候选仍默认关闭，尚未完成镜像收益与灾难回归。ALGO-2 的 rollout 首出不变量与异常回退代码门已通过，仍不构成性能、强度或发布证据。**

## 当前停止线

- [x] 不在 `20265401–20265480` 上继续 `ismcts-v3-fxe`；该正常臂整体 search-triggered P95/P99 为 `619/1022ms`，已违反固定 `500/750ms` 门。
- [x] 不用前 60 区组、10 区组探针或总体正 CI 绕过完整性能失败。
- [x] expert 继续作为网页默认；`ismcts-v3` 仅保留为离线候选。
- [x] 暂不启动正式 DMC/DanZero 训练，不把 `trainingEligible=false` 的外部轨迹并入训练。
- [ ] R1A 完成前，不把 active-match 完整快照暴露给智能体，不把真人复盘或智能体意见直接并入训练；所有新增真人轨迹默认 `trainingEligible=false`。
- [ ] STRAT-1～6 完成前，0831 复盘派生规则和当前“满手保留 A/级牌三带二”工作区修复只算候选；不得无开关进入 expert 默认，也不得用单测全绿替代镜像收益与灾难回归。
- [ ] R0 证据假绿缺口关闭前，不启动新的 80 区组正式长跑或消费新的正式种子。
- [x] SEC-1～3 已完成：不在聊天、日志或文档中展示抽取到的令牌值；EVID-9b 仅提交已验证候选快照。

## P0-A：浏览器导出安全处置与产品诚实性

- [x] **SEC-1：撤销/轮换可能受影响的第三方控制台会话。** 用户已确认对应第三方平台的相关会话或令牌已撤销/轮换；本任务未尝试恢复、输出或记录令牌值。
- [x] **SEC-2：处置本地与同步副本。** 已删除工作区 `tools/extracted/` 的 6 个原始导出文件（含原始批次、回放、设置、统计与分析产物），并复核目录不存在；`.gitignore` 已覆盖 `/tools/extracted/`。用户已确认 WPSDrive 同步历史版本和回收站也已按策略清除；不保留原始导出副本。
- [x] **SEC-3：最小化浏览器抽取器。** `read_browser_replays.py` 现要求显式 `--profile-dir`、`--origin` 与输出目录，只接受 `http://localhost` / `http://127.0.0.1` 的精确 origin 加固定 `guandan_replays_v1` 键；LevelDB log 只解析 put 项，不再因批次含 `guandan` 而写出原始 batch。输出日志只含数量和 SHA-256。合成 write-batch 回归证明第三方 origin、相邻键和值不会进入文件；测试未读取原始导出。
- [x] **UI-0：移除虚假的 DMC 选择项。** 已从 `index.html`、设置白名单、提示与复盘标签移除 `dmc-v1`；遗留设置经 `normalizeLocalAiEngine` 迁移为 expert，并由 stats/UI 回归证明不会以 DMC 标签伪装 expert 执行。

## P0-B：证据门加固（EVID-9b 已闭环；真实发布证据仍未形成）

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
- [x] **EVID-9b：代码门同一提交与远端 CI 闭环。** SEC-1～3、UI-0 和 VERIFY-1 后的冻结提交 [`585f099`](https://github.com/floating-life/new-guandan/commit/585f0996c727abe77709a3b864f3d1f7ac3819e0) 已在独立脱离工作树完成默认统一验证 **38 checks**、`-FullData` **42 checks**，并单独通过 A/B checkpoint 原子写入/Windows 锁/恢复及环境遥测回归；其远端 Windows CI [run `33470270032`](https://github.com/floating-life/new-guandan/actions/runs/33470270032) 已通过。真实 ReleaseEvidence/M2 工件仍到 RUN-2～6 后才可能形成，不作为 R0 代码门循环前置，也不消费新的正式种子。

### 0901 本轮 EVID-8 / EVID-9a / EVID-9b / STRAT 证据记录

- 前序 EVID-8/9a/9b 已于冻结提交 `585f099` 完成；该提交在独立脱离工作树通过默认统一验证 **38 checks**、`-FullData` **42 checks**，并通过远端 Windows CI run `33470270032`。本轮只在当前工作树继续 STRAT 开发，未向 EVID-9b 冻结提交追加改动。
- 当前工作树 `verify.ps1` 同时检查工作区与 staged diff，并显式拒绝 unmerged index；本轮默认统一验证实际为 **39/39**，`-FullData` 实际为 **45/45**（后者只读引用既有本地数据工件）。性能 provenance、M2 正负例、环境遥测、Windows 目录别名冲突、checkpoint 原子锁/恢复和 STRAT 夹具回归均通过。
- 独立复算：直接读取 43,653,388 字节 legacy v2 checkpoint，确认 2,080 局 / 1,040 镜像组 / 80 区组、无重复/缺失/失败，效用 `+0.028/局`、区组 bootstrap 95% CI `[+0.005,+0.051]`；6,677 个搜索代理回合 P95/P99 `619/1022ms`，1–60 为 `421.8/550ms`，61–80 为 `942/1481ms`。报告/checkpoint SHA-256 分别为 `3b4ebd543d56af0d9c860eef1c07d5fc294b3817a7da006612f3b0e04161762a` / `1a8ed1de8a4a67d6b474bd0bbf1a16f38cebcbff2f1294edd12c91aa26f9a887`。
- 未通过/未完成：真实 M2 所需 checkpoint、raw telemetry、正式性能回执和盲评工件均不存在；严格旧价值模型发布校验按预期退出 1。STRAT-1～4 尚未冻结、未跑正式镜像赛，expert 默认和现有性能停止线保持不变。
- 代码审计边界：EVID-1～9b、SEC-1～3、UI-0、VERIFY-1、ALGO-2 和 STRAT-1/2/3/4 的本地回归通过；EVID-9b 冻结提交远端 CI 已完成。STRAT-1～4 仅形成可复算代码门，正式 expert 仍关闭候选；`node tools/test_strategy_counterexamples.mjs` 为 **24/24**，`node js/ai.test.js` 为 **363/363**，`node js/ai.hybrid.test.js` 为 **81/81**。预算遥测语义缺口仍待 TEL-1；ALGO-2 仅为首出保护和异常回退代码门，不构成性能/强度/晋级证据。GC 仅能证明基本计数关系，不能把没有原始 GC duration 的汇总宣称为完整可复算。DMC-0 已关闭格式/畸形输入假绿路径，仍不构成 Python 独立规则环境或训练准入。

## P1-A：实时复盘智能体桥与真人训练候选（新增，当前未满足）

- [ ] **RT-1：冻结三层数据契约。** 定义 `guandan-live-public-event-v1`、`guandan-sealed-training-turn-v1`、`guandan-agent-annotation-v1`；都绑定唯一 match/round/trick/turn、`eventId`、单调 `sequence`、时间、规则版本、实现 SHA 和前序事件摘要。公开事件只含已公开动作/牌张、余牌数、贡还、引擎与脱敏决策元数据；密封 turn 才含行动座位自己的手牌、当时公开 observation、完整合法候选和唯一 chosen；annotation 只引用事件 ID，不复制或修改源数据。
- [ ] **RT-2：在真实动作提交边界发事件。** 在 `applyPlay` / `applyPass` 成功后以及 `trick_end / round_end` 接入独立 `setReplayEventObserver`，不复用可能重复触发的 UI `setUpdateCallback`。浏览器先写有界本地待发队列，再异步提交；失败重试不得阻断牌局，相同 `eventId` 重发必须幂等，并能检测 sequence 缺口。覆盖真人、三个 AI、贡还、接风、双上提前结束和打 A 终局。
- [ ] **RT-3：实现 opt-in 本机采集与游标读取。** `lan_server.py` 增加 `POST /api/replay/events` 与 `GET /api/replay/events?afterSequence=...&limit=...`（可带短长轮询）；默认关闭，只绑定 `127.0.0.1`。浏览器写入受同源、schema、请求体和速率限制；智能体读取要求短期 capability token。事件以原子追加 NDJSON 写入 `LOCALAPPDATA/GuandanTrainer/replays/`，配置保留期/轮转/最大空间，禁止进入仓库或 WPSDrive；磁盘满时降级并在 UI 明示缺口。
- [ ] **RT-4：提供智能体只读消费与独立注释。** 新增 CLI（后续可包装为 MCP resource）按 cursor 持续读取、恢复和校验事件链，输出每手/每圈/每副复盘；分析结果写入独立 annotation 存储并记录模型、提示版本、时间和源事件摘要。禁止智能体修改源事件、当前牌局状态或直接把建议写成训练标签。
- [ ] **RT-5：副末生成密封训练候选。** 对每个行动 turn 保存“行动座位手牌 + 当时公开观察 + 全部合法候选 + 实际动作”，副末再连接真实名次/团队收益；不向实时读 API 暴露密封内容。转换器逐条重放规则、牌张守恒、座位轮转、牌型声明、候选归属和唯一 chosen，去重后按完整 match 切分 train/validation/held-out；未人工批准前固定 `trainingEligible=false`，不为未选择动作伪造反事实标签。
- [ ] **RT-6：端到端安全与完整性验收。** 合成测试覆盖暗牌字段注入、跨 origin、坏/过期 token、超大请求、重复/乱序/漏序、服务中断重试、磁盘满和保留期轮转；真实 HTTP 完成一副时，第二个本机消费者能从中途 cursor 无丢失恢复，公开流逐字段证明无暗牌，密封流副末可复算且训练器拒绝未批准批次。UI 提供启用、暂停、清空、保留期和“当前智能体连接/最后序号/是否缺口”状态。

### 当前能力边界（RT 基线）

- [x] 每手出牌/过牌已经写入内存 `trickLog`，含圈号、座位、公开牌张、余牌数、评价和决策元数据；副末复盘保存后，最近 100 副可从浏览器手工导出。
- [x] `tools/replay_ai_audit.mjs` 能对手工导出文件做事后、公开信息边界内的逐手反事实审计。
- [ ] 当前没有复盘 POST/GET、cursor/订阅、智能体 token 或 annotation 存储；副末 localStorage 不是实时接口。
- [ ] 进行中存档包含四家 `hands` 与 `roundInitialHands`，明确不得作为实时智能体数据源；现有导出也不是训练 schema。

## P1-B：复盘驱动的专家策略修复（新增，可与 R0/R1A 并行）

- [x] **STRAT-1：冻结可复算反例与证据边界。** 新增 `tools/strategy-counterexamples.json` 与 `tools/test_strategy_counterexamples.mjs`：只保存行动座位手牌、公开历史、合法候选和预期不变量，observation 顶层采用严格白名单，绑定 `guandan-rules-v1`、`js/ai.js`/`js/cards.js`/`js/evaluator.js`/`js/rules.js`/`js/strategy-core.js` 文件摘要及聚合 SHA；4 个 STRAT-4 机制夹具与换名暗牌负例验证 24/24。历史复盘原始导出已删除，旧命中数仍只作不可独立复算线索，不作为失误率。
- [x] **STRAT-2：收口当前满手保留大三张修复。** 新增独立 `policyFeatures.reserveHighControlLead` 与 `with-reserved-high-control-lead` 候选变体，正式 expert/baseline 默认关闭；AI、共享策略和教练统一按出牌后剩余张数 `>8` 判定，特殊惩罚只由共享策略源产生，移除 `ai.js` 对三带二的重复 `power×系数` 惩罚，并移除教练入口的重复事件。已覆盖 11/13/14 张边界、三带二主张/带对、逢人配多解声明、默认关闭、候选开启时的两手收官豁免和单次扣分；镜像收益/灾难门仍待 STRAT-6。
- [x] **STRAT-3：实现任一对手报单的安全领牌约束。** 新增默认关闭的 `enemyReportLeadSafety` 与 `with-enemy-report-lead-safety` 候选；共享 `strategy-core` 按所有未出完敌方座位识别报单，并仅在完整合法候选含不拆炸/逢人配/王的安全非单或 `public_lock_lead` 路线时过滤 J 及以下低单。无替代动作、整手收官或跟牌分支不触发，避免机械“永不出 ≤J”；AI、教练与本地混合候选池复用同一过滤器。领牌解释、云端咨询和旧式混合首选回退也经过同一安全门，不能把被过滤低单重新送入搜索。已覆盖上家/下家双报单、仅炸弹回退、默认关闭、唯一共享事件、紧凑顶层 `tags`、`{play,strategy}` 包装和跨入口回归；镜像收益/灾难门仍待 STRAT-6。
- [x] **STRAT-4：修正队友牌权的硬优先级。** `assessPartnerTrickControl` 先用公开历史确认对家仍是本圈赢家，再确认活跃对手均已过牌/出完；`partnerTrickControl` 候选开关默认关闭。AI、教练评价和混合咨询在进入 P3、紧急拦截或普通接牌前优先接风，并写入唯一 `tacticalConstraint`/共享标签；整手出完保留明确例外，`partnerFinished=true` 不再静默落入接对手。已补未行动对手、刚出完、无历史证据和整手收官回归；镜像收益/灾难门仍待 STRAT-6。
- [ ] **STRAT-5：把同一安全约束放在搜索候选入口。** expert、root PIMC、ISMCTS v2/v3 和云端增强共用同一 eligible-action/invariant 层；搜索不得重新引入被 STRAT-3/4 排除的送单或抢队友牌，也不在每个引擎复制一套易漂移规则。逐引擎回归证明合法回退、无候选时 fail closed、关闭 feature 后恢复对照行为。
- [ ] **STRAT-6：独立消融和座位分层晋级。** 每条规则单独开关、单独镜像臂、使用未见种子；先跑定向反例与短 smoke，再比较团队效用、头游/双上/双下、灾难率和 search-triggered 性能，未达门保持关闭。策略与未来网络继续采用座位/队伍规范化共享参数，不为下家/对家/上家复制三套规则；报告按绝对座位、队伍角色、先手与贡还状态分层，只有稳定偏科证据才新增角色特征。

### 当前 STRAT 审计基线

- [x] 当前工作区的满手修复与 STRAT-1/3/4 定向回归通过；本轮独立运行 `rules 69/69`、`ai 363/363`、`hybrid 81/81`、`game 70/70` 与盲评工具严格门均通过。
- [x] 已确认 `preferredTypesForEnemyCount(2)` 会软奖励领单，固定下家五张内规则不能覆盖上家报单；队友让牌前有一手出完、紧急拦截和 P3 护牌等提前返回，且 `partnerFinished=true` 会跳过队友分支。
- [x] 对家已头游后的保三游/争双上目标并非完全缺失：现有 `survival_preserve_control`、`placementControl` 和对应回归已覆盖部分场景；本轨只补优先级和复盘反例，不重写整套端局目标。
- [x] STRAT-2 代码门已完成：`strategy-core` 提供唯一剩余张数阈值，AI 与 `evaluator` 共用 `premature_high_control`，教练的 breakdown/tips 只记录一次；显式候选覆盖 11/13/14 张、带对 A/级牌、逢人配多解和收官豁免。与 STRAT-3/4 合并回归后的 `node js/ai.test.js` 为 **363/363**；这不是镜像收益、灾难率或发布证据。
- [x] STRAT-3 代码门已完成：`strategy-core` 提供 `assessEnemyReportLead` / `filterEnemyReportLeadCandidates`，AI、教练和混合候选池共享任一方向报单识别；只在存在安全非单/公开锁牌路线时过滤低单，无替代动作时 fail open，且跟牌不触发。领牌解释/咨询使用过滤后候选，混合层也不会把旧式被阻断首选重新作为搜索锚点；`node js/ai.test.js` **363/363**、`node js/ai.hybrid.test.js` **81/81** 通过；这不是镜像收益、灾难率或发布证据。
- [x] STRAT-1/4 代码门已完成：脱敏夹具绑定规则/实现摘要，observation 顶层严格白名单；`assessPartnerTrickControl` 按公开过牌与完成状态 fail closed；`with-partner-trick-control` 为独立候选，正式 expert/baseline 保持关闭。AI、评价和 hybrid 入口共享接风约束；`test_strategy_counterexamples.mjs` **24/24**、`ai.test.js` **363/363**、`ai.hybrid.test.js` **81/81**。未运行正式镜像赛，不形成收益、灾难率、性能或晋级证据。
- [ ] 原始 0831 复盘已按安全流程删除，无法重新核对 7 次送单、3 次压队友和 55/1 搜索统计；这些数字不得晋升为发布证据。

## P1-C：定位并修复搜索尾延迟

- [x] **PERF-1：固化分段复算器（历史诊断已完成，正式性能门仍阻断）。** 新增只读 `tools/analyze_statefix_performance.mjs` 与自包含 `tools/test_analyze_statefix_performance.mjs`；仅接受 legacy v2 checkpoint，按每 10 区组、1–60/61–80、座位、来源、级牌和 candidateTeam 重算，并将外部分段 sidecar 明确标为 `externally_declared/provenanceVerified=false`。报告与 checkpoint 的 search-triggered 总体计数、均值/P95/P99、最大值、回退、四项资源计数及 coverage 均逐项绑定；不得输出含义模糊的 `pass`，`formalGateEligible=false`。真实 statefix 复算得到总体 `6677`、P95/P99 `619/1022ms`，1–60 为 `5058`、`421.8/550ms`，61–80 为 `1619`、`942/1481ms`；run/resume provenance unavailable，因此仅作历史诊断，不能生成正式性能回执或晋级证据。
- [x] **PERF-2a：接通运行环境遥测与短 fresh→resume smoke。** `--environment-telemetry` 仅显式 opt-in；每段记录 RSS/heap、GC 暂停、checkpoint 构建+校验、序列化、写入/fsync、临时重读+校验、备份/rename及总耗时、进程与系统 CPU、频率、电源方案和外部负载。Windows `os.loadavg()` 的无效 0 值保持 unavailable，并以 `os.cpus()` 累计时序/频率作为明确标注的外部负载代理；sidecar 与 checkpoint、`.last-valid`、report、raw telemetry 路径冲突时启动前拒绝。artifact 状态、peaks、系统 CPU/外部负载摘要和 checkpoint 序号由内容复算，sidecar 损坏/缺段只降级 unavailable，不阻断核心 checkpoint resume。`tools/test_environment_telemetry.mjs` 已覆盖完整性负例、路径保护、短 fresh→中断→resume、损坏/缺段 sidecar 和唯一递增 checkpoint 计时。
- [ ] **PERF-2b：真实大 checkpoint 诊断。** 仍待在 R0 假绿缺口关闭且获授权后，对比从零运行与加载大 checkpoint 后 resume，按运行段审计大对象恢复/GC、云盘 I/O、系统负载和热/电源状态；短 smoke 不能替代正式性能门证据，也不能据此归因于算法。
- [ ] **PERF-3：只做有证据的优化。** 若根因是 checkpoint 体积或 GC，改为分块/流式保存并保持可复算；若根因在搜索，先用 profile 锁定热点再优化。不得通过放宽阈值或静默减少搜索覆盖过门。
- [x] **ALGO-1：修正失败 sweep 的深层事务语义。** v3 每个 sweep 在完整候选集合完成前暂存整棵开放环树；中断或后置候选 rollout 失败时恢复 depth、节点、availability、visits、reward、outcomes、failures 和终端/截断计数。`includeTreeDigest` 下的回归先形成成功深树，再注入后置候选失败并继续下一成功 sweep，逐字段证明 snapshot/mutated/restored 一致；普通决策不启用测试 hook 或树序列化。
- [x] **ALGO-2：固定 rollout 首出不变量。** `chooseRolloutPlay` 现要求 `lastHand=null` 的非空手牌返回合法出牌；若牌型生成器异常只提供非收官炸弹候选，则按确定性最小结构成本回退，并留下 `lead_no_ordinary_fallback` 诊断，跟牌时仍保留原有结构成本/点力排序和合法过牌；整手炸弹收官不误记为异常。`js/ai-hybrid.test.js` 覆盖当前代表性手牌、7/9 张只返回炸弹异常夹具、候选实体牌合法性/乱序确定性、finishing 边界、跟牌回归和四种搜索诊断传播；`node js/ai.hybrid.test.js` 为 **81/81**，当前统一 `verify.ps1` 为 **39 checks**。这只是代码/机制门，不构成性能、强度或发布证据。
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
- [ ] **DMC-2b：本机真人复盘准入。** 只接受 RT-5/6 通过且用户逐批批准的密封候选；绑定同意记录、事件链/实现摘要、规则重放回执和按完整 match 的隔离清单。智能体 annotation、评价分和未选择候选不得直接充当监督真值；不满足时继续 `trainingEligible=false`。
- [ ] **DMC-3：PyTorch DMC / ONNX / Worker 安全加载。** 仅在 R2 正向基线和 DMC-1 完成后启动；模型包绑定数据、种子、schema、环境和评测回执。
- [ ] **OPP-1：对手画像留出门。** 增加漂移检测、冷启动降权、个性化采样权重与独立长期留出；只允许公开行动特征，失败时回退 `observe/off`。

## 已核验但不再列为活跃任务

- availability-aware UCT 已改为 `log(availability + 1) / visits`；旧错误实现报告全部退出正式证据集。
- A/B 已显式设置 `opponentModelMode=off`，当前状态隔离 smoke 通过；旧两轮 fxe 因控制臂不等价均作废。
- statefix 10 区组探针性能通过；statefix 80 区组正常臂完整且正 CI，但因完整性能失败不得晋级。
- 默认验证在 0831 审核时为 31 项通过；本轮当前工作树统一入口为 **39 checks**、`-FullData` **45 checks**，`git ls-files -u` 与工作区/staged 差异检查均为零。SEC-1～3 与 EVID-9b 冻结提交的远端 CI 均已完成；STRAT 改动尚未冻结，严格价值模型发布校验当前按预期返回 1，专家默认未改变。
