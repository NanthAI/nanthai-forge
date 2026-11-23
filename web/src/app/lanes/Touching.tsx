// SPDX-License-Identifier: Apache-2.0
// Who is touching what (Item eb0bbb94): the pairs of Items whose Lanes saved the same files (Item df1f2d46,
// Crossing.tsx), who waits on whom and why (traced to the front of the queue, Item 9e748e41), the landing
// queue in order with held Lanes apart, and who has what. Built only from the existing queue, hold and overlap
// records the Lanes place already reads; saved work only, so no row here ever proves two Lanes independent. A yard row's
// "shares N files with M Lanes" opens this with `?lane=` (Item f787005c): Where Lanes cross then lists the pairs that
// Lane is in, over its shared files only, with a link back to every pair; the address alone carries it.
import { useMemo, type ReactNode } from 'react';
import { Avatar, Dock, Key, Region, State, useDockLayout, type DockLayout } from '../../ds';
import { CrossList } from './Crossing';
import { crossPairs, mostlyOne, type CrossSide } from './cross-pairs';
import { A } from '../frames';
import { hrefFor } from '../paths';
import { Head, crumbsFor } from '../Place';
import { useSearch } from '../router';
import type { LanesProps } from './common';
import { currentEntries, queueEntryState, waitLine, type LaneMark } from '../lane-state';
import {
  LANE_FOCUS,
  buildYard,
  filesOfLane,
  sharedFiles,
  waits,
  yardReady,
  type QueueEntry,
  type QueueView,
  type Wait,
  type YardRow,
} from './model';
import { useLaneMeta, useQueue, useSharedFiles } from './reads';

const LAYOUT: DockLayout = { top: ['cross'], a: ['waits', 'queue'], b: ['has'] };
const CAP = 8;

/** Which Lanes Forge observed a conflict on: the Lane's current submission did not compose. The line feed's overlap
 * flag is only a shared saved file, never a conflict (owner 2026-11-23), so it ranks nothing here. Item 9b9057a9 wires
 * its observed-conflict signal into this one predicate; until then the queue lists no ended submission and it finds
 * none, so the Conflict band stays hidden. */
function conflictsOf(queue: QueueView | undefined) {
  const latest = currentEntries(queue?.entries ?? []);
  return (laneId: string) => latest.get(laneId)?.landingState?.state === 'conflict';
}

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
  const shared = useSharedFiles(projectId);
  const [layout, setLayout, resetLayout, moved] = useDockLayout('touching', LAYOUT);
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
  const all = useMemo(() => sharedFiles(shared.view), [shared.view]);
  const focus = useSearch().get(LANE_FOCUS);
  const files = useMemo(() => ({ ...all, files: filesOfLane(all.files, focus) }), [all, focus]);
  const everyFile = hrefFor({ ...route, section: 'touching', rest: '' });
  const markOf = new Map(feed?.lanes.map(mark => [mark.laneId, mark]));
  const current = currentEntries(queue?.entries ?? []);
  const conflicted = useMemo(() => conflictsOf(queue), [queue]);
  // One side per Item, so an Item with three Lanes is named once; a Lane the Lane page did not list stands alone.
  // Worked out again only when a read changes.
  const cross = useMemo(() => {
    const titles = new Map(yard?.rows.map(row => [row.laneId, row.title]));
    const intentOf = new Map(lanes?.map(lane => [lane.laneId, lane.intentId]));
    const sideOf = (laneId: string): CrossSide => ({
      key: intentOf.get(laneId) ?? laneId,
      title: titles.get(laneId) ?? `Lane ${laneId.slice(0, 8)}`,
    });
    const everyPair = crossPairs(all.files, sideOf, conflicted);
    const crossed = focus
      ? crossPairs(files.files, sideOf, conflicted).filter(
          pair => pair.aLanes.includes(focus) || pair.bLanes.includes(focus),
        )
      : everyPair;
    return {
      between: everyPair.filter(pair => pair.b).length,
      pairs: crossed.filter(pair => pair.b),
      own: crossed.filter(pair => !pair.b),
      mostly: focus ? null : mostlyOne(all.files, sideOf),
    };
  }, [all, files, focus, lanes, conflicted, yard]);
  const ordered = (queue?.entries ?? []).filter(entry => entry.position !== null);
  // Out of the order: held for a person, a dependency or main, and ended checks; only each Lane's current submission
  // (an earlier one is history).
  const held = (queue?.entries ?? []).filter(
    entry => entry.position === null && (!entry.laneId || current.get(entry.laneId) === entry),
  );
  const pairs = waits(
    (queue?.entries ?? []).filter(entry => !entry.laneId || current.get(entry.laneId) === entry),
    titleOf,
  );
  const onPerson = pairs.filter(pair => pair.person).length;
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
    : all.files.length
      ? `${all.files.length.toLocaleString()} ${all.files.length === 1 ? 'file is' : 'files are'} saved in more than one Lane${
          cross.between
            ? `; ${cross.between.toLocaleString()} ${cross.between === 1 ? 'pair' : 'pairs'} of Items cross`
            : ''
        }.`
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
          count={
            shared.view && (lanes || laneError) && (queue || queueError) ? cross.pairs.length : undefined
          }
          hint="pairs of Items, a conflict first, then most shared files · saved work only"
        >
          {focus && yard ? (
            <p className="quietline">
              The pairs{' '}
              <A className="lk lanes-inline" href={laneHref(focus)} dir="auto">
                {titleOf(focus)}
              </A>{' '}
              is in, over its own shared files.{' '}
              <A className="lk" href={everyFile}>
                Every pair
              </A>
            </p>
          ) : null}
          {shared.error ? (
            <p className="quietline">The overlaps could not be read.</p>
          ) : !shared.view || (!lanes && !laneError) || (!queue && !queueError) || (focus && !yard) ? (
            // The pairs wait for the Lane page (which Item each Lane is for) and the queue (which Lane did not compose),
            // so they never regroup once drawn; with a
            // Lane picked they wait for its title too, so the line above never pushes them down.
            <div className="sk-rows" aria-busy="true" aria-label="Loading the overlaps">
              <div className="sk" />
            </div>
          ) : cross.pairs.length || cross.own.length ? (
            <>
              {cross.mostly ? (
                <p className="quietline">
                  Most of it is one Item:{' '}
                  <span className="cx-title" dir="auto">
                    {cross.mostly.side.title}
                  </span>{' '}
                  is in {cross.mostly.files.toLocaleString()} of the {all.files.length.toLocaleString()}{' '}
                  files.
                </p>
              ) : null}
              <CrossList
                pairs={cross.pairs}
                own={cross.own}
                shared={files.files}
                laneHref={laneHref}
                conflicted={conflicted}
              />
            </>
          ) : (
            <p className="quietline">
              {focus
                ? 'This Lane shares no saved file with another open Lane now.'
                : 'No two open Lanes have saved changes to the same file.'}
            </p>
          )}
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
