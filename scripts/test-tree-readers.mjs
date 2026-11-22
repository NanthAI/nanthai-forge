// SPDX-License-Identifier: Apache-2.0
// Recognize repository paths consumed by a directory listing, glob, recursive reader or callback.
// Paths can be relative to the test process's working directory or to the source via import.meta.
// Package file lists come from the source inventory. The analysis does no I/O and runs no test code.
import ts from 'typescript';
import { posix } from 'node:path';

const LIST = /^(?:readdir|readdirSync|opendir|opendirSync)$/;
const GLOB = /^(?:glob|globSync)$/;
const ELEMENT_CALLBACKS = new Set(['every', 'filter', 'find', 'flatMap', 'forEach', 'map', 'some']);
const READ = /^(?:readFile|readFileSync)$/;
const BUILD = /^(?:join|resolve|normalize)$/;
const UNWRAP = /^(?:fileURLToPath)$/;
// Cheap text filters, so only a few files are parsed: a listing call, or a read of a computed path
// inside a function whose own body calls it (a walk); and a quoted piece naming a folder of the
// repository (or `import.meta` / `process.cwd()`), since an unknown base never counts.
const LISTING = /\b(?:readdir|readdirSync|opendir|opendirSync)\b/;
const GLOBBING = /\b(?:glob|globSync)\b/;
const READING = /\breadFile(?:Sync)?\b/;
const CALLBACK = /\.(?:every|filter|find|flatMap|forEach|map|some)\s*\(/;
const ITERATION = /\bfor\s*(?:await\s*)?\([^)]*\bof\b/;
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
    if (folder !== null && (folders.has(folder) || folders.has(posix.dirname(folder)))) return true;
  }
  return false;
};
const mentionsManifestFiles = text =>
  text.includes('package.json') && /\.files\b|\bfiles\s*[:},]|\[\s*['"]files['"]\s*\]/.test(text);
const maybe = (text, folders) =>
  !/\bprocess\.chdir\s*\(/.test(text) &&
  (GLOBBING.test(text) ||
    mentionsManifestFiles(text) ||
    ((LISTING.test(text) ||
      (READING.test(text) && (CALLBACK.test(text) || ITERATION.test(text) || walksInText(text)))) &&
      namesFolder(text, folders)));

/** A literal path relative to the repository root, or null when it leaves it or is absolute. */
const folderOf = text => {
  if (!text || text.startsWith('/') || /^[a-z]+:/i.test(text) || /[*?{[\\]/.test(text)) return null;
  const normal = posix.normalize(text).replace(/\/+$/, '');
  if (normal === '.' || normal === '') return '';
  return normal === '..' || normal.startsWith('../') ? null : normal;
};
const joinFolder = (base, piece) => folderOf(posix.join(base, piece));
const entryFolder = entry => {
  const literal = entry.split(/[*?{[(]/, 1)[0];
  const slash = literal.lastIndexOf('/');
  return slash >= 0 ? literal.slice(0, slash) : '';
};

const memberName = expression =>
  ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression)
    ? (ts.isIdentifier(expression) ? expression : expression.name).text
    : ts.isElementAccessExpression(expression) && ts.isStringLiteralLike(expression.argumentExpression)
      ? expression.argumentExpression.text
      : '';

// Bind in-memory sources only. There is no dependency resolution or standard-library read.
function treeChecker(sources) {
  return ts
    .createProgram(
      [...sources.keys()],
      { allowJs: true, noLib: true, noResolve: true, types: [] },
      {
        getSourceFile: name => sources.get(name),
        getDefaultLibFileName: () => '',
        getCurrentDirectory: () => '',
        getDirectories: () => [],
        fileExists: () => false,
        readFile: () => undefined,
        getCanonicalFileName: name => name,
        useCaseSensitiveFileNames: () => true,
        getNewLine: () => '\n',
        writeFile() {},
      },
    )
    .getTypeChecker();
}

function treeBinding(ast, checker) {
  return node => {
    if (!node || !ts.isIdentifier(node)) return undefined;
    checker ??= treeChecker(new Map([[ast.fileName, ast]]));
    const symbol =
      ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : checker.getSymbolAtLocation(node);
    return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  };
}

const containing = (node, predicate) => ts.findAncestor(node.parent, predicate);
const inside = (node, container) => !!containing(node, item => item === container);

// Only narrow when a literal suffix filter feeds unchanged paths to a file read.
// Any other use, predicate or additional scan keeps its own conservative coverage.
function listingSuffix(call) {
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

function analyse(ast, rootListings, manifestFiles, checker) {
  const path = ast.fileName;
  const binding = treeBinding(ast, checker);
  const declarations = new Map();
  const calls = new Map();
  const functions = new Map();
  const owners = new Map();
  const aliases = new Map();
  const sites = [];
  const collections = [];
  const add = (map, key, item) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  };
  const sourceOf = call =>
    ts.isPropertyAccessExpression(call.expression) && ELEMENT_CALLBACKS.has(call.expression.name.text)
      ? call.expression.expression
      : undefined;
  const visit = node => {
    if (ts.isImportSpecifier(node) || ts.isBindingElement(node)) {
      const name = memberName(node.name);
      const imported = memberName(node.propertyName ?? node.name);
      if (name && imported) add(aliases, name, imported);
    }
    if (ts.isVariableDeclaration(node)) {
      if (ts.isIdentifier(node.name) && node.initializer) {
        const alias = memberName(node.initializer);
        if (alias) add(aliases, node.name.text, alias);
      }
      const loop = node.parent.parent;
      if (ts.isForOfStatement(loop) && loop.initializer === node.parent) {
        add(declarations, node, { elementsOf: loop.expression });
        const condition =
          ts.isIfStatement(loop.statement) && !loop.statement.elseStatement
            ? prefixFilter(loop.statement.expression, node)
            : '';
        collections.push({ source: loop.expression, prefix: condition });
      } else if (node.initializer) add(declarations, node, node.initializer);
    }
    if (ts.isFunctionLike(node)) {
      const parent = node.parent;
      const owner = ts.isFunctionDeclaration(node)
        ? node
        : ts.isVariableDeclaration(parent) && parent.initializer === node
          ? parent
          : undefined;
      if (owner) {
        functions.set(owner, node);
        owners.set(node, owner);
      }
      const callback = ts.isCallExpression(parent) && parent.arguments[0] === node && sourceOf(parent);
      if (callback && parent.expression.name.text !== 'filter') collections.push({ source: callback });
      node.parameters.forEach((parameter, index) => {
        if (owner) add(declarations, parameter, { parameterOf: owner, index });
        if (index === 0 && callback) add(declarations, parameter, { elementsOf: callback });
        if (parameter.initializer) add(declarations, parameter, parameter.initializer);
      });
    }
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression)) add(calls, node.expression.text, node);
      if (node.arguments.length) sites.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);

  const callsByBinding = new Map();
  function callsTo(declaration) {
    if (!callsByBinding.has(declaration)) {
      const name = declaration.name;
      callsByBinding.set(
        declaration,
        name && ts.isIdentifier(name)
          ? (calls.get(name.text) ?? []).filter(call => binding(call.expression) === declaration)
          : [],
      );
    }
    return callsByBinding.get(declaration);
  }
  const walking = new Map();
  const isWalking = node => {
    const owner = owners.get(node);
    if (!owner) return false;
    if (!walking.has(owner))
      walking.set(
        owner,
        callsTo(owner).some(call => inside(call, node)),
      );
    return walking.get(owner);
  };
  const readerKinds = /^(?:readFile(?:Sync)?|readdir(?:Sync)?|opendir(?:Sync)?|glob(?:Sync)?)$/;
  function candidateName(name, seen = new Set()) {
    if (readerKinds.test(name)) return name;
    if (!name || seen.has(name)) return undefined;
    seen.add(name);
    for (const alias of aliases.get(name) ?? []) {
      const candidate = candidateName(alias, seen);
      if (candidate) return candidate;
    }
    return undefined;
  }
  const nameOf = (expression, seen = new Set()) => {
    if (!ts.isIdentifier(expression)) return memberName(expression);
    const declared = binding(expression);
    if (!declared) return expression.text;
    if (seen.has(declared)) return '';
    seen.add(declared);
    if (ts.isImportSpecifier(declared)) return (declared.propertyName ?? declared.name).text;
    if (ts.isBindingElement(declared) && ts.isObjectBindingPattern(declared.parent))
      return memberName(declared.propertyName ?? declared.name);
    if (ts.isVariableDeclaration(declared) && declared.initializer) return nameOf(declared.initializer, seen);
    return '';
  };
  const isGlobal = (node, name) => ts.isIdentifier(node) && node.text === name && !binding(node);
  const resolving = new Set();
  /** Repository-relative paths, with a trailing slash used only for an unresolved suffix. */
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
      ts.isAwaitExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isNonNullExpression(node)
    ) {
      merge(next(node.expression));
    } else if (ts.isConditionalExpression(node)) {
      merge(next(node.whenTrue));
      merge(next(node.whenFalse));
    } else if (ts.isTemplateExpression(node)) {
      merge(templatePaths(node, next, '', read === 'walk'));
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      ts.isStringLiteralLike(node.left) &&
      node.left.text.includes('/')
    ) {
      const prefix = node.left.text;
      const folder = folderOf(prefix.slice(0, prefix.lastIndexOf('/') + 1));
      if (folder !== null) found.add(folder + '/');
    } else if (ts.isIdentifier(node)) {
      merge(identifier(binding(node), depth + 1, read));
    } else if (ts.isCallExpression(node)) {
      const name = nameOf(node.expression);
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'cwd' &&
        isGlobal(node.expression.expression, 'process')
      )
        found.add('');
      else if (sourceOf(node) && node.expression.name.text === 'filter') merge(next(sourceOf(node)));
      else if (sourceOf(node) && node.expression.name.text === 'map') {
        const fn = node.arguments[0];
        if (fn && ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) merge(next(fn.body));
      } else if (UNWRAP.test(name) && node.arguments.length) merge(next(node.arguments[0]));
      else if (BUILD.test(name) && node.arguments.length) {
        merge(joinPaths(next(node.arguments[0]), node.arguments.slice(1), next, name, read));
      } else {
        const fn = functions.get(binding(node.expression));
        if (fn?.body && ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) merge(next(fn.body));
      }
    } else if (
      ts.isNewExpression(node) &&
      (isGlobal(node.expression, 'URL') || nameOf(node.expression) === 'URL')
    ) {
      const [relative, against] = node.arguments ?? [];
      if (relative && against) {
        const origin = dereference(against);
        const roots =
          origin?.getText() === 'import.meta.url'
            ? [posix.dirname(path)]
            : origin &&
                ts.isNewExpression(origin) &&
                origin.arguments?.[0] &&
                ts.isStringLiteralLike(origin.arguments[0]) &&
                origin.arguments[0].text.endsWith('/')
              ? next(origin)
              : [];
        for (const root of roots) {
          if (ts.isTemplateExpression(relative)) {
            merge(templatePaths(relative, next, root, read === 'walk'));
          } else if (
            ts.isBinaryExpression(relative) &&
            relative.operatorToken.kind === ts.SyntaxKind.PlusToken &&
            ts.isStringLiteralLike(relative.left)
          ) {
            merge(relativeSuffix(root, relative.left.text, next(relative.right), read === 'walk'));
          } else {
            const literal = ts.isStringLiteralLike(relative);
            for (const target of literal ? [relative.text] : next(relative)) {
              if (target.startsWith('/') || /^[a-z]+:/i.test(target)) continue;
              const folder = joinFolder(root, target);
              if (folder !== null) found.add(target.endsWith('/') && !literal ? folder + '/' : folder);
            }
          }
        }
      }
    } else if (ts.isPropertyAccessExpression(node)) {
      if (node.getText() === 'import.meta.dirname') found.add(posix.dirname(path));
      else if (node.name.text === 'pathname') merge(next(node.expression));
    } else if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) merge(next(element));
    }
    return found;
  }

  function relativeSuffix(root, prefix, suffixes, keepRoot) {
    if (prefix.startsWith('/') || /^[a-z]+:/i.test(prefix)) return [];
    if (!suffixes.size || [...suffixes].some(value => value.endsWith('/'))) {
      const slash = prefix.lastIndexOf('/');
      const folder = slash >= 0 ? joinFolder(root, prefix.slice(0, slash + 1)) : null;
      return folder === null || (!folder && !keepRoot) ? [] : [folder + '/'];
    }
    return [...suffixes].map(suffix => joinFolder(root, prefix + suffix)).filter(value => value !== null);
  }

  function templatePaths(node, values, base, keepRoot) {
    if (/^(?:\/|[a-z]+:)/i.test(node.head.text)) return [];
    let prefixes = [node.head.text];
    let partial = false;
    for (const { expression, literal } of node.templateSpans) {
      const alternatives = [...values(expression)];
      if (!alternatives.length || alternatives.some(value => value.endsWith('/'))) {
        partial = true;
        break;
      }
      prefixes = prefixes.flatMap(prefix => alternatives.map(value => prefix + value + literal.text));
    }
    return prefixes.flatMap(prefix => {
      const slash = prefix.lastIndexOf('/');
      if (partial && slash < 0) return [];
      const folder = joinFolder(base, partial ? prefix.slice(0, slash + 1) : prefix);
      return folder === null || (partial && !folder && !keepRoot) ? [] : [partial ? folder + '/' : folder];
    });
  }

  function joinPaths(paths, pieces, values, name, read) {
    for (const piece of pieces) {
      // Keep the containing folder after the first unknown piece. A later literal may still
      // escape that folder, so retain repository-root coverage if it climbs out of it.
      const targets = ts.isStringLiteralLike(piece)
        ? [piece.text]
        : read === 'walk' && name === 'resolve'
          ? []
          : [...values(piece)];
      const combined = new Set();
      for (const base of paths) {
        if (base.endsWith('/')) {
          const parent = targets.some(target => target.includes('..')) ? '/' : base;
          combined.add(parent);
          continue;
        }
        if (!targets.length) {
          if (base || read === 'walk') combined.add(base + '/');
          continue;
        }
        for (const target of targets) {
          if (name === 'resolve' && ts.isStringLiteralLike(piece) && target.startsWith('/')) continue;
          const partial = !ts.isStringLiteralLike(piece) && target.endsWith('/');
          const folder = joinFolder(base, partial ? target.slice(0, -1) : target);
          if (folder !== null) combined.add(partial ? folder + '/' : folder);
        }
      }
      paths = combined;
    }
    return paths;
  }
  function identifier(declaration, depth, read) {
    const found = new Set();
    if (!declaration || resolving.has(declaration) || depth > MAX_DEPTH) return found;
    resolving.add(declaration);
    for (const source of declarations.get(declaration) ?? []) {
      if (source.parameterOf) {
        const owner = functions.get(source.parameterOf);
        // Recursive calls pass a path found inside the walk: the walk's start decides the folder.
        for (const call of callsTo(source.parameterOf))
          if (!inside(call, owner))
            bases(call.arguments[source.index], depth + 1, read).forEach(item => found.add(item));
      } else {
        bases(source.elementsOf ?? source, depth + 1, read).forEach(item => found.add(item));
      }
    }
    resolving.delete(declaration);
    return found;
  }

  // Follow immutable aliases to their syntactic value. Loop and callback inputs are handled above.
  function dereference(node, depth = 0) {
    if (!node || depth > MAX_DEPTH) return node;
    if (ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node))
      return dereference(node.expression, depth + 1);
    if (!ts.isIdentifier(node)) return node;
    const declared = binding(node);
    return declared &&
      ts.isVariableDeclaration(declared) &&
      declared.initializer &&
      declared.parent.flags & ts.NodeFlags.Const
      ? dereference(declared.initializer, depth + 1)
      : node;
  }

  function prefixFilter(node, declaration) {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
      return prefixFilter(node.left, declaration) || prefixFilter(node.right, declaration);
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return '';
    const { expression, name } = node.expression;
    const [argument] = node.arguments;
    if (
      name.text === 'startsWith' &&
      binding(expression) === declaration &&
      argument &&
      ts.isStringLiteralLike(argument)
    )
      return argument.text;
    if (
      name.text === 'test' &&
      argument &&
      binding(argument) === declaration &&
      ts.isRegularExpressionLiteral(expression)
    ) {
      // Take only a literal anchored folder and no alternative or flag. Never evaluate the predicate.
      return /^\/\^((?:[\w.-]+\\\/)+)[^|?]*\$\/$/.exec(expression.text)?.[1]?.replaceAll('\\/', '/') ?? '';
    }
    return '';
  }

  function manifestList(node, depth = 0, prefix = '') {
    const value = dereference(node);
    if (!value || depth > MAX_DEPTH) return [];
    if (ts.isCallExpression(value) && sourceOf(value) && value.expression.name.text === 'filter') {
      const [predicate] = value.arguments;
      const restricted =
        predicate &&
        ts.isArrowFunction(predicate) &&
        !ts.isBlock(predicate.body) &&
        prefixFilter(predicate.body, predicate.parameters[0]);
      return manifestList(sourceOf(value), depth + 1, prefix || restricted || '');
    }
    if (ts.isIdentifier(value)) {
      const declared = binding(value);
      const passed = (declarations.get(declared) ?? []).flatMap(source =>
        source.parameterOf
          ? callsTo(source.parameterOf)
              .filter(call => !inside(call, functions.get(source.parameterOf)))
              .flatMap(call => manifestList(call.arguments[source.index], depth + 1, prefix))
          : [],
      );
      if (passed.length) return passed;
      if (
        declared &&
        ts.isBindingElement(declared) &&
        ts.isObjectBindingPattern(declared.parent) &&
        memberName(declared.propertyName ?? declared.name) === 'files' &&
        ts.isVariableDeclaration(declared.parent.parent)
      )
        return packageManifests(declared.parent.parent.initializer).map(manifest => ({ manifest, prefix }));
    }
    if (
      (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) &&
      memberName(value) === 'files'
    )
      return packageManifests(value.expression).map(manifest => ({ manifest, prefix }));
    return [];
  }
  function packageManifests(node) {
    const value = dereference(node);
    if (!value) return [];
    if (ts.isIdentifier(value)) {
      const declared = binding(value);
      if (declared && ts.isImportClause(declared) && ts.isStringLiteralLike(declared.parent.moduleSpecifier))
        return [folderOf(posix.join(posix.dirname(path), declared.parent.moduleSpecifier.text))];
    }
    if (!ts.isCallExpression(value) || value.expression.getText() !== 'JSON.parse') return [];
    const read = dereference(value.arguments[0]);
    return read && ts.isCallExpression(read) && READ.test(nameOf(read.expression))
      ? [...bases(read.arguments[0])]
      : [];
  }

  function globScopes(call) {
    const option = dereference(call.arguments[1]);
    const cwd =
      option &&
      ts.isObjectLiteralExpression(option) &&
      option.properties.find(property => property.name?.getText().replace(/^['"]|['"]$/g, '') === 'cwd');
    const roots =
      !option ||
      (ts.isObjectLiteralExpression(option) &&
        !cwd &&
        !option.properties.some(
          property => ts.isSpreadAssignment(property) || ts.isComputedPropertyName(property.name),
        ))
        ? ['']
        : cwd && ts.isPropertyAssignment(cwd)
          ? [...bases(cwd.initializer)]
          : cwd && ts.isShorthandPropertyAssignment(cwd)
            ? [...identifier(binding(cwd.name), 0, false)]
            : [];
    const pattern = dereference(call.arguments[0]);
    const patterns = pattern && ts.isArrayLiteralExpression(pattern) ? [...pattern.elements] : [pattern];
    return patterns.flatMap(part => {
      part = dereference(part);
      if (!part || !(ts.isStringLiteralLike(part) || ts.isTemplateExpression(part))) return [];
      const text = ts.isTemplateExpression(part) ? part.head.text + '**' : part.text;
      if (/^(?:\/|[a-z]+:)/i.test(text)) return [];
      const wildcard = text.search(/[*?{[(]/);
      if (wildcard < 0)
        return roots.flatMap(root => {
          const file = joinFolder(root, text);
          return file === null ? [] : [{ folder: entryFolder(file), entry: file, recursive: true }];
        });
      const slash = text.lastIndexOf('/', wildcard);
      return roots.flatMap(root => {
        const folder = slash < 0 ? root : joinFolder(root, text.slice(0, slash));
        return folder === null
          ? []
          : [{ folder, recursive: text.slice(slash + 1).includes('/') || text.includes('**') }];
      });
    });
  }

  const scans = new Map();
  const addScan = scan => scans.set(JSON.stringify(scan), scan);
  for (const call of sites) {
    const rawName = memberName(call.expression);
    if (!candidateName(rawName)) continue;
    if (
      READ.test(rawName) &&
      !aliases.has(rawName) &&
      !containing(
        call,
        node =>
          owners.has(node) ||
          ts.isForOfStatement(node) ||
          (ts.isFunctionLike(node) && ts.isCallExpression(node.parent) && sourceOf(node.parent)),
      )
    )
      continue;
    const name = nameOf(call.expression);
    if (!rootListings && GLOB.test(name) && call.expression.getText() !== 'import.meta.glob') {
      for (const scan of globScopes(call)) addScan(scan);
      const option = call.arguments[1];
      if (!option && manifestFiles) recordManifest(call.arguments[0]);
      continue;
    }
    const read = READ.test(name);
    if (!read && !LIST.test(name)) continue;
    const walks = !!containing(call, isWalking);
    const callback = containing(
      call,
      node =>
        ts.isFunctionLike(node) &&
        ts.isCallExpression(node.parent) &&
        node.parent.arguments[0] === node &&
        sourceOf(node.parent),
    );
    // One computed read isn't a scan unless it takes its path from a repeated read or enumeration.
    if (read && !walks) {
      const loop = containing(call, ts.isForOfStatement);
      const parameter = callback?.parameters[0];
      const source = loop && dereference(loop.expression);
      const declaration =
        source &&
        ts.isArrayLiteralExpression(source) &&
        ts.isVariableDeclarationList(loop.initializer) &&
        loop.initializer.declarations[0];
      if (
        !(
          (parameter && readsEach(call.arguments[0], parameter)) ||
          (declaration && readsEach(call.arguments[0], declaration))
        )
      )
        continue;
    }
    const options = call.arguments[1]?.getText() ?? '';
    for (const path of bases(call.arguments[0], 0, read && walks ? 'walk' : false)) {
      const partial = path.endsWith('/');
      const folder = partial ? path.slice(0, -1) : path;
      if (read && !walks && !partial) {
        if (folder) addScan({ folder: '', file: folder, recursive: false });
        continue;
      }
      const deep =
        partial ||
        read ||
        walks ||
        /\brecursive\s*:\s*true\b/.test(options) ||
        (folder === '' && potentiallyRecursive(call.arguments[1]));
      const rootListing = !read && !partial && deep && folder === '';
      const suffix = rootListing ? listingSuffix(call) : undefined;
      if (rootListing) rootListings?.set(call, suffix);
      addScan({
        folder,
        recursive: deep,
        ...(read && walks ? { code: true } : {}),
        ...(suffix ? { suffix } : {}),
      });
    }
  }
  if (manifestFiles) for (const { source, prefix } of collections) recordManifest(source, prefix);

  function recordManifest(source, prefix) {
    for (const item of manifestList(source, 0, prefix))
      for (const { entry, folder } of manifestFiles(item.manifest))
        addScan({ folder, entry, ...item, recursive: true });
  }

  function readsEach(node, parameter, depth = 0) {
    if (!node || depth > MAX_DEPTH || ts.isFunctionLike(node)) return false;
    if (ts.isIdentifier(node)) {
      const declared = binding(node);
      if (declared === parameter) return true;
      return (
        declared &&
        ts.isVariableDeclaration(declared) &&
        readsEach(declared.initializer, parameter, depth + 1)
      );
    }
    return ts.forEachChild(node, child => readsEach(child, parameter, depth + 1) || undefined) === true;
  }
  return [...scans.values()];
}

/** Recursive listings of the repository root, keyed by AST site so graph edges
 * can follow the walk through importing helpers as well as standalone tests. */
export function recursiveRootListings(ast) {
  const listings = new Map();
  if (LISTING.test(ast.text) && !/\bprocess\.chdir\s*\(/.test(ast.text)) analyse(ast, listings);
  return listings;
}

const memo = new WeakMap();
/** Test file -> the scopes it reads. Folder '' is the repository root. A `code` scope is an import
 * walk and excludes Markdown; a `file` or `entry` scope covers individual paths. Memoized per
 * inventory, test rule and skip set. */
export function treeReaders(files, isTest, skip = new Set()) {
  // One entry per inventory, reused only for the same test rule and the same skipped tests.
  const key = [...skip].sort().join('\n');
  const hit = memo.get(files);
  if (hit && hit.isTest === isTest && hit.key === key) return hit.found;
  const found = new Map();
  const folders = repositoryFolders(files);
  const manifests = new Map();
  const manifestFiles = path => {
    if (!path || posix.basename(path) !== 'package.json' || !files.has(path)) return [];
    if (!manifests.has(path)) {
      let entries = [];
      try {
        const names = JSON.parse(files.get(path)).files;
        if (Array.isArray(names))
          entries = names
            .map(name =>
              typeof name === 'string' && name && !name.startsWith('!')
                ? !name.startsWith('/') && !name.includes('\\') && !name.split('/').includes('..')
                  ? posix.join(posix.dirname(path), name).replace(/\/+$/, '')
                  : null
                : null,
            )
            .filter(Boolean)
            .map(entry => ({ entry, folder: folders.has(entry) ? entry : entryFolder(entry) }));
      } catch {
        // The manifest's own check reports invalid JSON.
      }
      manifests.set(path, entries);
    }
    return manifests.get(path);
  };
  const sources = new Map();
  for (const [path, text] of files) {
    if (!isTest(path) || skip.has(path) || typeof text !== 'string' || !maybe(text, folders)) continue;
    // Each test runs as its own module even when the inventory text has no import or export.
    sources.set(
      path,
      ts.createSourceFile(
        path,
        text,
        {
          languageVersion: ts.ScriptTarget.Latest,
          jsDocParsingMode: ts.JSDocParsingMode.ParseNone,
          setExternalModuleIndicator: file => {
            file.externalModuleIndicator = file;
          },
        },
        true,
        ts.ScriptKind.JS,
      ),
    );
  }
  const checker = sources.size ? treeChecker(sources) : undefined;
  for (const [path, ast] of sources) {
    let scans;
    try {
      scans = analyse(ast, undefined, mentionsManifestFiles(ast.text) ? manifestFiles : undefined, checker);
    } catch {
      continue; /* An unparseable test is the graph's problem; it fails selection there. */
    }
    if (scans.length) found.set(path, scans);
  }
  memo.set(files, { isTest, key, found });
  return found;
}
