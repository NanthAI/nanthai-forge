// SPDX-License-Identifier: Apache-2.0
// Lanes (Item e317b6ea): what needs the reader, then every open Lane on the shell's stops, the files Lanes share and
// what landed today. The yard's stops and held marks are the line feed's, so the counts here are the top bar's.
// Regions move with the dock; the deep regions read only while open. Filters live in the address, so a link, a
// reload and browser Back show the same view.
import { useMemo, type ReactNode } from 'react';
import { Dock, Key, Region, useDockLayout, useFold, type DockLayout } from '../../ds';
import { A } from '../frames';
import { hrefFor } from '../paths';
import { navigate, useSearch } from '../router';
import { Head, crumbsFor } from '../Place';
import { atStop, buildYard, filterRows, sharedFiles, situation, stopWords, type Filter } from './model';
import { useLaneMeta, useLandings, useQueue, useSharedFiles } from './reads';
import { Yard } from './Yard';
import { FirstRun, type LanesProps } from './common';

const LAYOUT: DockLayout = { top: ['yard'], a: ['overlaps'], b: ['landed'] };
const filters: readonly { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'needs', label: 'Needs you' },
  { id: 'mine', label: 'Mine' },
];

export function Overview({ route, projectId, projectName, feed, viewerHandle }: LanesProps) {
  const search = useSearch();
  const filter = (filters.find(f => f.id === search.get('show'))?.id ?? 'all') as Filter;
  const stop = search.get('stop');
  const { lanes, error: laneError } = useLaneMeta(projectId);
  const { queue } = useQueue(projectId);
  const overlapsFold = useFold('lanes-overlaps', true);
  const landedFold = useFold('lanes-landed', false);
  const shared = useSharedFiles(projectId, overlapsFold[0]);
  const landed = useLandings(projectId, 'recent', landedFold[0]);
  const [layout, setLayout, resetLayout] = useDockLayout('lanes', LAYOUT);
  // Ages ("saved 4 min ago") are worked out when the data changes, never on a timer.
  const yard = useMemo(
    () => (feed ? buildYard(feed, lanes ?? [], queue, Date.now()) : null),
    [feed, lanes, queue],
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
  const titleOf = new Map(yard?.rows.map(row => [row.laneId, row.title]));
  const touching = hrefFor({ ...route, section: 'touching', rest: '' });
  const toRead = hrefFor({ ...route, section: 'to-read', rest: '' });
  const today = new Date().toDateString();
  const landedToday = (landed.page?.rows ?? []).filter(row => new Date(row.at).toDateString() === today);
  const landedAll = !!landed.page && landedToday.length === landed.page.rows.length && landed.page.more;
  const moved = JSON.stringify(layout) !== JSON.stringify(LAYOUT);

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
                : `${shown.length.toLocaleString()} of ${yard.rows.length.toLocaleString()} shown${stop && stop in stopWords ? `, at ${stopWords[stop as keyof typeof stopWords]}` : ''}`
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
              <Yard rows={shown} hrefOf={laneHref} dense={shown.length > 12} label="" />
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
    {
      id: 'overlaps',
      title: 'Overlaps',
      render: (handle: ReactNode) => (
        <Region
          title="Overlaps"
          handle={handle}
          weight="watch"
          fold="lanes-overlaps"
          foldState={overlapsFold}
          count={shared.view ? files.files.length : undefined}
          hint="the same file saved in more than one Lane"
          sum={
            shared.view
              ? files.files.length
                ? `${files.files.length.toLocaleString()} shared ${files.files.length === 1 ? 'file' : 'files'}`
                : 'no two open Lanes share a file'
              : undefined
          }
        >
          {shared.error ? (
            <p className="quietline">The overlaps could not be read.</p>
          ) : !shared.view ? (
            <div className="sk-rows" aria-busy="true" aria-label="Loading the overlaps">
              <div className="sk" />
            </div>
          ) : files.files.length ? (
            <ul className="lanes-files">
              {files.files.slice(0, 5).map(file => (
                <li key={file.path} className="row">
                  <span className="mono cut" translate="no" title={file.path} dir="ltr">
                    {file.path}
                  </span>
                  <span className="meta t2 cut">
                    {file.laneIds
                      .slice(0, 2)
                      .map(id => titleOf.get(id) ?? `Lane ${id.slice(0, 8)}`)
                      .join(' and ')}
                    {file.laneIds.length > 2 ? ` and ${file.laneIds.length - 2} more` : ''}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="quietline">No two open Lanes have saved changes to the same file.</p>
          )}
          <div className="pf">
            {files.files.length > 5 ? `${(files.files.length - 5).toLocaleString()} more. ` : null}
            {shared.view && !files.complete ? 'Some Lanes were not compared. ' : null}
            Saved work only.{' '}
            <A className="lk" href={touching}>
              Who is touching what
            </A>
          </div>
        </Region>
      ),
    },
    {
      id: 'landed',
      title: 'Landed today',
      render: (handle: ReactNode) => (
        <Region
          title="Landed today"
          handle={handle}
          weight="ref"
          fold="lanes-landed"
          foldState={landedFold}
          foldedByDefault
          count={landed.page ? landedToday.length : undefined}
          sum={
            landed.page && landedToday[0]
              ? `the last at ${new Date(landedToday[0].at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
              : undefined
          }
        >
          {landed.error ? (
            <p className="quietline">What landed could not be read.</p>
          ) : !landed.page ? (
            <div className="sk-rows" aria-busy="true" aria-label="Loading what landed">
              <div className="sk" />
            </div>
          ) : landedToday.length ? (
            <ul className="lanes-files">
              {landedToday.slice(0, 5).map(row => (
                <li key={row.receiptId} className="row">
                  <span className="num t3">
                    {new Date(row.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                  {row.laneId ? (
                    <A className="ttl cut" dir="auto" href={laneHref(row.laneId)}>
                      {row.title ?? 'Untitled landing'}
                    </A>
                  ) : (
                    <span className="ttl cut" dir="auto">
                      {row.title ?? 'Untitled landing'}
                    </span>
                  )}
                  <span className="meta t2 mono cut" translate="no">
                    {row.actor ?? ''}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="quietline">Nothing has landed today.</p>
          )}
          <div className="pf">
            {landedToday.length > 5
              ? `${(landedToday.length - 5).toLocaleString()}${landedAll ? ' or more' : ''} earlier today. `
              : null}
            <A className="lk" href={toRead}>
              To read
            </A>
          </div>
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
