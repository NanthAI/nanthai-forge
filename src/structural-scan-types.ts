// SPDX-License-Identifier: Apache-2.0
/** What a declaration scanner (Ruby, PHP, Elixir; src/structural-scanned.ts) reads from one file. */
export type ScanDeclaration = { name: string; kind: string; exported: boolean; from: number; to: number };
/** A use of another file or name: `paths` are repository-relative file candidates (first captured
 * one wins); otherwise `specifier` resolves to the files that declare it (`provides`). */
export type ScanUse = {
  specifier: string;
  from: number;
  to: number;
  paths?: string[];
  /** With no captured `paths` match: every captured file at this path below any folder (a gem's
   * `lib/x.rb` inside a monorepo). */
  suffix?: string;
};
export type DeclarationScan = {
  symbols: ScanDeclaration[];
  uses: ScanUse[];
  /** Qualified names this file declares (`App.Accounts`, `App\Http\Controller`). */
  provides: string[];
  /** False when blocks or braces do not balance: nothing is read from the file. */
  ok: boolean;
};

/** Blank `[from, to)` of `out` to spaces, keeping newlines (so offsets and lines stay). */
export function blank(out: string[], from: number, to: number) {
  for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
}
/** End of a quoted literal opened at `i` by `quote`, honouring backslash escapes. */
export function quoted(text: string, i: number, quote: string) {
  let k = i + 1;
  while (k < text.length && text[k] !== quote) k += text[k] === '\\' ? 2 : 1;
  return Math.min(k + 1, text.length);
}
/** End of the line at `i` (the newline itself stays). */
export const lineEnd = (text: string, i: number) => {
  const end = text.indexOf('\n', i);
  return end < 0 ? text.length : end;
};
/** Repository-relative `relative` from the folder of `file`, null when it leaves the repository. */
export function fromFile(file: string, relative: string): string | null {
  const parts = file.split('/').slice(0, -1);
  for (const part of relative.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join('/');
}
