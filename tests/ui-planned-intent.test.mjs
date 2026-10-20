// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { moduleUrl } from './convex-module.mjs';
const { IntentDetailView } = await import(moduleUrl('../web/src/intents/IntentDetail.tsx'));
const { StatusMenu } = await import(moduleUrl('../web/src/intents/StatusMenu.tsx'));
const at = '2026-10-17T12:00:00Z';
const item = {
  id: 'planned',
  operationId: 'origin',
  kind: 'issue',
  title: 'Measure review payloads',
  body: 'Summary',
  version: 3,
  previousVersion: 2,
  status: 'open',
  intentIds: ['intent'],
  initiativeId: 'f10',
  at,
};
const detail = {
  row: {
    id: 'intent',
    outcome: item.title,
    constraints: item.body,
    planned: true,
    status: 'active',
    label: 'Planned',
    tone: 'plain',
    lanes: [],
    open: [],
    notes: 0,
    decisions: 0,
  },
  notes: [],
  views: [],
  planning: [],
  now: Date.parse(at),
  laneHref: id => `/lane/${id}`,
};
const find = (tree, predicate) =>
  !tree || typeof tree !== 'object'
    ? undefined
    : predicate(tree)
      ? tree
      : [tree.props?.children]
          .flat(Infinity)
          .map(child => find(child, predicate))
          .find(Boolean);
async function harness() {
  const source = readFileSync(new URL('../web/src/PlanningIntents.tsx', import.meta.url), 'utf8');
  const parsed = ts.createSourceFile(
    'PlanningIntents.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let clean = source;
  for (const statement of [...parsed.statements].reverse())
    if (ts.isImportDeclaration(statement)) clean = clean.slice(0, statement.pos) + clean.slice(statement.end);
  const state = [];
  let cursor = 0;
  const hooks = {
    useState: value => {
      const index = cursor++;
      if (!(index in state)) state[index] = typeof value === 'function' ? value() : value;
      return [
        state[index],
        next => {
          state[index] = typeof next === 'function' ? next(state[index]) : next;
        },
      ];
    },
    useEffect: () => {},
    useRef: value => {
      const index = cursor++;
      return (state[index] ??= { current: value });
    },
    IntentDetailView: 'detail',
    IntentEditForm: 'edit-form',
    StatusMenu: 'status-menu',
    Breadcrumbs: 'crumbs',
    ErrorToast: 'error-toast',
    Glyph: 'glyph',
    age: () => '3 d ago',
    workHref: () => '/work',
    planningDestination: value => value,
  };
  const key = `__planned_${crypto.randomUUID().replaceAll('-', '')}`;
  globalThis[key] = hooks;
  const js = ts
    .transpileModule(`const { ${Object.keys(hooks).join(',')} } = globalThis.${key};\n${clean}`, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.ReactJSX,
        target: ts.ScriptTarget.ES2022,
      },
    })
    .outputText.replace('"react/jsx-runtime"', JSON.stringify(import.meta.resolve('react/jsx-runtime')));
  const { PlanningIntentPage } = await import(
    `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`
  );
  return {
    render: props => {
      cursor = 0;
      return PlanningIntentPage({ item, initiatives: [], detail, ...props });
    },
    clear: () => delete globalThis[key],
  };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test('Planned page has Details before Lanes, one side column and no Candidates or Open Intent', () => {
  const html = renderToStaticMarkup(h(IntentDetailView, { ...detail, canStart: false }));
  assert.ok(html.indexOf('<h2>Details</h2>') < html.indexOf('<h2>Lanes</h2>'));
  assert.match(html, /Copy start command/);
  assert.doesNotMatch(html, /<h2>Candidates|Open Intent|role="tablist"/);
  assert.equal((html.match(/<h2>Conversation/g) ?? []).length, 1);
});
test('status menu has exact open and closed choices and never manually starts In motion', () => {
  const tree = StatusMenu({ label: 'Planned', tone: 'plain', closed: false, planned: true, onAction() {} });
  const motion = find(tree, node => node.props?.title === 'starts with the first Lane');
  assert.equal(motion.props.disabled, true);
  for (const label of ['Proposed', 'Planned', 'Mark done', 'Abandon…'])
    assert.ok(
      find(tree, node => [node.props?.children].flat().includes(label)),
      label,
    );
  const closed = StatusMenu({ label: 'Done', tone: 'passed', closed: true, onAction() {} });
  assert.equal(closed.props.children.props.children, 'Reopen');
});
test('Mark done hydrates full bytes, retains relationships and writes a new version without reload', async () => {
  const harnessed = await harness();
  const calls = [];
  const props = {
    loadItem: async () => ({ ...item, body: 'Full body beyond the summary' }),
    act: async command => {
      calls.push(command);
      return { operationId: command.operationId };
    },
  };
  let page = find(harnessed.render(props), node => node.type === 'detail');
  page.props.statusControl.props.onAction('complete');
  await tick();
  page = find(harnessed.render(props), node => node.type === 'detail');
  assert.equal(page.props.row.label, 'Done');
  assert.equal(calls[0].expectedVersion, 3);
  assert.equal(calls[0].status, 'closed');
  assert.equal(calls[0].body, 'Full body beyond the summary');
  assert.deepEqual(calls[0].intentIds, ['intent']);
  assert.equal(calls[0].initiativeId, 'f10');
  assert.match(page.props.timeline[0].detail, /version 4/);
  harnessed.clear();
});
test('failed status keeps the pill and retry reconciles the same operation', async () => {
  const harnessed = await harness();
  const calls = [];
  let fail = true;
  const props = {
    act: async command => {
      calls.push(command);
      if (fail) throw new Error('Offline');
      return { operationId: command.operationId };
    },
  };
  find(harnessed.render(props), node => node.type === 'detail').props.statusControl.props.onAction(
    'complete',
  );
  await tick();
  assert.equal(find(harnessed.render(props), node => node.type === 'detail').props.row.label, 'Planned');
  assert.equal(find(harnessed.render(props), node => node.type === 'error-toast').props.error, 'Offline');
  fail = false;
  props.item = { ...item, version: 4, operationId: calls[0].operationId };
  find(harnessed.render(props), node => node.type === 'detail').props.statusControl.props.onAction(
    'complete',
  );
  await tick();
  assert.equal(calls[0].operationId, calls[1].operationId);
  assert.equal(calls[1].expectedVersion, 3);
  assert.equal(find(harnessed.render(props), node => node.type === 'detail').props.row.label, 'Done');
  harnessed.clear();
});
test('Edit changes the header in place, preserves full details and saves on the same page', async () => {
  const harnessed = await harness();
  const calls = [];
  let loadedVersion = 3;
  const props = {
    loadItem: async () => ({ ...item, version: loadedVersion, body: 'Full details' }),
    act: async command => {
      calls.push(command);
      return { operationId: command.operationId };
    },
  };
  find(harnessed.render(props), node => node.type === 'detail').props.onEdit();
  await tick();
  let page = find(harnessed.render(props), node => node.type === 'detail');
  assert.equal(page.props.editor.props.body, 'Full details');
  page.props.editor.props.onTitle('Edited outcome');
  page = find(harnessed.render(props), node => node.type === 'detail');
  assert.equal(page.props.row.outcome, 'Edited outcome');
  loadedVersion = 4;
  await page.props.editor.props.save({ title: 'Edited outcome', body: 'Full details', initiativeId: '' });
  page = find(harnessed.render(props), node => node.type === 'detail');
  assert.equal(page.props.row.outcome, 'Edited outcome');
  assert.equal(page.props.editor, undefined);
  assert.equal(calls[0].initiativeId, undefined);
  assert.equal(calls[0].expectedVersion, 3);
  harnessed.clear();
});
test('native lifecycle uses existing owner actions; read-only pages expose no status or edit writes', async () => {
  const harnessed = await harness();
  const calls = [];
  const props = {
    lifecycle: {
      complete: () => calls.push('complete'),
      abandon: () => calls.push('abandon'),
      reopen: () => calls.push('reopen'),
    },
  };
  const page = find(harnessed.render(props), node => node.type === 'detail');
  for (const action of ['complete', 'abandon', 'reopen']) page.props.statusControl.props.onAction(action);
  assert.deepEqual(calls, ['complete', 'abandon', 'reopen']);
  const readOnly = find(harnessed.render({ ...props, readOnly: true }), node => node.type === 'detail');
  assert.equal(readOnly.props.onEdit, undefined);
  assert.equal(readOnly.props.statusControl, undefined);
  harnessed.clear();
});
