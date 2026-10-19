import { Breadcrumbs, workHref } from '../shell/Breadcrumbs';
import { useReadRetry } from '../ui/read-retry';
import { ErrorToast } from '../ui/Toast';
import { ConversationScope } from './ConversationScope';
// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAction, useConvex, useQuery } from 'convex/react';
import type { FunctionArgs } from 'convex/server';
import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';
import type { HostedRunSummary } from '../../../src/work-hosted-summary';
import type { WorkData, HostedChannelMove, MetadataCommand } from '../../../src/work-types';
import { useWorkRecord, type WorkIndexWorkspace } from '../hosted-work-index';
import { hostedHref } from '../cockpit/HostedNow';
import { hostedError } from '../snapshot';
import { Button, ExactRecord, Panel, StatusPill } from '../ui/primitives';
import { BriefSourceContext, hostedBriefs } from '../cockpit/brief';
import { CopyPrompt } from '../cockpit/CopyPrompt';
import { HostedLaneChanges } from './HostedLaneChanges';
import { ReviewStory } from './ReviewStory';
import NativeSourceReview from '../NativeSourceReview';
import { HostedConversation } from './HostedConversation';
import { PendingWrite } from '../pending-write';
import { useCoordination } from '../cockpit/coordination';
import { RequestChanges } from './RequestChanges';
import { reviewViewLabel } from './review-model';
import { ReviewDisposition } from './ReviewDisposition';
import type { ReviewRead } from './review-model';
import { protectedMatches } from '../../../src/autonomy-policy';
import { overlappingPaths } from '../../../src/coordination-paths';
import LocalChecks from '../LocalChecks';
import { HostedRunDetail } from './HostedRunDetail';
import { ReviewCheck } from './ReviewCheck';
import { HostedRevertAcceptance } from './RevertAcceptance';
import { ownerDecisionState, mainAncestryGate } from './owner-decision-model';
import { OwnerDecision } from './OwnerDecision';
import { Glyph } from '../ui/Glyph';

type Props = {
  projectId: Id<'hostedProjects'>;
  workspace: WorkIndexWorkspace;
  view: WorkData['views'][number] & { main?: { head?: string | null; included: boolean | null } };
  channels: HostedChannelMove[];
  owner: boolean;
  editable: boolean;
  busy: boolean;
  lanes: WorkData['lanes'];
  views: WorkData['views'];
  act: (command: MetadataCommand) => Promise<unknown>;
};
export function HostedReview({
  projectId,
  workspace,
  view,
  channels,
  owner,
  editable,
  busy,
  lanes,
  views,
  act,
}: Props) {
  const readAttempt = useReadRetry();
  const client = useConvex(),
    read = useAction(api.projectViewActions.read);
  const briefs = useMemo(() => hostedBriefs(client, projectId), [client, projectId]);
  const intent = useWorkRecord<WorkData['intents'][number]>(projectId, workspace, 'intents', view.intentId);
  const [story, setStory] = useState<ReviewRead | null>(null),
    [error, setError] = useState('');
  const [runs, setRuns] = useState<HostedRunSummary[]>([]);
  useEffect(() => {
    let active = true;
    setStory(null);
    setError('');
    void (async () => {
      const args = {
        projectId,
        viewId: view.id,
        paginationOpts: { numItems: 100, cursor: null as string | null },
      };
      const initial = JSON.parse(
        await client.query(api.projectViewReads.read, { ...args, action: 'view' }),
      ) as ReviewRead & { runs: HostedRunSummary[] };
      const files: ReviewRead['files']['items'] = [];
      let cursor: string | null = null;
      do {
        const page = JSON.parse(
          await read({ ...args, action: 'provenance', paginationOpts: { numItems: 100, cursor } }),
        ) as ReviewRead;
        files.push(...page.files.items);
        cursor = page.files.nextCursor ?? null;
      } while (cursor !== null && active);
      if (active) {
        setStory({ ...initial, files: { ...initial.files, items: files } });
        setRuns(initial.runs);
      }
    })().catch(e => {
      if (active) setError(hostedError(e));
    });
    return () => {
      active = false;
    };
  }, [client, read, projectId, view.id, workspace.revision, readAttempt]);
  const successorRead = useQuery(
    api.projectViewReads.read,
    story?.supersededBy
      ? {
          projectId,
          action: 'view',
          viewId: story.supersededBy,
          paginationOpts: { numItems: 1, cursor: null },
        }
      : 'skip',
  );
  const successor = successorRead
    ? (JSON.parse(successorRead) as ReviewRead & { runs: HostedRunSummary[] })
    : null;
  const successorRun = successor?.runs
    .filter(run => run.head === successor.head)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .at(-1);
  const [requestedId, setRequestedId] = useState('');
  const ownerStatus = useQuery(api.ownerAcceptance.status, { projectId, viewId: view.id });
  const acceptance =
    story?.accepted
      .filter(
        move =>
          move.channel === 'main' &&
          move.head === view.head &&
          ownerStatus &&
          (!ownerStatus.native || move.canonical === true),
      )
      .at(-1) ??
    (ownerStatus && !ownerStatus.native
      ? channels.find(move => move.viewId === view.id && move.channel === 'main' && move.head === view.head)
      : undefined);
  const superseded = !acceptance && story?.status === 'superseded';
  const policy = useQuery(api.projectAutonomy.read, { projectId });
  const claims = useQuery(api.projectCoordinationReads.claims, { projectId });
  const overlaps = new Map<string, string[]>();
  const files = story?.files.items.map(file => file.path) ?? [];
  for (const claim of claims?.claims ?? [])
    if (!view.inputs.some(input => input.laneId === claim.laneId)) {
      for (const path of overlappingPaths(files, claim.paths))
        overlaps.set(path, [
          ...new Set([
            ...(overlaps.get(path) ?? []),
            lanes.find(lane => lane.id === claim.laneId)?.name ?? 'Another contributor',
          ]),
        ]);
    }
  const protectedPaths = policy ? protectedMatches(policy, files) : [];
  const accepted = ownerStatus?.native
    ? ownerStatus.request?.state === 'accepted' || Boolean(acceptance)
    : Boolean(ownerStatus) && Boolean(acceptance);
  const ownerDecision = ownerDecisionState({
    ...(ownerStatus?.request ? { state: ownerStatus.request.state } : {}),
    ...(ownerStatus?.machine ? { machineName: ownerStatus.machine.name } : {}),
    accepted,
    optimistic: Boolean(requestedId && requestedId !== ownerStatus?.request?.operationId),
  });
  const run = runs
    .filter(run => run.head === view.head)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .at(-1);
  const passed = run?.status === 'passed';
  const [pending, setPending] = useState<FunctionArgs<typeof api.projectWorkActions.acceptChannel> | null>(
    null,
  );
  const [accepting, setAccepting] = useState(false),
    [acceptError, setAcceptError] = useState(''),
    [done, setDone] = useState<{ at: string; actor: string } | null>(null);
  const accept = async () => {
    if (!view.head) return;
    const original = pending ?? {
      projectId,
      operationId: crypto.randomUUID(),
      revision: workspace.revision,
      command: JSON.stringify({
        action: 'accept-hosted-channel',
        channel: 'main',
        viewId: view.id,
        head: view.head,
        archiveSha256: workspace.backupDigest,
        previousId: channels.find(move => move.channel === 'main')?.id ?? null,
      }),
    };
    setPending(original);
    setAccepting(true);
    setAcceptError('');
    try {
      const result = await client.action(api.projectWorkActions.acceptChannel, original);
      setPending(null);
      if (!('state' in result)) setDone({ at: result.at, actor: result.actor });
    } catch (e) {
      setAcceptError(hostedError(e));
    } finally {
      setAccepting(false);
    }
  };
  const coordination = useCoordination(projectId);
  const delivery = useRef<PendingWrite<
    import('../../../src/coordination-types').CoordinationCommand,
    unknown
  > | null>(null);
  delivery.current ??= new PendingWrite(attempt =>
    client.mutation(api.projectCoordination.publish, { projectId, ...attempt }),
  );
  const recorded = useRef(false);
  const delivered = useRef(new Set<string>());
  const feedback = useRef<FunctionArgs<typeof api.projectWorkCommand.command> | null>(null);
  const send = useCallback(
    async (text: string): Promise<string> => {
      const requested = {
        projectId,
        operationId: crypto.randomUUID(),
        command: JSON.stringify({
          action: 'note',
          intentId: view.intentId,
          kind: 'decision',
          text: `Changes requested for [View](${hostedHref({ projectTab: 'intent', reviewView: view.id })}) @ ${view.head}:\n${text}`,
        }),
      };
      const original = feedback.current ?? requested;
      feedback.current = original;
      if (!recorded.current) {
        await client.mutation(api.projectWorkCommand.command, original);
        recorded.current = true;
      }
      for (const input of view.inputs.length ? view.inputs : [{ laneId: '' }]) {
        if (delivered.current.has(input.laneId)) continue;
        const recipient = coordination.sessions
          .filter(session => session.context.laneId === input.laneId && session.status !== 'completed')
          .sort((a, b) => b.lastSeen - a.lastSeen)[0];
        await delivery.current!.send({
          kind: 'message',
          ...(recipient ? { recipient: recipient.sessionId } : {}),
          text: JSON.parse(original.command).text,
          context: {
            ...(input.laneId ? { laneId: input.laneId } : {}),
            intentId: view.intentId,
            head: view.head!,
          },
        });
        delivered.current.add(input.laneId);
      }
      feedback.current = null;
      recorded.current = false;
      delivered.current.clear();
      if (original.command !== requested.command) return send(text);
      return `Review feedback recorded · sent to ${view.inputs.length ? 'Lane' : 'Intent'} conversation.`;
    },
    [client, projectId, view.id, view.intentId, view.head, view.inputs, coordination.sessions],
  );
  const gates: { ok: boolean; warn?: boolean; title: string; body: string }[] = [
    {
      ok: passed,
      warn: !passed,
      title: run
        ? `Check ${run.status} on exactly this View`
        : story
          ? 'No check recorded for this View'
          : 'Reading check record…',
      body: run?.checkName ?? '',
    },
    mainAncestryGate({
      included: view.main?.included,
      indexedMain: view.main?.head,
      currentMain: ownerStatus?.mainHead,
      rejection:
        ownerStatus?.request?.state === 'rejected' && ownerStatus.request.receipt
          ? JSON.parse(ownerStatus.request.receipt)
          : null,
    }),
    { ok: owner, title: owner ? 'You can accept as project owner' : 'Project owner accepts', body: '' },
  ];
  return (
    <BriefSourceContext.Provider value={briefs}>
      <div className="fx fx-page fx-review-page">
        <Breadcrumbs
          items={[
            {
              label: story?.why.outcome ?? intent?.outcome ?? 'Intent',
              href: workHref({ intent: view.intentId }),
            },
            ...view.inputs.map(input => ({
              label: lanes.find(lane => lane.id === input.laneId)?.name ?? 'Lane',
              href: workHref({ projectTab: 'lanes', lane: input.laneId }),
            })),
            {
              label: 'Review',
              href: workHref({
                intent: view.intentId,
                intentTab: 'delivery',
                reviewView: view.id,
                classic: '1',
              }),
            },
          ]}
        />
        <div className="fx-review-head">
          <StatusPill
            tone={
              ownerStatus?.native && !superseded
                ? ownerDecision.tone
                : accepted || done
                  ? 'passed'
                  : superseded
                    ? 'stale'
                    : passed
                      ? 'passed'
                      : 'waiting'
            }
            glyph={superseded ? 'stale' : undefined}
          >
            {ownerStatus?.native && !superseded
              ? ownerDecision.label
              : accepted || done
                ? 'Accepted'
                : story?.status === 'superseded'
                  ? 'Superseded'
                  : passed
                    ? 'Ready'
                    : 'Waiting'}
          </StatusPill>
          <h1 title={story?.why.outcome ?? intent?.outcome}>
            {story?.why.outcome ?? intent?.outcome ?? 'Review View'}
          </h1>
          <div className="fx-lane-meta">
            <span>
              {reviewViewLabel(views, view.id)} · {view.inputs.length}{' '}
              {view.inputs.length === 1 ? 'Lane' : 'Lanes'} · {story?.files.total ?? '…'}{' '}
              {story?.files.total === 1 ? 'file' : 'files'} · into <b>main</b>
            </span>
          </div>
        </div>
        <div className="fx-review-grid">
          <div className="fx-lane-col">
            <ReviewStory
              data={story}
              error={error}
              outcome={story?.why.outcome ?? intent?.outcome ?? 'Intent'}
              intentHref={hostedHref({ projectTab: 'intent', intent: view.intentId })}
              laneName={id => lanes.find(lane => lane.id === id)?.name ?? 'Lane'}
              overlaps={overlaps}
              protectedPaths={protectedPaths}
            >
              {(paths, title) =>
                view.head && view.status === 'clean' ? (
                  <HostedLaneChanges
                    projectId={projectId}
                    backupId={workspace.backupId}
                    base={view.base}
                    head={view.head}
                    paths={paths}
                    title={title}
                  />
                ) : (
                  <Panel title="Unresolved composition">
                    <p className="fx-review-empty">Open the Lane to resolve conflicts.</p>
                  </Panel>
                )
              }
            </ReviewStory>
          </div>
          <aside className="fx-lane-col fx-review-side">
            <details className="fx-panel">
              <summary>Line comments</summary>
              <NativeSourceReview
                projectId={projectId}
                workspace={workspace}
                intentId={view.intentId}
                viewId={view.id}
                base={view.base}
                head={view.head!}
                editable={editable}
                busy={busy}
                act={act}
              />
            </details>
            <ConversationScope
              lanes={view.inputs.map(input => ({
                id: input.laneId,
                name: lanes.find(lane => lane.id === input.laneId)?.name ?? 'Lane',
              }))}
            >
              {laneId => (
                <HostedConversation
                  projectId={projectId}
                  {...(laneId ? { laneId } : {})}
                  intentId={view.intentId}
                  viewId={view.id}
                />
              )}
            </ConversationScope>
            {story?.accepted
              .filter(move => move.channel !== 'main' && move.head === view.head)
              .map(move => (
                <ReviewDisposition key={`${move.channel}:${move.at}`} acceptance={move} />
              ))}
            <ReviewCheck run={run} head={view.head} superseded={superseded}>
              {run && <HostedRunDetail key={run.id} run={run} projectId={projectId} workspace={workspace} />}
            </ReviewCheck>
            {owner && !run && view.head && (
              <LocalChecks projectId={projectId} workspace={workspace} viewId={view.id} head={view.head} />
            )}
            {acceptance ? (
              <ReviewDisposition acceptance={acceptance} />
            ) : superseded && story?.supersededBy ? (
              <ReviewDisposition
                replacement={{
                  href: hostedHref({ projectTab: 'intent', reviewView: story.supersededBy }),
                  label: reviewViewLabel(views, story.supersededBy),
                  check:
                    successorRead === undefined ? undefined : (successorRun?.status ?? 'no check recorded'),
                }}
              />
            ) : done ? (
              <ReviewDisposition acceptance={done} />
            ) : !story ? (
              <p className="fx-loading">Reading View record…</p>
            ) : (
              <Panel title={accepted ? 'Acceptance' : 'Your decision'} className="fx-decide">
                {!accepted && (
                  <ul className="fx-gates">
                    {gates.map(gate => (
                      <li
                        key={gate.title}
                        className={gate.warn ? 'fx-gate-warn' : gate.ok ? 'fx-gate-ok' : 'fx-gate-bad'}
                      >
                        <span className="fx-gate-icon">
                          <Glyph name={gate.ok ? 'passed' : 'info'} size={11} />
                        </span>
                        <div>
                          <b>{gate.title}</b>
                          {gate.body && <p>{gate.body}</p>}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                {ownerStatus?.native && view.head ? (
                  <OwnerDecision
                    key={view.id}
                    projectId={projectId}
                    viewId={view.id}
                    head={view.head}
                    status={ownerStatus}
                    showReceipt={false}
                    onRequested={setRequestedId}
                    disabled={busy || !owner || view.status !== 'clean'}
                  />
                ) : (
                  <div className="fx-decide-go">
                    {accepted || done ? (
                      <p className="fx-c-passed">✓ Hosted selection updated</p>
                    ) : (
                      <Button
                        variant="primary"
                        size="lg"
                        icon="passed"
                        disabled={
                          busy || accepting || !owner || !view.head || view.status !== 'clean' || !ownerStatus
                        }
                        onClick={() => void accept()}
                      >
                        {accepting ? 'Accepting…' : pending ? 'Retry acceptance' : 'Accept into main'}
                      </Button>
                    )}
                    {acceptError && <ErrorToast>{acceptError}</ErrorToast>}
                  </div>
                )}
                {!accepted && !done && (
                  <RequestChanges draftKey={`${view.id}:${view.head}`} disabled={!editable} send={send} />
                )}
              </Panel>
            )}
            {ownerStatus?.request?.state === 'accepted' && ownerStatus.request.receipt && (
              <HostedRevertAcceptance
                projectId={projectId}
                move={JSON.parse(ownerStatus.request.receipt).acceptance}
                base={JSON.parse(ownerStatus.request.receipt).acceptance.head}
              />
            )}
            <CopyPrompt
              label="Hand to an agent"
              request={{
                situation: 'review-and-accept',
                viewId: view.id,
                ...(view.inputs[0] ? { laneId: view.inputs[0].laneId } : {}),
              }}
            />
            <Panel>
              <ExactRecord
                summary="Exact record: View, pins, receipts"
                rows={[
                  ['View', view.id],
                  ['Head', view.head],
                  ['Base', view.base],
                  ['Check run', run?.id],
                  ['Owner receipt', ownerStatus?.request?.receipt ?? undefined],
                  ['Previous main receipt', channels.find(move => move.channel === 'main')?.id],
                ]}
              />
            </Panel>
          </aside>
        </div>
      </div>
    </BriefSourceContext.Provider>
  );
}
