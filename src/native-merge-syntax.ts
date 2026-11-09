// SPDX-License-Identifier: Apache-2.0
import type ts from 'typescript';
import { firstOtherSyntaxProblem, otherSyntaxLanguage } from './native-merge-syntax-other.js';
import { mergeGates } from './ecosystems.js';

/** A text merge can combine two edits that each compile alone into a file that
 * does not (two `const root` declarations, an unbalanced brace). The merge is
 * line-based and cannot see that. Before a composition is accepted, every
 * JS/TS, Python, Java, Rust and JSON file that was text-merged is parsed here,
 * source only: nothing in the project is imported, evaluated or run. JS/TS uses
 * the TypeScript parser and binder already in the dependencies, plus a
 * module-scope import/declaration clash check the binder leaves to its type
 * checker; the other languages use native-merge-syntax-other.
 *
 * Only a merged file that fails while BOTH side versions parse cleanly is a
 * conflict. A side that already fails is left to the check; it is not blocked.
 * Files over the size bound, other languages, and any parser failure never block. */
export const SYNTAX_GATE_MAX_BYTES = 256 * 1024;
const CHECKED = mergeGates().find(([, grammar]) => grammar === 'typescript')![0];
export const syntaxCheckedPath = (path: string) => CHECKED.test(path) || !!otherSyntaxLanguage(path);

export type SyntaxProblem = { line: number; column: number; message: string };

let loaded: Promise<typeof ts> | undefined;
/** Loaded on first use only: the compiler is about 9 MB and 100 ms to start. */
const compiler = () =>
  (loaded ??= import('typescript').then(
    module => ((module as { default?: typeof ts }).default ?? module) as typeof ts,
  ));

const options = (api: typeof ts): ts.CompilerOptions => ({
  noResolve: true,
  noLib: true,
  allowJs: true,
  noEmit: true,
  types: [],
  target: api.ScriptTarget.Latest,
  module: api.ModuleKind.ESNext,
});

/** Import bindings that a top-level value declaration then redeclares. The
 * binder reports import/import and declaration/declaration clashes, not this. */
function importClash(api: typeof ts, file: ts.SourceFile): ts.Node | null {
  const imported = new Map<string, ts.Node>();
  for (const statement of file.statements) {
    if (!api.isImportDeclaration(statement) || !statement.importClause) continue;
    const clause = statement.importClause;
    if (clause.isTypeOnly) continue;
    if (clause.name) imported.set(clause.name.text, clause.name);
    const bindings = clause.namedBindings;
    if (bindings && api.isNamespaceImport(bindings)) imported.set(bindings.name.text, bindings.name);
    else if (bindings)
      for (const item of bindings.elements) if (!item.isTypeOnly) imported.set(item.name.text, item.name);
  }
  if (!imported.size) return null;
  for (const statement of file.statements) {
    const names: ts.Identifier[] = [];
    if (api.isVariableStatement(statement))
      for (const item of statement.declarationList.declarations)
        if (api.isIdentifier(item.name)) names.push(item.name);
    if (
      (api.isFunctionDeclaration(statement) ||
        api.isClassDeclaration(statement) ||
        api.isEnumDeclaration(statement)) &&
      statement.name
    )
      names.push(statement.name);
    for (const name of names) if (imported.has(name.text)) return name;
  }
  return null;
}

/** The first syntax or binder-level early error, or null when the file parses.
 * Type errors and unresolved modules are not syntax and are not reported. */
export async function firstSyntaxProblem(path: string, bytes: Buffer): Promise<SyntaxProblem | null> {
  const text = bytes.toString('utf8');
  if (!CHECKED.test(path)) {
    const other = await firstOtherSyntaxProblem(path, text);
    if (!other) return null;
    const before = text.slice(0, other.offset),
      line = before.split('\n').length;
    return { line, column: other.offset - (before.lastIndexOf('\n') + 1) + 1, message: other.message };
  }
  const api = await compiler();
  const file = api.createSourceFile(path, text, api.ScriptTarget.Latest, true);
  const host: ts.CompilerHost = {
    getSourceFile: name => (name === path ? file : undefined),
    getDefaultLibFileName: () => 'lib.d.ts',
    writeFile: () => {},
    getCurrentDirectory: () => '/',
    getCanonicalFileName: name => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: name => name === path,
    readFile: () => undefined,
    getDirectories: () => [],
  };
  const program = api.createProgram([path], options(api), host);
  const found: { start: number; message: string }[] = [];
  for (const item of program.getSyntacticDiagnostics(file))
    found.push({ start: item.start ?? 0, message: api.flattenDiagnosticMessageText(item.messageText, '\n') });
  // Creating the checker binds the file; its duplicate-declaration errors are
  // the early errors a JavaScript engine rejects at load time.
  program.getTypeChecker();
  const bound = (file as unknown as { bindDiagnostics?: readonly ts.Diagnostic[] }).bindDiagnostics ?? [];
  for (const item of bound)
    found.push({ start: item.start ?? 0, message: api.flattenDiagnosticMessageText(item.messageText, '\n') });
  const clash = importClash(api, file);
  if (clash)
    found.push({
      start: clash.getStart(file),
      message: `Import declaration conflicts with local declaration of '${(clash as ts.Identifier).text}'.`,
    });
  const first = found.sort((a, b) => a.start - b.start)[0];
  if (!first) return null;
  const at = file.getLineAndCharacterOfPosition(first.start);
  return { line: at.line + 1, column: at.character + 1, message: first.message };
}

/** The conflict reason for a text-merged file, or null when it is fine, was
 * already broken on one side, is not source, is too large, or could not be parsed. */
export async function syntaxConflictReason(
  path: string,
  merged: Buffer,
  left: Buffer,
  right: Buffer,
): Promise<string | null> {
  if (!syntaxCheckedPath(path) || merged.length > SYNTAX_GATE_MAX_BYTES) return null;
  try {
    const problem = await firstSyntaxProblem(path, merged);
    if (!problem) return null;
    if (left.length > SYNTAX_GATE_MAX_BYTES || right.length > SYNTAX_GATE_MAX_BYTES) return null;
    if ((await firstSyntaxProblem(path, left)) || (await firstSyntaxProblem(path, right))) return null;
    return `composed ${path}:${problem.line}:${problem.column} does not parse although each side does: ${problem.message}`;
  } catch {
    return null;
  }
}
