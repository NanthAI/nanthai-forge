// SPDX-License-Identifier: Apache-2.0
// A landing read as its own diff (Item 8e847a17): the files it changed, each folded open to its hunks, unified or side
// by side, with syntax colours. The receipt's "Read the code here" opens this first; "Browse the repo at this landing"
// is the next step. It reads the receipt's changes (already read for the receipt: the answer is kept, so this view
// asks nothing more) and, per file the reader opens, one signed describe and the bytes from storage, as the Lane page
// does. The first file opens at once; the rest cost nothing until opened. A signed-out visitor of a public project gets
// the file list and a link to each file at this landing: storage downloads are for members.
import { useConvex } from 'convex/react';
import { useContext, useEffect, useState } from 'react';
import { DiffModeToggle, DiffView, useDiffMode, type DiffMode } from '../../diff-view';
import { Head, crumbsFor } from '../Place';
import { A } from '../frames';
import { hrefFor } from '../paths';
import { readFileBody, type FileBody as DrawnFile } from '../lane/file-diff';
import type { CodeProps } from './CodePlace';
import { plural, titleOf } from './code-words';
import { useChanges, VisitorCodeContext, type CodeChange, type CodeHistoryRow } from './code-data';

/** Files drawn before "Show all". */
const SHOWN = 30;
const kb = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / 1048576).toFixed(1)} MB`;

export function Changes({
  route,
  projectId,
  projectName,
  row,
  loading,
}: CodeProps & { row: CodeHistoryRow | null; loading: boolean }) {
  const changes = useChanges(projectId, row);
  const [mode, setMode] = useDiffMode();
  const [all, setAll] = useState(false);
  const visitor = Boolean(useContext(VisitorCodeContext));
  const repoAt = (path = '') =>
    row
      ? `${hrefFor({ ...route, section: 'files', rest: path })}?at=${row.head}&receipt=${row.receiptId}`
      : '';
  const list = changes.value?.changes ?? [];
  const shown = all ? list : list.slice(0, SHOWN);
  const sentence = !row ? (
    loading ? (
      'Reading the landing…'
    ) : (
      'This landing is unavailable.'
    )
  ) : changes.value?.available === false ? (
    (changes.value.reason ?? 'The changes are not available.')
  ) : changes.value ? (
    <>
      <b>{plural(changes.value.total, 'file')}</b> changed as “{titleOf(row)}”.
    </>
  ) : changes.error ? (
    changes.error
  ) : (
    'Reading the changes…'
  );
  return (
    <>
      <Head trail={crumbsFor(route, projectName)} sentence={sentence}>
        <A className="btn sm" href={hrefFor(route)}>
          Back to the receipt
        </A>
        {row ? (
          <A className="btn sm" href={repoAt()}>
            Browse the repo at this landing
          </A>
        ) : null}
      </Head>
      {row && list.length ? (
        <>
          <div className="mdbar">
            <DiffModeToggle mode={mode} onChange={setMode} />
            {visitor ? (
              <span className="t2">Read each file at this landing; its diff is for signed-in members.</span>
            ) : null}
          </div>
          <div className="changes-files">
            {shown.map((change, i) => (
              <ChangedFile
                key={change.path}
                change={change}
                projectId={projectId}
                mode={mode}
                first={i === 0}
                visitor={visitor}
                fileHref={repoAt(change.path)}
              />
            ))}
            {list.length > SHOWN && !all ? (
              <div className="pf">
                <button type="button" className="btn sm" onClick={() => setAll(true)}>
                  Show all {plural(list.length, 'file')}
                  {(changes.value?.total ?? 0) > list.length
                    ? ` of ${changes.value!.total.toLocaleString()}`
                    : ''}
                </button>
              </div>
            ) : null}
            {(changes.value?.total ?? 0) > list.length ? (
              <p className="pad t2">
                The first {list.length.toLocaleString()} of {changes.value!.total.toLocaleString()} files are
                listed. Read the rest with <code>nforge agent . history</code>.
              </p>
            ) : null}
          </div>
        </>
      ) : null}
    </>
  );
}

function ChangedFile({
  change,
  projectId,
  mode,
  first,
  visitor,
  fileHref,
}: {
  change: CodeChange;
  projectId: Parameters<typeof readFileBody>[1];
  mode: DiffMode;
  first: boolean;
  visitor: boolean;
  fileHref: string;
}) {
  const client = useConvex();
  const readable = !visitor && change.before !== undefined && change.after !== undefined;
  const [open, setOpen] = useState(first && readable);
  const [body, setBody] = useState<DrawnFile | 'loading' | 'failed' | null>(null);
  useEffect(() => {
    if (!open || (body && body !== 'failed') || !readable) return;
    setBody('loading');
    readFileBody(client, projectId, change.before ?? null, change.after ?? null).then(setBody, () =>
      setBody('failed'),
    );
  }, [open, body, readable, client, projectId, change.before, change.after]);
  const counts: [number, number] | null =
    body && typeof body === 'object' && body.kind === 'diff' ? [body.add, body.del] : null;
  return (
    <details
      className="file"
      open={open}
      onToggle={event => {
        if (!readable) return;
        setOpen(event.currentTarget.open);
        // Reopening a file whose read failed asks again.
        if (event.currentTarget.open && body === 'failed') setBody(null);
      }}
    >
      <summary>
        <span className="tw" aria-hidden="true" />
        <span className="mono path" title={change.path} translate="no">
          {'‎'}
          {change.path}
        </span>
        <span className="why">{change.status}</span>
        {counts && counts[0] + counts[1] > 0 ? (
          <span className="fstat">
            {counts[0] ? <span className="a">+{counts[0].toLocaleString()}</span> : null}
            {counts[0] > 0 && counts[1] > 0 ? ' ' : null}
            {counts[1] ? <span className="d">−{counts[1].toLocaleString()}</span> : null}
          </span>
        ) : null}
      </summary>
      {!readable ? (
        <p className="pad t2">
          {change.status === 'deleted' ? (
            'Removed at this landing.'
          ) : (
            <A className="lk" href={fileHref}>
              Read the file at this landing
            </A>
          )}
        </p>
      ) : open ? (
        <DrawnBody body={body} change={change} mode={mode} fileHref={fileHref} />
      ) : null}
    </details>
  );
}

function DrawnBody({
  body,
  change,
  mode,
  fileHref,
}: {
  body: DrawnFile | 'loading' | 'failed' | null;
  change: CodeChange;
  mode: DiffMode;
  fileHref: string;
}) {
  const open =
    change.status === 'deleted' ? null : (
      <>
        {' '}
        Or{' '}
        <A className="lk" href={fileHref}>
          read the file at this landing
        </A>
        .
      </>
    );
  if (!body || body === 'loading')
    return (
      <div className="pad" aria-busy="true" aria-label={`Loading ${change.path}`}>
        <div className="sk" style={{ width: '70%' }} />
      </div>
    );
  if (body === 'failed') return <p className="pad t2">This file did not load.{open}</p>;
  if (body.kind === 'large')
    return (
      <p className="pad t2">
        Too long to draw here ({kb(body.size)}).{open}
      </p>
    );
  if (body.kind === 'binary') return <p className="pad t2">Binary file, {kb(body.size)}.</p>;
  if (body.kind === 'submodule') return <p className="pad t2">A submodule pointer changed.</p>;
  if (body.kind === 'same')
    return (
      <p className="pad t2">
        Same lines. The file mode changed from {change.before?.mode ?? 'none'} to{' '}
        {change.after?.mode ?? 'none'}.
      </p>
    );
  return (
    <>
      {body.rough || body.encoding ? (
        <p className="pad t2">
          {body.rough ? 'Shown as one replaced block: the exact alignment was over the compare budget. ' : ''}
          {body.encoding ? 'Not UTF-8: bytes that are not text are shown escaped.' : ''}
        </p>
      ) : null}
      <DiffView path={change.path} hunks={body.hunks} mode={mode} />
    </>
  );
}
