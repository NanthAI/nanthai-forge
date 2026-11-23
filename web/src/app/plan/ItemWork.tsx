// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { useEffect, useId, useState, type ReactNode } from 'react';
import { Avatar, Count, Glyph, Key, Region, Row, State, Who, useFold, type StateWord } from '../../ds';
import { age } from '../../ui/status';
import { A } from '../frames';
import type { ProjectRoute } from '../screen-route';
import { whoLinks, type WhoProject } from '../who-links';

export type ReadItemWork = (itemId: string, cursor: string | null) => Promise<string>;

const stateWords = {
  open: 'Working',
  queued: 'Waiting its turn',
  parked: 'Waiting its turn',
  landed: 'Landed',
  abandoned: 'Abandoned',
} as const satisfies Record<string, StateWord>;
type Landing = {
  receiptId: string;
  commit: string;
  at: string;
  check: 'passed' | 'not-checked' | null;
  files: number | null;
  sequence?: number;
};
type Lane = {
  laneId: string;
  title: string | null;
  state: keyof typeof stateWords;
  receipt?: { receiptId: string } | null;
  actor?: string | null;
  kind: 'agent' | 'person';
  run?: string;
  model: string | null;
  saveCount?: number;
  moreSaves: boolean;
  lastSaveAt: string | null;
};
type Related = { kind: string; id: string; title: string };
type Work =
  | { role: false }
  | {
      role: true;
      lanes: Lane[];
      landings?: Landing[];
      moreLandings?: boolean;
      related?: Related[];
      moreRelated?: boolean;
      total: number;
      atLeast: boolean;
      nextCursor: string | null;
    };

function WorkTime({ at }: { at: string }) {
  return (
    <time className="t2" dateTime={at} title={new Date(at).toLocaleString()}>
      {age(at, Date.now())}
    </time>
  );
}

function Part({
  name,
  fold,
  count,
  atLeast,
  children,
}: {
  name: string;
  fold: string;
  count?: number;
  atLeast?: boolean;
  children: ReactNode;
}) {
  const [open, toggle] = useFold(fold, name === 'Lanes');
  const id = useId();
  return (
    <div className={`grp plan-grp${open ? '' : ' shut'}`} data-fold="">
      <div className="band plan-gh">
        <span className="plan-gn">{name}</span>
        {count === undefined ? null : atLeast ? (
          <span className="t2">At least {count.toLocaleString()}</span>
        ) : (
          <Count n={count} />
        )}
        <button
          type="button"
          className="tw"
          aria-expanded={open}
          aria-controls={id}
          aria-label={name}
          onClick={toggle}
        />
      </div>
      <div id={id} hidden={!open}>
        {children}
      </div>
    </div>
  );
}

function WhoWorked({ lane, project }: { lane: Lane; project: WhoProject }) {
  const actor = lane.actor ?? '';
  if (lane.kind === 'agent') {
    const handle = actor.includes('/') ? actor : `${actor}/${lane.run ?? 'Agent'}`;
    return (
      <Who
        handle={handle}
        model={lane.model}
        layout="line"
        nofor={!actor}
        {...(actor ? whoLinks(lane.run ? handle : actor, project) : {})}
      />
    );
  }
  return actor ? (
    <Who handle={actor} layout="line" {...whoLinks(actor, project)} />
  ) : (
    <span className="who" data-kind="person">
      <Avatar handle="?" /> Person
    </span>
  );
}

/** One page on open. Further pages use the same reader's cursor and an explicit request. */
export function ItemWork({
  itemId,
  read,
  at,
  project,
}: {
  itemId: string;
  read: ReadItemWork;
  at: (patch: Partial<ProjectRoute>) => string;
  project: WhoProject;
}) {
  const [work, setWork] = useState<Work | 'failed' | null>(null);
  const [paging, setPaging] = useState(false);
  const [pageFailed, setPageFailed] = useState(false);
  const [stale, setStale] = useState(false);
  const [attempt, retry] = useState(0);
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
  }, [itemId, read, attempt]);

  if (work === null || work === 'failed' || !work.role)
    return (
      <Region title="Work">
        <div className="quietline" role="status">
          {work === null
            ? 'Loading work…'
            : work === 'failed'
              ? 'Work could not be loaded.'
              : 'Sign in to see work.'}
          {work === 'failed' ? (
            <Key
              size="sm"
              onClick={() => {
                setWork(null);
                retry(value => value + 1);
              }}
            >
              Retry
            </Key>
          ) : null}
        </div>
      </Region>
    );

  const showMore = async () => {
    if (paging || !work.nextCursor) return;
    setPaging(true);
    setPageFailed(false);
    try {
      const next = JSON.parse(await read(itemId, stale ? null : work.nextCursor)) as Work;
      setStale(false);
      if (!next.role || stale) {
        setWork(next);
        return;
      }
      const lanes = new Map([...work.lanes, ...next.lanes].map(lane => [lane.laneId, lane]));
      const landings = new Map(
        [...(work.landings ?? []), ...(next.landings ?? [])].map(landing => [landing.receiptId, landing]),
      );
      setWork({
        ...next,
        lanes: [...lanes.values()],
        landings: [...landings.values()],
        moreLandings: Boolean(next.moreLandings ?? work.moreLandings),
        total: next.total ?? work.total,
        atLeast: next.atLeast ?? work.atLeast,
        related: [...(work.related ?? []), ...(next.related ?? [])],
      });
    } catch (error) {
      setStale(stale || (error instanceof Error && /WORK_STALE/.test(error.message)));
      setPageFailed(true);
    } finally {
      setPaging(false);
    }
  };
  const landings = [...(work.landings ?? [])].sort(
    (a, b) => b.at.localeCompare(a.at) || (b.sequence ?? 0) - (a.sequence ?? 0),
  );
  const related = new Map((work.related ?? []).map(link => [`${link.kind}:${link.id}`, link]));
  const fold = `item-work:${project.handle}/${project.project}:${itemId}`;
  const more = work.nextCursor ? (
    <div className="pad">
      <Key size="sm" onClick={() => void showMore()} disabled={paging}>
        {paging ? 'Loading more work…' : 'Show more work'}
      </Key>
      {pageFailed ? <p role="status">More work could not be loaded.</p> : null}
    </div>
  ) : null;
  return (
    <Region title="Work">
      <Part name="Lanes" fold={`${fold}:lanes`} count={work.total} atLeast={work.atLeast}>
        {work.lanes.length ? (
          work.lanes.map(lane => (
            <Row key={lane.laneId} cols="minmax(0, 1fr) auto" style={{ rowGap: 0 }}>
              <A className="lk ttl" href={at({ place: 'lanes', rest: lane.laneId })} dir="auto">
                {lane.title ?? `Lane ${lane.laneId.slice(0, 8)}`}
              </A>
              <div className="r">
                {lane.state === 'landed' && !lane.receipt ? (
                  <span className="st" data-st="stale">
                    <Glyph of="stale" /> Closed without landing
                  </span>
                ) : (
                  <State word={stateWords[lane.state]} />
                )}
              </div>
              <div className="meta" style={{ gridColumn: '1 / -1', flexBasis: '100%' }}>
                <WhoWorked lane={lane} project={project} />
              </div>
              <div className="meta" style={{ gridColumn: '1 / -1', flexBasis: '100%' }}>
                {lane.saveCount === undefined
                  ? 'Saves not reported'
                  : `${lane.moreSaves ? 'At least ' : ''}${lane.saveCount.toLocaleString()} ${lane.saveCount === 1 ? 'save' : 'saves'}`}
                {lane.lastSaveAt ? (
                  <>
                    {' '}
                    · Last save <WorkTime at={lane.lastSaveAt} />
                  </>
                ) : null}
                <A
                  className="lk"
                  style={{ textDecoration: 'underline' }}
                  href={at({ place: 'lanes', rest: `${lane.laneId}/thread` })}
                  aria-label={`Thread for ${lane.title ?? `Lane ${lane.laneId.slice(0, 8)}`}`}
                >
                  Thread
                </A>
              </div>
            </Row>
          ))
        ) : (
          <div className="quietline">No Lanes yet.</div>
        )}
      </Part>
      <Part
        name="Landings"
        count={landings.length}
        atLeast={Boolean(work.moreLandings)}
        fold={`${fold}:landings`}
      >
        {landings.length ? (
          landings.map(landing => (
            <Row key={landing.receiptId} cols="minmax(0, 1fr) auto">
              <div>
                <A
                  className="lk"
                  href={`${at({ place: 'code', section: 'files' })}?at=${encodeURIComponent(landing.commit)}`}
                >
                  Landing {landing.receiptId.slice(0, 8)}
                </A>
                <div className="meta">
                  {landing.files === null
                    ? 'File count unavailable'
                    : `${landing.files.toLocaleString()} ${landing.files === 1 ? 'file' : 'files'} changed`}
                </div>
              </div>
              <div>
                {landing.check === 'passed' ? (
                  <span className="st" data-st="passed">
                    <Glyph of="passed" /> Passed
                  </span>
                ) : (
                  <span className="t2">
                    {landing.check === 'not-checked' ? 'Not checked' : 'Check not reported'}
                  </span>
                )}
                <div className="meta">
                  <WorkTime at={landing.at} />
                </div>
              </div>
            </Row>
          ))
        ) : (
          <div className="quietline">No landings shown.</div>
        )}
      </Part>
      <Part name="Related" fold={`${fold}:related`} count={related.size}>
        {related.size ? (
          [...related.values()].map(link => (
            <Row key={`${link.kind}:${link.id}`} cols="8em minmax(0, 1fr)">
              <span className="t2">{link.kind}</span>
              <A className="lk ttl" href={at({ rest: link.id })} dir="auto">
                {link.title}
              </A>
            </Row>
          ))
        ) : (
          <div className="quietline">{work.moreRelated ? 'No links in this page.' : 'No related Items.'}</div>
        )}
      </Part>
      {more}
    </Region>
  );
}
