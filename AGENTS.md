# new-guandan 项目协作与验证约定

## 开工与证据基线

每次开始任务，先只读核对当前工作树、分支、已有未提交/未跟踪改动、相关实现、测试、`todo.md`、发布验证器和可用报告。记录本次基线与将要触及的文件；不得把旧报告、旧 CI、旧 checkpoint 或历史结论当作当前代码的证据。阈值、当前停止线和最终状态以当前代码、`todo.md` 与发布验证器为准。

既有改动属于用户：除非任务明确要求且已核对影响范围，不修改、回退、格式化、暂存、提交或混入这些改动。完成时区分本次改动与原有改动；只暂存和提交已验证、且属于本次任务的文件。未经用户明确授权，不创建提交、推送、改默认策略、降低门槛或改变发布状态。

## 自主协作与额度

父代理自行规划、分解、实施、测试和报告，不要求用户逐项指定模型。父代理的常规默认是 **Terra (`medium`)**，用于规划、集成、测试和汇总；架构、晋级、发布门禁、证据冲突或派独立审查时，临时调用只读 **Sol (`high`)**。ChatGPT / Codex 额度耗尽或原生子代理不可达时，改走「Codex 控制面与 CodexHost」中的降级控制面；用户声明的厂商活动窗口或 Grok 专场则改走同节对应窗口。不得假装 Luna / Terra / Sol 仍在执行。最多同时运行两个子代理；只有输入、输出和写入范围独立时才并行。任何会写文件的任务都要指定精确文件范围，避免冲突；共享文件、架构决策、合并和最终结论由父代理串行处理。窗口外优先复用已有命令、脚本与证据，避免为简单工作启动多个代理或反复消耗额度；Grok 专场内则把额度花在已排队的 TASK 上，仍禁止无 TASK 空转。

- **Luna (`medium`)**：使用自定义代理 `luna-helper` 处理重复、只读、枚举、精确机械转换、定向检索和轻量检查，默认只读。`low` 仅用于结果可由工具完整硬校验的确定性枚举、哈希或格式转换；仅当父代理给出精确文件与纯机械改动时可写。另有 `luna-max-worker`（Luna / `max`）作为窄范围小实现的首次尝试通道，不是一般开发或 Terra / `xhigh` 的替代。只有下列条件**全部**满足且已实施，才可启动：父代理给出精确文件 allowlist；任务只涉及一个局部组件及其定向测试；已有完整自动验收命令和成功条件；不改变架构、公共接口、数据格式、共享状态或并发安全；不引入新依赖；且不触及 AI 默认、UI 暴露、训练/外部数据、评测/遥测/checkpoint、`todo.md`、发布验证器、门禁或 CI。启动前任一条件不满足或尚未实施（包括完整自动验收命令或成功条件），直接使用普通 Terra / `medium`（高影响才可升 `high`），不得启用 Luna / `max`。Luna / `max` 启动后是当前工作树的唯一写入者，不得与其他写代理并行；只允许一次实现和一次既定验收。仅在已实际开始实施后，如既定验收失败、实际修改越界、需求扩张或发现高风险，才必须停止该通道，保留 diff 与失败输出，并升级 Terra / `high`（仅高影响或 `high` 仍失败才 Terra / `xhigh`）；“停止”绝不解释为回退用户改动。执行后父代理必须检查实际变更文件是否符合 allowlist、diff 与验收退出码，并按现有规则交由 Sol / `medium` 独立最终审查；存在风险时改用 Sol / `high`。自动验收通过不构成发布或晋级证据，expert 默认与既有硬门保持不变。
- **Terra (`medium`)**：使用自定义代理 `terra-worker` 处理一般功能开发、修复、定向测试和跨文件实现。接管 Luna / `max` 停止的任务前，先检查并继承或隔离已有 diff，绝不回退用户既有改动。`medium` 失败后，父代理才可显式另行委派 `gpt-5.6-terra` / `high` 并说明范围和验收条件；仅高影响任务或 `high` 仍失败时，才可显式另行委派 `gpt-5.6-terra` / `xhigh`。固定 `medium` 预设不可自行升级。
- **Sol (`medium`)**：使用只读自定义代理 `sol-reviewer` 做交付前的独立最终审查。规划、发布门禁、模型晋级、数据安全或证据冲突时，父代理必须显式临时调用只读 `Sol` / `high`；架构或门禁变更必须在实现前征询该审查。所有代码、配置、测试或评测工具改动在差异和测试证据生成后，必须由 `sol-reviewer` 进行只读最终审查。Sol 不代替实现代理写入，且不能只接受自评。`max` 与 `xhigh` 不进入 Sol 默认路由。

## Codex 控制面与 CodexHost

父会话是唯一编排者，默认用原生子代理 Luna / Terra / Sol。只有需要独立家族意见、第二实现，或用户点名外部 CLI 时，才经 CodexHost 委派。子 harness 只执行父会话给出的单个 TASK，不得再转派、不得重做路线图、不得自行更新 `todo.md` / `整体项目路线图.md` 或改变发布状态。

活文档权威顺序不变：当前代码 + `todo.md` 停止线 + 发布验证器 > `整体项目路线图.md` > 历史计划与旧产物。规划输出必须使用固定 TASK 模板（来源条目、目标/非目标、前置、精确 allowlist、禁止触碰、验收命令、成功条件、失败升级、并行性、风险等级、下一模型最小上下文）。执行代理一次只接一个 TASK。

委派前必须：

- 运行本机 CodexHost 的 `delegate --help` 与 `harness inspect <id> --cwd <repo>`，只使用其返回的 harness / model / thinking 不透明 ID；禁止凭记忆构造。`delegate start` 没有 `--permission` 参数，禁止发明该旗标。Grok 通道无论是否声明专场，都必须 `--model grok-4.6 --thinking xhigh`（Extra High），不得省略以免落到 harness 默认 `high`。Antigravity 必须 `--model gemini-3.8-flash --thinking high`。所有环境（Codex、Grok、Grok 专场、ZCode 窗口前后）Antigravity 权限都保持客户端 **Configured**（inspect 默认 `configured`），不要改成 skip-permissions / `dangerously-skip-permissions`。
- 确认 `todo.md` 当前停止线未禁止该任务，且 TASK 含精确 allowlist、验收命令、成功条件和禁止项。
- 写入任务与任何其他写者的文件范围不相交。共享文件（`todo.md`、路线图、`js/ai.js`、评测闭包、发布验证器、CI）由父会话串行合并。
- CLI 入口为 `D:\Program Files (x86)\codexhost\bin\codexhost.exe`；该目录须在系统 PATH 中。Windows 无 native broker，必须从 CodexHost 提供的环境发起委派；沙箱若禁止本地 Runtime 连接，报 `RUNTIME_UNREACHABLE`，不得回退到 PATH 上的 `grok` / `claude` / `dsh` 直接开写。

Harness 选用：

- `grok`：本仓库 Grok 父会话与 CodexHost `grok` 委派一律 `grok-4.6` / `xhigh`（Extra High），与是否声明 Grok 专场无关。Grok 已是父会话时，默认定向实现由父会话自己做，不要再委派另一个 `grok` 子会话。仅在用户声明的 Grok 专场内，且两条 TASK 的 allowlist 不相交时，才允许最多再开一个同样 `grok-4.6` / `xhigh` 的写入者。
- `deepseek-harness`：机械或低风险任务。审查必须 `read-only`；不要用默认 cmcc Flash 做门禁结论。当前仅 Grok + Antigravity 可用时不要启用。
- `claude-code`：先 inspect 解析标签；若解析为 k3 或非目标家族代理，不得当作跨家族独立审查。ChatGPT 额度耗尽时通常也不可用，不得当作后备。
- `antigravity`：Grok 控制面下的默认跨家族通道。独立审查与第二实现用 `gemini-3.8-flash` / `high`。`delegate start` 只传 `--harness antigravity --model gemini-3.8-flash --thinking high`，不传 `--permission`，沿用默认 Configured（`configured`）。所有环境都保持 Configured，禁止改成 skip-permissions / `dangerously-skip-permissions`，也禁止 `always-approve` / `bypassPermissions` / `danger-full-access`。TASK 审查必须只读。该审查仍不是发布/晋级证据。

`--task` 必须是完整 TASK 包（含子会话看不到父聊天记录所需的全部约束），并写明工作目录、须先读的文件、allowlist、验收命令、成功/失败语义，以及「不 commit / push、不改 expert 默认、不消费新正式种子」。审查任务必须写明只读、禁止改文件；实现任务必须写明当前唯一写入者。

`delegate start` 立即返回，不是同步 RPC。父会话必须记录 `delegationId` / `threadId` / `turnId` / `deepLink` / `status`；需要结果时显式 `thread read`，可用有界 `thread wait`。超时（`timedOut=true`）是检查点，子会话继续跑，不得写成完成或通过。同一 thread 未 idle 时禁止 `send`（`THREAD_BUSY`）。只报告子 thread 的可见 result，不把 running / 旧产物 / 未完成 checkpoint 说成通过。

父会话在子任务返回后必须自己：核对实际 diff 是否落在 allowlist；跑或复核 TASK 写明的验收命令；共享文件与活文档更新只在确认后由父会话写入。自动验收通过不构成发布或晋级证据。

### ChatGPT / Codex 额度耗尽时的降级控制面

当 ChatGPT 额度用尽、Codex 原生子代理不可达，或用户声明当前只有 Grok 与 Antigravity 时，启用本降级，不改硬门、停止线或 expert 默认。

- 父会话改为 **Grok 4.6 Extra High**（本仓库 Grok Build / CodexHost `grok` 的 `grok-4.6` / `xhigh`）。父会话负责核对基线、出 TASK、实现或派工、跑验收、合并共享文件和更新活文档。
- 独立审查、架构/晋级/发布门禁和第二实现只派 **Antigravity**，不得用 Grok 审查 Grok 自己的 diff，也不得把 Grok 自评写成 Sol PASS。交付报告写「Antigravity 跨家族审查」；Sol 条目记为不可达，不是通过。
- 禁止启动 `luna-helper` / `luna-max-worker` / `terra-worker` / `sol-reviewer` 或 `codex` harness 碰额度。禁止为「再找一个审查者」去调 `claude-code` 或 `deepseek-harness`。
- 单一写入者仍有效：Grok 正在写时，Antigravity 只读；Antigravity 实现时，Grok 父会话不写同一 allowlist。最多一个写者 + 一个只读审查。
- Codex 额度恢复后立刻回到 Luna / Terra / Sol 默认路由；降级期间的代码门通过仍不是发布或晋级证据。

### 厂商活动窗口：脱离 Codex，由用户指定的控制面指挥指定 Flash 执行

活动窗口**没有默认时刻表**。不得假定每晚 20:00 / 22:00 或任何固定时段自动切换。每次启用都必须由用户当场声明，或由用户给出可复用的自定义日程（仍须写明时区；未声明的日期不得自行开工）。

用户声明一次窗口时至少给出：起止时间（含时区）、控制面（如 ZCode）、执行模型（如 GLM 5.3 Flash）。可另给重复规则（例如「仅周三 21:00–次日 09:00 +0800」）；没有重复规则就只跑这一次。窗口只换编排者和执行者，不改硬门、停止线、expert 默认，也不因为 token 变便宜就开正式长跑、消费新正式种子或降低审查。

在哪里声明（必须两处，缺一不可）：

- **先在当时的父控制面声明**（Codex 可用时在 Codex，ChatGPT 额度耗尽时在 Grok）。这里只做授权、让出工作树、按模板写出本窗口 TASK 队列。Codex / Grok 看不到 ZCode 客户端，声明后它们在窗口内不得继续写同一 allowlist，也不得替 ZCode 开工。
- **再把同一段声明 + 完整 TASK 队列贴进 ZCode 客户端**，作为窗口内唯一父会话的开工合同。只在 Codex 里说一声、不打开 ZCode，窗口不算生效。只在 ZCode 里随口说「开始干活」、没有 Codex/Grok 写出的 TASK 队列，Flash 也不得开工。
- 两处文本必须一致（起止、时区、控制面、执行模型、TASK 包）。ZCode 不读取 Codex 聊天记录；CodexHost 不能委派 ZCode。收回窗口时也要在两侧都说一声，或等到声明的截止点。

准入（缺一不可，否则保持当时的 Codex 或 Grok 控制面）：

- 当前时刻落在用户声明的起止之内；提前或过点都立刻回到当时适用的控制面。
- 窗口开始前，当时的父控制面（Codex 或 Grok）已经按固定 TASK 模板写好**本窗口**队列：每个 TASK 含来源条目、目标/非目标、前置、精确 allowlist、禁止触碰、可复制验收命令、成功/失败语义。Flash 类模型没有完整 TASK 时禁止开工，不得让它自己读 `todo.md` 发明任务。
- 队列只含被停止线允许的代码/测试/文档缺口；不含晋级、发布互绑、正式评测、训练或 UI 暴露。
- 声明的控制面若不是 CodexHost harness（ZCode 即是），在该产品内指挥执行模型，不经 `codexhost delegate`。不得把 DSH 目录里的其他 GLM 版本当成用户点名的 Flash。

窗口内角色：

- **用户指定的控制面（如 ZCode）是唯一父会话**：按队列一次只派一个 TASK，核对 diff 是否落在 allowlist，跑或复核验收命令，决定下一个 TASK 或停止。不得让执行模型再转派、重做路线图或改 `todo.md` / 路线图 / 验证器 / expert 默认。
- **指定 Flash（如 GLM 5.3 Flash）只执行**：只改 allowlist，不规划、不升级范围、不 commit/push。TASK 含糊、验收失败、越界或触及门禁时立刻停止并保留 diff，交回父会话。
- **独立审查不在窗口内用同一 Flash 完成**。执行模型不得审自己的 diff。窗口结束后由 Grok / Antigravity（Codex 不可达时）或 Sol / `high`（Codex 恢复后）做跨家族只读审查。父会话对 allowlist 和退出码的核对是编排检查，不是 Sol PASS。

纪律：

- 单一写入者：窗口内执行模型在写时，Grok / Codex / Antigravity 不得写同一 allowlist。用户既有未提交文件仍不可回退或混入。
- 活文档：`todo.md` 与路线图只在 TASK 验收通过且用户确认后，由窗口父会话串行更新；禁止 Flash 顺手改停止线。
- 窗口结束（到用户声明的截止点，或用户提前收回）：父会话必须留下交接——实际改动文件、命令与退出码、未跑项、剩余队列、脏工作树与用户既有改动的区分。后续控制面从该交接继续，不重规划已完成 TASK。
- 控制面优先级：用户正在生效的窗口（ZCode 活动窗口或 Grok 专场，且已按该窗口规则贴入声明和 TASK 队列）> ChatGPT 额度耗尽降级 > Codex 默认 Luna / Terra / Sol。同一时刻只允许一个窗口；ZCode 与 Grok 专场时间重叠时，以用户当场指定的那一个为准，未指定则两侧都不得写入，回到声明前的控制面。只在 Codex/Grok 侧声明、或已过点、或用户在任一侧收回后，立即回到当时适用的那一层。

### Grok 专场：自定义窗口内尽快消耗 Grok 额度

Grok 专场同样**没有默认时刻表**。目的是在用户给出的起止内，把 Grok 额度花在已经写好的 TASK 队列上，而不是省着不用，也不是为烧额度而发明工作、重跑正式评测或自我审查。

用户声明时至少给出：起止（含时区）、本窗口为「Grok 专场」。思考档固定 `grok-4.6` / `xhigh`，未点名也不得降到 `high`。可另给重复规则；没有就只跑这一次。不改硬门、停止线、expert 默认。

在哪里声明：

- Codex 仍是父控制面时：**先在 Codex 声明**，让它写出本窗口 TASK 队列并让出工作树；**再在 Grok 客户端（Grok Build 或 CodexHost `grok`）贴入同一段声明 + 队列** 后才开工。只在 Codex 说一声不算专场生效。
- ChatGPT 额度已尽、当前父会话就是 Grok 时：**在这个 Grok 会话里声明即可**（授权与执行同一处）。若要第二个不相交写入者，把第二条 TASK 贴进另一个 Grok 会话，并写明 allowlist 不相交。
- 收回时在已声明的那一侧说一声，或等到截止点。

准入（缺一不可）：

- 当前时刻落在用户声明的起止之内。
- 本窗口 TASK 队列已按固定模板写好，且都是停止线允许的代码/测试/文档缺口。队列空了就停，不得为耗额度去读 `todo.md` 新编任务、循环跑 `verify.ps1 -FullData`、消费正式种子或重复审查同一 diff。
- 独立审查仍走 Antigravity（Codex 不可达）或 Sol / `high`（Codex 恢复后）。Grok 不得审自己的 diff，也不得把专场消耗写成 Sol PASS。

窗口内怎么加速消耗（只对已排队 TASK）：

- Grok 是唯一父会话，按队列尽快执行；思考档固定 `grok-4.6` / `xhigh`。
- 最多两个 Grok 写入者，且 allowlist 必须不相交；共享文件仍由父会话串行合并。
- 不要再把可做的队列项留给 Codex / GLM / DSH。独立审查按 CodexHost 委派技能执行：先 `codexhost delegate --help`，再 `harness inspect antigravity --cwd <repo>`，只用返回的 ID 做 `delegate start --harness antigravity --model gemini-3.8-flash --thinking high`。不要打开 Antigravity 客户端确认 live skip-permissions；权限用 inspect 默认 Configured（`configured`）即可，不传 `--permission`。Antigravity 只读、不抢写。
- 单条失败则保留 diff、跳过或停止由父会话决定，不得靠重试同一 TASK 空转烧额度。

窗口结束时留下交接（改动文件、命令与退出码、未跑项、剩余队列、用户既有脏文件）。之后回到当时适用的控制面；专场里的代码门通过仍不是发布或晋级证据。

## 实施、测试与交付

先形成可验证的验收条件，再做最小、可回退的实现。测试与改动风险相称：先运行相关快速测试，必要时使用统一入口 `pwsh -NoProfile -ExecutionPolicy Bypass -File .\tools\verify.ps1`；仅在本机大数据可用且任务相关时追加 `-FullData`。发布证据任务必须追加 `-ReleaseEvidence`，且只有命令退出 0、验证器明确输出 `releaseEvidenceReady=true` 和 `promotion.promoted=true` 才算通过。不要为了宣称通过而跳过失败项、放宽阈值、混合指标或以烟雾结果替代正式评测。文档或代理配置专改可做静态格式、TOML 和修改范围验证，不强制全套项目测试，但交付时必须说明未运行原因。耗时评测、训练、正式种子消耗、网络操作或影响发布的操作，须符合 `todo.md` 当前停止线和用户授权。

交付报告应包含：基线中已有改动、本次修改文件、实际运行的命令及退出结果、未运行项目及原因、独立审查结论（Sol，Codex 不可达时的 Antigravity 跨家族审查，或活动窗口结束后的跨家族审查）、门禁状态和剩余风险。报告不得把“进程仍在运行”、小样本、旧产物或未完成 checkpoint 说成完成或通过；Codex 不可达或活动窗口内不得把缺失的 Sol、ZCode 编排核对或 Flash 自评写成通过。

## AI、价值模型、搜索与外部数据的诚实晋级门禁

专家策略保持默认，除非当前冻结代码在同一提交上具备完整、可复算且互相绑定的晋级证据。当前关键硬门包括：全 13 级、`same-deal-cross-level-blocks`、至少 500 镜像对、零失败/死锁/镜像不一致、`opponentModelMode=off`，以及 `candidatePairedUtilityBootstrap95` 下界大于 0；`searchTriggered` P95 不高于 500ms、P99 不高于 750ms，且真实覆盖满足当前 `todo.md` 与验证器要求。连续赛、盲评、默认验证、`-FullData`、远端 CI 和浏览器验收必须按当前 `todo.md` 与同一冻结提交互绑。代码、`todo.md` 或验证器若收紧任何数值或规则，以更严格的当前规则为准，绝不降低。任一硬门未过、报告语义不匹配或验证器非零，即保持 `experimental`/`validated`（按当前代码定义）和 expert 默认，不得曝光到 UI。

搜索性能必须单独审计 `searchTriggered` 的样本量、覆盖率、P95/P99、回退与分段表现；不得用总体快速回合稀释尾延迟，也不得静默减少搜索覆盖或放宽阈值。checkpoint/resume 必须验证运行依赖、种子×级别×队伍覆盖、计数和数据一致性；中断、可解析篡改或不完整状态不是完成证据。

外部数据即使规则重放成功，也默认保持 `trainingEligible=false`。只有许可、再分发/商业使用、删除、规则版本、acting-seat、标签和暗牌边界审计均按当前准入规则通过，才可讨论训练准入；公平候选轨迹和外部原始档案继续隔离。不得把外部回放成功等同于可训练。
