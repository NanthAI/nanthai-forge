// SPDX-License-Identifier: Apache-2.0
// What landed: landings on main, newest first (a timeline, DESIGN.md rule 13), beside the selected landing's receipt.
// The list is one live page; earlier pages load on "Show earlier". The receipt (Receipt.tsx) adds two reads only for
// the landing the reader opens.
// Narrowed to one file (`?path=`, Item 3968a655) the list is that file's landings instead: one bounded read per step
// back (projectCode:fileHistory), and the live page of every landing is not read at all.
import { useState, type KeyboardEvent } from 'react';
import { Head, crumbsFor } from '../Place';
import { A } from '../frames';
import { hrefFor } from '../paths';
import { useSearch } from '../router';
import { RegionBoundary, type CodeProps } from './CodePlace';
import {
  ago,
  landedAt,
  landedBy,
  landedTodaySentence,
  pathHref,
  plural,
  timelinePath,
  titleOf,
} from './code-words';
import { PathBar, PathFoot, PathNotice, pathSentence } from './FileHistory';
import { Changes } from './Changes';
import { LandedBy, Receipt } from './Receipt';
import { useCodeReceipt, useHistory, type CodeHistoryRow } from './code-data';
import { useFileHistory } from './use-file-history';

/** Up and Down move between rows (DESIGN.md rule 21). */
function moveRows(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLAnchorElement>('a.hrow')];
  const at = rows.indexOf(document.activeElement as HTMLAnchorElement);
  const next = rows[at + (event.key === 'ArrowDown' ? 1 : -1)];
  if (!next) return;
  event.preventDefault();
  next.focus();
}

export function History(props: CodeProps) {
  const { route, projectId, projectName } = props;
  const search = useSearch();
  const path = timelinePath(`?${search.toString()}`);
  const history = useHistory(projectId, { skip: path !== null });
  const file = useFileHistory(projectId, path);
  const rows = path ? file.rows : history.rows;
  const loading = path ? file.loading : history.loading;
  const listed = rows.find(row => row.receiptId === route.rest) ?? (route.rest ? null : (rows[0] ?? null));
  const [retry, setRetry] = useState(0);
  const receipt = useCodeReceipt(projectId, listed || loading ? '' : route.rest, retry);
  const selected = listed ?? receipt.value?.landings.find(row => row.receiptId === route.rest) ?? null;
  const at = (rest: string) => pathHref(hrefFor({ ...route, rest }), path);
  const sentence = path ? pathSentence(path, file) : everySentence(history, props.flow);
  const [cli, setCli] = useState(false);
  const args = JSON.stringify(path ? { op: 'log', path, limit: 50 } : { op: 'log', limit: 50 });
  const command = `nforge agent . history '${args.replace(/'/g, "'\\''")}'`;
  // "Read the code here" on a receipt opens the landing's own diff first (Item 8e847a17).
  if (route.rest && !route.rest.startsWith('red/') && !path && search.get('view') === 'changes')
    return <Changes {...props} row={selected} loading={loading || receipt.loading} />;
  return (
    <>
      <Head trail={crumbsFor(route, projectName)} sentence={sentence}>
        <A className="btn sm" href={hrefFor({ ...route, section: 'files', rest: path ?? '' })}>
          Read the files at main
        </A>
        <button
          type="button"
          className="cli mono"
          aria-expanded={cli}
          aria-controls="history-cli"
          onClick={() => setCli(open => !open)}
          title="What an agent runs to read this"
        >
          <span>nforge agent . history</span>
        </button>
      </Head>
      <pre className="cli-out mono" id="history-cli" hidden={!cli}>
        <b>$ {command}</b>
        {'\n'}
        {path
          ? "This file's history, newest first: Git commits on a project imported from GitHub, otherwise these landings."
          : "Main's Git history, newest first: one commit per landing since the import. Kept for projects imported from GitHub."}
      </pre>
      {path ? <PathNotice file={file} /> : null}
      <div className="panes code-h">
        <section className={`pane${route.rest ? ' off' : ''}`} aria-label="What landed" data-weight="ref">
          <PathBar
            key={path ?? ''}
            route={route}
            path={path}
            count={
              !path || file.loading || file.error
                ? ''
                : file.scanned === null
                  ? plural(rows.length, 'landing')
                  : `${rows.length.toLocaleString()} of ${plural(file.scanned, 'landing')}`
            }
          />
          <div className="th hrow" aria-hidden="true">
            <span>Landed</span>
            <span>Change</span>
            <span className="who">By</span>
            <span>Check</span>
          </div>
          <div className="body" onKeyDown={moveRows}>
            {loading ? <Skeleton /> : null}
            {rows.map(row => (
              <LandingRow
                key={row.receiptId}
                row={row}
                href={at(row.receiptId)}
                selected={selected?.receiptId === row.receiptId}
              />
            ))}
            {path ? (
              <PathFoot file={file} clear={hrefFor({ ...route, rest: '' })} />
            ) : history.next ? (
              <div className="pf">
                <button
                  type="button"
                  className="btn sm"
                  onClick={history.loadMore}
                  disabled={history.more.loading}
                >
                  {history.more.loading ? 'Showing earlier…' : 'Show earlier landings'}
                </button>
                {history.more.error ? <span role="alert"> {history.more.error}</span> : null}
              </div>
            ) : rows.length ? (
              <div className="pf">{plural(rows.length, 'landing')} in all.</div>
            ) : null}
          </div>
        </section>
        <section className={`pane${route.rest ? '' : ' off'}`} aria-label="Receipt">
          <RegionBoundary label="The receipt">
            {route.rest && !selected && receipt.error ? (
              <div className="pad" role="alert">
                <p>{receipt.error}</p>
                <button className="btn sm" type="button" onClick={() => setRetry(retry + 1)}>
                  Retry
                </button>
              </div>
            ) : (
              <Receipt
                route={route}
                projectId={projectId}
                row={selected}
                listHref={at('')}
                loading={loading || receipt.loading}
              />
            )}
          </RegionBoundary>
        </section>
      </div>
    </>
  );
}

function everySentence(history: ReturnType<typeof useHistory>, flow: unknown) {
  const rows = history.rows;
  if (history.loading) return 'What landed on main.';
  if (!rows.length)
    return 'Nothing has landed on main yet. A landing appears here the moment it reaches main.';
  const today = landedTodaySentence(rows, history.next !== null, flow, Date.now());
  const newest = rows[0]!;
  return (
    <>
      <b>
        {today.atLeast ? 'At least ' : ''}
        {plural(today.n, 'landing')} today.
      </b>{' '}
      The newest landed {ago(newest.at)}
      {landedBy(newest) ? `, by ${landedBy(newest)}` : ''}.
    </>
  );
}

function LandingRow({ row, href, selected }: { row: CodeHistoryRow; href: string; selected: boolean }) {
  return (
    <A
      className={`row hrow${selected ? ' sel' : ''}`}
      href={href}
      aria-current={selected ? 'true' : undefined}
    >
      <span className="num t2" title={new Date(row.at).toLocaleString()}>
        {landedAt(row.at)}
      </span>
      <span className={`ttl${row.title ? '' : ' none'}`} dir="auto">
        {titleOf(row)}
      </span>
      <span className="who">
        <LandedBy row={row} />
      </span>
      <span className="t2">{row.check ? 'Checked' : 'No check'}</span>
    </A>
  );
}

function Skeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading what landed">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="row hrow" aria-hidden="true">
          <span className="sk" />
          <span className="sk" style={{ width: `${60 - i * 6}%` }} />
          <span className="sk who" />
          <span className="sk" />
        </div>
      ))}
    </div>
  );
}
