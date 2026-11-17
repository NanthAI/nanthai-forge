// SPDX-License-Identifier: Apache-2.0
// The plan as a board (Item e0a23825): the same rows as the list, one column per status. Order inside a column is
// the plan order (or the chosen sort); the board never drags, so the shared hand order changes only in the list.
import type { PlanRow } from '../../../../src/planning-model';
import { Who } from '../../ds';
import { A } from '../frames';
import type { PlaceProps } from '../screens';
import { statusOf } from './model';
import { sortRows, type Sort } from './query';
import { Tick, type Ticker } from './Tick';

const columns = [
  { status: 'proposed', title: 'Proposed' },
  { status: 'planned', title: 'Planned' },
  { status: 'in-progress', title: 'In progress' },
  { status: 'done', title: 'Done' },
  { status: 'abandoned', title: 'Won’t do' },
] as const;

export function Board({
  rows,
  sort,
  byId,
  at,
  ticker,
  settled,
}: {
  rows: readonly PlanRow[];
  sort: Sort;
  byId: ReadonlyMap<string, PlanRow>;
  at: (patch: Partial<PlaceProps['route']>) => string;
  ticker: Ticker | undefined;
  settled: boolean;
}) {
  const shown = columns.filter(
    column => settled || (column.status !== 'done' && column.status !== 'abandoned'),
  );
  const ordered = sortRows(
    rows.map(row => ({ row })),
    sort,
  );
  return (
    <div className="plan-board" role="list" aria-label="Items by status">
      {shown.map(column => {
        const cards = ordered.filter(({ row }) => statusOf(row) === column.status);
        return (
          <section key={column.status} className="plan-col" role="listitem" aria-label={column.title}>
            <h3 className="plan-col-h">
              {column.title} <span className="num t3">{cards.length.toLocaleString()}</span>
            </h3>
            {cards.map(({ row }) => (
              <div key={row.id} className="plan-card">
                {ticker ? <Tick row={row} ticker={ticker} /> : null}
                <A className="ttl" href={at({ rest: row.id })} dir="auto">
                  {row.title}
                </A>
                <span className="t3 cut">
                  {row.initiativeId ? (byId.get(row.initiativeId)?.title ?? 'Initiative') : 'No Initiative'}
                  {row.type ? `, ${row.type}` : ''}
                </span>
                {row.owner ? <Who handle={row.owner} /> : <span className="t3">no one yet</span>}
              </div>
            ))}
            {cards.length ? null : <div className="quietline">None</div>}
          </section>
        );
      })}
    </div>
  );
}
