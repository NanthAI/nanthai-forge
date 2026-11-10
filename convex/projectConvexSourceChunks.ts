// SPDX-License-Identifier: Apache-2.0
import { stateByteChunks } from '../src/state/format';
import { mapSourceOrdered } from '../src/hosted-source-parallel';
import type { WorkerPin } from '../src/hosted-source-worker-format';
import type { ObjectPack } from '../src/object-pack-range';
import type { ObjectLocation } from './projectConvexSourceTransport';
import type { SourceOutput } from './projectConvexSourceOutput';
import type { Id } from './_generated/dataModel';
import { invariant } from '../src/errors';
import { r2Key } from './r2';
type Physical = WorkerPin & { r2Key: string; pack?: ObjectPack };
/** One action's verified destination bindings, never a source/access cache. No
 * bytes survive here. Existing raw States can supply immutable ranges without a
 * seed upload or HEAD. Publication independently checks their project bindings. */
export function sourceStateChunks(
  projectId: Id<'hostedProjects'>,
  hash: (bytes: Uint8Array) => string,
  put: (pin: WorkerPin, bytes: Uint8Array) => Promise<Physical>,
  avoided: (size: number) => void,
) {
  const known = new Map<string, Physical>(),
    writing = new Map<string, Promise<Physical>>();
  function binding(
    pin: WorkerPin,
    url: string | null,
    range?: { offset: number; total: number },
  ): Physical | null {
    if (!url) return null;
    const physical = new URL(url).pathname.split('/').at(-1)!;
    if (!/^[a-f0-9]{64}$/.test(physical) || !new URL(url).pathname.endsWith('/' + r2Key(projectId, physical)))
      return null;
    return {
      ...pin,
      r2Key: r2Key(projectId, physical),
      ...(range ? { pack: { digest: physical, size: range.total, offset: range.offset } } : {}),
    };
  }
  const remember = (row: ObjectLocation) => {
    for (const leaf of row.closure ?? []) {
      const value = binding({ sha256: leaf.digest, size: leaf.size }, leaf.url, leaf.range);
      if (value) known.set(value.sha256, value);
    }
  };
  const rememberBytes = (pin: WorkerPin, bytes: Uint8Array, row?: ObjectLocation) => {
    if (!row || row.closure) return;
    const base = binding(pin, row.url, row.range);
    if (!base) return;
    const chunks = stateByteChunks(bytes, hash);
    if (!chunks) return;
    for (const chunk of chunks)
      known.set(chunk.sha256, {
        sha256: chunk.sha256,
        size: chunk.size,
        r2Key: base.r2Key,
        pack: {
          digest: base.pack?.digest ?? pin.sha256,
          size: base.pack?.size ?? pin.size,
          offset: (base.pack?.offset ?? 0) + chunk.offset,
        },
      });
  };
  const store = async (pin: WorkerPin, bytes: Uint8Array) => {
    const old = known.get(pin.sha256);
    if (old) {
      invariant(old.size === pin.size, 'SOURCE_HASH_MISMATCH', 'Source chunk size changed.');
      return old;
    }
    let pending = writing.get(pin.sha256);
    if (!pending) {
      pending = put(pin, bytes).then(value => {
        known.set(pin.sha256, value);
        return value;
      });
      writing.set(pin.sha256, pending);
    }
    return pending;
  };
  return {
    remember,
    rememberBytes,
    async output(pin: WorkerPin, bytes: Uint8Array): Promise<SourceOutput | null> {
      // In particular, a legacy cold baseline needs no speculative seed writes.
      if (!known.size) return null;
      const chunks = stateByteChunks(bytes, hash);
      if (!chunks) return null;
      const leaves = chunks.map(({ sha256, size }) => ({ sha256, size })),
        children = leaves.map(leaf => ({ ...leaf, height: 0, length: leaf.size })),
        treeBytes = new TextEncoder().encode(
          JSON.stringify({ kind: 'forge-byte-tree', schema: 1, children }),
        ),
        tree = { sha256: hash(treeBytes), size: treeBytes.length, height: 1, length: pin.size },
        recipeBytes = new TextEncoder().encode(
          JSON.stringify({ kind: 'forge-object-recipe', schema: 1, object: pin, tree }),
        ),
        recipe = { sha256: hash(recipeBytes), size: recipeBytes.length },
        reused = chunks.reduce(
          (n, leaf) => n + (known.get(leaf.sha256)?.size === leaf.size ? leaf.size : 0),
          0,
        );
      // Include all new metadata bodies. If this representation cannot save
      // bytes, retain the exact existing flat writer, including the first save.
      if (reused <= treeBytes.length + recipeBytes.length) return null;
      avoided(reused);
      const physical = await mapSourceOrdered(chunks, leaf =>
        store({ sha256: leaf.sha256, size: leaf.size }, bytes.subarray(leaf.offset, leaf.offset + leaf.size)),
      );
      physical.push(
        await store({ sha256: tree.sha256, size: tree.size }, treeBytes),
        await store(recipe, recipeBytes),
      );
      return {
        ...pin,
        recipe,
        recipeClosure: leaves,
        physical: [...new Map(physical.map(value => [value.sha256, value])).values()],
      };
    },
  };
}
