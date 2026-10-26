import { ErrorToast } from './ui/Toast';
// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from 'react';
import { useConvex, usePaginatedQuery, useQuery } from 'convex/react';
import { makeFunctionReference } from 'convex/server';
import type { Id } from '../../convex/_generated/dataModel';
import { api } from '../../convex/_generated/api';
import { Avatar } from './ui/primitives';
import { hostedError } from './snapshot';

type ProjectId = Id<'hostedProjects'>;
export const sharedProjects = makeFunctionReference<
  'query',
  { paginationOpts: { numItems: number; cursor: string | null } },
  {
    page: {
      id: ProjectId;
      key: string;
      name: string;
      currentBackup?: Id<'projectBackups'>;
      revision: number;
    }[];
    isDone: boolean;
    continueCursor: string;
  }
>('projectContributors:shared');
const contributors = makeFunctionReference<
  'query',
  { projectId: ProjectId },
  { id: string; contributor: string; at: number }[]
>('projectContributors:list');
const add = api.projectContributorActions.invitePerson;
const people = makeFunctionReference<
  'action',
  { projectId: ProjectId },
  { contributor: string; label: string; handle?: string }[]
>('projectContributorActions:labels');
const remove = makeFunctionReference<'mutation', { projectId: ProjectId; contributor: string }, null>(
  'projectContributors:remove',
);

export function SharedProjects({
  open,
  disabled = false,
}: {
  open: (projectId: ProjectId, name: string) => void;
  disabled?: boolean;
}) {
  const { results, status, loadMore } = usePaginatedQuery(sharedProjects, {}, { initialNumItems: 20 });
  return (
    <section className="shared-projects" aria-label="Projects shared with you">
      <h2>Shared with you</h2>
      {status === 'LoadingFirstPage' ? (
        <p role="status">Loading shared projects…</p>
      ) : !results.length ? (
        <p className="hosted-note">Projects shared with your Forge account appear here.</p>
      ) : (
        <ul className="import-list">
          {results.map(project => (
            <li key={project.id}>
              <div>
                <strong>{project.name}</strong>
                <small>Contributor · local execution</small>
              </div>
              <button disabled={disabled} onClick={() => open(project.id, project.name)}>
                Open project
              </button>
            </li>
          ))}
        </ul>
      )}
      {status === 'CanLoadMore' && <button onClick={() => loadMore(20)}>Load more shared projects</button>}
    </section>
  );
}

export default function ProjectContributors({
  projectId,
  active = true,
}: {
  projectId: ProjectId;
  active?: boolean;
}) {
  const client = useConvex(),
    [contributor, setContributor] = useState('');
  const handles = useQuery(
    api.projectContributors.handles,
    active && contributor.startsWith('@') ? { projectId, prefix: contributor } : 'skip',
  );
  const invites = useQuery(api.projectContributors.pending, active ? { projectId } : 'skip');
  const rows = useQuery(contributors, active ? { projectId } : 'skip');
  const [names, setNames] = useState<Record<string, { label: string; handle?: string }>>({});
  const memberIds = rows?.map(row => row.contributor).join(',') ?? '';
  useEffect(() => {
    if (!active || !memberIds) return;
    let live = true;
    void client
      .action(people, { projectId })
      .then(result => {
        if (live) setNames(Object.fromEntries(result.map(person => [person.contributor, person])));
      })
      .catch(() => {
        /* Membership remains available if identity names cannot be loaded. */
      });
    return () => {
      live = false;
    };
  }, [client, projectId, active, memberIds]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const invitation = useRef<{ person: string; operationId: string } | null>(null);
  async function change(person: string, grant: boolean) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      if (grant) {
        if (invitation.current?.person !== person)
          invitation.current = { person, operationId: crypto.randomUUID() };
        await client.action(add, { projectId, ...invitation.current });
        invitation.current = null;
      } else await client.mutation(remove, { projectId, contributor: person });
      if (grant) setContributor('');
      setMessage(grant ? 'Access saved.' : 'Contributor access removed.');
    } catch (e) {
      setError(hostedError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="project-contributors">
      <form
        onSubmit={event => {
          event.preventDefault();
          void change(contributor.trim(), true);
        }}
      >
        <label>
          @handle or email address
          <input
            type="text"
            list="forge-contributor-handles"
            autoComplete="off"
            required
            value={contributor}
            disabled={busy}
            onChange={event => setContributor(event.target.value)}
            placeholder="@handle or email"
          />
        </label>
        <datalist id="forge-contributor-handles">
          {handles?.map(person => (
            <option key={person.handle} value={`@${person.handle}`} />
          ))}
        </datalist>
        <button disabled={busy || !contributor.trim()}>Invite contributor</button>
      </form>
      {rows === undefined ? (
        <p role="status">Loading contributors…</p>
      ) : !rows.length ? (
        <p>No contributors yet.</p>
      ) : (
        <ul className="reader-list">
          {rows.map(row => (
            <li key={row.id}>
              <span className="fx-person">
                <Avatar name={names[row.contributor]?.label ?? 'Contributor'} />
                <span>
                  <b>{names[row.contributor]?.label ?? 'Contributor'}</b>
                  {names[row.contributor]?.handle && <small>@{names[row.contributor]!.handle}</small>}
                </span>
              </span>
              <button disabled={busy} onClick={() => void change(row.contributor, false)}>
                Remove contributor
              </button>
            </li>
          ))}
        </ul>
      )}
      {!!invites?.length && (
        <ul className="reader-list" aria-label="Pending invitations">
          {invites.map(invite => (
            <li key={invite.id}>
              <span>
                {invite.email}
                <small className="fx-muted"> · Pending invitation</small>
              </span>
              <button
                disabled={busy}
                onClick={() =>
                  void client
                    .mutation(api.projectContributors.cancelInvite, { projectId, id: invite.id })
                    .catch(e => setError(hostedError(e)))
                }
              >
                Cancel invitation
              </button>
            </li>
          ))}
        </ul>
      )}
      {message && <p role="status">{message}</p>}
      {error && <ErrorToast>{error}</ErrorToast>}
    </section>
  );
}
