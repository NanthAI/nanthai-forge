import { commitValidatedCheckpoint } from './project-exchange-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { fixture, modules, upload } from './project-exchange-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { buildObjectRecipe } from '../dist/object-chunks.js';
import { digest } from '../dist/hash.js';
import { readHosted } from './hosted-read.mjs';
const recipes = await import(moduleUrl('../convex/projectObjectRecipes.ts'));
const recipeStore = await import(moduleUrl('../convex/projectObjectRecipeStore.ts'));
const { purgeExchangeObjects } = await import(moduleUrl('../convex/projectObjectLifecycle.ts'));
const { objectRange } = await import(moduleUrl('../convex/projectObjectContent.ts'));
const { exchangeObjectReader } = await import(moduleUrl('../convex/projectExchangeReader.ts'));
const code = expected => error => (error.data?.code ?? error.code) === expected;
function setup() {
  const s = fixture(),
    run = s.ctx.runQuery;
  s.ctx.runQuery =
    s.ctx.runMutation =
    s.ctx.runAction =
      (ref, args) => {
        const [name, method] = getFunctionName(ref).split(':');
        return name === 'projectObjectRecipeStore'
          ? recipeStore[method]._handler(s.ctx, args)
          : name === 'projectObjectRecipes'
            ? recipes[method]._handler(s.ctx, args)
            : run(ref, args);
      };
  return s;
}
async function prepare(s, bytes, projectId = 'project') {
  const built = buildObjectRecipe(bytes);
  for (const content of built.objects.values()) await upload(s, content, projectId);
  const root = await upload(s, built.bytes, projectId);
  return {
    ...built,
    input: {
      projectId,
      digest: digest(bytes),
      size: bytes.length,
      recipeDigest: root.sha256,
      recipeSize: root.size,
    },
  };
}
const row = (s, sha, projectId = 'project') =>
  [...s.tables.projectObjects.values()].find(item => item.digest === sha && item.projectId === projectId);

test('recipe binds original logical bytes; direct-download redirects, internal ranges and retry retain exact content without full duplicate storage', async () => {
  const s = setup(),
    bytes = randomBytes(5 * 1024 * 1024 + 3),
    built = await prepare(s, bytes);
  await recipes.complete._handler(s.ctx, built.input);
  const bound = row(s, built.input.digest);
  assert(bound.recipe);
  assert.equal(bound.storageId, undefined);
  assert(
    ![...s.files.values()].some(file => file.metadata.size === bytes.length),
    'no reconstructed complete object stored',
  );
  assert.deepEqual(
    await modules.projectObjects.missing._handler(s.ctx, {
      projectId: 'project',
      objects: [{ digest: digest(bytes), size: bytes.length }],
    }),
    [],
  );
  const original = structuredClone(bound),
    count = s.files.size;
  await recipes.complete._handler(s.ctx, built.input);
  assert.deepEqual(bound, original);
  assert.equal(s.files.size, count);
  for (const offset of [0, 100, 2 * 1024 * 1024, bytes.length - 1]) {
    const result = await modules.projectExchangeActions.downloadPart._handler(s.ctx, {
      projectId: 'project',
      digest: digest(bytes),
      offset,
    });
    assert.deepEqual(result, { direct: true, digest: digest(bytes), size: bytes.length });
    assert.deepEqual(
      Buffer.from(await objectRange(s.ctx, bound, 'owner', offset)),
      bytes.subarray(offset, Math.min(bytes.length, offset + 2 * 1024 * 1024)),
    );
  }
  assert.deepEqual(
    await exchangeObjectReader(s.ctx).read('project', 'owner', [
      { sha256: digest(bytes), size: bytes.length },
    ]),
    [bytes],
  );
  const small = randomBytes(1300000),
    second = await prepare(s, small);
  await recipes.complete._handler(s.ctx, second.input);
  const result = await modules.projectExchangeActions.downloadBatch._handler(s.ctx, {
    projectId: 'project',
    digests: [digest(small)],
  });
  assert.deepEqual(result, [{ direct: true, digest: digest(small), size: small.length }]);
  const response = await recipes.representation._handler(s.ctx, {
    projectId: 'project',
    digest: digest(bytes),
    size: bytes.length,
  });
  assert.deepEqual(response.recipe, bound.recipe);
});

test('missing, corrupt and whole-digest mismatch recipe content never creates a logical binding', async () => {
  for (const fault of ['missing', 'corrupt', 'wrong hash']) {
    const s = setup(),
      bytes = randomBytes(3 * 1024 * 1024),
      built = await prepare(s, bytes);
    const leaf = [...built.objects].find(([, value]) => value.length > 10000),
      leafRow = row(s, leaf[0]);
    if (fault === 'missing') s.files.delete(leafRow.storageId);
    if (fault === 'corrupt') s.files.get(leafRow.storageId).blob = new Blob(['changed']);
    if (fault === 'wrong hash') {
      const changed = { ...built.recipe, object: { ...built.recipe.object, sha256: 'f'.repeat(64) } };
      const root = await upload(s, Buffer.from(JSON.stringify(changed)));
      built.input.digest = changed.object.sha256;
      built.input.recipeDigest = root.sha256;
      built.input.recipeSize = root.size;
    }
    await assert.rejects(recipes.complete._handler(s.ctx, built.input), code('INVALID_WORK_BACKUP'));
    assert.equal(row(s, built.input.digest), undefined);
  }
});

test('current owner/contributor authority and final project state are checked; readers cannot write or inherit obsolete access', async () => {
  const s = setup(),
    bytes = randomBytes(3 * 1024 * 1024),
    built = await prepare(s, bytes);
  s.caller('stranger');
  await assert.rejects(recipes.complete._handler(s.ctx, built.input), code('PROJECT_UNAVAILABLE'));
  s.caller('owner');
  const run = s.ctx.runMutation;
  s.ctx.runMutation = async (ref, args) => {
    if (getFunctionName(ref) === 'projectObjectRecipeStore:bind')
      s.tables.hostedProjects.get('project').removal = 'deleting';
    return run(ref, args);
  };
  await assert.rejects(recipes.complete._handler(s.ctx, built.input), code('PROJECT_UNAVAILABLE'));
  assert.equal(row(s, digest(bytes)), undefined);
  delete s.tables.hostedProjects.get('project').removal;
  s.ctx.runMutation = run;
  await recipes.complete._handler(s.ctx, built.input);
  s.tables.projectContributors.set('grant', { _id: 'grant', projectId: 'project', contributor: 'reader' });
  s.caller('reader');
  await recipes.complete._handler(s.ctx, built.input);
  s.tables.projectContributors.delete('grant');
  s.tables.projectReaders.set('read-grant', { _id: 'read-grant', projectId: 'project', reader: 'reader' });
  await assert.rejects(recipes.complete._handler(s.ctx, built.input), code('PROJECT_UNAVAILABLE'));
  const reader = exchangeObjectReader(s.ctx);
  assert.deepEqual(await reader.read('project', 'reader', [{ sha256: digest(bytes), size: bytes.length }]), [
    bytes,
  ]);
  s.tables.projectReaders.delete('read-grant');
  await assert.rejects(
    reader.read('project', 'reader', [{ sha256: digest(bytes), size: bytes.length }]),
    code('PROJECT_UNAVAILABLE'),
  );
  s.caller('owner');
  s.tables.hostedProjects.set('other', { ...s.tables.hostedProjects.get('project'), _id: 'other' });
  await assert.rejects(
    recipes.complete._handler(s.ctx, { ...built.input, projectId: 'other' }),
    code('INVALID_WORK_BACKUP'),
  );
});

test('raw/recipe completion races preserve the first verified binding and reconcile late raw uploads', async () => {
  for (const rawFirst of [false, true]) {
    const s = setup(),
      bytes = randomBytes(3 * 1024 * 1024),
      built = await prepare(s, bytes);
    const prepared = await modules.projectObjects.prepare._handler(s.ctx, {
      projectId: 'project',
      digest: digest(bytes),
      size: bytes.length,
    });
    const storageId = await s.ctx.storage.store(new Blob([bytes], { type: prepared.contentType }));
    if (rawFirst) await modules.projectObjects.complete._handler(s.ctx, { id: prepared.id, storageId });
    await recipes.complete._handler(s.ctx, built.input);
    await modules.projectObjects.complete._handler(s.ctx, { id: prepared.id, storageId });
    const bound = row(s, digest(bytes));
    assert.equal(!!bound.storageId, rawFirst);
    assert.equal(!!bound.recipe, !rawFirst);
    assert.equal(s.files.has(storageId), rawFirst);
    const reconciled = await modules.projectObjects.reconcile._handler(s.ctx, {
      id: prepared.id,
      cursor: null,
    });
    assert.equal(reconciled.stored, true);
    const again = await modules.projectObjects.prepare._handler(s.ctx, {
      projectId: 'project',
      digest: digest(bytes),
      size: bytes.length,
    });
    assert.equal(again.stored, true);
    assert.equal(again.uploadUrl, undefined);
  }
});

test('project cleanup removes recipe/chunk bindings without deleting another project contents', async () => {
  const s = setup(),
    bytes = randomBytes(3 * 1024 * 1024),
    built = await prepare(s, bytes);
  await recipes.complete._handler(s.ctx, built.input);
  s.tables.hostedProjects.set('other', { ...s.tables.hostedProjects.get('project'), _id: 'other' });
  const other = await prepare(s, bytes, 'other');
  await recipes.complete._handler(s.ctx, other.input);
  const otherIds = [...s.tables.projectObjects.values()]
    .filter(row => row.projectId === 'other')
    .map(row => row.storageId)
    .filter(Boolean);
  const project = s.tables.hostedProjects.get('project');
  project.removal = 'deleting';
  while (!(await purgeExchangeObjects(s.ctx, project))) {}
  assert(
    [...s.tables.projectObjects.values()]
      .filter(row => row.projectId === 'project')
      .every(row => row.removed && !row.storageId && !row.recipe),
  );
  assert(otherIds.every(id => s.files.has(id)));
  assert.equal(s.files.size, otherIds.length);
  assert.deepEqual(
    await exchangeObjectReader(s.ctx).read('other', 'owner', [{ sha256: digest(bytes), size: bytes.length }]),
    [bytes],
  );
});

test('recipe ranges recheck current chunk bytes and access after transfer, including previously successful readers', async () => {
  const s = setup(),
    bytes = randomBytes(3 * 1024 * 1024),
    built = await prepare(s, bytes);
  await recipes.complete._handler(s.ctx, built.input);
  const reader = exchangeObjectReader(s.ctx),
    pin = { sha256: digest(bytes), size: bytes.length };
  await reader.read('project', 'owner', [pin]);
  const leaf = [...built.objects].find(([, content]) => content.length > 10000),
    bound = row(s, leaf[0]),
    saved = s.files.get(bound.storageId);
  s.files.delete(bound.storageId);
  await assert.rejects(reader.read('project', 'owner', [pin]), code('INVALID_WORK_BACKUP'));
  s.files.set(bound.storageId, saved);
  s.tables.projectContributors.set('grant', { _id: 'grant', projectId: 'project', contributor: 'reader' });
  s.caller('reader');
  const get = s.ctx.storage.get;
  s.ctx.storage.get = async id => {
    const value = await get(id);
    if (id === bound.storageId) s.tables.projectContributors.delete('grant');
    return value;
  };
  await assert.rejects(objectRange(s.ctx, row(s, pin.sha256), 'reader', 0), code('PROJECT_UNAVAILABLE'));
});

test('a retained recipe-bound logical manifest opens Work without mislabeling recipe storage as original bytes', async t => {
  const { checkpoint } = await import('./project-exchange-fixture.mjs');
  const { randomUUID } = await import('node:crypto');
  const s = setup(),
    base = await checkpoint(t, s);
  const manifest = { ...base.manifest, coverage: 'Retained metadata '.repeat(85000) },
    bytes = Buffer.from(JSON.stringify(manifest));
  const built = await prepare(s, bytes);
  await recipes.complete._handler(s.ctx, built.input);
  assert(row(s, digest(bytes)).recipe);
  assert.equal(row(s, digest(bytes)).storageId, undefined);
  const backupId = await commitValidatedCheckpoint(s, {
    ...base,
    manifest,
    input: { ...base.input, digest: digest(bytes), size: bytes.length },
  });
  assert.equal(s.tables.projectBackups.get(backupId).storageId, undefined);
  await modules.projectWorkActions.initialize._handler(s.ctx, {
    projectId: 'project',
    backupId,
    operationId: randomUUID(),
  });
  const work = JSON.parse(await readHosted(s.ctx, { projectId: 'project' }));
  assert.deepEqual(work.data, base.store.load());
  const downloaded = await modules.projectExchangeActions.manifest._handler(s.ctx, { backupId });
  assert.equal(downloaded.json, bytes.toString());
});

test('lost recipe completion replies reconcile the original immutable logical binding without repeating content proof', async () => {
  const s = setup(),
    bytes = randomBytes(3 * 1024 * 1024),
    built = await prepare(s, bytes),
    run = s.ctx.runMutation;
  s.ctx.runMutation = async (ref, args) => {
    const value = await run(ref, args);
    if (getFunctionName(ref) === 'projectObjectRecipeStore:bind') throw new Error('unknown reply');
    return value;
  };
  await assert.rejects(recipes.complete._handler(s.ctx, built.input));
  const bound = structuredClone(row(s, digest(bytes)));
  assert(bound.recipe);
  const before = s.reads();
  s.ctx.runMutation = run;
  await recipes.complete._handler(s.ctx, built.input);
  assert.equal(s.reads(), before);
  assert.deepEqual(row(s, digest(bytes)), bound);
  s.caller('stranger');
  await assert.rejects(recipes.complete._handler(s.ctx, built.input), code('PROJECT_UNAVAILABLE'));
});

test('warm recipe reads reuse immutable leaves while rechecking current closure and authority', async () => {
  const s = setup(),
    bytes = randomBytes(600000),
    built = await prepare(s, bytes);
  await recipes.complete._handler(s.ctx, built.input);
  const pin = { sha256: digest(bytes), size: bytes.length };
  const read = () => exchangeObjectReader(s.ctx, true).read('project', 'owner', [pin]);
  assert.deepEqual(await read(), [bytes]);
  const before = s.reads();
  const cached = await read();
  cached[0].fill(0);
  assert.deepEqual(await read(), [bytes]);
  assert.equal(s.reads(), before, 'warm recipe nodes and leaves need no body downloads');
  await assert.rejects(
    exchangeObjectReader(s.ctx, true).read('project', 'stranger', [pin]),
    code('PROJECT_UNAVAILABLE'),
  );
  const leaf = [...built.objects.keys()][0];
  s.files.delete(row(s, leaf).storageId);
  await assert.rejects(read(), code('INVALID_WORK_BACKUP'));
});

test('recipe validation batches descriptor frontiers and rechecks access after IO', async t => {
  const s = setup(),
    objects = new Map();
  const leaves = Array.from({ length: 128 }, (_, i) => {
    const bytes = Buffer.alloc(8192);
    bytes.writeUInt32LE(i);
    const pin = { sha256: digest(bytes), size: bytes.length };
    objects.set(pin.sha256, bytes);
    return { ...pin, height: 0, length: bytes.length };
  });
  const bytes = Buffer.concat([...objects.values()]);
  const index = Buffer.from(JSON.stringify({ kind: 'forge-byte-tree', schema: 1, children: leaves }));
  const tree = { sha256: digest(index), size: index.length, height: 1, length: bytes.length };
  objects.set(tree.sha256, index);
  const recipeBytes = Buffer.from(
    JSON.stringify({
      kind: 'forge-object-recipe',
      schema: 1,
      object: { sha256: digest(bytes), size: bytes.length },
      tree,
    }),
  );
  for (const value of objects.values()) await upload(s, value);
  const rootPin = await upload(s, recipeBytes);
  const built = {
    objects,
    input: {
      projectId: 'project',
      digest: digest(bytes),
      size: bytes.length,
      recipeDigest: rootPin.sha256,
      recipeSize: rootPin.size,
    },
  };
  const { objectContent } = await import(moduleUrl('../convex/projectObjectContent.ts'));
  const { readObjectRecipe } = await import('../dist/object-chunks.js');
  const { internal } = await import('../convex/_generated/api.js');
  let calls = 0,
    largest = 0;
  for (const method of ['runQuery', 'runMutation']) {
    const original = s.ctx[method];
    s.ctx[method] = async (ref, args) => {
      calls++;
      largest = Math.max(largest, args.digests?.length ?? 0);
      return original(ref, args);
    };
  }
  const read = async pin => {
    const args = { projectId: 'project', actor: 'owner', digests: [pin.sha256] };
    const rows = await s.ctx.runQuery(internal.projectObjects.resolve, args);
    const value = await objectContent(s.ctx, rows[0], pin, 'owner');
    await s.ctx.runQuery(internal.projectObjects.resolve, args);
    return value;
  };
  const root = await read({ sha256: built.input.recipeDigest, size: built.input.recipeSize });
  const recipe = JSON.parse(root);
  for await (const part of readObjectRecipe(recipe, read)) void part;
  const before = calls;
  calls = 1; // Include the directly invoked outer action.
  await recipes.complete._handler(s.ctx, built.input);
  const after = calls;
  assert(largest <= 100);
  assert(after <= 12);
  assert(after < before / 10);
  t.diagnostic(
    JSON.stringify({
      beforeResolveCalls: before,
      afterCalls: after,
      physicalObjects: built.objects.size,
      maxDescriptorPage: largest,
    }),
  );
  // A cached descriptor window is reauthorized after IO before binding.
  const { recipeValidationReader } = await import(moduleUrl('../convex/projectObjectRecipeValidation.ts'));
  const reader = recipeValidationReader(s.ctx, 'project', 'owner');
  await reader.read({ sha256: built.input.recipeDigest, size: built.input.recipeSize });
  s.tables.hostedProjects.get('project').owner = 'another';
  await assert.rejects(reader.finish(), code('PROJECT_UNAVAILABLE'));
});
