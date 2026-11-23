// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item f9309eec: the Lane review screen on source data that repeats rows: one path on two pages and one path twice in
// a conflict. The test builds this module with a development React, which logs "two children with the same key" and
// fails on it.
import { createRoot } from 'react-dom/client';
import { ConvexProvider, type ConvexReactClient } from 'convex/react';
import { ReviewPage } from '../../web/src/app/lane/LaneReview';
import type { Reply } from '../../web/src/app/lane/review-model';

const base = 'a'.repeat(64);
const head = 'b'.repeat(64);
const at = new Date(Date.now() - 20 * 60_000).toISOString();

const client = {
  mutation: async () => [],
  watchQuery: () => ({
    onUpdate: () => () => {},
    localQueryResult: () => undefined,
    journal: () => undefined,
  }),
} as unknown as ConvexReactClient;

const side = { blob: 'c'.repeat(64), mode: 'file' };
const file = (path: string) => ({
  path,
  status: 'modified' as const,
  before: side,
  after: side,
  lines: [1, 1] as [number, number],
});
const reply: Reply = {
  lane: {
    laneId: 'lane-a',
    intentId: 'intent-a',
    goal: 'Stream parser: handle split UTF-8',
    actor: 'sample-owner',
    agent: 'amber-fox',
    state: 'active',
    head,
    base: { head: base },
    landed: null,
  },
  supervised: true,
  protectedRules: 0,
  files: {
    current: true,
    complete: true,
    total: 3,
    offset: 0,
    nextOffset: null,
    items: [file('src/a.ts'), file('src/b.ts'), file('src/a.ts'), file('src/c.ts')],
  },
  conflicts: [
    {
      with: 'main',
      flaggedAt: at,
      files: [
        { path: 'src/a.ts', mine: [[2, 4]], theirs: [[3, 5]] },
        { path: 'src/a.ts', mine: [[2, 4]], theirs: [[3, 5]] },
      ],
    },
  ],
  peers: [],
};

createRoot(document.getElementById('root')!).render(
  <ConvexProvider client={client}>
    <main id="main">
      <ReviewPage
        reply={reply}
        files={reply.files.items}
        feed={undefined}
        route={{
          frame: 'project',
          handle: 'sample-owner',
          project: 'tide-pool',
          place: 'lanes',
          section: '',
          rest: 'lane-a',
        }}
        projectId={'p1' as never}
        trail={[{ label: 'tide-pool', href: '/sample-owner/tide-pool' }, { label: 'Lane' }]}
        who="sample-owner/amber-fox"
        nextOffset={null}
        onMore={() => undefined}
        loader={null}
      />
    </main>
  </ConvexProvider>,
);
