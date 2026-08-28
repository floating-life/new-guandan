/**
 * 将“下次启动自动加载”的保存和运行时启用组织为一个小事务。
 *
 * 最重要的边界是：浏览器配额不足时绝不能先改动主线程/Worker 的模型，
 * 否则页面会提示保存失败、实际对局却已换用新权重。预检通过后仍先持久化，
 * 只有写入成功才允许调用运行时启用函数。
 */
export async function persistThenActivateValueModel({
  model,
  preflight,
  load,
  save,
  clear,
  activate,
}) {
  const check = preflight(model);
  if (!check?.ok) return { ...check, stage: 'preflight' };

  const previous = load();
  if (!save(model)) {
    return { ok: false, reason: 'storage_write_failed', stage: 'persist' };
  }

  try {
    const result = await activate(model);
    if (result?.ok) return { ...result, persisted: true };
    const restored = previous == null ? clear() : save(previous);
    return {
      ...result,
      ok: false,
      reason: result?.reason || 'activation_failed',
      stage: 'activate',
      rollbackFailed: !restored,
    };
  } catch (error) {
    const restored = previous == null ? clear() : save(previous);
    return {
      ok: false,
      reason: String(error?.message || error || 'activation_failed'),
      stage: 'activate',
      rollbackFailed: !restored,
    };
  }
}
