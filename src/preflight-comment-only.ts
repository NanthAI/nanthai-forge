// SPDX-License-Identifier: Apache-2.0
import type ts from 'typescript';
import { loadTypescript } from './lazy-typescript.js';
import { digest } from './state/hash.js';
import { localObjects } from './machine-object-store.js';
import { parseNativeState, type NativeFile } from './state/format.js';

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
/** Comments that tools read as instructions, in any language: type-checker and linter directives
 * (`@ts-expect-error`, `eslint-disable`, `type: ignore`, `noqa`, `ruff:`, `pyright:`, `rubocop:`,
 * `shellcheck`), test-environment and JSX pragmas (`@vitest-environment`, `@jest-environment`,
 * `@jsx`), triple-slash references, coverage switches, encoding and magic lines
 * (`frozen_string_literal`, `-*- coding -*-`, `vim:`), Dockerfile parser directives (`syntax=`,
 * `escape=`, `check=`), YAML schema lines, build tags and source maps. Editing one changes what runs
 * or how it is checked, so it is code. */
const DIRECTIVE =
  /(?:\/\/+|\/\*+|#+|^\s*\*)\s*(?:@ts-|@jsx|@flow|@vitest-environment|@jest-environment|@vite-ignore|@preserve|<reference\b|<amd-|#\s*source(?:Mapping)?URL|eslint|oxlint|biome-ignore|prettier-ignore|deno-lint|deno-fmt|istanbul\b|c8\b|v8\b|webpack|frozen_string_literal|-\*-|vim?:|coding[:=]|type:|ruff:|noqa|pyright:|mypy:|pylint:|isort:|fmt:|pragma\b|rubocop:|shellcheck|syntax=|escape=|check=|yaml-language-server|go:|\+build|nolint|NOLINT|lint:|@generated|nocheck|typecheck|sorbet|typed:)/i;
const directives = (text: string) =>
  text
    .split('\n')
    .filter(line => DIRECTIVE.test(line))
    .map(line => line.trim());

/** True when `before` and `after` differ only in comments (and, for JS/TS, layout): the same
 * program runs. Header-only languages compare everything after their leading `#` block. A changed,
 * added or removed directive comment (above) is never comment-only. */
export function commentOnlyEdit(path: string, before: string, after: string): boolean {
  if (before === after) return false;
  if (directives(before).join('\n') !== directives(after).join('\n')) return false;
  const kind = scriptKind(path);
  if (kind !== null) {
    const left = program(path, before, kind);
    return left !== null && left === program(path, after, kind);
  }
  return hashHeader(path) && afterHeader(before) === afterHeader(after);
}

/** The base and saved text of each changed regular file that exists on both sides and parses as source.
 * Reads the base State and blobs from this machine's object stores (the Lane checkout cached them);
 * never a server call. A path whose base bytes are absent, added, deleted or not a regular file is
 * missing, so an absent observation only costs precision. */
export function changedSources(
  root: string,
  base: string,
  head: NativeFile[],
  paths: string[],
  text: (path: string) => string | undefined,
): Map<string, { before: string; after: string }> {
  const found = new Map<string, { before: string; after: string }>();
  const candidates = paths.filter(path => scriptKind(path) !== null || hashHeader(path));
  if (!candidates.length) return found;
  const object = localObjects(root);
  try {
    const state = object(base);
    if (!state) return found;
    const before = new Map(parseNativeState(state).files.map(file => [file.path, file]));
    const after = new Map(head.map(file => [file.path, file]));
    for (const path of candidates) {
      const left = before.get(path);
      const right = after.get(path);
      if (left?.mode !== 'file' || right?.mode !== 'file' || left.blob === right.blob) continue;
      const current = text(path);
      const previous = object(left.blob);
      if (current !== undefined && digest(current) === right.blob && previous !== null)
        found.set(path, { before: previous.toString('utf8'), after: current });
    }
  } catch {
    return new Map();
  }
  return found;
}
