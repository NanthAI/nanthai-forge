// SPDX-License-Identifier: Apache-2.0
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
): Map<string, { doc: string; via: string }>;
