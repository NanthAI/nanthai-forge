// SPDX-License-Identifier: Apache-2.0
import ts from 'typescript';
const contracts = [
  ['src/hosted-landing.ts', 'hostedLandingStateSchema', 'SourceEntryPhases'],
  ['convex/projectHostedLandingBatchState.ts', 'batchSchema', 'SourceBatchPhases'],
];
// Parse syntax only. Never import/execute repository queue modules.
export function landingModelFindings(read) {
  const errors = [];
  const model = read('models/landing-queue/LandingQueue.tla');
  for (const [path, variable, operator] of contracts) {
    const source = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true);
    let declaration;
    const find = node => {
      if (ts.isVariableDeclaration(node) && node.name.getText(source) === variable) declaration = node;
      ts.forEachChild(node, find);
    };
    find(source);
    const values = [];
    const phase = node => {
      if (
        ts.isPropertyAssignment(node) &&
        node.name.getText(source) === 'phase' &&
        ts.isCallExpression(node.initializer)
      ) {
        const array = node.initializer.arguments[0];
        if (array && ts.isArrayLiteralExpression(array))
          for (const item of array.elements) if (ts.isStringLiteral(item)) values.push(item.text);
      }
      ts.forEachChild(node, phase);
    };
    if (declaration) phase(declaration);
    const body = model.match(new RegExp(`${operator} == \\{([^}]+)\\}`))?.[1] ?? '';
    const modeled = [...body.matchAll(/"([^"]+)"/g)].map(match => match[1]);
    if (!values.length || JSON.stringify([...values].sort()) !== JSON.stringify(modeled.sort()))
      errors.push(
        `${path}: queue phase names differ from ${operator}; update landing-queue model and mapping.`,
      );
  }
  return errors;
}
