// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from 'react';
import type { HostedRunSummary } from '../../../src/work-hosted-summary';
import type { WorkData } from '../../../src/work-types';
import { Panel, StatusPill } from '../ui/primitives';
import { age, checkStatus } from '../ui/status';
import { checkDuration } from './CheckPanel';
import { useNow } from '../shell/StatusBar';
export function ReviewCheck({
  run,
  head,
  children,
  superseded,
}: {
  run?: WorkData['runs'][number] | HostedRunSummary;
  head?: string;
  children?: ReactNode;
  superseded?: boolean;
}) {
  const now = useNow();
  if (!run) return null;
  const state = checkStatus(superseded ? 'superseded' : run.status);
  return (
    <Panel title="Check record">
      <div className="fx-review-check">
        {run ? (
          <>
            <StatusPill tone={state.tone}>
              {'check' in run ? run.check.name : run.checkName} · {state.label}
              {run.exitCode != null ? ` · exit ${run.exitCode}` : ''}
              {checkDuration(run) ? ` · ${checkDuration(run)}` : ''}
            </StatusPill>
            <span className="fx-faint" title={run.endedAt ?? run.startedAt}>
              {age(run.endedAt ?? run.startedAt, now, true)} ·{' '}
              {run.head === head ? 'exactly this View' : 'different source'}
            </span>
            {children}
          </>
        ) : (
          <p className="fx-faint">No check recorded for this View.</p>
        )}
      </div>
    </Panel>
  );
}
