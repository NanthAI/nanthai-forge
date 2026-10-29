// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { objectRecipeSchema, objectChunkPageSchema } from './object-chunks.js';
import type { TreeRef } from './native-exchange-tree.js';
import { SourceStepHash, type SourceHashState } from './hosted-source-step-hash.js';
import type { WorkerObject, WorkerPin } from './hosted-source-worker-format.js';
import type { SourceWorkerTransport } from './hosted-source-worker-reader.js';
import { invariant } from './errors.js';
export const sourceStepBytes = 8 * 1024 * 1024,
  sourceStepObjects = 100;
export type VerifyCursor = { ref: WorkerObject; pending: TreeRef[]; hash: SourceHashState; length: number };
export type StepMeter = {
  objects: number;
  bytes: number;
  started: number;
  yielded: boolean;
  outputObjects: number;
  outputBytes: number;
  treeUpdates: number;
};
export const meter = (): StepMeter => ({
  objects: 0,
  bytes: 0,
  started: performance.now(),
  yielded: false,
  outputObjects: 0,
  outputBytes: 0,
  treeUpdates: 0,
});
export const full = (m: StepMeter) =>
  m.yielded ||
  m.objects + m.outputObjects >= sourceStepObjects ||
  m.bytes + m.outputBytes >= sourceStepBytes ||
  performance.now() - m.started >= 20000;
export async function readPhysical(
  io: SourceWorkerTransport,
  pin: WorkerPin,
  _m: StepMeter,
): Promise<Buffer> {
  const parts: Buffer[] = [],
    hash = createHash('sha256');
  let size = 0;
  for await (const chunk of await io.read(pin)) {
    size += chunk.length;
    invariant(size <= pin.size, 'SOURCE_HASH_MISMATCH', 'Source exceeds its exact size.');
    hash.update(chunk);
    parts.push(Buffer.from(chunk));
  }
  invariant(
    size === pin.size && hash.digest('hex') === pin.sha256,
    'SOURCE_HASH_MISMATCH',
    'Source bytes differ from their exact pin.',
  );
  return Buffer.concat(parts);
}
export async function readJson(io: SourceWorkerTransport, pin: WorkerPin, m: StepMeter): Promise<unknown> {
  return JSON.parse((await readPhysical(io, pin, m)).toString('utf8'));
}
/** Leaves never survive a verification step. Both SHA state and the remaining
 * tree frontier are durable, so a retry never rehashes an acknowledged prefix. */
export async function verifySourceObject(
  io: SourceWorkerTransport,
  ref: WorkerObject,
  m: StepMeter,
  saved: VerifyCursor | null,
  consume?: (bytes: Uint8Array) => void,
) {
  if (!ref.recipe) {
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of await io.read(ref.object)) {
      size += chunk.length;
      invariant(size <= ref.object.size, 'SOURCE_HASH_MISMATCH', 'Source exceeds its exact size.');
      hash.update(chunk);
      consume?.(chunk);
    }
    invariant(
      size === ref.object.size && hash.digest('hex') === ref.object.sha256,
      'SOURCE_HASH_MISMATCH',
      'Source bytes differ from their exact pin.',
    );
    return null;
  }
  let c = saved;
  if (!c) {
    const recipe = objectRecipeSchema.parse(await readJson(io, ref.recipe, m));
    invariant(
      recipe.object.sha256 === ref.object.sha256 &&
        recipe.object.size === ref.object.size &&
        recipe.tree.length === ref.object.size,
      'SOURCE_RECIPE_INVALID',
      'Recipe selects different logical content.',
    );
    c = { ref, pending: [recipe.tree], hash: new SourceStepHash().snapshot(), length: 0 };
  }
  const hash = new SourceStepHash(c.hash);
  while (c.pending.length && !full(m)) {
    const next = c.pending[c.pending.length - 1]!;
    invariant(
      next.size <= (next.height === 0 ? 1024 * 1024 : 2 * 1024 * 1024),
      'SOURCE_RECIPE_INVALID',
      'Recipe physical encoding is oversized.',
    );
    if (m.objects && m.bytes + next.size > sourceStepBytes) {
      m.yielded = true;
      break;
    }
    const window: WorkerPin[] = [];
    let windowBytes = 0;
    for (const candidate of c.pending.slice(-100).reverse()) {
      if (window.length && windowBytes + candidate.size > sourceStepBytes - m.bytes) break;
      window.push(candidate);
      windowBytes += candidate.size;
    }
    await io.prepareRead?.(window);
    c.pending.pop();
    const bytes = await readPhysical(io, next, m);
    if (next.height === 0) {
      invariant(next.length === next.size, 'SOURCE_RECIPE_INVALID', 'Recipe leaf length changed.');
      hash.update(bytes);
      consume?.(bytes);
      c.length += bytes.length;
    } else {
      const page = objectChunkPageSchema.parse(JSON.parse(bytes.toString('utf8')));
      invariant(
        page.children.every(child => child.height < next.height) &&
          page.children.reduce((sum, child) => sum + child.length, 0) === next.length,
        'SOURCE_RECIPE_INVALID',
        'Recipe ancestry or logical length changed.',
      );
      c.pending.push(...page.children.slice().reverse());
    }
  }
  if (c.pending.length) {
    c.hash = hash.snapshot();
    return c;
  }
  invariant(
    c.length === ref.object.size && hash.hex() === ref.object.sha256,
    'SOURCE_HASH_MISMATCH',
    'Recipe whole-file hash changed.',
  );
  return null;
}
