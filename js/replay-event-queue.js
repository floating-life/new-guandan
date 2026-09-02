import { validateLivePublicEvent } from './replay-contracts.js';

export const REPLAY_QUEUE_SCHEMA = 'guandan-replay-pending-queue-v1';
export const REPLAY_QUEUE_STORAGE_KEY = 'guandan_replay_pending_v1';
export const REPLAY_QUEUE_DEFAULT_MAX_PENDING = 256;

const DEFAULT_MAX_EVENT_BYTES = 64 * 1024;
const DEFAULT_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 30_000;
const SHA256 = /^[a-f0-9]{64}$/;

const memoryStore = new Map();

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  return value;
}

function resolveStorage(candidate) {
  if (candidate && typeof candidate.getItem === 'function'
    && typeof candidate.setItem === 'function'
    && typeof candidate.removeItem === 'function') {
    return { storage: candidate, durable: true };
  }
  try {
    if (typeof localStorage !== 'undefined') return { storage: localStorage, durable: true };
  } catch { /* private browsing or disabled storage */ }
  return {
    durable: false,
    storage: {
      getItem: (key) => (memoryStore.has(key) ? memoryStore.get(key) : null),
      setItem: (key, value) => { memoryStore.set(key, String(value)); },
      removeItem: (key) => { memoryStore.delete(key); },
    },
  };
}

function defaultSchedule(fn, delay) {
  if (typeof globalThis.setTimeout === 'function') return globalThis.setTimeout(fn, delay);
  fn();
  return null;
}

function defaultClearSchedule(timer) {
  if (timer != null && typeof globalThis.clearTimeout === 'function') globalThis.clearTimeout(timer);
}

function retryableError(message, status = null) {
  const error = new Error(message);
  error.retryable = status == null || status === 408 || status === 425 || status === 429 || status >= 500;
  if (status != null) error.status = status;
  return error;
}

/**
 * Default RT-3 transport hook. RT-2 keeps the queue disabled by default;
 * callers must explicitly enable it after the local collector is opted in.
 */
export async function submitReplayEvent(event, {
  endpoint = '/api/replay/events',
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') throw retryableError('当前环境没有可用的 fetch');
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
    });
  } catch (error) {
    throw retryableError(`复盘事件提交失败：${error?.message || String(error)}`);
  }
  let body = null;
  try { body = await response.json(); } catch { /* 204 or non-JSON response */ }
  const matchesEvent = isRecord(body)
    && body.eventId === event?.eventId
    && body.eventSha256 === event?.eventSha256;
  if (body?.duplicate === true && body.ok !== false && matchesEvent) {
    return {
      ok: true,
      duplicate: true,
      eventId: event.eventId,
      eventSha256: event.eventSha256,
    };
  }
  if (response.ok) {
    if (!isRecord(body) || body.ok !== true || !matchesEvent) {
      const error = retryableError(
        body?.error || '复盘事件提交缺少匹配的业务回执',
        Number(response.status) || null,
      );
      error.code = 'invalid_replay_ack';
      throw error;
    }
    return {
      ok: true,
      duplicate: body.duplicate === true,
      eventId: event.eventId,
      eventSha256: event.eventSha256,
    };
  }
  throw retryableError(
    body?.error || `复盘事件提交返回 HTTP ${response.status}`,
    Number(response.status) || null,
  );
}

function isAccepted(result, event) {
  if (!isRecord(result)) return false;
  // Every successful acknowledgement must identify the exact event being
  // confirmed. Transport status or a bare boolean is not proof that this
  // event was durably accepted by the collector.
  if (result.eventId !== event.eventId || result.eventSha256 !== event.eventSha256) return false;
  if (result.ok === true) return true;
  if (result.duplicate === true && result.ok !== false) return true;
  return Number(result.status) >= 200 && Number(result.status) < 300;
}

function validSha(value) {
  return typeof value === 'string' && SHA256.test(value);
}

function normalizeAcked(value, limit) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => isRecord(item)
    && (item.matchId == null || typeof item.matchId === 'string')
    && typeof item.eventId === 'string'
    && validSha(item.eventSha256)
    && Number.isSafeInteger(item.sequence)
    && item.sequence >= 0)
    .slice(-limit)
    .map((item) => ({
      matchId: item.matchId || null,
      eventId: item.eventId,
      eventSha256: item.eventSha256,
      sequence: item.sequence,
    }));
}

function normalizeCursor(value) {
  if (!isRecord(value)) return { matchId: null, sequence: -1, eventSha256: null, eventId: null };
  return {
    matchId: typeof value.matchId === 'string' ? value.matchId : null,
    sequence: Number.isSafeInteger(value.sequence) && value.sequence >= -1 ? value.sequence : -1,
    eventSha256: validSha(value.eventSha256) ? value.eventSha256 : null,
    eventId: typeof value.eventId === 'string' ? value.eventId : null,
  };
}

function eventSize(event) {
  try { return new TextEncoder().encode(JSON.stringify(event)).byteLength; } catch { return Infinity; }
}

function eventKey(event) {
  return `${event.eventId}\u0000${event.eventSha256}`;
}

/**
 * Bounded, durable, non-blocking browser queue for public replay events.
 * It validates before persisting, preserves sequence order, detects gaps,
 * retries only asynchronously, and treats an acknowledged duplicate as a
 * successful idempotent delivery.
 */
export function createReplayEventQueue({
  storage: storageCandidate,
  storageKey = REPLAY_QUEUE_STORAGE_KEY,
  maxPending = REPLAY_QUEUE_DEFAULT_MAX_PENDING,
  maxEventBytes = DEFAULT_MAX_EVENT_BYTES,
  submit = submitReplayEvent,
  enabled: initiallyEnabled = false,
  schedule = defaultSchedule,
  clearSchedule = defaultClearSchedule,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
} = {}) {
  const resolvedStorage = resolveStorage(storageCandidate);
  const targetStorage = resolvedStorage.storage;
  const storageIsDurable = resolvedStorage.durable === true;
  const requestedLimit = Number(maxPending);
  const requestedEventBytes = Number(maxEventBytes);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.max(1, Math.floor(requestedLimit))
    : REPLAY_QUEUE_DEFAULT_MAX_PENDING;
  const eventByteLimit = Number.isFinite(requestedEventBytes) && requestedEventBytes > 0
    ? Math.max(1024, Math.floor(requestedEventBytes))
    : DEFAULT_MAX_EVENT_BYTES;
  const baseRetryDelay = Math.max(1, Number(retryDelayMs) || DEFAULT_RETRY_DELAY_MS);
  let submitter = typeof submit === 'function' ? submit : null;
  let enabled = initiallyEnabled === true;
  let timer = null;
  let flushing = false;
  let durable = storageIsDurable;
  let integrityGap = false;
  let durabilityGap = !storageIsDurable;
  let droppedCount = 0;
  let lastError = null;
  let retryCount = 0;
  let cursor = normalizeCursor(null);
  let acked = [];
  let events = [];
  // A persisted or explicit integrity failure is evidence that the stream can
  // no longer be trusted. Keep it separate from a temporarily recoverable
  // out-of-order enqueue gap, which may be repaired before a refresh.
  let integrityLock = false;

  function persisted() {
    return {
      schema: REPLAY_QUEUE_SCHEMA,
      cursor: clone(cursor),
      acked: clone(acked),
      events: clone(events),
      droppedCount,
      integrityGap,
      integrityLock,
      durabilityGap,
    };
  }

  function persist() {
    try {
      targetStorage.setItem(storageKey, JSON.stringify(persisted()));
      durable = storageIsDurable;
      if (!storageIsDurable) {
        durabilityGap = true;
        setError('当前环境没有可用的持久化存储，已暂停提交');
        return false;
      }
      return true;
    } catch {
      durable = false;
      durabilityGap = true;
      setError('本地待发复盘队列无法持久化，已暂停提交');
      return false;
    }
  }

  function setError(error) {
    lastError = String(error?.message || error || '复盘事件提交失败').slice(0, 240);
  }

  function latchIntegrityGap(error) {
    integrityLock = true;
    integrityGap = true;
    if (error) setError(error);
  }

  function findKnown(event) {
    const current = events.find((item) => item.eventId === event.eventId);
    if (current) return { kind: 'pending', event: current };
    const previous = acked.find((item) => item.eventId === event.eventId);
    if (previous) return { kind: 'acked', event: previous };
    return null;
  }

  function recomputeIntegrity() {
    let activeMatchId = cursor.matchId;
    let expected = activeMatchId == null ? 0 : cursor.sequence + 1;
    let previousSha = activeMatchId == null ? null : cursor.eventSha256;
    const ids = new Set();
    const matchIds = new Set(activeMatchId == null ? [] : [activeMatchId]);
    let gap = false;
    // sequence restarts at zero for a new match. Preserve enqueue order so a
    // later match cannot leapfrog older pending events in the same storage key.
    for (const event of events) {
      if (ids.has(event.eventId)) gap = true;
      ids.add(event.eventId);
      if (event.matchId !== activeMatchId) {
        if (matchIds.has(event.matchId)) gap = true;
        matchIds.add(event.matchId);
        activeMatchId = event.matchId;
        expected = 0;
        previousSha = null;
      }
      if (event.sequence !== expected) gap = true;
      if (previousSha == null) {
        if (event.sequence !== 0 || event.previousEventSha256 !== null) gap = true;
      } else if (event.previousEventSha256 !== previousSha) {
        gap = true;
      }
      expected = event.sequence + 1;
      previousSha = event.eventSha256;
    }
    integrityGap = integrityLock || gap;
    return !gap;
  }

  function insertPendingEvent(event) {
    const first = events.findIndex((item) => item.matchId === event.matchId);
    if (first < 0) {
      events.push(event);
      return;
    }
    let end = first;
    while (end < events.length && events[end].matchId === event.matchId) end += 1;
    const offset = events.slice(first, end).findIndex((item) => item.sequence > event.sequence);
    events.splice(offset < 0 ? end : first + offset, 0, event);
  }

  function hydrate() {
    let raw;
    try { raw = targetStorage.getItem(storageKey); } catch {
      durable = false;
      durabilityGap = true;
      return;
    }
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.schema !== REPLAY_QUEUE_SCHEMA) {
        latchIntegrityGap('本地待发复盘队列版本不匹配，已停止提交');
        return;
      }
      cursor = normalizeCursor(parsed.cursor);
      acked = normalizeAcked(parsed.acked, limit);
      droppedCount = Math.max(0, Number(parsed.droppedCount) || 0);
      // Older queue records only have integrityGap. Treat either field as a
      // durable lock: a refresh must not turn an earlier integrity alarm into
      // a clean queue merely because the remaining events happen to be linked.
      integrityLock = parsed.integrityGap === true || parsed.integrityLock === true;
      durabilityGap = !storageIsDurable || parsed.durabilityGap === true;
      durable = storageIsDurable && !durabilityGap;
      const loaded = Array.isArray(parsed.events) ? parsed.events : [];
      const valid = loaded.length <= limit && loaded.every((event) => (
        isRecord(event)
        && eventSize(event) <= eventByteLimit
        && validateLivePublicEvent(event).ok
      ));
      if (!valid) {
        events = [];
        latchIntegrityGap('本地待发复盘队列含无效事件，已停止提交');
      } else {
        events = loaded.map(clone);
        const chainIsContiguous = recomputeIntegrity();
        // A corrupted/older record may have failed to persist its alarm bit.
        // The chain itself is authoritative: once hydration observes a gap,
        // do not let a later repair silently clear the fail-closed state.
        if (!chainIsContiguous || droppedCount > 0) integrityLock = true;
        integrityGap = integrityLock || droppedCount > 0 || !chainIsContiguous;
      }
    } catch {
      events = [];
      latchIntegrityGap('本地待发复盘队列无法解析，已停止提交');
    }
  }

  function scheduleFlush(delay = 0) {
    if (!enabled || !submitter || timer != null || flushing || integrityGap || durabilityGap || droppedCount > 0) return;
    timer = schedule(() => {
      timer = null;
      void flush();
    }, delay);
  }

  function acknowledge(event) {
    if (events[0]?.eventId !== event.eventId || events[0]?.eventSha256 !== event.eventSha256) {
      latchIntegrityGap('提交回执与队首事件不一致');
      return { ok: false, reason: 'ack_mismatch' };
    }
    if (durabilityGap) {
      setError('本地待发复盘队列存在持久化缺口，已暂停提交');
      return { ok: false, reason: 'persistence_failed' };
    }
    const previousEvents = events;
    const previousCursor = cursor;
    const previousAcked = acked;
    const previousRetryCount = retryCount;
    events = events.slice(1);
    cursor = {
      matchId: event.matchId,
      sequence: event.sequence,
      eventSha256: event.eventSha256,
      eventId: event.eventId,
    };
    acked = [...acked.filter((item) => item.eventId !== event.eventId), {
      matchId: event.matchId,
      eventId: event.eventId,
      eventSha256: event.eventSha256,
      sequence: event.sequence,
    }].slice(-limit);
    retryCount = 0;
    lastError = null;
    recomputeIntegrity();
    if (!persist()) {
      // The server may already have accepted this event. Keep it in memory
      // until local durability is restored; a later retry is safe because
      // eventId delivery is idempotent.
      events = previousEvents;
      cursor = previousCursor;
      acked = previousAcked;
      retryCount = previousRetryCount;
      recomputeIntegrity();
      return { ok: false, reason: 'persistence_failed' };
    }
    return { ok: true };
  }

  async function flush() {
    if (flushing) return { ok: false, reason: 'busy' };
    if (!enabled) return { ok: false, reason: 'disabled', sent: 0 };
    if (!submitter) return { ok: false, reason: 'no_submitter', sent: 0 };
    recomputeIntegrity();
    if (integrityGap || durabilityGap || droppedCount > 0) {
      return {
        ok: false,
        reason: durabilityGap ? 'durability_gap' : droppedCount > 0 ? 'queue_overflow' : 'sequence_gap',
        sent: 0,
      };
    }
    if (!events.length) return { ok: true, sent: 0 };

    flushing = true;
    let sent = 0;
    let retryAfter = null;
    try {
      while (enabled && submitter && events.length) {
        const event = events[0];
        let result;
        try {
          result = await submitter(clone(event));
        } catch (error) {
          throw error;
        }
        if (!isAccepted(result, event)) throw retryableError('复盘事件提交未确认成功');
        const acknowledged = acknowledge(event);
        if (!acknowledged.ok) return { ...acknowledged, sent };
        sent += 1;
      }
      return { ok: true, sent };
    } catch (error) {
      setError(error);
      retryCount += 1;
      persist();
      if (error?.retryable !== false && enabled && submitter && !integrityGap && !durabilityGap) {
        retryAfter = Math.min(MAX_RETRY_DELAY_MS, baseRetryDelay * (2 ** Math.min(retryCount - 1, 6)));
      }
      return { ok: false, reason: 'submit_failed', sent, retryable: error?.retryable !== false };
    } finally {
      flushing = false;
      if (retryAfter != null) scheduleFlush(retryAfter);
    }
  }

  hydrate();

  return Object.freeze({
    enqueue(event) {
      try {
        if (!isRecord(event) || !validateLivePublicEvent(event).ok) {
          latchIntegrityGap('复盘事件未通过公开契约校验');
          persist();
          return { ok: false, reason: 'invalid_event' };
        }
        if (eventSize(event) > eventByteLimit) {
          latchIntegrityGap('复盘事件超过本地队列单事件上限');
          persist();
          return { ok: false, reason: 'event_too_large' };
        }
        const known = findKnown(event);
        if (known) {
          if (known.event.eventSha256 === event.eventSha256) {
            return { ok: true, duplicate: true, queued: known.kind === 'pending' };
          }
          latchIntegrityGap('相同 eventId 的事件摘要不一致');
          persist();
          return { ok: false, reason: 'event_conflict' };
        }
        if (events.length >= limit) {
          droppedCount += 1;
          latchIntegrityGap('本地待发复盘队列已满，已记录 sequence 缺口');
          persist();
          return { ok: false, reason: 'queue_full', gap: true };
        }
        insertPendingEvent(clone(event));
        recomputeIntegrity();
        persist();
        if (!integrityGap && !durabilityGap) scheduleFlush();
        return { ok: true, queued: true, gap: integrityGap || durabilityGap };
      } catch (error) {
        latchIntegrityGap(error);
        persist();
        return { ok: false, reason: 'queue_error' };
      }
    },
    flush,
    setEnabled(value) {
      enabled = value === true;
      if (enabled) scheduleFlush();
      else if (timer != null) {
        clearSchedule(timer);
        timer = null;
      }
      return enabled;
    },
    clearPending() {
      if (enabled) return { ok: false, reason: 'must_pause', pendingCount: events.length };
      events = [];
      persist();
      return { ok: true, pendingCount: 0, gap: integrityGap || durabilityGap || droppedCount > 0 };
    },
    setSubmitter(fn) {
      submitter = typeof fn === 'function' ? fn : null;
      if (submitter && enabled) scheduleFlush();
    },
    snapshot() {
      return {
        schema: REPLAY_QUEUE_SCHEMA,
        enabled,
        durable,
        pendingCount: events.length,
        pendingEvents: clone(events),
        lastMatchId: cursor.matchId,
        lastSequence: cursor.sequence,
        lastEventId: cursor.eventId,
        lastEventSha256: cursor.eventSha256,
        gap: integrityGap || durabilityGap || droppedCount > 0,
        integrityGap,
        integrityLock,
        durabilityGap,
        droppedCount,
        retryCount,
        lastError,
      };
    },
    dispose() {
      if (timer != null) clearSchedule(timer);
      timer = null;
      enabled = false;
    },
  });
}
