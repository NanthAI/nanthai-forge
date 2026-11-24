// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { useId } from 'react';
import { Key } from '../../ds';
import { isPlanningPrefix, isPlanningUuid } from '../../../../src/planning-id';
import { itemBody } from './item-body';
import type { ItemDraft, ItemEdits } from './item-edit';

const labels = {
  text: 'Item text',
  add: 'Add a Done-when line',
  wording: 'Edit wording',
  tick: 'Evidence for this line',
  move: 'Follow-up Item ID (optional)',
  reopen: 'Reopen line',
  remove: 'Remove line',
} as const;
const submitLabels = {
  text: 'Save text',
  add: 'Add',
  wording: 'Save',
  tick: 'Tick and post',
  move: 'Mark moved',
  reopen: 'Reopen',
  remove: 'Remove',
} as const;

export function EditDraft({ edits, draft }: { edits: ItemEdits; draft: ItemDraft }) {
  const id = useId();
  const { kind, value, base } = draft;
  const { busy, conflict, compare, resume, error, reset, save, words } = edits;
  const multiple = kind === 'tick' || kind === 'text';
  const input = kind !== 'reopen' && kind !== 'remove';
  const invalidMove =
    kind === 'move' && value.trim() && !isPlanningUuid(value.trim()) && !isPlanningPrefix(value.trim());
  const needsWords = kind === 'add' || kind === 'wording' || kind === 'tick';
  const enabled = !busy && !conflict && !invalidMove && (!needsWords || value.trim());
  const saveDraft = () => {
    if (enabled) void save(draft);
  };
  const props = {
    id,
    className: 'inp',
    value,
    autoFocus: kind !== 'add',
    readOnly: busy || Boolean(conflict),
    dir: 'auto' as const,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      edits.draft ? words(event.target.value) : reset({ ...draft, value: event.target.value }),
    'aria-describedby': error || invalidMove ? `${id}-error` : undefined,
    'aria-invalid': Boolean(error || invalidMove) || undefined,
  };
  const currentVersion = conflict?.latest?.version ?? conflict?.version;
  return (
    <form
      className={`ip-edit ip-edit-${kind}`}
      onSubmit={event => {
        event.preventDefault();
        saveDraft();
      }}
      onKeyDown={event => {
        if (event.key === 'Escape' && !busy && !conflict) {
          event.stopPropagation();
          reset();
        }
        if (multiple && (event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          event.preventDefault();
          saveDraft();
        }
      }}
    >
      {conflict ? (
        <div className="notice" data-st="waiting" role="status">
          <span>
            {conflict.latest?.author ? `@${conflict.latest.author}` : 'Someone'} saved{' '}
            {currentVersion ? `version ${currentVersion}` : 'another version'} while you edited. Nothing was
            overwritten; your draft is below.
          </span>
          <div className="ip-acts">
            {compare ? (
              <Key size="sm" onClick={() => compare(base.version, currentVersion)}>
                Compare and redo
              </Key>
            ) : null}
            {resume ? (
              <Key size="sm" onClick={resume}>
                Resume draft on version {currentVersion}
              </Key>
            ) : null}
            <Key size="sm" kind="ghost" onClick={() => reset()}>
              Discard my draft
            </Key>
          </div>
        </div>
      ) : null}
      {kind === 'add' ? (
        <span className="ip-plus" aria-hidden="true">
          +
        </span>
      ) : null}
      {input ? (
        <label className={kind === 'wording' || kind === 'add' ? 'sr' : 't2'} htmlFor={id}>
          {labels[kind]}
        </label>
      ) : null}
      {multiple ? (
        <textarea {...props} rows={kind === 'text' ? 8 : 2} />
      ) : input ? (
        <input {...props} placeholder={kind === 'add' ? 'Add a line: what shows it is done' : undefined} />
      ) : null}
      {kind === 'text' && itemBody(base.body).scattered ? (
        <div className="t2">Done-when lines are in several places, so this box contains the whole body.</div>
      ) : null}
      {kind === 'wording' ? (
        <div className="t2">Enter saves · Escape cancels · saves as version {base.version + 1}</div>
      ) : null}
      {error || invalidMove ? (
        <div id={`${id}-error`} className="t2" role="alert">
          {error || 'Use the follow-up Item’s full or short ID.'}
        </div>
      ) : null}
      {!conflict ? (
        <div className="ip-acts">
          <Key size="sm" type="submit" disabled={!enabled}>
            {busy ? 'Saving…' : submitLabels[kind]} {kind === 'text' ? <kbd>⌘↵</kbd> : null}
          </Key>
          {kind !== 'add' || edits.draft?.value ? (
            <Key size="sm" kind="ghost" disabled={busy} onClick={() => reset()}>
              Cancel
            </Key>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
