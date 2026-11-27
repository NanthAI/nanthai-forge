// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Avatar, Count, Glyph, Key, Region, Row, State, Who, useFold, type StateWord } from '../../ds';
import { visibleAuditSummary } from '../../../../src/planning-audit';
import { age } from '../../ui/status';
import { A } from '../frames';
import { Unchecked } from '../Unchecked';
import type { ProjectRoute } from '../screen-route';
import { whoLinks, type WhoProject } from '../who-links';

type ItemWorkSection = 'lanes' | 'landings' | 'related';
type ReadPage = (itemId: string, cursor: string | null, limit: number) => Promise<string>;
export type ReadItemWork = (
  itemId: string,
  cursor: string | null,
  limit: number,
  only?: ItemWorkSection,
) => Promise<string>;
export type ReadItemHistory = ReadPage;

const VISIBLE_ROWS = 3;
const WORK_PAGE = 10;
const HISTORY_PAGE = 25;

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
  checked?: false;
  files: number | null;
  sequence?: number;
  detailsPending?: true;
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
import type { Related } from './ItemRelations';
const linkKey = (link: Related) => `${link.kind}:${link.id}`;
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
  lazy,
  children,
}: {
  name: string;
  fold: string;
  count?: number;
  atLeast?: boolean;
  /** Mounts the body only once the part is open, so a closed part reads nothing. */
  lazy?: boolean;
  children: ReactNode;
}) {
  const [open, toggle] = useFold(fold, true);
  // Retain the page after the first open; toggling its fold never rereads it.
  const [visited, setVisited] = useState(open);
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
          onClick={() => {
            setVisited(true);
            toggle();
          }}
        />
      </div>
      <div id={id} hidden={!open}>
        {lazy && !open && !visited ? null : children}
      </div>
    </div>
  );
}

function TopRows<T>({
  rows,
  draw,
  empty,
  more,
  reveal = 0,
  error,
}: {
  rows: readonly T[];
  draw: (row: T) => ReactNode;
  empty: string;
  more?: { label: string; busy: boolean; load: () => Promise<boolean> } | undefined;
  reveal?: number;
  error?: string | undefined;
}) {
  const [choice, setChoice] = useState({ reveal, expanded: false });
  const expanded = choice.reveal === reveal ? choice.expanded : reveal > 0;
  const setExpanded = (value: boolean) => setChoice({ reveal, expanded: value });
  const id = useId();
  return (
    <>
      {rows.length
        ? rows.slice(0, VISIBLE_ROWS).map(draw)
        : !more && <div className="quietline">{empty}</div>}
      <div id={id} hidden={!expanded}>
        {expanded ? rows.slice(VISIBLE_ROWS).map(draw) : null}
      </div>
      {rows.length > VISIBLE_ROWS || more ? (
        <div className="ip-showmore">
          <Key
            size="sm"
            kind="ghost"
            aria-expanded={expanded}
            aria-controls={id}
            disabled={more?.busy}
            onClick={() => {
              if (!more || expanded) setExpanded(!expanded);
              else
                void more.load().then(loaded => {
                  if (loaded) setExpanded(true);
                });
            }}
          >
            {expanded
              ? 'Show fewer'
              : (more?.label ?? `Show ${(rows.length - VISIBLE_ROWS).toLocaleString()} more`)}
          </Key>
        </div>
      ) : null}
      {error ? (
        <div className="pad" role="status">
          {error}
        </div>
      ) : null}
    </>
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

type HistoryEvent = {
  kind: 'version' | 'comment' | 'lane' | 'landing' | 'revert';
  id: string;
  at: string;
  summary: string;
  actor?: string;
  actorKind: 'person' | 'agent' | 'system' | 'unknown';
  model?: string | null;
};
type History = {
  events: HistoryEvent[];
  nextCursor: string | null;
  historyStartsAt: string | null;
  completeFromCreation: boolean;
};

/** Who changed the Item: a person's handle, or an agent with the model it declared ('not declared' says so). */
function HistoryWho({ event, project }: { event: HistoryEvent; project: WhoProject }) {
  if (!event.actor) return <span className="t2">Unknown</span>;
  return (
    <Who
      handle={event.actor}
      layout="line"
      {...(event.actorKind === 'agent' ? { model: event.model === 'not declared' ? null : event.model } : {})}
      {...whoLinks(event.actor, project)}
    />
  );
}

/** The open part reads only its three visible events. Expansion opens the original full audit page. */
function ItemHistory({
  itemId,
  read,
  project,
}: {
  itemId: string;
  read: ReadItemHistory;
  project: WhoProject;
}) {
  const [history, setHistory] = useState<History | 'failed' | null>(null);
  const [full, setFull] = useState(false);
  const [paging, setPaging] = useState(false);
  const [pageFailed, setPageFailed] = useState(false);
  const [attempt, retry] = useState(0);
  const epoch = useRef(0);
  useEffect(() => {
    const source = ++epoch.current;
    setHistory(null);
    setFull(false);
    setPageFailed(false);
    setPaging(false);
    read(itemId, null, VISIBLE_ROWS)
      .then(raw => {
        if (source === epoch.current) setHistory(JSON.parse(raw) as History);
      })
      .catch(() => {
        if (source === epoch.current) setHistory('failed');
      });
    return () => {
      epoch.current++;
    };
  }, [itemId, read, attempt]);
  if (history === null || history === 'failed' || !Array.isArray(history.events))
    return (
      <div className="quietline" role="status">
        {history === null ? 'Loading history…' : 'History could not be loaded.'}
        {history === 'failed' || history ? (
          <Key
            size="sm"
            onClick={() => {
              setHistory(null);
              retry(value => value + 1);
            }}
          >
            Retry
          </Key>
        ) : null}
      </div>
    );
  const loadHistory = async (first: boolean) => {
    if (paging || !history.nextCursor) return false;
    setPaging(true);
    setPageFailed(false);
    const source = epoch.current;
    try {
      const next = JSON.parse(await read(itemId, first ? null : history.nextCursor, HISTORY_PAGE)) as History;
      if (source !== epoch.current) return false;
      if (!Array.isArray(next.events)) throw new Error('History page unavailable.');
      setHistory(first ? next : { ...next, events: [...history.events, ...next.events] });
      setFull(true);
      return true;
    } catch {
      if (source === epoch.current) setPageFailed(true);
      return false;
    } finally {
      if (source === epoch.current) setPaging(false);
    }
  };
  return (
    <>
      <TopRows
        rows={history.events}
        empty="No changes recorded."
        more={
          !full && history.nextCursor
            ? {
                label: paging ? 'Loading history…' : 'Show more history',
                busy: paging,
                load: () => loadHistory(true),
              }
            : undefined
        }
        draw={event => (
          <Row key={`${event.kind}:${event.id}`} cols="minmax(0, 1fr) auto">
            <div dir="auto">{visibleAuditSummary(event.summary)}</div>
            <div className="meta">
              <WorkTime at={event.at} />
            </div>
            <div className="meta t2" style={{ gridColumn: '1 / -1' }}>
              {new Date(event.at).toLocaleString()}
            </div>
            <div className="meta" style={{ gridColumn: '1 / -1' }}>
              <HistoryWho event={event} project={project} />
            </div>
          </Row>
        )}
      />
      {!history.completeFromCreation && history.historyStartsAt ? (
        <div className="quietline">
          History starts {new Date(history.historyStartsAt).toLocaleDateString()}.
        </div>
      ) : null}
      {full && history.nextCursor ? (
        <div className="pad">
          <Key size="sm" onClick={() => void loadHistory(false)} disabled={paging}>
            {paging ? 'Loading older changes…' : 'Show older changes'}
          </Key>
        </div>
      ) : null}
      {pageFailed ? (
        <div className="pad" role="status">
          More history could not be loaded. Try again.
        </div>
      ) : null}
    </>
  );
}

/** One page on open. Further pages use the same reader's cursor and an explicit request. */
export function ItemWork({
  itemId,
  read,
  readHistory,
  relations,
  at,
  project,
}: {
  itemId: string;
  relations?: ((related?: readonly Related[], more?: boolean) => ReactNode) | undefined;
  read: ReadItemWork;
  readHistory?: ReadItemHistory | undefined;
  at: (patch: Partial<ProjectRoute>) => string;
  project: WhoProject;
}) {
  const [work, setWork] = useState<Work | 'failed' | null>(null);
  const [full, setFull] = useState(false);
  const [paging, setPaging] = useState(false);
  const [pageFailed, setPageFailed] = useState<'lanes' | 'landings' | 'work' | null>(null);
  const [stale, setStale] = useState(false);
  const [revealed, reveal] = useState({ lanes: 0, landings: 0 });
  const [attempt, retry] = useState(0);
  const epoch = useRef(0);
  useEffect(() => {
    const source = ++epoch.current;
    setWork(null);
    setFull(false);
    setStale(false);
    setPageFailed(null);
    setPaging(false);
    reveal({ lanes: 0, landings: 0 });
    read(itemId, null, VISIBLE_ROWS)
      .then(raw => {
        if (source === epoch.current) setWork(JSON.parse(raw) as Work);
      })
      .catch(() => {
        if (source === epoch.current) setWork('failed');
      });
    return () => {
      epoch.current++;
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

  // total counts heads, not readable Lanes. A missing body within the first window is not another page.
  const expandLanes = !full && work.total > VISIBLE_ROWS && work.nextCursor !== null;
  const expandLandings = (work.landings ?? []).some(landing => landing.detailsPending);
  const continueWork =
    work.nextCursor !== null && (full || work.total > WORK_PAGE || work.moreLandings || work.moreRelated);
  const loadWork = async (part: 'lanes' | 'landings' | 'work') => {
    if (paging || (part !== 'landings' && !work.nextCursor)) return false;
    setPaging(true);
    setPageFailed(null);
    const source = epoch.current;
    try {
      if (part === 'landings') {
        const next = JSON.parse(await read(itemId, null, WORK_PAGE, 'landings')) as Work;
        if (source !== epoch.current) return false;
        if (!next.role) {
          setWork(next);
          return false;
        }
        const merged = new Map(
          [...(work.landings ?? []), ...(next.landings ?? [])].map(landing => [landing.receiptId, landing]),
        );
        setWork({
          ...work,
          landings: [...merged.values()],
          moreLandings: Boolean(next.moreLandings ?? work.moreLandings),
        });
        return true;
      }
      if (part === 'lanes' && !stale) {
        const next = JSON.parse(
          await read(itemId, work.nextCursor, WORK_PAGE - VISIBLE_ROWS, 'lanes'),
        ) as Work;
        if (source !== epoch.current) return false;
        setFull(true);
        if (!next.role) {
          setWork(next);
          return false;
        }
        const lanes = new Map([...work.lanes, ...next.lanes].map(lane => [lane.laneId, lane]));
        reveal(before => ({ ...before, lanes: before.lanes + Number(lanes.size > work.lanes.length) }));
        setWork({
          ...work,
          lanes: [...lanes.values()],
          total: next.total ?? work.total,
          atLeast: next.atLeast ?? work.atLeast,
          nextCursor: next.nextCursor,
        });
        return true;
      }
      const fromStart = stale;
      const [rawNext, rawHydrated] = await Promise.all([
        read(itemId, fromStart ? null : work.nextCursor, WORK_PAGE),
        !fromStart && expandLandings ? read(itemId, null, WORK_PAGE, 'landings') : Promise.resolve(null),
      ]);
      const next = JSON.parse(rawNext) as Work;
      const hydrated = rawHydrated ? (JSON.parse(rawHydrated) as Work) : null;
      if (source !== epoch.current) return false;
      setStale(false);
      setFull(true);
      if (!next.role || fromStart) {
        setWork(next);
        return next.role;
      }
      const lanes = new Map([...work.lanes, ...next.lanes].map(lane => [lane.laneId, lane]));
      const landings = new Map(
        [
          ...(work.landings ?? []),
          ...(hydrated && hydrated.role ? (hydrated.landings ?? []) : []),
          ...(next.landings ?? []),
        ].map(landing => [landing.receiptId, landing]),
      );
      const related = new Map(
        [...(work.related ?? []), ...(next.related ?? [])].map(link => [linkKey(link), link]),
      );
      reveal(before => ({
        lanes: before.lanes + Number(lanes.size > work.lanes.length),
        landings: before.landings + Number(landings.size > (work.landings?.length ?? 0)),
      }));
      setWork({
        ...work,
        ...next,
        lanes: [...lanes.values()],
        landings: [...landings.values()],
        moreLandings: Boolean(next.moreLandings ?? work.moreLandings),
        moreRelated: Boolean(next.moreRelated ?? work.moreRelated),
        total: next.total ?? work.total,
        atLeast: next.atLeast ?? work.atLeast,
        related: [...related.values()],
      });
      return true;
    } catch (error) {
      if (source === epoch.current) {
        setStale(stale || (error instanceof Error && /WORK_STALE/.test(error.message)));
        setPageFailed(part);
      }
      return false;
    } finally {
      if (source === epoch.current) setPaging(false);
    }
  };
  const landings = [...(work.landings ?? [])].sort(
    (a, b) => b.at.localeCompare(a.at) || (b.sequence ?? 0) - (a.sequence ?? 0),
  );
  const fold = `item-work:${project.handle}/${project.project}:${itemId}`;
  const more = continueWork ? (
    <div className="pad">
      <Key size="sm" onClick={() => void loadWork('work')} disabled={paging}>
        {paging ? 'Loading more work…' : 'Show more work'}
      </Key>
      {pageFailed === 'work' ? <p role="status">More work could not be loaded. Try again.</p> : null}
    </div>
  ) : null;
  const workRegion = (
    <Region title="Work">
      <Part name="Lanes" fold={`${fold}:lanes`} count={work.total} atLeast={work.atLeast}>
        <TopRows
          rows={work.lanes}
          empty="No Lanes yet."
          reveal={revealed.lanes}
          error={pageFailed === 'lanes' ? 'More Lanes could not be loaded. Try again.' : undefined}
          more={
            expandLanes
              ? {
                  label: paging ? 'Loading more Lanes…' : 'Show more Lanes',
                  busy: paging,
                  load: () => loadWork('lanes'),
                }
              : undefined
          }
          draw={lane => (
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
                {' · '}
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
          )}
        />
      </Part>
      <Part
        name="Landings"
        count={work.moreLandings && landings.length === 0 ? undefined : landings.length}
        atLeast={Boolean(work.moreLandings)}
        fold={`${fold}:landings`}
      >
        <TopRows
          rows={landings}
          reveal={revealed.landings}
          empty={work.moreLandings ? 'This page has no landings.' : 'No landings shown.'}
          error={
            pageFailed === 'landings' ? 'More landing details could not be loaded. Try again.' : undefined
          }
          more={
            expandLandings
              ? {
                  label: paging
                    ? 'Loading landing details…'
                    : `Show ${(landings.length - VISIBLE_ROWS).toLocaleString()} more`,
                  busy: paging,
                  load: () => loadWork('landings'),
                }
              : undefined
          }
          draw={landing => (
            <Row key={landing.receiptId} cols="minmax(0, 1fr) auto">
              <div>
                <A
                  className="lk"
                  href={`${at({ place: 'code', section: 'files' })}?at=${encodeURIComponent(landing.commit)}`}
                >
                  Landing {landing.receiptId.slice(0, 8)}
                </A>
                {landing.checked === false ? (
                  <>
                    {' '}
                    <Unchecked />
                  </>
                ) : null}
                <div className="meta">
                  {landing.files === null
                    ? 'File count unavailable'
                    : `${landing.files.toLocaleString()} ${landing.files === 1 ? 'file' : 'files'} changed`}
                </div>
              </div>
              <div>
                {landing.checked === false ? null : landing.check === 'passed' ? (
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
          )}
        />
      </Part>
      {readHistory ? (
        <Part name="History" fold={`${fold}:history`} lazy>
          <ItemHistory itemId={itemId} read={readHistory} project={project} />
        </Part>
      ) : null}
      {more}
    </Region>
  );
  return (
    <>
      {relations?.(work.related, work.moreRelated)}
      {workRegion}
    </>
  );
}
