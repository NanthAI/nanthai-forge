// SPDX-License-Identifier: Apache-2.0
import './account-handle.css';
import { projectRouteIdentity } from '../shell/location';
import { useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import { Panel, Button } from '../ui/primitives';
import { ErrorToast, useToast } from '../ui/Toast';
import { hostedError } from '../snapshot';
export function AccountHandle() {
  const account = useQuery(api.urlAccounts.current, {});
  return account ? (
    <HandleForm key={account.handle} initial={account.handle} />
  ) : (
    <p role="status">Reading your handle…</p>
  );
}
function HandleForm({ initial }: { initial: string }) {
  const [handle, setHandle] = useState(initial);
  const [attempt, setAttempt] = useState<{ handle: string; operationId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const validation = useQuery(api.urlAccounts.available, { handle });
  const save = useMutation(api.urlAccounts.set);
  const toast = useToast();
  const editing = handle !== initial;
  const status = validation?.includes('already taken')
    ? 'Taken'
    : validation?.includes('reserved')
      ? 'Reserved'
      : (validation ?? 'Available');
  return (
    <Panel title="Your URL">
      <form
        className="fx-handle-form"
        onSubmit={event => {
          event.preventDefault();
          const input = attempt ?? { handle, operationId: crypto.randomUUID() };
          setAttempt(input);
          setBusy(true);
          setError('');
          void save(input)
            .then(() => {
              setAttempt(null);
              toast.show({ tone: 'success', message: 'Handle changed. Old links still work.' });
            })
            .catch(e => setError(hostedError(e)))
            .finally(() => setBusy(false));
        }}
      >
        <label className="fx-handle-field">
          Handle
          <input
            value={handle}
            disabled={busy || !!attempt}
            onChange={event => setHandle(event.target.value)}
            aria-describedby={
              editing && validation !== undefined ? 'handle-preview handle-validation' : 'handle-preview'
            }
            aria-invalid={!!validation}
            autoCapitalize="none"
            spellCheck={false}
          />
        </label>
        <p id="handle-preview" className="fx-muted">
          {location.host}/{handle}/{projectRouteIdentity(location.href)?.slug ?? 'your-project'}
        </p>
        {editing && validation !== undefined && (
          <p id="handle-validation" role="status">
            {status}
          </p>
        )}
        <Button type="submit" disabled={busy || (!attempt && (validation !== null || handle === initial))}>
          {attempt ? 'Retry handle change' : 'Save handle'}
        </Button>
        {attempt && !busy && (
          <Button
            type="button"
            onClick={() => {
              setAttempt(null);
              setHandle(initial);
            }}
          >
            Use current handle
          </Button>
        )}
        {error && <ErrorToast>{error}</ErrorToast>}
      </form>
    </Panel>
  );
}
