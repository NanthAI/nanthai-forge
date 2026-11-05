// SPDX-License-Identifier: Apache-2.0
// Incident a7de3a93 (2026-11-05): a check dispatch whose outcome stayed unknown,
// with no execution bound, left the queue head `checking` for the 12 h watchdog.
// The checking stall alarm only flagged it; replaying the land only re-sent a wake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { finishFixture, desired } from './hosted-finish-fixture.mjs';
import { LANDING_STALL_MS } from '../dist/landing-stall.js';

const synthetic = {
  FORGE_HOSTED_CHECK_KEY_ID: 'SYNTHETIC',
  FORGE_SOURCE_PROVIDER: 'convex',
  FORGE_SOURCE_WORKER: 'fixed-worker',
  FORGE_SOURCE_RUNTIME: 'a'.repeat(64),
  FORGE_SOURCE_KEY_ID: 'SYNTHETIC',
  R2_ACCOUNT_ID: 'synthetic',
  R2_BUCKET: 'synthetic',
  R2_ACCESS_KEY_ID: 'synthetic',
  R2_SECRET_ACCESS_KEY: 'synthetic',
};
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
const runs = f =>
  [...f.tables.projectHostedCheckRuns.values()]
    .map(row => JSON.parse(row.value))
    .sort((a, b) => a.at.localeCompare(b.at));
const landing = (f, operationId) =>
  JSON.parse(
    [...f.tables.projectHostedLandingRequests.values()].find(r => r.operationId === operationId).value,
  );

test('incident a7de3a93 replay: an unacknowledged dispatch is re-checked by the stall alarm, then the head lands', async t => {
  const f = await finishFixture(t),
    command = {
      operationId: randomUUID(),
      authorityEpoch: 1,
      composeOperationId: f.selection.request.operationId,
      after: null,
      check: f.request().check,
    };
  await f.tx('desiredSubmit', desired.submit, { projectId: f.projectId, request: JSON.stringify(command) });
  for (let n = 0; !f.tables.projectHostedCheckRuns.size; n++) {
    assert(n < 30, 'check run created');
    await f.execute();
  }
  // The adapter (second runner kind: a worker-driven Actions credential) reserves the
  // dispatch, the provider reply is lost, and its controller dies with its lease.
  const [first] = runs(f);
  const p = await f.rawChecks.prepare(first.id);
  await f.rawChecks.control(first.id, { kind: 'reserve', owner: p.owner, token: p.token });
  await f.rawChecks.control(first.id, {
    kind: 'observe',
    owner: p.owner,
    token: p.token,
    result: { status: 'unknown' },
  });
  assert.equal(runs(f)[0].status, 'unknown');
  const calls = f.counts.length;
  const steps = await f.drain();
  const after = runs(f);
  assert.equal(after[0].status, 'interrupted', 'the stall alarm acts on a dispatch no runner acknowledged');
  assert.match(after[0].failureReason, /No runner acknowledged the dispatch/);
  assert.equal(after.length, 2, 'the bounded platform retry dispatched one new run');
  assert.equal(after[1].status, 'queued');
  const state = landing(f, command.operationId);
  assert.equal(state.phase, 'checking');
  assert.equal(
    after[1].request.candidateId,
    after[0].request.candidateId,
    'the same exact Candidate checks again',
  );
  // Bounded: one alarm-driven reconciliation, no poller (drain refuses >100 steps).
  t.diagnostic(JSON.stringify({ steps, calls: f.counts.length - calls }));
  assert(f.counts.length - calls <= 12, 'a handful of calls for the whole recovery');
  assert(
    Date.now() - Date.parse(first.at) < 2 * LANDING_STALL_MS,
    're-checked within the stall window, not 12 h',
  );
  await f.passChecks();
  await f.drain();
  assert.equal(landing(f, command.operationId).phase, 'landed');
  assert.equal(f.pending().length, 0, 'idle schedules nothing');
});
