// SPDX-License-Identifier: Apache-2.0
// Lanes (Item e317b6ea): what needs the reader, then every open Lane on the shell's stops. What landed is History
// (c613e6bc). The yard's stops and held marks are the line feed's, so the counts here are the top bar's. Each row that
// shares saved files with other open Lanes says so and links to Who is touching what (Item f787005c), which replaced
// the Overlaps block that sat below the yard.
// Regions move with the dock. Filters live in the address, so a link, a reload and browser Back show the same view.
// Every link here goes to the one screen that owns it (route.ts in each folder): a row to its Lane (saved changes), a
// failed row to its check, the head to Sessions (where each session links who holds its Lane), and shared files to
// Who is touching what. They are built from the reads above, so following one adds no read here.
// What waits on the reader (Needs you) is Needs me's own rule over Needs me's own read, the one the top bar's count
// already subscribes to (App.tsx), so the head, the filter, the band and the top bar agree and the page adds no read.
// Under the head, where the project stands: Items done, in progress and left. The Lanes reads hold no Item counts
// (they are projectPlanCounts:read, Item 3fa3187d), so those figures say "not reported" here rather than add a read;
// what the page knows, the open Lanes and those that need you, stands beside In progress.
// The command chip shows what an agent gets from `nforge agent . queue`, drawn from the queue read already here.
import { useMemo, useState, type ReactNode } from 'react';
import { Dock, Glyph, Key, Region, useDockLayout, type DockLayout } from '../../ds';
import { useSafeQuery } from '../../safe-query';
import { needsRead } from '../needs/count';
import { queueEntryState } from '../lane-state';
import type { LineFeed } from '../Line';
import { A } from '../frames';
import { hrefFor } from '../paths';
import { navigate, useSearch } from '../router';
import { Head, crumbsFor } from '../Place';
import { SaveFailureNotice } from '../SaveFailureNotice';
import {
  atStop,
  buildYard,
  filterRows,
  laneFocusHref,
  NEEDS_UNKNOWN,
  needsYouLanes,
  sharedFiles,
  sharesByLane,
  situation,
  stopLabel,
  yardReady,
  type Filter,
  type QueueView,
  type LaneMeta,
} from './model';
import { useLaneMeta, useQueue, useSharedFiles } from './reads';
import { Yard } from './Yard';
import { FirstRun, type LanesProps } from './common';

// History (Item c613e6bc) replaced Landed today and the rows replaced Overlaps (f787005c); a layout saved with either
// falls back to this one (useDockLayout).
const LAYOUT: DockLayout = { top: ['yard'], a: [], b: [] };
const filters: readonly { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'needs', label: 'Needs you' },
  { id: 'mine', label: 'Mine' },
];

export function Overview({ route, projectId, projectName, feed, viewerHandle }: LanesProps) {
  const search = useSearch();
  const filter = (filters.find(f => f.id === search.get('show'))?.id ?? 'all') as Filter;
  const stop = search.get('stop');
  const { lanes, error: laneError } = useLaneMeta(projectId, true);
  const { queue, error: queueError } = useQueue(projectId);
  const shared = useSharedFiles(projectId);
  // The frame's own subscription (same query, same args): no second read. If it fails, the yard still shows and
  // says it could not tell which held Lanes need the reader.
  const { value: needs, error: needsError } = useSafeQuery(needsRead, { projectId });
  const [cli, setCli] = useState(false);
  const [layout, setLayout, resetLayout, moved] = useDockLayout('lanes', LAYOUT);
  // Ages ("saved 4 min ago") are worked out when the data changes, never on a timer. Rows wait for all three reads, so
  // a reload never paints titles, people or states that change a moment later (Item 31328be4).
  const yard = useMemo(
    () =>
      feed && (needs || needsError) && yardReady({ feed, lanes, laneError, queue, queueError, shared })
        ? buildYard(
            feed,
            lanes ?? [],
            queue,
            Date.now(),
            needs ? needsYouLanes(needs, Date.now()) : NEEDS_UNKNOWN,
          )
        : null,
    // shared.view and shared.error, not the object rebuilt each render.
    [feed, lanes, laneError, queue, queueError, shared.view, shared.error, needs, needsError],
  );
  const laneHref = (laneId: string) => hrefFor({ ...route, section: '', rest: laneId });
  const checkHref = (laneId: string) => hrefFor({ ...route, section: '', rest: `${laneId}/check` });
  const setFilter = (id: Filter) => {
    const next = new URLSearchParams(location.search);
    if (id === 'all') next.delete('show');
    else next.set('show', id);
    const query = next.toString();
    navigate(`${location.pathname}${query ? `?${query}` : ''}`);
  };
  const said = yard ? situation(yard) : null;
  const shown = yard ? atStop(filterRows(yard.rows, filter, viewerHandle), stop) : [];
  const files = sharedFiles(shared.view);
  const shares = sharesByLane(files.files);
  const touching = hrefFor({ ...route, section: 'touching', rest: '' });
  const touchingFor = (laneId: string) => laneFocusHref(touching, laneId);

  const regions = [
    {
      id: 'yard',
      title: 'On the way to main',
      render: (handle: ReactNode) => (
        <Region
          title="On the way to main"
          handle={handle}
          weight={yard?.counts.needs ? 'act' : 'watch'}
          waiting={yard?.counts.needs ?? 0}
          count={shown.length}
          hint={
            !yard
              ? 'loading'
              : shown.length === yard.rows.length
                ? 'stuck work first'
                : `${shown.length.toLocaleString()} of ${yard.rows.length.toLocaleString()} shown${stopLabel(stop)}`
          }
        >
          {!yard ? (
            <div className="sk-rows" role="status" aria-busy="true" aria-label="Loading the Lanes">
              <div className="sk" />
              <div className="sk" />
              <div className="sk" />
            </div>
          ) : !yard.open ? (
            <div className="empty">
              <h3>Hand an Item to an agent</h3>
              <p>
                A Lane is one agent’s own copy of the project for one piece of work. It shows here the moment
                an agent starts.
              </p>
              <div className="btns">
                <A className="btn primary" href={hrefFor({ ...route, place: 'plan', section: '', rest: '' })}>
                  Pick an Item
                </A>
                <code className="mono">nforge agent . start</code>
              </div>
            </div>
          ) : shown.length ? (
            <>
              <Yard
                project={route}
                rows={shown}
                checking={filter === 'all' && (!stop || stop === 'checking') ? yard.checking : undefined}
                hrefOf={laneHref}
                checkHrefOf={checkHref}
                stops={filter === 'all' && !stop ? yard.stops : undefined}
                needsKnown={yard.needsKnown}
                dense={shown.length > 12}
                sharesOf={laneId => shares.get(laneId)}
                sharesHref={touchingFor}
              />
              {shared.error || (shared.view && !files.complete) ? (
                <div className="pf">
                  {shared.error
                    ? 'Which Lanes share files could not be read. '
                    : 'Some Lanes were not compared, so a row may share more files than it says. '}
                  <A className="lk lanes-inline" href={touching}>
                    Who is touching what
                  </A>
                </div>
              ) : null}
              {shown.some(row => row.longWait) ? (
                <div className="pf">
                  A Lane waits longer than a usual check.{' '}
                  <A className="lk lanes-inline" href={touching}>
                    Who waits on whom
                  </A>
                </div>
              ) : null}
              {yard.beyond || laneError ? (
                <div className="pf">
                  {yard.beyond
                    ? `${yard.beyond.toLocaleString()}${yard.beyondIsLowerBound ? ' or more' : ''} more open Lanes are not shown here. `
                    : null}
                  {laneError ? 'Lane titles could not be read; ids are shown instead. ' : null}
                  <a
                    className="lk lanes-inline"
                    href={`/${encodeURIComponent(route.handle)}/${encodeURIComponent(route.project)}/lanes`}
                  >
                    Every open Lane
                  </a>
                </div>
              ) : null}
            </>
          ) : (
            <div className="empty">
              <h3>{filter === 'mine' ? 'None of these are yours' : 'Nothing here'}</h3>
              <p>
                {yard.rows.length.toLocaleString()} {yard.rows.length === 1 ? 'Lane is' : 'Lanes are'} open in{' '}
                {projectName}.
              </p>
              <Key onClick={() => (stop ? navigate(location.pathname) : setFilter('all'))}>Show all</Key>
            </div>
          )}
        </Region>
      ),
    },
  ];

  return (
    <>
      <Head
        trail={crumbsFor(route, projectName)}
        sentence={
          said ? (
            <>
              <b>{said.lead}</b> {said.rest}
            </>
          ) : (
            'Loading the Lanes…'
          )
        }
      >
        <Key kind="ghost" size="sm" disabled={!moved} onClick={resetLayout} hidden={!moved}>
          Reset layout
        </Key>
        <A className="btn" href={hrefFor({ ...route, section: 'sessions', rest: '' })}>
          Sessions
        </A>
        {yard?.open ? (
          <div className="seg" role="group" aria-label="Show">
            {filters.map(f => (
              <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
                {f.label}
              </button>
            ))}
          </div>
        ) : null}
        <button
          type="button"
          className="cli"
          aria-controls="lanes-cli"
          aria-expanded={cli}
          title="What an agent gets"
          onClick={() => setCli(open => !open)}
        >
          <span className="mono">nforge agent . queue</span>
        </button>
      </Head>
      <pre className="cli-out mono" id="lanes-cli" hidden={!cli}>
        {cli ? queueReply(queue, queueError, lanes, feed) : null}
      </pre>
      <Stands
        lanes={yard ? yard.open : null}
        needs={yard?.counts.needs ?? 0}
        hrefs={{
          done: hrefFor({ ...route, place: 'code', section: '', rest: '' }),
          left: hrefFor({ ...route, place: 'plan', section: '', rest: '' }),
        }}
      />
      {lanes?.map(({ laneId, intent, saveFailure }) => {
        if (!saveFailure) return null;
        const short = laneId.slice(0, 8);
        return (
          <SaveFailureNotice
            key={`${laneId}:${saveFailure.operationId}:${saveFailure.attemptId}`}
            projectId={projectId}
            laneId={laneId}
            failure={saveFailure}
            lane={{ href: laneHref(laneId), label: intent ? `${intent} · ${short}` : `Lane ${short}` }}
          />
        );
      })}
      <FirstRun />
      <Dock
        label="Lanes regions"
        regions={regions}
        layout={layout}
        onLayout={setLayout}
        onReset={resetLayout}
      />
    </>
  );
}

/** Where the project stands (DESIGN.md `.pstate`, the approved flow under the Lanes head). Item counts are not in
 * the Lanes reads, so each says "not reported" (rule 15) instead of a read added for them; In progress also says
 * what this page knows: how many Lanes are open and how many need the reader. */
function Stands({
  lanes,
  needs,
  hrefs,
}: {
  lanes: number | null;
  needs: number;
  hrefs: { done: string; left: string };
}) {
  const open =
    lanes === null
      ? null
      : `${lanes.toLocaleString()} ${lanes === 1 ? 'Lane' : 'Lanes'} open${needs ? `, ${needs.toLocaleString()} need${needs === 1 ? 's' : ''} you` : ''}`;
  return (
    <nav className="pstate lanes-stands" aria-label="Where the project stands">
      <span className="pstate-scope">
        <span>Items in this project</span>
      </span>
      <A className="ps" href={hrefs.done}>
        <span className="st" data-st="passed">
          <Glyph of="passed" />
          Done
        </span>
        <span className="nr">not reported</span>
      </A>
      <span className="ps">
        <span className="st" data-st="active">
          <Glyph of="active" />
          In progress
        </span>
        <span className="nr">not reported</span>
        {open ? <span className="more">· {open}</span> : null}
      </span>
      <A className="ps" href={hrefs.left}>
        <span className="st" data-st="stale">
          <Glyph of="planned" />
          Left
        </span>
        <span className="nr">not reported</span>
      </A>
    </nav>
  );
}

/** What `nforge agent . queue` tells an agent, in short: each listed landing by position (held, or "–" while it has
 * none yet), its Lane and its state, from the queue read this page already holds. */
function queueReply(
  queue: QueueView | undefined,
  queueError: Error | undefined,
  lanes: readonly LaneMeta[] | undefined,
  feed: LineFeed | undefined,
) {
  const head = '$ nforge agent . queue';
  if (!queue) return `${head}\n${queueError ? 'The queue could not be read.' : 'Reading the queue…'}`;
  const title = new Map((lanes ?? []).map(lane => [lane.laneId, lane.intent]));
  const marks = new Map((feed?.lanes ?? []).map(mark => [mark.laneId, mark]));
  const rows = queue.entries.map(entry => {
    const name =
      (entry.laneId ? title.get(entry.laneId) : null) ??
      entry.intentTitle ??
      (entry.laneId ? `Lane ${entry.laneId.slice(0, 8)}` : 'Lane not reported');
    const at = entry.position !== null ? String(entry.position) : entry.hold ? 'held' : '–';
    const said = queueEntryState(entry, entry.laneId ? marks.get(entry.laneId) : null);
    // A held entry says why; a queued one its place, which the position already says.
    const state = entry.position === null && said.why ? `${said.word}, ${said.why}` : said.word;
    return `${at.padEnd(6)}${name.length > 44 ? `${name.slice(0, 43)}… ` : name.padEnd(45)}${state}`;
  });
  const total = `${queue.total.toLocaleString()} in the queue${queue.held ? `, ${queue.held.toLocaleString()} held` : ''}`;
  return [
    head,
    total,
    ...(rows.length
      ? [`${'pos'.padEnd(6)}${'lane'.padEnd(45)}state`, ...rows]
      : ['Nothing is waiting to land.']),
    ...(queue.more ? ['More entries are not listed here.'] : []),
  ].join('\n');
}
