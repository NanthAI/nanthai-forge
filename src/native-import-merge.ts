// SPDX-License-Identifier: Apache-2.0
import { parser } from '@lezer/javascript';
import { SourceIoError } from './hosted-source-io-error.js';
import type { SyntaxNode } from '@lezer/common';
import { importLanguage, statementKey, type ImportLanguage } from './native-import-languages.js';
import { importFixups } from './ecosystems.js';

const importsParser = parser.configure({ dialect: 'ts jsx' });

/** Only top-level declarations are candidates. Matching text inside functions,
 * comments or template literals is never deduplicated. */
function declarations(language: ImportLanguage, text: string) {
  try {
    return language.declarations(text);
  } catch (error) {
    throw new SourceIoError(error, 'task', null, null, {
      call: 'import-declarations',
      size: new TextEncoder().encode(text).length,
    });
  }
}
function parseDeclarations(text: string) {
  const source = importsParser.parse(text),
    result = new Map<string, { lines: number[]; safe: boolean }>();
  const requires = (node: SyntaxNode): boolean => {
    if (node.name === 'CallExpression') {
      const callee = node.firstChild;
      if (callee?.name === 'VariableName' && text.slice(callee.from, callee.to) === 'require') return true;
    }
    for (let child = node.firstChild; child; child = child.nextSibling) if (requires(child)) return true;
    return false;
  };
  for (let statement = source.topNode.firstChild; statement; statement = statement.nextSibling) {
    const imported = statement.name === 'ImportDeclaration',
      candidate =
        statement.name === 'ExportDeclaration' ? statement.getChild('VariableDeclaration') : statement,
      required =
        !!candidate &&
        ['ExpressionStatement', 'VariableDeclaration'].includes(candidate.name) &&
        requires(candidate);
    if (!imported && !required) continue;
    const from = text.lastIndexOf('\n', statement.from - 1) + 1,
      to = text.indexOf('\n', statement.to),
      declaration = text.slice(from, to === -1 ? undefined : to + 1),
      current = result.get(statementKey(declaration)) ?? { lines: [], safe: true };
    current.lines.push(text.slice(0, from).split('\n').length - 1);
    // Error recovery, multiline declarations, require evaluation order and attached
    // comments need explicit resolution. Only whole static imports can be removed.
    current.safe &&=
      imported &&
      !statement.toString().includes('⚠') &&
      !text.slice(statement.from, statement.to).includes('\n') &&
      declaration.trim() === text.slice(statement.from, statement.to).trim();
    result.set(statementKey(declaration), current);
  }
  return result;
}

const javascript: ImportLanguage = {
  hint: /\b(?:import|require)\b/,
  declarations: parseDeclarations,
  duplicateBreaks: true,
};
const JAVASCRIPT = importFixups().find(([, language]) => language === 'javascript')![0];
const languageFor = (path: string) => (JAVASCRIPT.test(path) ? javascript : importLanguage(path));

/** Coalesce only a new, byte-identical single-line import added once on each
 * side. Existing duplicates and distinct statements remain source truth. JS/TS,
 * Python, Java, Rust, Go and C# imports are read (native-import-languages); an
 * ambiguous duplicate is a conflict where a duplicate import fails the build. */
export function reconcileNativeImports(
  base: string[],
  left: string[],
  right: string[],
  merged: string[],
  path?: string,
): string[] | null {
  const language = path ? languageFor(path) : undefined;
  if (!language) return merged;
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
        language.hint.test(line),
    )
  )
    return merged;
  // The diff uses LF-delimited lines; other line separators have ambiguous
  // offsets. JS keeps them a conflict; elsewhere the merge stays as it was.
  if ([base, left, right, merged].some(rows => rows.some(line => /\r(?!\n)|[\u2028\u2029]/.test(line))))
    return language === javascript ? null : merged;
  const original = declarations(language, base.join('')),
    a = declarations(language, left.join('')),
    b = declarations(language, right.join('')),
    combined = declarations(language, merged.join('')),
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
      return language.duplicateBreaks ? null : merged;
    remove.add(output.lines[1]!);
  }
  return merged.filter((_, index) => !remove.has(index));
}
