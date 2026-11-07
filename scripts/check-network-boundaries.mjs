// SPDX-License-Identifier: Apache-2.0
import ts from 'typescript';

/** Files that may touch the global fetch or a primitive without the shared
 * helper, each with its reason. Keep this short; a new entry needs review. */
const exempt = new Map([
  // Measurement harnesses replace the global under networkFetch to count requests;
  // the shared helper still owns every deadline and retry above them.
  ['scripts/measure-host.mjs', 'intercept'],
  ['scripts/measure-exchange-latency.mjs', 'intercept'],
  ['scripts/benchmark-import-projection.mjs', 'intercept'],
  // Copied alone beside a benchmark agent's nforge shim (no repo imports). It
  // streams one local loopback command whose own wait is bounded (540 s).
  ['scripts/bench-t3code/relay-client.mjs', 'primitive'],
  // Runs in the release-sign GitHub job from a sparse checkout with plain Node (no install or
  // build, so no dist/ helper). Two Convex calls, each with its own 20 s deadline, in a job
  // capped at 5 minutes.
  ['scripts/release-sign-ci.mjs', 'standalone'],
]);

/** Server-side code that must reach the network through the shared helper.
 * convex/ actions use convex/networkFetch.ts (convexFetch, no default retries)
 * and netlify/ functions import src/network-fetch.js; both share its deadlines
 * (Issue aabe52a7). web/ stays out: browser requests run on the viewer's device
 * and connection, are cancelled by navigation, strand no worker or Convex call,
 * and its archive/backup transfers are sized by the user's file, so a fixed
 * server-side total deadline would only break large legitimate uploads. */
export const networkBoundaryScopes = /^(?:src|scripts|convex|netlify)\//;
/** Inspect executable syntax, so comments and type-only `typeof fetch` cannot
 * bless a bare request. One HTTP primitive and one complete-RPC constructor.
 * Scripts reach the same helper through dist/ (`npm run build:core`). */
export function networkBoundaryFindings(path, text) {
  if (!networkBoundaryScopes.test(path) || !/\.(?:[cm]?[jt]s|[jt]sx)$/.test(path)) return [];
  if (path === 'scripts/check-network-boundaries.mjs' || path.startsWith('convex/_generated/')) return [];
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
      path !== 'src/network-fetch.ts' &&
      exempt.get(path) !== 'standalone'
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
        (['intercept', 'standalone'].includes(exempt.get(path)) ||
          !['globalThis', 'window', 'self'].includes(parent.expression.getText(source)));
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
      exempt.get(path) !== 'primitive' &&
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
