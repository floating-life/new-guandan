# 外部掼蛋训练数据

本目录保存从公开来源取得的原始对局、来源清单和结构化结果。数据只供本机研究，
不会自动进入 AI 训练，也不会随公开 GitHub 仓库提交。

## 当前数据快照

截至 2026-08-27，本次导入的数据工件（不含本说明）共 537 个。

### 南邮比赛数据

- 来源：<https://gameai.njupt.edu.cn/gameaicompetition/result/index.html>
- 47 个 RAR 已全部保存并独立解压：46 个对局包、1 个复盘说明包；RAR 合计 498,523 字节。
- 原始内容包含 139 个 `.data`、138 个 `.data_R1_R2`、46 个 `.ros` 和 47 个解压校验标记。
- 标准化结果包含 139 局及 46 条三局两胜系列结果，拒绝 0 条。
- 138 局结构完整；1 局源文件不完整（无动作、终局和等级标记），已保留并明确标记。
- 另有 4 局在终局后重复记录动作，导入器保留原值并添加警告，没有静默修复。

### Botzone 公开对局

- 来源：<https://www.botzone.org.cn/globalmatchlist?game=65490c16ec1ab1389702dced>
- 已保存 5 个公开列表页和最近 100 个公开比赛详情页，页面抓取拒绝 0 条。
- 91 局通过结构校验；9 局因源 Bot 的响应裁决不是 `OK` 而隔离，未猜测或修复缺失动作。
- Botzone 官方下载页指向的月度 ZIP 主机当前存在 TLS 证书主机名不匹配；程序没有关闭证书校验，改用匿名公开回放页作为来源。

总计取得 239 个来源对局候选，写入 230 条标准化游戏记录，其中 229 条结构完整。
当前真正通过训练门禁的记录仍为 **0**。即使严格重放通过，也只生成隔离公平轨迹，
`trainingEligible` 固定为 `false`；外部数据不会自动进入当前 self-play 训练器。

## 目录

```text
训练数据/
├─ 南邮/压缩包/                 # 47 个原始 RAR
├─ 南邮/已解压/                 # 每包独立目录及 .extracted.json
├─ 南邮/清单/njupt_archives.json
├─ 标准化/njupt.jsonl
├─ 标准化/njupt-rejected.jsonl
└─ Botzone/
   ├─ raw/public_pages/         # 原始公开 HTML 与原始 JSONL
   ├─ manifests/                # URL、相对路径、SHA-256
   ├─ normalized/botzone_matches.jsonl
   ├─ rejected/                 # 页面和对局拒绝清单
   └─ reports/                  # 下载、抓取和导入摘要
```

所有持久化清单使用相对路径，不记录 Windows 用户名或工作区绝对路径。

## 可复现命令

```powershell
# 南邮：重新发现全部官网链接、校验缓存、独立解压并重建清单
python .\tools\download_njupt_archives.py --output ".\训练数据\南邮"

# 南邮：安全解析，不运行 replay.py，也不使用 pickle.load
python .\tools\import_njupt_data.py ".\训练数据\南邮\已解压" `
  --output ".\训练数据\标准化\njupt.jsonl" `
  --rejected ".\训练数据\标准化\njupt-rejected.jsonl"

# Botzone：默认重新验证最新列表页，已有详情页继续使用缓存
python .\tools\import_botzone_guandan.py public `
  --output ".\训练数据\Botzone" --limit 100 --delay 0.75 --timeout 30 --retries 3

# 完全离线、只用已保存页面复现当前快照
python .\tools\import_botzone_guandan.py public `
  --output ".\训练数据\Botzone" --limit 100 --delay 0.75 --offline-cache
```

## 进入训练前的强制门禁

这些档案包含四家初始牌，不能直接喂给实战模型。后续必须依次完成：

1. 用本项目规则引擎逐手重放，验证每次牌型声明、压制关系、贡还、接风、终局和升级结果；
2. 对每个行动座位生成“本家手牌 + 当时公开历史”的独立观察，删除其他三家的暗牌；
3. 检查特征中不存在终局信息、未来动作、其他座位暗牌或来源泄漏；
4. 在取得来源授权、完成标签审计和 OOD 评估后，才可由单独的外部训练流程改变
   `trainingEligible`；本项目当前不会自动执行这一步；
5. 模型必须通过同牌换座、未见种子 A/B 和真人对局门禁后，才能进入正式 AI。

## 外部回放验证

`tools/replay_external_to_v2.mjs` 不会修改本目录中的原始档案。它以来源局为
边界，用本项目的 JavaScript 规则引擎逐手检查持牌、牌权、牌型、压制、过牌
收圈、接风、终局和还贡约束；只有完整重放成功的局才会生成“本家手牌 + 当时
公开历史”的公平轨迹。

```powershell
node .\tools\replay_external_to_v2.mjs --output ".\训练数据\验证"
node .\tools\test_replay_external_to_v2.mjs
```

输出的 `external-trajectory-v2.jsonl` 是外部来源的公平轨迹，不等同于自对弈
`guandan-selfplay-trajectory-v2`，且 `trainingEligible=false`，不会被现有训练器自动接收。`external-replay-
rejected.jsonl` 会保留逐局失败原因；拒绝不会被修补为“通过”。

同一命令还会生成 `external-wind-adapter-report.json`。这是接风规则方言的只读
实验：它只检查“对家可响应”和“对家接风标记”两种来源语义能否让整局闭合，输出状态
始终为 `projectRuleReplay=adapter_candidate`、`trainingEligible=false`，不生成训练轨迹，
不能替代正式项目规则回放。

## 安全与授权

- 不执行来源包中的 `replay.py`；南邮 pickle 由只允许原语的解释器读取，危险 opcode 会拒绝。
- ZIP/RAR 解压前检查路径越界、符号链接和特殊文件；Botzone ZIP 还检查 Windows 保留名、ADS 和大小写碰撞。
- 原始网页可能含公开 Bot 名称、日志和头像路径。不要把本目录上传、公开分享或用于商业训练，除非先取得来源方许可并确认其数据政策。
- `.gitignore` 默认排除本目录除本说明外的所有内容，但不会删除本机文件。
