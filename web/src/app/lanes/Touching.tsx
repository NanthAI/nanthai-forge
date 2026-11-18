// SPDX-License-Identifier: Apache-2.0
// Who is touching what (Item eb0bbb94): files saved in more than one Lane, who waits on whom and why (traced to the
// front of the queue, Item 9e748e41), the landing
// queue in order with held Lanes apart, and who has what. Built only from the existing queue, hold and overlap
// records the Lanes place already reads; saved work only, so no row here ever proves two Lanes independent.
import { useMemo, type ReactNode } from 'react';
import { Avatar, Dock, Key, Region, State, useDockLayout, type DockLayout } from '../../ds';
import { A } from '../frames';
import { hrefFor } from '../paths';
import { Head, crumbsFor } from '../Place';
import type { LanesProps } from './common';
import { currentEntries, queueEntryState, waitLine, type LaneMark } from '../lane-state';
import { buildYard, sharedFiles, waits, yardReady, type QueueEntry, type Wait, type YardRow } from './model';
import { useLaneMeta, useQueue, useSharedFiles } from './reads';

const LAYOUT: DockLayout = { top: ['cross'], a: ['waits', 'queue'], b: ['has'] };
const CAP = 8;

const age = (from: string, now: number) => {
  const minutes = Math.max(0, Math.round((now - Date.parse(from)) / 60_000));
  return minutes < 60
    ? `${minutes} min`
    : minutes < 2880
      ? `${Math.round(minutes / 60)} h`
      : `${Math.round(minutes / 1440)} d`;
};

export function Touching({ route, projectId, projectName, feed }: LanesProps) {
  const { lanes, error: laneError } = useLaneMeta(projectId);
  const { queue, error: queueError } = useQueue(projectId);
  const shared = useSharedFiles(projectId, true);
  const [layout, setLayout, resetLayout] = useDockLayout('touching', LAYOUT);
  const now = Date.now();
  const yard = useMemo(
    () =>
      feed && yardReady({ feed, lanes, laneError, queue, queueError })
        ? buildYard(feed, lanes ?? [], queue, Date.now())
        : null,
    [feed, lanes, laneError, queue, queueError],
  );
  const rowOf = new Map<string, YardRow>(yard?.rows.map(row => [row.laneId, row]));
  const titleOf = (laneId: string) => rowOf.get(laneId)?.title ?? `Lane ${laneId.slice(0, 8)}`;
  const laneHref = (laneId: string) => hrefFor({ ...route, section: '', rest: laneId });
  const files = sharedFiles(shared.view);
  const ordered = (queue?.entries ?? []).filter(entry => entry.position !== null);
  // Out of the order: held for a person, a dependency or main, and ended checks; only each Lane's current submission
  // (an earlier one is history).
  const current = currentEntries(queue?.entries ?? []);
  const held = (queue?.entries ?? []).filter(
    entry => entry.position === null && (!entry.laneId || current.get(entry.laneId) === entry),
  );
  const pairs = waits(
    (queue?.entries ?? []).filter(entry => !entry.laneId || current.get(entry.laneId) === entry),
    titleOf,
  );
  const onPerson = pairs.filter(pair => pair.person).length;
  const markOf = new Map(feed?.lanes.map(mark => [mark.laneId, mark]));
  const row = (entry: QueueEntry) => (
    <QueueRow
      key={entry.submissionId ?? entry.laneId ?? entry.submittedAt}
      entry={entry}
      title={entry.laneId ? titleOf(entry.laneId) : (entry.intentTitle ?? 'A landing')}
      href={entry.laneId ? laneHref(entry.laneId) : null}
      mark={entry.laneId ? (markOf.get(entry.laneId) ?? null) : null}
      wait={waitLine(entry, ordered, now)?.line ?? null}
    />
  );
  const lead = !shared.view
    ? 'Loading the Lanes…'
    : files.files.length
      ? `${files.files.length.toLocaleString()} ${files.files.length === 1 ? 'file is' : 'files are'} saved in more than one Lane.`
      : 'No two open Lanes have saved the same file.';
  const rest = queue
    ? `${onPerson ? `${onPerson.toLocaleString()} ${onPerson === 1 ? 'Lane waits' : 'Lanes wait'} on a person, ` : ''}${(pairs.length - onPerson).toLocaleString()} on another Lane or on main.`
    : '';
  const more = (n: number, words: string) =>
    n > 0 ? (
      <div className="pf">
        {n.toLocaleString()} {words}.{' '}
        <a
          className="lk"
          href={`/${encodeURIComponent(route.handle)}/${encodeURIComponent(route.project)}/lanes`}
        >
          Every open Lane
        </a>
      </div>
    ) : null;
  const regions = [
    {
      id: 'cross',
      title: 'Where Lanes cross',
      render: (handle: ReactNode) => (
        <Region
          title="Where Lanes cross"
          handle={handle}
          weight="watch"
          count={shared.view ? files.files.length : undefined}
          hint="saved work only: unsaved edits are not seen"
        >
          {shared.error ? (
            <p className="quietline">The overlaps could not be read.</p>
          ) : !shared.view ? (
            <div className="sk-rows" aria-busy="true" aria-label="Loading the overlaps">
              <div className="sk" />
            </div>
          ) : files.files.length ? (
            <ul className="lanes-files">
              {files.files.slice(0, CAP).map(file => (
                <li key={file.path} className="row">
                  <span className="lanes-path">
                    <State word="Set aside" state="stale">
                      Same file
                    </State>
                    <span className="mono any" translate="no" dir="ltr">
                      {file.path}
                    </span>
                  </span>
                  <span className="meta t2">
                    {file.laneIds.map((id, index) => (
                      <span key={id}>
                        {index ? (index === file.laneIds.length - 1 ? ' and ' : ', ') : ''}
                        <A className="lk" href={laneHref(id)} dir="auto">
                          {titleOf(id)}
                        </A>
                        {rowOf.get(id)?.overlap ? ' (conflict)' : ''}
                      </span>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="quietline">No two open Lanes have saved changes to the same file.</p>
          )}
          {more(files.files.length - CAP, 'more shared files')}
          {shared.view && !files.complete ? (
            <div className="pf">Some Lanes were not compared, so this list may be short.</div>
          ) : null}
        </Region>
      ),
    },
    {
      id: 'has',
      title: 'Who has what',
      render: (handle: ReactNode) => (
        <Region
          title="Who has what"
          handle={handle}
          weight="ref"
          count={yard?.rows.length}
          hint="open Lanes, latest change first"
        >
          {(yard?.rows ?? [])
            .slice()
            .sort((a, b) => b.changedAt - a.changedAt)
            .slice(0, 12)
            .map(row => (
              <A key={row.laneId} className="row lanes-has" href={laneHref(row.laneId)}>
                <Avatar handle={row.actor ?? '?'} />
                <span className="any">
                  <span className="ttl wrap2" dir="auto">
                    {row.title}
                  </span>
                  <span className="meta mono cut" translate="no">
                    {row.actor ?? 'not reported'}
                  </span>
                </span>
                <State word={row.glyph} state={row.state}>
                  {row.word}
                </State>
              </A>
            ))}
          {more((yard?.rows.length ?? 0) - 12 + (yard?.beyond ?? 0), 'more open Lanes')}
        </Region>
      ),
    },
    {
      id: 'waits',
      title: 'Who waits on whom',
      render: (handle: ReactNode) => (
        <Region
          title="Who waits on whom"
          handle={handle}
          weight={onPerson ? 'act' : 'watch'}
          waiting={onPerson}
          count={queue ? pairs.length : undefined}
          hint="waits on a person first, longest first"
        >
          {queueError ? <p className="quietline">The landing queue could not be read.</p> : null}
          {queue && !pairs.length ? <p className="quietline">No Lane is waiting on another.</p> : null}
          {pairs.slice(0, CAP).map(pair => (
            <WaitRow
              key={pair.laneId}
              pair={pair}
              titleOf={titleOf}
              laneHref={laneHref}
              decideHref={hrefFor({ ...route, place: 'needs', section: '', rest: '' })}
              now={now}
            />
          ))}
          {more(pairs.length - CAP, 'more waits, none on a person')}
        </Region>
      ),
    },
    {
      id: 'queue',
      title: 'Landing queue',
      render: (handle: ReactNode) => (
        <Region
          title="Landing queue"
          handle={handle}
          weight="watch"
          count={queue ? queue.total : undefined}
          hint="in order, each checked on top of the one before"
        >
          {queue && !ordered.length ? <p className="quietline">Nothing is in the landing queue.</p> : null}
          {ordered.map(row)}
          {queue && queue.more ? <div className="pf">More are in the queue than are listed here.</div> : null}
          {held.length ? (
            <>
              <div className="band">
                <span>Held, out of the order</span>{' '}
                <span className="cnt">{held.length.toLocaleString()}</span>
              </div>
              {held.map(row)}
            </>
          ) : null}
        </Region>
      ),
    },
  ];
  const moved = JSON.stringify(layout) !== JSON.stringify(LAYOUT);
  return (
    <>
      <Head
        trail={crumbsFor(route, projectName)}
        sentence={
          <>
            <b>{lead}</b> {rest}
          </>
        }
      >
        <Key kind="ghost" size="sm" onClick={resetLayout} hidden={!moved}>
          Reset layout
        </Key>
      </Head>
      <Dock
        label="Who is touching what"
        regions={regions}
        layout={layout}
        onLayout={setLayout}
        onReset={resetLayout}
      />
    </>
  );
}

/** One wait: who waits on whom and why, and for a Lane further back, the front of the queue and why it has not
 * landed (the blocked path, Item 9e748e41). */
export function WaitRow({
  pair,
  titleOf,
  laneHref,
  decideHref,
  now,
}: {
  pair: Wait;
  titleOf: (laneId: string) => string;
  laneHref: (laneId: string) => string;
  decideHref: string;
  now: number;
}) {
  return (
    <div className="row lanes-wait">
      <span className="any">
        <A className="ttl" href={laneHref(pair.laneId)} dir="auto">
          {titleOf(pair.laneId)}
        </A>{' '}
        <span className="t3">waits on</span>{' '}
        <span className="ttl" dir="auto">
          {pair.on}
        </span>
        <span className="meta" style={{ display: 'block' }} dir="auto">
          {pair.why || 'no reason was recorded'}
          {pair.since ? ` · ${age(pair.since, now)}` : ''}
        </span>
        {pair.front ? (
          <span className="meta t3" style={{ display: 'block' }} dir="auto">
            {pair.front.ahead.toLocaleString()} Lanes ahead; the queue moves when{' '}
            <A className="lk lanes-inline" href={laneHref(pair.front.laneId)} dir="auto">
              {pair.front.title}
            </A>{' '}
            lands ({pair.front.why})
          </span>
        ) : null}
      </span>
      {pair.person ? (
        <A className="btn sm rec" href={decideHref}>
          Decide
        </A>
      ) : null}
    </div>
  );
}

function QueueRow({
  entry,
  title,
  href,
  mark,
  wait,
}: {
  entry: QueueEntry;
  title: string;
  href: string | null;
  mark: LaneMark | null;
  wait: string | null;
}) {
  const name = href ? (
    <A className="ttl cut" href={href} dir="auto">
      {title}
    </A>
  ) : (
    <span className="ttl cut" dir="auto">
      {title}
    </span>
  );
  const said = queueEntryState(entry, mark);
  return (
    <div className="row lanes-q">
      <span className="qn" aria-label={entry.position ? `number ${entry.position}` : 'held'}>
        {entry.position ?? '–'}
      </span>
      <span className="any">
        {name}
        <span className="meta cut" style={{ display: 'block' }}>
          {entry.hold?.reason ??
            (entry.position === null
              ? said.why
              : entry.position === 1
                ? 'lands next'
                : (wait ?? `behind ${entry.position - 1}`))}
        </span>
      </span>
      <State word={said.glyph} state={said.kind}>
        {said.word}
      </State>
    </div>
  );
}
