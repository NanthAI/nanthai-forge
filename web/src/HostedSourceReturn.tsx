import { countLabel } from './ui/count';
import { ErrorToast } from './ui/Toast';
// SPDX-License-Identifier: Apache-2.0
import { useState, type ReactNode } from 'react';
import { useConvex, usePaginatedQuery } from 'convex/react';
import type { FunctionArgs } from 'convex/server';
import type { Id } from '../../convex/_generated/dataModel';
import { api } from '../../convex/_generated/api';
import { hostedError } from './snapshot';

export default function HostedSourceReturn({
  projectId,
  backupId,
  revision,
  children,
}: {
  projectId: Id<'hostedProjects'>;
  backupId: Id<'projectBackups'>;
  revision: number;
  children?: ReactNode;
}) {
  const client = useConvex(),
    { results, status, loadMore } = usePaginatedQuery(
      api.projectBackups.history,
      { projectId },
      { initialNumItems: 10 },
    );
  const [selected, setSelected] = useState<Id<'projectBackups'> | ''>(''),
    [pending, setPending] = useState<FunctionArgs<typeof api.projectSourceReturn.returnSource> | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  async function submit() {
    if (!selected && !pending) return;
    const original = pending ?? {
      projectId,
      backupId: selected as Id<'projectBackups'>,
      expectedBackupId: backupId,
      revision,
      operationId: crypto.randomUUID(),
    };
    setPending(original);
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await client.action(api.projectSourceReturn.returnSource, original);
      setMessage('Returned source is now current. Previous source and Work remain in history.');
      setPending(null);
      setSelected('');
    } catch (e) {
      setError(hostedError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="fx-transfer-card" aria-label="Send local changes back">
      <h2>Send local changes back</h2>
      <p>Choose a checkpoint uploaded from your local Lane.</p>
      <div className="fx-transfer-return">
        <label>
          <span className="sr-only">Returned local checkpoint</span>
          <select
            aria-label="Returned local checkpoint"
            value={selected}
            disabled={busy || !!pending}
            onChange={e => {
              if (e.target.value === 'more') loadMore(10);
              else setSelected(e.target.value as Id<'projectBackups'>);
            }}
          >
            <option value="">Choose a stored checkpoint</option>
            {results
              .filter(item => item.status === 'stored' && item.id !== backupId)
              .map(item => (
                <option key={item.id} value={item.id}>
                  {new Date(item.at).toLocaleString()} · {countLabel(item.preview.lanes, 'Lane')} ·{' '}
                  {countLabel(item.preview.files, 'file')}
                </option>
              ))}
            {status === 'CanLoadMore' && <option value="more">Load more checkpoints…</option>}
            {status === 'LoadingMore' && <option disabled>Loading checkpoints…</option>}
          </select>
        </label>
        <button
          className="fx-btn fx-btn-primary"
          disabled={busy || (!selected && !pending)}
          onClick={() => void submit()}
        >
          {busy ? 'Returning…' : pending ? 'Retry original return' : 'Return to Forge'}
        </button>
      </div>
      {children}
      {pending && (
        <>
          <p>The return is not yet confirmed. Retry checks the original request.</p>
          <button disabled={busy} onClick={() => setPending(null)}>
            Start another return
          </button>
        </>
      )}
      {message && <p role="status">{message}</p>}
      {error && <ErrorToast>{error}</ErrorToast>}
    </section>
  );
}
