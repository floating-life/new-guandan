# 南邮掼蛋竞赛数据安全导入

南邮公开对局中的 `.data` 是连续的 Python pickle 记录，官方 `replay.py`
使用 `pickle.load()`。pickle 可以携带可执行对象，因此训练数据目录中的
`replay.py` 和 `.data` 都不应直接运行或反序列化。

本项目使用独立的原语解释器，只接受数字、字符串、列表、元组、字典等无代码
结构；遇到 `GLOBAL`、`REDUCE`、`NEWOBJ` 等对象构造指令会整文件拒绝。

```powershell
python .\tools\import_njupt_data.py ".\训练数据\南邮\已解压" `
  --output ".\训练数据\标准化\njupt.jsonl" `
  --rejected ".\训练数据\标准化\njupt-rejected.jsonl"
```

默认输出：

- `训练数据/标准化/njupt.jsonl`：成功导入的 `.data` 游戏和 `.ros` 三局两胜结果；
- `训练数据/标准化/njupt-rejected.jsonl`：损坏、危险、命名不合规或孤立的文件。

每个成功记录均保留本地相对路径、字节数、SHA-256、官网来源页；如果下载器留下
`.extracted.json`，还会关联原始 RAR 文件名、RAR 的 SHA-256 和解压时间。`.data` 还保留
逐条原始记录、pickle 字节区间和标准化事件。空的 `.data_R1_R2` 文件会被关联到
对应 `.data`，把 `R1/R2` 写入 `finalLevels`。空 `.ros` 文件从文件名右侧解析
比分、日期和时间。

导入结果属于包含四家初始牌的原始全状态档案。训练时必须再生成“本家手牌 +
公开历史”的座位视图，禁止把另外三家的暗牌输入实际出牌模型。
所有导入行因此先标记为 `trainingEligible: false`、`projectRuleReplay: pending`；
必须通过本项目规则重放和座位视图转换后才能进入训练集。

回归测试：

```powershell
python .\tools\test_import_njupt_data.py
```
