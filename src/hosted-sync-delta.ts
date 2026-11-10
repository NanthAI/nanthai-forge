// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { digest } from './state/hash.js';
import { oid, stateSchema, type NativeFile, type NativeState } from './state/format.js';

/** One-trip sync (fea47345 B): the resulting State as a change list from the State the client's
 * checkout already holds (`from`, the Lane head before the sync). It rides only on the submitting
 * action's reply (nothing stores it), so the client rebuilds the State and checks its exact digest
 * instead of reading the State page and downloading the State. Anything that does not rebuild to the
 * exact head is ignored and the checkout reads the State as before. */
export const syncStateDeltaBytes = 32 * 1024;
const entry = z
  .object({ path: z.string(), blob: oid, mode: z.enum(['file', 'executable', 'symlink', 'gitlink']) })
  .strict();
export const syncStateDeltaSchema = z
  .object({
    schema: z.literal(1),
    from: oid,
    head: oid,
    parents: z.array(oid),
    message: z.string(),
    at: z.string(),
    files: z.array(entry),
    removed: z.array(z.string()),
  })
  .strict();
export type SyncStateDelta = z.infer<typeof syncStateDeltaSchema>;

/** The delta from `from` to `head`, or null when the State has fields a delta does not carry or the
 * delta would exceed its byte bound (the client then reads the State). */
export function syncStateDelta(from: NativeState, fromId: string, head: NativeState, headId: string) {
  if (fromId === headId || head.git || head.conversation) return null;
  const before = new Map(from.files.map(file => [file.path, file]));
  const files: NativeFile[] = [];
  for (const file of head.files) {
    const old = before.get(file.path);
    before.delete(file.path);
    if (!old || old.blob !== file.blob || old.mode !== file.mode) files.push(file);
  }
  const delta: SyncStateDelta = {
    schema: 1,
    from: fromId,
    head: headId,
    parents: head.parents,
    message: head.message,
    at: head.at,
    files,
    removed: [...before.keys()],
  };
  return new TextEncoder().encode(JSON.stringify(delta)).length <= syncStateDeltaBytes ? delta : null;
}

/** The exact State `delta` describes on top of `from`, or null when it does not rebuild to its head. */
export function applySyncStateDelta(
  from: NativeState,
  fromId: string,
  value: unknown,
): { id: string; state: NativeState; bytes: Uint8Array } | null {
  const parsed = syncStateDeltaSchema.safeParse(value);
  if (!parsed.success || parsed.data.from !== fromId) return null;
  const delta = parsed.data,
    files = new Map(from.files.map(file => [file.path, file]));
  for (const path of delta.removed) files.delete(path);
  for (const file of delta.files) files.set(file.path, file);
  let state: NativeState;
  try {
    state = stateSchema.parse({
      schema: 1,
      kind: 'forge-source-state',
      parents: delta.parents,
      files: [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      message: delta.message,
      at: delta.at,
    });
  } catch {
    return null;
  }
  const bytes = new TextEncoder().encode(JSON.stringify(state));
  return digest(bytes) === delta.head ? { id: delta.head, state, bytes } : null;
}
