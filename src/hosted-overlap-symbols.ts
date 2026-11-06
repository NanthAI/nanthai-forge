// SPDX-License-Identifier: Apache-2.0
// Client-side symbol facts for cross-file advisory overlap notes (Issue 3629cf24).
// Parsing only: repository code never runs. The server matches the facts (hosted-overlap-symbol-notes).
import { lstatSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { SyntaxNode, Tree } from '@lezer/common';
import { digest } from './hash.js';
import type { SymbolLinks } from './hosted-overlap-evidence.js';

const declarations = new Set([
  'FunctionDeclaration',
  'ClassDeclaration',
  'VariableDeclaration',
  'InterfaceDeclaration',
  'TypeAliasDeclaration',
  'EnumDeclaration',
]);
/** Per file at most this many changed exports and referenced symbols; the rest is dropped. */
export const MAX_SYMBOL_LINKS = 64;
/** Client time for symbol facts per save. Past it the remaining files say `unavailable`. */
export const SYMBOL_LINK_BUDGET_MS = 400;

/** Each binding owns its initializer, even when one declaration contains several names. */
export function symbolBindings(node: SyntaxNode) {
  const bindings: { name: SyntaxNode; from: number; to: number }[] = [];
  if (node.name === 'VariableDeclaration') {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.name !== 'VariableDefinition') continue;
      let end = child.nextSibling;
      while (end && end.name !== ',' && end.name !== ';') end = end.nextSibling;
      bindings.push({ name: child, from: child.from, to: end?.from ?? node.to });
    }
  } else {
    const name =
      node.getChild('VariableDefinition') ??
      node.getChild('TypeDefinition') ??
      node.getChild('PropertyDefinition');
    if (name) bindings.push({ name, from: node.from, to: node.to });
  }
  return bindings;
}

/** Exported top-level names with a digest each, and the file's imports (local name -> [spec, name]).
 * The narrowest exported symbol counts: one binding of a multi-name const, and for a class only its
 * header (name, type parameters, extends, implements). A method change alone is never a class change. */
export function topLevelFacts(tree: Tree, text: string) {
  const local = new Map<string, string>(),
    exports: Record<string, string> = Object.create(null),
    imports: Record<string, [string, string]> = Object.create(null),
    named: [string, string][] = [];
  const record = (node: SyntaxNode, exported: boolean) => {
    for (const binding of symbolBindings(node)) {
      const name = text.slice(binding.name.from, binding.name.to);
      const body = node.getChild('ClassBody');
      const shape = body
        ? text.slice(node.from, body.from).replace(/\s+/g, ' ')
        : text.slice(binding.from, binding.to);
      // Overloads repeat a name: one digest covers them all.
      const value = digest((local.get(name) ?? '') + shape);
      local.set(name, value);
      if (exported) exports[name] = value;
    }
  };
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
    const raw = text.slice(node.from, node.to);
    if (node.name === 'ImportDeclaration') {
      const match = /^import\s+(?:type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/.exec(raw);
      if (match) addImports(imports, match[1]!, match[2]!);
    } else if (node.name === 'ExportDeclaration') {
      if (node.getChild('default')) continue;
      let inner: SyntaxNode | null = null;
      for (let child = node.firstChild; child; child = child.nextSibling)
        if (declarations.has(child.name)) inner = child;
      if (inner) record(inner, true);
      else if (!node.getChild('from')) {
        const group = /\{([^}]*)\}/.exec(raw);
        for (const part of group?.[1]?.split(',') ?? []) {
          const [name, alias] = part
            .trim()
            .replace(/^type\s+/, '')
            .split(/\s+as\s+/);
          if (name) named.push([name, alias ?? name]);
        }
      }
    } else if (declarations.has(node.name)) record(node, false);
  }
  for (const [name, alias] of named) {
    const value = local.get(name);
    if (value) exports[alias] = value;
  }
  return { exports, imports };
}
function addImports(map: Record<string, [string, string]>, clause: string, spec: string) {
  clause = clause.trim();
  const star = /\*\s+as\s+([\w$]+)/.exec(clause);
  if (star) map[star[1]!] = [spec, '*'];
  const fallback = /^([\w$]+)\s*(?:,|$)/.exec(clause);
  if (fallback) map[fallback[1]!] = [spec, 'default'];
  const group = /\{([\s\S]*)\}/.exec(clause);
  for (const part of group?.[1]?.split(',') ?? []) {
    const [name, alias] = part
      .trim()
      .replace(/^type\s+/, '')
      .split(/\s+as\s+/);
    if (name) map[(alias ?? name).trim()] = [spec, name.trim()];
  }
}

/** Compiled-output prefixes (tsconfig outDir -> rootDir), so `../dist/x.js` names `src/x.ts`. */
export function outputRoots(root: string): [string, string][] {
  try {
    const path = join(root, 'tsconfig.json');
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 64 * 1024) return [];
    const options = JSON.parse(
      readFileSync(path, 'utf8')
        .replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, '$1')
        .replace(/,(\s*[}\]])/g, '$1'),
    )?.compilerOptions;
    const clean = (value: unknown) =>
      typeof value === 'string' ? posix.normalize(value).replace(/^\.\/|\/$/g, '') : '';
    const out = clean(options?.outDir),
      source = clean(options?.rootDir);
    return out && source && !out.startsWith('..') && !source.startsWith('..') ? [[out, source]] : [];
  } catch {
    return [];
  }
}
function resolve(from: string, spec: string, exists: (path: string) => boolean, roots: [string, string][]) {
  if (!spec.startsWith('.')) return null;
  const joined = posix.normalize(posix.join(posix.dirname(from), spec));
  if (joined.startsWith('..')) return null;
  const bases = [joined];
  for (const [out, source] of roots)
    if (joined.startsWith(`${out}/`)) bases.push(`${source}/${joined.slice(out.length + 1)}`);
  for (const base of bases) {
    const stem = base.replace(/\.(?:[cm]?js|jsx)$/, '');
    for (const candidate of [
      base,
      `${stem}.ts`,
      `${stem}.tsx`,
      `${stem}.mts`,
      `${stem}.cts`,
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.js`,
      `${base}/index.ts`,
      `${base}/index.js`,
    ])
      if (exists(candidate)) return candidate;
  }
  return null;
}

type Sketch = {
  exports?: Record<string, string> | undefined;
  imports?: Record<string, [string, string]> | undefined;
};
type Edit = { start: number; end: number; lines: string[] };
export type SymbolLinkContext = {
  path: string;
  text: string;
  exists: (path: string) => boolean;
  roots: [string, string][];
  budget: SymbolBudget;
};
/** Changed exports of this file, and the imported symbols its inserted or changed lines use, keyed
 * `path#name`. Removed lines are not read. Missing facts are `unavailable`, never "no link". */
export function symbolLinks(
  before: Sketch,
  after: Sketch,
  edits: Edit[],
  context: SymbolLinkContext,
): SymbolLinks {
  const old = before.exports,
    now = after.exports,
    imports = after.imports;
  if (!old || !now || !imports) return { unavailable: true };
  const result = context.budget.run(() => {
    const exports = [...new Set([...Object.keys(old), ...Object.keys(now)])]
      .filter(name => old[name] !== now[name] && name.length <= 200)
      .sort()
      .slice(0, MAX_SYMBOL_LINKS);
    const lines = context.text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const refs = new Set<string>();
    let shift = 0;
    for (const edit of edits) {
      const start = edit.start + shift;
      shift += edit.lines.length - (edit.end - edit.start);
      for (const line of lines.slice(start, start + edit.lines.length)) {
        const code = line.replace(/\/\/.*$/, '').replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, "''");
        for (const match of code.matchAll(/([A-Za-z_$][\w$]*)(?:\s*\.\s*([A-Za-z_$][\w$]*))?/g)) {
          const imported = imports[match[1]!];
          if (!imported) continue;
          const name = imported[1] === '*' ? match[2] : imported[1];
          const target = name && resolve(context.path, imported[0], context.exists, context.roots);
          if (target && target !== context.path && target.length + name.length < 300)
            refs.add(`${target}#${name}`);
        }
      }
    }
    return { exports, refs: [...refs].sort().slice(0, MAX_SYMBOL_LINKS) };
  });
  return result ?? { unavailable: true };
}

/** Bounds the time symbol facts may add to one save; never blocks it. */
export class SymbolBudget {
  private spent = 0;
  constructor(
    private readonly limit = SYMBOL_LINK_BUDGET_MS,
    private readonly now: () => number = () => performance.now(),
  ) {}
  get exhausted() {
    return this.spent >= this.limit;
  }
  run<T>(work: () => T): T | undefined {
    if (this.exhausted) return undefined;
    const start = this.now();
    try {
      return work();
    } finally {
      this.spent += this.now() - start;
    }
  }
}
