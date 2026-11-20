// SPDX-License-Identifier: Apache-2.0
// Lanes (Item e317b6ea): what needs the reader, then every open Lane on the shell's stops. What landed is History
// (c613e6bc). The yard's stops and held marks are the line feed's, so the counts here are the top bar's. Each row that
// shares saved files with other open Lanes says so and links to Who is touching what (Item f787005c), which replaced
// the Overlaps block that sat below the yard.
// Regions move with the dock. Filters live in the address, so a link, a reload and browser Back show the same view.
import { useMemo, type ReactNode } from 'react';
import { Dock, Key, Region, useDockLayout, type DockLayout } from '../../ds';
import { A } from '../frames';
import { hrefFor } from '../paths';
import { navigate, useSearch } from '../router';
import { Head, crumbsFor } from '../Place';
import {
  atStop,
  buildYard,
  filterRows,
  laneFocusHref,
  sharedFiles,
  sharesByLane,
  situation,
  stopLabel,
  yardReady,
  type Filter,
} from './model';
import { useLaneMeta, useQueue, useSharedFiles } from './reads';
import { Yard } from './Yard';
import { FirstRun, type LanesProps } from './common';

// History (Item c613e6bc) replaced Landed today and the rows replaced Overlaps (f787005c); a layout saved with either
// falls back to this one (useDockLayout).
const LAYOUT: DockLayout = { top: ['yard'], a: [], b: [] };
const filters: readonly { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'needs', label: 'Held' },
  { id: 'mine', label: 'Mine' },
];

export function Overview({ route, projectId, projectName, feed, viewerHandle }: LanesProps) {
  const search = useSearch();
  const filter = (filters.find(f => f.id === search.get('show'))?.id ?? 'all') as Filter;
  const stop = search.get('stop');
  const { lanes, error: laneError } = useLaneMeta(projectId);
  const { queue, error: queueError } = useQueue(projectId);
  const shared = useSharedFiles(projectId);
  const [layout, setLayout, resetLayout, moved] = useDockLayout('lanes', LAYOUT);
  // Ages ("saved 4 min ago") are worked out when the data changes, never on a timer. Rows wait for all three reads, so
  // a reload never paints titles, people or states that change a moment later (Item 31328be4).
  const yard = useMemo(
    () =>
      feed && yardReady({ feed, lanes, laneError, queue, queueError, shared })
        ? buildYard(feed, lanes ?? [], queue, Date.now())
        : null,
    // shared.view and shared.error, not the object rebuilt each render.
    [feed, lanes, laneError, queue, queueError, shared.view, shared.error],
  );
  const laneHref = (laneId: string) => hrefFor({ ...route, section: '', rest: laneId });
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
            <div className="sk-rows" aria-busy="true" aria-label="Loading the Lanes">
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
                rows={shown}
                hrefOf={laneHref}
                dense={shown.length > 12}
                sharesOf={laneId => shares.get(laneId)}
                sharesHref={touchingFor}
              />
              {shared.error || (shared.view && !files.complete) ? (
                <div className="pf">
                  {shared.error
                    ? 'Which Lanes share files could not be read. '
                    : 'Some Lanes were not compared, so a row may share more files than it says. '}
                  <A className="lk" href={touching}>
                    Who is touching what
                  </A>
                </div>
              ) : null}
              {shown.some(row => row.longWait) ? (
                <div className="pf">
                  A Lane waits longer than a usual check.{' '}
                  <A className="lk" href={touching}>
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
                    className="lk"
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
        {yard?.open ? (
          <div className="seg" role="group" aria-label="Show">
            {filters.map(f => (
              <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
                {f.label}
              </button>
            ))}
          </div>
        ) : null}
      </Head>
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
