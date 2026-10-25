import { OwnerDecisionsRoute } from './decisions/OwnerDecisionsRoute';
import { continueLongAction } from '../../src/long-action';
import { ErrorToast } from './ui/Toast';
import { routeUrlState } from './shell/location';
import { reconcileBefore } from './pending-write';
// SPDX-License-Identifier: Apache-2.0
import { ConvexError } from 'convex/values';
import IntentDelivery from './IntentDelivery';
import { useWorkRecord } from './hosted-work-index';
import type { ComponentProps } from 'react';
import { HostedViewRoute } from './shell/ViewRoute';
import { PageHead } from './shell/Shell';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useConvex, useQuery } from 'convex/react';
import type { Id } from '../../convex/_generated/dataModel';
import type {
  MetadataCommand,
  WorkData,
  HostedEvent,
  HostedChannelMove,
  ChannelBase,
} from '../../src/work-types';
import { api } from '../../convex/_generated/api';
import { hostedError } from './snapshot';
import {
  captureHostedPair,
  downloadHostedPair,
  refreshHostedPairTransport,
  type HostedHandoffPair,
} from './hosted-handoff';
import { LazyPage, useSection, useDestination } from './WorkspaceUI';
import { useWorkIndex, useWorkRecords, useWorkRecordResult, type IntentHeader } from './hosted-work-index';
import HostedNow from './cockpit/HostedNow';
import { type WorkflowPage } from './ProjectOverview';
import { localAgentPrompt } from './local-agent-prompt';
import ExchangeHandoff from './ExchangeHandoff';
import ProjectProposals from './ProjectProposals';
import HostedSourceReturn from './HostedSourceReturn';
import { IndexedEvent } from './HostedIndexedHistory';
import { lazy, Suspense } from 'react';
import { loadCode } from './route-preload';
import { CodeSkeleton } from './CodeSkeleton';
import { AppLoader } from './ui/AppLoader';
const HostedCode = lazy(loadCode);
const HostedLanes = lazy(() => import('./HostedLanes'));
const HostedIndexedPlanning = lazy(() => import('./HostedIndexedPlanning'));
const HostedIntents = lazy(() => import('./intents/HostedIntents'));
const HostedSettings = lazy(() => import('./settings/HostedSettings'));

type Snapshot = {
  sourceTransport?: 'objects';
  projectId: Id<'hostedProjects'>;
  name: string;
  key: string;
  backupId: Id<'projectBackups'>;
  backupDigest: string;
  sourceHead: string;
  sourceKind?: 'git' | 'native';
  channels: { name: string; head: string }[];
  hostedChannels?: HostedChannelMove[];
  data: Pick<WorkData, 'revision' | 'intents' | 'channelMoves' | 'hostedChannelMoves'>;
  events: HostedEvent[];
  actor?: string;
  capabilities?: {
    owner: boolean;
    editableIntentIds: string[];
    sourceReturn: boolean;
    hostedChannels: boolean;
    planning?: boolean;
  };
};
type Attempt = { operationId: string; revision: number; command: MetadataCommand };
function sources(
  snapshot: Snapshot,
): { value: string; head: string; label: string; hostedBase?: ChannelBase }[] {
  return [
    ...(snapshot.hostedChannels ?? []).map(move => ({
      value: `hosted:${move.id}`,
      head: move.head,
      label: `Hosted Channel ${move.channel} · ${move.head.slice(0, 12)}`,
      hostedBase: { name: move.channel, head: move.head, acceptanceId: move.id },
    })),
    {
      value: snapshot.sourceHead,
      head: snapshot.sourceHead,
      label: `Archive checkout · ${snapshot.sourceHead.slice(0, 12)}`,
    },
    ...snapshot.channels
      .filter(pin => pin.head !== snapshot.sourceHead)
      .map(pin => ({
        value: pin.head,
        head: pin.head,
        label: `Archived Channel ${pin.name} · ${pin.head.slice(0, 12)}`,
      })),
  ];
}
function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob),
    link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
export default function HostedWork({
  projectId,
  backups,
  settings,
  embedded = false,
}: {
  /** Inside the shared shell, which renders the project destinations instead of this page's tabs. */
  embedded?: boolean;
  projectId: Id<'hostedProjects'>;
  backups?: ReactNode;
  settings?: ReactNode;
}) {
  const [section, setSection] = useSection(
    'projectTab',
    [
      'overview',
      'intent',
      'lanes',
      'views',
      'planning',
      'decisions',
      'activity',
      'coordination',
      'delivery',
      'sharing',
      'agents',
      'backups',
      'settings',
      'general',
      'autonomy',
      'checks',
      'access',
      'you',
      'appearance',
      'devices',
      'contributions',
      'transfer',
      'github',
    ] as const,
    'overview',
  );
  useEffect(() => {
    if (section === 'views' && !routeUrlState().searchParams.get('viewId')) setSection('intent');
  }, [section, setSection]);
  const [workflowTab, setWorkflowTab] = useSection(
    'intentTab',
    ['discussion', 'planning', 'lanes', 'coordination', 'delivery'] as const,
    'discussion',
  );
  const [, setPlanningItem] = useDestination('planningItem');
  const [, setLane] = useDestination('lane');
  const [, setSession] = useDestination('session');
  const [copied, setCopied] = useState(false);
  const client = useConvex(),
    project = useQuery(api.projectWork.state, { projectId });
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const { workspace, error: indexError } = useWorkIndex(projectId, project?.work);
  const [sourceDetailsOpen, setSourceDetailsOpen] = useState(false);
  const inWorkflow = section === 'intent';
  const intents = useWorkRecords<IntentHeader>(projectId, workspace, 'intents');
  const channels = useWorkRecords<{ name: string; head: string }>(projectId, workspace, 'channels');
  const hostedChannels = useWorkRecords<HostedChannelMove>(projectId, workspace, 'hostedChannels');
  const moves = useWorkRecords<WorkData['channelMoves'][number]>(
    projectId,
    workspace,
    'channelMoves',
    undefined,
    sourceDetailsOpen || section === 'delivery' || (inWorkflow && workflowTab === 'delivery'),
  );
  const hostedMoves = useWorkRecords<HostedChannelMove>(
    projectId,
    workspace,
    'hostedChannelMoves',
    undefined,
    sourceDetailsOpen || section === 'delivery' || (inWorkflow && workflowTab === 'delivery'),
  );
  const events = useWorkRecords<HostedEvent>(projectId, workspace, 'events', undefined, sourceDetailsOpen);
  const snapshot = useMemo(
    (): Snapshot | null =>
      workspace
        ? {
            ...workspace,
            projectId,
            channels: channels.records,
            hostedChannels: hostedChannels.records,
            data: {
              revision: workspace.revision,
              intents: intents.records,
              channelMoves: moves.records,
              hostedChannelMoves: hostedMoves.records,
            },
            events: events.records,
          }
        : null,
    [
      workspace,
      projectId,
      channels.records,
      hostedChannels.records,
      intents.records,
      moves.records,
      hostedMoves.records,
      events.records,
    ],
  );
  const [pair, setPair] = useState<HostedHandoffPair | null>(null);
  const sourceTransport = useQuery(
    api.projectWork.sourceTransport,
    project?.work ? { projectId, backupId: project.work.backupId } : 'skip',
  );
  const retainedTransport = useQuery(
    api.projectWork.sourceTransport,
    pair && pair.archive.id !== project?.work?.backupId
      ? { projectId, backupId: pair.archive.id as Id<'projectBackups'> }
      : 'skip',
  );
  const matchingPair =
    pair &&
    refreshHostedPairTransport(
      pair,
      pair.archive.id === sourceTransport?.backupId ? sourceTransport : retainedTransport,
    );
  const snapshotTransport =
    sourceTransport?.backupId === snapshot?.backupId && sourceTransport?.digest === snapshot?.backupDigest
      ? sourceTransport?.transport === 'objects'
        ? 'objects'
        : undefined
      : snapshot?.sourceTransport;
  const handoffObjects = matchingPair
    ? matchingPair.archive.transport === 'objects'
    : snapshotTransport === 'objects';
  const [transfer, setTransfer] = useState<{ label: string; received?: number; total?: number } | null>(null);
  const [start, setStart] = useState<{ backupId: Id<'projectBackups'>; operationId: string } | null>(null);
  const [pending, setPending] = useState<Attempt | null>(null),
    [, setOutcome] = useState(''),
    [, setConstraints] = useState(''),
    [base, setBase] = useState('');
  const [intentId, setIntentId] = useDestination('intent');
  const [viewId] = useDestination('viewId');
  const [reviewView, setReviewView] = useDestination('reviewView');
  const laneRecords = useWorkRecords<WorkData['lanes'][number]>(
    projectId,
    workspace,
    'lanes',
    undefined,
    section === 'lanes' || section === 'delivery' || section === 'coordination' || (inWorkflow && !!intentId),
  );
  const selectedIntent = useWorkRecordResult<IntentHeader>(
    projectId,
    workspace,
    'intents',
    inWorkflow ? intentId : '',
  );
  useEffect(() => {
    if (!snapshot) return;
    setBase(previous =>
      !channels.complete || !hostedChannels.complete
        ? previous
        : sources(snapshot).some(pin => pin.value === previous)
          ? previous
          : sources(snapshot).find(pin => pin.hostedBase?.name === 'main')?.value ||
            snapshot.channels.find(pin => pin.name === 'main')?.head ||
            snapshot.sourceHead,
    );
  }, [snapshot, workspace?.defaultIntentId, intents.complete, channels.complete, hostedChannels.complete]);
  async function initialize() {
    if (!project?.currentBackup) return;
    const original = start ?? { backupId: project.currentBackup, operationId: crypto.randomUUID() };
    setStart(original);
    setBusy(true);
    setError('');
    try {
      await client.action(api.projectWorkActions.initialize, { projectId, ...original });
      setStart(null);
    } catch (e) {
      setError(hostedError(e));
    } finally {
      setBusy(false);
    }
  }
  /** New cockpit screens read the failure of their own command without changing act's contract. */
  const lastError = useRef('');
  async function command(input: MetadataCommand): Promise<string | null> {
    lastError.current = '';
    return (await act(input))
      ? null
      : lastError.current || 'The request did not complete. Retry keeps its original operation.';
  }
  async function act(command?: MetadataCommand) {
    if (!snapshot || (!command && !pending)) return;
    // Reconcile an unknown earlier operation under its own payload before starting a different action.
    if (!(await reconcileBefore(pending, command, () => act()))) return;
    const original =
      pending && (!command || JSON.stringify(pending.command) === JSON.stringify(command))
        ? pending
        : {
            operationId: command && 'operationId' in command ? command.operationId : crypto.randomUUID(),
            revision: snapshot.data.revision,
            command: command!,
          };
    setPending(original);
    setBusy(true);
    setError('');
    try {
      if (
        (original.command.action === 'note' && original.command.anchor) ||
        original.command.action === 'put-planning-item'
      ) {
        await client.action(api.projectWorkActions.command, {
          projectId,
          operationId: original.operationId,
          revision: original.revision,
          command: JSON.stringify(original.command),
        });
      } else {
        const args = {
          projectId,
          operationId: original.operationId,
          command: JSON.stringify(original.command),
        };
        try {
          await client.mutation(api.projectWorkCommand.command, args);
        } catch (error) {
          if (
            !(error instanceof ConvexError) ||
            (error.data as { code?: string }).code !== 'PROJECT_WORK_INDEX_MISSING'
          )
            throw error;
          await continueLongAction('Work index', String(projectId), continuation =>
            client.action(api.projectWorkIndexActions.ensure, {
              projectId,
              ...(continuation ? { continuation } : {}),
            }),
          );
          await client.mutation(api.projectWorkCommand.command, args);
        }
      }
      setPending(null);
      if (original.command.action === 'intent') {
        setIntentId(original.operationId);
        setOutcome('');
        setConstraints('');
      }
      return { operationId: original.operationId };
    } catch (e) {
      setError(hostedError(e));
      lastError.current = hostedError(e);
    } finally {
      setBusy(false);
    }
  }
  async function preparePair() {
    if (!snapshot) return;
    setBusy(true);
    setError('');
    setTransfer({ label: 'Preparing current source and Work pair…' });
    try {
      setPair(
        await captureHostedPair(snapshot, () =>
          client.action(api.projectWorkActions.exportJournal, { projectId }),
        ),
      );
    } catch (e) {
      setError(hostedError(e));
    } finally {
      setBusy(false);
      setTransfer(null);
    }
  }
  async function exportWork(source = false) {
    if (!snapshot) return;
    setBusy(true);
    setError('');
    setTransfer({ label: 'Preparing matching source and Work…' });
    try {
      const captured =
        matchingPair ??
        (await captureHostedPair(snapshot, () =>
          client.action(api.projectWorkActions.exportJournal, { projectId }),
        ));
      const selected = refreshHostedPairTransport(
        captured,
        await client.query(api.projectWork.sourceTransport, {
          projectId,
          backupId: captured.archive.id as Id<'projectBackups'>,
        }),
      );
      setPair(selected);
      if (source && selected.archive.transport === 'objects') {
        download(
          new Blob(
            [
              JSON.stringify(
                {
                  url: client.url,
                  projectId,
                  backupId: selected.archive.id,
                  journalPath: `forge-work-${selected.projectKey}-r${selected.revision}.json`,
                },
                null,
                2,
              ),
            ],
            { type: 'application/json' },
          ),
          'forge-pull.json',
        );
      } else if (source) {
        setTransfer({ label: 'Downloading source archive…' });
        const result = await downloadHostedPair(
          selected,
          input =>
            client.action(api.projectBackupActions.downloadPart, {
              ...input,
              id: input.id as Id<'projectBackups'>,
            }),
          (received, total) =>
            setTransfer({
              label: received === total ? 'Verifying source archive…' : 'Downloading source archive…',
              received,
              total,
            }),
        );
        download(result.blob, result.filename);
      } else
        download(
          new Blob([selected.journal], { type: 'application/json' }),
          `forge-work-${selected.projectKey}-r${selected.revision}.json`,
        );
    } catch (e) {
      setError(hostedError(e));
    } finally {
      setBusy(false);
      setTransfer(null);
    }
  }
  const owner = snapshot?.capabilities?.owner !== false;
  const editable = owner || selectedIntent.editable;
  const intent = inWorkflow
      ? (selectedIntent.record ??
        (snapshot?.data.intents.find(item => item.id === intentId) as IntentHeader | undefined))
      : undefined,
    disabled = busy || !!pending,
    selectedSource = snapshot && sources(snapshot).find(pin => pin.value === base);
  const localHandoff = snapshot && (
    <section className="hosted-local-handoff fx-transfer-card" aria-label="Work on this project locally">
      <h2>Work on this project locally</h2>
      <p>Continue with your agent and tools in a local Lane.</p>

      <button
        className="fx-btn fx-btn-primary"
        onClick={() => {
          setCopied(false);
          void navigator.clipboard
            .writeText(
              localAgentPrompt({
                name: snapshot.name,
                projectId,
                backend: client.url,
                source: snapshot.sourceHead,
                revision: snapshot.data.revision,
                objects: handoffObjects,
                ...(intent ? { intent: { id: intent.id, outcome: intent.outcome } } : {}),
              }),
            )
            .then(() => setCopied(true))
            .catch(error => setError(hostedError(error)));
        }}
      >
        Copy agent prompt
      </button>
      {copied && <p role="status">Agent prompt copied. Authentication is provided separately.</p>}
      <div className="fx-transfer-downloads">
        <button className="fx-transfer-link" disabled={busy} onClick={() => void exportWork()}>
          Work journal
        </button>
        <button className="fx-transfer-link" disabled={busy} onClick={() => void exportWork(true)}>
          {handoffObjects ? 'Pull request' : pair ? 'Source archive' : 'Source archive'}
        </button>
        {pair && (
          <button className="fx-transfer-link" disabled={busy} onClick={() => void preparePair()}>
            Prepare current pair
          </button>
        )}
      </div>
      {transfer && (
        <div className="archive-transfer" role="status">
          <p>
            {transfer.label}
            {transfer.total !== undefined && (
              <>
                {' '}
                {(transfer.received! / 1024 / 1024).toFixed(1)} / {(transfer.total / 1024 / 1024).toFixed(1)}{' '}
                MiB
              </>
            )}
          </p>
          <progress
            aria-label={transfer.label}
            {...(transfer.total !== undefined ? { value: transfer.received, max: transfer.total } : {})}
          />
        </div>
      )}
      <details>
        <summary>Restore instructions</summary>
        {handoffObjects ? (
          <p>
            Download the matching Work journal and pull request, then run{' '}
            <code>nforge exchange NEW_DIRECTORY pull --command-file forge-pull.json</code>.
          </p>
        ) : (
          <p>
            Restore both into a new local folder:{' '}
            <code>
              nforge {snapshot.sourceKind === 'native' ? 'restore-native' : 'restore-work'} ARCHIVE.tar.gz
              NEW_DIRECTORY --journal HOSTED_WORK.json
            </code>
            . Edit and run checks locally, then export{' '}
            {owner ? 'and return the new checkpoint' : 'a proposal archive'}. No automatic synchronization
            runs.
          </p>
        )}
        {matchingPair && (
          <div className="item-provenance">
            <p>Matching pair · Work revision {matchingPair.revision}</p>
            <p>
              Original source receipt SHA-256 <code>{matchingPair.archive.digest}</code>
              {matchingPair.archive.transport === 'objects' && (
                <>
                  {' '}
                  · object manifest SHA-256 <code>{matchingPair.archive.manifestDigest}</code>
                </>
              )}{' '}
              · journal SHA-256 <code>{matchingPair.journalSha256}</code>
            </p>
            <p>
              Both download controls retain this exact pair across source returns. Use these matching files
              together.
              {snapshot.data.revision !== matchingPair.revision &&
                ' Prepare current pair to receive newer hosted Work.'}
            </p>
          </div>
        )}

        <ExchangeHandoff
          inline
          projectId={projectId}
          backupId={snapshot.backupId}
          previous={project?.currentBackup ?? null}
          {...(owner ? { revision: snapshot.data.revision } : {})}
          {...(snapshotTransport ? { transport: snapshotTransport } : {})}
        />
      </details>
    </section>
  );
  const lanes =
    inWorkflow && intentId
      ? laneRecords.records.filter(lane => lane.intentId === intentId)
      : laneRecords.records;
  const openIntent = (id: string, page: WorkflowPage = 'discussion') => {
    setSession('');
    setLane('');
    setReviewView('');
    setIntentId(id);
    setPlanningItem('');
    setWorkflowTab(page);
    setSection('intent');
  };
  const openProjectPage = (value: typeof section) => {
    setSession('');
    setLane('');
    setReviewView('');
    setIntentId('');
    setPlanningItem('');
    setSection(value);
  };
  const pin = selectedIntent.intentPin;
  const contributions =
    snapshot?.sourceKind === 'native' ? (
      <ProjectProposals
        projectId={projectId}
        projectKey={snapshot.key}
        actor={snapshot.actor}
        accessManager={owner}
        pin={pin}
        pair={matchingPair ?? undefined}
        inline
      />
    ) : null;
  const transferSettings = snapshot ? (
    <>
      {localHandoff}
      {owner && (
        <HostedSourceReturn
          projectId={projectId}
          backupId={snapshot.backupId}
          revision={snapshot.data.revision}
        >
          <details
            className="fx-transfer-verification"
            onToggle={event => setSourceDetailsOpen(event.currentTarget.open)}
          >
            <summary>Source verification</summary>
            <p>
              Source <code>{snapshot.sourceHead}</code>
            </p>
            <p>Work version {snapshot.data.revision}</p>
            {events.records.map(event => (
              <IndexedEvent
                key={event.id}
                projectId={projectId}
                workspace={workspace!}
                enabled={sourceDetailsOpen}
                item={event}
              />
            ))}
          </details>
        </HostedSourceReturn>
      )}
    </>
  ) : null;
  if (
    [
      'sharing',
      'agents',
      'backups',
      'settings',
      'general',
      'autonomy',
      'checks',
      'access',
      'you',
      'appearance',
      'devices',
      'contributions',
      'transfer',
      'github',
    ].includes(section)
  )
    return (
      <>
        {(error || indexError) && <ErrorToast>{error || indexError}</ErrorToast>}
        <Suspense fallback={<AppLoader />}>
          <HostedSettings
            key={projectId}
            projectId={projectId}
            workspace={workspace}
            owner={workspace?.capabilities?.owner === true}
            initial={section}
            backups={backups}
            general={settings}
            contributions={contributions}
            transfer={transferSettings}
          />
        </Suspense>
      </>
    );
  return (
    <section className="hosted-work" aria-label="Hosted project Work">
      {(error || indexError) && <ErrorToast>{error || indexError}</ErrorToast>}
      {!project ? (
        <p role="status">Loading project…</p>
      ) : (
        <div className={embedded ? 'project-layout embedded' : 'project-layout'}>
          <div className="project-page-content">
            {!project.work && section !== 'backups' && section !== 'settings' && (
              <>
                <h2>Overview</h2>
                <p>Start planning from this project's source.</p>
                <button disabled={busy || !project.currentBackup} onClick={() => void initialize()}>
                  {start ? 'Retry starting project Work' : 'Start project Work'}
                </button>
              </>
            )}
            {project.work && !snapshot && <p role="status">Loading project Work…</p>}
            {snapshot && (
              <>
                <LazyPage
                  active={section === 'overview' || section === 'coordination' || section === 'activity'}
                >
                  <HostedNow
                    {...{ activity: section === 'coordination' || section === 'activity' }}
                    projectId={projectId}
                    workspace={workspace}
                    initialChannelId={
                      project.hostingRequest?.startsWith('["empty-hosted-project",') ? project.key : undefined
                    }
                    newIntent={() => openProjectPage('intent')}
                  />
                </LazyPage>
                <LazyPage active={section === 'intent' && !reviewView}>
                  <HostedIntents
                    projectId={projectId}
                    workspace={workspace!}
                    {...(owner ? { planningAct: act } : {})}
                    {...(intentId ? { intentId } : {})}
                    // Commands go through this page's retry-safe act: an unknown outcome keeps its original operation.
                    {...(owner && selectedSource
                      ? {
                          create: (outcome: string, constraints: string) =>
                            command({
                              action: 'intent',
                              outcome,
                              constraints,
                              base: selectedSource.head,
                              ...(selectedSource.hostedBase ? { hostedBase: selectedSource.hostedBase } : {}),
                            }),
                        }
                      : {})}
                    {...(editable
                      ? {
                          addNote: async (id: string, text: string, kind: 'comment' | 'decision') =>
                            command({ action: 'note', intentId: id, text, kind }),
                          setStatus: async (
                            id: string,
                            status: 'active' | 'ready' | 'completed' | 'abandoned',
                          ) => command({ action: 'intent-status', intentId: id, status }),
                        }
                      : {})}
                  />
                </LazyPage>
                {reviewView && (
                  <HostedReviewRoute
                    projectId={projectId}
                    workspace={workspace!}
                    viewId={reviewView}
                    data={snapshot.data}
                    channels={snapshot.hostedChannels ?? []}
                    owner={owner}
                    editable={editable}
                    busy={disabled}
                    act={act}
                    select={setReviewView}
                  />
                )}
                {section === 'views' && viewId && (
                  <HostedViewRoute projectId={projectId} workspace={workspace!} viewId={viewId} />
                )}
                <LazyPage active={section === 'lanes'}>
                  <HostedLanes
                    active={section === 'lanes'}
                    projectId={projectId}
                    workspace={workspace!}
                    lanes={lanes}
                    intents={intents.records}
                    loading={laneRecords.loading}
                    openIntent={openIntent}
                  />
                </LazyPage>
                <LazyPage active={section === 'decisions'}>
                  <OwnerDecisionsRoute />
                </LazyPage>
                <LazyPage active={section === 'planning'}>
                  {snapshot.capabilities?.planning || !owner ? (
                    <HostedIndexedPlanning
                      projectId={projectId}
                      workspace={workspace!}
                      intents={intents.records}
                      busy={disabled}
                      readOnly={!owner}
                      act={act}
                      exportHistory={async () =>
                        JSON.parse(await client.action(api.projectWorkActions.exportPlanning, { projectId }))
                      }
                    />
                  ) : (
                    <div className="fx-page">
                      <PageHead title="Planning" />
                      <p>Planning is not available for this project and access level.</p>
                    </div>
                  )}
                </LazyPage>
                <LazyPage active={section === 'delivery'}>
                  {snapshot.sourceKind === 'native' ? (
                    <Suspense fallback={<CodeSkeleton />}>
                      <HostedCode
                        projectId={projectId}
                        workspace={workspace!}
                        head={
                          snapshot.hostedChannels?.find(channel => channel.channel === 'main')?.head ??
                          snapshot.channels.find(channel => channel.name === 'main')?.head ??
                          snapshot.sourceHead
                        }
                        lanes={laneRecords.records}
                      />
                    </Suspense>
                  ) : (
                    <p>Open the imported repository to browse its source.</p>
                  )}
                </LazyPage>
              </>
            )}
            {pending && (
              <div role="status">
                <p>This request has not been confirmed. Retry checks its original outcome.</p>
                <button disabled={busy} onClick={() => void act()}>
                  Retry original request
                </button>
                <button disabled={busy} onClick={() => setPending(null)}>
                  Start another request
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function HostedReviewRoute({
  viewId,
  ...props
}: Omit<ComponentProps<typeof IntentDelivery>, 'intentId' | 'selected'> & { viewId: string }) {
  const view = useWorkRecord<WorkData['views'][number]>(props.projectId, props.workspace, 'views', viewId);
  return view ? (
    <IntentDelivery {...props} intentId={view.intentId} selected={viewId} />
  ) : (
    <p role="status">Loading review…</p>
  );
}
