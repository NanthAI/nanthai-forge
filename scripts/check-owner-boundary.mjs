// SPDX-License-Identifier: Apache-2.0
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';

/** Reviewed device permissions, one file per Convex module (Item 491ddd77): every new owner entry
 * point used to add a line to one shared test file, so most such Lanes overlapped on it.
 * `tests/owner-boundary-guard.d/<module>.json` holds `{"actions": [...], "reason"?: "..."}`. Read as
 * data; nothing is imported or executed. The folder is the only input: the guard test may not declare
 * its own `allowed` map, dotfiles (such as Finder's .DS_Store) are ignored, and an entry for a module
 * that no longer exists is a finding, so a stale allowance cannot revive under a reused name. */
function permissionInventory(directory) {
  const guard = readFileSync(new URL('../tests/owner-boundary-guard.test.mjs', directory), 'utf8');
  if (/\ballowed\s*=\s*\{/.test(guard))
    throw new Error(
      'tests/owner-boundary-guard.test.mjs: owner permissions live in tests/owner-boundary-guard.d/<module>.json, one file per module.',
    );
  const folder = new URL('../tests/owner-boundary-guard.d/', directory);
  return Object.fromEntries(
    readdirSync(folder)
      .filter(name => !name.startsWith('.'))
      .sort()
      .map(name => {
        const entry = name.endsWith('.json') ? JSON.parse(readFileSync(new URL(name, folder), 'utf8')) : null;
        if (
          !entry ||
          !Array.isArray(entry.actions) ||
          !entry.actions.every(action => typeof action === 'string') ||
          !Object.keys(entry).every(key => key === 'actions' || key === 'reason')
        )
          throw new Error(
            `tests/owner-boundary-guard.d/${name}: must be {"actions": [names], "reason"?: text}.`,
          );
        return [name.slice(0, -'.json'.length), entry.actions];
      }),
  );
}
export function ownerBoundaryFindings(directory) {
  const allowed = permissionInventory(directory);
  const modules = readdirSync(directory).filter(file => file.endsWith('.ts'));
  const stale = Object.keys(allowed)
    .filter(module => !modules.includes(`${module}.ts`))
    .map(
      module =>
        `tests/owner-boundary-guard.d/${module}.json: convex/${module}.ts no longer exists; delete the stale entry`,
    );
  const unknown = [];
  for (const file of modules) {
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
  return [
    ...stale,
    ...unknown.map(
      name => `${name}: classify the owner action or requireOwnerPerson before adding authority`,
    ),
  ];
}
