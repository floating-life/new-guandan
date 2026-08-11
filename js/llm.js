/**
 * Optional cloud analysis adapter.
 *
 * The browser never receives a provider API key. It talks only to the local
 * loopback service, which validates the model response and keeps the key in
 * its server-side environment.
 */

export const LLM_POLICY_MODE = Object.freeze({
  LOCAL: 'local',
  CLOUD: 'cloud',
  AUTO: 'auto',
});

// 供应商生成速度可能随候选数量波动；本地候选已经收敛到最多三项，
// 这里给慢速兼容网关留出余量，但仍由服务端 20 秒硬上限兜底。
const LLM_DECISION_TIMEOUT_MS = 22000;
const REQUIRED_GATEWAY_API_VERSION = 3;
let requestSerial = 0;

let healthState = {
  state: 'unknown',
  configured: false,
  providerOk: false,
  verified: false,
  message: '尚未检测 API',
  checkedAt: null,
};

function timeoutSignal(timeoutMs) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(timeoutMs);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs);
  return controller.signal;
}

function cancellableSignal(timeoutMs, externalSignal = null) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new DOMException('Timeout', 'TimeoutError')), timeoutMs);
  const forwardAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal) {
    if (externalSignal.aborted) forwardAbort();
    else externalSignal.addEventListener('abort', forwardAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeoutId);
      externalSignal?.removeEventListener?.('abort', forwardAbort);
    },
  };
}

function compactCard(card) {
  if (typeof card === 'string') return card;
  if (!card || card.rank == null || !card.suit) return null;
  return `${String(card.suit).slice(0, 1)}${card.rank}`;
}

function compactCandidate(candidate) {
  return {
    id: String(candidate?.id || ''),
    action: candidate?.action || 'play',
    cards: Array.isArray(candidate?.cards) ? candidate.cards.map(compactCard).filter(Boolean) : [],
    hand: candidate?.hand ? {
      type: candidate.hand.type,
      mainRank: candidate.hand.mainRank,
      size: candidate.hand.size,
      power: candidate.hand.power,
    } : null,
    localScore: Number.isFinite(Number(candidate?.localScore)) ? Number(candidate.localScore) : null,
    projectedTricks: Number.isFinite(Number(candidate?.projectedTricks)) ? Number(candidate.projectedTricks) : null,
    tags: Array.isArray(candidate?.tags) ? candidate.tags.slice(0, 4) : [],
  };
}

function rememberHealth(next) {
  healthState = {
    ...healthState,
    ...(next || {}),
    checkedAt: new Date().toISOString(),
  };
  return { ...healthState };
}

function gatewayError(message, {
  code = 'gateway_error', retryable = true, failureClass = 'transient', cause = null,
} = {}) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  error.failureClass = failureClass;
  if (cause) error.cause = cause;
  return error;
}

function nextRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  requestSerial += 1;
  return `llm_${Date.now().toString(36)}_${requestSerial.toString(36)}`;
}

function assertGatewayVersion(payload) {
  const version = Number(payload?.apiVersion);
  if (!Number.isFinite(version) || version < REQUIRED_GATEWAY_API_VERSION) {
    throw gatewayError('本机 API 服务版本过旧，请重新运行 start-lan.ps1', {
      code: 'gateway_outdated', retryable: false, failureClass: 'configuration',
    });
  }
}

export function getLLMHealth() {
  return { ...healthState };
}

export async function getLLMConfig({ timeoutMs = 2500 } = {}) {
  const response = await fetch('/api/llm/config', {
    method: 'GET',
    cache: 'no-store',
    signal: timeoutSignal(timeoutMs),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) {
    throw new Error(payload.message || `本机 API 配置读取失败（${response.status}）`);
  }
  assertGatewayVersion(payload);
  return payload;
}

export async function updateLLMConfig({ apiUrl, model, apiKey = '', clearKey = false } = {}) {
  const response = await fetch('/api/llm/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    signal: timeoutSignal(8000),
    body: JSON.stringify({ apiUrl, model, apiKey, clearKey }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) {
    throw new Error(payload.message || `本机 API 配置保存失败（${response.status}）`);
  }
  assertGatewayVersion(payload);
  return payload;
}

export async function checkLLMHealth({ timeoutMs = null, deep = false } = {}) {
  if (typeof fetch !== 'function') {
    return rememberHealth({
      state: 'unavailable',
      configured: false,
      providerOk: false,
      verified: false,
      message: '当前环境不支持网络检测',
    });
  }
  try {
    // `Number(null)` is 0. Treating the default `null` as an explicitly
    // requested timeout used to abort every UI health check immediately,
    // even though direct gateway requests worked normally.
    const requestedTimeoutMs = timeoutMs == null ? NaN : Number(timeoutMs);
    const effectiveTimeoutMs = Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
      ? requestedTimeoutMs
      : (deep ? 22000 : 6000);
    const response = await fetch(deep ? '/api/llm/health?deep=1' : '/api/llm/health', {
      method: 'GET',
      cache: 'no-store',
      signal: timeoutSignal(effectiveTimeoutMs),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return rememberHealth({
        state: 'error',
        configured: !!payload.configured,
        providerOk: false,
        verified: false,
        message: payload.message || `本机 API 网关返回 ${response.status}`,
        code: payload.code || `http_${response.status}`,
        retryable: payload.retryable !== false,
        failureClass: payload.failureClass || 'transient',
      });
    }
    try {
      assertGatewayVersion(payload);
    } catch (error) {
      return rememberHealth({
        state: 'error', configured: !!payload.configured, providerOk: false, verified: false,
        message: error.message, code: error.code, retryable: false, failureClass: 'configuration',
      });
    }
    return rememberHealth({
      state: payload.state
        || (payload.providerOk ? 'online' : payload.configured ? 'error' : 'not_configured'),
      configured: !!payload.configured,
      providerOk: !!payload.providerOk,
      verified: !!payload.verified,
      message: payload.message || (payload.providerOk ? '云端 API 正常' : '未配置云端 API'),
      provider: payload.provider || null,
      model: payload.model || null,
      code: payload.code || null,
      retryable: payload.retryable !== false,
      failureClass: payload.failureClass || null,
      apiVersion: Number(payload.apiVersion) || null,
      serviceBuild: payload.serviceBuild || null,
    });
  } catch (error) {
    return rememberHealth({
      state: 'offline',
      configured: false,
      providerOk: false,
      verified: false,
      message: ['AbortError', 'TimeoutError'].includes(error?.name)
        ? 'API 检测超时'
        : '本机 API 网关不可用',
      code: ['AbortError', 'TimeoutError'].includes(error?.name) ? 'gateway_timeout' : 'gateway_offline',
      retryable: true,
      failureClass: 'transient',
    });
  }
}

export async function requestLLMDecision({
  context, candidates, mode = LLM_POLICY_MODE.CLOUD, signal: externalSignal = null,
}) {
  if (typeof fetch !== 'function') throw new Error('当前环境不支持云端 AI 请求');
  if (!Array.isArray(candidates) || !candidates.length) {
    throw new Error('没有可提交给云端 AI 的合法候选牌');
  }
  const abort = cancellableSignal(LLM_DECISION_TIMEOUT_MS, externalSignal);
  const compactCandidates = candidates.map(compactCandidate);
  const requestId = nextRequestId();
  let response;
  try {
    response = await fetch('/api/ai/decision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      signal: abort.signal,
      body: JSON.stringify({
        mode,
        requestId,
        context,
        candidates: compactCandidates,
      }),
    });
  } catch (error) {
    if (externalSignal?.aborted) throw gatewayError('云端 AI 请求已取消', {
      code: 'request_cancelled', retryable: true, failureClass: 'request', cause: error,
    });
    if (['AbortError', 'TimeoutError'].includes(error?.name)) throw gatewayError('云端 AI 请求超时', {
      code: 'gateway_timeout', retryable: true, failureClass: 'transient', cause: error,
    });
    throw gatewayError('本机 API 网关不可用', {
      code: 'gateway_offline', retryable: true, failureClass: 'transient', cause: error,
    });
  } finally {
    abort.cleanup();
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok || !payload.decision?.candidateId) {
    const message = payload.message || payload.error || `云端 AI 请求失败（${response.status}）`;
    const error = new Error(message);
    error.code = payload.code || `http_${response.status}`;
    error.retryable = payload.retryable !== false;
    error.failureClass = payload.failureClass || (response.status >= 500 ? 'transient' : 'configuration');
    error.requestId = payload.requestId || requestId;
    error.provider = payload.provider || null;
    error.model = payload.model || null;
    error.usage = payload.usage && typeof payload.usage === 'object' ? {
      promptTokens: Number(payload.usage.promptTokens) || 0,
      completionTokens: Number(payload.usage.completionTokens) || 0,
      totalTokens: Number(payload.usage.totalTokens) || 0,
      source: payload.usage.source === 'provider' ? 'provider' : 'estimate',
      estimated: payload.usage.estimated === true || payload.usage.source !== 'provider',
    } : null;
    throw error;
  }
  return {
    ...payload.decision,
    _llm: {
      provider: payload.provider || null,
      model: payload.model || null,
      usage: payload.usage && typeof payload.usage === 'object' ? {
        promptTokens: Number(payload.usage.promptTokens) || 0,
        completionTokens: Number(payload.usage.completionTokens) || 0,
        totalTokens: Number(payload.usage.totalTokens) || 0,
        source: payload.usage.source === 'provider' ? 'provider' : 'estimate',
        estimated: payload.usage.estimated === true || payload.usage.source !== 'provider',
      } : null,
      requestId: payload.requestId || requestId,
    },
  };
}
