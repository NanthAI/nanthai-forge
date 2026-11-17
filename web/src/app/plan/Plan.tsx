// SPDX-License-Identifier: Apache-2.0
// Plan (Items d3357f40, b7a0dff1): one hand-ordered list grouped by Initiative. The page sentence and the standing
// line answer what is done, in progress and left; "next" is derived from state (src/planning-model.ts nextItem), never
// stored. Each Initiative's band counts its Items one tick each. Loaded with its route only.
// Reads: projectPlanView:read, one subscription, re-run only by planning writes in the ranges it read; the frame
// already reads the line. Writes: projectWorkCommand:command (put-planning-item, retry-safe by its operation id).
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { makeFunctionReference } from 'convex/server';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import { Band, ItemState, Key, Region, ReorderList, Row, Sheet, Standing, State, Who } from '../../ds';
import { Announcer, useAnnounce } from '../../ds/behaviour/announce';
import { defaultItemTypes, inverseRelationLabel, itemStatusLabel } from '../../../../src/planning-model';
import type { PlanRow } from '../../../../src/planning-model';
import { A } from '../frames';
import { currentScreenHref, hrefFor } from '../paths';
import { Head, Placeholder, crumbsFor } from '../Place';
import type { PlaceProps } from '../screens';
import {
  captureBody,
  matches,
  movedRank,
  planSentence,
  planView,
  statusOf,
  type PlanGroup,
  type PlanLine,
  type PlanRead,
  type PlanView,
} from './model';
import './plan.css';

/** An Item's comments (Item 9a3d6f5f) load with the Item page only, so the list never loads the Markdown renderer. */
const ItemDiscussion = lazy(() => import('../discussion/ItemDiscussion'));
const planRead = makeFunctionReference<'query', { projectId: Id<'hostedProjects'> }, PlanRead>(
  'projectPlanView:read',
);
/** Columns after the handle: position, the name with its flags, done-when, owner, status. */
const COLS = '2.2em minmax(0, 1fr) auto auto auto';

export type Put = (command: Record<string, unknown>) => Promise<unknown>;

export default function Plan(props: PlaceProps) {
  // The Initiatives section keeps its placeholder until it is rebuilt.
  if (props.route.section) return <Placeholder route={props.route} projectName={props.projectName} />;
  return <PlanScreen {...props} />;
}

function PlanScreen({ route, projectId, projectName, feed }: PlaceProps) {
  const read = useQuery(planRead, { projectId });
  const mutate = useMutation(api.projectWorkCommand.command);
  const put: Put = command => {
    const operationId = crypto.randomUUID();
    return mutate({
      projectId,
      operationId,
      command: JSON.stringify({ action: 'put-planning-item', operationId, ...command }),
    });
  };
  return (
    <PlanScreenView
      route={route}
      projectName={projectName}
      feed={feed}
      read={read}
      put={put}
      projectId={projectId}
    />
  );
}

/** The screen from its read; an `undefined` read draws as loading. */
export function PlanScreenView({
  route,
  projectName,
  feed,
  read,
  put,
  projectId,
}: Pick<PlaceProps, 'route' | 'projectName' | 'feed'> & {
  read: PlanRead | undefined;
  put: Put;
  /** Hosted reads for the Item page's comments; without it the page draws no discussion. */
  projectId?: Id<'hostedProjects'>;
}) {
  const [find, setFind] = useState('');
  const [orders, setOrders] = useState<ReadonlyMap<string, string>>(new Map());
  const [capture, setCapture] = useState(false);
  const [error, setError] = useState('');
  const [message, announce] = useAnnounce();
  const view = useMemo(() => (read ? planView(read, find.trim(), orders) : null), [read, find, orders]);
  const at = (patch: Partial<PlaceProps['route']>) => hrefFor({ ...route, section: '', rest: '', ...patch });
  const canCapture = Boolean(view?.canEdit) && !route.rest;
  useEffect(() => {
    if (!canCapture) return;
    // "n" opens New Item, as its key shows, unless the reader is typing or holding a modifier.
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key !== 'n' || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented)
        return;
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      event.preventDefault();
      setCapture(true);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [canCapture]);
  const whole = useMemo(() => (read ? planView(read, '', orders) : null), [read, orders]);
  if (route.rest)
    return <ItemPage route={route} projectName={projectName} view={whole} at={at} projectId={projectId} />;
  const sentence = view ? planSentence(view) : null;
  const lanesOpen = feed ? feed.lanes.length + feed.more : null;

  const move = (group: PlanGroup, id: string, toIndex: number) => {
    const ids = group.lines.map(line => line.row.id).filter(other => other !== id);
    ids.splice(toIndex, 0, id);
    const order = movedRank(group.lines, ids, id);
    const row = view?.byId.get(id);
    if (!order || !row) return;
    setOrders(previous => new Map(previous).set(id, order));
    setError('');
    put({ itemId: id, expectedVersion: row.version ?? 0, order }).then(
      () => undefined,
      () => {
        setOrders(previous => {
          const next = new Map(previous);
          next.delete(id);
          return next;
        });
        setError(`Forge could not move ${row.title}; it is back where it was.`);
      },
    );
  };

  return (
    <div className="plan">
      <Head
        trail={crumbsFor(route, projectName)}
        sentence={
          sentence ? (
            <>
              <b>{sentence.bold}</b> {sentence.rest}
            </>
          ) : (
            'Loading the plan…'
          )
        }
      >
        {view?.canEdit ? (
          <Key size="sm" keys="n" onClick={() => setCapture(true)}>
            New Item
          </Key>
        ) : null}
      </Head>
      <Standing
        of="app"
        done={{ n: view?.done ?? 0, more: view ? 'in open Initiatives' : 'loading' }}
        inProgress={{
          n: view?.inProgress ?? 0,
          more:
            lanesOpen === null
              ? undefined
              : `${lanesOpen.toLocaleString()} ${lanesOpen === 1 ? 'Lane' : 'Lanes'} open`,
          href: at({ place: 'lanes' }),
        }}
        left={{
          n: view ? view.planned + view.proposed : 0,
          more: view
            ? [view.proposed ? `${view.proposed.toLocaleString()} proposed` : '', view.more ? 'at least' : '']
                .filter(Boolean)
                .join(', ') || undefined
            : undefined,
        }}
      />
      <Region
        title="Open work"
        count={view?.live}
        hint={view ? (find ? 'matching the find' : 'in the order set by hand') : undefined}
        tools={
          <label className="find">
            <span className="sr">Find in open work</span>
            <input
              className="inp"
              name="find"
              autoComplete="off"
              placeholder="Find in open work…"
              value={find}
              onChange={event => setFind(event.target.value)}
            />
          </label>
        }
      >
        {error ? (
          <div className="pf" role="alert">
            {error}
          </div>
        ) : null}
        {!view ? (
          <div className="quietline" aria-busy="true">
            Loading the plan…
          </div>
        ) : !view.live && !view.groups.length ? (
          <div className="quietline">No Items yet.</div>
        ) : (
          <>
            {view.groups.map(group => (
              <Group
                key={group.initiative?.id ?? 'none'}
                group={group}
                view={view}
                find={find}
                at={at}
                onMove={(id, toIndex) => move(group, id, toIndex)}
              />
            ))}
            {find && !view.groups.some(group => group.lines.length) ? (
              <div className="quietline">Nothing in open work matches “{find.trim()}”.</div>
            ) : null}
            {view.more ? (
              <div className="pf">
                Some open Items were not read; the first {view.live.toLocaleString()} are listed.
              </div>
            ) : null}
            {view.next ? (
              <div className="plan-next">
                <span
                  className="nextmark"
                  title="The first planned Item with no owner, no Lane and nothing blocking it, in order"
                >
                  next
                </span>
                <A className="lk" href={at({ rest: view.next.id })}>
                  {view.next.title}
                </A>
              </div>
            ) : null}
          </>
        )}
      </Region>
      {view?.canEdit ? (
        <Capture open={capture} onOpenChange={setCapture} view={view} put={put} announce={announce} />
      ) : null}
      <Announcer message={message} />
    </div>
  );
}

function Group({
  group,
  view,
  find,
  at,
  onMove,
}: {
  group: PlanGroup;
  view: PlanView;
  find: string;
  at: (patch: Partial<PlaceProps['route']>) => string;
  onMove: (id: string, toIndex: number) => void;
}) {
  const name = group.initiative?.title ?? 'No Initiative';
  const items = group.lines.map(line => ({ id: line.row.id, label: line.row.title, line }));
  return (
    <div className="grp plan-grp">
      <Band
        title={name}
        count={group.live}
        hint={
          group.initiative ? (
            <span className="plan-roll">
              <Roll group={group} />
              {group.done.toLocaleString()}
              {group.atLeast ? '+' : ''} of {group.total.toLocaleString()} done
              {group.dropped ? `, ${group.dropped.toLocaleString()} dropped` : ''}
              {group.initiative.hidden ? ', hidden from the public plan' : ''}
            </span>
          ) : (
            'not in an Initiative yet'
          )
        }
      />
      {items.length ? (
        <ReorderList
          label={`${name}, open Items in order`}
          items={items}
          onMove={onMove}
          disabled={!view.canEdit || Boolean(find.trim())}
          cols={COLS}
        >
          {({ line }) => <Line line={line} href={at({ rest: line.row.id })} />}
        </ReorderList>
      ) : group.live ? null : (
        <div className="quietline">No open Items.</div>
      )}
    </div>
  );
}

/** One tick per Item: done, in progress, not started (DESIGN.md roll-up; no typed percentage). */
function Roll({ group }: { group: PlanGroup }) {
  const total = group.total;
  const ticks = Math.min(total, 40);
  const step = total / (ticks || 1);
  return (
    <span
      className="roll"
      role="img"
      aria-label={`${group.done} of ${total} done, ${group.inProgress} in progress`}
    >
      {Array.from({ length: ticks }, (_, index) => (
        <i
          key={index}
          className={
            index * step < group.done
              ? 'ok'
              : index * step < group.done + group.inProgress
                ? 'run'
                : undefined
          }
        />
      ))}
    </span>
  );
}

function Status({ row }: { row: PlanRow }) {
  const status = statusOf(row);
  if (status === 'proposed' || status === 'planned') return <ItemState of={status} />;
  if (status === 'in-progress') return <State word="In progress" />;
  return <State word={status === 'done' ? 'Done' : 'Abandoned'} />;
}

function DoneWhen({ row }: { row: PlanRow }) {
  if (!row.doneWhen) return <span className="dw t3">none</span>;
  const [ticked, total] = row.doneWhen;
  return (
    <span className="dw" title={`${ticked} of ${total} done-when lines ticked`}>
      {total <= 12 ? (
        <span className="shards" aria-hidden="true">
          {Array.from({ length: total }, (_, index) => (
            <i key={index} className={index < ticked ? 'ok' : undefined} />
          ))}
        </span>
      ) : null}
      <span className="num">
        {ticked}/{total}
      </span>
    </span>
  );
}

function Line({ line, href }: { line: PlanLine; href: string }) {
  const { row } = line;
  return (
    <>
      <span className="rk" aria-hidden="true">
        {line.depth ? '' : line.rank}
      </span>
      <span className={`tt${line.depth ? ' sub' : ''}`}>
        <A className="ttl" href={href} dir="auto" title={row.title}>
          {row.title}
        </A>
        {line.next ? (
          <span
            className="nextmark"
            title="The first planned Item with no owner, no Lane and nothing blocking it"
          >
            next
          </span>
        ) : null}
        {line.blockedBy ? (
          <span className="flag" title={`Cannot start until ${line.blockedBy.title} is done`}>
            blocked by {line.blockedBy.id.slice(0, 4)}
          </span>
        ) : null}
        {row.type ? <span className="flag">{row.type}</span> : null}
        {row.hidden ? <span className="flag">hidden</span> : null}
      </span>
      <span className="plan-wide">
        <DoneWhen row={row} />
      </span>
      <span className="plan-wide">
        {row.owner ? <Who handle={row.owner} /> : <span className="t3">no one yet</span>}
      </span>
      <span className="state">
        <Status row={row} />
      </span>
    </>
  );
}

/** New Item: a person's Item starts Planned (owner decision 1.3) and lands last in its group, since its creation
 * position sorts after every stored rank. Matching open Items are shown while typing. */
function Capture({
  open,
  onOpenChange,
  view,
  put,
  announce,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  view: PlanView;
  put: Put;
  announce: (text: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [initiativeId, setInitiativeId] = useState('');
  const [type, setType] = useState('');
  const [doneWhen, setDoneWhen] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // One operation per Item written here, so a retry after a lost reply never files it twice.
  const pending = useRef<{ itemId: string; key: string } | null>(null);
  const initiatives = view.groups.flatMap(group => (group.initiative ? [group.initiative] : []));
  const similar =
    title.trim().length >= 3
      ? [...view.byId.values()].filter(row => row.kind === 'issue' && matches(row, title.trim())).slice(0, 3)
      : [];
  const reset = () => {
    setTitle('');
    setDoneWhen('');
    setType('');
    setError('');
    pending.current = null;
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = title.trim();
    if (!text || busy) return;
    const key = JSON.stringify([text, initiativeId, type, doneWhen]);
    if (pending.current?.key !== key) pending.current = { itemId: crypto.randomUUID(), key };
    setBusy(true);
    setError('');
    try {
      await put({
        itemId: pending.current.itemId,
        expectedVersion: 0,
        kind: 'issue',
        title: text,
        body: captureBody(doneWhen),
        status: 'open',
        initiativeId: initiativeId || null,
        ...(type ? { type } : {}),
      });
      announce(`${text} planned.`);
      reset();
      onOpenChange(false);
    } catch {
      setError('Forge could not file it. Nothing was filed; try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open={open}
      onOpenChange={next => {
        if (!next) reset();
        onOpenChange(next);
      }}
      title="New Item"
      footer={
        <>
          <Key onClick={() => onOpenChange(false)}>Cancel</Key>
          <Key kind="primary" type="submit" form="plan-capture" disabled={!title.trim() || busy}>
            {busy ? 'Filing…' : 'Plan it'}
          </Key>
        </>
      }
    >
      <form id="plan-capture" className="plan-capture" onSubmit={submit}>
        <label>
          <span>Title</span>
          <input
            className="inp"
            value={title}
            onChange={event => setTitle(event.target.value)}
            required
            autoFocus
          />
        </label>
        {similar.length ? (
          <div className="plan-similar" role="status">
            <span className="t2">Already in open work:</span>
            {similar.map(row => (
              <span key={row.id} className="cut" dir="auto">
                {row.title}
              </span>
            ))}
          </div>
        ) : null}
        <label>
          <span>Initiative</span>
          <select
            className="inp"
            value={initiativeId}
            onChange={event => setInitiativeId(event.target.value)}
          >
            <option value="">No Initiative</option>
            {initiatives.map(row => (
              <option key={row.id} value={row.id}>
                {row.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Type</span>
          <select className="inp" value={type} onChange={event => setType(event.target.value)}>
            <option value="">None</option>
            {defaultItemTypes.map(name => (
              <option key={name} value={name}>
                {name[0]!.toUpperCase() + name.slice(1)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Done when (one line each)</span>
          <textarea
            className="inp"
            rows={3}
            value={doneWhen}
            onChange={event => setDoneWhen(event.target.value)}
          />
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

/** An Item from the plan's own read: status, place in its Initiative, owner, done-when and relations, then its
 * comments (their own reads). The body and history open on the current Item screen until the Item page is rebuilt. */
function ItemPage({
  route,
  projectName,
  view,
  at,
  projectId,
}: {
  route: PlaceProps['route'];
  projectName: string;
  view: PlanView | null;
  at: (patch: Partial<PlaceProps['route']>) => string;
  projectId: Id<'hostedProjects'> | undefined;
}) {
  const row = view
    ? ([...view.byId.values()].find(entry => entry.id.startsWith(route.rest)) ?? null)
    : undefined;
  const legacy = currentScreenHref(route);
  const full = legacy && row ? `${legacy}?planningItem=${encodeURIComponent(row.id)}` : legacy;
  const group = row
    ? view?.groups.find(entry => entry.lines.some(line => line.row.id === row.id))
    : undefined;
  const line = group?.lines.find(entry => entry.row.id === row?.id);
  const blocks = row
    ? [...view!.byId.values()].filter(other =>
        other.relations?.some(relation => relation.kind === 'depends-on' && relation.id === row.id),
      )
    : [];
  const facts: [string, ReactNode][] = row
    ? [
        ['Status', <Status key="s" row={row} />],
        [
          'In',
          group?.initiative
            ? `${group.initiative.title}${line && !line.depth ? `, ${line.rank} of ${group.lines.filter(entry => !entry.depth).length} in order` : ''}`
            : 'No Initiative',
        ],
        ['Owner', row.owner ? <Who key="o" handle={row.owner} /> : 'no one yet'],
        ['Done when', <DoneWhen key="d" row={row} />],
        ...(row.type ? ([['Type', row.type]] as [string, ReactNode][]) : []),
        ...(row.hidden ? ([['Public plan', 'hidden']] as [string, ReactNode][]) : []),
      ]
    : [];
  return (
    <div className="plan">
      <Head
        trail={crumbsFor(route, projectName)}
        sentence={
          row === undefined ? (
            'Loading the Item…'
          ) : row === null ? (
            'This Item is not in open work.'
          ) : (
            <>
              <b dir="auto">{row.title}</b> {itemStatusLabel[statusOf(row)]}
              {line?.next ? ', and it is the next free one.' : '.'}
            </>
          )
        }
      >
        {full ? (
          <a className="btn sm" href={full}>
            Open the full Item
          </a>
        ) : null}
      </Head>
      {row ? (
        <Region title="Item">
          <dl className="kv">
            {facts.map(([label, value]) => (
              <FactRow key={label} label={label}>
                {value}
              </FactRow>
            ))}
          </dl>
          {row.relations?.length || blocks.length ? (
            <>
              <Band title="Relations" count={(row.relations?.length ?? 0) + blocks.length} />
              {row.relations?.map(relation => (
                <Relation
                  key={`${relation.kind}:${relation.id}`}
                  kind={relation.kind}
                  id={relation.id}
                  view={view!}
                  at={at}
                />
              ))}
              {blocks.map(other => (
                <Row key={`blocks:${other.id}`} cols="8em minmax(0, 1fr)">
                  <span className="t2">{inverseRelationLabel['depends-on']}</span>
                  <A className="lk" href={at({ rest: other.id })} dir="auto">
                    {other.title}
                  </A>
                </Row>
              ))}
            </>
          ) : null}
          {projectId ? (
            <Suspense fallback={<div className="quietline">Loading the comments…</div>}>
              <ItemDiscussion projectId={projectId} itemId={row.id} />
            </Suspense>
          ) : null}
        </Region>
      ) : row === null ? (
        <Region title="Item">
          <div className="quietline">
            It may be done or abandoned. <A href={at({})}>Back to the plan</A>
          </div>
        </Region>
      ) : null}
    </div>
  );
}

function FactRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

const relationWords = {
  'depends-on': 'Depends on',
  'duplicate-of': 'Duplicate of',
  related: 'Related',
} as const;
function Relation({
  kind,
  id,
  view,
  at,
}: {
  kind: keyof typeof relationWords;
  id: string;
  view: PlanView;
  at: (patch: Partial<PlaceProps['route']>) => string;
}) {
  const other = view.byId.get(id);
  return (
    <Row cols="8em minmax(0, 1fr)">
      <span className="t2">{relationWords[kind]}</span>
      {other ? (
        <A className="lk" href={at({ rest: id })} dir="auto">
          {other.title}
        </A>
      ) : (
        <span className="mono t2">{id.slice(0, 8)}, not in open work</span>
      )}
    </Row>
  );
}
