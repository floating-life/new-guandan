import { persistThenActivateValueModel } from './value-model-persistence.js';

let passed = 0;
let failed = 0;
function assert(condition, message) {
  if (condition) { passed += 1; console.log('  ✓', message); }
  else { failed += 1; console.error('  ✗', message); }
}

function createHarness({ quotaFailure = false, activationResult = { ok: true } } = {}) {
  const previous = { id: 'previous-promoted' };
  let persisted = previous;
  let mainModel = previous;
  let workerModel = previous;
  let activations = 0;
  return {
    state: () => ({ persisted, mainModel, workerModel, activations }),
    options: {
      model: { id: 'next-promoted' },
      preflight: () => ({ ok: true }),
      load: () => persisted,
      save: (model) => {
        if (quotaFailure) return false;
        persisted = model;
        return true;
      },
      clear: () => { persisted = null; return true; },
      activate: async (model) => {
        activations += 1;
        if (!activationResult.ok) return activationResult;
        mainModel = model;
        workerModel = model;
        return activationResult;
      },
    },
  };
}

console.log('价值模型保存/启用事务');
{
  const harness = createHarness({ quotaFailure: true });
  const result = await persistThenActivateValueModel(harness.options);
  const state = harness.state();
  assert(!result.ok && result.reason === 'storage_write_failed', '配额失败被明确报告');
  assert(state.activations === 0, '配额失败时不调用运行时启用');
  assert(state.persisted.id === 'previous-promoted'
    && state.mainModel.id === 'previous-promoted' && state.workerModel.id === 'previous-promoted',
  '配额失败后持久化、主线程和 Worker 均保持上一模型');
}
{
  const harness = createHarness({ activationResult: { ok: false, reason: 'worker_rejected' } });
  const result = await persistThenActivateValueModel(harness.options);
  const state = harness.state();
  assert(!result.ok && result.stage === 'activate', '运行时拒绝会报告启用阶段');
  assert(state.persisted.id === 'previous-promoted', '运行时拒绝后恢复之前的持久化模型');
}
{
  const harness = createHarness();
  const result = await persistThenActivateValueModel(harness.options);
  const state = harness.state();
  assert(result.ok && result.persisted, '保存成功后才完成运行时启用');
  assert(state.persisted.id === 'next-promoted'
    && state.mainModel.id === 'next-promoted' && state.workerModel.id === 'next-promoted',
  '成功路径中持久化、主线程和 Worker 指向同一模型');
}

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
