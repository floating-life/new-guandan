/**
 * 本地 AI 决策 Web Worker：把 chooseAIPlay 的搜索（含残局满深度路线搜索）
 * 移出主线程，避免阻塞界面动画。deterministic 决策在真实对局里也会走这里；
 * Node 单测/A-B 没有 window，一律走客户端同步回退，行为不变。
 */
import { chooseAIPlay } from './ai.js';
import { configureHybridValueModel } from './ai-hybrid.js';
import { createPublicAIObservation } from './ai-observation.js';

self.onmessage = (event) => {
  const { id, type = 'decision', ctx, model } = event.data || {};
  let payload;
  try {
    payload = type === 'configure-hybrid-model'
      ? { id, ok: true, decision: configureHybridValueModel(model) }
      : { id, ok: true, decision: chooseAIPlay(createPublicAIObservation(ctx)) };
  } catch (error) {
    payload = { id, ok: false, error: String(error?.message || error) };
  }
  self.postMessage(payload);
};
