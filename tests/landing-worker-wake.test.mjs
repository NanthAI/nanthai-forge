// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processIdentity } from '../dist/local-process.js';
import { saveLandingWorkerState } from '../dist/landing-worker-status.js';
import { wakeLandingWorker } from '../dist/landing-worker-wake.js';

const self = '00000000-0000-4000-8000-000000000001';
const peer = '00000000-0000-4000-8000-000000000002';
const turn = () => new Promise(resolve => setImmediate(resolve));
function fixture(t) {
  const store = { directory: mkdtempSync(join(tmpdir(), 'forge-worker-wake-')) };
  const sent = [];
  t.mock.method(net, 'createConnection', endpoint => {
    sent.push(endpoint);
    return Object.assign(new EventEmitter(), { setTimeout() {}, destroy() {}, end() {} });
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(store.directory, { recursive: true, force: true });
  });
  for (const [id, endpoint] of [
    [self, 'synthetic-self'],
    [peer, 'synthetic-peer'],
  ])
    saveLandingWorkerState(store, {
      schema: 1,
      id,
      worker: processIdentity(),
      status: 'idle',
      endpoint,
      observedAt: new Date().toISOString(),
    });
  return { store, sent };
}

test('peer release wakes other workers without waking its own controller', async t => {
  const { store, sent } = fixture(t);
  for (let i = 0; i < 10; i++) wakeLandingWorker(store, self);
  await turn();
  assert.deepEqual(sent, ['synthetic-peer']);
});

test('a coalesced Work publication still wakes the releasing controller', async t => {
  const { store, sent } = fixture(t);
  wakeLandingWorker(store, self);
  wakeLandingWorker(store);
  await turn();
  assert.deepEqual(sent.sort(), ['synthetic-peer', 'synthetic-self']);
});

test('coalesced releases from different controllers retain both recipients', async t => {
  const { store, sent } = fixture(t);
  wakeLandingWorker(store, self);
  wakeLandingWorker(store, peer);
  await turn();
  assert.deepEqual(sent.sort(), ['synthetic-peer', 'synthetic-self']);
});
