// SPDX-License-Identifier: Apache-2.0
import ts from 'typescript';
import { structuralAnalysis, STRUCTURAL_PROVIDERS } from './structural-analyze.js';
import { identity, graphIdentity } from './hash.js';
import { makeProgram, local, resolveImport, type CompilerSession } from './compiler.js';
import { ForgeError, invariant } from './errors.js';
import type { GraphPack, Locator, Snapshot, SymbolNode } from './types.js';

export const LIMITATIONS = [
  'TypeScript and JavaScript declarations and compiler-resolved identifier references; Python, Java and Rust parser-backed declarations and conservative lexical references.',
  'Captured relative TypeScript/JavaScript/Python imports, qualified Java types and explicit Rust file modules only; no installed dependencies, tsconfig paths, classpath, Cargo configuration or plugins.',
  'Python export flags remain unknown (false); Java/Rust public modifiers are syntactic declarations, not effective runtime visibility.',
  'Python global/nonlocal scopes, defaults, comprehensions and unmodelled bindings, nested import bindings, Java overloads and Rust braced/glob imports remain unresolved; Rust crate roots use captured lib.rs/main.rs module chains.',
  'No complete call graph, data flow, runtime dispatch, framework routing or cross-language semantics.',
  'Syntax-error files have no nodes or references; unresolved modules and unsupported behavior remain unknown.',
  'No persistent symbol lineage across states; offsets are UTF-16 code units and lines/columns are 1-based.',
];

function namedDeclaration(node: ts.Node): ts.Identifier | ts.StringLiteral | undefined {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isVariableDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isPropertySignature(node) ||
    ts.isEnumMember(node) ||
    ts.isModuleDeclaration(node)
  ) {
    const name = node.name;
    if (name && (ts.isIdentifier(name) || ts.isStringLiteral(name))) return name;
  }
  return undefined;
}

export const analysisProvider = (): GraphPack['analysis'] => ({
  provider: 'forge-language-analyzers',
  version:
    `typescript@${ts.version};` +
    STRUCTURAL_PROVIDERS.map(item => `${item.parser}@${item.version}`).join(';'),
  configVersion: 2,
  resolution: 'captured-language-structure',
  coverage: 'partial',
  limitations: [...LIMITATIONS],
  languages: [
    ...['typescript', 'javascript'].map(language => ({
      language,
      parser: 'typescript',
      version: ts.version,
      relationships: ['declarations', 'compiler-identifier-references', 'captured-relative-imports'],
    })),
    ...STRUCTURAL_PROVIDERS.map(item => ({ ...item, relationships: [...item.relationships] })),
  ],
});

export function analyze(snapshot: Snapshot, session?: CompilerSession): GraphPack {
  try {
    return analyzeSnapshot(snapshot, session);
  } catch (error) {
    if (error instanceof ForgeError) throw error;
    throw new ForgeError('ANALYSIS_FAILED', 'Source analysis failed; no new artifact was published.');
  }
}

function analyzeSnapshot(snapshot: Snapshot, session?: CompilerSession): GraphPack {
  const program = makeProgram(snapshot, session);
  const checker = program.getTypeChecker();
  const nodes: SymbolNode[] = [];
  const imports: GraphPack['imports'] = [];
  const references: GraphPack['references'] = [];
  const issues: GraphPack['issues'] = [];
  const declarationIds = new Map<ts.Node, string>();
  const declarations = new Set<ts.Node>();
  const files = new Map(snapshot.source.files.map(file => [file.path, file]));
  const valid = program.getSourceFiles().filter(source => {
    const diagnostics = program.getSyntacticDiagnostics(source);
    for (const d of diagnostics)
      issues.push({ file: local(source.fileName), code: `TS${d.code}`, offset: d.start ?? 0 });
    return diagnostics.length === 0;
  });
  function locator(node: ts.Node, source: ts.SourceFile): Locator {
    const start = node.getStart(source);
    const end = node.getEnd();
    const first = source.getLineAndCharacterOfPosition(start);
    const last = source.getLineAndCharacterOfPosition(end);
    return {
      file: local(source.fileName),
      digest: files.get(local(source.fileName))!.digest,
      start: { offset: start, line: first.line + 1, column: first.character + 1 },
      end: { offset: end, line: last.line + 1, column: last.character + 1 },
    };
  }
  let visits = 0;
  function visit(root: ts.Node, callback: (node: ts.Node) => void): void {
    const stack = [root];
    while (stack.length) {
      const node = stack.pop()!;
      invariant(++visits < 4_000_000, 'ANALYSIS_LIMIT', 'Source exceeds the analysis node budget.');
      callback(node);
      const children: ts.Node[] = [];
      ts.forEachChild(node, child => {
        children.push(child);
      });
      stack.push(...children.reverse());
    }
  }
  for (const source of valid)
    visit(source, node => {
      const name = namedDeclaration(node);
      if (name) {
        const loc = locator(name, source);
        const id = `symbol:${identity([snapshot.source.id, loc.file, loc.start.offset, ts.SyntaxKind[node.kind]])}`;
        declarationIds.set(node, id);
        declarations.add(name);
        nodes.push({
          id,
          name: name.text,
          kind: ts.SyntaxKind[node.kind],
          exported: (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0,
          locator: loc,
        });
      }
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const specifier = node.moduleSpecifier.text;
        const target = resolveImport(local(source.fileName), specifier, snapshot.content);
        imports.push({
          from: local(source.fileName),
          specifier,
          target,
          resolution: target ? 'resolved' : specifier.startsWith('.') ? 'unresolved' : 'external',
          locator: locator(node.moduleSpecifier, source),
        });
      }
    });
  for (const source of valid)
    visit(source, node => {
      if (!ts.isIdentifier(node) || declarations.has(node)) return;
      let symbol = checker.getSymbolAtLocation(node);
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      const target = symbol?.declarations?.map(d => declarationIds.get(d)).find(Boolean);
      if (target) references.push({ target, locator: locator(node, source) });
    });
  const structural = structuralAnalysis(snapshot, session);
  nodes.push(...structural.nodes);
  imports.push(...structural.imports);
  references.push(...structural.references);
  issues.push(...structural.issues);
  const body = {
    schemaVersion: 1 as const,
    source: snapshot.source,
    analysis: analysisProvider(),
    nodes,
    imports,
    references,
    issues,
  };
  return { id: graphIdentity(body), ...body };
}
