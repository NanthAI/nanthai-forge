// SPDX-License-Identifier: Apache-2.0
import { conversationSchema } from '../agent-edit-types.js';
import { z } from 'zod';
import { safeRelative } from '../safe-relative.js';
import { ForgeError, invariant } from '../errors.js';
const oidPattern = /^[0-9a-f]{64}$/;
export const oid = z.string().regex(oidPattern);
export const gitImport = z
  .object({
    bundle: oid,
    commit: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/),
    format: z.enum(['sha1', 'sha256']),
  })
  .strict();
const fileModes = ['file', 'executable', 'symlink', 'gitlink'] as const;
const validModes: ReadonlySet<unknown> = new Set(fileModes);
const entry = z
  .object({
    path: z.string().refine(safeRelative),
    blob: oid,
    mode: z.enum(fileModes),
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
const decodedState = stateSchema.extend({ files: z.custom<unknown[]>(Array.isArray) });
// A '.forge' or '.git' segment in any case (the names contain only ASCII letters).
const reservedSegment = /(?:^|\/)\.(?:forge|git)(?:\/|$)/i;
export function overlappingPaths(files: readonly { path: string }[]): string[] {
  const paths = new Set<string>();
  for (const { path } of files) paths.add(path);
  return overlappingPathSet(paths);
}
function overlappingPathSet(paths: ReadonlySet<string>): string[] {
  const seen = new Set<string>(),
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
/** What a volume treats as the same name. Case-sensitive Linux volumes keep both. */
export type NameFolding = { caseInsensitive: boolean; unicodeInsensitive: boolean };
/** Paths that would land on one name (or a file under a file's name) on a volume with this folding:
 * valid States may hold `A` and `a/x`, which only a case-insensitive volume turns into a write
 * through the link `A`. Empty when the volume keeps every path distinct. */
export function foldedCollisions(files: readonly { path: string }[], folding: NameFolding): string[] {
  if (!folding.caseInsensitive && !folding.unicodeInsensitive) return [];
  const fold = (path: string) => {
    if (folding.unicodeInsensitive) path = path.normalize('NFD');
    return folding.caseInsensitive ? path.toLowerCase() : path;
  };
  const byName = new Map<string, string>(),
    conflicts = new Set<string>();
  for (const { path } of files) {
    const name = fold(path),
      prior = byName.get(name);
    if (prior === undefined) byName.set(name, path);
    else if (prior !== path) conflicts.add(prior).add(path);
  }
  for (const name of overlappingPaths([...byName.keys()].map(path => ({ path }))))
    conflicts.add(byName.get(name)!);
  return [...conflicts].sort();
}
export function parseNativeState(bytes: Uint8Array): NativeState {
  let state: NativeState;
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes));
    const parsed = decodedState.parse(value);
    // These objects came from this JSON decode. Reuse entries in the schema's
    // key order and normalize other valid encodings before a writer reuses them.
    for (let i = 0; i < parsed.files.length; i++) {
      const file = parsed.files[i];
      if (!canonicalDecodedFile(file)) parsed.files[i] = entry.parse(file);
    }
    state = { ...parsed, files: parsed.files as NativeFile[] };
  } catch (error) {
    if (!(error instanceof SyntaxError || error instanceof z.ZodError)) throw error;
    throw new ForgeError('INVALID_NATIVE_SOURCE', 'Native source manifest encoding is invalid.');
  }
  validateNativeStateFiles(state);
  return state;
}
function canonicalDecodedFile(value: unknown): value is NativeFile {
  if (typeof value !== 'object' || value === null) return false;
  const keys = Object.keys(value);
  if (keys.length !== 3 || keys[0] !== 'path' || keys[1] !== 'blob' || keys[2] !== 'mode') return false;
  const { path, blob, mode } = value as Record<string, unknown>;
  return (
    typeof path === 'string' &&
    safeRelative(path) &&
    typeof blob === 'string' &&
    oidPattern.test(blob) &&
    validModes.has(mode)
  );
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
  validateNativeStateFiles(state);
  return state;
}
/** Semantic checks shared by decoded reads and already schema-checked writers. */
export function validateNativeStateFiles(state: NativeState) {
  const paths = new Set<string>();
  for (const { path } of state.files) {
    invariant(
      !paths.has(path) && !reservedSegment.test(path),
      'INVALID_NATIVE_SOURCE',
      'Native source manifest paths are invalid.',
    );
    paths.add(path);
  }
  invariant(
    overlappingPathSet(paths).length === 0,
    'INVALID_NATIVE_SOURCE',
    'Source file and directory paths overlap.',
  );
}

/** Derived physical boundaries only: the original State bytes and identity never
 * change. Header/parents and suffix are isolated; file-list anchors depend on
 * path bytes, so an edited blob does not move the remaining boundaries. */
export function stateByteChunks(bytes: Uint8Array, hash: (bytes: Uint8Array) => string) {
  if (
    bytes.length < 1024 * 1024 ||
    bytes.length > 8 * 1024 * 1024 ||
    !new TextDecoder().decode(bytes.subarray(0, 256)).includes('"kind":"forge-source-state"')
  )
    return null;
  const key = new TextEncoder().encode('"files":[');
  let first = -1;
  for (let i = 0; i <= bytes.length - key.length; i++) {
    if (bytes[i] === 34 && key.every((c, n) => bytes[i + n] === c)) {
      first = i + key.length;
      break;
    }
  }
  if (first < 0) return null;
  const ends = [first];
  let at = first,
    chunk = first,
    last = first;
  while (bytes[at] !== 93) {
    // Other validated file values are hex digests and fixed mode tokens: none
    // contains 'p'. Native indexOf skips them without per-entry regex/string
    // allocations. A path literal is consumed completely, including escapes.
    const pathAt = bytes.indexOf(112, at);
    if (
      bytes[at] !== 123 ||
      pathAt < 0 ||
      bytes[pathAt - 1] !== 34 ||
      bytes[pathAt + 1] !== 97 ||
      bytes[pathAt + 2] !== 116 ||
      bytes[pathAt + 3] !== 104 ||
      bytes[pathAt + 4] !== 34 ||
      bytes[pathAt + 5] !== 58 ||
      bytes[pathAt + 6] !== 34
    )
      return null;
    let cursor = pathAt + 7,
      anchor = 2166136261,
      escaped = false,
      closed = false;
    while (cursor < bytes.length) {
      const c = bytes[cursor++]!;
      if (c === 34 && !escaped) {
        closed = true;
        break;
      }
      if (c < 128) {
        anchor = Math.imul(anchor ^ c, 16777619) >>> 0;
        if (escaped) escaped = false;
        else if (c === 92) escaped = true;
      } else {
        const length = c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : 2;
        if (c < 0xc2 || c > 0xf4) return null;
        let code = c & (length === 4 ? 7 : length === 3 ? 15 : 31);
        for (let n = 1; n < length; n++) {
          const next = bytes[cursor++]!;
          if (!(next >= 0x80 && next <= 0xbf)) return null;
          code = (code << 6) | (next & 63);
        }
        if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return null;
        if (code > 0xffff) {
          code -= 0x10000;
          anchor = Math.imul(anchor ^ (0xd800 + (code >>> 10)), 16777619) >>> 0;
          anchor = Math.imul(anchor ^ (0xdc00 + (code & 1023)), 16777619) >>> 0;
        } else anchor = Math.imul(anchor ^ code, 16777619) >>> 0;
        escaped = false;
      }
    }
    if (!closed) return null;
    const end = bytes.indexOf(125, cursor) + 1;
    if (!end) return null;
    if (end - chunk > 1024 * 1024 && last > chunk) {
      ends.push(last);
      chunk = last;
    }
    if (end - chunk > 1024 * 1024) return null;
    if (end - chunk >= 256 * 1024 && ((anchor & 4095) === 0 || end - chunk >= 1024 * 1024 - 8192)) {
      ends.push(end);
      chunk = end;
    }
    last = end;
    at = end;
    if (bytes[at] === 44) at++;
    else if (bytes[at] !== 93) return null;
  }
  if (at > chunk) ends.push(at);
  ends.push(bytes.length);
  let offset = 0;
  const chunks = ends
    .map(end => {
      const content = bytes.subarray(offset, end),
        value = { sha256: hash(content), size: content.length, offset };
      offset = end;
      return value;
    })
    .filter(pin => pin.size > 0);
  return chunks.every(pin => pin.size <= 1024 * 1024) ? chunks : null;
}
