import { ErrorToast } from './ui/Toast';
// SPDX-License-Identifier: Apache-2.0
import { useState, type ReactNode } from 'react';
import { useMutation, usePaginatedQuery } from 'convex/react';
import { makeFunctionReference, type PaginationOptions, type PaginationResult } from 'convex/server';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import { useWorkRecord, useWorkRecords, type WorkIndexWorkspace } from './hosted-work-index';
import { useNow } from './shell/StatusBar';
import { hostedError } from './snapshot';
import type { CheckRun } from '../../src/work-types';
import { Button, StatusPill } from './ui/primitives';
import { age, checkStatus } from './ui/status';
import { logCommand, cancellationResult } from './lane/run-model';
import './local-checks.css';

type Check = {
  id: string;
  name: string;
  definition: string;
  at?: string;
  executable?: string;
  args?: string[];
  environmentLabel?: string;
  env?: string[];
  credentials?: string[];
};
type Project = { projectId: Id<'hostedProjects'> };
type Request = Project &
  Pick<
    Doc<'projectCheckRequests'>,
    'operationId' | 'runnerId' | 'viewId' | 'head' | 'checkId' | 'definition'
  >;
const runnersRef = makeFunctionReference<
  'query',
  Project & { paginationOpts: PaginationOptions },
  PaginationResult<Doc<'projectCheckRunners'>>
>('projectCheckRequests:runners');
const requestsRef = makeFunctionReference<
  'query',
  Project & { viewId: string; paginationOpts: PaginationOptions },
  PaginationResult<Doc<'projectCheckRequests'>>
>('projectCheckRequests:list');
const requestRef = makeFunctionReference<'mutation', Request, Doc<'projectCheckRequests'>>(
  'projectCheckRequests:request',
);
const cancelRef = makeFunctionReference<
  'mutation',
  Project & { operationId: string },
  Doc<'projectCheckRequests'>
>('projectCheckRequests:cancel');

function Disclosure({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="fx-check-disclosure">
      <summary>{title}</summary>
      {children}
    </details>
  );
}
export default function LocalChecks({
  projectId,
  workspace,
  viewId,
  head,
  pinnedRun,
}: Project & { workspace: WorkIndexWorkspace; viewId: string; head: string; pinnedRun?: CheckRun }) {
  const now = useNow();
  const checks = useWorkRecords<Check>(projectId, workspace, 'checks');
  const runners = usePaginatedQuery(runnersRef, { projectId }, { initialNumItems: 50 });
  const requests = usePaginatedQuery(requestsRef, { projectId, viewId }, { initialNumItems: 20 });
  const request = useMutation(requestRef),
    cancel = useMutation(cancelRef);
  const [checkId, setCheckId] = useState(pinnedRun?.check.id ?? ''),
    [runnerId, setRunnerId] = useState('');
  const [pending, setPending] = useState<Request | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [filter, setFilter] = useState('');
  const sorted = [...checks.records].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const choices = sorted.filter(check =>
    check.name.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()),
  );
  const selectedCheck = pinnedRun?.check ?? choices.find(check => check.id === checkId) ?? choices[0];
  const currentDefinition = useWorkRecord<Check>(projectId, workspace, 'checks', selectedCheck?.id ?? '');
  const definition = pinnedRun?.check ?? currentDefinition;
  const choiceLabel = (check: Check) => {
    const same = sorted.filter(item => item.name === check.name);
    return same.length > 1
      ? `${check.name} · saved definition ${same.findIndex(item => item.id === check.id) + 1} of ${same.length}`
      : check.name;
  };
  const ownsRunner = (runner: Doc<'projectCheckRunners'> | undefined) =>
    Boolean(workspace.actor && runner?.actor === workspace.actor);
  const selectedRunner =
    runners.results.find(runner => runner.runnerId === runnerId) ??
    runners.results.find(ownsRunner) ??
    runners.results[0];
  const canRequest = ownsRunner(
    pending ? runners.results.find(runner => runner.runnerId === pending.runnerId) : selectedRunner,
  );
  const canChange = (item: Doc<'projectCheckRequests'>) =>
    item.actor === workspace.actor ||
    workspace.capabilities.owner ||
    runners.results.some(runner => runner.runnerId === item.runnerId && ownsRunner(runner));
  async function submit(event: React.SubmitEvent) {
    event.preventDefault();
    if (!selectedCheck || !selectedRunner || !canRequest || busy) return;
    const input = pending ?? {
      projectId,
      viewId,
      head,
      operationId: crypto.randomUUID(),
      runnerId: selectedRunner.runnerId,
      checkId: pinnedRun?.check.id ?? selectedCheck.id,
      definition: pinnedRun?.check.definition ?? selectedCheck.definition,
    };
    setPending(input);
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const receipt = await request(input);
      if (
        !receipt ||
        Object.entries(input).some(([key, value]) => receipt[key as keyof typeof input] !== value)
      )
        throw new Error('The check request was not acknowledged. Retry the original request.');
      setPending(null);
      setNotice('Check requested.');
    } catch (error) {
      setError(hostedError(error));
    } finally {
      setBusy(false);
    }
  }
  async function stop(operationId: string) {
    const item = requests.results.find(item => item.operationId === operationId);
    if (!item || !canChange(item) || busy) return;
    setBusy(true);
    setError('');
    try {
      const receipt = await cancel({ projectId, operationId });
      setNotice(
        cancellationResult({
          status: receipt.report?.status ?? 'queued',
          cancelRequested: receipt.cancelRequested,
        }),
      );
    } catch (error) {
      setError(hostedError(error));
    } finally {
      setBusy(false);
    }
  }
  const command = `nforge local-checks /path/to/your/local/project ${import.meta.env.VITE_CONVEX_URL || 'DEPLOYMENT_URL'} ${projectId}`;
  return (
    <div className="fx-connected-checks">
      <div className="local-checks">
        <div className="local-checks-heading">
          <Disclosure title="Connect a local runner">
            <pre>
              <code>{command}</code>
            </pre>
          </Disclosure>
        </div>
        {checks.loading || runners.status === 'LoadingFirstPage' ? (
          <p role="status">Loading checks and local runners…</p>
        ) : !checks.records.length && !pinnedRun ? (
          <p>No check definitions returned.</p>
        ) : !runners.results.length ? (
          <p>No connected runner.</p>
        ) : (
          <form onSubmit={submit}>
            {!pinnedRun && (
              <label className="local-check-filter">
                Find a check
                <input
                  type="search"
                  value={filter}
                  onChange={event => setFilter(event.target.value)}
                  disabled={busy || !!pending}
                  placeholder="Check name"
                />
              </label>
            )}
            {!pinnedRun && (
              <label>
                Check
                <select
                  value={selectedCheck?.id ?? ''}
                  onChange={event => setCheckId(event.target.value)}
                  disabled={busy || !!pending}
                >
                  {!choices.length && <option value="">No matching checks</option>}
                  {choices.map(check => (
                    <option key={check.id} value={check.id}>
                      {choiceLabel(check)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              Computer
              <select
                value={selectedRunner?.runnerId ?? ''}
                onChange={event => setRunnerId(event.target.value)}
                disabled={busy || !!pending}
              >
                {runners.results.map(runner => (
                  <option
                    key={runner.runnerId}
                    value={runner.runnerId}
                    disabled={!ownsRunner(runner)}
                    title={ownsRunner(runner) ? undefined : 'Only the runner owner can queue checks.'}
                  >
                    {runner.name}
                  </option>
                ))}
              </select>
            </label>
            <Button
              type="submit"
              disabled={busy || !selectedCheck || !canRequest}
              title={canRequest ? undefined : 'Only the runner owner can queue checks.'}
            >
              {busy
                ? 'Requesting…'
                : pending
                  ? 'Retry original request'
                  : pinnedRun
                    ? 'Rerun on this View'
                    : 'Run on this View'}
            </Button>
          </form>
        )}
        {definition && (
          <Disclosure title="Check definition">
            <p>
              {definition.name} · {definition.environmentLabel}
            </p>
            <pre>
              <code>
                {[definition.executable, ...(definition.args ?? [])]
                  .map(value => JSON.stringify(value))
                  .join(' ')}
              </code>
            </pre>
          </Disclosure>
        )}
        {selectedRunner && (
          <p className="local-checks-report">
            {selectedRunner.name} · {selectedRunner.listening ? 'Listening at last report' : 'Disconnected'} ·{' '}
            {age(selectedRunner.lastSeen, now, true)}
          </p>
        )}
        {runners.status === 'CanLoadMore' && (
          <Button onClick={() => runners.loadMore(50)}>More computers</Button>
        )}
        {error && <ErrorToast>{error}</ErrorToast>}
        {notice && <p role="status">{notice}</p>}
        {requests.status === 'LoadingFirstPage' && <p role="status">Loading check requests…</p>}
        <ul className="local-check-requests">
          {requests.results
            .filter(item => !(item.state === 'finished' && item.report?.runId === pinnedRun?.id))
            .map(item => (
              <li key={item.operationId}>
                <div>
                  <strong>{item.checkName}</strong>
                  <StatusPill tone={checkStatus(item.report?.status ?? 'queued').tone}>
                    {item.cancelRequested && item.state !== 'finished'
                      ? 'Cancellation requested'
                      : checkStatus(item.report?.status ?? 'queued').label}
                  </StatusPill>
                </div>
                <p>
                  {item.runnerName} · {age(item.createdAt, now, true)}
                </p>
                {item.report?.status === 'error' && <ErrorToast error={item.report.message} />}
                <div className="import-actions">
                  {item.state !== 'finished' && !item.cancelRequested && canChange(item) && (
                    <Button disabled={busy} onClick={() => void stop(item.operationId)}>
                      Cancel check
                    </Button>
                  )}
                  <Disclosure title="Run details">
                    <p>{item.report?.message ?? 'Waiting for the selected local runner.'}</p>
                    <p>
                      Reported by {item.runnerName}. Last update {new Date(item.updatedAt).toLocaleString()}.
                    </p>
                    <p>
                      Source <code>{item.head}</code>
                    </p>
                    <p>
                      Check definition <code>{item.definition}</code>
                    </p>
                    {item.report?.runId && (
                      <>
                        <p>
                          Original run <code>{item.report.runId}</code>
                        </p>
                        <p>Local log command:</p>
                        <pre>
                          <code>{logCommand(item.report.runId)}</code>
                        </pre>
                      </>
                    )}
                    {item.report?.exitCode !== null && item.report?.exitCode !== undefined && (
                      <p>Exit code {item.report.exitCode}</p>
                    )}
                  </Disclosure>
                </div>
              </li>
            ))}
        </ul>
        {requests.status === 'CanLoadMore' && (
          <Button onClick={() => requests.loadMore(20)}>Earlier requests</Button>
        )}
      </div>
    </div>
  );
}
