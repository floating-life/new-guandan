/** Validate a local self-play value model against the browser's exact schema. */
import fs from 'node:fs';
import path from 'node:path';

const { validateHybridValueModel } = await import('../js/ai-hybrid.js');
const {
  hasPromotionReceipt, isPromotedValueModel, valueModelStatus,
} = await import('../js/value-model-gate.js');
const input = process.argv[2];
if (!input) throw new Error('用法：node tools/validate_value_model.mjs <model.json>');
const file = path.resolve(input);
const model = JSON.parse(fs.readFileSync(file, 'utf8'));
const result = validateHybridValueModel(model);
console.log(JSON.stringify({
  file,
  ...result,
  status: valueModelStatus(model),
  promotionReceiptValid: hasPromotionReceipt(model),
  loadableInGame: isPromotedValueModel(model),
}, null, 2));
if (!result.ok) process.exit(1);
