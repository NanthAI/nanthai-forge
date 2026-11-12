// SPDX-License-Identifier: Apache-2.0
import ts from 'typescript';
import { relative } from 'node:path';

// Finite adapters for the existing runtime selectors. These derive names from source
// declarations, never a name allowlist. Unsupported withIndex expressions fail the guard.
export function dynamicIndexUses(c) {
  const uses = [],
    handled = new Set();
  const sourceAt = path => c.sources.find(s => relative(c.root, s.fileName) === path);
  const nodes = (source, predicate) => {
    const out = [];
    function visit(n) {
      if (predicate(n)) out.push(n);
      ts.forEachChild(n, visit);
    }
    if (source) visit(source);
    return out;
  };
  const object = (path, name) => {
    const declaration = nodes(
      sourceAt(path),
      n => ts.isVariableDeclaration(n) && n.name.getText() === name,
    )[0];
    const value = declaration && c.unwrap(declaration.initializer);
    if (!value || !ts.isObjectLiteralExpression(value))
      throw Error(`Unresolved dynamic index registry ${path}:${name}`);
    return value;
  };
  const add = (table, name, call, detail) =>
    uses.push({ table, name, location: `${call.location} (${detail})` });
  for (const call of c.calls.filter(call => !call.tables.length || !call.names.length)) {
    const path = relative(c.root, call.node.getSourceFile().fileName);
    const argument = c.unwrap(call.node.arguments[0]);
    if (path === 'convex/projectPurgeRows.ts' && argument?.getText() === 'purgeIndex(table).index') {
      const selector = sourceAt('convex/projectPurgeInventory.ts');
      const compact = n => n.getText().replace(/\s/g, '');
      if (
        !nodes(
          selector,
          n =>
            ts.isVariableDeclaration(n) &&
            n.name.getText() === 'entry' &&
            n.initializer &&
            compact(n.initializer) === 'projectPurgeTables[table]',
        ).length ||
        !nodes(
          selector,
          n =>
            ts.isReturnStatement(n) &&
            n.expression &&
            compact(n.expression) === "typeofentry==='string'?{index:entry}:entry",
        ).length
      )
        throw Error('Update purge selector analysis');

      for (const property of object('convex/projectPurgeInventory.ts', 'projectPurgeTables').properties) {
        if (!ts.isPropertyAssignment(property)) throw Error('Unresolved purge registry member');
        let value = c.unwrap(property.initializer);
        if (ts.isObjectLiteralExpression(value))
          value = value.properties.find(p => p.name?.getText() === 'index')?.initializer;
        const names = c.strings(value);
        if (names.length !== 1) throw Error('Unresolved purge index');
        add(property.name.text, names[0], call, 'projectPurgeTables');
      }
    } else if (path === 'convex/projectStorageInventory.ts' && argument?.getText() === 'owner.index') {
      // storageOwners selects the first declared index beginning with each typed
      // project/generation owner field. Preserve declaration order exactly.
      const selector = sourceAt('convex/projectStorageOwnership.ts')?.text;
      if (!selector?.includes("definition[' indexes']().find(item => item.fields[0] === field)"))
        throw Error('Update ownership selector analysis');
      for (const definition of c.definitions)
        for (const field of definition.fields) {
          if (
            field.kind !== 'id' ||
            !(
              (field.name === 'projectId' && field.parent === 'hostedProjects') ||
              (['generationId', 'partitionId'].includes(field.name) &&
                field.parent === 'projectWorkGenerations')
            )
          )
            continue;
          const index = definition.indexes.find(i => i.fields[0] === field.name);
          if (!index) throw Error(`Missing owner-first index ${definition.table}.${field.name}`);
          add(definition.table, index.name, call, `owner ${field.name}`);
        }
    } else if (
      path === 'convex/projectFinishReadReader.ts' &&
      argument?.getText() === "index.replace(/^by_/, 'by_kind_and_')"
    ) {
      const projected = call.tables[0];
      const kinds = object('convex/projectFinishReadProjection.ts', 'finishReadFields').properties.map(
        p => p.name.text,
      );
      const bypass = nodes(
        sourceAt(path),
        n =>
          ts.isCallExpression(n) &&
          ts.isPropertyAccessExpression(n.expression) &&
          n.expression.name.text === 'includes' &&
          ts.isArrayLiteralExpression(n.expression.expression),
      ).flatMap(n => n.expression.expression.elements.flatMap(n => c.strings(n)));
      for (const consumer of c.calls)
        for (const table of consumer.tables.filter(t => kinds.includes(t) && !bypass.includes(t)))
          for (const name of consumer.names) {
            const mapped = name.replace(/^by_/, 'by_kind_and_');
            if (c.indexes.some(i => i.table === projected && i.name === mapped))
              add(projected, mapped, call, `proxy ${consumer.location} ${table}.${name}`);
          }
    } else if (
      path === 'convex/projectFinishReadReader.ts' &&
      argument?.getText() === 'index' &&
      call.node.expression.expression.getText() === 'original'
    ) {
      // Legacy fallback uses the same table/index pairs already recorded at callers.
    } else if (path === 'scripts/lib/legacy-storage-bench-query.mjs' && argument?.getText() === 'index') {
      // benchIndexes prefers by_project, otherwise the first declared project-first
      // index (its AST walk visits the chain in reverse and takes the last).
      const selector = sourceAt('scripts/lib/legacy-storage-bench-definition.mjs')?.text;
      if (!selector?.includes("indexes.includes('by_project')") || !selector.includes('indexes.at(-1)'))
        throw Error('Update bench selector analysis');
      for (const definition of c.definitions) {
        const indexes = definition.indexes.filter(i => i.fields[0] === 'projectId');
        const index = indexes.find(i => i.name === 'by_project') ?? indexes[0];
        if (index) add(definition.table, index.name, call, 'benchIndexes project-first selection');
      }
    } else continue;
    handled.add(call.node);
  }
  return { uses, handled };
}

// Scripts serialize read-only sandbox queries as source. Parse the literal query
// fragments too, substituting finite table-array interpolations without executing JS.
export function inlineIndexUses(c) {
  const uses = [],
    unresolved = [];
  for (const source of c.sources) {
    if (!relative(c.root, source.fileName).startsWith('scripts/')) continue;
    function visit(node) {
      if (ts.isStringLiteralLike(node) && node.text.includes('.withIndex(') && node.text.includes('ctx.db'))
        parse(node, node.text);
      if (ts.isTemplateExpression(node)) {
        const text = node.head.text + node.templateSpans.map(s => '__INLINE__' + s.literal.text).join('');
        if (text.includes('.withIndex(') && text.includes('ctx.db')) {
          let tables = [];
          for (const span of node.templateSpans) {
            const expr = span.expression;
            if (
              ts.isCallExpression(expr) &&
              expr.expression.getText() === 'JSON.stringify' &&
              ts.isElementAccessExpression(expr.arguments[0])
            ) {
              const ref = expr.arguments[0].expression;
              tables.push(
                ...c.declarations(ref).flatMap(d => {
                  const array = c.unwrap(d.initializer);
                  return array && ts.isArrayLiteralExpression(array)
                    ? array.elements.flatMap(n => c.strings(n))
                    : [];
                }),
              );
            }
          }
          parse(node, text, tables);
        }
      }
      ts.forEachChild(node, visit);
    }
    function parse(origin, text, tables = []) {
      const embedded = ts.createSourceFile('inline.ts', text, ts.ScriptTarget.Latest, true);
      function walk(n) {
        if (
          ts.isCallExpression(n) &&
          ts.isPropertyAccessExpression(n.expression) &&
          n.expression.name.text === 'withIndex'
        ) {
          const name = n.arguments[0];
          const query = n.expression.expression;
          if (
            name &&
            ts.isStringLiteralLike(name) &&
            ts.isCallExpression(query) &&
            ts.isPropertyAccessExpression(query.expression) &&
            query.expression.name.text === 'query'
          ) {
            const arg = query.arguments[0];
            const targets = arg && ts.isStringLiteralLike(arg) ? [arg.text] : tables;
            if (!targets.length)
              unresolved.push({ location: c.location(origin), text: 'Unresolved inline query table' });
            for (const table of targets)
              uses.push({ table, name: name.text, location: `${c.location(origin)} (inline query)` });
          } else unresolved.push({ location: c.location(origin), text: 'Unresolved inline index query' });
        }
        ts.forEachChild(n, walk);
      }
      walk(embedded);
    }
    visit(source);
  }
  return { uses, unresolved };
}
