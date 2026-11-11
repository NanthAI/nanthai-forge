// SPDX-License-Identifier: Apache-2.0
import { useAction, useQuery } from 'convex/react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';
import { semanticReportsSchema } from '../../../src/intent-semantic-conflict';
import { parseHostedResponse } from '../../../src/hosted-response';
import { hostedCheckRunSchema } from '../../../src/hosted-check';
import { z } from 'zod';
import { Button } from '../ui/primitives';
import { ErrorToast } from '../ui/Toast';
const pageSchema = z.object({ contractReports: semanticReportsSchema, nextCursor: z.string().nullable() });
function Reports({ projectId, runId }: { projectId: Id<'hostedProjects'>; runId: string }) {
  const status = useQuery(api.projectHostedCheckRead.status, {
    projectId,
    runId,
    features: ['ci-status-check', 'check-report-detail'],
  });
  const read = useAction(api.projectHostedCheckDetail.reports);
  const [page, setPage] = useState<z.infer<typeof pageSchema> | null>(null);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const [busy, setBusy] = useState(false);
  async function load(cursor: string | null = null) {
    const request = ++generation.current;
    setBusy(true);
    setError('');
    try {
      const next = parseHostedResponse(pageSchema, await read({ projectId, runId, failed: true, cursor }));
      if (request === generation.current) setPage(next);
    } catch (failure) {
      if (request === generation.current)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }
  // This component exists only while the detail disclosure is open. The header stays reactive;
  // immutable report detail is read once per recorded update, with no timer or polling.
  useEffect(() => {
    if (status === undefined) return;
    try {
      parseHostedResponse(hostedCheckRunSchema, status);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      return;
    }
    setPage(null);
    void load();
    return () => {
      generation.current++;
    };
  }, [status, projectId, runId, read]);
  return (
    <>
      {page &&
        Object.entries(page.contractReports).map(([file, report]) => (
          <div key={file}>
            <b>
              {file} · {report.failed ? 'Failed' : 'Flaky'}
            </b>
            {report.firstError && <pre className="fx-log">{report.firstError}</pre>}
          </div>
        ))}
      {page && !Object.keys(page.contractReports).length && <p>No retained failed or flaky file detail.</p>}
      {busy && <p>Loading test reports…</p>}
      {page?.nextCursor && (
        <Button disabled={busy} onClick={() => void load(page.nextCursor)}>
          More reports
        </Button>
      )}
      <ErrorToast error={error} retry={() => void load()} />
    </>
  );
}
export function CheckReportDetail(props: { projectId: Id<'hostedProjects'>; runId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>Test reports</summary>
      {open && <Reports {...props} />}
    </details>
  );
}
