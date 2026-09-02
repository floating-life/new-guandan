/**
 * STRAT-6 只汇总驱动：读取现有正式/烟测报告与 checkpoint，产出消融汇总文件。
 * 只消费既有产物，绝不重跑评测；不要用 strat6_ablation.mjs --execute 重跑正式臂
 * （那会以新 checkpoint 重新 spawn 三臂，而不是汇总现有产物）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadStrat6Registry,
  loadStrat6Artifacts,
  summarizeStrat6Arm,
  decidePromotion,
  STRAT6_SUMMARY_SCHEMA,
} from './strat6_ablation.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function resolveArmReportPath(reportDir, role, arm) {
  const candidates = [
    path.join(reportDir, `eval-strat6-${role}-${arm.id}.json`),
    path.join(reportDir, `strat6-${role}-${arm.id}.json`),
  ];
  const reportPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!reportPath) {
    throw new Error(`缺少 ${arm.id} 臂报告：${candidates.join(' 或 ')}`);
  }
  return reportPath;
}

export function summarizeStrat6Artifacts(registry, role, reportDir) {
  if (!registry?.[role]) throw new Error(`registry 缺少 ${role} 角色`);
  const summaries = registry.arms.map((arm) => {
    const reportPath = resolveArmReportPath(reportDir, role, arm);
    const checkpointPath = reportPath.replace(/\.json$/, '.checkpoint.json');
    const checkpointExists = fs.existsSync(checkpointPath);
    if (!checkpointExists) {
      throw new Error(`缺少 ${arm.id} 臂 checkpoint（分层需要逐局数据）：${checkpointPath}`);
    }
    const { report, checkpoint } = loadStrat6Artifacts(reportPath, checkpointPath);
    return summarizeStrat6Arm(report, arm, checkpoint);
  });
  return {
    schema: STRAT6_SUMMARY_SCHEMA,
    role,
    baseSeed: registry[role].baseSeed,
    groupCount: registry[role].groupCount,
    promotion: decidePromotion(summaries),
    summaries,
  };
}

function parseArgs(argv) {
  const options = {
    role: 'formal',
    registry: path.join(root, 'tools', 'strat6-seed-registry.json'),
    reportDir: path.join(root, 'data'),
    stdout: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--formal') options.role = 'formal';
    else if (arg === '--smoke') options.role = 'smoke';
    else if (arg === '--stdout') options.stdout = true;
    else if (arg === '--registry' && argv[index + 1]) options.registry = path.resolve(argv[++index]);
    else if (arg === '--report-dir' && argv[index + 1]) options.reportDir = path.resolve(argv[++index]);
    else if (arg === '--out' && argv[index + 1]) options.out = path.resolve(argv[++index]);
    else if (arg === '--help' || arg === '-h') options.help = true;
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log('用法：node tools/strat6_summarize.mjs [--formal|--smoke] [--report-dir DIR] [--out FILE] [--stdout]');
    return 0;
  }
  const registry = loadStrat6Registry(options.registry);
  const output = summarizeStrat6Artifacts(registry, options.role, options.reportDir);
  const outPath = options.out || path.join(options.reportDir, `strat6-${options.role}-summary.json`);
  if (options.stdout) {
    console.log(JSON.stringify(output, null, 2));
    return 0;
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`STRAT-6 ${options.role} 汇总写入 ${outPath}`);
  console.log(JSON.stringify(output.promotion, null, 2));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
