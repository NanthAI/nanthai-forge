// SPDX-License-Identifier: Apache-2.0
// Needs me › Loose ends (Item fc1831eb): what was started and left, in five groups from one read
// (projectLooseEnds:read). The owner picks Lanes nobody holds and sets them aside in one call to the existing dormant
// sweep, which re-checks each Lane: one that gained a save meanwhile is skipped and named, and retry repeats only the
// call that failed. Nothing here deletes. Loaded with its section only.
import { useMemo, useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { makeFunctionReference } from 'convex/server';
import type { Id } from '../../../../convex/_generated/dataModel';
import { Key, Region, Row, State, Who } from '../../ds';
import { Announcer, useAnnounce } from '../../ds/behaviour/announce';
import { Head, crumbsFor } from '../Place';
import type { PlaceProps } from '../screens';
import { looseEndsView, setAsideWord, type LooseEndsRead } from './loose-ends';
import './needs.css';

const looseRead = makeFunctionReference<'query', { projectId: Id<'hostedProjects'> }, string>(
  'projectLooseEnds:read',
);
const abandon = makeFunctionReference<
  'mutation',
  { projectId: Id<'hostedProjects'>; authorityEpoch: number; abandon: string[] },
  string
>('projectHostedDormant:abandon');
/** The sweep takes at most this many Lanes per call (projectHostedDormant DORMANT_BATCH). */
const BATCH = 25;

export default function LooseEnds({ route, projectId, projectName }: PlaceProps) {
  const live = useQuery(looseRead, { projectId });
  const read = useMemo(() => (live === undefined ? undefined : (JSON.parse(live) as LooseEndsRead)), [live]);
  const setAside = useMutation(abandon);
  return (
    <LooseEndsView
      trail={crumbsFor(route, projectName)}
      read={read}
      setAside={(epoch, ids) => setAside({ projectId, authorityEpoch: epoch, abandon: ids })}
    />
  );
}

type Outcome = Record<string, string>;

export function LooseEndsView({
  trail,
  read,
  setAside,
}: {
  trail: Parameters<typeof Head>[0]['trail'];
  read: LooseEndsRead | undefined;
  setAside: (authorityEpoch: number, laneIds: string[]) => Promise<string>;
}) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [outcome, setOutcome] = useState<Outcome>({});
  const [busy, setBusy] = useState(false);
  const [message, announce] = useAnnounce();
  if (!read) return <Head trail={trail} sentence="Loading loose ends…" />;
  const view = looseEndsView(read, read.at);
  const toggle = (laneId: string) =>
    setPicked(old => {
      const next = new Set(old);
      if (next.has(laneId)) next.delete(laneId);
      else next.add(laneId);
      return next;
    });
  const run = async (ids: string[]) => {
    if (!read.setAside || !ids.length) return;
    setBusy(true);
    const results: Outcome = {};
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH);
      try {
        const reply = JSON.parse(await setAside(read.setAside.authorityEpoch, batch)) as {
          results: { laneId: string; result: string }[];
        };
        for (const entry of reply.results) results[entry.laneId] = entry.result;
      } catch {
        for (const id of batch) results[id] = 'failed';
      }
    }
    setOutcome(old => ({ ...old, ...results }));
    setPicked(new Set());
    setBusy(false);
    const done = Object.values(results).filter(result => result === 'abandoned').length;
    const skipped = ids.length - done;
    announce(
      `${done.toLocaleString('en')} set aside${skipped ? `, ${skipped.toLocaleString('en')} skipped or failed, named in the list` : ''}.`,
    );
  };
  const idle = view.groups.find(group => group.key === 'idle')?.rows ?? [];
  const failed = idle.filter(row => outcome[row.laneId] === 'failed').map(row => row.laneId);
  const selected = idle.filter(row => picked.has(row.laneId)).map(row => row.laneId);
  return (
    <div className="needs-me loose-ends">
      <Head
        trail={trail}
        sentence={
          <>
            <b>{view.sentence.bold}</b> {view.sentence.rest}
          </>
        }
      />
      {view.groups.map(group => (
        <Region
          key={group.key}
          title={group.title}
          weight={group.rows.length ? 'watch' : 'ref'}
          count={group.reported ? group.rows.length : undefined}
          hint={group.hint}
          tools={
            group.key === 'idle' && read.setAside && group.rows.length ? (
              <span className="loose-tools">
                {failed.length ? (
                  <Key size="sm" disabled={busy} onClick={() => void run(failed)}>
                    Retry {failed.length.toLocaleString('en')} that failed
                  </Key>
                ) : null}
                <Key
                  size="sm"
                  kind="primary"
                  disabled={busy || !selected.length}
                  onClick={() => void run(selected)}
                >
                  Set aside {selected.length ? selected.length.toLocaleString('en') : ''}
                </Key>
              </span>
            ) : undefined
          }
        >
          {!group.reported ? (
            <Row cols="minmax(0, 1fr)">
              <span className="meta">Not reported. {group.why}</span>
            </Row>
          ) : group.rows.length === 0 ? (
            <Row cols="minmax(0, 1fr)">
              <span className="meta">None.</span>
            </Row>
          ) : (
            group.rows.map(row => {
              const result = outcome[row.laneId];
              const word = result ? setAsideWord(result) : null;
              const pickable = group.key === 'idle' && !!read.setAside && !word?.done;
              return (
                <Row
                  key={row.laneId}
                  cols={pickable ? 'auto minmax(0, 1fr) auto auto' : 'minmax(0, 1fr) auto auto'}
                  className="loose-row"
                >
                  {pickable ? (
                    <input
                      type="checkbox"
                      checked={picked.has(row.laneId)}
                      onChange={() => toggle(row.laneId)}
                      aria-label={`Pick ${row.title || 'this Lane'}`}
                    />
                  ) : null}
                  <span className="ttl" dir="auto">
                    {row.title || 'Lane without a goal'}
                    {row.who ? (
                      <span className="meta">
                        {' '}
                        <Who handle={row.who} />
                      </span>
                    ) : null}
                  </span>
                  <span className="meta">
                    {row.paths.toLocaleString('en')} {row.paths === 1 ? 'file' : 'files'}, {row.age}
                    {row.replacedBy ? (
                      <>
                        , replaced by{' '}
                        <span className="mono" translate="no">
                          Lane {row.replacedBy.slice(0, 8)}
                        </span>
                      </>
                    ) : null}
                    {row.heldBy ? ` · ${row.heldBy}` : ''}
                  </span>
                  <span className="r">
                    {word ? (
                      <State word={word.done ? 'Done' : word.retry ? 'Check failed' : 'Set aside'}>
                        {word.word}
                      </State>
                    ) : null}
                  </span>
                </Row>
              );
            })
          )}
          {group.more ? (
            <Row cols="minmax(0, 1fr)">
              <span className="meta">
                More than these; the oldest are shown first and the rest follow as these close.
              </span>
            </Row>
          ) : null}
        </Region>
      ))}
      <Announcer message={message} />
    </div>
  );
}
