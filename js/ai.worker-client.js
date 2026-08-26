/**
 * 本地 AI 决策的异步入口：浏览器环境有 Worker 时把搜索卸到 Worker，
 * 不可用（Node 单测/A-B、旧浏览器、Worker 异常、超时）时同步回退
 * chooseAIPlay。回退路径与直接调用完全一致，保证行为可复现。
 */
import { chooseAIPlay } from './ai.js';
import { configureHybridValueModel } from './ai-hybrid.js';
import { createPublicAIObservation } from './ai-observation.js';

let worker = null;
let requestId = 0;
const pending = new Map();
let workerValueModelConfigured = false;
let workerValueModel = null;

function handleMessage(instance, event) {
  const { id, ok, decision, error } = event.data || {};
  const waiter = pending.get(id);
  if (!waiter || waiter.worker !== instance) return;
  pending.delete(id);
  if (waiter.timer) clearTimeout(waiter.timer);
  if (ok) waiter.resolve(decision);
  else {
    try {
      waiter.onWorkerFailure(new Error(error || 'AI Worker 决策失败'));
    } catch (fallbackError) {
      waiter.reject(fallbackError);
    }
  }
}

function settleWorkerFailure(instance, error) {
  if (worker === instance) worker = null;
  for (const [id, waiter] of pending.entries()) {
    if (waiter.worker !== instance) continue;
    pending.delete(id);
    if (waiter.timer) clearTimeout(waiter.timer);
    try {
      waiter.onWorkerFailure(error);
    } catch (fallbackError) {
      waiter.reject(fallbackError);
    }
  }
}

function terminateFailedWorker(instance, error) {
  settleWorkerFailure(instance, error);
  try { instance.terminate(); } catch { /* noop */ }
}

function cloneModelConfig(model) {
  if (model == null) return null;
  if (typeof structuredClone === 'function') return structuredClone(model);
  return JSON.parse(JSON.stringify(model));
}

function createWorker() {
  try {
    const url = new URL('./ai.worker.js', import.meta.url);
    const instance = new Worker(url, { type: 'module' });
    instance.onmessage = (event) => handleMessage(instance, event);
    instance.onerror = (event) => {
      const message = event?.message || 'AI Worker 异常';
      terminateFailedWorker(instance, new Error(message));
    };
    // Worker 异常/超时重建后按消息顺序先恢复最近一次有效模型配置，避免
    // 主线程显示“模型已启用”而新 Worker 实际退回无模型状态。
    if (workerValueModelConfigured) {
      instance.postMessage({
        id: ++requestId,
        type: 'configure-hybrid-model',
        model: workerValueModel,
      });
    }
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
  const observation = createPublicAIObservation(ctx);
  const timeoutMs = Number(options.timeoutMs) || 0;
  if (!aiWorkerAvailable()) return Promise.resolve(chooseAIPlay(observation));
  if (!worker) worker = createWorker();
  if (!worker) return Promise.resolve(chooseAIPlay(observation));
  const activeWorker = worker;
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const waiter = {
      resolve,
      reject,
      timer: null,
      worker: activeWorker,
      onWorkerFailure: () => resolve(chooseAIPlay(observation)),
    };
    pending.set(id, waiter);
    if (timeoutMs > 0) {
      waiter.timer = setTimeout(() => {
        if (!pending.has(id)) return;
        terminateFailedWorker(activeWorker, new Error('AI Worker 决策超时'));
      }, timeoutMs);
    }
    activeWorker.postMessage({ id, ctx: observation });
  });
}

/**
 * 配置可选的本地专用价值模型。主线程与 Worker 使用同一份经过校验的权重；
 * 传 null 清除模型。模型无效时保留上一份有效权重。
 */
export function configureAIWorkerValueModel(model, options = {}) {
  const local = configureHybridValueModel(model);
  if (!local.ok) return Promise.resolve(local);
  workerValueModelConfigured = true;
  workerValueModel = cloneModelConfig(model);
  if (!aiWorkerAvailable()) return Promise.resolve(local);
  if (!worker) worker = createWorker();
  if (!worker) return Promise.resolve(local);
  const activeWorker = worker;
  const timeoutMs = Number(options.timeoutMs) || 3000;
  return new Promise((resolve) => {
    const id = ++requestId;
    const waiter = {
      resolve,
      reject: () => resolve(local),
      timer: null,
      worker: activeWorker,
      onWorkerFailure: () => resolve(local),
    };
    pending.set(id, waiter);
    waiter.timer = setTimeout(() => {
      if (!pending.has(id)) return;
      terminateFailedWorker(activeWorker, new Error('AI Worker 模型配置超时'));
    }, timeoutMs);
    activeWorker.postMessage({ id, type: 'configure-hybrid-model', model });
  });
}
