/**
 * RT-4: read-only public replay consumer.
 *
 * The consumer has one write boundary: its own cursor and annotation files.
 * It never POSTs to the gateway and never writes a replay event or game state.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AGENT_ANNOTATION_SCHEMA,
  LIVE_PUBLIC_EVENT_SCHEMA,
  createAgentAnnotation,
  validateAgentAnnotation,
  validateLivePublicEvent,
} from '../js/replay-contracts.js';

export const CONSUMER_CURSOR_SCHEMA = 'guandan-replay-consumer-cursor-v1';
export const DEFAULT_ENDPOINT = 'http://127.0.0.1:20801/api/replay/events';
export const DEFAULT_MODEL = 'deterministic-replay-reviewer';
export const DEFAULT_PROMPT_VERSION = 'rt-4-review-v1';
export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 256;
export const MAX_WAIT_MS = 5000;
export const MAX_TIMEOUT_MS = 30000;

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORBIDDEN_ANNOTATION_KEYS = new Set([
  'hands', 'deck', 'initialHands', 'remainingHands', 'allHands',
  'opponentHands', 'partnerHand', 'hiddenCards', 'roundInitialHands',
  'trainingLabel', 'reward', 'outcome', 'trainingEligible',
]);
const ANNOTATION_KEYS = new Set([
  'schema', 'matchId', 'round', 'trick', 'turn', 'eventId', 'sequence',
  'occurredAt', 'ruleVersion', 'implementationSha256', 'eventSha256',
  'previousEventSha256', 'annotationId', 'createdAt', 'model',
  'promptVersion', 'sourceEventSha256', 'content',
]);

export class ReplayConsumerError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message);
    this.name = 'ReplayConsumerError';
    this.code = code;
    this.retryable = retryable;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function exactKeys(value, expected, label) {
  if (!isRecord(value)) throw new ReplayConsumerError('invalid_state', `${label} 必须是对象`);
  const unknown = Object.keys(value).filter((key) => !expected.has(key));
  if (unknown.length) throw new ReplayConsumerError('invalid_state', `${label} 含未知字段`);
}

function scanForbiddenKeys(value, pathName = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForbiddenKeys(item, `${pathName}[${index}]`));
  } else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_ANNOTATION_KEYS.has(key)) {
        throw new ReplayConsumerError('annotation_invalid', `annotation 含禁止字段（${pathName}）`);
      }
      scanForbiddenKeys(item, `${pathName}.${key}`);
    }
  }
}

function positiveInteger(value, name, fallback, maximum) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new ReplayConsumerError('bad_argument', `${name} 参数无效`);
  }
  return parsed;
}

export function parseReplayEndpoint(value = DEFAULT_ENDPOINT) {
  let endpoint;
  try {
    endpoint = new URL(String(value));
  } catch {
    throw new ReplayConsumerError('bad_endpoint', '复盘端点 URL 无效');
  }
  if (endpoint.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(endpoint.hostname.toLowerCase())) {
    throw new ReplayConsumerError('bad_endpoint', '复盘端点必须是 http 回环地址');
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new ReplayConsumerError('bad_endpoint', '复盘端点不得含身份信息或查询参数');
  }
  if (endpoint.pathname !== '/api/replay/events') {
    throw new ReplayConsumerError('bad_endpoint', '复盘端点路径必须为 /api/replay/events');
  }
  return endpoint;
}

function resolvedPath(value) {
  if (!value) throw new ReplayConsumerError('bad_path', '存储路径不能为空');
  return path.resolve(String(value));
}

export function assertSafeStoragePath(value) {
  const target = resolvedPath(value);
  const relative = path.relative(PROJECT_ROOT, target);
  if (!relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
    throw new ReplayConsumerError('unsafe_path', '消费者存储路径不得位于项目目录');
  }
  if (target.split(path.sep).some((part) => ['wpsdrive', 'wps云盘'].includes(part.toLowerCase()))) {
    throw new ReplayConsumerError('unsafe_path', '消费者存储路径不得位于 WPSDrive');
  }
  if (/^events-\d{8}(?:-\d+)?\.ndjson$/i.test(path.basename(target))) {
    throw new ReplayConsumerError('unsafe_path', '消费者 annotation 路径不得指向源事件分片');
  }
  let probe = target;
  while (probe && probe !== path.dirname(probe)) {
    if (fs.existsSync(probe)) {
      let stat;
      try { stat = fs.lstatSync(probe); } catch { throw new ReplayConsumerError('unsafe_path', '消费者存储路径无法核对'); }
      if (stat.isSymbolicLink()) throw new ReplayConsumerError('unsafe_path', '消费者存储路径不得经过符号链接');
      let real;
      try { real = fs.realpathSync(probe); } catch { throw new ReplayConsumerError('unsafe_path', '消费者存储路径无法核对'); }
      const realRelative = path.relative(PROJECT_ROOT, real);
      if (!realRelative || (realRelative !== '..' && !realRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(realRelative))) {
        throw new ReplayConsumerError('unsafe_path', '消费者存储路径不得通过链接进入项目目录');
      }
      if (real.split(path.sep).some((part) => ['wpsdrive', 'wps云盘'].includes(part.toLowerCase()))) {
        throw new ReplayConsumerError('unsafe_path', '消费者存储路径不得通过链接进入 WPSDrive');
      }
    }
    probe = path.dirname(probe);
  }
  return target;
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function defaultStoragePaths() {
  const appData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const directory = path.join(appData, 'GuandanTrainer', 'replay-consumer');
  return {
    cursorPath: assertSafeStoragePath(path.join(directory, 'cursor.json')),
    annotationPath: assertSafeStoragePath(path.join(directory, 'annotations.ndjson')),
  };
}

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(filePath), 0o700); } catch { /* Windows ACLs are managed by the user profile. */ }
}

function writeAtomicJson(filePath, value) {
  ensureParent(filePath);
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    const data = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
    const written = fs.writeSync(descriptor, data);
    if (written !== data.length) throw new Error('短写');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch { /* Windows ACLs are managed by the user profile. */ }
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* best effort cleanup */ }
    }
    try { fs.unlinkSync(temporary); } catch { /* no leftover temp file is required */ }
    throw new ReplayConsumerError('storage_unavailable', '消费者游标无法安全写入');
  }
}

function initialCursor(endpoint) {
  return {
    schema: CONSUMER_CURSOR_SCHEMA,
    endpoint: endpoint.toString(),
    matchId: null,
    sequence: -1,
    eventSha256: null,
  };
}

export function readCursor(cursorPath, endpoint) {
  if (!fs.existsSync(cursorPath)) return initialCursor(endpoint);
  let value;
  try {
    value = JSON.parse(fs.readFileSync(cursorPath, 'utf8'));
  } catch {
    throw new ReplayConsumerError('invalid_state', '消费者游标损坏，已拒绝恢复');
  }
  exactKeys(value, new Set(['schema', 'endpoint', 'matchId', 'sequence', 'eventSha256']), '游标');
  if (value.schema !== CONSUMER_CURSOR_SCHEMA || value.endpoint !== endpoint.toString()) {
    throw new ReplayConsumerError('invalid_state', '消费者游标版本或端点不匹配');
  }
  if (value.matchId !== null && (typeof value.matchId !== 'string' || !value.matchId.length || value.matchId.length > 120)) {
    throw new ReplayConsumerError('invalid_state', '消费者游标 matchId 无效');
  }
  if (!Number.isSafeInteger(value.sequence) || value.sequence < -1 || (value.sequence === -1 && value.matchId !== null)) {
    throw new ReplayConsumerError('invalid_state', '消费者游标 sequence 无效');
  }
  if (value.sequence === -1 && value.eventSha256 !== null) {
    throw new ReplayConsumerError('invalid_state', '消费者游标首位置不得带事件摘要');
  }
  if (value.sequence >= 0 && (value.matchId === null || value.eventSha256 === null)) {
    throw new ReplayConsumerError('invalid_state', '消费者游标已前进但缺少 matchId 或事件摘要');
  }
  if (value.eventSha256 !== null && !/^[a-f0-9]{64}$/.test(value.eventSha256)) {
    throw new ReplayConsumerError('invalid_state', '消费者游标事件摘要无效');
  }
  return value;
}

function writeCursor(cursorPath, cursor) {
  writeAtomicJson(cursorPath, cursor);
}

function validateStoredAnnotation(value) {
  exactKeys(value, ANNOTATION_KEYS, 'annotation');
  scanForbiddenKeys(value);
  if (value.schema !== AGENT_ANNOTATION_SCHEMA || typeof value.annotationId !== 'string' || !value.annotationId) {
    throw new ReplayConsumerError('annotation_invalid', 'annotation 存储记录无效');
  }
  const stringField = (field, maximum) => {
    if (typeof value[field] !== 'string' || value[field].length < 1 || value[field].length > maximum) {
      throw new ReplayConsumerError('annotation_invalid', `annotation ${field} 无效`);
    }
  };
  stringField('matchId', 120);
  for (const field of ['eventId', 'annotationId']) stringField(field, 160);
  for (const field of ['occurredAt', 'createdAt']) stringField(field, 80);
  stringField('ruleVersion', 80);
  for (const field of ['model', 'promptVersion']) stringField(field, 160);
  for (const field of ['round', 'trick', 'turn', 'sequence']) {
    if (!Number.isSafeInteger(value[field]) || value[field] < (field === 'sequence' ? 0 : 1)) {
      throw new ReplayConsumerError('annotation_invalid', `annotation ${field} 无效`);
    }
  }
  for (const field of ['implementationSha256', 'eventSha256', 'sourceEventSha256']) {
    if (typeof value[field] !== 'string' || !/^[a-f0-9]{64}$/.test(value[field])) {
      throw new ReplayConsumerError('annotation_invalid', `annotation ${field} 无效`);
    }
  }
  if (value.eventSha256 !== value.sourceEventSha256
    || (value.previousEventSha256 !== null
      && (typeof value.previousEventSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.previousEventSha256)))) {
    throw new ReplayConsumerError('annotation_invalid', 'annotation 源事件摘要无效');
  }
  if (!isRecord(value.content)) {
    throw new ReplayConsumerError('annotation_invalid', 'annotation 内容无效');
  }
  exactKeys(value.content, new Set(['summary', 'tags', 'recommendations', 'confidence']), 'annotation.content');
  if (typeof value.content.summary !== 'string' || value.content.summary.length < 1 || value.content.summary.length > 4000) {
    throw new ReplayConsumerError('annotation_invalid', 'annotation summary 无效');
  }
  for (const [field, maximum] of [['tags', 80], ['recommendations', 1000]]) {
    if (!Array.isArray(value.content[field]) || value.content[field].some((item) => (
      typeof item !== 'string' || item.length < 1 || item.length > maximum
    ))) throw new ReplayConsumerError('annotation_invalid', `annotation ${field} 无效`);
  }
  if (value.content.confidence !== null && (
    typeof value.content.confidence !== 'number'
    || !Number.isFinite(value.content.confidence)
    || value.content.confidence < 0 || value.content.confidence > 1
  )) throw new ReplayConsumerError('annotation_invalid', 'annotation confidence 无效');
}

function truncateAnnotationFile(annotationPath, size) {
  const descriptor = fs.openSync(annotationPath, 'r+');
  try {
    fs.ftruncateSync(descriptor, size);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function splitAnnotationLines(buffer) {
  const lines = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0x0a) {
      lines.push({
        start,
        content: buffer.subarray(start, index).toString('utf8').replace(/\r$/, ''),
      });
      start = index + 1;
    }
  }
  if (start < buffer.length) {
    lines.push({
      start,
      content: buffer.subarray(start).toString('utf8'),
    });
  }
  return lines;
}

export function readAnnotationStore(annotationPath) {
  if (!fs.existsSync(annotationPath)) return new Map();
  let buffer;
  try { buffer = fs.readFileSync(annotationPath); } catch {
    throw new ReplayConsumerError('storage_unavailable', 'annotation 存储无法读取');
  }
  const records = new Map();
  const lines = splitAnnotationLines(buffer);
  for (const [index, line] of lines.entries()) {
    if (!line.content.trim()) continue;
    let value;
    try {
      value = JSON.parse(line.content);
    } catch {
      if (index !== lines.length - 1) {
        throw new ReplayConsumerError('annotation_invalid', `annotation 存储第 ${index + 1} 行损坏`);
      }
      try {
        truncateAnnotationFile(annotationPath, line.start);
      } catch {
        throw new ReplayConsumerError('storage_unavailable', 'annotation 半行无法安全截断');
      }
      break;
    }
    validateStoredAnnotation(value);
    if (records.has(value.annotationId)) {
      throw new ReplayConsumerError('annotation_invalid', 'annotation 存储含重复 annotationId');
    }
    records.set(value.annotationId, value);
  }
  return records;
}

function appendAnnotation(annotationPath, annotation, records) {
  validateStoredAnnotation(annotation);
  const previous = records.get(annotation.annotationId);
  if (previous) {
    const comparable = (value) => {
      const copy = { ...value };
      delete copy.createdAt;
      return canonicalJson(copy);
    };
    if (comparable(previous) !== comparable(annotation)) {
      throw new ReplayConsumerError('annotation_conflict', '已有 annotation 与当前源事件不一致');
    }
    return false;
  }
  ensureParent(annotationPath);
  const line = Buffer.from(`${JSON.stringify(annotation)}\n`, 'utf8');
  let descriptor;
  let originalSize = 0;
  try {
    originalSize = fs.existsSync(annotationPath) ? fs.statSync(annotationPath).size : 0;
    descriptor = fs.openSync(annotationPath, 'a', 0o600);
    const written = fs.writeSync(descriptor, line);
    if (written !== line.length) throw new Error('短写');
    fs.fsyncSync(descriptor);
  } catch {
    if (descriptor !== undefined) {
      try { fs.ftruncateSync(descriptor, originalSize); fs.fsyncSync(descriptor); } catch { /* fail closed below */ }
    }
    throw new ReplayConsumerError('storage_unavailable', 'annotation 无法安全追加');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  try { fs.chmodSync(annotationPath, 0o600); } catch { /* Windows ACLs are managed by the user profile. */ }
  records.set(annotation.annotationId, annotation);
  return true;
}

function annotationId(event, model, promptVersion) {
  return `rt4-${sha256(`${event.matchId}\0${event.sequence}\0${event.eventSha256}\0${model}\0${promptVersion}`).slice(0, 40)}`;
}

export function createReplayAnnotation(event, { model = DEFAULT_MODEL, promptVersion = DEFAULT_PROMPT_VERSION, createdAt = new Date().toISOString() } = {}) {
  const scope = event.eventType === 'round_end' ? 'round' : event.eventType === 'trick_end' ? 'trick' : 'turn';
  const annotation = createAgentAnnotation({
    annotationId: annotationId(event, model, promptVersion),
    createdAt,
    model,
    promptVersion,
    sourceEventSha256: event.eventSha256,
    content: {
      summary: `公开复盘 ${scope} 事件：round=${event.round}, trick=${event.trick}, turn=${event.turn}, type=${event.eventType}`,
      tags: ['replay-review', `scope:${scope}`, `event:${event.eventType}`],
      recommendations: [],
      confidence: null,
    },
  }, event);
  const result = validateAgentAnnotation(annotation, event);
  if (!result.ok) throw new ReplayConsumerError('annotation_invalid', '生成的 annotation 未通过契约校验');
  return annotation;
}

function validateResponse(value, requestedLimit) {
  exactKeys(value, new Set(['ok', 'matchId', 'events', 'nextSequence', 'hasMore', 'collector']), '复盘响应');
  if (value.ok !== true || (value.matchId !== null && typeof value.matchId !== 'string')) {
    throw new ReplayConsumerError('invalid_response', '复盘响应身份无效');
  }
  if (!Array.isArray(value.events) || value.events.length > requestedLimit || typeof value.hasMore !== 'boolean') {
    throw new ReplayConsumerError('invalid_response', '复盘响应分页字段无效');
  }
  if (!Number.isSafeInteger(value.nextSequence) || value.nextSequence < -1) {
    throw new ReplayConsumerError('invalid_response', '复盘响应 nextSequence 无效');
  }
  if (!isRecord(value.collector) || value.collector.enabled !== true || value.collector.gap !== false
    || value.collector.lastError !== null) {
    throw new ReplayConsumerError('source_gap', '源事件流报告缺口，已停止消费');
  }
  for (const event of value.events) {
    const result = validateLivePublicEvent(event);
    if (!result.ok) throw new ReplayConsumerError('invalid_event', '源事件未通过公开契约校验');
  }
  return value;
}

function addToReview(review, event) {
  const round = review.rounds.get(event.round) || { round: event.round, eventCount: 0, tricks: new Map() };
  const trick = round.tricks.get(event.trick) || { trick: event.trick, eventCount: 0, turns: new Map() };
  const turn = trick.turns.get(event.turn) || { turn: event.turn, eventTypes: [] };
  round.eventCount += 1;
  trick.eventCount += 1;
  if (!turn.eventTypes.includes(event.eventType)) turn.eventTypes.push(event.eventType);
  trick.turns.set(event.turn, turn);
  round.tricks.set(event.trick, trick);
  review.rounds.set(event.round, round);
  review.events += 1;
}

export function reviewSummary(review, cursor) {
  return {
    schema: 'guandan-replay-review-summary-v1',
    matchId: review.matchId,
    events: review.events,
    cursor: { matchId: cursor.matchId, sequence: cursor.sequence, eventSha256: cursor.eventSha256 },
    rounds: [...review.rounds.values()].sort((a, b) => a.round - b.round).map((round) => ({
      round: round.round,
      eventCount: round.eventCount,
      tricks: [...round.tricks.values()].sort((a, b) => a.trick - b.trick).map((trick) => ({
        trick: trick.trick,
        eventCount: trick.eventCount,
        turns: [...trick.turns.values()].sort((a, b) => a.turn - b.turn),
      })),
    })),
  };
}

async function getPage(endpoint, token, cursor, { limit, waitMs, timeoutMs, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new ReplayConsumerError('network_error', '当前 Node 运行时没有 fetch');
  const url = new URL(endpoint.toString());
  url.searchParams.set('afterSequence', String(cursor.sequence));
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('waitMs', String(waitMs));
  if (cursor.matchId !== null) url.searchParams.set('matchId', cursor.matchId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'X-Guandan-Replay-Capability': token },
      redirect: 'error',
      signal: controller.signal,
    });
  } catch {
    throw new ReplayConsumerError('network_error', '复盘读取暂时不可用', { retryable: true });
  } finally {
    clearTimeout(timer);
  }
  if (!response || !response.ok) {
    const retryable = !response || response.status === 429 || response.status >= 500;
    if (response && response.status === 401) {
      let failureCode = null;
      try { failureCode = (await response.json())?.code; } catch { failureCode = null; }
      if (failureCode === 'capability_expired') {
        throw new ReplayConsumerError(
          'capability_expired',
          '复盘 capability token 已过期：活跃读取会滑动续期；闲置过期后请重新运行 '
            + 'start-lan.ps1 -EnableReplayCollector 签发新 token，并用新 token 重启本消费者',
        );
      }
    }
    throw new ReplayConsumerError('http_error', `复盘读取 HTTP ${response?.status || 0}`, { retryable });
  }
  let payload;
  try { payload = await response.json(); } catch {
    throw new ReplayConsumerError('invalid_response', '复盘响应不是合法 JSON');
  }
  return validateResponse(payload, limit);
}

export async function consumeOnce({
  endpoint = DEFAULT_ENDPOINT,
  token,
  cursorPath,
  annotationPath,
  model = DEFAULT_MODEL,
  promptVersion = DEFAULT_PROMPT_VERSION,
  limit = DEFAULT_LIMIT,
  waitMs = 0,
  timeoutMs = 10000,
  fetchImpl,
} = {}) {
  const parsedEndpoint = parseReplayEndpoint(endpoint);
  if (typeof token !== 'string' || token.length < 32) throw new ReplayConsumerError('bad_argument', '缺少有效的复盘 capability token');
  const paths = defaultStoragePaths();
  const safeCursorPath = assertSafeStoragePath(cursorPath || paths.cursorPath);
  const safeAnnotationPath = assertSafeStoragePath(annotationPath || paths.annotationPath);
  if (samePath(safeCursorPath, safeAnnotationPath)) throw new ReplayConsumerError('unsafe_path', '游标与 annotation 必须使用不同文件');
  const pageLimit = positiveInteger(limit, 'limit', DEFAULT_LIMIT, MAX_LIMIT);
  if (pageLimit < 1) throw new ReplayConsumerError('bad_argument', 'limit 参数无效');
  const pollWait = positiveInteger(waitMs, 'waitMs', 0, MAX_WAIT_MS);
  const requestTimeout = positiveInteger(timeoutMs, 'timeoutMs', 10000, MAX_TIMEOUT_MS);
  const cursor = readCursor(safeCursorPath, parsedEndpoint);
  const annotations = readAnnotationStore(safeAnnotationPath);
  const review = { matchId: cursor.matchId, events: 0, rounds: new Map(), annotationsAdded: 0 };
  const response = await getPage(parsedEndpoint, token, cursor, {
    limit: pageLimit, waitMs: pollWait, timeoutMs: requestTimeout, fetchImpl,
  });
  if (cursor.matchId !== null && response.matchId !== cursor.matchId) {
    throw new ReplayConsumerError('cursor_mismatch', '复盘响应 matchId 与游标不一致');
  }
  if (response.events.length && response.matchId === null) {
    throw new ReplayConsumerError('invalid_response', '有事件时复盘响应必须提供 matchId');
  }
  let expectedSequence = cursor.sequence + 1;
  let previousSha = cursor.eventSha256;
  for (const event of response.events) {
    if (review.matchId === null) review.matchId = event.matchId;
    if (event.matchId !== response.matchId || event.matchId !== review.matchId || event.sequence !== expectedSequence) {
      throw new ReplayConsumerError('chain_gap', '复盘事件 sequence 或 matchId 不连续');
    }
    if (event.sequence === 0 ? event.previousEventSha256 !== null : event.previousEventSha256 !== previousSha) {
      throw new ReplayConsumerError('chain_gap', '复盘事件前序摘要不连续');
    }
    const annotation = createReplayAnnotation(event, { model, promptVersion });
    if (appendAnnotation(safeAnnotationPath, annotation, annotations)) review.annotationsAdded += 1;
    addToReview(review, event);
    expectedSequence += 1;
    previousSha = event.eventSha256;
  }
  const expectedNext = response.events.length ? expectedSequence - 1 : cursor.sequence;
  if (response.nextSequence !== expectedNext) throw new ReplayConsumerError('invalid_response', '复盘响应 nextSequence 与事件不一致');
  const nextCursor = {
    schema: CONSUMER_CURSOR_SCHEMA,
    endpoint: parsedEndpoint.toString(),
    matchId: review.matchId,
    sequence: expectedNext,
    eventSha256: previousSha,
  };
  if (response.events.length) writeCursor(safeCursorPath, nextCursor);
  return { summary: reviewSummary(review, nextCursor), cursor: nextCursor, hasMore: response.hasMore };
}

function usage() {
  return '用法：node tools/replay_consumer.mjs [--endpoint URL] [--token TOKEN] [--cursor PATH] [--annotations PATH] [--model NAME] [--prompt-version VERSION] [--limit N] [--wait-ms N] [--follow] [--json]';
}

function parseArgs(argv) {
  const options = { endpoint: DEFAULT_ENDPOINT, limit: DEFAULT_LIMIT, waitMs: 0, timeoutMs: 10000, follow: false, json: false };
  const values = new Map([
    ['--endpoint', 'endpoint'], ['--token', 'token'], ['--cursor', 'cursorPath'],
    ['--annotations', 'annotationPath'], ['--model', 'model'], ['--prompt-version', 'promptVersion'],
    ['--limit', 'limit'], ['--wait-ms', 'waitMs'], ['--timeout-ms', 'timeoutMs'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--follow') options.follow = true;
    else if (arg === '--once') options.follow = false;
    else if (arg === '--json') options.json = true;
    else if (values.has(arg)) {
      if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) throw new ReplayConsumerError('bad_argument', `${arg} 缺少参数`);
      options[values.get(arg)] = argv[++index];
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new ReplayConsumerError('bad_argument', `未知参数：${arg}`);
    }
  }
  options.token ||= process.env.GUANDAN_REPLAY_CAPABILITY;
  if (options.limit !== undefined) options.limit = Number(options.limit);
  if (options.waitMs !== undefined) options.waitMs = Number(options.waitMs);
  if (options.timeoutMs !== undefined) options.timeoutMs = Number(options.timeoutMs);
  return options;
}

function printHuman(summary) {
  console.log(`复盘 matchId=${summary.matchId || 'none'}，新增事件 ${summary.events} 条`);
  for (const round of summary.rounds) {
    console.log(`  第 ${round.round} 圈组：${round.eventCount} 条事件`);
    for (const trick of round.tricks) {
      const turns = trick.turns.map((turn) => `${turn.turn}(${turn.eventTypes.join('/')})`).join('、');
      console.log(`    第 ${trick.trick} 手：${trick.eventCount} 条；事件 ${turns}`);
    }
  }
  console.log(`复盘游标 sequence=${summary.cursor.sequence}，annotation 新增记录已独立保存`);
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try { options = parseArgs(argv); } catch (error) {
    console.error(error.message);
    console.error(usage());
    return 2;
  }
  if (options.help) { console.log(usage()); return 0; }
  const token = options.token;
  delete options.token;
  while (true) {
    try {
      const result = await consumeOnce({ ...options, token });
      if (options.json) console.log(JSON.stringify(result.summary));
      else printHuman(result.summary);
      if (result.hasMore) continue;
      if (!options.follow) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch (error) {
      const safeError = error instanceof ReplayConsumerError
        ? error : new ReplayConsumerError('consumer_error', '复盘消费者失败');
      if (options.follow && safeError.retryable) {
        console.error(`复盘读取暂时失败（${safeError.code}），保留现有游标后重试`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }
      console.error(safeError.message);
      return 1;
    }
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
