// SPDX-License-Identifier: Apache-2.0
// One file's landings (Item 3968a655), from one paged read (useFileHistory) drawn in two places: "Landings that
// touched it" beside the file, and What landed narrowed to the file (`?path=`), whose toolbar, notice and foot are here.
import { useState } from 'react';
import { Glyph } from '../../ds';
import { A } from '../frames';
import { hrefFor } from '../paths';
import { navigate } from '../router';
import type { CodeProps } from './CodePlace';
import { useFileHistory, type FileHistoryView } from './code-data';
import { ago, landedAt, landedBy, pathHref, plural, titleOf, typedPath } from './code-words';

export function FileHistory({
  projectId,
  path,
  before,
  route,
}: {
  projectId: CodeProps['projectId'];
  path: string;
  before: number | null;
  route: CodeProps['route'];
}) {
  const file = useFileHistory(projectId, path, before);
  const all = (
    <div className="pf">
      <A className="lk" href={pathHref(hrefFor({ ...route, section: '', rest: '' }), path)}>
        All landings that touched it
      </A>
    </div>
  );
  if (file.error)
    return (
      <div className="pad" role="alert">
        <p>{file.error}</p>
        <button type="button" className="btn sm" onClick={file.retry}>
          Retry
        </button>
      </div>
    );
  if (file.loading)
    return (
      <p className="quietline" role="status">
        Reading landings…
      </p>
    );
  const { rows, missing, scanned, next } = file;
  return (
    <>
      {rows.map(row => (
        <A
          key={row.receiptId}
          className="row"
          href={hrefFor({ ...route, section: '', rest: row.receiptId })}
          style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}
        >
          <div style={{ minWidth: 0 }}>
            <div className="ttl" dir="auto">
              {titleOf(row)}
            </div>
            <div className="meta">{[landedBy(row), landedAt(row.at)].filter(Boolean).join(', ')}</div>
          </div>
        </A>
      ))}
      {!rows.length ? (
        <p className="quietline">
          {next !== null
            ? 'No matches yet.'
            : missing
              ? 'No recorded landings touch this file.'
              : 'No landings touch this file.'}
        </p>
      ) : null}
      {missing ? (
        <p className="quietline">Change lists unavailable for {plural(missing, 'landing')}.</p>
      ) : null}
      {next !== null && scanned ? (
        <p className="quietline" role="status">
          Looked through {plural(scanned, 'landing')}.
        </p>
      ) : null}
      {next !== null ? (
        <div className="pad">
          <button type="button" className="btn sm" onClick={file.loadMore} disabled={file.busy}>
            {file.busy ? 'Reading landings…' : 'Show earlier landings'}
          </button>
          {file.moreError ? <p role="alert">{file.moreError}</p> : null}
        </div>
      ) : null}
      {all}
    </>
  );
}

/** The file's name, cut at the start so its end stays (the Wrap Rule for paths). */
function FileName({ path }: { path: string }) {
  const name = path.split('/').at(-1) || path;
  return (
    <span className="mono" dir="ltr" title={path}>
      {name.length > 36 ? `…${name.slice(-34)}` : name}
    </span>
  );
}

export function pathSentence(path: string, file: FileHistoryView) {
  if (file.loading || (file.error && !file.rows.length)) return 'What landed on main.';
  const newest = file.rows[0];
  if (!newest)
    return (
      <>
        <b>
          {/* Only a complete look says none: more steps, or receipts with no kept change list, leave it open. */}
          {file.next === null && !file.missing ? 'No landing touched' : 'No landing looked at so far touched'}{' '}
          <FileName path={path} />.
        </b>{' '}
        {file.scanned === null
          ? 'Not every landing was looked at.'
          : file.scanned === 0
            ? 'Nothing has landed on main yet.'
            : `${plural(file.scanned, 'landing')} looked at${file.next === null ? ', back to the first' : ''}.`}
      </>
    );
  return (
    <>
      <b>
        {plural(file.rows.length, 'landing')} touched <FileName path={path} />.
      </b>{' '}
      The newest landed {ago(newest.at)}
      {landedBy(newest) ? `, by ${landedBy(newest)}` : ''}.
    </>
  );
}

const findGlyph = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <circle cx="7" cy="7" r="4.5" />
    <path d="m10.5 10.5 3.5 3.5" />
  </svg>
);
const clearGlyph = (
  <svg
    width="10"
    height="10"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="m4 4 8 8M12 4l-8 8" />
  </svg>
);

/** The list toolbar: a file path typed here, or the one set, is the address (`?path=`), so Back undoes it. */
export function PathBar({
  route,
  path,
  count,
}: {
  route: CodeProps['route'];
  path: string | null;
  count: string;
}) {
  const [typed, setTyped] = useState('');
  const go = (to: string | null) => navigate(pathHref(hrefFor({ ...route, rest: '' }), to));
  return (
    <div className="tbar" role="search" aria-label="Narrow what landed">
      <label className="find">
        <span className="sr">Narrow to one file</span>
        {findGlyph}
        <input
          className="inp"
          type="search"
          placeholder="A file path…"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          value={typed}
          onChange={event => setTyped(event.target.value)}
          onKeyDown={event => {
            if (event.key !== 'Enter') return;
            const to = typedPath(typed);
            if (to) go(to);
          }}
        />
      </label>
      {path ? (
        <span className="chip" title={path}>
          <i>Path</i>
          <span className="mono path-cut">&lrm;{path}</span>
          <button type="button" aria-label="Clear the path" onClick={() => go(null)}>
            {clearGlyph}
          </button>
        </span>
      ) : null}
      {count ? <span className="n">{count}</span> : null}
    </div>
  );
}

/** A failed step says so above the list; the rows already read stay, with when they were read. */
export function PathNotice({ file }: { file: FileHistoryView }) {
  if (!file.error && !file.moreError) return null;
  const when =
    file.rows.length && file.readAt
      ? ` What is below is from ${new Date(file.readAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}.`
      : '';
  return (
    <div className="notice" data-st="failed" role="alert">
      <span className="st" data-st="failed">
        <Glyph of="failed" />
        Could not load
      </span>
      <p>The landings could not be read just now.{when} Nothing on main changed because of this.</p>
      <button type="button" className="btn sm" onClick={file.retry}>
        Retry
      </button>
    </div>
  );
}

/** How far back the narrowed list looked, and the next step back. Shown even when a step matched nothing. */
export function PathFoot({ file, clear }: { file: FileHistoryView; clear: string }) {
  if (file.loading || (file.error && !file.rows.length)) return null;
  const looked = file.scanned === null ? 'the newest landings' : plural(file.scanned, 'landing');
  const first = file.next === null && file.scanned !== 0 ? ' That is the first landing.' : '';
  const further =
    file.next !== null ? (
      <button type="button" className="btn sm" onClick={file.loadMore} disabled={file.busy}>
        {file.busy ? 'Looking further back…' : 'Look further back'}
      </button>
    ) : null;
  const unknown = file.missing ? (
    <p className="pf">
      What {plural(file.missing, 'landing')} changed was not kept, so whether{' '}
      {file.missing === 1 ? 'it' : 'they'} touched this file is not known.
    </p>
  ) : null;
  if (!file.rows.length)
    return (
      <>
        <div className="pad path-none">
          <p className="t2">
            Nothing touched this path in the {looked} looked at.{first}
          </p>
          <div className="btns">
            {further}
            <A className="btn sm ghost" href={clear}>
              Clear the path
            </A>
          </div>
        </div>
        {unknown}
      </>
    );
  return (
    <>
      <div className="pf path-foot">
        <span>
          Looked at {looked}.{first}
        </span>
        {further}
      </div>
      {unknown}
    </>
  );
}
