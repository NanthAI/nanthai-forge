// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

function screen() {
  const values = [];
  let cursor = 0;
  const hooks = {
    useState(initial) {
      const i = cursor++;
      if (!(i in values)) values[i] = initial;
      return [
        values[i],
        value => {
          values[i] = value;
        },
      ];
    },
  };
  const calls = [],
    state = {
      reply: input => input,
      requests: [],
      runners: [{ runnerId: 'machine', actor: 'viewer', name: 'My Mac', listening: true, lastSeen: 1 }],
      checks: [{ id: randomUUID(), name: 'Unit tests', definition: 'a'.repeat(64) }],
    };
  const jsx = (type, props) => ({ type, props }),
    module = { exports: {} };
  const code = ts.transpileModule(
    readFileSync(new URL('../web/src/LocalChecks.tsx', import.meta.url), 'utf8').replace(
      'import.meta.env.VITE_CONVEX_URL',
      JSON.stringify('https://example.convex.cloud'),
    ),
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
    require: name => {
      if (name === 'react') return hooks;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (name === 'convex/server') return { makeFunctionReference: value => value };
      if (name === 'convex/react')
        return {
          useMutation: name => async input => {
            calls.push({ name, input });
            return state.reply(input);
          },
          usePaginatedQuery: name => ({
            status: 'Exhausted',
            results: name.endsWith(':runners') ? state.runners : state.requests,
          }),
        };
      if (name === './hosted-work-index')
        return {
          useWorkRecords: () => ({ records: state.checks, loading: false }),
          useWorkRecord: (_project, _workspace, _collection, id) =>
            state.checks.find(check => check.id === id),
        };
      if (name === './shell/StatusBar') return { useNow: () => Date.now() };
      if (name === './ui/status')
        return { age: () => 'just now', checkStatus: status => ({ tone: 'plain', label: status }) };
      if (name === './ui/primitives') return { Button: 'button', StatusPill: 'span' };
      if (name === './lane/run-model') return { cancellationResult: () => 'Cancellation requested' };
      if (name === './WorkspaceUI') return { ActionPanel: 'aside' };
      if (name === './snapshot') return { hostedError: error => error.message };
      return {};
    },
  });
  const props = {
    projectId: 'project',
    workspace: { actor: 'viewer', capabilities: { owner: false } },
    viewId: randomUUID(),
    head: 'b'.repeat(64),
  };
  const nodes = node =>
    !node || typeof node !== 'object'
      ? []
      : Array.isArray(node)
        ? node.flatMap(nodes)
        : [node, ...nodes(node.props?.children)];
  const render = () => {
    cursor = 0;
    return nodes(module.exports.default(props));
  };
  return {
    calls,
    state,
    props,
    render,
    submit: () =>
      render()
        .find(node => node.type === 'form')
        .props.onSubmit({ preventDefault() {} }),
  };
}
test('check request retries keep the original UUID and pins until matching acknowledgement', async () => {
  const ui = screen();
  ui.state.reply = () => {
    throw Error('Response lost');
  };
  await ui.submit();
  assert.ok(ui.render().some(node => node.props?.children === 'Retry original request'));
  ui.state.reply = () => ({ operationId: randomUUID() });
  await ui.submit();
  assert.equal(ui.calls[1].input.operationId, ui.calls[0].input.operationId);
  ui.state.reply = input => input;
  await ui.submit();
  assert.equal(ui.calls[2].input.head, ui.props.head);
  assert.equal(ui.calls[2].input.definition, ui.state.checks[0].definition);
  assert.equal(ui.calls[2].input.operationId, ui.calls[0].input.operationId);
  await ui.submit();
  assert.notEqual(ui.calls[3].input.operationId, ui.calls[0].input.operationId);
});
test('queued request cancellation targets its retained operation rather than the current form selection', async () => {
  const ui = screen(),
    operationId = randomUUID();
  ui.state.requests = [
    {
      operationId,
      actor: 'viewer',
      runnerId: 'machine',
      checkName: 'Earlier check',
      runnerName: 'My Mac',
      createdAt: 1,
      updatedAt: 1,
      state: 'queued',
      cancelRequested: false,
      report: null,
      head: ui.props.head,
      definition: 'c'.repeat(64),
    },
  ];
  const button = ui.render().find(node => node.type === 'button' && node.props.children === 'Cancel check');
  button.props.onClick();
  await Promise.resolve();
  assert.equal(ui.calls[0].name, 'projectCheckRequests:cancel');
  assert.equal(ui.calls[0].input.operationId, operationId);
});

test('search and duplicate selection retain the chosen definition with visible provenance', async () => {
  const ui = screen();
  ui.state.checks = [
    {
      id: 'b',
      name: 'Unit tests',
      definition: 'b'.repeat(64),
      at: '2026-10-01T12:00:00Z',
      environmentLabel: 'Node24',
    },
    {
      id: 'a',
      name: 'Unit tests',
      definition: 'a'.repeat(64),
      at: '2026-09-01T12:00:00Z',
      environmentLabel: 'Node22',
    },
    { id: 'c', name: 'Build', definition: 'c'.repeat(64) },
  ];
  ui.render()
    .find(node => node.type === 'input' && node.props.type === 'search')
    .props.onChange({ target: { value: 'unit' } });
  let nodes = ui.render(),
    options = nodes.filter(node => node.type === 'option' && ['a', 'b', 'c'].includes(node.props.value));
  assert.deepEqual(
    options.map(node => node.props.value),
    ['a', 'b'],
  );
  assert.notEqual(options[0].props.children, options[1].props.children);
  nodes
    .find(node => node.type === 'select' && node.props.value === 'a')
    .props.onChange({ target: { value: 'b' } });
  nodes = ui.render();
  assert.ok(
    nodes.some(node => node.props?.children === 'Node24') || JSON.stringify(nodes).includes('Node24'),
  );
  await ui.submit();
  assert.equal(ui.calls[0].input.checkId, 'b');
  assert.equal(ui.calls[0].input.definition, 'b'.repeat(64));
  ui.render()
    .find(node => node.type === 'input' && node.props.type === 'search')
    .props.onChange({ target: { value: 'absent' } });
  await ui.submit();
  assert.equal(ui.calls.length, 1);
  assert.ok(ui.render().some(node => node.props?.children === 'No matching checks'));
});

test('only owned runners are enabled and selected for requests, including project owners', async () => {
  const ui = screen();
  ui.state.runners.unshift({ runnerId: 'foreign', actor: 'other', name: 'Other computer' });
  let nodes = ui.render();
  const foreign = nodes.find(node => node.type === 'option' && node.props.value === 'foreign');
  assert.equal(foreign.props.disabled, true);
  assert.equal(foreign.props.title, 'Only the runner owner can queue checks.');
  await ui.submit();
  assert.equal(ui.calls[0].input.runnerId, 'machine');
  ui.state.runners = ui.state.runners.filter(runner => runner.runnerId === 'foreign');
  ui.props.workspace.capabilities.owner = true;
  nodes = ui.render();
  assert.equal(
    nodes.find(node => node.type === 'button' && node.props.type === 'submit').props.disabled,
    true,
  );
  await ui.submit();
  assert.equal(ui.calls.length, 1);
});

test('pending retries never switch to another owned runner when the original runner disappears', async () => {
  const ui = screen();
  ui.state.reply = () => {
    throw Error('Response lost');
  };
  await ui.submit();
  ui.state.runners = [{ runnerId: 'second', actor: 'viewer', name: 'Another computer' }];
  await ui.submit();
  assert.equal(ui.calls.length, 1);
  ui.state.runners.push({ runnerId: 'machine', actor: 'viewer', name: 'My Mac' });
  ui.state.reply = input => input;
  await ui.submit();
  assert.equal(ui.calls[1].input.operationId, ui.calls[0].input.operationId);
  assert.equal(ui.calls[1].input.runnerId, 'machine');
});

test('cancel controls are limited to the requester, runner owner or project owner', () => {
  const ui = screen();
  ui.state.requests = [
    { operationId: randomUUID(), actor: 'other', runnerId: 'foreign', state: 'queued', updatedAt: 1 },
  ];
  const cancel = () =>
    ui.render().find(node => node.type === 'button' && node.props.children === 'Cancel check');
  assert.equal(cancel(), undefined);
  ui.state.requests[0].actor = 'viewer';
  assert.ok(cancel());
  ui.state.requests[0].actor = 'other';
  ui.state.requests[0].runnerId = 'machine';
  assert.ok(cancel());
  ui.state.requests[0].runnerId = 'foreign';
  ui.props.workspace.capabilities.owner = true;
  assert.ok(cancel());
});
