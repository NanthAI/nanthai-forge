// SPDX-License-Identifier: Apache-2.0
import ts from 'typescript';

/** The retained store implementation stays behind explicit caller capabilities (657d63ee). */
export function workStoreAccessFindings(path, source) {
  if (!path.startsWith('src/') || path === 'src/work-store.ts' || !source.includes('WorkStore')) return [];
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const names = new Set();
  const namespaces = new Set();
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement) || !/work-store\.js$/.test(statement.moduleSpecifier.text))
      continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings))
      for (const entry of bindings.elements)
        if ((entry.propertyName ?? entry.name).text === 'WorkStore') names.add(entry.name.text);
  }
  const store = expression =>
    (ts.isIdentifier(expression) && names.has(expression.text)) ||
    (ts.isPropertyAccessExpression(expression) &&
      expression.name.text === 'WorkStore' &&
      ((ts.isIdentifier(expression.expression) && namespaces.has(expression.expression.text)) ||
        /import\(['"]\.\/work-store\.js['"]\)/.test(expression.expression.getText(tree))));
  const explicit = node =>
    node &&
    (ts.isUnionTypeNode(node)
      ? node.types.every(explicit)
      : ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal));
  const findings = [];
  const fail = node => {
    const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
    findings.push(
      `${path}:${line}: select WorkStore.open<explicit capability keys>(); keep full-store types inside Pick.`,
    );
  };
  function visit(node) {
    if (ts.isNewExpression(node) && store(node.expression)) fail(node);
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'open' &&
      store(node.expression.expression) &&
      !explicit(node.typeArguments?.[0])
    )
      fail(node);
    if (ts.isTypeReferenceNode(node) && names.has(node.typeName.getText(tree))) {
      const parent = node.parent;
      if (
        !ts.isTypeReferenceNode(parent) ||
        parent.typeName.getText(tree) !== 'Pick' ||
        parent.typeArguments?.[0] !== node
      )
        fail(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return findings;
}
