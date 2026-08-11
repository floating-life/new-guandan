/**
 * AI Worker 逻辑集成自检（Node: node js/ai.worker.integration.test.js）
 * worker_threads 没有浏览器 Worker 的全局 self，这里在 Worker 里预置
 * self 垫片（onmessage/postMessage 桥到 parentPort）后再导入真实的
 * js/ai.worker.js，验证它能在 Worker 环境加载并按协议返回决策。
 */
import { Worker } from 'node:worker_threads';
import { createDeck } from './cards.js';
import { chooseAIPlay } from './ai.js';

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

const workerHref = new URL('./ai.worker.js', import.meta.url).href;

function runWorkerDecision(ctx) {
  const bootstrap = `
    import { parentPort } from 'node:worker_threads';
    const handlers = {};
    globalThis.self = {
      postMessage: (payload) => parentPort.postMessage(payload),
      set onmessage(fn) { handlers.msg = fn; },
      get onmessage() { return handlers.msg; },
    };
    parentPort.on('message', (data) => { if (handlers.msg) handlers.msg({ data }); });
    await import(${JSON.stringify(workerHref)});
  `;
  return new Promise((resolve, reject) => {
    const worker = new Worker(bootstrap, { eval: true, type: 'module' });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('Worker 决策超时'));
    }, 10000);
    worker.on('message', (payload) => {
      clearTimeout(timer);
      worker.terminate();
      if (payload?.ok) resolve(payload.decision);
      else reject(new Error(payload?.error || 'Worker 返回失败'));
    });
    worker.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    worker.postMessage({ id: 1, ctx });
  });
}

console.log('G Web Worker 逻辑（worker_threads 实测）');
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

runWorkerDecision(ctx).then((decision) => {
  const direct = chooseAIPlay(ctx);
  assert(decision && decision.action === 'play', 'Worker 返回有效出牌决策');
  assert(JSON.stringify(decision) === JSON.stringify(direct),
    '确定性决策在 Worker 与主线程逐字节一致');
  console.log(`\n结果: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}).catch((error) => {
  failed++;
  console.error('  ✗', 'Worker 实测异常:', error?.message || error);
  console.log(`\n结果: ${passed} passed, ${failed} failed`);
  process.exit(1);
});
