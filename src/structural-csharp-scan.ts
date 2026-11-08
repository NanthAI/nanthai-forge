// SPDX-License-Identifier: Apache-2.0
/** C# header scanner: comments, strings and preprocessor lines are masked, bodies are skipped. */
const MODIFIERS = new Set(
  'public private protected internal static abstract sealed virtual override readonly const new partial unsafe async extern volatile required file ref implicit explicit fixed global'.split(
    ' ',
  ),
);
const TYPE_KINDS: Record<string, string> = {
  class: 'ClassDeclaration',
  struct: 'StructDeclaration',
  interface: 'InterfaceDeclaration',
  enum: 'EnumDeclaration',
  record: 'RecordDeclaration',
};
type Token = { v: string; from: number; to: number };
type Context = { name: string; kind: string; exported: boolean };

/** Replaces comments, string and character literals and `#` lines with spaces, keeping offsets. */
export function maskCsharp(text: string): string {
  const out = text.split('');
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i]!,
      next = text[i + 1];
    if (c === '/' && next === '/') {
      const end = text.indexOf('\n', i);
      blank(i, end < 0 ? text.length : end);
      i = end < 0 ? text.length : end;
    } else if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      blank(i, end < 0 ? text.length : end + 2);
      i = end < 0 ? text.length : end + 2;
    } else if (c === '#' && /^[ \t]*$/.test(text.slice(text.lastIndexOf('\n', i - 1) + 1, i))) {
      const end = text.indexOf('\n', i);
      blank(i, end < 0 ? text.length : end);
      i = end < 0 ? text.length : end;
    } else if (c === '"' || c === "'" || ((c === '@' || c === '$') && /^[@$]*"/.test(text.slice(i, i + 3)))) {
      const start = i;
      while (text[i] === '@' || text[i] === '$') i++;
      const verbatim = text.slice(start, i).includes('@'),
        quote = text[i]!;
      let run = 0;
      while (text[i + run] === quote) run++;
      const raw = quote === '"' && run >= 3;
      i += raw ? run : 1;
      for (;;) {
        if (i >= text.length) break;
        if (raw ? text.startsWith(quote.repeat(run), i) : text[i] === quote) {
          if (verbatim && text[i + 1] === quote) {
            i += 2;
            continue;
          }
          i += raw ? run : 1;
          break;
        }
        i += text[i] === '\\' && !verbatim && !raw ? 2 : 1;
      }
      blank(start, i);
    } else i++;
  }
  return out.join('');
}

const tokens = (masked: string): Token[] =>
  [...masked.matchAll(/[\p{L}_@][\p{L}\p{N}_]*|=>|::|\S/gu)].map(m => ({
    v: m[0],
    from: m.index!,
    to: m.index! + m[0].length,
  }));
const isName = (token?: Token) => !!token && /^[\p{L}_@]/u.test(token.v);
/** Index of the name just before the `(` at `open`, stepping over generic arguments (`Run<T>(`). */
function nameBefore(head: Token[], open: number, floor: number): number {
  let at = open - 1;
  if (head[at]?.v === '>') {
    let level = 0;
    for (; at >= floor; at--) {
      if (head[at]!.v === '>') level++;
      else if (head[at]!.v === '<' && --level === 0) break;
    }
    at--;
  }
  return at;
}

export type Scan = {
  symbols: { name: string; kind: string; exported: boolean; from: number; to: number }[];
  usings: { specifier: string; target: string; from: number; to: number }[];
  namespaces: string[];
  ok: boolean;
};
export function scanCsharp(text: string): Scan {
  const toks = tokens(maskCsharp(text)),
    out: Scan = { symbols: [], usings: [], namespaces: [], ok: true };
  let depth = 0;
  for (const t of toks) {
    if (t.v === '{' || t.v === '(' || t.v === '[') depth++;
    else if (t.v === '}' || t.v === ')' || t.v === ']') depth--;
    if (depth < 0) break;
  }
  if (depth !== 0) return { ...out, ok: false };
  let i = 0,
    fileNamespace = '';
  const closer = (open: string, close: string, at: number) => {
    let level = 0;
    for (let k = at; k < toks.length; k++) {
      if (toks[k]!.v === open) level++;
      else if (toks[k]!.v === close && --level === 0) return k;
    }
    return toks.length - 1;
  };
  const skipTo = (stop: string) => {
    while (i < toks.length && toks[i]!.v !== stop) {
      const v = toks[i]!.v;
      i =
        v === '('
          ? closer('(', ')', i) + 1
          : v === '{'
            ? closer('{', '}', i) + 1
            : v === '['
              ? closer('[', ']', i) + 1
              : i + 1;
    }
    i++;
  };
  const record = (
    token: Token | undefined,
    kind: string,
    exported: boolean,
    name = token?.v.replace(/^@/, ''),
  ) => {
    if (token && name) out.symbols.push({ name, kind, exported, from: token.from, to: token.to });
  };
  function members(ctx: Context | null, namespace: string): void {
    while (i < toks.length && toks[i]!.v !== '}') {
      while (toks[i]?.v === '[') i = closer('[', ']', i) + 1;
      const head: Token[] = [];
      let terminator = '',
        level = 0;
      while (i < toks.length) {
        const v = toks[i]!.v;
        if (level === 0 && (v === ';' || v === '{' || v === '=>' || v === '=' || v === '}')) {
          terminator = v;
          break;
        }
        if (v === '(' || v === '[') level++;
        else if (v === ')' || v === ']') level--;
        head.push(toks[i++]!);
      }
      if (!head.length) {
        if (terminator === '{') i = closer('{', '}', i) + 1;
        else if (terminator === '}') break;
        else if (terminator === '=' || terminator === '=>') skipTo(';');
        else i++;
        continue;
      }
      const mods = new Set<string>();
      let k = 0;
      while (k < head.length && MODIFIERS.has(head[k]!.v)) mods.add(head[k++]!.v);
      const word = head[k]?.v ?? '',
        exported =
          mods.has('public') ||
          (!!ctx && ['InterfaceDeclaration', 'EnumDeclaration'].includes(ctx.kind) && ctx.exported);
      if (word === 'namespace') {
        const parts = head
          .slice(k + 1)
          .filter(isName)
          .map(t => t.v);
        const name = [namespace, parts.join('.')].filter(Boolean).join('.');
        out.namespaces.push(name);
        if (terminator === '{') {
          i++;
          members(null, name);
          i++;
        } else {
          fileNamespace = name;
          i++;
        }
      } else if (word === 'using') {
        const alias = terminator === '=';
        const rest = alias ? [] : head.slice(k + 1).filter(t => t.v !== 'static');
        if (alias) {
          const from = i + 1;
          skipTo(';');
          rest.push(...toks.slice(from, i - 1));
        } else i += terminator === ';' ? 1 : 0;
        const parts = rest.filter(t => isName(t) || t.v === '.');
        if (parts.length)
          out.usings.push({
            specifier: parts.map(t => t.v).join(''),
            target: alias || head.some(t => t.v === 'static') ? 'type' : 'namespace',
            from: parts[0]!.from,
            to: parts.at(-1)!.to,
          });
        if (terminator !== ';' && !alias) skipTo(';');
      } else if (word in TYPE_KINDS || word === 'delegate') {
        let kind = TYPE_KINDS[word] ?? 'DelegateDeclaration',
          at = k + 1;
        if (word === 'delegate') {
          const open = head.findIndex(t => t.v === '(');
          if (open > 0) at = nameBefore(head, open, k);
        } else if (word === 'record' && ['class', 'struct'].includes(head[at]?.v ?? '')) {
          kind = head[at]!.v === 'struct' ? 'StructDeclaration' : 'ClassDeclaration';
          at++;
        }
        const name = head[at];
        record(name, kind, mods.has('public'));
        if (terminator === '{') {
          i++;
          if (kind === 'EnumDeclaration') enumMembers(exported);
          else
            members({ name: name?.v ?? '', kind, exported: mods.has('public') }, namespace || fileNamespace);
          i++;
        } else skipTo(';');
      } else {
        member(head, k, mods, terminator, ctx, exported);
      }
    }
  }
  function enumMembers(exported: boolean) {
    while (i < toks.length && toks[i]!.v !== '}') {
      while (toks[i]?.v === '[') i = closer('[', ']', i) + 1;
      if (isName(toks[i])) record(toks[i], 'EnumMember', exported);
      while (i < toks.length && toks[i]!.v !== ',' && toks[i]!.v !== '}') {
        const v = toks[i]!.v;
        i = v === '(' ? closer('(', ')', i) + 1 : v === '{' ? closer('{', '}', i) + 1 : i + 1;
      }
      if (toks[i]?.v === ',') i++;
    }
  }
  function member(
    head: Token[],
    k: number,
    mods: Set<string>,
    terminator: string,
    ctx: Context | null,
    exported: boolean,
  ) {
    const open = head.findIndex((t, at) => at >= k && t.v === '(');
    const hasThis = head.findIndex((t, at) => at >= k && t.v === 'this' && head[at + 1]?.v === '[');
    if (hasThis >= 0) record(head[hasThis], 'PropertyDeclaration', exported);
    else if (open >= 0) {
      const at = nameBefore(head, open, k);
      const op = head.findIndex((t, n) => n >= k && t.v === 'operator');
      const name = op >= 0 ? head[op] : head[at];
      if (name && (op >= 0 || isName(name))) {
        const ctor = op < 0 && at === k && name.v === ctx?.name;
        const symbol = op >= 0 ? `operator ${head[op + 1]?.v ?? ''}`.trim() : undefined;
        record(name, ctor ? 'ConstructorDeclaration' : 'MethodDeclaration', exported, symbol);
      }
    } else {
      const events = head.some(t => t.v === 'event');
      const kind = mods.has('const')
        ? 'ConstantDeclaration'
        : events
          ? 'EventDeclaration'
          : 'PropertyDeclaration';
      record(head.filter(isName).at(-1), kind, exported);
      if (terminator === '=') {
        let level = 0;
        for (; i < toks.length; i++) {
          const v = toks[i]!.v;
          if (v === '(' || v === '{' || v === '[') level++;
          else if (v === ')' || v === '}' || v === ']') level--;
          else if (level === 0 && v === ';') break;
          // `int a = 1, b = 2;` declares both names.
          else if (
            level === 0 &&
            v === ',' &&
            isName(toks[i + 1]) &&
            ['=', ',', ';'].includes(toks[i + 2]?.v ?? '')
          )
            record(toks[i + 1], kind, exported);
        }
        i++;
        return;
      }
    }
    if (terminator === '{') i = closer('{', '}', i) + 1;
    else if (terminator === '=>' || (terminator === '=' && open >= 0)) skipTo(';');
    else if (terminator === ';') i++;
  }
  members(null, '');
  return out;
}
