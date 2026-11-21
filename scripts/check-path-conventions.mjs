// SPDX-License-Identifier: Apache-2.0
import ts from 'typescript';

const timers = new Set(['setTimeout', 'setInterval']);
const schedulerMethods = new Set(['runAfter', 'runAt']);
const copyingMethods = new Set([
  'concat',
  'filter',
  'flat',
  'flatMap',
  'map',
  'slice',
  'splice',
  'subarray',
  'toReversed',
  'toSorted',
  'toSpliced',
]);
const allocatingCalls = new Set([
  'Array.from',
  'Array.of',
  'Buffer.alloc',
  'Buffer.allocUnsafe',
  'Buffer.from',
  'Object.entries',
  'Object.fromEntries',
  'Object.keys',
  'Object.values',
]);

function member(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression))
    return node.argumentExpression.text;
}

function name(node) {
  return ts.isIdentifier(node) ? node.text : member(node);
}

function allocates(node) {
  if (
    ts.isObjectLiteralExpression(node) ||
    ts.isArrayLiteralExpression(node) ||
    ts.isNewExpression(node) ||
    (ts.isBindingElement(node) && node.dotDotDotToken)
  )
    return true;
  if (!ts.isCallExpression(node)) return false;
  const callee = ts.skipOuterExpressions(node.expression);
  const method = member(callee);
  if (method)
    return copyingMethods.has(method) || allocatingCalls.has(`${name(callee.expression)}.${method}`);
  return ts.isIdentifier(callee) && (callee.text === 'Array' || callee.text === 'structuredClone');
}

function taggedLoop(node, source) {
  const text = source.text;
  const start = node.getStart(source);
  const comments = ts.getLeadingCommentRanges(text, node.getFullStart()) ?? [];
  return comments.some(
    ({ kind, pos, end }) =>
      kind === ts.SyntaxKind.SingleLineCommentTrivia &&
      /^\/\/ hot-loop: \S/.test(text.slice(pos, end)) &&
      /^\r?\n[^\S\r\n]*$/.test(text.slice(end, start)),
  );
}

/** Check visible operations in opted-in TypeScript. No type checking or repository code execution. */
export function pathConventionFindings(path, text) {
  const idle = /\.idle\.tsx?$/.test(path);
  const hot = path.endsWith('.hot.ts');
  const tags = text.includes('// hot-loop:');
  if (!idle && !hot && !tags) return [];

  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest);
  const findings = [];
  const fail = (node, message) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    findings.push(`${path}:${line + 1}: ${message}`);
  };

  function visit(node, inHotLoop = false) {
    if (idle && ts.isCallExpression(node)) {
      const callee = ts.skipOuterExpressions(node.expression);
      const called = name(callee);
      if (timers.has(called)) fail(node, 'Idle paths must observe events without a refresh timer.');
      if (
        member(callee) &&
        schedulerMethods.has(called) &&
        name(ts.skipOuterExpressions(callee.expression)) === 'scheduler'
      )
        fail(node, 'Idle paths must observe events without scheduling a refresh.');
    }

    if (inHotLoop && allocates(node))
      fail(node, 'Move scratch allocation or copying outside the hot-loop body.');

    const flagged =
      (hot || tags) && ts.isIterationStatement(node, false) && (hot || taggedLoop(node, source));
    ts.forEachChild(node, child => visit(child, inHotLoop || (flagged && child === node.statement)));
  }

  visit(source);
  return findings;
}
