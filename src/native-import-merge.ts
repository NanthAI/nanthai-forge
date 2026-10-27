// SPDX-License-Identifier: Apache-2.0
import { createRequire } from 'node:module';
import type { Node } from 'typescript';

const loadParser = createRequire(import.meta.url);
const statementKey = (text: string) => text.replace(/\r?\n$/, '');

/** Only top-level declarations are candidates. Matching text inside functions,
 * comments or template literals is never deduplicated. */
function declarations(text: string, path: string) {
  const ts = loadParser('typescript') as typeof import('typescript');
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true),
    result = new Map<string, { lines: number[]; safe: boolean }>();
  const requires = (node: Node): boolean =>
    (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') ||
    Boolean(ts.forEachChild(node, child => requires(child) || undefined));
  for (const statement of source.statements) {
    const imported = ts.isImportDeclaration(statement),
      required =
        ts.isImportEqualsDeclaration(statement) ||
        (ts.isExpressionStatement(statement) && requires(statement.expression)) ||
        (ts.isVariableStatement(statement) &&
          statement.declarationList.declarations.some(d => d.initializer && requires(d.initializer)));
    if (!imported && !required) continue;
    const start = source.getLineAndCharacterOfPosition(statement.getStart(source)),
      end = source.getLineAndCharacterOfPosition(statement.end),
      from = source.getPositionOfLineAndCharacter(start.line, 0),
      to = text.indexOf('\n', statement.end),
      declaration = text.slice(from, to === -1 ? undefined : to + 1),
      current = result.get(statementKey(declaration)) ?? { lines: [], safe: true };
    current.lines.push(start.line);
    // Multiline declarations, require evaluation order and attached comments need
    // an explicit resolution; only whole single-line static imports can be removed.
    current.safe &&=
      imported && start.line === end.line && declaration.trim() === statement.getText(source).trim();
    result.set(statementKey(declaration), current);
  }
  return result;
}

/** Coalesce only a new, byte-identical single-line import added once on each
 * side. Existing duplicates and distinct statements remain source truth. */
export function reconcileNativeImports(
  base: string[],
  left: string[],
  right: string[],
  merged: string[],
  path?: string,
): string[] | null {
  if (!path || !/\.(?:[cm]?[jt]s|[jt]sx)$/.test(path)) return merged;
  const counts = (rows: string[]) => {
    const result = new Map<string, number>();
    for (const line of rows) {
      const key = statementKey(line);
      result.set(key, (result.get(key) ?? 0) + 1);
    }
    return result;
  };
  const before = counts(base),
    aLines = counts(left),
    bLines = counts(right);
  if (
    ![...aLines].some(
      ([line, count]) =>
        count > (before.get(line) ?? 0) &&
        (bLines.get(line) ?? 0) > (before.get(line) ?? 0) &&
        /\b(?:import|require)\b/.test(line),
    )
  )
    return merged;
  // The diff uses LF-delimited lines; other JS line separators have ambiguous offsets.
  if ([base, left, right, merged].some(rows => rows.some(line => /\r(?!\n)|[\u2028\u2029]/.test(line))))
    return null;
  const original = declarations(base.join(''), path),
    a = declarations(left.join(''), path),
    b = declarations(right.join(''), path),
    combined = declarations(merged.join(''), path),
    remove = new Set<number>();
  for (const [declaration, x] of a) {
    const y = b.get(declaration),
      output = combined.get(declaration),
      prior = original.get(declaration)?.lines.length ?? 0;
    if (
      !y ||
      !output ||
      x.lines.length <= prior ||
      y.lines.length <= prior ||
      output.lines.length <= Math.max(x.lines.length, y.lines.length)
    )
      continue;
    if (
      prior ||
      x.lines.length !== 1 ||
      y.lines.length !== 1 ||
      output.lines.length !== 2 ||
      !x.safe ||
      !y.safe ||
      !output.safe
    )
      return null;
    remove.add(output.lines[1]!);
  }
  return merged.filter((_, index) => !remove.has(index));
}
