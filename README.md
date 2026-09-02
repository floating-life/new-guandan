# 掼蛋训练大师 · 1v3 AI

本机运行的掼蛋训练网页：**你 + 对家 AI** 为一队，**上家 / 下家 AI** 为对手。

当前诚实默认：**专家策略**。没有 `promoted` 模型；`ismcts-v3` 只用于离线评测，不在产品选择器里。目标、硬门和证据台账见 [整体项目路线图.md](./整体项目路线图.md)，近期待办见 [todo.md](./todo.md)。

## 登录网址：127.0.0.1 + 端口

本项目没有账号和密码。固定地址：

**http://127.0.0.1:20801/**

### Windows 一键启动

1. 双击 **`启动本机版.cmd`**。
2. 启动窗口会打开 `http://127.0.0.1:20801/`。
3. 保持窗口开启；`Ctrl+C` 停止。

或手动：`.\start-lan.ps1`。服务只绑定本机回环，不开放防火墙，也不托管 README、训练数据或项目目录。不要直接双击 `index.html`。

## 当前能力

| 模块 | 说明 |
|------|------|
| 规则引擎 | 完整牌型、逢人配多解、升级、进贡还贡、打 A |
| 默认 AI | 四档难度；网页默认专家策略，不读未公开手牌 |
| 实验搜索 | PIMC / 成对根 PIMC / ISMCTS v2 可选；v3 仅离线。失败回退专家 |
| 对手画像 | 公开行动 v3（含 v1/v2 迁移）；`off / observe / adaptive` |
| 教练与评价 | 主推荐、五维评分、逐手复盘；最近 100 副可导出 |
| 数据 | 仅浏览器 `localStorage` 与批准的本机应用数据目录 |

## 操作说明

开始游戏后单击选牌，点数标题循环选中，`Shift` 连选。合法时出牌，无法领出时可过牌。教练建议需点「采用此建议」才改变选牌。还贡只高亮允许的牌。

快捷键：`Enter` 出牌/确认还贡 · `Space` 过牌 · `Esc` 取消 · `H` 提示 · `C` 教练。

## 数据与隐私边界

- 对局、设置、复盘、进行中存档在浏览器 `localStorage`；更换端口/浏览器/用户资料后数据彼此独立。
- 默认完全离线。可选云端增强只经本机 `127.0.0.1` 网关重排**已筛选的合法候选**，不提交未公开手牌；API Key 不进页面存储，网页保存时用 Windows DPAPI 写入 `%LOCALAPPDATA%\GuandanTrainer\llm-config.json`。
- 实时复盘采集默认关闭，须 `start-lan.ps1 -EnableReplayCollector` 才写入本机应用数据目录。
- 外部对局与密封训练候选默认 `trainingEligible=false`。细节见 `训练数据/README.md`。

## 验证

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tools\verify.ps1
```

加 `-FullData` 才校验本机大数据；加 `-ReleaseEvidence` 才跑发布互绑（当前预期失败，因为没有 `promoted` 模型）。评测命令、种子清单和历史回执只放在路线图与 `todo.md`，避免 README 再堆已作废数字。

## 回滚

1. 停止启动窗口。
2. 需要时可清浏览器本源 `localStorage`（会丢掉未导出的统计/复盘）。
3. 用 git 回到已知提交后重新运行 `启动本机版.cmd`。
4. 实验引擎或画像异常时，设置里把本地引擎改回「专家策略」，对手画像改「关闭」。

## 目录（摘要）

`index.html` 页面入口；`js/` 规则、AI、评价、复盘与测试；`lan_server.py` / `start-lan.ps1` 本机服务；`tools/` 评测与校验；`训练数据/` 外部档案（默认不入库）。

## 云端增强（可选）

「AI策略」默认 `本地 AI`。`智能增强` / `云端增强` 只让云端在本地安全候选中重排。环境变量 `GUANDAN_LLM_API_URL` / `GUANDAN_LLM_API_KEY` / `GUANDAN_LLM_MODEL` 优先于本机密文配置。远程必须 HTTPS。报告不保存 Key 或完整牌面。独立探针：`python .\tools\llm_smoke.py`。
