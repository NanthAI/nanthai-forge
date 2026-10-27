import { providerLogUrl } from '../../../src/check-log-policy';
import type { CheckRun } from '../../../src/work-types';
// SPDX-License-Identifier: Apache-2.0
import { useState, type ReactNode } from 'react';
import { Button, ExactRecord, StatusPill } from '../ui/primitives';
import { RunLog } from './RunLog';
import { liveRun, scopeLabel, type LogRead } from './run-model';
export type DetailRun = {
  id: string;
  status: string;
  viewId?: string;
  head?: string;
  base?: string;
  runner?: { host: string };
  environment?: { platform: string; arch: string; node: string };
  startedAt?: string;
  endedAt?: string;
  exitCode?: number | null;
  details?: string;
  cancelRequested?: boolean;
  backend?: CheckRun['backend'];
  failureSummary?: string;
  // gpt-c1 integration hook: populated only from recorded scope when available.
  scope?: { mode: 'scoped' | 'full'; selectedTests: readonly string[] };
};
export function RunDetail({
  run,
  read,
  rerun,
  cancel,
  children,
  superseded,
  remote = false,
}: {
  run: DetailRun;
  read: LogRead;
  rerun?: () => Promise<string>;
  cancel?: () => Promise<string>;
  children?: ReactNode;
  superseded?: boolean;
  remote?: boolean;
}) {
  const providerUrl = providerLogUrl(run);
  const [open, setOpen] = useState(new URLSearchParams(location.search).get('checkRun') === run.id);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  async function act(action: () => Promise<string>) {
    setBusy(true);
    setMessage('');
    try {
      setMessage(await action());
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="fx-run-detail">
      <div className="fx-run-meta">
        {superseded && <StatusPill tone="plain">Superseded run</StatusPill>}
        {scopeLabel(run.scope) && <span>{scopeLabel(run.scope)}</span>}
        {run.cancelRequested && liveRun(run.status) && <span>Cancellation requested</span>}
      </div>
      <div className="fx-run-tools">
        {providerUrl ? (
          <a href={providerUrl} target="_blank" rel="noreferrer">
            Full log on {run.backend?.actual === 'github-actions' ? 'GitHub Actions' : 'Modal'}
          </a>
        ) : (
          <Button aria-expanded={open} onClick={() => setOpen(value => !value)}>
            {open ? 'Hide output' : 'Full log'}
          </Button>
        )}
        {rerun && !liveRun(run.status) && (
          <Button disabled={busy} onClick={() => void act(rerun)}>
            Rerun on this Candidate
          </Button>
        )}
        {cancel && liveRun(run.status) && (
          <Button disabled={busy || run.cancelRequested} onClick={() => void act(cancel)}>
            Cancel check
          </Button>
        )}
      </div>
      {providerUrl && run.failureSummary && <pre className="fx-run-output">{run.failureSummary}</pre>}
      {open && !providerUrl && (
        <RunLog
          key={run.id}
          runId={run.id}
          status={run.status}
          read={read}
          remoteMachine={remote ? run.runner?.host || 'the runner' : undefined}
        />
      )}
      <div role="status" className="fx-run-feedback">
        {message}
      </div>
      {children}
      <ExactRecord
        summary="Exact run record"
        rows={[
          ['Run', run.id],
          ['Candidate', run.viewId],
          ['Head', run.head],
          ['Base', run.base],
          [
            'Environment',
            run.environment
              ? `${run.environment.platform}/${run.environment.arch} ${run.environment.node}`
              : undefined,
          ],
          ['Started', run.startedAt],
          ['Ended', run.endedAt],
          ['Result', run.details],
        ]}
      />
    </div>
  );
}
