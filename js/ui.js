/**
 * 掼蛋 UI
 */

import {
  createMatch, startMatch, nextRound, humanPlay, humanPass, humanSelectToggle,
  humanClearSelect, humanPickReturnCard, humanConfirmReturn, setUpdateCallback,
  getLegalHints, getHandAnalysis, getReturnCandidates, PHASE, seatName,
  applySettings, refreshCoach, getSkillStats, humanSelectSet, humanSelectAllOfRank,
  humanSelectRankCycle, getSelectedCards, getCombosFromSelection, restoreMatch,
  resumeMatch, persistMatch, AI_DIFFICULTY_LABEL,
} from './game.js';
import {
  SUIT_SYMBOL, SUIT_COLOR, RANK_LABEL, isJoker, isWild, isLevelCard,
  cardLabel, LEVEL_LABEL,
} from './cards.js';
import {
  formatHand, parseHand, parseHandVariants, isLegalPlay, handSignature,
} from './rules.js';
import {
  loadReplays, clearStats, loadSettings, exportTrainingData, importTrainingData,
} from './stats.js';

const restoredState = restoreMatch();
const state = restoredState || createMatch();
const $ = (sel) => document.querySelector(sel);

/** 用于 shift 连选 */
let lastClickedId = null;

function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}

function rankKeyOf(card, level) {
  if (isWild(card, level)) return 'wild';
  if (card.rank === 16) return 'joker16';
  if (card.rank === 17) return 'joker17';
  return String(card.rank);
}

function rankHeadLabel(key, level) {
  if (key === 'wild') return `逢人配×`;
  if (key === 'joker16') return '小王×';
  if (key === 'joker17') return '大王×';
  if (Number(key) === level) return `级${RANK_LABEL[key] || key}×`;
  return `${RANK_LABEL[key] || key}×`;
}

function renderCard(card, opts = {}) {
  const {
    mini = false, selectable = false, selected = false, level = 2, back = false,
    dimmed = false, suggested = false, copyIndex = 0, totalCopies = 1,
  } = opts;
  const div = el(selectable ? 'button' : 'div', 'card');
  if (mini) div.classList.add('mini');
  if (back) {
    div.classList.add('back');
    return div;
  }
  if (isJoker(card)) {
    div.classList.add('joker');
    div.innerHTML = `<div class="rank">${card.rank === 17 ? '大' : '小'}</div><div class="suit">🃏</div>`;
  } else {
    const color = SUIT_COLOR[card.suit] || 'black';
    div.classList.add(color);
    div.innerHTML = `
      <div class="rank">${RANK_LABEL[card.rank]}</div>
      <div class="suit">${SUIT_SYMBOL[card.suit]}</div>
      <div class="corner-suit">${SUIT_SYMBOL[card.suit]}</div>
    `;
  }
  if (isWild(card, level)) div.classList.add('wild');
  else if (isLevelCard(card, level)) div.classList.add('level-mark');
  if (selectable) {
    div.type = 'button';
    div.classList.add('selectable');
    if (selected) div.classList.add('selected');
    div.dataset.id = card.id;
    div.dataset.focusKey = `card:${card.id}`;
    div.setAttribute(
      'aria-label',
      `${cardLabel(card)}${isWild(card, level) ? '，逢人配' : ''}${totalCopies > 1 ? `，第 ${copyIndex + 1} 张，共 ${totalCopies} 张` : ''}`,
    );
    div.setAttribute('aria-pressed', selected ? 'true' : 'false');
  }
  if (dimmed) div.classList.add('dimmed');
  if (suggested) div.classList.add('suggested');
  return div;
}

function lastPlayFor(seat) {
  const start = Number.isInteger(state.currentTrickStartIndex) ? state.currentTrickStartIndex : 0;
  for (let i = state.trickLog.length - 1; i >= start; i--) {
    const t = state.trickLog[i];
    if (t.seat === seat) return t;
  }
  return null;
}

/** 当前圈最后一手有效出牌（非过） */
function lastRealPlay() {
  for (let i = state.trickLog.length - 1; i >= 0; i--) {
    const t = state.trickLog[i];
    if (t.action === 'play' && t.cards?.length) return t;
  }
  return null;
}

function finishLabel(seat) {
  const idx = state.finishOrder.indexOf(seat);
  if (idx < 0) return '';
  return ['头游', '二游', '三游', '末游'][idx];
}

function render() {
  const active = document.activeElement;
  const focusKey = active?.dataset?.focusKey || (active?.id ? `id:${active.id}` : null);
  renderTop();
  renderSeats();
  renderCenter();
  renderSpotlight();
  renderPlayerHand();
  renderSelectionBar();
  renderActions();
  renderEndHands();
  renderLog();
  renderEval();
  renderCoach();
  renderStructure();
  if (focusKey) {
    queueMicrotask(() => {
      const next = focusKey.startsWith('id:')
        ? document.getElementById(focusKey.slice(3))
        : document.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`);
      if (next && !next.disabled) next.focus({ preventScroll: true });
    });
  }
}

/** 每副结束后自动翻开所有未出完 AI 玩家的余牌。 */
function renderEndHands() {
  const box = $('#endHands');
  if (!box) return;
  box.innerHTML = '';

  if (![PHASE.ROUND_END, PHASE.MATCH_END].includes(state.phase)) {
    box.classList.add('hidden');
    return;
  }

  const remainingSeats = [1, 2, 3].filter((seat) => (state.hands[seat] || []).length > 0);
  if (!remainingSeats.length) {
    box.classList.add('hidden');
    return;
  }

  box.classList.remove('hidden');
  box.appendChild(el('h3', '', '终局自动亮牌'));
  box.appendChild(el('p', 'end-hands-note', '未出完玩家的剩余手牌，可结合牌局日志检查其出牌路线。'));

  for (const seat of remainingSeats) {
    const group = el('div', 'end-hand-group');
    const hand = state.hands[seat] || [];
    group.appendChild(el(
      'div',
      'end-hand-title',
      `${escapeHtml(seatName(seat))} · ${escapeHtml(finishLabel(seat) || '未出完')} · 剩余 ${hand.length} 张`,
    ));
    const cards = el('div', 'end-hand-cards');
    for (const card of hand) {
      cards.appendChild(renderCard(card, { mini: true, level: state.currentLevel }));
    }
    group.appendChild(cards);
    box.appendChild(group);
  }
}

function renderTop() {
  const cur = LEVEL_LABEL[state.currentLevel] || state.currentLevel;
  $('#levelMine').textContent = LEVEL_LABEL[state.levels[0]];
  $('#levelOpp').textContent = LEVEL_LABEL[state.levels[1]];
  $('#currentLevel').textContent = `当前打 ${cur}`;
  $('#roundNum').textContent = state.round ? `第 ${state.round} 副` : '未开始';

  const s = state.settings || loadSettings();
  const d = $('#selDifficulty');
  const sp = $('#selSpeed');
  const c = $('#chkCoach');
  const large = $('#chkLargeText');
  const reduced = $('#chkReducedMotion');
  if (d && d.value !== s.difficulty) d.value = s.difficulty || 'normal';
  if (sp && sp.value !== s.aiSpeed) sp.value = s.aiSpeed || 'normal';
  if (c && c.checked !== !!s.coachMode) c.checked = !!s.coachMode;
  if (large && large.checked !== !!s.largeText) large.checked = !!s.largeText;
  if (reduced && reduced.checked !== !!s.reducedMotion) reduced.checked = !!s.reducedMotion;
  document.body.classList.toggle('large-text', !!s.largeText);
  document.body.classList.toggle('reduced-motion', !!s.reducedMotion);
}

function renderSeats() {
  const map = [
    { seat: 0, root: '#seatSouth', name: '你', role: '我方', avatar: 'human' },
    { seat: 1, root: '#seatEast', name: '下家', role: '对方', avatar: '' },
    { seat: 2, root: '#seatNorth', name: '对家', role: '队友', avatar: 'partner' },
    { seat: 3, root: '#seatWest', name: '上家', role: '对方', avatar: '' },
  ];

  for (const m of map) {
    const root = $(m.root);
    if (!root) continue;
    const active = state.phase === PHASE.PLAYING && state.currentSeat === m.seat;
    const finished = state.finishOrder.includes(m.seat);
    const info = root.querySelector('.seat-info');
    info.className = 'seat-info'
      + (active ? ' active' : '')
      + (finished ? ' finished' : '');
    info.querySelector('.name').textContent = m.name;
    info.querySelector('.role').textContent = finished ? finishLabel(m.seat) : m.role;
    info.querySelector('.count').textContent = `${state.handCounts[m.seat] ?? 0}张`;

    const av = info.querySelector('.avatar');
    av.className = 'avatar' + (m.avatar ? ` ${m.avatar}` : '');
    av.textContent = m.name[0];

    const played = root.querySelector('.played-area');
    played.innerHTML = '';
    const lp = lastPlayFor(m.seat);
    if (lp) {
      if (lp.action === 'pass') {
        played.appendChild(el('span', '', '<span style="color:#9bb5a8;font-size:0.85rem">过</span>'));
      } else if (lp.cards) {
        for (const card of lp.cards) {
          played.appendChild(renderCard(card, { mini: true, level: state.currentLevel }));
        }
      }
    }

    if (m.seat !== 0) {
      const backs = root.querySelector('.opp-backs');
      if (backs) {
        backs.innerHTML = '';
        const n = Math.min(state.handCounts[m.seat] || 0, 16);
        for (let i = 0; i < n; i++) {
          backs.appendChild(renderCard(null, { back: true, mini: true }));
        }
      }
    }
  }
}

function renderSpotlight() {
  const box = $('#trickSpotlight');
  if (!box) return;
  box.innerHTML = '';
  const play = lastRealPlay();
  if (!play || !state.lastHand) return;
  // 若当前领出清空了 lastHand，spotlight 可不显示
  if (state.phase !== PHASE.PLAYING && state.phase !== PHASE.ROUND_END) return;

  const label = el('div', 'spot-label', `${seatName(play.seat)} · ${formatHand(play.hand)}`);
  box.appendChild(label);
  for (const card of play.cards) {
    box.appendChild(renderCard(card, { mini: true, level: state.currentLevel }));
  }
}

function renderCenter() {
  const phaseMap = {
    [PHASE.IDLE]: '点击开始游戏',
    [PHASE.DEALING]: '发牌中…',
    [PHASE.TRIBUTE]: '进贡阶段',
    [PHASE.RETURN]: '还贡阶段 — 选一张牌后点「确认还贡」',
    [PHASE.PLAYING]: state.currentSeat === 0 ? '轮到你出牌' : `等待 ${seatName(state.currentSeat)}…`,
    [PHASE.ROUND_END]: '本副结束',
    [PHASE.MATCH_END]: '比赛结束',
  };
  $('#phaseText').textContent = phaseMap[state.phase] || state.phase;
  if (state.lastHand) {
    $('#lastText').textContent = `需压：${formatHand(state.lastHand)}（${seatName(state.lastSeat)}）`;
  } else if (state.phase === PHASE.PLAYING) {
    $('#lastText').textContent = '自由领出任意牌型';
  } else if (state.phase === PHASE.RETURN) {
    $('#lastText').textContent = '点选手牌预览，确认后再交出';
  } else {
    $('#lastText').textContent = '';
  }
}

function canSelectCards() {
  return (state.phase === PHASE.PLAYING && state.currentSeat === 0 && !state.finishOrder.includes(0))
    || (state.phase === PHASE.RETURN && getReturnCandidates(state).length > 0);
}

function groupHand(hand, level) {
  const order = [];
  const map = new Map();
  // 展示顺序：与手牌排序一致（大→小），按首次出现的 key 分组
  for (const c of hand) {
    const k = rankKeyOf(c, level);
    if (!map.has(k)) {
      map.set(k, []);
      order.push(k);
    }
    map.get(k).push(c);
  }
  return order.map((k) => ({ key: k, cards: map.get(k) }));
}

function onCardClick(card, e) {
  if (!canSelectCards()) return;
  if (e.detail > 1) return;

  if (state.phase === PHASE.RETURN) {
    humanPickReturnCard(state, card.id);
    lastClickedId = card.id;
    render();
    return;
  }

  // Shift+点击：从上次点到本次的区间选中
  if (e.shiftKey && lastClickedId) {
    const hand = state.hands[0] || [];
    const i0 = hand.findIndex((c) => c.id === lastClickedId);
    const i1 = hand.findIndex((c) => c.id === card.id);
    if (i0 >= 0 && i1 >= 0) {
      const [a, b] = i0 < i1 ? [i0, i1] : [i1, i0];
      const next = new Set(state.selectedIds);
      for (let i = a; i <= b; i++) next.add(hand[i].id);
      humanSelectSet(state, [...next]);
      render();
      return;
    }
  }

  humanSelectToggle(state, card.id);
  lastClickedId = card.id;
  render();
}

function renderPlayerHand() {
  const board = $('#playerHand');
  if (!board) return;
  board.innerHTML = '';

  const hand = state.hands[0] || [];
  const level = state.currentLevel;
  const selectable = canSelectCards();
  const returnIds = state.phase === PHASE.RETURN
    ? new Set(getReturnCandidates(state).map((c) => c.id))
    : null;
  const groups = groupHand(hand, level);
  const selected = state.selectedIds;

  // 有选中时未选中的牌略微变暗，突出选中
  const hasSel = selected.size > 0;

  for (const g of groups) {
    const wrap = el('div', 'rank-group');
    const selCount = g.cards.filter((c) => selected.has(c.id)).length;
    const head = el('button', 'rank-head' + (selCount ? ' has-sel' : ''),
      `${rankHeadLabel(g.key, level)}${g.cards.length}${selCount ? ` ·已选${selCount}` : ''}`);
    head.title = '循环选择张数';
    head.type = 'button';
    head.dataset.focusKey = `rank:${g.key}`;
    if (selectable && state.phase !== PHASE.RETURN) {
      head.onclick = (e) => {
        e.preventDefault();
        humanSelectRankCycle(state, g.key);
        render();
      };
    } else {
      head.disabled = true;
      head.style.opacity = '0.6';
      head.style.cursor = 'default';
    }

    const headRow = el('div', 'rank-head-row');
    headRow.appendChild(head);
    if (state.phase !== PHASE.RETURN) {
      const allBtn = el('button', 'rank-all', selCount === g.cards.length ? '取消全选' : '全选');
      allBtn.type = 'button';
      allBtn.dataset.focusKey = `rank-all:${g.key}`;
      allBtn.setAttribute('aria-label', `${rankHeadLabel(g.key, level).replace('×', '')}全部选择或取消`);
      allBtn.disabled = !selectable;
      allBtn.onclick = () => {
        humanSelectAllOfRank(state, g.key);
        render();
      };
      headRow.appendChild(allBtn);
    }

    const row = el('div', 'rank-cards');
    for (let cardIndex = 0; cardIndex < g.cards.length; cardIndex++) {
      const card = g.cards[cardIndex];
      const isSel = selected.has(card.id);
      const cardSelectable = selectable && (!returnIds || returnIds.has(card.id));
      const cardEl = renderCard(card, {
        selectable: cardSelectable,
        selected: isSel,
        level,
        copyIndex: cardIndex,
        totalCopies: g.cards.length,
        dimmed: (hasSel && !isSel && selectable) || (returnIds && !returnIds.has(card.id)),
      });
      if (cardSelectable) {
        cardEl.addEventListener('click', (e) => onCardClick(card, e));
      }
      row.appendChild(cardEl);
    }
    wrap.appendChild(headRow);
    wrap.appendChild(row);
    board.appendChild(wrap);
  }

  if (!hand.length && state.phase !== PHASE.IDLE) {
    board.appendChild(el('div', 'sel-status', '手牌已出完'));
  }
}

function renderSelectionBar() {
  const status = $('#selStatus');
  const preview = $('#selPreview');
  const declarationChips = $('#declarationChips');
  const chips = $('#comboChips');
  if (!status || !preview || !declarationChips || !chips) return;

  preview.innerHTML = '';
  declarationChips.innerHTML = '';
  chips.innerHTML = '';

  if (state.phase === PHASE.RETURN && getReturnCandidates(state).length) {
    const picked = getSelectedCards(state);
    status.className = 'sel-status warn';
    if (picked.length === 1) {
      const c = picked[0];
      status.textContent = '已预选合规还贡牌，请点「确认还贡」交出';
      preview.appendChild(renderCard(c, { mini: true, level: state.currentLevel, selected: true }));
      preview.appendChild(el('span', 'tag', cardLabel(c)));
    } else {
      status.textContent = '还贡：可选牌已高亮；有不大于 10 的非级牌时必须从中选择';
    }
    return;
  }

  if (!(state.phase === PHASE.PLAYING && state.currentSeat === 0)) {
    status.className = 'sel-status';
    status.textContent = '点击手牌选牌 · 点“全选”选择同点牌 · 点数标题循环张数 · Shift+点击连选';
    return;
  }

  const selected = getSelectedCards(state);
  if (!selected.length) {
    status.className = 'sel-status';
    status.textContent = '未选牌 — 点选组合后点「出牌」；下方可点推荐牌型一键选中';
    // 显示若干领出/接牌推荐
    renderComboChips(getCombosFromSelection(state).slice(0, 10));
    return;
  }

  // 识别牌型
  const legal = isLegalPlay(
    selected,
    state.currentLevel,
    state.lastHand,
    state.selectedDeclaration,
  );
  const parsed = legal.ok ? legal.hand : parseHand(selected, state.currentLevel);
  renderDeclarationChips(selected, legal, parsed);

  for (const c of selected) {
    preview.appendChild(renderCard(c, { mini: true, level: state.currentLevel, selected: true }));
  }

  if (legal.ok && parsed) {
    status.className = 'sel-status ok';
    status.textContent = `已选 ${selected.length} 张 · 合法牌型：${formatHand(parsed)} — 可点「出牌」`;
    preview.appendChild(el('span', 'tag', formatHand(parsed)));
  } else if (parsed && !legal.ok) {
    status.className = 'sel-status bad';
    status.textContent = `识别为 ${formatHand(parsed)}，但无法压上家：${legal.reason || ''}`;
    preview.appendChild(el('span', 'tag bad', legal.reason || '压不过'));
  } else {
    status.className = 'sel-status warn';
    status.textContent = `已选 ${selected.length} 张，尚未组成合法牌型 — 可继续点选，或点下方「凑牌」推荐`;
    preview.appendChild(el('span', 'tag bad', '非合法牌型'));
  }

  // 基于选中的凑牌推荐
  renderComboChips(getCombosFromSelection(state));
}

/** 允许玩家为同一组实体牌明确指定逢人配点数或牌型解释。 */
function renderDeclarationChips(selected, legal, parsed) {
  const wrap = $('#declarationChips');
  if (!wrap) return;
  wrap.innerHTML = '';

  const allVariants = parseHandVariants(selected, state.currentLevel);
  const flushKeys = new Set(allVariants
    .filter((hand) => hand.type === 'flush_straight')
    .map((hand) => `${hand.mainRank}|${(hand.meta?.sequence || []).join('-')}`));
  const variants = allVariants.filter((hand) => (
    hand.type !== 'straight'
    || !flushKeys.has(`${hand.mainRank}|${(hand.meta?.sequence || []).join('-')}`)
  ));
  if (!variants.length) return;

  const title = el('span', 'sel-status', variants.length > 1 ? '自定义牌型：' : '当前牌型：');
  wrap.appendChild(title);

  if (variants.length > 1) {
    const auto = el('button', `declaration-chip${state.selectedDeclaration ? '' : ' active'}`, '自动判定');
    auto.type = 'button';
    auto.title = '由系统选择能合法出牌的最小牌型解释';
    auto.onclick = () => {
      humanSelectSet(state, selected.map((c) => c.id));
      render();
    };
    wrap.appendChild(auto);
  }

  const effectiveSignature = state.selectedDeclaration
    || handSignature(legal.ok ? legal.hand : parsed);
  for (const variant of variants) {
    const signature = handSignature(variant);
    const canPlay = isLegalPlay(
      selected,
      state.currentLevel,
      state.lastHand,
      signature,
    ).ok;
    const chip = el(
      'button',
      `declaration-chip${signature === effectiveSignature ? ' active' : ''}${canPlay ? '' : ' unavailable'}`,
      formatHand(variant),
    );
    chip.type = 'button';
    chip.title = canPlay ? `指定为 ${formatHand(variant)}` : `当前不能以 ${formatHand(variant)} 出牌`;
    chip.setAttribute('aria-pressed', String(signature === effectiveSignature));
    chip.onclick = () => {
      humanSelectSet(state, selected.map((c) => c.id), signature);
      render();
    };
    wrap.appendChild(chip);
  }
}

function renderComboChips(combos) {
  const chips = $('#comboChips');
  if (!chips) return;
  chips.innerHTML = '';
  if (!combos?.length) return;

  const title = el('span', 'sel-status', '可选牌型：');
  title.style.marginRight = '4px';
  chips.appendChild(title);

  for (const p of combos) {
    const label = `${p.exact ? '✓ ' : ''}${formatHand(p.hand)} · ${p.cards.map(cardLabel).join('')}`;
    const chip = el('button', 'combo-chip' + (p.exact ? ' exact' : ''), label);
    chip.type = 'button';
    chip.dataset.focusKey = `combo:${p.signature || handSignature(p.hand)}:${p.cards.map((c) => c.id).sort().join('.')}`;
    chip.title = p.cards.map(cardLabel).join(' ');
    chip.onclick = () => {
      humanSelectSet(
        state,
        p.cards.map((c) => c.id),
        p.signature || handSignature(p.hand),
        'combo',
      );
      render();
    };
    chips.appendChild(chip);
  }
}

function renderActions() {
  const bar = $('#actionBar');
  const hintBar = $('#hintBar');
  bar.innerHTML = '';
  hintBar.innerHTML = '';

  // 还贡确认条
  if (state.phase === PHASE.RETURN && getReturnCandidates(state).length) {
    const banner = el('div', 'return-banner');
    const picked = getSelectedCards(state);
    banner.innerHTML = picked.length === 1
      ? `还贡预览：<span class="picked">${escapeHtml(cardLabel(picked[0]))}</span> → 进贡方`
      : '请从高亮的合规牌中选择一张还贡';
    bar.appendChild(banner);

    const confirmBtn = el('button', 'accent', '确认还贡');
    confirmBtn.dataset.focusKey = 'action:return-confirm';
    confirmBtn.disabled = picked.length !== 1;
    confirmBtn.onclick = () => {
      const r = humanConfirmReturn(state);
      if (!r.ok) flash(r.reason);
      render();
    };
    const clearBtn = el('button', 'secondary', '重选');
    clearBtn.dataset.focusKey = 'action:return-clear';
    clearBtn.onclick = () => {
      humanClearSelect(state);
      render();
    };
    bar.append(confirmBtn, clearBtn);
    return;
  }

  if (state.phase === PHASE.IDLE) {
    const b = el('button', '', '开始游戏');
    b.dataset.focusKey = 'action:start';
    b.onclick = () => {
      startMatch(state);
      render();
    };
    bar.appendChild(b);
    return;
  }

  if (state.phase === PHASE.ROUND_END || state.phase === PHASE.MATCH_END) {
    const b = el('button', 'accent', state.phase === PHASE.MATCH_END ? '再来一局' : '下一副');
    b.dataset.focusKey = 'action:next';
    b.onclick = () => {
      nextRound(state);
      render();
    };
    bar.appendChild(b);
    const rb = el('button', 'secondary', '查看本副复盘');
    rb.dataset.focusKey = 'action:replay';
    rb.onclick = () => openReplay(state.lastReplay?.id);
    bar.appendChild(rb);
    return;
  }

  if (state.phase === PHASE.PLAYING && state.currentSeat === 0 && !state.finishOrder.includes(0)) {
    const selected = getSelectedCards(state);
    const legal = selected.length
      ? isLegalPlay(selected, state.currentLevel, state.lastHand, state.selectedDeclaration)
      : { ok: false };

    const playBtn = el('button', 'accent', legal.ok ? `出牌（${formatHand(legal.hand)}）` : '出牌');
    playBtn.dataset.focusKey = 'action:play';
    playBtn.disabled = !legal.ok;
    playBtn.onclick = doPlay;

    const passBtn = el('button', 'secondary', '过牌');
    passBtn.dataset.focusKey = 'action:pass';
    passBtn.disabled = !state.lastHand;
    passBtn.onclick = doPass;

    const clearBtn = el('button', 'secondary', '取消选择');
    clearBtn.dataset.focusKey = 'action:clear';
    clearBtn.onclick = () => {
      humanClearSelect(state);
      render();
    };

    const hintBtn = el('button', 'secondary', '提示');
    hintBtn.dataset.focusKey = 'action:hint';
    hintBtn.onclick = () => showHints();

    const tipBtn = el('button', 'secondary', '牌面分析');
    tipBtn.dataset.focusKey = 'action:analysis';
    tipBtn.onclick = () => {
      const tips = getHandAnalysis(state);
      flash(tips.join(' '));
      const box = $('#structTips');
      if (box) box.innerHTML = tips.map((t) => `<li>${escapeHtml(t)}</li>`).join('');
    };

    const coachBtn = el('button', 'secondary', '教练建议');
    coachBtn.dataset.focusKey = 'action:coach';
    coachBtn.onclick = () => {
      const tip = refreshCoach(state, false);
      if (tip) flash(tip.text);
      render();
    };

    bar.append(playBtn, passBtn, clearBtn, hintBtn, tipBtn, coachBtn);
  }
}

function doPlay() {
  const r = humanPlay(state);
  if (!r.ok) flash(r.reason);
  render();
}

function doPass() {
  const r = humanPass(state);
  if (!r.ok) flash(r.reason);
  render();
}

function showHints() {
  const hints = getLegalHints(state);
  const bar = $('#hintBar');
  bar.innerHTML = '';
  if (!hints.length) {
    bar.appendChild(el('span', 'hint-chip', state.lastHand ? '无可接牌，请过牌' : '无提示'));
    return;
  }
  // 同步到 combo chips 区更醒目
  renderComboChips(hints.map((h) => ({ ...h, exact: false })));
  hints.forEach((h) => {
    const chip = el('button', 'hint-chip', `${formatHand(h.hand)} · ${h.cards.map(cardLabel).join(' ')}`);
    chip.onclick = () => {
      humanSelectSet(
        state,
        h.cards.map((c) => c.id),
        h.signature || handSignature(h.hand),
        'hint',
      );
      render();
    };
    bar.appendChild(chip);
  });
}

function renderLog() {
  const box = $('#logBox');
  box.innerHTML = '';
  const msgs = state.messages.slice(-40);
  for (const m of msgs) {
    box.appendChild(el('div', 'item', escapeHtml(m.text)));
  }
  box.scrollTop = box.scrollHeight;
}

function renderCoach() {
  const box = $('#coachBox');
  if (!box) return;
  const tip = state.coachTip;
  const show = tip && state.phase === PHASE.PLAYING && state.currentSeat === 0;
  if (!show) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  box.classList.remove('hidden');
  box.innerHTML = '';
  box.appendChild(document.createTextNode(tip.text));
  if (tip.projectedTricks != null) {
    box.appendChild(document.createTextNode(` 预计剩余约 ${tip.projectedTricks} 手。`));
  }
  if (tip.action === 'play' && tip.cards) {
    const btn = el('button', 'accent', '采用此建议');
    btn.onclick = () => {
      humanSelectSet(
        state,
        tip.cards.map((c) => c.id),
        tip.signature || handSignature(tip.hand),
        'coach_apply',
      );
      render();
    };
    box.appendChild(document.createElement('br'));
    box.appendChild(btn);
  }
}

function renderEval() {
  const scoreEl = $('#evalScore');
  const gradeEl = $('#evalGrade');
  const starsEl = $('#evalStars');
  const tipsEl = $('#evalTips');
  const altEl = $('#evalAlt');
  const summaryEl = $('#evalSummary');
  const statsEl = $('#sessionStats');

  const ev = state.lastEval;
  if (!ev) {
    scoreEl.textContent = '--';
    scoreEl.style.color = '#9bb5a8';
    gradeEl.textContent = '出牌后显示评价';
    starsEl.textContent = '';
    summaryEl.textContent = '系统会从配合、留炸、逢人配、拆牌等维度打分并给建议';
    tipsEl.innerHTML = `
      <li>手牌在桌面下方，对家出牌不会被挡住</li>
      <li>点点数标题循环张数；“全选”按钮选择同点牌</li>
      <li>选中后会显示牌型识别与凑牌推荐</li>
    `;
    altEl.classList.add('hidden');
  } else {
    scoreEl.textContent = ev.score;
    scoreEl.style.color = ev.color || '#e8c36a';
    gradeEl.innerHTML = `${escapeHtml(ev.grade)}${ev.assisted ? '<span class="assist-badge">使用辅助</span>' : ''}${ev.forced ? '<span class="assist-badge">被迫操作</span>' : ''}`;
    starsEl.textContent = '★'.repeat(ev.stars) + '☆'.repeat(5 - ev.stars);
    const dimensions = Object.values(ev.dimensions || {});
    summaryEl.innerHTML = `<div>${escapeHtml(ev.summary || '')}</div>${dimensions.length ? `<div class="dimension-grid">${dimensions.map((d) => `<div class="dimension">${escapeHtml(d.label)}<b>${d.score}</b></div>`).join('')}</div>` : ''}`;
    tipsEl.innerHTML = ev.tips.map((t) => {
      const warn = /浪费|拆|压了|错失|不必|无需|不要|不足|失误/.test(t);
      return `<li class="${warn ? 'warn' : ''}">${escapeHtml(t)}</li>`;
    }).join('');
    if (ev.betterAlternative) {
      altEl.classList.remove('hidden');
      altEl.textContent = `更优参考：${ev.betterAlternative.cards.map(cardLabel).join(' ')}（${ev.betterAlternative.label}）`;
    } else {
      altEl.classList.add('hidden');
    }
  }

  const hist = state.evalHistory || [];
  if (hist.length) {
    const avg = Math.round(hist.reduce((s, h) => s + h.score, 0) / hist.length);
    const clean = hist.filter((h) => !h.assisted && !h.forced);
    const cleanAvg = clean.length
      ? Math.round(clean.reduce((sum, h) => sum + h.score, 0) / clean.length)
      : null;
    statsEl.innerHTML = `
      <div class="stat"><b>${hist.length}</b>本副评价次数</div>
      <div class="stat"><b style="color:${avg >= 70 ? '#6bcb77' : '#e8c36a'}">${avg}</b>综合均分</div>
      <div class="stat"><b>${cleanAvg ?? '--'}</b>无辅助均分</div>
      <div class="stat"><b>${hist.filter((h) => h.assisted).length}</b>辅助决策</div>
    `;
  } else if (state.roundSummary) {
    const s = state.roundSummary;
    statsEl.innerHTML = `
      <div class="stat"><b>${s.count}</b>本副操作</div>
      <div class="stat"><b>${s.avg}</b>平均分</div>
    `;
  } else {
    statsEl.innerHTML = '';
  }

  const endTips = $('#endAdvice');
  if (state.phase === PHASE.ROUND_END || state.phase === PHASE.MATCH_END) {
    const s = state.roundSummary;
    if (s) {
      endTips.innerHTML = `<h2>本副复盘</h2><ul class="eval-tips">${
        s.advice.map((a) => `<li>${escapeHtml(a)}</li>`).join('')
      }</ul>`;
      endTips.classList.remove('hidden');
    }
  } else {
    endTips.classList.add('hidden');
  }
}

function renderStructure() {
  const box = $('#structTips');
  if (!box) return;
  if (state.phase === PHASE.IDLE) {
    box.innerHTML = '<li>开始游戏后自动分析当前手牌</li>';
    return;
  }
  const tips = getHandAnalysis(state);
  box.innerHTML = tips.map((tip) => `<li>${escapeHtml(tip)}</li>`).join('');
}

function flash(msg) {
  const t = $('#toast');
  const inner = t.querySelector('div') || t;
  inner.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(flash._t);
  flash._t = setTimeout(() => t.classList.add('hidden'), 2200);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function openStats() {
  const s = getSkillStats();
  const places = ['头游', '二游', '三游', '末游'];
  const mistakeLabels = {
    waste_wild: '逢人配使用不当',
    waste_bomb: '炸弹时机不佳',
    split_bomb: '拆散炸弹',
    over_teammate: '误压队友',
    missed_finish: '错失一手出完',
  };
  const body = $('#statsBody');
  const recent = (s.scoreTrend || []).slice(-8).reverse();
  body.innerHTML = `
    <div class="stats-grid">
      <div class="cell">累计副数<b>${s.totalRounds}</b></div>
      <div class="cell">综合均分<b>${s.avg || '--'}</b></div>
      <div class="cell">无辅助均分<b>${s.unassistedAvg || '--'}</b></div>
      <div class="cell">辅助/被迫<b>${s.assistedEvalCount || 0} / ${s.forcedEvalCount || 0}</b></div>
      <div class="cell">头游次数<b>${s.winsAsHead}</b></div>
      <div class="cell">队伍胜/负<b>${s.teamWins} / ${s.teamLosses}</b></div>
      <div class="cell">过 A 胜场<b>${s.matchWins}</b></div>
      <div class="cell">评价次数<b>${s.evalCount}</b></div>
    </div>
    <h4>名次分布</h4>
    <ul>${places.map((p, i) => `<li>${p}：${s.finishes[i] || 0} 次</li>`).join('')}</ul>
    <h4>评分等级</h4>
    <ul>${Object.entries(s.gradeCounts || {}).map(([k, v]) => `<li>${k}：${v}</li>`).join('')}</ul>
    <h4>常见问题</h4>
    <ul>${Object.entries(s.mistakeCounts || {}).length
    ? Object.entries(s.mistakeCounts).sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([k, v]) => `<li>${escapeHtml(mistakeLabels[k] || k)}：${v} 次</li>`).join('')
    : '<li>暂无明确失误记录</li>'}</ul>
    <h4>最近趋势</h4>
    <ul>${recent.length ? recent.map((item) => `<li>${new Date(item.time).toLocaleString('zh-CN')} · ${escapeHtml(AI_DIFFICULTY_LABEL[item.difficulty] || item.difficulty)} · 综合 ${item.avg || '--'} · 无辅助 ${item.unassistedAvg ?? '--'}</li>`).join('') : '<li>暂无趋势数据</li>'}</ul>
    <p style="margin-top:12px;font-size:0.8rem;color:var(--muted)">数据仅保存在本机浏览器，可使用“导出数据”备份。</p>
  `;
  openModal('#statsModal', $('#btnStats'));
}

function openReplay(preferId) {
  const list = loadReplays();
  const tabs = $('#replayList');
  const body = $('#replayBody');
  tabs.innerHTML = '';
  body.innerHTML = '';

  if (!list.length) {
    body.innerHTML = '<p>暂无复盘记录。打完一副后会自动保存。</p>';
    openModal('#replayModal', $('#btnReplay'));
    return;
  }

  let activeId = preferId && list.some((r) => r.id === preferId) ? preferId : list[0].id;
  let activeStep = 0;

  const renderReplay = () => {
    const r = list.find((x) => x.id === activeId);
    if (!r) return;
    const lines = r.trickLog || [];
    activeStep = Math.max(0, Math.min(activeStep, Math.max(lines.length - 1, 0)));
    const current = lines[activeStep] || null;
    const placeNames = ['头', '二', '三', '末'];
    const fo = (r.finishOrder || []).map((s, i) => `${placeNames[i]}游 ${['你', '下家', '对家', '上家'][s]}`).join(' · ');
    let html = `
      <p><strong>第 ${r.round} 副</strong> · 打 ${LEVEL_LABEL[r.level] || r.level}
      · 难度 ${escapeHtml(AI_DIFFICULTY_LABEL[r.difficulty] || r.difficulty || '-') } · 升 ${r.up} 级
      · ${r.winTeam === 0 ? '我方' : '对方'}胜</p>
      <p>${new Date(r.endedAt || r.time).toLocaleString('zh-CN')}</p>
      <p>${escapeHtml(fo)}</p>
    `;
    if (r.roundSummary) {
      html += `<p>本副均分 <strong>${r.roundSummary.avg}</strong>（${r.roundSummary.count} 次操作）</p>`;
      if (r.roundSummary.advice?.length) {
        html += `<ul>${r.roundSummary.advice.map((a) => `<li>${escapeHtml(a)}</li>`).join('')}</ul>`;
      }
    }
    html += `<div class="replay-stepper">
      <button type="button" class="secondary" id="replayPrev" ${activeStep <= 0 ? 'disabled' : ''}>上一手</button>
      <span>第 ${lines.length ? activeStep + 1 : 0} / ${lines.length} 手</span>
      <button type="button" class="secondary" id="replayNext" ${activeStep >= lines.length - 1 ? 'disabled' : ''}>下一手</button>
    </div>`;
    if (current) {
      const ev = current.evaluation;
      html += `<div class="replay-current">
        <strong>第 ${current.trickNumber || '-'} 圈 · ${escapeHtml(current.text)}</strong>
        ${current.countsAfter ? `<p>剩余张数：你 ${current.countsAfter[0]} / 下家 ${current.countsAfter[1]} / 对家 ${current.countsAfter[2]} / 上家 ${current.countsAfter[3]}</p>` : ''}
        ${current.decisionMeta?.reason ? `<p>AI 思路：${escapeHtml(current.decisionMeta.reason)}</p>` : ''}
        ${ev ? `<p>你的评价：<strong>${ev.score} · ${escapeHtml(ev.grade)}</strong>${ev.assisted ? '<span class="assist-badge">使用辅助</span>' : ''}${ev.forced ? '<span class="assist-badge">被迫操作</span>' : ''}</p>
          <ul>${(ev.tips || []).map((tip) => `<li>${escapeHtml(tip)}</li>`).join('')}</ul>` : ''}
      </div>`;
    }
    if (r.initialHands?.length) {
      html += `<details><summary>查看本副初始牌面</summary>${r.initialHands.map((hand, seat) => `<p><strong>${['你', '下家', '对家', '上家'][seat]}：</strong>${hand.map(cardLabel).join(' ')}</p>`).join('')}</details>`;
    }
    const remainingAIHands = (r.remainingHands || [])
      .map((hand, seat) => ({ hand: hand || [], seat }))
      .filter(({ hand, seat }) => seat !== 0 && hand.length > 0);
    if (remainingAIHands.length) {
      html += `<details open><summary>终局余牌（自动亮牌）</summary>${remainingAIHands.map(({ hand, seat }) => `<p><strong>${['你', '下家', '对家', '上家'][seat]}：</strong>${hand.map(cardLabel).join(' ')}（${hand.length} 张）</p>`).join('')}</details>`;
    }
    html += `<h4>逐手时间线</h4><div class="replay-timeline">${lines.map((line, index) => `<button type="button" class="replay-line-button${line.seat === 0 ? ' me' : ''}${index === activeStep ? ' active' : ''}" data-step="${index}">${escapeHtml(line.text)}${line.evaluation ? ` · ${line.evaluation.score}分` : ''}</button>`).join('')}</div>`;
    body.innerHTML = html;
    $('#replayPrev')?.addEventListener('click', () => { activeStep -= 1; renderReplay(); });
    $('#replayNext')?.addEventListener('click', () => { activeStep += 1; renderReplay(); });
    body.querySelectorAll('[data-step]').forEach((button) => {
      button.addEventListener('click', () => {
        activeStep = Number(button.dataset.step) || 0;
        renderReplay();
      });
    });
  };

  const show = (id) => {
    activeId = id;
    activeStep = 0;
    [...tabs.children].forEach((t) => t.classList.toggle('active', t.dataset.id === id));
    renderReplay();
  };

  for (const r of list) {
    const date = new Date(r.endedAt || r.time);
    const tab = el('button', 'replay-tab', `${date.toLocaleDateString('zh-CN')} · 第${r.round}副 ·${LEVEL_LABEL[r.level] || r.level}`);
    tab.dataset.id = r.id;
    tab.onclick = () => show(r.id);
    tabs.appendChild(tab);
  }
  show(activeId);
  openModal('#replayModal', $('#btnReplay'));
}

let modalTrigger = null;

function openModal(selector, trigger = document.activeElement) {
  const overlay = $(selector);
  if (!overlay) return;
  modalTrigger = trigger instanceof HTMLElement ? trigger : null;
  overlay.classList.remove('hidden');
  const dialog = overlay.querySelector('[role="dialog"]');
  queueMicrotask(() => dialog?.focus());
}

function closeModal(selector) {
  const overlay = $(selector);
  if (!overlay) return;
  overlay.classList.add('hidden');
  const trigger = modalTrigger;
  modalTrigger = null;
  queueMicrotask(() => trigger?.focus?.());
}

function visibleModal() {
  return ['#rulesModal', '#statsModal', '#replayModal']
    .map((selector) => ({ selector, overlay: $(selector) }))
    .find(({ overlay }) => overlay && !overlay.classList.contains('hidden')) || null;
}

function trapModalTab(event, overlay) {
  const focusable = [...overlay.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])')]
    .filter((node) => !node.hidden && node.getClientRects().length);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!focusable.includes(document.activeElement)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function downloadTrainingData() {
  const data = JSON.stringify(exportTrainingData(), null, 2);
  const blob = new Blob([data], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `掼蛋训练数据_${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function setupChrome() {
  $('#btnRules').onclick = (e) => openModal('#rulesModal', e.currentTarget);
  $('#btnCloseRules').onclick = () => closeModal('#rulesModal');
  $('#rulesModal').addEventListener('click', (e) => {
    if (e.target.id === 'rulesModal') closeModal('#rulesModal');
  });

  $('#btnStats').onclick = openStats;
  $('#btnCloseStats').onclick = () => closeModal('#statsModal');
  $('#statsModal').addEventListener('click', (e) => {
    if (e.target.id === 'statsModal') closeModal('#statsModal');
  });
  $('#btnClearStats').onclick = () => {
    if (confirm('确定清空本机牌技统计？')) {
      clearStats();
      openStats();
    }
  };
  $('#btnExportStats').onclick = downloadTrainingData;
  $('#btnImportStats').onclick = () => $('#fileImportStats').click();
  $('#fileImportStats').onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const result = importTrainingData(JSON.parse(await file.text()));
      if (!result.ok) throw new Error(result.reason);
      flash('训练数据导入成功');
      openStats();
    } catch (error) {
      flash(`导入失败：${error.message || '文件无效'}`);
    } finally {
      e.target.value = '';
    }
  };

  $('#btnReplay').onclick = () => openReplay(state.lastReplay?.id);
  $('#btnCloseReplay').onclick = () => closeModal('#replayModal');
  $('#replayModal').addEventListener('click', (e) => {
    if (e.target.id === 'replayModal') closeModal('#replayModal');
  });

  $('#btnNew').onclick = () => {
    if (confirm('确定重新开始整场比赛？')) {
      startMatch(state);
      render();
    }
  };

  $('#selDifficulty').onchange = (e) => {
    applySettings(state, { difficulty: e.target.value });
    flash(`AI 难度：${e.target.options[e.target.selectedIndex].text}`);
  };
  $('#selSpeed').onchange = (e) => {
    applySettings(state, { aiSpeed: e.target.value });
  };
  $('#chkCoach').onchange = (e) => {
    applySettings(state, { coachMode: e.target.checked });
    if (e.target.checked && state.phase === PHASE.PLAYING && state.currentSeat === 0) {
      refreshCoach(state, false);
    }
    render();
  };
  $('#chkLargeText').onchange = (e) => {
    applySettings(state, { largeText: e.target.checked });
    render();
  };
  $('#chkReducedMotion').onchange = (e) => {
    applySettings(state, { reducedMotion: e.target.checked });
    render();
  };

  document.addEventListener('keydown', (e) => {
    const modal = visibleModal();
    if (modal) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeModal(modal.selector);
      } else if (e.key === 'Tab') {
        trapModalTab(e, modal.overlay);
      }
      return;
    }
    if (e.target.matches('input, select, textarea')) return;
    if (e.target.closest('button') && (e.key === 'Enter' || e.key === ' ' || e.code === 'Space')) return;

    // 还贡确认
    if (state.phase === PHASE.RETURN) {
      if (e.key === 'Enter') {
        e.preventDefault();
        const r = humanConfirmReturn(state);
        if (!r.ok) flash(r.reason);
        render();
      } else if (e.key === 'Escape') {
        humanClearSelect(state);
        render();
      }
      return;
    }

    if (state.phase !== PHASE.PLAYING || state.currentSeat !== 0) return;

    if (e.key === 'Enter') {
      e.preventDefault();
      doPlay();
    } else if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      doPass();
    } else if (e.key === 'Escape') {
      humanClearSelect(state);
      render();
    } else if (e.key === 'h' || e.key === 'H') {
      showHints();
    } else if (e.key === 'c' || e.key === 'C') {
      const tip = refreshCoach(state, false);
      if (tip) flash(tip.text);
      render();
    }
  });
}

setUpdateCallback(() => {
  persistMatch(state);
  render();
});

setupChrome();
render();
if (restoredState && restoredState.phase !== PHASE.IDLE) {
  flash('已恢复上次未完成的牌局');
  resumeMatch(state);
}
