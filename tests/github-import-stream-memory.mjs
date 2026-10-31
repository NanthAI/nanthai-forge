// Measure the production transfer runtime in its own process. The compiler,
// coverage collector and complete fake backend belong to the parent test runner,
// not the Convex action. RPC/storage stubs retain only external receipt metadata.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { streamGithubSourceBlob, githubBlobEndpointBytes } from '../dist/github-project-source.js';
import { ObjectRecipeBuilder } from '../dist/object-chunks.js';
import { defaultR2Config } from './default-r2.mjs';
// Import bytes go to R2. This process keeps only each PUT's digest and size, not the bytes.
Object.assign(process.env, {
  R2_ACCOUNT_ID: defaultR2Config.accountId,
  R2_BUCKET: defaultR2Config.bucket,
  R2_ACCESS_KEY_ID: defaultR2Config.accessKeyId,
  R2_SECRET_ACCESS_KEY: defaultR2Config.secretAccessKey,
});
globalThis.fetch = async (url, init) => {
  assert.equal(init.method, 'PUT');
  const bytes = Buffer.from(await new Response(init.body).arrayBuffer()),
    key = decodeURIComponent(new URL(url).pathname).split('/').at(-1);
  stored.set(key, { digest: createHash('sha256').update(bytes).digest('hex'), size: bytes.length });
  return new Response(null, { status: 200 });
};
const { ImportUpload } = await import(process.argv[2]);
const objects = new Map(),
  stored = new Map();
let executions = 0;
const ctx = {
  runMutation: async (reference, args) => {
    executions++;
    const name = getFunctionName(reference);
    if (name === 'projectGithubImportBatch:prepare')
      return args.objects.map(pin => {
        if (!objects.has(pin.digest)) objects.set(pin.digest, { ...pin, id: pin.digest });
        const row = objects.get(pin.digest);
        return { id: row.id, stored: !!row.key || !!row.recipe, key: row.id };
      });
    assert.equal(name, 'projectGithubImportBatch:complete');
    for (const object of args.objects) {
      const row = objects.get(object.id),
        bytes = stored.get(object.key);
      assert.equal(bytes.digest, row.digest);
      assert.equal(bytes.size, row.size);
      row.key = object.key;
    }
    for (const pin of args.recipes) {
      assert.ok(objects.get(pin.recipeDigest).key);
      if (!objects.has(pin.digest)) objects.set(pin.digest, { ...pin, recipe: pin.recipeDigest });
    }
    return null;
  },
  storage: {
    store: () => assert.fail('import bytes never go to Convex storage'),
  },
};
const size = githubBlobEndpointBytes,
  blockSize = 64 * 1024;
const block = index => {
  const seed = createHash('sha256').update(String(index)).digest(),
    value = Buffer.allocUnsafe(blockSize);
  for (let offset = 0; offset < value.length; offset += seed.length) seed.copy(value, offset);
  return value;
};
const git = createHash('sha1').update(`blob ${size}\0`),
  logical = createHash('sha256');
for (let i = 0; i < size / blockSize; i++) {
  const bytes = block(i);
  git.update(bytes);
  logical.update(bytes);
}
const expected = logical.digest('hex'),
  upload = new ImportUpload(ctx, 'project', 'owner');
const builder = new ObjectRecipeBuilder(upload.put);
let index = 0,
  peakRss = process.memoryUsage().rss;
const pin = await streamGithubSourceBlob(
  'fixture/stream',
  { path: 'large.bin', sha: git.digest('hex'), size, mode: '100644' },
  async bytes => {
    builder.update(bytes);
    if (await upload.drain()) await upload.commit();
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  },
  undefined,
  async () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          if (index * blockSize >= size) controller.close();
          else controller.enqueue(block(index++));
        },
      }),
    ),
);
assert.equal(pin.blob, expected);
assert.equal(pin.size, size);
upload.recipe(pin, builder.finish({ sha256: pin.blob, size }).bytes);
await upload.drain(true);
await upload.commit();
assert.ok(objects.get(expected).recipe);
assert.equal(objects.get(expected).key, undefined);
console.log(
  JSON.stringify({
    logicalBytes: size,
    peakBufferedBytes: upload.peakBufferedBytes,
    peakProcessRss: peakRss,
    physicalObjects: stored.size,
    executions,
  }),
);
