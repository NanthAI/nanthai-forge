import { ErrorToast } from '../ui/Toast';
import { useDraft } from './draft';
// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import type { CoordinationCommand } from '../../../src/coordination-types';
import type { Session } from '../coordination-view';
import { Button } from '../ui/primitives';
import { Sheet } from '../ui/Sheet';
/** Session-scoped communication; a local copy is labelled separately from a sent message. */
export function MessageComposer({
  session,
  kind,
  send,
  close,
}: {
  session: Session;
  kind: 'message' | 'handoff';
  send?: (command: CoordinationCommand) => Promise<unknown>;
  close: () => void;
}) {
  const [text, setText] = useDraft(`session:${session.sessionId}:${kind}`),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [status, setStatus] = useState('');
  const deliver = send && (kind !== 'handoff' || Boolean(session.context.head));
  const title = `${kind === 'handoff' ? 'Hand off to' : 'Message'} ${session.name}`;
  return (
    <Sheet title={title} onClose={close} compact width={480}>
      <form
        className="fx-compose"
        onSubmit={event => {
          event.preventDefault();
          if (busy || !text.trim()) return;
          setBusy(true);
          setError('');
          const command: CoordinationCommand =
            kind === 'handoff' && session.context.head
              ? {
                  kind: 'handoff',
                  to: session.sessionId,
                  summary: text.trim(),
                  head: session.context.head,
                  ...(session.context.laneId ? { laneId: session.context.laneId } : {}),
                  ...(session.context.intentId ? { intentId: session.context.intentId } : {}),
                }
              : {
                  kind: 'message',
                  recipient: session.sessionId,
                  text: text.trim(),
                  context: session.context,
                };
          void (
            deliver
              ? send!(command)
              : navigator.clipboard.writeText(
                  `${title}\n${text.trim()}\n${session.context.laneId ? `Lane: ${session.context.laneId}` : ''}\nHead: ${session.context.head ?? 'not reported'}`,
                )
          )
            .then(() => {
              setStatus(deliver ? `Sent to ${session.name}` : `Paste it into ${session.name}'s session.`);
              setText('');
            })
            .catch(e => setError((e as Error).message))
            .finally(() => setBusy(false));
        }}
      >
        <label>
          Message
          <textarea
            className="fx-input"
            disabled={busy}
            autoFocus
            rows={4}
            value={text}
            onChange={e => setText(e.target.value)}
          />
        </label>
        <Button type="submit" disabled={busy || !text.trim()}>
          {busy
            ? deliver
              ? 'Sending…'
              : 'Copying…'
            : deliver
              ? kind === 'handoff'
                ? 'Send handoff'
                : 'Send'
              : 'Copy message'}
        </Button>
        {status && (
          <p className="fx-panel-note fx-flush" role="status">
            {status}
          </p>
        )}
        <ErrorToast error={error} />
      </form>
    </Sheet>
  );
}
