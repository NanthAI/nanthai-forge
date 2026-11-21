// SPDX-License-Identifier: Apache-2.0
// The Plan Item page with its discussion (Item 9a3d6f5f) on synthetic data, through the real Plan screen, the lazy
// ItemDiscussion chunk and its hosted hooks. The Convex client is a stand-in that answers the reads the
// discussion makes (the Work index workspace, comments, reactions and the scoped thread) and records every write.
// `?viewer=reader` is a reader of a public project: no people, no composer, no reaction keys.
import { createRoot } from 'react-dom/client';
import { ConvexProvider, type ConvexReactClient } from 'convex/react';
import { getFunctionName, type FunctionReference } from 'convex/server';
import '../../web/src/ds';
import '../../web/src/app/app.css';
import type { Id } from '../../convex/_generated/dataModel';
import { review } from '../fixtures/review-findings.mjs';

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'dark';
const reader = params.get('viewer') === 'reader';
const withThread = params.has('thread');
const withPages = params.has('pages');

const uuid = (n: number) => `7be2c41a-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ITEM = uuid(1),
  INITIATIVE = uuid(2);
const minutes = (m: number) => new Date(Date.UTC(2026, 10, 10, 16, 20 + m)).toISOString();
const author = (handle: string) => (reader ? {} : { author: handle });
const comments = [
  {
    id: uuid(11),
    itemId: ITEM,
    at: minutes(0),
    authorLabel: '',
    ...author('sample-two'),
    text: 'Do we list the renamed options too, or only the removed calls?',
  },
  {
    id: uuid(12),
    itemId: ITEM,
    at: minutes(21),
    authorLabel: '',
    ...author('sample-one'),
    replyTo: uuid(11),
    decision: true,
    text: 'Renamed too. **Anything that makes older code stop compiling** goes in the table.',
  },
  {
    id: uuid(13),
    itemId: ITEM,
    at: minutes(60 * 24 * 7),
    authorLabel: '',
    ...author('sample-one'),
    agent: 'keen-impala',
    text: 'Done in landing `5c1e`:\n\n- the removed calls table\n- the upgrade steps\n\nRaw HTML stays out: <img src=x onerror=alert(1)> and [the guide](https://docs.example.com/guide) opens safely.',
  },
  {
    id: uuid(14),
    itemId: ITEM,
    at: minutes(60 * 24 * 7 + 11),
    // An older comment with only a typed label.
    authorLabel: '@sample-three',
    text: 'Checking the download numbers before the answer.',
  },
];
if (params.has('review'))
  comments.push({
    id: uuid(15),
    itemId: ITEM,
    at: minutes(60 * 24 * 7 + 15),
    authorLabel: '',
    ...author('sample-two'),
    agent: 'keen-impala',
    text: JSON.stringify(review, null, 2),
  });
const reactions = reader
  ? []
  : [
      { commentId: uuid(12), kind: '+1', count: 2, mine: true },
      { commentId: uuid(13), kind: 'rocket', count: 1, mine: false },
    ];
const rows = [
  { id: INITIATIVE, kind: 'initiative', title: 'Release 3', status: 'open', position: 0 },
  {
    id: ITEM,
    kind: 'issue',
    title: 'Write the upgrade guide',
    status: 'in-progress',
    position: 1,
    version: 4,
    initiativeId: INITIATIVE,
    owner: reader ? null : 'sample-one',
    doneWhen: [2, 4],
    inLane: true,
  },
];
const workspace = JSON.stringify({
  generationId: 'generation',
  backupId: 'backup',
  backupDigest: 'd'.repeat(64),
  sourceHead: 'h'.repeat(64),
  key: 'synthetic',
  name: 'synthetic',
  actor: 'viewer',
  counts: {},
  capabilities: { owner: !reader, editableIntentIds: [], hostedChannels: false, recentSummaryPages: true },
});
const calls: string[] = [];
const writes: unknown[] = [];
const watches = new Set<() => void>();
let newest = 3,
  answered = false;
Object.assign(window, {
  __calls: calls,
  __writes: writes,
  changeThread: (change: 'append' | 'answer') => {
    if (change === 'append') newest++;
    else answered = true;
    for (const notify of watches) notify();
  },
});
type Before = { message?: [number, number, string] };
function answer(name: string, before?: Before) {
  if (name === 'projectWorkIndex:workspace') return workspace;
  if (name === 'projectWorkIndex:records')
    return {
      page: comments.map((comment, position) => ({
        id: comment.id,
        position,
        value: JSON.stringify(comment),
      })),
      isDone: true,
      continueCursor: '',
      generationId: 'generation',
      revision: 1,
    };
  if (name === 'planningReactions:forItem') return { counts: reactions, complete: true };
  if (name === 'projectDiscussionThread:read' && withPages) {
    const end = before?.message?.[0] ?? newest + 1;
    const numbers = [end - 1, end - 2].filter(n => n > 0);
    return {
      canRead: true,
      before: numbers.at(-1)! > 1 ? { message: [numbers.at(-1), 0, 'cursor'] } : null,
      entries: numbers.map(n => ({
        id: uuid(30 + n),
        at: Date.parse(minutes(n)),
        actor: 'sample-two',
        text: `Message ${n}`,
        type: n === 1 ? 'question' : 'note',
        ...(n === 1
          ? {
              choices: ['Pick A', 'Pick B'],
              mayAnswer: !answered,
              ...(answered ? { answer: { choice: 'Pick A', text: 'Chosen elsewhere' } } : {}),
            }
          : {}),
      })),
    };
  }
  if (name === 'projectDiscussionThread:read')
    return {
      canRead: !reader,
      before: null,
      entries:
        withThread && !reader
          ? [
              {
                id: uuid(17),
                type: 'question',
                actor: 'sample-two',
                agent: 'keen-impala',
                at: Date.parse(minutes(-4)),
                text: 'Which endpoint should we use?',
                choices: ['The old endpoint', 'The new endpoint', 'LongEndpoint'.repeat(10)],
                mayAnswer: true,
              },
              {
                id: uuid(18),
                type: 'question',
                actor: 'sample-two',
                agent: 'keen-impala',
                at: Date.parse(minutes(40)),
                text: 'Which release can ship?',
                answer: {
                  actor: 'sample-one',
                  choice: 'Release 3',
                  text: 'QA is green.',
                  resumePrompt: 'Resume the release after reading the recorded answer.',
                },
              },
            ]
          : [],
    };
  throw new Error(`Unexpected read ${name}`);
}
const client = {
  watchQuery: (fn: FunctionReference<'query'>, args: { before?: Before }) => {
    const name = getFunctionName(fn);
    calls.push(name);
    return {
      localQueryResult: () => answer(name, args.before),
      journal: () => undefined,
      onUpdate: (notify: () => void) => {
        watches.add(notify);
        return () => watches.delete(notify);
      },
    };
  },
  mutation: async (fn: FunctionReference<'mutation'>, args: unknown) => {
    writes.push([getFunctionName(fn), args]);
    return { on: true };
  },
} as unknown as ConvexReactClient;

// The screen loads as its own chunk, as its route does (the behaviour layer never joins first paint).
const { PlanScreenView } = await import('../../web/src/app/plan/Plan');
createRoot(document.getElementById('root')!).render(
  <ConvexProvider client={client}>
    <main id="main" tabIndex={-1}>
      <PlanScreenView
        route={{
          frame: 'project',
          handle: 'sample-one',
          project: 'synthetic',
          place: 'plan',
          section: '',
          rest: ITEM,
        }}
        projectName="synthetic"
        feed={undefined}
        read={{ rows: JSON.stringify(rows), more: false, settled: [], canEdit: !reader }}
        put={async () => undefined}
        projectId={'project' as Id<'hostedProjects'>}
      />
    </main>
  </ConvexProvider>,
);
