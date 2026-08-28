/** 混合决策、公平观察、信息集采样与价值模型契约测试。 */
import { createDeck } from './cards.js';
import { handSignature, parseHand, parseHandVariants } from './rules.js';
import {
  auditPublicAIObservation, createPublicAIObservation,
  FORBIDDEN_AI_OBSERVATION_FIELDS,
} from './ai-observation.js';
import {
  HYBRID_VALUE_FEATURES, HYBRID_VALUE_SCHEMA,
  HYBRID_SEARCH_MODES,
  chooseHybridFromConsultation, configureHybridValueModel,
  evaluateInformationSetCandidates,
  evaluateHybridValueModel, extractHybridValueFeatures,
  samplePublicInformationSets, validateHybridValueModel,
} from './ai-hybrid.js';
import { makePromotedValueModel } from './value-model.test-fixture.js';

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
  const model = makePromotedValueModel({
    id: 'unit-finish-value',
    schema: HYBRID_VALUE_SCHEMA,
    layers: [{ weights: [weights], bias: [0], activation: 'linear' }],
  });
  const validation = validateHybridValueModel(model);
  assert(validation.ok && validation.model.weightCount === HYBRID_VALUE_FEATURES.length + 1,
    '固定特征架构与稠密层权重经过尺寸和有限值校验');
  const configured = configureHybridValueModel(model);
  assert(configured.ok && configured.modelId === 'unit-finish-value', '有效模型可原子启用');
  const unpromoted = configureHybridValueModel({ ...model, metadata: { status: 'validated' } });
  assert(!unpromoted.ok && unpromoted.reason === 'model_not_promoted' && unpromoted.active,
    '未证明强于专家的validated模型不能替换当前晋级模型');
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

console.log('成对根 PIMC 公平根动作覆盖');
{
  const deck = createDeck();
  const own = [deck[0], deck[1]];
  const hidden = [deck[27], deck[28], deck[54], deck[55], deck[81], deck[82]];
  const used = new Set([...own, ...hidden].map(physicalKey));
  const playedCards = deck.filter((card) => !used.has(physicalKey(card)));
  const candidates = own.map((card, index) => {
    const hand = parseHand([card], 7);
    return {
      id: `root_${index}`,
      action: 'play',
      cards: [card],
      hand,
      signature: handSignature(hand),
      localScore: 10 - index,
    };
  });
  const context = {
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
    decisionEngine: 'ismcts',
    hands: [['secret'], ['another-secret']],
  };
  const options = {
    searchMode: 'paired-root-pimc-v1', sampleCount: 3, behaviorAttempts: 1,
    iterationBudget: 10, maxPlies: 48, nodeBudget: 1000, seed: 20260826,
  };
  const first = evaluateInformationSetCandidates(context, candidates, options);
  const second = evaluateInformationSetCandidates({ ...context, hands: [['changed-secret']] }, candidates, options);
  assert(first.applied && first.searchMode === HYBRID_SEARCH_MODES.PAIRED_ROOT_PIMC,
    '成对根 PIMC 在关键局面完成公平信息集根候选覆盖');
  assert(first.iterations === candidates.length * 3
    && first.candidateResults.every((item) => item.visits === 3),
  '每条 iteration 都对应一次实际 rollout，不保留空转预算');
  assert(first.pairedWorlds === 3
    && first.candidateResults.every((item) => (
      item.worldAttempts.slice(0, 3).every((attempts) => attempts >= 1)
    )), '每个候选都在相同的三个假想世界完成基础覆盖');
  assert(JSON.stringify(first.candidateResults) === JSON.stringify(second.candidateResults),
    '成对根 PIMC 结果不受调用方误传暗牌字段影响，且固定种子可复现');
  const legacyAlias = evaluateInformationSetCandidates(context, candidates, {
    ...options, searchMode: 'ismcts-root-v1',
  });
  assert(legacyAlias.searchMode === HYBRID_SEARCH_MODES.PAIRED_ROOT_PIMC
    && JSON.stringify(legacyAlias.candidateResults) === JSON.stringify(first.candidateResults),
  '历史 ismcts-root-v1 标识会兼容映射为成对根 PIMC');

  const thinEvidence = evaluateInformationSetCandidates(context, candidates, {
    ...options,
    iterationBudget: 2,
  });
  assert(!thinEvidence.applied && thinEvidence.reason === 'insufficient_search_evidence'
    && thinEvidence.pairedWorlds === 1
    && thinEvidence.candidateResults.every((item) => item.attempts === 1),
  '只有单个成对世界时保留搜索遥测，但不允许作为改选证据');
  const oneWorldPimc = evaluateInformationSetCandidates(context, candidates, {
    searchMode: 'pimc-v1', sampleCount: 1, behaviorAttempts: 1,
    maxPlies: 48, nodeBudget: 1000, seed: 20260826,
  });
  assert(oneWorldPimc.applied && oneWorldPimc.minimumEffectiveVisits == null,
  '最低访问与成对世界门禁只作用于成对根 PIMC，旧 PIMC 完成边界不变');

  const midOwn = deck.slice(0, 14);
  const midPlayed = deck.slice(56);
  const midCandidates = midOwn.slice(0, 2).map((card, index) => {
    const hand = parseHand([card], 7);
    return {
      id: `mid_${index}`, action: 'play', cards: [card], hand,
      signature: handSignature(hand), localScore: 10 - index,
    };
  });
  const midContext = {
    ...context, hand: midOwn, handCounts: [14, 14, 14, 14], playedCards: midPlayed,
  };
  const pimcMid = evaluateInformationSetCandidates(midContext, midCandidates, {
    searchMode: 'pimc-v1', sampleCount: 2, seed: 91,
  });
  const rootMid = evaluateInformationSetCandidates(midContext, midCandidates, {
    searchMode: 'paired-root-pimc-v1', sampleCount: 2, iterationBudget: 4,
    minimumEffectiveVisits: 2, maxPlies: 32, nodeBudget: 500, seed: 91,
  });
  assert(pimcMid.reason === 'not_critical' && rootMid.critical.scope === 'root_extended'
    && rootMid.applied,
  '中残局扩展范围只对显式成对根 PIMC 生效，原 PIMC 触发边界保持不变');
}

console.log('成对根 PIMC 置信改选门禁');
{
  const deck = createDeck();
  const own = [deck[0], deck[1]];
  const hidden = [deck[27], deck[28], deck[54], deck[55], deck[81], deck[82]];
  const used = new Set([...own, ...hidden].map(physicalKey));
  const playedCards = deck.filter((card) => !used.has(physicalKey(card)));
  const candidates = own.map((card, index) => {
    const hand = parseHand([card], 7);
    return {
      id: `confidence_${index}`, action: 'play', cards: [card], hand,
      signature: handSignature(hand), localScore: 10 - index,
    };
  });
  const weights = new Array(HYBRID_VALUE_FEATURES.length).fill(0);
  weights[31] = 100; // 故意用主点数把第二候选推到综合分首位。
  const valueModel = validateHybridValueModel({
    id: 'confidence-gate-probe',
    schema: HYBRID_VALUE_SCHEMA,
    layers: [{ weights: [weights], bias: [0], activation: 'linear' }],
  }).model;
  const result = chooseHybridFromConsultation({
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
    decisionEngine: 'ismcts',
  }, {
    action: 'play',
    cards: own[0],
    hand: candidates[0].hand,
    signature: candidates[0].signature,
    reason: '专家首选',
    candidates,
    localCandidateId: candidates[0].id,
    cloudConstraint: 'soft_rerank',
  }, {
    searchMode: 'paired-root-pimc-v1',
    sampleCount: 3,
    iterationBudget: 6,
    minimumEffectiveVisits: 3,
    minimumUtilityGap: 1,
    confidenceZ: 3,
    maxPlies: 48,
    nodeBudget: 1000,
    behaviorAttempts: 1,
    seed: 20260826,
    valueModel,
  });
  assert(result.telemetry?.proposedCandidateId === candidates[1].id
    && result.decision?.signature === candidates[0].signature,
  '价值分提议改选但搜索置信差不足时，最终保持专家首选');
  assert(result.telemetry?.rerankGate?.required
    && result.telemetry.rerankGate.allowed === false
    && result.telemetry.rerankGate.reason === 'confidence_margin_insufficient'
    && result.telemetry.candidates.every((item) => item.visits >= 3),
  '改选门禁同时记录有效访问数、标准误与置信差');
}

console.log('成对根 PIMC 不伪造额外迭代');
{
  const deck = createDeck();
  const own = [deck[0], deck[1]];
  const hidden = [deck[27], deck[28], deck[54], deck[55], deck[81], deck[82]];
  const used = new Set([...own, ...hidden].map(physicalKey));
  const playedCards = deck.filter((card) => !used.has(physicalKey(card)));
  const candidates = own.map((card, index) => {
    const hand = parseHand([card], 7);
    return {
      id: `repeat_${index}`, action: 'play', cards: [card], hand,
      signature: handSignature(hand), localScore: 10 - index,
    };
  });
  const context = {
    seat: 0, hand: own, level: 7, lastHand: null, lastSeat: null,
    handCounts: [2, 2, 2, 2], teams: [0, 1, 0, 1], finishOrder: [],
    playedCards, publicHistory: [], difficulty: 'master',
    deterministic: true, decisionEngine: 'ismcts',
  };
  const shared = {
    searchMode: 'paired-root-pimc-v1', sampleCount: 3, behaviorAttempts: 1,
    maxPlies: 48, nodeBudget: 1000, seed: 20260826,
  };
  const paired = evaluateInformationSetCandidates(context, candidates, {
    ...shared, iterationBudget: 6,
  });
  const leftover = evaluateInformationSetCandidates(context, candidates, {
    ...shared, iterationBudget: 24,
  });
  assert(paired.applied && leftover.applied && leftover.iterations === paired.iterations,
    '预算超过完整成对世界覆盖时不会伪造额外 iteration');
  assert(paired.candidateResults.every((item, index) => {
    const extra = leftover.candidateResults[index];
    return item.visits === extra.visits
      && item.attempts === extra.attempts
      && item.visits === paired.pairedWorlds
      && item.utility === extra.utility
      && item.standardError === extra.standardError;
  }), '额外预算不改变真实样本数、标准误或用于改选的均值');
  assert(leftover.candidateResults.every((item) => item.worldAttempts.every((attempts) => attempts <= 1)),
    '同一候选/世界不会被重复尝试并冒充新 rollout');

  const weights = new Array(HYBRID_VALUE_FEATURES.length).fill(0);
  weights[31] = 100;
  const valueModel = validateHybridValueModel({
    id: 'repeat-world-gate-probe',
    schema: HYBRID_VALUE_SCHEMA,
    layers: [{ weights: [weights], bias: [0], activation: 'linear' }],
  }).model;
  const gateOptions = {
    ...shared, minimumEffectiveVisits: 3, minimumUtilityGap: 1, confidenceZ: 3, valueModel,
  };
  const leftoverGate = chooseHybridFromConsultation(context, {
    action: 'play', cards: own[0], hand: candidates[0].hand,
    signature: candidates[0].signature, reason: '专家首选', candidates,
    localCandidateId: candidates[0].id, cloudConstraint: 'soft_rerank',
  }, { ...gateOptions, iterationBudget: 24 });
  const pairedGate = chooseHybridFromConsultation(context, {
    action: 'play', cards: own[0], hand: candidates[0].hand,
    signature: candidates[0].signature, reason: '专家首选', candidates,
    localCandidateId: candidates[0].id, cloudConstraint: 'soft_rerank',
  }, { ...gateOptions, iterationBudget: 6 });
  assert(pairedGate.telemetry?.proposedCandidateId === candidates[1].id
    && leftoverGate.telemetry?.rerankGate?.allowed === false
    && leftoverGate.telemetry?.rerankGate?.allowed === pairedGate.telemetry?.rerankGate?.allowed
    && leftoverGate.telemetry?.rerankGate?.reason === pairedGate.telemetry?.rerankGate?.reason,
  '剩余预算不能把置信改选门从拒绝翻成允许');
}

console.log('晋级模型关键局面门禁');
{
  const deck = createDeck();
  const ctx = baseContext(deck);
  const candidateCards = [deck[0], deck[1]];
  const candidates = candidateCards.map((card, index) => {
    const hand = parseHand([card], ctx.level);
    return {
      id: `ordinary_${index}`, action: 'play', cards: [card], hand,
      signature: handSignature(hand), localScore: 10 - index,
    };
  });
  const weights = new Array(HYBRID_VALUE_FEATURES.length).fill(0);
  weights[31] = 100;
  const valueModel = validateHybridValueModel(makePromotedValueModel({
    id: 'non-critical-probe', schema: HYBRID_VALUE_SCHEMA,
    layers: [{ weights: [weights], bias: [0], activation: 'linear' }],
  })).model;
  const result = chooseHybridFromConsultation(ctx, {
    action: 'play', cards: candidates[0].cards, hand: candidates[0].hand,
    signature: candidates[0].signature, reason: '专家首选', candidates,
    localCandidateId: candidates[0].id, cloudConstraint: 'soft_rerank',
  }, { searchMode: 'pimc-v1', sampleCount: 2, valueModel });
  assert(result.decision?.signature === candidates[0].signature
    && result.telemetry?.reason === 'not_critical' && !result.telemetry?.applied,
  '晋级模型在非关键局面不能绕过搜索门禁改写专家动作');
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
