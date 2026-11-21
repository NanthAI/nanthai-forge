// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import type { CodeFileHistoryPage } from '../../../../src/code-history';
import { A } from '../frames';
import { hrefFor } from '../paths';
import type { CodeProps } from './CodePlace';
import { messageOf, useFileHistoryReader, useRead } from './code-data';
import { landedAt, landedBy, plural, titleOf } from './code-words';

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
  const ask = useFileHistoryReader(projectId, path);
  const [retry, setRetry] = useState(0);
  const first = useRead('file-history', () => ask(before), retry);
  const [more, setMore] = useState<CodeFileHistoryPage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (first.error)
    return (
      <div className="pad" role="alert">
        <p>{first.error}</p>
        <button type="button" className="btn sm" onClick={() => setRetry(retry + 1)}>
          Retry
        </button>
      </div>
    );
  if (!first.value)
    return (
      <p className="quietline" role="status">
        Reading landings…
      </p>
    );
  const pages = [first.value, ...more];
  const rows = pages.flatMap(page => page.landings);
  const missing = pages.reduce((total, page) => total + page.missing, 0);
  const scanned = pages.every(page => page.scanned !== undefined)
    ? pages.reduce((total, page) => total + (page.scanned ?? 0), 0)
    : null;
  const next = (more.at(-1) ?? first.value).nextBefore;
  const loadMore = () => {
    if (next === null || busy) return;
    setBusy(true);
    setError('');
    void ask(next).then(
      page => {
        setMore(was => [...was, page]);
        setBusy(false);
      },
      caught => {
        setError(messageOf(caught));
        setBusy(false);
      },
    );
  };
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
          <button type="button" className="btn sm" onClick={loadMore} disabled={busy}>
            {busy ? 'Reading landings…' : 'Show earlier landings'}
          </button>
          {error ? <p role="alert">{error}</p> : null}
        </div>
      ) : null}
    </>
  );
}
