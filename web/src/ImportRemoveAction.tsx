// SPDX-License-Identifier: Apache-2.0
import { useRef, useState } from 'react';
import { useConvex } from 'convex/react';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { Menu } from './ui/Menu';
import { Sheet } from './ui/Sheet';
import { Button } from './ui/primitives';
import { ErrorToast } from './ui/Toast';
import { hostedError } from './snapshot';

export function ImportRemoveAction({ id, repository }: { id: Id<'imports'>; repository: string }) {
  const client = useConvex();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const operation = useRef<string | null>(null);
  async function remove() {
    operation.current ??= crypto.randomUUID();
    setBusy(true);
    setError('');
    try {
      await client.mutation(api.importRemoval.remove, { importId: id, operationId: operation.current });
      setConfirm(false);
    } catch (e) {
      setError(hostedError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Menu label="•••" ariaLabel={`Actions for ${repository}`}>
        <a href={`/?surface=projects&repositorySettings=${id}`}>Settings</a>
        <button data-destructive onClick={() => setConfirm(true)}>
          Remove
        </button>
      </Menu>
      {confirm && (
        <Sheet compact title={`Remove ${repository}?`} width={480} onClose={() => setConfirm(false)}>
          <p>This removes the analysis for everyone it is shared with. The GitHub repository is untouched.</p>
          <p>The analysis and its saved views cannot be restored.</p>
          <div className="fx-import-remove-actions">
            <Button onClick={() => setConfirm(false)}>Cancel</Button>
            <Button variant="danger" disabled={busy} onClick={() => void remove()}>
              {busy ? 'Removing…' : error ? 'Retry removal' : 'Remove analysis'}
            </Button>
          </div>
          {error && <ErrorToast>{error}</ErrorToast>}
        </Sheet>
      )}
    </>
  );
}
