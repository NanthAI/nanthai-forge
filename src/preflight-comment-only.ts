// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type ts from 'typescript';
import { loadTypescript } from './lazy-typescript.js';
import { digest } from './portable-hash.js';
import { machineObjectsDirectory } from './machine-object-store.js';
import { parseNativeState, type NativeFile } from './native-state-format.js';
import { clientCacheRoot } from './root-paths.js';

const scriptKind = (path: string) =>
  /\.[cm]?tsx$/.test(path)
    ? loadTypescript().ScriptKind.TSX
    : /\.[cm]?ts$/.test(path)
      ? loadTypescript().ScriptKind.TS
      : /\.jsx$/.test(path)
        ? loadTypescript().ScriptKind.JSX
        : /\.[cm]?js$/.test(path)
          ? loadTypescript().ScriptKind.JS
          : null;
/** Languages whose header lines are `#` comments (a shebang is code, never a header). */
const hashHeader = (path: string) =>
  /\.(?:sh|bash|py|ya?ml|toml|rb)$/.test(path) || /(?:^|\/)Dockerfile$/.test(path);
let printer: ts.Printer | undefined;

/** The program without its comments and layout, or null when it does not parse cleanly. The
 * parser decides what is a comment (a `//` inside a regex or a string is not one). */
function program(path: string, text: string, kind: ts.ScriptKind) {
  const ts = loadTypescript();
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, kind);
  const diagnostics = (source as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics;
  if (diagnostics?.length) return null;
  return (printer ??= ts.createPrinter({ removeComments: true })).printFile(source);
}
/** The text without its leading block of `#` comments and blank lines (a first-line shebang is
 * kept: it chooses the interpreter). */
const afterHeader = (text: string) => {
  const lines = text.split('\n');
  const shebang = lines[0]?.startsWith('#!') ? lines.splice(0, 1) : [];
  let start = 0;
  while (start < lines.length && /^\s*(?:#.*)?$/.test(lines[start]!)) start++;
  return [...shebang, ...lines.slice(start)].join('\n');
};
/** True when `before` and `after` differ only in comments (and, for JS/TS, layout): the same
 * program runs. Header-only languages compare everything after their leading `#` block. */
export function commentOnlyEdit(path: string, before: string, after: string): boolean {
  if (before === after) return false;
  const kind = scriptKind(path);
  if (kind !== null) {
    const left = program(path, before, kind);
    return left !== null && left === program(path, after, kind);
  }
  return hashHeader(path) && afterHeader(before) === afterHeader(after);
}

/** Changed paths whose saved bytes differ from their base only in comments. Reads the base State and
 * blobs from this machine's object stores (the Lane checkout cached them); never a server call. A
 * path whose base bytes are absent, added, deleted or not a regular file is not comment-only, so a
 * missing observation only costs precision. */
export function commentOnlyPaths(
  root: string,
  base: string,
  head: NativeFile[],
  paths: string[],
  text: (path: string) => string | undefined,
): string[] {
  const candidates = paths.filter(path => scriptKind(path) !== null || hashHeader(path));
  if (!candidates.length) return [];
  const stores = [join(clientCacheRoot(root), 'objects'), machineObjectsDirectory()].filter(
    (dir): dir is string => !!dir,
  );
  const object = (id: string) => {
    for (const dir of stores)
      try {
        const bytes = readFileSync(join(dir, id));
        if (digest(bytes) === id) return bytes;
      } catch {
        /* Try the next store. */
      }
    return null;
  };
  try {
    const state = object(base);
    if (!state) return [];
    const before = new Map(parseNativeState(state).files.map(file => [file.path, file]));
    const after = new Map(head.map(file => [file.path, file]));
    return candidates.filter(path => {
      const left = before.get(path);
      const right = after.get(path);
      if (left?.mode !== 'file' || right?.mode !== 'file' || left.blob === right.blob) return false;
      const current = text(path);
      const previous = object(left.blob);
      return (
        current !== undefined &&
        digest(current) === right.blob &&
        previous !== null &&
        commentOnlyEdit(path, previous.toString('utf8'), current)
      );
    });
  } catch {
    return [];
  }
}
