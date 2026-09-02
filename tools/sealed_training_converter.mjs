/**
 * RT-5: convert sealed training batches into match-level splits.
 *
 * The converter never marks batches trainingEligible=true and never writes
 * into the live replay GET store or the project tree.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  convertSealedTrainingBatches,
  SEALED_TRAINING_MANIFEST_SCHEMA,
} from '../js/sealed-training.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export class SealedTrainingConverterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SealedTrainingConverterError';
    this.code = code;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function assertSafeOutputDirectory(value) {
  if (!value) throw new SealedTrainingConverterError('bad_path', '输出目录不能为空');
  const target = path.resolve(String(value));
  const relative = path.relative(PROJECT_ROOT, target);
  if (!relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
    throw new SealedTrainingConverterError('unsafe_path', '密封训练输出不得位于项目目录');
  }
  if (target.split(path.sep).some((part) => ['wpsdrive', 'wps云盘'].includes(part.toLowerCase()))) {
    throw new SealedTrainingConverterError('unsafe_path', '密封训练输出不得位于 WPSDrive');
  }
  if (/[/\\]GuandanTrainer[/\\]replays(?:[/\\]|$)/i.test(target)
    || /[/\\]GuandanTrainer[/\\]replay-consumer(?:[/\\]|$)/i.test(target)) {
    throw new SealedTrainingConverterError('unsafe_path', '密封训练输出不得写入公开复盘流或消费者目录');
  }
  let probe = target;
  while (probe && probe !== path.dirname(probe)) {
    if (fs.existsSync(probe)) {
      let stat;
      try { stat = fs.lstatSync(probe); } catch {
        throw new SealedTrainingConverterError('unsafe_path', '密封训练输出路径无法核对');
      }
      if (stat.isSymbolicLink()) {
        throw new SealedTrainingConverterError('unsafe_path', '密封训练输出不得经过符号链接');
      }
    }
    probe = path.dirname(probe);
  }
  return target;
}

export function defaultSealedTrainingOutputDir() {
  const appData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return assertSafeOutputDirectory(path.join(appData, 'GuandanTrainer', 'sealed-training'));
}

export function readSealedTrainingBatches(inputPath) {
  const resolved = path.resolve(String(inputPath));
  if (!fs.existsSync(resolved)) {
    throw new SealedTrainingConverterError('missing_input', '找不到密封批次输入文件');
  }
  const text = fs.readFileSync(resolved, 'utf8');
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.map((line, index) => {
    let value;
    try { value = JSON.parse(line); } catch (error) {
      throw new SealedTrainingConverterError('invalid_input', `输入第 ${index + 1} 行不是 JSON`);
    }
    if (!isRecord(value)) {
      throw new SealedTrainingConverterError('invalid_input', `输入第 ${index + 1} 行必须是对象`);
    }
    return value;
  });
}

function writeNdjson(filePath, rows) {
  const body = rows.length ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n` : '';
  const temporary = `${filePath}.tmp`;
  fs.writeFileSync(temporary, body, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.renameSync(temporary, filePath);
  } catch (error) {
    if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error?.code)) throw error;
    fs.rmSync(filePath, { force: true });
    fs.renameSync(temporary, filePath);
  }
  try { fs.chmodSync(filePath, 0o600); } catch { /* Windows ACLs follow the user profile. */ }
}

export function writeSealedTrainingSplits(outputDir, converted) {
  const directory = assertSafeOutputDirectory(outputDir);
  if (!converted?.ok) {
    throw new SealedTrainingConverterError('convert_failed', converted?.errors?.[0] || '密封转换失败');
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch { /* Windows ACLs follow the user profile. */ }
  writeNdjson(path.join(directory, 'train.ndjson'), converted.splits.train);
  writeNdjson(path.join(directory, 'validation.ndjson'), converted.splits.validation);
  writeNdjson(path.join(directory, 'held-out.ndjson'), converted.splits['held-out']);
  const manifestPath = path.join(directory, 'manifest.json');
  const temporary = `${manifestPath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(converted.manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.renameSync(temporary, manifestPath);
  } catch (error) {
    if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error?.code)) throw error;
    fs.rmSync(manifestPath, { force: true });
    fs.renameSync(temporary, manifestPath);
  }
  return {
    directory,
    manifestPath,
    schema: SEALED_TRAINING_MANIFEST_SCHEMA,
    trainingEligible: false,
  };
}

export function convertSealedTrainingFile({ inputPath, outputDir } = {}) {
  const batches = readSealedTrainingBatches(inputPath);
  const converted = convertSealedTrainingBatches(batches);
  if (!converted.ok) {
    throw new SealedTrainingConverterError(
      'convert_failed',
      converted.errors.slice(0, 5).join('; ') || '密封转换失败',
    );
  }
  const written = writeSealedTrainingSplits(outputDir || defaultSealedTrainingOutputDir(), converted);
  return {
    ok: true,
    trainingEligible: false,
    ...written,
    manifest: converted.manifest,
  };
}

function parseArgs(argv) {
  const args = { inputPath: null, outputDir: null };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--input' || item === '--output-dir') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new SealedTrainingConverterError('bad_argument', `${item} 需要参数`);
      }
      if (item === '--input') args.inputPath = value;
      else args.outputDir = value;
      index += 1;
    } else {
      throw new SealedTrainingConverterError('bad_argument', `未知参数 ${item}`);
    }
  }
  if (!args.inputPath) throw new SealedTrainingConverterError('bad_argument', '必须提供 --input');
  return args;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = convertSealedTrainingFile(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify({
      ok: true,
      trainingEligible: false,
      directory: result.directory,
      acceptedMatchRounds: result.manifest.acceptedMatchRounds,
      splits: result.manifest.splits,
    }, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
