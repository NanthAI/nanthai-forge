import { ErrorToast } from './ui/Toast';
// SPDX-License-Identifier: Apache-2.0
import { DetailPanel } from './DetailPanel';
import { useCallback, useEffect, useState } from 'react';
import { useConvex, usePaginatedQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
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

export function SharedImports({ open }: { open: (id: Id<'imports'>) => void }) {
  const client = useConvex();
  const [result, setResult] = useState<FunctionReturnType<typeof api.sharingActions.list> | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const load = useCallback(
    async (cursor: string | null = null) => {
      setBusy(true);
      setError('');
      try {
        const next = await client.action(api.sharingActions.list, {
          paginationOpts: { numItems: 20, cursor },
        });
        setResult(previous => ({
          ...next,
          page:
            cursor && previous
              ? [...new Map([...previous.page, ...next.page].map(row => [row.id, row])).values()]
              : next.page,
        }));
      } catch (e) {
        setError(hostedError(e));
      } finally {
        setBusy(false);
      }
    },
    [client],
  );
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <section className="private-imports" aria-label="Shared with you">
      <div className="section-heading">
        <h2>Shared with you</h2>
        <button
          aria-label="Refresh shared list"
          title="Refresh shared list"
          disabled={busy}
          onClick={() => void load()}
        >
          ↻
        </button>
      </div>
      <DetailPanel className="collection-guide" title={<>About shared access</>}>
        <p className="hosted-note">
          Private snapshots shared with your Forge user ID. This list shows imports you and the importer can
          currently access through GitHub. Source access is checked on every read.
        </p>
      </DetailPanel>
      {busy && <p role="status">Checking shared access…</p>}
      {!result && !error ? (
        <p>Loading shared imports…</p>
      ) : result?.page.length === 0 ? (
        <p>No shared imports available.</p>
      ) : (
        <ul className="import-list">
          {result?.page.map(job => (
            <li key={job.id}>
              <div>
                <strong>{job.repository}</strong>
                <small>
                  {job.ref} · {job.phase}
                </small>
              </div>
              <button onClick={() => open(job.id)}>Explore shared snapshot</button>
            </li>
          ))}
        </ul>
      )}
      {result && !result.isDone && (
        <button disabled={busy} onClick={() => void load(result.continueCursor)}>
          Load more shared imports
        </button>
      )}
      {error && <ErrorToast>{error}</ErrorToast>}
    </section>
  );
}
