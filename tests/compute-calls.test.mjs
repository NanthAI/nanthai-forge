// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { state, job } from './hosted-fixture.mjs';
import { tokenKeys } from '../dist/device-token.js';
const { watchImport } = await import(moduleUrl('../web/src/import-watch.ts'));
const status = await import(moduleUrl('../convex/importStatus.ts'));
const sync = await import(moduleUrl('../convex/sync.ts'));

test('idle import subscription makes zero periodic action calls per minute and hour', t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const oldWindow = globalThis.window;
  globalThis.window = new EventTarget();
  t.after(() => {
    globalThis.window = oldWindow;
  });
  let baseline = 0;
  const oldPoll = setInterval(() => baseline++, 5000);
  t.mock.timers.tick(3_600_000);
  clearInterval(oldPoll);
  assert.equal(baseline, 720);
  let listener,
    value = 'initial',
    calls = 0,
    detached = false;
  const client = {
    watchQuery: () => ({
      onUpdate: callback => {
        listener = callback;
        return () => {
          detached = true;
        };
      },
      localQueryResult: () => value,
    }),
  };
  const stop = watchImport(client, 'own', () => calls++);
  assert.equal(calls, 1); // Initial authorized action is not periodic work.
  calls = 0;
  for (let minute = 0; minute < 60; minute++) {
    t.mock.timers.tick(60_000);
    listener(); // Duplicate delivery/reconnect with identical value is also quiet.
    assert.equal(calls, 0, `idle minute ${minute + 1}`);
  }
  value = 'changed';
  listener();
  assert.equal(calls, 1);
  window.dispatchEvent(new Event('focus'));
  window.dispatchEvent(new Event('online'));
  assert.equal(calls, 3);
  stop();
  window.dispatchEvent(new Event('focus'));
  assert.equal(calls, 3);
  assert.equal(detached, true);
  const app = readFileSync(new URL('../web/src/App.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /setInterval/);
  assert.match(app, /hosted\.subscribeStatus/);
  t.diagnostic(
    'Same fake clock: before 720 periodic calls/tab-hour; after 0; startup, changed-state and focus calls counted separately.',
  );
});

test('invalidation is opaque, excludes read observations, and tracks derivative/head/revocation', async () => {
  const s = state([job()]);
  const watch = () => status.watch._handler(s.ctx, { id: 'own' });
  const first = await watch();
  assert.match(first, /^[0-9a-f]{64}$/);
  const row = s.tables.imports.get('own');
  row.sync = { result: 'checked', head: 'a'.repeat(40), checkedAt: 1 };
  const checked = await watch();
  assert.notEqual(checked, first);
  row.sync.checkedAt++;
  row.syncRevision = 999;
  assert.equal(await watch(), checked);
  row.syncEventRevision = 1000;
  assert.notEqual(await watch(), checked);
  delete row.syncEventRevision;
  row.sync.head = 'b'.repeat(40);
  assert.notEqual(await watch(), checked);
  row.removal = 'trash';
  assert.equal(await watch(), null);
  delete row.removal;
  s.caller('stranger');
  assert.equal(await watch(), null);
});

test('signing-key derivation memo reuses the same key and invalidates on rotation', () => {
  const key = () =>
    generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  const a = key(),
    b = key();
  const first = tokenKeys(a);
  assert.equal(tokenKeys(a), first);
  assert.equal('d' in first.jwk, false);
  const rotated = tokenKeys(b);
  assert.notEqual(rotated.kid, first.kid);
  assert.equal(tokenKeys(b), rotated);
  assert.throws(() => tokenKeys('invalid key'));
  assert.equal(tokenKeys(b), rotated);
});

test('webhook invalidation survives an overlapping status-read observation', async () => {
  const s = state([job()]);
  const watch = () => status.watch._handler(s.ctx, { id: 'own' });
  const before = await watch();
  const event = await sync.begin._handler(s.ctx, { id: 'own', event: true });
  const changed = await watch();
  assert.notEqual(changed, before);
  const read = await sync.begin._handler(s.ctx, { id: 'own' });
  assert.equal(await watch(), changed);
  const observation = { checkedAt: 1, result: 'checked', head: 'a'.repeat(40) };
  assert.equal(await sync.finish._handler(s.ctx, { id: 'own', revision: read, observation }), true);
  assert.equal(await sync.finish._handler(s.ctx, { id: 'own', revision: event, observation }), false);
  assert.equal(s.tables.imports.get('own').syncEventRevision, 1);
});
