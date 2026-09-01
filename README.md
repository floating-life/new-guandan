# 掼蛋训练大师 · 1v3 AI

本机运行的掼蛋训练网页：**你 + 对家 AI** 为一队，**上家 / 下家 AI** 为对手。包含完整对局、逢人配多解规则、四档 AI 与大师级策略评分、五维出牌评价、自动存档和逐手复盘。

## 登录网址：127.0.0.1 + 端口

本项目没有账号和密码；“登录网址”指本机浏览器访问入口。固定地址为：

**http://127.0.0.1:20801/**

### Windows 一键启动

1. 双击 **`启动本机版.cmd`**。
2. 启动窗口会自动打开 `http://127.0.0.1:20801/`。
3. 保持启动窗口开启；按 `Ctrl+C` 停止，完成后关闭窗口。

旧的 `启动内网版.cmd` 作为兼容入口保留，但现在同样只绑定 `127.0.0.1`。

### 手动启动

```powershell
.\start-lan.ps1
```

`127.0.0.1` 是本机回环地址：只有当前电脑能访问，手机和其他电脑无法连接，也不需要开放 Windows 防火墙。服务仅开放页面静态资源、健康检查，以及供本页使用的本机 LLM 配置/健康/决策 API；不会公开 README、训练数据或项目目录。

直接双击 `index.html` 可能因浏览器模块策略无法加载，必须先运行启动入口。

## 已实现功能

| 模块 | 说明 |
|------|------|
| 规则引擎 | 单、对、三张、三带二、顺子、三连对、钢板、炸弹、同花顺、天王炸 |
| 逢人配多解 | 同一组牌可保留多种合法声明；跟牌自动采用刚好可压的最小解释 |
| 升级与胜负 | 双上 +3、头三 +2、头末 +1；打 A 过关；三次不过 A 回 2 |
| 进贡还贡 | 单下/双下、抗贡、首出权；有 ≤10 非级牌时严格从中还贡 |
| 多难度 AI | 简单、普通、困难、大师；大师模式在困难前瞻基础上强化公开牌史记忆、牌型规划、搭档配合、残局控制和候选比较，且不读取其他玩家未公开手牌 |
| 公平搜索（实验） | PIMC、成对根 PIMC、ISMCTS v2 或 v3：公平观察 → 规则候选 → 专家安全筛选 → 公开信息集采样 → rollout/开放环树 → 团队升级收益；异常原样回退专家策略。所有搜索引擎当前仍未晋级，默认仍是专家策略。 |
| 对手建模（实验） | 只从你的公开出牌/过牌频率学习牌型倾向；大师 AI 仅在领出时作 ±12 分内的候选排序，不读取暗牌 |
| 教练模式 | 推荐主出法、理由、预计剩余手数及备选；查看与采用分为两个动作 |
| 五维评价 | 配合、资源、结构、残局、防守；显示扣分依据、错误标签和更优参考 |
| 训练口径 | 分开统计综合均分、无辅助均分、辅助决策和被迫操作 |
| 逐手复盘 | 保存初始牌面、每手圈号、剩余张数、AI 思路和真人评价，可前后逐手查看 |
| 自动恢复 | 出牌、等待 AI、还贡阶段刷新页面后，恢复上次未完成牌局 |
| 数据管理 | 本机统计、难度趋势、常见错误；支持 JSON 导入与导出 |
| 移动端 | 牌桌优先、评价其次、日志最后；紧凑牌张与吸底操作栏 |
| 无障碍 | 键盘选牌、弹窗焦点管理、Esc 关闭、状态播报、大字和减少动画 |

## 操作说明

1. 点击 **开始游戏**。
2. 选择手牌：
   - 单击牌张：选中或取消。
   - 点数标题：按 `1 → 2 → … → 全部 → 清空` 循环。
   - **全选**按钮：选择或取消该点数的全部牌。
   - `Shift + 单击`：区间连选。
   - “可选牌型”会区分逢人配的不同声明，一键选中后记为辅助决策。
3. 合法时点击 **出牌**；无法领出时可点击 **过牌**。
4. **教练建议**只展示思路；只有点击 **采用此建议**才改变当前选牌。
5. 还贡阶段仅高亮允许还出的牌，先预选再确认。

快捷键：`Enter` 出牌/确认还贡 · `Space` 过牌 · `Esc` 取消/关闭弹窗 · `H` 提示 · `C` 查看教练。

### 大师难度

- 只使用自己手牌、已出牌、公开余牌数、贡还牌和出牌顺序等公开信息。
- 强化牌型多方案规划、关键牌记忆、搭档角色判断、残局张数控制和炸弹时机。
- P0 公开余牌模型按座位使用已出牌、张数、贡还和过牌证据估算同型可接概率；P1 在安全候选内展开“下家应手→对家接回→上家反压”的一层公开应手树，并按团队升级/保名次价值重排。
- P2 把炸弹、普通接法和过牌放进同一净收益，并计入被更大炸弹反压；P3 补齐“下家过→对家直接接手→上家反压”，只在公开风险显著下降且零结构损伤时抬牌保护对家；P4 在十四张内的残局/名次关键区做受节点和墙钟约束的两层公开情景 rollout；P5 对 P1/P3/P4 的相关牌权分做有界、零均值融合，避免重复叠分。
- P0-P5 都不读取或采样真实暗牌；`no-p0` 至 `no-p5` 可逐项消融，`p1-only` 用于比较 P2-P5 联合增益。旧的“只因下家短就机械抬牌”仍保持关闭，与新版 P3 的公开风险护牌不是同一个策略。
- 顶部“本地引擎”默认使用稳定的“专家策略”。`pimc-v1` 在多个公平假想牌面比较安全候选；`root-pimc-v1` 让全部候选在相同假想牌面完成成对 rollout，它不声称树搜索；`ismcts-v2`/`ismcts-v3` 在只记录公开动作序列的开放环树上按 availability-aware UCT（`log(availability + 1) / visits`）选择。所有变体均至少要求根候选有 3 次有效访问，证据不足、超时或非法输出时保留专家首选；未完成新的独立评测前不改变默认策略。
- 本机对手画像 v3 仅记录公开领牌、应手/过牌、牌型、实际用炸、残局压力和相对座次，按 100 副半衰期衰减。`off` 不记录也不影响决策，`observe` 只记录，`adaptive` 仅在专家安全候选内作小幅调整；它不读取暗牌、不上传数据，也不把过牌解释为持有炸弹。
- 混合层不能把专家已经决定的普通接牌改成过牌，也不能恢复专家已排除的领炸、先交王、额外消耗级牌/逢人配或新增结构破坏。采样失败、超时、证据不足、牌型声明不一致或只剩一个安全候选时，最终动作保持专家首选。
- `guandan-candidate-v1` 提供固定 32 维候选特征与最多四层稠密价值模型的校验/推理接口；当前仓库**没有冒充附带训练好的神经网络权重**。`guandan-selfplay-trajectory-v2` 训练数据使用递归白名单，并重算候选归属、规则合法性、牌型声明、32维特征及终局团队收益；旧版轨迹不能混入。线性训练器只产生 `experimental_unvalidated` 模型，并记录训练数据 SHA-256 与种子清单；网页只接受带完整发布回执、完成全13级、至少500组未见种子镜像、全部计划局与区组完成、零失败且升级收益置信下界为正的 `promoted` 模型。模型仅在搜索证据充分的关键局面参与，不会绕过专家和搜索门禁。
- 每副结束后，系统把你已公开的领出类型、面对各座位/牌型的应手与过牌、实际应手牌型和公开用炸按余牌压力平滑汇总。旧 v1 画像会自动迁移到 v2。只有总样本达到 12 次且分项证据足够时，大师 AI 领出才获得最多 ±12 分软偏置；过牌绝不会被推断成“手里有炸”，规则和安全门始终优先。
- “独立散单接管”只在对手十张内或连续走单压力成立时升级为硬拦截。
- 真实复盘防线把“团队名次下延迟整手强控出完”和“对手五张内最低损伤普通接牌”接入 AI、教练与评分同一核心；十张软压力在未见种子镜像赛中显著负向，因此默认关闭，仅保留 `with-soft-ordinary-pressure` 实验臂。
- 不读取对手或对家未公开手牌；局末自动亮牌仅用于复盘。

### 策略来源与冲突处理

- 官方竞赛规则属于硬约束：牌型、大小、接风、升级和公开信息边界不得被策略覆盖。
- 掼蛋 AI 论文与公开基准属于高权重方法依据：采用公开牌史、候选比较、有限前瞻和搭档/对手行为建模。
- 有作者和实战背景的高手经验只作为条件性加减分；匿名“必胜口诀”不直接进入核心。
- “剩 5 出对、剩 6 出三、剩 7/8 出顺或夯、剩 9 出单、剩 10 出对”最高只加 20～35 分，并服从不拆炸、不拆唯一顺子、紧急拦截和明确收官路线。
- “炸弹及时用”与“炸弹要保留”统一按净收益处理：阻止走完、炸后两手收官、护送对家时提高优先级；中盘无后续路线时保留。
- 对手过牌只降低其持有相应牌型的概率，不会被视为确定没有，避免把推断变成偷看暗牌。

## 规则口径

- 两副牌 108 张，每人 27 张；对家为队友。
- 级牌大于 A、小于王；红桃级牌为逢人配，可替代任意非王牌。
- A 可在顺子、三连对、钢板中作低位或高位。
- 天王炸 > 六张及以上炸弹 > 同花顺 > 五炸 > 四炸 > 普通同型。
- 还贡：有不大于 10 的非级牌时必须从中选择；否则只能还当前最小牌。
- 出完后无人再压，由对家借风。

## 数据说明

- 统计、设置、复盘和进行中牌局保存在浏览器 `localStorage`。
- 固定使用 `127.0.0.1:20801` 可避免因局域网 IP 或端口变化产生新的数据来源。
- 更换端口、浏览器或浏览器用户资料后，数据彼此独立；可通过统计弹窗导出/导入。
- 本项目没有网络账号、云同步或多人联网对战。

### 外部对局训练数据

- `tools/download_njupt_archives.py` 会从南邮比赛结果页发现全部 RAR，保留原包和 SHA-256，逐包安全解压；不会运行来源中的 `replay.py`。
- `tools/import_njupt_data.py` 使用受限 pickle 原语解释器导入 `.data/.ros/.data_R1_R2`，不调用 `pickle.load()`。
- `tools/import_botzone_guandan.py` 可导入 Botzone 月度 ZIP；当官方归档主机不可用时，可限速读取匿名公开比赛页，并保留 HTML、来源 URL 和哈希。
- 当前本机快照包含南邮 139 局和 Botzone 最近 100 个来源对局；结构化写入 230 局，其中 229 局结构完整。严格重放通过的轨迹也只作为隔离候选，统一保持 `trainingEligible=false`；动作不唯一的接风适配轨迹同样不可训练。
- 外部档案含四家完整手牌，只能在规则重放后转换为“行动座位手牌 + 当时公开信息”的公平观察，绝不能直接接入对局 AI。
- 来源页未明确授予本仓库再分发许可，因此 `训练数据/` 默认不提交到公开仓库。完整目录、异常明细和复现命令见 `训练数据/README.md`。
- 自对弈、训练和 A/B 运行产物同样默认不提交；只有经过门禁生成的晋级模型回执才应按发布评审单独加入版本库。

## 自动测试

```bash
# Windows 统一入口；加 -FullData 才校验本机大数据与外部隔离产物
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tools\verify.ps1
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tools\verify.ps1 -FullData

# 严格互绑发布证据：当前历史 A/B 会如实失败，不能代表模型晋级
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tools\verify.ps1 -ReleaseEvidence

node js/rules.test.js
node js/ai.test.js
node js/ai.hybrid.test.js
node js/opponent-model.test.js
node js/value-model-gate.test.js
node js/ai.worker.test.js
node js/ai.worker.integration.test.js
node js/game.test.js
node js/stats.test.js
node js/ui.static.test.js
node js/llm.test.js
node js/llm.integration.test.js
python lan_server.test.py
node js/integration.test.js
node js/ai.ab.simulation.js 30 20260801 expert baseline --levels=all
node js/ai.ab.simulation.js 30 20260811 expert no-p0 --levels=2,3,4,5,6,7,8,9,10,J,Q,K,A
node js/ai.ab.simulation.js 20 20260825 expert p1-legacy --levels=all --level-blocks
node js/ai.ab.simulation.js 20 20260826 hybrid-v1 expert --levels=all --level-blocks --summary-only
node js/ai.ab.simulation.js 20 20260826 root-pimc-v1 expert --levels=all --level-blocks --summary-only
node js/ai.ab.simulation.js 3 20260925 expert p1-legacy --levels=all --level-blocks --trace-divergence
node js/ai.ab.simulation.js 20 20260825 expert no-p1 --levels=2,A --continuous-match
node js/ai.ablation.simulation.js 20 20260811 --levels=all --level-blocks
node js/ai.exploit.simulation.js 100 20260814 --levels=all --gate
node js/ai.policy.calibration.js 4 20 20260825 --levels=all
node js/ai.ab.simulation.js 20 20261210 expert p1-only --levels=all --level-blocks --summary-only --json
node tools/replay_ai_audit.mjs "C:\路径\掼蛋训练数据_YYYY-MM-DD.json" 8
node tools/selfplay_dataset.mjs 20 20260901 data/selfplay.jsonl
# 长任务中断后从最近完整牌局继续
node tools/selfplay_dataset.mjs 20 20260901 data/selfplay.jsonl --resume
node tools/validate_value_dataset.mjs data/selfplay.jsonl
python tools/train_value_model.py data/selfplay.jsonl data/value-model.json 350
node tools/validate_value_model.mjs data/value-model.json
# 正式模型 A/B 的 40 个评测种子必须与训练清单不重叠；脚本会在首局前拒绝重叠。
node js/ai.ab.simulation.js 40 920000 root-pimc-v1 expert --levels=all --level-blocks --summary-only --json --value-model=data/value-model.json --report=data/value-model-ab.json
# 连续赛必须是与训练集、主 A/B 都不重叠的完整 8 场证据。
node js/ai.ab.simulation.js 4 931000 root-pimc-v1 expert --levels=2 --continuous-match --summary-only --json --value-model=data/value-model.json --report=data/value-model-continuous.json --checkpoint=data/value-model-continuous.checkpoint.json
node tools/promote_value_model.mjs data/value-model.json data/value-model-ab.json data/value-model.promoted.json --continuous-report=data/value-model-continuous.json
node tools/validate_external_replay_policy.mjs --trajectory "训练数据/验证/external-trajectory-v2.jsonl" --status "训练数据/验证/external-replay-status.json"
python tools/test_import_botzone_guandan.py
python tools/test_import_njupt_data.py
python tools/download_njupt_archives.py --self-test
```

测试覆盖逢人配多解、牌型声明、AI 前瞻与评价、还贡约束、状态恢复、统计口径、响应式/无障碍契约，以及完整一副自动对局与复盘结构。A/B 脚本按相同种子交换两种策略的座位，只把两腿都完成且牌面/先手一致的镜像组计入结果，并报告升级净效用、头游、双上、配对 bootstrap 区间、死局、耗时和 2 至 A 分层。`--level-blocks` 会把每副基础牌在全部指定级牌下重复评测，并按基础牌区组而非13个相关观测做 bootstrap；40个基础牌区组、13级、双腿为1040局/520组镜像，达到价值模型发布门禁。`--value-model` 会在启动前检查评测种子与训练种子无重叠，并把跨运行时一致的模型权重 SHA-256、评估种子清单和训练数据来源写入报告；`promote_value_model.mjs` 会核对权重摘要、完整发布回执、训练/评估种子不重叠、覆盖、样本、安全性和收益置信区间。小样本只作烟雾测试，不会晋级模型。

M2 首个干净批次已用 `20260901–20260940` 生成并通过严格校验（40 副、3,859 条轨迹）；生成器按副增量写入并保留 `guandan-selfplay-checkpoint-v1`，校验器逐行读取，训练器分块计算数据 SHA-256。对应模型 `data/value-model-20260901-experimental.json` 只用于离线评测，未通过正式 A/B 门禁前不会被网页加载。

该模型随后完成正式 1,040 局 A/B（40 个基础牌区组、13 级、双腿换座）：520/520 镜像组，0 失败、0 死锁、0 镜像偏差；相对专家升级效用 `+0.010/局`，配对 bootstrap 95% 为 `-0.008～+0.029`，下界跨 0。因此历史门禁只生成 `validated` 回执而非 `promoted` 模型，网页继续使用专家默认策略。

2026-08-28 已用语义权重摘要重新建立 `root-pimc-v1` 的独立连续赛：`baseSeed=931000–931003`，8/8 场、4/4 镜像组、0 失败/死锁/镜像偏差，覆盖 113 轮、92 个贡还轮和 11 个 ≥120 动作长轮。旧 1,040 局主 A/B 的报告绑定的是早期文件摘要，不能与语义摘要模型或这份新连续赛拼接成发布回执；而且其收益下界本就跨 0。故当前没有可加载的 `promoted` 模型，专家策略仍是预期默认值。

2026-08-29 使用同一批 `20261001–20261040` 基础牌区组完成新的搜索引擎 A/B。`root-pimc-v1` 为 1,040/1,040 局、520/520 镜像组、0 失败，升级效用 `+0.022/局`、bootstrap 95% CI `[-0.008, +0.052]`；`ismcts-v2` 同样完整且 0 失败，效用 `+0.015/局`、CI `[-0.024, +0.060]`。两者自动性能门均通过，但收益下界都跨 0；完整报告见 `data/eval-20260828-root-pimc-v1-ab.json`、`data/eval-20260828-ismcts-v2-ab.json`，汇总见 `data/performance-baseline-20260829.json`。因此暂不启动正式 DMC/DanZero 训练。

2026-08-30 独立复核发现后续 Kimi v3 评测的总局数、汇总和报告哈希是自洽的，但旧实现的 availability-aware UCT 公式错误，旧性能基线把大量未触发搜索的回合混入分位数，强制专家消融并非逐对象等价，检查点也未绑定源码/预算，盲评统计没有处理同一玩家/同一场景的相关性。因此旧 v3 40/80 区组正 CI 仅保留为诊断，不是晋级或发布证据；代码已新增源码/预算绑定的 v2 checkpoint、四座延迟覆盖、search-triggered 性能门与严格盲评 v2，下一轮必须使用完全未见种子重跑，网页继续默认专家策略。

2026-08-30 修复后冻结 1800 节点的独立 v3 80 区组复测（`20263001–20263080`）完成 2,080 局 / 1,040 镜像组，零失败、死锁和镜像偏差。严格 search-triggered 性能为 6,354 回合 100% 测量、P95/P99 `443/590.6ms`、零回退，性能门通过；但升级效用 `+0.015/局` 的 bootstrap 95% CI 为 `[-0.006,+0.038]`，强度门失败。报告 SHA-256 为 `987526440ec54f380377704e792c02df9922f29b2fb0af6184ce049ee12040bb`；因此专家策略继续是默认，性能回执可单独由 `node tools/summarize_ai_performance_baseline.mjs --report data/eval-20260830-ismcts-v3-ab80-budget1800.json --min-blocks 80` 生成，不能伪造另一引擎或替代强度、盲评与消融门。

同日的首次 v3 force-expert 80 区组消融（`20264101–20264180`）虽完成，但审计发现强制臂在 Worker 路径静默退回专家并丢失部分搜索遥测：相对专家有 2 个非零配对，正常 `changed=101` 与强制 `wouldChange=29` 不一致，故报告和分析回执只保留为失败证据，不能归因或晋级。已修复传递链；全新单区组控制烟雾（`20264202`）实现逐项零差且 `changed=wouldChange=1`，但仅 87 个搜索触发回合，未达到性能门样本量，也不构成任何强度结论。专家策略仍为默认。

同日修复后的第二次 v3 force-expert 80 区组控制（`20265101–20265180`）也已完整结束，但同样**作废**：源码摘要和冻结 v3/1800 节点配置与正常臂一致，2,080 局 / 1,040 镜像组零 failures/deadlocks/mirror mismatch；然而强制臂相对专家仍有 5 个非零配对、3 个头游差、3 个双上差，且正常 `changed=118` 与强制 `wouldChange=117` 在 7 个对局对象不一致。分析回执因此标记 `invalid_forced_expert_control`；其表面 `+0.022/局`、bootstrap `[+0.004,+0.040]` 不可作因果、强度或晋级主张。回执工具现强制检查这些机械门，避免正向 CI 遮蔽失效消融；专家策略继续是默认。

2026-08-26 的混合决策框架完成两组独立未见种子烟雾赛：`20260831` 的 10/10 局相对专家策略升级效用 `+0.1/局`、头游 `5:5`、双上 `2:2`；`20260901` 的 20/20 局升级效用 `+0.15/局`、头游 `11:9`、双上 `4:4`。两组均为 0 失败、0 死锁；第二组 940 个混合回合中 31 次完成模拟、2 次实际改选。它们只证明链路生效且暂未见明显退化，远不足以证明强度显著提升；因此“专家策略”仍为默认，正式晋级需至少 39 个完整基础牌区组（13 级共 507 组镜像/1014 局；推荐按上方命令取 40 区组、520 组镜像/1040 局）及真人复盘共同通过。

2026-08-25 的 P2-P5 未见种子留出验证使用 `seed=20261210`：520/520 局完成，0 失败、0 死锁、0 镜像偏差；相对 `p1-only` 的升级效用为 `+0.025/局`（基础牌区组 bootstrap 95%：`-0.031～+0.083`），头游 `260:260`，双上 `125:123`。它满足当前“无明显退化”的安全发布门槛，但区间仍跨 0，只能表述为安全中性偏正，不能表述为已证明显著变强。

同日8副真实复盘逐手重建了546个电脑回合。最初把十张软压力一并强制接牌时，未见种子60局相对关闭臂为 `-0.383/局`，因此没有发布；收窄为五张硬残局后，真实复盘只改动“三张6应拦、三张5替代三张Q”两手。最终用新种子 `20260917` 做60局同牌换座门禁：升级效用 `0.000/局`、头游 `30:30`、双上 `18:17`，0失败、0死锁、0镜像偏差。该结果只支持“未见明显退化”，真实强度增益仍需后续真人牌局与更大留出样本确认。

## 目录结构

```text
index.html                 # 页面入口
css/style.css              # 桌面/移动端与无障碍样式
js/cards.js                # 牌张、牌组与排序
js/rules.js                # 多解规则引擎
js/ai.js                   # 多难度 AI 与有界前瞻
js/ai-observation.js       # AI 公平公开信息白名单与泄漏审计
js/ai-hybrid.js            # 专家安全候选、PIMC/成对根 PIMC/ISMCTS v2、价值模型接口与信息集模拟
js/value-model-gate.js     # 价值模型 experimental/validated/promoted 发布门禁
js/opponent-model.js       # 仅公开行动统计、跨局持久化的真人对手模型 v3
js/ai-route.js             # 公开余牌、座位应手树与受限残局 rollout
js/ai.policy.calibration.js # P5 离线选型与未见种子发布门禁
js/evaluator.js            # 五维出牌评价
js/game.js                 # 游戏状态机、存档与复盘
js/stats.js                # 统计、导入导出、localStorage
js/ui.js                   # 界面与交互
js/*.test.js               # 自动测试
lan_server.py              # 仅绑定 127.0.0.1 的受限静态服务
start-lan.ps1              # 本机服务启动器
tools/llm_smoke.py         # 真实本机网关/云端决策烟雾测试
tools/replay_ai_audit.mjs  # 导出数据的逐手公开信息 AI 反事实审计
tools/selfplay_dataset.mjs # 公平自对弈轨迹数据生成器（手动执行）
tools/validate_value_dataset.mjs # 训练数据暗牌边界校验
tools/train_value_model.py # 本机线性价值模型训练器（实验）
tools/validate_value_model.mjs # 浏览器模型接口校验
tools/promote_value_model.mjs # 绑定未见种子A/B报告的模型晋级工具
tools/summarize_ai_performance_baseline.mjs # 汇总全量 A/B 的本机决策延迟门
tools/download_njupt_archives.py # 南邮公开竞赛数据下载与安全解压
tools/import_njupt_data.py # 南邮 pickle 原语安全导入器
tools/import_botzone_guandan.py # Botzone ZIP/公开回放导入器
训练数据/README.md         # 本机外部数据快照、门禁和授权说明
启动本机版.cmd              # 推荐的 Windows 双击入口
启动内网版.cmd              # 兼容入口，同样仅限本机
README.md
```

## 云端增强 AI（可选）

页面新增「AI策略」：

- `本地 AI`（默认）：完全离线运行，不提交牌面。
- `智能增强`：只在残局、对手接近出完或候选难分高下时请求云端，每副最多 6 次。
- `云端增强`：在关键或有歧义的电脑回合让云端重排本地安全候选，每副最多 12 次。模型不能创造牌，也不能读取未公开手牌。

云端模式只访问本机代理 `GET /api/llm/health` 与 `POST /api/ai/decision`。API 密钥不进入浏览器和 `localStorage`；网页中保存时，密钥以 Windows DPAPI 当前用户密文写入 `%LOCALAPPDATA%\GuandanTrainer\llm-config.json`，重启后仍可用。环境变量优先级更高，仍可用于临时/自动化启动：

```powershell
$env:GUANDAN_LLM_API_URL = 'https://api.openai.com/v1/chat/completions'
$env:GUANDAN_LLM_API_KEY = '<你的 API Key>'
$env:GUANDAN_LLM_MODEL = 'gpt-4.1-mini'
python .\lan_server.py
```

兼容 OpenAI Chat Completions 格式的服务可替换 `GUANDAN_LLM_API_URL`。远程地址必须使用 HTTPS；仅本机 loopback 模型允许 HTTP。本机网关校验 Host、Origin 和 JSON Content-Type，限制并发/频率，并禁止携带密钥跨站重定向。页面「检测 API」和「保存并检测」会实际调用极短聊天探针。超时、429、5xx 和网络波动只回退当前手，然后按 5/15/45/120 秒退避自动重试；401/403、模型/地址不兼容或返回协议无效才进入需要「检测/恢复 API」的全场景本地模式。

火山引擎方舟 Coding Plan 可将官方 OpenAI 兼容 Base URL 直接填入 `GUANDAN_LLM_API_URL`，程序会自动补全 `/chat/completions`；也接受已经写完整的 Chat Completions 地址：

```powershell
$env:GUANDAN_LLM_API_URL = 'https://ark.cn-beijing.volces.com/api/coding/v3'
$env:GUANDAN_LLM_MODEL = 'deepseek-v4-flash' # 仅当该模型出现在你的 Coding Plan 控制台；否则改为控制台列出的模型或 ark-code-latest
```

DeepSeek 官方 API 使用 `https://api.deepseek.com`（不要加 `/v1`），模型可用 `deepseek-v4-flash`。针对官方 V4，程序会自动关闭不必要的思考模式并请求 JSON Output，避免健康探针把短 Token 预算耗尽后返回空内容；更换服务商时必须填写对应的新 API Key，空白只会保留同一服务商的旧密钥。

`/api/llm/health` 显示「待首次决策验证」表示只完成了浅检测；`/api/llm/health?deep=1` 才会验证真实聊天接口。部分兼容网关不开放自动推导的 `/models`。`start-lan.ps1` 会比对当前代码 build 和项目指纹；只有能验证为本项目的旧服务才会自动安全重启，不会误杀占用 20801 的其他程序。

每副结束后，「复盘」会保存云端 API 报告：实际调用、成功率、临时/配置故障、退避/策略跳过、平均与 P95 延迟、Tokens，以及「本地候选 → 云端候选 → 最终执行」。可直接看到云端是真正改选，还是与本地 AI 意见一致。报告不保存 API Key，也不保存发送给云端的完整牌面。

顶部「API 设置」可以在不重启页面的情况下切换 Base URL、模型和 API Key。Token 统计优先使用供应商 `usage`，缺失时估算并明确标注，适合看趋势而不替代账单。云端只接收本地已筛选的最多 3 个安全候选；代理默认等待 20 秒，可用 `GUANDAN_LLM_TIMEOUT_SECONDS` 调整到 8～30 秒。

需要独立证明「不只是健康端点正常，而是真的能完成候选决策」时，在服务运行期间执行：

```powershell
python .\tools\llm_smoke.py
```

该脚本不读取、不打印 API Key，会输出服务 build、provider/model、真实决策 ID、延迟与 Token 来源。

云端每次只接收当前电脑玩家自己的手牌、合法候选和公开牌史，不直接接收其他玩家暗牌。不过整局多次调用可能让第三方服务累计看到多名电脑玩家手牌，并据此推断牌池；使用前应确认服务商的数据保留、训练和日志政策。选择「本地 AI」时页面不会执行云端健康检测或决策请求。

## 当前边界

- 大师难度仍是本机启发式评分与有限前瞻，不代表职业级或深度强化学习模型。
- 成对根 PIMC 是“相同世界基础覆盖 + 置信改选”的受限根搜索，不是树搜索；`ismcts-v2` 才是开放环信息集树，但仍是实验引擎，必须通过本机延迟、反作弊和同牌跨级收益门禁。没有达到 `promoted` 强制门禁的训练权重不会进入正式对局。
- 深度强化学习的环境契约、100k JS↔Python 差分门禁和远程训练前置检查见 [training/README.md](./training/README.md)。本机未完成 Python 规则适配器、未安装 PyTorch/ONNX 时不得假装训练完成。
- 完整 DanZero/深度强化学习仍需要外部 GPU 自对弈训练、专用策略/价值网络、模型导出和大量对抗评测；本项目现在具备公平数据契约、模型接口、离线训练起点与加载入口，尚不能宣称达到职业/竞赛级强度。
- `127.0.0.1` 只允许当前电脑访问。
- 如果未来需要真实账号登录、跨设备同步或真人联网对战，需要新增后端、数据库和认证系统。
