// SPDX-License-Identifier: Apache-2.0
import ts from 'typescript';

/** Incident 8c9b84fc: a second attempt writer consumed an ordinal reserved before source IO.
 * Only forkLandingAttempt constructs a child identity; initial attempts and retained cache
 * metadata are not forks. Parse object literals so comments, types and unrelated counters pass. */
export function landingAttemptForkFindings(path, source) {
  if (!path.startsWith('convex/') || !source.includes('parentAttemptId') || !source.includes('number'))
    return [];
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const findings = [];
  const visit = node => {
    if (ts.isObjectLiteralExpression(node)) {
      const named = name => node.properties.find(p => p.name?.getText(file) === name);
      const parent = named('parentAttemptId'),
        number = named('number');
      if (
        parent &&
        number &&
        ts.isPropertyAssignment(parent) &&
        parent.initializer.kind !== ts.SyntaxKind.NullKeyword
      ) {
        let owner = node.parent;
        while (owner && !ts.isFunctionDeclaration(owner)) owner = owner.parent;
        if (path !== 'convex/projectHostedLandingStore.ts' || owner?.name?.text !== 'forkLandingAttempt') {
          const { line } = file.getLineAndCharacterOfPosition(parent.getStart(file));
          findings.push(
            `${path}:${line + 1}: child landing ordinal constructed outside forkLandingAttempt; use the current attempt and refresh reserved identity at install`,
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return findings;
}
