# 现代 DMC 训练系统（预训练门禁阶段）

浏览器项目仍是掼蛋规则与产品行为的真源。本目录只容纳现代 Python/PyTorch 训练代码和模型包规范，不复制或嵌入旧 DanZero 的 TensorFlow 运行环境。

## 当前状态

- 已定义 `guandan-env-v1` 的可交换状态、动作、奖励和转换记录契约。
- `verify_conformance.py` 只会在 100,000 条以上转换、零差异且存在独立 Python 规则适配器回执时输出 `conformanceReady=true`。
- `dmc_preflight.py` 在没有该回执、公平自对弈数据清单、许可记录和完整评测回执时拒绝启动训练。
- 本机尚未安装 PyTorch 或 ONNX，也没有完成 Python 规则适配器；因此本目录**不能训练或导出任何可部署模型**。

## 训练前顺序

1. 让 JS 规则引擎导出带完整合法动作集的公平自对弈转换记录。
2. 实现独立 Python 规则适配器，逐条比较贡还、接风、升级、打 A 与全部合法动作。
3. 生成 `guandan-conformance-receipt-v1`：至少 100,000 条、零差异、输入与输出摘要齐全。
4. 运行 `python training/dmc_preflight.py --conformance-receipt ... --dataset-manifest ... --license-record ...`。
5. 仅在获得授权的远程 GPU 环境安装 [requirements-train.txt](./requirements-train.txt)，以公平自对弈热启动并训练 DMC。
6. 导出 `guandan-dmc-model-v1` ONNX 包，经过同牌跨级与严格发布证据门禁后，才允许 Worker 加载。

## 外部参考与归属

- DanZero 论文：<https://arxiv.org/abs/2210.17087>。
- 原始代码参考：<https://github.com/AltmanD/guandan_mcc>，Apache-2.0，固定参考提交 `e816ca3af431678903d051365d7c19a6dd4ebdb8`。本项目尚未复制其代码；未来若复用受许可代码，必须保留 NOTICE 与许可证文本。
- DanZero+：<https://github.com/submit-paper/Danzero_plus>，当前参考提交 `e2b900b01096e0743de945f9963df35cd544f36d`。在许可证完成核验前只可参考论文与结构，不可合并代码或权重。
