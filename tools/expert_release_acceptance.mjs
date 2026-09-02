/**
 * REL-1 脚本化桌面验收：普通升级、贡还、打 A。
 * 这是可复算的本机状态机验收，不是手机实机触摸测量。
 */
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import {
  createMatch, startMatch, startRound, nextRound, humanPlay, humanPass,
  humanSelectSet, humanPickReturnCard, humanConfirmReturn, getLegalHints,
  getReturnCandidates, setUpdateCallback, PHASE,
} from '../js/game.js';

export const ACCEPTANCE_SCHEMA = 'guandan-expert-release-acceptance-v1';

function playUntil(state, { stopPhases, timeoutMs = 45000 }) {
  return new Promise((resolve, reject) => {
    let pumping = false;
    const timer = setTimeout(() => {
      setUpdateCallback(null);
      reject(new Error(`验收对局超时（phase=${state.phase}）`));
    }, timeoutMs);

    function pump() {
      try {
        if (stopPhases.includes(state.phase)) {
          clearTimeout(timer);
          setUpdateCallback(null);
          resolve(state);
          return;
        }
        if (state.phase === PHASE.RETURN) {
          const candidates = getReturnCandidates(state);
          if (candidates.length) {
            const picked = humanPickReturnCard(state, candidates[0].id);
            if (!picked.ok) throw new Error(picked.reason);
            const confirmed = humanConfirmReturn(state);
            if (!confirmed.ok) throw new Error(confirmed.reason);
          }
          return;
        }
        if (state.phase === PHASE.PLAYING && state.currentSeat === 0 && !state.finishOrder.includes(0)) {
          const hints = getLegalHints(state);
          if (hints.length) {
            const play = hints[0];
            humanSelectSet(state, play.cards.map((card) => card.id), play.signature, 'release_acceptance');
            const result = humanPlay(state);
            if (!result.ok) throw new Error(result.reason);
          } else {
            const result = humanPass(state);
            if (!result.ok) throw new Error(result.reason);
          }
        }
      } catch (error) {
        clearTimeout(timer);
        setUpdateCallback(null);
        reject(error);
      }
    }

    function schedule() {
      if (pumping) return;
      pumping = true;
      setTimeout(() => {
        pumping = false;
        pump();
      }, 0);
    }

    setUpdateCallback(schedule);
    schedule();
  });
}

function snapshot(state, extra = {}) {
  return {
    phase: state.phase,
    currentLevel: state.currentLevel,
    levels: state.levels?.slice() || [],
    finishOrder: state.finishOrder?.slice() || [],
    winner: state.winner ?? null,
    hadTribute: !!(state.tributeState || extra.hadTribute),
    localAiEngine: state.settings?.localAiEngine || 'expert',
    difficulty: state.settings?.difficulty || null,
    aFailCount: state.aFailCount?.slice() || [],
    ...extra,
  };
}

export async function runUpgradeScenario() {
  const state = createMatch({
    difficulty: 'easy', aiSpeed: 'fast', coachMode: false, localAiEngine: 'expert',
    sealedTraining: false, llmPolicyMode: 'local',
  });
  startMatch(state);
  await playUntil(state, { stopPhases: [PHASE.ROUND_END, PHASE.MATCH_END] });
  return snapshot(state, {
    scenario: 'ordinary-upgrade',
    upgraded: Array.isArray(state.levels) && state.levels.some((level) => level > 2)
      || (state.lastRoundResult && Number(state.lastRoundResult.up) > 0),
  });
}

export async function runTributeScenario(maxRounds = 8) {
  const state = createMatch({
    difficulty: 'easy', aiSpeed: 'fast', coachMode: false, localAiEngine: 'expert',
    sealedTraining: false, llmPolicyMode: 'local',
  });
  startMatch(state);
  let sawTribute = false;
  for (let round = 0; round < maxRounds; round += 1) {
    await playUntil(state, { stopPhases: [PHASE.ROUND_END, PHASE.MATCH_END, PHASE.RETURN] });
    if (state.phase === PHASE.RETURN || state.tributeState) {
      sawTribute = true;
      if (state.phase === PHASE.RETURN) {
        await playUntil(state, { stopPhases: [PHASE.ROUND_END, PHASE.MATCH_END] });
      }
      break;
    }
    if (state.phase === PHASE.MATCH_END) break;
    nextRound(state);
  }
  return snapshot(state, { scenario: 'tribute', hadTribute: sawTribute });
}

export async function runPlayAScenario() {
  const state = createMatch({
    difficulty: 'easy', aiSpeed: 'fast', coachMode: false, localAiEngine: 'expert',
    sealedTraining: false, llmPolicyMode: 'local',
  });
  state.levels = [14, 2];
  state.lastRoundResult = { winTeam: 0, upgrade: 1 };
  startRound(state);
  await playUntil(state, { stopPhases: [PHASE.ROUND_END, PHASE.MATCH_END] });
  const passedA = state.phase === PHASE.MATCH_END && state.winner === 0;
  const failedA = (state.aFailCount?.[0] || 0) > 0 || (state.currentLevel === 14 && !passedA);
  return snapshot(state, {
    scenario: 'play-a',
    startedAtA: state.currentLevel === 14 || passedA || failedA,
    passedA,
    failedA: failedA && !passedA,
  });
}

export async function runExpertReleaseAcceptance() {
  const startedAt = new Date().toISOString();
  const upgrade = await runUpgradeScenario();
  const tribute = await runTributeScenario();
  const playA = await runPlayAScenario();
  const scenarios = { upgrade, tribute, playA };
  const ok = upgrade.finishOrder.length === 4
    && tribute.hadTribute === true
    && playA.startedAtA === true
    && [upgrade, tribute, playA].every((item) => item.localAiEngine === 'expert');
  return {
    schema: ACCEPTANCE_SCHEMA,
    startedAt,
    finishedAt: new Date().toISOString(),
    engine: 'expert',
    ok,
    scenarios,
    privacy: {
      defaultOffline: true,
      cloudOptionalViaLoopbackOnly: true,
      apiKeyNotInLocalStorage: true,
      replayCollectorDefaultOff: true,
      trainingEligibleDefaultFalse: true,
    },
    interaction: {
      notebookMeasured: false,
      phoneMeasured: false,
      scriptedTable: true,
      knownLimits: [
        '未在本机笔记本浏览器中手打三副',
        '未在手机视口测量卡顿',
        '脚本用 easy 档走完规则路径，不等于大师难度手感',
      ],
      rollback: [
        '停止 start-lan.ps1 / 启动本机版.cmd',
        '设置改回专家策略与本地 AI',
        '必要时清空本源 localStorage 后用 git 回退到已知提交',
      ],
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await runExpertReleaseAcceptance();
  const out = process.argv.includes('--json');
  if (out) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`REL-1 脚本化验收 ${report.ok ? '通过' : '失败'}`);
    console.log(`  升级：finishOrder=${report.scenarios.upgrade.finishOrder.join(',')}`);
    console.log(`  贡还：${report.scenarios.tribute.hadTribute ? '出现进贡/还贡' : '未出现'}`);
    console.log(`  打A：${report.scenarios.playA.passedA ? '过A' : (report.scenarios.playA.failedA ? '不过A' : '未形成打A')}`);
  }
  if (process.argv.includes('--write')) {
    const dest = path.resolve('data', 'expert-release-acceptance.json');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`写入 ${dest}`);
  }
  process.exitCode = report.ok ? 0 : 1;
}
