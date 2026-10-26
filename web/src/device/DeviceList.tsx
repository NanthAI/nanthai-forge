import { ErrorToast } from '../ui/Toast';
// SPDX-License-Identifier: Apache-2.0
import { useRef, useState } from 'react';
import { useMutation, usePaginatedQuery } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import { hostedError } from '../snapshot';
import { useNow } from '../shell/StatusBar';
import { Glyph } from '../ui/Glyph';
import { Button, Panel } from '../ui/primitives';

export type DeviceRow = {
  id: string;
  credentialId: string;
  name: string;
  scope: string;
  expiresAt: number;
  revoked: boolean;
};

const dateWords = (at: number) =>
  new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/** Terminals signed in as this account, with a two-step revoke. Revoked and expired ones fold away. */
export function DeviceListView({
  rows,
  now,
  revoke,
  more,
}: {
  rows: readonly DeviceRow[];
  now: number;
  revoke: (row: DeviceRow) => Promise<void>;
  more?: () => void;
}) {
  const [confirming, setConfirming] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [showOld, setShowOld] = useState(false);
  const active = rows.filter(row => !row.revoked && row.expiresAt > now);
  const old = rows.filter(row => row.revoked || row.expiresAt <= now);
  const row = (device: DeviceRow) => {
    const live = !device.revoked && device.expiresAt > now;
    return (
      <li key={device.id} className={live ? 'fx-dl-row' : 'fx-dl-row fx-dl-old'}>
        <span className="fx-dl-icon" aria-hidden="true">
          <Glyph name="terminal" size={14} />
        </span>
        <span className="fx-dl-main">
          <b title={device.name}>{device.name}</b>
          <small>
            {device.scope === 'cli' ? 'Terminal access' : 'Coordination only'} ·{' '}
            {device.revoked
              ? 'revoked'
              : live
                ? `until ${dateWords(device.expiresAt)}`
                : `expired ${dateWords(device.expiresAt)}`}
          </small>
        </span>
        {live &&
          (confirming === device.credentialId ? (
            <span className="fx-dl-confirm">
              <span>Stops working now.</span>
              <Button
                size="sm"
                variant="danger"
                disabled={busy === device.credentialId}
                onClick={() => {
                  setBusy(device.credentialId);
                  setError('');
                  revoke(device)
                    .then(() => setConfirming(''))
                    .catch(e => setError(hostedError(e)))
                    .finally(() => setBusy(''));
                }}
              >
                {busy === device.credentialId ? 'Revoking…' : 'Revoke'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming('')}>
                Cancel
              </Button>
            </span>
          ) : (
            <Button size="sm" onClick={() => setConfirming(device.credentialId)}>
              Revoke
            </Button>
          ))}
      </li>
    );
  };
  return (
    <Panel title="Signed-in devices" count={active.length} className="fx-dl">
      {active.length === 0 ? (
        <p className="fx-dl-empty">
          No terminals are signed in. Run <code>nforge login</code> to add one.
        </p>
      ) : (
        <ul className="fx-dl-list">{active.map(row)}</ul>
      )}
      {old.length > 0 && (
        <>
          <button
            type="button"
            className="fx-fold"
            aria-expanded={showOld}
            onClick={() => setShowOld(!showOld)}
          >
            <Glyph name={showOld ? 'down' : 'chevron'} size={12} />
            {old.length} revoked or expired
          </button>
          {showOld && <ul className="fx-dl-list">{old.map(row)}</ul>}
        </>
      )}
      {more && (
        <div className="fx-panel-f">
          <Button size="sm" variant="ghost" onClick={more}>
            More devices
          </Button>
        </div>
      )}
      {error && (
        <div className="fx-dl-error">
          <ErrorToast>{error}</ErrorToast>
        </div>
      )}
    </Panel>
  );
}

/** Account settings: the signed-in devices list. Each revoke keeps its operation id until it succeeds. */
export function DeviceCredentials() {
  const { results, status, loadMore } = usePaginatedQuery(
    api.deviceCredentials.list,
    {},
    { initialNumItems: 20 },
  );
  const revoke = useMutation(api.deviceCredentials.revoke);
  const attempts = useRef(new Map<string, string>());
  const now = useNow(60_000);
  return (
    <div className="fx fx-dl-wrap">
      <DeviceListView
        rows={results}
        now={now}
        revoke={async row => {
          const operationId = attempts.current.get(row.credentialId) ?? crypto.randomUUID();
          attempts.current.set(row.credentialId, operationId);
          await revoke({ credentialId: row.credentialId, operationId });
          attempts.current.delete(row.credentialId);
        }}
        {...(status === 'CanLoadMore' ? { more: () => loadMore(20) } : {})}
      />
    </div>
  );
}
