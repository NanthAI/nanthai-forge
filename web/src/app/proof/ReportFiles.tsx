// SPDX-License-Identifier: Apache-2.0
import { useAction } from 'convex/react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import { Key, Row } from '../../ds';

type Page = {
  contractReports: Record<string, { failed: boolean; flaky?: boolean; durationMs?: number }>;
  nextCursor: string | null;
};
type Props = { projectId: Id<'hostedProjects'>; runId: string; version: string | null };
function ReportPage({ projectId, runId, version }: Props) {
  const read = useAction(api.projectHostedCheckDetail.reports);
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  async function load(cursor: string | null = null) {
    const token = ++request.current;
    setBusy(true);
    setError('');
    try {
      const value = JSON.parse(await read({ projectId, runId, cursor })) as Page;
      if (request.current === token) setPage(value);
    } catch (failure) {
      if (request.current === token) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (request.current === token) setBusy(false);
    }
  }
  useEffect(() => {
    void load();
    return () => {
      request.current++;
    };
  }, [projectId, runId, read, version]);
  return (
    <>
      <p className="quietline">Reported by the checked code, via CI. Each page replaces the last.</p>
      {page
        ? Object.entries(page.contractReports).map(([file, report]) => (
            <Row key={file} cols="minmax(0,1fr) auto">
              <span className="any mono">{file}</span>
              <span className="meta">
                {report.failed ? 'Failed' : report.flaky ? 'Passed on retry' : 'Reported passed'}
                {report.durationMs === undefined
                  ? ''
                  : ` · ${(report.durationMs / 1000).toLocaleString()} s, self-reported`}
              </span>
            </Row>
          ))
        : null}
      {page && !Object.keys(page.contractReports).length ? (
        <p className="quietline">No retained file reports are available.</p>
      ) : null}
      {error ? (
        <div className="quietline" role="alert">
          {error}
          <Key size="sm" onClick={() => void load()}>
            Try again
          </Key>
        </div>
      ) : null}
      {busy ? (
        <p className="quietline" role="status">
          Loading file reports…
        </p>
      ) : null}
      {page?.nextCursor ? (
        <div className="pad">
          <Key size="sm" disabled={busy} onClick={() => void load(page.nextCursor)}>
            Next page of reports
          </Key>
        </div>
      ) : null}
    </>
  );
}
export function ReportFiles(props: Props) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={event => setOpen(event.currentTarget.open)}>
      <summary className="quietline">Reported test files</summary>
      {open ? <ReportPage {...props} /> : null}
    </details>
  );
}
