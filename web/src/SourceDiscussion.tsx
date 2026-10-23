// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from 'react';
import type { Id } from '../../convex/_generated/dataModel';
import type { SourceAnchor } from '../../src/work-intent-types';
import type { MetadataCommand, WorkData } from '../../src/work-types';
import { useWorkRecords, useResolvedWorkValue, type WorkIndexWorkspace } from './hosted-work-index';

type Context = { projectId: Id<'hostedProjects'>; workspace: WorkIndexWorkspace };
export function SourceReference({ anchor }: { anchor: SourceAnchor }) {
  return (
    <p className="source-reference">
      <code>{anchor.file}</code> · {anchor.side} line {anchor.line} · source{' '}
      <code>{(anchor.side === 'before' ? anchor.base : anchor.head).slice(0, 12)}</code>
    </p>
  );
}
function Comment({
  projectId,
  workspace,
  item,
  viewId,
  file,
}: Context & { item: WorkData['intents'][number]['notes'][number]; viewId: string; file: string }) {
  const note = useResolvedWorkValue(projectId, workspace, 'notes', item, true);
  if (!note?.anchor || note.anchor.viewId !== viewId || note.anchor.file !== file) return null;
  return (
    <article className="work-note">
      <small>
        {note.kind} · {new Date(note.at).toLocaleString()}
      </small>
      <SourceReference anchor={note.anchor} />
      <p>{note.text}</p>
    </article>
  );
}
export default function SourceDiscussion({
  projectId,
  workspace,
  intentId,
  viewId,
  file,
  anchor,
  busy,
  act,
  clear,
}: Context & {
  intentId: string;
  viewId: string;
  file: string;
  anchor: SourceAnchor | null;
  busy: boolean;
  act: (command: MetadataCommand) => Promise<unknown>;
  clear: () => void;
}) {
  const notes = useWorkRecords<WorkData['intents'][number]['notes'][number]>(
      projectId,
      workspace,
      'notes',
      intentId,
      !!file,
    ),
    [text, setText] = useState(''),
    [posted, setPosted] = useState(false),
    input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (anchor) {
      input.current?.focus();
      setPosted(false);
    }
  }, [anchor]);
  return (
    <section className="source-discussion" aria-label="Source discussion">
      {anchor && (
        <form
          onSubmit={async event => {
            event.preventDefault();
            if (await act({ action: 'note', intentId, kind: 'comment', text, anchor })) {
              setText('');
              setPosted(true);
              clear();
            }
          }}
        >
          <h4>Comment on this line</h4>
          <SourceReference anchor={anchor} />
          <label>
            Comment
            <textarea
              ref={input}
              value={text}
              onChange={event => setText(event.target.value)}
              required
              maxLength={4000}
              disabled={busy}
            />
          </label>
          <div className="import-actions">
            <button disabled={busy || !text.trim()}>Post line comment</button>
            <button type="button" disabled={busy} onClick={clear}>
              Close comment
            </button>
          </div>
        </form>
      )}
      {posted && <p role="status">Line comment posted.</p>}
      {!!file && (
        <>
          <h4>Discussion on this file</h4>
          <p>Line comments retain their original source and also appear in the Intent discussion.</p>
          {notes.loading && <p role="status">Loading comments…</p>}
          {notes.records.map((item, index) => (
            <Comment
              key={index}
              projectId={projectId}
              workspace={workspace}
              item={item}
              viewId={viewId}
              file={file}
            />
          ))}
        </>
      )}
    </section>
  );
}
