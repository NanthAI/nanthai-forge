// SPDX-License-Identifier: Apache-2.0
// Incident 2026-11-18 (Item 4bc460aa): the browser's Lane changes and Code views read a State stored as a recipe
// without a signed closure by walking its byte tree one node at a time, two serial describe calls per leaf (hundreds
// of round trips, minutes for one view). A tree read must batch each level: calls grow with height and width / 100,
// never with the leaf count, while access is still described before and re-checked after every batch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ObjectDownloadReader } from '../dist/blob-download.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const pinOf = bytes => ({ sha256: sha(bytes), size: bytes.length });

/** A logical object of `leafCount` leaves under pages of `fan` children and one root page, stored as a recipe. */
function recipeFixture(leafCount, fan) {
  const objects = new Map();
  const put = bytes => {
    const pin = pinOf(bytes);
    objects.set(pin.sha256, bytes);
    return pin;
  };
  const leaves = Array.from({ length: leafCount }, (_, i) => Buffer.from(`leaf ${i} `.repeat(1 + (i % 7))));
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
  let gets = 0;
  const reader = new ObjectDownloadReader({
    describe: async (digests, signed) => {
      describes.push({ count: digests.length, signed: !!signed });
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
      return new Response(objects.get(new URL(url).pathname.slice(1)));
    },
  });
  return { reader, pin, bytes, describes, gets: () => gets };
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
