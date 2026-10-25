// SPDX-License-Identifier: Apache-2.0
// Interpret only Zod declarations. Never import project modules or execute their code.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';
import { z } from 'zod';

export const sharedSchemaFiles = ['src/work-types.ts', 'src/work-unified-types.ts'];
const constructors = new Set([
  'object',
  'strictObject',
  'looseObject',
  'string',
  'number',
  'boolean',
  'unknown',
  'any',
  'never',
  'null',
  'undefined',
  'literal',
  'enum',
  'nativeEnum',
  'array',
  'tuple',
  'record',
  'union',
  'discriminatedUnion',
  'intersection',
  'uuid',
  'url',
  'email',
  'hash',
  'stringbool',
]);
const methods = new Set([
  'optional',
  'nullable',
  'nullish',
  'array',
  'or',
  'and',
  'extend',
  'pick',
  'omit',
  'partial',
  'required',
  'safeExtend',
  'passthrough',
  'strict',
  'strip',
  'catchall',
  'min',
  'max',
  'length',
  'nonempty',
  'int',
  'safe',
  'finite',
  'nonnegative',
  'positive',
  'nonpositive',
  'negative',
  'gt',
  'gte',
  'lt',
  'lte',
  'multipleOf',
  'regex',
  'uuid',
  'url',
  'email',
  'datetime',
  'date',
  'trim',
  'toLowerCase',
  'toUpperCase',
  'readonly',
  'describe',
]);

export function generateSnapshot(root, files = sharedSchemaFiles, version) {
  const modules = new Map(),
    cache = new Map(),
    visiting = new Set();
  function fail(node, message) {
    const source = node.getSourceFile();
    const { line } = source.getLineAndCharacterOfPosition(node.getStart());
    throw new Error(`${source.fileName}:${line + 1}: ${message}`);
  }
  function moduleAt(path) {
    if (modules.has(path)) return modules.get(path);
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    const bindings = new Map(),
      exports = new Map();
    const result = { bindings, exports };
    modules.set(path, result);
    const dependency = specifier => {
      if (specifier === 'zod') return { zod: true };
      if (!specifier.startsWith('.')) throw new Error(`Unsupported schema import: ${specifier}`);
      const base = resolve(dirname(path), specifier);
      const found = [base.replace(/\.js$/, '.ts'), base, `${base}.ts`, `${base}.js`].find(existsSync);
      if (!found) throw new Error(`Missing schema import: ${specifier}`);
      return moduleAt(found);
    };
    for (const statement of source.statements) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
          const get = () => evaluate(declaration.initializer, result);
          bindings.set(declaration.name.text, get);
          if (statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword))
            exports.set(declaration.name.text, get);
        }
      } else if (ts.isImportDeclaration(statement)) {
        const clause = statement.importClause;
        if (clause?.isTypeOnly || !clause?.namedBindings || !ts.isNamedImports(clause.namedBindings))
          continue;
        for (const item of clause.namedBindings.elements) {
          if (item.isTypeOnly) continue;
          bindings.set(item.name.text, () => {
            const imported = dependency(statement.moduleSpecifier.text);
            const name = item.propertyName?.text ?? item.name.text;
            if (imported.zod && name === 'z') return z;
            const get = imported.exports?.get(name);
            if (!get) fail(item, `Unsupported schema import ${name}`);
            return get();
          });
        }
      } else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.exportClause) {
        if (!ts.isNamedExports(statement.exportClause)) fail(statement, 'Unsupported schema export');
        for (const item of statement.exportClause.elements) {
          if (item.isTypeOnly) continue;
          exports.set(item.name.text, () => {
            const imported = statement.moduleSpecifier ? dependency(statement.moduleSpecifier.text) : result;
            const get = (statement.moduleSpecifier ? imported.exports : bindings).get(
              item.propertyName?.text ?? item.name.text,
            );
            if (!get) fail(item, `Missing schema export ${item.name.text}`);
            return get();
          });
        }
      }
    }
    return result;
  }
  function evaluate(node, module) {
    if (cache.has(node)) return cache.get(node);
    if (visiting.has(node)) fail(node, 'Recursive schema expression is unsupported');
    visiting.add(node);
    let value;
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node))
      value = evaluate(node.expression, module);
    else if (ts.isIdentifier(node)) {
      const get = module.bindings.get(node.text);
      if (!get) fail(node, `Unsupported schema identifier ${node.text}`);
      value = get();
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) value = node.text;
    else if (ts.isNumericLiteral(node)) value = Number(node.text);
    else if (node.kind === ts.SyntaxKind.TrueKeyword) value = true;
    else if (node.kind === ts.SyntaxKind.FalseKeyword) value = false;
    else if (node.kind === ts.SyntaxKind.NullKeyword) value = null;
    else if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken)
      value = -evaluate(node.operand, module);
    else if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      const text = node.getText(),
        end = text.lastIndexOf('/');
      value = new RegExp(text.slice(1, end), text.slice(end + 1));
    } else if (ts.isArrayLiteralExpression(node)) {
      value = node.elements.flatMap(item =>
        ts.isSpreadElement(item) ? evaluate(item.expression, module) : [evaluate(item, module)],
      );
    } else if (ts.isObjectLiteralExpression(node)) {
      value = Object.create(null);
      for (const property of node.properties) {
        if (ts.isSpreadAssignment(property)) Object.assign(value, evaluate(property.expression, module));
        else if (ts.isPropertyAssignment(property) && !ts.isComputedPropertyName(property.name))
          value[property.name.text] = evaluate(property.initializer, module);
        else if (ts.isShorthandPropertyAssignment(property))
          value[property.name.text] = evaluate(property.name, module);
        else fail(property, 'Unsupported schema object member');
      }
    } else if (ts.isPropertyAccessExpression(node)) {
      const receiver = evaluate(node.expression, module);
      if (receiver === z && node.name.text === 'iso') value = z.iso;
      else if (node.name.text === 'shape' && receiver instanceof z.ZodObject) value = receiver.shape;
      else if (
        receiver &&
        [null, Object.prototype].includes(Object.getPrototypeOf(receiver)) &&
        Object.hasOwn(receiver, node.name.text)
      )
        value = receiver[node.name.text];
      else fail(node, 'Unsupported schema property');
    } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const call = node.expression,
        name = call.name.text;
      const receiver = evaluate(call.expression, module);
      if (receiver instanceof z.ZodType && ['refine', 'superRefine'].includes(name)) {
        // Arbitrary predicates have no structural JSON Schema equivalent. Never execute them.
        value = receiver;
      } else if (receiver instanceof z.ZodType && name === 'default') {
        // A default accepts an absent input. Its value is irrelevant to input compatibility.
        value = receiver.optional();
      } else {
        if (
          !(receiver === z.iso
            ? ['datetime', 'date', 'time', 'duration'].includes(name)
            : receiver === z
              ? constructors.has(name)
              : receiver instanceof z.ZodType && methods.has(name))
        )
          fail(node, `Unsupported schema call ${name}`);
        value = receiver[name](...node.arguments.map(argument => evaluate(argument, module)));
      }
    } else fail(node, `Unsupported schema expression ${ts.SyntaxKind[node.kind]}`);
    visiting.delete(node);
    cache.set(node, value);
    return value;
  }
  const registry = z.registry(),
    aliases = {},
    registered = new Map();
  for (const [index, file] of files.entries()) {
    const module = moduleAt(resolve(root, file));
    for (const [name, get] of [...module.exports].sort(([a], [b]) => a.localeCompare(b))) {
      if (!name.endsWith('Schema')) continue;
      const schema = get();
      if (!(schema instanceof z.ZodType)) throw new Error(`${file}#${name} is not a Zod schema`);
      const id = `${sharedSchemaFiles[index] ?? file}#${name}`;
      if (registered.has(schema)) aliases[id] = { $ref: registered.get(schema) };
      else {
        registry.add(schema, { id });
        registered.set(schema, id);
      }
    }
  }
  return {
    format: 1,
    ...(version ? { version } : {}),
    schemas: { ...z.toJSONSchema(registry, { io: 'input' }).schemas, ...aliases },
  };
}
