// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { useState } from 'react';
import { useConvex } from 'convex/react';
import { makeFunctionReference } from 'convex/server';
import { A } from '../frames';
import { hrefFor } from '../paths';
import type { CodeRoute } from './CodePlace';
import { parseReply, useRead, type ProjectId } from './code-data';
import { landedAt, landedBy, titleOf } from './code-words';
import type { FileHistoryView } from './use-file-history';

const readOrigins = makeFunctionReference<
  'action',
  {
    projectId: ProjectId;
    path: string;
    blob: string;
    pairs: { base: string; head: string }[];
  },
  string
>('projectCodeLineHistory:read');

export function LineHistory({
  projectId,
  path,
  route,
  blob,
  line,
  file,
  state,
}: {
  projectId: ProjectId;
  path: string;
  route: CodeRoute;
  blob: string;
  line: number | null;
  file: FileHistoryView;
  state: string;
}) {
  const client = useConvex();
  const [retry, setRetry] = useState(0);
  const rows = file.rows
    .slice(0, file.traceable ?? 0)
    .filter(
      (row, i, all) =>
        !row.batch || !all[i - 1]?.batch || row.base !== all[i - 1]?.base || row.head !== all[i - 1]?.head,
    )
    .slice(0, 4);
  const pairs = rows.map(({ base, head }) => ({ base, head }));
  const enabled = Boolean(line && file.newestHead === state && pairs.length);
  const read = useRead<{ origins: (number | null)[] }>(
    enabled ? JSON.stringify([projectId, path, blob, pairs]) : null,
    () =>
      client
        .action(readOrigins, { projectId, path, blob, pairs })
        .then(parseReply<{ origins: (number | null)[] }>),
    retry,
  );
  const index = line ? read.value?.origins[line - 1] : null;
  const landing = index != null ? rows[index] : undefined;
  return (
    <>
      <div className="ph plain">
        <h2>Who changed these lines</h2>
      </div>
      <div className="pad" aria-live="polite">
        {!line ? (
          <p className="t2">Select a line number to see its landing.</p>
        ) : read.loading || file.loading ? (
          <p className="t2">Reading line {line.toLocaleString()}…</p>
        ) : read.error ? (
          <>
            <p>{read.error}</p>
            <button type="button" className="btn sm" onClick={() => setRetry(n => n + 1)}>
              Retry
            </button>
          </>
        ) : landing ? (
          <>
            <p className="t2">Line {line.toLocaleString()}</p>
            <p>
              <A
                className="lk"
                dir="auto"
                href={`${hrefFor({ ...route, section: '', rest: landing.receiptId })}?view=changes&file=${encodeURIComponent(path)}`}
              >
                {titleOf(landing)}
              </A>
            </p>
            <p className="t2">
              {landing.batch
                ? 'Landed in a batch'
                : landedBy(landing)
                  ? `Landed by ${landedBy(landing)}`
                  : 'Who landed it not reported'}{' '}
              · {landedAt(landing.at)} · {landing.check ? 'Check passed' : 'Not checked'}
            </p>
            {landing.itemId ? (
              <p>
                <A
                  className="lk"
                  href={hrefFor({ ...route, place: 'plan', section: '', rest: landing.itemId })}
                >
                  Open Item
                </A>
              </p>
            ) : null}
          </>
        ) : (
          <p className="t2">No recorded origin for line {line.toLocaleString()} in the recent landings.</p>
        )}
      </div>
    </>
  );
}
