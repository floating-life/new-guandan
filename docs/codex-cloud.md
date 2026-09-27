# 在 Codex 云端开发 new-guandan

本配置把 GitHub 上的源码、规则测试与开发验证接入 Codex 云端。游戏仍按现有方式在本机运行。云端容器是任务执行环境，不是常驻游戏服务器，也不接管 Windows 电脑或 RTX 5080。

## 创建环境

在 [Codex](https://chatgpt.com/codex) 的环境设置中连接 GitHub，选择 `floating-life/new-guandan`。本文件和两个脚本合并进默认分支后，再创建或重置环境缓存；Codex 初始化缓存时会先取默认分支。

| 配置项 | 值 |
| --- | --- |
| 名称 | `new-guandan` |
| 仓库 / 默认工作分支 | `floating-life/new-guandan` / `main` |
| 镜像 | `universal`（Ubuntu） |
| Node.js | `22`，与现有 GitHub Actions 一致 |
| Python | `3.12`，与现有 GitHub Actions 一致 |
| Setup script | `bash tools/codex-cloud-setup.sh` |
| Maintenance script | `bash tools/codex-cloud-setup.sh` |
| 环境变量 | `PYTHONUTF8=1`；`PYTHONIOENCODING=utf-8`；`POWERSHELL_TELEMETRY_OPTOUT=1` |
| Agent internet access | 初始关闭；源码修改和默认离线测试无需外网 |
| Secrets | 初始不填写；源码验证无需模型 API Key |

Setup/maintenance 仅检查与准备依赖，不启动服务、下载训练数据或执行训练任务。缺少 PowerShell 时使用微软官方 Ubuntu 软件源安装；缺少 PyTorch 时使用官方 CPU wheel 源安装。可用的既有安装会复用，版本会打印到日志。安装需要容器内 root 或无交互 sudo；不适用时明确失败，不静默跳过。

初始化阶段需要访问 Ubuntu 软件源、`packages.microsoft.com`、`download.pytorch.org` 及依赖下载地址。按 Codex 官方说明，Setup 阶段允许联网，表中的关闭选项针对后续 agent 阶段；若工作区另有出网限制，须由相应管理员允许这些依赖源，不能把安装失败标成就绪。两个入口都会在启动 PowerShell 前关闭其可选遥测；环境设置中的同名变量也覆盖直接运行 PowerShell 的任务。

这是幂等依赖初始化，不是依赖锁文件；依赖版本跟随当前环境和官方源。需要精确复现实验时另行冻结环境版本并记录完整证据。修改依赖或发现缓存不兼容时使用 **Reset cache**。Setup 中临时 `export` 不会传到 agent，所以持久环境变量应按上表在设置里填写。

## 首次验收任务

环境创建成功后，在 `main` 上提交下面的云端任务：

```text
核验 new-guandan 云端环境，不做业务改动。
先读取 AGENTS.md、todo.md 当前区、整体项目路线图.md 当前区和 docs/codex-cloud.md；
检查 git status、分支、提交 SHA，使用实际仓库根目录，不使用历史 Windows 绝对路径。
运行 bash tools/codex-cloud-check.sh。
报告运行时版本、各失败项或跳过项及最终退出码；现有 Windows 专用分支未执行须如实说明。
不下载外部数据、不采集自对弈、不执行完整训练、FullData、ReleaseEvidence、正式评测或保护确认集。
不改 expert 默认、门槛、UI、todo 或路线图，不提交或推送。
验证失败先诊断并报告，不删测试、不降低门槛；不要根据历史报告宣称通过或晋级。
```

`tools/codex-cloud-check.sh` 先验证 Node、Python、PowerShell 和实际训练模块能导入，再原样调用 `tools/verify.ps1`。因此 torch 缺失会直接失败，不会依赖现有测试的自动 skip。默认验证含既有的小型合成训练测试，不会执行路线图上的完整学习实验。

后续小改动继续遵循 `AGENTS.md`，优先运行相关定向测试。不要每次都重复全套验证。依赖检查可单独运行：

```bash
bash tools/codex-cloud-check.sh --preflight
```

## 迁移范围与本地衔接

| 内容 | 本次如何处理 |
| --- | --- |
| GitHub 已提交源码、测试、AGENTS.md、路线文档 | 随仓库检出；每个任务核对实际 SHA |
| Windows 本地未提交、未推送修改 | 云端看不到；在原电脑审查并提交目标修改后才能同步 |
| `data/`、`训练数据/`、训练模型与 checkpoint | 现有忽略规则继续有效；本次未上传、未重建，旧本地任务进度不能视为云端现状 |
| 浏览器战绩、localStorage、复盘、Windows DPAPI 密钥 | 本次未迁移；不得把密钥或私人数据放入公开仓库 |
| CodexHost / Grok / Claude / DSH / Antigravity | 本机程序、会话和授权不会随 GitHub 自动迁移；云端没有该能力时报告不可用，不假装委派或审查通过 |
| 代理型号与独立审查 | 保留现有 AGENTS 规则；核对云端实际支持的能力。要求的审查者不可用时明确列为未完成，不自动替换身份 |
| Windows 专属功能和测试 | 由现有 Windows CI / 本机继续覆盖；Linux 通过不等于 DPAPI 或 Windows 锁文件分支已通过 |
| 模型晋级和正式发布 | 继续使用现有停止线与完整证据门；默认测试通过不构成晋级 |

本地工作目录仍可继续使用。同步云端结果前先在本机运行 `git status`，妥善保存自己的未提交修改；工作树干净时再 `git pull --ff-only`。不使用 `reset --hard` 或 `clean` 处理本地差异。

需要在容器中临时检查页面时运行 `python lan_server.py`，只监听容器内 `127.0.0.1:20801`。本机浏览器的同名地址不会连接云端容器；不要把服务器改为公网监听来绕过此限制。Linux 不支持现有 Windows DPAPI 保存密钥流程，开发验收使用默认离线模式即可。

官方参考：[Codex 云端环境](https://learn.chatgpt.com/docs/environments/cloud-environment)、[微软 Ubuntu PowerShell 安装](https://learn.microsoft.com/en-us/powershell/scripting/install/install-ubuntu)。
