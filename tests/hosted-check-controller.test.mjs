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
    id: 'modal',
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
  assert.equal((await s.status(r.id)).configuration.provider, 'modal');
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
