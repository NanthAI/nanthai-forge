// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { moduleUrl } from './convex-module.mjs';
const { ToastStore, toastErrorText } = await import(moduleUrl('../web/src/ui/toast-store.ts'));
const { PendingWrite } = await import(moduleUrl('../web/src/pending-write.ts'));

test('toast queue dedupes identical messages, keeps errors and orders newest first', () => {
  const store = new ToastStore();
  const first = store.show({ message: 'Could not save this note.' });
  store.show({ message: 'Saved.', tone: 'success' });
  assert.equal(store.show({ message: 'Could not save this note.' }), first);
  assert.equal(store.snapshot()[0].count, 2);
  assert.equal(store.snapshot()[0].tone, 'error');
  store.show({ message: 'Could not read source.' });
  store.show({ message: 'Could not copy.' });
  assert.equal(store.snapshot().length, 4, 'the fourth is queued, never lost');
  store.dismiss(store.snapshot()[0].id);
  assert.equal(store.snapshot().length, 3);
});

test('Retry stays pending, rejects double clicks, retains failure, then dismisses on success', async () => {
  const store = new ToastStore();
  let calls = 0,
    complete;
  const id = store.show({
    message: 'Could not save.',
    retry: () => {
      calls++;
      return new Promise(resolve => {
        complete = resolve;
      });
    },
  });
  const running = store.retry(id);
  await store.retry(id);
  assert.equal(calls, 1);
  assert.equal(store.snapshot()[0].busy, true);
  complete(false);
  await running;
  assert.equal(store.snapshot()[0].busy, false);
  const success = store.retry(id);
  complete(true);
  await success;
  assert.equal(store.snapshot().length, 0);
});

test('connection loss has one toast across observers, suppresses query noise and recovers', () => {
  const store = new ToastStore();
  store.connection('local', true);
  store.connection('browser', true);
  store.show({ message: 'Failed to fetch' });
  store.show({ message: 'Network connection failed' });
  assert.equal(store.snapshot().length, 1);
  assert.equal(store.snapshot()[0].message, 'Reconnecting…');
  assert.equal(store.snapshot()[0].count, 1);
  store.connection('local', false);
  assert.equal(store.snapshot().length, 1);
  store.connection('browser', false);
  assert.equal(store.snapshot().length, 0);
});

test('transport details and server codes never appear in error toasts', () => {
  for (const text of [
    'Error: private stack at method()',
    'WORK_STALE',
    'TypeError: Failed to fetch',
    'Request id: secret',
  ])
    assert.equal(toastErrorText(text), "Couldn't reach Forge. Try again.");
  assert.equal(toastErrorText('Could not copy. Select the command.'), 'Could not copy. Select the command.');
});

test('actual acknowledge hook reports failure to toast and Retry reuses its operation id', async () => {
  const source = readFileSync(new URL('../web/src/cockpit/coordination.ts', import.meta.url), 'utf8');
  const parsed = ts.createSourceFile('coordination.ts', source, 99, true);
  const fn = parsed.statements.find(
    node => ts.isFunctionDeclaration(node) && node.name?.text === 'useAnswers',
  );
  const store = new ToastStore(),
    calls = [];
  let failNextAck = false;
  const hooks = {
    // The overlap writer is exercised by the mounted Now overlap fixture; this harness isolates message retries.
    useOverlapAnswers: () => ({
      error: '',
      acknowledgeOverlaps: () => {
        throw new Error('Unexpected overlap answer in a message retry');
      },
    }),
    useToast: () => store,
    useRef: value => ({ current: value }),
    useState: value => [value, () => {}],
    PendingWrite,
    hostedError: () => 'Could not acknowledge this message.',
    api: { projectCoordination: { publish: {} } },
    useMutation: () => async attempt => {
      calls.push(attempt);
      if (calls.length === 1 || (failNextAck && attempt.command.kind === 'ack')) {
        failNextAck = false;
        throw new Error('synthetic failure');
      }
    },
  };
  const key = `__toast_${crypto.randomUUID().replaceAll('-', '')}`;
  globalThis[key] = hooks;
  try {
    const code = ts.transpileModule(
      `const {${Object.keys(hooks).join(',')}} = globalThis.${key};\n${fn.getText(parsed)}`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
    ).outputText;
    const { useAnswers } = await import(
      `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
    );
    const answers = useAnswers('synthetic');
    assert.equal(await answers.acknowledge('message', 'Read.'), false);
    const failure = store.snapshot()[0];
    assert.equal(failure.message, 'Could not acknowledge this message.');
    assert.equal(typeof failure.retry, 'function');
    await store.retry(failure.id);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].operationId, calls[1].operationId);
    assert.deepEqual(calls[0].command, calls[1].command);
    assert.equal(store.snapshot()[0].tone, 'success');
    failNextAck = true;
    assert.equal(await answers.reply('reply-message', 'sender', 'Keep this text'), false);
    const replyFailure = store.snapshot().find(entry => entry.tone === 'error');
    await store.retry(replyFailure.id);
    const replyCalls = calls.filter(call => call.command.kind === 'message');
    const ackCalls = calls.filter(call => call.command.messageId === 'reply-message');
    assert.equal(replyCalls.length, 1, 'retrying the ack cannot send the successful reply twice');
    assert.equal(ackCalls.length, 2);
    assert.equal(ackCalls[0].operationId, ackCalls[1].operationId);
  } finally {
    delete globalThis[key];
  }
});

test('provider shares one store with consumers and renders three accessible escaped notifications', async () => {
  const { createElement: h } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { ToastProvider, useToast } = await import(moduleUrl('../web/src/ui/Toast.tsx'));
  const store = new ToastStore();
  store.show({ message: 'Could not read section one.' });
  store.show({ message: 'Saved.', tone: 'success' });
  store.show({ message: 'Could not read section two.' });
  store.show({ message: 'Could not render <img src=x>.' });
  let observed;
  function Consumer() {
    observed = useToast();
    return h('main', null, 'Page');
  }
  const html = renderToStaticMarkup(h(ToastProvider, { store }, h(Consumer)));
  assert.equal(observed, store);
  assert.equal((html.match(/class="fx-toast fx-toast-/g) ?? []).length, 3);
  assert.equal((html.match(/role="alert"/g) ?? []).length, 2);
  assert.equal((html.match(/role="status"/g) ?? []).length, 1);
  assert.match(html, /Could not render &lt;img src=x&gt;/);
  assert.match(html, /<span hidden="" id="forge-toast-1">/);
  assert.doesNotMatch(html, /<img/);
});
