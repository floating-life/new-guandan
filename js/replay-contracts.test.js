import {
  AGENT_ANNOTATION_SCHEMA,
  LIVE_PUBLIC_EVENT_SCHEMA,
  SEALED_TRAINING_TURN_SCHEMA,
  createAgentAnnotation,
  createLivePublicEvent,
  createSealedTrainingTurn,
  computeReplayContractImplementationSha256,
  REPLAY_CONTRACT_IMPLEMENTATION_MANIFEST,
  REPLAY_CONTRACT_IMPLEMENTATION_SHA256,
  validateAgentAnnotation,
  validateLiveEventChain,
  validateLivePublicEvent,
  validateSealedTrainingTurn,
} from './replay-contracts.js';

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
function sha(char = 'a') { return char.repeat(64); }
function card(rank = 5, suit = 'S', deckIndex = 0) {
  return { id: `${rank}-${suit}-${deckIndex}`, rank, suit, deckIndex };
}
function base(sequence = 0) {
  return {
    matchId: 'match-test', round: 1, trick: 2, turn: sequence + 1,
    eventId: `event-${sequence}`, sequence, occurredAt: '2026-09-01T00:00:00.000Z',
    ruleVersion: 'guandan-rules-v1', implementationSha256: sha(),
    previousEventSha256: null,
  };
}

console.log('R1A 三层复盘契约');
const publicEvent = createLivePublicEvent({
  ...base(), eventType: 'play', seat: 1, action: 'play', cards: [card(5, 'S', 1)],
  hand: { type: 'single', mainRank: 5, size: 1, power: 5 },
  countsBefore: [10, 5, 8, 7], countsAfter: [10, 4, 8, 7], tribute: [],
  engine: { name: 'expert', version: 'local-v1' },
  decisionMeta: {
    reason: '公开原因', source: 'local', searchAttempted: false,
    searchTriggered: false, fallbackKind: 'none', latencyMs: 12,
  },
});
assert(publicEvent.schema === LIVE_PUBLIC_EVENT_SCHEMA, '公开事件使用固定 schema');
assert(!('hands' in publicEvent) && !('hiddenCards' in publicEvent.decisionMeta), '公开事件不复制暗牌字段');
assert(publicEvent.cards[0].id === undefined && publicEvent.cards[0].deckIndex === undefined
  && publicEvent.decisionMeta.latencyMs === 12, '公开牌与脱敏决策元数据按白名单输出且不暴露实体副本');
assert(publicEvent.decisionMeta.reason === undefined, '公开决策元数据不携带可能泄露暗牌结构的自由文本原因');
assert(validateLivePublicEvent(publicEvent).ok, '合法公开事件可通过校验');
const sanitizedUnknownMeta = createLivePublicEvent({
  ...publicEvent,
  eventId: 'event-unknown-meta', sequence: 3, turn: 4,
  eventSha256: undefined,
  decisionMeta: { source: 'private hand says bomb', fallbackKind: 'keep my hidden pair' },
});
assert(sanitizedUnknownMeta.decisionMeta.source === 'unknown'
  && sanitizedUnknownMeta.decisionMeta.fallbackKind === 'unknown',
  '公开决策来源与回退类型只保留受控 token，未知值归一为 unknown');
assert(['stableJson', 'publicCard', 'sanitizeDecisionMeta', 'createLivePublicEvent']
  .every((name) => REPLAY_CONTRACT_IMPLEMENTATION_MANIFEST.includes(name)),
  '实现摘要绑定完整的公开序列化依赖清单');
assert(computeReplayContractImplementationSha256({ publicCard: 'changed-source' })
  !== REPLAY_CONTRACT_IMPLEMENTATION_SHA256
  && computeReplayContractImplementationSha256({ stableJson: 'changed-source' })
    !== REPLAY_CONTRACT_IMPLEMENTATION_SHA256,
  '修改牌面投影或稳定序列化实现会改变实现摘要');
const aceLowStraight = createLivePublicEvent({
  ...base(2), eventId: 'event-ace-low', eventType: 'play', seat: 1, action: 'play',
  cards: [card(14, 'S'), card(2, 'H'), card(3, 'D'), card(4, 'C'), card(5, 'S')],
  hand: { type: 'straight', mainRank: 5, size: 5, power: 5, meta: { sequence: [1, 2, 3, 4, 5] } },
  countsBefore: [10, 9, 8, 7], countsAfter: [10, 4, 8, 7], tribute: [],
  engine: { name: 'expert', version: 'local-v1' }, decisionMeta: null,
});
assert(validateLivePublicEvent(aceLowStraight).ok, '公开事件允许规则层 A2345 的 rank=1 顺子标记');
let rejectedHiddenInput = false;
try {
  createLivePublicEvent({ ...base(), eventType: 'play', seat: 0, action: 'play', cards: [card()],
    hand: { type: 'single', mainRank: 5, size: 1, power: 5 }, countsBefore: [5, 5, 5, 5],
    countsAfter: [4, 5, 5, 5], hands: [['must-not-copy']] });
} catch { rejectedHiddenInput = true; }
assert(rejectedHiddenInput, '公开事件构造器拒绝调用方混入暗牌输入');

const invalidChain = { ...publicEvent, previousEventSha256: 'not-a-sha' };
assert(!validateLivePublicEvent(invalidChain).ok, '坏的前序事件摘要被拒绝');
assert(!validateLivePublicEvent({ ...publicEvent, sequence: -1 }).ok, '非法 sequence 被拒绝');
assert(!validateLivePublicEvent({ ...publicEvent, eventType: 'secret' }).ok, '非公开事件类型被拒绝');
const secondPublicEvent = createLivePublicEvent({
  ...base(1), eventId: 'event-1', previousEventSha256: publicEvent.eventSha256,
  eventType: 'pass', seat: 1, action: 'pass', cards: [], hand: null,
  countsBefore: [10, 4, 8, 7], countsAfter: [10, 4, 8, 7], tribute: [], engine: null, decisionMeta: null,
});
assert(validateLiveEventChain([publicEvent, secondPublicEvent]).ok, '公开事件链校验连续 sequence 与前序摘要');
assert(!validateLiveEventChain([publicEvent, { ...secondPublicEvent, sequence: 3 }]).ok, '事件链拒绝 sequence 缺口');
assert(!validateLiveEventChain([publicEvent, { ...secondPublicEvent, previousEventSha256: sha('z') }]).ok, '事件链拒绝错误前序摘要');
assert(!validateLiveEventChain([publicEvent, null]).ok, '事件链对非对象输入 fail closed');
assert(!validateLivePublicEvent({ ...publicEvent, countsAfter: [10, 3, 8, 7] }).ok, '事件内容篡改后摘要校验失败');
const nonZeroFirst = createLivePublicEvent({
  ...publicEvent,
  eventId: 'event-nonzero-first', sequence: 1, turn: 2,
  eventSha256: undefined, previousEventSha256: null,
});
assert(!validateLiveEventChain([nonZeroFirst]).ok, '完整事件链拒绝从 sequence=1 开始的首事件');
const validBoundary = createLivePublicEvent({
  ...base(4), eventId: 'event-trick-end', eventType: 'trick_end', seat: null, action: null,
  cards: [], hand: null, countsBefore: [10, 4, 8, 7], countsAfter: [10, 4, 8, 7],
  tribute: [], engine: null, decisionMeta: null,
});
assert(validBoundary.seat === null && validBoundary.action === null && validBoundary.cards.length === 0
  && validBoundary.hand === null && validBoundary.tribute.length === 0
  && validBoundary.engine === null && validBoundary.decisionMeta === null,
  'trick_end/round_end 只携带空动作载荷与余牌数');
let rejectedBoundaryPayload = false;
try {
  createLivePublicEvent({
    ...base(5), eventId: 'event-round-end-invalid', eventType: 'round_end', seat: 1, action: null,
    cards: [card()], hand: { type: 'single', mainRank: 5, size: 1, power: 5 },
    countsBefore: [10, 4, 8, 7], countsAfter: [10, 4, 8, 7], tribute: [],
    engine: { name: 'expert', version: 'local-v1' },
    decisionMeta: { source: 'local' },
  });
} catch { rejectedBoundaryPayload = true; }
assert(rejectedBoundaryPayload, '结束事件拒绝座位、牌型、引擎和决策元数据等动作载荷');

const sealed = createSealedTrainingTurn({
  ...base(1), eventId: 'sealed-1', sourceEventId: publicEvent.eventId, seat: 1,
  hand: [card(5, 'S', 0), card(6, 'H', 1)],
  publicObservation: {
    seat: 1, hand: [card(5, 'S', 0)], level: 2, lastHand: null, lastSeat: null,
    handCounts: [10, 2, 8, 7], teams: [0, 1, 0, 1], finishOrder: [],
    playedCards: [card(3)], publicHistory: [], tributeContext: null,
    difficulty: 'normal', deterministic: true, timeBudgetMs: 0,
    policyProfile: 'expert', decisionEngine: 'expert',
  },
  legalCandidates: [
    { candidateId: 'c1', cards: [card(5)], hand: { type: 'single', mainRank: 5, size: 1, power: 5 } },
    { candidateId: 'c2', cards: [card(6, 'H', 1)], hand: { type: 'single', mainRank: 6, size: 1, power: 6 } },
  ],
  chosenCandidateId: 'c2', trainingEligible: true,
});
assert(sealed.schema === SEALED_TRAINING_TURN_SCHEMA && sealed.trainingEligible === false, '密封 turn 强制保持不可训练');
assert(sealed.hand[0].id && sealed.publicObservation.hand[0].id === undefined, '密封手牌可保留物理身份，公开 observation 不保留牌 ID');
assert(validateSealedTrainingTurn(sealed).ok, '合法密封 turn 可通过校验');
assert(!validateSealedTrainingTurn({ ...sealed, chosenCandidateId: 'missing' }).ok, 'chosen 必须唯一对应合法候选');
assert(!validateSealedTrainingTurn({ ...sealed, publicObservation: { ...sealed.publicObservation, hands: [] } }).ok, '密封 observation 拒绝暗牌字段');

const annotation = createAgentAnnotation({
  schema: AGENT_ANNOTATION_SCHEMA,
  annotationId: 'annotation-1',
  createdAt: '2026-09-01T00:00:01.000Z', model: 'local-reviewer', promptVersion: 'p1',
  sourceEventSha256: publicEvent.eventSha256,
  content: { summary: '建议在公开牌权变化后复核', tags: ['review'], recommendations: ['保留结构'], confidence: 0.8 },
}, publicEvent);
assert(annotation.eventId === publicEvent.eventId && annotation.matchId === publicEvent.matchId
  && annotation.sequence === publicEvent.sequence && annotation.eventSha256 === publicEvent.eventSha256
  && !('cards' in annotation),
  'annotation 绑定事件身份但不复制源事件');
assert(validateAgentAnnotation(annotation, publicEvent).ok, '合法 annotation 可通过源事件绑定校验');
assert(!validateAgentAnnotation(annotation).ok, '缺少源公开事件时 annotation 校验 fail closed');
assert(!validateAgentAnnotation({ ...annotation, content: { summary: 'x', reward: 1 } }, publicEvent).ok, 'annotation 拒绝训练标签/结果字段');
assert(!validateAgentAnnotation({ ...annotation, sourceEventSha256: sha('d') }, publicEvent).ok, 'annotation 拒绝不一致源事件摘要');
for (const [field, value] of [
  ['matchId', 'other-match'], ['round', 2], ['trick', 3], ['turn', 2],
  ['eventId', 'other-event'], ['sequence', 1], ['ruleVersion', 'other-rules-v1'],
  ['implementationSha256', sha('b')], ['eventSha256', sha('c')],
  ['previousEventSha256', sha('d')],
]) {
  assert(!validateAgentAnnotation({ ...annotation, [field]: value }, publicEvent).ok,
    `annotation 拒绝源事件 ${field} 身份错配`);
}

console.log(`\n结果: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
