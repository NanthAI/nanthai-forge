import { useReadRetry } from './ui/read-retry';
import { ErrorToast } from './ui/Toast';
// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import { useUser } from '@clerk/react';
import { useConvex, usePaginatedQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import type { Id } from '../../convex/_generated/dataModel';
import { api } from '../../convex/_generated/api';
import { hostedError } from './snapshot';

type Team = { id: Id<'teams'>; name: string; owner: string };
export default function Teams({ open }: { open: (id: Id<'imports'>) => void }) {
  const client = useConvex(),
    { user } = useUser();
  const { results, status, loadMore } = usePaginatedQuery(api.teams.list, {}, { initialNumItems: 20 });
  const [name, setName] = useState(''),
    [operationId, setOperationId] = useState(() => crypto.randomUUID());
  const [selected, setSelected] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const team = results.find(row => row.id === selected);
  return (
    <section className="private-imports" aria-label="Your teams">
      <h2>Your teams</h2>
      <p className="hosted-note">
        Create separate reader teams for different groups. Team owners manage members and shared repositories;
        each reader uses their current GitHub access.
      </p>
      <form
        onSubmit={e => {
          e.preventDefault();
          setBusy(true);
          setError('');
          void client
            .mutation(api.teams.create, { name, operationId })
            .then(id => {
              setSelected(id);
              setName('');
              setOperationId(crypto.randomUUID());
            })
            .catch(e => setError(hostedError(e)))
            .finally(() => setBusy(false));
        }}
      >
        <label>
          Team name
          <input required value={name} onChange={e => setName(e.target.value)} />
        </label>
        <button disabled={busy || !name.trim()}>Create reader team</button>
      </form>
      {status === 'LoadingFirstPage' ? (
        <p>Loading teams…</p>
      ) : !results.length ? (
        <p>No reader teams yet.</p>
      ) : (
        <ul className="reader-list">
          {results.map(row => (
            <li key={row.id}>
              <button
                className="collection-row"
                aria-pressed={row.id === selected}
                onClick={() => setSelected(row.id)}
              >
                <span>
                  <strong>{row.name}</strong>
                  <small>{row.owner === user?.id ? 'Creator' : 'Reader'}</small>
                </span>
                <span aria-hidden="true">→</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {status === 'CanLoadMore' && <button onClick={() => loadMore(20)}>Load more teams</button>}
      {team && <TeamDetail key={team.id} team={team} owner={team.owner === user?.id} open={open} />}
      {error && <ErrorToast>{error}</ErrorToast>}
    </section>
  );
}
function TeamDetail({
  team,
  owner,
  open,
}: {
  team: Team;
  owner: boolean;
  open: (id: Id<'imports'>) => void;
}) {
  const readAttempt = useReadRetry();
  const client = useConvex();
  const { results, status, loadMore } = usePaginatedQuery(
    api.teams.members,
    owner ? { id: team.id } : 'skip',
    { initialNumItems: 20 },
  );
  const [member, setMember] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [saved, setSaved] = useState('');
  const { user } = useUser();
  const [labels, setLabels] = useState<Record<string, string>>({});
  const memberKey = results.map(row => row.member).join(',');
  useEffect(() => {
    if (!owner) return;
    let active = true;
    void (async () => {
      const names: Record<string, string> = {};
      let cursor: string | null = null;
      do {
        const page: { page: { member: string; label: string }[]; isDone: boolean; continueCursor: string } =
          await client.action(api.teamActions.labels, {
            id: team.id,
            paginationOpts: { cursor, numItems: 20 },
          });
        for (const row of page.page) names[row.member] = row.label;
        cursor = page.isDone ? null : page.continueCursor;
      } while (cursor !== null);
      if (active) setLabels(names);
    })().catch(e => {
      if (active) setError(hostedError(e));
    });
    return () => {
      active = false;
    };
  }, [client, team.id, owner, memberKey, readAttempt]);
  const [imports, setImports] = useState<FunctionReturnType<typeof api.teamActions.codescapes> | null>(null);
  async function act(run: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError('');
    setSaved('');
    try {
      await run();
      setSaved(message);
    } catch (e) {
      setError(hostedError(e));
    } finally {
      setBusy(false);
    }
  }
  async function load(cursor: string | null = null) {
    await act(async () => {
      const next = await client.action(api.teamActions.codescapes, {
        id: team.id,
        paginationOpts: { cursor, numItems: 20 },
      });
      setImports(previous => ({
        ...next,
        page:
          cursor && previous
            ? [...new Map([...previous.page, ...next.page].map(row => [row.id, row])).values()]
            : next.page,
      }));
    }, 'Team access checked.');
  }
  return (
    <section aria-label="Selected reader team">
      <h3>{team.name}</h3>
      {owner && (
        <>
          <form
            onSubmit={e => {
              e.preventDefault();
              void act(async () => {
                await client.action(api.teamActions.addByEmail, { id: team.id, email: member });
                setMember('');
              }, 'Team membership saved.');
            }}
          >
            <label>
              Team member email
              <input
                type="email"
                required
                value={member}
                onChange={e => setMember(e.target.value)}
                placeholder="name@example.com"
              />
            </label>
            <button disabled={busy}>Add team member</button>
          </form>
          {status === 'LoadingFirstPage' ? (
            <p>Loading members…</p>
          ) : (
            <ul className="reader-list">
              {results.map(row => (
                <li key={row.member}>
                  <span>
                    {row.member === user?.id
                      ? user.fullName || user.primaryEmailAddress?.emailAddress || 'You'
                      : labels[row.member] || 'Loading account…'}
                  </span>
                  {row.member === team.owner ? (
                    <small>Creator</small>
                  ) : (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void act(
                          () => client.mutation(api.teams.removeMember, { id: team.id, member: row.member }),
                          'Team membership removed.',
                        )
                      }
                    >
                      Remove team member
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {status === 'CanLoadMore' && <button onClick={() => loadMore(20)}>Load more team members</button>}
        </>
      )}
      <button disabled={busy} onClick={() => void load()}>
        Check team repositories
      </button>
      {imports &&
        (!imports.page.length ? (
          <p>No team repositories available with current access.</p>
        ) : (
          <ul className="import-list">
            {imports.page.map(row => (
              <li key={row.id}>
                <div>
                  <strong>{row.repository}</strong>
                  <small>
                    {row.ref} · {row.phase}
                  </small>
                </div>
                <button onClick={() => open(row.id)}>Explore team repository</button>
              </li>
            ))}
          </ul>
        ))}
      {imports && !imports.isDone && (
        <button disabled={busy} onClick={() => void load(imports.continueCursor)}>
          Load more team repositories
        </button>
      )}
      {busy && <p role="status">Checking team…</p>}
      {saved && <p role="status">{saved}</p>}
      {error && <ErrorToast>{error}</ErrorToast>}
    </section>
  );
}
export function TeamSharing({ importId }: { importId: Id<'imports'> }) {
  const client = useConvex(),
    { user } = useUser();
  const teams = usePaginatedQuery(api.teams.list, {}, { initialNumItems: 20 });
  const links = usePaginatedQuery(api.teams.links, { importId }, { initialNumItems: 20 });
  const [selected, setSelected] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [saved, setSaved] = useState('');
  async function change(id: Id<'teams'>, shared: boolean) {
    setBusy(true);
    setError('');
    setSaved('');
    try {
      await client.mutation(api.teams.link, { id, importId, shared });
      setSaved(shared ? 'Team access saved.' : 'Team access removed.');
    } catch (e) {
      setError(hostedError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Share with reader teams">
      <h4>Reader teams</h4>
      <p>
        Create a team above, then attach it here. Removing a link stops future team reads; separate named
        grants still apply.
      </p>
      <form
        onSubmit={e => {
          e.preventDefault();
          void change(selected as Id<'teams'>, true);
        }}
      >
        <label>
          Your reader team
          <select value={selected} onChange={e => setSelected(e.target.value)} required>
            <option value="">Choose your team</option>
            {teams.results
              .filter(row => row.owner === user?.id)
              .map(row => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
          </select>
        </label>
        <button disabled={busy || !selected}>Share with team</button>
      </form>
      {teams.status === 'CanLoadMore' && (
        <button onClick={() => teams.loadMore(20)}>Load more team choices</button>
      )}
      <ul className="reader-list">
        {links.results.map(row => (
          <li key={row.id}>
            <strong>{row.name}</strong>
            <button disabled={busy} onClick={() => void change(row.id, false)}>
              Remove team access
            </button>
          </li>
        ))}
      </ul>
      {links.status === 'CanLoadMore' && (
        <button onClick={() => links.loadMore(20)}>Load more shared teams</button>
      )}
      {saved && <p role="status">{saved}</p>}
      {error && <ErrorToast>{error}</ErrorToast>}
    </section>
  );
}
