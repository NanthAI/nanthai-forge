// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { dispatchHostedCheck } from '../dist/hosted-check-controller.js';
import { checksFixture, code } from './hosted-checks-fixture.mjs';

function provider({ lostReply = false, unknownLookup = false, rejected = false } = {}) {
  const executions = new Map(),
    observed = { dispatches: 0, lookups: 0, paidExecutions: 0, pins: [] };
  return {
    id: 'github-actions',
    observed,
    async dispatch(input) {
      observed.dispatches++;
      observed.pins.push(structuredClone(input));
      if (rejected) return { status: 'rejected' };
      if (!executions.has(input.dispatchKey)) {
        executions.set(input.dispatchKey, 'synthetic-provider-execution');
        observed.paidExecutions++;
      }
      if (lostReply) throw new Error('synthetic lost dispatch response');
      return { status: 'accepted', executionId: executions.get(input.dispatchKey) };
    },
    async lookup(input) {
      observed.lookups++;
      observed.pins.push(structuredClone(input));
      return unknownLookup || !executions.has(input.dispatchKey)
        ? { status: 'unknown' }
        : { status: 'found', executionId: executions.get(input.dispatchKey) };
    },
  };
}
test('lost provider replies reconcile one run and one paid execution with the original pins', async () => {
  const s = await checksFixture(),
    request = s.selection(),
    r = await s.enqueue(request),
    p = await s.prepare(r.id);
  const fake = provider({ lostReply: true }),
    store = { control: command => s.control(r.id, command) };
  const unknown = await dispatchHostedCheck(store, fake, p.owner);
  assert.equal(unknown.status, 'unknown');
  const adopted = await dispatchHostedCheck(store, fake, p.owner);
  assert.equal(adopted.status, 'running');
  assert.equal(adopted.id, r.id);
  assert.equal((await s.enqueue(request)).id, r.id);
  assert.equal(fake.observed.dispatches, 1);
  assert.equal(fake.observed.lookups, 1);
  assert.equal(fake.observed.paidExecutions, 1);
  assert.deepEqual(fake.observed.pins[0], fake.observed.pins[1]);
  assert.equal((await s.pass(adopted)).status, 'passed');
});
test('unknown dispatch stays recoverable across lookup failures without repeating paid submission', async () => {
  const s = await checksFixture(),
    r = await s.enqueue(s.selection()),
    p = await s.prepare(r.id);
  const fake = provider({ lostReply: true, unknownLookup: true });
  const store = { control: command => s.control(r.id, command) };
  for (let i = 0; i < 3; i++)
    assert.equal((await dispatchHostedCheck(store, fake, p.owner)).status, 'unknown');
  fake.lookup = async () => {
    throw new Error('synthetic lookup outage');
  };
  assert.equal((await dispatchHostedCheck(store, fake, p.owner)).status, 'unknown');
  assert.equal(fake.observed.dispatches, 1);
  assert.equal(fake.observed.paidExecutions, 1);
  assert.deepEqual((await s.status(r.id)).cost, { status: 'unknown' });
});
test('two controllers reserve one dispatch under OCC and never substitute a provider', async () => {
  const s = await checksFixture(),
    r = await s.enqueue(s.selection());
  const p = await s.prepare(r.id),
    fake = provider(),
    store = { control: command => s.control(r.id, command) };
  await assert.rejects(
    dispatchHostedCheck(store, { ...fake, id: 'local' }, p.owner),
    code('RUNNER_UNAVAILABLE'),
  );
  const row = [...s.tables.projectHostedCheckRuns.values()][0],
    value = JSON.parse(row.value);
  value.lease.until = 0;
  s.patch('projectHostedCheckRuns', row._id, { value: JSON.stringify(value) });
  await Promise.all([
    dispatchHostedCheck(store, fake, randomUUID()),
    dispatchHostedCheck(store, fake, randomUUID()),
  ]);
  assert.equal(fake.observed.dispatches, 1);
  assert.equal(fake.observed.paidExecutions, 1);
  assert.equal((await s.status(r.id)).configuration.provider, 'github-actions');
});
test('expired controller response cannot overwrite takeover; lookup adopts the existing execution', async () => {
  const s = await checksFixture(),
    r = await s.enqueue(s.selection()),
    p = await s.prepare(r.id);
  const fake = provider(),
    submit = fake.dispatch;
  fake.dispatch = async input => {
    const result = await submit(input);
    const row = [...s.tables.projectHostedCheckRuns.values()][0],
      value = JSON.parse(row.value);
    value.lease.until = 0;
    s.patch('projectHostedCheckRuns', row._id, { value: JSON.stringify(value) });
    return result;
  };
  const store = { control: command => s.control(r.id, command) };
  await assert.rejects(dispatchHostedCheck(store, fake, p.owner), code('WORK_STALE'));
  const recovered = await dispatchHostedCheck(store, fake, randomUUID());
  assert.equal(recovered.status, 'running');
  assert.equal(fake.observed.paidExecutions, 1);
  assert.equal(fake.observed.dispatches, 1);
  assert.equal(fake.observed.lookups, 1);
});
test('provider rejection is runner-unavailable, remains distinct from failed/cancelled/unknown and never falls back', async () => {
  const s = await checksFixture(),
    r = await s.enqueue(s.selection()),
    p = await s.prepare(r.id),
    fake = provider({ rejected: true });
  const store = { control: command => s.control(r.id, command) };
  const terminal = await dispatchHostedCheck(store, fake, p.owner);
  assert.equal(terminal.status, 'runner-unavailable');
  assert.equal(terminal.exitCode, null);
  assert.equal(fake.observed.paidExecutions, 0);
  assert.deepEqual(await dispatchHostedCheck(store, fake, p.owner), terminal);
  assert.equal(fake.observed.dispatches, 1);
  assert.equal(fake.observed.lookups, 0);
  await assert.rejects(
    s.callback(s.complete({ ...p.run, dispatchStarted: true }, 'passed')),
    code('EVIDENCE_CHANGED'),
  );
});
test('a crash after reservation recovers only after two fresh authoritative empty lookups', async () => {
  const s = await checksFixture(),
    r = await s.enqueue(s.selection()),
    p = await s.prepare(r.id);
  await s.control(r.id, { kind: 'reserve', owner: p.owner, token: p.token });
  const fake = provider();
  fake.lookup = async () => {
    fake.observed.lookups++;
    return { status: 'empty', authoritative: true, receipt: randomUUID() };
  };
  const recovered = await dispatchHostedCheck({ control: c => s.control(r.id, c) }, fake, p.owner);
  assert.equal(recovered.status, 'running');
  assert(recovered.recoveryUsed);
  assert.equal(fake.observed.lookups, 2);
  assert.equal(fake.observed.dispatches, 1);
  assert.equal(fake.observed.paidExecutions, 1);
});
test('ambiguous recovery preserves the same provider key and cannot multiply paid executions', async () => {
  const s = await checksFixture(),
    r = await s.enqueue(s.selection()),
    p = await s.prepare(r.id);
  const fake = provider({ lostReply: true }),
    store = { control: c => s.control(r.id, c) };
  await dispatchHostedCheck(store, fake, p.owner);
  fake.lookup = async () => ({ status: 'empty', authoritative: true, receipt: randomUUID() });
  const recovered = await dispatchHostedCheck(store, fake, p.owner);
  assert.equal(recovered.status, 'unknown');
  assert(recovered.recoveryUsed);
  assert.equal(fake.observed.dispatches, 2);
  assert.equal(fake.observed.paidExecutions, 1);
  assert.deepEqual(fake.observed.pins[0], fake.observed.pins[1]);
  await dispatchHostedCheck(store, fake, p.owner);
  assert.equal(fake.observed.dispatches, 2);
});
test('replayed or non-authoritative empty lookups do not authorize recovery and a rejected recovery stays unknown', async () => {
  const s = await checksFixture(),
    r = await s.enqueue(s.selection()),
    p = await s.prepare(r.id);
  const fake = provider({ lostReply: true }),
    store = { control: c => s.control(r.id, c) };
  await dispatchHostedCheck(store, fake, p.owner);
  const receipt = randomUUID();
  fake.lookup = async () => ({ status: 'empty', authoritative: true, receipt });
  assert.equal((await dispatchHostedCheck(store, fake, p.owner)).status, 'unknown');
  assert.equal(fake.observed.dispatches, 1);
  fake.lookup = async () => ({ status: 'empty', authoritative: false, receipt: randomUUID() });
  await dispatchHostedCheck(store, fake, p.owner);
  assert.equal(fake.observed.dispatches, 1);
  fake.lookup = async () => ({ status: 'empty', authoritative: true, receipt: randomUUID() });
  fake.dispatch = async () => ({ status: 'rejected' });
  assert.equal((await dispatchHostedCheck(store, fake, p.owner)).status, 'unknown');
});

// Checks machine 1 (Issue 68361cd5): stored `unknown` meant four things, all read as "still
// checking": a lost dispatch reply, a refused (rate-limited) dispatch, a controller that could not
// confirm after recovery, and a pass with shards still unreported. Each is its own state now,
// never success, failure or running; runner-* results are "Not run".
test('checks machine 1: every recorded run reads as one named state with a next step', async () => {
  const { checkRunState, checkRunStatuses } = await import('../dist/check-run-state.js');
  const rows = [
    [{ status: 'unknown', actions: { outcome: 'unknown' }, executionId: null }, 'dispatch-unconfirmed'],
    [{ status: 'unknown', actions: { outcome: 'rejected' }, executionId: null }, 'dispatch-refused'],
    [{ status: 'unknown', executionId: null, recoveryUsed: true }, 'recovery-unconfirmed'],
    [{ status: 'unknown', executionId: null, recoveryUsed: false }, 'dispatch-unconfirmed'],
    [{ status: 'unknown', actions: { outcome: 'accepted' }, executionId: 'run-1' }, 'shards-unconfirmed'],
    [{ status: 'running', actions: { outcome: 'accepted', verdictPending: true } }, 'awaiting-verdict'],
    [{ status: 'running' }, 'running'],
    [{ status: 'runner-unavailable' }, 'runner-unavailable'],
    [{ status: 'runner-budget-exhausted' }, 'runner-budget-exhausted'],
    [{ status: 'something-new' }, 'unknown'],
  ];
  const views = rows.map(([run]) => checkRunState(run));
  assert.deepEqual(
    views.map(view => view.state),
    rows.map(([, state]) => state),
  );
  for (const view of views.slice(0, 5)) {
    assert.equal(view.terminal, false);
    assert.notEqual(view.tone, 'running');
    assert.notEqual(view.tone, 'passed');
    assert.notEqual(view.tone, 'failed');
  }
  // The four unknowns tell an agent four different things.
  assert.equal(new Set(views.slice(0, 5).map(view => view.nextStep)).size, 4);
  for (const status of ['runner-unavailable', 'runner-budget-exhausted'])
    assert.deepEqual(
      [checkRunState({ status }).label, checkRunState({ status }).terminal],
      ['Not run', true],
    );
  for (const status of checkRunStatuses) assert.ok(checkRunState({ status }).nextStep);
});

// The predicates keep each caller's previous member list (no silent unification).
test('checks machine 1: named predicates keep the hand-list memberships they replaced', async () => {
  const m = await import('../dist/check-run-state.js');
  const pick = predicate => m.checkRunStatuses.filter(predicate);
  assert.deepEqual(pick(m.checkTerminal), [
    'passed',
    'failed',
    'cancelled',
    'interrupted',
    'runner-unavailable',
    'runner-budget-exhausted',
  ]);
  assert.deepEqual(pick(m.checkActive), ['queued', 'preparing', 'running']);
  assert.deepEqual(pick(m.checkInfrastructure), [
    'interrupted',
    'runner-unavailable',
    'runner-budget-exhausted',
  ]);
  assert.deepEqual(pick(m.checkNeverRan), ['runner-unavailable', 'runner-budget-exhausted']);
  assert.deepEqual(pick(m.checkUnsuccessful), [
    'failed',
    'cancelled',
    'interrupted',
    'runner-unavailable',
    'runner-budget-exhausted',
  ]);
  assert.deepEqual(pick(m.checkFailedOrInfrastructure), [
    'failed',
    'interrupted',
    'runner-unavailable',
    'runner-budget-exhausted',
  ]);
});

// Build guard: a new hand-written runner-* status list outside src/check-run-state.ts fails check.
test('checks machine 1: the status-list guard flags hand lists and passes writers', async () => {
  const { statusListFindings } = await import('../scripts/check-status-lists.mjs');
  assert.equal(
    statusListFindings('src/x.ts', "if (['failed', 'runner-unavailable'].includes(run.status)) return;")
      .length,
    1,
  );
  assert.equal(
    statusListFindings('web/src/x.ts', "const s = new Set(['runner-budget-exhausted']);").length,
    1,
  );
  assert.equal(statusListFindings('convex/x.ts', "if (run.status === 'runner-unavailable') {}").length, 1);
  assert.deepEqual(statusListFindings('convex/x.ts', "run.status = 'runner-unavailable';"), []);
  assert.deepEqual(statusListFindings('src/check-run-state.ts', "new Set(['runner-unavailable'])"), []);
  assert.deepEqual(statusListFindings('tests/x.mjs', "['runner-unavailable'].includes(s)"), []);
});
