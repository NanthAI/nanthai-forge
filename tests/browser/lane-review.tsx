// SPDX-License-Identifier: Apache-2.0
// The Lane review screen (Items 52235fbf, 4bc460aa, a1e3d771) on synthetic data, through its real components. The
// Convex client is a stand-in that answers the two download calls the screen makes and counts them; file bytes come
// back as data: URLs and the real reader checks each against its digest. `?s=review` is a held Lane with a conflict
// with the Lane ahead; `?s=combined` is the same Lane after it was combined on top of that Lane; `?s=parked` is the
// held Lane also parked on a named holder (Item e1633718); `?s=landed` and `?s=abandoned` are the Lane once review is
// over. Each file carries the +/- counts its save recorded (c2388099), except docs/parser.md and the fixture, which
// stand for an older save that recorded none.
import { createRoot } from 'react-dom/client';
import { ConvexProvider, type ConvexReactClient } from 'convex/react';
import { getFunctionName } from 'convex/server';
import '../../web/src/ds';
import '../../web/src/app/app.css';
import { ReviewPage } from '../../web/src/app/lane/LaneReview';
import type { Reply } from '../../web/src/app/lane/review-model';

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'dark';
const scenario = params.get('s') ?? 'review';

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
const client = {
  mutation: async (ref: unknown, args: { digests: string[] }) => {
    const name = getFunctionName(ref as never);
    calls.push(name);
    (window as unknown as { __calls: string[] }).__calls = calls;
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
  watchQuery: (ref: unknown) => {
    const watches = ((window as unknown as { __watches?: string[] }).__watches ??= []);
    watches.push(getFunctionName(ref as never));
    return { onUpdate: () => () => {}, localQueryResult: () => undefined, journal: () => undefined };
  },
} as unknown as ConvexReactClient;

const PEER = '3c1f9a20-5b7e-4d2a-9c11-2f0e6b8a4d19';
const LANE = '7a2b4c6d-8e9f-4a1b-8c3d-5e6f7a8b9c0d';
const BASE = 'b'.repeat(64);
const AHEAD_HEAD = 'a1'.repeat(32);
const HEAD = 'c3'.repeat(32);

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
      intentId: '9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a',
      goal: 'Stream parser: handle split UTF-8',
      actor: 'sample-owner',
      agent: 'amber-fox',
      state: scenario === 'abandoned' ? 'abandoned' : scenario === 'landed' ? 'completed' : 'active',
      head: HEAD,
      base: { head: BASE },
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
      : [{ laneId: LANE, stage: 'checking' as const, held: true, overlap: true, changedAt: Date.now() }],
  more: 0,
  moreIsLowerBound: false,
  main: { head: BASE },
};

void reply().then(data =>
  createRoot(document.getElementById('root')!).render(
    <ConvexProvider client={client}>
      <main id="main">
        <ReviewPage
          reply={data}
          files={data.files.items}
          feed={feed}
          route={route}
          projectId={'p1' as never}
          trail={[
            { label: 'tide-pool', href: '/-/sample-owner/tide-pool' },
            { label: 'Lanes', href: '/-/sample-owner/tide-pool/lanes' },
            { label: 'sample-owner/amber-fox' },
          ]}
          who="sample-owner/amber-fox"
          nextOffset={null}
          onMore={() => undefined}
          loader={null}
        />
      </main>
    </ConvexProvider>,
  ),
);
