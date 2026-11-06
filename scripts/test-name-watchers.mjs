// SPDX-License-Identifier: Apache-2.0
// Tests that watch names a change introduces. An import graph cannot see a test that hooks
// `fs.open` on paths matching /(checkout|delta)-/ while the changed module only builds those
// names with mkdtemp: the two share a literal, not an import. Parse repository bytes only.
import ts from 'typescript';

/** A fragment is distinctive when at most this share of the project's tests watch it. A name every
 * test touches (".json", an error code) says nothing about which test the change can break. */
export const distinctiveShare = 0.01;

const NAME = /^[A-Za-z0-9_.@][A-Za-z0-9_.@/-]*$/;
const SEPARATED = /[-_./]/;
const PATH_CALL =
  /^(?:join|resolve|mkdtemp|mkdtempSync|mkdir|mkdirSync|rename|renameSync|rm|rmSync|open|openSync)$/;
const sourceKind = path => (/\.(?:[cm]?ts|tsx)$/.test(path) ? ts.ScriptKind.TS : ts.ScriptKind.JS);

/** Name-shaped literals (static string and template pieces, minus import specifiers) and the
 * regular expressions a file contains. A bare word counts only as an argument of a path call. */
export function nameLiterals(path, text) {
  const names = new Set();
  const patterns = [];
  const add = (value, pathArgument) => {
    if (value.length < 3 || value.length > 64 || !NAME.test(value)) return;
    if (pathArgument || SEPARATED.test(value)) names.add(value);
  };
  const callee = call =>
    ts.isIdentifier(call.expression)
      ? call.expression.text
      : ts.isPropertyAccessExpression(call.expression)
        ? call.expression.name.text
        : '';
  const visit = node => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) return;
      if (ts.isIdentifier(node.expression) && node.expression.text === 'require') return;
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      add(node.text, ts.isCallExpression(node.parent) && PATH_CALL.test(callee(node.parent)));
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node))
      add(node.text, false);
    else if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      const match = /^\/(.*)\/([a-z]*)$/s.exec(node.text);
      try {
        if (match) patterns.push(new RegExp(match[1], match[2].replace(/[gy]/g, '')));
      } catch {
        /* A pattern this engine rejects watches nothing. */
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, sourceKind(path)));
  return { names, patterns };
}

/** `test` watches `name` when one of its patterns matches the name (alone or as a path segment
 * prefix) or one of its own literals equals the name or contains it. */
function watches(watcher, name) {
  for (const pattern of watcher.patterns) if (pattern.test(name) || pattern.test(`/${name}x`)) return true;
  for (const literal of watcher.names)
    if (literal === name || (name.length >= 5 && literal.includes(name))) return true;
  return false;
}

const stem = name => (name.match(/[A-Za-z0-9]{3,}/g) ?? []).sort((a, b) => b.length - a.length)[0] ?? name;

/** Rank candidate tests by how distinctively they watch names in the changed sources.
 * `tests`: every test path in the inventory (rarity is measured over all of them);
 * `candidates`: tests already in landing coverage that may be promoted; `changed`: changed paths.
 * Returns a Map of candidate -> { score, names } for tests with at least one distinctive match. */
export function watchRanking({ files, tests, candidates, changed }) {
  const fragments = new Set();
  for (const path of new Set(changed)) {
    if (/^tests\//.test(path) || !files.has(path) || !/\.(?:[cm]?[jt]sx?)$/.test(path)) continue;
    for (const name of nameLiterals(path, files.get(path)).names) fragments.add(name);
  }
  const ranking = new Map();
  if (!fragments.size) return ranking;
  const stems = new Map([...fragments].map(name => [name, stem(name)]));
  const matchedBy = new Map([...fragments].map(name => [name, []]));
  for (const test of tests) {
    const text = files.get(test);
    if (typeof text !== 'string') continue;
    // A watcher must at least contain a stem; this keeps the parse to the few tests that could match.
    const possible = [...fragments].filter(name => text.includes(stems.get(name)));
    if (!possible.length) continue;
    const watcher = nameLiterals(test, text);
    for (const name of possible) if (watches(watcher, name)) matchedBy.get(name).push(test);
  }
  const ceiling = Math.max(1, Math.floor(tests.length * distinctiveShare));
  const wanted = new Set(candidates);
  for (const [name, watchers] of matchedBy) {
    if (!watchers.length || watchers.length > ceiling) continue;
    for (const test of watchers) {
      if (!wanted.has(test)) continue;
      const entry = ranking.get(test) ?? { score: 0, names: [] };
      entry.score += 1 / watchers.length;
      entry.names.push(name);
      ranking.set(test, entry);
    }
  }
  return ranking;
}
