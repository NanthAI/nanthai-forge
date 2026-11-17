// SPDX-License-Identifier: Apache-2.0
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';

/** Read the existing registration inventory as data; never import or execute its test module. */
function permissionInventory(directory) {
  const file = new URL('../tests/owner-boundary-guard.test.mjs', directory);
  const source = ts.createSourceFile(file.pathname, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const declaration = source.statements
    .filter(ts.isVariableStatement)
    .flatMap(statement => [...statement.declarationList.declarations])
    .find(item => ts.isIdentifier(item.name) && item.name.text === 'allowed');
  const inventory = declaration?.initializer;
  if (!inventory || !ts.isObjectLiteralExpression(inventory))
    throw new Error('Owner permission inventory must declare a literal allowed object.');
  return Object.fromEntries(
    inventory.properties.map(property => {
      if (
        !ts.isPropertyAssignment(property) ||
        !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ||
        !ts.isArrayLiteralExpression(property.initializer) ||
        !property.initializer.elements.every(ts.isStringLiteral)
      )
        throw new Error('Owner permission inventory must name literal modules and actions.');
      return [property.name.text, property.initializer.elements.map(action => action.text)];
    }),
  );
}
export function ownerBoundaryFindings(directory, allowed = permissionInventory(directory)) {
  const unknown = [];
  for (const file of readdirSync(directory).filter(file => file.endsWith('.ts'))) {
    const source = readFileSync(new URL(file, directory), 'utf8');
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    for (const statement of parsed.statements) {
      if (
        !ts.isVariableStatement(statement) ||
        !statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
      )
        continue;
      for (const declaration of statement.declarationList.declarations) {
        const call = declaration.initializer;
        if (
          !call ||
          !ts.isCallExpression(call) ||
          !['mutation', 'query', 'action', 'receiptMutation'].includes(call.expression.getText(parsed))
        )
          continue;
        const body = call.getText(parsed);
        if (!/\b(?:ownedProject|activeOwnedProject)\(|\bproject\??\.owner\s*[!=]==/.test(body)) continue;
        const name = declaration.name.getText(parsed);
        if (!/\brequireOwnerPerson\(/.test(body) && !allowed[file.slice(0, -3)]?.includes(name))
          unknown.push(`${file}:${name}`);
      }
    }
  }
  return unknown.map(
    name => `${name}: classify the owner action or requireOwnerPerson before adding authority`,
  );
}
