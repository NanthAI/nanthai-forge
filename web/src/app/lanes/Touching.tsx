// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Who is touching what (Item eb0bbb94): which Lanes collide or block each other. The pairs of Items whose Lanes saved
// the same files (Item df1f2d46, Crossing.tsx), then who waits on whom drawn as chains (WaitChains.tsx, Item 8f94e5c3;
// traced to the front of the queue, Item 9e748e41). The landing queue and who has what are Lanes > Open's and the top
// flow strip's, so they are not repeated here (owner 2026-11-23). Built only from the existing queue, hold and overlap
// records the Lanes place already reads; saved work only, so no row here ever proves two Lanes independent. A yard row's
// "shares N files with M Lanes" opens this with `?lane=` (Item f787005c): Where Lanes cross then lists the pairs that
// Lane is in, over its shared files only, with a link back to every pair; the address alone carries it.
import { useMemo, type ReactNode } from 'react';
import { Dock, Key, Region, useDockLayout, type DockLayout } from '../../ds';
import { CrossList } from './Crossing';
import { crossPairs, mostlyOne, type CrossSide } from './cross-pairs';
import { A } from '../frames';
import { hrefFor } from '../paths';
import { Head, crumbsFor } from '../Place';
import { useSearch } from '../router';
import type { LanesProps } from './common';
import { conflictedLanes, currentEntries } from '../lane-state';
import { LANE_FOCUS, buildYard, filesOfLane, sharedFiles, waits, yardReady, type YardRow } from './model';
import { WaitChains } from './WaitChains';
import { useLaneMeta, useQueue, useSharedFiles } from './reads';

const LAYOUT: DockLayout = { top: ['cross'], a: ['waits'], b: [] };

/** Why the pair list may be short, said once: the overlap read holds every Lane's saved files only up to a limit (a
 * very long list of changed files, or more Lanes than one read holds), and says only that it is partial. */
function notCompared(compared: number, open: number | undefined) {
  const of = `${compared.toLocaleString()}${open !== undefined && open >= compared ? ` of ${open.toLocaleString()}` : ''} open Lanes were compared. `;
  return `${of}For some Lanes Forge holds only part of the saved files (a very long list of changed files, or more Lanes than one read holds), so a pair may be missing.`;
}

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
  const lanesHref = hrefFor({ ...route, section: '', rest: '' });
  const current = currentEntries(queue?.entries ?? []);
  // Which Lanes are in conflict: the one rule every screen uses (Item 9b9057a9). A shared saved file alone ranks nothing.
  const conflicted = useMemo(
    () => conflictedLanes(feed?.lanes ?? [], queue?.entries ?? [], lanes ?? []),
    [feed, queue, lanes],
  );
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
  // Only each Lane's current submission waits (an earlier one is history).
  const pairs = waits(
    (queue?.entries ?? []).filter(entry => !entry.laneId || current.get(entry.laneId) === entry),
    titleOf,
  );
  const onPerson = pairs.filter(pair => pair.person).length;
  const laneOf = (laneId: string) => {
    const row = rowOf.get(laneId);
    return { title: titleOf(laneId), state: row?.state ?? 'stale', word: row?.word ?? 'open' } as const;
  };
  const lead = !shared.view
    ? 'Loading the Lanes…'
    : all.files.length
      ? `${all.files.length.toLocaleString()} ${all.files.length === 1 ? 'file is' : 'files are'} saved in more than one Lane${
          cross.between
            ? `; ${cross.between.toLocaleString()} ${cross.between === 1 ? 'pair' : 'pairs'} of Items cross`
            : ''
        }.`
      : shared.view.complete
        ? 'No two open Lanes have saved the same file.'
        : 'No two compared Lanes have saved the same file.';
  const rest = queue
    ? `${onPerson ? `${onPerson.toLocaleString()} ${onPerson === 1 ? 'Lane waits' : 'Lanes wait'} on a person, ` : ''}${(pairs.length - onPerson).toLocaleString()} on another Lane or on main.`
    : '';
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
            <div className="pf">
              {notCompared(shared.view.lanes.length, lanes?.length)}{' '}
              <code className="mono">nforge agent . peers</code> checks one Lane exactly.
            </div>
          ) : null}
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
          hint="longest wait first"
        >
          {queueError ? <p className="quietline">The landing queue could not be read.</p> : null}
          {queue && !pairs.length ? <p className="quietline">No Lane is waiting on another.</p> : null}
          <WaitChains
            waits={pairs}
            laneOf={laneOf}
            laneHref={laneHref}
            decideHref={hrefFor({ ...route, place: 'needs', section: '', rest: '' })}
            now={now}
          />
          <div className="pf">
            The landing queue and every open Lane are on{' '}
            <A className="lk lanes-inline" href={lanesHref}>
              Lanes
            </A>
            .
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
