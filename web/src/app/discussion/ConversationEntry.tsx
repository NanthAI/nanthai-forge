// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { Key } from '../../ds';
import { COORDINATION_LIMITS } from '../../../../src/coordination-types';
import './conversation.css';
import { RecordedWho } from '../RecordedWho';
import { recordedIdentity, type WhoProject } from '../who-links';
import type { Answer, ThreadEntry } from './conversation';

const time = (at: number) =>
  new Date(at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });

export function HandBackDetails({
  head,
  left,
  tried,
  to,
}: {
  head: string;
  left: string;
  tried: string;
  to?: string;
}) {
  return (
    <dl className="thread-handoff">
      <dt>Tried</dt>
      <dd dir="auto">{tried || 'Not reported'}</dd>
      <dt>Left to do</dt>
      <dd dir="auto">{left || 'Not reported'}</dd>
      <dt>Where the work is</dt>
      <dd>
        {head ? (
          <>
            Saved head <code>{head}</code>
          </>
        ) : (
          'Not reported'
        )}
      </dd>
      <dt>Handed to</dt>
      <dd>{recordedIdentity(to) || 'Not reported'}</dd>
    </dl>
  );
}

export function AnswerKeys({
  entry,
  choices,
  answer,
  onAnswered,
}: {
  entry: { id: string };
  choices: string[];
  answer: Answer;
  onAnswered?: (choice: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [answered, setAnswered] = useState('');
  const [failed, setFailed] = useState(false);
  const pick = async (choice: string) => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await answer(entry, choice, reason.trim());
      setAnswered(choice);
      onAnswered?.(choice);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return answered ? (
    <p role="status">Answered “{answered}”.</p>
  ) : (
    <>
      <label className="thread-reason">
        Reason (optional)
        <input
          className="inp"
          value={reason}
          onChange={e => setReason(e.target.value)}
          maxLength={COORDINATION_LIMITS.summary}
        />
      </label>
      <div className="btns">
        {choices.map(choice => (
          <Key key={choice} className="wrap" disabled={busy} onClick={() => void pick(choice)}>
            <span dir="auto">{choice}</span>
          </Key>
        ))}
      </div>
      {failed ? (
        <p role="alert" className="err">
          Could not confirm the answer. Try again or check the thread.
        </p>
      ) : null}
    </>
  );
}

export function ConversationEntry({
  row,
  answer,
  project,
}: {
  row: ThreadEntry;
  answer?: Answer;
  project?: WhoProject | undefined;
}) {
  const saved = row.answer;
  const [copy, setCopy] = useState<'copied' | 'failed'>();
  const sender = saved?.agent ?? 'the asker';
  const choice = row.type === 'hand-back' ? ['Decline'] : (row.choices ?? []);
  if (row.withdrawnAt !== undefined) return <p>Withdrawn {time(row.withdrawnAt)}.</p>;
  return (
    <>
      {row.type === 'question' ? (
        <p dir="auto">{row.text}</p>
      ) : row.type === 'handoff' ? (
        <p dir="auto">
          {row.text}{' '}
          {row.head ? (
            <span>
              Saved head <code>{row.head}</code>
            </span>
          ) : null}
        </p>
      ) : (
        <HandBackDetails
          head={row.head ?? ''}
          left={row.left ?? ''}
          tried={row.text}
          {...(row.to ? { to: row.to } : {})}
        />
      )}
      {saved ? (
        <div className="thread-answer">
          <p>
            <strong>Answer:</strong> <span dir="auto">{saved.choice}</span>{' '}
            {saved.actor ? (
              <RecordedWho handle={recordedIdentity(saved.actor)} project={project} model={null} />
            ) : null}
          </p>
          {saved.text && saved.text !== saved.choice ? <p dir="auto">{saved.text}</p> : null}
          {saved.seenAt !== undefined ? (
            <p className="t2">
              Seen by {sender} at {time(saved.seenAt)}.
            </p>
          ) : saved.resumePrompt ? (
            <>
              <p className="t2">
                {saved.lastActivity === undefined
                  ? 'The asker has yet to acknowledge this answer.'
                  : `The answer is waiting for ${sender}. Last recorded activity ${time(saved.lastActivity)}.`}
              </p>
              <Key
                size="sm"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(saved.resumePrompt!);
                    setCopy('copied');
                  } catch {
                    setCopy('failed');
                  }
                }}
              >
                Give this to your agent
              </Key>
              {copy ? (
                <p role="status">
                  {copy === 'copied'
                    ? 'Resume prompt copied.'
                    : 'Could not copy. Open the resume prompt to copy it.'}
                </p>
              ) : null}
              <details open={copy === 'failed' || undefined}>
                <summary>Resume prompt</summary>
                <p dir="auto">{saved.resumePrompt}</p>
              </details>
            </>
          ) : null}
        </div>
      ) : row.mayAnswer && answer ? (
        <AnswerKeys entry={row} choices={choice} answer={answer} />
      ) : row.type === 'question' ? (
        <p className="t2" dir="auto">
          {choice.join(' · ')}
        </p>
      ) : null}
    </>
  );
}
