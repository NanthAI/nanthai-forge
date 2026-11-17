// SPDX-License-Identifier: Apache-2.0
// Settings / People and access (Items b987e608, c6629fda; docs/access.md). One bounded read, projectAccess.people,
// which re-runs only when a grant or an invitation changes; no timer and no poll. The screen shows the server's
// answers and never decides access: every change below is refused by the server unless the owner person makes it.
// Devices inside each person arrive with the device record (df06081d); teams with team grants (1e474c35).
import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useAction, useMutation, useQuery } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import { Band, Menu, Sheet, State, Who } from '../../ds';
import { crumbsFor, Head } from '../Place';
import type { PlaceProps } from '../screens';
import { hrefFor } from '../paths';
import { A } from '../frames';
import './people.css';

type Data = NonNullable<ReturnType<typeof useQuery<typeof api.projectAccess.people>>>;
type Role = 'read' | 'write';
const PAGE = 50;
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const opId = () => crypto.randomUUID();
const handleOf = (person: string) => (person ? `@${person}` : '');

const Yes = ({ what }: { what: string }) => (
  <span className="yes" role="img" aria-label={`may ${what}`}>
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="m3 8.5 3.2 3.2L13 4.8" />
    </svg>
  </span>
);
const No = ({ what }: { what: string }) => (
  <span className="t3" role="img" aria-label={`may not ${what}`}>
    –
  </span>
);
const Cell = ({ k, on }: { k: string; on: boolean }) => (
  <span className="c">
    <span className="k">{k}</span>
    {on ? <Yes what={k.toLowerCase()} /> : <No what={k.toLowerCase()} />}
  </span>
);

export default function PeopleAccess({ route, projectId, projectName: name }: PlaceProps) {
  const trail = crumbsFor(route, name);
  const [limit, setLimit] = useState(PAGE);
  const [invitationCursor, setInvitationCursor] = useState<string | null>(null);
  const data = useQuery(api.projectAccess.people, { projectId, limit, invitationCursor });
  const owner = data?.role === 'owner';
  const [inviting, setInviting] = useState(false);
  const [sent, setSent] = useState<{ who: string; role: Role; email: boolean } | null>(null);
  const [removing, setRemoving] = useState<{ person: string; role: Role } | null>(null);
  const [error, setError] = useState('');
  const setRole = useMutation(api.projectAccess.setRole);
  const run = (work: Promise<unknown>) =>
    void work.then(
      () => setError(''),
      (e: { data?: { message?: string } }) =>
        setError(e?.data?.message ?? 'Forge did not answer. Nothing changed.'),
    );
  const projectHref = hrefFor({ frame: 'account', place: 'people' });
  const checksHref = hrefFor({ ...route, place: 'settings', section: 'checks', rest: '' });
  return (
    <>
      <Head trail={trail} sentence={data ? <Situation data={data} name={name} /> : ''}>
        {owner ? (
          <button type="button" className="btn" onClick={() => (setInviting(true), setSent(null))}>
            Invite
          </button>
        ) : null}
      </Head>
      {error ? (
        <div className="notice" data-st="failed" role="alert">
          <State word="Check failed">Not changed</State>
          <p>{error}</p>
        </div>
      ) : null}
      {data?.role === 'read' ? (
        <div className="notice" data-st="stale">
          <State word="Set aside">View only</State>
          <p>You see what you can do here. Changing who can do what is the owner’s.</p>
        </div>
      ) : null}
      {inviting && owner ? (
        <InviteForm
          projectId={projectId}
          onDone={value => (setInviting(false), setSent(value))}
          onCancel={() => setInviting(false)}
        />
      ) : null}
      {sent ? (
        <div className="notice" data-st="passed" aria-live="polite">
          <State word="Done">Invited</State>
          <p>
            <span className="mono">{sent.who}</span> has a pending invitation for {sent.role} access. They
            join only after they accept it.
          </p>
          <CopyLink href={projectHref} />
          <button type="button" className="btn sm ghost" onClick={() => setSent(null)}>
            Done
          </button>
        </div>
      ) : null}
      <section className="region" aria-label="Who can do what" aria-busy={!data}>
        <div className="ph plain">
          <h2>Who can do what</h2>
          <span className="hint">{owner ? 'a change applies at once' : 'as it is now'}</span>
        </div>
        <div className="th acc">
          <span>Who</span>
          <span>Read</span>
          <span>Write</span>
          <span>Land without a check</span>
          <span />
        </div>
        {!data ? (
          <Skeleton />
        ) : (
          <>
            {data.visibility === 'public' ? (
              <div className="row acc">
                <span className="nm">
                  <span className="who">
                    <span className="av none" aria-hidden="true">
                      a
                    </span>
                    <span>Anyone</span>
                  </span>
                  <span className="sub">{name} is public. Cloning needs a sign-in.</span>
                </span>
                <Cell k="Read" on />
                <Cell k="Write" on={false} />
                <Cell k="Land without a check" on={false} />
                <span className="ph0" />
              </div>
            ) : null}
            {data.owner ? (
              <div className="row acc">
                <span className="nm">
                  <Who handle={handleOf(data.owner)} />
                  <span className="sub">owner{owner ? ', you' : ''}</span>
                </span>
                <Cell k="Read" on />
                <Cell k="Write" on />
                <Cell k="Land without a check" on />
                <span className="ph0" />
              </div>
            ) : null}
            <Members
              data={data}
              owner={owner}
              onRole={(person, role) => run(setRole({ projectId, person, role, operationId: opId() }))}
              onRemove={setRemoving}
            />
            {data.write.more || data.read.more ? (
              <div className="pf">
                Showing the first {plural(limit, 'person', 'people')} of each kind.{' '}
                <button type="button" className="btn sm ghost" onClick={() => setLimit(limit + PAGE)}>
                  Show {PAGE} more
                </button>
              </div>
            ) : null}
            {owner && data.invited.length ? (
              <>
                <Invited projectId={projectId} rows={data.invited} onError={setError} />
                <div className="quietline btns">
                  {data.invitationCursor ? (
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => setInvitationCursor(data.invitationCursor)}
                    >
                      More invitations
                    </button>
                  ) : null}
                  {invitationCursor ? (
                    <button type="button" className="btn sm ghost" onClick={() => setInvitationCursor(null)}>
                      Newest invitations
                    </button>
                  ) : null}
                </div>
              </>
            ) : null}
            {owner &&
            !data.write.rows.length &&
            !data.read.rows.length &&
            !data.invited.filter(row => row.state === 'pending').length ? (
              <div className="empty">
                <h3>Nobody else yet</h3>
                <p>
                  Invite a person. Your own agents need no invitation: they act through a device you approve
                  with <code>nforge login</code>.
                </p>
              </div>
            ) : null}
          </>
        )}
      </section>
      {data ? (
        <section className="region quiet" aria-label="Landing without a check">
          <div className="ph plain">
            <h2>Landing without a check</h2>
            <span className="hint">people only; agents always need a check</span>
          </div>
          <div className="row people-quiet">
            <span className="ttl">
              {data.withoutCheck === 'owner'
                ? 'Only the owner.'
                : data.withoutCheck === 'writers'
                  ? 'The owner and everyone with write access.'
                  : 'The owner and the people or teams chosen in Landing and checks.'}
            </span>
            <A className="btn sm ghost" href={checksHref}>
              {owner ? 'Change' : 'See'} in Landing and checks
            </A>
          </div>
        </section>
      ) : null}
      <RemoveSheet
        projectId={projectId}
        name={name}
        target={removing}
        onClose={() => setRemoving(null)}
        onError={setError}
      />
    </>
  );
}

/** The head's sentence: who can change the project, then what waits on the owner (open invitations). */
function Situation({ data, name }: { data: Data; name: string }) {
  const writers = 1 + data.write.rows.length;
  const more = data.write.more ? ' at least' : '';
  let text: ReactNode;
  if (data.role === 'read') text = <b>You can read {name}.</b>;
  else if (data.role === 'write')
    text = (
      <>
        <b>You can change {name} and land with a check.</b> Agents act through your devices and never get more
        than you.
      </>
    );
  else if (data.role === 'owner')
    text =
      writers === 1 && !data.read.rows.length ? (
        <>
          <b>Only you can change {name}.</b>
          {data.visibility === 'public' ? ' Anyone can read it, because it is public.' : ''} Agents act
          through your devices.
        </>
      ) : (
        <>
          <b>
            {more ? 'At least ' : ''}
            {plural(writers, 'person', 'people')} can change {name}.
          </b>{' '}
          {data.read.rows.length
            ? `${plural(data.read.rows.length, 'more person reads', 'more people read')} it. `
            : ''}
          Agents act through their person’s devices.
          {data.invited.filter(row => row.state === 'pending').length
            ? ` ${plural(data.invited.filter(row => row.state === 'pending').length, 'invitation is', 'invitations are')} open.`
            : ''}
        </>
      );
  else text = <b>Anyone can read {name}, because it is public.</b>;
  return text;
}

function Members({
  data,
  owner,
  onRole,
  onRemove,
}: {
  data: Data;
  owner: boolean;
  onRole: (person: string, role: Role) => void;
  onRemove: (target: { person: string; role: Role }) => void;
}) {
  const rows = [
    ...data.write.rows.map(row => ({ ...row, role: 'write' as const })),
    ...data.read.rows.map(row => ({ ...row, role: 'read' as const })),
  ].filter(row => row.person);
  if (!rows.length) return null;
  return (
    <>
      <Band title="People" count={rows.length} />
      {rows.map(row => {
        const handle = handleOf(row.person);
        return (
          <div key={row.person} className="row acc">
            <span className="nm">
              <Who handle={handle} />
              <span className="sub">{row.role === 'write' ? 'write' : 'read'}</span>
            </span>
            <Cell k="Read" on />
            <span className="c">
              <span className="k">Write</span>
              {owner ? (
                <input
                  className="sw"
                  type="checkbox"
                  role="switch"
                  checked={row.role === 'write'}
                  aria-label={`${handle}, write`}
                  onChange={() => onRole(row.person, row.role === 'write' ? 'read' : 'write')}
                />
              ) : row.role === 'write' ? (
                <Yes what="write" />
              ) : (
                <No what="write" />
              )}
            </span>
            <Cell k="Land without a check" on={row.role === 'write' && data.withoutCheck === 'writers'} />
            {owner ? (
              <Menu
                label={`More for ${handle}`}
                className="icb"
                items={[
                  {
                    id: 'role',
                    label: row.role === 'write' ? 'Change to read' : 'Change to write',
                    onAction: () => onRole(row.person, row.role === 'write' ? 'read' : 'write'),
                  },
                  'separator',
                  {
                    id: 'remove',
                    label: 'Remove from the project…',
                    danger: true,
                    onAction: () => onRemove(row),
                  },
                ]}
              >
                <span aria-hidden="true">⋯</span>
              </Menu>
            ) : (
              <span className="ph0" />
            )}
          </div>
        );
      })}
    </>
  );
}

function InviteForm({
  projectId,
  onDone,
  onCancel,
}: {
  projectId: Id<'hostedProjects'>;
  onDone: (sent: { who: string; role: Role; email: boolean }) => void;
  onCancel: () => void;
}) {
  const invite = useAction(api.projectContributorActions.invitePerson);
  const [role, setRole] = useState<Role>('read');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const operation = useRef(opId());
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const who = String(new FormData(event.currentTarget).get('who') ?? '').trim();
    if (!who) return;
    setBusy(true);
    // The same operation id until it succeeds, so a retry after a lost reply reconciles instead of inviting twice.
    void invite({ projectId, person: who, role, operationId: operation.current }).then(
      () => (
        (operation.current = opId()),
        setBusy(false),
        onDone({ who, role, email: who.includes('@') && !who.startsWith('@') })
      ),
      (e: { data?: { message?: string } }) => (
        setBusy(false),
        setProblem(e?.data?.message ?? 'Forge did not answer.')
      ),
    );
  };
  return (
    <form className="notice" data-st="active" onSubmit={submit} aria-busy={busy}>
      <label className="f people-who">
        Forge handle or email
        <input
          className="inp"
          name="who"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="@handle or name@example.com…"
          required
          aria-describedby="invite-help"
          autoFocus
        />
        <span className="help" id="invite-help">
          {problem || 'They sign in with the invited account, then accept. Invitations expire after 7 days.'}
        </span>
      </label>
      <span className="f people-role">
        Starts with
        <span className="seg" role="group" aria-label="Starts with">
          {(['read', 'write'] as const).map(value => (
            <button key={value} type="button" aria-pressed={role === value} onClick={() => setRole(value)}>
              {value === 'read' ? 'Read' : 'Write'}
            </button>
          ))}
        </span>
      </span>
      <span className="btns">
        <button className="btn primary" disabled={busy}>
          Invite
        </button>
        <button type="button" className="btn ghost" onClick={onCancel}>
          Not now
        </button>
      </span>
    </form>
  );
}

function Invited({
  projectId,
  rows,
  onError,
}: {
  projectId: Id<'hostedProjects'>;
  rows: Data['invited'];
  onError: (message: string) => void;
}) {
  const cancel = useMutation(api.projectContributors.cancelInvite);
  const resend = useMutation(api.projectInviteMail.resend);
  const fail = (e: { data?: { message?: string } }) => onError(e?.data?.message ?? 'Forge did not answer.');
  return (
    <>
      <Band title="Invitations" count={rows.length} hint="latest invitations; access waits for acceptance" />
      {rows.map(row => (
        <div key={row.id} className="row acc ask">
          <span className="nm">
            <span className="who">
              <span className="av none" aria-hidden="true">
                ?
              </span>
              <span className="mono" translate="no">
                {row.email}
              </span>
            </span>
            <span className="sub">
              {row.role} ·{' '}
              <span>
                {row.state === 'pending' ? 'Pending' : row.state[0]!.toUpperCase() + row.state.slice(1)}
              </span>{' '}
              · <MailState mail={row.mail} />
            </span>
          </span>
          <span className="btns">
            {row.state === 'pending' && row.operationId && row.mail ? (
              <button
                type="button"
                className="btn sm"
                onClick={() =>
                  void resend({ projectId, operationId: row.operationId!, resendId: opId() }).catch(fail)
                }
              >
                Resend
              </button>
            ) : null}
            {row.state === 'pending' ? (
              <button
                type="button"
                className="btn sm ghost"
                onClick={() => void cancel({ projectId, id: row.id }).catch(fail)}
              >
                End invitation
              </button>
            ) : null}
            <CopyLink href={hrefFor({ frame: 'account', place: 'people' })} />
          </span>
        </div>
      ))}
    </>
  );
}

function MailState({ mail }: { mail: Data['invited'][number]['mail'] }) {
  if (!mail) return <>no email sent; copy the link</>;
  if (mail.status === 'sending') return <State word="Saving">Sending the email</State>;
  if (mail.status === 'sent') return <>email submitted{mail.sends > 1 ? ` ${mail.sends} times` : ''}</>;
  if (mail.status === 'off')
    return <State word="Not run">Invitation email is off here; copy the link and send it yourself</State>;
  return (
    <State word="Check failed">
      Email not sent{mail.code ? ` (${mail.code})` : ''}; resend or copy the link
    </State>
  );
}

function CopyLink({ href }: { href: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn sm"
      onClick={() =>
        void navigator.clipboard?.writeText(new URL(href, location.origin).href).then(() => setCopied(true))
      }
    >
      {copied ? 'Link copied' : 'Copy the link'}
    </button>
  );
}

function RemoveSheet({
  projectId,
  name,
  target,
  onClose,
  onError,
}: {
  projectId: Id<'hostedProjects'>;
  name: string;
  target: { person: string; role: Role } | null;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const setRole = useMutation(api.projectAccess.setRole);
  const handle = target ? handleOf(target.person) : '';
  return (
    <Sheet
      open={!!target}
      onOpenChange={open => (open ? undefined : onClose())}
      title={`Remove ${handle} from ${name}?`}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} autoFocus>
            Keep {handle}
          </button>
          <button
            type="button"
            className="btn danger"
            onClick={() => {
              if (target)
                void setRole({ projectId, person: target.person, role: 'none', operationId: opId() }).catch(
                  (e: { data?: { message?: string } }) =>
                    onError(e?.data?.message ?? 'Forge did not answer.'),
                );
              onClose();
            }}
          >
            Remove {handle}
          </button>
        </>
      }
    >
      <p>
        <b>Ends now:</b> {target?.role === 'write' ? 'write and read' : 'read'} access. Their agents’ next
        call is refused.
      </p>
      <p>
        <b>Stays:</b> their saved work and open Lanes, under their name. You can invite them again.
      </p>
    </Sheet>
  );
}

function Skeleton() {
  return (
    <>
      {[38, 22, 30].map(width => (
        <div key={width} className="skrow">
          <span className="sk" />
          <span className="sk" style={{ '--w': width } as React.CSSProperties} />
        </div>
      ))}
    </>
  );
}
