// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
const lookup = (ctx, _projectId, key) =>
  ctx.db
    .query('projectObjectReceipts')
    .withIndex('by_key', q => q.eq('key', key))
    .unique();
const setup = () => {
  const f = lanesFixture(),
    projectId = f.insert('hostedProjects', {
      key: 'synthetic',
      name: 'Synthetic',
      owner: 'owner',
      currentBackup: null,
      revision: 0,
    });
  return { f, projectId };
};

test('snapshot equality reads keep same-transaction insert, replacement and deletion visible with unchanged read charges', async () => {
  const { f, projectId } = setup();
  await f.call(
    'read your own writes',
    {
      _handler: async ctx => {
        assert.equal(await lookup(ctx, projectId, 'same'), null);
        const id = await ctx.db.insert('projectObjectReceipts', { projectId, key: 'same', value: 'first' });
        assert.equal((await lookup(ctx, projectId, 'same')).value, 'first');
        await ctx.db.patch(id, { value: 'second' });
        assert.equal((await lookup(ctx, projectId, 'same')).value, 'second');
        await ctx.db.delete(id);
        assert.equal(await lookup(ctx, projectId, 'same'), null);
      },
    },
    {},
  );
  assert.equal(f.counts[0].ranges, 4);
  assert.equal(f.counts[0].documents, 4, 'missing keys remain metered');
});

test('a concurrent matching insert still invalidates an absent-key snapshot and retries its exact transaction', async () => {
  const { f, projectId } = setup();
  let release,
    read,
    attempts = 0;
  const held = new Promise(resolve => {
      release = resolve;
    }),
    ready = new Promise(resolve => {
      read = resolve;
    });
  const result = f.call(
    'absent-key OCC',
    {
      _handler: async ctx => {
        attempts++;
        const found = await lookup(ctx, projectId, 'racing');
        if (attempts === 1) {
          read();
          await held;
        }
        return found?.value ?? 'absent';
      },
    },
    {},
  );
  await ready;
  await f.call(
    'concurrent insert',
    {
      _handler: ctx =>
        ctx.db.insert('projectObjectReceipts', {
          projectId,
          key: 'racing',
          value: 'peer',
        }),
    },
    {},
  );
  release();
  assert.equal(await result, 'peer');
  assert.equal(attempts, 2);
  assert.equal(f.counts.filter(row => row.name === 'absent-key OCC').length, 2);
});

test('a retained observer read set rechecks later matching writes instead of reusing its prior equality result', async () => {
  const { f, projectId } = setup();
  await f.call('observerBudgetPage', { _handler: ctx => lookup(ctx, projectId, 'later') }, {});
  const unchanged = f.readSet();
  assert(unchanged());
  f.insert('projectObjectReceipts', { projectId, key: 'later', value: 'new advice' });
  assert.equal(unchanged(), false, 'later matching advice invalidates the retained read set');
});
