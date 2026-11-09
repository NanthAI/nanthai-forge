// SPDX-License-Identifier: Apache-2.0
// Tests that scan the repository tree: a rules or lint-style guard lists a folder (readdir, opendir,
// glob) and checks every file in it. No import edge reaches such a test, so a new literal in any
// scanned file can fail it while the import graph says nothing (Issue ec7960f9 item 4). A test
// scans a folder when a directory enumeration's argument is rooted at the repository (built from
// `import.meta` or `process.cwd()`); its scan set is the folder literals that flow into that
// argument (through variables, `for…of` lists and function parameters). Parses repository bytes
// only: no file read, no process, no server call.
import ts from 'typescript';
import { posix } from 'node:path';

const testFile = path => /^tests\/[^/]+\.test\.mjs$/.test(path);
const ENUMERATE = /^(?:readdir|readdirSync|opendir|opendirSync|glob|globSync)$/;
// Cheap text filter: only files that enumerate a directory and name a repository base are parsed.
const MAYBE = /\b(?:readdir|readdirSync|opendir|opendirSync|glob|globSync)\b/;
const BASE = /import\.meta\.(?:url|dirname|filename)|process\.cwd\(\)/;
const FOLDER = /^[\w.@-]+(?:\/[\w.@-]+)*$/;
const MAX_DEPTH = 12;

/** What an expression can contribute to a path: whether it is built from the repository base (and
 * from `import.meta`, which can name the root itself), and the string pieces in it. */
const empty = () => ({ rooted: false, meta: false, literals: new Set() });
const merge = (into, from) => {
  into.rooted ||= from.rooted;
  into.meta ||= from.meta;
  for (const literal of from.literals) into.literals.add(literal);
  return into;
};

function analyse(path, text) {
  const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declarations = new Map();
  const calls = new Map();
  const enumerations = [];
  const callee = call =>
    ts.isIdentifier(call.expression)
      ? call.expression.text
      : ts.isPropertyAccessExpression(call.expression)
        ? call.expression.name.text
        : '';
  const visit = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const list = node.parent;
      const loop = list?.parent;
      const source =
        loop && (ts.isForOfStatement(loop) || ts.isForInStatement(loop)) && loop.initializer === list
          ? loop.expression
          : node.initializer;
      if (source)
        (declarations.get(node.name.text) ?? declarations.set(node.name.text, []).get(node.name.text)).push(
          source,
        );
    }
    const fn =
      ts.isFunctionDeclaration(node) && node.name
        ? { name: node.name.text, node }
        : ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.initializer &&
            (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
          ? { name: node.name.text, node: node.initializer }
          : null;
    if (fn)
      fn.node.parameters.forEach((parameter, index) => {
        if (!ts.isIdentifier(parameter.name)) return;
        const name = parameter.name.text;
        (declarations.get(name) ?? declarations.set(name, []).get(name)).push({
          parameterOf: fn.name,
          index,
        });
        if (parameter.initializer) declarations.get(name).push(parameter.initializer);
      });
    // A callback's first parameter takes the receiver's values: `['lib', 'app'].flatMap(dir => …)`.
    if (
      (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
      ts.isCallExpression(node.parent) &&
      node.parent.arguments.includes(node) &&
      ts.isPropertyAccessExpression(node.parent.expression) &&
      node.parameters[0] &&
      ts.isIdentifier(node.parameters[0].name)
    ) {
      const name = node.parameters[0].name.text;
      (declarations.get(name) ?? declarations.set(name, []).get(name)).push(
        node.parent.expression.expression,
      );
    }
    if (ts.isCallExpression(node)) {
      const name = callee(node);
      if (ts.isIdentifier(node.expression)) (calls.get(name) ?? calls.set(name, []).get(name)).push(node);
      if (ENUMERATE.test(name) && node.arguments.length) enumerations.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  const resolving = new Set();
  const identifier = (name, depth) => {
    const found = empty();
    if (resolving.has(name) || depth > MAX_DEPTH) return found;
    resolving.add(name);
    for (const source of declarations.get(name) ?? [])
      if (source.parameterOf)
        for (const call of calls.get(source.parameterOf) ?? [])
          merge(found, value(call.arguments[source.index], depth + 1));
      else merge(found, value(source, depth + 1));
    resolving.delete(name);
    return found;
  };
  /** The pieces of an expression. Unknown shapes contribute their parts, so a folder is found
   * through `join`, `new URL`, `fileURLToPath`, `.pathname`, templates and string concatenation. */
  function value(node, depth = 0) {
    const found = empty();
    if (!node || depth > MAX_DEPTH) return found;
    if (ts.isStringLiteralLike(node)) found.literals.add(node.text);
    else if (ts.isTemplateExpression(node)) {
      found.literals.add(node.head.text);
      for (const span of node.templateSpans) {
        merge(found, value(span.expression, depth + 1));
        found.literals.add(span.literal.text);
      }
    } else if (ts.isIdentifier(node)) merge(found, identifier(node.text, depth));
    else if (
      ts.isMetaProperty(node) ||
      (ts.isPropertyAccessExpression(node) && ts.isMetaProperty(node.expression))
    )
      found.rooted = found.meta = true;
    else if (ts.isCallExpression(node) && node.expression.getText() === 'process.cwd') found.rooted = true;
    else if (ts.isArrowFunction(node) || ts.isFunctionLike(node) || ts.isObjectLiteralExpression(node))
      return found;
    else if (ts.isPropertyAccessExpression(node)) merge(found, value(node.expression, depth + 1));
    else ts.forEachChild(node, child => void merge(found, value(child, depth + 1)));
    return found;
  }
  const scans = [];
  for (const call of enumerations) {
    const argument = value(call.arguments[0]);
    const options = call.arguments[1]?.getText() ?? '';
    // A glob pattern is relative to the working directory unless its options move it elsewhere.
    const glob = /^glob/.test(callee(call));
    const setting =
      call.arguments[1] && ts.isObjectLiteralExpression(call.arguments[1])
        ? call.arguments[1].properties.find(
            item => ts.isPropertyAssignment(item) && item.name.getText() === 'cwd',
          )
        : undefined;
    const cwd = setting ? value(setting.initializer) : /\bcwd\b/.test(options) ? empty() : null;
    if (!argument.rooted && !(glob && argument.literals.size && (!cwd || cwd.rooted))) continue;
    const enclosing = ts.findAncestor(call.parent, node => ts.isFunctionLike(node));
    const own = enclosing && (enclosing.name?.getText() ?? enclosing.parent?.name?.getText?.());
    const recursive =
      /\brecursive\s*:\s*true\b/.test(options) ||
      /\*\*/.test([...argument.literals].join(' ')) ||
      (own && (calls.get(own) ?? []).some(inner => ts.findAncestor(inner, node => node === enclosing)));
    const folders = new Set();
    for (const literal of argument.literals) {
      const cut = literal.split(/[*?{[]/)[0];
      // `./x` and `../x` are relative to the test file (`new URL('../convex', import.meta.url)`); a
      // bare piece is relative to the repository base it is joined to (`join(root, 'src')`).
      const folder = (
        cut.startsWith('.') ? posix.normalize(posix.join(posix.dirname(path), cut)) : cut
      ).replace(/\/+$/, '');
      if (folder && folder !== '.' && !folder.startsWith('..') && FOLDER.test(folder)) folders.add(folder);
    }
    // Rooted with no folder piece: the repository root itself, named through `import.meta`.
    if (!folders.size && argument.meta) folders.add('');
    for (const folder of folders)
      if (!scans.some(item => item.folder === folder && item.recursive === !!recursive))
        scans.push({ folder, recursive: !!recursive });
  }
  return scans;
}

const memo = new WeakMap();
/** Test file -> the folders it scans ({folder, recursive}; folder '' is the repository root).
 * Memoized per inventory. */
export function treeScanners(files) {
  if (memo.has(files)) return memo.get(files);
  const found = new Map();
  for (const [path, text] of files) {
    if (!testFile(path) || typeof text !== 'string' || !MAYBE.test(text) || !BASE.test(text)) continue;
    let scans;
    try {
      scans = analyse(path, text);
    } catch {
      continue; /* An unparseable test is the graph's problem; it fails selection there. */
    }
    if (scans.length) found.set(path, scans);
  }
  memo.set(files, found);
  return found;
}

/** A scan covers a path inside its folder (anywhere below it when recursive, directly in it when not). */
export const scanCovers = ({ folder, recursive }, path) => {
  if (folder && !path.startsWith(`${folder}/`)) return false;
  return recursive || !path.slice(folder ? folder.length + 1 : 0).includes('/');
};

/** Tests that scan a folder holding one of `paths`: test -> {path, folder}. The test is that path's
 * coverage, as a reader of a changed document is. */
export function scanReaders(files, paths) {
  const found = new Map();
  if (!paths.length) return found;
  for (const [test, scans] of treeScanners(files))
    for (const path of paths) {
      const scan = scans.find(item => scanCovers(item, path));
      if (scan) {
        found.set(test, { path, folder: scan.folder });
        break;
      }
    }
  return found;
}

/** Why a scanner covers a path, for selection reasons. */
export const scanDetail = ({ path, folder }) =>
  `Scans ${folder ? `${folder}/` : 'the repository root'}, which holds changed ${path}`;
