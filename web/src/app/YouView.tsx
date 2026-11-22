// SPDX-License-Identifier: Apache-2.0
import { DeviceSettings } from './DeviceSettings';
import type { DeviceSettings as Settings } from './access-contract';
import { useState, type ReactNode } from 'react';
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
    code?: string;
    approvedAt?: number;
    removed?: boolean;
    approvalExpired?: boolean;
    settings?: Settings;
  }[];
  github: string | null;
  notice: { at: number; passkeyId: string } | null;
  deviceNotice?: { at: number; credentialId: string; signInId: string };
  isDone: boolean;
  continueCursor: string;
};
const date = (value: number) =>
  new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
type Actions = {
  leave: () => void;
  more: () => void;
  acknowledge: () => void;
  acknowledgeDevice?: () => void;
  revoke: (includeDevices?: boolean) => void;
  github: (includeDevices?: boolean) => void;
  add: () => void;
  rename: (id: string, name: string) => void;
  remove: (id: string) => void;
  renameDevice: (id: string, name: string) => void;
  endDevice: (id: string) => void;
  removeDevice?: (id: string) => void;
  projectChoice?: (select: (projectId: string, name: string) => void) => ReactNode;
  configureDevice?: (id: string, name: string, settings: Settings) => void;
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
  const [includeDevices, setIncludeDevices] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [configuring, setConfiguring] = useState<string | null>(null);
  const [projectName, setProjectName] = useState<string | null>(null);
  const [pickingProject, setPickingProject] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const sentence = data
    ? `You are signed in on ${data.sessions.length} ${data.sessions.length === 1 ? 'browser' : 'browsers'} shown here and have ${data.devices.length}${data.isDone ? '' : ' shown'} ${data.devices.length === 1 ? 'device' : 'devices'}.`
    : 'Loading your sign-ins and devices…';
  const edit = (id: string, value: string) => {
    setEditing(id);
    setName(value);
  };
  return (
    <>
      <Head trail={[{ label: 'You' }]} sentence={sentence}>
        <Key onClick={() => actions.revoke(includeDevices)} disabled={busy || !data?.passkeys.length}>
          Sign out other sessions
        </Key>
        {data?.github ? (
          <Key onClick={() => actions.github(includeDevices)} disabled={busy}>
            Check with GitHub and sign out other sessions
          </Key>
        ) : null}
        <label className="btn">
          <input
            type="checkbox"
            className="ckb"
            checked={includeDevices}
            onChange={e => setIncludeDevices(e.target.checked)}
            disabled={busy}
          />
          Also sign out all devices
        </label>
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
      {data?.deviceNotice ? (
        <div className="notice" data-st="waiting" role="status">
          <State state="waiting" word="Needs you" />
          <p>A device was approved on {date(data.deviceNotice.at)}. Check your devices below.</p>
          <Key size="sm" onClick={actions.acknowledgeDevice}>
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
                    aria-label={`${open === d.credentialId ? 'Fold' : 'Open'} device ${d.name || d.code || 'removed device'}`}
                    aria-expanded={open === d.credentialId}
                    onClick={() => setOpen(open === d.credentialId ? null : d.credentialId)}
                  >
                    {open === d.credentialId ? '−' : '+'}
                  </Key>
                  <div>
                    <q dir="auto" translate="no">
                      {d.name || d.code || 'Removed device'}
                    </q>
                    <span className="sub">
                      {d.removed
                        ? 'Removed'
                        : d.revoked
                          ? 'Signed out'
                          : d.approvalExpired
                            ? 'Approve again in your browser'
                            : d.expiresAt <= now
                              ? d.code
                                ? 'Renews on its next command'
                                : 'Sign-in expired'
                              : `Signed in until ${date(d.expiresAt)}`}
                    </span>
                  </div>
                  <span className="meta">
                    {d.settings?.source === 'read'
                      ? 'Read only'
                      : d.scope === 'coordination'
                        ? 'Coordination only'
                        : 'May write'}
                    <br />
                    {d.code && (
                      <>
                        <span className="dcode">{d.code}</span>
                        <br />
                      </>
                    )}
                    approved {date(d.approvedAt ?? d.issuedAt)}
                  </span>
                </Row>
                {open === d.credentialId ? (
                  <div className="access-detail">
                    <Row cols="minmax(0,1fr) auto">
                      <span>
                        Name <q dir="auto">{d.name}</q>
                      </span>
                      <Key
                        size="sm"
                        kind="ghost"
                        disabled={busy || d.removed}
                        onClick={() => edit(d.credentialId, d.name)}
                      >
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
                    {d.code && (
                      <>
                        <Row cols="120px minmax(0,1fr)">
                          <span className="t2">Code</span>
                          <span>
                            <span className="dcode">{d.code}</span>
                            <span className="sub">
                              From the key on this device. <code>nforge agent . whoami</code> prints the same
                              reference.
                            </span>
                          </span>
                        </Row>
                        {d.settings && actions.configureDevice && (
                          <Row cols="120px minmax(0,1fr) auto">
                            <span className="t2">Agents may write</span>
                            <span>
                              {d.settings.source === 'write'
                                ? 'They can start Lanes, save and land with a check.'
                                : d.settings.source === 'read'
                                  ? 'They read and cannot change work.'
                                  : 'They see who is working and wait their turn.'}
                            </span>
                            <input
                              className="sw"
                              type="checkbox"
                              role="switch"
                              aria-label="Agents on this device may write"
                              checked={d.settings.source === 'write'}
                              disabled={busy || d.removed}
                              onChange={event =>
                                actions.configureDevice?.(d.credentialId, d.name, {
                                  ...d.settings!,
                                  source: event.target.checked ? 'write' : 'read',
                                })
                              }
                            />
                          </Row>
                        )}
                        <Row cols="120px minmax(0,1fr)">
                          <span className="t2">Without a check</span>
                          <span>Never. An agent needs a passing check.</span>
                        </Row>
                        <Row cols="120px minmax(0,1fr)">
                          <span className="t2">Sign-in</span>
                          <span>
                            {d.removed
                              ? 'Removed'
                              : d.revoked
                                ? 'Signed out; its name and settings are kept.'
                                : `30 days, renewed while the device is in use.`}
                          </span>
                        </Row>
                        <Row cols="120px minmax(0,1fr)">
                          <span className="t2">Last sign-in issued</span>
                          <span>{date(d.issuedAt)}</span>
                        </Row>
                        <Row cols="120px minmax(0,1fr)">
                          <span className="t2">Approved</span>
                          <span>{date(d.approvedAt ?? d.issuedAt)}, by you.</span>
                        </Row>
                      </>
                    )}
                    {d.settings && actions.configureDevice && !d.removed && (
                      <>
                        {configuring === d.credentialId && settings ? (
                          <form
                            onSubmit={event => {
                              event.preventDefault();
                              actions.configureDevice?.(d.credentialId, d.name, settings);
                              setConfiguring(null);
                            }}
                          >
                            <DeviceSettings
                              projectName={projectName}
                              value={settings}
                              change={setSettings}
                              disabled={busy}
                            />
                            {actions.projectChoice && (
                              <div className="pad">
                                <Key size="sm" onClick={() => setPickingProject(!pickingProject)}>
                                  Choose a project…
                                </Key>
                              </div>
                            )}
                            {pickingProject &&
                              actions.projectChoice?.((projectId, name) => {
                                setProjectName(name);
                                setSettings({ ...settings, projects: { kind: 'project', projectId } });
                                setPickingProject(false);
                              })}
                            <div className="pad btns">
                              <Key type="submit" disabled={busy}>
                                Save settings
                              </Key>
                              <Key type="button" onClick={() => setConfiguring(null)}>
                                Cancel
                              </Key>
                            </div>
                          </form>
                        ) : (
                          <div className="pad">
                            <Key
                              size="sm"
                              onClick={() => {
                                setConfiguring(d.credentialId);
                                setSettings(d.settings!);
                              }}
                            >
                              Change settings
                            </Key>
                            <p className="sub">
                              {d.settings.projects.kind === 'all'
                                ? 'Every project you can reach'
                                : 'The approved project only'}
                              . Changes apply to this device’s next command.
                            </p>
                          </div>
                        )}
                      </>
                    )}
                    <div className="pad btns">
                      <Key disabled={busy || d.revoked} onClick={() => actions.endDevice(d.credentialId)}>
                        Sign out this device
                      </Key>
                      {d.code && actions.removeDevice && (
                        <Key
                          kind="danger"
                          disabled={busy || d.removed}
                          onClick={() => actions.removeDevice?.(d.credentialId)}
                        >
                          Remove this device
                        </Key>
                      )}
                      {d.code && (
                        <p className="sub">
                          Signing out keeps its key, name and settings. Removing it revokes its key and drops
                          its settings; approve a new key to use it again.
                        </p>
                      )}
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
                <a className="btn" href="/signin/passkey">
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
              <a className="lk" href="/account/data">
                Your data
              </a>
              .
            </p>
            <p className="quietline">
              <a className="lk" href="/terms">
                Terms
              </a>{' '}
              ·{' '}
              <a className="lk" href="/privacy">
                Privacy policy
              </a>
            </p>
          </Region>
        </div>
      </div>
    </>
  );
}
