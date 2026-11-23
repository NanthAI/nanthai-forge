// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { Limits, Position } from './types.js';

/** Files that are never text, even if their bytes happen to decode as UTF-8. */
export const binaryInventoryPath = (path: string): boolean =>
  /\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|class|dll|exe|so|dylib|a|o|obj|wasm|woff2?|ttf|otf|eot|mp[34]|mov|avi|webm|ogg|wav|flac|bin|dat|pyc|sqlite3?|db)$/i.test(
    path,
  );

export function inventoryText(bytes: Uint8Array): string | undefined {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (!text.includes('\0')) return text;
  } catch {
    // A non-UTF-8 file is not eligible for a text entry.
  }
  return undefined;
}

export function inventoryFull(limits: Limits, files: number, bytes: number, size = 0): boolean {
  return (
    files >= limits.maxFiles ||
    bytes >= limits.maxTotalBytes ||
    size > limits.maxFileBytes ||
    bytes + size > limits.maxTotalBytes
  );
}

/** Compute only the end position, without allocating a line-start index. */
export function inventoryEntry(path: string, text: string): { path: string; end: Position } {
  let line = 1,
    start = 0;
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', start)) {
    line++;
    start = index + 1;
  }
  return { path, end: { offset: text.length, line, column: text.length - start + 1 } };
}
