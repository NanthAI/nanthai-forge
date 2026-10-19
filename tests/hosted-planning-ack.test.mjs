// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { moduleUrl } from './convex-module.mjs';
const planningRows = await import(moduleUrl('../web/src/planning-rows.ts'));
const intentProgress = await import(moduleUrl('../src/work-intent-progress.ts'));

// Exercise the actual editor handlers with deterministic state and deferred network
// replies. Rendering effects are irrelevant to this race: the acknowledged version
// never appears in the current-only reactive page.
function editor() {
  const values = [];
  let cursor = 0;
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in values)) values[index] = initial;
      return [
        values[index],
        value => {
          values[index] = typeof value === 'function' ? value(values[index]) : value;
        },
      ];
    },
    useRef(initial) {
      const index = cursor++;
      return (values[index] ??= { current: initial });
    },
    useEffect() {},
  };
  const jsx = (type, props) => ({ type, props });
  const module = { exports: {} };
  const code = ts.transpileModule(
    readFileSync(new URL('../web/src/WorkPlanning.tsx', import.meta.url), 'utf8'),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
      },
    },
  ).outputText;
  runInNewContext(code, {
    exports: module.exports,
    crypto: { randomUUID },
    require: name =>
      name === 'react'
        ? hooks
        : name === 'react/jsx-runtime'
          ? { jsx, jsxs: jsx }
          : name === '../../src/work-intent-progress'
            ? intentProgress
            : name === './planning-rows'
              ? planningRows
              : name === './ui/status'
                ? { age: () => 'now' }
                : name === './shell/WorkHeader'
                  ? { useWorkHeader: () => null }
                  : name === './shell/Shell'
                    ? { PageHead: 'header' }
                    : name === './WorkspaceUI'
                      ? { useDestination: () => hooks.useState(''), ActionPanel: 'section' }
                      : {},
  });
  const data = { revision: 1, intents: [], planningItems: [], planningComments: [], hostedEvents: [] };
  const props = { data, busy: false, scope: 'hosted', act: async () => {} };
  const render = () => {
    cursor = 0;
    return module.exports.WorkPlanning(props);
  };
  const nodes = root =>
    !root || typeof root !== 'object'
      ? []
      : Array.isArray(root)
        ? root.flatMap(nodes)
        : [root, ...nodes(root.props?.children), ...nodes(root.props?.actions)];
  const find = predicate => nodes(render()).find(predicate);
  const field = label => {
    const row = find(node => node.type === 'label' && node.props.children?.[0] === label);
    assert.ok(row, label);
    return row.props.children[1];
  };
  const submit = () => find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  return { props, field, submit };
}
const deferred = () => {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
};

test('successful save retains its created item identity when a newer remote version overtakes the current page', async () => {
  const ui = editor(),
    reply = deferred(),
    commands = [];
  ui.props.act = command => {
    commands.push(command);
    return reply.promise;
  };
  ui.field('Title').props.onChange({ target: { value: 'My item' } });
  const saving = ui.submit(),
    original = commands[0];
  // This is the only version the browser receives; original operation is historical.
  ui.props.data.planningItems = [
    {
      ...original,
      id: original.itemId,
      operationId: randomUUID(),
      version: 2,
      title: 'Remote version',
      at: 'now',
    },
  ];
  ui.field('Details').props.onChange({ target: { value: 'My continued draft' } });
  reply.resolve({ operationId: original.operationId });
  await saving;
  assert.equal(ui.field('Planning item').props.value, original.itemId);
  assert.equal(ui.field('Details').props.value, 'My continued draft');
  assert.equal(ui.field('Title').props.value, 'My item');
  await ui.submit();
  assert.equal(commands[1].itemId, original.itemId);
  assert.equal(commands[1].expectedVersion, 1);
  assert.notEqual(commands[1].operationId, original.operationId);
});

test('failed or mismatched acknowledgements retain the original UUID for reconciliation', async () => {
  for (const acknowledgement of [undefined, { operationId: randomUUID() }]) {
    const ui = editor(),
      commands = [];
    ui.props.act = async command => {
      commands.push(command);
      return acknowledgement;
    };
    ui.field('Title').props.onChange({ target: { value: 'Retry original' } });
    await ui.submit();
    await ui.submit();
    assert.equal(commands[1].operationId, commands[0].operationId);
    assert.equal(commands[1].itemId, commands[0].itemId);
  }
});

test('late acknowledgement does not replace another selected editor or its draft', async () => {
  const ui = editor(),
    reply = deferred();
  let original;
  ui.props.act = command => {
    original = command;
    return reply.promise;
  };
  ui.field('Title').props.onChange({ target: { value: 'First item' } });
  const saving = ui.submit();
  ui.props.data.planningItems = [
    {
      id: 'other',
      kind: 'issue',
      title: 'Other item',
      body: 'Other draft',
      status: 'open',
      version: 3,
      intentIds: [],
    },
  ];
  await ui.field('Planning item').props.onChange({ target: { value: 'other' } });
  reply.resolve({ operationId: original.operationId });
  await saving;
  assert.equal(ui.field('Planning item').props.value, 'other');
  assert.equal(ui.field('Details').props.value, 'Other draft');
});
