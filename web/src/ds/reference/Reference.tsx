// SPDX-License-Identifier: Apache-2.0
// The design system's reference surface (dev only: web/ds.html, not a build input). One screen built from the shared
// parts only, so a change to a part shows here first and tests/ds-reference.test.mjs can check it in a real browser.
// All figures are invented and marked as sample data.
import { useEffect, useState, type ReactNode } from 'react';
import { Avatar, Count, ItemState, KindMark, State, Who } from '../marks';
import { Band, Chip, CodeBox, Key, Prose, Region, Row, Standing, Table, useFold } from '../parts';
import {
  Dock,
  Menu,
  Palette,
  ReorderList,
  Sheet,
  useDockLayout,
  type DockLayout,
  type ReorderItem,
} from '../interactive';
import { Figures } from './Figures';
import { DocsFrame } from '../DocsFrame';
import '../docs.css';
import { Discussion } from '../../app/discussion/Discussion';
import type { DiscussionComment, ReactionCount } from '../../app/discussion/model';

type Planned = ReorderItem & { state: 'planned' | 'proposed'; by: string };

const PLAN: Planned[] = [
  { id: 'i1', label: 'Split the import step', state: 'planned', by: '@sample-one' },
  {
    id: 'i2',
    label: 'Retry uploads after a dropped connection',
    state: 'planned',
    by: '@sample-two/builder',
  },
  { id: 'i3', label: 'Show the landing queue on a phone', state: 'planned', by: '@sample-one' },
  {
    id: 'i4',
    label: 'Keep the reader’s place after a reload',
    state: 'proposed',
    by: '@sample-three/reviewer',
  },
  { id: 'i5', label: 'Drop the old export format', state: 'proposed', by: '@sample-two' },
];

const CHECKS = [
  { id: 'c1', name: 'Type check', state: 'passed' as const, minutes: 1.4 },
  { id: 'c2', name: 'Unit tests', state: 'failed' as const, minutes: 3.9 },
  { id: 'c3', name: 'Browser tests', state: 'active' as const, minutes: 6.2 },
];

const NOTE = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const COMMENTS: DiscussionComment[] = [
  {
    id: NOTE(1),
    itemId: NOTE(0),
    at: '2026-11-10T16:20:00Z',
    author: 'sample-two',
    text: 'Do we resend the whole file, or only the missing parts?',
  },
  {
    id: NOTE(2),
    itemId: NOTE(0),
    at: '2026-11-10T16:41:00Z',
    author: 'sample-one',
    replyTo: NOTE(1),
    decision: true,
    text: 'Only the missing parts. **Parts already sent are kept.**',
  },
  {
    id: NOTE(3),
    itemId: NOTE(0),
    at: '2026-11-11T09:20:00Z',
    author: 'sample-one',
    agent: 'keen-impala',
    text: 'Done in landing `5c1e`:\n\n- retries wait for the connection\n- the rest is sent once\n\n<b>raw HTML</b> is dropped; [links](https://example.com) open safely.',
  },
];
const REACTIONS: ReactionCount[] = [
  { commentId: NOTE(2), kind: '+1', count: 2, mine: true },
  { commentId: NOTE(3), kind: 'rocket', count: 1, mine: false },
];

const LAYOUT: DockLayout = { top: ['needs'], a: ['plan', 'lanes'], b: ['checks', 'notes'] };

export function Reference() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [plan, setPlan] = useState(PLAN);
  const [sheet, setSheet] = useState(false);
  const [palette, setPalette] = useState(false);
  const [filters, setFilters] = useState(['Mine', 'Needs you']);
  const [layout, setLayout, resetLayout] = useDockLayout('reference', LAYOUT);
  // The screen holds this fold so what the region reads waits until it is open (Region foldState).
  const notesFold = useFold('reference-notes', false);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPalette(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const move = (id: string, to: number) =>
    setPlan(items => {
      const rest = items.filter(item => item.id !== id);
      rest.splice(
        to,
        0,
        items.find(item => item.id === id)!,
      );
      return rest;
    });

  const regions = [
    {
      id: 'needs',
      title: 'Needs you',
      render: (handle: ReactNode) => (
        <Region
          title="Needs you"
          weight="act"
          waiting="c2"
          count={2}
          handle={handle}
          hint="held until a person decides"
        >
          <Band title="Decisions" count={1} needs />
          <Row weight="act">
            <State word="Conflict" />
            <span className="ttl cut">Two Lanes change the same lines in the upload step</span>
            <Who handle="@sample-two/builder" app="an agent app" />
            <Key kind="primary" size="sm" keys="a" onClick={() => setSheet(true)}>
              Choose
            </Key>
          </Row>
          <Band title="Checks" count={1} />
          <Row weight="act">
            <State word="Check failed" />
            <span className="ttl cut">Unit tests on “Retry uploads after a dropped connection”</span>
            <Menu
              label="More"
              className="btn sm ghost"
              items={[
                { id: 'retry', label: 'Retry the check', keys: 'r', onAction: () => undefined },
                { id: 'open', label: 'Open the output', onAction: () => undefined },
                'separator',
                { id: 'aside', label: 'Set the Lane aside', danger: true, onAction: () => undefined },
              ]}
            />
          </Row>
        </Region>
      ),
    },
    {
      id: 'plan',
      title: 'Plan, in order',
      render: (handle: ReactNode) => (
        <Region
          title="Plan, in order"
          weight="watch"
          count={plan.length}
          handle={handle}
          fold="reference-plan"
          sum={`${plan.length} Items, next: ${plan[0]?.label ?? 'none'}`}
        >
          <ReorderList label="Planned Items, in order" items={plan} onMove={move}>
            {(item, index) => (
              <>
                <span className="num t3">{index + 1}</span>
                <ItemState of={item.state} />
                <span className="ttl cut">{item.label}</span>
                <span className="meta">
                  <Avatar handle={item.by} />
                </span>
              </>
            )}
          </ReorderList>
        </Region>
      ),
    },
    {
      id: 'lanes',
      title: 'Lanes',
      render: (handle: ReactNode) => (
        <Region title="Lanes" weight="watch" count={3} handle={handle} fold="reference-lanes">
          {(
            [
              ['Working', 'Split the import step', '@sample-one/builder'],
              ['Waiting its turn', 'Show the landing queue on a phone', '@sample-three/reviewer'],
              ['Landed', 'Keep the parser’s buffer', '@sample-two/builder'],
            ] as const
          ).map(([word, title, who]) => (
            <Row key={title}>
              <KindMark kind="lane" />
              <span className="ttl cut">{title}</span>
              <State word={word} />
              <Who handle={who} />
            </Row>
          ))}
        </Region>
      ),
    },
    {
      id: 'checks',
      title: 'Checks',
      render: (handle: ReactNode) => (
        <Region title="Checks" weight="ref" count={CHECKS.length} handle={handle} hint="reported by your CI">
          <Table
            caption="Checks on the current Lane"
            rowKey={row => row.id}
            rows={CHECKS}
            columns={[
              { key: 'name', title: 'Check', cell: row => row.name },
              {
                key: 'state',
                title: 'State',
                cell: row => (
                  <State
                    word={
                      row.state === 'passed' ? 'Landed' : row.state === 'failed' ? 'Check failed' : 'Checking'
                    }
                    state={row.state}
                  />
                ),
              },
              { key: 'min', title: 'Minutes', numeric: true, cell: row => row.minutes.toLocaleString() },
            ]}
          />
        </Region>
      ),
    },
    {
      id: 'notes',
      title: 'Notes',
      render: (handle: ReactNode) => (
        <Region title="Notes" weight="ref" handle={handle} fold="reference-notes" foldState={notesFold}>
          {notesFold[0] ? <p className="quietline">Read when opened.</p> : null}
          <Prose label="Item text">
            <p>
              Uploads restart from the last saved part. <code>retryUpload()</code> waits for the connection,
              then sends the rest.
            </p>
          </Prose>
          <CodeBox label="Change to the upload step">
            <div className="l del">
              <span className="n">12</span>
              <span className="n" />
              <span className="c">send(all)</span>
            </div>
            <div className="l add">
              <span className="n" />
              <span className="n">12</span>
              <span className="c">send(rest(from))</span>
            </div>
          </CodeBox>
          <Discussion
            comments={COMMENTS}
            reactions={REACTIONS}
            canWrite
            onPost={async () => {}}
            onReact={async () => {}}
          />
        </Region>
      ),
    },
  ];

  return (
    <div className="ds-ref">
      <header className="head">
        <h1>Needs me</h1>
        <span className="sit">
          <b>2 things need you.</b> Sample data throughout.
        </span>
        <span className="tools">
          <Key size="sm" kind="ghost" onClick={() => setPalette(true)} keys="⌘K">
            Go to or run
          </Key>
          <Key
            size="sm"
            kind="ghost"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            aria-pressed={theme === 'light'}
          >
            Light
          </Key>
        </span>
      </header>
      <Standing
        of="app"
        done={{ n: 5, more: '14 landed today' }}
        inProgress={{ n: 5, more: '5 Lanes open, 2 need you' }}
        left={{ n: 7, more: `next: ${plan[0]?.label ?? 'none'}` }}
      />
      <div className="tbar">
        {filters.map(filter => (
          <Chip
            key={filter}
            label={filter}
            onRemove={() => setFilters(all => all.filter(f => f !== filter))}
          />
        ))}
        <Chip label="Kind" value="any" off />
        <Count n={plan.length} label={`${plan.length} Items`} />
      </div>
      <Dock
        label="Regions on this screen"
        regions={regions}
        layout={layout}
        onLayout={setLayout}
        onReset={resetLayout}
      />
      <Figures />
      <section aria-label="Public standing" className="region">
        <div className="ph plain">
          <h2>On the public page</h2>
        </div>
        <Standing of="public" done={{ n: 14 }} inProgress={{ n: 5 }} left={{ n: 31 }} />
      </section>
      <section aria-label="Documentation frame">
        <DocsFrame
          current="/docs/"
          groups={[
            {
              label: 'Start here',
              pages: [
                { title: 'Documentation', href: '/docs/' },
                { title: 'Quickstart', href: '/docs/quickstart/' },
              ],
            },
          ]}
        >
          <h2>Documentation</h2>
          <p>
            One readable column and a left tree. <a href="/docs/">Open the docs</a>.
          </p>
        </DocsFrame>
      </section>
      <Sheet
        open={sheet}
        onOpenChange={setSheet}
        title="Which side lands first?"
        footer={
          <>
            <Key onClick={() => setSheet(false)}>Later</Key>
            <Key kind="primary" keys="a" onClick={() => setSheet(false)}>
              Upload step first
            </Key>
          </>
        }
      >
        <p>
          Both Lanes change the same lines. The one that lands second is checked again on top of the first.
        </p>
      </Sheet>
      <Palette
        open={palette}
        onOpenChange={setPalette}
        groups={[
          {
            title: 'Needs you',
            entries: [
              {
                id: 'p1',
                label: 'Conflict: the upload step',
                lead: <State word="Conflict" />,
                onAction: () => setSheet(true),
              },
            ],
          },
          { title: 'Run', entries: [{ id: 'p2', label: 'Reset this page’s layout', onAction: resetLayout }] },
          {
            title: 'Go to',
            entries: plan.map(item => ({
              id: `go-${item.id}`,
              label: `Item: ${item.label}`,
              onAction: () => undefined,
            })),
          },
        ]}
      />
    </div>
  );
}
