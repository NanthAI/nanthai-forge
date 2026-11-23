// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';

import ts from 'typescript';
import { moduleUrl } from './convex-module.mjs';
const { ToastStore, toastErrorText } = await import(moduleUrl('../web/src/ui/toast-store.ts'));

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
    'TypeError: Failed to fetch',
    'Request id: secret',
    'ConvexError: AUTH_REVOKED Your access was revoked',
  ])
    assert.equal(toastErrorText(text), "Couldn't reach Forge. Try again.");
  assert.equal(toastErrorText('Could not copy. Select the command.'), 'Could not copy. Select the command.');
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

test('W21: a coded server refusal keeps its words; only network failures read as an outage', () => {
  // Old main mapped any text with an upper-case code to "Couldn't reach Forge".
  assert.equal(toastErrorText('AUTH_REVOKED: Your access was revoked.'), 'Your access was revoked.');
  assert.equal(
    toastErrorText('WORK_STALE The Lane moved; reload and save again.'),
    'The Lane moved; reload and save again.',
  );
  const bare = toastErrorText('WORK_STALE');
  assert.doesNotMatch(bare, /reach Forge/, 'a bare code is not an outage');
  assert.doesNotMatch(bare, /WORK_STALE/, 'the code itself is not shown');
  for (const outage of ['Failed to fetch', 'Network connection failed', 'Request timed out'])
    assert.equal(toastErrorText(outage), "Couldn't reach Forge. Try again.");
});
