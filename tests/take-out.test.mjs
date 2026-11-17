// SPDX-License-Identifier: Apache-2.0
// Item 9e7a17df: "Take it out of main", the person's undo of a landing on the landing check, proof and Lane review
// screens, starts the existing exact-change revert and never a second one. A press retried after a lost reply, and a
// second press, reuse the first operation id, so the server reconciles one reverse landing; the reply names the
// reverse Lane, whose landing check the screens link.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';

const { TakeOut } = await import(moduleUrl('../web/src/app/take-out.ts'));

const receipt = 'receipt-1';
function fakeLanding(fail = 0) {
  const calls = [];
  return {
    calls,
    async revert(operationId, receiptId, why) {
      calls.push({ operationId, receiptId, why });
      if (calls.length <= fail) throw new Error('lost reply');
      return { candidateId: 'c', laneId: 'reverse-lane', submission: { id: `s-${operationId}` } };
    },
  };
}

test('a press retried after a lost reply reuses its operation id, so one reverse landing is made', async () => {
  const landing = fakeLanding(1);
  let n = 0;
  const takeOut = new TakeOut(landing, () => `op-${++n}`);
  await assert.rejects(takeOut.press(receipt, 'Take it out'));
  const result = await takeOut.press(receipt, 'Take it out');
  assert.deepEqual(
    landing.calls.map(call => call.operationId),
    ['op-1', 'op-1'],
  );
  assert.deepEqual(result, { laneId: 'reverse-lane', submissionId: 's-op-1' });
});

test('a second press on the same landing reconciles the same revert; another landing gets its own', async () => {
  const landing = fakeLanding();
  let n = 0;
  const takeOut = new TakeOut(landing, () => `op-${++n}`);
  await takeOut.press(receipt, 'Take it out');
  await takeOut.press(receipt, 'Take it out');
  await takeOut.press('receipt-2', 'Take the other out');
  assert.deepEqual(
    landing.calls.map(call => [call.receiptId, call.operationId]),
    [
      [receipt, 'op-1'],
      [receipt, 'op-1'],
      ['receipt-2', 'op-2'],
    ],
  );
});
