// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Archive and Deleted (Item 4c9e961e, DESIGN.md rule 18): two places an Item can be sent and come back from. Archive
// hides it from every view and count and keeps its links with no time limit; Deleted hides it the same way. Each
// action, and each way back, is one ordinary put through the batch call, so it is retry-safe by operation id, adds
// one version, keeps the history and gets the same 10-second Undo as any batch. The server allows planning writes
// to the project owner only. The lists read one bounded page of 50 only while their view is open; a shelved Item's
// own page reads its root (Plan.tsx useShelvedRow; re-run only by writes to it) to offer its way back.
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

/** One Item's current root (the work-index detail value) as a row, when it is Archived or Deleted; else null. */
export function shelvedRowOf(value: string | null, id: string): PlanRow | null {
  try {
    const item = value ? (JSON.parse(value) as Partial<PlanRow>) : null;
    if (!item || typeof item.id !== 'string' || !item.id.startsWith(id) || !isShelf(item.status ?? ''))
      return null;
    return {
      id: item.id,
      kind: item.kind === 'initiative' ? 'initiative' : 'issue',
      title: typeof item.title === 'string' && item.title ? item.title : id.slice(0, 8),
      status: item.status as Shelf,
      position: 0,
      ...(typeof item.version === 'number' ? { version: item.version } : {}),
      ...(item.was ? { was: item.was } : {}),
      ...(typeof item.at === 'string' ? { at: item.at } : {}),
    };
  } catch {
    return null;
  }
}

const day = (at: string | undefined) =>
  at ? new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';

/** The Archive or Deleted list, newest first, with the way back on each row when the reader may edit. */
export function ShelfList({
  shelf,
  rows,
  at,
  run,
  onPurge,
  onDone,
}: {
  shelf: Shelf;
  rows: readonly PlanRow[];
  at: (patch: Partial<PlaceProps['route']>) => string;
  run: RunBatch | undefined;
  onPurge?: ((row: PlanRow) => void) | undefined;
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
              <span className="t3">
                {shelf === 'deleted' && row.purgeAt !== undefined ? (
                  <time dateTime={new Date(row.purgeAt).toISOString()}>
                    Purges from{' '}
                    {new Date(row.purgeAt).toLocaleDateString(undefined, {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                      timeZone: 'UTC',
                    })}
                  </time>
                ) : null}
              </span>
              <span>
                {run ? (
                  <Key size="sm" onClick={() => void back(row)} disabled={busy}>
                    {words.back}
                  </Key>
                ) : null}
                {onPurge && row.version !== undefined ? (
                  <Key size="sm" kind="danger" onClick={() => onPurge(row)} disabled={busy}>
                    Delete forever
                  </Key>
                ) : null}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="quietline">Nothing is {words.done.toLowerCase()}.</div>
      )}
    </div>
  );
}
