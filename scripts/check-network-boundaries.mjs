// SPDX-License-Identifier: Apache-2.0
import ts from 'typescript';

/** Inspect executable syntax, so comments and type-only `typeof fetch` cannot
 * bless a bare request. One HTTP primitive and one complete-RPC constructor. */
export function networkBoundaryFindings(path, text) {
  if (!path.startsWith('src/') || !/\.(?:[cm]?[jt]s|[jt]sx)$/.test(path)) return [];
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const findings = [];
  const fail = (node, message) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    findings.push(`${path}:${line + 1}: ${message}`);
  };
  const httpClients = new Set(['ConvexHttpClient', 'ConvexClient']);
  for (const statement of source.statements)
    if (ts.isImportDeclaration(statement) && statement.moduleSpecifier.text === 'convex/browser')
      for (const item of statement.importClause?.namedBindings?.elements ?? [])
        if (['ConvexHttpClient', 'ConvexClient'].includes((item.propertyName ?? item.name).text))
          httpClients.add(item.name.text);
  const visit = node => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === 'AbortSignal.timeout' &&
      path !== 'src/network-fetch.ts'
    )
      fail(node, 'Use networkTimeout so explicit request budgets reach the shared transport.');
    if (ts.isIdentifier(node) && node.text === 'fetch' && path !== 'src/network-fetch.ts') {
      const parent = node.parent;
      const property =
        (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isMethodSignature(parent)) &&
        parent.name === node;
      const type = ts.isTypeQueryNode(parent) || ts.isLiteralTypeNode(parent);
      const accessor =
        ts.isPropertyAccessExpression(parent) &&
        parent.name === node &&
        !['globalThis', 'window', 'self'].includes(parent.expression.getText(source));
      if (!property && !type && !accessor)
        fail(node, 'Use networkFetch; bare or aliased fetch bypasses shared deadlines.');
    }
    if (
      ts.isElementAccessExpression(node) &&
      ['globalThis', 'window', 'self'].includes(node.expression.getText(source)) &&
      node.argumentExpression.getText(source).match(/^['"]fetch['"]$/) &&
      path !== 'src/network-fetch.ts'
    )
      fail(node, 'Use networkFetch; global fetch bypasses shared deadlines.');
    if (
      ts.isNewExpression(node) &&
      ((ts.isIdentifier(node.expression) && httpClients.has(node.expression.text)) ||
        (ts.isPropertyAccessExpression(node.expression) &&
          ['ConvexHttpClient', 'ConvexClient'].includes(node.expression.name.text))) &&
      path !== 'src/network-convex-client.ts'
    )
      fail(node, 'Use deadlineConvexClient; the complete RPC must have a deadline.');
    if (
      ts.isImportDeclaration(node) &&
      /^(node:)?https?$|^(undici|node-fetch|cross-fetch|axios|got|superagent)$/.test(
        node.moduleSpecifier.text,
      ) &&
      path !== 'src/exchange-convex-fetch.ts' &&
      !node.importClause?.isTypeOnly &&
      (node.importClause?.name ||
        ts.isNamespaceImport(node.importClause?.namedBindings ?? {}) ||
        (node.importClause?.namedBindings?.elements ?? []).some(
          item =>
            !item.isTypeOnly &&
            ['request', 'get', 'fetch', 'Client', 'Pool', 'Agent'].includes(
              (item.propertyName ?? item.name).text,
            ),
        ))
    )
      fail(node, 'Network primitives belong in the shared transport.');
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        node.expression.getText(source) === 'require') &&
      ts.isStringLiteral(node.arguments[0] ?? {}) &&
      /^(node:)?https?$|^(undici|node-fetch|cross-fetch|axios|got|superagent)$/.test(node.arguments[0].text)
    )
      fail(node, 'Dynamic network primitives bypass the shared transport.');
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}
