import assert from 'node:assert/strict';

import { validateRow } from './validate_external_adapter_dataset.mjs';

function baseRow() {
  return {
    schema: 'guandan-external-adapter-trajectory-v1',
    provider: 'fixture', sourceGameId: 'fixture-game', sourceRound: 1,
    recordIndex: 1, split: 'held_out',
    trainingEligible: false,
    projectRuleReplay: 'adapter_action_audited',
    actionMapping: 'resolved_unique_branch',
    fairness: 'own_hand_plus_public_history_only',
    observation: {
      seat: 0, hand: [], handCounts: [0, 0, 0, 0], lastHand: {},
    },
    chosenAction: 'pass', chosen: { action: 'pass', cards: [] },
    outcome: {
      finishOrder: [0, 1, 3, 2], teamUtility: 1, teamWon: true, place: 1,
    },
  };
}

function errorsFor(row) {
  const errors = [];
  validateRow(row, 0, errors);
  return errors;
}

assert.deepEqual(errorsFor(baseRow()), [], '有效的唯一动作分支标签通过严格校验');

const wrongUtility = baseRow();
wrongUtility.outcome.teamUtility = -1;
assert(errorsFor(wrongUtility).some((error) => error.message.includes('team utility')),
  '反转 teamUtility 符号会被拒绝');

const wrongWinner = baseRow();
wrongWinner.outcome.teamWon = false;
assert(errorsFor(wrongWinner).some((error) => error.message.includes('teamWon')),
  '伪造 teamWon 会被拒绝');

const wrongPlace = baseRow();
wrongPlace.outcome.place = 4;
assert(errorsFor(wrongPlace).some((error) => error.message.includes('place')),
  '伪造座位名次会被拒绝');

const duplicateFinish = baseRow();
duplicateFinish.outcome.finishOrder = [0, 1, 1, 2];
assert(errorsFor(duplicateFinish).some((error) => error.message.includes('finish order')),
  '重复或缺失座位的终局顺序会被拒绝');

console.log('外部适配标签校验: 5 passed, 0 failed');
