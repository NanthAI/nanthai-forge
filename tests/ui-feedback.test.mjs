// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';

import { moduleUrl } from './convex-module.mjs';
const { PendingWrite } = await import(moduleUrl('../web/src/pending-write.ts'));

test('lost reply reconciles the original payload before a new action, with distinct identities', async () => {
  const calls = [];
  let fail = true;
  const writer = new PendingWrite(async attempt => {
    calls.push(structuredClone(attempt));
    if (fail) {
      fail = false;
      throw new Error('Unknown outcome');
    }
    return attempt.command;
  });
  const a = { action: 'note', text: 'A' },
    b = { action: 'intent-status', status: 'completed' };
  await assert.rejects(writer.send(a), /Unknown outcome/);
  assert.deepEqual(await writer.send(b), b);
  assert.deepEqual(
    calls.map(call => call.command),
    [a, a, b],
  );
  assert.equal(calls[0].operationId, calls[1].operationId);
  assert.notEqual(calls[1].operationId, calls[2].operationId);
});
test('a rejected pending replay cannot report a different draft as sent', async () => {
  const calls = [];
  const writer = new PendingWrite(async attempt => {
    calls.push(attempt);
    throw new Error('Rejected');
  });
  await assert.rejects(writer.send({ text: 'old' }));
  await assert.rejects(writer.send({ text: 'edited' }));
  assert.deepEqual(
    calls.map(call => call.command.text),
    ['old', 'old'],
  );
  assert.equal(calls[0].operationId, calls[1].operationId);
});

test('toast feedback errors hide transport details and distinguish uncertain writes', async () => {
  const { feedbackError } = await import(moduleUrl('../web/src/ui/InlineError.tsx'));
  const { toastErrorText } = await import(moduleUrl('../web/src/ui/toast-store.ts'));
  assert.equal(feedbackError('Failed to fetch'), "Couldn't reach Forge. Your text is kept — try again.");
  assert.equal(toastErrorText('Error: SERVER_PRIVATE_STACK'), "Couldn't reach Forge. Try again.");
  assert.equal(
    toastErrorText('Could not copy. Select the command to copy it.'),
    'Could not copy. Select the command to copy it.',
  );
});

test('W18: a refused GitHub import start frees the form; an unknown outcome keeps its operation id', async () => {
  const { importAttemptAfterStartError } = await import(moduleUrl('../web/src/import-attempt.ts'));
  const attempt = { operationId: 'op-1', url: 'https://github.com/o/r' };
  // Old main never cleared the attempt, so both inputs stayed disabled until a reload.
  assert.equal(importAttemptAfterStartError(attempt, 'BAD_ARGUMENT'), null);
  assert.equal(importAttemptAfterStartError(attempt, 'GITHUB_REPOSITORY_NOT_FOUND'), null);
  assert.equal(
    importAttemptAfterStartError(attempt, undefined),
    attempt,
    'a dropped reply is retried with the same id',
  );
  assert.equal(importAttemptAfterStartError(null, undefined), null);
});
