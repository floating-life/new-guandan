import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateHybridValueModel, evaluateHybridValueModel } from '../js/ai-hybrid.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function checkParity(model) {
  assert.equal(validateHybridValueModel(model).ok, true, 'exported model schema');
  const cases = model.metadata?.parityCases;
  assert(Array.isArray(cases) && cases.length >= 6, 'native Python prediction cases are required');
  let maximumError = 0;
  for (const sample of cases) {
    const actual = evaluateHybridValueModel(model, sample.features);
    assert(Number.isFinite(actual) && Number.isFinite(sample.expected), 'finite parity prediction');
    const error = Math.abs(actual - sample.expected);
    maximumError = Math.max(maximumError, error);
    assert(error <= 1e-5, `Python/JS parity error ${error} exceeds 1e-5`);
  }
  return { model: model.id, cases: cases.length, maximumError };
}

let temp = null;
try {
  let modelPaths = process.argv.slice(2).filter(a => a.startsWith('--model=')).map(a => a.slice(8));
  const output = process.argv.slice(2).find(a => a.startsWith('--output='))?.slice(9);
  for (const arg of process.argv.slice(2)) {
    if (!arg.startsWith('--model=') && !arg.startsWith('--output=')) throw new Error(`unknown argument ${arg}`);
  }
  if (!modelPaths.length) {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-parity-'));
    const program = [
      'import sys,json', 'from pathlib import Path', "sys.path.insert(0, str(Path('tools').resolve()))",
      'from test_train_learning_model import write_fixture', 'from train_learning_model import train_model',
      'root=Path(sys.argv[1])', 'labels=write_fixture(root)', 'paths=[]',
      "for architecture in ['linear','mlp']:",
      "    output=root/(architecture+'.json')", '    train_model(labels,output,architecture=architecture,epochs=15,seed=1)',
      '    paths.append(str(output))',
      "v2_labels=root/'labels-v2.jsonl'",
      "lines=labels.read_text().splitlines(); h=json.loads(lines[0]); h['featureEngine']='learned-context-v2'; lines[0]=json.dumps(h)",
      "for i in range(1,len(lines)):",
      "    r=json.loads(lines[i]); r['features']=r['features']+[0.1,0.2,0.3,0.4,0.5,0.6]; lines[i]=json.dumps(r)",
      "v2_labels.write_text('\\n'.join(lines)+'\\n')",
      "v2_out=root/'context-v2.json'",
      "train_model(v2_labels,v2_out,architecture='mlp',epochs=15,seed=1)",
      'paths.append(str(v2_out))',
      'print(json.dumps(paths))',
    ].join('\n');
    const child = spawnSync('python', ['-B', '-c', program, temp], { cwd: root, encoding: 'utf8', timeout: 120000 });
    assert.equal(child.status, 0, child.stderr || child.stdout || 'Python fixture training failed');
    modelPaths = JSON.parse(child.stdout);
  }
  const models = modelPaths.map(file => JSON.parse(fs.readFileSync(file, 'utf8')));
  const results = models.map(checkParity);
  const mutated = structuredClone(models[0]);
  mutated.layers.at(-1).bias[0] += 1;
  assert.throws(() => checkParity(mutated), /parity error/, 'changed export bias must be detected');
  const report = { ok: true, tolerance: 1e-5, results, changedExportDetected: true };
  if (output) fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify(report, null, 2));
} finally { if (temp) fs.rmSync(temp, { recursive: true, force: true }); }
