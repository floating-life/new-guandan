/**
 * 依据未见种子镜像赛报告晋级本地价值模型。
 *
 * 用法：
 *   node tools/promote_value_model.mjs <实验模型.json> <A-B报告.json> <输出模型.json>
 *     --continuous-report=<连续对局报告.json>
 *
 * A/B报告必须由带 --value-model、--levels=all、--level-blocks、--summary-only、
 * --json 的 ai.ab.simulation.js 生成。轮换级牌或少于500组镜像、存在失败时
 * 不写晋级文件；还必须提供独立连续对局报告，覆盖贡还和长局路径。安全门通过
 * 但收益置信或 M3 质量门不足时，只写出网页不可加载的 validated 模型。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { validateHybridValueModel } from '../js/ai-hybrid.js';
import { evaluateValueModelPromotion, VALUE_MODEL_STATUS } from '../js/value-model-gate.js';
import { modelPayloadSha256 } from '../js/model-fingerprint.js';

const [modelArg, reportArg, outputArg] = process.argv.slice(2);
const continuousFlag = process.argv.find((item) => String(item).startsWith('--continuous-report='));
const continuousReportPath = continuousFlag
  ? path.resolve(String(continuousFlag).slice('--continuous-report='.length)) : null;
if (!modelArg || !reportArg || !outputArg) {
  throw new Error('用法：node tools/promote_value_model.mjs <实验模型.json> <A-B报告.json> <输出模型.json> --continuous-report=<连续对局报告.json>');
}

const modelPath = path.resolve(modelArg);
const reportPath = path.resolve(reportArg);
const outputPath = path.resolve(outputArg);
const modelBytes = fs.readFileSync(modelPath);
const model = JSON.parse(modelBytes.toString('utf8'));
const reportBytes = fs.readFileSync(reportPath);
const report = JSON.parse(reportBytes.toString('utf8'));
const continuousReportBytes = continuousReportPath ? fs.readFileSync(continuousReportPath) : null;
const continuousReport = continuousReportBytes
  ? JSON.parse(continuousReportBytes.toString('utf8')) : null;
const validation = validateHybridValueModel(model);
if (!validation.ok) throw new Error(`模型格式无效：${validation.reason}`);

const modelSha256 = modelPayloadSha256(model);
if (!modelSha256) throw new Error('模型无法生成稳定权重摘要');
const primaryReportSha256 = createHash('sha256').update(reportBytes).digest('hex');
const continuousReportSha256 = continuousReportBytes
  ? createHash('sha256').update(continuousReportBytes).digest('hex') : null;
const gate = evaluateValueModelPromotion(report, modelSha256, {
  continuousReport,
  continuousReportSha256,
});
if (gate.status === VALUE_MODEL_STATUS.EXPERIMENTAL) {
  console.error(JSON.stringify({
    ok: false, written: false, model: modelPath, report: reportPath, modelSha256, gate,
  }, null, 2));
  process.exitCode = 1;
} else {
  const promoted = {
    ...model,
    metadata: {
      ...(model.metadata || {}),
      status: gate.status,
      modelSha256,
      validation: {
        checkedAt: new Date().toISOString(),
        primaryReportSha256,
        candidate: report.config?.candidate || null,
        comparison: report.config?.comparison || null,
        baseSeed: report.config?.baseSeed ?? null,
        evaluationSeedManifest: report.config?.evaluationSeedManifest || null,
        evaluationLevels: report.config?.evaluationLevels || [],
        ...gate.metrics,
      },
    },
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(promoted, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    ok: true,
    written: true,
    promoted: gate.promoted,
    status: gate.status,
    output: outputPath,
    modelSha256,
    continuousReport: continuousReportPath,
    gate,
  }, null, 2));
}
