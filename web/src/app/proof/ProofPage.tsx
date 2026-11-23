// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { useConvex, useMutation, useQuery } from 'convex/react';
import { Component, useMemo, useState, type ReactNode } from 'react';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import { hrefFor, type AppRoute } from '../paths';
import { useSearch } from '../router';
import { Head } from '../Place';
import { Key } from '../../ds';
import { BrowserLanding } from '../../lane/hosted-landing-client';
import { landingBrowserIO } from '../../lane/landing-browser-io';
import { TakeOut, takenOutText } from '../take-out';
import { proofRecheckId } from '../../../../src/run-evidence';
import { ReportFiles } from './ReportFiles';
import { ProofView, type ProofData } from './ProofView';

type ProjectRoute = Extract<AppRoute, { frame: 'project' }>;
function ProofRead({ projectId, route }: { projectId: Id<'hostedProjects'>; route: ProjectRoute }) {
  const search = useSearch();
  const laneId = route.rest.split('/')[0]!;
  const [runId, setRunId] = useState(search.get('run') ?? undefined);
  const read = useQuery(api.projectRunProof.read, {
    projectId,
    laneId,
    ...(search.get('save') ? { saveId: search.get('save')! } : {}),
    ...(runId ? { runId } : {}),
  });
  const runAll = useMutation(api.projectRunProofActions.runAll);
  const followups = useMutation(api.projectRunProofActions.followups);
  const client = useConvex();
  const landing = useMemo(() => new BrowserLanding(landingBrowserIO(client, projectId)), [client, projectId]);
  const takeOut = useMemo(() => new TakeOut(landing), [landing]);
  const [undone, setUndone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  if (read === undefined)
    return <Head trail={[{ label: 'What was checked' }]} sentence="Loading this Lane’s evidence…" />;
  const data = JSON.parse(read) as ProofData;
  const claim = data.declaration ?? data.save;
  const laneHref = hrefFor({ ...route, rest: laneId });
  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <ProofView
      data={data}
      reportDetails={
        data.check ? (
          <ReportFiles
            key={data.check.runId}
            projectId={projectId}
            runId={data.check.runId}
            version={
              data.check.endedAt
                ? [
                    data.check.endedAt,
                    data.check.files?.total,
                    data.check.files?.failed,
                    data.check.files?.flaky,
                  ].join(':')
                : null
            }
          />
        ) : null
      }
      busy={busy}
      message={message}
      error={error}
      lanesHref={hrefFor({ ...route, rest: '', section: '' })}
      changeHref={laneHref}
      onRevert={
        data.landing && !undone
          ? () =>
              void act(async () => {
                await takeOut.press(
                  data.landing!.receiptId,
                  'Take the change selected on the proof page out of main',
                );
                setUndone(true);
                setMessage(takenOutText);
              })
          : undefined
      }
      recoveryHref={hrefFor({ ...route, rest: `${laneId}/check` })}
      onRunAll={
        data.check
          ? () =>
              void act(async () => {
                const result = JSON.parse(
                  await runAll({
                    projectId,
                    runId: data.check!.runId,
                    operationId: proofRecheckId(data.check!.runId),
                  }),
                );
                const next = result.id ?? result.run?.id;
                if (next) {
                  setRunId(next);
                }
                setMessage('A full check was requested on this exact source. Its result appears here.');
              })
          : undefined
      }
      onFollowups={
        claim?.notVerified?.length
          ? line =>
              void act(async () => {
                let offset: number | null = 0;
                let count = 0;
                do {
                  const result = JSON.parse(
                    await followups({
                      projectId,
                      ...(data.declaration
                        ? { submissionId: data.declaration.id }
                        : { saveId: data.save!.id }),
                      ...(line === undefined ? { offset } : { line }),
                    }),
                  );
                  count += result.items.length;
                  offset = result.nextOffset;
                } while (offset !== null);
                setMessage(
                  `${count} linked ${count === 1 ? 'Item' : 'Items'} in Plan. Retrying keeps the same Items.`,
                );
              })
          : undefined
      }
    />
  );
}

class ProofBoundary extends Component<{ children: ReactNode }, { error: string | null; attempt: number }> {
  state = { error: null as string | null, attempt: 0 };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    if (this.state.error)
      return (
        <>
          <Head trail={[{ label: 'What was checked' }]} sentence="The retained evidence could not be read." />
          <div className="quietline" role="alert">
            {this.state.error}
          </div>
          <div className="pad">
            <Key onClick={() => this.setState(state => ({ error: null, attempt: state.attempt + 1 }))}>
              Try again
            </Key>
          </div>
        </>
      );
    return <div key={this.state.attempt}>{this.props.children}</div>;
  }
}
export default function ProofPage(props: { projectId: Id<'hostedProjects'>; route: ProjectRoute }) {
  return (
    <ProofBoundary>
      <ProofRead {...props} />
    </ProofBoundary>
  );
}
