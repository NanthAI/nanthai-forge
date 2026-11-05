// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { landingFixture } from './hosted-landing-fixture.mjs';
import { moduleUrl, moduleSource } from './convex-module.mjs';
const observe = await import(moduleUrl('../convex/projectHostedFinishObserve.ts'));
// The same reader over source rows supplies a conservative baseline (it already
// benefits from selected-row reuse). No second implementation of the protocol.
const sourceReader = await import(
  `data:text/javascript;base64,${Buffer.from(
    moduleSource('../convex/projectHostedFinishObserve.ts')
      .replace('const ctx = finishReadReader(rawCtx);', 'const ctx = rawCtx;')
      .replace("finishReadReader(rawCtx, 'owner')", 'rawCtx'),
  ).toString('base64')}`
);
const rowOf = (f, table, key, value) => [...f.tables[table].values()].find(r => r[key] === value);
const page = (f, fn, operationId, nextVersion = 0) =>
  f
    .call('observerBudgetPage', fn.page, { projectId: f.projectId, operationId, nextVersion })
    .then(JSON.parse);

test('finish observer budgets calls and bytes per landing independently of 10x retained history', async t => {
  const costs = [];
  for (const history of [1000, 10000]) {
    const f = await landingFixture();
    const state = await f.enqueue();
    const row = rowOf(f, 'projectHostedLandingRequests', 'submissionId', state.id);
    const queue = [...f.tables.projectHostedLandingQueues.values()][0];
    // Representative large metadata discarded by the finite DTO: not source bytes.
    await f.call(
      'observerLargeMetadata',
      {
        _handler: async ctx => {
          await ctx.db.patch(row._id, { batchSelection: 'b'.repeat(24000) });
          await ctx.db.insert('projectHostedFinishes', {
            projectId: f.projectId,
            submissionId: state.id,
            composeOperationId: null,
            parentSubmissionId: null,
            waiting: false,
            wake: null,
            value: JSON.stringify({
              pending: null,
              restoreBases: Array.from({ length: 256 }, () => 'a'.repeat(64)),
            }),
          });
        },
      },
      {},
    );
    for (let n = 0; n < history; n++)
      f.insert('projectHostedLandingObservations', {
        projectId: f.projectId,
        submissionId: randomUUID(),
        version: 0,
        value: '{}',
      });
    const before = await page(f, sourceReader, state.operationId);
    const baseline = f.counts.at(-1);
    const after = await page(f, observe, state.operationId);
    const projected = { ...f.counts.at(-1), isCurrent: f.readSet() };
    assert.deepEqual(after, before, 'identical receipt, queue, progress and retained events');
    assert(projected.readBytes <= baseline.readBytes / 2, 'at least 50% fewer DB bytes');
    assert(projected.readBytes < 12000, 'per-landing initial read bytes');
    // Eight selected documents plus one account read naming the caller by handle.
    assert(projected.documents <= 9, 'bounded selected documents, no history hydration');
    assert(!projected.touched.includes('projectHostedLandingRequests'));
    assert(!projected.touched.includes('projectHostedFinishes'));
    // Queue/controller and Work-only publications must not invalidate the page.
    const finish = rowOf(f, 'projectHostedFinishes', 'submissionId', state.id);
    await f.call(
      'observerBookkeeping',
      {
        _handler: async ctx => {
          await ctx.db.patch(queue._id, { fence: 100, sequence: 100 });
          await ctx.db.patch(row._id, { runnable: false, checkWakeVersion: 100 });
          await ctx.db.patch(finish._id, {
            waiting: true,
            reuseLease: { pendingId: randomUUID(), owner: 'synthetic', until: 100 },
          });
          await ctx.db.patch(f.projectId, { revision: 100 });
        },
      },
      {},
    );
    assert(projected.isCurrent(), 'unrelated source writes do not invalidate the page');
    const idleCalls = f.counts.filter(c => c.name === 'observerBudgetPage').length;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(
      f.counts.filter(c => c.name === 'observerBudgetPage').length,
      idleCalls,
      'idle = zero calls',
    );
    costs.push({
      history,
      sourceDocuments: baseline.documents,
      sourceBytes: baseline.readBytes,
      documents: projected.documents,
      readBytes: projected.readBytes,
      idleCalls: 0,
    });
  }
  assert.equal(costs[0].readBytes, costs[1].readBytes);
  assert.equal(costs[0].documents, costs[1].documents);
  t.diagnostic(JSON.stringify(costs));
});

test('all mutation entry points maintain observer projections, including internal continuations', async () => {
  const { readFile, readdir } = await import('node:fs/promises');
  const ts = (await import('typescript')).default;
  const bad = [];
  for (const name of await readdir(new URL('../convex/', import.meta.url))) {
    if (!name.endsWith('.ts') || name === 'server.ts') continue;
    const source = await readFile(new URL(`../convex/${name}`, import.meta.url), 'utf8');
    const ast = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
    for (const statement of ast.statements) {
      if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.text !== './_generated/server')
        continue;
      const imports = statement.importClause?.namedBindings;
      if (!imports || !ts.isNamedImports(imports)) continue;
      for (const specifier of imports.elements)
        if (['mutation', 'internalMutation'].includes((specifier.propertyName ?? specifier.name).text))
          bad.push(`${name}:${specifier.name.text}`);
    }
  }
  assert.deepEqual(bad, [], 'raw mutation registrations would leave the read model stale');
});

test('progress and conflict advice invalidate immediately; private finish wake does not', async () => {
  const f = await landingFixture();
  const state = await f.enqueue();
  const requestRow = rowOf(f, 'projectHostedLandingRequests', 'submissionId', state.id);
  await f.call(
    'finishInsert',
    {
      _handler: ctx =>
        ctx.db.insert('projectHostedFinishes', {
          projectId: f.projectId,
          submissionId: state.id,
          composeOperationId: null,
          parentSubmissionId: null,
          waiting: false,
          wake: null,
          value: '{"pending":null}',
        }),
    },
    {},
  );
  await page(f, observe, state.operationId);
  const pending = { ...f.counts.at(-1), isCurrent: f.readSet() };
  const finish = rowOf(f, 'projectHostedFinishes', 'submissionId', state.id);
  await f.call(
    'privateWake',
    {
      _handler: async ctx => {
        const taskId = await ctx.db.insert('_scheduled_functions', {
          name: 'synthetic',
          args: [],
          scheduledTime: 100,
          state: { kind: 'pending' },
        });
        await ctx.db.patch(finish._id, { wake: { id: randomUUID(), taskId, at: 100 } });
      },
    },
    {},
  );
  assert(pending.isCurrent(), 'selected finish wake is not observable');
  const advice = {
    paths: ['synthetic.ts'],
    more: 0,
    landedSubmissionId: randomUUID(),
    at: new Date().toISOString(),
    next: 'sync-and-land',
  };
  await f.call(
    'advice',
    { _handler: ctx => ctx.db.patch(requestRow._id, { wouldConflict: JSON.stringify(advice) }) },
    {},
  );
  assert(!pending.isCurrent(), 'advice is visible in the same transaction');
  const receipt = await page(f, observe, state.operationId);
  assert.deepEqual(receipt.wouldConflict, advice);
  const observed = { ...f.counts.at(-1), isCurrent: f.readSet() };
  const { store } = await import('./hosted-landing-fixture.mjs');
  await f.call(
    'phaseChange',
    {
      _handler: ctx =>
        store.writeLanding(
          ctx,
          rowOf(f, 'projectHostedLandingRequests', 'submissionId', state.id),
          {
            ...state,
            version: state.version + 1,
            phase: 'checking',
            observation: { state: 'pending', pendingReason: 'checking', cause: null },
          },
          false,
        ),
    },
    {},
  );
  assert(!observed.isCurrent(), 'progress is visible in the same transaction');
  assert.equal((await page(f, observe, state.operationId, 1)).submission.phase, 'checking');
  await f.call('revokeProject', { _handler: ctx => ctx.db.patch(f.projectId, { removal: 'deleting' }) }, {});
  await assert.rejects(
    page(f, observe, state.operationId),
    error => error.data?.code === 'PROJECT_UNAVAILABLE',
  );
});

test('one accepted landing budgets executions and aggregate read bytes with 100 unrelated publications', async t => {
  const { finishFixture } = await import('./hosted-finish-fixture.mjs');
  const { synthetic } = await import('./hosted-landing-batches-fixture.mjs');
  for (const [key, value] of Object.entries(synthetic)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => (previous === undefined ? delete process.env[key] : (process.env[key] = previous)));
  }
  const costs = [];
  for (const history of [1000, 10000]) {
    const f = await finishFixture(t);
    const request = f.request();
    const state = await f.enqueue(request);
    for (let n = 0; n < history; n++)
      f.insert('projectHostedLandingObservations', {
        projectId: f.projectId,
        submissionId: randomUUID(),
        version: 0,
        value: '{}',
      });
    const watchers = [sourceReader, observe].map(fn => ({
      fn,
      version: 0,
      reads: null,
      calls: 0,
      bytes: 0,
      latest: null,
    }));
    const refresh = async () => {
      for (const w of watchers) {
        if (w.reads?.isCurrent()) continue;
        w.latest = await page(f, w.fn, request.operationId, w.version);
        w.reads = { ...f.counts.at(-1), isCurrent: f.readSet() };
        w.calls++;
        w.bytes += w.reads.readBytes;
        w.version = w.latest.nextVersion;
      }
      for (const key of ['submission', 'pendingAttempt', 'wouldConflict', 'queueAheadSelection'])
        assert.deepEqual(
          watchers[1].latest[key],
          watchers[0].latest[key],
          `${key} delivered at the same commit`,
        );
    };
    await refresh();
    const readStart = f.counts.length;
    for (let i = 0; i < 100; i++) {
      await f.call(
        'unrelatedPublication',
        { _handler: ctx => ctx.db.patch(f.projectId, { agentGuidance: `synthetic-${i}` }) },
        {},
      );
      await refresh();
    }
    assert.equal(watchers[0].calls, 101);
    assert.equal(watchers[1].calls, 1, '100 unrelated publications produce no observer executions');
    let steps = 0;
    while (f.pending().length) {
      assert(++steps <= 100);
      await f.execute();
      await refresh();
    }
    await f.passChecks();
    await refresh();
    while (f.pending().length) {
      assert(++steps <= 100);
      await f.execute();
      await refresh();
    }
    assert.equal(watchers[1].latest.submission.phase, 'landed');
    assert(watchers[1].latest.submission.acceptance.receiptId);
    assert(watchers[1].calls <= 5, 'calls per accepted synthetic landing');
    assert(watchers[1].bytes <= 36000, 'DB read bytes per accepted synthetic landing');
    assert(watchers[1].bytes < watchers[0].bytes / 2);
    const observerCalls = watchers.map(w => w.calls);
    const transactions = f.counts.slice(readStart);
    const otherCalls = transactions.filter(c => c.name !== 'observerBudgetPage').length;
    assert(otherCalls <= 122, 'other functions do not grow to carry observation work');
    const totalCalls = {
      source: otherCalls + watchers[0].calls,
      projected: otherCalls + watchers[1].calls,
      otherFunctions: otherCalls,
    };
    assert(totalCalls.projected <= totalCalls.source, 'no shifted Convex calls');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(
      watchers.map(w => w.calls),
      observerCalls,
      'idle = 0',
    );
    costs.push({
      history,
      source: { callsPerLanding: watchers[0].calls, bytesPerLanding: watchers[0].bytes },
      projected: { callsPerLanding: watchers[1].calls, bytesPerLanding: watchers[1].bytes },
      totalCallsPerLanding: totalCalls,
      accepted: 1,
      steps,
      idleCalls: 0,
      rssBytes: process.memoryUsage().rss,
    });
  }
  assert.equal(costs[0].projected.callsPerLanding, costs[1].projected.callsPerLanding);
  assert(
    costs[1].projected.bytesPerLanding <= costs[0].projected.bytesPerLanding * 1.01,
    '10x history does not grow observation reads',
  );
  t.diagnostic(JSON.stringify(costs));
});
