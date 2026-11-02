// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from '../dist/hash.js';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { checkoutIoCapacity, checkoutVolumeCapacity } from '../dist/checkout-io.js';
import { checkoutHostedLane } from '../dist/hosted-lane-checkout.js';

test(
  'a finite copy turn yields to another prepared Lane before copying the whole tree',
  {
    timeout: 15000,
  },
  async t => {
    const first = agentFixture(t),
      second = agentFixture(t),
      original = fs.copyFile;
    const firstStage = join(realpathSync(dirname(first.root)), 'client.forge-client', 'checkout-');
    const secondStage = join(realpathSync(dirname(second.root)), 'client.forge-client', 'checkout-');
    const count = Math.min(checkoutIoCapacity(), checkoutVolumeCapacity()) * 64;
    let readyFirst,
      readySecond,
      readyBoth,
      prepared = 0,
      copied = 0,
      observed = count;
    const enteredFirst = new Promise(r => (readyFirst = r)),
      copiedSecond = new Promise(r => (readySecond = r)),
      both = new Promise(r => (readyBoth = r));
    t.signal.addEventListener(
      'abort',
      () => {
        readyFirst();
        readyBoth();
      },
      { once: true },
    );
    t.after(() => {
      fs.copyFile = original;
      syncBuiltinESMExports();
    });
    const transport = s => {
      const bytes = Buffer.from('ordinary shared source'),
        blob = digest(bytes);
      const files = Array.from({ length: s === first ? count : 1 }, (_, i) => ({
        path: `source${String(i).padStart(6, '0')}.txt`,
        blob,
        mode: 'file',
      }));
      const state = Buffer.from(
        JSON.stringify({
          schema: 1,
          kind: 'forge-source-state',
          parents: [],
          files,
          message: 'synthetic',
          at: '2026-01-01T00:00:00Z',
        }),
      );
      s.objects.set(blob, bytes);
      s.objects.set(digest(state), state);
      s.lane.head = digest(state);
      let selects = 0;
      return {
        select: async () => {
          if (++selects === 2) {
            if (++prepared === 2) readyBoth();
            await both;
            if (s === second) await enteredFirst;
          }
          return s.lane;
        },
        objects: async ids => ids.map(sha256 => ({ sha256, size: s.objects.get(sha256).length })),
        downloadToFile: async (pin, path) => writeFileSync(path, s.objects.get(pin.sha256), { mode: 0o600 }),
      };
    };
    fs.copyFile = async (...args) => {
      if (String(args[1]).startsWith(firstStage)) {
        readyFirst();
        await new Promise(r => setTimeout(r, 30));
      }
      await original(...args);
      if (String(args[1]).startsWith(firstStage)) copied++;
      if (String(args[1]).startsWith(secondStage)) {
        observed = copied;
        readySecond();
      }
    };
    syncBuiltinESMExports();
    const open = s =>
      checkoutHostedLane(
        s.root,
        { ...s.address, laneId: s.lane.laneId, operationId: randomUUID() },
        transport(s),
      );
    const pending = Promise.all([open(first), open(second)]);
    try {
      await copiedSecond;
      assert(
        observed > 0 && observed < count,
        'the peer runs after a finite turn rather than after the entire tree',
      );
    } finally {
      await pending;
    }
  },
);

for (const failedPath of ['changed.bin', 'hosted-lane.json'])
  test(`checkout drains barriers on ${failedPath} failure and preserves the prior root`, async t => {
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
        if (String(args[0]).endsWith(failedPath)) throw new Error('synthetic file fsync failure');
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
    await assert.rejects(
      s.transport().dispatch('open', { laneId: s.lane.laneId, operationId: randomUUID() }),
      {
        code: 'HOSTED_ACTION_FAILED',
      },
    );
    assert(opened > 1, 'cleanup drains the other active barriers too');
    assert.equal(closed, opened);
    assert.deepEqual(readFileSync(marker), before);
    assert.throws(() => readFileSync(join(s.root, 'changed.bin')), { code: 'ENOENT' });
  });
