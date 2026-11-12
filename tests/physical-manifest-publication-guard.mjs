// SPDX-License-Identifier: Apache-2.0
import ts from 'typescript';
import { relative } from 'node:path';
import { compilerTrace } from './physical-manifest-publication-trace.mjs';

/** Discover publication functions from DB sinks and resolved record call sites.
 * The policy follows exact head origins, never a writer-name allowlist. */
export function publicationInventory(root, injected = {}) {
  const inventory = [],
    findings = [];
  const {
    checker,
    declaration,
    callName,
    symbol,
    type,
    propertyType,
    actual,
    fields,
    keys,
    origin,
    same,
    literal,
    forwardedParameter,
    sourceFiles,
    calls,
    nodes,
    enclosingFunction,
    databaseAdapter,
    dominates,
    uncast,
  } = compilerTrace(root, injected);
  const checks = fn => nodes(fn.body, node => ts.isCallExpression(node) && callName(node) === 'invariant');
  const equalities = (fn, sink) =>
    checks(fn)
      .filter(check => check.end < sink.pos && dominates(check, sink))
      .flatMap(call =>
        nodes(
          call.arguments[0],
          node =>
            ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken,
        ),
      );
  function composedHead(head, fn, sink) {
    const pin = origin(head);
    if (!pin || pin.path.slice(-3).join('.') !== 'result.state.sha256') return false;
    const payload = { ...pin, path: pin.path.slice(0, -3) },
      equals = equalities(fn, sink);
    for (const equality of equals) {
      const left = origin(equality.left),
        right = actual(equality.right);
      if (
        !left ||
        left.path.at(-1) !== 'jobKind' ||
        literal(right) !== 'compose' ||
        !ts.isCallExpression(left.node) ||
        callName(left.node) !== 'loadSourceJob'
      )
        continue;
      const job = { ...left, path: left.path.slice(0, -1) };
      const completed = equals.some(eq => {
        const value = origin(eq.left);
        return (
          literal(eq.right) === 'completed' &&
          value?.path.at(-1) === 'status' &&
          same({ ...value, path: value.path.slice(0, -1) }, job)
        );
      });
      const signed = equals.some(eq => {
        const value = origin(eq.left),
          hash = actual(eq.right);
        return (
          value?.path.slice(-2).join('.') === 'output.sha256' &&
          same({ ...value, path: value.path.slice(0, -2) }, job) &&
          hash &&
          ts.isCallExpression(hash) &&
          callName(hash) === 'digest' &&
          same(origin(hash.arguments[0]), payload)
        );
      });
      if (completed && signed) return true;
    }
    return false;
  }
  function candidateHead(head) {
    const value = origin(head);
    if (
      !value ||
      value.path.join('.') !== 'value.result.head' ||
      !ts.isCallExpression(value.node) ||
      callName(value.node) !== 'readHostedRecord'
    )
      return false;
    return literal(fields(value.node.arguments[1], 'kind')[0]) === 'candidate';
  }
  function serialized(node) {
    node = actual(node);
    if (node && ts.isCallExpression(node) && callName(node) === 'canonicalPayload')
      node = actual(node.arguments[0]);
    if (
      node &&
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'parse'
    )
      if (ts.isObjectLiteralExpression(actual(node.arguments[0]))) node = actual(node.arguments[0]);
    return node;
  }
  const inputRecord = call => fields(call.arguments[1], 'record')[0];
  const recordWriters = new Set();
  // Discover the generic record primitive from its DB sink, then inspect all
  // callers using the resolved declaration (including renamed imports/aliases).
  const recordSinks = new Map();
  for (const call of calls) {
    const decl = declaration(call),
      method = decl?.name?.getText();
    if (
      !decl?.getSourceFile().fileName.endsWith('/server/database.d.ts') ||
      !['insert', 'patch', 'replace'].includes(method) ||
      call.arguments.length < 2
    )
      continue;
    const target = checker.typeToString(type(call.arguments[0]));
    if (!target.includes('projectHostedRecords') && !target.includes('projectHostedRecordHeads')) continue;
    const value = actual(call.arguments[1]);
    const names = keys(value);
    if (
      method === 'patch' &&
      names &&
      names.every(name => !['kind', 'key', 'version', 'recordId', 'digest', 'bytes', 'bodyId'].includes(name))
    )
      continue;
    const fn = enclosingFunction(call),
      kind = propertyType(type(call.arguments[1]), 'kind', call),
      possible = kind && checker.typeToString(kind),
      excludes = checks(fn)
        .filter(check => check.end < call.pos && dominates(check, call))
        .some(
          check =>
            nodes(
              check.arguments[0],
              node =>
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken &&
                ts.isPropertyAccessExpression(node.left) &&
                node.left.name.text === 'kind' &&
                literal(node.right) === 'candidate' &&
                same(origin(node.left), origin(fields(value, 'kind')[0])),
            ).length,
        );
    if (
      excludes ||
      (possible && !['any', 'unknown', 'string'].includes(possible) && !possible.includes('candidate'))
    )
      continue;
    const dispatch =
      ts.isFunctionDeclaration(fn) && fn.parameters.some(param => type(param).getProperty('record'));
    recordSinks.set(call, dispatch ? 'record-dispatch' : 'unproven');
    if (dispatch) recordWriters.add(fn);
  }
  for (const file of sourceFiles)
    for (const prop of nodes(
      file,
      node => ts.isPropertyAssignment(node) && node.name.getText() === 'handler',
    )) {
      const handler = actual(prop.initializer),
        target = handler && ts.isIdentifier(handler) && symbol(handler)?.valueDeclaration;
      if (!recordWriters.has(target)) continue;
      const item = {
        file: relative(root, file.fileName).replaceAll('\\', '/'),
        line: file.getLineAndCharacterOfPosition(prop.pos).line + 1,
        function: target.name.getText(),
        kind: 'dynamic-record-entry',
        route: 'unproven',
      };
      inventory.push(item);
      findings.push(item);
    }
  for (const call of calls) {
    const decl = declaration(call),
      name = decl?.name?.getText(),
      fn = enclosingFunction(call);
    if (
      ts.isElementAccessExpression(call.expression) &&
      !literal(call.expression.argumentExpression) &&
      type(call.expression.expression).getProperty('insert') &&
      type(call.expression.expression).getProperty('query')
    ) {
      const file = call.getSourceFile(),
        item = {
          file: relative(root, file.fileName).replaceAll('\\', '/'),
          line: file.getLineAndCharacterOfPosition(call.pos).line + 1,
          function: fn?.name?.getText() ?? '<handler>',
          kind: 'computed-db-write',
          route: 'unproven',
        };
      inventory.push(item);
      findings.push(item);
      continue;
    }

    let kind, route;
    if (recordSinks.has(call)) {
      kind = 'dynamic-record-sink';
      route = recordSinks.get(call) === 'unproven' ? undefined : recordSinks.get(call);
    } else if (recordWriters.has(decl)) {
      const record = inputRecord(call),
        kindNode = fields(record, 'kind')[0],
        recType = propertyType(type(call.arguments[1]), 'record', call),
        kindType = propertyType(recType, 'kind', call),
        possible = literal(kindNode) ?? (kindType && checker.typeToString(kindType));
      if (possible && !['any', 'unknown', 'string'].includes(possible) && !possible.includes('candidate'))
        continue;
      kind = 'candidate';
      const results = fields(record, 'result'),
        heads = results.flatMap(result => fields(result, 'head')),
        statuses = results.flatMap(result => fields(result, 'status')).map(literal);
      if (statuses.length && statuses.every(status => status === 'conflict')) route = 'conflict-only';
      else if (heads.length && heads.every(head => composedHead(head, fn, call))) route = 'verified-compose';
    } else if (
      decl?.getSourceFile().fileName.endsWith('/server/database.d.ts') &&
      ['insert', 'patch', 'replace'].includes(name) &&
      call.arguments.length > 1
    ) {
      const target =
          checker.typeToString(type(call.arguments[0])) === 'never'
            ? checker.typeToString(type(uncast(call.arguments[0])))
            : checker.typeToString(type(call.arguments[0])),
        value = call.arguments[1],
        selection = fields(value, 'selection')[0];
      if (
        !target.includes('projectHostedChannels') &&
        !['any', 'unknown', 'string', 'never'].includes(target)
      )
        continue;
      // A concrete patch of unrelated fields cannot publish source, even when
      // an old internal row ID is untyped. An unknown payload remains a sink.
      if (
        name === 'patch' &&
        !selection &&
        ts.isObjectLiteralExpression(actual(value)) &&
        !actual(value).properties.some(ts.isSpreadAssignment)
      )
        continue;
      kind = name === 'insert' ? 'main-insert' : 'main-update';
      const payload = serialized(selection),
        heads = fields(payload, 'head');
      if (name === 'insert' && payload && (heads.length || propertyType(type(payload), 'head', payload))) {
        const proofs = nodes(
          fn.body,
          node =>
            ts.isCallExpression(node) &&
            callName(node) === 'assertRootlessSeed' &&
            node.end < call.pos &&
            dominates(node, call),
        );
        if (
          (heads.length ? heads.map(head => origin(head)) : [origin(payload, ['head'])]).every(head =>
            proofs.some(proof => same(head, origin(proof.arguments[2]))),
          )
        )
          route = 'rootless-seed';
      } else if (heads.length && heads.every(candidateHead)) route = 'composed-candidate';
      if (
        !heads.length &&
        payload &&
        ts.isObjectLiteralExpression(payload) &&
        payload.properties.every(prop => ts.isSpreadAssignment(prop) || prop.name?.getText() === 'authority')
      ) {
        const spreads = payload.properties.filter(ts.isSpreadAssignment),
          target = origin(call.arguments[0]);
        if (
          spreads.length === 1 &&
          nodes(
            actual(spreads[0].expression),
            node =>
              ts.isPropertyAccessExpression(node) &&
              node.name.text === 'selection' &&
              checker
                .typeToString(propertyType(type(node.expression), '_id', node) ?? type(node))
                .includes('projectHostedChannels') &&
              target?.path.at(-1) === '_id' &&
              same(origin(node.expression), { ...target, path: target.path.slice(0, -1) }),
          ).length
        )
          route = 'preserved-main';
      }
      // After a negative normalizeId guard returns, subsequent writes are
      // confined to that concrete, unrelated table (cold request bodies).
      if (
        !route &&
        nodes(fn.body, node => {
          if (
            !ts.isIfStatement(node) ||
            node.end >= call.pos ||
            !nodes(node.thenStatement, ts.isReturnStatement).length
          )
            return false;
          const condition = uncast(node.expression);
          if (!ts.isPrefixUnaryExpression(condition) || condition.operator !== ts.SyntaxKind.ExclamationToken)
            return false;
          const check = uncast(condition.operand);
          return (
            ts.isCallExpression(check) &&
            ts.isPropertyAccessExpression(check.expression) &&
            check.expression.name.text === 'normalizeId' &&
            literal(check.arguments[0]) &&
            !['projectHostedChannels', 'projectHostedRecords', 'projectHostedRecordHeads'].includes(
              literal(check.arguments[0]),
            ) &&
            same(origin(check.arguments[1]), origin(call.arguments[0]))
          );
        }).length
      )
        route = 'db-specialization';
      // A passthrough insert forwards both original parameters without making
      // a selection. Its callers are still inventoried through the DB signature.
      if (
        !selection &&
        databaseAdapter(call) &&
        forwardedParameter(call.arguments[0], call.arguments[0]) &&
        forwardedParameter(value, call.arguments[0])
      )
        route = 'db-forwarding';
    } else continue;
    const file = call.getSourceFile(),
      item = {
        file: relative(root, file.fileName).replaceAll('\\', '/'),
        line: file.getLineAndCharacterOfPosition(call.pos).line + 1,
        function: fn?.name?.getText() ?? fn?.parent?.name?.getText() ?? '<handler>',
        kind,
        route: route ?? 'unproven',
      };
    inventory.push(item);
    if (!route) findings.push(item);
  }
  return { inventory, findings };
}
