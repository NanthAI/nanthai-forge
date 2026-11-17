// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { Band, Key, Region, Row, State } from '../ds';
import { Head } from './Place';
import './access.css';
export type AccountSessions = {
  sessions: { sessionId: string; creationTime: number; lastRefreshedAt: number; current: boolean }[];
  passkeys: { passkeyId: string; name?: string; createdAt: number }[];
  devices: {
    credentialId: string;
    name: string;
    scope: string;
    issuedAt: number;
    expiresAt: number;
    revoked: boolean;
  }[];
  github: string | null;
  notice: { at: number; passkeyId: string } | null;
  isDone: boolean;
  continueCursor: string;
};
const date = (value: number) =>
  new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
type Actions = {
  leave: () => void;
  more: () => void;
  acknowledge: () => void;
  revoke: () => void;
  github: () => void;
  add: () => void;
  rename: (id: string, name: string) => void;
  remove: (id: string) => void;
  renameDevice: (id: string, name: string) => void;
  endDevice: (id: string) => void;
};
export function YouView({
  data,
  handle,
  now,
  busy,
  problem,
  ...actions
}: Actions & {
  data?: AccountSessions;
  handle?: string;
  now: number;
  busy: boolean;
  problem: string | null;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const sentence = data
    ? `You are signed in on ${data.sessions.length} ${data.sessions.length === 1 ? 'browser' : 'browsers'} and have ${data.devices.length}${data.isDone ? '' : ' shown'} ${data.devices.length === 1 ? 'device' : 'devices'}.`
    : 'Loading your sign-ins and devices…';
  const edit = (id: string, value: string) => {
    setEditing(id);
    setName(value);
  };
  return (
    <>
      <Head trail={[{ label: 'You' }]} sentence={sentence}>
        <Key onClick={actions.revoke} disabled={busy || !data?.passkeys.length}>
          Sign out other sessions
        </Key>
        {data?.github ? (
          <Key onClick={actions.github} disabled={busy}>
            Check with GitHub and sign out other sessions
          </Key>
        ) : null}
        <Key kind="ghost" onClick={actions.leave}>
          Sign out of this browser
        </Key>
      </Head>
      {problem ? (
        <div className="notice" data-st="failed" role="alert">
          <State state="failed" word="Check failed" />
          <p>{problem}</p>
        </div>
      ) : null}
      {data?.notice ? (
        <div className="notice" data-st="waiting" role="status">
          <State state="waiting" word="Needs you" />
          <p>A passkey was added to your account on {date(data.notice.at)}.</p>
          <Key size="sm" onClick={actions.acknowledge}>
            Seen
          </Key>
        </div>
      ) : null}
      <div className="panes access-frame">
        <Region
          title="Devices"
          count={data?.devices.length}
          hint="agents act through these, never beyond you"
        >
          {!data ? (
            <p className="quietline" aria-busy="true">
              Loading devices…
            </p>
          ) : !data.devices.length ? (
            <div className="empty">
              <h3>No device yet</h3>
              <p>
                Run <code>nforge login</code> where your agent works, then approve the code it prints.
              </p>
            </div>
          ) : (
            data.devices.map(d => (
              <div key={d.credentialId}>
                <Row cols="auto minmax(0,1fr) auto" className="access-device">
                  <Key
                    kind="ghost"
                    size="sm"
                    aria-label={`${open === d.credentialId ? 'Fold' : 'Open'} device ${d.name}`}
                    aria-expanded={open === d.credentialId}
                    onClick={() => setOpen(open === d.credentialId ? null : d.credentialId)}
                  >
                    {open === d.credentialId ? '−' : '+'}
                  </Key>
                  <div>
                    <q dir="auto" translate="no">
                      {d.name}
                    </q>
                    <span className="sub">
                      {d.revoked
                        ? 'Signed out'
                        : d.expiresAt <= now
                          ? 'Sign-in expired'
                          : `Signed in until ${date(d.expiresAt)}`}
                    </span>
                  </div>
                  <span className="meta">
                    {d.scope === 'coordination' ? 'Coordination only' : 'May write'}
                    <br />
                    approved {date(d.issuedAt)}
                  </span>
                </Row>
                {open === d.credentialId ? (
                  <div className="access-detail">
                    <Row cols="minmax(0,1fr) auto">
                      <span>
                        Name <q dir="auto">{d.name}</q>
                      </span>
                      <Key size="sm" kind="ghost" onClick={() => edit(d.credentialId, d.name)}>
                        Rename
                      </Key>
                    </Row>
                    {editing === d.credentialId ? (
                      <form
                        className="pad access-edit"
                        onSubmit={event => {
                          event.preventDefault();
                          actions.renameDevice(d.credentialId, name);
                          setEditing(null);
                        }}
                      >
                        <label className="f">
                          Name
                          <input
                            className="inp"
                            value={name}
                            onChange={e => setName(e.target.value)}
                            maxLength={80}
                          />
                        </label>
                        <Key type="submit" disabled={busy}>
                          Save the name
                        </Key>
                      </form>
                    ) : null}
                    <div className="pad">
                      <Key disabled={busy || d.revoked} onClick={() => actions.endDevice(d.credentialId)}>
                        Sign out this device
                      </Key>
                    </div>
                  </div>
                ) : null}
              </div>
            ))
          )}
          {data && !data.isDone ? (
            <div className="pad">
              <Key size="sm" onClick={actions.more}>
                Next 20 devices
              </Key>
            </div>
          ) : null}
          <Band title="Browsers" count={data?.sessions.length} hint="a sign-out works at once" />
          {data?.sessions.map(s => (
            <Row key={s.sessionId} cols="minmax(0,1fr) auto" className="access-browser">
              <div>
                <span className="ttl">{s.current ? 'This browser' : 'Browser session'}</span>
                <span className="sub">
                  Signed in {date(s.creationTime)}
                  <br />
                  Last active {date(s.lastRefreshedAt)}
                </span>
              </div>
              {s.current ? (
                <State state="passed" word="Done">
                  This browser
                </State>
              ) : (
                <span className="meta">Signed in</span>
              )}
            </Row>
          ))}
        </Region>
        <div>
          <Region title="Ways in" count={data ? data.passkeys.length + (data.github ? 1 : 0) : undefined}>
            {data?.passkeys.map(k => (
              <div key={k.passkeyId}>
                <Row cols="minmax(0,1fr) auto">
                  <div>
                    <span className="ttl">Passkey: {k.name ?? 'Unnamed'}</span>
                    <span className="sub">Made {date(k.createdAt)}</span>
                  </div>
                  <Key size="sm" kind="ghost" onClick={() => edit(k.passkeyId, k.name ?? '')}>
                    Change
                  </Key>
                </Row>
                {editing === k.passkeyId ? (
                  <form
                    className="pad access-edit"
                    onSubmit={e => {
                      e.preventDefault();
                      actions.rename(k.passkeyId, name);
                      setEditing(null);
                    }}
                  >
                    <label className="f">
                      Passkey name
                      <input
                        className="inp"
                        value={name}
                        onChange={e => setName(e.target.value)}
                        maxLength={50}
                      />
                    </label>
                    <div className="btns">
                      <Key type="submit" disabled={busy}>
                        Save the name
                      </Key>
                      <Key kind="danger" disabled={busy} onClick={() => actions.remove(k.passkeyId)}>
                        Remove this passkey
                      </Key>
                      <Key kind="ghost" onClick={() => setEditing(null)}>
                        Keep it
                      </Key>
                    </div>
                  </form>
                ) : null}
              </div>
            ))}
            {data?.github ? (
              <Row cols="minmax(0,1fr)">
                <div>
                  <span className="ttl">
                    GitHub: <span className="mono">{data.github}</span>
                  </span>
                  <span className="sub">Linked to this account</span>
                </div>
              </Row>
            ) : null}
            <div className="pad">
              <Key onClick={actions.add} disabled={busy || !data?.passkeys.length}>
                Add a passkey
              </Key>
              {data && !data.passkeys.length ? (
                <a className="btn" href="/-/signin/passkey">
                  Add your first passkey
                </a>
              ) : null}
            </div>
          </Region>
          {handle ? (
            <Region title="Handle">
              <Row cols="minmax(0,1fr)">
                <div className="mono">@{handle}</div>
              </Row>
            </Region>
          ) : null}
          <Region title="Your data and account" weight="ref">
            <p className="quietline">
              Your account is in{' '}
              <a className="lk" href="/-/account/data">
                Your data
              </a>
              .
            </p>
            <p className="quietline">
              <a className="lk" href="/-/terms">
                Terms
              </a>{' '}
              ·{' '}
              <a className="lk" href="/-/privacy">
                Privacy policy
              </a>
            </p>
          </Region>
        </div>
      </div>
    </>
  );
}
