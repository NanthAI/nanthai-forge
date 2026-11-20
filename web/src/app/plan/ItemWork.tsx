// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import { Band, Key, Region, Row, State, Who, type StateWord } from '../../ds';
import { A } from '../frames';
import type { ProjectRoute } from '../screen-route';

export type ReadItemWork = (itemId: string, cursor: string | null) => Promise<string>;

const stateWords = {
  open: 'Working',
  queued: 'Waiting its turn',
  parked: 'Waiting its turn',
  landed: 'Landed',
  abandoned: 'Abandoned',
} as const satisfies Record<string, StateWord>;

type Receipt = { receiptId: string; commit: string; at: string };
type Lane = {
  laneId: string;
  state: keyof typeof stateWords;
  lastActivityAt: string;
  actor?: string | null;
  kind: 'agent' | 'person';
  model: string | null;
  receipt?: Receipt | null;
};
type Work =
  | { role: false }
  | { role: true; lanes: Lane[]; total: number; atLeast: boolean; nextCursor: string | null };

function WorkTime({ at }: { at: string }) {
  return (
    <time className="t2" dateTime={at}>
      {new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
    </time>
  );
}

/** One page on open. Further pages use only the same reader's cursor and an explicit request. */
export function ItemWork({
  itemId,
  read,
  at,
}: {
  itemId: string;
  read: ReadItemWork;
  at: (patch: Partial<ProjectRoute>) => string;
}) {
  const [work, setWork] = useState<Work | 'failed' | null>(null);
  const [paging, setPaging] = useState(false);
  const [pageFailed, setPageFailed] = useState(false);
  useEffect(() => {
    let current = true;
    read(itemId, null)
      .then(raw => {
        if (current) setWork(JSON.parse(raw) as Work);
      })
      .catch(() => {
        if (current) setWork('failed');
      });
    return () => {
      current = false;
    };
  }, [itemId, read]);

  if (work === null || work === 'failed' || !work.role)
    return (
      <Region title="Work">
        <div className="quietline" role="status">
          {work === null
            ? 'Loading work…'
            : work === 'failed'
              ? 'Work could not be loaded.'
              : 'Sign in to see work.'}
        </div>
      </Region>
    );

  const showMore = async () => {
    if (paging || !work.nextCursor) return;
    setPaging(true);
    setPageFailed(false);
    try {
      const next = JSON.parse(await read(itemId, work.nextCursor)) as Work;
      if (!next.role) {
        setWork(next);
        return;
      }
      const shown = new Set(work.lanes.map(lane => lane.laneId));
      setWork({ ...next, lanes: [...work.lanes, ...next.lanes.filter(lane => !shown.has(lane.laneId))] });
    } catch {
      setPageFailed(true);
    } finally {
      setPaging(false);
    }
  };
  const receipts = new Map<string, Receipt>();
  for (const lane of work.lanes) {
    if (lane.receipt) receipts.set(lane.receipt.receiptId, lane.receipt);
  }
  const landings = [...receipts.values()].sort((a, b) => b.at.localeCompare(a.at));
  return (
    <Region title="Work">
      <Band
        title="Lanes"
        count={work.atLeast ? undefined : work.total}
        hint={work.atLeast ? `At least ${work.total.toLocaleString()}` : undefined}
      />
      {work.lanes.length ? (
        work.lanes.map(lane => (
          <Row key={lane.laneId} cols="minmax(0, 1fr) auto">
            <div>
              <A className="lk" href={at({ place: 'lanes', rest: lane.laneId })}>
                Lane {lane.laneId.slice(0, 8)}
              </A>
              <div className="meta">
                {lane.actor ? (
                  <Who handle={lane.actor} model={lane.model} />
                ) : lane.kind === 'agent' ? (
                  'Agent'
                ) : (
                  'Person'
                )}
              </div>
            </div>
            <div>
              <State word={stateWords[lane.state]} />
              <div className="meta">
                <WorkTime at={lane.lastActivityAt} />
              </div>
            </div>
          </Row>
        ))
      ) : (
        <div className="quietline">No Lanes yet.</div>
      )}
      <Band title="Landings" />
      {landings.length ? (
        landings.map(landing => (
          <Row key={landing.receiptId} cols="minmax(0, 1fr) auto">
            <A
              className="lk"
              href={`${at({ place: 'code', section: 'files' })}?at=${encodeURIComponent(landing.commit)}`}
            >
              Landing {landing.receiptId.slice(0, 8)}
            </A>
            <WorkTime at={landing.at} />
          </Row>
        ))
      ) : (
        <div className="quietline">No landings on these Lanes.</div>
      )}
      {work.nextCursor ? (
        <div className="pad">
          <Key size="sm" onClick={() => void showMore()} disabled={paging}>
            {paging ? 'Loading more Lanes…' : 'Show more Lanes'}
          </Key>
          {pageFailed ? <p role="status">More work could not be loaded.</p> : null}
        </div>
      ) : null}
    </Region>
  );
}
