// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { useEffect, useRef, useState } from 'react';
import { useMutation } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import { DiffView, type DiffLine, type DiffMode } from '../../diff-view';
import { Key } from '../../ds';
import { usePageCritical } from '../../ui/page-critical';
import { A } from '../frames';
import { lineReviewText, type ReviewNoteTarget } from '../../../../src/candidate-line-note';
import type { ReviewFile } from './review-model';
import type { Hunk } from './file-diff';

export type NoteDestination = Omit<ReviewNoteTarget, 'path' | 'blob' | 'line' | 'side' | 'changed'> & {
  itemId: string;
  href: string;
};

const keyOf = (line: DiffLine) => `${line.side}-${line.line}`;
const labelOf = (line: DiffLine) => `${line.side === 'base' ? 'Before' : 'After'} line ${line.line}`;

export function ReviewDiff({
  file,
  hunks,
  rough,
  encoding,
  mode,
  projectId,
  note,
}: {
  file: ReviewFile;
  hunks: Hunk[];
  rough: boolean;
  encoding?: 'not-utf-8' | undefined;
  mode: DiffMode;
  projectId: Id<'hostedProjects'>;
  note: NoteDestination | null;
}) {
  const [coloured, setColoured] = useState(false);
  usePageCritical('Lane first diff', { sourceDiff: coloured && hunks.length > 0 });
  const send = useMutation(api.projectWorkCommand.command);
  const [selected, select] = useState<DiffLine | null>(null);
  const [claim, setClaim] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [posted, setPosted] = useState<Record<string, string>>({});
  const pending = useRef<{ key: string; operationId: string } | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLButtonElement | null>(null);
  const selectedKey = selected ? keyOf(selected) : null;
  useEffect(() => {
    if (selectedKey) editor.current?.focus();
  }, [selectedKey, mode]);
  const close = () => {
    gutter.current?.focus();
    select(null);
    setClaim('');
    setFailed(false);
  };
  async function post(line: DiffLine) {
    const blob = (line.side === 'base' ? file.before : file.after)?.blob;
    if (!note || !blob || !claim.trim() || busy) return;
    const text = lineReviewText({ ...note, ...line, path: file.path, blob }, claim);
    setBusy(true);
    setFailed(false);
    try {
      const fingerprint = new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
      );
      const key = `forge.review-note:${projectId}:${Array.from(fingerprint, byte => byte.toString(16).padStart(2, '0')).join('')}`;
      let operationId = pending.current?.key === key ? pending.current.operationId : crypto.randomUUID();
      // Retain only retry identity across this tab's reload, not the private text.
      try {
        operationId = sessionStorage.getItem(key) ?? operationId;
        sessionStorage.setItem(key, operationId);
      } catch {
        /* an in-page retry still works when browser storage is disabled */
      }
      pending.current = { key, operationId };
      await send({
        projectId,
        operationId,
        command: JSON.stringify({ action: 'comment-planning-item', operationId, itemId: note.itemId, text }),
      });
      pending.current = null;
      try {
        sessionStorage.removeItem(key);
      } catch {
        /* browser storage is optional */
      }
      setPosted(current => ({ ...current, [keyOf(line)]: claim.trim() }));
      close();
    } catch {
      setFailed(true);
      editor.current?.focus();
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {rough || encoding ? (
        <p className="pad t2" style={{ paddingBlock: 'var(--s-2)' }}>
          {rough ? 'Shown as one replaced block: the exact alignment was over the compare budget. ' : ''}
          {encoding ? 'Not UTF-8: bytes that are not text are shown escaped.' : ''}
        </p>
      ) : null}
      <DiffView
        path={file.path}
        hunks={hunks}
        mode={mode}
        onColoured={setColoured}
        {...(note
          ? {
              lineNumber: (line: DiffLine) => (
                <button
                  className="lr-line-note"
                  type="button"
                  aria-label={`Add note: ${labelOf(line)}`}
                  aria-expanded={selectedKey === keyOf(line)}
                  ref={selectedKey === keyOf(line) ? gutter : undefined}
                  onClick={() => select(line)}
                  disabled={selectedKey !== null && selectedKey !== keyOf(line)}
                >
                  {line.line}
                </button>
              ),
              belowLine: (line: DiffLine) => {
                const sent = posted[keyOf(line)];
                return selectedKey === keyOf(line) || sent ? (
                  <div className="thread lr-note">
                    {sent ? (
                      <div className="msg" role="status">
                        <p dir="auto">{sent}</p>
                        <A href={note.href}>Open the note in the Lane Thread</A>
                      </div>
                    ) : null}
                    {selectedKey === keyOf(line) ? (
                      <form
                        onSubmit={event => {
                          event.preventDefault();
                          void post(line);
                        }}
                      >
                        <label>
                          Note on {labelOf(line).toLowerCase()}
                          <textarea
                            className="inp"
                            ref={editor}
                            value={claim}
                            onChange={event => setClaim(event.target.value)}
                            disabled={busy}
                            maxLength={4000}
                          />
                        </label>
                        {failed ? (
                          <p role="alert">Forge did not confirm the note. Your text is here; try again.</p>
                        ) : null}
                        <div className="lr-note-keys">
                          <Key type="submit" disabled={busy || !claim.trim()}>
                            {busy ? 'Sending…' : 'Send note'}
                          </Key>
                          <Key kind="ghost" disabled={busy} onClick={close}>
                            Cancel
                          </Key>
                        </div>
                      </form>
                    ) : null}
                  </div>
                ) : null;
              },
            }
          : {})}
      />
    </>
  );
}
