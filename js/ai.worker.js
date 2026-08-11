/**
 * 本地 AI 决策 Web Worker：把 chooseAIPlay 的搜索（含残局满深度路线搜索）
 * 移出主线程，避免阻塞界面动画。deterministic 决策在真实对局里也会走这里；
 * Node 单测/A-B 没有 window，一律走客户端同步回退，行为不变。
 */
import { chooseAIPlay } from './ai.js';

self.onmessage = (event) => {
  const { id, ctx } = event.data || {};
  let payload;
  try {
    payload = { id, ok: true, decision: chooseAIPlay(ctx) };
  } catch (error) {
    payload = { id, ok: false, error: String(error?.message || error) };
  }
  self.postMessage(payload);
};
