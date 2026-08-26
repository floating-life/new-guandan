/** 混合决策、公平观察、信息集采样与价值模型契约测试。 */
import { createDeck } from './cards.js';
import { handSignature, parseHand, parseHandVariants } from './rules.js';
import {
  auditPublicAIObservation, createPublicAIObservation,
  FORBIDDEN_AI_OBSERVATION_FIELDS,
} from './ai-observation.js';
import {
  HYBRID_VALUE_FEATURES, HYBRID_VALUE_SCHEMA,
  chooseHybridFromConsultation, configureHybridValueModel,
  evaluateHybridValueModel, extractHybridValueFeatures,
  samplePublicInformationSets, validateHybridValueModel,
} from './ai-hybrid.js';

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

function physicalKey(card) {
  return `${card.rank}:${card.suit}:${card.deckIndex}`;
}

function baseContext(deck) {
  return {
    seat: 0,
    hand: deck.slice(0, 27),
    level: 7,
    lastHand: null,
    lastSeat: null,
    handCounts: [27, 27, 27, 27],
    teams: [0, 1, 0, 1],
    finishOrder: [],
    playedCards: [],
    publicHistory: [],
    difficulty: 'master',
    deterministic: true,
    decisionEngine: 'hybrid',
  };
}

console.log('公平观察白名单');
{
  const deck = createDeck();
  const ctx = {
    ...baseContext(deck),
    hands: [deck.slice(0, 27), deck.slice(27, 54), deck.slice(54, 81), deck.slice(81)],
    initialHands: ['secret'],
    opponentHands: ['secret'],
    lastReplay: { remainingHands: ['secret'] },
  };
  const observation = createPublicAIObservation(ctx);
  const audit = auditPublicAIObservation(observation);
  assert(audit.ok, '观察对象通过公平性审计');
  assert(FORBIDDEN_AI_OBSERVATION_FIELDS.every((key) => !(key in observation)),
    '四家手牌、牌堆、初始牌与复盘暗牌全部被白名单剥离');
  assert(observation.hand.length === 27 && observation.handCounts[0] === 27,
    '本家手牌与公开张数完整保留');
}

console.log('公平信息集采样');
{
  const deck = createDeck();
  const ctx = baseContext(deck);
  const first = samplePublicInformationSets({
    ...ctx,
    hands: [[], ['绝不能读取'], [], []],
  }, { sampleCount: 3, seed: 20260826 });
  const second = samplePublicInformationSets({
    ...ctx,
    hands: [['另一份暗牌噪声'], [], [], []],
  }, { sampleCount: 3, seed: 20260826 });
  assert(first.ok && first.samples.length === 3, '从公开未知牌池生成指定数量的可能牌面');
  assert(first.samples.every((sample) => sample.hands.every((hand) => hand.length === 27)),
    '每个采样世界严格满足四家公开剩余张数');
  assert(first.samples.every((sample) => {
    const keys = sample.hands.flat().map(physicalKey);
    return keys.length === 108 && new Set(keys).size === 108;
  }), '采样世界108张实体牌守恒且不重复');
  const fingerprint = (result) => result.samples.map((sample) => (
    sample.hands.map((hand) => hand.map(physicalKey).sort().join(',')).join('|')
  ));
  assert(JSON.stringify(fingerprint(first)) === JSON.stringify(fingerprint(second)),
    '改变调用方误带的真实暗牌字段不会改变采样结果');
}

console.log('公开贡还约束进入采样');
{
  const deck = createDeck();
  const known = deck[40];
  const ctx = {
    ...baseContext(deck),
    tributeContext: {
      knownTransfers: [{ kind: 'tribute', from: 3, to: 1, card: known }],
    },
  };
  const result = samplePublicInformationSets(ctx, { sampleCount: 2, seed: 77 });
  assert(result.ok, '含公开贡牌的未知池仍保持资源守恒');
  assert(result.samples.every((sample) => (
    sample.hands[1].some((card) => physicalKey(card) === physicalKey(known))
  )), '已知贡牌在每个采样世界都归属公开接收座位');
}

console.log('可插拔专用价值模型契约');
{
  const weights = new Array(HYBRID_VALUE_FEATURES.length).fill(0);
  weights[23] = 2; // finishes_now
  const model = {
    id: 'unit-finish-value',
    schema: HYBRID_VALUE_SCHEMA,
    layers: [{ weights: [weights], bias: [0], activation: 'linear' }],
  };
  const validation = validateHybridValueModel(model);
  assert(validation.ok && validation.model.weightCount === HYBRID_VALUE_FEATURES.length + 1,
    '固定特征架构与稠密层权重经过尺寸和有限值校验');
  const configured = configureHybridValueModel(model);
  assert(configured.ok && configured.modelId === 'unit-finish-value', '有效模型可原子启用');
  const deck = createDeck();
  const ctx = { ...baseContext(deck), hand: [deck[0]], handCounts: [1, 27, 27, 27] };
  const candidate = {
    id: 'finish', action: 'play', cards: [deck[0]], hand: parseHand([deck[0]], 7),
    localScore: 0,
  };
  const features = extractHybridValueFeatures(ctx, candidate);
  assert(features.length === HYBRID_VALUE_FEATURES.length,
    '候选编码维度与模型schema完全一致');
  assert(evaluateHybridValueModel(validation.model, features) === 2,
    '价值模型能对候选执行确定性前向计算');
  const invalid = configureHybridValueModel({ schema: HYBRID_VALUE_SCHEMA, layers: [] });
  assert(!invalid.ok && invalid.active, '无效新权重不会破坏上一份有效模型');
  configureHybridValueModel(null);
}

console.log('关键残局混合重排与安全回退');
{
  const deck = createDeck();
  const own = [deck[0], deck[1]];
  const hidden = [deck[27], deck[28], deck[54], deck[55], deck[81], deck[82]];
  const used = new Set([...own, ...hidden].map(physicalKey));
  const playedCards = deck.filter((card) => !used.has(physicalKey(card)));
  const observation = {
    seat: 0,
    hand: own,
    level: 7,
    lastHand: null,
    lastSeat: null,
    handCounts: [2, 2, 2, 2],
    teams: [0, 1, 0, 1],
    finishOrder: [],
    playedCards,
    publicHistory: [],
    difficulty: 'master',
    deterministic: true,
    decisionEngine: 'hybrid',
  };
  const candidates = own.map((card, index) => ({
    id: `candidate_${index}`,
    action: 'play',
    cards: [card],
    hand: parseHand([card], 7),
    signature: handSignature(parseHand([card], 7)),
    localScore: 10 - index,
  }));
  const consultation = {
    action: 'play',
    cards: [own[0]],
    hand: candidates[0].hand,
    reason: '专家首选',
    candidates,
    localCandidateId: 'candidate_0',
    cloudConstraint: 'soft_rerank',
  };
  const result = chooseHybridFromConsultation(observation, consultation, {
    sampleCount: 3,
    behaviorAttempts: 1,
    maxPlies: 48,
    nodeBudget: 800,
    seed: 123,
  });
  assert(result.decision?.action === 'play' && result.decision.hybrid,
    '关键残局返回合法混合决策及逐候选遥测');
  assert(result.decision.hybrid.samples === 3 && result.decision.hybrid.nodes > 0,
    '信息集采样与受限终局模拟实际执行而非只打标签');

  const hard = chooseHybridFromConsultation(observation, {
    ...consultation,
    candidates: [candidates[0]],
    cloudConstraint: 'finish_now',
  });
  assert(hard.decision?.hybrid?.applied === false
    && hard.decision.hybrid.reason === 'hard_constraint_or_single_candidate',
  '本地硬约束或单一候选时不允许模型/模拟绕过安全策略');

  const passCandidate = { id: 'pass', action: 'pass', cards: [], hand: null, signature: null };
  const noNewPass = chooseHybridFromConsultation({
    ...observation,
    lastHand: { type: 'single', mainRank: 1, size: 1, power: 1, meta: {} },
    lastSeat: 3,
  }, {
    ...consultation,
    candidates: [candidates[0], passCandidate],
    cloudConstraint: 'soft_rerank',
  });
  assert(noNewPass.decision?.action === 'play'
    && noNewPass.telemetry?.rejectedCandidates?.some((item) => (
      item.id === 'pass' && item.reason === 'no_new_pass_override'
    )), '混合层不能把专家已经决定的普通接牌重新改成过牌');
}

console.log('混合候选执行前恢复完整牌型声明');
{
  const deck = createDeck();
  const own = deck.slice(0, 10);
  const hidden = deck.slice(10, 40);
  const used = new Set([...own, ...hidden].map(physicalKey));
  const playedCards = deck.filter((card) => !used.has(physicalKey));
  const makeStraightCandidate = (cards, id, score) => {
    const full = parseHandVariants(cards, 7).find((hand) => hand.type === 'flush_straight');
    return {
      id,
      action: 'play',
      cards,
      hand: {
        type: full.type,
        mainRank: full.mainRank,
        size: full.size,
        power: full.power,
      },
      signature: handSignature(full),
      localScore: score,
      full,
    };
  };
  const first = makeStraightCandidate(own.slice(0, 5), 'straight_0', 20);
  const second = makeStraightCandidate(own.slice(5, 10), 'straight_1', 19);
  const result = chooseHybridFromConsultation({
    seat: 0,
    hand: own,
    level: 7,
    lastHand: null,
    lastSeat: null,
    handCounts: [10, 10, 10, 10],
    teams: [0, 1, 0, 1],
    finishOrder: [],
    playedCards,
    publicHistory: [],
    difficulty: 'master',
    deterministic: true,
    decisionEngine: 'hybrid',
  }, {
    action: 'play',
    cards: first.cards,
    hand: first.full,
    signature: first.signature,
    reason: '专家首选',
    candidates: [first, second].map(({ full, ...candidate }) => candidate),
    localCandidateId: first.id,
    cloudConstraint: 'soft_rerank',
  }, {
    sampleCount: 2,
    behaviorAttempts: 1,
    maxPlies: 40,
    nodeBudget: 600,
    seed: 88,
  });
  assert(Array.isArray(result.decision?.hand?.meta?.sequence)
    && result.decision.signature === handSignature(result.decision.hand),
  '紧凑候选改选后按牌型签名恢复顺子/同花顺完整声明');
}

console.log('专家安全筛选不可被短视模拟绕过');
{
  const deck = createDeck();
  const tripleCards = deck.filter((card) => card.rank === 12).slice(0, 3);
  const bombCards = deck.filter((card) => card.rank === 13).slice(0, 4);
  const own = [...tripleCards, ...bombCards];
  const ownKeys = new Set(own.map(physicalKey));
  const hidden = deck.filter((card) => !ownKeys.has(physicalKey(card))).slice(0, 21);
  const visibleKeys = new Set([...own, ...hidden].map(physicalKey));
  const playedCards = deck.filter((card) => !visibleKeys.has(physicalKey(card)));
  const tripleHand = parseHand(tripleCards, 7);
  const bombHand = parseHand(bombCards, 7);
  const local = {
    id: 'safe_triple', action: 'play', cards: tripleCards, hand: tripleHand,
    signature: handSignature(tripleHand), localScore: 100,
  };
  const premium = {
    id: 'lead_bomb', action: 'play', cards: bombCards, hand: bombHand,
    signature: handSignature(bombHand), localScore: 300,
  };
  const result = chooseHybridFromConsultation({
    seat: 0,
    hand: own,
    level: 7,
    lastHand: null,
    lastSeat: null,
    handCounts: [7, 7, 7, 7],
    teams: [0, 1, 0, 1],
    finishOrder: [],
    playedCards,
    publicHistory: [],
    difficulty: 'master',
    deterministic: true,
    decisionEngine: 'hybrid',
  }, {
    action: 'play',
    cards: tripleCards,
    hand: tripleHand,
    reason: '专家资源安全池选择三张',
    candidates: [premium, local],
    localCandidateId: local.id,
    cloudConstraint: 'soft_rerank',
  }, { sampleCount: 2, seed: 99 });
  assert(result.decision?.signature === local.signature
    && result.telemetry?.rejectedCandidates?.some((item) => (
      item.id === premium.id && item.reason === 'premium_control_escalation'
    )), '专家已排除的领炸候选即使原始分更高也不能被增强层恢复');
}

console.log(`\n结果: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
