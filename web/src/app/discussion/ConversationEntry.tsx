// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { useState } from 'react';
import { Key } from '../../ds';
import { DECLINE_HAND_BACK, HAND_TO_AGENT } from '../../../../src/coordination-hand-back';
import { COORDINATION_LIMITS } from '../../../../src/coordination-types';
import './conversation.css';
import { RecordedWho } from '../RecordedWho';
import { recordedIdentity, type WhoProject } from '../who-links';
import { answerFailureReason, type Answer, type ThreadEntry } from './conversation';

const time = (at: number) =>
  new Date(at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });

export function HandBackDetails({
  savedWork,
  showTitle = false,
  left,
  tried,
  to,
}: {
  savedWork?: ThreadEntry['savedWork'];
  showTitle?: boolean;
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
      <dd dir="auto">
        {showTitle && savedWork?.title ? <bdi>{savedWork.title} · </bdi> : null}
        Saves: {savedWork?.saves?.toLocaleString() ?? 'not reported'} · Files in saved work:{' '}
        {savedWork?.files?.toLocaleString() ?? 'not reported'}
        {' · '}Last save recorded:{' '}
        {savedWork?.lastSaveAt === undefined ? (
          'not reported'
        ) : (
          <time dateTime={new Date(savedWork.lastSaveAt).toISOString()}>{time(savedWork.lastSaveAt)}</time>
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
  handBack = false,
  onAnswered,
}: {
  entry: { id: string };
  choices: string[];
  answer: Answer;
  handBack?: boolean;
  onAnswered?: (message: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [answered, setAnswered] = useState('');
  const [failed, setFailed] = useState<string | null>(null);
  const pick = async (choice: string) => {
    if (busy) return;
    setBusy(true);
    setFailed(null);
    try {
      const prompt = await answer(entry, choice, reason.trim());
      let message = `Answered “${choice}”.`;
      if (handBack && choice === HAND_TO_AGENT) {
        try {
          if (!prompt) throw Error('Resume prompt missing');
          await navigator.clipboard.writeText(prompt);
          message = 'Resume prompt copied.';
        } catch {
          message = 'Answer saved. Open the Thread to copy the resume prompt.';
        }
      }
      setAnswered(message);
      onAnswered?.(message);
    } catch (error) {
      setFailed(answerFailureReason(error, handBack));
    } finally {
      setBusy(false);
    }
  };
  return answered ? (
    <p role="status">{answered}</p>
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
          {failed}
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
  const choices = row.choices ?? (row.type === 'hand-back' ? ['Decline'] : []);
  const handToAgent = row.type === 'hand-back' && saved?.choice === HAND_TO_AGENT;
  const canCopyPrompt = row.type !== 'hand-back' || handToAgent || saved?.choice === DECLINE_HAND_BACK;
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
          savedWork={row.savedWork}
          showTitle
          left={row.left ?? ''}
          tried={row.text}
          {...(row.to ? { to: row.to } : {})}
        />
      )}
      {row.superseded ? <p className="t2">The Lane changed after this hand-back.</p> : null}
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
            <p className="t2">
              {saved.lastActivity === undefined
                ? 'The asker has yet to acknowledge this answer.'
                : `The answer is waiting for ${sender}. Last recorded activity ${time(saved.lastActivity)}.`}
            </p>
          ) : null}
          {saved.resumePrompt && canCopyPrompt && (handToAgent || saved.seenAt === undefined) ? (
            <>
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
      ) : row.mayAnswer && !row.recipientEnded && answer && choices.length ? (
        <AnswerKeys entry={row} choices={choices} answer={answer} handBack={row.type === 'hand-back'} />
      ) : row.type === 'question' ? (
        <>
          {row.recipientEnded ? (
            <p className="t2" dir="auto">
              For {row.to ?? 'another session'} — that session ended.
            </p>
          ) : row.to ? (
            <p className="t2" dir="auto">
              For {row.to} — directed to that session.
            </p>
          ) : null}
          <p className="t2" dir="auto">
            {choices.join(' · ')}
          </p>
        </>
      ) : null}
    </>
  );
}
