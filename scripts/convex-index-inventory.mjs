// SPDX-License-Identifier: Apache-2.0
// Static source analysis only: never import a schema, function, hook or script.
import { readdirSync, readFileSync } from 'node:fs';
import { dynamicIndexUses, inlineIndexUses } from './convex-index-dynamic.mjs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export function indexInventory(root = process.cwd()) {
  const files = [];
  function scan(dir) {
    for (const entry of readdirSync(resolve(root, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory() && entry.name !== '_generated') scan(path);
      else if (entry.isFile() && /\.(ts|mjs)$/.test(path)) files.push(resolve(root, path));
    }
  }
  scan('convex');
  scan('scripts');
  const options = {
    target: ts.ScriptTarget.Latest,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext,
    moduleDetection: ts.ModuleDetectionKind.Force,
    allowJs: true,
    skipLibCheck: true,
    types: [],
    lib: ['lib.es2023.d.ts'],
  };
  // Source query resolution needs local backend declarations and Convex validator
  // types, not the CLI/UI dependency graph imported by unrelated build scripts.
  const host = ts.createCompilerHost(options);
  host.resolveModuleNames = (names, containing) =>
    names.map(name => {
      const found = ts.resolveModuleName(name, containing, options, host).resolvedModule;
      if (!found) return undefined;
      const local = relative(root, found.resolvedFileName);
      if (local.startsWith('src/'))
        return relative(root, containing).startsWith('convex/') ? found : undefined;
      return /^(web|netlify|tests)\//.test(local) ? undefined : found;
    });
  const scriptSources = new Map(
    files.filter(p => relative(root, p).startsWith('scripts/')).map(p => [p, readFileSync(p, 'utf8')]),
  );
  const roots = files.filter(
    p => !scriptSources.has(p) || /with(?:Search)?Index\s*\(/.test(scriptSources.get(p)),
  );
  const program = ts.createProgram(roots, options, host);
  const checker = program.getTypeChecker();
  const sources = files.map(
    path =>
      program.getSourceFile(path) ??
      ts.createSourceFile(path, scriptSources.get(path), ts.ScriptTarget.Latest, true),
  );
  const indexes = [],
    calls = [],
    unresolved = [],
    definitions = [];
  const location = node => {
    const source = node.getSourceFile();
    return `${relative(root, source.fileName)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  };
  const unwrap = node => {
    while (
      node &&
      (ts.isAsExpression(node) ||
        ts.isTypeAssertionExpression(node) ||
        ts.isParenthesizedExpression(node) ||
        ts.isSatisfiesExpression(node))
    )
      node = node.expression;
    return node;
  };
  const declarations = node => {
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return symbol?.declarations ?? [];
  };
  function strings(node, seen = new Set()) {
    node = unwrap(node);
    if (node && seen.has(node)) return [];
    if (node) seen = new Set(seen).add(node);
    if (!node) return [];
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (ts.isConditionalExpression(node))
      return [...new Set([...strings(node.whenTrue, seen), ...strings(node.whenFalse, seen)])];
    if (ts.isIdentifier(node)) {
      const values = declarations(node).flatMap(d => (d.initializer ? strings(d.initializer, seen) : []));
      if (values.length) return [...new Set(values)];
    }
    const type = checker.getTypeAtLocation(node);
    return (type.isUnion() ? type.types : [type]).filter(t => t.isStringLiteral()).map(t => t.value);
  }
  function tables(node, seen = new Set(), bindings = new Map()) {
    node = unwrap(node);
    if (!node || seen.has(node)) return [];
    seen = new Set(seen).add(node);
    if (ts.isIdentifier(node)) {
      if (bindings.has(node.text)) return tables(bindings.get(node.text), seen, bindings);
      return declarations(node).flatMap(d => tables(d.initializer, seen, bindings));
    }
    if (ts.isConditionalExpression(node))
      return [...tables(node.whenTrue, seen, bindings), ...tables(node.whenFalse, seen, bindings)];
    if (!ts.isCallExpression(node)) return [];
    const fn = node.expression;
    if (ts.isPropertyAccessExpression(fn)) {
      if (fn.name.text === 'query') {
        const argument = unwrap(node.arguments[0]);
        return strings(
          ts.isIdentifier(argument) && bindings.has(argument.text) ? bindings.get(argument.text) : argument,
        );
      }
      return tables(fn.expression, seen, bindings);
    }
    return declarations(fn).flatMap(d => {
      const f = d.initializer ?? d;
      if (!(ts.isArrowFunction(f) || ts.isFunctionDeclaration(f) || ts.isFunctionExpression(f))) return [];
      const bound = new Map(bindings);
      f.parameters.forEach((p, i) => bound.set(p.name.getText(), node.arguments[i]));
      if (!ts.isBlock(f.body)) return tables(f.body, seen, bound);
      return f.body.statements.filter(ts.isReturnStatement).flatMap(s => tables(s.expression, seen, bound));
    });
  }
  function walk(node) {
    if (ts.isPropertyAssignment(node)) {
      let call = unwrap(node.initializer);
      const found = [];
      while (call && ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression)) {
        if (['index', 'searchIndex'].includes(call.expression.name.text)) {
          const name = strings(call.arguments[0]);
          const kind = call.expression.name.text === 'searchIndex' ? 'search' : 'database';
          let fields = unwrap(call.arguments[1]);
          if (kind === 'search' && fields && ts.isObjectLiteralExpression(fields)) {
            const search = fields.properties.find(p => p.name?.getText() === 'searchField')?.initializer;
            const filters = fields.properties.find(p => p.name?.getText() === 'filterFields')?.initializer;
            fields = ts.factory.createArrayLiteralExpression([search, ...(filters?.elements ?? [])]);
          }
          if (name.length !== 1 || !ts.isArrayLiteralExpression(fields))
            throw Error(`${location(call)}: unresolved index definition`);
          const names = fields.elements.map(n => strings(n));
          if (names.some(n => n.length !== 1)) throw Error(`${location(call)}: unresolved index fields`);
          const before = call
            .getSourceFile()
            .text.slice(call.expression.expression.end, call.expression.name.getStart());
          found.unshift({
            table: node.name.text,
            kind,
            name: name[0],
            fields: names.flat(),
            location: location(call.expression.name),
            reason: before.match(/index-order:\s*([^\n]+)/)?.[1]?.trim() ?? '',
            uses: [],
          });
        }
        call = unwrap(call.expression.expression);
      }
      if (call && ts.isCallExpression(call) && call.expression.getText() === 'defineTable') {
        indexes.push(...found);
        const fields = checker
          .getTypeAtLocation(call.arguments[0])
          .getProperties()
          .map(p => {
            const type = checker.getTypeOfSymbolAtLocation(p, call.arguments[0]);
            const parent = type.getProperty('tableName');
            const kind = type.getProperty('kind');
            return {
              name: p.name,
              parent: parent
                ? checker
                    .typeToString(checker.getTypeOfSymbolAtLocation(parent, call.arguments[0]))
                    .replaceAll('"', '')
                : null,
              kind: kind
                ? checker
                    .typeToString(checker.getTypeOfSymbolAtLocation(kind, call.arguments[0]))
                    .replaceAll('"', '')
                : null,
            };
          });
        definitions.push({ table: node.name.text, fields, indexes: found });
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ['withIndex', 'withSearchIndex'].includes(node.expression.name.text)
    ) {
      const call = {
        kind: node.expression.name.text === 'withSearchIndex' ? 'search' : 'database',
        tables: [...new Set(tables(node.expression.expression))],
        names: strings(node.arguments[0]),
        location: location(node),
        text: node.getText(),
        node,
      };
      calls.push(call);
    }
    ts.forEachChild(node, walk);
  }
  sources.forEach(walk);
  const context = { root, sources, indexes, calls, definitions, strings, declarations, unwrap, location };
  const dynamic = dynamicIndexUses(context);
  const inline = inlineIndexUses(context);
  const addUse = (table, name, at) => {
    const index = indexes.find(i => i.table === table && i.name === name);
    if (index) index.uses.push(at);
    else if (!['by_id', 'by_creation_time'].includes(name))
      unresolved.push({ location: at, text: `Missing ${table}.${name}` });
  };
  for (const use of [...dynamic.uses, ...inline.uses]) addUse(use.table, use.name, use.location);
  unresolved.push(...inline.unresolved);
  for (const call of calls) {
    if (dynamic.handled.has(call.node)) continue;
    if (!call.tables.length || !call.names.length)
      unresolved.push({ location: call.location, tables: call.tables, names: call.names, text: call.text });
    else
      for (const table of call.tables)
        for (const name of call.names) {
          const index = indexes.find(i => i.table === table && i.name === name);
          if (index) index.uses.push(call.location);
          else if (!['by_id', 'by_creation_time'].includes(name))
            unresolved.push({ ...call, node: undefined, text: `Missing ${table}.${name}` });
        }
  }
  for (const index of indexes) {
    index.prefixOf = indexes
      .filter(
        i =>
          i.kind === 'database' &&
          index.kind === 'database' &&
          i.table === index.table &&
          i.fields.length > index.fields.length &&
          index.fields.every((f, n) => i.fields[n] === f),
      )
      .map(i => i.name);
    index.classification = !index.uses.length
      ? 'unused'
      : index.prefixOf.length
        ? 'prefix-redundant'
        : 'used';
    index.uses = [...new Set(index.uses)].sort();
  }
  return {
    indexes,
    tables: definitions.map(d => d.table).sort(),
    unresolved,
    queries: calls.map(({ node, ...call }) => {
      let end = node;
      while (
        end.parent &&
        ((ts.isPropertyAccessExpression(end.parent) && end.parent.expression === end) ||
          (ts.isCallExpression(end.parent) && end.parent.expression === end))
      )
        end = end.parent;
      return { ...call, text: end.getText() };
    }),
    dynamicUses: dynamic.uses,
    inlineUses: inline.uses,
  };
}

export function indexIssues(inventory) {
  const issues = inventory.unresolved.map(u => `${u.location}: ${u.text}`);
  for (const index of inventory.indexes) {
    if (!index.uses.length) issues.push(`${index.location}: unused ${index.table}.${index.name}`);
    if (index.prefixOf.length && index.reason.length < 20)
      issues.push(
        `${index.location}: ${index.table}.${index.name} prefixes ${index.prefixOf.join(', ')}; record an index-order: reason next to its definition`,
      );
  }
  return issues;
}

// Reporting entry point only; enforcement stays in the existing Convex schema test.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(indexInventory(), null, 2));
