// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
/** Test files that read one of `docs` (scripts/docs-readers.mjs): test -> the document and the file that names it. */
export function docsReaders(
  files:
    | Map<string, string>
    | {
        keys(): Iterable<string>;
        [Symbol.iterator](): Iterator<[string, string]>;
        get(path: string): string | undefined;
      },
  docs: string[],
): Map<string, { doc: string; via: string; linked?: true }>;
