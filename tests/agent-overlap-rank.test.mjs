// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';

import { boundPeers } from '../dist/agent-peers-bound.js';

import { rankPeerLanes } from '../dist/agent-peer-ranking.js';

test('path index ranks shared paths then save recency and respects directory claims without blob or live reads', () => {
  const lanes = [
    { id: 'unrelated', base: 'base', head: 'unrelated' },
    { id: 'older', base: 'base', head: 'older' },
    { id: 'recent', base: 'base', head: 'recent' },
    { id: 'most', base: 'base', head: 'most' },
    { id: 'claim', base: 'base', head: 'base', scope: { paths: ['src/'] } },
  ];
  const paths = {
    unrelated: ['other.txt'],
    older: ['src/a.ts'],
    recent: ['src/a.ts'],
    most: ['src/a.ts', 'src/b.ts'],
  };
  const source = {
    state: head => ({ at: head === 'recent' ? '2026-02' : '2026-01' }),
    object: () => assert.fail('ranking must not read blobs'),
    live: () => assert.fail('ranking must not scan live trees'),
  };
  const cache = {
    read: key =>
      key.startsWith('regions-v1:')
        ? { files: (paths[key.split(':').at(-1)] ?? []).map(path => ({ path })) }
        : undefined,
  };
  const ranked = rankPeerLanes(source, cache, ['src/a.ts', 'src/b.ts'], lanes);
  assert.deepEqual(
    ranked.ranked.map(l => l.id),
    ['most', 'claim', 'recent', 'older', 'unrelated'],
  );
  assert.equal(ranked.shared.get('most'), 2);
  assert.equal(ranked.shared.get('claim'), 2);
  assert.equal(ranked.shared.has('unrelated'), false);
  assert.equal(ranked.incomplete, false);
  const indexed = rankPeerLanes(
    { state: () => assert.fail('warm path index must not reread manifests') },
    {
      read: key =>
        key.startsWith('peer-paths-v1:')
          ? { paths: paths[key.split(':').at(-1)] ?? [], at: '2026-01' }
          : assert.fail('warm path index must not decode region summaries'),
    },
    ['src/a.ts'],
    lanes,
  );
  assert.equal(indexed.shared.get('most'), 1);
  assert.deepEqual(
    rankPeerLanes(source, cache, ['src'], lanes)
      .ranked.map(l => l.id)
      .slice(0, 4),
    ['most', 'recent', 'older', 'claim'],
  );
});

test('compact inbox follows path-ranked Lane summaries before its ten-Lane display cap', () => {
  const overlaps = Array.from({ length: 11 }, (_, i) => ({
    lane: `peer-${i}`,
    actor: `Agent ${i}`,
    intent: `Intent ${i}`,
    state: 'working',
    paths: ['shared.txt'],
    via: 'edit',
  }));
  const inbox = overlaps.map((p, i) => ({
    noticeId: String(i).padStart(64, '0'),
    kind: 'overlap-notice',
    lanes: ['mine', p.lane],
    file: 'shared.txt',
    proposedOrder: ['mine', p.lane],
    text: 'High overlap',
  }));
  const compact = boundPeers({ overlaps, inbox });
  assert.equal(compact.overlaps.length, 10);
  assert.equal(compact.inbox.length, 10);
  assert.ok(compact.inbox.every(n => !n.lanes.includes('peer-10')));
  assert.equal(compact.more, 2);
});
