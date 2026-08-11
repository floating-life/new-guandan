/** Cloud decision end-to-end tests: browser adapter -> game -> executed cards. */
import { createCard } from './cards.js';
import {
  createMatch, resumeMatch, setUpdateCallback, PHASE,
} from './game.js';

let passed = 0;
let failed = 0;
function assert(condition, message) {
  if (condition) { passed += 1; console.log(`  ✓ ${message}`); }
  else { failed += 1; console.error(`  ✗ ${message}`); }
}

function cards(...items) {
  return items.map(([rank, suit], index) => createCard(rank, suit, index % 2));
}

function cloudState() {
  const state = createMatch({
    difficulty: 'normal', aiSpeed: 'fast', coachMode: false,
    llmPolicyMode: 'cloud', deterministicAI: true,
  });
  state.phase = PHASE.PLAYING;
  state.currentLevel = 2;
  state.currentSeat = 1;
  state.firstPlayer = 1;
  state.hands = [
    cards([5, 'S'], [9, 'D'], [13, 'C']),
    cards([3, 'C'], [4, 'D'], [6, 'S'], [8, 'H'], [10, 'C'], [12, 'D']),
    cards([5, 'H'], [9, 'C'], [13, 'D']),
    cards([7, 'S'], [11, 'H'], [14, 'C']),
  ];
  state.handCounts = state.hands.map((hand) => hand.length);
  state.lastHand = null;
  state.lastSeat = null;
  state.finishOrder = [];
  state.trickLog = [];
  state.messages = [];
  return state;
}

function code(card) {
  return `${card.suit}${card.rank}`;
}

async function waitForTurn(state, timeoutMs = 2500) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (state.trickLog.length) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('等待 AI 决策超时');
}

async function runOne(state) {
  setUpdateCallback(() => {
    if (state.trickLog.length) state.phase = PHASE.IDLE;
  });
  resumeMatch(state);
  await waitForTurn(state);
  setUpdateCallback(null);
}

const originalFetch = globalThis.fetch;
try {
  console.log('云端改选确实落到牌桌');
  {
    const state = cloudState();
    let submitted = null;
    let selected = null;
    globalThis.fetch = async (url, options) => {
      assert(url === '/api/ai/decision', '实战决策通过本机网关调用');
      submitted = JSON.parse(options.body);
      assert(!Array.isArray(submitted.context.playedCards)
        && submitted.context.playedRankCounts
        && typeof submitted.context.playedRankCounts === 'object',
      '真实牌局上下文使用公开点数计数，避免与逐手历史重复上传');
      selected = submitted.candidates.find((candidate) => (
        candidate.action === 'play' && candidate.id !== submitted.context.localCandidateId
      ));
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            ok: true,
            requestId: submitted.requestId,
            decision: { candidateId: selected.id, confidence: 0.99, reasonCodes: ['route'] },
            provider: 'mock.provider',
            model: 'mock-model',
            usage: { promptTokens: 80, completionTokens: 12, totalTokens: 92, source: 'provider' },
          };
        },
      };
    };
    await runOne(state);
    const played = state.trickLog[0];
    assert(selected && played.cards.map(code).join(',') === selected.cards.join(','),
      '云端选中的合法候选牌被实际执行，不是仅记录结果');
    assert(state.llmReport.successes === 1 && state.llmReport.cloudOverrides === 1,
      '报告记录一次成功云端改选');
    assert(played.decisionMeta?.llm?.localCandidateId === submitted.context.localCandidateId
      && played.decisionMeta?.llm?.cloudCandidateId === selected.id
      && played.decisionMeta?.llm?.executedCandidateId === selected.id,
    '逐手记录保留本地、云端与最终执行三个候选 ID');
  }

  console.log('临时故障只回退当前手并打开退避');
  {
    const state = cloudState();
    globalThis.fetch = async () => ({
      ok: false,
      status: 502,
      async json() {
        return {
          ok: false,
          code: 'provider_offline',
          retryable: true,
          failureClass: 'transient',
          message: '模拟网络波动',
          usage: { promptTokens: 70, completionTokens: 0, totalTokens: 70, source: 'estimate', estimated: true },
        };
      },
    });
    await runOne(state);
    assert(state.trickLog.length === 1 && state.llmReport.fallbacks === 1,
      '云端临时失败后本地 AI 仍完成本手');
    assert(!state.llmFallbackActive && state.llmCircuit?.state === 'open'
      && state.llmCircuit.retryAt > Date.now(),
    '网络波动不再锁死整副，而是进入有期限自动重试');
    assert(state.llmReport.transientFailures === 1 && state.llmReport.permanentFailures === 0,
      '报告正确区分临时故障与配置故障');
  }

  console.log('模型偶发输出异常不锁死整副');
  {
    const state = cloudState();
    globalThis.fetch = async () => ({
      ok: false,
      status: 502,
      async json() {
        return {
          ok: false,
          code: 'invalid_response',
          retryable: true,
          failureClass: 'model_output',
          message: '模拟模型候选格式异常',
          usage: { promptTokens: 75, completionTokens: 18, totalTokens: 93, source: 'provider' },
        };
      },
    });
    await runOne(state);
    assert(state.trickLog.length === 1 && !state.llmFallbackActive
      && state.llmCircuit?.state === 'open', '模型输出异常仅由本地 AI 接管当前手');
    assert(state.llmReport.modelOutputFailures === 1
      && state.llmReport.permanentFailures === 0,
    '报告把模型输出异常与永久配置故障分开统计');
    assert(state.llmReport.totalTokens === 93 && state.llmReport.estimatedTokenCalls === 0,
      '失败响应中的供应商真实 Token 使用量仍被记录');
  }

  console.log('已有成功调用后单次协议异常不推翻有效配置');
  {
    const state = cloudState();
    state.llmReport.successes = 1;
    state.llmReport.cloudCalls = 1;
    globalThis.fetch = async () => ({
      ok: false,
      status: 502,
      async json() {
        return {
          ok: false,
          code: 'provider_configuration',
          retryable: false,
          failureClass: 'configuration',
          message: '模拟单个请求被供应商拒绝',
        };
      },
    });
    await runOne(state);
    assert(!state.llmFallbackActive && state.llmCircuit?.state === 'open',
      '同一模型已有成功证据时单次协议异常改为可恢复退避');
    assert(state.llmReport.transientFailures === 1
      && state.llmReport.permanentFailures === 0,
    '成功后的单次协议异常不再计为永久配置故障');
    assert(state.llmReport.records.at(-1)?.retryable === true,
      '重新分类后的逐次记录同步标记为可重试');
  }
} finally {
  globalThis.fetch = originalFetch;
  setUpdateCallback(null);
}

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
