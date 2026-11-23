// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type ts from 'typescript';

type Specifier = { value: string; complete: boolean };

function unwrap(api: typeof ts, node: ts.Expression): ts.Expression {
  if (
    api.isParenthesizedExpression(node) ||
    api.isAsExpression(node) ||
    api.isTypeAssertionExpression(node) ||
    api.isNonNullExpression(node) ||
    api.isSatisfiesExpression(node)
  )
    return unwrap(api, node.expression);
  return node;
}

function concatenation(api: typeof ts, node: ts.Expression): node is ts.BinaryExpression {
  return api.isBinaryExpression(node) && node.operatorToken.kind === api.SyntaxKind.PlusToken;
}

function leadingLiteral(api: typeof ts, input: ts.Expression): Specifier | undefined {
  const node = unwrap(api, input);
  if (api.isStringLiteralLike(node)) return { value: node.text, complete: true };
  if (api.isTemplateExpression(node)) return { value: node.head.text, complete: false };
  if (concatenation(api, node)) {
    const left = leadingLiteral(api, node.left);
    if (!left?.complete) return left;
    const right = leadingLiteral(api, node.right);
    return { value: left.value + (right?.value ?? ''), complete: right?.complete ?? false };
  }
}

function emptyLiteralBranch(api: typeof ts, input: ts.Expression): boolean {
  const node = unwrap(api, input);
  if (api.isStringLiteralLike(node)) return !node.text;
  if (api.isConditionalExpression(node))
    return emptyLiteralBranch(api, node.whenTrue) || emptyLiteralBranch(api, node.whenFalse);
  return (
    concatenation(api, node) && emptyLiteralBranch(api, node.left) && emptyLiteralBranch(api, node.right)
  );
}

function callProperty(api: typeof ts, node: ts.Expression) {
  if (api.isPropertyAccessExpression(node)) return { receiver: node.expression, name: node.name.text };
  if (api.isElementAccessExpression(node) && api.isStringLiteralLike(node.argumentExpression))
    return { receiver: node.expression, name: node.argumentExpression.text };
}

export function visitJsSpecifiers(
  api: typeof ts,
  file: ts.SourceFile,
  emit: (specifier: Specifier, glob?: boolean) => void,
) {
  const literal = (value: ts.Node | undefined) => {
    if (value && api.isStringLiteralLike(value)) emit({ value: value.text, complete: true });
  };
  const argument = (input: ts.Expression | undefined, glob: boolean, appended = false) => {
    if (!input) return;
    const node = unwrap(api, input);
    if (api.isConditionalExpression(node)) {
      argument(node.whenTrue, glob, appended);
      argument(node.whenFalse, glob, appended);
    } else if (glob && api.isArrayLiteralExpression(node)) {
      for (const child of node.elements) argument(child, glob, appended);
    } else {
      const value = leadingLiteral(api, node);
      if (value?.value) emit({ value: value.value, complete: value.complete && !appended }, glob);
      else if (concatenation(api, node)) {
        argument(node.left, glob, true);
        if (emptyLiteralBranch(api, node.left)) argument(node.right, glob, appended);
      }
    }
  };
  const visit = (node: ts.Node) => {
    if (api.isImportDeclaration(node) || api.isExportDeclaration(node)) literal(node.moduleSpecifier);
    else if (api.isExternalModuleReference(node)) literal(node.expression);
    else if (api.isImportTypeNode(node) && api.isLiteralTypeNode(node.argument))
      literal(node.argument.literal);
    else if (api.isJSDocImportTag(node)) literal(node.moduleSpecifier);
    else if (api.isCallExpression(node)) {
      const target = unwrap(api, node.expression);
      const method = callProperty(api, target);
      const glob =
        !!method &&
        ((api.isIdentifier(method.receiver) &&
          method.receiver.text === 'require' &&
          method.name === 'context') ||
          (api.isMetaProperty(method.receiver) &&
            method.receiver.keywordToken === api.SyntaxKind.ImportKeyword &&
            method.receiver.name.text === 'meta' &&
            method.name === 'glob'));
      if (
        glob ||
        target.kind === api.SyntaxKind.ImportKeyword ||
        (api.isIdentifier(target) && target.text === 'require')
      )
        argument(node.arguments[0], glob);
    }
    api.forEachChild(node, visit);
    // JSDoc import types and import tags are outside the ordinary child walk.
    for (const doc of (node as ts.Node & { jsDoc?: readonly ts.JSDoc[] }).jsDoc ?? []) visit(doc);
  };
  visit(file);
}
