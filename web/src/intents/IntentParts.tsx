import { ErrorToast } from '../ui/Toast';
// SPDX-License-Identifier: Apache-2.0
import { useUnsavedInput } from '../ui/NavigationGuard';
import { useId, useState } from 'react';
import { Avatar, Button, ButtonLink, DiffStat, Panel, StatusPill } from '../ui/primitives';
import { age, type Tone } from '../ui/status';
import { Glyph } from '../ui/Glyph';
import type { CockpitWork } from '../cockpit/model';
import type { IntentRow } from './model';
import { canReviewView } from '../views/intent-views';
import type { NoteRow, ViewRow } from './IntentDetail';

export function AddLane({ add }: { add: (name: string) => Promise<string | null> }) {
  const [open, setOpen] = useState(false),
    [name, setName] = useState('');
  useUnsavedInput(Boolean(name.trim()), () => setName(''));
  if (!open)
    return (
      <Button size="sm" variant="ghost" icon="plus" onClick={() => setOpen(true)}>
        Add Lane
      </Button>
    );
  return (
    <form
      className="fx-inline-form"
      onSubmit={event => {
        event.preventDefault();
        if (!name.trim()) return;
        void add(name.trim()).then(error => {
          if (error !== null) return;
          setName('');
          setOpen(false);
        });
      }}
    >
      <input
        className="fx-input"
        autoFocus
        aria-label="Lane name"
        maxLength={120}
        placeholder="Lane name"
        value={name}
        onChange={event => setName(event.target.value)}
      />
      <Button size="sm" variant="primary" type="submit" disabled={!name.trim()}>
        Add
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </form>
  );
}

export function LaneTag({ lane, href }: { lane: { id: string; name: string }; href: string }) {
  return (
    <a className="fx-ltag" href={href}>
      <Glyph name="lane" size={10} />
      {lane.name}
    </a>
  );
}

/** Intent notes and Lane messages, with replies pinned to their original Lane. */
export function Conversation({
  notes,
  now,
  add,
  send,
  laneHref,
}: {
  notes: readonly NoteRow[];
  now: number;
  add?: (text: string, kind: NoteRow['kind']) => Promise<string | null>;
  send?: (text: string, laneId?: string) => Promise<string | null>;
  laneHref: (id: string) => string;
}) {
  const [text, setText] = useState('');
  const [reply, setReply] = useState<NoteRow['lane']>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useUnsavedInput(Boolean(text.trim()), () => setText(''));
  const id = useId();
  return (
    <Panel title="Conversation" count={notes.length}>
      {notes.length ? (
        <ol className="fx-intent-thread">
          {[...notes]
            .sort((a, b) => a.at.localeCompare(b.at))
            .map((note, index) => (
              <li key={index}>
                <div className="fx-msg-head">
                  {note.actor && (
                    <>
                      <Avatar name={note.actor.name} kind={note.actor.kind} size="sm" />
                      <b>{note.actor.name}</b>
                    </>
                  )}
                  <time title={note.at}>{age(note.at, now)}</time>
                  {note.lane && <LaneTag lane={note.lane} href={laneHref(note.lane.id)} />}
                </div>
                <p>{note.text}</p>
                {note.lane && send && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setReply(note.lane);
                      document.getElementById(id)?.focus();
                    }}
                  >
                    Reply
                  </Button>
                )}
              </li>
            ))}
        </ol>
      ) : (
        <p className="fx-panel-note">No messages yet.</p>
      )}
      {(add || send) && (
        <form
          className="fx-compose"
          onSubmit={event => {
            event.preventDefault();
            if (!text.trim() || busy) return;
            setBusy(true);
            setError('');
            const action =
              reply && send
                ? send(text.trim(), reply.id)
                : add
                  ? add(text.trim(), 'comment')
                  : send!(text.trim());
            void action
              .then(problem => {
                if (problem === null) {
                  setText('');
                  setReply(undefined);
                } else setError(problem);
              })
              .catch(error => setError((error as Error).message))
              .finally(() => setBusy(false));
          }}
        >
          {reply && (
            <div className="fx-intent-reply">
              <LaneTag lane={reply} href={laneHref(reply.id)} />
              <Button size="sm" variant="ghost" onClick={() => setReply(undefined)}>
                Cancel reply
              </Button>
            </div>
          )}
          <label htmlFor={id} className="fx-sr">
            {reply ? `Message ${reply.name}` : 'Message everyone on this Intent'}
          </label>
          <textarea
            id={id}
            className="fx-input"
            rows={1}
            maxLength={4000}
            disabled={busy}
            value={text}
            placeholder={reply ? `Message ${reply.name}…` : 'Message everyone on this Intent…'}
            onChange={event => setText(event.target.value)}
          />
          <Button size="sm" type="submit" disabled={busy || !text.trim()}>
            {busy ? 'Sending…' : 'Send'}
          </Button>
          <ErrorToast error={error} />
        </form>
      )}
    </Panel>
  );
}

const viewTone = (view: ViewRow): [Tone, string] =>
  view.supersededBy && !view.accepted
    ? ['stale', 'Superseded']
    : view.accepted
      ? ['passed', 'Accepted']
      : view.status === 'conflict'
        ? ['conflict', 'Conflict']
        : view.check === 'passed'
          ? ['passed', 'Check passed']
          : view.check === 'failed'
            ? ['failed', 'Check failed']
            : view.check === 'cancelled' || view.check === 'interrupted'
              ? ['stale', view.check === 'cancelled' ? 'Cancelled' : 'Interrupted']
              : view.check
                ? ['running', `Check ${view.check}`]
                : ['plain', 'Not checked'];

export function Candidates({
  row,
  views,
  now,
  laneHref,
  reviewHref,
  viewHref,
  records,
  base,
}: {
  row: IntentRow;
  views: readonly ViewRow[];
  now: number;
  laneHref: (id: string) => string;
  reviewHref?: (id: string) => string;
  viewHref?: (id: string) => string;
  records?: CockpitWork;
  base?: string;
}) {
  const [allViews, setAllViews] = useState(false);
  return (
    <>
      {' '}
      {views.length > 0 && (
        <section id="intent-views">
          <Panel title="Candidates" count={views.length}>
            <ul className="fx-intent-candidates">
              {[...views]
                .reverse()
                .slice(0, allViews ? undefined : 5)
                .map(view => {
                  const [tone, label] = viewTone(view);
                  const href = (viewHref ?? reviewHref)?.(view.id);
                  const landing = records?.channelMoves?.find(
                    move => move.viewId === view.id && move.status === 'accepted',
                  );
                  const acceptedBy =
                    landing && 'acceptedBy' in landing
                      ? (landing.acceptedBy as { name?: string } | undefined)?.name
                      : undefined;
                  return (
                    <li key={view.id}>
                      <div>
                        <div className="fx-candidate-name">
                          <Glyph name="view" size={12} />{' '}
                          {href ? <a href={href}>Candidate of</a> : 'Candidate of'}{' '}
                          {view.inputs?.length
                            ? view.inputs.map(input => (
                                <LaneTag
                                  key={input.laneId}
                                  lane={{
                                    id: input.laneId,
                                    name: row.lanes.find(lane => lane.id === input.laneId)?.name ?? 'Lane',
                                  }}
                                  href={laneHref(input.laneId)}
                                />
                              ))
                            : view.lanes}
                          {(view.base ?? records?.views.find(item => item.id === view.id)?.base ?? base) && (
                            <>
                              {' '}
                              on main{' '}
                              <code>
                                {(view.base ??
                                  records?.views.find(item => item.id === view.id)?.base ??
                                  base)!.slice(0, 8)}
                              </code>
                            </>
                          )}
                        </div>
                        <div className="fx-candidate-check">
                          <Glyph
                            name={tone === 'passed' ? 'check' : tone === 'failed' ? 'failed' : 'file'}
                            size={12}
                          />
                          {view.accepted && acceptedBy ? `accepted by ${acceptedBy} · ` : ''}
                          {view.checkName} {view.check ?? label}
                          {view.changes && <DiffStat add={view.changes.add} del={view.changes.del} />}
                        </div>
                      </div>
                      {canReviewView(view) && reviewHref ? (
                        <ButtonLink variant="secondary" size="sm" href={reviewHref(view.id)}>
                          Review &amp; accept
                        </ButtonLink>
                      ) : (
                        <StatusPill tone={tone}>{label}</StatusPill>
                      )}
                      <time className="fx-faint" title={view.at}>
                        {age(view.at, now)}
                      </time>
                    </li>
                  );
                })}
            </ul>
            {views.length > 5 && (
              <Button variant="ghost" onClick={() => setAllViews(!allViews)}>
                {allViews ? 'Show fewer Candidates' : `${views.length - 5} more Candidates`}
              </Button>
            )}
          </Panel>
        </section>
      )}
    </>
  );
}
