import { ErrorToast } from '../ui/Toast';
// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { ownerDecisionState, ownerRecovery } from './owner-decision-model';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import type { Id } from '../../../convex/_generated/dataModel';
import { api } from '../../../convex/_generated/api';
import { Button, StatusPill } from '../ui/primitives';
import { hostedError } from '../snapshot';
import { useNow } from '../shell/StatusBar';
export type OwnerStatus = FunctionReturnType<typeof api.ownerAcceptance.status>;
/** Local receipts are the only completion signal for a bound native owner. */
export function OwnerDecision({
  projectId,
  viewId,
  head,
  status,
  disabled,
  channel = 'main',
  showReceipt = true,
  onRequested,
}: {
  projectId: Id<'hostedProjects'>;
  viewId: string;
  head: string;
  status: OwnerStatus;
  disabled: boolean;
  channel?: string;
  showReceipt?: boolean;
  onRequested?: (operationId: string) => void;
}) {
  const request = useMutation(api.ownerAcceptance.request),
    now = useNow();
  const [attempt, setAttempt] = useState<FunctionArgs<typeof api.ownerAcceptance.request> | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [requestedId, setRequestedId] = useState('');
  const [recheckSent, setRecheckSent] = useState(false);
  const recheckStatus = useQuery(api.ownerAcceptance.status, { projectId, viewId, channel: 'recheck' });
  const optimistic = Boolean(requestedId && requestedId !== status.request?.operationId);
  const pending = status.request?.state === 'requested' || optimistic;
  const accepted = status.request?.state === 'accepted';
  const recent = status.machine && now - status.machine.lastSeen < 30_000;
  const accept = async (recheck = false) => {
    const pinned = attempt ?? {
      projectId,
      viewId,
      head,
      operationId: crypto.randomUUID(),
      expectedMain: status.mainHead,
      channel: recheck ? 'recheck' : channel,
      ...(recheck ? { recheck: true as const } : {}),
    };
    setAttempt(pinned);
    setBusy(true);
    setError('');
    try {
      await request(pinned);
      setAttempt(null);
      if (pinned.recheck) setRecheckSent(true);
      else {
        setRequestedId(pinned.operationId);
        onRequested?.(pinned.operationId);
      }
    } catch (e) {
      setError(hostedError(e));
    } finally {
      setBusy(false);
    }
  };
  // A reactive terminal receipt supersedes the immediate "Requested" acknowledgement.
  const waiting =
    optimistic || (pending && status.request?.state !== 'accepted' && status.request?.state !== 'rejected');
  const receipt = status.request?.receipt ? JSON.parse(status.request.receipt) : null;
  const decision = ownerDecisionState({
    ...(status.request ? { state: status.request.state } : {}),
    ...(status.machine ? { machineName: status.machine.name } : {}),
    optimistic,
  });
  const recovery = ownerRecovery(receipt);
  const recheckReceipt = recheckStatus?.request?.receipt ? JSON.parse(recheckStatus.request.receipt) : null;
  const recheckPending = recheckSent || Boolean(recheckStatus?.request);
  return (
    <div className="fx-decide-go fx-owner-decision">
      {(status.request || optimistic) && (
        <p role="status">
          <StatusPill tone={decision.tone}>{decision.label}</StatusPill>
          {!optimistic && status.request?.state === 'rejected' && receipt?.reason && (
            <ErrorToast error={receipt.reason} />
          )}
        </p>
      )}
      {accepted && showReceipt && (
        <details>
          <summary>Local acceptance receipt</summary>
          <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {JSON.stringify(receipt, null, 2)}
          </pre>
        </details>
      )}
      {!accepted && !waiting && (!status.request || attempt || recovery !== 'none') && !recheckPending && (
        <Button
          variant="primary"
          size="lg"
          disabled={disabled || busy}
          onClick={() => void accept(Boolean(attempt?.recheck) || recovery === 'recheck')}
        >
          {busy
            ? 'Requesting…'
            : attempt
              ? 'Retry request'
              : recovery === 'recheck'
                ? 'Re-check on latest main'
                : status.request?.state === 'rejected'
                  ? 'Request again'
                  : 'Accept into main'}
        </Button>
      )}
      {recheckPending && (
        <p role="status" className="fx-owner-reason">
          {recheckReceipt?.status === 'accepted' ? (
            'Re-check queued'
          ) : recheckReceipt?.status === 'rejected' ? (
            <ErrorToast error={recheckReceipt.reason} />
          ) : recheckStatus?.machine ? (
            `Re-check requested · Waiting for ${recheckStatus.machine.name}`
          ) : (
            'Re-check requested'
          )}
        </p>
      )}
      {!accepted && !recent && (
        <details>
          <summary>Connect owner machine</summary>
          <p>
            {status.machine
              ? `${status.machine.name} has not been seen recently.`
              : 'No owner machine has been seen yet.'}{' '}
            On the owner, run{' '}
            <code style={{ overflowWrap: 'anywhere' }}>
              {status.machine?.command ?? 'nforge host ROOT --listen'}
            </code>
            .{!status.machine && ' ROOT is the canonical owner directory.'}
          </p>
        </details>
      )}
      {error && <ErrorToast>{error}</ErrorToast>}
    </div>
  );
}
