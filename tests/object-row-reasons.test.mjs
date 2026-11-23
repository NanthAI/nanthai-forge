// SPDX-License-Identifier: Apache-2.0
// Item d0297b9f: catalog and point entries stay O(pages). Only a writer that changes what an
// object binds may copy an entry into a row, and the row names why; a writer that only sets a
// flag or returns an id never copies one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { moduleUrl } from './convex-module.mjs';
import { fixture } from './project-exchange-fixture.mjs';
const find = await import(moduleUrl('../convex/projectObjectFind.ts'));
const fields = await import(moduleUrl('../convex/projectObjectFields.ts'));
const objects = await import(moduleUrl('../convex/projectObjects.ts'));
const exchangeCache = await import(moduleUrl('../convex/projectExchangeCache.ts'));
const importBatch = await import(moduleUrl('../convex/projectGithubImportBatch.ts'));
const hex = value => createHash('sha256').update(String(value)).digest('hex');

/** Every objectRow caller and its writer label, by file. A new caller is a new materializing
 * writer: give it a label only when it changes the binding, else use ownRow or skip the write. */
const allowed = {
  'projectConvexSourceOutput.ts': ['source-output-encoding', 'source-output-state', 'source-state-size'],
  'projectHostedCulprit.ts': ['recovery-encoding'],
  'projectObjectFind.ts': ['purge-tombstone'],
  'projectStateGeneration.ts': ['state-generation'],
};

test('only State metadata, storage encoding and purge tombstones copy catalog entries into rows', () => {
  const found = {};
  for (const name of readdirSync(new URL('../convex/', import.meta.url))) {
    if (!name.endsWith('.ts')) continue;
    const source = readFileSync(new URL(`../convex/${name}`, import.meta.url), 'utf8');
    const calls = [...source.matchAll(/\bobjectRow\(\s*ctx,\s*[^,()]+(?:\([^()]*\))?,\s*([^)]*)\)/g)];
    const mentions =
      [...source.matchAll(/\bobjectRow\(/g)].length - (name === 'projectObjectFind.ts' ? 1 : 0);
    assert.equal(calls.length, mentions, `${name}: every objectRow call names a literal writer label`);
    if (!calls.length) continue;
    found[name] = calls.map(([, reason]) => {
      const literal = /^'([a-z-]+)'$/.exec(reason.trim())?.[1];
      assert.ok(literal && fields.objectRowReasons.includes(literal), `${name}: label ${reason}`);
      return literal;
    });
  }
  assert.deepEqual(found, allowed);
  assert.deepEqual([...new Set(Object.values(allowed).flat())].sort(), [...fields.objectRowReasons].sort());
});

test('recovery re-commits skip an entry already committed at its key instead of copying it', () => {
  // The recovery commit only sets location, key and committed: copying a stored entry that already
  // holds all three would be a flag-only materialization.
  const source = readFileSync(new URL('../convex/projectHostedCulprit.ts', import.meta.url), 'utf8');
  const call = source.indexOf("objectRow(ctx, object, 'recovery-encoding')");
  assert.match(
    source.slice(source.lastIndexOf('if (', call), call),
    /!\(object\.location === 'r2' && object\.r2Key === key && object\.r2Committed\)/,
  );
});

function catalogued() {
  const s = fixture();
  const digest = hex('catalogued'),
    size = 10;
  for (const page of find.catalogPages([{ digest, size }]))
    s.tables.projectObjectCatalog.set(`catalog-${page.first}`, {
      _id: `catalog-${page.first}`,
      _creationTime: 1,
      projectId: 'project',
      origin: 'github-import:job',
      ...page,
    });
  return { s, digest, size };
}

test('preparing a catalog-stored object answers stored with no row id and copies no row', async () => {
  const { s, digest, size } = catalogued();
  const stored = { stored: true, created: false, contentType: '' };
  const single = await objects.prepare._handler(s.ctx, { projectId: 'project', digest, size });
  assert.deepEqual(single, stored);
  const batch = await objects.prepareBatch._handler(s.ctx, {
    projectId: 'project',
    objects: [{ digest, size }],
  });
  assert.deepEqual(batch, [stored]);
  const artifact = await exchangeCache.prepare._handler(s.ctx, {
    projectId: 'project',
    actor: 'owner',
    digest,
    size,
  });
  assert.deepEqual(artifact, stored);
  const imported = await importBatch.prepare._handler(s.ctx, {
    projectId: 'project',
    actor: 'owner',
    objects: [{ digest, size }],
  });
  assert.deepEqual(imported, [{ stored: true, contentType: '' }]);
  assert.equal(s.tables.projectObjects.size, 0, 'no per-object row for an already stored entry');
  await assert.rejects(
    objects.prepareBatch._handler(s.ctx, { projectId: 'project', objects: [{ digest, size: size + 1 }] }),
    /INVALID_WORK_BACKUP/,
    'a different size still refuses against the catalog binding',
  );
});

test('objectRow stamps the copied row with its writer reason; ownRow refuses a catalog entry', async () => {
  const { s, digest } = catalogued();
  const view = await find.findObject(s.ctx, 'project', digest);
  assert.throws(
    () => find.ownRow(view),
    error => error.code === 'SOURCE_HASH_MISMATCH',
  );
  const row = await find.objectRow(s.ctx, view, 'state-generation');
  assert.equal(row.materializedBy, 'state-generation');
  assert.equal(find.ownRow(row)._id, row._id);
  assert.equal((await find.objectRow(s.ctx, row, 'recovery-encoding')).materializedBy, 'state-generation');
  assert.equal(s.tables.projectObjects.size, 1);
});
