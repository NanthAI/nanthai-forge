// SPDX-License-Identifier: Apache-2.0
import { blank, lineEnd, quoted, type DeclarationScan } from './structural-scan-types.js';

const SIGIL_CLOSE: Record<string, string> = { '(': ')', '[': ']', '{': '}', '<': '>' };

/** Elixir without comments, strings, charlists, heredocs, sigils and character literals (offsets kept). */
export function maskElixir(text: string) {
  const out = text.split('');
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '#') {
      const end = lineEnd(text, i);
      blank(out, i, end);
      i = end;
    } else if ((c === '"' || c === "'") && text.startsWith(c.repeat(3), i)) {
      const close = text.indexOf(c.repeat(3), i + 3);
      const end = close < 0 ? text.length : close + 3;
      blank(out, i, end);
      i = end;
    } else if (c === '"' || c === "'") {
      const end = quoted(text, i, c);
      blank(out, i, end);
      i = end;
    } else if (c === '~' && /^~[a-zA-Z]+[/|"'([{<]/.test(text.slice(i, i + 12))) {
      const name = /^~[a-zA-Z]+/.exec(text.slice(i))![0];
      const open = text[i + name.length]!;
      const end = quoted(text, i + name.length, SIGIL_CLOSE[open] ?? open);
      blank(out, i, end);
      i = end;
    } else if (c === '?' && /\S/.test(text[i + 1] ?? '') && !/[\w)\]}]/.test(text[i - 1] ?? ' ')) {
      // A character literal (`?a`, `?#`, `?\n`).
      const end = i + (text[i + 1] === '\\' ? 3 : 2);
      blank(out, i, end);
      i = end;
    } else i++;
  }
  return out.join('');
}

const DEF = /^(defp?|defmacrop?|defguardp?|defdelegate)$/;
const TOKEN = /[A-Z][\w]*(?:\.[A-Z]\w*)*(?:\.\{)?|[a-z_][\w]*[?!]?:?|__MODULE__|[{}(),.]|\S/g;

/** Modules and protocols (provided by their full name, nested ones joined: `App.Accounts.User`),
 * public and private functions and macros (one symbol per name per module), and `alias`, `import`,
 * `use` and `require` uses (`alias A.{B, C}` expands; `__MODULE__` is the enclosing module). */
export function scanElixir(text: string): DeclarationScan {
  const masked = maskElixir(text);
  const out: DeclarationScan = { symbols: [], uses: [], provides: [], ok: true };
  const tokens = [...masked.matchAll(TOKEN)].map(m => ({ v: m[0], from: m.index! }));
  /** Open `do … end` and `fn … end` blocks; a module block carries its full name. */
  const stack: { module?: string }[] = [];
  const seen = new Set<string>();
  const current = () => [...stack].reverse().find(block => block.module)?.module ?? '';
  let pendingModule: string | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const { v } = tokens[i]!;
    if (v === 'do:') pendingModule = undefined;
    else if (v === 'do') {
      stack.push(pendingModule ? { module: pendingModule } : {});
      pendingModule = undefined;
    } else if (v === 'fn') stack.push({});
    else if (v === 'end') {
      if (!stack.pop()) return { ...out, ok: false };
    } else if (v === 'defmodule' || v === 'defprotocol') {
      const name = tokens[i + 1];
      if (!name || !/^[A-Z]/.test(name.v)) continue;
      const full = [current(), name.v].filter(Boolean).join('.');
      out.provides.push(full);
      const short = name.v.slice(name.v.lastIndexOf('.') + 1);
      const at = name.from + name.v.length - short.length;
      out.symbols.push({
        name: short,
        kind: v === 'defmodule' ? 'ModuleDefinition' : 'ProtocolDefinition',
        exported: true,
        from: at,
        to: at + short.length,
      });
      pendingModule = full;
    } else if (DEF.test(v)) {
      const name = tokens[i + 1];
      if (!name || !/^[a-z_]/.test(name.v) || name.v.endsWith(':')) continue;
      const key = `${current()}#${name.v}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.symbols.push({
        name: name.v,
        kind: /^defmacro/.test(v) ? 'MacroDefinition' : 'FunctionDefinition',
        exported: !/p$/.test(v),
        from: name.from,
        to: name.from + name.v.length,
      });
    } else if (/^(?:alias|import|use|require)$/.test(v) && tokens[i - 1]?.v !== '.') {
      let name = tokens[i + 1];
      if (!name) continue;
      let base = '';
      if (name.v === '__MODULE__' && tokens[i + 2]?.v === '.' && /^[A-Z]/.test(tokens[i + 3]?.v ?? '')) {
        base = current();
        name = tokens[i + 3]!;
      }
      if (!/^[A-Z]/.test(name.v)) continue;
      const head = [base, name.v.replace(/\.\{$/, '')].filter(Boolean).join('.');
      const use = (specifier: string, at: { from: number; v: string }) =>
        out.uses.push({ specifier, from: at.from, to: at.from + at.v.length });
      if (!name.v.endsWith('.{')) {
        use(head, name);
        continue;
      }
      for (let k = tokens.indexOf(name) + 1; k < tokens.length && tokens[k]!.v !== '}'; k++)
        if (/^[A-Z]/.test(tokens[k]!.v)) use(`${head}.${tokens[k]!.v}`, tokens[k]!);
    }
  }
  if (stack.length) out.ok = false;
  return out;
}
