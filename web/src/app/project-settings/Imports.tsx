// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Settings > Project > Imported repositories (Item 966cb821): the analyses the person imported, each with Remove. Ported
// from the old screen's ImportRemoveAction with the same call (importRemoval.remove). One page of 20 per open (a
// one-off read); a removal is one retry-safe mutation, so its operation id is kept until it succeeds.
import { useCallback, useRef, useState } from 'react';
import { useConvex } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import { Key, Region, Row, Sheet } from '../../ds';
import { hostedError } from '../../snapshot';

export type Imported = FunctionReturnType<typeof api.importRemoval.listMine>['page'][number];
const PAGE = 20;

export default function Imports() {
  const client = useConvex();
  const [rows, setRows] = useState<readonly Imported[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const read = useCallback(
    (from: string | null) => {
      void client
        .query(api.importRemoval.listMine, { paginationOpts: { cursor: from, numItems: PAGE } })
        .then(result => {
          setRows(was => [...(from && was ? was : []), ...result.page]);
          setCursor(result.isDone ? null : result.continueCursor);
          setFailed(false);
        })
        .catch(() => setFailed(true));
    },
    [client],
  );
  // Read on a press, not on open: the page's own reads stay at the project and its backups.
  const [opened, setOpened] = useState(false);
  const operation = useRef(new Map<string, string>());
  const remove = async (row: Imported) => {
    const operationId = operation.current.get(row.id) ?? crypto.randomUUID();
    operation.current.set(row.id, operationId);
    await client.mutation(api.importRemoval.remove, { importId: row.id as Id<'imports'>, operationId });
    operation.current.delete(row.id);
    setRows(was => (was ?? []).filter(item => item.id !== row.id));
  };
  if (!opened)
    return (
      <Region title="Imported repositories" weight="ref" hint="analyses you imported">
        <Row cols="minmax(0, 1fr) auto">
          <span className="meta">Repositories you imported for analysis, with a way to remove each one.</span>
          <Key
            size="sm"
            onClick={() => {
              setOpened(true);
              read(null);
            }}
          >
            Show my imports
          </Key>
        </Row>
      </Region>
    );
  return (
    <ImportsView
      rows={rows}
      failed={failed}
      more={!!cursor}
      showMore={() => cursor && read(cursor)}
      retry={() => read(null)}
      remove={remove}
    />
  );
}

export function ImportsView({
  rows,
  failed,
  more,
  showMore,
  retry,
  remove,
}: {
  rows: readonly Imported[] | null;
  failed: boolean;
  more: boolean;
  showMore: () => void;
  retry: () => void;
  remove: (row: Imported) => Promise<void>;
}) {
  const [asking, setAsking] = useState<Imported | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const go = async () => {
    if (!asking) return;
    setPending(true);
    setError('');
    try {
      await remove(asking);
      setAsking(null);
    } catch (failure) {
      setError(hostedError(failure));
    } finally {
      setPending(false);
    }
  };
  return (
    <Region title="Imported repositories" weight="ref" count={rows?.length ?? 0} hint="analyses you imported">
      {failed ? (
        <div className="notice" data-st="failed" role="status">
          <p>Your imports could not be read just now. Nothing was removed.</p>
          <Key size="sm" onClick={retry}>
            Retry
          </Key>
        </div>
      ) : null}
      {rows && !rows.length ? <p className="quietline">You have not imported a repository.</p> : null}
      {rows?.map(row => (
        <Row key={row.id} cols="minmax(0, 1fr) auto" className="backup">
          <span className="nm">
            <span className="ttl mono" translate="no">
              {row.repository}
            </span>
            <span className="meta">
              {row.ref} · imported{' '}
              {new Date(row.createdAt).toLocaleDateString('en-GB', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              })}
            </span>
          </span>
          <Key size="sm" kind="danger" aria-label={`Remove ${row.repository}`} onClick={() => setAsking(row)}>
            Remove
          </Key>
        </Row>
      ))}
      {more ? (
        <div className="quietline proj-more">
          <span>{rows?.length.toLocaleString()} shown; there are more.</span>
          <Key size="sm" onClick={showMore}>
            Show {PAGE} more
          </Key>
        </div>
      ) : null}
      {asking ? (
        <Sheet
          open
          title="Remove an import"
          onOpenChange={open => {
            if (!open && !pending) setAsking(null);
          }}
          footer={
            <>
              <Key kind="ghost" keys="Esc" disabled={pending} onClick={() => setAsking(null)}>
                Keep it
              </Key>
              <Key kind="danger" disabled={pending} onClick={() => void go()}>
                {pending ? 'Removing…' : error ? 'Retry removal' : 'Remove analysis'}
              </Key>
            </>
          }
        >
          <div className="trash-sheet">
            <h3 dir="auto" translate="no">
              Remove {asking.repository}?
            </h3>
            <p>
              <strong>This removes the analysis for everyone it is shared with.</strong> The GitHub repository
              is untouched. The analysis and its saved views cannot be restored.
            </p>
            {error ? (
              <p className="pf" role="alert">
                {error}
              </p>
            ) : null}
          </div>
        </Sheet>
      ) : null}
    </Region>
  );
}
