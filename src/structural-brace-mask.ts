// SPDX-License-Identifier: Apache-2.0
/** Comment and string masking for the Swift, Kotlin and Dart declaration scanner
 * (src/structural-brace-scan.ts). Block comments nest in all three; Swift strings interpolate
 * `\\(…)` (raw `#"…"#` ones `\\#(…)`), Kotlin and Dart `${…}`, Dart `r'…'` strings are raw. */
export type BraceLanguage = 'swift' | 'kotlin' | 'dart';

/** Replaces comments with spaces and each string literal (interpolations included) with `0` and
 * spaces, keeping offsets and line breaks. */
export function maskBraces(text: string, language: BraceLanguage): string {
  const out = text.split('');
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  /** A string literal becomes one `0` (a value, so an expression never seems to end mid-line). */
  const literal = (from: number, to: number) => {
    blank(from, to);
    out[from] = '0';
  };
  /** Code from `i` up to (not including) `closer` at depth zero; returns the closer's index. */
  const code = (start: number, closer?: string): number => {
    let i = start,
      depth = 0;
    while (i < text.length) {
      const c = text[i]!,
        next = text[i + 1];
      if (closer && depth === 0 && c === closer) return i;
      if (c === '(' || c === '{' || c === '[') depth++;
      else if (c === ')' || c === '}' || c === ']') depth--;
      if (c === '/' && next === '/') {
        const end = text.indexOf('\n', i);
        blank(i, end < 0 ? text.length : end);
        i = end < 0 ? text.length : end;
      } else if (c === '/' && next === '*') {
        let level = 0,
          k = i;
        while (k < text.length) {
          if (text.startsWith('/*', k)) {
            level++;
            k += 2;
          } else if (text.startsWith('*/', k)) {
            k += 2;
            if (--level === 0) break;
          } else k++;
        }
        blank(i, k);
        i = k;
      } else if (
        c === '"' ||
        c === "'" ||
        (language === 'swift' && c === '#' && /^#+"/.test(text.slice(i, i + 8)))
      ) {
        const end = string(i);
        literal(i, end);
        i = end;
      } else if (
        language === 'dart' &&
        c === 'r' &&
        (next === '"' || next === "'") &&
        !/[\w$]/.test(text[i - 1] ?? '')
      ) {
        const end = string(i + 1, true);
        literal(i, end);
        i = end;
      } else i++;
    }
    return text.length;
  };
  /** End (exclusive) of the string literal opening at `start` (`raw`: Dart `r'…'`). */
  const string = (start: number, raw = false): number => {
    let i = start,
      hashes = 0;
    while (text[i] === '#') {
      hashes++;
      i++;
    }
    const quote = text[i]!;
    const triple = text.startsWith(quote.repeat(3), i);
    const delimiter = (triple ? quote.repeat(3) : quote) + '#'.repeat(hashes);
    const pounds = '#'.repeat(hashes);
    i += triple ? 3 : 1;
    while (i < text.length) {
      if (text.startsWith(delimiter, i)) return i + delimiter.length;
      if (!triple && text[i] === '\n') return i;
      if (!raw && text[i] === '\\' && text.startsWith(pounds, i + 1)) {
        const after = i + 1 + hashes;
        // Swift `\(…)` (or `\#(…)` in a raw string) holds code, which may hold strings.
        if (language === 'swift' && text[after] === '(') i = code(after + 1, ')') + 1;
        else i = hashes ? after : i + 2;
        continue;
      }
      if (!raw && language !== 'swift' && text.startsWith('${', i)) {
        i = code(i + 2, '}') + 1;
        continue;
      }
      i++;
    }
    return text.length;
  };
  code(0);
  return out.join('');
}
