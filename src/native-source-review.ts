import { readSubmodulePointers } from './gitlink.js';
// SPDX-License-Identifier: Apache-2.0
import { readChangeMap } from './change-map.js';
import { sourceFilePage } from './source-file-page.js';
import type { SourceAnchor } from './work-intent-types.js';
import { validateAnchorFile } from './work-source-anchor.js';
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
import { reviewPaths, reviewTextPage } from './source-review-format.js';
export { reviewPaths, reviewTextPage, type ReviewPath } from './source-review-format.js';
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
    state = parseNativeState(selected!),
    paths = reviewPaths(parseNativeState(original!).files, state.files);
  const pins = { base, head, ...(state.conversation ? { conversation: state.conversation } : {}) };
  if (selection?.map) return { ...pins, map: await readChangeMap(base, head, paths, bytes) };
  if (!selection || selection.file === undefined) return { ...pins, paths };
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
    ...pins,
    file,
    ...(file.after?.mode === 'gitlink'
      ? { submodule: (await readSubmodulePointers(state.files, bytes, file.path))[0] }
      : {}),
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
