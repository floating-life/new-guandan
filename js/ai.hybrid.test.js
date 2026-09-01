/** 混合决策、公平观察、信息集采样与价值模型契约测试。 */
import { createDeck } from './cards.js';
import {
  HandType, generateLegalPlays, handSignature, parseHand, parseHandVariants,
} from './rules.js';
import {
  auditPublicAIObservation, createPublicAIObservation,
  FORBIDDEN_AI_OBSERVATION_FIELDS,
} from './ai-observation.js';
import {
  HYBRID_VALUE_FEATURES, HYBRID_VALUE_SCHEMA,
  HYBRID_SEARCH_MODES,
  availabilityAwareUctBonus,
  chooseHybridFromConsultation, chooseRolloutPlay, configureHybridValueModel,
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

console.log('availability-aware UCT');
{
  const bonus = availabilityAwareUctBonus(15, 3, 2);
  const expected = 2 * Math.sqrt(Math.log(16) / 3);
  assert(Math.abs(bonus - expected) < 1e-12,
    'UCT 探索项以动作 availability 为分子、动作 visits 为分母');
  assert(availabilityAwareUctBonus(30, 3, 2) > bonus
    && availabilityAwareUctBonus(15, 6, 2) < bonus,
  'availability 增加会提高探索项，而同一动作访问增加会降低探索项');
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
  assert(result.decision.hybrid.searchAttempted === true
    && result.decision.hybrid.searchTriggered === true,
  '实际执行的信息集搜索必须写入显式搜索状态');
  assert(result.decision.hybrid.rolloutDiagnostics
      && typeof result.decision.hybrid.rolloutDiagnostics === 'object',
  'PIMC 最终混合遥测保留 rollout 诊断对象');

  const hard = chooseHybridFromConsultation(observation, {
    ...consultation,
    candidates: [candidates[0]],
    cloudConstraint: 'finish_now',
  });
  assert(hard.decision?.hybrid?.applied === false
    && hard.decision.hybrid.reason === 'hard_constraint_or_single_candidate'
    && hard.decision.hybrid.searchAttempted === false
    && hard.decision.hybrid.searchTriggered === false
    && hard.decision.hybrid.fallbackKind === 'expert_safety_fallback',
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
  assert(first.rolloutDiagnostics && typeof first.rolloutDiagnostics === 'object',
    '成对根 PIMC 结果保留 rollout 诊断对象');
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
    && thinEvidence.candidateResults.every((item) => item.attempts === 1)
    && thinEvidence.searchAttempted === true
    && thinEvidence.searchTriggered === true,
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

console.log('ISMCTS v2 开放环信息集树');
{
  const deck = createDeck();
  const own = [deck[0], deck[1]];
  const hidden = [deck[27], deck[28], deck[54], deck[55], deck[81], deck[82]];
  const used = new Set([...own, ...hidden].map(physicalKey));
  const playedCards = deck.filter((card) => !used.has(physicalKey(card)));
  const candidates = own.map((card, index) => {
    const hand = parseHand([card], 7);
    return {
      id: `tree_${index}`, action: 'play', cards: [card], hand,
      signature: handSignature(hand), localScore: 10 - index,
    };
  });
  const context = {
    seat: 0, hand: own, level: 7, lastHand: null, lastSeat: null,
    handCounts: [2, 2, 2, 2], teams: [0, 1, 0, 1], finishOrder: [],
    playedCards, publicHistory: [], difficulty: 'master', deterministic: true,
    decisionEngine: 'ismcts-v2', hands: [['hidden-state'], ['never-read']],
  };
  const options = {
    searchMode: 'ismcts-v2', behaviorAttempts: 1, iterationBudget: 12,
    minimumEffectiveVisits: 3, maxPlies: 48, nodeBudget: 1000, seed: 20260828,
  };
  const first = evaluateInformationSetCandidates(context, candidates, options);
  const second = evaluateInformationSetCandidates({
    ...context, hands: [['different-hidden-state'], ['also-never-read']],
  }, candidates, options);
  assert(first.applied && first.searchMode === HYBRID_SEARCH_MODES.ISMCTS,
    'ISMCTS v2 在关键局面完成开放环信息集搜索');
  assert(first.iterations === 12 && first.sampledWorlds === 12 && first.treeNodes > 2,
    '每个 ISMCTS iteration 都重新采样世界，并产生非根树节点');
  assert(first.candidateResults.every((item) => (
    item.availability === 12 && item.visits >= 3 && item.completedSamples === item.visits
  )), 'UCT 根候选记录可用次数、真实访问数与 rollout 结果，不伪造覆盖');
  assert(first.rolloutDiagnostics && typeof first.rolloutDiagnostics === 'object'
      && !(first.sampleFailures?.rollout_action_invalid),
  'ISMCTS 搜索结果保留 rollout 诊断载荷且首出不会伪造非法过牌失败');
  assert(JSON.stringify(first.candidateResults) === JSON.stringify(second.candidateResults),
    'ISMCTS v2 固定公开输入和种子时可复现，误传暗牌字段不影响结果');
}

console.log('rollout 首出不变量与异常回退');
{
  const deck = createDeck();
  const hand = [
    ...deck.filter((card) => card.rank === 9).slice(0, 5),
    ...deck.filter((card) => card.rank === 10).slice(0, 4),
  ];
  const state = {
    hands: [hand, [], [], []],
    level: 7,
    lastHand: null,
    lastSeat: null,
    teams: [0, 1, 0, 1],
  };
  const legal = generateLegalPlays(hand, state.level, null);
  const normal = chooseRolloutPlay(state, 0, legal);
  assert(normal?.cards?.length > 0 && normal.hand?.type !== 'pass',
    '首出非空手牌始终返回合法出牌，不把 null 当作 pass');

  // 模拟未来牌型生成器异常地只给出炸弹候选，验证保护路径而不是依赖
  // 当前“单张总会生成”的实现细节。
  const bombOnly = legal.filter((play) => play.hand?.type === HandType.BOMB);
  const fallback = chooseRolloutPlay(state, 0, bombOnly);
  const reversedFallback = chooseRolloutPlay(state, 0, [...bombOnly].reverse());
  const cardSignature = (cards) => cards.map(physicalKey).sort().join(',');
  assert(bombOnly.length > 0 && fallback?.cards?.length > 0
      && bombOnly.some((play) => handSignature(play.hand) === handSignature(fallback.hand))
      && fallback.cards.every((card) => hand.includes(card))
      && fallback.cards.length === 4
      && fallback.rolloutDiagnostic === 'lead_no_ordinary_fallback',
  '首出无普通候选时选择最小结构成本的合法炸弹并留下显式诊断');
  assert(reversedFallback?.rolloutDiagnostic === fallback.rolloutDiagnostic
      && handSignature(reversedFallback.hand) === handSignature(fallback.hand)
      && cardSignature(reversedFallback.cards) === cardSignature(fallback.cards),
  '首出异常回退在候选乱序下仍保持确定性');

  const finishingState = {
    ...state,
    hands: [fallback.cards, [], [], []],
  };
  const finishing = chooseRolloutPlay(finishingState, 0, [{ ...fallback,
    rolloutDiagnostic: undefined,
  }]);
  assert(finishing?.cards?.length === finishingState.hands[0].length
      && !finishing.rolloutDiagnostic,
  '整手合法炸弹收官走正常 finishing 路径，不误记为异常回退');

  const responseState = {
    ...state,
    hands: [hand.slice(0, 8), new Array(9).fill(null), [], []],
    lastHand: parseHand([deck.find((card) => card.rank === 8)], state.level),
    lastSeat: 1,
  };
  const responseCandidates = [
    bombOnly.find((play) => play.cards.length === 5),
    bombOnly.find((play) => play.cards.length === 4),
  ].filter(Boolean);
  const response = chooseRolloutPlay(responseState, 0, responseCandidates);
  assert(response?.cards?.length === 4 && !response.rolloutDiagnostic,
    '跟牌仍按原有结构成本/点力顺序选择，不受首出回退重构影响');

  const shortHand = hand.slice(0, 7);
  const shortState = { ...state, hands: [shortHand, [], [], []] };
  const shortBombs = generateLegalPlays(shortHand, state.level, null)
    .filter((play) => play.hand?.type === HandType.BOMB);
  const shortFallback = chooseRolloutPlay(shortState, 0, shortBombs);
  assert(shortFallback?.cards?.length > 0
      && shortFallback.rolloutDiagnostic === 'lead_no_ordinary_fallback',
  '7张首出即使只有炸弹候选也不走紧急跟牌分支，仍记录首出回退');
}

console.log('ISMCTS v3 根候选成对采样');
{
  const deck = createDeck();
  const own = [deck[0], deck[1]];
  const hidden = [deck[27], deck[28], deck[54], deck[55], deck[81], deck[82]];
  const used = new Set([...own, ...hidden].map(physicalKey));
  const playedCards = deck.filter((card) => !used.has(physicalKey(card)));
  const candidates = own.map((card, index) => {
    const hand = parseHand([card], 7);
    return {
      id: `sweep_${index}`, action: 'play', cards: [card], hand,
      signature: handSignature(hand), localScore: 10 - index,
    };
  });
  const context = {
    seat: 0, hand: own, level: 7, lastHand: null, lastSeat: null,
    handCounts: [2, 2, 2, 2], teams: [0, 1, 0, 1], finishOrder: [],
    playedCards, publicHistory: [], difficulty: 'master', deterministic: true,
    decisionEngine: 'ismcts-v3', hands: [['hidden-state'], ['never-read']],
  };
  const options = {
    searchMode: 'ismcts-v3', behaviorAttempts: 1, iterationBudget: 12,
    minimumEffectiveVisits: 3, maxPlies: 48, nodeBudget: 1000, seed: 20260829,
  };
  const first = evaluateInformationSetCandidates(context, candidates, options);
  const second = evaluateInformationSetCandidates({
    ...context, hands: [['different-hidden-state'], ['also-never-read']],
  }, candidates, options);
  assert(first.applied && first.searchMode === HYBRID_SEARCH_MODES.ISMCTS_V3,
    'ISMCTS v3 在关键局面完成根候选成对采样搜索');
  assert(first.pairedSweeps === 6 && first.sampledWorlds === 6
    && first.iterations === 6 * candidates.length && first.treeNodes > 2,
  'iterationBudget 与 v2 同口径按 rollout 总预算换算 sweep 数，每次 sweep 对每个根候选各下钻一次');
  assert(first.candidateResults.every((item) => (
    item.visits === first.pairedSweeps
    && item.availability === first.pairedSweeps
    && item.completedSamples === item.visits
  )), 'v3 根候选严格成对：visits 与 availability 恒等于成功 sweep 数');
  assert(first.requiredPairedSweeps === 3 && first.pairedWorlds === 0,
    'v3 证据门槛按成对 sweep 数判定，不复用成对 PIMC 的世界口径');
  assert(first.rolloutDiagnostics && typeof first.rolloutDiagnostics === 'object',
    'ISMCTS v3 结果保留 rollout 诊断对象');
  assert(JSON.stringify(first.candidateResults) === JSON.stringify(second.candidateResults)
    && first.pairedSweeps === second.pairedSweeps,
  'ISMCTS v3 固定公开输入和种子时可复现，误传暗牌字段不影响结果');

  const tinyBudget = evaluateInformationSetCandidates(context, candidates, {
    ...options, iterationBudget: 36, nodeBudget: 100,
  });
  assert(tinyBudget.pairedSweeps < 18,
    '保守预算估计在节点预算耗尽前停止启动新 sweep，不会用完全部 18 次 sweep 配额');
  assert(tinyBudget.candidateResults.every((item) => (
    item.visits === tinyBudget.pairedSweeps
    && item.availability === tinyBudget.pairedSweeps
  )), '预算受限下根候选仍严格成对，不留半成对状态');
  const tinyRepeat = evaluateInformationSetCandidates(context, candidates, {
    ...options, iterationBudget: 36, nodeBudget: 100,
  });
  assert(tinyRepeat.pairedSweeps === tinyBudget.pairedSweeps
    && JSON.stringify(tinyRepeat.candidateResults) === JSON.stringify(tinyBudget.candidateResults),
  '保守启动估计是确定性的：同种子同输入下停止点逐字节一致');

  const tooFewSweeps = evaluateInformationSetCandidates(context, candidates, {
    ...options, iterationBudget: 1,
  });
  assert(!tooFewSweeps.applied && tooFewSweeps.reason === 'insufficient_search_evidence'
    && tooFewSweeps.pairedSweeps === 1
    && tooFewSweeps.candidateResults.every((item) => item.visits === 1),
  '成对 sweep 数不足时保留搜索遥测，但不允许作为改选证据');
}

console.log('ISMCTS v3 失败 sweep 深层事务回滚');
{
  const deck = createDeck();
  const own = [deck[0], deck[1]];
  const hidden = [deck[27], deck[28], deck[54], deck[55], deck[81], deck[82]];
  const used = new Set([...own, ...hidden].map(physicalKey));
  const playedCards = deck.filter((card) => !used.has(physicalKey(card)));
  const validHand = parseHand([own[0]], 7);
  // This card is public/absent from the sampled own hand.  It is deliberately
  // shaped like a legal candidate so the first valid candidate can expand a
  // deep node before the second candidate makes the sweep fail.
  const invalidCard = deck[2];
  const invalidHand = parseHand([invalidCard], 7);
  const candidates = [
    {
      id: 'rollback_valid', action: 'play', cards: [own[0]], hand: validHand,
      signature: handSignature(validHand), localScore: 10,
    },
    {
      id: 'rollback_invalid', action: 'play', cards: [invalidCard], hand: invalidHand,
      signature: handSignature(invalidHand), localScore: 9,
    },
  ];
  const context = {
    seat: 0, hand: own, level: 7, lastHand: null, lastSeat: null,
    handCounts: [2, 2, 2, 2], teams: [0, 1, 0, 1], finishOrder: [],
    playedCards, publicHistory: [], difficulty: 'master', deterministic: true,
    decisionEngine: 'ismcts-v3', hands: [['hidden-state'], ['never-read']],
  };
  const result = evaluateInformationSetCandidates(context, candidates, {
    searchMode: 'ismcts-v3', behaviorAttempts: 1, iterationBudget: 2,
    minimumEffectiveVisits: 2, maxPlies: 48, nodeBudget: 1000, seed: 20260901,
  });
  assert(result.pairedSweeps === 0, '失败 sweep 不得计入成对证据');
  assert(result.sampleFailures.sweep_outcome_failed === 1,
    '后置候选失败必须显式计入失败 sweep');
  assert(result.treeNodes === 1,
    '后置候选失败后此前候选创建的深层子树必须整棵回滚');
  assert(result.candidateResults.every((item) => (
    item.visits === 0 && (item.availability || 0) === 0 && item.completedSamples === 0
  )), '失败 sweep 不得残留根 visits/availability 或 rollout');
}

console.log('ISMCTS v3 后置 rollout 失败的深树事务回滚');
{
  const deck = createDeck();
  const own = [deck[0], deck[1]];
  const hidden = [deck[27], deck[28], deck[54], deck[55], deck[81], deck[82]];
  const used = new Set([...own, ...hidden].map(physicalKey));
  const playedCards = deck.filter((card) => !used.has(physicalKey(card)));
  const candidates = own.map((card, index) => {
    const hand = parseHand([card], 7);
    return {
      id: `postrollout_${index}`, action: 'play', cards: [card], hand,
      signature: handSignature(hand), localScore: 10 - index,
    };
  });
  const context = {
    seat: 0, hand: own, level: 7, lastHand: null, lastSeat: null,
    handCounts: [2, 2, 2, 2], teams: [0, 1, 0, 1], finishOrder: [],
    playedCards, publicHistory: [], difficulty: 'master', deterministic: true,
    decisionEngine: 'ismcts-v3', hands: [['hidden-state'], ['never-read']],
  };
  const result = evaluateInformationSetCandidates(context, candidates, {
    searchMode: 'ismcts-v3', behaviorAttempts: 1, iterationBudget: 6,
    minimumEffectiveVisits: 2, maxPlies: 48, nodeBudget: 1000,
    includeTreeDigest: true, seed: 20260903,
    testHooks: {
      forcedOutcome: ({ sweepIndex, offset }) => (
        sweepIndex === 1 && offset === 1 ? { ok: false, reason: 'test_forced_failure' } : null
      ),
    },
  });
  const failed = result.rollbackDiagnostics.find((item) => item.kind === 'failed');
  assert(result.pairedSweeps === 2,
    '后置 rollout 失败后，之前与之后的成功 sweep 都应保留');
  assert(result.sampleFailures.sweep_outcome_failed === 1,
    '后置候选 rollout 失败必须显式计入失败 sweep');
  assert(failed && failed.reason === 'test_forced_failure',
    '回滚诊断必须绑定到注入的后置候选失败');
  assert(failed.snapshotDigest.actions.some((item) => item.child),
    '失败 sweep 前的快照必须已经包含深层子树');
  assert(JSON.stringify(failed.mutatedDigest) !== JSON.stringify(failed.snapshotDigest),
    '后置候选失败前必须确实写入新的深层 availability/子节点状态');
  assert(JSON.stringify(failed.restoredDigest) === JSON.stringify(failed.snapshotDigest),
    '后置 rollout 失败后必须恢复整棵深层树');
  assert(result.treeDigest.actions.every((item) => item.visits === 2
    && item.availability === 2), '失败 sweep 不得污染最终根证据计数');
}

console.log('ISMCTS v3 中断 sweep 保留既有深层树');
{
  const deck = createDeck();
  const own = [deck[0], deck[1]];
  const hidden = [deck[27], deck[28], deck[54], deck[55], deck[81], deck[82]];
  const used = new Set([...own, ...hidden].map(physicalKey));
  const playedCards = deck.filter((card) => !used.has(physicalKey(card)));
  const candidates = own.map((card, index) => {
    const hand = parseHand([card], 7);
    return {
      id: `interrupt_${index}`, action: 'play', cards: [card], hand,
      signature: handSignature(hand), localScore: 10 - index,
    };
  });
  const context = {
    seat: 0, hand: own, level: 7, lastHand: null, lastSeat: null,
    handCounts: [2, 2, 2, 2], teams: [0, 1, 0, 1], finishOrder: [],
    playedCards, publicHistory: [], difficulty: 'master', deterministic: true,
    decisionEngine: 'ismcts-v3', hands: [['hidden-state'], ['never-read']],
  };
  const control = evaluateInformationSetCandidates(context, candidates, {
    searchMode: 'ismcts-v3', behaviorAttempts: 1, iterationBudget: 2,
    minimumEffectiveVisits: 2, maxPlies: 16, nodeBudget: 1000,
    includeTreeDigest: true, seed: 20260902,
  });
  const performanceDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  let performanceCalls = 0;
  Object.defineProperty(globalThis, 'performance', {
    configurable: true,
    value: { now: () => { performanceCalls += 1; return performanceCalls <= 27 ? 0 : 100; } },
  });
  let interrupted;
  try {
    interrupted = evaluateInformationSetCandidates(context, candidates, {
      searchMode: 'ismcts-v3', behaviorAttempts: 1, iterationBudget: 4,
      minimumEffectiveVisits: 2, maxPlies: 16, nodeBudget: 1000,
      includeTreeDigest: true, deadlineMs: 1, seed: 20260902,
    });
  } finally {
    Object.defineProperty(globalThis, 'performance', performanceDescriptor);
  }
  assert(control.pairedSweeps === 1 && control.treeNodes > 1,
    '控制运行必须先形成一棵带深层节点的成功 sweep');
  assert(interrupted.pairedSweeps === 1
    && interrupted.sampleFailures.partial_sweep_discarded === 1,
  '后续 sweep 中途耗尽预算必须显式丢弃整批');
  assert(interrupted.treeNodes === control.treeNodes
    && JSON.stringify(interrupted.treeDigest) === JSON.stringify(control.treeDigest)
    && JSON.stringify(interrupted.candidateResults) === JSON.stringify(control.candidateResults),
  '中断回滚后既有深层 availability/子节点/visits/reward 必须与控制树完全一致');
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

console.log('forceExpertChoice 消融臂');
{
  const deck = createDeck();
  const own = [deck[0], deck[1]];
  const hidden = [deck[27], deck[28], deck[54], deck[55], deck[81], deck[82]];
  const used = new Set([...own, ...hidden].map(physicalKey));
  const playedCards = deck.filter((card) => !used.has(physicalKey(card)));
  const candidates = own.map((card, index) => {
    const hand = parseHand([card], 7);
    return {
      id: `fxe_${index}`, action: 'play', cards: [card], hand,
      signature: handSignature(hand), localScore: 10 - index,
    };
  });
  const weights = new Array(HYBRID_VALUE_FEATURES.length).fill(0);
  weights[31] = 100; // 与置信门禁探针相同：把第二候选推到综合分首位。
  const valueModel = validateHybridValueModel({
    id: 'fxe-probe',
    schema: HYBRID_VALUE_SCHEMA,
    layers: [{ weights: [weights], bias: [0], activation: 'linear' }],
  }).model;
  const context = {
    seat: 0, hand: own, level: 7, lastHand: null, lastSeat: null,
    handCounts: [2, 2, 2, 2], teams: [0, 1, 0, 1], finishOrder: [],
    playedCards, publicHistory: [], difficulty: 'master', deterministic: true,
    decisionEngine: 'ismcts',
  };
  const consultation = {
    action: 'play', cards: own[0], hand: candidates[0].hand,
    signature: candidates[0].signature, reason: '专家首选', candidates,
    localCandidateId: candidates[0].id, cloudConstraint: 'soft_rerank',
  };
  // 旧 PIMC 模式下根置信门禁不拦截（not_root_search），且样本量放大后
  // rollout 与价值分同向推第二候选，保证本探针中正常臂确定性改选，
  // 从而覆盖强制臂的全部遥测分支。
  const options = {
    searchMode: 'pimc-v1', sampleCount: 6, iterationBudget: 12,
    maxPlies: 48, nodeBudget: 2000, behaviorAttempts: 1, seed: 20260829, valueModel,
  };
  const normal = chooseHybridFromConsultation(context, consultation, options);
  const forced = chooseHybridFromConsultation(context, consultation, {
    ...options, forceExpertChoice: true,
  });
  assert(normal.telemetry?.proposedCandidateId === candidates[1].id
    && normal.telemetry?.changedDecision === true
    && normal.telemetry?.wouldChangeDecision === true,
  '探针布局下正常臂确定性改选第二候选');
  assert(JSON.stringify(normal.telemetry.candidates) === JSON.stringify(forced.telemetry.candidates)
    && normal.telemetry.proposedCandidateId === forced.telemetry.proposedCandidateId,
  'forceExpertChoice 不改变任何搜索统计与提议，两臂只有最终选择不同');
  assert(forced.telemetry?.forceExpertChoice === true
    && forced.telemetry.finalCandidateId === candidates[0].id
    && forced.telemetry.changedDecision === false
    && forced.telemetry.wouldChangeDecision === true
    && forced.telemetry.searchAttempted === true
    && forced.telemetry.searchTriggered === true
    && forced.telemetry.fallbackKind === 'force_expert_choice'
    && forced.decision.reason === '搜索提议改选，消融臂强制保持专家首选',
  '消融臂强制保持专家首选，并记录“本会改选”的反事实标记');
  assert(forced.telemetry.wouldChangeDecision === (normal.telemetry.changedDecision === true),
  'wouldChangeDecision 与正常臂 changedDecision 互为反事实口径');
  assert(forced.decision.cards === consultation.cards
    && forced.decision.hand === consultation.hand
    && forced.decision.signature === consultation.signature,
  'forceExpertChoice 逐对象保留专家动作、牌型声明与签名，不经候选重建');
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
    && result.telemetry?.reason === 'not_critical' && !result.telemetry?.applied
    && result.telemetry?.searchAttempted === false
    && result.telemetry?.searchTriggered === false
    && result.telemetry?.fallbackKind === 'search_evidence_insufficient',
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
