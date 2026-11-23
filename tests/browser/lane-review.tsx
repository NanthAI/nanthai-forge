// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The Lane review screen (Items 52235fbf, 4bc460aa, a1e3d771) on synthetic data, through its real components. The
// Convex client is a stand-in that answers the two download calls the screen makes and counts them; file bytes come
// back as data: URLs and the real reader checks each against its digest. `?s=review` is a held Lane with a conflict
// with the Lane ahead; `?s=combined` is the same Lane after it was combined on top of that Lane; `?s=parked` is the
// held Lane also parked on a named holder (Item e1633718); `?s=landed` and `?s=abandoned` are the Lane once review is
// over. Each file carries the +/- counts its save recorded (c2388099), except docs/parser.md and the fixture, which
// stand for an older save that recorded none. Item 0a99ab23: `?s=asked` is the Lane with an approval request asked
// at an older save, before it holds a landing, decided from the Lane read's own row; `?s=declined` is that request
// declined while it still holds the Lane; `?s=linked&submission=…` is an approval link naming one of two landings of
// this Lane that wait for review, after a newer save moved the Lane's mark.
import type { ReactNode } from 'react';
import { ProjectFrame } from '../../web/src/app/frames';
import { createRoot } from 'react-dom/client';
import { ConvexProvider, type ConvexReactClient } from 'convex/react';
import { getFunctionName } from 'convex/server';
import '../../web/src/ds';
import '../../web/src/app/app.css';
import { PlaceScreen } from '../../web/src/app/screens';
import { useRoute } from '../../web/src/app/router';
import { ReviewPage } from '../../web/src/app/lane/LaneReview';
import type { Reply } from '../../web/src/app/lane/review-model';

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'dark';
const scenario = params.get('s') ?? 'review';
const routed = params.has('routes');
const unattended = scenario.startsWith('save-');
const saveFailure =
  unattended && scenario !== 'save-healthy'
    ? {
        operationId: '7c6b5a49-3827-4160-9e8d-1a2b3c4d5e6f',
        attemptId: '5a78d310-8a93-4e4b-a236-f6b76aea2057',
        code: 'WORK_STALE',
        at: 1_790_000_000_000,
        canDismiss: scenario !== 'save-reader',
      }
    : undefined;

const enc = new TextEncoder();
const hex = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
const bodies = new Map<string, Uint8Array>();
const sizes = new Map<string, number>();
async function blob(text: string | Uint8Array) {
  const bytes = typeof text === 'string' ? enc.encode(text) : text;
  const id = await hex(bytes);
  bodies.set(id, bytes);
  sizes.set(id, bytes.length);
  return { blob: id, mode: 'file' };
}
const fake = (seed: string, size: number) => {
  const id = seed.padEnd(64, '0').slice(0, 64);
  sizes.set(id, size);
  return { blob: id, mode: 'file' };
};

const parserMain = Array.from({ length: 40 }, (_, i) =>
  i === 21 ? '  const text = decoder.decode(chunk);' : i === 22 ? '  emit(text);' : `  // step ${i + 1}`,
).join('\n');
const parserAhead = parserMain
  .replace('  const text = decoder.decode(chunk);', '  const text = decoder.decode(chunk, { stream: true });')
  .replace('  emit(text);', '  if (text) emit(text);\n  flushed = false;');
const parserMine = parserMain
  .replace('  const text = decoder.decode(chunk);', '  const text = decoder.decode(chunk, { stream: true });')
  .replace('  emit(text);', '  if (text) emit(text);\n  carry.reset();');

const calls: string[] = [];
const listeners = new Map<string, Set<() => void>>();
const client = {
  mutation: async (ref: unknown, args: { digests: string[] }) => {
    const name = getFunctionName(ref as never);
    calls.push(name);
    (window as unknown as { __calls: string[] }).__calls = calls;
    if (
      name === 'projectHostedApprovals:decide' ||
      name === 'projectHostedAcceptance:approve' ||
      name === 'projectHostedOwnerReview:decline'
    ) {
      (window as unknown as { __decide: unknown[] }).__decide ??= [];
      (window as unknown as { __decide: unknown[] }).__decide.push(args);
      return JSON.stringify({ approval: { status: 'granted' } });
    }
    if (name === 'projectHostedSaves:dismissFailure') {
      (window as unknown as { __dismissArgs: unknown }).__dismissArgs = args;
      if (scenario === 'save-denied') return false;
      for (const query of ['projectLaneReview:read', 'projectHostedLiveLanes:list']) {
        const value = JSON.parse(reads.get(query) as string);
        const lane = value.lane ?? value.page[0];
        delete lane.saveFailure;
        reads.set(query, JSON.stringify(value));
        for (const update of listeners.get(query) ?? []) update();
      }
      return true;
    }
    const url = (id: string) =>
      `data:application/octet-stream;base64,${btoa(String.fromCharCode(...(bodies.get(id) ?? new Uint8Array())))}`;
    return args.digests.map(digest => ({
      digest,
      size: sizes.get(digest) ?? 0,
      location: 'convex',
      url: url(digest),
    }));
  },
  // The owner's decision block subscribes to Needs me's read while the Lane is held; here it never answers, so the
  // block stays hidden and only its name is recorded (window.__watches).
  watchQuery: (ref: unknown, args: unknown) => {
    const name = getFunctionName(ref as never);
    const watches = ((window as unknown as { __watches?: string[] }).__watches ??= []);
    watches.push(name);
    return {
      onUpdate: (update: () => void) => {
        const subscriptions = ((
          window as unknown as {
            __subscriptions?: { name: string; args: unknown }[];
          }
        ).__subscriptions ??= []);
        subscriptions.push({ name, args });
        const callbacks = listeners.get(name) ?? new Set();
        callbacks.add(update);
        listeners.set(name, callbacks);
        return () => callbacks.delete(update);
      },
      localQueryResult: () => reads.get(name),
      journal: () => undefined,
    };
  },
} as unknown as ConvexReactClient;

const PEER = '3c1f9a20-5b7e-4d2a-9c11-2f0e6b8a4d19';
const LANE = '7a2b4c6d-8e9f-4a1b-8c3d-5e6f7a8b9c0d';
const ITEM = '9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a';
const INTENT = '2a3f12de-8371-4310-a004-f9cae1ef291c';
const TITLE = scenario === 'uuid-title' ? INTENT : 'Stream parser: handle split UTF-8';
const reads = new Map<string, unknown>();
const BASE = 'b'.repeat(64);
const AHEAD_HEAD = 'a1'.repeat(32);
const HEAD = 'c3'.repeat(32);
const LINKED_SUBMISSION = 'a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d';

async function reply(): Promise<Reply> {
  const stream = {
    before: await blob(parserMain),
    after: await blob(scenario === 'combined' ? parserMine : parserMine),
  };
  const aheadSide = await blob(parserAhead);
  const files: Reply['files']['items'] = [
    { path: 'src/parser/stream-parser.ts', status: 'modified', ...stream, lines: [3, 2] },
    {
      path: 'src/parser/utf8-carry.ts',
      status: 'added',
      before: null,
      after: await blob('export const carry = {\n  reset() {},\n};\n'),
      lines: [3, 0],
    },
    {
      path: 'package.json',
      status: 'modified',
      before: await blob('{\n  "version": "1.0.0"\n}\n'),
      after: await blob('{\n  "version": "1.1.0"\n}\n'),
      lines: [1, 1],
      protected: true,
    },
    {
      path: 'src/generated/tables.ts',
      status: 'modified',
      before: fake('d1', 2_400_000),
      after: fake('d2', 2_600_000),
      lines: [1_204, 380],
    },
    {
      path: 'tests/stream-parser.test.ts',
      status: 'modified',
      before: await blob("test('a', () => {});\n"),
      after: await blob("test('a', () => {});\ntest('split', () => {});\n"),
      lines: [1, 0],
    },
    {
      path: 'docs/parser.md',
      status: 'modified',
      before: await blob('# Parser\n'),
      after: await blob('# Parser\n\nSplit characters are carried.\n'),
    },
    {
      path: 'tests/fixtures/split-utf8.bin',
      status: 'added',
      before: null,
      after: await blob(new Uint8Array([0, 255, 0, 1, 2, 3])),
    },
    {
      path: 'src/parser/legacy-decoder.ts',
      status: 'deleted',
      before: await blob('export const old = 1;\n'),
      after: null,
      lines: [0, 1],
    },
    ...(await Promise.all(
      Array.from({ length: 9 }, async (_, i) => ({
        path: `src/adapters/very/long/nested/folder/structure/adapter-number-${i + 1}-with-a-long-name.ts`,
        status: 'modified' as const,
        before: await blob(`export const n = ${i};\n`),
        after: await blob(`export const n = ${i + 1};\n`),
        lines: [1, 1] as [number, number],
      })),
    )),
  ];
  const combined = scenario === 'combined';
  return {
    lane: {
      laneId: LANE,
      intentId: scenario === 'legacy-id' ? ITEM : INTENT,
      ...(scenario === 'legacy-id' ? {} : { itemId: ITEM }),
      goal: scenario === 'unavailable' ? null : scenario === 'legacy-id' ? ITEM : TITLE,
      actor: 'sample-owner',
      agent: 'amber-fox',
      agentClient: 'codex:gpt-example',
      state: scenario === 'abandoned' ? 'abandoned' : scenario === 'landed' ? 'completed' : 'active',
      head: HEAD,
      base: { head: BASE },
      ...(saveFailure ? { saveFailure } : {}),
      // A landed Lane carries its own time to main and stops (Item a61d3c91).
      landed:
        scenario === 'landed'
          ? {
              receiptId: '7c6b5a49-3827-4160-9e8d-1a2b3c4d5e6f',
              commit: 'c4'.repeat(32),
              at: new Date(Date.now() - 3 * 60_000).toISOString(),
              timing: { toMain: 477, queue: 42, check: 430, land: 5 },
            }
          : null,
      ...(scenario === 'parked'
        ? {
            park: {
              to: 'sample-two',
              named: true,
              reason: 'Waits for the bench window to end before it lands.',
              at: Date.now() - 95 * 60_000,
              by: 'sample-owner/amber-fox',
            },
          }
        : {}),
      ...(combined
        ? {
            earlyResolution: {
              predecessor: {
                submissionId: '1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9',
                head: AHEAD_HEAD,
                receiptId: '0a9b8c7d-6e5f-4a3b-9c2d-1e0f9a8b7c6d',
              },
              laneId: LANE,
              originalHead: 'e5'.repeat(32),
              startedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
            },
            ahead: PEER,
          }
        : {}),
    },
    ...(scenario === 'asked' || scenario === 'declined' || scenario === 'granted'
      ? {
          request: {
            laneId: LANE,
            kind: 'lane' as const,
            status: scenario,
            state: scenario === 'asked' ? 'requested' : scenario,
            live: true,
            needsOwner: scenario === 'asked',
            label:
              scenario === 'asked' ? 'Approval requested' : scenario === 'granted' ? 'Granted' : 'Declined',
            nextStep:
              scenario === 'asked'
                ? 'Approve or decline it; landing waits for your answer.'
                : scenario === 'granted'
                  ? 'Nothing to do; the Lane can land.'
                  : 'The builder was told; you can still approve it.',
            reason: 'Touches the billing migration; please look first.',
            requester: 'sample-two',
            agent: 'salt-wren',
            // The request was asked at an older save; the decision names the Lane's current one.
            head: AHEAD_HEAD,
            at: '2026-11-22T12:00:00.000Z',
            ...(scenario === 'declined' ? { decision: { reason: 'Wait for the schema review.' } } : {}),
          },
        }
      : {}),
    supervised: true,
    protectedRules: 2,
    files: { current: true, complete: true, total: files.length, offset: 0, nextOffset: null, items: files },
    conflicts: combined
      ? []
      : [
          {
            with: PEER,
            goal: 'Parser: carry partial bytes',
            flaggedAt: new Date(Date.now() - 9 * 60_000).toISOString(),
            files: [{ path: 'src/parser/stream-parser.ts', mine: [[22, 24]], theirs: [[22, 24]] }],
            earlyResolution: {
              predecessor: {
                submissionId: '1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9',
                head: AHEAD_HEAD,
                receiptId: '0a9b8c7d-6e5f-4a3b-9c2d-1e0f9a8b7c6d',
              },
            },
          },
        ],
    peers: [
      {
        laneId: PEER,
        actor: 'sample-two',
        agent: 'salt-wren',
        goal: 'Parser: carry partial bytes',
        head: AHEAD_HEAD,
        baseHead: BASE,
        complete: true,
        landed: null,
        files: [{ path: 'src/parser/stream-parser.ts', before: stream.before, after: aheadSide }],
      },
    ],
  };
}

const route = {
  frame: 'project' as const,
  handle: 'sample-owner',
  project: 'tide-pool',
  place: 'lanes' as const,
  section: '',
  rest: LANE,
};
const feed = {
  lanes:
    scenario === 'abandoned'
      ? []
      : [
          {
            laneId: LANE,
            stage: unattended ? ('editing' as const) : ('checking' as const),
            held: !unattended && !['asked', 'declined', 'granted', 'linked'].includes(scenario),
            overlap: !unattended,
            changedAt: Date.now(),
          },
        ],
  more: 0,
  moreIsLowerBound: false,
  main: { head: BASE },
};

function Frame({ children, current = route }: { children: ReactNode; current?: typeof route }) {
  if (!routed && !params.has('frame')) return <main id="main">{children}</main>;
  return (
    <ProjectFrame
      route={current}
      name="tide-pool"
      feed={feed}
      needs={{ n: unattended ? 0 : 1, atLeast: false }}
      projects={null}
      controls={{ viewerHandle: 'sample-owner', onPicker() {}, onPalette() {}, onKeys() {} }}
    >
      {children}
    </ProjectFrame>
  );
}

function Routed() {
  const current = useRoute();
  if (current.frame !== 'project' || current.place !== 'lanes') throw new Error('Expected a Lanes route');
  return (
    <Frame current={{ ...current, place: 'lanes' }}>
      <PlaceScreen
        route={current}
        projectId={'p1' as never}
        projectName="tide-pool"
        feed={feed}
        viewerHandle="sample-owner"
      />
    </Frame>
  );
}

void reply().then(data => {
  if (scenario === 'linked')
    reads.set('projectNeedsMe:read', {
      held: ['older', 'newer'].map((which, index) => ({
        laneId: LANE,
        title: 'Stream parser',
        actor: 'sample-two',
        agent: 'salt-wren',
        why: 'review',
        note: null,
        submissionId: which === 'older' ? LINKED_SUBMISSION : '9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
        attemptId:
          which === 'older' ? 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e' : 'c2d3e4f5-a6b7-4c8d-9e0f-1a2b3c4d5e6f',
        since: 1_790_000_000_000 - index,
      })),
      more: 0,
      moreIsLowerBound: false,
      canDecide: true,
      approvals: '{}',
    });
  if (routed) {
    reads.set('projectLaneReview:read', JSON.stringify(data));
    reads.set('projectDiscussionThread:read', {
      canRead: true,
      before: null,
      entries: [
        { id: 'legacy-board', at: 2, type: 'note', actor: 'sample-owner', text: 'Legacy board note' },
        {
          id: 'new-question',
          at: 1,
          type: 'question',
          actor: 'sample-two',
          agent: 'salt-wren',
          text: 'Which client should land first?',
          choices: ['Old client', 'New client'],
          mayAnswer: true,
        },
      ],
    });
    reads.set(
      'projectHostedLiveLanes:list',
      JSON.stringify({
        page: [
          {
            laneId: LANE,
            intentId: INTENT,
            intent: TITLE,
            actor: 'sample-owner',
            lastSaveAt: null,
            landing: null,
            ...(saveFailure ? { saveFailure } : {}),
          },
        ],
        isDone: true,
      }),
    );
    reads.set(
      'projectHostedQueueView:read',
      JSON.stringify({ total: 0, listed: 0, more: false, entries: [] }),
    );
    // Lanes' Needs you shares the frame's Needs me read (e317b6ea): nothing waits on this reader.
    reads.set('projectNeedsMe:read', {
      held: [],
      more: 0,
      moreIsLowerBound: false,
      approvals: '{}',
      canDecide: false,
    });
    reads.set(
      'projectNowOverlaps:now',
      JSON.stringify({
        signals: {
          lanes: [{ laneId: LANE }, { laneId: PEER }],
          paths: ['src/parser/stream-parser.ts'],
          edits: [
            { lane: 0, paths: [0] },
            { lane: 1, paths: [0] },
          ],
          complete: true,
        },
      }),
    );
  }
  createRoot(document.getElementById('root')!).render(
    <ConvexProvider client={client}>
      {routed ? (
        <Routed />
      ) : (
        <Frame>
          <ReviewPage
            reply={data}
            files={data.files.items}
            feed={feed}
            route={route}
            projectId={'p1' as never}
            trail={[
              { label: 'tide-pool', href: '/sample-owner/tide-pool' },
              { label: 'Lanes', href: '/sample-owner/tide-pool/lanes' },
              { label: 'sample-owner/amber-fox' },
            ]}
            who="sample-owner/amber-fox"
            nextOffset={null}
            onMore={() => undefined}
            loader={null}
          />
        </Frame>
      )}
    </ConvexProvider>,
  );
});
