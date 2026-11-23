// SPDX-License-Identifier: Apache-2.0
// Report abuse (Item b6588425 line 2): one sheet for a project, a message, a comment or an account. The report goes to
// the Forge operator, not to the project; it is one write (convex/abuseReports.ts). One operation id per open sheet, so
// a retry from it is the same report.
import { useId, useState, type FormEvent } from 'react';
import { useMutation } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';
import { Key, Sheet } from '../ds';
import { hostedError } from '../snapshot';
import { ABUSE_REASON_CHARACTERS, type AbuseReportInput } from '../../../src/hosted-record-input';

export type ReportTarget = Omit<AbuseReportInput, 'reason'>;

const noun: Record<ReportTarget['target'], string> = {
  project: 'this project',
  message: 'this message',
  comment: 'this comment',
  account: 'this account',
};

export function ReportSheet({
  projectId,
  target,
  close,
}: {
  projectId?: Id<'hostedProjects'> | undefined;
  target: ReportTarget;
  close: () => void;
}) {
  const send = useMutation(api.abuseReports.report);
  const form = useId();
  const [operationId] = useState(() => crypto.randomUUID());
  const [reason, setReason] = useState('');
  const [state, setState] = useState<'editing' | 'sending' | 'sent'>('editing');
  const [error, setError] = useState('');
  const ready = state === 'editing' && reason.trim().length > 0;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setState('sending');
    setError('');
    try {
      await send({
        ...(projectId ? { projectId } : {}),
        request: JSON.stringify({ ...target, reason: reason.trim(), operationId }),
      });
      setState('sent');
    } catch (failure) {
      setError(hostedError(failure));
      setState('editing');
    }
  };
  return (
    <Sheet
      open
      title={`Report ${noun[target.target]}`}
      onOpenChange={open => {
        if (!open && state !== 'sending') close();
      }}
      footer={
        state === 'sent' ? (
          <Key kind="ghost" onClick={close}>
            Close
          </Key>
        ) : (
          <>
            <Key kind="ghost" disabled={state === 'sending'} onClick={close}>
              Keep it
            </Key>
            <Key kind="primary" type="submit" form={form} disabled={!ready}>
              {state === 'sending' ? 'Sending…' : 'Send report'}
            </Key>
          </>
        )
      }
    >
      {state === 'sent' ? (
        <p role="status">Sent to the Forge operator. Nothing changes until they review it.</p>
      ) : (
        <form id={form} className="report-abuse" onSubmit={submit}>
          <label>
            <span>What is wrong? Only the Forge operator reads this.</span>
            <textarea
              className="inp"
              rows={4}
              maxLength={ABUSE_REASON_CHARACTERS}
              value={reason}
              onChange={event => setReason(event.target.value)}
              disabled={state === 'sending'}
              dir="auto"
            />
          </label>
          {error ? (
            <p className="pf" role="alert">
              {error}
            </p>
          ) : null}
        </form>
      )}
    </Sheet>
  );
}
