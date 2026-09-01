/**
 * AI Worker 客户端自检（Node: node js/ai.worker.test.js）
 * Node 没有浏览器 window → aiWorkerAvailable() 为 false → 走同步回退，
 * 验证回退路径与直接 chooseAIPlay 逐字节一致。
 */
import { createDeck } from './cards.js';
import { chooseAIPlay } from './ai.js';
import {
  requestAIDecision, aiWorkerAvailable, configureAIWorkerValueModel,
} from './ai.worker-client.js';
import { createPublicAIObservation } from './ai-observation.js';
import { HYBRID_VALUE_FEATURES, HYBRID_VALUE_SCHEMA } from './ai-hybrid.js';
import { makePromotedValueModel } from './value-model.test-fixture.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log('  ✓', message);
  } else {
    failed++;
    console.error('  ✗', message);
  }
}

console.log('G Web Worker 客户端（Node 回退路径）');
assert(aiWorkerAvailable() === false,
  'Node 测试环境识别不到浏览器 Worker，自动走同步回退');

const hand = createDeck().slice(0, 27);
const ctx = {
  seat: 0,
  hand,
  level: 2,
  lastHand: null,
  lastSeat: null,
  handCounts: [27, 27, 27, 27],
  teams: [0, 1, 0, 1],
  finishOrder: [],
  difficulty: 'master',
  deterministic: true,
  policyProfile: 'expert',
};

const zeroModel = makePromotedValueModel({
  id: 'worker-client-zero',
  schema: HYBRID_VALUE_SCHEMA,
  layers: [{
    weights: [new Array(HYBRID_VALUE_FEATURES.length).fill(0)],
    bias: [0],
    activation: 'linear',
  }],
});

const originalWindow = globalThis.window;
const originalWorker = globalThis.Worker;

class FakeBrowserWorker {
  static instances = [];

  static mode = 'respond';

  constructor() {
    this.terminated = false;
    this.onmessage = null;
    this.onerror = null;
    FakeBrowserWorker.instances.push(this);
  }

  postMessage(message) {
    if (message?.type === 'configure-hybrid-model') {
      if (FakeBrowserWorker.mode === 'respond') {
        queueMicrotask(() => this.onmessage?.({
          data: { id: message.id, ok: true, decision: { ok: true, active: Boolean(message.model) } },
        }));
      }
      return;
    }
    if (FakeBrowserWorker.mode === 'respond') {
      const decision = chooseAIPlay(createPublicAIObservation(message.ctx));
      queueMicrotask(() => this.onmessage?.({ data: { id: message.id, ok: true, decision } }));
    } else if (FakeBrowserWorker.mode === 'error') {
      queueMicrotask(() => this.onerror?.({ message: '模拟 Worker 故障' }));
    }
  }

  terminate() {
    this.terminated = true;
  }
}

function enableFakeBrowserWorker(mode) {
  globalThis.window = {};
  globalThis.Worker = FakeBrowserWorker;
  FakeBrowserWorker.mode = mode;
}

function restoreGlobals() {
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
  if (originalWorker === undefined) delete globalThis.Worker;
  else globalThis.Worker = originalWorker;
}

configureAIWorkerValueModel(zeroModel).then((configured) => {
  assert(configured.ok && configured.active, 'Node 回退路径也校验并配置专用价值模型');
  return requestAIDecision({ ...ctx, hands: [['不应进入Worker']] });
}).then((decision) => {
  const direct = chooseAIPlay(createPublicAIObservation(ctx));
  assert(decision && typeof decision === 'object' && decision.action === 'play',
    '回退路径返回有效出牌决策');
  assert(JSON.stringify(decision) === JSON.stringify(direct),
    'Worker 客户端白名单回退与正式公平观察决策逐字节一致');
  return configureAIWorkerValueModel(null);
}).then((cleared) => {
  assert(cleared.ok && !cleared.active, '可清除本地专用价值模型并恢复无模型状态');
  enableFakeBrowserWorker('timeout');
  const before = FakeBrowserWorker.instances.length;
  return Promise.all([
    requestAIDecision(ctx, { timeoutMs: 20 }),
    requestAIDecision(ctx, { timeoutMs: 1000 }),
  ]).then((decisions) => {
    const timedOutWorker = FakeBrowserWorker.instances[before];
    assert(timedOutWorker?.terminated,
      '任一请求超时会终止阻塞 Worker，避免旧搜索占用后续决策队列');
    assert(decisions.every((item) => item?.action === 'play'),
      '同一阻塞 Worker 上的全部待决请求都会安全回退，不遗留悬空 Promise');
    assert(decisions.every((item) => item?.localFallbackKind === 'local_timeout'),
      'Worker 超时回退必须保留 local_timeout 分类，供正式决策遥测入账');

    enableFakeBrowserWorker('respond');
    return requestAIDecision(ctx, { timeoutMs: 200 });
  });
}).then((decision) => {
  assert(decision?.action === 'play', '超时后下一手会重建 Worker 并恢复异步决策');
  enableFakeBrowserWorker('error');
  return requestAIDecision(ctx, { timeoutMs: 200 });
}).then((decision) => {
  assert(decision?.action === 'play' && decision?.localFallbackKind === 'local_decision_error',
    'Worker 运行时故障直接回退专家策略并保留 local_decision_error 分类');
  restoreGlobals();
  console.log(`\n结果: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}).catch((error) => {
  restoreGlobals();
  failed++;
  console.error('  ✗', '回退路径异常:', error?.message || error);
  console.log(`\n结果: ${passed} passed, ${failed} failed`);
  process.exit(1);
});
