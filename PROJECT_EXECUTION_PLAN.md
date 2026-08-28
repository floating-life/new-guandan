# 项目执行总计划

目标：把掼蛋 AI 从“能运行、能做实验”推进到“数据可追溯、评测可复现、发布有硬门”。

## M0：数据与模型发布安全（已实施）

1. **种子 provenance**：自对弈数据头写入 `guandan-seed-manifest-v1`；训练模型记录
   数据集 SHA-256、基础种子、完整种子清单；A/B 报告记录评估种子清单。
2. **未见种子硬门**：晋级前必须同时存在训练和评估种子清单，且集合无交集；缺失或
   重叠统一拒绝，不能再用“基础种子范围”推断未见性。
3. **发布回执**：网页可加载的 `promoted` 模型必须带模型源哈希、完整级别覆盖、
   计划/完成局数、零失败/死锁/镜像偏差、正向置信下界、评测种子和训练种子回执。
   仅修改 `metadata.status` 不再能够绕过门禁。
4. **外部数据隔离**：严格项目规则重放通过的外部轨迹也保持 `trainingEligible=false`；
   接风适配轨迹继续隔离。外部标签校验现在严格检查 acting seat 对应的胜负符号、名次、
   终局排列，拒绝“只要正负任一匹配”的宽松标签。

## M1：工程化交付与可复核验证（已实施）

1. `stats.importTrainingData` 改为三键事务式导入：写入任一环节失败会恢复战绩、设置和
   复盘的旧值，不留下半导入状态。
2. 新增 `tools/verify.ps1` 统一入口，覆盖差异检查、JS/MJS、Python、PowerShell 语法，
   核心单测、Worker、完整对局、外部转换器和 Python 导入器；`-FullData` 才读取本机大数据，
   并检查所有外部回放产物仍为隔离标签。
3. 自对弈、训练和 A/B 产物默认由 `.gitignore` 排除；明确晋级的模型回执可单独提交，
   外部原始档案继续只保存在本机。
4. 新增 Windows CI 工作流，在干净环境执行默认验证入口。

## 当前证据与注意事项

- 既有 `data/` 中的自对弈、模型和 A/B 报告是在 M0 之前生成的历史产物：旧报告存在训练/
  评估种子重叠，旧模型没有 provenance，不能作为晋级证据。
- 重新生成链路时必须使用互不重叠的种子批次；旧产物不会被自动当作新证据。
- 外部重放输出目录也需重新运行转换器，才能使历史严格轨迹反映新的隔离标签。
- 当前没有 `promoted` 模型，网页继续使用专家策略作为默认；这是预期的安全状态。

## M2：数据规模与可恢复链路（已完成）

1. **增量与恢复（已完成）**：`selfplay_dataset.mjs` 按副写入临时记录文件，保存
   `guandan-selfplay-checkpoint-v1`；`--resume` 会校验输出路径、种子、记录数和安全字节位置，
   中断时丢弃未提交尾部后从最后一副继续。校验器逐行读取，训练器逐行读取并分块计算 SHA-256，
   不再把整个 JSONL 文本复制到内存。
2. **首个干净训练批次（已完成）**：`data/selfplay-20260901.jsonl` 使用种子
   `20260901–20260940`，40 个完整牌局、3,859 条轨迹；与历史 `20260827–20260866` 无交集。
   新模型为 `data/value-model-20260901-experimental.json`，按完整牌局 32/8 留出，训练和留出
   均优于训练均值基线；模型仍是 `experimental_unvalidated`，尚未进入网页。
3. **历史正式评测（已完成但不可晋级）**：使用训练集之外的 `920000–920039` 种子完成 40 个基础牌区组、
   13 级、双腿换座共 1,040 局，得到 520/520 镜像组、0 失败/死锁/偏差。升级效用为 `+0.010/局`，
   配对 bootstrap 95% 为 `-0.008～+0.029`，下界跨 0。该报告采用早期文件摘要口径，不能为当前语义权重摘要模型背书；
   因此不得生成或加载 `promoted` 模型，网页仍使用专家默认策略。
4. **后续可选**：视资源再追加相邻且不重叠的批次并合并统计；只有新的评测下界稳定为正且 M3
   发布质量门禁通过，才重新申请晋级。

## M3：发布质量（连续赛证据已完成，主 A/B 仍待重评）

逐级最低表现、连续赛、长局/贡还覆盖的门禁代码已实施。2026-08-28 已用语义摘要模型完成
`root-pimc-v1` 的独立连续赛：`baseSeed=931000–931003`，8/8 场、4/4 镜像组、0 失败/死锁/偏差，
覆盖 113 轮、92 个贡还轮和 11 个 ≥120 动作长轮。它不能与旧文件摘要的主 A/B 拼接为发布回执，且历史主 A/B
置信下界仍跨 0。后续必须以当前语义摘要重跑完整主 A/B，并获得严格正的置信下界；浏览器人工试玩和性能基线
同样应完成。任何失败、摘要不匹配或收益下界不为正都保持专家默认。

## 常用命令

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tools\verify.ps1
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tools\verify.ps1 -FullData
node .\tools\selfplay_dataset.mjs 40 20260901 .\data\selfplay-20260901.jsonl
node .\tools\selfplay_dataset.mjs 40 20260901 .\data\selfplay-20260901.jsonl --resume
node .\tools\validate_value_dataset.mjs .\data\selfplay-20260901.jsonl
python .\tools\train_value_model.py .\data\selfplay-20260901.jsonl .\data\value-model-20260901-experimental.json 350
node .\tools\validate_value_model.mjs .\data\value-model-20260901-experimental.json
```
