// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { physicalStateSourceFixture } from './physical-state-source-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { digest } from '../dist/hash.js';
import { expandSourceGrants } from '../dist/source-grant-wire.js';
import { verifyPackRange } from '../dist/object-pack-range.js';
const api = await import(moduleUrl('../convex/projectStateSourceApi.ts'));
const downloads = await import(moduleUrl('../convex/projectObjectDownloads.ts'));
const { readSignedPhysical } = await import(moduleUrl('../convex/projectStateSourceReader.ts'));
const nonceA = '00000000-0000-4000-8000-000000000001',
  nonceB = '00000000-0000-4000-8000-000000000002';
const key = (f, sha, nonce = nonceA) => `v1/p/${f.s.projectId}/o/${sha}/u/${nonce}`;
function put(f, bytes, nonce = nonceA) {
  const pin = { sha256: digest(bytes), size: bytes.length },
    r2Key = key(f, pin.sha256, nonce);
  f.r2.objects.set('/synthetic/' + r2Key, bytes);
  f.s.insert('projectObjects', {
    projectId: f.s.projectId,
    digest: pin.sha256,
    size: pin.size,
    nonce: 'synthetic',
    removed: false,
    sourceReferenced: true,
    location: 'r2',
    r2Committed: true,
    r2Key,
  });
  return pin;
}
function missingRoot(f) {
  const row = [...f.s.tables.projectObjects.values()].find(row => row.digest === f.s.state.sha256);
  f.s.patch('projectObjects', row._id, { statePhysical: undefined, stateGeneration: 1 });
}
test('clone State catalog fallback reads a stored raw nonce member instead of reporting it unavailable', async t => {
  const f = await physicalStateSourceFixture(t, 2),
    pin = put(f, Buffer.from('source 0'));
  missingRoot(f);
  const wire = await api.read._handler(f.ctx, {
    projectId: f.s.projectId,
    state: f.s.state.sha256,
    digests: [pin.sha256],
    version: 2,
  });
  const reply = expandSourceGrants(JSON.parse(wire));
  assert.equal(reply.mode, 'catalog');
  const row = reply.rows[0];
  assert(new URL(row.url).pathname.endsWith('/' + key(f, pin.sha256)));
  assert.equal(Buffer.from(await readSignedPhysical(pin, row.url)).toString(), 'source 0');
  const signed = await f.s.transaction('nonce-general-sign', downloads.signDownloads, {
    projectId: f.s.projectId,
    digests: [pin.sha256],
  });
  assert.equal(signed.length, 1);
  assert(new URL(signed[0].url).pathname.endsWith('/' + key(f, pin.sha256)));
  const lane = await f.s.transaction('nonce-lane-page', downloads.lanePage, {
    projectId: f.s.projectId,
    digests: [pin.sha256],
    signed: true,
  });
  assert.equal(lane.length, 1);
  assert(new URL(lane[0].url).pathname.endsWith('/' + key(f, pin.sha256)));
});
test('catalog runs keep identical pack digests under different nonce keys separate and verify exact member bytes', async t => {
  const f = await physicalStateSourceFixture(t, 4),
    bodies = f.entries.map((_entry, i) => Buffer.from(`source ${i}`)),
    body = Buffer.concat(bodies),
    pack = digest(body);
  for (const nonce of [nonceA, nonceB]) f.r2.objects.set('/synthetic/' + key(f, pack, nonce), body);
  let offset = 0;
  for (const [i, entry] of f.entries.entries()) {
    f.s.insert('projectObjects', {
      projectId: f.s.projectId,
      digest: entry.sha256,
      size: entry.size,
      nonce: 'synthetic',
      removed: false,
      sourceReferenced: true,
      location: 'r2',
      r2Committed: true,
      r2Key: key(f, pack, i < 2 ? nonceA : nonceB),
      pack: { digest: pack, size: body.length, offset },
    });
    offset += entry.size;
  }
  missingRoot(f);
  const wire = await api.read._handler(f.ctx, {
    projectId: f.s.projectId,
    state: f.s.state.sha256,
    digests: f.entries.map(entry => entry.sha256),
    runs: true,
    version: 2,
  });
  const reply = expandSourceGrants(JSON.parse(wire)),
    runs = reply.rows.filter(row => row.run?.url);
  assert.equal(runs.length, 2, 'one exact run for each immutable nonce key');
  assert.deepEqual(runs.map(row => new URL(row.run.url).pathname.split('/u/')[1]).sort(), [nonceA, nonceB]);
  for (const first of runs) {
    const run = first.run,
      response = await fetch(run.url, {
        headers: { range: `bytes=${run.offset}-${run.offset + run.length - 1}` },
      });
    verifyPackRange(response, { offset: run.offset, total: run.total }, run.length);
    const bytes = new Uint8Array(await response.arrayBuffer());
    for (const row of reply.rows.filter(row => row.run?.id === run.id)) {
      const part = bytes.subarray(row.range.offset - run.offset, row.range.offset - run.offset + row.size);
      assert.equal(digest(part), row.digest);
    }
  }
});
test('a selected recipe reaches packed nonce metadata and raw nonce leaves with full hash and membership checks', async t => {
  const f = await physicalStateSourceFixture(t, 2),
    object = f.entries[0],
    leaves = [put(f, Buffer.from('sour')), put(f, Buffer.from('ce 0'), nonceB)];
  missingRoot(f);
  const pageBytes = Buffer.from(
      JSON.stringify({
        kind: 'forge-byte-tree',
        schema: 1,
        children: leaves.map(pin => ({ ...pin, height: 0, length: pin.size })),
      }),
    ),
    page = put(f, pageBytes);
  const recipeBytes = Buffer.from(
      JSON.stringify({
        kind: 'forge-object-recipe',
        schema: 1,
        object: { sha256: object.sha256, size: object.size },
        tree: { ...page, height: 1, length: object.size },
      }),
    ),
    recipe = { sha256: digest(recipeBytes), size: recipeBytes.length };
  const packed = Buffer.concat([
      Buffer.from('unselected prefix'),
      recipeBytes,
      Buffer.from('unselected suffix'),
    ]),
    carrier = digest(packed);
  f.r2.objects.set('/synthetic/' + key(f, carrier), packed);
  f.s.insert('projectObjects', {
    projectId: f.s.projectId,
    digest: recipe.sha256,
    size: recipe.size,
    nonce: 'synthetic',
    removed: false,
    sourceReferenced: true,
    location: 'r2',
    r2Committed: true,
    r2Key: key(f, carrier),
    pack: { digest: carrier, size: packed.length, offset: 17 },
  });
  f.s.insert('projectObjects', {
    projectId: f.s.projectId,
    digest: object.sha256,
    size: object.size,
    nonce: 'synthetic',
    removed: false,
    sourceReferenced: true,
    recipe: { digest: recipe.sha256, size: recipe.size },
  });
  const logical = await f.s.transaction('nonce-recipe-description', downloads.describe, {
    projectId: f.s.projectId,
    digests: [object.sha256],
    signed: true,
  });
  assert(new URL(logical[0].recipe.url).pathname.endsWith('/' + key(f, carrier)));
  const wire = await api.read._handler(f.ctx, {
    projectId: f.s.projectId,
    state: f.s.state.sha256,
    object: object.sha256,
    digests: leaves.map(pin => pin.sha256),
    version: 2,
  });
  const reply = expandSourceGrants(JSON.parse(wire)),
    parts = [];
  for (const [i, row] of reply.rows.entries()) parts.push(await readSignedPhysical(leaves[i], row.url));
  assert.equal(digest(Buffer.concat(parts)), object.sha256);
  await assert.rejects(
    api.read._handler(f.ctx, {
      projectId: f.s.projectId,
      state: f.s.state.sha256,
      object: object.sha256,
      digests: [digest('unselected leaf')],
      version: 2,
    }),
    error => (error.code ?? error.data?.code) === 'SOURCE_UNAVAILABLE',
  );
});
test('nonce support still refuses another project, another digest and malformed key suffixes', async t => {
  const f = await physicalStateSourceFixture(t, 1),
    pin = put(f, Buffer.from('source 0'));
  const row = [...f.s.tables.projectObjects.values()].find(row => row.digest === pin.sha256);
  for (const r2Key of [
    key({ ...f, s: { projectId: 'other' } }, pin.sha256),
    key(f, digest('other')),
    key(f, pin.sha256) + '/suffix',
    key(f, pin.sha256, 'bad'),
  ]) {
    f.s.patch('projectObjects', row._id, { r2Key });
    await assert.rejects(
      f.s.transaction('nonce-bad-describe', downloads.describe, {
        projectId: f.s.projectId,
        digests: [pin.sha256],
        signed: true,
      }),
      error => (error.code ?? error.data?.code) === 'INVALID_WORK_BACKUP',
    );
    assert.deepEqual(
      await f.s.transaction('nonce-bad-sign', downloads.signDownloads, {
        projectId: f.s.projectId,
        digests: [pin.sha256],
      }),
      [],
    );
  }
});
