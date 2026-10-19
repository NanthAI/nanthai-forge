import { ErrorToast } from '../ui/Toast';
// SPDX-License-Identifier: Apache-2.0
import { useUnsavedInput } from '../ui/NavigationGuard';
import { useId, useState } from 'react';
import { Button, Panel, Segmented } from '../ui/primitives';
import { age } from '../ui/status';
import type { NoteRow } from './IntentDetail';

export function AddLane({ add }: { add: (name: string) => Promise<string | null> }) {
  const [open, setOpen] = useState(false),
    [name, setName] = useState('');
  useUnsavedInput(Boolean(name.trim()), () => setName(''));
  if (!open)
    return (
      <Button size="sm" icon="plus" onClick={() => setOpen(true)}>
        Add a Lane
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

export function Notes({
  notes,
  now,
  add,
}: {
  notes: readonly NoteRow[];
  now: number;
  add?: (text: string, kind: NoteRow['kind']) => Promise<string | null>;
}) {
  const [text, setText] = useState(''),
    [kind, setKind] = useState<NoteRow['kind']>('decision'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useUnsavedInput(Boolean(text.trim()), () => setText(''));
  const id = useId();
  if (!notes.length && !add) return null;
  return (
    <Panel title="Decisions and notes" count={notes.length || undefined}>
      {notes.length === 0 ? (
        <p className="fx-panel-note fx-flush">No decisions or notes</p>
      ) : (
        <ol className="fx-notes">
          {[...notes].reverse().map((note, index) => (
            <li key={index} className={note.kind === 'decision' ? 'fx-note-decision' : undefined}>
              <span className="fx-note-kind">{note.kind === 'decision' ? 'Decision' : 'Note'}</span>
              <p>{note.text}</p>
              <time>{age(note.at, now, true)}</time>
            </li>
          ))}
        </ol>
      )}
      {add && (
        <form
          className="fx-compose"
          onSubmit={event => {
            event.preventDefault();
            if (!text.trim() || busy) return;
            setBusy(true);
            setError('');
            void add(text.trim(), kind)
              .then(error => {
                if (error === null) setText('');
                else setError(error);
              })
              .catch(error => setError((error as Error).message))
              .finally(() => setBusy(false));
          }}
        >
          <label htmlFor={id} className="fx-sr">
            Record a decision or note
          </label>
          <textarea
            id={id}
            className="fx-input"
            rows={2}
            maxLength={4000}
            value={text}
            placeholder="What was decided, and why?"
            onChange={event => setText(event.target.value)}
          />
          <div className="fx-reply-actions">
            <Segmented<NoteRow['kind']>
              label="Kind"
              value={kind}
              onChange={setKind}
              options={[
                { id: 'decision', label: 'Decision' },
                { id: 'comment', label: 'Note' },
              ]}
            />
            <span />
            <Button size="sm" variant="primary" type="submit" disabled={busy || !text.trim()}>
              Record
            </Button>
          </div>
          <ErrorToast error={error} />
        </form>
      )}
    </Panel>
  );
}
