// SPDX-License-Identifier: Apache-2.0
import { readChangeMap } from './change-map.js';
import { sourceFilePage } from './source-file-page.js';
import type { SourceAnchor } from './work-intent-types.js';
import { validateAnchorFile } from './work-source-anchor.js';
import type { NativeFile } from './native-source.js';
import { parseNativeState } from './native-source.js';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { contextualHunks } from './review-hunks.js';
import type { z } from 'zod';
import type { nativeManifestSchema } from './work-archive-metadata.js';

type ReviewSelection = {
  file?: string;
  map?: boolean;
  beforeOffset?: number;
  afterOffset?: number;
  line?: number;
  anchor?: SourceAnchor;
};

type Manifest = z.infer<typeof nativeManifestSchema>;
type Pin = { sha256: string; size: number };
export type ReviewPath = {
  path: string;
  status: 'added' | 'deleted' | 'modified' | 'unchanged';
  before: NativeFile | null;
  after: NativeFile | null;
};
export function reviewPaths(before: NativeFile[], after: NativeFile[]): ReviewPath[] {
  const a = new Map(before.map(file => [file.path, file])),
    b = new Map(after.map(file => [file.path, file]));
  return [...new Set([...a.keys(), ...b.keys()])].sort().map(path => {
    const original = a.get(path) ?? null,
      selected = b.get(path) ?? null;
    return {
      path,
      before: original,
      after: selected,
      status: !original
        ? 'added'
        : !selected
          ? 'deleted'
          : original.blob !== selected.blob || original.mode !== selected.mode
            ? 'modified'
            : 'unchanged',
    };
  });
}
export function reviewTextPage(bytes: Buffer, offset = 0) {
  invariant(Number.isSafeInteger(offset) && offset >= 0, 'BAD_ARGUMENT', 'Choose a valid source position.');
  let value: string;
  try {
    value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { kind: 'binary' as const, size: bytes.length };
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) return { kind: 'binary' as const, size: bytes.length };
  invariant(offset <= value.length, 'BAD_ARGUMENT', 'Source position is beyond this exact file.');
  // A transport page, not a file-size exclusion: every character remains reachable.
  let end = Math.min(value.length, offset + 16000);
  if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]!)) end--;
  const prefix = value.slice(0, offset),
    line = prefix.split('\n').length,
    column = offset - prefix.lastIndexOf('\n');
  return {
    kind: 'text' as const,
    size: bytes.length,
    text: value.slice(offset, end),
    offset,
    nextOffset: end < value.length ? end : null,
    totalCharacters: value.length,
    line,
    column,
  };
}
export async function readNativeSourceReview(
  manifest: Manifest,
  base: string,
  head: string,
  read: (pins: Pin[]) => Promise<Buffer[]>,
  selection?: ReviewSelection,
) {
  const objects = new Map(manifest.files.map(file => [file.path, file]));
  function pin(id: string) {
    invariant(/^[a-f0-9]{64}$/.test(id), 'BAD_ARGUMENT', 'Select an exact native source identity.');
    const file = objects.get(`objects/${id}`);
    invariant(
      file?.sha256 === id,
      'SOURCE_UNAVAILABLE',
      'This source object is not retained in the selected checkpoint.',
    );
    return file;
  }
  async function bytes(ids: string[]) {
    const pins = ids.map(pin),
      values = await read(pins);
    invariant(
      values.length === pins.length &&
        values.every((value, i) => value.length === pins[i]!.size && digest(value) === ids[i]),
      'INVALID_NATIVE_SOURCE',
      'Stored source differs from its exact identity.',
    );
    return values;
  }
  return readNativeSourceReviewBytes(base, head, bytes, selection);
}

/** Same review semantics with exact-byte pins supplied by an authorized derived index. */
export async function readNativeSourceReviewBytes(
  base: string,
  head: string,
  bytes: (ids: string[]) => Promise<Buffer[]>,
  selection?: ReviewSelection,
) {
  const [original, selected] = await bytes([base, head]),
    paths = reviewPaths(parseNativeState(original!).files, parseNativeState(selected!).files);
  if (selection?.map) return { base, head, map: await readChangeMap(base, head, paths, bytes) };
  if (!selection || selection.file === undefined) return { base, head, paths };
  const file = paths.find(path => path.path === selection.file);
  invariant(file, 'NOT_FOUND', 'Choose a file from this source comparison.');
  const ids = [file.before?.blob, file.after?.blob].filter((id): id is string => !!id),
    contents = await bytes(ids);
  const a = file.before ? contents.shift()! : Buffer.alloc(0),
    b = file.after ? contents.shift()! : Buffer.alloc(0);
  if (selection.anchor)
    validateAnchorFile(
      selection.anchor,
      (selection.anchor.side === 'before' ? file.before : file.after) ?? undefined,
      selection.anchor.side === 'before' ? a : b,
    );
  return {
    base,
    head,
    file,
    before: file.before ? reviewTextPage(a, selection.beforeOffset) : null,
    after: file.after ? reviewTextPage(b, selection.afterOffset) : null,
    ...(selection.line !== undefined && file.after
      ? { source: sourceFilePage(b, selection.file, selection.line) }
      : {}),
    comparison: {
      ...contextualHunks(a, b, 3),
      beforeBlob: file.before?.blob ?? null,
      afterBlob: file.after?.blob ?? null,
    },
  };
}
