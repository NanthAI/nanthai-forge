// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { safeRelative } from './safe-relative.js';
import { invariant } from './errors.js';
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
    mode: z.enum(['file', 'executable', 'symlink']),
  })
  .strict();
export const stateSchema = z
  .object({
    schema: z.literal(1),
    kind: z.literal('forge-source-state'),
    parents: z.array(oid),
    files: z.array(entry),
    message: z.string(),
    at: z.string(),
    git: gitImport.optional(),
  })
  .strict();
export type NativeFile = z.infer<typeof entry>;
export type NativeState = z.infer<typeof stateSchema>;
export function overlappingPaths(files: NativeFile[]): string[] {
  const paths = new Set(files.map(file => file.path)),
    conflicts = new Set<string>();
  for (const path of paths) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index++) {
      const parent = parts.slice(0, index).join('/');
      if (paths.has(parent)) conflicts.add(parent);
    }
  }
  return [...conflicts].sort();
}
export function parseNativeState(bytes: Uint8Array): NativeState {
  const state = stateSchema.parse(JSON.parse(new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)));
  invariant(
    new Set(state.files.map(file => file.path)).size === state.files.length &&
      state.files.every(
        file =>
          !file.path.toLowerCase().split('/').includes('.forge') &&
          !file.path.toLowerCase().split('/').includes('.git'),
      ),
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
