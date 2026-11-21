// SPDX-License-Identifier: Apache-2.0
// The Initiative page (Items 4df3ee17, b7a0dff1; decision afcb5bc3): opened from a group's name on the backlog. Its
// open Items in hand order (reorderable, the same one-write move as the backlog), its counted progress, its About
// text, an edit of title, About and status, and its done and dropped Items on request.
// Reads: the backlog's own projectPlanView:read rows (no new subscription); the Initiative record once per version
// (one-shot, re-read only when the live row's version changes); done and dropped Items of this Initiative, one page
// of 50 each, subscribed only while that fold is open. Writes: projectWorkCommand:command, retry-safe by operation id.
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Band, Count, Key, Region, ReorderList, Sheet, Who } from '../../ds';
import { itemStatus, itemStatusLabel, type PlanRow, type StoredStatus } from '../../../../src/planning-model';
import { A } from '../frames';
import { Head, crumbsFor } from '../Place';
import type { PlaceProps } from '../screens';
import type { InitiativeDetails } from './batch';
import type { Reads } from './Bulk';
import { groupBreakdown, statusOf, type PlanGroup, type PlanView } from './model';
import { breakdownTotal, breakdownWords } from '../progress';
import type { Put, Settled } from './Plan';
import { BreakdownWords, COLS, Line, Roll, Status } from './rows';
import { InitiativeWork, type ReadInitiativeWork } from './InitiativeWork';
import { accountableHandle, workingAgentsLabel, type Workers } from './workers';

type At = (patch: Partial<PlaceProps['route']>) => string;
const statuses: StoredStatus[] = ['proposed', 'open', 'in-progress', 'closed', 'abandoned'];

/** The sentence under the Initiative's name: what is done, what is moving, and what to do when nothing is left. */
export function initiativeSentence(group: PlanGroup) {
  if (!group.total)
    return { bold: 'No Items in this Initiative yet.', rest: 'Add one, or move Items in from the plan.' };
  if (
    !group.live &&
    group.initiative &&
    statusOf(group.initiative) !== 'done' &&
    statusOf(group.initiative) !== 'abandoned'
  )
    return {
      bold: 'Every Item in this Initiative is done or dropped.',
      rest: 'Close the Initiative, or keep it open for what comes next.',
    };
  const next = group.lines.find(line => line.next);
  const breakdown = groupBreakdown(group);
  return {
    bold: `${breakdownTotal(breakdown)} in this Initiative · ${breakdownWords(breakdown)}.`,
    rest: next ? `The next free one is ${next.row.title}.` : '',
  };
}

export function InitiativePage({
  route,
  projectName,
  initiative,
  view,
  workers,
  observedLanes,
  missingIdentity,
  at,
  put,
  reads,
  readWork,
  closed,
  dropped,
  onShowDone,
  onMove,
  error,
  onNew,
  announce,
}: {
  route: PlaceProps['route'];
  projectName: string;
  initiative: PlanRow;
  view: PlanView;
  workers: Workers;
  observedLanes: number;
  missingIdentity: boolean;
  at: At;
  put: Put;
  reads?: Reads | undefined;
  readWork?: ReadInitiativeWork | undefined;
  closed: Settled;
  dropped: Settled;
  /** Subscribes to (id) or drops (null) this Initiative's done and dropped pages. */
  onShowDone: (id: string | null) => void;
  /** Moves one open Item to a new place among the lines shown (the backlog's move). */
  onMove: (group: PlanGroup, id: string, toIndex: number) => void;
  error: string;
  onNew?: (() => void) | undefined;
  announce: (text: string) => void;
}) {
  const [failed, setError] = useState('');
  const group =
    view.groups.find(entry => entry.initiative?.id === initiative.id) ??
    ({
      initiative,
      lines: [],
      live: 0,
      inProgress: 0,
      open: 0,
      proposed: 0,
      done: 0,
      dropped: 0,
      total: 0,
      atLeast: false,
    } as PlanGroup);
  const [editing, setEditing] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const full = useFullItem(reads, initiative);
  const accountable = accountableHandle(full.item?.creator);
  const [openLanes, setOpenLanes] = useState<number | null>(null);
  // Only a complete first Work page establishes coverage. Never fetch a page to finish the count.
  const readWorkCoverage = useMemo<ReadInitiativeWork | undefined>(
    () =>
      readWork &&
      (async (id, cursor) => {
        const raw = await readWork(id, cursor);
        if (cursor === null) {
          const page = JSON.parse(raw);
          setOpenLanes(
            page.role && !page.nextCursor && !page.openAtLeast && typeof page.openLanes === 'number'
              ? page.openLanes
              : null,
          );
        }
        return raw;
      }),
    [readWork],
  );
  useEffect(() => {
    onShowDone(showDone ? initiative.id : null);
    return () => onShowDone(null);
  }, [showDone, initiative.id]);
  // The backlog's own move: shown at once, one order write, put back with a notice if it fails.
  const ordered = group.lines;
  const sentence = initiativeSentence(group);
  const breakdown = groupBreakdown(group);
  const settled = [...closed.rows, ...dropped.rows].filter(row => row.initiativeId === initiative.id);
  const status = statusOf(initiative);
  const allDone = group.total > 0 && !group.live && status !== 'done' && status !== 'abandoned';
  return (
    <div className="plan plan-ini">
      <Head
        trail={crumbsFor(route, projectName)}
        sentence={
          <>
            <b>{sentence.bold}</b> {sentence.rest}
          </>
        }
      >
        {view.canEdit && onNew ? (
          <Key size="sm" keys="n" onClick={onNew}>
            New Item here
          </Key>
        ) : null}
        {view.canEdit ? (
          <Key size="sm" onClick={() => setEditing(true)}>
            Edit
          </Key>
        ) : null}
      </Head>
      <div className="plan-ini-body">
        <Region
          title={initiative.title}
          count={group.live}
          hint={group.live ? 'open, in the order set by hand' : undefined}
        >
          {error || failed ? (
            <div className="pf" role="alert">
              {error || failed}
            </div>
          ) : null}
          {allDone && view.canEdit ? (
            <div className="plan-ini-close">
              <span>Everything in it is done or dropped.</span>
              <Key
                size="sm"
                kind="rec"
                onClick={() =>
                  put({
                    itemId: initiative.id,
                    expectedVersion: initiative.version ?? 0,
                    status: 'closed',
                  }).then(
                    () => announce(`${initiative.title} closed.`),
                    () => setError('Forge could not close it; nothing changed.'),
                  )
                }
              >
                Close the Initiative
              </Key>
            </div>
          ) : null}
          {ordered.length ? (
            <ReorderList
              label={`${initiative.title}, open Items in order`}
              items={ordered.map(line => ({ id: line.row.id, label: line.row.title, line }))}
              onMove={(id, toIndex) => onMove(group, id, toIndex)}
              disabled={!view.canEdit}
              cols={COLS}
            >
              {({ line }) => <Line line={line} href={at({ rest: line.row.id })} workers={workers} />}
            </ReorderList>
          ) : (
            <div className="quietline">
              {group.total ? 'No open Items.' : 'Nothing in it yet. Items added here count toward it.'}
            </div>
          )}
          <div className={`grp plan-grp${showDone ? '' : ' shut'}`} data-fold="">
            <div className="band plan-gh">
              <span className="plan-gn">Done and dropped</span>
              <Count n={group.done + group.dropped} />
              <span className="plan-pl t3">{showDone ? 'newest first' : ''}</span>
              <button
                type="button"
                className="tw"
                aria-expanded={showDone}
                aria-controls="plan-ini-done"
                aria-label="Done and dropped Items"
                onClick={() => setShowDone(open => !open)}
              />
            </div>
            <div id="plan-ini-done">
              {showDone ? (
                <>
                  {settled.map(row => (
                    <div key={row.id} className="row" style={{ gridTemplateColumns: COLS }}>
                      <Line
                        line={{ row, depth: 0, rank: 0, next: false }}
                        href={at({ rest: row.id })}
                        ranked={false}
                      />
                    </div>
                  ))}
                  {closed.loading || dropped.loading ? (
                    <div className="quietline" aria-busy="true">
                      Loading done and dropped Items…
                    </div>
                  ) : !settled.length ? (
                    <div className="quietline">Nothing done or dropped yet.</div>
                  ) : null}
                  {closed.failed || dropped.failed ? (
                    <div className="pf">A page could not be read; the rows above stay.</div>
                  ) : null}
                  {closed.more || dropped.more ? (
                    <div className="pager">
                      <Key
                        size="sm"
                        onClick={() => {
                          if (closed.more) closed.loadMore();
                          if (dropped.more) dropped.loadMore();
                        }}
                      >
                        Show 50 more
                      </Key>
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          </div>
        </Region>
        <Region title="Initiative progress" quiet>
          <div className="fig">
            <div className="big">
              {breakdownTotal(breakdown)}
              <small>{group.total ? <BreakdownWords breakdown={breakdown} /> : 'nothing to count yet'}</small>
            </div>
            {group.total ? <Roll breakdown={breakdown} large /> : null}
          </div>
          <dl className="kv">
            <dt>Status</dt>
            <dd>
              <Status row={initiative} />
            </dd>
            <dt>Accountable</dt>
            <dd>{accountable ? <Who handle={accountable} /> : <span className="t3">Not reported</span>}</dd>
            <dt>Working now</dt>
            <dd>
              <A className="lk" href={at({ place: 'lanes', section: 'touching' })}>
                {workingAgentsLabel(
                  workers,
                  ordered.map(line => line.row.id),
                  observedLanes,
                  missingIdentity,
                  !view.more && group.total === 0 ? 0 : openLanes,
                )}
              </A>
            </dd>
            {initiative.hidden ? (
              <>
                <dt>Public plan</dt>
                <dd>hidden, with every Item in it</dd>
              </>
            ) : null}
          </dl>
          {readWorkCoverage ? (
            <InitiativeWork key={initiative.id} initiativeId={initiative.id} read={readWorkCoverage} />
          ) : null}
          <Band title="About" />
          <div className="plan-about" dir="auto">
            {full.item === undefined ? (
              <span className="t3" aria-busy="true">
                Loading…
              </span>
            ) : full.item === null ? (
              <span className="t3">Forge could not read it.</span>
            ) : full.item.body.trim() ? (
              full.item.body
            ) : (
              <span className="t3">Nothing written yet.</span>
            )}
          </div>
          <div className="plan-about">
            <A className="lk" href={`${at({})}?initiative=${encodeURIComponent(initiative.id)}`}>
              Show it in the backlog
            </A>
          </div>
        </Region>
      </div>
      {editing ? (
        <EditInitiative
          initiative={initiative}
          body={full.item?.body}
          put={put}
          onOpenChange={setEditing}
          onSaved={() => {
            full.reload();
            announce(`${initiative.title} saved.`);
          }}
        />
      ) : null}
    </div>
  );
}

/** The Initiative in full (its About text), read once per version: the live plan row's version changing re-reads it. */
function useFullItem(reads: Reads | undefined, initiative: PlanRow) {
  const [item, setItem] = useState<InitiativeDetails | null | undefined>(undefined);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!reads) return setItem(null);
    let live = true;
    reads.initiative(initiative.id).then(
      value => live && setItem(value),
      () => live && setItem(null),
    );
    return () => {
      live = false;
    };
  }, [reads ? 1 : 0, initiative.id, initiative.version, tick]);
  return { item, reload: () => setTick(n => n + 1) };
}

function EditInitiative({
  initiative,
  body,
  put,
  onOpenChange,
  onSaved,
}: {
  initiative: PlanRow;
  body: string | undefined;
  put: Put;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(initiative.title);
  const [about, setAbout] = useState(body ?? '');
  const [status, setStatus] = useState<StoredStatus>(initiative.status);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (body !== undefined) setAbout(body);
  }, [body]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = title.trim();
    if (!text || busy || body === undefined) return;
    setBusy(true);
    setError('');
    try {
      await put({
        itemId: initiative.id,
        expectedVersion: initiative.version ?? 0,
        ...(text !== initiative.title ? { title: text } : {}),
        ...(about !== body ? { body: about } : {}),
        ...(status !== initiative.status ? { status } : {}),
      });
      onSaved();
      onOpenChange(false);
    } catch (failure) {
      const changed = failure instanceof Error && /ITEM_CHANGED|changed/i.test(failure.message);
      setError(
        changed
          ? 'Someone changed this Initiative meanwhile. Nothing was overwritten; close and edit again.'
          : 'Forge could not save it; nothing changed.',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open
      onOpenChange={onOpenChange}
      title="Edit the Initiative"
      footer={
        <>
          <Key onClick={() => onOpenChange(false)}>Cancel</Key>
          <Key
            kind="primary"
            type="submit"
            form="plan-ini-edit"
            disabled={!title.trim() || busy || body === undefined}
          >
            {busy ? 'Saving…' : 'Save'}
          </Key>
        </>
      }
    >
      <form id="plan-ini-edit" className="plan-capture" onSubmit={submit}>
        <label>
          <span>Name</span>
          <input
            className="inp"
            value={title}
            onChange={event => setTitle(event.target.value)}
            required
            autoFocus
          />
        </label>
        <label>
          <span>About</span>
          <textarea className="inp" rows={5} value={about} onChange={event => setAbout(event.target.value)} />
        </label>
        <label>
          <span>Status</span>
          <select
            className="inp"
            value={status}
            onChange={event => setStatus(event.target.value as StoredStatus)}
          >
            {statuses.map(value => (
              <option key={value} value={value}>
                {itemStatusLabel[itemStatus[value]]}
              </option>
            ))}
          </select>
        </label>
        {error ? (
          <p className="pf" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </Sheet>
  );
}
