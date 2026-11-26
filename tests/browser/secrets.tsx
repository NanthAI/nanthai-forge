// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Synthetic names, codes and public handles only (Item 41a0df87, slice 4). This entry is never a production Vite input
// or an app route. It draws the real SecretsScreen inside the real project frame from fixed overview data.
import { createRoot } from 'react-dom/client';
import { ConvexError } from 'convex/values';
import { ConvexProvider } from 'convex/react';
import { useState } from 'react';
import { ProjectFrame } from '../../web/src/app/frames';
import Secrets, { SecretsScreen } from '../../web/src/app/secrets/Secrets';
import type { Overview, OverviewSet, SecretsView } from '../../web/src/app/secrets/secrets-model';
import '../../web/src/app/app.css';
import '../../web/src/ui/mark.css';

const NOW = Date.parse('2026-11-24T14:02:11Z');
const ago = (minutes: number) => NOW - minutes * 60_000;
type Names = NonNullable<OverviewSet['names']>['page'];
type People = NonNullable<OverviewSet['people']>['page'];
const name = (n: string, v: number, minutes: number, by: string | null, extra = {}): Names[number] => ({
  name: n,
  kind: n.includes('.') ? 2 : 1,
  version: v,
  at: ago(minutes),
  by,
  waits: 0,
  ...extra,
});
const development = (patch: Partial<OverviewSet> = {}): OverviewSet => ({
  kind: 1,
  sharing: 'automatic',
  headVersion: 12,
  takeOut: [],
  proposals: [],
  rotate: { total: 0, page: [], next: null },
  names: {
    total: 4,
    page: [
      name('API_BASE_URL', 2, 12 * 1440, 'alex'),
      name('API_TOKEN', 3, 4 * 1440, 'sam'),
      name('DATABASE_URL', 7, 25 * 1440, 'alex'),
      name('SENTRY_DSN', 1, 1440, 'lee'),
    ],
    next: null,
  },
  people: {
    total: 2,
    page: [
      {
        handle: 'alex',
        role: 'owner',
        mine: true,
        computers: [
          { code: 'M5VG-0YSJ', how: 'first', name: 'desk machine' },
          { code: '9CEB-T4NQ', how: 'code', name: 'travel laptop' },
        ],
      },
      {
        handle: 'sam',
        role: 'write',
        computers: [
          { code: '4HTB-W8CZ', how: 'code' },
          { code: 'ZX7H-1PRF', how: 'auto' },
        ],
      },
    ],
    next: null,
  },
  machines: [],
  waiting: [],
  ...patch,
});
const checks = (patch: Partial<OverviewSet> = {}): OverviewSet => ({
  kind: 2,
  sharing: 'confirm',
  headVersion: 3,
  takeOut: [],
  proposals: [],
  rotate: { total: 0, page: [], next: null },
  names: {
    total: 2,
    page: [name('E2E_ACCOUNT_PASSWORD', 1, 6 * 1440, 'alex'), name('NPM_TOKEN', 2, 6 * 1440, 'alex')],
    next: null,
  },
  people: {
    total: 1,
    page: [
      {
        handle: 'alex',
        role: 'owner',
        mine: true,
        computers: [{ code: 'M5VG-0YSJ', how: 'first', name: 'desk machine' }],
      },
    ],
    next: null,
  },
  machines: [{ code: 'T8NB-3QZE', name: 'walk-ci', by: 'alex' }],
  waiting: [],
  ...patch,
});
const ok = (sets: OverviewSet[]): SecretsView => ({
  status: 'ready',
  data: { status: 'ok', now: NOW, needs: 0, sets } as Overview,
  shownAt: NOW,
});
const removal = (): OverviewSet =>
  development({
    takeOut: [{ handle: 'dana', left: true, at: ago(120), codes: ['K7QD-2MWX'] }],
    rotate: {
      total: 3,
      page: [
        {
          name: 'DATABASE_URL',
          kind: 1,
          version: 7,
          devices: [{ code: 'R2PA-9XNE', handle: 'dana' }],
          more: 0,
        },
        {
          name: 'SIGNING_KEY.pem',
          kind: 2,
          version: 1,
          devices: [{ code: 'R2PA-9XNE', handle: 'dana', name: 'MacBook Air' }],
          more: 0,
        },
        {
          name: 'STRIPE_SECRET_KEY',
          kind: 1,
          version: 4,
          devices: [{ code: 'R2PA-9XNE', handle: 'dana' }],
          machines: [{ id: 'c876f11a', name: 'walk-ci' }, { id: '3d48a562' }],
          more: 0,
        },
      ],
      next: null,
    },
    proposals: [
      {
        id: '3f9a12c04b7e5d1a9c2e8f60b3d417aa',
        op: 2,
        name: 'API_TOKEN',
        kind: 1,
        from: '4HTB-W8CZ',
        handle: 'sam',
        at: ago(12),
      },
      {
        id: 'a81c0e5f92d34b07e6a1c9d8f2b4e0c3',
        op: 3,
        name: 'LEGACY_WEBHOOK_SECRET',
        kind: 3,
        from: 'M5VG-0YSJ',
        handle: 'alex',
        at: ago(180),
      },
    ],
    names: {
      total: 4,
      page: [
        name('API_TOKEN', 3, 4 * 1440, 'sam', { waits: 1 }),
        name('DATABASE_URL', 7, 25 * 1440, 'alex', { rotate: true }),
        name('SIGNING_KEY.pem', 1, 23 * 1440, 'alex', { rotate: true }),
        name('STRIPE_SECRET_KEY', 4, 19 * 1440, null, { rotate: true }),
      ],
      next: null,
    },
    people: {
      total: 3,
      page: [
        {
          handle: 'alex',
          role: 'owner',
          mine: true,
          computers: [{ code: 'M5VG-0YSJ', how: 'first', name: 'desk machine' }],
        },
        { handle: 'sam', role: 'write', computers: [{ code: 'ZX7H-1PRF', how: 'auto' }] },
        {
          handle: 'dana',
          role: 'write',
          left: true,
          leftAt: ago(120),
          computers: [{ code: 'K7QD-2MWX', how: 'code', marked: true }],
        },
      ],
      next: null,
    },
    waiting: [{ code: 'P3TR-88KD', handle: 'jo', at: ago(5) }],
  });
const worst = (): SecretsView => {
  const long = `ENV_${'X'.repeat(56)}_KEY`;
  const handle60 = `quintessential-maintainer-${'x'.repeat(34)}`;
  const people: People = Array.from({ length: 25 }, (_, i) => ({
    handle: i === 0 ? handle60 : i === 1 ? 'b' : i === 2 ? '🦊fox' : `person-${i}`,
    role: i === 0 ? 'owner' : 'write',
    computers: [{ code: `P${String(i).padStart(3, '0')}-ABCD`, how: 'code' }],
  }));
  return ok([
    development({
      takeOut: [{ handle: null, left: false, at: null, codes: ['0000-0001', '0000-0002'] }],
      rotate: {
        total: 787,
        page: Array.from({ length: 100 }, (_, i) => ({
          name: i === 0 ? long : `ROTATE_${String(i).padStart(4, '0')}`,
          kind: 1 as const,
          version: 12840,
          devices: [{ code: '0000-0001', handle: null }],
          more: i === 1 ? 4 : 0,
        })),
        next: 'ROTATE_0099',
      },
      proposals: Array.from({ length: 32 }, (_, i) => ({
        id: `${i.toString(16).padStart(2, '0')}ff00ff${'a'.repeat(24)}`,
        op: ([1, 2, 3] as const)[i % 3]!,
        name: i === 0 ? 'X' : i === 1 ? 'K' : `NAME_${i}`,
        kind: ([2, 1, 3] as const)[i % 3]!,
        from: `ZZ${String(i).padStart(2, '0')}-ZZZZ`,
        handle: i === 0 ? handle60 : i === 1 ? '🦊fox' : i === 2 ? 'b' : null,
        at: ago(i * 7),
      })),
      names: {
        total: 400,
        page: Array.from({ length: 100 }, (_, i) =>
          name(
            i === 0 ? long : i === 1 ? 'X' : `SERVICE_${String(i).padStart(3, '0')}_API_KEY`,
            12840,
            i * 300,
            i === 3 ? null : handle60,
          ),
        ),
        next: 'SERVICE_099_API_KEY',
      },
      people: { total: 61, page: people, next: '000024' },
    }),
    checks({ names: { total: 1, page: [name('X', 1, 5, 'b')], next: null } }),
  ]);
};

function state(which: string): SecretsView {
  switch (which) {
    case 'calm':
      return ok([development(), checks()]);
    case 'removal':
      return ok([removal(), checks()]);
    case 'proposals': {
      const set = removal();
      return ok([{ ...set, takeOut: [], rotate: { total: 0, page: [], next: null } }, checks()]);
    }
    case 'takeout': {
      const set = removal();
      return ok([{ ...set, rotate: { total: 0, page: [], next: null }, proposals: [] }]);
    }
    case 'empty':
      return ok([]);
    case 'loading':
      return { status: 'loading' };
    case 'reader':
      return { status: 'reader' };
    case 'failed':
      return {
        status: 'failed',
        previous: (ok([development(), checks()]) as Extract<SecretsView, { status: 'ready' }>).data,
        lastShown: NOW,
      };
    case 'failed-empty':
      return { status: 'failed' };
    case 'nobody':
      return ok([
        development(),
        checks({
          people: { total: 0, page: [], next: null },
          machines: [],
          names: { total: 4, page: [name('NPM_TOKEN', 2, 6 * 1440, 'alex')], next: null },
        }),
      ]);
    case 'worst':
      return worst();
    default:
      return ok([development(), checks()]);
  }
}

/** The real container (reads, pages, Refresh, denial) over a client whose answers the test settles by hand. Every
 * query it makes waits in `queries` until the test resolves or rejects it. */
function Container() {
  const query = new URLSearchParams(location.search);
  document.documentElement.dataset.ds = '';
  document.documentElement.dataset.theme = query.get('theme') ?? 'dark';
  const queries: { args: Record<string, unknown>; settle(result: unknown, error?: boolean): void }[] = [];
  const actions: Record<string, unknown>[] = [];
  const client = {
    query: (_ref: unknown, args: Record<string, unknown>) =>
      new Promise((resolve, reject) =>
        queries.push({ args, settle: (result, error) => (error ? reject(result) : resolve(result)) }),
      ),
    action: (_ref: unknown, args: Record<string, unknown>) => {
      actions.push(args);
      return Promise.resolve(JSON.stringify({ names: ['API_TOKEN', 'NPM_TOKEN'] }));
    },
  };
  const data = (state('worst') as Extract<SecretsView, { status: 'ready' }>).data;
  (window as unknown as { secretsContainer: unknown }).secretsContainer = {
    queries: () => queries.map(q => q.args),
    actions: () => actions,
    checksSetup: (index: number, configured: boolean) =>
      queries[index]!.settle({
        ...data,
        sets: [
          development(),
          checks({
            names: configured ? { total: 101, page: [], next: 'A' } : { total: 0, page: [], next: null },
            ...(configured ? { checksNamesAfterPage: ['API_TOKEN', 'NPM_TOKEN'] } : {}),
          }),
        ],
      }),
    /** Answers query `index` with the worst-case overview. */
    overview: (index: number, patch: Record<string, unknown> = {}) =>
      queries[index]!.settle({ ...data, ...patch }),
    /** Answers a "Show the next" query with one more page of a set, as `headVersion` and `total` describe it. */
    page: (index: number, part: string, total: number, headVersion: number, names: string[]) =>
      queries[index]!.settle({
        status: 'ok',
        now: 0,
        needs: 0,
        sets: [
          {
            kind: 1,
            sharing: 'automatic',
            headVersion,
            [part]: {
              total,
              next: null,
              page: names.map(n => ({
                name: n,
                kind: 1,
                version: 1,
                devices: [],
                more: 0,
                at: 1,
                by: null,
                waits: 0,
              })),
            },
          },
        ],
      }),
    reader: (index: number) => queries[index]!.settle({ status: 'reader' }),
    fail: (index: number, code?: string) =>
      queries[index]!.settle(code ? new ConvexError({ code }) : new Error('network'), true),
    headVersion: data.sets[0]!.headVersion,
  };
  const route = {
    frame: 'project',
    handle: 'river',
    project: 'test-project',
    place: 'settings',
    section: 'secrets',
    rest: '',
  } as const;
  return (
    <ConvexProvider client={client as never}>
      <ProjectFrame
        route={route}
        name="test-project"
        feed={{ lanes: [], more: 0, moreIsLowerBound: false, main: null }}
        needs={undefined}
        projects={null}
        controls={{ viewerHandle: 'river', onPalette() {}, onKeys() {} }}
      >
        <Secrets
          route={route}
          projectId={'project-1' as never}
          projectName="test-project"
          feed={
            query.has('checksSetup')
              ? { lanes: [], more: 0, moreIsLowerBound: false, main: { head: 'a'.repeat(64) } }
              : undefined
          }
          viewerHandle="river"
        />
      </ProjectFrame>
    </ConvexProvider>
  );
}

function Fixture() {
  const query = new URLSearchParams(location.search);
  const [view, setView] = useState<SecretsView>(() => state(query.get('state') ?? 'calm'));
  const w = window as unknown as { secretsFixture: Record<string, unknown> };
  w.secretsFixture = { show: setView, state, refreshes: 0, more: [] as string[] };
  document.documentElement.dataset.ds = '';
  document.documentElement.dataset.theme = query.get('theme') ?? 'dark';
  const route = {
    frame: 'project',
    handle: 'river',
    project: 'test-project',
    place: 'settings',
    section: 'secrets',
    rest: '',
  } as const;
  return (
    <ProjectFrame
      route={route}
      name="test-project"
      feed={{ lanes: [], more: 0, moreIsLowerBound: false, main: null }}
      needs={undefined}
      projects={null}
      controls={{ viewerHandle: 'river', onPalette() {}, onKeys() {} }}
    >
      <SecretsScreen
        route={route}
        projectName="test-project"
        view={view}
        onRefresh={() => {
          (w.secretsFixture.refreshes as number)++;
        }}
        onMore={(kind, part) => (w.secretsFixture.more as string[]).push(`${kind}:${part}`)}
      />
    </ProjectFrame>
  );
}

createRoot(document.getElementById('root')!).render(
  new URLSearchParams(location.search).get('container') ? <Container /> : <Fixture />,
);
