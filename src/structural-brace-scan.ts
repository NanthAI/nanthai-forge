// SPDX-License-Identifier: Apache-2.0
/** Declaration scanner for Swift, Kotlin and Dart (no Lezer grammar exists for them). Comments and
 * string literals (with their interpolations) are masked, keeping offsets; only top-level and
 * type-body headers are read, never function bodies, and no project code runs. */
import { maskBraces, type BraceLanguage } from './structural-brace-mask.js';
export type { BraceLanguage } from './structural-brace-mask.js';

type Spec = {
  types: Record<string, string>;
  /** Keywords that introduce a function name (Dart has none: `Type name(…) {`). */
  functions: readonly string[];
  variables: readonly string[];
  /** Words that may precede a declaration keyword. */
  modifiers: ReadonlySet<string>;
  /** Modifiers that keep a declaration out of other files' reach. */
  hidden: ReadonlySet<string>;
};
const words = (text: string) => new Set(text.split(' '));
const SPECS: Record<BraceLanguage, Spec> = {
  swift: {
    types: {
      class: 'ClassDeclaration',
      struct: 'StructDeclaration',
      enum: 'EnumDeclaration',
      protocol: 'InterfaceDeclaration',
      actor: 'ClassDeclaration',
      extension: 'ExtensionDeclaration',
      typealias: 'TypeAliasDeclaration',
    },
    functions: ['func'],
    variables: ['let', 'var'],
    modifiers: words(
      'public private fileprivate internal open final static class override mutating nonmutating dynamic lazy weak unowned required convenience indirect nonisolated isolated async throws rethrows consuming borrowing package distributed prefix postfix infix',
    ),
    hidden: words('private fileprivate'),
  },
  kotlin: {
    types: {
      class: 'ClassDeclaration',
      interface: 'InterfaceDeclaration',
      object: 'ObjectDeclaration',
      typealias: 'TypeAliasDeclaration',
    },
    functions: ['fun'],
    variables: ['val', 'var'],
    modifiers: words(
      'public private protected internal open final abstract sealed data enum annotation inner value inline override suspend tailrec operator infix external lateinit const companion expect actual vararg noinline crossinline reified',
    ),
    hidden: words('private'),
  },
  dart: {
    types: {
      class: 'ClassDeclaration',
      mixin: 'MixinDeclaration',
      enum: 'EnumDeclaration',
      extension: 'ExtensionDeclaration',
      typedef: 'TypeAliasDeclaration',
    },
    functions: [],
    variables: ['var', 'final', 'const', 'late'],
    modifiers: words(
      'abstract base interface final sealed static external factory const late covariant required augment',
    ),
    hidden: new Set(),
  },
};
const CONTROL = words(
  'if else for while do switch case catch try return throw guard when in is as await yield assert new super this get set where sizeof typeof',
);

type Token = { v: string; from: number; to: number };
export type BraceScan = {
  symbols: { name: string; kind: string; exported: boolean; from: number; to: number }[];
  imports: { specifier: string; from: number; to: number }[];
  /** Kotlin `package a.b`, empty otherwise. */
  packageName: string;
  ok: boolean;
};

const isName = (token?: Token) => !!token && /^[\p{L}_$`]/u.test(token.v);
const clean = (name: string) => name.replace(/`/g, '');

export function scanBraces(text: string, language: BraceLanguage): BraceScan {
  const spec = SPECS[language];
  const masked = maskBraces(text, language);
  const toks: Token[] = [...masked.matchAll(/`[^`\n]+`|[\p{L}_$][\p{L}\p{N}_$]*|=>|->|\n|\S/gu)].map(m => ({
    v: m[0],
    from: m.index!,
    to: m.index! + m[0].length,
  }));
  const out: BraceScan = { symbols: [], imports: [], packageName: '', ok: true };
  let depth = 0;
  for (const t of toks) {
    if (t.v === '{' || t.v === '(' || t.v === '[') depth++;
    else if (t.v === '}' || t.v === ')' || t.v === ']') depth--;
    if (depth < 0) break;
  }
  if (depth !== 0) return { ...out, ok: false };
  const v = (at: number) => toks[at]?.v ?? '';
  const closer = (at: number) => {
    const open = v(at),
      close = open === '{' ? '}' : open === '(' ? ')' : open === '[' ? ']' : '>';
    let level = 0;
    for (let k = at; k < toks.length; k++) {
      if (toks[k]!.v === open) level++;
      else if (toks[k]!.v === close && --level === 0) return k;
      // An unclosed `<` is a comparison: it ends at the line.
      else if (open === '<' && (toks[k]!.v === '\n' || toks[k]!.v === '{' || toks[k]!.v === ';'))
        return k - 1;
    }
    return toks.length - 1;
  };
  const keyword = (word: string) =>
    word in spec.types ||
    spec.modifiers.has(word) ||
    spec.functions.includes(word) ||
    spec.variables.includes(word);
  /** A header continues on the next line when the line ends mid-header or the next starts with `{`,
   * `:`, `where` or a Dart clause. */
  const continues = (at: number) =>
    [',', ':', '<', '(', '.', '&', '|'].includes(v(at - 1)) ||
    ['{', ':', 'where', 'extends', 'implements', 'with', 'on', '.', ','].includes(v(at + 1));
  /** Past one declaration: its parameter list, then a `{…}` body or an expression up to the line end. */
  const skipStatement = (start: number, end: number) => {
    let k = start;
    while (k < end) {
      const word = v(k);
      if (word === '(' || word === '[') {
        k = closer(k) + 1;
        continue;
      }
      if (word === '{') return closer(k) + 1;
      if (word === ';' || (word === '\n' && !continues(k))) return k;
      k++;
    }
    return k;
  };
  const record = (name: Token | undefined, kind: string, open: boolean) => {
    if (!name || !isName(name) || CONTROL.has(name.v) || keyword(name.v)) return;
    const value = clean(name.v);
    out.symbols.push({
      name: value,
      kind,
      exported: open && (language !== 'dart' || !value.startsWith('_')),
      from: name.from,
      to: name.to,
    });
  };
  const imports = (keywordAt: number, end: number) => {
    const t = toks[keywordAt]!;
    let k = keywordAt + 1;
    while (k < end && v(k) !== ';' && (language === 'dart' || v(k) !== '\n')) k++;
    if (language === 'dart') {
      if (t.v === 'part' && v(keywordAt + 1) === 'of') return k;
      const raw = text.slice(t.to, toks[k]?.from ?? text.length);
      const quoted = /^\s*(["'])([^"'\n]+)\1/.exec(raw);
      if (quoted) {
        const from = t.to + raw.indexOf(quoted[1]!);
        out.imports.push({ specifier: quoted[2]!, from, to: from + quoted[2]!.length + 2 });
      }
      return k;
    }
    const parts = toks.slice(keywordAt + 1, k).filter(p => isName(p) || p.v === '.');
    if (t.v === 'package') {
      out.packageName = parts.map(p => clean(p.v)).join('');
      return k;
    }
    let first = 0;
    // Swift `import struct M.T`; Kotlin `import a.b.C as D`.
    if (
      language === 'swift' &&
      /^(?:struct|class|enum|protocol|typealias|func|let|var)$/.test(parts[0]?.v ?? '')
    )
      first = 1;
    const as = parts.findIndex(p => p.v === 'as');
    const path = parts.slice(first, as < 0 ? undefined : as);
    while (path.at(-1)?.v === '.') path.pop();
    if (path.length)
      out.imports.push({
        specifier: path.map(p => clean(p.v)).join(''),
        from: path[0]!.from,
        to: path.at(-1)!.to,
      });
    return k;
  };
  const IMPORTS =
    language === 'dart'
      ? ['import', 'export', 'part']
      : language === 'kotlin'
        ? ['import', 'package']
        : ['import'];
  /** Statement-level scan of tokens [start, end): records declarations; bodies of types recurse. */
  const scope = (start: number, end: number, exportedScope: boolean, topLevel: boolean) => {
    let i = start,
      lineStart = true;
    const mods = new Set<string>();
    while (i < end) {
      const t = toks[i]!,
        next = v(i + 1);
      if (t.v === '\n' || t.v === ';') {
        lineStart = true;
        mods.clear();
        i++;
        continue;
      }
      if (t.v === '@' || t.v === '#') {
        // Annotations and attributes (`@Test`, `@objc(name)`, `@file:JvmName("x")`), Swift `#if`.
        i += isName(toks[i + 1]) ? 2 : 1;
        while (v(i) === '.' && isName(toks[i + 1])) i += 2;
        if (v(i) === '(') i = closer(i) + 1;
        continue;
      }
      if (t.v === '{' || t.v === '(' || t.v === '[') {
        i = closer(i) + 1;
        lineStart = false;
        continue;
      }
      if (topLevel && lineStart && IMPORTS.includes(t.v)) {
        i = imports(i, end);
        continue;
      }
      if (
        spec.modifiers.has(t.v) &&
        (!(t.v in spec.types || spec.variables.includes(t.v)) || keyword(next))
      ) {
        mods.add(t.v);
        i++;
        continue;
      }
      // Kotlin `fun interface X`.
      if (language === 'kotlin' && t.v === 'fun' && next === 'interface') {
        i++;
        continue;
      }
      const exported = exportedScope && ![...mods].some(m => spec.hidden.has(m));
      mods.clear();
      lineStart = false;
      if (t.v in spec.types) {
        let at = i + 1;
        if (language === 'dart' && t.v === 'extension' && v(at) === 'type') at++;
        const named = isName(toks[at]) && v(at) !== 'on' && !keyword(v(at));
        if (named) record(toks[at], spec.types[t.v]!, exported);
        // The body: the first `{` before the header ends, past parentheses and generics.
        let k = named ? at + 1 : at,
          body = -1;
        while (k < end) {
          const word = v(k);
          if (word === '{') {
            body = k;
            break;
          }
          if (word === ';' || (word === '=' && (t.v === 'typealias' || t.v === 'typedef'))) break;
          if (word === '\n' && !continues(k)) break;
          if (word === '(' || word === '[') k = closer(k);
          k++;
        }
        if (body >= 0) {
          const close = closer(body);
          const open = exported && (language !== 'dart' || !clean(v(at)).startsWith('_'));
          scope(body + 1, close, open, false);
          i = close + 1;
        } else i = skipStatement(k, end);
        continue;
      }
      if (spec.functions.includes(t.v)) {
        let k = i + 1;
        if (v(k) === '<') k = closer(k) + 1;
        // Extension functions (`fun <T> List<T>.second()`): the name is the last before `(`.
        for (;;) {
          let n = k + 1;
          if (v(n) === '<') n = closer(n) + 1;
          if (v(n) === '?') n++;
          if (v(n) === '.' && isName(toks[n + 1])) k = n + 1;
          else break;
        }
        record(toks[k], topLevel ? 'FunctionDeclaration' : 'MethodDeclaration', exported);
        i = skipStatement(k + 1, end);
        continue;
      }
      if (spec.variables.includes(t.v)) {
        let at = i + 1;
        while (spec.variables.includes(v(at)) || spec.modifiers.has(v(at))) at++;
        // Dart `final int x = …;`: the name is the last before `=`, `;` or the line's end.
        let name = at,
          call = false;
        if (language === 'dart')
          for (let k = at; k < end && !['=', ';', '\n', ','].includes(v(k)); k++) {
            if (v(k) === '<') k = closer(k);
            else if (v(k) === '(') {
              // `const Point(this.x);`, `final T f() …`: a constructor or function, not a variable.
              call = isName(toks[k - 1]);
              name = k - 1;
              break;
            } else if (isName(toks[k])) name = k;
          }
        const kind = call ? (topLevel ? 'Function' : 'Method') : topLevel ? 'Variable' : 'Property';
        record(toks[name], `${kind}Declaration`, exported);
        i = skipStatement(name + 1, end);
        continue;
      }
      if (language === 'dart' && isName(t) && !CONTROL.has(t.v)) {
        // `Type name(…) {`, `Type get name =>`, `int count = 0;`, `void main() async {`.
        let k = i,
          name = -1,
          kind = 'Method';
        let last = -1;
        while (k < end && !['\n', ';', '{', '=>', '='].includes(v(k))) {
          if (v(k) === '<') {
            k = closer(k) + 1;
            continue;
          }
          if (v(k) === '(') {
            if (isName(toks[k - 1])) name = k - 1;
            break;
          }
          if (v(k) === 'get' && isName(toks[k + 1])) {
            name = k + 1;
            break;
          }
          if (isName(toks[k])) last = k;
          k++;
        }
        if (name < 0 && last > i && (v(k) === '=' || v(k) === ';')) {
          name = last;
          kind = 'Variable';
        }
        if (name >= 0) {
          const declared =
            kind === 'Method'
              ? topLevel
                ? 'FunctionDeclaration'
                : 'MethodDeclaration'
              : topLevel
                ? 'VariableDeclaration'
                : 'PropertyDeclaration';
          record(toks[name], declared, exported);
          i = skipStatement(name + 1, end);
        } else i = skipStatement(i + 1, end);
        continue;
      }
      i++;
    }
  };
  scope(0, toks.length, true, true);
  return out;
}
