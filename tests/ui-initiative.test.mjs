// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { moduleUrl } from './convex-module.mjs';
const model = await import(moduleUrl('../web/src/planning-rows.ts'));
const { InitiativePage, InitiativeConversation } = await import(
  moduleUrl('../web/src/planning/InitiativePage.tsx')
);
const { destination, options } = await import('../scripts/ui-shots/options.mjs');
const at = '2026-10-01T10:00:00Z';
const item = (id, extra = {}) => ({
  id,
  operationId: id,
  kind: 'initiative',
  title: id,
  body: 'Details',
  status: 'open',
  version: 1,
  at,
  intentIds: [],
  ...extra,
});
const initiative = item('initiative', { intentIds: ['planned', 'ready', 'done', 'working'] });
const intents = [
  { id: 'planned', outcome: 'Plan the follow-up', status: 'active', createdAt: at },
  {
    id: 'done',
    outcome: 'The landed work',
    status: 'completed',
    createdAt: at,
    lifecycle: [
      {
        from: 'active',
        to: 'completed',
        at: '2026-10-03T10:00:00Z',
        actor: { kind: 'person', name: 'Dino' },
      },
    ],
  },
  { id: 'ready', outcome: 'Ready for review', status: 'ready', createdAt: at },
  {
    id: 'working',
    outcome: 'Working now',
    status: 'active',
    createdAt: at,
    agentStart: { laneId: 'started' },
  },
];
const lanes = [
  { intentId: 'ready', startedBy: { kind: 'agent', name: 'gpt-builder' } },
  { id: 'started', intentId: 'working', checkpoints: [{ at: '2026-10-04T10:00:00Z' }] },
];
const data = {
  revision: 1,
  intents,
  lanes,
  planningItems: [initiative, item('child', { initiativeId: initiative.id }), item('parent')],
  planningComments: [],
  hostedEvents: [],
};
const rows = model.planningGroups(data.planningItems, intents, lanes)[0].rows;
const props = {
  item: initiative,
  data,
  busy: false,
  href: (kind, id) => `/${kind}/${id}`,
  listHref: '/planning',
  onCreate() {},
  onEdit() {},
  onStatus() {},
  onExport() {},
  conversation: h(InitiativeConversation, { itemId: initiative.id, data, busy: false, act: async () => {} }),
};

test('Initiative progress is derived from its own rows; completion requires the recorded closed state', () => {
  assert.deepEqual(model.initiativeProgress(initiative, rows), {
    total: 4,
    done: 1,
    motion: 2,
    label: 'In motion',
  });
  assert.equal(
    model.initiativeProgress(
      initiative,
      rows.filter(row => row.label === 'Planned'),
    ).label,
    'Planned',
  );
  assert.equal(
    model.initiativeProgress(
      initiative,
      rows.filter(row => row.label === 'Done'),
    ).label,
    'Planned',
  );
  assert.equal(model.initiativeProgress({ ...initiative, status: 'closed' }, rows).label, 'Done');
  assert.equal(model.initiativeProgress(initiative, []).label, 'Planned');
});
test('Initiative rows put Ready/Working before Planned and Done without mutating source order', () => {
  assert.deepEqual(
    model.initiativeRows(rows).map(row => row.id),
    ['ready', 'working', 'planned', 'done'],
  );
  assert.deepEqual(
    rows.map(row => row.id),
    ['planned', 'ready', 'done', 'working'],
  );
});
test('child Initiatives flatten deeper nesting, exclude unrelated records, and tolerate cycles', () => {
  const items = [
    initiative,
    item('child', { initiativeId: 'initiative' }),
    item('grandchild', { initiativeId: 'child' }),
    item('other'),
    item('cycle-a', { initiativeId: 'cycle-b' }),
    item('cycle-b', { initiativeId: 'cycle-a' }),
  ];
  assert.deepEqual(
    model.childInitiatives(items, 'initiative').map(row => row.id),
    ['child', 'grandchild'],
  );
  assert.equal(model.childInitiatives(items, 'absent').length, 0);
});
test('Initiative timeline merges lifecycle events newest first and excludes saves and fabricated closure times', () => {
  const events = model.initiativeTimeline(initiative, rows, intents, lanes);
  assert.equal(events[0].label, 'Intent done');
  assert.equal(events[0].at, '2026-10-03T10:00:00Z');
  assert.match(events[0].detail, /by Dino/);
  assert.ok(events.some(event => event.label === 'Intent in motion'));
  assert.ok(events.every(event => !event.label.includes('save')));
  assert.equal(events.filter(event => event.label === 'Intent done').length, 1);
  const unknown = model.initiativeTimeline(
    { ...initiative, version: 2 },
    rows,
    intents.map(intent => ({ ...intent, lifecycle: [] })),
    [],
  );
  assert.ok(unknown.every(event => event.label !== 'Created' && event.label !== 'Intent done'));
});
test('Initiative uses the shared detail layout and WorkRows, with parent and child destinations', () => {
  const html = renderToStaticMarkup(
    h(InitiativePage, { ...props, item: { ...initiative, initiativeId: 'parent' } }),
  );
  assert.match(html, /fx-detail-grid/);
  // Hosted renders it inside the legacy planning section; its own cockpit scope keeps it full width.
  assert.match(html, /^<div class="fx-page fx-detail fx /);
  assert.match(html, /href="\/initiative\/parent"/);
  assert.match(html, /href="\/initiative\/child"/);
  assert.match(html, />Timeline<\/h2>/);
  assert.match(html, />Conversation<\/h2>/);
  assert.equal((html.match(/class="fx-wr-title"/g) ?? []).length, 4);
  assert.ok(html.indexOf('Ready for review') < html.indexOf('Plan the follow-up'));
  assert.match(html, /by gpt-builder/);
  assert.doesNotMatch(html, /Open Intent|Discussion name|PageTabs/);
});
test('read-only Initiative retains progress, rows and conversation but no mutation controls', () => {
  const html = renderToStaticMarkup(
    h(InitiativePage, {
      ...props,
      readOnly: true,
      conversation: h(InitiativeConversation, {
        itemId: initiative.id,
        data,
        busy: false,
        readOnly: true,
        act: async () => {},
      }),
    }),
  );
  assert.match(html, /1 of 4 done/);
  assert.match(html, /fx-wr-title/);
  assert.doesNotMatch(html, /Add Intent|>Edit<|>Send<|Initiative status/);
});
test('screenshot tooling accepts Initiative routes without changing the selected project', () => {
  assert.deepEqual(
    options(['--base', 'http://localhost:5179', '--out', '/tmp/ui', '--pages', 'initiative:abc']).pages,
    ['initiative:abc'],
  );
  const url = new URL(destination('http://localhost:5179', 'project', 'initiative:abc'));
  assert.equal(url.searchParams.get('projectTab'), 'planning');
  assert.equal(url.searchParams.get('planningItem'), 'abc');
  assert.equal(url.searchParams.get('planningRoute'), 'initiative:abc');
  assert.equal(url.searchParams.get('project'), 'project');
});

// Run the real handlers with deferred replies, independently of the browser fixture.
async function conversationHarness(act) {
  const { readFileSync } = await import('node:fs');
  const { runInNewContext } = await import('node:vm');
  const { randomUUID } = await import('node:crypto');
  const { default: ts } = await import('typescript');
  const values = [],
    effects = [];
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
    useEffect(effect) {
      effects.push(effect);
    },
  };
  const jsx = (type, props) => ({ type, props });
  const output = {};
  const code = ts.transpileModule(
    readFileSync(new URL('../web/src/planning/InitiativePage.tsx', import.meta.url), 'utf8'),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
      },
    },
  ).outputText;
  runInNewContext(code, {
    exports: output,
    crypto: { randomUUID },
    require: name =>
      name === 'react'
        ? hooks
        : name === 'react/jsx-runtime'
          ? { jsx, jsxs: jsx }
          : name === '../ui/status'
            ? { age: () => 'now' }
            : {},
  });
  const props = { itemId: 'initiative', data: { planningComments: [] }, busy: false, act };
  const nodes = root =>
    !root || typeof root !== 'object'
      ? []
      : Array.isArray(root)
        ? root.flatMap(nodes)
        : [root, ...nodes(root.props?.children)];
  const render = () => {
    cursor = 0;
    effects.length = 0;
    return nodes(output.InitiativeConversation(props));
  };
  const field = () => render().find(node => node.type === 'input');
  return {
    props,
    field,
    type(text) {
      field().props.onChange({ target: { value: text } });
    },
    send() {
      return render()
        .find(node => node.type === 'form')
        .props.onSubmit({ preventDefault() {} });
    },
    flush() {
      render();
      for (const effect of effects) effect();
    },
  };
}

test('conversation retry retains its UUID and suppresses a second submission while a reply is pending', async () => {
  const commands = [];
  let respond;
  const ui = await conversationHarness(command => {
    commands.push(command);
    return new Promise(resolve => {
      respond = resolve;
    });
  });
  ui.type('A recorded question');
  const sending = ui.send();
  await ui.send();
  assert.equal(commands.length, 1);
  respond({ operationId: 'wrong-reply' });
  await sending;
  const retry = ui.send();
  assert.equal(commands[1].operationId, commands[0].operationId);
  respond({ operationId: commands[0].operationId });
  await retry;
  assert.equal(ui.field().props.value, '');
});
test('an acknowledgement never clears text typed while the previous comment was sending', async () => {
  let respond, original;
  const ui = await conversationHarness(command => {
    original = command;
    return new Promise(resolve => {
      respond = resolve;
    });
  });
  ui.type('First comment');
  const sending = ui.send();
  ui.type('My newer draft');
  respond({ operationId: original.operationId });
  await sending;
  assert.equal(ui.field().props.value, 'My newer draft');
});
test('observed comment identity reconciles a successful write even when the action returns no acknowledgement', async () => {
  let original;
  const ui = await conversationHarness(async command => {
    original = command;
  });
  ui.type('A local comment');
  await ui.send();
  ui.props.data.planningComments = [
    { id: original.operationId, itemId: 'initiative', text: original.text, at },
  ];
  ui.flush();
  assert.equal(ui.field().props.value, '');
});

test('hosted screenshot readiness requires the real Initiative component, not the temporary Planning fallback', async () => {
  const { waitForPage } = await import('../scripts/ui-shots/browser.mjs');
  const { runInNewContext } = await import('node:vm');
  for (const mounted of [true, false]) {
    const heading = { textContent: 'Synthetic Initiative', getClientRects: () => [{}], closest: () => null };
    const main = {
      querySelectorAll: selector => (selector === '[role="alert"]' ? [] : [heading]),
      querySelector: () => mounted,
    };
    let result;
    await waitForPage(
      {
        waitForFunction(fn) {
          result = runInNewContext(`(${fn})('initiative')`, {
            document: { querySelector: () => main },
            window: { Clerk: { user: {} } },
            getComputedStyle: () => ({ visibility: 'visible' }),
          });
        },
        evaluate: async () => {},
      },
      'initiative',
    );
    assert.equal(result, mounted);
  }
});

test('editing an Initiative retains the original creation event when its recorded first version is loaded', () => {
  const html = renderToStaticMarkup(
    h(InitiativePage, {
      ...props,
      item: { ...initiative, version: 2, at: '2026-10-04T10:00:00Z' },
      origin: initiative,
    }),
  );
  assert.match(html, /created <time title="2026-10-01T10:00:00Z"/);
  assert.match(html, />Created<\/div>/);
});
test('a legacy Intent edit timestamp is not displayed as its planning event', () => {
  const legacy = item('legacy', { kind: 'issue', initiativeId: initiative.id, version: 2 });
  const groups = model.planningGroups([initiative, legacy], [], []);
  const events = model.initiativeTimeline(initiative, groups[0].rows, [], []);
  assert.equal(
    events.some(event => event.label === 'Intent planned'),
    false,
  );
});

test('abandoned Initiative stays readable, keeps children Planned and exposes a versioned Timeline', () => {
  const abandoned = {
    ...initiative,
    status: 'abandoned',
    version: 2,
    previousVersion: 1,
    operationId: 'abandon-group',
    reason: 'Different direction',
  };
  const html = renderToStaticMarkup(
    h(InitiativePage, { ...props, item: abandoned, versions: [initiative, abandoned], origin: initiative }),
  );
  assert.match(html, /Abandoned/);
  assert.match(html, /Different direction/);
  assert.match(html, /version 2/);
  assert.match(html, /Initiative status/);
  assert.equal(model.initiativeProgress(abandoned, [{ label: 'Planned' }]).label, 'Abandoned');
});
test('planning lifecycle buckets count unlinked Proposed and Abandoned once, including unified records', () => {
  const proposed = item('proposal', {
    kind: 'issue',
    status: 'proposed',
    initiativeId: undefined,
    intentIds: [],
  });
  const abandoned = item('abandoned', {
    kind: 'issue',
    status: 'abandoned',
    initiativeId: undefined,
    intentIds: [],
  });
  const groups = model.planningGroups([proposed, abandoned], [], []);
  assert.equal(groups.find(group => group.id === 'proposed').rows[0].label, 'Proposed');
  const rows = groups.flatMap(group => group.rows);
  assert.equal(rows.filter(row => model.planningRowMatches(row, 'proposed')).length, 1);
  assert.equal(rows.filter(row => model.planningRowMatches(row, 'done')).length, 1);
  const unified = model.planningGroups(
    [proposed],
    [{ id: 'proposal', outcome: proposed.title, status: 'proposed' }],
    [],
  );
  assert.equal(unified.flatMap(group => group.rows).length, 1);
});

test('Initiative creation byline uses the recorded origin actor and omits unknown authors', () => {
  const known = renderToStaticMarkup(
    h(InitiativePage, { ...props, origin: { ...initiative, actorDisplayName: 'Dino' } }),
  );
  assert.match(known, /created <time[^>]*>.*?<\/time> by Dino/);
  assert.match(known, /by Dino<\/a>/);
  const events = model.initiativeTimeline(initiative, [], [], []);
  assert.equal(events[0].detail, '');
  const markup = renderToStaticMarkup(h(InitiativePage, props));
  assert.doesNotMatch(markup, /created <time[^>]*>.*?<\/time> by /);
});

test('Initiative planned events use the creator recorded at creation, not a later Lane holder', () => {
  const source = {
    ...intents[0],
    lifecycle: [{ from: '', to: 'active', at, actor: { kind: 'person', name: 'Maya' } }],
  };
  const events = model.initiativeTimeline(
    initiative,
    rows,
    [source],
    [{ intentId: source.id, startedBy: { kind: 'agent', name: 'Different holder' } }],
  );
  const planned = events.find(event => event.id === `${source.id}:planned`);
  assert.match(planned.detail, /^by Maya · /);
  assert.doesNotMatch(planned.detail, /Different holder/);
});
