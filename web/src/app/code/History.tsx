// SPDX-License-Identifier: Apache-2.0
// What landed: landings on main, newest first (a timeline, DESIGN.md rule 13), beside the selected landing's receipt.
// The list is one live page; earlier pages load on "Show earlier". The receipt adds two reads only for the landing
// the reader opens: its evidence (the existing landings read) and what it changed (one source comparison).
import { useState, type KeyboardEvent } from 'react';
import { State, Who } from '../../ds';
import { Head, crumbsFor } from '../Place';
import { A } from '../frames';
import { hrefFor } from '../paths';
import { RegionBoundary, type CodeProps } from './CodePlace';
import { ago, between, landedAt, landedBy, plural, titleOf } from './code-words';
import {
  useChanges,
  useCodeReceipt,
  useEvidence,
  useHistory,
  type CodeHistoryRow,
  type ProjectId,
} from './code-data';

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
  const history = useHistory(projectId);
  const rows = history.rows;
  const listed = rows.find(row => row.receiptId === route.rest) ?? (route.rest ? null : (rows[0] ?? null));
  const [retry, setRetry] = useState(0);
  const receipt = useCodeReceipt(projectId, listed || history.loading ? '' : route.rest, retry);
  const selected = listed ?? receipt.value?.landings.find(row => row.receiptId === route.rest) ?? null;
  const today = new Date().toDateString();
  const todays = rows.filter(row => new Date(row.at).toDateString() === today).length;
  const allToday = todays === rows.length && history.next !== null;
  const newest = rows[0];
  const sentence = history.loading ? (
    'What landed on main.'
  ) : !rows.length ? (
    'Nothing has landed on main yet. A landing appears here the moment it reaches main.'
  ) : (
    <>
      <b>
        {allToday ? 'At least ' : ''}
        {plural(todays, 'landing')} today.
      </b>{' '}
      The newest landed {ago(newest!.at)}
      {landedBy(newest!) ? `, by ${landedBy(newest!)}` : ''}.
    </>
  );
  return (
    <>
      <Head trail={crumbsFor(route, projectName)} sentence={sentence}>
        <A className="btn sm" href={hrefFor({ ...route, section: 'files', rest: '' })}>
          Read the files at main
        </A>
      </Head>
      <div className="panes code-h">
        <section className={`pane${route.rest ? ' off' : ''}`} aria-label="What landed" data-weight="ref">
          <div className="th hrow" aria-hidden="true">
            <span>Landed</span>
            <span>Change</span>
            <span className="who">By</span>
            <span>Check</span>
          </div>
          <div className="body" onKeyDown={moveRows}>
            {history.loading ? <Skeleton /> : null}
            {rows.map(row => (
              <A
                key={row.receiptId}
                className={`row hrow${selected?.receiptId === row.receiptId ? ' sel' : ''}`}
                href={hrefFor({ ...route, rest: row.receiptId })}
                aria-current={selected?.receiptId === row.receiptId ? 'true' : undefined}
              >
                <span className="num t2" title={new Date(row.at).toLocaleString()}>
                  {landedAt(row.at)}
                </span>
                <span className={`ttl${row.title ? '' : ' none'}`} dir="auto">
                  {titleOf(row)}
                </span>
                <span className="who">{row.actor ? <Who handle={landedBy(row)!} /> : landedBy(row)}</span>
                <span className="t2">{row.check ? 'Checked' : 'No check'}</span>
              </A>
            ))}
            {history.next ? (
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
                loading={history.loading || receipt.loading}
              />
            )}
          </RegionBoundary>
        </section>
      </div>
    </>
  );
}

function Skeleton() {
  return (
    <div aria-busy="true" aria-label="Loading what landed">
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

const FILES_SHOWN = 12;
function Receipt({
  route,
  projectId,
  row,
  loading,
}: {
  route: CodeProps['route'];
  projectId: ProjectId;
  row: CodeHistoryRow | null;
  loading: boolean;
}) {
  const evidence = useEvidence(projectId, row);
  const changes = useChanges(projectId, row);
  const [all, setAll] = useState(false);
  const back = (
    <A className="lk hide-dt" href={hrefFor({ ...route, rest: '' })}>
      Everything that landed
    </A>
  );
  if (!row)
    return (
      <>
        <div className="ph plain">
          <h2>Receipt</h2>
        </div>
        <div className="body pad">
          <p className="t2">
            {loading
              ? 'Reading the receipt…'
              : route.rest
                ? 'This receipt is unavailable.'
                : 'Choose a landing to read its receipt.'}
          </p>
          {back}
        </div>
      </>
    );
  const by = landedBy(row);
  const toMain = between(evidence?.submittedAt, evidence?.committedAt ?? row.at);
  const atHead = (path = '') =>
    `${hrefFor({ ...route, section: 'files', rest: path })}?at=${row.head}&receipt=${row.receiptId}`;
  const list = changes.value?.changes ?? [];
  const shown = all ? list : list.slice(0, FILES_SHOWN);
  return (
    <>
      <div className="ph plain">
        <h2>Receipt</h2>
        <span className="hint">
          <State word="Landed">Landed {landedAt(row.at)}</State>
        </span>
      </div>
      <div className="body">
        <div className="pad">
          <h3 style={{ fontSize: 'var(--t-lead)', marginBottom: 6 }} dir="auto">
            {titleOf(row)}
          </h3>
          {row.why ? (
            <p className="t2" dir="auto" style={{ whiteSpace: 'pre-line', maxWidth: 'var(--m-prose)' }}>
              {row.why}
            </p>
          ) : null}
        </div>
        <dl className="kv" style={{ borderTop: 'var(--rule) solid var(--line)' }}>
          <dt>By</dt>
          <dd>
            {by && row.actor ? (
              <Who handle={by} app={row.agentClient ?? undefined} />
            ) : (
              (by ?? 'not reported')
            )}
          </dd>
          {evidence?.intentId ? (
            <>
              <dt>Why</dt>
              <dd>
                <A
                  className="lk"
                  href={hrefFor({ ...route, place: 'plan', section: '', rest: evidence.intentId })}
                >
                  Its Item
                </A>
              </dd>
            </>
          ) : null}
          <dt>Checked</dt>
          <dd>{checkLine(row)}</dd>
          <dt>To main</dt>
          <dd>{evidence === undefined ? '…' : toMain ? `${toMain} from land` : 'not reported'}</dd>
          <dt>Files</dt>
          <dd>
            {changes.loading && !changes.value
              ? '…'
              : changes.error
                ? changes.error
                : changes.value?.available === false
                  ? (changes.value.reason ?? 'not reported')
                  : plural(changes.value?.total ?? 0, 'file')}
          </dd>
        </dl>
        {shown.length ? (
          <ul className="changes" aria-label="Files it changed">
            {shown.map(change => (
              <li key={change.path}>
                <span className="t3" style={{ width: 62, flex: 'none' }}>
                  {change.status}
                </span>
                {change.status === 'deleted' ? (
                  <span className="mono cut path-cut" title={change.path}>
                    {change.path}
                  </span>
                ) : (
                  <A className="lk mono cut path-cut" href={atHead(change.path)} title={change.path}>
                    {change.path}
                  </A>
                )}
              </li>
            ))}
            {list.length > FILES_SHOWN && !all ? (
              <li>
                <button type="button" className="btn sm ghost" onClick={() => setAll(true)}>
                  All {plural(list.length, 'file')}
                  {(changes.value?.total ?? 0) > list.length
                    ? ` of ${changes.value!.total.toLocaleString()}`
                    : ''}
                </button>
              </li>
            ) : null}
          </ul>
        ) : null}
        <div className="pad btns" style={{ borderTop: 'var(--rule) solid var(--line)' }}>
          <A className="btn" href={atHead()}>
            Read the code here
          </A>
          {evidence?.laneId ? (
            <A
              className="btn"
              href={hrefFor({ ...route, place: 'lanes', section: '', rest: evidence.laneId })}
            >
              See the change
            </A>
          ) : null}
          {back}
        </div>
      </div>
    </>
  );
}

function checkLine(row: CodeHistoryRow) {
  if (!row.check) return 'Landed without a check';
  const how =
    row.firstCheck === 'admission-run'
      ? 'Its Lane check carried, on top of main'
      : row.firstCheck === 'scoped-intersection'
        ? 'Checked again on the tests both changes reach'
        : row.firstCheck === 'recheck'
          ? 'Checked again on top of main'
          : 'Checked on top of main';
  return `${how}${row.check.testsSkipped ? '; no test was affected' : ''}${row.batch ? ', with others in one batch' : ''}`;
}
