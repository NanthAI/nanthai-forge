// SPDX-License-Identifier: Apache-2.0
import type { NativeFile } from './native-source.js';
import { invariant } from './errors.js';
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
export function reviewTextPage(bytes: Uint8Array, offset = 0) {
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
