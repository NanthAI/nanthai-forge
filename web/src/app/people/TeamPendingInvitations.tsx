// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { useRef, useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';

export default function TeamPendingInvitations({ teamId }: { teamId: Id<'teams'> }) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>Pending team invitations</summary>
      {open ? <Pending teamId={teamId} /> : null}
    </details>
  );
}

function Pending({ teamId }: { teamId: Id<'teams'> }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState('');
  const attempts = useRef(new Map<string, string>());
  const page = useQuery(api.teamInvitationReads.pending, { teamId, cursor });
  const cancel = useMutation(api.teamInvitationWrites.cancel);
  const cancelInvitation = (invitationId: Id<'projectInvites'>) => {
    const operationId = attempts.current.get(invitationId) ?? crypto.randomUUID();
    attempts.current.set(invitationId, operationId);
    setProblem('');
    setBusy(invitationId);
    void cancel({ teamId, invitationId, operationId })
      .catch((error: { data?: { message?: string } }) =>
        setProblem(error.data?.message ?? 'Forge did not cancel the invitation. Try again.'),
      )
      .finally(() => setBusy(''));
  };
  return (
    <>
      {problem ? <p role="alert">{problem}</p> : null}
      {!page ? (
        <p role="status">Loading pending invitations…</p>
      ) : page.rows.length ? (
        <ul className="team-members">
          {page.rows.map(row => (
            <li key={row.id}>
              <span className="ttl" dir="auto" translate="no">
                {row.target}
              </span>
              <button
                type="button"
                className="btn sm ghost"
                disabled={busy === row.id}
                aria-label={'Cancel invitation for ' + row.target}
                onClick={() => cancelInvitation(row.id)}
              >
                Cancel invitation
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p>No pending invitations on this page.</p>
      )}
      {cursor ? (
        <button type="button" className="btn sm ghost" onClick={() => setCursor(null)}>
          Newest invitations
        </button>
      ) : null}
      {page?.cursor ? (
        <button type="button" className="btn sm" onClick={() => setCursor(page.cursor)}>
          More invitations
        </button>
      ) : null}
    </>
  );
}
