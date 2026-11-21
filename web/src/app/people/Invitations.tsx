// SPDX-License-Identifier: Apache-2.0
import { useRef, useState } from 'react';
import { useAction, useMutation, useQuery } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import { Band, State } from '../../ds';
import { A } from '../frames';

type Inbox = NonNullable<ReturnType<typeof useQuery<typeof api.projectInvitationInbox.inbox>>>;
type Invitation = Inbox['rows'][number];
type Choice = 'accept' | 'decline' | 'block';
function InvitationRows({
  rows,
  answer,
  busy,
}: {
  rows: Invitation[];
  busy: string;
  answer: (row: Invitation, choice: Choice) => void;
}) {
  return (
    <>
      {rows.map(row => (
        <div
          className="row people-invitation"
          key={row.invitationId}
          data-weight={row.state === 'pending' ? 'act' : 'ref'}
        >
          <span className="nm">
            <b>{'teamName' in row ? row.teamName : row.projectName}</b>
            <span className="sub">
              {row.inviterHandle ? `@${row.inviterHandle}` : 'A Forge person'} invited you to{' '}
              {'teamName' in row ? 'join this team' : row.role === 'write' ? 'read and change' : 'read'} ·{' '}
              <State word={row.state === 'pending' ? 'Needs you' : 'Set aside'}>
                {row.state === 'pending' ? 'Pending' : 'Expired'}
              </State>
            </span>
            {'expiresAt' in row ? (
              <span className="sub">
                {row.state === 'pending' ? 'Expires' : 'Expired'}{' '}
                <time dateTime={new Date(row.expiresAt).toISOString()}>
                  {new Date(row.expiresAt).toLocaleDateString()}
                </time>
              </span>
            ) : null}
          </span>
          {row.state === 'pending' ? (
            <span className="btns">
              {(['accept', 'decline', 'block'] as const).map(choice => (
                <button
                  type="button"
                  key={choice}
                  className={`btn sm ${choice === 'accept' ? 'key' : 'ghost'}`}
                  disabled={busy === row.invitationId}
                  onClick={() => answer(row, choice)}
                >
                  {choice === 'accept'
                    ? 'Accept'
                    : choice === 'decline'
                      ? 'Decline'
                      : 'Decline and block inviter'}
                </button>
              ))}
            </span>
          ) : (
            <span className="hint">Ask the inviter for a new invitation.</span>
          )}
        </div>
      ))}
    </>
  );
}
export default function Invitations({ onJoinTeam }: { onJoinTeam?: () => void }) {
  const [handleCursor, setHandleCursor] = useState<string | null>(null),
    [emailCursor, setEmailCursor] = useState<string | null>(null);
  const handles = useQuery(api.projectInvitationInbox.inbox, { kind: 'handle', cursor: handleCursor });
  const emails = useQuery(api.projectInvitationInbox.inbox, {
    kind: 'email',
    cursor: emailCursor,
    includeTeams: true,
  });
  const answer = useMutation(api.projectInvitationAnswers.answer);
  const answerTeam = useAction(api.teamActions.answerInvitation);
  const attempts = useRef(new Map<string, string>());
  const [busy, setBusy] = useState(''),
    [problem, setProblem] = useState(''),
    [joined, setJoined] = useState<{ href: string; team: boolean } | null>(null);
  const [preferences, setPreferences] = useState(false);
  const rows = [...(handles?.rows ?? []), ...(emails?.rows ?? [])].sort(
    (a, b) => Number(a.state !== 'pending') - Number(b.state !== 'pending'),
  );
  const act = (row: Invitation, choice: Choice) => {
    const { invitationId, href } = row;
    const team = 'teamName' in row;
    const key = `${invitationId}:${choice}`;
    if (!attempts.current.has(key)) attempts.current.set(key, crypto.randomUUID());
    setBusy(invitationId);
    setProblem('');
    void (team ? answerTeam : answer)({ invitationId, choice, operationId: attempts.current.get(key)! })
      .then(() => {
        if (choice === 'accept') {
          setJoined({ href, team });
          if (team) onJoinTeam?.();
        }
      })
      .catch((error: { data?: { message?: string } }) =>
        setProblem(error.data?.message ?? 'Forge did not answer. Retry your answer.'),
      )
      .finally(() => setBusy(''));
  };
  return (
    <>
      <section className="region" aria-label="Your invitations" aria-busy={!handles || !emails}>
        <Band title="Invitations" count={rows.length} hint="on this page" />
        {problem ? (
          <p className="notice" role="alert">
            {problem}
          </p>
        ) : null}
        {joined ? (
          <p className="quietline" role="status">
            Invitation accepted.{' '}
            <A href={joined.href}>{joined.team ? 'Open People and teams' : 'Open the project'}</A>
          </p>
        ) : null}
        {!handles || !emails ? (
          <p className="quietline">Loading invitations…</p>
        ) : !rows.length ? (
          <p className="quietline">No invitations on this page.</p>
        ) : (
          <InvitationRows rows={rows} answer={act} busy={busy} />
        )}
        <div className="quietline btns">
          {handles?.cursor ? (
            <button type="button" className="btn sm" onClick={() => setHandleCursor(handles.cursor)}>
              More handle invitations
            </button>
          ) : null}
          {emails?.cursor ? (
            <button type="button" className="btn sm" onClick={() => setEmailCursor(emails.cursor)}>
              More email invitations
            </button>
          ) : null}
          {handleCursor || emailCursor ? (
            <button
              type="button"
              className="btn sm ghost"
              onClick={() => {
                setHandleCursor(null);
                setEmailCursor(null);
              }}
            >
              Newest invitations
            </button>
          ) : null}
          <button
            type="button"
            className="btn sm ghost"
            aria-expanded={preferences}
            onClick={() => setPreferences(!preferences)}
          >
            Blocked inviters
          </button>
        </div>
      </section>
      {preferences ? <BlockedInviters /> : null}
    </>
  );
}
function BlockedInviters() {
  const [cursor, setCursor] = useState<string | null>(null),
    [problem, setProblem] = useState('');
  const data = useQuery(api.projectInvitationInbox.blocked, { cursor });
  const unblock = useMutation(api.projectInvitationAnswers.unblock);
  return (
    <section className="region quiet" aria-label="Blocked inviters">
      <Band title="Blocked inviters" count={data?.rows.length ?? 0} />
      {problem ? <p role="alert">{problem}</p> : null}
      {data?.rows.map(row => (
        <div className="row people-invitation" key={row.id}>
          <span>{row.inviterHandle ? `@${row.inviterHandle}` : 'A Forge person'}</span>
          <button
            type="button"
            className="btn sm"
            onClick={() =>
              void unblock({
                id: row.id,
                expectedVersion: row.version,
                operationId: crypto.randomUUID(),
              }).catch((error: { data?: { message?: string } }) =>
                setProblem(error.data?.message ?? 'Forge did not answer.'),
              )
            }
          >
            Unblock
          </button>
        </div>
      ))}
      {data && !data.rows.length ? <p className="quietline">No blocked inviters on this page.</p> : null}
      {data?.cursor ? (
        <button type="button" className="btn sm" onClick={() => setCursor(data.cursor)}>
          More blocked inviters
        </button>
      ) : null}
    </section>
  );
}
