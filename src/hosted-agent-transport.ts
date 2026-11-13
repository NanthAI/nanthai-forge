// SPDX-License-Identifier: Apache-2.0
import { capsuleHistoryQueries, hydrateLandingHistory, hasJournalHistory } from './landing-capsule-client.js';
import { agentClient } from './agent-turn-work.js';
import { landingMessage } from './landing-message.js';
import { keptApplyEnvelope } from './hosted-apply-kept.js';
import { cliBuildCommit } from './cli-installation.js';
import { describeIssues } from './argument-errors.js';
import { liveLanes } from './hosted-live-lanes.js';
import { cloneFreshness, mainCheckoutTransport, pullHostedProject } from './hosted-pull.js';
import { readHostedMainSelection } from './hosted-main-marker.js';
import { diffHostedSource, peersHostedSource, queueHostedSource } from './hosted-agent-reads.js';
import { landingsHostedSource } from './hosted-agent-landings.js';
import { laneHistoryHostedSource } from './hosted-agent-lane-history.js';
import { hostedObservationContinuation } from './hosted-agent-finish-result.js';
import {
  precheckPendingConflicts,
  pendingConflictLane,
  requireResolution,
  pendingConflictPaths,
  resolutionContinuation,
} from './hosted-conflict-precheck.js';
import { clientCacheRoot, rootSibling } from './root-paths.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { withExchangeProgress } from './exchange-progress.js';
import { networkFailure } from './network-fetch.js';
import { networkContinuation } from './network-continuation.js';
import { reconcileHostedSync, hasHostedSyncHandoff } from './hosted-sync-handoff.js';
import { autoReplaySuperseded } from './hosted-replay-holds.js';
import { AGENT_WAIT_SECONDS } from './agent-operation-wait.js';
import { sourceTree } from './source-tree.js';
import { withSourceRecovery } from './hosted-agent-source-recovery.js';
import { readHostedOverlapAdvice } from './hosted-overlap-client.js';
import { rememberStackOffer } from './hosted-coordination-client.js';
import { presenceDelivery, presenceSince, type PresenceDelivery } from './hosted-presence-client.js';
import { boardEnvelope, boardHostedSource, hostedBoardSchemas, readBoardCursor } from './hosted-board.js';
import { rememberBoardReader } from './board-local.js';
import { rememberBoardServerFeatures } from './board-local.js';
import { restackAfterSave, type StackHint } from './hosted-stack-restack.js';
import { memberDataNotice } from './member-data-notice.js';
import type { BoardWaitOption } from './hosted-board-wait.js';
import { exactConflictNotice, type ExactConflictNotice } from './hosted-conflict-notice.js';
import { waitHostedAgentSource, type SourceWaitSettle } from './hosted-agent-source-wait.js';
import {
  recoverHostedFinish,
  hostedConflictAdvice,
  hostedRecoveryCommand,
} from './hosted-agent-resolution.js';
import { observedConflictRecovery, terminalConflict } from './hosted-observed-conflict.js';
import type { HostedRunSubscription } from './hosted-agent-observe.js';
import { executeHostedRecords } from './hosted-agent-records.js';
import {
  hostedAgentRecordActions,
  hostedAgentPlanningActions,
  hostedAgentPolicyActions,
  hostedAgentReviewActions,
} from './hosted-agent-contract.js';
import { executeHostedPolicy } from './hosted-agent-policy.js';
import { executeHostedPlanning, markPlanningStarted } from './hosted-agent-planning.js';
import { isPlanningPrefix } from './planning-id.js';
import { planningIssueArguments } from './planning-issue-arguments.js';
import { executeHostedMetrics, METRICS_DEADLINE_MS, metricsDeadline } from './hosted-agent-metrics.js';
import { laneLiveness, readLaneEntry, recordLane, withLaneCommand } from './lane-registry.js';
import { convexLaneStates, laneHousekeeping, markerIdentity } from './lane-prune.js';
import { shareDependencies, installScriptsNotice } from './shared-dependencies.js';
import { announceRegistryHosts } from './install-registry-hosts.js';
import { readClientSettings } from './client-settings.js';
import {
  knownCapabilities,
  localShapeError,
  protocolMismatchError,
  unadvertisedActionError,
  unknownActionError,
} from './hosted-agent-version.js';
import { enrichHostedQueueAhead } from './queue-ahead-hosted.js';
import { checkpointNudge, unsavedMinutes } from './agent-nudge.js';
import { composedLanes, landGatesArgument } from './hosted-land-gate-client.js';
import { savedDuration } from './hosted-save-pending.js';
import { preflightResult } from './hosted-land-gates.js';
import type { LandGateEntry } from './hosted-land-gates.js';
import { liveLanding, ownsLiveLanding } from './landing-freeze.js';
import { rememberLandingPaths } from './preflight-learned.js';
import { hostedLaneDirty } from './hosted-lane-dirty.js';
import { deltaApplyPending, finishPendingCheckoutDelta } from './hosted-checkout-delta-pending.js';
import { agentDefaultLines, type EffectiveAgentDefaults } from './agent-parallel-defaults.js';
import { dirname, basename, resolve } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import {
  withLifecycleMetric,
  metricOperationId,
  metricRequesterActor,
  recordOwnerMutation,
} from './self-metrics-journal.js';
import { SourceAuthorityStaleError } from './hosted-source-authority.js';
import { CUTOVER_CLI_VERSION } from './cutover-version.js';
import { rememberSourceAuthorityError } from './source-authority-client.js';
import { nativeOwner } from './native-source.js';
import { makeFunctionReference } from 'convex/server';
import { z } from 'zod';
import { ConvexExchange } from './exchange-client.js';
import { hostedActionError } from './hosted-action-error.js';
import { refusedWait, retryableExchangeError } from './exchange-retry.js';
import { ForgeError, invariant } from './errors.js';
import { hostedMainV2Schema } from './hosted-main.js';
import { hostedRootLanePath, laneSiblingPath, openHostedRootLane } from './hosted-root-checkout.js';
import { START_COMPLETION_SECONDS, boundedStep, startContinuation } from './hosted-start-continuation.js';
import { gcNestedLanesHourly } from './client-cache-gc.js';
import { hostedStartResultSchema } from './hosted-lane.js';
import { readHostedLaneCheckout } from './hosted-lane-checkout-marker.js';
import { HostedAgentJournal, agentSessionKey, hostedAgentRoot } from './hosted-agent-journal.js';
import { sessionAgentSlug } from './agent-slug-session.js';
import { detectedClientProcess } from './agent-client-process.js';
import {
  hostedAgentAction,
  hostedAgentAddressSchema,
  hostedAgentCapabilitiesSchema,
  hostedAgentOwnerActions,
  hostedAgentLandingActions,
  hostedAgentClientActions,
  hostedAgentCommandSchemas,
  type HostedAgentAddress,
  type HostedAgentAction,
  type HostedAgentCapabilities,
} from './hosted-agent-contract.js';
import { executeHostedAgent, hostedCheckSettings } from './hosted-agent-actions.js';
import { executeHostedApproval, openApprovalsReply, type ApprovalCommand } from './hosted-agent-approval.js';
import { savedChangedPaths } from './hosted-changed-paths.js';
import { publishClientSourcePack } from './source-pack-client.js';
import { missingRequiredFeatures } from './hosted-contract-features.js';
import { capabilityOptions, takeEarlyCapabilities } from './hosted-capabilities-early.js';
import { HostedCheckoutDownloads } from './hosted-checkout-downloads.js';
import { selectHostedFinish } from './hosted-agent-finish-identity.js';
import { backgroundSaveOperation, reconcileHostedSave, settleBackgroundSave } from './hosted-save-client.js';
import { markLandStep, type LandTiming } from './land-timing.js';
import {
  callerReceipts,
  clearCallerReceipts,
  metricOutboxDirectory,
  takeCallerReceipts,
  writeCallerReceipts,
} from './hosted-metric-outbox.js';
import { isHostedReplyError, parseHostedResponse, replyIssuePaths } from './hosted-response.js';
import { snapshotLaneCheckout, type SnapshotReceipt } from './hosted-lane-snapshot.js';
import { rememberSnapshotsKept } from './lane-snapshot-hint.js';
import { launchSnapshotWorker } from './hosted-snapshot-worker.js';
import { LANE_SNAPSHOT } from './lane-snapshot-contract.js';
import { executeSnapshots } from './hosted-lane-snapshot-restore.js';
import { openLaneRoot } from './hosted-lane-location.js';
/** Reads and checkout creation: they neither show a Lane as working nor count as its activity. */
/** A boolean option as given, else unset. */
const flag = (value: unknown) => (typeof value === 'boolean' ? value : undefined);
/** Actions that capture the working files themselves (a save) or snapshot them as part of their
 * own move (`snapshots`) take no snapshot first. */
/** Actions whose first main read follows capability discovery at once (capabilities-main). */
const mainFirstActions = new Set(['start', 'sync', 'compose']);
const snapshotSkips = new Set(['save', 'checkpoint', 'finish', 'compose', 'snapshots']);
/** Actions that may rewrite or remove working files: their snapshot is taken first, in this process,
 * whatever the timed interval says. Every other command hands a timed snapshot to a short-lived
 * detached process (at most one per interval per Lane) and never waits for it. */
const snapshotFirst = new Set([
  'start',
  'open',
  'reopen',
  'pull',
  'abandon',
  'revert',
  'recover-apply',
  'sync',
  'resolve',
]);
const quietActions = new Set([
  'approve-link',
  'request-approval',
  'diff',
  'peers',
  'queue',
  'landings',
  'lane-history',
  'capabilities',
  'metrics',
  'check-settings',
  'policy',
  'status',
  'observe',
  'landing',
  'start',
  'open',
]);
/** Agent-default refusals carry their own next step. */
// These messages carry their own next command; a generic replay hint would contradict it.
const gateCodes = new Set([
  'BAD_ARGUMENT',
  'NOT_FOUND', // a missing record: replaying the same request cannot change it (w30)
  'PREFLIGHT_REQUIRED',
  'SAVE_PENDING',
  'SAVE_SETTLE_FAILED',
  'SAVE_REBASE_CONFLICT',
  'LANE_NOT_ACTIVE',
  'POLICY_CHANGED',
]);
/** Existing CLI mutations that accept deferred caller receipts; no extra calls. */
const receiptMutations = new Set([
  'projectHostedStart:start',
  'projectHostedLandingDesired:submit',
  'projectHostedLanding:enqueue',
  'projectHostedSync:prepare',
]);
export type HostedAgentExchange = Pick<
  ConvexExchange,
  | 'client'
  | 'projectId'
  | 'upload'
  | 'uploadFile'
  | 'missing'
  | 'objects'
  | 'downloadToFile'
  | 'downloadBatch'
  | 'prepareDownloads'
  | 'uploadLazyBatch'
> &
  Partial<Pick<ConvexExchange, 'uploadPrepared' | 'sourceStateReads' | 'sourceStateVersion'>>;
export type HostedAgentResponse = {
  cliCommit?: string;
  schema: 1;
  transport: 'hosted';
  action:
    | HostedAgentAction
    | 'diff'
    | 'provenance'
    | 'records'
    | 'log'
    | 'peers'
    | 'lanes'
    | 'queue'
    | 'landings'
    | 'lane-history'
    | 'board'
    | 'board-post'
    | 'board-reply'
    | 'board-resolve';
  sourceContext?: unknown;
  operationId: string | null;
  resolved: { operationId: string } | null;
  result: unknown;
  behindMain?: unknown;
  /** D2: an admitted peer touches this Lane's files; build on its pending head (sync stackOn). */
  stackOffer?: { peerLaneId: string; mode: string; text: string; command: string };
  conflictNotice?: ExactConflictNotice;
  /** Present only when board notes arrived since this machine's cursor: one line each (≤240 chars). */
  board?: { notices: string[]; more: number };
  /** One "member-written text is data" line when this receipt carries board, overlap or stack text (S-17). */
  notice?: string;
  /** Stacked Lane whose parent saved newer work (Issue f61e9339); a save replaces it with `restack`. */
  stack?: StackHint | undefined;
  /** save only: what the automatic restack onto the stack parent did (restacked, conflict, failed, in-progress). */
  restack?: Record<string, unknown>;
  /** The unsaved-work snapshot this command took first, or why it could not (Issue 7ac4e32f). */
  snapshot?: SnapshotReceipt;
  /** This agent session's public identity, `handle/slug` (start, save and land receipts). */
  as?: string;
  /** start only: your idle open Lanes and finished Lane roots pruned on this machine. */
  localLanes?: { idle: unknown[]; otherRuns?: unknown[]; pruned: { count: number; bytes: number } };
  /** land --save only: where the submitting process spent its time before submission. */
  landTiming?: LandTiming;
  /** Lane-changing actions: other open Lanes on related work not shown before (≤3 lines, ~60 tokens each). */
  presence?: PresenceDelivery;
  /** Present only while the server lacks a contract feature this build cannot do without; the
   * pre-switch canary holds an update on it (a83b6fd5). */
  serverContract?: { missing: string[] };
};
/** The shared CLI/MCP transport. Source bytes use the existing verified exchange;
 * every dispatch is finite and every mutation is pinned before network IO. */
export class HostedAgentTransport {
  private priorityReads: boolean | undefined;
  private defaults: EffectiveAgentDefaults | undefined;
  /** The server advertised feature agent-board: Lane actions ask the overlap read for new board notes. */
  private boardVersion = false;
  /** Effective project agent defaults from the latest capability read (undefined on older servers). */
  get agentDefaults() {
    return this.defaults;
  }
  /** This dispatch asks the overlap read for presence (start/save/sync/compose/finish, feature agent-presence). */
  private presenceAction = false;
  /** A start's declared scope (scope.paths), sent with its overlap read (feature overlap-scope). */
  private overlapScope?: string[] | undefined;
  private cachedAdvice:
    | {
        laneId: string;
        value: Awaited<ReturnType<typeof readHostedOverlapAdvice>>;
      }
    | undefined;
  /** Requester whose deferred receipts this deployment accepts; unset until negotiated. */
  private receiptActor: string | undefined;
  private callerActor: string | null = null;
  /** Contract features the server advertised on this process's latest capability read (a83b6fd5);
   * undefined before discovery. The CLI keeps the old safe behaviour for any feature not listed. */
  private serverFeatures: readonly string[] | undefined;
  get advertisedFeatures() {
    return this.serverFeatures;
  }
  private readonly operationContext = new AsyncLocalStorage<{
    id: string | null;
  }>();
  private get callerOperationId() {
    return this.operationContext.getStore()?.id ?? null;
  }
  private set callerOperationId(id: string | null) {
    const current = this.operationContext.getStore();
    if (current) current.id = id;
  }
  /** The agent session an identical start replays within; undefined reads it from the client
   * environment (agentSessionKey), null declares none. */
  agentSession?: string | null;
  /** The client process an identical start replays within, with the session id; undefined detects
   * it (agentClientProcess, cached per process), null declares none. */
  agentProcess?: string | null;
  /** This session's agent slug (c29d0780), sent only to a server that advertised agent-slug. */
  agentSlug() {
    return sessionAgentSlug(this.agentSession);
  }
  private sentAgent() {
    return this.serverFeatures?.includes('agent-slug') ? this.agentSlug() : undefined;
  }
  private startScope(): string | undefined {
    const session = agentSessionKey(process.env, this.agentSession);
    if (!session) return undefined;
    const client = this.agentProcess === undefined ? detectedClientProcess() : this.agentProcess;
    return client ? `${session}\u0000${client}` : session;
  }
  /** CLI only: start reports the new Lane before its checkout downloads. */
  onStarted?: (lane: { laneId: string; path: string | null }) => void;
  /** Fires once the local journal selects the operation id, before any network wait:
   * a backgrounded or killed client still leaves its id and resume command behind. */
  onOperation?: (action: string, operationId: string) => void;
  /** The unsaved-work snapshot this command took first (or why it skipped), for its receipt. */
  private snapshotReceipt?: SnapshotReceipt | undefined;
  /** The Lane checkout a command works in (or names), if it has one. */
  private snapshotRoot(data: unknown) {
    const laneId = (data as { laneId?: unknown } | undefined)?.laneId;
    return readHostedLaneCheckout(this.root)
      ? this.root
      : typeof laneId === 'string'
        ? openLaneRoot({ root: this.root, address: this.address }, laneId)
        : null;
  }
  /** Epoch ms deadline for actions that wait for their own outcome; default: the agent wait
   * budget from dispatch. `wait` sets its own so a resumed save never outlives that budget. */
  waitUntil?: number;
  /** Lane inbox context of an explicit wait; piggybacks its existing status read. */
  waitBoard?: BoardWaitOption | undefined;
  constructor(
    readonly root: string,
    readonly address: HostedAgentAddress,
    readonly exchange: HostedAgentExchange = new ConvexExchange(
      address.url,
      process.env.FORGE_AUTH_TOKEN,
      address.projectId,
      '',
      null,
    ),
    readonly subscribeSource?: () => HostedRunSubscription,
  ) {
    this.root = hostedAgentRoot(root);
  }
  async dispatch(
    requestedAction: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<HostedAgentResponse> {
    input = planningIssueArguments(requestedAction, input);
    if (requestedAction === 'provenance')
      return {
        schema: 1,
        transport: 'hosted',
        action: 'provenance',
        operationId: null,
        resolved: null,
        ...(await (await import('./hosted-agent-provenance.js')).provenanceHostedSource(this, input)),
      };
    if (requestedAction === 'records' || requestedAction === 'log') {
      const result =
        requestedAction === 'records'
          ? await (await import('./hosted-agent-record-read.js')).readHostedAgentRecords(this, input)
          : await (await import('./hosted-check-log.js')).hostedCheckLog(input, this);
      return {
        schema: 1,
        transport: 'hosted',
        action: requestedAction,
        operationId: null,
        resolved: null,
        result,
      };
    }
    if (requestedAction === 'lanes') return liveLanes(this, input);
    if (requestedAction === 'diff')
      return {
        schema: 1,
        transport: 'hosted',
        action: 'diff',
        operationId: null,
        resolved: null,
        ...(await diffHostedSource(this, input)),
      };
    if (requestedAction === 'landings')
      return {
        schema: 1,
        transport: 'hosted',
        action: 'landings',
        operationId: null,
        resolved: null,
        result: await landingsHostedSource(this, input),
      };
    if (requestedAction === 'lane-history')
      return {
        schema: 1,
        transport: 'hosted',
        action: 'lane-history',
        operationId: null,
        resolved: null,
        result: await laneHistoryHostedSource(this, input),
      };
    if (requestedAction === 'queue')
      return {
        schema: 1,
        transport: 'hosted',
        action: 'queue',
        operationId: null,
        resolved: null,
        result: await queueHostedSource(this, input),
      };
    if (Object.hasOwn(hostedBoardSchemas, requestedAction)) {
      const result = await boardHostedSource(this, requestedAction as keyof typeof hostedBoardSchemas, input);
      const { conflictNotice, notice } = result as { conflictNotice?: ExactConflictNotice; notice?: string };
      return {
        schema: 1,
        transport: 'hosted',
        action: requestedAction as keyof typeof hostedBoardSchemas,
        operationId: null,
        resolved: null,
        result,
        ...(conflictNotice ? { conflictNotice, notice } : {}),
      };
    }
    if (requestedAction === 'peers')
      return {
        schema: 1,
        transport: 'hosted',
        action: 'peers',
        operationId: null,
        resolved: null,
        result: await peersHostedSource(this, input),
      };
    const response = await this.operationContext.run(
      { id: typeof input.operationId === 'string' ? input.operationId : null },
      () => this.dispatchScoped(requestedAction, input, signal),
    );
    const snapshot = this.snapshotReceipt;
    this.snapshotReceipt = undefined;
    const withSnapshot = snapshot ? { ...response, snapshot } : response;
    // A stacked Lane's save restacks onto its parent's newer saved work when that applies cleanly.
    // Keyed on the normalized response action: the CLI sends a save under its wire name `checkpoint`.
    return withSnapshot.action === 'save'
      ? restackAfterSave(withSnapshot, this.checkoutLaneId(), (action, data) =>
          this.dispatch(action, data, signal),
        )
      : withSnapshot;
  }
  /** The Lane this checkout holds, if any. */
  checkoutLaneId() {
    return readHostedLaneCheckout(this.root)?.selection.laneId;
  }
  private async dispatchScoped(
    requestedAction: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<HostedAgentResponse> {
    // The landing message limit is local knowledge: refuse before any server call (friction d8d357c2).
    if (requestedAction === 'finish' && typeof input.message === 'string') landingMessage(input.message);
    const replay =
      typeof input.operationId === 'string' &&
      z.uuid().safeParse(input.operationId).success &&
      existsSync(resolve(clientCacheRoot(this.root), 'agent', `${input.operationId}.json`));
    const remoteSelection =
      requestedAction === 'finish' && (input.candidateId !== undefined || input.inputs !== undefined);
    const recoverySync = requestedAction === 'sync' && input.candidateId !== undefined;
    const pendingInstall = requestedAction === 'finish' && hasHostedSyncHandoff(this.root);
    if (
      !replay &&
      !remoteSelection &&
      !recoverySync &&
      !pendingInstall &&
      ['finish', 'save', 'checkpoint', 'resolve', 'sync', 'compose'].includes(requestedAction)
    ) {
      const laneId = pendingConflictLane(this.root);
      if (laneId && (!input.laneId || input.laneId === laneId)) {
        const marker = markerIdentity(this.root);
        if (
          marker?.laneId === laneId &&
          marker.url === this.address.url &&
          marker.projectId === this.address.projectId
        ) {
          precheckPendingConflicts(this.root, laneId);
          if (['finish', 'sync', 'compose'].includes(requestedAction)) requireResolution(this.root, laneId);
        }
      }
    }
    const running = quietActions.has(requestedAction)
      ? undefined
      : typeof input.laneId === 'string'
        ? input.laneId
        : (markerIdentity(this.root)?.laneId ?? undefined);
    try {
      const response = await withLaneCommand(running, requestedAction, () =>
        withExchangeProgress({ ...(signal ? { signal } : {}) }, () =>
          this.dispatchCaller(requestedAction, input, signal),
        ),
      );
      this.retainCaller(requestedAction, { result: response.result }, response.operationId);
      this.touchLane(requestedAction, input, response);
      return response;
    } catch (error) {
      this.retainCaller(requestedAction, { error }, this.callerOperationId);
      if (networkFailure(error))
        return networkContinuation(
          this.root,
          this.address,
          hostedAgentAction(requestedAction),
          input,
          this.callerOperationId,
          error,
        );
      throw error;
    }
  }
  /** Local Lane activity for idle listing and prune: one small file write, no network. */
  private touchLane(action: string, input: Record<string, unknown>, response: HostedAgentResponse) {
    if (
      [
        'capabilities',
        'metrics',
        'check-settings',
        'policy',
        'status',
        'observe',
        'landing',
        'start',
        'open',
      ].includes(action)
    )
      return;
    const laneId =
      typeof input.laneId === 'string' ? input.laneId : (markerIdentity(this.root)?.laneId ?? undefined);
    if (!laneId) return;
    const text = JSON.stringify(response.result ?? null);
    const state =
      action === 'abandon'
        ? ('abandoned' as const)
        : action === 'complete' || (action === 'finish' && /"phase":"landed"/.test(text))
          ? ('completed' as const)
          : undefined;
    recordLane({ laneId, ...(state ? { state } : {}) });
  }
  /** Record what the caller receives, locally; a later CLI mutation carries it. */
  private retainCaller(
    action: string,
    outcome: { result?: unknown; error?: unknown },
    operationId: string | null,
  ) {
    if (
      [
        'capabilities',
        'metrics',
        'check-settings',
        ...hostedAgentPlanningActions,
        ...hostedAgentPolicyActions,
        ...hostedAgentReviewActions,
      ].includes(action)
    )
      return;
    writeCallerReceipts(
      metricOutboxDirectory(this.address),
      callerReceipts({
        action,
        operationId,
        actor: this.callerActor,
        at: new Date().toISOString(),
        ...outcome,
      }),
    );
  }
  private async dispatchCaller(
    requestedAction: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<HostedAgentResponse> {
    // Issue e32cb0e7: capability discovery shares the metrics budget.
    if (requestedAction === 'metrics')
      return metricsDeadline(
        input,
        () => this.dispatchRequest(requestedAction, input, signal),
        this.metricsDeadlineMs,
      );
    if (
      [
        'capabilities',
        'status',
        'observe',
        'landing',
        'check-settings',
        'policy',
        'approve-link',
        'request-approval',
        ...hostedAgentPlanningActions,
      ].includes(requestedAction)
    )
      return this.dispatchRequest(requestedAction, input, signal);
    const metricRoot = resolve(this.root);
    return withLifecycleMetric(
      dirname(metricRoot),
      { ...input, action: requestedAction },
      () => this.dispatchRequest(requestedAction, input, signal),
      basename(rootSibling(metricRoot, '.forge-metrics.jsonl')),
    );
  }
  private async dispatchRequest(
    requestedAction: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<HostedAgentResponse> {
    let action: HostedAgentAction;
    try {
      action = hostedAgentAction(requestedAction);
    } catch (error) {
      if (error instanceof ForgeError && error.code === 'HOSTED_ACTION_UNSUPPORTED')
        throw unknownActionError(hostedAgentRoot(this.root), requestedAction);
      throw error;
    }
    invariant(
      hostedAgentAddressSchema.safeParse(this.address).success &&
        this.exchange.projectId === this.address.projectId,
      'BAD_ARGUMENT',
      'Select one complete hosted project address and matching transport.',
    );
    try {
      if ((hostedAgentRecordActions as readonly string[]).includes(action))
        return await executeHostedRecords(this, action as (typeof hostedAgentRecordActions)[number], input);
      const dispatchedAt = Date.now();
      const observation = action === 'status' || action === 'observe';
      const { operationId, ...parameters } = input;
      // Client-only start placement: where to open the Lane, or open:false for pins only.
      const placement =
        action === 'start'
          ? { path: parameters.path, open: parameters.open, installScripts: parameters.installScripts }
          : {};
      if (action === 'start') {
        delete parameters.path;
        delete parameters.open;
        delete parameters.installScripts;
        invariant(
          (placement.path === undefined || (typeof placement.path === 'string' && placement.path !== '')) &&
            (placement.open === undefined || typeof placement.open === 'boolean') &&
            (placement.installScripts === undefined || typeof placement.installScripts === 'boolean'),
          'BAD_ARGUMENT',
          'start path is a directory, open is true or false, and installScripts is true or false.',
        );
      }
      const command = hostedAgentCommandSchemas[action].safeParse(observation ? input : parameters);
      invariant(
        command.success,
        'BAD_ARGUMENT',
        `Invalid hosted ${requestedAction} parameters. ${command.success ? '' : describeIssues(command.error.issues, observation ? input : parameters)}. Run nforge agent ROOT ${requestedAction} --help.`,
      );
      if (!observation && operationId !== undefined)
        invariant(z.uuid().safeParse(operationId).success, 'BAD_ARGUMENT', 'operationId must be a UUID.');
      // A bare start has nothing to start. Refuse before any journal or call exists (Issue ec7bd1b5).
      if (action === 'start') {
        const asked = command.data as { planningItemId?: string; intentId?: string; outcome?: string };
        invariant(
          asked.planningItemId || asked.intentId || asked.outcome,
          'BAD_ARGUMENT',
          'start needs one of: planningItemId (an Issue id), intentId (join an Intent), or outcome (a new one).',
        );
      }
      // Policy needs no capability discovery: the server authorizes it, so each command is one call.
      if ((hostedAgentPolicyActions as readonly string[]).includes(action)) {
        const policy = await executeHostedPolicy(
          this,
          action as (typeof hostedAgentPolicyActions)[number],
          command.data as Record<string, unknown>,
          operationId as string | undefined,
        );
        return this.response(action, policy.operationId, policy.result);
      }
      // One query, no capability discovery; the page needs a signed-in owner, never this credential.
      if (action === 'request-approval') {
        const approval = await executeHostedApproval(
          {
            root: this.root,
            query: this.query.bind(this),
            mutation: this.mutation.bind(this),
            agentSlug: () => this.agentSlug() ?? undefined,
          },
          command.data as ApprovalCommand,
          operationId as string | undefined,
        );
        return this.response(action, approval.operationId, approval.result);
      }
      // Without an operationId, approve-link is the owner's attention list: every open approval request
      // (Lane, fork pull request run, held settings change) with its page link. One query.
      if (action === 'approve-link' && typeof operationId !== 'string') {
        const read = await this.query('projectHostedApprovals:list', {});
        return this.response(action, null, openApprovalsReply(read));
      }
      if ((hostedAgentReviewActions as readonly string[]).includes(action)) {
        invariant(
          typeof operationId === 'string',
          'BAD_ARGUMENT',
          'approve-link needs operationId: the original landing UUID from land --save.',
        );
        const link = await this.query<{ url: string | null; held: boolean }>(
          'projectHostedOwnerReview:link',
          {
            operationId,
          },
        );
        return this.response(action, null, {
          ...link,
          next: link.held
            ? link.url
              ? 'Hand this link to the project owner; they open it signed in and accept or decline. Your wait returns on their decision.'
              : 'This deployment has no web address configured; the owner accepts on the review page.'
            : 'This landing is not waiting for review.',
        });
      }
      if (action === 'pull') {
        const result = await pullHostedProject(
          this.root,
          this.address,
          mainCheckoutTransport(this.root, this.address, this.exchange),
          operationId as string | undefined,
        );
        await this.refreshDependencies(this.root);
        return this.response(action, result.operationId, result);
      }
      if (action === 'status' && Object.keys(input).length === 0 && readHostedMainSelection(this.root))
        return this.response(
          action,
          null,
          await cloneFreshness(this.root, mainCheckoutTransport(this.root, this.address, this.exchange)),
        );
      const settling = backgroundSaveOperation(this.root);
      let discovery: unknown;
      try {
        let options = capabilityOptions(this.root);
        // The CLI may have started this exact read alongside its release check: take it once.
        let early = takeEarlyCapabilities(this.address, { clientVersion: CUTOVER_CLI_VERSION, ...options });
        for (;;) {
          try {
            discovery = await (early ??
              this.query('projectHostedAgent:capabilities', {
                clientVersion: CUTOVER_CLI_VERSION,
                ...options,
              }));
            break;
          } catch (error) {
            early = undefined;
            if (
              !(error instanceof Error) ||
              !error.message.includes('ArgumentValidationError') ||
              !Object.keys(options).length
            )
              throw error;
            const field =
              /extra field\s+[`'"]?(features|noticeVersion|resolveVersion|overlapVersion|overlapEvidenceVersion|mirrorVersion|metricReceiptVersion|planningVersion|defaultsVersion|landingMessageVersion|openLanesVersion|presenceVersion|boardVersion|settling)\b/i.exec(
                error.message,
              )?.[1];
            // Preserve independently supported features, and never repeat a
            // named refusal. Pre-notice servers use the oldest argument shape.
            if (field === 'noticeVersion') options = {};
            else if (field && field in options) delete options[field];
            else
              options =
                'resolveVersion' in options || 'overlapVersion' in options || 'mirrorVersion' in options
                  ? { noticeVersion: 1 }
                  : {};
          }
        }
      } catch (error) {
        const safe = hostedActionError(error, 'agent capability discovery');
        if (safe.code !== 'HOSTED_ACTION_FAILED') throw safe;
        throw new ForgeError(
          'HOSTED_AGENT_UNAVAILABLE',
          'Hosted agent capability discovery is unavailable at this deployment. A compatible hosted agent API is required; no native owner or local listener fallback was attempted.',
        );
      }
      const capabilities = parseHostedResponse(
        hostedAgentCapabilitiesSchema,
        knownCapabilities(hostedAgentRoot(this.root), discovery),
      );
      this.callerActor = capabilities.actor;
      this.serverFeatures = capabilities.features ?? [];
      this.exchange.sourceStateReads = this.serverFeatures.includes('source-state');
      this.exchange.sourceStateVersion = this.serverFeatures.includes('source-state-v2') ? 2 : 1;
      // Named features (a83b6fd5); presenceVersion/boardVersion are still accepted from older CLIs.
      this.presenceAction =
        this.serverFeatures.includes('agent-presence') &&
        ['start', 'save', 'sync', 'compose', 'finish'].includes(action);
      this.boardVersion = this.serverFeatures.includes('agent-board');
      if (this.boardVersion) rememberBoardReader(this.root, this.address.projectId, capabilities.actor);
      // The first-write hook reads this marker instead of a capability call (written on change only).
      rememberBoardServerFeatures(this.address.projectId, this.serverFeatures);
      this.receiptActor = capabilities.metricReceiptVersion === 1 ? capabilities.actor : undefined;
      // Split save (fea47345 C): apply the outcome of this checkout's save that returned before its
      // settle, or report its failure, before the command does anything else.
      if (settling) await settleBackgroundSave(this.root, this.exchange, capabilities.settledSave);
      metricRequesterActor({ kind: 'agent', name: capabilities.actor });
      invariant(
        capabilities.projectId === this.address.projectId,
        'PROJECT_UNAVAILABLE',
        'Capabilities belong to a different project.',
      );
      if (
        !capabilities.actions.includes(action as (typeof capabilities.actions)[number]) &&
        !(
          capabilities.authority.mode !== 'native-owner' &&
          [...hostedAgentOwnerActions, ...hostedAgentClientActions, ...hostedAgentLandingActions].includes(
            action as never,
          )
        )
      )
        throw unadvertisedActionError(action);
      if ((hostedAgentPlanningActions as readonly string[]).includes(action)) {
        const planning = await executeHostedPlanning(
          {
            root: this.root,
            address: this.address,
            exchange: this.exchange,
            query: this.query.bind(this),
            mutation: this.mutation.bind(this),
            serverFeatures: this.serverFeatures,
            retainOperation: (id: string) => {
              this.callerOperationId ??= id;
            },
          },
          capabilities.actor,
          action as (typeof hostedAgentPlanningActions)[number],
          command.data as Record<string, unknown>,
          operationId as string | undefined,
        );
        return this.response(action, planning.operationId, planning.result);
      }
      if (action === 'metrics')
        return this.response(
          action,
          null,
          await executeHostedMetrics(
            {
              root: this.root,
              address: this.address,
              query: Object.assign(this.query.bind(this), {
                objects: this.exchange.downloadBatch.bind(this.exchange),
              }),
            },
            command.data,
            this.metricsDeadlineMs,
          ),
        );
      if (action === 'capabilities') {
        this.defaults = capabilities.agentDefaults;
        return this.response(action, null, {
          ...capabilities,
          ...(capabilities.agentDefaults ? { rules: agentDefaultLines(capabilities.agentDefaults) } : {}),
        });
      }
      this.defaults = capabilities.agentDefaults;
      if (action === 'snapshots') {
        invariant(
          this.serverFeatures.includes('lane-snapshots'),
          'HOSTED_ACTION_UNSUPPORTED',
          'This Forge server does not keep Lane snapshots yet.',
        );
        const selected = hostedAgentCommandSchemas.snapshots.parse(command.data);
        const root = selected.laneId
          ? (openLaneRoot({ root: this.root, address: this.address }, selected.laneId) ?? this.root)
          : this.root;
        return this.response(
          action,
          null,
          await executeSnapshots(root, this.address.projectId, this.exchange.client, selected),
        );
      }
      // Unsaved-work snapshot (7ac4e32f): only when the policy is on and files changed; never fails the command.
      // A project without the policy costs one local file check here; the Lane marker is read only when it is on.
      const keep = capabilities.laneSnapshots ? this.snapshotRoot(command.data) : null;
      if (keep) {
        rememberSnapshotsKept(keep, true, {
          intervalMinutes: capabilities.snapshotIntervalMinutes ?? LANE_SNAPSHOT.intervalMinutes.default,
          packs: this.serverFeatures.includes('lane-snapshot-packs'),
        });
        if (!snapshotSkips.has(action)) {
          if (snapshotFirst.has(action)) {
            const taken = await snapshotLaneCheckout(keep, this.address.projectId, this.exchange.client);
            this.snapshotReceipt = taken.status === 'unchanged' ? undefined : taken;
          } else launchSnapshotWorker(keep, this.address);
        }
      } else if (!capabilities.laneSnapshots) rememberSnapshotsKept(this.root, false);
      if (action === 'source-pack') {
        hostedAgentCommandSchemas['source-pack'].parse(command.data);
        const journal = new HostedAgentJournal(
          this.root,
          this.address,
          capabilities.actor,
          action,
          command.data,
          (operationId as string | undefined) ?? randomUUID(),
        );
        this.callerOperationId = journal.operationId;
        const main = await journal.retain('source-pack-main', () =>
          this.query<{ head: string }>('projectHostedChannels:current', {}),
        );
        return this.response(
          action,
          journal.operationId,
          await publishClientSourcePack({
            client: this.exchange.client as never,
            projectId: this.address.projectId,
            head: main.head,
            cacheRoot: clientCacheRoot(hostedAgentRoot(this.root)),
            transport: new HostedCheckoutDownloads(this.exchange),
          }),
        );
      }
      if (action === 'preflight')
        return await this.clientAction(action, command.data as Record<string, unknown>);
      if (action === 'check-settings')
        return this.response(action, null, await hostedCheckSettings(this.query.bind(this), capabilities));
      if (observation && action === 'status' && Object.keys(command.data).length === 0)
        return this.response(
          action,
          null,
          {
            needsFix: capabilities.needsFix ?? [],
            ...(capabilities.githubMirror !== undefined ? { githubMirror: capabilities.githubMirror } : {}),
          },
          capabilities.overlapVersion === 1 ? readHostedLaneCheckout(this.root)?.selection.laneId : undefined,
        );
      if (observation)
        return this.response(
          action,
          null,
          {
            ...((await this.observe(
              command.data as z.infer<typeof hostedAgentCommandSchemas.status>,
            )) as Record<string, unknown>),
            ...(capabilities.needsFix ? { needsFix: capabilities.needsFix } : {}),
            ...(capabilities.githubMirror !== undefined ? { githubMirror: capabilities.githubMirror } : {}),
            // Liveness: lastActivityAt above is the server record; this is the command this machine runs now.
            ...(typeof (command.data as { laneId?: string }).laneId === 'string'
              ? {
                  local: laneLiveness((command.data as { laneId: string }).laneId),
                }
              : {}),
          },
          capabilities.overlapVersion === 1 ? (command.data as { laneId?: string }).laneId : undefined,
        );
      const root = hostedAgentRoot(this.root);
      this.gcClientCache(root, [markerIdentity(root)?.laneId, (command.data as { laneId?: unknown }).laneId]);
      if (action === 'start' || action === 'open') hostedRootLanePath(root, this.address);
      const replaying =
        typeof operationId === 'string' &&
        existsSync(resolve(clientCacheRoot(root), 'agent', `${operationId}.json`));
      const pendingSync =
        action === 'finish' && !replaying ? await reconcileHostedSync(root, this.exchange) : null;
      if (pendingSync)
        return this.response(action, typeof operationId === 'string' ? operationId : null, pendingSync);
      const pendingSave =
        action === 'finish' && !replaying ? await reconcileHostedSave(root, this.exchange) : null;
      if (pendingSave)
        return this.response(action, typeof operationId === 'string' ? operationId : null, pendingSave);
      // An identical start replays only within the agent session that made it (issue b6ba9219).
      // Where the client's own environment gave the session id, the client process narrows it:
      // two processes sharing one session id never replay each other's start (issue 3676f3e1).
      const startSession = action === 'start' && !operationId ? this.startScope() : undefined;
      const previousStart =
        action === 'start' && !operationId
          ? await this.closedStart(root, capabilities.actor, command.data, startSession)
          : null;
      // An identical auto-addressed request replays only while the state its receipt reports still
      // holds (Issue ca49dc6c): a sync whose pins this checkout moved past, a withdraw whose landing
      // ended, a settled save whose Lane files changed since, an open whose folder is gone. Each
      // is new work instead. Local reads only; every action declares its binding (replayBindings).
      const supersededReplay =
        !operationId &&
        autoReplaySuperseded(action, {
          root,
          address: this.address,
          actor: capabilities.actor,
          command: command.data,
        });
      const journal =
        action === 'finish'
          ? await selectHostedFinish(
              root,
              this.address,
              capabilities.actor,
              hostedAgentCommandSchemas.finish.parse(command.data),
              operationId as string | undefined,
              (operationId, runId) =>
                runId
                  ? this.query('projectHostedCheckRead:status', { runId })
                  : this.query('projectHostedFinishObserve:page', {
                      operationId,
                      nextVersion: 0,
                    }),
            )
          : new HostedAgentJournal(
              root,
              this.address,
              capabilities.actor,
              action,
              command.data,
              operationId as string | undefined,
              previousStart !== null || supersededReplay,
              startSession,
            );
      metricOperationId(journal.operationId);
      this.callerOperationId = journal.operationId;
      this.onOperation?.(action, journal.operationId);
      // The finish gate's judgement of the checkout's saved head, sent again with the landing.
      let gatedLane: LandGateEntry | undefined;
      let carriedMain = mainFirstActions.has(action) ? capabilities.main : undefined;
      const session: HostedAgentSession = {
        root,
        address: this.address,
        exchange: this.exchange,
        capabilities,
        journal,
        ...(this.sentAgent() ? { agent: this.sentAgent()! } : {}),
        ...(this.serverFeatures?.includes('landing-agent-run') && this.agentSlug()
          ? { landingAgent: this.agentSlug()! }
          : {}),
        ...(this.serverFeatures?.includes('landing-agent-client') && this.agentSlug() && agentClient()
          ? { landingClient: agentClient()! }
          : {}),
        query: this.query.bind(this),
        mutation: this.mutation.bind(this),
        action: this.action.bind(this),
        main: async () => {
          // A start, sync or compose reads main first: the capability read of this same command
          // already carries it (capabilities-main), once. Later reads, and other actions, read current.
          const taken = carriedMain;
          carriedMain = undefined;
          const main =
            taken ??
            parseHostedResponse(hostedMainV2Schema, await this.query('projectHostedChannels:current', {}));
          invariant(
            main.projectId === this.address.projectId,
            'PROJECT_UNAVAILABLE',
            'Main belongs to another project.',
          );
          return main;
        },
        waitSource: (operationId, initial, kind, timeoutSeconds, observe, settle) =>
          waitHostedAgentSource(
            this.address,
            operationId,
            initial,
            signal,
            this.subscribeSource,
            kind,
            timeoutSeconds,
            observe,
            settle,
            this.serverFeatures?.includes('source-board-wait') ? this.waitBoard : undefined,
          ),
        waitUntil: this.waitUntil ?? dispatchedAt + AGENT_WAIT_SECONDS * 1000,
        finishGates: async (laneId: string, head: string, tree?: string) => {
          const read = await this.overlapAdvice(laneId, capabilities.agentDefaults?.preflight !== 'off');
          const selected = readHostedLaneCheckout(root)?.selection;
          const advice =
            capabilities.agentDefaults?.preflight !== 'off' && selected?.laneId === laneId
              ? {
                  ...read,
                  changedPaths: await savedChangedPaths(
                    this,
                    { base: selected.base.head, head },
                    read.changedPaths,
                  ),
                }
              : read;
          // The paths this landing carries, so its check failure can teach the next preflight.
          if (advice.changedPaths?.complete) rememberLandingPaths(root, laneId, advice.changedPaths.paths);
          // The gates read the preflight planner and the test-selection graph; only a finish loads them.
          const { finishGates } = await import('./agent-default-gates.js');
          const gates = finishGates(
            root,
            capabilities.agentDefaults,
            {
              laneId,
              head,
              ...(tree ? { tree } : {}),
            },
            advice,
            selected?.laneId === laneId && selected.head === head
              ? () =>
                  invariant(
                    !hostedLaneDirty(root, { refresh: true }),
                    'LANE_DIRTY',
                    'Save first: inline preflight records a result for the saved head, and the files here differ from it. Replay land --save to save them.',
                  )
              : false,
          );
          // The server requires this preflight result again at enqueue (Issue 029138ef).
          gatedLane = { laneId, head, preflight: preflightResult(gates.preflight) };
          if (this.serverFeatures?.includes('save-preflight-timing')) {
            const { readPreflightReceipt } = await import('./agent-preflight.js');
            const receipt = readPreflightReceipt(root, laneId);
            const saveMs = savedDuration(root, laneId, head);
            if (saveMs !== undefined) gatedLane.saveMs = saveMs;
            if (receipt && (receipt.tree && tree ? receipt.tree === tree : receipt.head === head))
              gatedLane.preflightMs = Math.round(receipt.durationMs);
          }
          return gates;
        },
        landGates: (composeOperationId: string) => {
          if (!this.serverFeatures?.includes('land-gates')) return undefined;
          // A Candidate composed by an earlier operation (a check-only run reused): this checkout's
          // saved head, which the server confirms against the composition it lands.
          const composed = composedLanes(journal, composeOperationId);
          const selected = readHostedLaneCheckout(root)?.selection;
          const lanes = composed.length
            ? composed
            : selected
              ? [{ laneId: selected.laneId, head: selected.head }]
              : [];
          return landGatesArgument(lanes, gatedLane);
        },
        marker: () => {
          const marker = readHostedLaneCheckout(root);
          if (marker)
            invariant(
              marker.selection.projectId === this.address.projectId && marker.url === this.address.url,
              'WORK_OPERATION_CHANGED',
              'This checkout belongs to another hosted project.',
            );
          return marker;
        },
      };
      let result: unknown;
      if (
        action === 'open' &&
        hostedRootLanePath(root, this.address, (command.data as { laneId: string }).laneId) !== root
      ) {
        const open = hostedAgentCommandSchemas.open.parse(command.data);
        result = await openHostedRootLane(root, this.address, this.exchange, {
          ...open,
          operationId: journal.operationId,
        });
      } else {
        if (action === 'finish') markLandStep('ready');
        result = await executeHostedAgent(session, action, command.data);
        // A sync, resolution or revert rewrote files: follow a changed lockfile before the next build.
        if (['sync', 'resolve', 'revert', 'compose'].includes(action)) await this.refreshDependencies(root);
        const askedItemId =
          action === 'start' && (command.data as { planningItemId?: string }).planningItemId;
        // A short id was resolved by the start itself: the journal holds the Issue it started. (The
        // started Intent can be a follow-up with its own id, e4a71127.)
        const planningItemId =
          askedItemId && isPlanningPrefix(askedItemId)
            ? (journal.get<{ intentId?: string }>('start-planned-intent')?.intentId ??
              (result as { intentId?: string }).intentId)
            : askedItemId;
        const planning = planningItemId
          ? await markPlanningStarted(
              {
                root,
                address: this.address,
                exchange: this.exchange,
                query: this.query.bind(this),
                mutation: this.mutation.bind(this),
                serverFeatures: this.serverFeatures,
              },
              planningItemId,
              journal.operationId,
            )
          : undefined;
        if (action === 'finish') result = await recoverHostedFinish(session, result);
        if (action === 'start') {
          // The replay command keeps the client-only choice to run dependency install scripts.
          const startData =
            typeof placement.installScripts === 'boolean'
              ? { ...(command.data as object), installScripts: placement.installScripts }
              : command.data;
          const started = parseHostedResponse(hostedStartResultSchema, result);
          const into =
            placement.open === false || !started.lane
              ? null
              : typeof placement.path === 'string'
                ? resolve(placement.path)
                : hostedRootLanePath(root, this.address)
                  ? hostedRootLanePath(root, this.address, started.lane.laneId)
                  : null;
          if (started.lane) {
            // Later identical starts replay this Lane only while it is open (closedStart).
            await journal.retain('started-lane', () => started.lane!.laneId);
            // Report the Lane before its checkout downloads, so a slow or interrupted open never hides it.
            recordLane({
              laneId: started.lane.laneId,
              root: into ?? root,
              url: this.address.url,
              projectId: this.address.projectId,
              // This run started it: only this run's start lists it as its own idle Lane (d730121f).
              agent: this.agentSlug() ?? null,
              ...(command.data && typeof (command.data as { outcome?: unknown }).outcome === 'string'
                ? { outcome: (command.data as { outcome: string }).outcome }
                : {}),
            });
            this.onStarted?.({ laneId: started.lane.laneId, path: into });
          }
          if (into) {
            invariant(started.lane, 'SOURCE_UNAVAILABLE', 'Hosted start has no Lane source.');
            result = await this.completeStart(root, started, into, startData, journal);
          } else if (started.lane && placement.open !== false)
            // Pins only because ROOT has no default placement: say how to materialize this same Lane.
            result = {
              ...started,
              continuation: startContinuation(
                this.root,
                startData,
                journal.operationId,
                laneSiblingPath(root, started.lane.laneId),
                'no-placement',
              ),
            };
        }
        if (planning) result = { ...(result as object), planning };
        const startedIntent = (result as { intentId?: string }).intentId;
        if (action === 'start' && planningItemId && startedIntent && startedIntent !== planningItemId)
          result = {
            ...(result as object),
            continued: {
              issueId: planningItemId,
              intentId: startedIntent,
              note: `Intent ${startedIntent} continues Issue ${planningItemId}: the Issue's earlier Intent already finished, so this start opened a follow-up Intent (new or joined) for the same Issue.`,
            },
          };
        if (action === 'start' && previousStart) {
          const { unscoped, ...previousLane } = previousStart;
          result = {
            ...(result as object),
            previousLane: {
              ...previousLane,
              note: unscoped
                ? `An identical start on this machine ran before (${'operationId' in previousStart ? `operation ${previousStart.operationId}` : `Lane ${previousStart.laneId}`}). No agent session id (CLAUDE_CODE_SESSION_ID, CODEX_THREAD_ID or the MCP session) shows it was yours, so this opened a new Lane instead of replaying it; openLanes lists the open ones. To retry a lost start, pass its operationId.`
                : `The Lane from your earlier identical start is ${previousStart.state}; this opened a new Lane.`,
            },
          };
        }
      }
      if (action === 'open') {
        const opened = result as { root?: unknown; laneId?: unknown };
        const path = typeof opened.root === 'string' ? opened.root : resolve(root);
        recordLane({
          laneId: (command.data as { laneId: string }).laneId,
          root: path,
          url: this.address.url,
          projectId: this.address.projectId,
        });
        result = {
          ...(result as object),
          dependencies: await this.shareDependencies(path),
        };
        const laneId = (command.data as { laneId: string }).laneId;
        const paths = pendingConflictPaths(path, laneId);
        if (paths.length)
          result = {
            ...(result as object),
            conflict: resolutionContinuation(path, laneId, paths),
          };
      }
      // A replayed finish poll adds no read; the first call and the terminal answer carry the notice.
      const finishDone =
        action === 'finish' && /"phase":"(landed|ready|terminal-failed)"/.test(JSON.stringify(result));
      const overlapLane =
        capabilities.overlapVersion === 1 &&
        (['start', 'save', 'sync', 'compose'].includes(action) ||
          (action === 'finish' && (!replaying || finishDone)))
          ? ((result as { lane?: { laneId?: string } }).lane?.laneId ??
            (command.data as { laneId?: string }).laneId ??
            readHostedLaneCheckout(root)?.selection.laneId)
          : undefined;
      // start's housekeeping (one batched read, advice only) runs beside the overlap read, never after it.
      const started =
        action === 'start' ? (result as { lane?: { laneId?: string } | null; path?: string }) : undefined;
      const housekeeping = started
        ? boundedStep(
            this.housekeeping(
              [root, ...(started.path ? [started.path] : [])],
              [...(started.lane?.laneId ? [started.lane.laneId] : [])],
            ),
            Math.min(15_000, this.startBoundMs),
          )
        : undefined;
      const declared = (command.data as { scope?: { paths?: string[] } }).scope?.paths;
      this.overlapScope =
        action === 'start' && declared?.length && this.serverFeatures?.includes('overlap-scope')
          ? declared
          : undefined;
      const response = await this.response(
        action,
        journal.operationId,
        await withSourceRecovery(
          session,
          action,
          action === 'finish'
            ? ((result as { replayParameters?: object }).replayParameters ?? command.data)
            : command.data,
          result,
        ),
        overlapLane,
      );
      if (housekeeping) {
        // Never let advice hold the reply back past its bound.
        const done = await housekeeping;
        if (done.status === 'done' && done.value) response.localLanes = done.value;
        else if (done.status === 'timeout') this.abandonedStart = true;
      }
      return response;
    } catch (error) {
      const owner = nativeOwner(existsSync(this.root) ? realpathSync(this.root) : this.root);
      // The native Work store is a large module graph; only a failing native-owned command loads it.
      if (owner)
        rememberSourceAuthorityError(
          (await import('./work-store.js')).WorkStore.open<'directory' | 'locked'>(owner),
          error,
          this.address.projectId,
        );
      if (error instanceof z.ZodError)
        throw isHostedReplyError(error)
          ? protocolMismatchError(replyIssuePaths(error.issues))
          : localShapeError(action, error.issues);
      const safe = hostedActionError(error, `agent ${action}`);
      // A write pause, OCC conflict or 429/503 refusal ran nothing: keep its structured
      // retryable flag and retryAt instead of rebuilding it from code and message (72d50375).
      const refused =
        safe.code === 'LEGACY_STORAGE_WRITES_PAUSED' ||
        safe.code === 'HOSTED_CONFLICT' ||
        safe.recovery?.outcome === 'refused';
      if (refused && safe.recovery?.retryable !== true)
        throw retryableExchangeError(safe, this.callerOperationId) ?? safe;
      if (safe instanceof SourceAuthorityStaleError || safe.recovery) throw safe;
      // Version skew (either side) needs an upgrade, not a replay.
      if (
        safe.code === 'HOSTED_ACTION_UNSUPPORTED' ||
        safe.code === 'CLI_UPGRADE_REQUIRED' ||
        safe.code === 'HOSTED_SCHEMA_REJECTED'
      )
        throw safe;
      throw new ForgeError(
        safe.code,
        gateCodes.has(safe.code)
          ? safe.message
          : `${safe.code === 'HOSTED_ACTION_FAILED' ? `Hosted agent ${action} failed.` : safe.message} Retry the original hosted agent action and parameters to reconcile its retained operation.`,
      );
    }
  }
  /** Seconds-bound for checkout and dependency sharing after the durable start. */
  startBoundMs = START_COMPLETION_SECONDS * 1000;
  /** Whole metrics action, capability discovery included (e32cb0e7). */
  metricsDeadlineMs = METRICS_DEADLINE_MS;
  /** Set when a bounded step was abandoned: the CLI must not wait for it to exit. */
  abandonedStart = false;
  /** Checkout and dependency sharing after the durable start, within the bound. A stall or failure
   * still returns the Lane, its path and the exact same-operation replay, with no extra calls. */
  private async completeStart(
    root: string,
    started: { lane?: { laneId: string } | null },
    into: string,
    data: unknown,
    journal: HostedAgentJournal,
  ) {
    const laneId = started.lane!.laneId,
      deadline = Date.now() + this.startBoundMs,
      left = () => deadline - Date.now(),
      boundSeconds = this.startBoundMs / 1000;
    const replay = (reason: 'stalled' | 'failed') => {
      if (reason === 'stalled') this.abandonedStart = true;
      return startContinuation(this.root, data, journal.operationId, into, reason);
    };
    // A checkout ROOT keeps its warm object cache for the new Lane, wherever it opens.
    const open = async () =>
      openHostedRootLane(
        hostedRootLanePath(root, this.address) ? root : into,
        this.address,
        this.exchange,
        { laneId, operationId: await journal.id('checkout') },
        into,
      );
    const opening = (async () => {
      try {
        return await open();
      } catch (error) {
        // A replayed start whose Lane folder was deleted since (Issue ca49dc6c): its finished
        // checkout no longer holds, so the Lane opens again as new work at its current saved head.
        if (!(error instanceof ForgeError && error.code === 'CHECKOUT_MISSING')) throw error;
        journal.forget('id:checkout');
        return open();
      }
    })();
    const opened = await boundedStep(opening, left());
    if (opened.status !== 'done') {
      const failure =
        opened.status === 'timeout'
          ? { reason: 'timeout', boundSeconds }
          : (({ code, message }) => ({ reason: 'failed', code, message }))(
              hostedActionError(opened.error, 'start checkout'),
            );
      return {
        ...started,
        path: into,
        checkout: { status: 'incomplete', ...failure },
        dependencies: { status: 'pending' },
        continuation: replay(opened.status === 'timeout' ? 'stalled' : 'failed'),
      };
    }
    recordLane({ laneId, root: opened.value.root });
    const shared = await boundedStep(
      this.shareDependencies(
        opened.value.root,
        // An explicit start flag wins; unset, a repository's request runs only if this machine accepts it.
        flag((data as { installScripts?: unknown } | null)?.installScripts),
      ),
      left(),
    );
    return {
      ...started,
      path: opened.value.root,
      checkout: opened.value,
      dependencies:
        shared.status === 'done' ? shared.value : { status: 'pending', reason: 'timeout', boundSeconds },
      ...(shared.status === 'done' ? {} : { continuation: replay('stalled') }),
    };
  }
  /** After files changed in a Lane: one key compare; a Forge link to an older lockfile's install is
   * relinked (or installed once into the shared cache). Silent when nothing changed; never fails the action. */
  private async refreshDependencies(path: string) {
    try {
      const shared = await shareDependencies(path, {
        refresh: true,
        announce: announceRegistryHosts,
      });
      if ('relinked' in shared && shared.relinked)
        process.stderr.write(
          `The lockfile changed: node_modules now links the install for the current one (was ${shared.relinked.from}).\n`,
        );
      else if (shared.status === 'stale' || shared.status === 'failed')
        process.stderr.write(
          `The lockfile changed but node_modules was not relinked: ${'reason' in shared ? shared.reason : shared.message}\n`,
        );
      const notice = installScriptsNotice(shared);
      if (notice && 'relinked' in shared) process.stderr.write(`${notice}\n`);
    } catch {
      /* Dependencies are a convenience the agent can still install itself. */
    }
  }
  /** Never fails the action: dependencies are a convenience the agent can still install itself. */
  private async shareDependencies(path: string, runScripts?: boolean) {
    try {
      const shared = await shareDependencies(path, {
        runScripts,
        announce: announceRegistryHosts,
      });
      const notice = installScriptsNotice(shared);
      if (notice) process.stderr.write(`${notice}\n`);
      return shared;
    } catch (error) {
      return {
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
  /** Nested Lane copies are a cache: at most one bounded local pass an hour, never a failure. */
  private gcClientCache(root: string, keep: unknown[]) {
    try {
      gcNestedLanesHourly({
        root,
        keepLaneIds: keep.filter((id): id is string => typeof id === 'string'),
      });
    } catch {
      /* Cache housekeeping is advisory. */
    }
  }
  /** start lists the caller's idle open Lanes and prunes finished Lane roots: registry plus one batched read. */
  private async housekeeping(roots: string[], laneIds: string[]) {
    try {
      const settings = readClientSettings();
      const value = await laneHousekeeping({
        readStates: convexLaneStates(() => ({
          query: (name, args) => this.exchange.client.query(name as never, args as never),
        })),
        address: this.address,
        apply: settings.autoPruneHours > 0,
        settings,
        exclude: { roots, laneIds },
        run: this.agentSlug() ?? null,
      });
      if (!value.idle.length && !value.otherRuns.length && !value.pruned.length) return undefined;
      return {
        idle: value.idle,
        ...(value.otherRuns.length ? { otherRuns: value.otherRuns } : {}),
        pruned: {
          count: value.pruned.length,
          bytes: value.pruned.reduce((sum, lane) => sum + lane.bytes, 0),
        },
      };
    } catch {
      return undefined;
    }
  }
  private async response(
    action: HostedAgentAction,
    operationId: string | null,
    result: unknown,
    overlapLaneId?: string,
  ): Promise<HostedAgentResponse> {
    const advice = overlapLaneId ? await this.overlapAdvice(overlapLaneId) : undefined;
    this.cachedAdvice = undefined;
    // D2: a stack offer is never shown while this checkout's own landing is live (no sync then),
    // and the last offer is kept for stacking:auto.
    const offered = advice?.stackOffer;
    const offer =
      offered && !(liveLanding(result) || ownsLiveLanding(hostedAgentRoot(this.root))) ? offered : undefined;
    if (advice && overlapLaneId && advice.behindMain.coverage !== 'unavailable')
      rememberStackOffer(overlapLaneId, offer);
    const presence =
      advice?.presence && overlapLaneId ? presenceDelivery(overlapLaneId, advice.presence) : undefined;
    const conflictNotice =
      advice?.conflicts && overlapLaneId ? exactConflictNotice(overlapLaneId, advice.conflicts) : undefined;
    const board =
      advice?.board && overlapLaneId ? boardEnvelope(this.root, overlapLaneId, advice.board) : undefined;
    // Conflict advice first, so the continuation never offers wait beside a recovery.
    // Finite canonical reads never hydrate conflict/advice source; a terminal conflict on
    // a landing read gets the same one-query sync recovery as wait. Mutating flows may
    // still prepare their existing actionable conflict checkout.
    result =
      action === 'status' || action === 'observe'
        ? enrichHostedQueueAhead(this, terminalConflict(result) ? await this.readRecovery(result) : result)
        : await hostedConflictAdvice(this, enrichHostedQueueAhead(this, result));
    if (result && typeof result === 'object')
      result = hostedObservationContinuation(this.root, result as Record<string, unknown>);
    const missing = this.serverFeatures ? missingRequiredFeatures(this.serverFeatures) : [];
    return {
      schema: 1,
      cliCommit: cliBuildCommit(),
      transport: 'hosted',
      action,
      operationId,
      resolved: operationId ? { operationId } : null,
      result,
      ...(advice ? { behindMain: advice.behindMain } : {}),
      ...(advice?.stack ? { stack: advice.stack } : {}),
      ...(offer
        ? {
            stackOffer: {
              peerLaneId: offer.peerLaneId,
              mode: offer.mode,
              text: offer.text,
              command: offer.command,
            },
          }
        : {}),
      ...(conflictNotice ? { conflictNotice } : {}),
      ...(presence ? { presence } : {}),
      ...(board?.notices.length ? { board } : {}),
      // One marker per receipt, not per note: board notes (stack notices arrive as board notes) and
      // conflict and presence peers name member-written text. A stack hint holds Lane ids only.
      ...(conflictNotice || presence || board?.notices.length ? { notice: memberDataNotice } : {}),
      ...this.nudge(action, result),
      ...(action === 'status' ? keptApplyEnvelope(this.root) : {}),
      ...this.identity(action),
      ...(missing.length ? { serverContract: { missing } } : {}),
    };
  }
  /** Who this session shows as to other agents (c29d0780), on Lane-changing receipts only. */
  private identity(action: string): { as?: string } {
    const slug = ['start', 'save', 'finish'].includes(action) ? this.sentAgent() : undefined;
    return slug && this.callerActor ? { as: `${this.callerActor}/${slug}` } : {};
  }
  /** A read keeps its canonical terminal outcome even when recovery metadata is unreadable or
   * belongs to another attempt; wait and finish still surface that refusal. */
  private async readRecovery<T extends Parameters<typeof observedConflictRecovery>[1]>(entry: T) {
    try {
      return await observedConflictRecovery(this, entry);
    } catch {
      return entry;
    }
  }
  /** One overlap read per dispatch: a finish gate and its receipt share it. */
  private async overlapAdvice(laneId: string, paths = false) {
    if (this.cachedAdvice?.laneId === laneId) return this.cachedAdvice.value;
    const value = await readHostedOverlapAdvice(
      this,
      laneId,
      paths,
      undefined,
      this.presenceAction ? presenceSince(laneId) : undefined,
      this.boardVersion ? { after: readBoardCursor(this.root, laneId) } : undefined,
      this.overlapScope,
    );
    this.cachedAdvice = { laneId, value };
    return value;
  }
  /** unsavedFor and the checkpoint nudge, on Lane calls only; a local stat walk, no timers. */
  private nudge(action: HostedAgentAction, result: unknown) {
    if (!this.defaults || ['save', 'capabilities', 'metrics', 'check-settings'].includes(action)) return {};
    const root = hostedAgentRoot(this.root);
    const laneId = readHostedLaneCheckout(root)?.selection.laneId;
    if (!laneId) return {};
    // Reported, never finished here: observation takes no lock and changes no file.
    if (deltaApplyPending(root))
      return {
        interruptedApply:
          'A local apply is running or was interrupted in this checkout. The next sync, save or preflight here finishes it first.',
      };
    // A live landing froze this saved source: saving now would supersede it, so never advise it.
    const frozen = liveLanding(result) || ownsLiveLanding(root);
    return checkpointNudge(root, laneId, this.defaults, unsavedMinutes(root), frozen);
  }
  /** The Lane of an earlier identical `start` that this start must not replay. Within one agent
   * session: its Lane once finished (a follow-up start opens a new Lane), else null while it is open
   * (that replay is the idempotent retry). Without a session id nothing proves the earlier start was
   * this agent's, so any earlier Lane is reported and never replayed (no read). Local registry first;
   * one Lane read only when an earlier same-session start exists, so a first start makes no extra call. */
  private async closedStart(root: string, actor: string, command: unknown, session: string | undefined) {
    const previous = HostedAgentJournal.previous(root, this.address, actor, 'start', command, session);
    const laneId = previous?.values['started-lane'];
    if (previous && session === undefined)
      return typeof laneId === 'string'
        ? {
            laneId,
            state: readLaneEntry(laneId)?.state ?? 'unknown',
            unscoped: true,
          }
        : {
            laneId: null,
            operationId: previous.operationId,
            state: 'unknown',
            unscoped: true,
          };
    if (typeof laneId !== 'string') return null;
    const local = readLaneEntry(laneId)?.state;
    if (local) return { laneId, state: local, unscoped: false };
    try {
      const lane = await this.query<{ state?: string }>('projectHostedLanes:select', { laneId });
      return lane.state === 'completed' || lane.state === 'abandoned'
        ? { laneId, state: lane.state, unscoped: false }
        : null;
    } catch (error) {
      if (hostedActionError(error, 'start').code === 'NOT_FOUND')
        return { laneId, state: 'missing', unscoped: false };
      throw error;
    }
  }
  private async clientAction(action: 'preflight', input: Record<string, unknown>) {
    const root = hostedAgentRoot(this.root);
    // A save the client returned as pending may have completed on the server while the marker still
    // names the earlier head. Settle that original operation (no new save) before anything pins the
    // marker's head/tree. No pending file means no call.
    // An interrupted local apply leaves the marker describing other bytes; finish it first.
    finishPendingCheckoutDelta(root);
    await this.refreshDependencies(root);
    const pendingSave = await reconcileHostedSave(root, this.exchange);
    if (pendingSave) return this.response(action, null, pendingSave);
    const marker = readHostedLaneCheckout(root);
    const laneId = (input.laneId as string | undefined) ?? marker?.selection.laneId;
    invariant(laneId, 'BAD_ARGUMENT', `Select laneId, or run ${action} inside the Lane directory.`);
    const command = hostedAgentCommandSchemas.preflight.parse(input);
    invariant(
      marker?.selection.laneId === laneId,
      'HOSTED_CHECKOUT_REQUIRED',
      'Run preflight with the Lane folder printed by start as ROOT (not the project folder): it tests the saved files there.',
    );
    const { preflightPlan, readPreflightReceipt, runPreflight } = await import('./agent-preflight.js');
    const stopped = command.retry ? readPreflightReceipt(root, laneId)?.stopped : undefined;
    invariant(
      !command.retry || stopped?.length,
      'BAD_ARGUMENT',
      'The last preflight of this Lane stopped no file for time; run preflight without "retry".',
    );
    const advice = await readHostedOverlapAdvice(this, laneId, true);
    const plan = preflightPlan(
      root,
      await savedChangedPaths(
        this,
        { base: marker.selection.base.head, head: marker.selection.head },
        advice.changedPaths,
      ),
      { laneId, files: marker.state.files, base: marker.selection.base.head },
      { budgetSeconds: command.budgetSeconds, trim: command.trim, only: stopped },
    );
    const head = marker.selection.head;
    const landNext = {
      next: { action: 'land', mode: 'save', laneId },
      command: hostedRecoveryCommand(root, 'land --save', { laneId }),
    };
    const planNext = {
      next: { action: 'preflight', ...command, laneId, run: true },
      command: hostedRecoveryCommand(root, 'preflight', { ...command, laneId, run: true }),
    };
    if (plan.status === 'unavailable' || !command.run)
      return this.response(action, null, {
        laneId,
        head,
        plan,
        ...(plan.status === 'unavailable' ? landNext : planNext),
      });
    const minutes = unsavedMinutes(root);
    invariant(
      minutes === null,
      'LANE_DIRTY',
      'Save first: preflight records a result for the saved head, and these files have unsaved edits.',
    );
    // File times can miss an edit made while a save was uploading (the marker is rewritten after it).
    // The receipt must name the bytes under test, so confirm them against the saved baseline: a local
    // digest pass that skips files the stat index vouches for (and refreshes its racy entries).
    invariant(
      !hostedLaneDirty(root, { refresh: true }),
      'LANE_DIRTY',
      'Save first: preflight records a result for the saved head, and the files here differ from it.',
    );
    const receipt = runPreflight(root, laneId, head, plan, marker.tree ?? sourceTree(marker.state.files));
    const next = receipt.passed || receipt.environment ? landNext : planNext;
    return this.response(action, null, {
      laneId,
      head,
      plan,
      receipt,
      ...next,
    });
  }
  async query<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    if (name === 'projectHostedCheckRead:status')
      args = { ...args, features: ['ci-status-check', 'check-report-detail'] };
    const priorityRead = [
      'projectHostedLanding:status',
      'projectHostedFinish:status',
      'projectHostedFinishObserve:page',
    ].includes(name);
    const request = {
      ...args,
      projectId: this.address.projectId,
      ...(capsuleHistoryQueries.has(name) && this.serverFeatures?.includes('landing-capsules-v1')
        ? { capsuleProtocol: 1 }
        : {}),
    };
    const read = async (input: Record<string, unknown>) => {
      try {
        return await this.exchange.client.query(makeFunctionReference<'query'>(name), input);
      } catch (error) {
        if (hasJournalHistory(error)) return error;
        throw error;
      }
    };
    let value: unknown;
    let selectedRequest: Record<string, unknown> = request;
    if (priorityRead && this.priorityReads !== false) {
      try {
        value = await read({
          ...request,
          priorityInfo: 1,
        });
        this.priorityReads = true;
        selectedRequest = { ...request, priorityInfo: 1 };
      } catch (error) {
        // Read-only negotiation with a released server. Authorization and source
        // failures never trigger a retry or a native/alternate-source fallback.
        const message = error instanceof Error ? error.message : '';
        if (
          !message.includes('ArgumentValidationError') ||
          !message.includes('priorityInfo') ||
          !/extra field/i.test(message)
        )
          throw error;
        this.priorityReads = false;
        value = await read(request);
      }
    } else value = await read(request);
    value = await hydrateLandingHistory(name, selectedRequest, value, (name, args) =>
      this.action(name, args),
    );
    return (typeof value === 'string' ? JSON.parse(value) : value) as T;
  }
  async mutation<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    if (!this.callerOperationId) {
      const payload = args.request ?? args.command;
      let command: unknown = args;
      if (typeof payload === 'string') {
        try {
          command = JSON.parse(payload);
        } catch {
          /* The server owns validation. */
        }
      }
      const identity = z.object({ operationId: z.uuid() }).safeParse(command);
      if (identity.success) this.callerOperationId = identity.data.operationId;
    }
    const outbox = metricOutboxDirectory(this.address);
    const pending =
      this.receiptActor && receiptMutations.has(name) ? takeCallerReceipts(outbox, this.receiptActor) : null;
    const request = {
      ...args,
      projectId: this.address.projectId,
      ...(pending ? { metricReceipts: pending.payload } : {}),
    };
    let value: unknown;
    for (let retry = 0; ; retry++) {
      try {
        value = await this.exchange.client.mutation(makeFunctionReference<'mutation'>(name), request);
        break;
      } catch (error) {
        // Provider OCC exhaustion has no committed mutation. Reconcile the same
        // receipt-pinned payload; never rediscover main, source or the epoch.
        const typed = hostedActionError(error, name);
        // A 429/503 refusal also ran nothing; wait out a short Retry-After (72d50375).
        if (
          typed.code === 'EXCHANGE_REQUEST_TIMEOUT' &&
          retry === 0 &&
          [
            'projectHostedLanding:enqueue',
            'projectHostedLandingDesired:submit',
            'projectHostedChecks:enqueue',
          ].includes(name)
        )
          continue;
        const wait = refusedWait(typed, retry);
        if ((typed.code !== 'HOSTED_CONFLICT' && wait === null) || retry >= 3)
          throw retryableExchangeError(typed, this.callerOperationId) ?? error;
        await new Promise(resolve => setTimeout(resolve, wait ?? 25 * 2 ** retry));
      }
    }
    if (pending) clearCallerReceipts(pending.files);
    const metricRoot = resolve(this.root);
    recordOwnerMutation(
      dirname(metricRoot),
      undefined,
      basename(rootSibling(metricRoot, '.forge-metrics.jsonl')),
    );
    return (typeof value === 'string' ? JSON.parse(value) : value) as T;
  }
  /** One attempt: an action is not retried here, its caller replays the same operation id. */
  async action<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    let value: unknown;
    try {
      value = await this.exchange.client.action(makeFunctionReference<'action'>(name), {
        ...args,
        projectId: this.address.projectId,
      });
    } catch (error) {
      // The server's typed refusal (HISTORY_UNAVAILABLE, ...) reaches the caller with its code and
      // message; only a transient one gets the retry wording. Never the raw error: it prints as INTERNAL_ERROR.
      const typed = hostedActionError(error, name);
      throw retryableExchangeError(typed, this.callerOperationId) ?? typed;
    }
    return (typeof value === 'string' ? JSON.parse(value) : value) as T;
  }
  private async observe(command: z.infer<typeof hostedAgentCommandSchemas.status>) {
    const { laneId, operationId, submissionId, runId, kind, version, summary, reports, cursor } = command;
    invariant(!summary || runId, 'BAD_ARGUMENT', 'summary:true reads one check run: pass runId.');
    invariant(
      [laneId, operationId, submissionId, runId].filter(Boolean).length === 1,
      'BAD_ARGUMENT',
      'Choose exactly one operationId (original landing or source operation), submissionId or runId; status also accepts laneId.',
    );
    if (submissionId)
      return this.query('projectHostedFinish:status', {
        submissionId,
        ...(version === undefined ? {} : { version }),
      });
    if (runId && reports)
      return this.action('projectHostedCheckDetail:reports', {
        runId,
        ...(reports === 'failed' ? { failed: true } : typeof reports === 'object' ? reports : {}),
        ...(cursor === undefined ? {} : { cursor }),
      });
    if (runId)
      return this.query(`projectHostedCheckRead:${summary ? 'summary' : 'status'}`, {
        runId,
        ...(!summary
          ? {
              features: ['ci-status-check', 'check-report-detail'],
              ...(this.waitBoard && this.serverFeatures?.includes('run-board-wait')
                ? { board: { laneId: this.waitBoard.laneId, after: this.waitBoard.after } }
                : {}),
            }
          : {}),
      });
    if (laneId) return this.query('projectHostedLanes:head', { laneId });
    if (!kind)
      return this.query('projectHostedFinishObserve:page', {
        operationId,
        nextVersion: 0,
      });
    const api = {
      save: 'Saves',
      compose: 'Compose',
      sync: 'Sync',
      revert: 'Sync',
      lifecycle: 'Lifecycle',
    }[kind];
    return this.query(`projectHosted${api}:progress`, { operationId });
  }
}
export type HostedAgentSession = {
  root: string;
  address: HostedAgentAddress;
  exchange: HostedAgentExchange;
  capabilities: HostedAgentCapabilities;
  journal: HostedAgentJournal;
  /** This agent session's slug when the server takes it (feature agent-slug); absent for a person. */
  agent?: string;
  /** The same slug for landing submissions, when the server records it on receipts (feature
   * landing-agent-run, d730121f); absent for a person or an older server. */
  landingAgent?: string;
  /** The agent client (harness and declared model) for landing receipts, when the server records
   * it (feature landing-agent-client, 81d12a32). */
  landingClient?: string;
  waitSource: (
    operationId: string,
    initial: unknown,
    kind?: 'Sync' | 'Saves' | 'Compose',
    timeoutSeconds?: number,
    observe?: (progress: unknown) => void,
    settle?: SourceWaitSettle,
  ) => Promise<unknown>;
  /** Epoch ms by which an action that waits for its own outcome (save) returns IN_PROGRESS. */
  waitUntil: number;
  query: <T = unknown>(name: string, args: Record<string, unknown>) => Promise<T>;
  mutation: <T = unknown>(name: string, args: Record<string, unknown>) => Promise<T>;
  /** A project action (the project id is added), for calls that run work as well as write. */
  action: <T = unknown>(name: string, args: Record<string, unknown>) => Promise<T>;
  main: () => Promise<z.infer<typeof hostedMainV2Schema>>;
  marker: () => ReturnType<typeof readHostedLaneCheckout>;
  /** Agent-default finish gates (preflight); refusals throw, advisories return. */
  finishGates?: (laneId: string, head: string, tree?: string) => Promise<Record<string, unknown>>;
  /** The `gates` argument for this finish's landing (feature land-gates); undefined when not sent. */
  landGates?: (composeOperationId: string) => string | undefined;
};
