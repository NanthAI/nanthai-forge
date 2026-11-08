// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { revertNoticeId, revertNoticeText, reopenCommand } from '../dist/hosted-revert-notice.js';
import { boardTextProblem } from '../dist/board-text.js';

test('the revert board note fits one board line and names the exact reopen command (8dbccdfb)', () => {
  const input = { revertOf: randomUUID(), receiptId: randomUUID(), laneId: randomUUID() };
  const text = revertNoticeText(input);
  assert.equal(boardTextProblem(text), null);
  assert(text.endsWith(reopenCommand(input.laneId)));
  assert(text.includes(input.revertOf.slice(0, 8)) && text.includes(input.receiptId.slice(0, 8)));
});

test('the revert note id is stable per revert and Lane, so a replay posts nothing new', () => {
  const [a, b] = [randomUUID(), randomUUID()];
  assert.equal(revertNoticeId(a, b), revertNoticeId(a, b));
  assert.notEqual(revertNoticeId(a, b), revertNoticeId(b, a));
  assert.match(revertNoticeId(a, b), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
});
