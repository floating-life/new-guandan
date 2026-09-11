/**
 * LEARN-002 离线学习对照入口。包装既有 A/B CLI，不直接 import
 * 会在加载时自动开赛的 js/ai.ab.simulation.js。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateHybridValueModel } from '../js/ai-hybrid.js';
import { isLearningDecisionEngine, LEARNING_DECISION_ENGINE } from '../js/ai-learning.js';

export const LEARNING_PURPOSE = 'learning-development';
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(moduleDirectory, '..');
const abRunner = path.join(root, 'js', 'ai.ab.simulation.js');

const VALUE_FLAGS = new Set([
  'candidate', 'comparison', 'model', 'blocks', 'base-seed', 'levels',
  'report', 'checkpoint',
]);
const BOOLEAN_FLAGS = new Set([
  'json', 'summary-only', 'level-blocks', 'no-level-blocks',
]);
const UINT32_MAX = 0xFFFFFFFF;

function parsePositiveInteger(raw, label) {
  const text = String(raw);
  if (!/^[1-9]\d*$/.test(text)) {
    throw new Error(`${label} 必须是正整数，收到：${text}`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} 必须是正整数，收到：${text}`);
  }
  return value;
}

function parseNonzeroUint32(raw, label) {
  const text = String(raw);
  if (!/^[1-9]\d*$/.test(text)) {
    throw new Error(`${label} 必须是非零 uint32，收到：${text}`);
  }
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1 || value > UINT32_MAX) {
    throw new Error(`${label} 必须是非零 uint32，收到：${text}`);
  }
  return value;
}

function parseLevels(raw) {
  const text = String(raw).trim();
  if (!text) throw new Error('级牌列表无效：');
  if (text.toLowerCase() === 'all') return 'all';
  const rank = (token) => {
    const normalized = String(token).trim().toUpperCase();
    if (normalized === 'A') return 14;
    if (normalized === 'K') return 13;
    if (normalized === 'Q') return 12;
    if (normalized === 'J') return 11;
    if (!/^[1-9]\d*$/.test(normalized)) return null;
    const value = Number(normalized);
    return Number.isInteger(value) && value >= 2 && value <= 14 ? value : null;
  };
  const tokens = text.split(',');
  if (!tokens.length || tokens.some((token) => rank(token) == null)) {
    throw new Error(`级牌列表无效：${text}`);
  }
  return text;
}

export function parseArenaArgs(argv = []) {
  const seen = new Set();
  const values = {};
  const booleans = {};
  for (const item of argv) {
    const token = String(item);
    if (!token.startsWith('--')) {
      throw new Error(`未知参数：${token}`);
    }
    const eq = token.indexOf('=');
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
    if (seen.has(name)) throw new Error(`重复参数：--${name}`);
    seen.add(name);
    if (BOOLEAN_FLAGS.has(name)) {
      if (eq !== -1) throw new Error(`布尔旗标不得取值：${token}`);
      booleans[name] = true;
      continue;
    }
    if (VALUE_FLAGS.has(name)) {
      if (eq === -1) throw new Error(`参数 --${name} 需要取值`);
      values[name] = token.slice(eq + 1);
      continue;
    }
    throw new Error(`未知参数：${token}`);
  }
  const blocks = parsePositiveInteger(values.blocks ?? '1', '--blocks');
  const baseSeed = parseNonzeroUint32(values['base-seed'] ?? '3400000000', '--base-seed');
  if (blocks > (UINT32_MAX + 1 - baseSeed)) {
    throw new Error(`评测种子范围发生 uint32 回绕：base-seed=${baseSeed} blocks=${blocks}`);
  }
  return {
    candidate: values.candidate ?? 'learned-value-v1',
    comparison: values.comparison ?? 'expert',
    modelPath: values.model,
    blocks,
    baseSeed,
    levels: parseLevels(values.levels ?? 'all'),
    report: values.report,
    checkpoint: values.checkpoint,
    json: booleans.json === true,
    summaryOnly: booleans['summary-only'] === true,
    levelBlocks: booleans['no-level-blocks'] !== true,
  };
}

function comparablePath(value, cwd = root) {
  let resolved = path.resolve(cwd, value);
  const suffix = [];
  let existing = resolved;
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) {
    suffix.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  try { existing = fs.realpathSync.native(existing); } catch { /* lexical fallback */ }
  resolved = path.join(existing, ...suffix);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function assertFreshOutput(target, label, modelPath, cwd) {
  if (!target) return;
  const resolved = path.resolve(cwd, target);
  if (fs.existsSync(resolved)) {
    throw new Error(`拒绝覆盖已有${label}：${resolved}`);
  }
  if (comparablePath(resolved, cwd) === comparablePath(modelPath, cwd)) {
    throw new Error(`${label} 路径不得与模型文件相同`);
  }
}

function markLearningReport(report, modelPath) {
  const valueModel = report?.config?.valueModel && typeof report.config.valueModel === 'object'
    ? {
        ...report.config.valueModel,
        purpose: LEARNING_PURPOSE,
        promoted: false,
      }
    : {
        path: modelPath || null,
        purpose: LEARNING_PURPOSE,
        promoted: false,
      };
  return {
    ...report,
    purpose: LEARNING_PURPOSE,
    promoted: false,
    config: {
      ...(report?.config || {}),
      purpose: LEARNING_PURPOSE,
      promoted: false,
      valueModel,
    },
  };
}

function writeReport(targetPath, report) {
  if (!targetPath) return;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

export function runLocalLearningArena(argv = [], options = {}) {
  const args = parseArenaArgs(argv);
  if (!isLearningDecisionEngine(args.candidate)) {
    throw new Error('local_learning_arena 只接受离线学习候选引擎');
  }
  if (args.comparison !== 'expert') {
    throw new Error('对照策略必须是 expert，避免全局模型污染控制侧');
  }
  if (!args.modelPath) {
    throw new Error('必须提供 --model= 合成或训练模型路径');
  }
  const modelPath = path.resolve(options.cwd || root, args.modelPath);
  if (!fs.existsSync(modelPath)) {
    throw new Error(`学习模型不存在：${modelPath}`);
  }
  const model = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
  if ((model.metadata?.featureEngine || LEARNING_DECISION_ENGINE) !== args.candidate) {
    throw new Error('学习模型 featureEngine 与候选引擎不匹配');
  }
  const validation = validateHybridValueModel(model);
  if (!validation.ok) {
    throw new Error(`学习模型格式无效：${validation.reason}`);
  }
  const cwd = options.cwd || root;
  assertFreshOutput(args.report, 'report', modelPath, cwd);
  assertFreshOutput(args.checkpoint, 'checkpoint', modelPath, cwd);

  const childArgs = [
    abRunner,
    String(args.blocks),
    String(args.baseSeed),
    args.candidate,
    args.comparison,
    `--levels=${args.levels}`,
    `--value-model=${modelPath}`,
    '--json',
  ];
  if (args.levelBlocks) childArgs.push('--level-blocks');
  if (args.summaryOnly) childArgs.push('--summary-only');
  if (args.report) childArgs.push(`--report=${path.resolve(cwd, args.report)}`);
  if (args.checkpoint) childArgs.push(`--checkpoint=${path.resolve(cwd, args.checkpoint)}`);

  const spawn = options.spawnSync || spawnSync;
  const child = spawn(process.execPath, childArgs, {
    cwd,
    encoding: 'utf8',
    ...(Number(options.timeoutMs) > 0 ? { timeout: Number(options.timeoutMs) } : {}),
  });
  if (child.status !== 0) {
    const detail = `${child.stderr || ''}\n${child.stdout || ''}`.trim();
    const error = new Error(`A/B 学习对照失败（exit ${child.status}）：${detail.slice(-1600)}`);
    error.status = child.status;
    error.stdout = child.stdout;
    error.stderr = child.stderr;
    throw error;
  }

  let report;
  try {
    report = JSON.parse(child.stdout);
  } catch (error) {
    throw new Error(`A/B 学习对照未输出 JSON：${error.message}\n${String(child.stdout).slice(-1200)}`);
  }
  const marked = markLearningReport(report, modelPath);
  if (args.report) writeReport(path.resolve(cwd, args.report), marked);
  if (args.json || options.print !== false) {
    process.stdout.write(`${JSON.stringify(marked, null, 2)}\n`);
  }
  return { status: 0, report: marked, child };
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    runLocalLearningArena(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(Number(error?.status) || 1);
  }
}
