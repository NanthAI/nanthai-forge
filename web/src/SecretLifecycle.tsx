import { ErrorToast } from './ui/Toast';
// SPDX-License-Identifier: Apache-2.0
import { DetailPanel } from './DetailPanel';
import { useRef, useState } from 'react';
import { useConvex, useQuery, usePaginatedQuery } from 'convex/react';
import { ConvexError } from 'convex/values';
import type { FunctionReturnType } from 'convex/server';
import type { Id } from '../../convex/_generated/dataModel';
import { api } from '../../convex/_generated/api';
import { hostedError } from './snapshot';

type Selection = {
  id: Id<'secretObjects'>;
  name: string | null;
  version: number;
  policyRevision: number;
  archiveRevision: number | null;
};
export async function secretObjectArchive(
  client: Pick<ReturnType<typeof useConvex>, 'query'>,
  id: Id<'secretObjects'>,
) {
  const info = await client.query(api.secretLifecycle.exportInfo, { id });
  const rows: Record<
    'versions' | 'grants' | 'events',
    Array<FunctionReturnType<typeof api.secretLifecycle.exportPage>['page'][number]>
  > = { versions: [], grants: [], events: [] };
  for (const part of ['versions', 'grants', 'events'] as const) {
    let cursor: string | null = null;
    for (;;) {
      const result: FunctionReturnType<typeof api.secretLifecycle.exportPage> = await client.query(
        api.secretLifecycle.exportPage,
        {
          id,
          ...info.pins,
          eventThrough: info.eventThrough,
          eventThroughId: info.eventThroughId,
          part,
          paginationOpts: { cursor, numItems: part === 'versions' ? 1 : 50 },
        },
      );
      rows[part].push(...result.page);
      if (result.isDone) break;
      cursor = result.continueCursor;
    }
  }
  // Complete pages keep the original value, grant, organization and audit boundaries.
  const current = await client.query(api.secretLifecycle.exportInfo, { id });
  if (
    JSON.stringify(current.pins) !== JSON.stringify(info.pins) ||
    current.eventThroughId !== info.eventThroughId
  )
    throw new ConvexError({
      code: 'SECRET_CHANGED',
      message: 'The Secret Object changed during export. Retry its new recorded state.',
    });
  return JSON.stringify({ ...info, ...rows, complete: true }, null, 2) + '\n';
}
export default function SecretLifecycle({ item, close }: { item: Selection; close: () => void }) {
  const client = useConvex(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [checksum, setChecksum] = useState('');
  const pending = useRef<{
    id: Id<'secretObjects'>;
    operationId: string;
    version: number;
    policyRevision: number;
    archiveRevision: number;
  } | null>(null);
  const [operation, setOperation] = useState<string | null>(null);
  const receipt = useQuery(
    api.secretLifecycle.deletion,
    operation ? { id: item.id, operationId: operation } : 'skip',
  );
  const download = async () => {
    setBusy(true);
    setError('');
    try {
      const text = await secretObjectArchive(client, item.id),
        bytes = new TextEncoder().encode(text);
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' })),
        anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `forge-secret-${item.id}.json`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setChecksum(digest);
    } catch (e) {
      setError(hostedError(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    setError('');
    try {
      if (!pending.current) {
        const current = await client.query(api.secrets.details, { id: item.id });
        pending.current = {
          id: item.id,
          operationId: crypto.randomUUID(),
          version: current.version,
          policyRevision: current.policyRevision,
          archiveRevision: current.archiveRevision ?? 0,
        };
      }
      const input = pending.current;
      setOperation(input.operationId);
      await client.mutation(api.secretLifecycle.permanentlyDelete, input);
    } catch (e) {
      if (e instanceof ConvexError && e.data?.code === 'SECRET_CHANGED') {
        pending.current = null;
        setOperation(null);
      }
      setError(hostedError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Secret Object export and deletion">
      <h3>{item.name ?? 'Secret Object'} · export and deletion</h3>
      <p>
        Encrypted export contains all credential versions, original key bindings, grants and audit
        observations. Retain the backend encryption keys separately to recover values offline. Exported grants
        are historical records.
      </p>
      <button disabled={busy || Boolean(receipt)} onClick={() => void download()}>
        Download encrypted object
      </button>
      {checksum && (
        <p role="status">
          Archive SHA-256 <code>{checksum}</code>
        </p>
      )}
      <p>
        Permanent deletion removes this object’s values, grants and audit records from this backend. A minimal
        owner deletion receipt remains for recovery. Existing downloads and provider backups remain with their
        holders.
      </p>
      <button disabled={busy || receipt?.status === 'deleted'} onClick={() => void remove()}>
        {receipt?.status === 'deleted'
          ? 'Deleted'
          : operation
            ? 'Reconcile deletion'
            : 'Permanently delete object'}
      </button>
      {receipt && (
        <p role="status">
          {receipt.status === 'deleted' ? 'Object deleted.' : 'Deletion is processing.'} Operation{' '}
          <code>{receipt.operationId}</code>
        </p>
      )}
      {error && <ErrorToast>{error}</ErrorToast>}
      <button disabled={busy} onClick={close}>
        Close
      </button>
    </section>
  );
}

export function SecretDeletions() {
  const client = useConvex(),
    { results, status, loadMore } = usePaginatedQuery(
      api.secretLifecycle.deletions,
      {},
      { initialNumItems: 20 },
    );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const resume = async (row: (typeof results)[number]) => {
    setBusy(true);
    setError('');
    try {
      await client.mutation(api.secretLifecycle.permanentlyDelete, {
        id: row.id,
        operationId: row.operationId,
        version: row.version,
        policyRevision: row.policyRevision,
        archiveRevision: row.archiveRevision,
      });
    } catch (e) {
      setError(hostedError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <DetailPanel title={<>Deletion receipts</>}>
      <p>These owner receipts preserve original operations after closing or restarting the browser.</p>
      <ul>
        {results.map(row => (
          <li key={row.id}>
            <code>{row.id}</code> · {row.status} · operation <code>{row.operationId}</code>
            {row.status === 'deleting' && (
              <button disabled={busy} onClick={() => void resume(row)}>
                Reconcile deletion
              </button>
            )}
          </li>
        ))}
      </ul>
      {status === 'CanLoadMore' && <button onClick={() => loadMore(20)}>Load more deletion receipts</button>}
      {error && <ErrorToast>{error}</ErrorToast>}
    </DetailPanel>
  );
}
