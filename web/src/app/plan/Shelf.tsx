// SPDX-License-Identifier: Apache-2.0
// Archive and Deleted (Item 4c9e961e, DESIGN.md rule 18): two places an Item can be sent and come back from. Archive
// hides it from every view and count and keeps its links with no time limit; Deleted hides it the same way. Each
// action, and each way back, is one ordinary put through the batch call, so it is retry-safe by operation id, adds
// one version, keeps the history and gets the same 10-second Undo as any batch. The server allows planning writes
// to the project owner only. The lists read one bounded page of 50 only while their view is open.
import { useState } from 'react';
import type { PlanRow, StoredStatus } from '../../../../src/planning-model';
import { itemStatusLabel, itemStatus } from '../../../../src/planning-model';
import type { BatchPut } from '../../../../src/planning-batch';
import { Band, Key } from '../../ds';
import { A } from '../frames';
import type { PlaceProps } from '../screens';
import type { RunBatch, BatchOutcome } from './batch';
import { COLS } from './rows';

export type Shelf = 'archived' | 'deleted';
export const shelfWords: Record<Shelf, { list: string; send: string; back: string; done: string }> = {
  archived: { list: 'Archive', send: 'Archive', back: 'Unarchive', done: 'Archived' },
  deleted: { list: 'Deleted', send: 'Delete', back: 'Restore', done: 'Deleted' },
};
export const isShelf = (status: string): status is Shelf => status === 'archived' || status === 'deleted';

/** Send rows to a shelf, each at the version the caller read. */
export const shelve = (rows: readonly Pick<PlanRow, 'id' | 'version'>[], to: Shelf): BatchPut[] =>
  rows.map(row => ({
    action: 'put-planning-item',
    itemId: row.id,
    expectedVersion: row.version ?? 0,
    status: to,
  }));

/** Bring a shelved row back to the status it left (`was`; Planned when an older row does not say). */
export const unshelve = (row: Pick<PlanRow, 'id' | 'version' | 'was'>): BatchPut => ({
  action: 'put-planning-item',
  itemId: row.id,
  expectedVersion: row.version ?? 0,
  status: (row.was ?? 'open') as Exclude<StoredStatus, Shelf>,
});

const day = (at: string | undefined) =>
  at ? new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';

/** The Archive or Deleted list, newest first, with the way back on each row when the reader may edit. */
export function ShelfList({
  shelf,
  rows,
  at,
  run,
  onDone,
}: {
  shelf: Shelf;
  rows: readonly PlanRow[];
  at: (patch: Partial<PlaceProps['route']>) => string;
  run: RunBatch | undefined;
  onDone: (outcome: BatchOutcome, extra: string) => void;
}) {
  const words = shelfWords[shelf];
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState('');
  const back = async (row: PlanRow) => {
    if (!run) return;
    setBusy(true);
    setFailed('');
    try {
      onDone(await run([unshelve(row)]), '');
    } catch {
      setFailed(`Forge could not bring back ${row.title}; nothing changed.`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grp plan-grp">
      <Band title={words.list} count={rows.length} hint="newest first" />
      {failed ? (
        <div className="pf" role="alert">
          {failed}
        </div>
      ) : null}
      {rows.length ? (
        <div role="list" aria-label={`${words.list} Items`}>
          {rows.map(row => (
            <div
              role="listitem"
              key={row.id}
              className="row"
              style={{ gridTemplateColumns: COLS.replace('2.2em ', '') }}
            >
              <span className="name">
                <A className="lk" href={at({ rest: row.id })} dir="auto">
                  {row.title}
                </A>
              </span>
              <span className="t3">
                {words.done.toLowerCase()} {day(row.at)}
                {row.was ? `, was ${itemStatusLabel[itemStatus[row.was]]}` : ''}
              </span>
              <span />
              {run ? (
                <Key size="sm" onClick={() => void back(row)} disabled={busy}>
                  {words.back}
                </Key>
              ) : (
                <span />
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="quietline">Nothing is {words.done.toLowerCase()}.</div>
      )}
    </div>
  );
}
