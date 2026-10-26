import { ErrorToast } from '../ui/Toast';
import { useDraft } from './draft';
// SPDX-License-Identifier: Apache-2.0
import { useUnsavedInput } from '../ui/NavigationGuard';
import { useId, useState, type ReactNode } from 'react';
import {
  activityAuthor,
  eventText,
  flattenSessions,
  type ActivityEvent,
  type Session,
} from '../coordination-view';
import { Glyph, type GlyphName } from '../ui/Glyph';
import { Avatar, Button, Panel } from '../ui/primitives';
import { age } from '../ui/status';

const glyphs: Record<string, GlyphName> = {
  claim: 'claim',
  release: 'claim',
  change: 'sync',
  handoff: 'handoff',
  activity: 'agent',
};

/** One Lane's coordination thread: messages as speech, everything else as quiet system lines. */
export function Conversation({
  events,
  sessions,
  now,
  send,
  more,
  note,
  draftKey,
  loading,
  error,
}: {
  events: readonly ActivityEvent[];
  sessions: readonly Session[];
  now: number;
  send?: (text: string) => Promise<boolean>;
  more?: ReactNode;
  note?: ReactNode;
  draftKey?: string;
  loading?: boolean;
  error?: string;
}) {
  const id = useId();
  const [text, setText] = useDraft(`conversation:${draftKey ?? id}`),
    [busy, setBusy] = useState(false),
    [sendError, setSendError] = useState('');
  useUnsavedInput(Boolean(text.trim()), () => setText(''));
  const people = flattenSessions(sessions);
  const acked = new Set(
    events.flatMap(event => (event.command.kind === 'ack' ? [event.command.messageId] : [])),
  );
  const shown = events.filter(event => event.command.kind !== 'ack');
  return (
    <Panel
      title="Conversation"
      count={shown.length || undefined}
      actions={
        note ? (
          <span
            tabIndex={0}
            role="note"
            aria-label={typeof note === 'string' ? note : 'About conversation'}
            title={typeof note === 'string' ? note : undefined}
          >
            <Glyph name="info" size={12} />
          </span>
        ) : undefined
      }
    >
      {loading ? (
        <p className="fx-panel-note" role="status">
          Reading messages…
        </p>
      ) : shown.length === 0 ? (
        <p className="fx-panel-note">No messages yet.</p>
      ) : (
        <ol className="fx-thread">
          {shown.map(event => {
            const command = event.command;
            const who = activityAuthor(event, people);
            if (command.kind === 'message')
              return (
                <li key={event.operationId} className="fx-msg">
                  <Avatar name={who} kind={command.sessionId ? 'agent' : 'human'} size="sm" />
                  <div>
                    <div className="fx-msg-head">
                      <b>{who}</b>
                      <span>
                        {event.recipientActor || command.recipient
                          ? `→ ${people.find(session => session.sessionId === command.recipient)?.name ?? 'participant'}`
                          : '→ everyone on this Lane'}
                      </span>
                      <time>{age(event.at, now)}</time>
                    </div>
                    <p>{command.text}</p>
                    {
                      <span className="fx-msg-ack">
                        <Glyph name={acked.has(event.operationId) ? 'passed' : 'message'} size={10} />{' '}
                        {acked.has(event.operationId)
                          ? `Seen by ${activityAuthor(
                              events.find(
                                item =>
                                  item.command.kind === 'ack' && item.command.messageId === event.operationId,
                              )!,
                              people,
                            )} · acknowledged`
                          : 'Sent'}
                      </span>
                    }
                    {events
                      .filter(
                        item => item.command.kind === 'ack' && item.command.messageId === event.operationId,
                      )
                      .map(ack => (
                        <p key={ack.operationId} className="fx-msg-ack">
                          {ack.command.kind === 'ack'
                            ? [...new Set([ack.command.choice, ack.command.text].filter(Boolean))].join(' · ')
                            : eventText(ack)}
                        </p>
                      ))}
                  </div>
                </li>
              );
            return (
              <li key={event.operationId} className={`fx-sys fx-sys-${command.kind}`}>
                <Glyph name={glyphs[command.kind] ?? 'info'} size={12} />
                <span>
                  <b>{command.kind === 'change' ? 'Forge' : who}</b>{' '}
                  {command.kind === 'claim'
                    ? `intends to change ${command.paths.join(', ')}`
                    : command.kind === 'handoff'
                      ? `handed this Lane off: ${command.summary}`
                      : command.kind === 'activity'
                        ? `${command.status} · ${command.summary}`
                        : eventText(event)}
                </span>
                <time>{age(event.at, now)}</time>
              </li>
            );
          })}
        </ol>
      )}
      {more}
      {send && (
        <form
          className="fx-compose"
          onSubmit={event => {
            event.preventDefault();
            if (!text.trim() || busy) return;
            setBusy(true);
            setSendError('');
            void send(text.trim())
              .then(ok => ok && setText(''))
              .catch(() => setSendError('Could not send this message.'))
              .finally(() => setBusy(false));
          }}
        >
          <label htmlFor={id} className="fx-sr">
            Message everyone on this Lane
          </label>
          <textarea
            id={id}
            className="fx-input"
            disabled={busy}
            rows={1}
            maxLength={4000}
            value={text}
            placeholder="Message everyone on this Lane…"
            onChange={event => setText(event.target.value)}
          />
          <div className="fx-reply-actions">
            <Button size="sm" type="submit" disabled={busy || !text.trim()}>
              {busy ? 'Sending…' : 'Send'}
            </Button>
          </div>
          <ErrorToast error={sendError || error} />
        </form>
      )}
    </Panel>
  );
}
