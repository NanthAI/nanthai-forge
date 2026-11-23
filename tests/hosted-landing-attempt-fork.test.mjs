// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { finishFixture } from './hosted-finish-fixture.mjs';
import { batchStore, synthetic } from './hosted-landing-batches-fixture.mjs';
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
// Every child names why it replaces its parent (ced8e98f); these ordinal fixtures need no real cause.
const forkCause = { kind: 'unknown', link: 'fixture:ordinal' };
const ordinals = (f, id) =>
  [...f.tables.projectHostedLandingAttempts.values()]
    .map(r => JSON.parse(r.value))
    .filter(a => a.submissionId === id)
    .sort((a, b) => a.number - b.number);
for (const forks of [1, 2, 5])
  test(`8c9b84fc: a finish reservation installs after ${forks} intervening immutable forks without WORK_STALE`, async t => {
    const f = await finishFixture(t);
    const state = await f.enqueue(
      f.request({ finish: { composeOperationId: f.selection.request.operationId, after: null } }),
    );
    await f.drain();
    f.moveMain();
    await f.passChecks();
    for (let n = 0; !(await f.current(state.id)).pendingAttempt; n++) {
      assert(n < 50, 'main race reserves source work');
      await f.execute();
    }
    const pending = (await f.current(state.id)).pendingAttempt;
    for (let n = 0; n < forks; n++)
      await f.transaction(
        'platform-or-batch-fork-during-reserved-finish',
        {
          _handler: async ctx => {
            const current = await import(moduleUrl('../convex/projectHostedLandingStore.ts'));
            const loaded = await current.loadLanding(ctx, { projectId: f.projectId, submissionId: state.id });
            const parent = await current.loadLandingAttempt(ctx, {
              projectId: f.projectId,
              attemptId: loaded.state.attemptId,
            });
            await batchStore.installBatchAttempt(ctx, {
              projectId: f.projectId,
              original: parent,
              check: parent.check,
              keepReceipt: true,
            });
          },
        },
        {},
      );
    await f.drain();
    const after = (await f.current(state.id)).submission;
    assert.notEqual(after.error?.code, 'WORK_STALE', 'a reserved ordinal is refreshed at installation');
    const attempts = ordinals(f, state.id);
    assert.deepEqual(
      attempts.map(a => a.number),
      Array.from({ length: attempts.length }, (_, i) => i),
    );
    assert.equal(attempts.at(-1).id, pending.id, 'the reserved source identity is retained');
    for (let wave = 0; wave < 8 && (await f.current(state.id)).submission.phase !== 'landed'; wave++) {
      await f.passChecks();
      await f.drain();
    }
    assert.equal((await f.current(state.id)).submission.phase, 'landed');
    assert.equal(f.pending().length, 0);
  });

for (const seed of [1, 17, 73])
  test(`8c9b84fc: randomized fork/reservation model keeps a contiguous immutable lineage (seed ${seed})`, async t => {
    const store = await import(moduleUrl('../convex/projectHostedLandingStore.ts'));
    const { randomUUID } = await import('node:crypto');
    const f = await finishFixture(t);
    const initial = await f.enqueue(
      f.request({ finish: { composeOperationId: f.selection.request.operationId, after: null } }),
    );
    let random = seed,
      reserved = null,
      installed = 0;
    const kinds = [
      'install',
      'platform-retry',
      'invalidate',
      'stale-cancel',
      'conflict-retain',
      'reserve',
      'install-finish',
    ];
    const seen = new Set();
    for (let step = 0; step < 80; step++) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      const kind = kinds[random % kinds.length];
      seen.add(kind);
      await f.transaction(
        `attempt-model-${kind}`,
        {
          _handler: async ctx => {
            const { row, state } = await store.loadLanding(ctx, {
              projectId: f.projectId,
              submissionId: initial.id,
            });
            if (kind === 'reserve') {
              reserved ??= await store.forkLandingAttempt(ctx, state, forkCause);
              return;
            }
            const parent = await store.loadLandingAttempt(ctx, {
              projectId: f.projectId,
              attemptId: state.attemptId,
            });
            const identity = await store.forkLandingAttempt(
              ctx,
              state,
              forkCause,
              kind === 'install-finish' ? (reserved ?? undefined) : undefined,
            );
            if (kind === 'install-finish' && reserved) {
              assert.equal(identity.id, reserved.id, 'source identity survives intervening forks');
              reserved = null;
              installed++;
            }
            const next = {
              ...parent,
              ...identity,
              operations: { check: randomUUID(), accept: randomUUID() },
            };
            await store.insertLandingAttempt(ctx, next);
            await store.writeLanding(
              ctx,
              row,
              { ...state, attemptId: next.id, version: state.version + 1 },
              false,
            );
          },
        },
        {},
      );
      const attempts = ordinals(f, initial.id);
      assert.deepEqual(
        attempts.map(a => a.number),
        Array.from({ length: attempts.length }, (_, n) => n),
      );
      assert.equal(new Set(attempts.map(a => a.id)).size, attempts.length);
      for (let n = 1; n < attempts.length; n++) assert.equal(attempts[n].parentAttemptId, attempts[n - 1].id);
    }
    assert.equal(seen.size, kinds.length);
    assert(installed > 0, 'the sequence installs reserved finishes after other transitions');
  });
