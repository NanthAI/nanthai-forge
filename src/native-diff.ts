// SPDX-License-Identifier: Apache-2.0
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { NativeSource, type NativeFile } from './native-source.js';
import { nativeFile } from './native-file.js';
import { digest } from './hash.js';

function changedFiles(before: NativeFile[], after: NativeFile[]) {
  const a = new Map(before.map(file => [file.path, file])),
    b = new Map(after.map(file => [file.path, file]));
  return [...new Set([...a.keys(), ...b.keys()])]
    .sort()
    .filter(path => a.get(path)?.blob !== b.get(path)?.blob || a.get(path)?.mode !== b.get(path)?.mode)
    .map(path => ({ path, before: a.get(path), after: b.get(path) }));
}
export function nativeChanges(before: NativeFile[], after: NativeFile[]) {
  return changedFiles(before, after)
    .map(file => `${!file.before ? 'A' : !file.after ? 'D' : 'M'} ${file.path}`)
    .join('\n');
}
function text(bytes: Buffer): string | null {
  try {
    const value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) ? null : value;
  } catch {
    return null;
  }
}
function lines(value: string) {
  if (!value) return [];
  const result = value.split('\n');
  if (value.endsWith('\n')) result.pop();
  return result;
}
function body(value: string, prefix: string) {
  return [
    ...lines(value).map(line => prefix + line),
    ...(value && !value.endsWith('\n') ? ['\\ No newline at end of file'] : []),
  ].join('\n');
}
function metadata(file: NativeFile | undefined, bytes: Buffer) {
  return file ? `mode ${file.mode} · ${bytes.length} bytes · SHA-256 ${file.blob}` : 'absent';
}

/** Whole-file review only. Live bytes must match their captured identity. */
export function nativeDiff(
  source: NativeSource,
  before: NativeFile[],
  after: NativeFile[],
  liveRoot?: string,
): string {
  const blocks = changedFiles(before, after).map(file => {
    const original = file.before ? source.object(file.before.blob) : Buffer.alloc(0);
    let selected: Buffer = Buffer.alloc(0);
    if (!file.after && liveRoot && existsSync(join(liveRoot, file.path)))
      return `Review ${file.path}\nPreview unavailable: the deleted live path reappeared after capture. Refresh to review its current bytes.`;
    if (file.after) {
      if (!liveRoot) selected = source.object(file.after.blob);
      else {
        try {
          const { bytes, mode } = nativeFile(liveRoot, file.path);
          if (!bytes || digest(bytes) !== file.after.blob || mode !== file.after.mode)
            throw Error('Changed captured source');
          selected = bytes;
        } catch {
          return `Review ${file.path}\nPreview unavailable: live source changed or could not be read safely after capture. Refresh to review its current bytes. Expected SHA-256 ${file.after.blob}; no replacement text was inferred.`;
        }
      }
    }
    const header = `diff --native ${file.path}\n--- ${file.before ? `a/${file.path}` : '/dev/null'} · ${metadata(file.before, original)}\n+++ ${file.after ? `b/${file.path}` : '/dev/null'} · ${metadata(file.after, selected)}`;
    const a = text(original),
      b = text(selected);
    if (a === null || b === null)
      return `${header}\nBinary or non-UTF-8 content; exact size, hash and mode shown above.`;
    const content = [body(a, '-'), body(b, '+')].filter(Boolean).join('\n');
    return `${header}\n@@ -${a ? 1 : 0},${lines(a).length} +${b ? 1 : 0},${lines(b).length} @@\n${content}`;
  });
  return blocks.length
    ? `Whole-file before/after review (not a minimal hunk diff).\n${blocks.join('\n\n')}`
    : '';
}
