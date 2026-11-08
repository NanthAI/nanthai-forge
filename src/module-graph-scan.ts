// SPDX-License-Identifier: Apache-2.0
/** Lexical helpers for the module graph (src/module-graph.ts): blank comments and string literals
 * while keeping every offset and newline, so line-anchored patterns stay exact. Syntactic and
 * approximate by design: a construct it misreads adds edges (over-selects); it never removes one,
 * because every caller treats what it cannot read as "depends on the whole package". */

export type Syntax = 'python' | 'go' | 'java' | 'kotlin' | 'rust';

const fill = (out: string[], from: number, to: number, text: string) => {
  for (let i = from; i < to; i++) out[i] = text[i] === '\n' ? '\n' : ' ';
};

/** End of a quoted literal starting at `i` (the opening quote), stopping at a newline unless
 * `multiline`: an unterminated literal never swallows the rest of the file. */
function quotedEnd(text: string, i: number, quote: string, multiline: boolean) {
  for (let j = i + quote.length; j < text.length; j++) {
    if (text[j] === '\\') j++;
    else if (!multiline && text[j] === '\n') return j;
    else if (text.startsWith(quote, j)) return j + quote.length;
  }
  return text.length;
}

/** `text` with comments blanked and, unless `keepStrings`, string and character literals too. */
export function blank(text: string, syntax: Syntax, keepStrings = false): string {
  const out = text.split('');
  const nested = syntax === 'rust' || syntax === 'kotlin';
  for (let i = 0; i < text.length;) {
    const c = text[i]!;
    if (syntax === 'python' ? c === '#' : c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      const stop = end < 0 ? text.length : end;
      fill(out, i, stop, text);
      i = stop;
      continue;
    }
    if (syntax !== 'python' && c === '/' && text[i + 1] === '*') {
      let depth = 0,
        j = i;
      for (; j < text.length; j++) {
        if (text[j] === '/' && text[j + 1] === '*') {
          depth++;
          j++;
        } else if (text[j] === '*' && text[j + 1] === '/') {
          j++;
          if (!nested || --depth === 0) break;
        }
      }
      const stop = Math.min(text.length, j + 1);
      fill(out, i, stop, text);
      i = stop;
      continue;
    }
    let end = -1;
    if (syntax === 'python' && (c === '"' || c === "'")) {
      const triple = text.startsWith(c.repeat(3), i);
      end = quotedEnd(text, i, triple ? c.repeat(3) : c, triple);
    } else if (syntax !== 'python' && c === '"') {
      const triple = (syntax === 'java' || syntax === 'kotlin') && text.startsWith('"""', i);
      const close = triple ? text.indexOf('"""', i + 3) : -1;
      end = triple ? (close < 0 ? text.length : close + 3) : quotedEnd(text, i, '"', syntax === 'rust');
    } else if (syntax === 'go' && c === '`') {
      const close = text.indexOf('`', i + 1);
      end = close < 0 ? text.length : close + 1;
    } else if (
      syntax === 'rust' &&
      c === 'r' &&
      /^r#*"/.test(text.slice(i, i + 8)) &&
      !/\w/.test(text[i - 1] ?? '')
    ) {
      const hashes = /^r(#*)"/.exec(text.slice(i, i + 8))![1]!;
      const close = text.indexOf(`"${hashes}`, i + hashes.length + 2);
      end = close < 0 ? text.length : close + 1 + hashes.length;
    } else if (syntax !== 'python' && c === "'") {
      // A character literal ('x', '\n'); a Rust lifetime ('a) has no closing quote two later.
      if (text[i + 1] === '\\') end = quotedEnd(text, i, "'", false);
      else if (text[i + 2] === "'") end = i + 3;
    }
    if (end > i) {
      if (!keepStrings) fill(out, i, end, text);
      i = end;
      continue;
    }
    i++;
  }
  return out.join('');
}

/** Every identifier-like word of `text`. */
export const identifiers = (text: string) => new Set(text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);

/** `code` (already blanked) with everything inside braces (and parentheses, with `parens`) blanked:
 * top-level declarations only. */
export function topLevel(code: string, parens = false): string {
  const out = code.split('');
  let depth = 0;
  for (let i = 0; i < code.length; i++) {
    const c = code[i]!;
    if (c === '}' || (parens && c === ')')) depth = Math.max(0, depth - 1);
    if (depth > 0 && c !== '\n') out[i] = ' ';
    if (c === '{' || (parens && c === '(')) depth++;
  }
  return out.join('');
}

export const posixDirname = (path: string) =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
export const posixBasename = (path: string) => path.slice(path.lastIndexOf('/') + 1);
export const joinPath = (...parts: string[]) => parts.filter(Boolean).join('/');
