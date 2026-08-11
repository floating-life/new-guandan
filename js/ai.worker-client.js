/**
 * 本地 AI 决策的异步入口：浏览器环境有 Worker 时把搜索卸到 Worker，
 * 不可用（Node 单测/A-B、旧浏览器、Worker 异常、超时）时同步回退
 * chooseAIPlay。回退路径与直接调用完全一致，保证行为可复现。
 */
import { chooseAIPlay } from './ai.js';

let worker = null;
let requestId = 0;
const pending = new Map();

function handleMessage(event) {
  const { id, ok, decision, error } = event.data || {};
  const waiter = pending.get(id);
  if (!waiter) return;
  pending.delete(id);
  if (waiter.timer) clearTimeout(waiter.timer);
  if (ok) waiter.resolve(decision);
  else waiter.reject(new Error(error || 'AI Worker 决策失败'));
}

function createWorker() {
  try {
    const url = new URL('./ai.worker.js', import.meta.url);
    const instance = new Worker(url, { type: 'module' });
    instance.onmessage = handleMessage;
    instance.onerror = (event) => {
      if (worker === instance) worker = null;
      const message = event?.message || 'AI Worker 异常';
      for (const waiter of pending.values()) {
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.reject(new Error(message));
      }
      pending.clear();
      try { instance.terminate(); } catch { /* noop */ }
    };
    return instance;
  } catch {
    return null;
  }
}

export function aiWorkerAvailable() {
  return typeof Worker === 'function' && typeof window !== 'undefined';
}

/** 异步取本地 AI 决策；options.timeoutMs 超时后回退主线程决策。 */
export function requestAIDecision(ctx, options = {}) {
  const timeoutMs = Number(options.timeoutMs) || 0;
  if (!aiWorkerAvailable()) return Promise.resolve(chooseAIPlay(ctx));
  if (!worker) worker = createWorker();
  if (!worker) return Promise.resolve(chooseAIPlay(ctx));
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const waiter = { resolve, reject, timer: null };
    pending.set(id, waiter);
    if (timeoutMs > 0) {
      waiter.timer = setTimeout(() => {
        if (!pending.delete(id)) return;
        resolve(chooseAIPlay(ctx));
      }, timeoutMs);
    }
    worker.postMessage({ id, ctx });
  });
}
