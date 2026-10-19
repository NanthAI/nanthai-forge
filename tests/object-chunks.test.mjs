// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getFunctionName } from 'convex/server';
import { buildObjectRecipe, readObjectRecipe, objectChunkBytes } from '../dist/object-chunks.js';
import { ConvexExchange } from '../dist/exchange-client.js';
import { downloadExchangeFile, exchangeRangeBytes } from '../dist/exchange-download-file.js';
import { digest } from '../dist/hash.js';
const pin = bytes => ({ sha256: digest(bytes), size: bytes.length });
function noise(size) {
  const bytes = Buffer.alloc(size);
  let state = 72413;
  for (let i = 0; i < size; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[i] = state & 255;
  }
  return bytes;
}
async function resolved(built, objects = built.objects) {
  const parts = [];
  for await (const bytes of readObjectRecipe(built.recipe, async p => {
    const content = objects.get(p.sha256);
    assert(content);
    return content;
  }))
    parts.push(bytes);
  return Buffer.concat(parts);
}

test('content recipes preserve exact large bytes and reuse regions after edits, insertions and deletions', async () => {
  const bytes = noise(24 * 1024 * 1024),
    original = buildObjectRecipe(bytes);
  assert.ok(original.recipe.tree.height >= 2, 'large recipes use bounded pages');
  assert.deepEqual(await resolved(original), bytes);
  const edited = Buffer.from(bytes);
  edited.write('one actual byte edit', 5 * 1024 * 1024);
  for (const next of [
    edited,
    Buffer.concat([
      bytes.subarray(0, 5 * 1024 * 1024),
      Buffer.from('inserted content'),
      bytes.subarray(5 * 1024 * 1024),
    ]),
    Buffer.concat([bytes.subarray(0, 5 * 1024 * 1024), bytes.subarray(5 * 1024 * 1024 + 1024)]),
  ]) {
    const built = buildObjectRecipe(next),
      missing = [...built.objects].filter(([id]) => !original.objects.has(id));
    assert.ok(missing.reduce((sum, [, value]) => sum + value.length, 0) < 2 * 1024 * 1024);
    assert.deepEqual(await resolved(built), next);
    assert.deepEqual(buildObjectRecipe(next).bytes, built.bytes);
  }
  assert.deepEqual(await resolved(buildObjectRecipe(Buffer.alloc(0))), Buffer.alloc(0));
});

test('streamed recipe validation rejects corruption, absent content, bad order and inconsistent bounds', async () => {
  const bytes = noise(4 * 1024 * 1024),
    built = buildObjectRecipe(bytes),
    wrong = new Map(built.objects);
  wrong.set(built.recipe.tree.sha256, Buffer.from('changed'));
  await assert.rejects(resolved(built, wrong), error => error.code === 'INVALID_WORK_BACKUP');
  await assert.rejects(resolved(built, new Map()));
  const reversed = JSON.parse(built.objects.get(built.recipe.tree.sha256));
  reversed.children.reverse();
  const page = Buffer.from(JSON.stringify(reversed)),
    changed = structuredClone(built.recipe);
  changed.tree.sha256 = digest(page);
  changed.tree.size = page.length;
  const swapped = new Map(built.objects);
  swapped.set(changed.tree.sha256, page);
  await assert.rejects(resolved({ recipe: changed }, swapped), error => error.code === 'INVALID_WORK_BACKUP');
  const oversized = {
    kind: 'forge-object-recipe',
    schema: 1,
    object: { sha256: 'a'.repeat(64), size: objectChunkBytes + 1 },
    tree: { sha256: 'a'.repeat(64), size: objectChunkBytes + 1, height: 0, length: objectChunkBytes + 1 },
  };
  let reads = 0;
  await assert.rejects(
    async () => {
      for await (const _ of readObjectRecipe(oversized, async () => {
        reads++;
        return Buffer.alloc(0);
      })) {
      }
    },
    error => error.code === 'INVALID_WORK_BACKUP',
  );
  assert.equal(reads, 0, 'invalid encoding cannot request an unbounded leaf');
});

function clientFixture() {
  const client = new ConvexExchange(
      'https://fixture.convex.cloud',
      'private-fixture',
      'project',
      'operation',
      null,
    ),
    objects = new Map(),
    bindings = new Map(),
    calls = [];
  client.missing = async pins => pins.filter(pin => !objects.has(pin.sha256)).map(pin => pin.sha256);
  client.uploadPhysical = async lazy => {
    const batch = await Promise.all(lazy.map(async item => ({ pin: item.pin, bytes: await item.read() })));
    let uploadedObjects = 0,
      uploadedBytes = 0;
    for (const item of batch)
      if (!objects.has(item.pin.sha256)) {
        assert.equal(digest(item.bytes), item.pin.sha256);
        objects.set(item.pin.sha256, Buffer.from(item.bytes));
        uploadedObjects++;
        uploadedBytes += item.bytes.length;
      }
    return { uploadedObjects, uploadedBytes, uploadedLogicalObjects: uploadedObjects };
  };
  client.uploadRawBatch = batch =>
    client.uploadPhysical(batch.map(item => ({ pin: item.pin, read: () => item.bytes })));
  let lost = false;
  client.client.action = async (ref, args) => {
    calls.push(getFunctionName(ref));
    assert.equal(getFunctionName(ref), 'projectObjectRecipes:complete');
    const recipe = JSON.parse(objects.get(args.recipeDigest)),
      hash = createHash('sha256');
    let size = 0;
    for await (const bytes of readObjectRecipe(recipe, async pin => objects.get(pin.sha256))) {
      hash.update(bytes);
      size += bytes.length;
    }
    assert.equal(hash.digest('hex'), args.digest);
    assert.equal(size, args.size);
    bindings.set(args.digest, recipe);
    if (lost) {
      lost = false;
      throw Error('unknown completed response');
    }
    return null;
  };
  return {
    client,
    objects,
    bindings,
    calls,
    loseNext: () => {
      lost = true;
    },
  };
}
test('client uploads physical chunk deltas, reconciles an unknown finalize and leaves metadata/root uploads raw', async () => {
  const f = clientFixture(),
    bytes = noise(8 * 1024 * 1024),
    first = await f.client.upload(pin(bytes), bytes);
  assert.ok(first.uploadedBytes > bytes.length, 'first seed includes recipe overhead');
  assert.ok(first.uploadedObjects > 1);
  assert.equal(first.uploadedLogicalObjects, 1);
  const next = Buffer.from(bytes);
  next.write('changed', 4 * 1024 * 1024);
  const delta = await f.client.upload(pin(next), next);
  assert.ok(delta.uploadedBytes < 2 * 1024 * 1024);
  assert.equal(delta.uploadedLogicalObjects, 1);
  const retry = await f.client.upload(pin(next), next);
  assert.equal(retry.uploadedBytes, 0);
  assert.equal(retry.uploadedObjects, 0);
  assert.equal(retry.uploadedLogicalObjects, 0);
  const third = Buffer.from(next);
  third.write('another change', 6 * 1024 * 1024);
  f.loseNext();
  await assert.rejects(f.client.upload(pin(third), third), /unknown completed response/);
  assert.equal((await f.client.upload(pin(third), third)).uploadedBytes, 0);
  assert.ok(f.bindings.has(digest(third)));
  const metadata = noise(3 * 1024 * 1024),
    before = f.calls.length;
  const raw = await f.client.upload({ ...pin(metadata), path: 'manifest.json' }, metadata);
  assert.equal(raw.uploadedObjects, 1);
  assert.equal(f.calls.length, before);
  assert.ok(f.objects.has(digest(metadata)));
});

test('private downloads use bounded waves, exact file hashes and preserve existing destinations', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-stream-download-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bytes = noise(9 * exchangeRangeBytes + 7),
    path = join(directory, 'content'),
    calls = [];
  let active = 0,
    peak = 0;
  await downloadExchangeFile(pin(bytes), path, async offset => {
    active++;
    peak = Math.max(peak, active);
    calls.push(offset);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return bytes.subarray(offset, offset + exchangeRangeBytes);
  });
  assert.equal(peak, 4);
  assert.equal(active, 0);
  assert.deepEqual(readFileSync(path), bytes);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  await assert.rejects(
    downloadExchangeFile(pin(bytes), path, async () =>
      assert.fail('existing file must never be read or overwritten'),
    ),
  );
  assert.deepEqual(readFileSync(path), bytes);
  assert.equal(calls.length, 10);
  const empty = join(directory, 'empty');
  await downloadExchangeFile(pin(Buffer.alloc(0)), empty, async () => Buffer.alloc(0));
  assert.equal(statSync(empty).size, 0);
});

test('download failures drain active ranges before cleanup and reject incorrect full content', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-stream-failure-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bytes = noise(5 * exchangeRangeBytes),
    path = join(directory, 'content');
  let active = 0,
    settled = 0;
  await assert.rejects(
    downloadExchangeFile(pin(bytes), path, async offset => {
      active++;
      try {
        if (offset === 0) throw Error('failed range');
        await new Promise(resolve => setImmediate(resolve));
        assert.ok(existsSync(path), 'cleanup waits for siblings');
        return bytes.subarray(offset, offset + exchangeRangeBytes);
      } finally {
        active--;
        settled++;
      }
    }),
    /failed range/,
  );
  assert.equal(active, 0);
  assert.equal(settled, 4);
  assert.equal(existsSync(path), false);
  await assert.rejects(
    downloadExchangeFile({ ...pin(bytes), sha256: '0'.repeat(64) }, path, async offset =>
      bytes.subarray(offset, offset + exchangeRangeBytes),
    ),
    error => error.code === 'INVALID_WORK_BACKUP',
  );
  assert.equal(existsSync(path), false);
});

test('Convex streaming transport retains logical response pins and propagates current authority failures', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-convex-stream-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bytes = noise(5 * exchangeRangeBytes + 1),
    expected = pin(bytes),
    client = new ConvexExchange('https://fixture.convex.cloud', 'fixture', 'project', 'operation', null);
  let active = 0,
    peak = 0;
  client.client.mutation = async () => []; // no R2 objects
  client.client.action = async (ref, args) => {
    assert.equal(getFunctionName(ref), 'projectExchangeActions:downloadPart');
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return {
      data: bytes.subarray(args.offset, args.offset + exchangeRangeBytes),
      digest: expected.sha256,
      size: expected.size,
    };
  };
  await client.downloadToFile(expected, join(directory, 'valid'));
  assert.equal(peak, 4);
  assert.deepEqual(readFileSync(join(directory, 'valid')), bytes);
  client.client.action = async () => ({
    data: bytes.subarray(0, exchangeRangeBytes),
    digest: 'f'.repeat(64),
    size: expected.size,
  });
  await assert.rejects(
    client.downloadToFile(expected, join(directory, 'wrong')),
    error => error.code === 'INVALID_WORK_BACKUP',
  );
  assert.equal(existsSync(join(directory, 'wrong')), false);
  const revoked = Error('Current account no longer has project access');
  client.client.action = async () => {
    throw revoked;
  };
  await assert.rejects(
    client.downloadToFile(expected, join(directory, 'revoked')),
    error => error === revoked,
  );
  assert.equal(existsSync(join(directory, 'revoked')), false);
});

test('identical content can appear as an index page and as original source leaf bytes', async () => {
  const a = Buffer.from('alpha'),
    b = Buffer.from('beta'),
    leaf = bytes => ({ ...pin(bytes), height: 0, length: bytes.length });
  const page = Buffer.from(
    JSON.stringify({ kind: 'forge-byte-tree', schema: 1, children: [leaf(a), leaf(b)] }),
  );
  const root = Buffer.from(
    JSON.stringify({
      kind: 'forge-byte-tree',
      schema: 1,
      children: [{ ...pin(page), height: 1, length: a.length + b.length }, leaf(page)],
    }),
  );
  const bytes = Buffer.concat([a, b, page]),
    recipe = {
      kind: 'forge-object-recipe',
      schema: 1,
      object: pin(bytes),
      tree: { ...pin(root), height: 2, length: bytes.length },
    };
  const objects = new Map([a, b, page, root].map(content => [digest(content), content]));
  assert.deepEqual(await resolved({ recipe }, objects), bytes);
});

test('large source upload reads bounded source chunks, preserves recipes and rejects changed source before binding', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-file-upload-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const f = clientFixture(),
    bytes = noise(13 * 1024 * 1024 + 7),
    path = join(directory, 'source');
  writeFileSync(path, bytes);
  const expected = pin(bytes),
    original = buildObjectRecipe(bytes),
    first = await f.client.uploadFile(expected, directory, 'source');
  assert(first.uploadedObjects > 1);
  assert.deepEqual(f.bindings.get(expected.sha256), original.recipe);
  assert.equal((await f.client.uploadFile(expected, directory, 'source')).uploadedBytes, 0);
  const altered = Buffer.from(bytes);
  altered[6 * 1024 * 1024] ^= 1;
  writeFileSync(path, altered);
  const before = f.objects.size;
  await assert.rejects(f.client.uploadFile(expected, directory, 'source'), {
    code: 'EXCHANGE_SOURCE_CHANGED',
  });
  assert.equal(f.objects.size, before);
  const next = pin(altered),
    delta = await f.client.uploadFile(next, directory, 'source');
  assert(delta.uploadedBytes < 2 * 1024 * 1024);
  f.loseNext();
  await assert.rejects(f.client.uploadFile(next, directory, 'source'), /unknown completed/);
  assert.equal((await f.client.uploadFile(next, directory, 'source')).uploadedBytes, 0);
});
