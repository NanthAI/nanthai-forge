import type { SemanticConflict } from '../../../src/intent-semantic-conflict';
import { readTestContract } from './test-contract-api';
import { candidateTestContract, type IntentTestContract } from '../../../src/intent-test-contract';
import { OwnerDecisionsDisclosure } from '../decisions/OwnerDecisionsPanel';
import { Breadcrumbs, workHref } from '../shell/Breadcrumbs';
import { useReadRetry } from '../ui/read-retry';
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
import { ExactRecord, Panel, StatusPill } from '../ui/primitives';
import { BriefSourceContext, hostedBriefs } from '../cockpit/brief';
import { CopyPrompt } from '../cockpit/CopyPrompt';
import { HostedLaneChanges } from './HostedLaneChanges';
import { ReviewStory } from './ReviewStory';
import NativeSourceReview from '../NativeSourceReview';
import { HostedConversation } from './HostedConversation';
import { PendingWrite } from '../pending-write';
import { useCoordination } from '../cockpit/coordination';
import { reviewViewLabel } from './review-model';
import type { ReviewRead } from './review-model';
import { protectedMatches } from '../../../src/autonomy-policy';
import { overlappingPaths } from '../../../src/coordination-paths';
import { HostedRunDetail } from './HostedRunDetail';
import { LandingDecision } from './LandingDecision';
import { useHostedLanding } from './use-hosted-landing';
import { landingState, mainAncestryGate, landingRunSummary, feedbackWorking } from './landing-model';
import { landingMain } from './landing-api';
import { ReviewCheck } from './ReviewCheck';

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
  const canonicalContract = useQuery(readTestContract, {
    projectId,
    intentId: view.intentId,
    candidateId: view.id,
    ...(view.head ? { head: view.head } : {}),
  });
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
  const landing = useHostedLanding(projectId, view.id, story?.why.outcome ?? intent?.outcome ?? 'Candidate');
  const main = useQuery(landingMain, { projectId });
  const mainHead = main ? (JSON.parse(main).head as string) : undefined;
  const acceptance =
    story?.accepted.filter(move => move.channel === 'main' && move.head === view.head).at(-1) ??
    channels.find(move => move.viewId === view.id && move.channel === 'main' && move.head === view.head);
  const superseded = !acceptance && story?.status === 'superseded';
  const decision = landingState(landing.read, superseded);
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
  const observedRun = landing.read?.run ?? landing.readyRun;
  const run = observedRun
    ? landingRunSummary(observedRun)
    : runs
        .filter(run => run.head === view.head)
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
        .at(-1);
  const passed = run?.status === 'passed';
  const [feedbackSent, setFeedbackSent] = useState(false);
  const working = feedbackWorking(feedbackSent, view.inputs, lanes);
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
    async (text: string, laneId?: string): Promise<string> => {
      const requested = {
        projectId,
        operationId: crypto.randomUUID(),
        command: JSON.stringify({
          action: 'note',
          intentId: view.intentId,
          kind: 'decision',
          text: `Changes requested for [Candidate](${hostedHref({ projectTab: 'intent', reviewView: view.id })}):\n${text}`,
        }),
      };
      const original = feedback.current ?? requested;
      feedback.current = original;
      if (!recorded.current) {
        await client.mutation(api.projectWorkCommand.command, original);
        recorded.current = true;
      }
      for (const input of laneId
        ? view.inputs.filter(input => input.laneId === laneId)
        : view.inputs.length
          ? view.inputs
          : [{ laneId: '' }]) {
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
        ? `Check ${run.status} on exactly this Candidate`
        : story
          ? 'No check recorded for this Candidate'
          : 'Reading check record…',
      body: run?.checkName ?? '',
    },
    mainAncestryGate({
      included: view.main?.included,
      indexedMain: view.main?.head,
      currentMain: mainHead,
    }),
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
          <StatusPill tone={acceptance ? 'passed' : working ? 'active' : decision.tone}>
            {acceptance ? 'Accepted' : working ? 'Working' : decision.label}
          </StatusPill>
          {landing.reverseRead?.request.observation.state === 'landed' && (
            <span className="fx-rev-tag">
              Reverted by {reviewViewLabel(views, landing.reverseRead.attempt.candidate.id)}
            </span>
          )}
          <h1 title={story?.why.outcome ?? intent?.outcome}>
            {story?.why.outcome ?? intent?.outcome ?? 'Review Candidate'}
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
              data={
                story
                  ? {
                      ...story,
                      semanticConflicts: canonicalContract
                        ? ((JSON.parse(canonicalContract) as { semanticConflicts?: SemanticConflict[] })
                            .semanticConflicts ?? [])
                        : story.semanticConflicts,
                      contract: canonicalContract
                        ? (JSON.parse(canonicalContract) as { contract: IntentTestContract | null }).contract
                        : (candidateTestContract(intent, view.id, view.head) ?? story.contract),
                    }
                  : null
              }
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
            <LandingDecision
              reverseLabel={
                landing.reverseRead
                  ? reviewViewLabel(views, landing.reverseRead.attempt.candidate.id)
                  : undefined
              }
              reverseHref={
                landing.reverseRead
                  ? hostedHref({ projectTab: 'intent', reviewView: landing.reverseRead.attempt.candidate.id })
                  : undefined
              }
              read={landing.read}
              reverseRead={landing.reverseRead}
              reversing={landing.reversing}
              acceptance={acceptance}
              candidateLabel={reviewViewLabel(views, view.id)}
              canAccept={owner && view.status === 'clean' && Boolean(view.head)}
              canComment={editable}
              failures={landing.failures}
              log={landing.log}
              busy={busy || landing.busy}
              error={landing.error}
              gates={gates}
              draftKey={`${view.id}:${view.head}`}
              send={send}
              onRequestSent={() => setFeedbackSent(true)}
              recipients={view.inputs.map(input => {
                const lane = lanes.find(item => item.id === input.laneId);
                return {
                  id: input.laneId,
                  name: lane?.name ?? 'Lane',
                  agent: lane?.startedBy?.name,
                  state:
                    lane?.head !== input.head
                      ? 'Saved again'
                      : lane?.state === 'completed'
                        ? 'Done'
                        : landing.read?.receipt?.completion.enabled
                          ? 'Completing'
                          : 'Active',
                  automatic:
                    lane?.head === input.head &&
                    (lane?.state === 'completed' || Boolean(landing.read?.receipt?.completion.enabled)),
                };
              })}
              accept={() =>
                void landing.accept(observedRun?.status === 'passed' ? observedRun.id : undefined)
              }
              cancel={() => void landing.cancel()}
              revert={
                owner && (landing.read?.request.acceptance?.receiptId || acceptance?.id)
                  ? why =>
                      void landing.revert(landing.read?.request.acceptance?.receiptId ?? acceptance!.id, why)
                  : undefined
              }
              replacement={
                superseded && story?.supersededBy
                  ? {
                      href: hostedHref({ projectTab: 'intent', reviewView: story.supersededBy }),
                      label: reviewViewLabel(views, story.supersededBy),
                    }
                  : undefined
              }
              repairHref={
                view.inputs[0] ? workHref({ projectTab: 'lanes', lane: view.inputs[0].laneId }) : undefined
              }
              aheadLabel={landing.read?.ahead ? reviewViewLabel(views, landing.read.ahead) : undefined}
              runHref={
                observedRun?.configuration.provider === 'github-actions' && observedRun.executionId
                  ? `https://github.com/${observedRun.configuration.repository}/actions/runs/${observedRun.executionId}`
                  : run
                    ? hostedHref({ projectTab: 'intent', reviewView: view.id, checkRun: run.id })
                    : undefined
              }
            />
            <ReviewCheck
              run={run}
              head={observedRun?.request.expectedHead ?? view.head}
              superseded={superseded}
            >
              {observedRun?.configuration.provider === 'github-actions' && observedRun.executionId && (
                <a
                  href={`https://github.com/${observedRun.configuration.repository}/actions/runs/${observedRun.executionId}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open run
                </a>
              )}
              {run && !observedRun && (
                <HostedRunDetail key={run.id} run={run} projectId={projectId} workspace={workspace} />
              )}
            </ReviewCheck>
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
            <OwnerDecisionsDisclosure intentId={view.intentId} />
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
                open={decision.kind === 'landed' || Boolean(acceptance)}
                summary="Exact record: Candidate, pins, receipts"
                rows={[
                  ['Candidate', view.id],
                  ['Head', view.head],
                  ['Base', view.base],
                  ['Check run', run?.id],
                  ['Landing submission', landing.read?.request.id],
                  [
                    'Landing receipt',
                    landing.read?.receipt ? JSON.stringify(landing.read.receipt) : undefined,
                  ],
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
