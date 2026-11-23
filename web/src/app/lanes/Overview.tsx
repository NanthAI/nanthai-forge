// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Lanes (Item e317b6ea): what needs the reader, then every open Lane on the shell's stops. What landed is History
// (c613e6bc). The yard's stops and held marks are the line feed's, so the counts here are the top bar's. Each row that
// shares saved files with other open Lanes says so and links to Who is touching what (Item f787005c), which replaced
// the Overlaps block that sat below the yard.
// Regions move with the dock. Filters live in the address, so a link, a reload and browser Back show the same view.
// Every link here goes to the one screen that owns it (route.ts in each folder): a row to its Lane (saved changes), a
// failed row to its check and shared files to Who is touching what. They are built from the reads above, so following one adds no read here.
// What waits on the reader (Needs you) is Needs me's own rule over Needs me's own read, the one the top bar's count
// already subscribes to (App.tsx), so the band, the filter and the top bar agree and the page adds no read. There is no
// headline sentence and no backlog bar here: the top bar and the section headers say it, and the backlog is Plan's
// (owner 2026-11-23). One status filter and a Mine toggle sit in the head's row, kept in the address.
// The command chip shows what an agent gets from `nforge agent . queue`, drawn from the queue read already here.
import { useMemo, useState, type ReactNode } from 'react';
import { Dock, Key, Region, useDockLayout, type DockLayout } from '../../ds';
import { useSafeQuery } from '../../safe-query';
import { needsRead } from '../needs/count';
import { queueEntryState } from '../lane-state';
import { lineStops, type LineFeed } from '../Line';
import { A } from '../frames';
import { hrefFor } from '../paths';
import { navigate, useSearch } from '../router';
import { Head, crumbsFor } from '../Place';
import { SaveFailureNotice } from '../SaveFailureNotice';
import {
  buildYard,
  filterOf,
  filterRows,
  laneFocusHref,
  NEEDS_UNKNOWN,
  needsYouLanes,
  sharedFiles,
  sharesByLane,
  statuses,
  stopLabel,
  yardReady,
  type Status,
  type QueueView,
  type LaneMeta,
} from './model';
import { useLaneMeta, useQueue, useSharedFiles } from './reads';
import { Yard } from './Yard';
import { FirstRun, type LanesProps } from './common';

// History (Item c613e6bc) replaced Landed today and the rows replaced Overlaps (f787005c); a layout saved with either
// falls back to this one (useDockLayout).
const LAYOUT: DockLayout = { top: ['yard'], a: [], b: [] };
export function Overview({ route, projectId, projectName, feed, viewerHandle }: LanesProps) {
  const search = useSearch();
  const filter = filterOf(search);
  const stop = lineStops.find(entry => entry.stage === filter.status)?.stage ?? null;
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
  const setFilter = (change: { status?: Status; mine?: boolean }) => {
    const next = new URLSearchParams(location.search);
    const status = change.status ?? filter.status;
    const mine = change.mine ?? filter.mine;
    next.delete('stop');
    if (status === 'all') next.delete('show');
    else next.set('show', status);
    if (mine) next.set('mine', '1');
    else next.delete('mine');
    const query = next.toString();
    navigate(`${location.pathname}${query ? `?${query}` : ''}`);
  };
  const shown = yard ? filterRows(yard.rows, filter, viewerHandle) : [];
  const files = sharedFiles(shared.view);
  const shares = sharesByLane(files.files);
  const touching = hrefFor({ ...route, section: 'touching', rest: '' });
  const touchingFor = (laneId: string) => laneFocusHref(touching, laneId);

  // What was not covered says so whatever the filter shows, an empty result included.
  const coverage = yard ? (
    <>
      {filter.status === 'needs' && yard.needsKnown !== 'all' ? (
        <div className="pf">Not every held Lane was checked for you, so this list may be incomplete.</div>
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
  ) : null;

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
                checking={
                  !filter.mine && (filter.status === 'all' || stop === 'checking') ? yard.checking : undefined
                }
                hrefOf={laneHref}
                checkHrefOf={checkHref}
                stops={!filter.mine && filter.status === 'all' ? yard.stops : undefined}
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
            </>
          ) : (
            <div className="empty">
              <h3>{filter.mine ? 'None of these are yours' : 'Nothing here'}</h3>
              <p>
                {yard.rows.length.toLocaleString()} listed {yard.rows.length === 1 ? 'Lane is' : 'Lanes are'}{' '}
                open in {projectName}.
              </p>
              <Key onClick={() => setFilter({ status: 'all', mine: false })}>Show all</Key>
            </div>
          )}
          {yard?.open ? coverage : null}
        </Region>
      ),
    },
  ];

  return (
    <>
      <Head trail={crumbsFor(route, projectName)}>
        <Key kind="ghost" size="sm" disabled={!moved} onClick={resetLayout} hidden={!moved}>
          Reset layout
        </Key>
        {yard?.open ? (
          <>
            <select
              className="inp"
              aria-label="Show"
              value={filter.status}
              onChange={event => setFilter({ status: event.target.value as Status })}
            >
              {statuses.map(status => (
                <option key={status.id} value={status.id}>
                  {status.label}
                </option>
              ))}
            </select>
            <div className="seg" role="group" aria-label="Mine">
              <button
                type="button"
                aria-pressed={filter.mine}
                onClick={() => setFilter({ mine: !filter.mine })}
              >
                Mine
              </button>
            </div>
          </>
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
