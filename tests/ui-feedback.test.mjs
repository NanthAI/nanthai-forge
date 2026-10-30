// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { moduleUrl } from './convex-module.mjs';
const { PendingWrite } = await import(moduleUrl('../web/src/pending-write.ts'));
const { latestAcceptedMain } = await import(moduleUrl('../web/src/shell/main-model.ts'));
const { laneTimeline } = await import(moduleUrl('../web/src/lane/timeline.ts'));

test('lost reply reconciles the original payload before a new action, with distinct identities', async () => {
  const calls = [];
  let fail = true;
  const writer = new PendingWrite(async attempt => {
    calls.push(structuredClone(attempt));
    if (fail) {
      fail = false;
      throw new Error('Unknown outcome');
    }
    return attempt.command;
  });
  const a = { action: 'note', text: 'A' },
    b = { action: 'intent-status', status: 'completed' };
  await assert.rejects(writer.send(a), /Unknown outcome/);
  assert.deepEqual(await writer.send(b), b);
  assert.deepEqual(
    calls.map(call => call.command),
    [a, a, b],
  );
  assert.equal(calls[0].operationId, calls[1].operationId);
  assert.notEqual(calls[1].operationId, calls[2].operationId);
});
test('a rejected pending replay cannot report a different draft as sent', async () => {
  const calls = [];
  const writer = new PendingWrite(async attempt => {
    calls.push(attempt);
    throw new Error('Rejected');
  });
  await assert.rejects(writer.send({ text: 'old' }));
  await assert.rejects(writer.send({ text: 'edited' }));
  assert.deepEqual(
    calls.map(call => call.command.text),
    ['old', 'old'],
  );
  assert.equal(calls[0].operationId, calls[1].operationId);
});

test('main follows retained order for equal and reversed clocks, or an explicit indexed selection', () => {
  for (const at of ['2026-10-15T12:00:00Z', '2026-10-15T11:00:00Z']) {
    const moves = [
      { id: 'a', channel: 'main', head: 'a', at: '2026-10-15T12:00:00Z' },
      { id: 'b', channel: 'main', head: 'b', at },
    ];
    assert.equal(latestAcceptedMain(moves).head, 'b');
    assert.equal(latestAcceptedMain(moves, { head: 'a' }).head, 'a');
    assert.equal(latestAcceptedMain(moves, { head: 'unloaded' }), undefined);
  }
});
test('selected Lane saves remain visible despite more than forty unrelated events', () => {
  const work = {
    lanes: [
      { id: 'selected', name: 'Selected', checkpoints: [{ at: '2020-01-01', message: 'Keep me' }] },
      ...Array.from({ length: 45 }, (_, i) => ({
        id: `other-${i}`,
        name: 'Busy',
        checkpoints: [{ at: '2026-01-01', message: 'Other' }],
      })),
    ],
    views: [],
    runs: [],
  };
  assert.equal(laneTimeline(work, 'selected')[0].detail, 'Keep me');
});

// Render actual form functions with deterministic hooks. No DOM, backend, credentials or project writes.
async function formHarness(file = 'intents/IntentParts.tsx') {
  const source = readFileSync(new URL(`../web/src/${file}`, import.meta.url), 'utf8');
  const parsed = ts.createSourceFile(
    'IntentParts.tsx',
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
    useState: initial => {
      const i = cursor++;
      if (!(i in state)) state[i] = typeof initial === 'function' ? initial() : initial;
      return [
        state[i],
        value => {
          state[i] = typeof value === 'function' ? value(state[i]) : value;
        },
      ];
    },
    useId: () => 'draft',
    useUnsavedInput: () => {},
    ErrorToast: 'error-toast',
    Button: 'button',
    Panel: 'section',
    Segmented: 'select',
    age: () => '',
  };
  hooks.useDraft = () => hooks.useState('');
  const key = `__feedback_${crypto.randomUUID().replaceAll('-', '')}`;
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
  const forms = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
  return {
    render(name, props) {
      cursor = 0;
      return forms[name](props);
    },
    clear() {
      delete globalThis[key];
    },
  };
}
const find = (tree, predicate) =>
  !tree || typeof tree !== 'object'
    ? undefined
    : predicate(tree)
      ? tree
      : [tree.props?.children]
          .flat(Infinity)
          .map(child => find(child, predicate))
          .find(Boolean);
const tick = () => new Promise(resolve => setImmediate(resolve));
test('a rejected note result keeps the actual textarea draft; success clears it', async () => {
  const h = await formHarness();
  let result = 'WORK_STALE';
  const props = { notes: [], now: 0, add: async () => result };
  let tree = h.render('Conversation', props);
  find(tree, node => node.type === 'textarea').props.onChange({ target: { value: 'Keep this decision' } });
  tree = h.render('Conversation', props);
  find(tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await tick();
  tree = h.render('Conversation', props);
  assert.equal(find(tree, node => node.type === 'textarea').props.value, 'Keep this decision');
  result = null;
  find(tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await tick();
  assert.equal(find(h.render('Conversation', props), node => node.type === 'textarea').props.value, '');
  h.clear();
});
test('failed Add Lane keeps both its name and open form', async () => {
  const h = await formHarness(),
    props = { add: async () => 'Offline' };
  h.render('AddLane', props).props.onClick();
  let tree = h.render('AddLane', props);
  find(tree, node => node.type === 'input').props.onChange({ target: { value: 'Lane draft' } });
  tree = h.render('AddLane', props);
  tree.props.onSubmit({ preventDefault() {} });
  await tick();
  assert.equal(find(h.render('AddLane', props), node => node.type === 'input').props.value, 'Lane draft');
  h.clear();
});

test('other-Channel acceptance names its destination', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { ReviewDisposition } = await import(moduleUrl('../web/src/review/ReviewDisposition.tsx'));
  const html = renderToStaticMarkup(
    createElement(ReviewDisposition, {
      acceptance: { channel: 'release', at: new Date().toISOString(), actor: { name: 'Maya' } },
    }),
  );
  assert.match(html, /Accepted into release/);
  assert.doesNotMatch(html, /Accepted into main/);
});

test('rejected request changes keeps the review draft and reports failure', async () => {
  const h = await formHarness('review/RequestChanges.tsx');
  const props = {
    draftKey: 'synthetic',
    send: async () => {
      throw new Error('Rejected');
    },
  };
  h.render('RequestChanges', props).props.children.props.onClick();
  let tree = h.render('RequestChanges', props);
  find(tree, node => node.type === 'textarea').props.onChange({ target: { value: 'Please fix this' } });
  tree = h.render('RequestChanges', props);
  find(tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await tick();
  tree = h.render('RequestChanges', props);
  assert.equal(find(tree, node => node.type === 'textarea').props.value, 'Please fix this');
  assert.equal(find(tree, node => node.type === 'error-toast').props.error, 'Rejected');
  h.clear();
});

test('conversation shows an explicit choice even when acknowledgement text is empty', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { Conversation } = await import(moduleUrl('../web/src/lane/Conversation.tsx'));
  const events = [
    {
      operationId: 'message',
      at: 0,
      command: { kind: 'message', recipient: 'agent', text: 'Choose the API shape', context: {} },
    },
    {
      operationId: 'ack',
      at: 1,
      command: { kind: 'ack', sessionId: 'agent', messageId: 'message', choice: 'Keep the API', text: '' },
    },
  ];
  const html = renderToStaticMarkup(
    createElement(Conversation, {
      events,
      sessions: [{ sessionId: 'agent', name: 'gpt-synthetic' }],
      now: 2,
    }),
  );
  assert.match(html, /Keep the API/);
  assert.match(html, /Seen by gpt-synthetic/);
});

test('toast feedback errors hide transport details and distinguish uncertain writes', async () => {
  const { feedbackError } = await import(moduleUrl('../web/src/ui/InlineError.tsx'));
  const { toastErrorText } = await import(moduleUrl('../web/src/ui/toast-store.ts'));
  assert.equal(feedbackError('Failed to fetch'), "Couldn't reach Forge. Your text is kept — try again.");
  assert.equal(toastErrorText('Error: SERVER_PRIVATE_STACK'), "Couldn't reach Forge. Try again.");
  assert.equal(
    toastErrorText('Could not copy. Select the command to copy it.'),
    'Could not copy. Select the command to copy it.',
  );
});

test('a thrown Intent write keeps its draft and sends its error to a toast', async () => {
  const h = await formHarness();
  const props = {
    notes: [],
    now: 0,
    add: async () => {
      throw new TypeError('Failed to fetch');
    },
  };
  let tree = h.render('Conversation', props);
  find(tree, node => node.type === 'textarea').props.onChange({ target: { value: 'Keep this note' } });
  tree = h.render('Conversation', props);
  find(tree, node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await tick();
  tree = h.render('Conversation', props);
  assert.equal(find(tree, node => node.type === 'textarea').props.value, 'Keep this note');
  const error = find(
    find(tree, node => node.type === 'form'),
    node => node.type === 'error-toast',
  );
  assert.equal(error.props.error, 'Failed to fetch');
  h.clear();
});
