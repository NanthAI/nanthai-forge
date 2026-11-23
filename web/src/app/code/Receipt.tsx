// SPDX-License-Identifier: Apache-2.0
// A landing's receipt beside What landed: its title and message, who landed it, its check, how long it took to reach
// main and the files it changed. Two reads, only for the landing the reader opens: its evidence (the existing landings
// read: its Lane and Item) and what it changed (one source comparison).
import { useContext, useState } from 'react';
import { Avatar, State } from '../../ds';
import { A } from '../frames';
import { hrefFor } from '../paths';
import type { CodeProps } from './CodePlace';
import { between, landedAt, landedBy, plural, titleOf } from './code-words';
import {
  useChanges,
  useEvidence,
  VisitorCodeContext,
  type CodeHistoryRow,
  type ProjectId,
} from './code-data';

/** Who landed it, as the mock draws it (Item 3968a655): the square and one handle, `@person` or `person/run`, cut
 * at the end with the full handle in its label. "an agent" when people are hidden; "not reported" when unknown. */
export function LandedBy({ row }: { row: CodeHistoryRow }) {
  const by = landedBy(row);
  if (!by) return <span className="nr">not reported</span>;
  if (!row.actor) return <>{by}</>;
  return (
    <span className="who handle" title={by}>
      <Avatar handle={by} />
      <span className="mono" dir="auto" translate="no">
        {by}
      </span>
    </span>
  );
}

const FILES_SHOWN = 12;
export function Receipt({
  route,
  projectId,
  row,
  listHref,
  loading,
}: {
  route: CodeProps['route'];
  projectId: ProjectId;
  row: CodeHistoryRow | null;
  /** What landed, as narrowed: where the phone's way back goes. */
  listHref: string;
  loading: boolean;
}) {
  const evidence = useEvidence(projectId, row);
  const changes = useChanges(projectId, row);
  const [all, setAll] = useState(false);
  // A signed-out visitor cannot download file versions, so their button opens the files at this landing.
  const visitor = Boolean(useContext(VisitorCodeContext));
  const back = (
    <A className="lk hide-dt" href={listHref}>
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
          {loading ? (
            <div className="sk-rows" aria-hidden="true">
              <div className="sk" />
              <div className="sk" />
              <div className="sk" />
            </div>
          ) : null}
          <p className={loading ? 'sr' : 't2'} role={loading ? 'status' : undefined}>
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
            <p className="t2 any" dir="auto" style={{ whiteSpace: 'pre-line', maxWidth: 'var(--m-prose)' }}>
              {row.why}
            </p>
          ) : null}
        </div>
        <dl className="kv" style={{ borderTop: 'var(--rule) solid var(--line)' }}>
          <dt>By</dt>
          <dd>
            <LandedBy row={row} />
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
            {changes.loading && !changes.value ? (
              <span className="t2" role="status">
                Reading the changed files…
              </span>
            ) : changes.error ? (
              changes.error
            ) : changes.value?.available === false ? (
              (changes.value.reason ?? 'The changed files were not reported')
            ) : (
              `${plural(changes.value?.total ?? 0, 'file')}${list.length ? ', listed below' : ''}`
            )}
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
          <A
            className="btn"
            href={visitor ? atHead() : `${hrefFor({ ...route, rest: row.receiptId })}?view=changes`}
          >
            Read the code here
          </A>
          {evidence?.laneId ? (
            <A
              className="btn"
              href={hrefFor({ ...route, place: 'lanes', section: '', rest: evidence.laneId })}
            >
              See the Lane
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
