// SPDX-License-Identifier: Apache-2.0
// Incident 2026-11-18 (Item 4bc460aa): the browser's Lane changes and Code views read a State stored as a recipe
// without a signed closure by walking its byte tree one node at a time, two serial describe calls per leaf (hundreds
// of round trips, minutes for one view). A tree read must batch each level: calls grow with height and width / 100,
// never with the leaf count, while access is still described before and re-checked after every batch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ObjectDownloadReader } from '../dist/blob-download.js';
import { ForgeError } from '../dist/errors.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const pinOf = bytes => ({ sha256: sha(bytes), size: bytes.length });

/**
 * A logical object of `leafCount` leaves under pages of `fan` children and one root page, stored as a recipe.
 * `leafOf(i)` makes the bytes of leaf i; `onGet(digest)` runs when a stored object is fetched; `access.denied`
 * makes every later describe fail like a revoked viewer.
 */
function recipeFixture(leafCount, fan, { leafOf, onGet } = {}) {
  const objects = new Map();
  const put = bytes => {
    const pin = pinOf(bytes);
    objects.set(pin.sha256, bytes);
    return pin;
  };
  const leaves = Array.from(
    { length: leafCount },
    (_, i) => leafOf?.(i) ?? Buffer.from(`leaf ${i} `.repeat(1 + (i % 7))),
  );
  const leafRefs = leaves.map(leaf => ({ ...put(leaf), height: 0, length: leaf.length }));
  const pages = [];
  for (let at = 0; at < leafRefs.length; at += fan) {
    const children = leafRefs.slice(at, at + fan);
    const page = Buffer.from(JSON.stringify({ kind: 'forge-byte-tree', schema: 1, children }));
    pages.push({ ...put(page), height: 1, length: children.reduce((sum, child) => sum + child.length, 0) });
  }
  const rootPage = Buffer.from(JSON.stringify({ kind: 'forge-byte-tree', schema: 1, children: pages }));
  const bytes = Buffer.concat(leaves);
  const pin = pinOf(bytes);
  const tree = { ...put(rootPage), height: 2, length: bytes.length };
  const recipe = put(
    Buffer.from(JSON.stringify({ kind: 'forge-object-recipe', schema: 1, object: pin, tree })),
  );
  const describes = [];
  const access = { denied: false };
  let gets = 0;
  const reader = new ObjectDownloadReader({
    describe: async (digests, signed) => {
      describes.push({ count: digests.length, signed: !!signed });
      if (access.denied) throw new ForgeError('EXCHANGE_DOWNLOAD_DENIED', 'Access was revoked.');
      return digests.map(digest =>
        digest === pin.sha256
          ? {
              digest,
              size: pin.size,
              location: 'recipe',
              recipe: { digest: recipe.sha256, size: recipe.size },
            }
          : {
              digest,
              size: objects.get(digest).length,
              location: 'r2',
              ...(signed ? { url: `https://objects.test/${digest}` } : {}),
            },
      );
    },
    sign: async () => assert.fail('a signed describe already carries every URL'),
    fetch: async url => {
      gets++;
      const digest = new URL(url).pathname.slice(1);
      onGet?.(digest);
      return new Response(objects.get(digest));
    },
  });
  return { reader, pin, bytes, describes, access, leafDigests: leaves.map(sha), gets: () => gets };
}

test('a closure-less recipe of 250 leaves reads in batched levels: 14 describes, not one pair per leaf', async () => {
  const { reader, pin, bytes, describes, gets } = recipeFixture(250, 90);
  const [read] = await reader.read([pin]);
  assert.deepEqual(Buffer.from(read), bytes, 'exact logical bytes');
  // Object describe, recipe (describe + re-check), root page (2), three pages (2), 250 leaves in three batches of
  // at most 100 (6), and the object's own re-check. The node-at-a-time walk made 512.
  assert.equal(describes.length, 14, `describe calls: ${describes.length}`);
  assert(
    describes.every(call => call.count <= 100),
    'each describe stays within one page of 100',
  );
  assert.equal(
    describes.filter(call => !call.signed).length,
    7,
    'every batch is re-checked after its bytes are read (recipe, root, pages, three leaf batches, the object)',
  );
  assert.equal(gets(), 1 + 1 + 3 + 250, 'one GET per stored object, nothing fetched twice');
});

test('a range of a closure-less recipe reads only the leaves it touches, still in batches', async () => {
  const { reader, pin, bytes, describes, gets } = recipeFixture(250, 90);
  const offset = 700,
    length = 2_000;
  const part = await reader.range(pin, offset, length);
  assert.deepEqual(Buffer.from(part), bytes.subarray(offset, offset + length), 'exact range bytes');
  assert(describes.length <= 10, `describe calls: ${describes.length}`);
  assert(gets() < 1 + 1 + 3 + 250, 'leaves outside the range are not fetched');
});

test('access revoked while the second leaf batch is read fails the read and returns no bytes', async () => {
  // 150 leaves under two pages: leaf batches of 100 and 50. Access is revoked on the first GET of the second (last)
  // leaf batch, so only that batch's re-check (and the object's own) can notice; the first batch had passed.
  let revoke = () => {};
  const { reader, pin, describes, access, leafDigests } = recipeFixture(150, 90, {
    onGet: digest => {
      if (digest === leafDigests[100]) revoke();
    },
  });
  revoke = () => {
    access.denied = true;
  };
  await assert.rejects(
    reader.read([pin]),
    error => error instanceof ForgeError && error.code === 'EXCHANGE_DOWNLOAD_DENIED',
    'a revoked viewer gets a denial, never the bytes already fetched',
  );
  assert(
    describes.some(call => !call.signed && call.count === 50),
    'the second leaf batch was described again after its GETs',
  );
});

test('with 1 MiB leaves a leaf batch holds at most 16, the byte cache budget', async () => {
  const MiB = 1024 * 1024;
  const { reader, pin, bytes, describes } = recipeFixture(40, 20, {
    leafOf: i => Buffer.alloc(MiB, i + 1),
  });
  const [read] = await reader.read([pin]);
  assert.equal(sha(read), pin.sha256, 'exact logical bytes');
  assert.equal(read.length, bytes.length);
  // The signed describe of a batch covers exactly the leaves it will hold in memory at once (the two pages above
  // them are described as one batch of 2).
  assert.deepEqual(
    describes.filter(call => call.signed && call.count > 2).map(call => call.count),
    [16, 16, 8],
    'forty 1 MiB leaves read as 16, 16 and 8, never one page of 40',
  );
});
