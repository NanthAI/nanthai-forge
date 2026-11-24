// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The plan as a board (Items e0a23825, d3357f40; design cecab403, decision f4e28113): the system board, lists side
// by side that meet at seams, each Item a row (DESIGN.md rule 5). Bands of the chosen group run across the columns and
// fold (fold.ts, this browser only). The same rows as the list, from the same read: order inside a cell is the plan
// order or the chosen sort, the board never reorders, and each column's total is the rows it draws. A sub-item whose
// parent is on the board shows in its parent's roll. A cell shows 20 rows, then 20 more at a time.
import { useMemo, useRef, useState, type CSSProperties } from 'react';
import type { PlanRow } from '../../../../src/planning-model';
import { Key, State, Who } from '../../ds';
import { initiativeBreakdown, type Breakdown } from '../progress';
import type { ItemLane } from './lane-words';
import { A } from '../frames';
import type { PlaceProps } from '../screens';
import { boardColumns, columnTotals, subItems, type BoardColumn, type PlanBand } from './bands';
import { isShut, type Folds } from './fold';
import { groupBreakdown, statusOf, type PlanLine } from './model';
import { sortRows, type Sort } from './query';
import { COLS, DoneWhen, Line, Owner, Roll } from './rows';
import { Tick, type Ticker } from './Tick';
import type { Workers } from './workers';

type At = (patch: Partial<PlaceProps['route']>) => string;
/** Rows a cell shows before "Show 20 more". */
export const CELL_ROWS = 20;

const Ring = ({ dotted = false }: { dotted?: boolean }) => (
  <svg
    width="13"
    height="13"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeDasharray={dotted ? '2 2.6' : undefined}
    aria-hidden="true"
  >
    <circle cx="8" cy="8" r="5" />
  </svg>
);

const plus = (atLeast: boolean) => (atLeast ? '+' : '');
const count = (n: number, atLeast = false) => `${n.toLocaleString()}${plus(atLeast)}`;

/** A band's roll as the board mock draws it (02-plan-board): done, then in progress, then the rest as plain ticks;
 * dropped Items are not drawn, as "x of y done" does not count them. The list's header keeps the full breakdown. */
function boardRoll(breakdown: Breakdown): Breakdown {
  const part = (key: string) => breakdown.parts.find(p => p.key === key);
  const rest = breakdown.parts.filter(p => p.key === 'open' || p.key === 'proposed');
  const parts = [part('done'), part('inProgress')].filter(p => p !== undefined);
  const left = rest.reduce((sum, p) => sum + p.n, 0);
  parts.push({ key: 'open', word: 'left', tick: 'open', n: left, atLeast: rest.some(p => p.atLeast) });
  const total = parts.reduce((sum, p) => sum + p.n, 0);
  return { total, atLeast: breakdown.atLeast, parts };
}

/** A band's roll and its words. An Initiative band uses the whole plan's counts (the list's header does too); any
 * other band counts its own rows, and says how many done only when done Items were read. */
function bandSummary(band: PlanBand, settledRead: boolean, liveAtLeast: boolean) {
  if (band.group?.initiative) {
    const breakdown = groupBreakdown(band.group);
    const total = breakdown.total - band.group.dropped;
    return {
      breakdown: boardRoll(breakdown),
      words: total
        ? `${count(band.group.done, band.group.atLeast)} of ${count(total, breakdown.atLeast)} done`
        : 'Nothing in it yet',
    };
  }
  const n = { done: 0, inProgress: 0, open: 0, proposed: 0, removed: 0 };
  for (const { row } of band.lines) {
    const status = statusOf(row);
    if (status === 'done') n.done++;
    else if (status === 'in-progress') n.inProgress++;
    else if (status === 'planned') n.open++;
    else if (status === 'proposed') n.proposed++;
  }
  const breakdown: Breakdown = initiativeBreakdown({ ...n, atLeast: false, liveAtLeast });
  const live = n.inProgress + n.open + n.proposed;
  return {
    breakdown: boardRoll(breakdown),
    words: !breakdown.total
      ? 'Nothing in it yet'
      : settledRead
        ? `${count(n.done)} of ${count(n.done + live, liveAtLeast)} done`
        : `${count(live, liveAtLeast)} ${live === 1 && !liveAtLeast ? 'Item' : 'Items'}`,
  };
}

/** A band's head: its name (an Initiative links to its page), the roll, the count that is never cut, the fold. The
 * whole band folds on a click; its link and key keep their own. */
function BandHead({
  band,
  at,
  shut,
  controls,
  onToggle,
  settledRead,
  liveAtLeast,
}: {
  band: PlanBand;
  at: At;
  shut: boolean;
  controls: string;
  onToggle: () => void;
  settledRead: boolean;
  liveAtLeast: boolean;
}) {
  const { breakdown, words } = bandSummary(band, settledRead, liveAtLeast);
  return (
    <div
      className="band plan-band"
      onClick={event => {
        if (!(event.target as HTMLElement).closest('a, button')) onToggle();
      }}
    >
      {band.group?.initiative ? (
        <A className="ttl" href={at({ rest: band.group.initiative.id })} dir="auto" title={band.title}>
          {band.title}
        </A>
      ) : band.field === 'owner' && !band.rest ? (
        <Who handle={band.title} whole />
      ) : (
        <span className="ttl" dir="auto" title={band.title}>
          {band.title}
        </span>
      )}
      {breakdown.total ? <Roll breakdown={breakdown} /> : null}
      <span className="hint">{words}</span>
      <button
        type="button"
        className="tw"
        aria-expanded={!shut}
        aria-controls={controls}
        aria-label={`Items of ${band.title}`}
        onClick={onToggle}
      />
    </div>
  );
}

/** One board row: the title (two lines at most), then its state and flags, then sub-items, done-when and owner. */
function BoardRow({
  line,
  at,
  workers,
  subs,
  settledRead,
  ticker,
  lane,
}: {
  line: PlanLine;
  at: At;
  /** Its Lane's state, when a read the page holds names it (lane-words.ts). */
  lane: ItemLane | undefined;
  workers: Workers | undefined;
  subs: { total: number; done: number; running: number } | undefined;
  settledRead: boolean;
  ticker: Ticker | undefined;
}) {
  const { row } = line;
  const status = statusOf(row);
  const settled = status === 'done' || status === 'abandoned';
  return (
    <div className={`row brow${ticker ? ' tk' : ''}`} role="listitem">
      {ticker ? <Tick row={row} ticker={ticker} /> : null}
      <span className="ttl">
        <A href={at({ rest: row.id })} dir="auto" title={row.title}>
          {row.title}
        </A>
      </span>
      <span className="plan-facts">
        {status === 'done' ? (
          <State word="Done" />
        ) : status === 'abandoned' ? (
          <State word="Abandoned" />
        ) : null}
        {settled ? null : lane ? (
          <>
            <State word={lane.glyph} state={lane.kind}>
              {lane.word}
            </State>
            {lane.why ? <span className={`flag${lane.you ? ' hold' : ''}`}>{lane.why}</span> : null}
          </>
        ) : row.inLane ? (
          <span className="flag">in Lane</span>
        ) : null}
        {line.next ? (
          <span
            className="nextmark"
            title="The first planned Item with no owner, no Lane and nothing blocking it"
          >
            next
          </span>
        ) : null}
        {line.blockedBy ? (
          <span className="flag cut" dir="auto" title={`Cannot start until ${line.blockedBy.title} is done`}>
            blocked by {line.blockedBy.title}
          </span>
        ) : null}
        {line.shelvedInitiative ? <span className="flag">Initiative archived or deleted</span> : null}
        {row.type ? <span className="flag">{row.type}</span> : null}
        {row.hidden ? <span className="flag">hidden</span> : null}
      </span>
      <span className="plan-facts">
        {subs ? <SubRoll subs={subs} settledRead={settledRead} /> : null}
        <DoneWhen counts={row.doneWhen} />
        <Owner
          owner={row.owner}
          workers={settled ? undefined : workers ? (workers.get(row.id) ?? []) : undefined}
          whole
        />
      </span>
    </div>
  );
}

/** A parent's sub-items as a small roll and words. Done sub-items are known only when done Items were read. */
function SubRoll({
  subs,
  settledRead,
}: {
  subs: { total: number; done: number; running: number };
  settledRead: boolean;
}) {
  const live = subs.total - subs.done;
  const total = settledRead ? subs.total : live;
  const words = settledRead
    ? `${total.toLocaleString()} ${total === 1 ? 'sub-item' : 'sub-items'}, ${subs.done.toLocaleString()} done`
    : `${live.toLocaleString()} open ${live === 1 ? 'sub-item' : 'sub-items'}`;
  return (
    <span className="subroll" title={words}>
      {total <= 12 ? (
        <span className="roll" aria-hidden="true">
          {Array.from({ length: total }, (_, index) => (
            <i
              key={index}
              className={
                settledRead && index < subs.done
                  ? 'ok'
                  : index < (settledRead ? subs.done : 0) + subs.running
                    ? 'run'
                    : undefined
              }
            />
          ))}
        </span>
      ) : null}
      <span>{words}</span>
    </span>
  );
}

function ColumnHead({ column, total, atLeast }: { column: BoardColumn; total: number; atLeast: boolean }) {
  return (
    <div title={column.about || undefined}>
      {column.status === 'proposed' ? <Ring dotted /> : column.status === 'planned' ? <Ring /> : null}
      {column.title} <span className="cnt">{count(total, atLeast)}</span>
      {column.hint ? <span className="hint">{column.hint}</span> : null}
    </div>
  );
}

export function Board({
  bands,
  sort,
  at,
  folds,
  onToggle,
  settled,
  liveAtLeast,
  settledAtLeast,
  workers,
  loaded,
  ticker,
  lanes,
}: {
  /** Each working Item's Lane state, from reads the page already holds (lane-words.ts). */
  lanes?: ReadonlyMap<string, ItemLane> | undefined;
  /** Board bands (bands.ts boardBands): sub-items already rolled into their parents. */
  bands: readonly PlanBand[];
  sort: Sort;
  at: At;
  folds: Folds;
  onToggle: (id: string) => void;
  /** Done and Won't do columns are shown (the scope reads settled Items). */
  settled: boolean;
  /** Some open Items were not read: open column totals are lower bounds. */
  liveAtLeast: boolean;
  /** More done or dropped Items can be read: those totals are lower bounds. */
  settledAtLeast: { done: boolean; abandoned: boolean };
  /** Who works on each unowned Item now (workers.ts). */
  workers?: Workers | undefined;
  /** Every loaded row, for each parent's sub-items. */
  loaded: ReadonlyMap<string, PlanRow>;
  /** Bulk select, when the reader may edit (the same picks as the list). */
  ticker?: Ticker | undefined;
}) {
  const [extra, setExtra] = useState<ReadonlyMap<string, number>>(new Map());
  const wrap = useRef<HTMLDivElement>(null);
  // "Show 20 more" leaves when the cell is all shown: focus moves to the first row it revealed, never to the page.
  const showMore = (key: string, cell: string, from: number) => {
    setExtra(previous => new Map(previous).set(key, (previous.get(key) ?? 0) + CELL_ROWS));
    requestAnimationFrame(() =>
      wrap.current
        ?.querySelector<HTMLElement>(`[id="${cell}"] > [role="listitem"]:nth-child(${from + 1}) .ttl a`)
        ?.focus(),
    );
  };
  const columns = boardColumns.filter(
    column => settled || (column.status !== 'done' && column.status !== 'abandoned'),
  );
  const totals = columnTotals(bands);
  const subs = useMemo(() => subItems(loaded.values()), [loaded]);
  const atLeast = (status: BoardColumn['status']) =>
    status === 'done' ? settledAtLeast.done : status === 'abandoned' ? settledAtLeast.abandoned : liveAtLeast;
  const grid = { '--cols': columns.length } as CSSProperties;
  const flat = bands.length === 1 && bands[0]!.field === 'none';
  return (
    <div className="bwrap plan-bwrap" role="region" aria-label="Items by status" tabIndex={0} ref={wrap}>
      <div className="bgrid heads" style={grid}>
        {columns.map(column => (
          <ColumnHead
            key={column.status}
            column={column}
            total={totals.get(column.status) ?? 0}
            atLeast={atLeast(column.status)}
          />
        ))}
      </div>
      {bands.map((band, bandIndex) => {
        const shut = !flat && isShut(folds, band.id);
        const body = `plan-b-${bandIndex}`;
        const ordered = sortRows(band.lines, sort);
        return (
          <section key={band.id} className={`bgroup${shut ? ' shut' : ''}`} aria-label={band.title}>
            {flat ? null : (
              <BandHead
                band={band}
                at={at}
                shut={shut}
                controls={body}
                onToggle={() => onToggle(band.id)}
                settledRead={settled}
                liveAtLeast={liveAtLeast}
              />
            )}
            {shut ? (
              <div id={body} hidden />
            ) : (
              <div className="bgrid" style={grid} id={body}>
                {columns.map((column, columnIndex) => {
                  const rows = ordered.filter(line => statusOf(line.row) === column.status);
                  const key = `${band.id}\n${column.status}`;
                  const more = extra.get(key) ?? 0;
                  const limit = CELL_ROWS + more;
                  const label = `${column.title}${flat ? '' : `, ${band.title}`}`;
                  const cell = `${body}-${columnIndex}`;
                  return (
                    <div key={column.status}>
                      {rows.length ? (
                        <>
                          <div className="bcol-label" aria-hidden="true">
                            {column.title} <span className="cnt">{rows.length.toLocaleString()}</span>
                          </div>
                          <div role="list" aria-label={label} id={cell}>
                            {rows.slice(0, limit).map(line => (
                              <BoardRow
                                key={line.row.id}
                                line={line}
                                at={at}
                                workers={workers}
                                lane={lanes?.get(line.row.id)}
                                subs={subs.get(line.row.id)}
                                settledRead={settled}
                                ticker={ticker}
                              />
                            ))}
                          </div>
                        </>
                      ) : null}
                      {rows.length > limit ? (
                        <div className="pager">
                          <span className="n">
                            {limit.toLocaleString()} of {rows.length.toLocaleString()} shown
                          </span>
                          <Key
                            size="sm"
                            aria-label={`Show 20 more of ${label}`}
                            onClick={() => showMore(key, cell, limit)}
                          >
                            Show 20 more
                          </Key>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

/** While the first read is on its way: the column heads at once, still bars after 300 ms. */
export function BoardLoading({ settled }: { settled: boolean }) {
  const columns = boardColumns.filter(
    column => settled || (column.status !== 'done' && column.status !== 'abandoned'),
  );
  const grid = { '--cols': columns.length } as CSSProperties;
  return (
    <div className="bwrap plan-bwrap" aria-busy="true">
      <div className="bgrid heads" style={grid}>
        {columns.map(column => (
          <div key={column.status}>
            {column.status === 'proposed' ? <Ring dotted /> : column.status === 'planned' ? <Ring /> : null}
            {column.title}
          </div>
        ))}
      </div>
      <div className="bgrid plan-bload" style={grid}>
        {columns.map((column, index) => (
          <div key={column.status} className="skrows">
            {Array.from({ length: 2 + (index % 2) }, (_, row) => (
              <div key={row} className="skrow">
                <div className="sk" />
                <div
                  className="sk"
                  style={{ '--w': 44 + ((index * 3 + row * 7) % 5) * 6 } as CSSProperties}
                />
              </div>
            ))}
          </div>
        ))}
      </div>
      <span className="sr">Loading the plan…</span>
    </div>
  );
}

/** The list grouped by owner, type or nothing: the same bands as the board, each folding, rows in plan order (or the
 * chosen sort). Hand order is kept within Initiatives, so these rows do not drag; the list by Initiative does. */
export function FieldList({
  bands,
  sort,
  at,
  ticker,
  folds,
  onToggle,
  workers,
  tree,
  liveAtLeast,
  settledRead,
  view,
}: {
  bands: readonly PlanBand[];
  view?: Parameters<typeof Line>[0]['view'];
  sort: Sort;
  at: At;
  ticker: Ticker | undefined;
  folds: Folds;
  onToggle: (id: string) => void;
  workers?: Workers | undefined;
  tree: boolean;
  liveAtLeast: boolean;
  settledRead: boolean;
}) {
  const flat = bands.length === 1 && bands[0]!.field === 'none';
  return (
    <>
      {bands.map((band, bandIndex) => {
        const shut = !flat && isShut(folds, band.id);
        const body = `plan-g-${bandIndex}`;
        return (
          <div key={band.id} className={`grp plan-grp${shut ? ' shut' : ''}`} data-fold="">
            {flat ? null : (
              <BandHead
                band={band}
                at={at}
                shut={shut}
                controls={body}
                onToggle={() => onToggle(band.id)}
                settledRead={settledRead}
                liveAtLeast={liveAtLeast}
              />
            )}
            {shut ? (
              <div id={body} hidden />
            ) : (
              <div id={body} role="list" aria-label={flat ? 'Items' : `${band.title}, Items`}>
                {sortRows(band.lines, sort).map(line => (
                  <div
                    role="listitem"
                    key={line.row.id}
                    className="row"
                    style={{ gridTemplateColumns: `${ticker ? '28px ' : ''}${COLS}` }}
                  >
                    {ticker ? <Tick row={line.row} ticker={ticker} /> : null}
                    <Line
                      line={line}
                      href={at({ rest: line.row.id })}
                      ranked={false}
                      flat={!tree}
                      workers={workers}
                      view={view}
                      itemHref={id => at({ rest: id })}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
