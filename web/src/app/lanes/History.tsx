// SPDX-License-Identifier: Apache-2.0
// History (Item c613e6bc): what landed, newest first, with this reader's read marks. It replaces To read and the Lanes
// overview's Landed today. The first page is read when the page opens (35f62c2c: never behind a fold), and the empty
// state shows only when that read came back with no rows. Read state is per account (convex/projectLandingReads.ts),
// so every device and the CLI agree; nothing here holds a landing or counts toward Needs you.
import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { Group, Key, Region } from '../../ds';
import { A } from '../frames';
import { RecordedWho } from '../RecordedWho';
import { recordedIdentity, type WhoProject } from '../who-links';
import { hrefFor } from '../paths';
import { navigate, useSearch } from '../router';
import { Head, crumbsFor } from '../Place';
import type { LanesProps } from './common';
import { groupByDay, historyEmpty } from './model';
import {
  useHistoryPages,
  useMarkRead,
  useQueue,
  type HistoryFilter,
  type Landed,
  type LandedPage,
} from './reads';

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** Who landed it, as a public identity: `@person`, or `person/run` for an agent run. */
const whoOf = (row: Pick<Landed, 'actor' | 'agent' | 'agentRun'>) =>
  recordedIdentity(row.actor, row.agent ? row.agentRun : null);
/** The declared model for <Who>: a model, null ("model not declared"), or undefined for a person. */
const modelOf = (row: Landed) =>
  !row.agent
    ? undefined
    : row.model === 'not-declared' || row.model === 'unknown' || row.model === null
      ? null
      : row.model;
const titleOf = (row: Landed) => row.item?.title ?? row.goal ?? row.title ?? 'Untitled landing';

/** The filters in the address (`?unread=1&by=…&item=…&kind=agent`), so a link, a reload and Back show the same view. */
export function historyFilter(search: URLSearchParams): HistoryFilter {
  const kind = search.get('kind');
  return {
    unread: search.get('unread') === '1',
    by: search.get('by') || null,
    item: search.get('item') || null,
    kind: kind === 'agent' || kind === 'person' ? kind : null,
  };
}

type Done = { words: string; undo: () => void } | null;
type Mark = Parameters<ReturnType<typeof useMarkRead>>[0];

export function History({ route, projectId, projectName }: LanesProps) {
  const filter = historyFilter(useSearch());
  const history = useHistoryPages(projectId, filter);
  const { queue } = useQueue(projectId);
  const mark = useMarkRead();
  const [done, setDone] = useState<Done>(null);
  const [failed, setFailed] = useState('');
  const run = (args: Mark, words: string, undo?: Mark) => {
    setFailed('');
    void mark(args)
      .then(reply => {
        const { previous } = JSON.parse(reply) as { previous: { through: number; read: number[] } };
        const back = undo ?? { projectId, restoreThrough: previous.through, read: previous.read };
        setDone({ words, undo: () => void mark(back).then(() => setDone(null)) });
      })
      .catch(() => setFailed('Could not change what is marked read. Nothing changed; try again.'));
  };
  const setFilter = (next: Partial<HistoryFilter>) => {
    const merged = { ...filter, ...next };
    const query = new URLSearchParams();
    if (merged.unread) query.set('unread', '1');
    if (merged.by) query.set('by', merged.by);
    if (merged.item) query.set('item', merged.item);
    if (merged.kind) query.set('kind', merged.kind);
    const text = query.toString();
    navigate(`${location.pathname}${text ? `?${text}` : ''}`);
  };
  return (
    <HistoryView
      project={route}
      trail={crumbsFor(route, projectName)}
      page={history.page}
      error={!!history.error}
      filter={filter}
      approvals={(queue?.entries ?? []).filter(entry => entry.hold?.kind === 'review').length}
      needsMe={hrefFor({ ...route, place: 'needs', section: '', rest: '' })}
      laneHref={laneId => hrefFor({ ...route, section: '', rest: laneId })}
      receiptHref={receiptId => hrefFor({ ...route, place: 'code', section: '', rest: receiptId })}
      onFilter={setFilter}
      onMark={read =>
        run({ projectId, read }, `Marked ${read.length.toLocaleString()} as read.`, {
          projectId,
          unread: read,
        })
      }
      onMarkAll={newest => run({ projectId, through: newest }, 'Marked everything as read.')}
      showEarlier={history.showEarlier}
      busy={history.busy}
      earlierFailed={history.earlierFailed}
      status={
        done ? (
          <div className="notice" data-st="passed">
            <p>{done.words}</p>
            <Key size="sm" onClick={done.undo}>
              Undo
            </Key>
          </div>
        ) : failed ? (
          <div className="notice" data-st="failed">
            <p>{failed}</p>
          </div>
        ) : null
      }
    />
  );
}

export type HistoryViewProps = {
  project?: WhoProject | undefined;
  trail: Parameters<typeof Head>[0]['trail'];
  page: LandedPage | undefined;
  error: boolean;
  filter: HistoryFilter;
  approvals: number;
  needsMe: string;
  laneHref: (laneId: string) => string;
  receiptHref: (receiptId: string) => string;
  onFilter: (next: Partial<HistoryFilter>) => void;
  onMark: (read: number[]) => void;
  onMarkAll: (newest: number) => void;
  showEarlier: () => void;
  busy: boolean;
  earlierFailed: boolean;
  status: ReactNode;
};

/** The screen from its read, with no reads of its own (tests render it). */
export function HistoryView(props: HistoryViewProps) {
  const { page, filter, onFilter } = props;
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const rows = page?.rows ?? [];
  const unread = rows.filter(row => !row.read).length;
  const empty = historyEmpty(page, filter);
  const flip = (set: typeof setSelected, sequence: number) =>
    set(was => {
      const next = new Set(was);
      if (next.has(sequence)) next.delete(sequence);
      else next.add(sequence);
      return next;
    });
  const markSelected = () => {
    if (!selected.size) return;
    props.onMark([...selected]);
    setSelected(new Set());
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if ((event.target as HTMLElement).closest('input, textarea, select')) return;
    if (event.key === 'e' && selected.size) {
      event.preventDefault();
      markSelected();
    } else if (event.key === 'Escape' && selected.size) setSelected(new Set());
  };
  // The choices are the people and agent runs, and the Items, in the rows read so far, plus the one chosen.
  const byChoices = [
    ...new Set(
      rows.flatMap(row => {
        const who = whoOf(row);
        if (!who || who.startsWith('/')) return [];
        const slash = who.indexOf('/');
        return slash < 0 ? [who] : [`@${who.slice(0, slash)}`, who];
      }),
    ),
  ];
  const byValue = (who: string) => (who.startsWith('@') ? who.slice(1) : who);
  if (filter.by && !byChoices.some(who => byValue(who) === filter.by))
    byChoices.push(filter.by.includes('/') ? filter.by : `@${filter.by}`);
  const items = new Map(rows.flatMap(row => (row.item ? [[row.item.id, row.item.title] as const] : [])));
  if (filter.item && !items.has(filter.item)) items.set(filter.item, 'The chosen Item');
  const lead = !page ? 'Loading what landed…' : unread ? `${unread.toLocaleString()} unread.` : null;
  return (
    <>
      <Head
        trail={props.trail}
        sentence={
          <>
            {lead ? <b>{lead}</b> : null} {page ? 'What landed, newest first.' : null}
            {props.approvals ? (
              <>
                {' '}
                <A className="lk lanes-inline" href={props.needsMe}>
                  {props.approvals.toLocaleString()} {props.approvals === 1 ? 'Lane waits' : 'Lanes wait'} for
                  your approval
                </A>{' '}
                in Needs me.
              </>
            ) : null}
          </>
        }
      >
        {unread && page?.newest !== null && page?.newest !== undefined ? (
          <Key size="sm" onClick={() => props.onMarkAll(page.newest!)}>
            Mark all as read
          </Key>
        ) : null}
      </Head>
      <div role="status" aria-live="polite" className="lanes-status">
        {props.status}
      </div>
      {props.error ? (
        <div className="notice" data-st="failed" role="alert">
          <p>What landed could not be read. Your agents and the queue are not affected.</p>
        </div>
      ) : null}
      <div onKeyDown={onKey}>
        <Region
          title="History"
          count={page ? rows.length : undefined}
          hint={page && page.next !== null ? 'newest first, more below' : 'newest first'}
        >
          <div className="tbar" role="search" aria-label="Filter History">
            <div className="seg" role="group" aria-label="Show">
              <button type="button" aria-pressed={!filter.unread} onClick={() => onFilter({ unread: false })}>
                All
              </button>
              <button type="button" aria-pressed={filter.unread} onClick={() => onFilter({ unread: true })}>
                Unread
              </button>
            </div>
            <label className="sr" htmlFor="history-by">
              Landed by
            </label>
            <select
              className={filter.by ? 'chip' : 'chip off'}
              id="history-by"
              value={filter.by ?? ''}
              onChange={event => onFilter({ by: event.target.value || null })}
            >
              <option value="">Anyone</option>
              {byChoices.map(who => (
                <option key={who} value={byValue(who)}>
                  {who}
                </option>
              ))}
            </select>
            <label className="sr" htmlFor="history-kind">
              Agents or people
            </label>
            <select
              className={filter.kind ? 'chip' : 'chip off'}
              id="history-kind"
              value={filter.kind ?? ''}
              onChange={event =>
                onFilter({
                  kind:
                    event.target.value === 'agent' || event.target.value === 'person'
                      ? event.target.value
                      : null,
                })
              }
            >
              <option value="">Agents and people</option>
              <option value="agent">Agents</option>
              <option value="person">People</option>
            </select>
            <label className="sr" htmlFor="history-item">
              Item
            </label>
            <select
              className={filter.item ? 'chip' : 'chip off'}
              id="history-item"
              value={filter.item ?? ''}
              onChange={event => onFilter({ item: event.target.value || null })}
            >
              <option value="">Any Item</option>
              {[...items].map(([id, title]) => (
                <option key={id} value={id}>
                  {title}
                </option>
              ))}
            </select>
          </div>
          {selected.size ? (
            <div className="bulk">
              <b>{selected.size.toLocaleString()} selected</b>
              <Key size="sm" keys="e" onClick={markSelected}>
                Mark as read
              </Key>
              <Key size="sm" kind="ghost" keys="Esc" onClick={() => setSelected(new Set())}>
                Clear
              </Key>
            </div>
          ) : null}
          {!page && !props.error ? (
            <div className="sk-rows" aria-busy="true" aria-label="Loading what landed">
              <div className="sk" />
              <div className="sk" />
              <div className="sk" />
            </div>
          ) : null}
          {groupByDay(rows, new Date().toDateString()).map(group => (
            <Group
              key={group.title}
              id={`lanes.history.${group.title}`}
              role="list"
              title={group.title}
              count={group.rows.length}
            >
              {group.rows.map(row => (
                <HistoryRow
                  key={row.receiptId}
                  row={row}
                  on={selected.has(row.sequence)}
                  toggle={() => flip(setSelected, row.sequence)}
                  open={open.has(row.sequence)}
                  project={props.project}
                  expand={() => flip(setOpen, row.sequence)}
                  laneHref={row.laneId ? props.laneHref(row.laneId) : null}
                  receiptHref={props.receiptHref(row.receiptId)}
                  onMark={props.onMark}
                />
              ))}
            </Group>
          ))}
          {empty ? (
            <Empty
              kind={empty}
              onClear={() => onFilter({ by: null, item: null, kind: null, unread: false })}
            />
          ) : null}
          {page && page.next !== null ? (
            <div className="pf">
              <button type="button" className="btn sm" onClick={props.showEarlier} disabled={props.busy}>
                {props.busy ? 'Showing earlier…' : 'Show earlier landings'}
              </button>
              {props.earlierFailed ? (
                <span role="alert"> Earlier landings could not be read; try again.</span>
              ) : null}
            </div>
          ) : null}
        </Region>
      </div>
    </>
  );
}

function Empty({
  kind,
  onClear,
}: {
  kind: NonNullable<ReturnType<typeof historyEmpty>>;
  onClear: () => void;
}) {
  if (kind === 'look-further')
    return (
      <p className="quietline">
        None in the newest landings looked at. Show earlier landings to look further.
      </p>
    );
  if (kind === 'no-match')
    return (
      <div className="empty">
        <h3>Nothing landed that matches</h3>
        <Key onClick={onClear}>Show everything</Key>
      </div>
    );
  if (kind === 'all-read') return <p className="quietline">You have read everything that landed.</p>;
  return (
    <div className="empty">
      <h3>Nothing has landed yet</h3>
      <p>A landing shows here the moment it reaches main.</p>
    </div>
  );
}

function HistoryRow({
  row,
  project,
  on,
  toggle,
  open,
  expand,
  laneHref,
  receiptHref,
  onMark,
}: {
  row: Landed;
  project?: WhoProject | undefined;
  on: boolean;
  toggle: () => void;
  open: boolean;
  expand: () => void;
  laneHref: string | null;
  receiptHref: string;
  onMark: (read: number[]) => void;
}) {
  const title = titleOf(row);
  const who = whoOf(row);
  const more = `landing-${row.sequence}`;
  return (
    <div role="listitem" className={`row hv${on ? ' sel' : ''}${row.read ? '' : ' unread'}`}>
      <label className="ckhit">
        <input
          type="checkbox"
          className="ckb"
          checked={on}
          onChange={toggle}
          aria-label={`Select ${title}`}
        />
      </label>
      <span className="any">
        <button
          type="button"
          className="ttl wrap2"
          dir="auto"
          aria-expanded={open}
          aria-controls={more}
          onClick={expand}
        >
          {row.read ? null : <span className="hv-dot" aria-hidden="true" />}
          {row.read ? null : <span className="sr">Unread: </span>}
          {title}
        </button>
        <span className="meta cut">
          <RecordedWho
            handle={who}
            agentAuthored={row.agent}
            model={modelOf(row)}
            project={project}
            layout="line"
          />
        </span>
      </span>
      <span className="num t2 when" title={new Date(row.at).toLocaleString()}>
        {time(row.at)}
      </span>
      {open ? (
        <div className="hv-more" id={more}>
          {row.message ? (
            <p className="t2" dir="auto">
              {row.message}
            </p>
          ) : null}
          <p className="t3">{row.automatic ? 'Landed by project policy.' : 'Accepted by a person.'}</p>
          <div className="btns">
            <A className="btn sm" href={receiptHref}>
              Receipt
            </A>
            {laneHref ? (
              <A className="btn sm" href={laneHref}>
                Its Lane
              </A>
            ) : null}
            {row.read ? null : (
              <Key size="sm" kind="ghost" onClick={() => onMark([row.sequence])}>
                Mark as read
              </Key>
            )}
          </div>
        </div>
      ) : (
        <span id={more} hidden />
      )}
    </div>
  );
}
