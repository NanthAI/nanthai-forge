import { Menu } from '../ui/Menu';
import { LifecycleDialog } from './LifecycleDialog';
import { ErrorToast } from '../ui/Toast';
// SPDX-License-Identifier: Apache-2.0
import './owner-lifecycle.css';
import { useState, type ReactNode } from 'react';
import { useMutation, useQuery } from 'convex/react';
import type { Id } from '../../../convex/_generated/dataModel';
import { api } from '../../../convex/_generated/api';
import type { OwnerLifecycle as Command } from '../../../src/owner-lifecycle-schema';
import { Button, StatusPill } from '../ui/primitives';
import { hostedError } from '../snapshot';
type LifecycleProps = {
  projectId: Id<'hostedProjects'>;
  collection: 'lanes' | 'intents';
  id: string;
  head: string;
  state: string;
  editable: boolean;
};

/** Menu items, request status and dialog, so a page can place them in its own ⋯ menu and banner. */
export type LifecycleParts = {
  items: ReactNode;
  status: ReactNode;
  dialog: ReactNode;
  /** Opens the Abandon dialog; absent when the record is closed or a request is in flight. */
  abandon?: () => void;
  complete?: () => void;
  reopen?: () => void;
};

/** The same owner queue as acceptance, with terminal lifecycle receipts kept distinct. */
export function OwnerLifecycle(props: LifecycleProps) {
  const parts = useOwnerLifecycle(props);
  if (!parts) return null;
  return (
    <>
      <Menu label="Lifecycle">{parts.items}</Menu>
      {parts.status}
      {parts.dialog}
    </>
  );
}

export function useOwnerLifecycle({
  projectId,
  collection,
  id,
  head,
  state,
  editable,
}: LifecycleProps): LifecycleParts | null {
  const status = useQuery(api.ownerAcceptance.status, { projectId, viewId: id, channel: 'lifecycle' });
  const request = useMutation(api.ownerLifecycle.request);
  const [reason, setReason] = useState(''),
    [saveFirst, setSaveFirst] = useState(false),
    [cascade, setCascade] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [pending, setPending] = useState<{
    projectId: Id<'hostedProjects'>;
    operationId: string;
    command: string;
  } | null>(null);
  const [sent, setSent] = useState(false);
  const [dialog, setDialog] = useState<Command['action'] | null>(null);
  if (!editable || !status?.native || state === 'creating') return null;
  const closed = state === 'completed' || state === 'abandoned';
  const receipt = status.request?.receipt ? JSON.parse(status.request.receipt) : null;
  const waiting = status.request?.state === 'requested' || (sent && !status.request);
  const run = async (action: Command['action']) => {
    const original = pending ?? {
      projectId,
      operationId: crypto.randomUUID(),
      command: JSON.stringify({
        action,
        collection,
        id,
        expectedHead: head,
        expectedState: state,
        reason,
        saveFirst,
        cascade,
      }),
    };
    setPending(original);
    setBusy(true);
    setError('');
    try {
      await request(original);
      setPending(null);
      setSent(true);
      setDialog(null);
    } catch (e) {
      setError(hostedError(e));
    } finally {
      setBusy(false);
    }
  };
  return {
    ...(!pending && !waiting
      ? { complete: () => setDialog('complete'), reopen: () => void run('reopen') }
      : {}),
    items: pending ? (
      <Button disabled={busy} onClick={() => void run('complete')}>
        Retry request
      </Button>
    ) : (
      !waiting && (
        <>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => (closed ? void run('reopen') : setDialog('complete'))}
          >
            {closed ? 'Reopen' : 'Mark complete'}
          </Button>
          {!closed && (
            <Button variant="ghost" data-destructive disabled={busy} onClick={() => setDialog('abandon')}>
              Abandon…
            </Button>
          )}
        </>
      )
    ),
    ...(!pending && !waiting && !closed ? { abandon: () => setDialog('abandon') } : {}),
    status: (status.request || sent) && (
      <span role="status">
        <StatusPill tone={receipt?.status === 'rejected' ? 'failed' : receipt ? 'plain' : 'waiting'}>
          {receipt?.status === 'rejected'
            ? 'Not applied'
            : receipt
              ? 'Applied on owner'
              : status.machine
                ? `Waiting for ${status.machine.name}`
                : 'Requested'}
        </StatusPill>
        {receipt?.status === 'rejected' && <ErrorToast error={receipt.reason} />}
      </span>
    ),
    dialog: (
      <>
        {dialog && (
          <LifecycleDialog
            action={dialog === 'abandon' ? 'abandon' : 'complete'}
            collection={collection}
            reason={reason}
            setReason={setReason}
            saveFirst={saveFirst}
            setSaveFirst={setSaveFirst}
            cascade={cascade}
            setCascade={setCascade}
            busy={busy}
            submit={() => void run(dialog)}
            close={() => setDialog(null)}
          />
        )}
        {error && <ErrorToast>{error}</ErrorToast>}
      </>
    ),
  };
}
