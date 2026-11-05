// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './landing-batch-fixture.mjs';
import { drainLandingBatches } from '../dist/landing-batch.js';
import { workLocked } from '../dist/work-lock.js';

test('a direct batch drain yields acceptance contention to the owner event loop', async t => {
  const f = await fixture(t);
  const candidate = await f.candidate('guard.ts');
  await f.checkCandidates([candidate]);
  const lock = join(f.store.directory, 'acceptance-lock-probe');
  const dispatch = f.work.dispatch.bind(f.work);
  let attempts = 0,
    release;
  t.after(() => clearTimeout(release));
  t.mock.method(f.work, 'dispatch', (command, ...args) => {
    if (command.action !== 'accept-channel') return dispatch(command, ...args);
    if (++attempts === 1) {
      writeFileSync(lock, '{unpublished');
      release = setTimeout(() => rmSync(lock, { force: true }), 0);
    }
    // The owner must be able to release contention on its next turn. Guard the
    // blocking primitive directly, rather than relying on a hardware deadline.
    const wait = t.mock.method(Atomics, 'wait', () =>
      assert.fail('A batch driver must yield lock contention.'),
    );
    try {
      return workLocked(lock, () => dispatch(command, ...args));
    } finally {
      wait.mock.restore();
    }
  });
  await drainLandingBatches(f.work, 'main');
  assert.ok(attempts >= 2, 'acceptance reconciles its original phase after contention');
  assert.equal(f.store.select('landingEntries', candidate.command.operationId).status, 'accepted');
  assert.equal(f.content('guard.ts'), 'guard.ts\n');
  assert.equal(existsSync(lock), false);
});
