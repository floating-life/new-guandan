import { createLivePublicEvent } from './replay-contracts.js';
import { createReplayEventQueue, submitReplayEvent } from './replay-event-queue.js';

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

function storage({ failReads = false, failWrites = false, failWritesAfter = null } = {}) {
  const values = new Map();
  let writes = 0;
  return {
    getItem: (key) => {
      if (failReads) throw new Error('模拟存储读取失败');
      return values.get(key) || null;
    },
    setItem: (key, value) => {
      if (failWrites || (Number.isSafeInteger(failWritesAfter) && writes >= failWritesAfter)) {
        throw new Error('模拟存储空间不足');
      }
      writes += 1;
      values.set(key, String(value));
    },
    removeItem: (key) => values.delete(key),
    values,
  };
}

function scheduler() {
  const jobs = [];
  return {
    jobs,
    schedule(fn, delay) {
      const id = jobs.length;
      jobs.push({ id, fn, delay, cancelled: false });
      // Tests drive flush() explicitly; returning null keeps a recorded
      // schedule from looking like a live timer that was never drained.
      return null;
    },
    clear(id) {
      if (jobs[id]) jobs[id].cancelled = true;
    },
  };
}

function sha(char) {
  return char.repeat(64);
}

function event(
  sequence,
  previousEventSha256 = null,
  eventId = `event-${sequence}`,
  matchId = 'queue-test-match',
) {
  return createLivePublicEvent({
    matchId,
    round: 1,
    trick: 1,
    turn: sequence + 1,
    eventId,
    sequence,
    occurredAt: `2026-09-01T00:00:0${sequence}.000Z`,
    ruleVersion: 'guandan-rules-v1',
    implementationSha256: sha('a'),
    previousEventSha256,
    eventType: 'pass',
    seat: 0,
    action: 'pass',
    cards: [],
    hand: null,
    countsBefore: [10, 10, 10, 10],
    countsAfter: [10, 10, 10, 10],
    tribute: [],
    engine: null,
    decisionMeta: null,
  });
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function accepted(item) {
  return { ok: true, eventId: item.eventId, eventSha256: item.eventSha256 };
}

console.log('RT-2 本机复盘待发队列');

{
  const target = storage();
  const queue = createReplayEventQueue({ storage: target, enabled: false });
  const first = event(0);
  const result = queue.enqueue(first);
  const persisted = JSON.parse(target.values.get('guandan_replay_pending_v1'));
  assert(result.ok && result.queued, '合法公开事件进入本机待发队列');
  assert(queue.snapshot().pendingCount === 1 && persisted.events[0].eventId === first.eventId,
    '待发队列按独立存储键持久化且保留原 eventId');
}

{
  const jobs = scheduler();
  const queue = createReplayEventQueue({
    storage: storage(),
    enabled: false,
    schedule: jobs.schedule,
    clearSchedule: jobs.clear,
    submit: async (item) => accepted(item),
  });
  const first = event(0, null, 'match-one:event-0', 'match-one');
  const second = event(1, first.eventSha256, 'match-one:event-1', 'match-one');
  const nextMatch = event(0, null, 'match-two:event-0', 'match-two');
  queue.enqueue(first);
  queue.enqueue(second);
  queue.enqueue(nextMatch);
  const beforeFlush = queue.snapshot();
  assert(!beforeFlush.gap
    && beforeFlush.pendingEvents.map((item) => `${item.matchId}:${item.sequence}`).join(',')
      === 'match-one:0,match-one:1,match-two:0',
  '新副 sequence 从0重启时按 matchId 分段且保持旧事件先提交');
  queue.setEnabled(true);
  const flushed = await queue.flush();
  assert(flushed.ok && flushed.sent === 3 && queue.snapshot().lastMatchId === 'match-two'
    && queue.snapshot().lastSequence === 0 && queue.snapshot().pendingCount === 0,
  '跨副提交后游标绑定最新 matchId，不误报序号缺口');
}

{
  const queue = createReplayEventQueue({ storage: storage() });
  const first = event(0);
  const invalid = { ...first, countsAfter: [9, 10, 10, 10] };
  const result = queue.enqueue(invalid);
  assert(!result.ok && result.reason === 'invalid_event', '事件摘要被篡改时拒绝入队并记录完整性异常');
  assert(queue.snapshot().gap && queue.snapshot().pendingCount === 0,
    '非法事件不进入队列且状态 fail closed');
}

{
  const target = storage();
  const queue = createReplayEventQueue({ storage: target });
  const first = event(0);
  const second = event(1, first.eventSha256);
  const third = event(2, second.eventSha256);
  queue.enqueue(first);
  queue.enqueue(third);
  assert(queue.snapshot().gap, 'sequence 缺口在入队时立即可见');
  queue.enqueue(second);
  assert(!queue.snapshot().gap && queue.snapshot().pendingEvents.map((item) => item.sequence).join(',') === '0,1,2',
    '迟到的中间事件补齐后恢复连续 sequence 与前序摘要链');
}

{
  const queue = createReplayEventQueue({ storage: storage() });
  const first = event(0);
  const duplicate = queue.enqueue(first);
  const again = queue.enqueue(first);
  assert(duplicate.ok && again.ok && again.duplicate && queue.snapshot().pendingCount === 1,
    '相同 eventId 与摘要重复入队保持幂等');
  const conflict = queue.enqueue(event(1, first.eventSha256, first.eventId));
  assert(!conflict.ok && conflict.reason === 'event_conflict' && queue.snapshot().gap,
    '相同 eventId 但摘要不同的重发被拒绝');
}

{
  const target = storage();
  const jobs = scheduler();
  let calls = 0;
  const queue = createReplayEventQueue({
    storage: target,
    enabled: false,
    schedule: jobs.schedule,
    clearSchedule: jobs.clear,
    submit: async (item) => {
      calls++;
      assert(item.eventId === 'event-0', '异步提交收到原始公开事件的不可变副本');
      return accepted(item);
    },
  });
  const first = event(0);
  queue.enqueue(first);
  queue.setEnabled(true);
  queue.setEnabled(false);
  assert(calls === 0 && queue.snapshot().pendingCount === 1, '未显式启用时不发起网络提交');
  queue.setEnabled(true);
  queue.flush().then(() => {
    assert(calls === 1 && queue.snapshot().pendingCount === 0, '启用后异步提交成功并推进本地游标');
    const duplicate = queue.enqueue(first);
    assert(duplicate.ok && duplicate.duplicate && queue.snapshot().pendingCount === 0,
      '已确认事件再次重发按 eventId 幂等接受');
  }).catch((error) => {
    failed++;
    console.error('  ✗ 异步队列测试异常', error);
  });
}

{
  const target = storage();
  const jobs = scheduler();
  let shouldFail = true;
  const queue = createReplayEventQueue({
    storage: target,
    schedule: jobs.schedule,
    clearSchedule: jobs.clear,
    submit: async (item) => {
      if (shouldFail) {
        const error = new Error('模拟服务中断');
        error.retryable = true;
        throw error;
      }
      return accepted(item);
    },
  });
  queue.enqueue(event(0));
  queue.setEnabled(true);
  queue.flush().then(async (result) => {
    assert(!result.ok && result.retryable && queue.snapshot().pendingCount === 1,
      '提交失败不丢弃事件，保留待发项并安排异步重试');
    assert(jobs.jobs.some((job) => !job.cancelled && job.delay > 0), '失败重试使用延迟调度而不是阻断牌局');
    shouldFail = false;
    const retried = await queue.flush();
    assert(retried.ok && retried.sent === 1 && queue.snapshot().pendingCount === 0,
      '服务恢复后重试成功并清空已确认事件');
  }).catch((error) => {
    failed++;
    console.error('  ✗ 重试队列测试异常', error);
  });
}

{
  const jobs = scheduler();
  const queue = createReplayEventQueue({
    storage: storage(),
    maxPending: 1,
    schedule: jobs.schedule,
    clearSchedule: jobs.clear,
  });
  const first = event(0);
  const second = event(1, first.eventSha256);
  queue.enqueue(first);
  const result = queue.enqueue(second);
  assert(!result.ok && result.reason === 'queue_full', '队列达到上限时拒绝新事件而不无界增长');
  assert(queue.snapshot().gap && queue.snapshot().droppedCount === 1, '队列溢出显式记录可审计缺口');
}

{
  const target = storage();
  const jobs = scheduler();
  let calls = 0;
  const first = event(0);
  const queue = createReplayEventQueue({
    storage: target,
    enabled: false,
    schedule: jobs.schedule,
    clearSchedule: jobs.clear,
    submit: (item) => submitReplayEvent(item, {
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({ ok: false, error: 'rejected-by-business-rule' });
      },
    }),
  });
  queue.enqueue(first);
  queue.setEnabled(true);
  const result = await queue.flush();
  assert(calls === 1 && !result.ok && result.retryable === false && result.reason === 'submit_failed',
    'HTTP 200 的业务拒绝回执不会伪装成成功');
  assert(queue.snapshot().pendingCount === 1 && queue.snapshot().lastSequence === -1,
    '业务拒绝保留队首事件而不推进本地游标');
}

{
  const target = storage();
  const first = event(0);
  const queue = createReplayEventQueue({
    storage: target,
    enabled: false,
    submit: (item) => submitReplayEvent(item, {
      fetchImpl: async () => jsonResponse({
        ok: true, eventId: 'wrong-event', eventSha256: sha('b'),
      }),
    }),
  });
  queue.enqueue(first);
  queue.setEnabled(true);
  const result = await queue.flush();
  assert(!result.ok && result.retryable === false && result.reason === 'submit_failed',
    'HTTP 成功状态但 eventId/摘要错配时拒绝回执');
  assert(queue.snapshot().pendingCount === 1 && queue.snapshot().lastSequence === -1,
    '错配回执不会删除或确认队首事件');
}

{
  const target = storage();
  const first = event(0);
  const queue = createReplayEventQueue({
    storage: target,
    enabled: false,
    submit: (item) => submitReplayEvent(item, {
      fetchImpl: async () => jsonResponse(null, 204),
    }),
  });
  queue.enqueue(first);
  queue.setEnabled(true);
  const result = await queue.flush();
  assert(!result.ok && result.retryable === false && result.reason === 'submit_failed',
    '无 eventId/摘要身份的 HTTP 204 回执不会被视为成功');
  assert(queue.snapshot().pendingCount === 1 && queue.snapshot().lastSequence === -1,
    '无身份回执不会删除或确认队首事件');
}

{
  const unboundResults = [true, { ok: true }, { status: 204 }, { duplicate: true }];
  const outcomes = [];
  for (const [index, unbound] of unboundResults.entries()) {
    const jobs = scheduler();
    const queue = createReplayEventQueue({
      storage: storage(),
      enabled: false,
      schedule: jobs.schedule,
      clearSchedule: jobs.clear,
      submit: async () => unbound,
    });
    queue.enqueue(event(0, null, `unbound-${index}`));
    queue.setEnabled(true);
    const result = await queue.flush();
    const snapshot = queue.snapshot();
    outcomes.push(!result.ok && result.reason === 'submit_failed'
      && snapshot.pendingCount === 1 && snapshot.lastSequence === -1);
  }
  assert(outcomes.every(Boolean),
    '队列最终确认边界拒绝所有无 eventId/摘要身份的成功形态');
}

{
  const target = storage();
  const jobs = scheduler();
  const initial = createReplayEventQueue({
    storage: target,
    maxPending: 1,
    schedule: jobs.schedule,
    clearSchedule: jobs.clear,
  });
  initial.enqueue(event(0));
  initial.enqueue(event(1, event(0).eventSha256));
  let submitCalls = 0;
  const restored = createReplayEventQueue({
    storage: target,
    maxPending: 1,
    enabled: true,
    submit: async (item) => {
      submitCalls += 1;
      return accepted(item);
    },
    schedule: jobs.schedule,
    clearSchedule: jobs.clear,
  });
  const snapshot = restored.snapshot();
  const result = await restored.flush();
  assert(snapshot.integrityGap && snapshot.droppedCount === 1 && snapshot.gap,
    '刷新后仍保留持久化的队列溢出完整性缺口');
  assert(!result.ok && result.reason === 'queue_overflow' && submitCalls === 0
    && restored.snapshot().pendingCount === 1,
  '刷新恢复的溢出队列继续 fail closed，不发送或丢弃队首事件');
}

{
  const target = storage();
  const initial = createReplayEventQueue({ storage: target, maxPending: 3 });
  const first = event(0);
  const late = event(2, first.eventSha256);
  initial.enqueue(first);
  initial.enqueue(late);
  const restored = createReplayEventQueue({
    storage: target,
    maxPending: 3,
    enabled: true,
    submit: async (item) => accepted(item),
  });
  const beforeRepair = restored.snapshot();
  const middle = restored.enqueue(event(1, first.eventSha256));
  const result = await restored.flush();
  assert(beforeRepair.integrityGap && beforeRepair.droppedCount === 0
    && beforeRepair.gap && middle.ok && middle.gap,
  '刷新后仍锁存未丢牌的持久化完整性缺口');
  assert(!result.ok && result.reason === 'sequence_gap' && restored.snapshot().pendingCount === 3,
    '补齐刷新后的完整性缺口也不能自动解除 fail-closed 锁');
}

{
  const target = storage();
  const first = event(0);
  const late = event(2, first.eventSha256);
  target.values.set('tampered-gap', JSON.stringify({
    schema: 'guandan-replay-pending-queue-v1',
    cursor: { matchId: null, sequence: -1, eventSha256: null, eventId: null },
    acked: [], events: [first, late], droppedCount: 0,
    integrityGap: false, integrityLock: false, durabilityGap: false,
  }));
  const restored = createReplayEventQueue({
    storage: target,
    storageKey: 'tampered-gap',
    maxPending: 3,
    enabled: true,
    submit: async (item) => accepted(item),
  });
  const beforeRepair = restored.snapshot();
  const middle = restored.enqueue(event(1, first.eventSha256));
  const result = await restored.flush();
  assert(beforeRepair.integrityGap && beforeRepair.integrityLock && middle.ok && middle.gap,
    '刷新时即使旧记录漏写完整性标记，链缺口也会被锁存');
  assert(!result.ok && result.reason === 'sequence_gap' && restored.snapshot().pendingCount === 3,
    '锁存的刷新链缺口不能因补齐事件而自动恢复提交');
}

{
  const jobs = scheduler();
  let submitCalls = 0;
  const queue = createReplayEventQueue({
    storage: storage({ failWrites: true }),
    enabled: true,
    schedule: jobs.schedule,
    clearSchedule: jobs.clear,
    submit: async (item) => {
      submitCalls += 1;
      return accepted(item);
    },
  });
  const result = queue.enqueue(event(0));
  const blocked = await queue.flush();
  const snapshot = queue.snapshot();
  assert(result.ok && snapshot.pendingCount === 1, '本地存储失败不抛出异常，当前回合仍保留内存待发事件');
  assert(!snapshot.durable && snapshot.durabilityGap && snapshot.gap
    && blocked.reason === 'durability_gap' && submitCalls === 0 && jobs.jobs.length === 0,
  '存储失败标记非持久化与完整性风险，并在恢复持久化前阻断提交');
}

{
  const target = storage({ failWritesAfter: 1 });
  const queue = createReplayEventQueue({ storage: target, enabled: false });
  const first = event(0);
  queue.enqueue(first);
  let submitCalls = 0;
  queue.setSubmitter(async (item) => {
    submitCalls += 1;
    return accepted(item);
  });
  queue.setEnabled(true);
  const flushed = await queue.flush();
  const snapshot = queue.snapshot();
  assert(submitCalls === 1 && !flushed.ok && flushed.reason === 'persistence_failed'
    && snapshot.pendingCount === 1 && snapshot.lastSequence === -1 && snapshot.durabilityGap,
  '提交已确认但本地持久化失败时保留队首事件并 fail closed');
  const blocked = await queue.flush();
  assert(submitCalls === 1 && !blocked.ok && blocked.reason === 'durability_gap'
    && queue.snapshot().pendingCount === 1,
  '持久化缺口期间不重复提交或丢弃未落盘事件');
}

{
  const queue = createReplayEventQueue({ storage: storage({ failReads: true }) });
  const snapshot = queue.snapshot();
  assert(!snapshot.durable && snapshot.durabilityGap && snapshot.gap,
    '本地存储读取失败标记非持久化与完整性风险');
}

{
  const jobs = scheduler();
  let submitCalls = 0;
  const queue = createReplayEventQueue({
    storage: null,
    storageKey: 'memory-only-fallback',
    enabled: true,
    schedule: jobs.schedule,
    clearSchedule: jobs.clear,
    submit: async (item) => {
      submitCalls += 1;
      return accepted(item);
    },
  });
  const before = queue.snapshot();
  const queued = queue.enqueue(event(0));
  const blocked = await queue.flush();
  assert(!before.durable && before.durabilityGap && queued.ok && queued.gap,
    '无可用 localStorage 时内存回退明确标记为非持久化');
  assert(!blocked.ok && blocked.reason === 'durability_gap' && submitCalls === 0,
    '非持久化内存回退在恢复持久化前阻断网络提交');
}

await new Promise((resolve) => setTimeout(resolve, 0));
console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
