// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { createHash } from 'node:crypto';
import ts from 'typescript';

export const storageShapeBaseline = 'tests/storage-shape-baseline.json';
const formatField =
  /^(?:schema|schemaVersion|version|format|formatVersion|protocol|protocolVersion|wireVersion)$/;
const domainTag = /^(?:action|kind|status|type)$/;
const reader = '(?:read|load|parse|decode|hydrate|resolve|normalize|rehydrate|deserialize)';
const legacy = '(?:legacy|backCompat|backwardCompat|compatibility|[Vv][0-9]+)';
const readerName = new RegExp(`^(?:${reader}.*${legacy}|${legacy}.*${reader})`, 'i');
const oldFormat =
  /\b(?:legacy[A-Z\w]*|(?:schema|format|protocol|wire)Version|[A-Za-z]+V[0-9]+)\b|['"][^'"]*[-_]v[0-9]+['"]/;
const sourceDirectory = /^(?:convex|src|site|web\/src)\//;

function eligible(path) {
  return (
    sourceDirectory.test(path) &&
    /(?<!\.d)\.tsx?$/.test(path) &&
    !path.split('/').some(part => part === '_generated' || part === 'node_modules')
  );
}

function validRemoval(comments) {
  return [...comments.matchAll(/@remove-after\s+(\d{4}-\d{2}-\d{2})\b/g)].some(([, day]) => {
    const date = new Date(day + 'T00:00:00.000Z');
    return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === day;
  });
}

/** Static checks for competing format arms and compatibility reader patterns. No source is executed. */
export function storageShapeCandidates(path, source) {
  if (!eligible(path) || !/(?:union|legacy|compat|format|schema|protocol|version|v\d)/i.test(source))
    return [];
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const printer = ts.createPrinter({ removeComments: true });
  const definitions = new Map();
  for (const statement of tree.statements)
    if (ts.isVariableStatement(statement))
      for (const decl of statement.declarationList.declarations)
        if (ts.isIdentifier(decl.name) && decl.initializer) definitions.set(decl.name.text, decl.initializer);
  const declared = node => (ts.isIdentifier(node) ? (definitions.get(node.text) ?? node) : node);
  const called = node =>
    ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      ? node.expression.name.text
      : undefined;
  const fields = node => {
    const value = declared(node);
    if (
      called(value) !== 'object' ||
      !value.arguments[0] ||
      !ts.isObjectLiteralExpression(value.arguments[0])
    )
      return;
    return value.arguments[0].properties.filter(ts.isPropertyAssignment);
  };
  const literal = node =>
    called(node) === 'literal' &&
    node.arguments[0] &&
    (ts.isStringLiteral(node.arguments[0]) || ts.isNumericLiteral(node.arguments[0]))
      ? node.arguments[0].text
      : undefined;
  const property = field =>
    ts.isIdentifier(field.name) || ts.isStringLiteral(field.name) ? field.name.text : '';
  const findings = [];
  function add(kind, node, identity = printer.printNode(ts.EmitHint.Unspecified, node, tree)) {
    let declaration = node;
    while (
      declaration.parent &&
      (ts.isArrowFunction(declaration.parent) ||
        ts.isVariableDeclaration(declaration.parent) ||
        ts.isVariableDeclarationList(declaration.parent) ||
        ts.isVariableStatement(declaration.parent) ||
        ts.isExpressionStatement(declaration.parent) ||
        ts.isReturnStatement(declaration.parent))
    )
      declaration = declaration.parent;
    const ranges = ts.getLeadingCommentRanges(source, declaration.getFullStart()) ?? [];
    findings.push({
      key: createHash('sha256')
        .update(kind + '\0' + identity)
        .digest('hex')
        .slice(0, 24),
      kind,
      line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
      dated: validRemoval(ranges.map(range => source.slice(range.pos, range.end)).join('\n')),
    });
  }
  function union(node) {
    const args = node.arguments.find(ts.isArrayLiteralExpression)?.elements ?? node.arguments;
    const objects = [...args].map(fields).filter(Boolean);
    if (objects.length < 2) return;
    const tags = objects[0].filter(field => literal(field.initializer) !== undefined).map(property);
    const distinguishes = key => {
      const values = objects.map(object => {
        const field = object.find(candidate => property(candidate) === key);
        return field && literal(field.initializer);
      });
      return values.every(value => value !== undefined) && new Set(values).size > 1;
    };
    const versioned = tags.some(key => formatField.test(key) && distinguishes(key));
    const ordinaryVariants = tags.some(key => domainTag.test(key) && distinguishes(key));
    const persistedOverlap =
      path.startsWith('convex/') &&
      !ordinaryVariants &&
      objects
        .slice(1)
        .some(object =>
          object.some(field =>
            objects[0].some(other => property(other) === property(field) && Boolean(property(field))),
          ),
        );
    if (versioned || persistedOverlap)
      add(
        'competing record shapes',
        node,
        [...args].map(arg => printer.printNode(ts.EmitHint.Unspecified, declared(arg), tree)).join('\n'),
      );
  }
  function visit(node) {
    const fn =
      ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isVariableDeclaration(node);
    if (fn && node.name && ts.isIdentifier(node.name) && readerName.test(node.name.text))
      add('compatibility reader', node, node.name.text);
    if (called(node) === 'union' || called(node) === 'discriminatedUnion') union(node);
    if ((ts.isIfStatement(node) && node.elseStatement) || ts.isConditionalExpression(node)) {
      const condition = ts.isIfStatement(node) ? node.expression : node.condition;
      if (oldFormat.test(condition.getText(tree))) add('compatibility dispatch', node);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return findings;
}

export function storageShapeFindings(path, source, baseline) {
  const remaining = new Map(Object.entries(baseline[path] ?? {}));
  const errors = [];
  for (const finding of storageShapeCandidates(path, source)) {
    if (finding.dated) continue;
    const count = remaining.get(finding.key) ?? 0;
    if (count) remaining.set(finding.key, count - 1);
    else
      errors.push(`${path}:${finding.line}: ${finding.kind} needs a nearby @remove-after YYYY-MM-DD line.`);
  }
  for (const [key, count] of remaining)
    if (count)
      errors.push(`${path}: unused storage shape baseline ${key} (${count}). Remove the retired exception.`);
  return errors;
}
