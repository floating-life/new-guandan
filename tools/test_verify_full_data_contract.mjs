import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'tools', 'verify.ps1'), 'utf8');
const fullData = source.slice(source.indexOf('if ($FullData) {'), source.indexOf('if ($ReleaseEvidence) {'));
const releaseEvidence = source.slice(source.indexOf('if ($ReleaseEvidence) {'));

assert(fullData.includes("Resolve-RequiredProjectFile 'ContinuousCheckpoint'"),
  'FullData 保留历史 A/B 完整性所需的连续赛 checkpoint');
assert(!fullData.includes("Resolve-RequiredProjectFile 'ContinuousReport'"),
  'FullData 不得无关要求 ReleaseEvidence 专属的连续赛报告');
assert(releaseEvidence.includes("Resolve-RequiredProjectFile 'ContinuousReport'"),
  'ReleaseEvidence 仍必须解析连续赛报告');
console.log('verify FullData/ReleaseEvidence input contract: OK');
