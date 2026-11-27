// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { useContext, useMemo, useState } from 'react';
import { useConvex } from 'convex/react';
import { makeFunctionReference } from 'convex/server';
import { A } from '../frames';
import { hrefFor } from '../paths';
import type { CodeRoute } from './CodePlace';
import { parseReply, useRead, VisitorCodeContext, type ProjectId } from './code-data';
import { plural } from './code-words';

type Lane = { id: string; title: string; paths: string[] };
type Snapshot = { partial: boolean; lanes: Lane[] };
const changing = makeFunctionReference<'query', { projectId: ProjectId }, string>('projectCode:changing');

export function useChanging(projectId: ProjectId, main: boolean) {
  const client = useConvex();
  const visitor = useContext(VisitorCodeContext);
  const [retry, setRetry] = useState(0);
  const read = useRead<Snapshot | null>(
    !visitor && main ? projectId : null,
    () => client.query(changing, { projectId }).then(parseReply<Snapshot | null>),
    retry,
  );
  const paths = useMemo(() => {
    const index = new Map<string, Set<Lane>>();
    for (const lane of read.value?.lanes ?? [])
      for (const saved of lane.paths) {
        for (let path = saved; path; path = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '') {
          const known = index.get(path) ?? new Set<Lane>();
          known.add(lane);
          index.set(path, known);
        }
      }
    return index;
  }, [read.value]);
  return { ...read, paths, refresh: () => setRetry(n => n + 1) };
}

export function SavedMark({ lanes }: { lanes: number }) {
  if (!lanes) return null;
  const label = `${plural(lanes, 'open Lane')} with saved changes here`;
  return (
    <span className="saved-path-mark" title={label}>
      <span className="sr">{label}</span>
    </span>
  );
}

export function Changing({
  work,
  path,
  route,
}: {
  work: ReturnType<typeof useChanging>;
  path: string;
  route: CodeRoute;
}) {
  if (!work.value && !work.error && !work.loading) return null;
  const lanes = [...(work.paths.get(path) ?? [])];
  return (
    <>
      <div className="ph plain">
        <h2>Changing now</h2>
      </div>
      <div className="pad">
        {work.loading ? (
          <p className="t2" role="status">
            Reading saved changes…
          </p>
        ) : null}
        {work.error ? <p role="alert">{work.error}</p> : null}
        {lanes.map(lane => (
          <p key={lane.id}>
            <A
              className="lk"
              href={hrefFor({ ...route, place: 'lanes', section: '', rest: lane.id })}
              dir="auto"
            >
              {lane.title || 'Open Lane'}
            </A>
          </p>
        ))}
        {!lanes.length && work.value ? (
          <p className="t2">No saved Lane changes shown for this file.</p>
        ) : null}
        {work.value?.partial ? <p className="t2">Only some saved paths are shown.</p> : null}
        {!work.loading ? (
          <button type="button" className="btn sm" onClick={work.refresh}>
            {work.error ? 'Retry' : 'Refresh saved changes'}
          </button>
        ) : null}
      </div>
    </>
  );
}
