// SPDX-License-Identifier: Apache-2.0
import ts from 'typescript';

/** Parse source only. Never import/evaluate a project's schema or Convex runtime. */
export function convexSchemaErrors(text: string): string[] {
  const file = ts.createSourceFile('convex/schema.ts', text, ts.ScriptTarget.Latest, true);
  const tables = new Map<ts.CallExpression, Set<string>>(),
    errors: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ['index', 'searchIndex', 'vectorIndex'].includes(node.expression.name.text)
    ) {
      const name = node.arguments[0];
      let root: ts.Expression = node.expression.expression;
      while (ts.isCallExpression(root) && ts.isPropertyAccessExpression(root.expression))
        root = root.expression.expression;
      if (
        name &&
        ts.isStringLiteralLike(name) &&
        ts.isCallExpression(root) &&
        ((ts.isIdentifier(root.expression) && root.expression.text === 'defineTable') ||
          (ts.isPropertyAccessExpression(root.expression) && root.expression.name.text === 'defineTable'))
      ) {
        const names = tables.get(root) ?? new Set<string>();
        if (names.has(name.text)) {
          const at = file.getLineAndCharacterOfPosition(name.getStart(file));
          errors.push(
            `convex/schema.ts:${at.line + 1}:${at.character + 1}: duplicate index name ${JSON.stringify(name.text)} on one table`,
          );
        }
        names.add(name.text);
        tables.set(root, names);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return errors;
}
