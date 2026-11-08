// SPDX-License-Identifier: Apache-2.0
import { parser as python } from '@lezer/python';
import { parser as java } from '@lezer/java';
import { parser as rust } from '@lezer/rust';
import { parser as go } from '@lezer/go';
import type { SyntaxNode, Tree } from '@lezer/common';
import { identity } from './hash.js';
import { sourceLanguage } from './languages.js';
import { positionIn } from './structural-positions.js';
import { goUnmodelledBinding, goVisibleFrom } from './structural-go.js';
import { csharpAnalysis, CSHARP_PROVIDER } from './structural-csharp.js';
import {
  children,
  declarationFor,
  publicDeclaration,
  referenceName,
  scopeNames,
  type StructuralLanguage,
} from './structural-language.js';
import type { CompilerSession } from './compiler.js';
import type { GraphPack, Locator, Snapshot, SymbolNode } from './types.js';
import { structuralImports } from './structural-imports.js';

type Scope = {
  id: string;
  kind: string;
  parent: Scope | null;
  bindings: Map<string, SymbolNode[]>;
  unknown: boolean;
};
export type StructuralFile = {
  file: string;
  text: string;
  language: StructuralLanguage;
  tree: Tree;
  definitions: { symbol: SymbolNode; scope: string; owner: SyntaxNode }[];
  rootScope: string;
};
const key = (node: SyntaxNode) => `${node.name}:${node.from}:${node.to}`;
const parsers = { python, java, rust, go };
export const STRUCTURAL_PROVIDERS = [
  {
    language: 'python',
    parser: '@lezer/python',
    version: '1.1.19',
    relationships: ['declarations', 'lexical-references', 'captured-relative-imports'],
  },
  {
    language: 'java',
    parser: '@lezer/java',
    version: '1.1.5',
    relationships: ['declarations', 'lexical-references', 'captured-qualified-type-imports'],
  },
  {
    language: 'rust',
    parser: '@lezer/rust',
    version: '1.0.3',
    relationships: ['declarations', 'lexical-references', 'captured-explicit-file-modules'],
  },
  {
    language: 'go',
    parser: '@lezer/go',
    version: '1.0.1',
    relationships: [
      'declarations',
      'lexical-references',
      'same-package-references',
      'captured-module-package-imports',
      'qualified-package-references',
    ],
  },
  CSHARP_PROVIDER,
];
export function structuralAnalysis(
  snapshot: Snapshot,
  session?: CompilerSession,
): Pick<GraphPack, 'nodes' | 'references' | 'imports' | 'issues'> {
  const nodes: SymbolNode[] = [],
    references: GraphPack['references'] = [],
    issues: GraphPack['issues'] = [];
  const files: StructuralFile[] = [];
  const pending: {
    file: StructuralFile;
    node: SyntaxNode;
    scope: Scope;
    locator: (node: SyntaxNode) => Locator;
  }[] = [];
  const digests = new Map(snapshot.source.files.map(file => [file.path, file.digest]));
  if (session && session.structuralRoot !== snapshot.root) {
    session.structuralRoot = snapshot.root;
    session.structuralTrees = new Map();
  }
  const retainedPaths = new Set<string>();
  const visibleFrom = new Map<string, number>();
  const csharp: { file: string; text: string }[] = [];
  for (const [file, text] of snapshot.content) {
    const language = sourceLanguage(file);
    if (language === 'csharp') csharp.push({ file, text });
    if (!language || language === 'typescript' || language === 'javascript' || language === 'csharp')
      continue;
    retainedPaths.add(file);
    const retained = session?.structuralTrees?.get(file);
    const tree = retained?.text === text ? retained.tree : parsers[language].parse(text);
    if (session) {
      if (retained?.text === text) session.reusedFiles = (session.reusedFiles ?? 0) + 1;
      else session.parsedFiles = (session.parsedFiles ?? 0) + 1;
      session.structuralTrees?.set(file, { text, tree });
    }
    let invalid = false;
    tree.iterate({
      enter(node) {
        if (node.type.isError) {
          invalid = true;
          issues.push({ file, code: `${language.toUpperCase()}_SYNTAX`, offset: node.from });
        }
      },
    });
    if (invalid) continue;
    const position = positionIn(text);
    const locator = (node: SyntaxNode): Locator => ({
      file,
      digest: digests.get(file)!,
      start: position(node.from),
      end: position(node.to),
    });
    const root: Scope = {
      id: key(tree.topNode),
      kind: tree.topNode.name,
      parent: null,
      bindings: new Map(),
      unknown: false,
    };
    const parsed: StructuralFile = { file, text, language, tree, definitions: [], rootScope: root.id };
    files.push(parsed);
    const stack = [{ node: tree.topNode, scope: root }];
    while (stack.length) {
      const entry = stack.pop()!,
        node = entry.node;
      let scope = entry.scope;
      if (node.parent && scopeNames[language].includes(node.name))
        scope = { id: key(node), kind: node.name, parent: scope, bindings: new Map(), unknown: false };
      if (language === 'python' && node.name === 'ScopeStatement') {
        scope.unknown = true;
        issues.push({ file, code: 'PYTHON_SCOPE_DIRECTIVE_UNRESOLVED', offset: node.from });
      }
      const definition = declarationFor(node, language, text.slice(node.from, node.to));
      // An unmodelled binding must not accidentally resolve to an outer symbol.
      const unsupportedBinding =
        language === 'python'
          ? node.name.includes('Comprehension') ||
            (['WithStatement', 'TryStatement'].includes(node.name) && !!node.getChild('as')) ||
            node.name === 'NamedExpression' ||
            (node.name === 'AssignStatement' &&
              children(node).filter(child => child.name === 'AssignOp').length > 1) ||
            (node.name === 'ImportStatement' && !!node.getChild('*'))
          : language === 'java'
            ? node.name === 'Definition' && !definition
            : language === 'go'
              ? goUnmodelledBinding(node, text.slice(node.from, node.to))
              : node.name === 'BoundIdentifier' && !definition && !hasImportAncestor(node);
      if (
        unsupportedBinding ||
        (language === 'rust' &&
          node.name === 'LetDeclaration' &&
          ['IfExpression', 'WhileExpression'].includes(node.parent?.name ?? ''))
      ) {
        scope.unknown = true;
        issues.push({ file, code: `${language.toUpperCase()}_BINDING_UNRESOLVED`, offset: node.from });
      }
      if (language === 'python' && node.name === 'ImportStatement' && scope !== root) {
        scope.unknown = true;
        issues.push({ file, code: 'PYTHON_NESTED_IMPORT_UNRESOLVED', offset: node.from });
      }
      if (definition) {
        const owner = definition.outside ? (scope.parent ?? scope) : scope;
        const symbol: SymbolNode = {
          id: `symbol:${identity([snapshot.source.id, file, node.from, language, definition.kind])}`,
          name: text.slice(node.from, node.to),
          kind: definition.kind,
          exported: publicDeclaration(definition.owner, language, text, text.slice(node.from, node.to)),
          locator: locator(node),
        };
        nodes.push(symbol);
        if (language === 'go' && owner.id !== root.id)
          visibleFrom.set(symbol.id, goVisibleFrom(definition.owner));
        parsed.definitions.push({ symbol, scope: owner.id, owner: definition.owner });
        if (definition.bind) {
          const prior = owner.bindings.get(symbol.name) ?? [];
          prior.push(symbol);
          owner.bindings.set(symbol.name, prior);
        }
      } else if (referenceName(node, language)) pending.push({ file: parsed, node, scope, locator });
      stack.push(
        ...children(node)
          .reverse()
          .map(child => ({ node: child, scope })),
      );
    }
  }
  for (const path of session?.structuralTrees?.keys() ?? [])
    if (!retainedPaths.has(path)) session!.structuralTrees!.delete(path);
  const resolved = structuralImports(files, snapshot);
  issues.push(...resolved.issues);
  references.push(...resolved.references);
  const scanned = csharpAnalysis(csharp, snapshot);
  nodes.push(...scanned.nodes);
  resolved.imports.push(...scanned.imports);
  issues.push(...scanned.issues);
  for (const { file, node, scope, locator } of pending) {
    const name = file.text.slice(node.from, node.to);
    let current: Scope | null = scope,
      target: string | undefined,
      shadowed = false,
      crossedRustFunction = false;
    while (current) {
      if (current.unknown) {
        shadowed = true;
        break;
      }
      // Python methods do not capture their class namespace as lexical variables.
      let candidates =
        file.language === 'python' && current.kind === 'ClassDefinition' && current !== scope
          ? []
          : (current.bindings.get(name) ?? []);
      if (['TypeName', 'TypeIdentifier'].includes(node.name))
        candidates = candidates.filter(item =>
          [
            'ClassDeclaration',
            'InterfaceDeclaration',
            'RecordDeclaration',
            'EnumDeclaration',
            'StructDeclaration',
            'TraitDeclaration',
            'TypeAliasDeclaration',
            'TypeParameter',
          ].includes(item.kind),
        );
      if (file.language === 'go')
        candidates = candidates.filter(item => (visibleFrom.get(item.id) ?? 0) <= node.from);
      else if (file.language !== 'python')
        candidates = candidates.filter(
          item => item.kind !== 'VariableDeclaration' || item.locator.start.offset < node.from,
        );
      if (current.id === file.rootScope && candidates.length && resolved.reserved.get(file.file)?.has(name)) {
        shadowed = true;
        break;
      }
      if (candidates.length) {
        shadowed = true;
        const allowed = crossedRustFunction
          ? candidates.filter(item => !['VariableDeclaration', 'Parameter'].includes(item.kind))
          : candidates;
        if (allowed.length === 1) target = allowed[0]!.id;
        else if (file.language === 'python' && allowed.every(item => item.kind === 'VariableDeclaration'))
          target = allowed[0]?.id;
        else if (file.language === 'rust' && allowed.every(item => item.kind === 'VariableDeclaration'))
          target = allowed.filter(item => item.locator.start.offset < node.from).at(-1)?.id;
        break;
      }
      if (file.language === 'rust' && current.kind === 'FunctionItem') crossedRustFunction = true;
      current = current.parent;
    }
    if (!shadowed) target = resolved.bindings.get(file.file)?.get(name);
    if (target) references.push({ target, locator: locator(node) });
  }
  return { nodes, references, imports: resolved.imports, issues };
}

function hasImportAncestor(node: SyntaxNode): boolean {
  for (let parent = node.parent; parent; parent = parent.parent)
    if (parent.name === 'UseDeclaration') return true;
  return false;
}
