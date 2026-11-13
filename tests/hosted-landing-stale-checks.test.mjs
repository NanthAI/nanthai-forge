// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { synthetic, states } from './hosted-landing-batches-fixture.mjs';
import {
  fixture,
  current,
  requestRow,
  finishRow,
  pendingTasks,
  drain,
  settle,
  assertProgressOwners,
} from './hosted-stale-check-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const stale = await import(moduleUrl('../convex/projectHostedLandingStaleChecks.ts'));
const observe = await import(moduleUrl('../convex/projectHostedFinishObserve.ts'));
const completion = await import(moduleUrl('../convex/projectHostedAcceptanceCompletion.ts'));
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

for (const conflict of [true, false])
  test(`83e6d0d3: accepted overlap cancels its running admission and ${conflict ? 'delivers conflict without old CI' : 'starts a fresh exact check in the same queue position'}`, async t => {
    const f = await fixture(t, { conflict });
    const [a, b] = f.runs();
    const old = await f.rawChecks.activate(b.id);
    const original = current(f, 1);
    await f.rawChecks.pass(await f.rawChecks.activate(a.id));
    await drain(f, () => f.runs().find(r => r.id === b.id).status === 'cancelled');
    assert.equal(f.runs().find(r => r.id === b.id).status, 'cancelled');
    assert.equal(current(f, 0).phase, 'landed');
    assert.equal(current(f, 1).phase, 'queued');
    assert.equal(current(f, 1).sequence, original.sequence);
    assert.equal(current(f, 1).operationId, original.operationId);
    assert(finishRow(f, 1).wake, 'cancel transaction retains the replacement scheduler receipt');
    assert(JSON.parse(finishRow(f, 1).value).pending, 'replacement composition is reserved atomically');
    assertProgressOwners(f);
    await assert.rejects(f.rawChecks.pass(old), e =>
      ['CHECK_CANCELLED', 'EVIDENCE_CHANGED'].includes(e.data?.code ?? e.code),
    );
    await drain(f);
    if (conflict) {
      assert.equal(current(f, 1).phase, 'terminal-failed');
      assert.equal(current(f, 1).error.code, 'COMPOSITION_CONFLICT');
      const page = JSON.parse(
        await f.transaction('stale-conflict-observe', observe.page, {
          projectId: f.projectId,
          operationId: original.operationId,
          nextVersion: 0,
        }),
      );
      assert.equal(page.submission.error.code, 'COMPOSITION_CONFLICT');
      assert.equal(f.runs().length, 2, 'no replacement check for a real conflict');
    } else {
      assert.equal(current(f, 1).phase, 'checking', 'fresh exact check starts without a further agent turn');
      const fresh = f.runs().find(r => r.status === 'queued');
      assert(fresh && fresh.id !== old.id);
      assert.equal(fresh.candidate.base.head, f.currentMain().head);
      assert.equal(fresh.candidate.base.receiptId, f.currentMain().receipt.id);
      await settle(f);
      assert.equal(current(f, 1).phase, 'landed');
      assert.equal(f.runs().length, 3, 'one cancelled admission plus the ordinary exact recheck');
    }
    assert.equal(pendingTasks(f).length, 0, 'settled work is idle');
  });

for (const [name, paths] of [
  ['unrelated', ['src/a.ts', 'src/b.ts']],
  ['global-risk', ['build.rs', 'src/b.ts']],
])
  test(`${name} accepted paths ${name === 'unrelated' ? 'preserve' : 'cancel'} the other running check without changing acceptance proofs`, async t => {
    const f = await fixture(t, { memberPaths: paths, count: 0 });
    if (name === 'global-risk') {
      const project = f.tables.hostedProjects.get(f.projectId);
      f.patch('hostedProjects', f.projectId, {
        autonomyPolicy: {
          ...project.autonomyPolicy,
          acceptance: { ...project.autonomyPolicy.acceptance, hostedCrossHeadReuse: false },
        },
      });
    }
    await f.add(0);
    await f.add(1);
    await drain(f);
    const [a, b] = f.runs();
    await f.rawChecks.activate(b.id);
    await f.rawChecks.pass(await f.rawChecks.activate(a.id));
    await drain(f);
    assert.equal(f.runs().find(r => r.id === b.id).status === 'cancelled', name === 'global-risk');
    if (name === 'unrelated') assert.equal(current(f, 1).phase, 'checking');
    await settle(f);
    assert(states(f).every(s => s.phase === 'landed'));
    assert.equal(f.runs().length, name === 'unrelated' ? 2 : 3);
  });

test('post-acceptance cancellation without a running entry reads zero new DB bytes and schedules nothing', async t => {
  const f = await fixture(t, { count: 1 });
  await settle(f);
  const before = f.counts.length;
  assert.equal(
    await f.transaction(
      'empty-stale-pass',
      {
        _handler: ctx =>
          stale.cancelStaleLandingChecks(ctx, {
            projectId: f.projectId,
            sequence: 0,
            receiptIds: [],
            head: 'a'.repeat(64),
            candidate: { id: randomUUID(), actor: 'owner', digest: 'a'.repeat(64) },
          }),
      },
      {},
    ),
    0,
  );
  const [cost] = f.counts.slice(before);
  assert.equal(cost.readBytes, 0);
  assert.equal(cost.writes, 0);
  assert.equal(pendingTasks(f).length, 0);
  t.diagnostic(JSON.stringify({ documents: cost.documents, readBytes: cost.readBytes, writes: cost.writes }));
});

test('restart after cancellation resumes the committed composition wake without a client repair', async t => {
  const f = await fixture(t, { conflict: false });
  const [a, b] = f.runs();
  await f.rawChecks.activate(b.id);
  await f.rawChecks.pass(await f.rawChecks.activate(a.id));
  await drain(f, () => f.runs().find(r => r.id === b.id).status === 'cancelled');
  const request = current(f, 1),
    pending = structuredClone(JSON.parse(finishRow(f, 1).value).pending);
  // Only durable tables/scheduler entries survive; no session invokes resume.
  for (const table of Object.values(f.tables))
    for (const [id, row] of table) table.set(id, structuredClone(row));
  assertProgressOwners(f);
  await drain(f);
  assert.equal(current(f, 1).phase, 'checking');
  assert.notEqual(requestRow(f, 1).runId, b.id);
  assert.equal(current(f, 1).operationId, request.operationId);
  assert(f.runs().some(r => r.request.operationId === pending.operations.check));
  await settle(f);
  assert.equal(current(f, 1).phase, 'landed');
});

test('a scheduling failure rolls back cancellation and replay schedules fresh work atomically', async t => {
  const f = await fixture(t);
  const [a, b] = f.runs();
  await f.rawChecks.activate(b.id);
  await f.rawChecks.pass(await f.rawChecks.activate(a.id));
  await drain(f, task => task.name === 'projectHostedAcceptance:complete');
  const task = pendingTasks(f).find(t => t.name === 'projectHostedAcceptance:complete');
  assert(task);
  await assert.rejects(
    f.transaction(
      'cancel-schedule-crash',
      {
        _handler: async (ctx, args) =>
          completion.completeAcceptedHeads(
            {
              ...ctx,
              scheduler: {
                ...ctx.scheduler,
                runAfter: async () => {
                  throw new Error('synthetic scheduler interruption');
                },
              },
            },
            args,
          ),
      },
      task.args[0],
    ),
    /synthetic scheduler interruption/,
  );
  assert.equal(
    f.runs().find(r => r.id === b.id).status,
    'running',
    'uncommitted cancel cannot strand the run',
  );
  assert.equal(JSON.parse(finishRow(f, 1).value).pending, null);
  await f.execute(task);
  await drain(f);
  assert.equal(f.runs().find(r => r.id === b.id).status, 'cancelled');
  assert.equal(current(f, 1).error.code, 'COMPOSITION_CONFLICT');
});

test('a failed or late CI adapter stop cannot strand the replacement or revive the old run', async t => {
  const f = await fixture(t, { conflict: false });
  const [a, b] = f.runs();
  const old = await f.rawChecks.activate(b.id);
  const checks = await import(moduleUrl('../convex/projectHostedCheckStore.ts'));
  await f.transaction(
    'bind-direct-cancel-adapter',
    {
      _handler: async ctx => {
        const selected = await checks.loadHostedCheck(ctx, { projectId: f.projectId, runId: b.id }, false);
        selected.run.actions = {
          reservedAt: Date.now(),
          fence: selected.run.fence,
          watchdog: null,
          outcome: 'accepted',
        };
        await checks.writeHostedCheck(ctx, selected.row._id, selected.run);
      },
    },
    {},
  );
  await f.rawChecks.pass(await f.rawChecks.activate(a.id));
  await drain(f, () => f.runs().find(r => r.id === b.id).status === 'cancelled');
  const stop = f
    .pending()
    .find(t => t.name === 'projectHostedActionsWebhook:cancel' && t.args[0].runId === b.id);
  assert(stop, 'the existing adapter receives cancellation of the exact provider run');
  assertProgressOwners(f);
  // The external stop action has not returned. Its failure is independent of
  // the atomic landing/source reservation already committed by cancellation.
  f.patch('_scheduled_functions', stop._id, { state: { kind: 'failed' } });
  await drain(f);
  assert.equal(current(f, 1).phase, 'checking');
  await assert.rejects(f.rawChecks.pass(old), e => (e.data?.code ?? e.code) === 'CHECK_CANCELLED');
  await settle(f);
  assert.equal(current(f, 1).phase, 'landed');
  assert(
    ![...f.tables.projectHostedAcceptances.values()]
      .map(r => JSON.parse(r.value))
      .some(r => r.submissionId === current(f, 1).id && r.check.runId === old.id),
  );
});

test('a failed replacement compose settles visibly instead of leaving a cancelled landing pending', async t => {
  const f = await fixture(t, { conflict: false });
  const [a, b] = f.runs();
  await f.rawChecks.activate(b.id);
  await f.rawChecks.pass(await f.rawChecks.activate(a.id));
  await drain(f, () => f.runs().find(r => r.id === b.id).status === 'cancelled');
  const source = JSON.parse(finishRow(f, 1).value).pending.operations.compose;
  const exhaustion = await import(moduleUrl('../convex/projectHostedComposeExhaustion.ts'));
  // The source owner's existing exhaustion terminal is also the failure exit of
  // an interrupted replacement, including a restart before any source step.
  await f.transaction(
    'cancelled-replacement-fails',
    { _handler: ctx => exhaustion.exhaustFinishCompose(ctx, finishRow(f, 1), source) },
    {},
  );
  assert.equal(current(f, 1).phase, 'terminal-failed');
  assert.equal(current(f, 1).error.code, 'SOURCE_RETRY_EXHAUSTED');
  assertProgressOwners(f);
  const page = JSON.parse(
    await f.transaction('observe-source-failure', observe.page, {
      projectId: f.projectId,
      operationId: current(f, 1).operationId,
      nextVersion: 0,
    }),
  );
  assert.equal(page.submission.error.code, 'SOURCE_RETRY_EXHAUSTED');
  await drain(f);
});

test('back-to-back acceptances coalesce into actual main before the cancelled landing checks', async t => {
  const f = await fixture(t, { conflict: false, count: 3 });
  const [a, b, c] = f.runs();
  await f.rawChecks.activate(b.id);
  await f.rawChecks.pass(await f.rawChecks.activate(a.id));
  await f.rawChecks.pass(await f.rawChecks.activate(c.id));
  // Both publications happen before their post-acceptance ticks. The checking
  // entry holds no order yet, so the unrelated entry can land in the same wave.
  for (let n = 0; current(f, 2).phase !== 'landed'; n++) {
    assert(n < 200);
    const task = pendingTasks(f).find(t => t.name !== 'projectHostedAcceptance:complete');
    assert(task);
    await f.execute(task);
  }
  assert.equal(current(f, 0).phase, 'landed');
  const actual = f.currentMain();
  const ticks = pendingTasks(f).filter(t => t.name === 'projectHostedAcceptance:complete');
  assert(ticks.length >= 2);
  for (const tick of ticks.toReversed()) await f.execute(tick);
  await drain(f);
  assert.equal(f.runs().find(r => r.id === b.id).status, 'cancelled');
  const replacement = f.runs().find(r => r.status === 'queued');
  assert(replacement);
  assert.equal(replacement.candidate.base.head, actual.head);
  assert.equal(replacement.candidate.base.receiptId, actual.receipt.id);
  assertProgressOwners(f);
  await settle(f);
  assert(states(f).every(s => s.phase === 'landed'));
});

test('a main move during replacement composition never starts CI on that obsolete generation', async t => {
  const f = await fixture(t, { conflict: false });
  const [a, b] = f.runs();
  await f.rawChecks.activate(b.id);
  await f.rawChecks.pass(await f.rawChecks.activate(a.id));
  await drain(f, () => f.runs().find(r => r.id === b.id).status === 'cancelled');
  const obsolete = JSON.parse(finishRow(f, 1).value).pending;
  const next = f.moveMain();
  await drain(f);
  const checks = f.runs().filter(r => r.status === 'queued');
  assert.equal(checks.length, 1);
  assert.equal(checks[0].candidate.base.head, next.head);
  assert.equal(checks[0].candidate.base.receiptId, next.receipt.id);
  assert(!f.runs().some(r => r.request.operationId === obsolete.operations.check));
  assertProgressOwners(f);
  await settle(f);
  assert.equal(current(f, 1).phase, 'landed');
});

test('the acceptance cancellation pass stops at eight running entries', async t => {
  const f = await fixture(t, { count: 10, memberPaths: Array(10).fill('src/shared.ts') });
  const initial = f.runs();
  await f.rawChecks.pass(await f.rawChecks.activate(initial[0].id));
  await drain(f, () => f.runs().filter(r => r.status === 'cancelled').length > 0);
  assert.equal(f.runs().filter(r => r.status === 'cancelled').length, 8);
  assert.equal(current(f, 9).phase, 'checking', 'the ninth entry remains outside this finite look-ahead');
  assertProgressOwners(f);
});
