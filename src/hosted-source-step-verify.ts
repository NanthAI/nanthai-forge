// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { objectRecipeSchema, objectChunkPageSchema } from './object-chunks.js';
import type { TreeRef } from './native-exchange-tree.js';
import { SourceStepHash, type SourceHashState } from './hosted-source-step-hash.js';
import type { WorkerObject, WorkerPin } from './hosted-source-worker-format.js';
import type { SourceWorkerTransport } from './hosted-source-worker-reader.js';
import { invariant } from './errors.js';
import { sourceValidation } from './hosted-source-validation.js';
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
  /** Why the step stopped before its work was done (friction 09c0b7cd); set where it yields. */
  stop?: SourceStepStop;
  /** Each object read, by kind from its first bytes (see `readKinds`). */
  kinds: Map<string, 'state' | 'page' | 'blob'>;
};
/** `fanout`: handed bounded tasks to parallel actions; `bytes`/`objects`/`time`: the step's 8 MiB,
 * 100-object or 20 s budget; `compute-bytes`: whole-State merge starts a fresh heap after 2 MiB of
 * reads; `created`: the next round reads a blob this action created; `recompute`: an inline round
 * finished and the merge re-runs in a fresh action; `tree`: one save tree update per step;
 * `window`: the next bounded read window does not fit or was not prepared. */
export type SourceStepStop =
  | 'fanout'
  | 'bytes'
  | 'objects'
  | 'time'
  | 'compute-bytes'
  | 'created'
  | 'recompute'
  | 'tree'
  | 'window';
/** End this step early, recording why. */
export function yieldStep(m: StepMeter, stop: SourceStepStop) {
  m.yielded = true;
  m.stop ??= stop;
}
/** Why a step that is not done stopped: its recorded yield, else the budget `full` hit. */
export function stepStop(m: StepMeter): SourceStepStop {
  if (m.stop) return m.stop;
  if (m.objects + m.outputObjects >= sourceStepObjects) return 'objects';
  if (m.bytes + m.outputBytes >= sourceStepBytes) return 'bytes';
  return performance.now() - m.started >= 20000 ? 'time' : 'window';
}
/** Kind of a read from its first 256 bytes: a State manifest, other Forge JSON (plans, pages,
 * recipes) or a file blob. Canonical JSON sorts its keys, so a State can hide its kind behind
 * `files`; `readKinds` also counts every read the step parsed as a State. */
export function readKind(head: string): 'state' | 'page' | 'blob' {
  if (head.includes('"kind":"forge-source-state"')) return 'state';
  return head.startsWith('{') && head.includes('"kind":"forge-') ? 'page' : 'blob';
}
/** How many State manifests, other Forge JSON pages and file blobs this step read. */
export function readKinds(m: StepMeter, parsedState: (id: string) => boolean) {
  const counts = { states: 0, pages: 0, blobs: 0 };
  for (const [id, kind] of m.kinds) {
    if (kind === 'state' || parsedState(id)) counts.states++;
    else if (kind === 'page') counts.pages++;
    else counts.blobs++;
  }
  return counts;
}
export const meter = (): StepMeter => ({
  objects: 0,
  bytes: 0,
  started: performance.now(),
  yielded: false,
  outputObjects: 0,
  outputBytes: 0,
  treeUpdates: 0,
  kinds: new Map(),
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
export async function readJson(
  io: SourceWorkerTransport,
  pin: WorkerPin,
  m: StepMeter,
  code = 'SOURCE_JOB_INVALID',
): Promise<unknown> {
  const bytes = await readPhysical(io, pin, m);
  return sourceValidation(code, () => JSON.parse(bytes.toString('utf8')));
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
    const value = await readJson(io, ref.recipe, m, 'SOURCE_RECIPE_INVALID');
    const recipe = sourceValidation('SOURCE_RECIPE_INVALID', () => objectRecipeSchema.parse(value));
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
      yieldStep(m, 'bytes');
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
      const page = sourceValidation('SOURCE_RECIPE_INVALID', () =>
        objectChunkPageSchema.parse(JSON.parse(bytes.toString('utf8'))),
      );
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
