// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { landingFixture } from './hosted-landing-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const {
  finishReadFields,
  finishReadProjection,
  finishOwnerProjection,
  finishPeerProjection,
  finishAheadQueueProjection,
} = await import(moduleUrl('../convex/projectFinishReadProjection.ts'));
const { finishReadWriter } = await import(moduleUrl('../convex/projectFinishReadWriter.ts'));
const expected = (kind, row) => [
  finishReadProjection(kind, row),
  ...(kind === 'projectHostedFinishes' ? [finishOwnerProjection(row)] : []),
  ...(kind === 'projectHostedLandingRequests' ? [finishPeerProjection(row)] : []),
  ...(kind === 'projectHostedLandingQueues' ? [finishAheadQueueProjection(row)] : []),
];
function assertProjection(f, kind, row) {
  for (const value of expected(kind, row)) {
    const saved = [...f.tables.projectFinishReadRows.values()].find(
      r => r.sourceId === row._id && r.kind === value.kind,
    );
    assert(saved, value.kind);
    assert.deepEqual(
      Object.fromEntries(Object.entries(saved).filter(([key]) => !key.startsWith('_'))),
      value,
    );
  }
}

test('no-DB handlers stay lazy and method decoration preserves the underlying writer', async () => {
  let accesses = 0;
  const lazy = finishReadWriter({
    get db() {
      accesses++;
      throw Error('synthetic forbidden DB access');
    },
  });
  assert.equal(accesses, 0);
  assert.throws(() => lazy.db.get('unused'), /forbidden DB access/);
  assert.equal(accesses, 1);
  const capabilities = { query: () => null, patch: () => null };
  const checked = finishReadWriter({ db: capabilities });
  assert('patch' in checked.db, 'mutation capability checks still see the original writer');
  delete capabilities.patch;
  assert(!('patch' in checked.db), 'a read-only port does not gain mutation capabilities');
  assert('query' in checked.db);
  const f = await landingFixture();
  const state = await f.enqueue();
  const row = [...f.tables.projectHostedLandingRequests.values()].find(r => r.submissionId === state.id);
  let patches = 0;
  await f.call(
    'decoratedWriter',
    {
      _handler: async ctx => {
        const patch = ctx.db.patch.bind(ctx.db);
        ctx.db.patch = (...args) => {
          patches++;
          return patch(...args);
        };
        await ctx.db.patch(row._id, { priorityVersion: 3 });
      },
    },
    {},
  );
  assert.equal(patches, 1);
  assertProjection(f, 'projectHostedLandingRequests', f.tables.projectHostedLandingRequests.get(row._id));
});

test('projection patches are idempotent and match recomputing the complete source row', async () => {
  const f = await landingFixture();
  await f.enqueue();
  for (const kind of Object.keys(finishReadFields)) {
    for (const row of [...f.tables[kind].values()]) {
      const field = finishReadFields[kind].find(key => row[key] !== undefined);
      const patch = { [field]: row[field] };
      await f.call('installLegacyProjection', { _handler: ctx => ctx.db.patch(row._id, patch) }, {});
      assertProjection(f, kind, f.tables[kind].get(row._id));
      const writes = f.tables.projectFinishReadRows.size;
      await f.call('sameProjection', { _handler: ctx => ctx.db.patch(row._id, patch) }, {});
      assert.equal(
        f.counts.at(-1).written.filter(t => t === 'projectFinishReadRows').length,
        0,
        'unchanged projection writes zero bytes',
      );
      assert.equal(f.tables.projectFinishReadRows.size, writes);
    }
  }
});

test('parallel same-row patches, field removal, replacement, rollback and deletion preserve the read model', async () => {
  const f = await landingFixture();
  const state = await f.enqueue();
  const original = [...f.tables.projectHostedLandingRequests.values()].find(r => r.submissionId === state.id);
  await f.call(
    'parallelPatches',
    {
      _handler: ctx =>
        Promise.all([
          ctx.db.patch(original._id, { priorityReason: 'synthetic reason' }),
          ctx.db.patch(original._id, { priorityVersion: 5 }),
          ctx.db.patch(original._id, { runnable: false }),
        ]),
    },
    {},
  );
  assertProjection(
    f,
    'projectHostedLandingRequests',
    f.tables.projectHostedLandingRequests.get(original._id),
  );
  await f.call(
    'removeField',
    { _handler: ctx => ctx.db.patch(original._id, { priorityReason: undefined }) },
    {},
  );
  assertProjection(
    f,
    'projectHostedLandingRequests',
    f.tables.projectHostedLandingRequests.get(original._id),
  );
  const before = structuredClone([...f.tables.projectFinishReadRows.values()]);
  await assert.rejects(
    f.call(
      'rollback',
      {
        _handler: async ctx => {
          await ctx.db.patch(original._id, { priorityVersion: 6 });
          throw new Error('synthetic rollback');
        },
      },
      {},
    ),
    /synthetic rollback/,
  );
  assert.deepEqual([...f.tables.projectFinishReadRows.values()], before);
  const replacement = Object.fromEntries(Object.entries(original).filter(([key]) => !key.startsWith('_')));
  await f.call('replace', { _handler: ctx => ctx.db.replace(original._id, replacement) }, {});
  assertProjection(
    f,
    'projectHostedLandingRequests',
    f.tables.projectHostedLandingRequests.get(original._id),
  );
  await f.call('delete', { _handler: ctx => ctx.db.delete(original._id) }, {});
  assert(![...f.tables.projectFinishReadRows.values()].some(r => r.sourceId === original._id));
});
