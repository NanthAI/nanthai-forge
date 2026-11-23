// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateSourceRecipeFixture } from './state-source-recipe-fixture.mjs';
import { temporaryDirectory } from '../scripts/test-temp.mjs';
import { materializeActionsSource } from '../dist/hosted-actions-job-source.js';
import { digest } from '../dist/hash.js';
import { expandSourceGrants } from '../dist/source-grant-wire.js';

for (const count of [1, 3, 24])
  test(`cold legacy preparation for ${count} large recipes stays at two HTTP rounds and seven mutations`, async t => {
    const f = await stateSourceRecipeFixture(t, count),
      root = temporaryDirectory(t, 'forge-recipe-preparation-'),
      cache = join(root, 'objects');
    mkdirSync(cache);
    const source = f.client.transport(cache);
    await source.resolveHeads([f.s.state.sha256]);
    await source.selectState(f.s.state.sha256, true);
    await source.prepareRecipes(f.files.map(file => file.blob));
    assert.equal(f.rounds.length, 2, 'no per-owner recipe, tree or leaf HTTP rounds');
    assert.equal(f.calls.length, 7, 'one bootstrap plus two access fences and four catalog frontiers');
    assert.equal(f.calls.filter(call => call.name === 'projectStateSourceSelection:runner').length, 2);
    assert(f.rounds.reduce((sum, row) => sum + row.dbReadBytes, 0) < 128 * 1024);
    assert(f.rounds.reduce((sum, row) => sum + row.replyBytes, 0) < 128 * 1024);
    assert.equal(f.r2.requests.length, 1 + 2 * count, 'State and verified recipe/tree metadata only');
    assert(
      f.rounds.reduce((sum, row) => sum + row.r2Bytes, 0) < 32 * 1024,
      'no logical binary bodies in preparation',
    );
    // The original State and recipe identities still produce the exact files through normal workers.
    mkdirSync(join(root, 'cold-objects'));
    await materializeActionsSource(f.client, join(root, 'candidate'), join(root, 'cold-objects'));
    for (const file of f.files)
      assert.equal(digest(readFileSync(join(root, 'candidate', file.path))), file.blob);
  });

test('prepared legacy recipes recheck current run access after metadata IO', async t => {
  const f = await stateSourceRecipeFixture(t, 3),
    request = globalThis.fetch;
  let withdrew = false;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const response = await request(url, init);
    if (!withdrew && new Headers(init?.headers).has('range')) {
      withdrew = true;
      f.s.patch('hostedProjects', f.s.projectId, { owner: 'different-owner' });
    }
    return response;
  });
  await assert.rejects(
    f.source({
      state: f.s.state.sha256,
      closures: true,
      preparation: true,
      digests: [f.s.state.sha256],
      all: true,
    }),
    error => (error.data?.code ?? error.code) === 'PROJECT_UNAVAILABLE',
  );
  assert(withdrew);
});

test('prepared legacy recipes never authorize catalog history outside the selected State', async t => {
  const f = await stateSourceRecipeFixture(t, 1),
    outside = f.s.put('unselected history');
  await assert.rejects(
    f.source({ state: f.s.state.sha256, closures: true, preparation: true, digests: [outside.sha256] }),
    error => error.code === 'SOURCE_UNAVAILABLE',
  );
  const result = expandSourceGrants(
    await f.source({
      state: f.s.state.sha256,
      closures: true,
      preparation: true,
      digests: [f.files[0].blob],
    }),
  );
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].descriptor.object.sha256, f.files[0].blob);
  assert(result.rows[0].closure.every(leaf => leaf.digest !== outside.sha256));
});

test('prepared legacy recipe metadata corruption never becomes a leaf grant', async t => {
  const f = await stateSourceRecipeFixture(t, 1),
    request = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const response = await request(url, init);
    if (!new Headers(init?.headers).has('range')) return response;
    const bytes = Buffer.from(await response.arrayBuffer());
    bytes[0] ^= 1;
    return new Response(bytes, { status: response.status, headers: response.headers });
  });
  await assert.rejects(
    f.source({ state: f.s.state.sha256, closures: true, preparation: true, digests: [f.files[0].blob] }),
    error => error.code === 'SOURCE_HASH_MISMATCH',
  );
});

test('legacy State windows without closure negotiation retain ordinary recipe traversal', async t => {
  const f = await stateSourceRecipeFixture(t, 1);
  const result = expandSourceGrants(
    await f.source({
      state: f.s.state.sha256,
      digests: [f.s.state.sha256],
      all: true,
    }),
  );
  assert.equal(result.rows[0].closure, undefined, 'older all-State readers never receive a new projection');
  assert.equal(f.calls.length, 3, 'no speculative preparation for an older reader');
  // An older server ignores the existing optional flag; the new client must still reconstruct bytes.
  t.mock.method(f.client, 'call', async command =>
    command.bound
      ? f.heads()
      : expandSourceGrants(await f.source({ ...command, closures: undefined, preparation: undefined })),
  );
  const root = temporaryDirectory(t, 'forge-old-recipe-reader-'),
    cache = join(root, 'objects');
  mkdirSync(cache);
  await materializeActionsSource(f.client, join(root, 'candidate'), cache);
  assert.equal(digest(readFileSync(join(root, 'candidate', f.files[0].path))), f.files[0].blob);
});

test('24/24/6 MiB imported binaries prepare 216 exact packed leaves in one shared State window', async t => {
  const f = await stateSourceRecipeFixture(t, 3, {
    leaves: [96, 96, 24],
    leafBytes: 256 * 1024,
    packedLeaves: true,
  });
  const root = temporaryDirectory(t, 'forge-large-recipe-preparation-'),
    cache = join(root, 'objects');
  mkdirSync(cache);
  await materializeActionsSource(f.client, join(root, 'candidate'), cache);
  assert.equal(f.rounds.length, 2);
  assert.equal(f.calls.length, 8, 'one additional shared frontier for the second metadata level');
  assert(f.rounds.reduce((sum, row) => sum + row.dbReadBytes, 0) < 512 * 1024);
  assert(
    f.rounds.reduce((sum, row) => sum + row.r2Bytes, 0) < 128 * 1024,
    'preparation reads metadata, not file bodies',
  );
  for (const file of f.files)
    assert.equal(digest(readFileSync(join(root, 'candidate', file.path))), file.blob);
});

test('recipes beyond the inline closure bound reuse verified descriptors without per-owner rounds', async t => {
  const f = await stateSourceRecipeFixture(t, 3, { leaves: 101, leafBytes: 64 * 1024, packedLeaves: true });
  const root = temporaryDirectory(t, 'forge-large-recipe-descriptors-'),
    cache = join(root, 'objects');
  mkdirSync(cache);
  await materializeActionsSource(f.client, join(root, 'candidate'), cache);
  assert.equal(f.rounds.length, 2);
  assert.equal(f.calls.length, 8, 'metadata depth adds a shared frontier, never a round per owner');
  for (const file of f.files)
    assert.equal(digest(readFileSync(join(root, 'candidate', file.path))), file.blob);
});
