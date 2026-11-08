// SPDX-License-Identifier: Apache-2.0

/** Import declarations per file, keyed by their exact line text. `lines` are
 * 0-based line numbers; `safe` is false when removing one copy could change
 * meaning (multiline, conditional, or attached to something else). */
export type ImportDeclarations = Map<string, { lines: number[]; safe: boolean }>;
export type ImportLanguage = {
  /** Cheap filter on a line both sides added before any file is read. */
  hint: RegExp;
  declarations: (text: string) => ImportDeclarations;
  /** A duplicate import fails the build (Go "redeclared", Rust E0252), so an
   * unsafe duplicate is a conflict. Elsewhere it is harmless and kept as merged. */
  duplicateBreaks: boolean;
};

export const statementKey = (text: string) => text.replace(/\r?\n$/, '');

/** Imports beyond JS/TS are read from the file prologue only, line by line:
 * comments, the package/module header, then one import per line. The first
 * line that is anything else ends the scan, so code, strings and nested scopes
 * are never read. This is deliberately parser-free: the merge runs inside every
 * hosted bundle that composes, and the prologue is where these languages put
 * imports (Go and Java require it). */
type Prologue = {
  /** Line comment prefixes. */
  comments: RegExp;
  /** `/* … *\/` block comments. */
  blocks?: boolean;
  /** Python module docstrings. */
  docstrings?: boolean;
  /** Header lines that are neither imports nor the end of the prologue. */
  header: RegExp;
  /** A whole single-line import. */
  single: RegExp;
  /** Imports that continue on later lines: recorded unsafe, skipped to `end`. */
  multiline?: { start: RegExp; end: RegExp }[];
  /** `import ( … )`: each line inside is one import. */
  group?: { start: RegExp; end: RegExp; item: RegExp };
  /** A line that binds the next import to itself (Rust `#[cfg(…)]`). */
  attribute?: RegExp;
  /** A line that can make any import conditional (C# `#if`). */
  hazard?: RegExp;
  /** An import that must never be removed (cgo `import "C"`). */
  pinned?: RegExp;
};

function prologue(spec: Prologue) {
  return (text: string): ImportDeclarations => {
    const result: ImportDeclarations = new Map(),
      rows = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const add = (index: number, safe: boolean) => {
      const key = statementKey(rows[index]!),
        current = result.get(key) ?? { lines: [], safe: true };
      current.lines.push(index);
      current.safe &&= safe;
      result.set(key, current);
    };
    /** Inside a comment, docstring or multiline import: 'done' on its last line,
     * 'stop' when it closes mid-line (code follows on that line). */
    let until: ((line: string) => 'more' | 'done' | 'stop') | null = null,
      group = false,
      attached = false,
      hazard = false;
    for (let index = 0; index < rows.length; index++) {
      const line = rows[index]!.trim();
      if (until) {
        const state = until(line);
        if (state === 'stop') break;
        if (state === 'done') until = null;
        continue;
      }
      const closes = (close: string) => (part: string) =>
        !part.includes(close) ? 'more' : part.endsWith(close) ? 'done' : 'stop';
      if (!line || spec.comments.test(line)) continue;
      if (spec.blocks && line.startsWith('/*')) {
        const state = closes('*/')(line.slice(2));
        if (state === 'stop') break;
        if (state === 'more') until = closes('*/');
        continue;
      }
      const docstring = spec.docstrings && /^[rRuUbB]{0,2}("""|''')/.exec(line);
      if (docstring) {
        const state = closes(docstring[1]!)(line.slice(docstring[0].length));
        if (state === 'stop') break;
        if (state === 'more') until = closes(docstring[1]!);
        continue;
      }
      if (group) {
        if (spec.group!.end.test(line)) group = false;
        else if (spec.group!.item.test(line)) add(index, !spec.pinned?.test(line));
        else break;
        continue;
      }
      if (spec.hazard?.test(line)) hazard = true;
      else if (spec.attribute?.test(line)) attached = true;
      else if (spec.group?.start.test(line)) group = true;
      else if (spec.single.test(line)) {
        add(index, !attached && !spec.pinned?.test(line));
        attached = false;
      } else if (spec.multiline?.some(item => item.start.test(line))) {
        const end = spec.multiline.find(item => item.start.test(line))!.end;
        add(index, false);
        until = part => (end.test(part) ? 'done' : 'more');
        attached = false;
      } else if (spec.header.test(line)) attached = false;
      else break;
    }
    if (hazard) for (const item of result.values()) item.safe = false;
    return result;
  };
}

const trailing = String.raw`\s*(?:\/\/.*)?$`;
const PY_NAMES = (name: string) => String.raw`${name}(?:\s+as\s+\w+)?(?:\s*,\s*${name}(?:\s+as\s+\w+)?)*`;
const GO_SPEC = String.raw`(?:(?:[A-Za-z_]\w*|\.)\s+)?"[^"\\]*"`;
const LANGUAGES: [RegExp, ImportLanguage][] = [
  [
    /\.pyi?$/,
    {
      hint: /^\s*(?:import|from)\s/,
      declarations: prologue({
        comments: /^#/,
        docstrings: true,
        header: /^$/,
        single: new RegExp(
          String.raw`^(?:import\s+${PY_NAMES(String.raw`[\w.]+`)}|from\s+[\w.]+\s+import\s+(?:\*|${PY_NAMES(String.raw`\w+`)}|\(\s*${PY_NAMES(String.raw`\w+`)}\s*,?\s*\)))\s*(?:#.*)?$`,
        ),
        multiline: [
          { start: /^(?:from|import)\s[^#]*\(\s*(?:#.*)?$/, end: /\)/ },
          { start: /^(?:from|import)\s.*\\$/, end: /[^\\]$/ },
        ],
      }),
      duplicateBreaks: false,
    },
  ],
  [
    /\.java$/,
    {
      hint: /^\s*import\s/,
      declarations: prologue({
        comments: /^\/\//,
        blocks: true,
        header: /^package\s+[\w.]+\s*;\s*(?:\/\/.*)?$/,
        single: new RegExp(String.raw`^import\s+(?:static\s+)?[\w.]+(?:\.\*)?\s*;${trailing}`),
        multiline: [{ start: /^import\s+[^;]*$/, end: /;/ }],
      }),
      duplicateBreaks: false,
    },
  ],
  [
    /\.rs$/,
    {
      hint: /^\s*(?:pub(?:\([^)]*\))?\s+)?use\s/,
      declarations: prologue({
        comments: /^\/\//,
        blocks: true,
        header:
          /^(?:#!\[.*\]|(?:pub(?:\([^)]*\))?\s+)?(?:mod\s+\w+|extern\s+crate\s+\w+(?:\s+as\s+\w+)?)\s*;)\s*(?:\/\/.*)?$/,
        // A use path holds no strings, so a line from `use` to its first `;` is one statement.
        single: new RegExp(String.raw`^(?:pub(?:\([^)]*\))?\s+)?use\s+[^;]*;${trailing}`),
        multiline: [{ start: /^(?:pub(?:\([^)]*\))?\s+)?use\s+[^;]*$/, end: /;\s*(?:\/\/.*)?$/ }],
        attribute: /^#\[/,
      }),
      duplicateBreaks: true,
    },
  ],
  [
    /\.go$/,
    {
      hint: /"/,
      declarations: prologue({
        comments: /^\/\//,
        blocks: true,
        header: /^package\s+\w+\s*(?:\/\/.*)?$/,
        single: new RegExp(`^import\\s+${GO_SPEC}${trailing}`),
        group: {
          start: /^import\s*\(\s*(?:\/\/.*)?$/,
          end: /^\)$/,
          item: new RegExp(`^${GO_SPEC}${trailing}`),
        },
        pinned: /"C"/,
      }),
      duplicateBreaks: true,
    },
  ],
  [
    /\.cs$/,
    {
      hint: /^\s*(?:global\s+)?using\s/,
      declarations: prologue({
        comments: /^\/\//,
        blocks: true,
        header: /^extern\s+alias\s+\w+\s*;$/,
        single: new RegExp(
          String.raw`^(?:global\s+)?using\s+(?:static\s+)?(?:[A-Za-z_]\w*\s*=\s*)?[A-Za-z_][\w.]*(?:<[\w.,\s<>]*>)?\s*;${trailing}`,
        ),
        hazard: /^#/,
      }),
      duplicateBreaks: false,
    },
  ],
];
export function importLanguage(path: string): ImportLanguage | undefined {
  return LANGUAGES.find(([pattern]) => pattern.test(path))?.[1];
}
