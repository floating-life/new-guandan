import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createLivePublicEvent,
  validateAgentAnnotation,
} from '../js/replay-contracts.js';
import {
  ReplayConsumerError,
  assertSafeStoragePath,
  consumeOnce,
  createReplayAnnotation,
  main as runConsumer,
  parseReplayEndpoint,
  readAnnotationStore,
} from './replay_consumer.mjs';

const TOKEN = 't'.repeat(40);
const ENDPOINT = 'http://127.0.0.1:20801/api/replay/events';

function event(sequence, previousEventSha256 = null, eventType = 'play', matchId = 'rt4-test-match') {
  return createLivePublicEvent({
    matchId,
    round: sequence < 2 ? 1 : 2,
    trick: sequence < 2 ? 1 : 2,
    turn: sequence + 1,
    eventId: `rt4-event-${sequence}`,
    sequence,
    occurredAt: '2026-09-02T00:00:00.000Z',
    ruleVersion: 'guandan-rules-v1',
    implementationSha256: 'a'.repeat(64),
    previousEventSha256,
    eventType,
    seat: eventType === 'play' || eventType === 'pass' ? 0 : null,
    action: eventType === 'play' || eventType === 'pass' ? eventType : null,
    cards: eventType === 'play' ? [{ rank: 2, suit: 'S' }] : [],
    hand: eventType === 'play' ? { type: 'single', mainRank: 2, size: 1, power: 2 } : null,
    countsBefore: [2, 5, 5, 5],
    countsAfter: [1, 5, 5, 5],
    tribute: [],
    engine: null,
    decisionMeta: null,
  });
}

function response(events, matchId, nextSequence, hasMore = false) {
  return {
    ok: true,
    matchId,
    events,
    nextSequence,
    hasMore,
    collector: { enabled: true, gap: false, lastError: null, capabilityExpiresAt: null },
  };
}

function fakeFetch(responses, calls) {
  return async (url, init) => {
    calls.push({ url: new URL(url), init });
    const payload = responses.shift();
    if (payload instanceof Error) throw payload;
    return { ok: true, status: 200, json: async () => payload };
  };
}

function expectConsumerError(action, code) {
  return assert.rejects(action, (error) => error instanceof ReplayConsumerError && error.code === code);
}

async function main() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'guandan-rt4-'));
  const cursorPath = path.join(temporary, 'cursor.json');
  const annotationPath = path.join(temporary, 'annotations.ndjson');
  const calls = [];
  try {
    assert.equal(parseReplayEndpoint(ENDPOINT).pathname, '/api/replay/events');
    assert.throws(() => parseReplayEndpoint('https://127.0.0.1:20801/api/replay/events'), /回环地址/);
    assert.throws(() => parseReplayEndpoint('http://example.test/api/replay/events'), /回环地址/);
    assert.throws(() => parseReplayEndpoint('http://127.0.0.1:20801/api/replay/events?x=1'), /查询参数/);
    assertSafeStoragePath(path.join(temporary, 'safe.json'));
    assert.throws(() => assertSafeStoragePath(process.cwd()), /项目目录/);
    assert.throws(() => assertSafeStoragePath('D:\\WPSDrive\\Guandan\\annotation.ndjson'), /WPSDrive/);
    const symlinkPath = path.join(temporary, 'linked-storage');
    try {
      fs.symlinkSync(temporary, symlinkPath, 'junction');
      assert.throws(() => assertSafeStoragePath(path.join(symlinkPath, 'cursor.json')), /符号链接/);
    } catch (error) {
      if (!(error instanceof ReplayConsumerError) && !String(error?.code || '').match(/EPERM|EACCES|UNKNOWN/)) throw error;
    }
    console.log('  [OK] 端点和消费者存储路径严格限制在安全边界');

    const first = event(0);
    const second = event(1, first.eventSha256, 'pass');
    const third = event(2, second.eventSha256);
    const fetchImpl = fakeFetch([
      response([first, second], first.matchId, 1, true),
      response([third], first.matchId, 2, false),
    ], calls);
    const firstResult = await consumeOnce({
      endpoint: ENDPOINT, token: TOKEN, cursorPath, annotationPath,
      model: 'test-model', promptVersion: 'test-prompt-v1', limit: 2, fetchImpl,
    });
    assert.equal(firstResult.summary.events, 2);
    assert.equal(firstResult.summary.rounds.length, 1);
    assert.equal(firstResult.summary.rounds[0].tricks[0].turns.length, 2);
    assert.equal(firstResult.cursor.sequence, 1);
    assert.equal(firstResult.hasMore, true);
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(calls[0].init.headers['X-Guandan-Replay-Capability'], TOKEN);
    assert.equal(new URL(calls[0].url).searchParams.get('afterSequence'), '-1');
    console.log('  [OK] 首次分页只读消费、链校验和手/圈/副摘要通过');

    const secondResult = await consumeOnce({
      endpoint: ENDPOINT, token: TOKEN, cursorPath, annotationPath,
      model: 'test-model', promptVersion: 'test-prompt-v1', fetchImpl,
    });
    assert.equal(secondResult.cursor.sequence, 2);
    assert.equal(calls[1].url.searchParams.get('afterSequence'), '1');
    assert.equal(calls[1].url.searchParams.get('matchId'), first.matchId);
    const annotations = readAnnotationStore(annotationPath);
    const sourceEvents = new Map([[first.eventId, first], [second.eventId, second], [third.eventId, third]]);
    assert.equal(annotations.size, 3);
    for (const annotation of annotations.values()) {
      assert.equal(validateAgentAnnotation(annotation, sourceEvents.get(annotation.eventId)).ok, true);
      assert.equal(annotation.model, 'test-model');
      assert.equal(annotation.promptVersion, 'test-prompt-v1');
      assert.equal('cards' in annotation, false);
      assert.equal('trainingEligible' in annotation, false);
      assert.equal('reward' in annotation.content, false);
    }
    console.log('  [OK] 断点恢复绑定 matchId，annotation 独立且不含源事件/训练标签');

    const recoveredCalls = [];
    const recovered = await consumeOnce({
      endpoint: ENDPOINT, token: TOKEN, cursorPath, annotationPath,
      fetchImpl: fakeFetch([response([], first.matchId, 2, false)], recoveredCalls),
    });
    assert.equal(recovered.summary.events, 0);
    assert.equal(recovered.cursor.sequence, 2);
    console.log('  [OK] 无新事件时保留已确认 cursor');

    const savedCursor = JSON.parse(fs.readFileSync(cursorPath, 'utf8'));
    fs.writeFileSync(cursorPath, JSON.stringify({
      ...savedCursor, sequence: 1, eventSha256: second.eventSha256,
    }), { mode: 0o600 });
    const replayed = await consumeOnce({
      endpoint: ENDPOINT, token: TOKEN, cursorPath, annotationPath,
      model: 'test-model', promptVersion: 'test-prompt-v1', fetchImpl: fakeFetch([
        response([third], first.matchId, 2, false),
      ], []),
    });
    assert.equal(replayed.cursor.sequence, 2);
    assert.equal(readAnnotationStore(annotationPath).size, 3);
    console.log('  [OK] annotation 已落盘而 cursor 未落盘时可幂等恢复');

    const beforeBad = JSON.parse(fs.readFileSync(cursorPath, 'utf8'));
    fs.writeFileSync(cursorPath, JSON.stringify({ ...beforeBad, eventSha256: null }), { mode: 0o600 });
    await expectConsumerError(consumeOnce({
      endpoint: ENDPOINT, token: TOKEN, cursorPath, annotationPath,
      fetchImpl: fakeFetch([], []),
    }), 'invalid_state');
    fs.writeFileSync(cursorPath, JSON.stringify(beforeBad), { mode: 0o600 });
    console.log('  [OK] 已前进但缺少事件摘要的损坏 cursor 被拒绝');

    fs.writeFileSync(cursorPath, JSON.stringify({ ...beforeBad, sequence: Number.MAX_SAFE_INTEGER + 1 }), { mode: 0o600 });
    await expectConsumerError(consumeOnce({
      endpoint: ENDPOINT, token: TOKEN, cursorPath, annotationPath,
      fetchImpl: fakeFetch([], []),
    }), 'invalid_state');
    fs.writeFileSync(cursorPath, JSON.stringify(beforeBad), { mode: 0o600 });
    console.log('  [OK] 超出安全整数范围的损坏 cursor 被拒绝');

    const missingGap = response([], first.matchId, 2, false);
    delete missingGap.collector.gap;
    await expectConsumerError(consumeOnce({
      endpoint: ENDPOINT, token: TOKEN, cursorPath, annotationPath,
      fetchImpl: fakeFetch([missingGap], []),
    }), 'source_gap');
    console.log('  [OK] 缺少 collector gap 状态的坏响应被拒绝');

    await expectConsumerError(consumeOnce({
      endpoint: ENDPOINT, token: TOKEN, cursorPath, annotationPath,
      fetchImpl: fakeFetch([response([], first.matchId, Number.MAX_SAFE_INTEGER + 1, false)], []),
    }), 'invalid_response');
    console.log('  [OK] 超出安全整数范围的响应 nextSequence 被拒绝');

    await expectConsumerError(consumeOnce({
      endpoint: ENDPOINT, token: TOKEN, cursorPath, annotationPath,
      fetchImpl: fakeFetch([response([event(4, third.eventSha256)], first.matchId, 4)], []),
    }), 'chain_gap');
    assert.deepEqual(JSON.parse(fs.readFileSync(cursorPath, 'utf8')), beforeBad);
    console.log('  [OK] 漏序响应 fail closed 且不推进游标');

    await expectConsumerError(consumeOnce({
      endpoint: ENDPOINT, token: TOKEN, cursorPath, annotationPath,
      fetchImpl: fakeFetch([response([event(3, third.eventSha256, 'play', 'other-match')], 'other-match', 3)], []),
    }), 'cursor_mismatch');
    console.log('  [OK] 跨 match 响应被拒绝');

    await expectConsumerError(consumeOnce({
      endpoint: ENDPOINT, token: TOKEN, cursorPath, annotationPath,
      fetchImpl: fakeFetch([response([event(2, third.eventSha256, 'play', 'other-match')], first.matchId, 2)], []),
    }), 'chain_gap');
    console.log('  [OK] 响应 matchId 与事件身份串线时被拒绝');

    const failureCalls = [];
    await expectConsumerError(consumeOnce({
      endpoint: ENDPOINT, token: TOKEN, cursorPath, annotationPath,
      fetchImpl: fakeFetch([new Error('offline')], failureCalls),
    }), 'network_error');
    assert.deepEqual(JSON.parse(fs.readFileSync(cursorPath, 'utf8')), beforeBad);
    console.log('  [OK] 网络失败不丢失已有 cursor，下一次运行可恢复');

    const validStored = annotations.values().next().value;
    const halfPath = path.join(temporary, 'half-line.ndjson');
    fs.writeFileSync(halfPath, `${JSON.stringify(validStored)}\n{"partial`, { mode: 0o600 });
    const recoveredHalf = readAnnotationStore(halfPath);
    assert.equal(recoveredHalf.size, 1);
    assert.equal(recoveredHalf.get(validStored.annotationId).annotationId, validStored.annotationId);
    assert.equal(fs.readFileSync(halfPath, 'utf8'), `${JSON.stringify(validStored)}\n`);
    const halfConsume = await consumeOnce({
      endpoint: ENDPOINT, token: TOKEN, cursorPath, annotationPath: halfPath,
      fetchImpl: fakeFetch([response([], first.matchId, 2, false)], []),
    });
    assert.equal(halfConsume.summary.events, 0);
    assert.equal(readAnnotationStore(halfPath).size, 1);
    console.log('  [OK] annotation 末行半行截断后可恢复消费且不发明记录');

    const tornValidJson = path.join(temporary, 'torn-valid-json.ndjson');
    const tornRecord = { ...validStored, eventSha256: 'z'.repeat(64) };
    fs.writeFileSync(tornValidJson, `${JSON.stringify(validStored)}\n${JSON.stringify(tornRecord)}`, { mode: 0o600 });
    const recoveredTorn = readAnnotationStore(tornValidJson);
    assert.equal(recoveredTorn.size, 1);
    assert.equal(recoveredTorn.get(validStored.annotationId).annotationId, validStored.annotationId);
    assert.equal(fs.readFileSync(tornValidJson, 'utf8'), `${JSON.stringify(validStored)}\n`);
    const tornConsume = await consumeOnce({
      endpoint: ENDPOINT, token: TOKEN, cursorPath, annotationPath: tornValidJson,
      fetchImpl: fakeFetch([response([], first.matchId, 2, false)], []),
    });
    assert.equal(tornConsume.summary.events, 0);
    console.log('  [OK] annotation 末行撕裂写（JSON 完整但校验失败）截断后可恢复消费');

    const tamperedTerminated = path.join(temporary, 'tampered-terminated.ndjson');
    fs.writeFileSync(
      tamperedTerminated,
      `${JSON.stringify(validStored)}\n${JSON.stringify(tornRecord)}\n`,
      { mode: 0o600 },
    );
    await expectConsumerError(consumeOnce({
      endpoint: ENDPOINT, token: TOKEN, cursorPath, annotationPath: tamperedTerminated,
      fetchImpl: fakeFetch([], []),
    }), 'annotation_invalid');
    console.log('  [OK] annotation 已终止末行校验失败仍 fail closed（完整写入视为篡改）');

    const corrupted = path.join(temporary, 'corrupt.ndjson');
    fs.writeFileSync(
      corrupted,
      `${JSON.stringify(validStored)}\n{broken\n${JSON.stringify(validStored)}\n`,
      { mode: 0o600 },
    );
    await expectConsumerError(consumeOnce({
      endpoint: ENDPOINT, token: TOKEN, cursorPath, annotationPath: corrupted,
      fetchImpl: fakeFetch([], []),
    }), 'annotation_invalid');
    console.log('  [OK] annotation 中间行损坏时拒绝继续消费');

    const malformed = { ...annotations.values().next().value, matchId: 42,
      eventSha256: 'z'.repeat(64), content: { summary: 1, tags: {}, recommendations: [], confidence: 3 } };
    const malformedPath = path.join(temporary, 'malformed.ndjson');
    fs.writeFileSync(malformedPath, `${JSON.stringify(malformed)}\n`, { mode: 0o600 });
    await expectConsumerError(consumeOnce({
      endpoint: ENDPOINT, token: TOKEN, cursorPath, annotationPath: malformedPath,
      fetchImpl: fakeFetch([], []),
    }), 'annotation_invalid');
    console.log('  [OK] annotation 身份、摘要和内容类型损坏时 fail closed');

    const validStoredAnnotation = annotations.values().next().value;
    const isolatedMalformed = [
      ['unsafe-sequence', { sequence: Number.MAX_SAFE_INTEGER + 1 }],
      ['oversize-rule-version', { ruleVersion: 'r'.repeat(81) }],
      ['empty-tag', { content: { ...validStoredAnnotation.content, tags: [''] } }],
    ];
    for (const [name, mutation] of isolatedMalformed) {
      const isolatedPath = path.join(temporary, `${name}.ndjson`);
      fs.writeFileSync(isolatedPath, `${JSON.stringify({ ...validStoredAnnotation, ...mutation })}\n`, { mode: 0o600 });
      await expectConsumerError(consumeOnce({
        endpoint: ENDPOINT, token: TOKEN, cursorPath, annotationPath: isolatedPath,
        fetchImpl: fakeFetch([], []),
      }), 'annotation_invalid');
      console.log(`  [OK] annotation 单错负例：${name}`);
    }

    const arrayDigest = { ...annotations.values().next().value,
      previousEventSha256: ['c'.repeat(64)] };
    const arrayDigestPath = path.join(temporary, 'array-digest.ndjson');
    fs.writeFileSync(arrayDigestPath, `${JSON.stringify(arrayDigest)}\n`, { mode: 0o600 });
    await expectConsumerError(consumeOnce({
      endpoint: ENDPOINT, token: TOKEN, cursorPath, annotationPath: arrayDigestPath,
      fetchImpl: fakeFetch([], []),
    }), 'annotation_invalid');
    console.log('  [OK] annotation 数组前序摘要不会被正则隐式放行');

    const generated = createReplayAnnotation(first, { createdAt: '2026-09-02T00:00:00.000Z' });
    assert.equal(generated.schema, 'guandan-agent-annotation-v1');
    assert.equal(generated.sourceEventSha256, first.eventSha256);
    console.log('  [OK] annotation 复用既有契约并绑定源事件摘要');

    const expiredFetch = async () => ({
      ok: false, status: 401,
      json: async () => ({ ok: false, code: 'capability_expired', message: 'expired' }),
    });
    await assert.rejects(consumeOnce({
      endpoint: ENDPOINT, token: TOKEN, cursorPath, annotationPath, fetchImpl: expiredFetch,
    }), (error) => {
      assert.equal(error.code, 'capability_expired');
      assert.equal(error.retryable, false);
      assert.match(error.message, /start-lan\.ps1 -EnableReplayCollector/);
      return true;
    });
    console.log('  [OK] 过期 capability token 不可重试并提示滑动续期与重新签发路径');

    const wrongTokenFetch = async () => ({
      ok: false, status: 401,
      json: async () => ({ ok: false, code: 'capability_required', message: 'required' }),
    });
    await assert.rejects(consumeOnce({
      endpoint: ENDPOINT, token: TOKEN, cursorPath, annotationPath, fetchImpl: wrongTokenFetch,
    }), (error) => {
      assert.equal(error.code, 'http_error');
      assert.equal(error.retryable, false);
      return true;
    });
    console.log('  [OK] 无效 token 保持 http_error 且不可重试');

    const onceCursor = path.join(temporary, 'once-cursor.json');
    const onceAnnotations = path.join(temporary, 'once-annotations.ndjson');
    const onceCalls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fakeFetch([
      response([first, second], first.matchId, 1, true),
      response([third], first.matchId, 2, false),
    ], onceCalls);
    try {
      const code = await runConsumer([
        '--endpoint', ENDPOINT, '--token', TOKEN,
        '--cursor', onceCursor, '--annotations', onceAnnotations,
        '--once', '--limit', '2', '--json',
      ]);
      assert.equal(code, 0);
      assert.equal(onceCalls.length, 2);
      assert.equal(readAnnotationStore(onceAnnotations).size, 3);
      assert.equal(JSON.parse(fs.readFileSync(onceCursor, 'utf8')).sequence, 2);
    } finally {
      globalThis.fetch = originalFetch;
    }
    console.log('  [OK] --once 会排空多页流并在 hasMore=false 后以 0 退出');

    const followCursor = path.join(temporary, 'follow-cursor.json');
    const followAnnotations = path.join(temporary, 'follow-annotations.ndjson');
    let followCalls = 0;
    globalThis.fetch = async () => {
      followCalls += 1;
      if (followCalls === 1) {
        return { ok: true, status: 200, json: async () => response([], null, -1, false) };
      }
      return { ok: false, status: 400, json: async () => ({ ok: false }) };
    };
    try {
      const code = await runConsumer([
        '--endpoint', ENDPOINT, '--token', TOKEN,
        '--cursor', followCursor, '--annotations', followAnnotations,
        '--follow',
      ]);
      assert.equal(code, 1);
      assert.equal(followCalls, 2);
    } finally {
      globalThis.fetch = originalFetch;
    }
    console.log('  [OK] --follow 在 hasMore=false 后继续轮询，非可重试错误时停止');

    console.log('replay consumer: 27/27');
    return 0;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
