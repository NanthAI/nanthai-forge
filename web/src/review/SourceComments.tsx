import { useSourceReview } from '../use-source-review';
import { useReadRetry } from '../ui/read-retry';
import { ErrorToast } from '../ui/Toast';
import { SyntaxLine } from '../SourceTokens';
// SPDX-License-Identifier: Apache-2.0
import { memo, Profiler, useCallback, useEffect, useState } from 'react';
import type { Id } from '../../../convex/_generated/dataModel';
import type { ReviewPath, reviewTextPage } from '../../../src/native-source-review';
import type { contextualHunks } from '../../../src/review-hunks';
import type { MetadataCommand } from '../../../src/work-types';
import type { SourceAnchor } from '../../../src/work-intent-types';
import type { WorkIndexWorkspace } from '../hosted-work-index';
import SourceDiscussion from '../SourceDiscussion';
import { PageTabs, ActionPanel } from '../WorkspaceUI';
import '../legacy-source-review.css';
import { LazyLines } from '../lane/LazyLines';
import { profileDiff } from '../lane/diff-profile';

type Page = ReturnType<typeof reviewTextPage>;
type Unavailable = { available: false; reason: string };
type Index = { available: true; paths: ReviewPath[] };
type File = {
  available: true;
  file: ReviewPath;
  before: Page | null;
  after: Page | null;
  comparison: ReturnType<typeof contextualHunks>;
};
type Selection = 'diff' | 'before' | 'after';
type LineAction = (side: 'before' | 'after', line: number) => void;
function Line({
  side,
  line,
  onLine,
}: {
  side: 'before' | 'after';
  line: number | string;
  onLine?: LineAction;
}) {
  return onLine && typeof line === 'number' ? (
    <button
      className="review-line-number"
      aria-label={`Comment on ${side} line ${line}`}
      title={`Comment on ${side} line ${line}`}
      onClick={() => onLine(side, line)}
    >
      {line}
    </button>
  ) : (
    <span className="review-line-number">{line}</span>
  );
}
const Patch = memo(function Patch({
  comparison,
  onLine,
  file,
}: {
  comparison: File['comparison'];
  onLine?: LineAction;
  file: string;
}) {
  return (
    <>
      {comparison.content && (
        <p className="review-message">{comparison.content}. Open Before or After for the retained source.</p>
      )}
      {!comparison.hunks.length && !comparison.truncated && (
        <p className="review-message">The file text is unchanged. File mode changes are shown above.</p>
      )}
      <div className="review-code source" aria-label="Source changes">
        {comparison.hunks.map((hunk, index) => (
          <div key={index}>
            <p className="review-hunk">
              Before line {hunk.beforeStart} · After line {hunk.afterStart}
            </p>
            <PatchLines hunk={hunk} file={file} onLine={onLine} />
          </div>
        ))}
      </div>
    </>
  );
});
function PatchLines({
  hunk,
  file,
  onLine,
}: {
  hunk: File['comparison']['hunks'][number];
  file: string;
  onLine?: LineAction;
}) {
  let before = hunk.beforeStart,
    after = hunk.afterStart;
  const lines = hunk.lines.map(line => ({
    ...line,
    a: line.kind === 'added' ? '' : before++,
    b: line.kind === 'removed' ? '' : after++,
  }));
  return (
    <pre>
      <LazyLines
        count={lines.length}
        height={24}
        render={(start, end) =>
          lines.slice(start, end).map((line, row) => {
            const i = start + row,
              { a, b } = line;
            return (
              <div className={`review-code-line ${line.kind}`} key={i}>
                <Line side="before" line={a} onLine={onLine} />
                <Line side="after" line={b} onLine={onLine} />
                <span className="review-change-mark">
                  {line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '}
                </span>
                <code>
                  <SyntaxLine text={line.text} file={file} range={String(i)} />
                </code>
              </div>
            );
          })
        }
      />
    </pre>
  );
}
function Source({
  page,
  side,
  onLine,
  file,
}: {
  page: Page | null;
  side: 'before' | 'after';
  onLine?: LineAction;
  file: string;
}) {
  if (!page) return <p className="review-message">This file is absent from this version.</p>;
  if (page.kind === 'binary')
    return (
      <p className="review-message">
        Binary or non-UTF-8 content · {page.size.toLocaleString()} bytes. Its exact identity is available in
        File references.
      </p>
    );
  return (
    <>
      <p className="review-message">
        {page.size.toLocaleString()} bytes
        {page.column > 1 ? ` · continuing line ${page.line}, column ${page.column}` : ''}
      </p>
      <div className="review-code source">
        <pre>
          {page.text.split('\n').map((text, i) => (
            <div className="review-code-line" key={i}>
              <Line side={side} line={page.line + i} onLine={onLine} />
              <code>
                <SyntaxLine
                  text={text}
                  file={file}
                  range={String(page.line + i)}
                  plain={page.size > 1_000_000}
                />
              </code>
            </div>
          ))}
        </pre>
      </div>
    </>
  );
}
export default function SourceComments({
  projectId,
  workspace,
  intentId,
  viewId,
  base,
  head,
  editable,
  busy,
  act,
}: {
  projectId: Id<'hostedProjects'>;
  workspace: WorkIndexWorkspace;
  intentId: string;
  viewId?: string;
  base: string;
  head: string;
  editable: boolean;
  busy: boolean;
  act: (command: MetadataCommand) => Promise<unknown>;
}) {
  const readAttempt = useReadRetry();
  const backupId = workspace.backupId;
  const [anchor, setAnchor] = useState<SourceAnchor | null>(null);
  const read = useSourceReview(),
    [index, setIndex] = useState<Index | Unavailable | null>(null),
    [file, setFile] = useState(''),
    [detail, setDetail] = useState<File | Unavailable | null>(null);
  const [query, setQuery] = useState(''),
    [filter, setFilter] = useState('changed'),
    [sort, setSort] = useState('path'),
    [limit, setLimit] = useState(80),
    [tab, setTab] = useState<Selection>('diff');
  const [positions, setPositions] = useState({ before: [0], after: [0] }),
    [error, setError] = useState(''),
    [retry, setRetry] = useState(0);
  const beforeOffset = positions.before.at(-1)!,
    afterOffset = positions.after.at(-1)!;
  useEffect(() => {
    let current = true;
    setIndex(null);
    setError('');
    read({ projectId, backupId, base, head })
      .then(value => {
        if (current) setIndex(JSON.parse(value) as Index | Unavailable);
      })
      .catch((e: Error) => {
        if (current) setError(e.message);
      });
    return () => {
      current = false;
    };
  }, [read, projectId, backupId, base, head, retry, readAttempt]);
  useEffect(() => {
    let current = true;
    setDetail(null);
    setError('');
    // Each selection rechecks current authority; verified immutable bytes use the shared short cache.
    if (file)
      read({ projectId, backupId, base, head, file, beforeOffset, afterOffset })
        .then(value => {
          if (current) {
            const parsed = JSON.parse(value) as File | Unavailable;
            setDetail(parsed);
          }
        })
        .catch((e: Error) => {
          if (current) setError(e.message);
        });
    return () => {
      current = false;
    };
  }, [read, projectId, backupId, base, head, file, beforeOffset, afterOffset, retry, readAttempt]);
  const paths = index?.available ? index.paths : [],
    needle = query.trim().toLowerCase(),
    shown = paths
      .filter(
        path =>
          (filter === 'all' ||
            (filter === 'changed' && path.status !== 'unchanged') ||
            path.status === filter) &&
          path.path.toLowerCase().includes(needle),
      )
      .sort((a, b) =>
        sort === 'status'
          ? a.status.localeCompare(b.status) || a.path.localeCompare(b.path)
          : a.path.localeCompare(b.path),
      );
  const open = (path: string) => {
    setFile(path);
    setPositions({ before: [0], after: [0] });
  };
  const selected = detail?.available ? detail : null,
    page = selected && tab !== 'diff' ? selected[tab] : null;
  const commentLine = useCallback<LineAction>(
    (side, line) => {
      const source = selected?.file[side];
      if (viewId && source) setAnchor({ viewId, base, head, file, side, line, blob: source.blob });
    },
    [selected?.file, viewId, base, head, file],
  );
  const onLine = editable && viewId ? commentLine : undefined;
  return (
    <section className="native-source-review" aria-label="Review source changes">
      {error && (
        <ErrorToast read>
          {error} <button onClick={() => setRetry(value => value + 1)}>Retry source read</button>
        </ErrorToast>
      )}
      {!index && !error && <p role="status">Loading the file comparison…</p>}
      {index && !index.available && (
        <ErrorToast read error={index.reason} retry={() => setRetry(value => value + 1)} />
      )}
      {index?.available && (
        <>
          <div className="review-toolbar">
            <label>
              Find a file
              <input
                type="search"
                value={query}
                onChange={e => {
                  setQuery(e.target.value);
                  setLimit(80);
                }}
                placeholder="Path or filename"
              />
            </label>
            <label>
              Files
              <select
                value={filter}
                onChange={e => {
                  setFilter(e.target.value);
                  setLimit(80);
                }}
              >
                <option value="changed">Changed files</option>
                <option value="all">All files</option>
                <option value="added">Added</option>
                <option value="modified">Modified</option>
                <option value="deleted">Deleted</option>
              </select>
            </label>
            <label>
              Sort
              <select value={sort} onChange={e => setSort(e.target.value)}>
                <option value="path">Path</option>
                <option value="status">Change type</option>
              </select>
            </label>
          </div>
          <p className="review-count">
            {shown.length.toLocaleString()} {shown.length === 1 ? 'file' : 'files'}
            {query ? ' matching your search' : ''}
          </p>
          <div className="review-workspace">
            <nav className="review-files" aria-label="Files in selected source">
              {shown.slice(0, limit).map(path => (
                <button
                  key={path.path}
                  aria-current={file === path.path ? 'page' : undefined}
                  onClick={() => open(path.path)}
                >
                  <span>{path.path}</span>
                  <small>{path.status}</small>
                </button>
              ))}
              {!shown.length && (
                <p>{query ? 'No files match this search.' : 'No files match this filter.'}</p>
              )}
              {shown.length > limit && (
                <button onClick={() => setLimit(value => value + 80)}>Show more files</button>
              )}
            </nav>
            <div className="review-selected">
              {!file ? (
                <p className="review-message">Choose a file to inspect its changes and retained source.</p>
              ) : (
                <>
                  <header className="review-file-heading">
                    <h5>{file}</h5>
                    {selected && (
                      <p>
                        {selected.file.status}
                        {selected.file.before &&
                        selected.file.after &&
                        selected.file.before.mode !== selected.file.after.mode
                          ? ` · executable permission ${selected.file.after.mode === 'executable' ? 'added' : 'removed'}`
                          : selected.file.after?.mode === 'executable'
                            ? ' · executable file'
                            : ''}
                      </p>
                    )}
                  </header>
                  {editable && (
                    <p className="review-message review-instruction">
                      Select a line number to comment on this source.
                    </p>
                  )}
                  <PageTabs
                    label="Source comparison"
                    value={tab}
                    onChange={setTab}
                    items={[
                      { id: 'diff', label: 'Changes' },
                      { id: 'before', label: 'Before' },
                      { id: 'after', label: 'After' },
                    ]}
                  />
                  {!detail && !error && (
                    <p role="status" className="review-message">
                      Reading this file…
                    </p>
                  )}
                  {detail && !detail.available && (
                    <ErrorToast read error={detail.reason} retry={() => setRetry(value => value + 1)} />
                  )}
                  {selected && (
                    <>
                      {tab === 'diff' ? (
                        <Profiler id="hosted-diff" onRender={profileDiff}>
                          <Patch comparison={selected.comparison} onLine={onLine} file={file} />
                        </Profiler>
                      ) : (
                        <Source page={page} side={tab} onLine={onLine} file={file} />
                      )}
                      {tab !== 'diff' && page?.kind === 'text' && (
                        <div className="review-paging">
                          <button
                            disabled={positions[tab].length === 1}
                            onClick={() =>
                              setPositions(value => ({ ...value, [tab]: value[tab].slice(0, -1) }))
                            }
                          >
                            Previous source
                          </button>
                          <button
                            disabled={page.nextOffset === null}
                            onClick={() => {
                              if (page.nextOffset !== null)
                                setPositions(value => ({
                                  ...value,
                                  [tab]: [...value[tab], page.nextOffset!],
                                }));
                            }}
                          >
                            Next source
                          </button>
                        </div>
                      )}
                      <ActionPanel title="File references">
                        <p>
                          Before source <code>{base}</code>
                        </p>
                        <p>
                          After source <code>{head}</code>
                        </p>
                        <p>
                          Before file <code>{selected.file.before?.blob ?? 'Absent'}</code>
                        </p>
                        <p>
                          After file <code>{selected.file.after?.blob ?? 'Absent'}</code>
                        </p>
                      </ActionPanel>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        </>
      )}
      {viewId && (
        <SourceDiscussion
          projectId={projectId}
          workspace={workspace}
          intentId={intentId}
          viewId={viewId}
          file={file}
          anchor={anchor}
          busy={busy}
          act={act}
          clear={() => setAnchor(null)}
        />
      )}
    </section>
  );
}
