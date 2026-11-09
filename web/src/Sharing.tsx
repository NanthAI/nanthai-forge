// SPDX-License-Identifier: Apache-2.0
import { ErrorToast } from './ui/Toast';
import { useState } from 'react';
import { useConvex, usePaginatedQuery } from 'convex/react';
import type { Id } from '../../convex/_generated/dataModel';
import { api } from '../../convex/_generated/api';
import { hostedError } from './snapshot';
import { TeamSharing } from './Teams';

export default function Sharing({ id, inline = false }: { inline?: boolean; id: Id<'imports'> }) {
  const client = useConvex();
  const [expanded, setExpanded] = useState(inline),
    [reader, setReader] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [saved, setSaved] = useState('');
  const { results, status, loadMore } = usePaginatedQuery(api.sharing.readers, expanded ? { id } : 'skip', {
    initialNumItems: 20,
  });
  const change = async (target: string, add: boolean) => {
    setBusy(true);
    setError('');
    setSaved('');
    try {
      if (add) await client.action(api.sharingActions.add, { id, reader: target });
      else await client.mutation(api.sharing.remove, { id, reader: target });
      if (add) setReader('');
      setSaved(add ? 'Reader access saved.' : 'Reader access removed.');
    } catch (e) {
      setError(hostedError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="sharing-panel">
      {!inline && (
        <button
          aria-expanded={expanded}
          aria-controls={`sharing-${id}`}
          onClick={() => setExpanded(value => !value)}
        >
          Share with readers
        </button>
      )}
      {expanded && (
        <div id={`sharing-${id}`}>
          <p className="hosted-note">
            Share this included repository snapshot with an existing Forge user. Readers can explore and
            download when both of you retain GitHub repository access through the Forge App. You manage
            refresh and lifecycle. Removing access stops future service reads; downloaded copies remain.
          </p>
          <form
            onSubmit={e => {
              e.preventDefault();
              void change(reader.trim(), true);
            }}
          >
            <label>
              Forge user ID
              <input value={reader} onChange={e => setReader(e.target.value)} placeholder="user_…" required />
            </label>
            <button disabled={busy}>Add reader</button>
          </form>
          {status === 'LoadingFirstPage' ? (
            <p>Loading readers…</p>
          ) : results.length === 0 ? (
            <p>No named readers.</p>
          ) : (
            <ul className="reader-list">
              {results.map(row => (
                <li key={row.reader}>
                  <code>{row.reader}</code>
                  <button disabled={busy} onClick={() => void change(row.reader, false)}>
                    Remove reader
                  </button>
                </li>
              ))}
            </ul>
          )}
          {status === 'CanLoadMore' && <button onClick={() => loadMore(20)}>Load more readers</button>}
          <TeamSharing importId={id} />
          {saved && <p role="status">{saved}</p>}
          {error && <ErrorToast>{error}</ErrorToast>}
        </div>
      )}
    </div>
  );
}
