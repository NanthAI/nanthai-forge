// SPDX-License-Identifier: Apache-2.0
// Repo-wide guard tests the folder scanner (test-tree-scanners.mjs) misses because their path is not
// built from `import.meta` or `process.cwd()` (Item 5dcfce75, preflight-miss fix 4):
// - a directory listing of a plain relative path: `node --test` runs from the repository root, so
//   `readdirSync('lib')`, or a walk started from a `['lib', 'app']` list, lists the repository's
//   own folders;
// - a recursive reader: a function that reads the file its parameter names and calls itself on paths
//   it found there (an import-closure walk), started from the repository root or a folder in it.
// Each is a consumer of every file in that folder, with no import edge. Only values whose every piece
// is known count: an alternative built from a temporary folder, a helper's return value or a name the
// file does not bind is dropped, and a test that changes its working directory is skipped. Parses
// repository bytes only: no file read, no process, no server call.
import ts from 'typescript';
import { posix } from 'node:path';

const LIST = /^(?:readdir|readdirSync|opendir|opendirSync)$/;
const READ = /^(?:readFile|readFileSync)$/;
const BUILD = /^(?:join|resolve|normalize)$/;
const UNWRAP = /^(?:fileURLToPath)$/;
// Cheap text filters, so only a few files are parsed: a listing call, or a read of a computed path
// inside a function whose own body calls it (a walk); and a quoted piece naming a folder of the
// repository (or `import.meta` / `process.cwd()`), since an unknown base never counts.
const LISTING = /\b(?:readdir|readdirSync|opendir|opendirSync)\b/;
const READING = /\breadFile(?:Sync)?\s*\(\s*[\w$]/;
const ROOTED = /import\.meta\.(?:url|dirname)|process\.cwd\(\)/;
const QUOTED = /(['"`])([\w.@/-]{1,200})\1/g;
const DECLARED =
  /(?:function\s+([\w$]+)\s*\([^)]*\)\s*\{|(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:\([^()]*\)|[\w$]+)\s*=>\s*\{)/g;
const MAX_DEPTH = 12;

/** The block body that opens at `start` (a `{`), by brace depth; strings and comments are not
 * skipped, which only makes the filter let more files through. */
const blockAt = (text, start) => {
  let depth = 0;
  for (let i = start; i < text.length; i++)
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(start, i);
  return text.slice(start);
};
const walksInText = text => {
  for (const match of text.matchAll(DECLARED)) {
    const name = match[1] ?? match[2];
    const body = blockAt(text, match.index + match[0].length - 1);
    if (new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}\\s*\\(`).test(body)) return true;
  }
  return false;
};
const folderSets = new WeakMap();
/** Every folder of the inventory ('' is the root), so a quoted piece can be checked in O(1). */
const repositoryFolders = files => {
  if (folderSets.has(files)) return folderSets.get(files);
  const folders = new Set(['']);
  for (const path of files.keys())
    for (let at = path.indexOf('/'); at > 0; at = path.indexOf('/', at + 1)) folders.add(path.slice(0, at));
  folderSets.set(files, folders);
  return folders;
};
const namesFolder = (text, folders) => {
  if (ROOTED.test(text)) return true;
  for (const [, , piece] of text.matchAll(QUOTED)) {
    const folder = folderOf(piece);
    if (folder !== null && folders.has(folder)) return true;
  }
  return false;
};
const maybe = (text, folders) =>
  !/\bprocess\.chdir\s*\(/.test(text) &&
  (LISTING.test(text) || (READING.test(text) && walksInText(text))) &&
  namesFolder(text, folders);

/** A literal path relative to the repository root, or null when it leaves it or is absolute. */
const folderOf = text => {
  if (!text || text.startsWith('/') || /^[a-z]+:/i.test(text) || /[*?{[\\]/.test(text)) return null;
  const normal = posix.normalize(text).replace(/\/+$/, '');
  if (normal === '.' || normal === '') return '';
  return normal === '..' || normal.startsWith('../') ? null : normal;
};
const joinFolder = (base, piece) => folderOf(base ? `${base}/${piece}` : piece);

const memberName = expression =>
  ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression)
    ? (ts.isIdentifier(expression) ? expression : expression.name).text
    : ts.isElementAccessExpression(expression) && ts.isStringLiteralLike(expression.argumentExpression)
      ? expression.argumentExpression.text
      : '';

// Only narrow when a literal suffix filter feeds unchanged paths to a file read.
// Any other use, predicate or additional scan keeps its own conservative coverage.
export function listingSuffix(call) {
  let result = call;
  while (ts.isAwaitExpression(result.parent) || ts.isParenthesizedExpression(result.parent))
    result = result.parent;
  const method = result.parent;
  const filter = method.parent;
  if (
    !ts.isPropertyAccessExpression(method) ||
    method.expression !== result ||
    method.name.text !== 'filter' ||
    !ts.isCallExpression(filter) ||
    filter.expression !== method
  )
    return undefined;
  const [predicate] = filter.arguments;
  if (
    !predicate ||
    !ts.isArrowFunction(predicate) ||
    predicate.modifiers?.length ||
    !ts.isCallExpression(predicate.body)
  )
    return undefined;
  const parameter = predicate.parameters[0]?.name;
  const { expression, arguments: args } = predicate.body;
  if (
    !parameter ||
    !ts.isIdentifier(parameter) ||
    !ts.isPropertyAccessExpression(expression) ||
    expression.name.text !== 'endsWith' ||
    args.length !== 1 ||
    !ts.isStringLiteralLike(args[0]) ||
    !/^\.[\w.-]+$/.test(args[0].text)
  )
    return undefined;
  const filename = expression.expression;
  if (!ts.isIdentifier(filename) || filename.text !== parameter.text) return undefined;

  // Filtering JS names can still lead to reads of JSON sidecars, for example.
  // Prove this read uses the filtered name itself before dropping other paths.
  const next = filter.parent;
  if (
    !ts.isPropertyAccessExpression(next) ||
    next.expression !== filter ||
    !['map', 'forEach'].includes(next.name.text) ||
    !ts.isCallExpression(next.parent) ||
    next.parent.expression !== next
  )
    return undefined;
  const [reader] = next.parent.arguments;
  if (!reader || !ts.isArrowFunction(reader) || !ts.isCallExpression(reader.body)) return undefined;
  const file = reader.parameters[0]?.name;
  const read =
    reader.body.expression.getText() === 'JSON.parse' && reader.body.arguments.length === 1
      ? reader.body.arguments[0]
      : reader.body;
  if (
    !file ||
    !ts.isIdentifier(file) ||
    !ts.isCallExpression(read) ||
    !READ.test(memberName(read.expression))
  )
    return undefined;
  const [argument, ...options] = read.arguments;
  return argument &&
    ts.isIdentifier(argument) &&
    argument.text === file.text &&
    options.every(ts.isStringLiteralLike)
    ? args[0].text
    : undefined;
}

const potentiallyRecursive = option =>
  !!option &&
  !ts.isStringLiteralLike(option) &&
  (!ts.isObjectLiteralExpression(option) ||
    option.properties.some(
      property =>
        ts.isSpreadAssignment(property) ||
        ts.isComputedPropertyName(property.name) ||
        (property.name.getText().replace(/^['"]|['"]$/g, '') === 'recursive' &&
          (!ts.isPropertyAssignment(property) || property.initializer.kind !== ts.SyntaxKind.FalseKeyword)),
    ));

function analyse(ast, rootListings) {
  const path = ast.fileName;
  const declarations = new Map();
  const functions = new Map();
  const calls = new Map();
  const sites = [];
  const listingAliases = new Set();
  for (const statement of ast.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !/^(?:node:)?fs(?:\/promises)?$/.test(statement.moduleSpecifier.text)
    )
      continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings))
      for (const item of bindings.elements)
        if (LIST.test(item.propertyName?.text ?? item.name.text)) listingAliases.add(item.name.text);
  }
  const add = (map, name, value) => (map.get(name) ?? map.set(name, []).get(name)).push(value);
  const calleeName = call => memberName(call.expression);
  const visit = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const loop = node.parent?.parent;
      const source =
        loop && (ts.isForOfStatement(loop) || ts.isForInStatement(loop)) && loop.initializer === node.parent
          ? ts.isForOfStatement(loop)
            ? { elementsOf: loop.expression }
            : null
          : node.initializer;
      if (source) add(declarations, node.name.text, source);
    }
    if (ts.isBindingElement(node) && ts.isIdentifier(node.name) && ts.isObjectBindingPattern(node.parent)) {
      const original = node.propertyName ?? node.name;
      if ((ts.isIdentifier(original) || ts.isStringLiteralLike(original)) && LIST.test(original.text))
        listingAliases.add(node.name.text);
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
    if (fn) {
      functions.set(fn.name, fn.node);
      fn.node.parameters.forEach((parameter, index) => {
        if (!ts.isIdentifier(parameter.name)) return;
        add(declarations, parameter.name.text, { parameterOf: fn.name, index });
        if (parameter.initializer) add(declarations, parameter.name.text, parameter.initializer);
      });
    }
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression)) add(calls, node.expression.text, node);
      if (node.arguments.length) sites.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);

  const inside = (node, container) => !!ts.findAncestor(node, item => item === container);
  const recursive = name => {
    const node = functions.get(name);
    return !!node && (calls.get(name) ?? []).some(call => inside(call, node));
  };
  const resolving = new Set();
  /** Folders (relative to the repository root) an expression can name, from alternatives whose every
   * piece is known. Unknown alternatives are dropped, never widened. */
  function bases(node, depth = 0, read = false) {
    const found = new Set();
    if (!node || depth > MAX_DEPTH) return found;
    const merge = more => more.forEach(item => found.add(item));
    const next = child => bases(child, depth + 1, read);
    if (ts.isStringLiteralLike(node)) {
      const folder = folderOf(node.text);
      if (folder !== null) found.add(folder);
    } else if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression?.(node) ||
      ts.isNonNullExpression?.(node)
    )
      merge(next(node.expression));
    else if (ts.isConditionalExpression(node)) {
      merge(next(node.whenTrue));
      merge(next(node.whenFalse));
    } else if (ts.isTemplateExpression(node)) {
      // Only the literal head is known: `src/${name}` reads below src/.
      const head = node.head.text;
      const folder = head.includes('/') ? folderOf(head.slice(0, head.lastIndexOf('/'))) : null;
      if (folder || (folder === '' && read)) found.add(folder);
    } else if (ts.isIdentifier(node)) merge(identifier(node.text, depth + 1, read));
    else if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (node.expression.getText() === 'process.cwd') found.add('');
      else if (UNWRAP.test(name) && node.arguments.length) merge(next(node.arguments[0]));
      else if (BUILD.test(name) && node.arguments.length) {
        // The first piece is the base; literal pieces after it narrow the folder, the first unknown
        // piece ends it (`join(root, name)` reads somewhere below root). A literal piece that leaves
        // the repository (`'../..'`, or an absolute one for `resolve`) drops the alternative.
        for (let base of next(node.arguments[0])) {
          let inside = true;
          for (const piece of node.arguments.slice(1)) {
            if (!ts.isStringLiteralLike(piece)) {
              // A listing somewhere under root does not establish a root listing.
              inside = Boolean(base) || read;
              break;
            }
            const next =
              name === 'resolve' && piece.text.startsWith('/') ? null : joinFolder(base, piece.text);
            if (next === null) {
              inside = false;
              break;
            }
            base = next;
          }
          if (inside) found.add(base);
        }
      }
    } else if (ts.isNewExpression(node) && node.expression.getText() === 'URL') {
      // `new URL('../src', import.meta.url)` resolves against the test file.
      const [relative, against] = node.arguments ?? [];
      if (relative && ts.isStringLiteralLike(relative) && against?.getText() === 'import.meta.url') {
        const folder = folderOf(posix.join(posix.dirname(path), relative.text));
        if (folder !== null) found.add(folder);
      }
    } else if (ts.isPropertyAccessExpression(node)) {
      if (node.getText() === 'import.meta.dirname') found.add(posix.dirname(path));
      else if (node.name.text === 'pathname') merge(next(node.expression));
    } else if (ts.isArrayLiteralExpression(node)) for (const element of node.elements) merge(next(element));
    return found;
  }
  function identifier(name, depth, read) {
    const found = new Set();
    if (resolving.has(name) || depth > MAX_DEPTH) return found;
    resolving.add(name);
    for (const source of declarations.get(name) ?? []) {
      if (source.parameterOf) {
        const owner = functions.get(source.parameterOf);
        // A recursive call passes a path found inside the walk: the walk's start decides the folder.
        for (const call of calls.get(source.parameterOf) ?? [])
          if (!inside(call, owner))
            bases(call.arguments[source.index], depth + 1, read).forEach(item => found.add(item));
      } else if (source.elementsOf) {
        // `for (const dir of ['lib', 'app'])`: each element is an alternative.
        const list = source.elementsOf;
        const elements = ts.isArrayLiteralExpression(list)
          ? list.elements
          : ts.isIdentifier(list)
            ? (declarations.get(list.text) ?? []).flatMap(item =>
                item && !item.parameterOf && !item.elementsOf && ts.isArrayLiteralExpression(item)
                  ? [...item.elements]
                  : [],
              )
            : [];
        for (const element of elements) bases(element, depth + 1, read).forEach(item => found.add(item));
      } else bases(source, depth + 1, read).forEach(item => found.add(item));
    }
    resolving.delete(name);
    return found;
  }

  const scans = [];
  const listing = (name, seen = new Set()) => {
    if (LIST.test(name) || listingAliases.has(name)) return true;
    if (!name || seen.has(name)) return false;
    seen.add(name);
    return (declarations.get(name) ?? []).some(
      item => !item.parameterOf && !item.elementsOf && listing(memberName(item), seen),
    );
  };
  for (const call of sites) {
    const name = calleeName(call);
    const read = READ.test(name);
    if (!read && !listing(name)) continue;
    const enclosing = ts.findAncestor(call.parent, node => ts.isFunctionLike(node));
    const own = enclosing && [...functions].find(([, node]) => node === enclosing)?.[0];
    const walks = !!own && recursive(own);
    // A read counts only inside a walk: one file read by a computed name is not a scan of a folder.
    if (read && !walks) continue;
    const options = call.arguments[1]?.getText() ?? '';
    // An import walk follows code: a Markdown document is never one of its files.
    for (const folder of bases(call.arguments[0], 0, read)) {
      const deep =
        read ||
        walks ||
        /\brecursive\s*:\s*true\b/.test(options) ||
        (folder === '' && potentiallyRecursive(call.arguments[1]));
      const rootListing = !read && deep && folder === '';
      const suffix = rootListing ? listingSuffix(call) : undefined;
      if (rootListing) rootListings?.set(call, suffix);
      if (
        !scans.some(
          item =>
            item.folder === folder &&
            item.recursive === deep &&
            !!item.code === read &&
            item.suffix === suffix,
        )
      )
        scans.push({
          folder,
          recursive: deep,
          ...(read ? { code: true } : {}),
          ...(suffix ? { suffix } : {}),
        });
    }
  }
  return scans;
}

/** Recursive listings of the repository root, keyed by AST site so graph edges
 * can follow the walk through importing helpers as well as standalone tests. */
export function recursiveRootListings(ast) {
  const listings = new Map();
  if (LISTING.test(ast.text) && !/\bprocess\.chdir\s*\(/.test(ast.text)) analyse(ast, listings);
  return listings;
}

const memo = new WeakMap();
/** Test file -> the folders it lists or walks through a plain relative path or a recursive reader
 * ({folder, recursive, code?}; folder '' is the repository root; `code`: an import walk, which never
 * reads a Markdown document). `isTest` is the caller's test-file rule; `skip` names tests already
 * known to scan (the rooted scanner's), which are not parsed again. Memoized per inventory, test rule
 * and skip set. */
export function treeReaders(files, isTest, skip = new Set()) {
  // One entry per inventory, reused only for the same test rule and the same skipped tests.
  const key = [...skip].sort().join('\n');
  const hit = memo.get(files);
  if (hit && hit.isTest === isTest && hit.key === key) return hit.found;
  const found = new Map();
  const folders = repositoryFolders(files);
  for (const [path, text] of files) {
    if (!isTest(path) || skip.has(path) || typeof text !== 'string' || !maybe(text, folders)) continue;
    let scans;
    try {
      scans = analyse(ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS));
    } catch {
      continue; /* An unparseable test is the graph's problem; it fails selection there. */
    }
    if (scans.length) found.set(path, scans);
  }
  memo.set(files, { isTest, key, found });
  return found;
}
