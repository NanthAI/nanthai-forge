// SPDX-License-Identifier: Apache-2.0
import { conversationSchema } from './agent-edit-types.js';
import { z } from 'zod';
import { safeRelative } from './safe-relative.js';
import { ForgeError, invariant } from './errors.js';
export const oid = z.string().regex(/^[0-9a-f]{64}$/);
export const gitImport = z
  .object({
    bundle: oid,
    commit: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/),
    format: z.enum(['sha1', 'sha256']),
  })
  .strict();
const entry = z
  .object({
    path: z.string().refine(safeRelative),
    blob: oid,
    mode: z.enum(['file', 'executable', 'symlink', 'gitlink']),
  })
  .strict();
export const stateSchema = z
  .object({
    schema: z.literal(1),
    kind: z.literal('forge-source-state'),
    conversation: conversationSchema.optional(),
    parents: z.array(oid),
    files: z.array(entry),
    message: z.string(),
    at: z.string(),
    git: gitImport.optional(),
  })
  .strict();
export type NativeFile = z.infer<typeof entry>;
export type NativeState = z.infer<typeof stateSchema>;
// A '.forge' or '.git' segment in any case (the names contain only ASCII letters).
const reservedSegment = /(?:^|\/)\.(?:forge|git)(?:\/|$)/i;
export function overlappingPaths(files: NativeFile[]): string[] {
  const paths = new Set(files.map(file => file.path)),
    seen = new Set<string>(),
    conflicts = new Set<string>();
  // Check each distinct ancestor once: climbing from a path stops at the first ancestor an
  // earlier path already climbed, because all of that ancestor's own parents were checked then.
  for (const path of paths)
    for (let slash = path.lastIndexOf('/'); slash !== -1; slash = path.lastIndexOf('/', slash - 1)) {
      const parent = path.slice(0, slash);
      if (seen.has(parent)) break;
      seen.add(parent);
      if (paths.has(parent)) conflicts.add(parent);
    }
  return [...conflicts].sort();
}
export function parseNativeState(bytes: Uint8Array): NativeState {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new ForgeError('INVALID_NATIVE_SOURCE', 'Native source manifest encoding is invalid.');
  }
  return parseNativeStateValue(value);
}
/** Validate an already decoded marker without serializing and cloning its manifest again. */
export function parseNativeStateValue(value: unknown): NativeState {
  let state: NativeState;
  try {
    state = stateSchema.parse(value);
  } catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    throw new ForgeError('INVALID_NATIVE_SOURCE', 'Native source manifest encoding is invalid.');
  }
  invariant(
    new Set(state.files.map(file => file.path)).size === state.files.length &&
      state.files.every(file => !reservedSegment.test(file.path)),
    'INVALID_NATIVE_SOURCE',
    'Native source manifest paths are invalid.',
  );
  invariant(
    overlappingPaths(state.files).length === 0,
    'INVALID_NATIVE_SOURCE',
    'Source file and directory paths overlap.',
  );
  return state;
}
