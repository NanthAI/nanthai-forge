// SPDX-License-Identifier: Apache-2.0
import ts from 'typescript';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
/** Parse declarations without executing repository code or hooks. */
export async function benchIndexes(root, tables) {
  const found = {};
  for (const file of await readdir(join(root, 'convex'))) {
    if (!file.endsWith('.ts')) continue;
    const text = await readFile(join(root, 'convex', file), 'utf8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    function walk(node) {
      if (ts.isPropertyAssignment(node) && tables.includes(node.name.getText(source))) {
        let call = node.initializer,
          indexes = [];
        while (ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression)) {
          if (
            call.expression.name.text === 'index' &&
            ts.isStringLiteral(call.arguments[0]) &&
            ts.isArrayLiteralExpression(call.arguments[1])
          ) {
            const fields = call.arguments[1].elements;
            if (fields[0] && ts.isStringLiteral(fields[0]) && fields[0].text === 'projectId')
              indexes.push(call.arguments[0].text);
          }
          call = call.expression.expression;
        }
        if (ts.isCallExpression(call) && call.expression.getText(source) === 'defineTable')
          found[node.name.getText(source)] = indexes.includes('by_project')
            ? 'by_project'
            : (indexes.at(-1) ?? null);
      }
      ts.forEachChild(node, walk);
    }
    walk(source);
  }
  if (tables.some(t => !(t in found))) throw Error('BENCH_DEFINITION_MISSING');
  return found;
}
