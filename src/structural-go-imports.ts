// SPDX-License-Identifier: Apache-2.0
import { posix } from 'node:path';
import type { SyntaxNode } from '@lezer/common';
import type { StructuralFile } from './structural-analyze.js';
import { positionIn } from './structural-positions.js';
import type { GraphPack, Snapshot, SymbolNode } from './types.js';

/** Edges per import: a Go import names a package (a directory), so each import points at every
 * non-test file of that package up to this bound. */
const MAX_PACKAGE_EDGES = 64;
const PACKAGE_KINDS = [
  'FunctionDeclaration',
  'StructDeclaration',
  'InterfaceDeclaration',
  'TypeAliasDeclaration',
  'ConstantDeclaration',
  'VariableDeclaration',
];
type Package = {
  dir: string;
  name: string;
  files: StructuralFile[];
  symbols: Map<string, SymbolNode | null>;
};

/** Go imports, same-package bindings and `pkg.Name` references from captured files only: the
 * module path comes from a captured go.mod, and no vendor directory, workspace, replace
 * directive or build tag is read. */
export function goImports(files: StructuralFile[], snapshot: Snapshot) {
  const imports: GraphPack['imports'] = [],
    issues: GraphPack['issues'] = [],
    references: GraphPack['references'] = [],
    bindings = new Map<string, Map<string, string>>();
  const goFiles = files.filter(file => file.language === 'go');
  if (!goFiles.length) return { imports, issues, references, bindings };
  const digests = new Map(snapshot.source.files.map(file => [file.path, file.digest]));
  const modules: { dir: string; path: string }[] = [];
  for (const [path, text] of snapshot.content) {
    const module = /(^|\/)go\.mod$/.test(path) ? /^\s*module\s+"?([^\s"]+)"?/m.exec(text)?.[1] : undefined;
    if (module) modules.push({ dir: posix.dirname(path) === '.' ? '' : posix.dirname(path), path: module });
  }
  modules.sort((a, b) => b.path.length - a.path.length);
  const packageName = (file: StructuralFile) => {
    const name = file.tree.topNode.getChild('PackageClause')?.getChild('DefName');
    return name ? file.text.slice(name.from, name.to) : '';
  };
  const byDirectory = new Map<string, Map<string, Package>>();
  const own = new Map<string, Package>();
  for (const file of goFiles) {
    const dir = posix.dirname(file.file) === '.' ? '' : posix.dirname(file.file);
    const name = packageName(file);
    const named = byDirectory.get(dir) ?? new Map<string, Package>();
    const pkg: Package = named.get(name) ?? { dir, name, files: [], symbols: new Map() };
    pkg.files.push(file);
    named.set(name, pkg);
    byDirectory.set(dir, named);
    own.set(file.file, pkg);
  }
  const packages = new Set(own.values());
  for (const pkg of packages)
    for (const file of pkg.files)
      for (const { symbol, scope } of file.definitions) {
        if (scope !== file.rootScope || !PACKAGE_KINDS.includes(symbol.kind)) continue;
        // A repeated package-level name (build-tagged files) is ambiguous: no target is guessed.
        pkg.symbols.set(symbol.name, pkg.symbols.has(symbol.name) ? null : symbol);
      }
  const isTest = (file: StructuralFile) => file.file.endsWith('_test.go');
  const importedPackage = (path: string): Package | null | undefined => {
    const module = modules.find(item => path === item.path || path.startsWith(`${item.path}/`));
    if (!module) return undefined;
    const dir = posix.join(module.dir, path.slice(module.path.length + 1));
    const candidates = [...(byDirectory.get(dir === '.' ? '' : dir)?.values() ?? [])].filter(
      pkg => !pkg.name.endsWith('_test') && pkg.files.some(file => !isTest(file)),
    );
    return candidates.length === 1 ? candidates[0]! : null;
  };
  for (const pkg of packages) {
    const shared = new Map<string, string>();
    for (const [name, symbol] of pkg.symbols) if (symbol) shared.set(name, symbol.id);
    for (const file of pkg.files) if (!bindings.has(file.file)) bindings.set(file.file, shared);
  }
  for (const file of goFiles) {
    const position = positionIn(file.text),
      text = (node: SyntaxNode) => file.text.slice(node.from, node.to);
    const locator = (node: SyntaxNode) => ({
      file: file.file,
      digest: digests.get(file.file)!,
      start: position(node.from),
      end: position(node.to),
    });
    const aliases = new Map<string, Package>();
    const selectors: SyntaxNode[] = [];
    file.tree.iterate({
      enter(ref) {
        if (ref.name === 'ImportSpec') {
          const literal = ref.node.getChild('String');
          if (!literal) return false;
          const specifier = text(literal).slice(1, -1);
          const local = ref.node.getChild('DefName');
          const pkg = importedPackage(specifier);
          const targets = pkg ? pkg.files.filter(item => !isTest(item) && item.file !== file.file) : [];
          if (targets.length > MAX_PACKAGE_EDGES)
            issues.push({ file: file.file, code: 'GO_PACKAGE_EDGES_TRUNCATED', offset: ref.from });
          for (const target of targets.slice(0, MAX_PACKAGE_EDGES))
            imports.push({
              from: file.file,
              specifier,
              target: target.file,
              resolution: 'resolved',
              locator: locator(literal),
            });
          if (!targets.length)
            imports.push({
              from: file.file,
              specifier,
              target: null,
              resolution: pkg === undefined ? 'external' : 'unresolved',
              locator: locator(literal),
            });
          const alias = local ? text(local) : pkg?.name;
          if (pkg && alias && alias !== '_' && alias !== '.') aliases.set(alias, pkg);
          return false;
        }
        if (ref.name === 'SelectorExpr' || ref.name === 'QualifiedType') selectors.push(ref.node);
        return undefined;
      },
    });
    if (!aliases.size) continue;
    // A name declared anywhere in this file might shadow the package name: no reference is guessed.
    const declared = new Set(file.definitions.map(item => item.symbol.name));
    for (const selector of selectors) {
      const head = selector.firstChild,
        tail = selector.lastChild;
      if (!head || !tail || head.name !== 'VariableName' || !['FieldName', 'TypeName'].includes(tail.name))
        continue;
      const alias = text(head);
      const pkg = aliases.get(alias);
      const name = text(tail);
      const symbol = pkg && !declared.has(alias) ? pkg.symbols.get(name) : undefined;
      if (symbol?.exported) references.push({ target: symbol.id, locator: locator(tail) });
    }
  }
  return { imports, issues, references, bindings };
}
