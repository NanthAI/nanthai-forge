// SPDX-License-Identifier: Apache-2.0
import { digest } from '../dist/hash.js';
import { physicalStateSourceFixture } from './physical-state-source-fixture.mjs';
import { ActionsJobClient } from '../dist/hosted-actions-job-client.js';
import { hostedActionsCapabilities } from '../dist/hosted-actions-capabilities.js';
import { expandSourceGrants } from '../dist/source-grant-wire.js';

/** Imported recipes have packed metadata and no retained inline leaf projection. */
export async function stateSourceRecipeFixture(
  t,
  count,
  { leaves = 2, leafBytes = 1024 * 1024, packedLeaves = false } = {},
) {
  const recipes = Array.from({ length: count }, (_, index) => {
    const bodies = new Map();
    const put = bytes => {
      const pin = { sha256: digest(bytes), size: bytes.length };
      bodies.set(pin.sha256, bytes);
      return pin;
    };
    const leafCount = Array.isArray(leaves) ? leaves[index] : leaves;
    const parts = Array.from({ length: leafCount }, (_, leaf) => {
      const bytes = Buffer.alloc(leafBytes, index + leaf);
      if (packedLeaves) bytes.writeUInt32LE(index * 1000 + leaf);
      return bytes;
    });
    const object = { sha256: digest(Buffer.concat(parts)), size: leafCount * leafBytes };
    const children = parts.map(bytes => ({ ...put(bytes), height: 0, length: bytes.length }));
    const leafPack = packedLeaves
      ? put(Buffer.concat([...parts, Buffer.from('unselected neighbour')]))
      : null;
    const treeBytes = Buffer.from(JSON.stringify({ kind: 'forge-byte-tree', schema: 1, children }));
    const tree = { ...put(treeBytes), height: 1, length: object.size };
    const recipeBytes = Buffer.from(JSON.stringify({ kind: 'forge-object-recipe', schema: 1, object, tree }));
    const recipe = put(recipeBytes);
    const pack = put(Buffer.concat([recipeBytes, treeBytes]));
    return {
      entry: { ...object, recipe },
      bodies,
      catalog: [
        ...children.map((pin, index) => ({
          ...pin,
          ...(leafPack
            ? { pack: { digest: leafPack.sha256, size: leafPack.size, offset: index * leafBytes } }
            : {}),
        })),
        { ...recipe, pack: { digest: pack.sha256, size: pack.size, offset: 0 } },
        { ...tree, pack: { digest: pack.sha256, size: pack.size, offset: recipe.size } },
      ],
      metadata: [recipe.sha256, tree.sha256],
    };
  });
  const f = await physicalStateSourceFixture(t, 0, { protocol: 2, recipes });
  // Match the imported catalog: the metadata exists only inside its committed pack.
  for (const recipe of recipes)
    for (const id of recipe.metadata) f.r2.objects.delete(`/synthetic/v1/p/${f.s.projectId}/o/${id}`);
  const stateRow = [...f.s.tables.projectObjects.values()].find(row => row.digest === f.s.state.sha256);
  f.s.patch('projectObjects', stateRow._id, { statePhysical: undefined });
  let readBytes = 0;
  const request = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const response = await request(url, init);
    if (response.ok && (!init?.method || init.method === 'GET')) {
      const body = f.r2.objects.get(new URL(url).pathname);
      const range = new Headers(init?.headers).get('range')?.match(/^bytes=(\d+)-(\d+)$/);
      readBytes += range ? Number(range[2]) - Number(range[1]) + 1 : (body?.length ?? 0);
    }
    return response;
  });
  const rounds = [];
  const client = new ActionsJobClient('https://forge.example', f.s.projectId, f.run.id, (url, init) =>
    fetch(url, init),
  );
  client.run = f.run;
  client.capabilities = [...hostedActionsCapabilities];
  t.mock.method(client, 'call', async command => {
    const start = performance.now(),
      before = f.calls.length,
      gets = f.r2.requests.length;
    const io = readBytes,
      transactions = f.s.counts.length;
    const reply = command.bound ? await f.heads() : expandSourceGrants(await f.source(command));
    rounds.push({
      object: !!command.object,
      all: !!command.all,
      digests: command.digests.length,
      calls: f.calls.length - before,
      gets: f.r2.requests.length - gets,
      r2Bytes: readBytes - io,
      dbReadBytes: f.s.counts.slice(transactions).reduce((sum, row) => sum + row.readBytes, 0),
      dbWriteBytes: f.s.counts.slice(transactions).reduce((sum, row) => sum + row.writeBytes, 0),
      replyBytes: Buffer.byteLength(JSON.stringify(reply)),
      wallMs: performance.now() - start,
    });
    return reply;
  });
  return { ...f, client, rounds, recipes };
}
