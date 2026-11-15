// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptanceFixture, api } from './hosted-acceptance-fixture.mjs';
import { code } from './hosted-landing-fixture.mjs';
import { patchTicketState } from './landing-ticket-fixture.mjs';
import { policyPreset } from '../dist/autonomy-policy.js';
import { moduleUrl } from './convex-module.mjs';
const order = await import(moduleUrl('../convex/projectHostedLandingOrder.ts'));
const reservation = await import(moduleUrl('../convex/projectHostedLandingReservation.ts'));
const priorKey = process.env.FORGE_HOSTED_CHECK_KEY_ID;
test.before(() => {
  process.env.FORGE_HOSTED_CHECK_KEY_ID = 'SYNTHETIC';
});
test.after(() => {
  if (priorKey === undefined) delete process.env.FORGE_HOSTED_CHECK_KEY_ID;
  else process.env.FORGE_HOSTED_CHECK_KEY_ID = priorKey;
});
const rowOf = (f, id) => [...f.tables.projectHostedLandingRequests.values()].find(r => r.submissionId === id);
async function fixture(preset = 'supervised') {
  const f = await acceptanceFixture();
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: {
      ...policyPreset(preset),
      agentDefaults: { preflight: 'advise', stallAlerts: { enabled: false } },
    },
  });
  f.insert('projectContributors', { projectId: f.projectId, contributor: 'contributor' });
  return f;
}
async function prepared(
  f,
  { actor = 'contributor', checked = false, agent = false, paths = ['src/leaf.ts'] } = {},
) {
  const item = await f.makeCandidate(
    [],
    [],
    { governance: { version: 1, paths, ownerInputs: false } },
    actor,
  );
  let run;
  if (checked) {
    run = await f.rawChecks.enqueue(
      f.rawChecks.selection({ candidateId: item.candidate.id, expectedHead: item.candidate.result.head }),
      actor,
    );
    await f.rawChecks.pass(await f.rawChecks.activate(run.id));
  }
  const s = await f.enqueue(
    f.request({
      candidateId: item.candidate.id,
      expectedHead: item.candidate.result.head,
      agent,
      check: run ? { kind: 'run', runId: run.id } : null,
    }),
    actor,
  );
  for (let tick = 0; tick < 100; tick++) {
    const task = f
      .pendingTasks()
      .filter(t => !t.name.startsWith('projectHostedLandingStall'))
      .sort((a, b) => a.scheduledTime - b.scheduledTime)[0];
    if (!task) break;
    await f.execute(task);
  }
  await f.transaction('prepare', api.prepare, f.select(s), actor);
  for (const kind of ['inputs', 'dependencies'])
    for (const [index, page] of item.pages[kind].entries())
      await f.transaction(
        'stage',
        api.stage,
        { ...f.select(s), kind, index, page: JSON.stringify(page.value) },
        actor,
      );
  return (await f.status(s.id, actor)).request;
}
test('private contributor person needs an exact check and follows supervised review', async () => {
  const f = await fixture();
  const state = await prepared(f);
  await assert.rejects(f.accept(state, 'contributor'), code('CHECK_NOT_PASSED'));
  assert.equal(f.currentMain().sourceRevision, 0);
  const g = await fixture();
  const checked = await prepared(g, { checked: true });
  const held = await g.accept(checked, 'contributor');
  assert.equal(held.status, 'pending');
  assert.equal(held.request.error.code, 'REVIEW_REQUIRED');
  assert.equal(g.currentMain().sourceRevision, 0);
});
test('owner person can accept unchecked source and approve a contributor exact attempt', async () => {
  const f = await fixture();
  assert.equal((await f.accept(await prepared(f, { actor: 'owner' }))).status, 'landed');
  const g = await fixture();
  const state = await prepared(g);
  const approved = JSON.parse(await g.transaction('approve', api.approve, g.select(state)));
  assert.equal(approved.status, 'landed');
  assert.equal(approved.receipt.check, null);
  assert.equal(approved.receipt.automatic, false);
});
test('unchecked driverless submission never holds a later exact checked landing', async () => {
  const f = await fixture('trusted');
  const older = await prepared(f, { agent: true });
  const newer = await prepared(f, { actor: 'owner', agent: true, checked: true });
  assert.equal(order.holdsLandingOrder(rowOf(f, older.id), older, f.now()), false);
  assert.equal((await f.accept(newer)).status, 'landed');
});
test('driverless ready order has a finite settlement window; driven ready retains order', async () => {
  const f = await fixture();
  const s = await prepared(f, { actor: 'owner', checked: true });
  const at = Date.parse(s.timing.settlementStartedAt);
  assert.equal(order.holdsLandingOrder(rowOf(f, s.id), s, at + 59_999), true);
  assert.equal(order.holdsLandingOrder(rowOf(f, s.id), s, at + 60_000), false);
  const driven = { ...s, request: { ...s.request, finish: { composeOperationId: 'synthetic' } } };
  assert.equal(order.holdsLandingOrder(rowOf(f, s.id), driven, at + 60_000), true);
});
test('driverless ready submission settles through the existing drop deadline', async () => {
  const f = await fixture();
  const s = await prepared(f, { actor: 'owner' });
  f.elapse(60 * 60_000 + 1);
  for (let tick = 0; tick < 10 && (await f.status(s.id)).request.phase !== 'terminal-failed'; tick++)
    await f.execute();
  const ended = (await f.status(s.id)).request;
  assert.equal(ended.phase, 'terminal-failed');
  assert.equal(ended.error.code, 'LANDING_STALLED');
  assert.equal(f.pendingTasks().length, 0);
});
test('direct submission requires retained reverse composition before recording revert metadata', async () => {
  const f = await fixture();
  const item = await f.makeCandidate([], [], {}, 'contributor');
  await assert.rejects(
    f.enqueue(
      f.request({
        agent: false,
        candidateId: item.candidate.id,
        expectedHead: item.candidate.result.head,
        revertOf: crypto.randomUUID(),
      }),
      'contributor',
    ),
    code('BAD_ARGUMENT'),
  );
  assert.equal(f.tables.projectHostedLandingRequests.size, 0);
});
test('driverless and stalled holders do not reserve paths against another landing', async () => {
  const f = await fixture();
  const s = await prepared(f, { actor: 'owner' });
  const holder = rowOf(f, s.id);
  f.patch('projectHostedLandingRequests', holder._id, { reservedUntil: f.now() + 30 * 60_000 });
  const other = { ...holder, submissionId: crypto.randomUUID(), _creationTime: holder._creationTime + 1 };
  const check = () =>
    f.transaction(
      'reservation',
      { _handler: ctx => reservation.reservationAhead(ctx, other, s, f.now()) },
      {},
    );
  assert.equal(await check(), null);
  const driven = {
    ...s,
    request: { ...s.request, finish: { composeOperationId: crypto.randomUUID() } },
    observation: {
      ...s.observation,
      stall: {
        code: 'LANDING_STALLED',
        step: 'ready',
        missingOwner: 'synthetic',
        lastProgressAt: s.timing.settlementStartedAt,
        alarmAt: s.at,
        message: 'synthetic',
      },
    },
  };
  patchTicketState(f, holder, driven);
  assert.equal(await check(), null);
});
