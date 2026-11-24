// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { fixture, NOW } from './public-discovery-fixture.mjs';

const { readSlice } = await import(moduleUrl('../convex/publicDirectorySource.ts'));
const { buildPublicDirectory } = await import(moduleUrl('../convex/publicDirectoryProjection.ts'));
const { collectPublicSearch, readSearchShard } = await import(moduleUrl('../src/public-explore-pages.ts'));
const deployment = 'https://example.convex.cloud';
const fence = {
  v: 1,
  state: 'public',
  generation: Number.MAX_SAFE_INTEGER,
  asOf: Number.MAX_SAFE_INTEGER,
  contentHash: 'a'.repeat(64),
};
const row = (index, long = false) => ({
  id: String(index).padStart(32, '0'),
  handle: long ? 'a'.repeat(38) : `owner-${Math.floor(index / 4)}`,
  slug: long ? `${'x'.repeat(94)}${String(index).padStart(6, '0')}` : `project-${index}`,
  name: long ? '🌊'.repeat(100) : `Project ${index}`,
  since: 1795530000000 + index,
  stars: index % 104,
  landings: index % 19,
  main: 'passing',
  days: [1, 2, 3, 0, 5, 2, 9],
});
const serialized = pages => pages.map(page => Buffer.byteLength(JSON.stringify({ ...page, ...fence })));

test('an Explore page clips only its display name and packs whole UTF-8 rows under 16 KiB', () => {
  const rows = Array.from({ length: 51 }, (_, index) => row(index, true));
  const { orders, index } = buildPublicDirectory(rows, deployment);
  for (const { pages } of orders) {
    assert.ok(pages[0].projects.length < 50 && pages[0].more);
    assert.ok(serialized(pages).every(size => size <= 16 * 1024));
    assert.equal(pages[1].start, pages[0].projects.length);
    assert.equal(pages.flatMap(page => page.projects).length, rows.length);
    assert.ok(
      pages[0].projects.every(
        project => /^🌊+…$/u.test(project.name) && Buffer.byteLength(project.name) <= 80,
      ),
    );
  }
  assert.equal(index[0].projects[0][1], rows[0].slug);
  assert.match(rows[0].name, /^🌊{100}$/u);
});

test('the directory rebuild applies current visibility even when its indexed listing is stale', async () => {
  const { ctx, tables } = fixture();
  const slice = () => readSlice._handler(ctx, { now: NOW, cursor: null });
  const project = tables.hostedProjects.get('project');
  assert.deepEqual(
    (await slice()).projects.map(row => `${row.handle}/${row.slug}`),
    ['ada/atlas'],
  );
  project.removal = 'trashed';
  assert.deepEqual((await slice()).projects, []);
  delete project.removal;
  project.visibility = 'private';
  assert.deepEqual((await slice()).projects, []);
  project.visibility = 'public';
  tables.boardSwitches.set('switch', { _id: 'switch', key: 'account:owner', off: true });
  assert.deepEqual((await slice()).projects, []);
  tables.boardSwitches.clear();
  const account = tables.forgeAccounts.get('acct');
  account.closing = { operationId: 'close' };
  assert.deepEqual((await slice()).projects, []);
  delete account.closing;
  account.handle = 'renamed';
  project.slug = 'renamed-atlas';
  assert.deepEqual(
    (await slice()).projects.map(row => `${row.handle}/${row.slug}`),
    ['renamed/renamed-atlas'],
  );
  tables.forgeAccounts.clear();
  assert.deepEqual((await slice()).projects, []);
});

for (const size of [1284, 12840])
  test(`full search reads compact shards at ${size} synthetic projects`, async t => {
    const rows = Array.from({ length: size }, (_, index) => row(index));
    const { orders, index } = buildPublicDirectory(rows, deployment);
    const read = async number => readSearchShard(index[number - 1]);
    const results = await collectPublicSearch(deployment, read);
    assert.equal(results.length, size);
    const shardSizes = serialized(index);
    assert.ok(shardSizes.every(bytes => bytes <= 64 * 1024));
    assert.ok(index.length <= Math.ceil(size / 1284) * 2);
    t.diagnostic(
      `search shards=${index.length}, max bytes=${Math.max(...shardSizes)}, Explore page objects=${orders.reduce((sum, order) => sum + order.pages.length, 0)}`,
    );
    if (index.length > 1)
      await assert.rejects(
        collectPublicSearch(deployment, async number => {
          const page = await read(number);
          return number > 1 ? { ...page, total: page.total + 1 } : page;
        }),
        /index changed/,
      );
  });
