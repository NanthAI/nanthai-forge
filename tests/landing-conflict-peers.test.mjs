// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeSource } from '../dist/native-source.js';
import { initNative } from '../dist/native-work.js';
import { landingConflictPeers } from '../dist/landing-conflict-peers.js';
test('accepted input attribution excludes paths inherited through a prior sync', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-peer-attribution-'));
  try {
    initNative(root);
    const source = new NativeSource(root),
      at = '2026-01-01T00:00:00.000Z';
    const state = (text, parents, extra = false) =>
      source.writeState(
        [
          { path: 'shared.txt', mode: 'file', blob: source.put(Buffer.from(text)) },
          ...(extra
            ? [{ path: 'unrelated.txt', mode: 'file', blob: source.put(Buffer.from('unrelated')) }]
            : []),
        ],
        parents,
        'Synthetic',
        at,
      );
    const base = state('base', []),
      first = state('first', [base]),
      child = state('child', [base]);
    const synced = state('first', [base, first]),
      unrelated = state('first', [synced], true);
    const second = state('second', [first]);
    const main = source.compose(second, unrelated, 'Combined', at).head;
    const data = {
      nativeHead: base,
      lanes: [
        { id: 'first', base, head: first, checkpoints: [] },
        { id: 'second', base: first, head: second, checkpoints: [] },
        {
          id: 'unrelated',
          base,
          head: unrelated,
          checkpoints: [
            { head: synced, parent: base, sync: { target: first } },
            { head: unrelated, parent: synced },
          ],
        },
      ],
      views: [
        { id: 'first-view', inputs: [{ laneId: 'first', head: first }] },
        {
          id: 'combined-view',
          inputs: [
            { laneId: 'second', head: second },
            { laneId: 'unrelated', head: unrelated },
          ],
        },
      ],
      channelMoves: [
        { status: 'accepted', viewId: 'first-view', head: first, previous: base },
        { status: 'accepted', viewId: 'combined-view', head: main, previous: first },
      ],
    };
    const peers = landingConflictPeers(
      { native: true, root, load: () => data },
      main,
      [{ laneId: 'child', head: child }],
      ['shared.txt'],
    );
    assert.deepEqual(peers, ['first', 'second']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
