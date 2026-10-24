import { useInventory } from './useInventory';
import { ErrorToast } from './ui/Toast';
// SPDX-License-Identifier: Apache-2.0
import { DetailPanel } from './DetailPanel';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useConvex, usePaginatedQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import { api } from '../../convex/_generated/api';
import { hostedError } from './snapshot';
const address = (id: Id<'sourceZones'>, importId: Id<'imports'>) =>
  `?codescape=${importId}&zone=${id}&view=map`;

function ZoneItem({ zone }: { zone: Doc<'sourceZones'> }) {
  const client = useConvex(),
    [reader, setReader] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [saved, setSaved] = useState('');
  const { results, status, loadMore } = usePaginatedQuery(
    api.sourceZones.readers,
    { id: zone._id },
    { initialNumItems: 20 },
  );
  const pending = useRef<Parameters<typeof client.action<typeof api.zoneActions.change>>[1] | null>(null);
  const change = async (update: NonNullable<typeof pending.current>['update']) => {
    // Keep the original revision/UUID on an identical retry even if the live policy query has advanced.
    if (!pending.current || JSON.stringify(pending.current.update) !== JSON.stringify(update))
      pending.current = {
        id: zone._id,
        operationId: crypto.randomUUID(),
        expectedRevision: zone.revision,
        update,
      };
    setBusy(true);
    setError('');
    setSaved('');
    try {
      await client.action(api.zoneActions.change, pending.current);
      pending.current = null;
      setSaved('Zone policy saved.');
      if (update.kind === 'reader' && update.present) setReader('');
    } catch (e) {
      setError(hostedError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li>
      <div>
        <strong>{zone.name}</strong>
        <small>
          {zone.enabled ? 'Enabled' : 'Disabled'} · Policy revision {zone.revision}
        </small>
        <small>
          Pinned revision <code>{zone.gitHead}</code>
        </small>
        <small>Files: {zone.files.join(', ')}</small>
      </div>
      <div className="import-actions">
        <a href={address(zone._id, zone.importId)}>Explore source Zone</a>
        <button disabled={busy} onClick={() => void change({ kind: 'enabled', enabled: !zone.enabled })}>
          {zone.enabled ? 'Disable Zone' : 'Enable Zone'}
        </button>
      </div>
      <form
        onSubmit={event => {
          event.preventDefault();
          void change({ kind: 'reader', reader: reader.trim(), present: true });
        }}
      >
        <label>
          Zone reader Forge user ID
          <input
            required
            value={reader}
            onChange={event => setReader(event.target.value)}
            placeholder="user_…"
          />
        </label>
        <button disabled={busy}>Add Zone reader</button>
      </form>
      <ul className="reader-list">
        {results.map(row => (
          <li key={row.reader}>
            <code>{row.reader}</code>
            <button
              disabled={busy}
              onClick={() => void change({ kind: 'reader', reader: row.reader, present: false })}
            >
              Remove Zone reader
            </button>
          </li>
        ))}
      </ul>
      {status === 'CanLoadMore' && <button onClick={() => loadMore(20)}>Load more Zone readers</button>}
      {saved && <p role="status">{saved}</p>}
      {error && (
        <>
          <ErrorToast>{error}</ErrorToast>
          {pending.current && (
            <button disabled={busy} onClick={() => void change(pending.current!.update)}>
              Reconcile original Zone change
            </button>
          )}
          <button
            disabled={busy}
            onClick={() => {
              pending.current = null;
              setError('');
            }}
          >
            Use latest Zone policy revision
          </button>
        </>
      )}
    </li>
  );
}
function CreateZone({ importId }: { importId: Id<'imports'> }) {
  const client = useConvex(),
    [name, setName] = useState(''),
    [files, setFiles] = useState(''),
    [sourceId, setSourceId] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [created, setCreated] = useState<Id<'sourceZones'> | null>(null);
  const pending = useRef<Parameters<typeof client.action<typeof api.zoneActions.create>>[1] | null>(null);
  const load = async () => {
    setBusy(true);
    setError('');
    try {
      setSourceId(
        (
          JSON.parse(await client.action(api.hosted.read, { id: importId, endpoint: 'status' })) as {
            sourceId: string;
          }
        ).sourceId,
      );
    } catch (e) {
      setError(hostedError(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void load();
  }, [importId]); // Current snapshot is selected again only through the explicit button.
  const create = async () => {
    const input = {
      importId,
      name: name.trim(),
      sourceId,
      files: [...new Set(files.split(/\r?\n/).filter(Boolean))].sort(),
    };
    if (
      !pending.current ||
      JSON.stringify({ ...pending.current, operationId: undefined }) !== JSON.stringify(input)
    )
      pending.current = { ...input, operationId: crypto.randomUUID() };
    setBusy(true);
    setError('');
    try {
      setCreated(await client.action(api.zoneActions.create, pending.current));
      pending.current = null;
    } catch (e) {
      setError(hostedError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <p>
        Pinned source <code>{sourceId || 'Loading…'}</code>
      </p>
      <button disabled={busy} onClick={() => void load()}>
        Choose current Zone snapshot
      </button>
      <form
        onSubmit={event => {
          event.preventDefault();
          void create();
        }}
      >
        <label>
          Source Zone name
          <input required value={name} onChange={event => setName(event.target.value)} />
        </label>
        <label>
          Zone files (one included path per line)
          <textarea
            required
            value={files}
            onChange={event => setFiles(event.target.value)}
            placeholder="src/example.ts"
          />
        </label>
        <button disabled={busy || !sourceId}>{busy ? 'Creating…' : 'Create source Zone'}</button>
      </form>
      {created && (
        <p role="status">
          Source Zone ready. <a href={address(created, importId)}>Explore created Zone</a>
        </p>
      )}
      {error && <ErrorToast>{error}</ErrorToast>}
    </>
  );
}
export default function SourceZones({
  importId,
  canCreate,
}: {
  importId: Id<'imports'>;
  canCreate: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const { results, status, loadMore } = useInventory(
    api.sourceZones.list,
    'sourceZones',
    expanded ? { importId } : 'skip',
    20,
  );
  return (
    <DetailPanel className="save-view" onChange={isOpen => setExpanded(isOpen)} title={<>Source Zones</>}>
      <p className="hosted-note">
        Name selected source files at one retained revision. Named readers see only these files and their
        derived graph, while both people retain GitHub access. Repository documents are omitted. This does not
        restrict whole-import access, downloaded copies or tools outside Forge.
      </p>
      {expanded && canCreate && <CreateZone importId={importId} />}
      <ul className="import-list">
        {results.map(zone => (
          <ZoneItem key={zone._id} zone={zone} />
        ))}
      </ul>
      {status === 'CanLoadMore' && <button onClick={() => loadMore(20)}>Load more source Zones</button>}
    </DetailPanel>
  );
}
export function SharedZones() {
  const client = useConvex(),
    [result, setResult] = useState<FunctionReturnType<typeof api.zoneActions.shared> | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const load = useCallback(
    async (cursor: string | null = null) => {
      setBusy(true);
      setError('');
      try {
        const next = await client.action(api.zoneActions.shared, {
          paginationOpts: { cursor, numItems: 20 },
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
    <section className="private-imports" aria-label="Source Zones shared with you">
      <h2>Source Zones shared with you</h2>
      <button disabled={busy} onClick={() => void load()}>
        Refresh shared Zones
      </button>
      <ul className="import-list">
        {result?.page.map(zone => (
          <li key={zone.id}>
            <strong>{zone.name}</strong>
            <small>
              {zone.repository} · {zone.head.slice(0, 12)}
            </small>
            <a href={address(zone.id, zone.importId)}>Explore shared Zone</a>
          </li>
        ))}
      </ul>
      {result?.page.length === 0 && <p>No source Zones available.</p>}
      {result && !result.isDone && (
        <button disabled={busy} onClick={() => void load(result.continueCursor)}>
          Load more shared Zones
        </button>
      )}
      {error && <ErrorToast>{error}</ErrorToast>}
    </section>
  );
}
