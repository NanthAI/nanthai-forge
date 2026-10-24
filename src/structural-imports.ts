// SPDX-License-Identifier: Apache-2.0
import { posix } from 'node:path';
import type { SyntaxNode } from '@lezer/common';
import type { StructuralFile } from './structural-analyze.js';
import { ancestor, children } from './structural-language.js';
import type { GraphPack, Snapshot, SymbolNode } from './types.js';

const unique = <T>(values: T[]): T | undefined => (values.length === 1 ? values[0] : undefined);
const content = (file: StructuralFile, node: SyntaxNode) => file.text.slice(node.from, node.to);
const nodesNamed = (node: SyntaxNode, names: string[]) => {
  const result: SyntaxNode[] = [],
    stack = [node];
  while (stack.length) {
    const current = stack.pop()!;
    if (names.includes(current.name)) result.push(current);
    stack.push(...children(current).reverse());
  }
  return result;
};
export function structuralImports(files: StructuralFile[], snapshot: Snapshot) {
  const imports: GraphPack['imports'] = [],
    issues: GraphPack['issues'] = [],
    bindings = new Map<string, Map<string, string>>();
  const reserved = new Map<string, Set<string>>();
  const ambiguous = new Set<string>(),
    digests = new Map(snapshot.source.files.map(file => [file.path, file.digest]));
  const fileMap = new Map(files.map(file => [file.file, file]));
  const lines = new Map<string, number[]>();
  const locator = (file: StructuralFile, node: SyntaxNode) => {
    let starts = lines.get(file.file);
    if (!starts) {
      starts = [0];
      for (let i = 0; i < file.text.length; i++) if (file.text[i] === '\n') starts.push(i + 1);
      lines.set(file.file, starts);
    }
    const position = (offset: number) => {
      let low = 0,
        high = starts.length;
      while (low + 1 < high) {
        const mid = (low + high) >> 1;
        if (starts[mid]! <= offset) low = mid;
        else high = mid;
      }
      return { offset, line: low + 1, column: offset - starts[low]! + 1 };
    };
    return {
      file: file.file,
      digest: digests.get(file.file)!,
      start: position(node.from),
      end: position(node.to),
    };
  };
  const edge = (
    file: StructuralFile,
    node: SyntaxNode,
    specifier: string,
    target: string | undefined,
    external = false,
  ) =>
    imports.push({
      from: file.file,
      specifier,
      target: target ?? null,
      resolution: target ? 'resolved' : external ? 'external' : 'unresolved',
      locator: locator(file, node),
    });
  const bind = (file: StructuralFile, name: string, symbol?: SymbolNode) => {
    if (!symbol) return;
    const key = `${file.file}\0${name}`;
    if (ambiguous.has(key)) return;
    const map = bindings.get(file.file) ?? new Map<string, string>();
    if (map.has(name) && map.get(name) !== symbol.id) {
      map.delete(name);
      ambiguous.add(key);
    } else map.set(name, symbol.id);
    bindings.set(file.file, map);
  };
  const topSymbol = (path: string | undefined, name: string) => {
    const file = path ? fileMap.get(path) : undefined;
    return file
      ? unique(
          file.definitions
            .filter(d => d.scope === file.rootScope && d.symbol.name === name)
            .map(d => d.symbol),
        )
      : undefined;
  };
  const localPython = (from: string, specifier: string) => {
    const dots = specifier.match(/^\.+/)?.[0].length ?? 0;
    if (!dots) return undefined;
    const base = posix.normalize(
      posix.join(
        posix.dirname(from),
        ...Array.from({ length: dots - 1 }, () => '..'),
        specifier.slice(dots).replaceAll('.', '/'),
      ),
    );
    if (base === '..' || base.startsWith('../')) return undefined;
    return unique(
      (specifier.slice(dots)
        ? [`${base}.py`, posix.join(base, '__init__.py')]
        : [posix.join(base, '__init__.py')]
      ).filter(path => snapshot.content.has(path)),
    );
  };
  const javaTypes = new Map<string, { file: string; symbol: SymbolNode }[]>();
  for (const file of files.filter(file => file.language === 'java')) {
    const pkg = file.tree.topNode.getChild('PackageDeclaration');
    const prefix = pkg
      ? nodesNamed(pkg, ['Identifier'])
          .map(node => content(file, node))
          .join('.')
      : '';
    for (const d of file.definitions.filter(
      d =>
        d.scope === file.rootScope &&
        ['ClassDeclaration', 'InterfaceDeclaration', 'EnumDeclaration', 'RecordDeclaration'].includes(
          d.symbol.kind,
        ),
    )) {
      const name = [prefix, d.symbol.name].filter(Boolean).join('.');
      javaTypes.set(name, [...(javaTypes.get(name) ?? []), { file: file.file, symbol: d.symbol }]);
    }
  }
  const modules = new Map<string, Map<string, string>>(),
    parents = new Map<string, string[]>(),
    ambiguousModules = new Set<string>();
  for (const file of files.filter(file => file.language === 'rust'))
    for (const node of nodesNamed(file.tree.topNode, ['ModItem'])) {
      if (node.getChild('DeclarationList')) continue;
      const name = node.getChild('BoundIdentifier');
      if (!name) continue;
      const declared = content(file, name),
        stem = posix.basename(file.file, '.rs');
      const base = posix.join(
        posix.dirname(file.file),
        ['lib', 'main', 'mod'].includes(stem) ? '' : stem,
        declared,
      );
      // Path attributes and inline parent modules require another module-resolution context.
      const attributed = content(file, node).includes('#[') || node.prevSibling?.name.includes('Attribute');
      const target =
        !attributed && !ancestor(node, ['ModItem'])
          ? unique([`${base}.rs`, `${base}/mod.rs`].filter(path => snapshot.content.has(path)))
          : undefined;
      edge(file, node, `mod ${declared}`, target);
      if (target) {
        const map = modules.get(file.file) ?? new Map<string, string>();
        const key = `${file.file}\0${declared}`;
        if (map.has(declared) || ambiguousModules.has(key)) {
          map.delete(declared);
          ambiguousModules.add(key);
        } else map.set(declared, target);
        modules.set(file.file, map);
        parents.set(target, [...(parents.get(target) ?? []), file.file]);
      }
    }
  const rustRoot = (path: string): string | undefined => {
    const roots: string[] = [],
      seen = new Set<string>(),
      stack = [path];
    while (stack.length) {
      const item = stack.pop()!;
      if (seen.has(item)) continue;
      seen.add(item);
      const parent = parents.get(item) ?? [];
      if (!parent.length && /\/(lib|main)\.rs$/.test(`/${item}`)) roots.push(item);
      else stack.push(...parent);
    }
    return unique(roots);
  };
  const rustTarget = (file: string, parts: string[]): string | undefined => {
    const route = [...parts];
    let current: string | undefined;
    if (route[0] === 'crate') {
      current = rustRoot(file);
      route.shift();
    } else if (route[0] === 'self') {
      current = file;
      route.shift();
    } else if (route[0] === 'super') {
      current = file;
      while (route[0] === 'super') {
        current = unique(parents.get(current ?? '') ?? []);
        route.shift();
      }
    } else return undefined;
    for (const part of route) current = modules.get(current ?? '')?.get(part);
    return current;
  };
  for (const file of files) {
    const statements = nodesNamed(
      file.tree.topNode,
      file.language === 'python'
        ? ['ImportStatement']
        : file.language === 'java'
          ? ['ImportDeclaration']
          : ['UseDeclaration'],
    );
    for (const node of statements) {
      if (file.language === 'python') {
        const tokens = children(node).filter(child => child.name !== 'Comment'),
          from = tokens.findIndex(child => child.name === 'from'),
          at = tokens.findIndex(child => child.name === 'import');
        if (!ancestor(node, ['FunctionDefinition', 'ClassDefinition', 'LambdaExpression'])) {
          const names = reserved.get(file.file) ?? new Set<string>();
          for (const part of nodesNamed(node, ['VariableName'])) names.add(content(file, part));
          reserved.set(file.file, names);
        }
        if (from < 0) {
          edge(file, node, content(file, node), undefined, true);
          continue;
        }
        const specifier = tokens
            .slice(from + 1, at)
            .map(child => content(file, child))
            .join(''),
          target = localPython(file.file, specifier);
        edge(file, node, specifier, target, !specifier.startsWith('.'));
        if (ancestor(node, ['FunctionDefinition', 'ClassDefinition', 'LambdaExpression'])) continue;
        const names = tokens.slice(at + 1);
        for (let i = 0; i < names.length; i++) {
          const item = names[i]!;
          if (item.name !== 'VariableName') continue;
          const imported = content(file, item);
          let local = imported;
          if (names[i + 1]?.name === 'as' && names[i + 2]?.name === 'VariableName') {
            local = content(file, names[i + 2]!);
            i += 2;
          }
          bind(file, local, topSymbol(target, imported));
        }
      } else if (file.language === 'java') {
        const names = nodesNamed(node, ['Identifier']).map(item => content(file, item));
        const isStatic = !!node.getChild('static'),
          wildcard = nodesNamed(node, ['*']).length > 0;
        const qualified = names.join('.'),
          typeName = isStatic ? names.slice(0, -1).join('.') : qualified;
        const resolved = !wildcard ? unique(javaTypes.get(typeName) ?? []) : undefined;
        edge(file, node, `${isStatic ? 'static ' : ''}${qualified}${wildcard ? '.*' : ''}`, resolved?.file);
        if (resolved && !isStatic) bind(file, names.at(-1)!, resolved.symbol);
      } else {
        // Braced/glob imports stay observed but unresolved; no package or edition guesses.
        const raw = content(file, node)
          .replace(/^\s*(?:pub\s+)?use\s+/, '')
          .replace(/;\s*$/, '')
          .trim();
        if (raw.includes('{') || raw.includes('*')) {
          edge(file, node, raw, undefined);
          continue;
        }
        const [path, alias] = raw.split(/\s+as\s+/),
          parts = path!.replace(/\s+/g, '').split('::'),
          imported = parts.at(-1)!;
        const target = rustTarget(file.file, parts.slice(0, -1));
        edge(file, node, raw, target, !['crate', 'self', 'super'].includes(parts[0]!));
        if (!ancestor(node, ['FunctionItem', 'ModItem', 'Block']))
          bind(file, alias?.trim() ?? imported, topSymbol(target, imported));
      }
    }
  }
  return { imports, bindings, reserved, issues };
}
