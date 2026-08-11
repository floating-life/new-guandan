/**
 * AI Worker 客户端自检（Node: node js/ai.worker.test.js）
 * Node 没有浏览器 window → aiWorkerAvailable() 为 false → 走同步回退，
 * 验证回退路径与直接 chooseAIPlay 逐字节一致。
 */
import { createDeck } from './cards.js';
import { chooseAIPlay } from './ai.js';
import { requestAIDecision, aiWorkerAvailable } from './ai.worker-client.js';

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

requestAIDecision(ctx).then((decision) => {
  const direct = chooseAIPlay(ctx);
  assert(decision && typeof decision === 'object' && decision.action === 'play',
    '回退路径返回有效出牌决策');
  assert(JSON.stringify(decision) === JSON.stringify(direct),
    'Worker 客户端回退与直接 chooseAIPlay 逐字节一致');
  console.log(`\n结果: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}).catch((error) => {
  failed++;
  console.error('  ✗', '回退路径异常:', error?.message || error);
  console.log(`\n结果: ${passed} passed, ${failed} failed`);
  process.exit(1);
});
