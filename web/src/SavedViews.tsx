import { useInventory } from './useInventory';
import { ErrorToast } from './ui/Toast';
// SPDX-License-Identifier: Apache-2.0
import { DetailPanel } from './DetailPanel';
import { useRef, useState } from 'react';
import { SignInButton, useUser } from '@clerk/react';
import { useConvex } from 'convex/react';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import type { Route } from './api';
import { hostedError } from './snapshot';

type SavedRoute = Omit<Route, 'view'> & { view: 'home' | 'readme' | 'map' | 'source' };
type Saved = { id: Id<'savedViews'>; importId: Id<'imports'>; name: string; route: SavedRoute };
function SaveForm({ id, route }: { id: Id<'imports'>; route: SavedRoute }) {
  const client = useConvex(),
    [name, setName] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [saved, setSaved] = useState('');
  const signature = JSON.stringify({ id, route });
  const pending = useRef<{
    operationId: string;
    importId: Id<'imports'>;
    name: string;
    route: SavedRoute;
  } | null>(null);
  const save = async () => {
    const input = { importId: id, name: name.trim(), route };
    if (
      !pending.current ||
      JSON.stringify({ ...pending.current, operationId: undefined }) !== JSON.stringify(input)
    )
      pending.current = { ...input, operationId: crypto.randomUUID() };
    setBusy(true);
    setError('');
    setSaved('');
    try {
      await client.action(api.savedViewActions.save, pending.current);
      pending.current = null;
      setName('');
      setSaved(signature);
    } catch (e) {
      setError(hostedError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <DetailPanel className="save-view" title={<>Star this location</>}>
      <form
        onSubmit={event => {
          event.preventDefault();
          void save();
        }}
      >
        <label>
          Star name
          <input
            required
            value={name}
            onChange={event => {
              setName(event.target.value);
              setSaved('');
            }}
          />
        </label>
        <button disabled={busy || !name.trim()}>{busy ? 'Saving…' : 'Star location'}</button>
      </form>
      {saved === signature && <p role="status">Star saved. Find it under Starred on Projects.</p>}
      {error && <ErrorToast>{error}</ErrorToast>}
      <small>
        This private link retains the source state, file and line. It does not retain an older snapshot or
        grant access.
      </small>
    </DetailPanel>
  );
}
export function SaveView({ id, route }: { id: Id<'imports'>; route: Route }) {
  const { isSignedIn, user } = useUser();
  if (route.view === 'work') return null;
  return isSignedIn ? (
    <SaveForm key={user?.id} id={id} route={{ ...route, view: route.view }} />
  ) : (
    <div className="save-view">
      <SignInButton mode="modal">
        <button>Sign in to star</button>
      </SignInButton>
    </div>
  );
}
function SavedItem({ item }: { item: Saved }) {
  const client = useConvex(),
    [editing, setEditing] = useState(false),
    [name, setName] = useState(item.name),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const mutate = async (remove: boolean) => {
    setBusy(true);
    setError('');
    try {
      if (remove) await client.mutation(api.savedViews.remove, { id: item.id });
      else {
        await client.mutation(api.savedViews.rename, { id: item.id, name });
        setEditing(false);
      }
    } catch (e) {
      setError(hostedError(e));
    } finally {
      setBusy(false);
    }
  };
  const link = `${location.pathname}?${new URLSearchParams({ ...item.route, line: String(item.route.line), codescape: item.importId })}`;
  return (
    <li>
      <div>
        <strong>{item.name}</strong>
        <small>
          {item.route.view === 'home'
            ? 'Home'
            : item.route.view === 'readme'
              ? 'README'
              : item.route.view === 'map'
                ? 'Map'
                : 'Source'}
          {item.route.file && ` · ${item.route.file}:${item.route.line}`}
        </small>
      </div>
      {editing ? (
        <form
          onSubmit={event => {
            event.preventDefault();
            void mutate(false);
          }}
        >
          <label>
            Star name
            <input required value={name} onChange={event => setName(event.target.value)} />
          </label>
          <div className="import-actions">
            <button disabled={busy || !name.trim()}>Save name</button>
            <button type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="import-actions">
          {item.route.state && <a href={link}>Open bookmark</a>}
          <button
            disabled={busy}
            onClick={() => {
              setName(item.name);
              setEditing(true);
            }}
          >
            Rename
          </button>
          <button disabled={busy} onClick={() => void mutate(true)}>
            Remove
          </button>
        </div>
      )}
      {error && <ErrorToast>{error}</ErrorToast>}
    </li>
  );
}
export default function SavedViews() {
  const { results, status, loadMore } = useInventory(api.savedViews.list, 'savedViews', {}, 20);
  return (
    <section className="private-imports saved-views" aria-label="Your bookmarks">
      <h2>Bookmarks</h2>
      <p className="hosted-note">
        Saved places in your repositories: a file, a line, or a graph. Each bookmark points to the original
        source version.
      </p>
      {status === 'LoadingFirstPage' ? (
        <p>Loading bookmarks…</p>
      ) : results.length === 0 ? (
        <p>No bookmarks yet.</p>
      ) : (
        <ul className="import-list">
          {results.map(item => (
            <SavedItem key={item.id} item={item} />
          ))}
        </ul>
      )}
      {status === 'CanLoadMore' && <button onClick={() => loadMore(20)}>Load more bookmarks</button>}
    </section>
  );
}
