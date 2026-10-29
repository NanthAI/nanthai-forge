// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { readLandingJournals, observeLandingJournals } from '../dist/landing-journal-reads.js';
import { withLandingWorker } from '../dist/landing-worker-context.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-journal-reads-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const folder = join(directory, 'agent-finish');
  mkdirSync(folder);
  return { store: { directory }, folder };
}

test('unchanged journals reuse validation, changed identities refresh, and returned selections are private', async t => {
  const { store, folder } = fixture(t);
  const path = join(folder, `${randomUUID()}.json`);
  writeFileSync(path, '{"pending":false}');
  let parses = 0;
  const parse = text => {
    parses++;
    return JSON.parse(text);
  };
  const select = value => (value.pending ? value : undefined);
  assert.deepEqual(readLandingJournals(store, 'agent-finish', parse, select), []);
  assert.deepEqual(await observeLandingJournals(store, 'agent-finish', parse, select), []);
  assert.equal(parses, 1);
  writeFileSync(`${path}.tmp`, '{"pending":true}');
  renameSync(`${path}.tmp`, path);
  const rows = await observeLandingJournals(store, 'agent-finish', parse, select);
  assert.equal(parses, 2);
  rows[0].pending = false;
  assert.deepEqual(readLandingJournals(store, 'agent-finish', parse, select), [{ pending: true }]);
  writeFileSync(path, '{broken');
  assert.throws(() => readLandingJournals(store, 'agent-finish', parse, select), SyntaxError);
});

test('cold journal discovery yields and stops promptly when its hosting driver aborts', async t => {
  const { store, folder } = fixture(t);
  for (let i = 0; i < 30; i++) writeFileSync(join(folder, `${randomUUID()}.json`), '{}');
  const controller = new AbortController();
  let parsed = 0;
  const parse = text => {
    parsed++;
    if (parsed === 10) controller.abort();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
    return JSON.parse(text);
  };
  await assert.rejects(
    withLandingWorker(controller.signal, () =>
      observeLandingJournals(store, 'agent-finish', parse, value => value),
    ),
    { code: 'LANDING_WORKER_STOPPED' },
  );
  assert.ok(parsed < 30, 'abort does not wait for the remaining retained history');
});
