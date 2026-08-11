/** Optional cloud AI adapter contract tests. */
import {
  LLM_POLICY_MODE, checkLLMHealth, getLLMHealth, getLLMConfig,
  updateLLMConfig, requestLLMDecision,
} from './llm.js';

let passed = 0;
let failed = 0;
function assert(condition, message) {
  if (condition) { passed++; console.log(`  ✓ ${message}`); }
  else { failed++; console.error(`  ✗ ${message}`); }
}

assert(LLM_POLICY_MODE.LOCAL === 'local', '本地模式值稳定');
assert(LLM_POLICY_MODE.AUTO === 'auto' && LLM_POLICY_MODE.CLOUD === 'cloud', '自动回退和云端模式值稳定');

const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async (url, options) => {
    assert(url === '/api/llm/health', '健康检测只访问本机 API 网关');
    assert(options?.method === 'GET', '健康检测使用 GET');
    return {
      ok: true,
      status: 200,
      async json() {
        return { apiVersion: 3, providerOk: true, configured: true, state: 'online', message: 'ok', model: 'test' };
      },
    };
  };
  const health = await checkLLMHealth({ timeoutMs: 100 });
  assert(health.providerOk && getLLMHealth().state === 'online', '健康结果保存为在线状态');

  globalThis.fetch = async (url, options) => {
    assert(url === '/api/llm/health?deep=1', '深度健康检测实际请求聊天接口探针');
    assert(options?.method === 'GET', '深度健康检测使用 GET');
    return {
      ok: true,
      status: 200,
      async json() {
        return { apiVersion: 3, providerOk: true, verified: true, configured: true, state: 'online', message: 'ok', model: 'test' };
      },
    };
  };
  const deepHealth = await checkLLMHealth({ timeoutMs: 100, deep: true });
  globalThis.fetch = async (url, options) => {
    assert(url === '/api/llm/health?deep=1', '默认深度检测仍访问真实聊天探针');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 8);
      const abort = () => {
        clearTimeout(timer);
        reject(options?.signal?.reason || new DOMException('Aborted', 'AbortError'));
      };
      if (options?.signal?.aborted) abort();
      else options?.signal?.addEventListener?.('abort', abort, { once: true });
    });
    return {
      ok: true,
      status: 200,
      async json() {
        return { apiVersion: 3, providerOk: true, verified: true, configured: true, state: 'online', message: 'ok', model: 'test' };
      },
    };
  };
  const defaultTimeoutHealth = await checkLLMHealth({ deep: true });
  assert(defaultTimeoutHealth.verified === true,
    '未显式传入超时时间时采用默认上限，不把 null 错当成 0 毫秒');
  assert(deepHealth.verified === true, '深度健康检测保存聊天协议验证结果');

  globalThis.fetch = async (url, options) => {
    assert(url === '/api/ai/decision', '决策只访问本机 API 代理');
    const body = JSON.parse(options.body);
    assert(body.mode === 'cloud' && body.candidates.length === 1 && body.requestId, '提交模式、请求 ID 和合法候选集');
    return {
      ok: true,
      status: 200,
      async json() { return { ok: true, decision: { candidateId: 'candidate_0', confidence: 0.9 } }; },
    };
  };
  const decision = await requestLLMDecision({
    mode: LLM_POLICY_MODE.CLOUD,
    context: { seat: 1, level: 2 },
    candidates: [{ id: 'candidate_0', action: 'play', cards: [] }],
  });
  assert(decision.candidateId === 'candidate_0', '结构化决策返回候选 ID');

  globalThis.fetch = async (url, options) => {
    assert(url === '/api/llm/config', '配置只访问本机 API 代理');
    assert(options?.method === 'GET', '读取配置使用 GET');
    return {
      ok: true,
      status: 200,
      async json() { return { ok: true, apiVersion: 3, configured: true, apiKeyConfigured: true, apiUrl: 'https://example.com/v1', model: 'test' }; },
    };
  };
  const config = await getLLMConfig();
  assert(config.apiKeyConfigured && config.apiUrl.includes('example.com'), '读取配置不需要暴露密钥内容');

  globalThis.fetch = async (url, options) => {
    assert(url === '/api/llm/config', '保存配置只访问本机 API 代理');
    assert(options?.method === 'POST' && options?.headers?.['Content-Type'] === 'application/json', '保存配置使用 JSON POST');
    const body = JSON.parse(options.body);
    assert(!body.apiKey || body.apiKey === 'new-key', '配置请求只在用户主动填写时携带密钥');
    return {
      ok: true,
      status: 200,
      async json() { return { ok: true, apiVersion: 3, configured: true, apiKeyConfigured: true, apiUrl: body.apiUrl, model: body.model }; },
    };
  };
  const updated = await updateLLMConfig({ apiUrl: 'https://example.com/v1', model: 'test', apiKey: 'new-key' });
  assert(updated.configured && updated.model === 'test', '网页配置保存结果可用于刷新状态');

  globalThis.fetch = async () => ({
    ok: false,
    status: 502,
    async json() {
      return {
        ok: false,
        code: 'provider_offline',
        retryable: true,
        failureClass: 'transient',
        message: '云端 API 无法连接或响应超时',
        provider: 'api.example.com',
        model: 'test-model',
        usage: { promptTokens: 120, completionTokens: 0, totalTokens: 120, source: 'estimate', estimated: true },
      };
    },
  });
  try {
    await requestLLMDecision({
      mode: LLM_POLICY_MODE.CLOUD,
      context: { seat: 1, level: 2 },
      candidates: [{ id: 'candidate_0', action: 'play', cards: [] }],
    });
    assert(false, '云端失败应抛出可识别错误');
  } catch (error) {
    assert(error.code === 'provider_offline' && error.provider === 'api.example.com'
      && error.model === 'test-model' && error.usage?.estimated === true
      && error.usage.totalTokens === 120 && error.retryable === true
      && error.failureClass === 'transient', '云端失败保留 Token 与故障分类元数据');
  }
} finally {
  globalThis.fetch = originalFetch;
}

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
