// SPDX-License-Identifier: Apache-2.0
// Item f9309eec: the Lane page on source data that repeats rows. `?s=lane` is the hosted Lane page (saves, timeline
// and conversation) fed one save recorded three times, one operation read on two pages and two accepted moves at one
// instant; `?s=review` is the Lane review screen fed one path on two pages and one path twice in a conflict. The test
// builds this module with a development React, which logs "two children with the same key" and fails on it.
import { createRoot } from 'react-dom/client';
import { ConvexProvider, type ConvexReactClient } from 'convex/react';
import { HostedLaneView } from '../../web/src/lane/HostedLane';
import { ReviewPage } from '../../web/src/app/lane/LaneReview';
import type { Reply } from '../../web/src/app/lane/review-model';

const scenario = new URLSearchParams(location.search).get('s') ?? 'lane';
const base = 'a'.repeat(64);
const head = 'b'.repeat(64);
const at = new Date(Date.now() - 20 * 60_000).toISOString();
const later = new Date(Date.now() - 10 * 60_000).toISOString();
const save = (when: string) => ({ head, parent: base, at: when, message: 'Carry split characters' });
const message = (operationId: string, text: string) => ({
  operationId,
  at: later,
  actor: 'sample-owner',
  command: { kind: 'message', text, context: { laneId: 'lane-a' } },
});
const move = { channel: 'main', status: 'accepted', head, viewId: 'view-a', at: later };

const records = {
  intents: [{ id: 'intent-a', outcome: 'Stream parser: handle split UTF-8', createdAt: at }],
  lanes: [
    {
      id: 'lane-a',
      name: 'Stream parser',
      intentId: 'intent-a',
      state: 'active' as const,
      base,
      head,
      checkpoints: [save(at), save(at), save(later)],
      lifecycle: [{ to: 'active', at }],
    },
  ],
  views: [{ id: 'view-a', intentId: 'intent-a', at, inputs: [{ laneId: 'lane-a', head, saveIndex: 0 }] }],
  runs: [],
  channelMoves: [move, { ...move }],
};
const events = [message('op-1', 'First'), message('op-1', 'First'), message('op-2', 'Second')];

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
  scenario === 'lane' ? (
    <div className="fx">
      <HostedLaneView
        laneId="lane-a"
        records={records}
        sessions={[]}
        events={events as never}
        now={Date.now()}
        changes={<p>Source changes</p>}
        send={async () => true}
      />
    </div>
  ) : (
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
          trail={[{ label: 'tide-pool', href: '/-/sample-owner/tide-pool' }, { label: 'Lane' }]}
          who="sample-owner/amber-fox"
          nextOffset={null}
          onMore={() => undefined}
          loader={null}
        />
      </main>
    </ConvexProvider>
  ),
);
