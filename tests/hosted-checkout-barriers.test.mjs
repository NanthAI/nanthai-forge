// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from '../dist/hash.js';
import { agentFixture } from './hosted-agent-fixture.mjs';

test('checkout drains file and directory barriers on failure and preserves the prior root', async t => {
  const s = agentFixture(t);
  await s.transport().dispatch('open', { laneId: s.lane.laneId });
  const marker = join(s.root, '.forge', 'hosted-lane.json'),
    before = readFileSync(marker);
  const bytes = Buffer.from('new source'),
    blob = digest(bytes);
  const state = Buffer.from(
    JSON.stringify({
      schema: 1,
      kind: 'forge-source-state',
      parents: [],
      files: [{ path: 'changed.bin', blob, mode: 'file' }],
      message: 'synthetic',
      at: '2026-01-01T00:00:00Z',
    }),
  );
  s.objects.set(blob, bytes);
  s.objects.set(digest(state), state);
  Object.assign(s.lane, { head: digest(state), sourceVersion: 1, version: 1 });
  const original = fs.open;
  t.after(() => {
    fs.open = original;
    syncBuiltinESMExports();
  });
  let opened = 0,
    closed = 0;
  fs.open = async (...args) => {
    const handle = await original(...args);
    if (!String(args[0]).includes('/checkout-')) return handle;
    opened++;
    const sync = handle.sync.bind(handle),
      close = handle.close.bind(handle);
    handle.sync = async () => {
      if (String(args[0]).endsWith('changed.bin')) throw new Error('synthetic file fsync failure');
      await sync();
    };
    handle.close = async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      await close();
      closed++;
    };
    return handle;
  };
  syncBuiltinESMExports();
  await assert.rejects(s.transport().dispatch('open', { laneId: s.lane.laneId, operationId: randomUUID() }), {
    code: 'HOSTED_ACTION_FAILED',
  });
  assert(opened > 1, 'both barrier groups ran');
  assert.equal(closed, opened);
  assert.deepEqual(readFileSync(marker), before);
  assert.throws(() => readFileSync(join(s.root, 'changed.bin')), { code: 'ENOENT' });
});
