// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { protectedPathNotice, type ProtectedPathPolicy } from './public-governance.js';
import type { SaveContract } from './hosted-save-client.js';
import {
  capsuleHistoryQueries,
  hydrateLandingHistory,
  hasJournalHistory,
  queryJournalPage,
} from './landing-capsule-client.js';
import { agentClient, agentAuthorship, modelTipOnce } from './agent-turn-work.js';
import { workIndexRecovery } from './error-teaching.js';
import { clientLandingMessage, suppliedLandingMessage } from './landing-message.js';
import { keptApplyEnvelope } from './hosted-apply-kept.js';
import { laneScratchPath } from './forge-cache-paths.js';
import { cliBuildProvenance, withCliBuildProvenance } from './cli-installation.js';
import type { CliProvenance } from './self-metric-receipts.js';
import { describeIssues, missingObserveId, retryReasonHint } from './argument-errors.js';
import { liveLanes } from './hosted-live-lanes.js';
import { cloneFreshness, mainCheckoutTransport, mainTodayFrom, pullHostedProject } from './hosted-pull.js';
import { readHostedMainSelection } from './hosted-main-marker.js';
import {
  diffHostedSource,
  flowHostedSource,
  peersHostedSource,
  queueHostedSource,
} from './hosted-agent-reads.js';
import { landingsHostedSource } from './hosted-agent-landings.js';
import { laneHistoryHostedSource } from './hosted-agent-lane-history.js';
import { hostedObservationContinuation } from './hosted-agent-finish-result.js';
import {
  precheckPendingConflicts,
  pendingConflictLane,
  requireResolution,
  pendingConflictPaths,
  resolutionContinuation,
  laneChangeBase,
} from './hosted-conflict-precheck.js';
import { clientCacheRoot, rootSibling } from './root-paths.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { withExchangeProgress } from './exchange-progress.js';
import { networkFailure, networkTimeout } from './network-fetch.js';
import { networkContinuation } from './network-continuation.js';
import { reconcileHostedSync, hasHostedSyncHandoff } from './hosted-sync-handoff.js';
import { autoReplaySuperseded } from './hosted-replay-holds.js';
import { AGENT_WAIT_SECONDS, operationWait } from './agent-operation-wait.js';
import { sourceTree } from './source-tree.js';
import { withSourceRecovery } from './hosted-agent-source-recovery.js';
import { readHostedOverlapAdvice } from './hosted-overlap-client.js';
import { rememberStackOffer } from './hosted-coordination-client.js';
import { presenceDelivery, presenceSince, type PresenceDelivery } from './hosted-presence-client.js';
import { boardEnvelope, boardHostedSource, hostedBoardSchemas, boardReadPosition } from './hosted-board.js';
import { rememberBoardReader } from './board-local.js';
import { rememberBoardServerFeatures } from './board-local.js';
import { restackAfterSave, type StackHint } from './hosted-stack-restack.js';
import { coordinateField, firstStartTip, memberDataNotice } from './member-data-notice.js';
import type { BoardWaitOption } from './hosted-board-wait.js';
import {
  exactConflictNotice,
  type ExactConflictNotice,
  type ExactConflicts,
} from './hosted-conflict-notice.js';
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
import { executeHostedPlanning, markPlanningStarted, resolvePlanningId } from './hosted-agent-planning.js';
import { isPlanningPrefix } from './planning-id.js';
import { planningIssueArguments } from './planning-issue-arguments.js';
import {
  agentMetricsRead,
  executeHostedMetrics,
  METRICS_DEADLINE_MS,
  metricsDeadline,
} from './hosted-agent-metrics.js';
import { laneLiveness, readLaneEntry, recordLane, withLaneCommand } from './lane-registry.js';
import { convexLaneStates, markerIdentity, type LaneHousekeeping } from './lane-prune.js';
import { shareDependencies, installScriptsNotice } from './shared-dependencies.js';
import { announceRegistryHosts } from './install-registry-hosts.js';
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
import { hostedLaneDirty, inspectUnsavedLane } from './hosted-lane-dirty.js';
import { deltaApplyPending, finishPendingCheckoutDelta } from './hosted-checkout-delta-pending.js';
import { agentDefaultLines, type EffectiveAgentDefaults } from './agent-parallel-defaults.js';
import { dirname, basename, resolve } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import {
  withLifecycleMetric,
  metricOperationId,
  metricRequesterActor,
  recordOwnerMutation,
  setMetricCliBuild,
} from './self-metrics-journal.js';
import { SourceAuthorityStaleError } from './hosted-source-authority.js';
import { CUTOVER_CLI_VERSION } from './cutover-version.js';
import { rememberSourceAuthorityError } from './source-authority-client.js';
import { nativeOwner } from './native-source.js';
import { makeFunctionReference } from 'convex/server';
import { z } from 'zod';
import { ConvexExchange } from './exchange-client.js';
import { hostedActionError, hostedFailureCauseOf } from './hosted-action-error.js';
import { limitRefusal, refusedWait, retryableExchangeError } from './exchange-retry.js';
import { ForgeError, invariant } from './errors.js';
import { hostedMainV2Schema } from './hosted-main.js';
import { hostedRootLanePath, laneSiblingPath, openHostedRootLane } from './hosted-root-checkout.js';
import { START_COMPLETION_SECONDS, boundedStep, startContinuation } from './hosted-start-continuation.js';
import { gcNestedLanesHourly } from './client-cache-gc.js';
import { hostedStartResultSchema, replacedOpenLanes } from './hosted-lane.js';
import { readHostedLaneCheckout } from './hosted-lane-checkout-marker.js';
import {
  HostedAgentJournal,
  finishCommandLaneIds,
  hostedAgentRoot,
  retainedFinishMessage,
} from './hosted-agent-journal.js';
import { shellQuote } from './shell-quote.js';
import { landPhase } from './hosted-land-summary.js';
import { agentSlug, sessionAgentSlug, sessionAgentIdentity } from './agent-slug-session.js';
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
import {
  executeHostedAgent,
  holderOpenFailure,
  hostedCheckSettings,
  openLaneHolder,
} from './hosted-agent-actions.js';
import { executeHostedApproval, openApprovalsReply, type ApprovalCommand } from './hosted-agent-approval.js';
import {
  savedChangedPaths,
  checkoutProtectedPathNotice,
  mainFilteredNotice,
  type SavedChangedPaths,
} from './hosted-changed-paths.js';
import { reviewPaths } from './source-review-format.js';
import { publishClientSourcePack } from './source-pack-client.js';
import {
  agentHooksFeature,
  landingCancelReason,
  laneUndo,
  missingRequiredFeatures,
  syncResolutionReuse,
} from './hosted-contract-features.js';
import type { LandingHold } from './hosted-landing-hold.js';
import {
  bareStatus,
  capabilityOptions,
  requestFeedCapability,
  takeEarlyCapabilities,
} from './hosted-capabilities-early.js';
import { HostedCheckoutDownloads } from './hosted-checkout-downloads.js';
import { backgroundSave } from './hosted-save-pending.js';
import { finishRefusedKey, selectHostedFinish, unsavedFiles } from './hosted-agent-finish-identity.js';
import {
  acknowledgeBackgroundSaveFailure,
  backgroundSaveOperation,
  reconcileHostedSave,
  saveContract,
  settleBackgroundSave,
} from './hosted-save-client.js';
import { markLandStep, type LandTiming } from './land-timing.js';
import { stampWallMs, withDependencyTiming } from './sync-timing.js';
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
import {
  checkoutRequired,
  followResolutionLane,
  openLaneRoot,
  resolutionFollow,
} from './hosted-lane-location.js';
import { localObjects } from './machine-object-store.js';
import { digest } from './state/hash.js';
import { parseNativeState } from './state/format.js';
import { readSource } from './files.js';
import {
  changedStatePaths,
  scanSecretPaths,
  SECRET_SCAN_ALLOW_FILE,
  SECRET_SCAN_MAX_FILE_BYTES,
} from './secret-scan.js';

/** The weakened-test check's local reads (Issue 11901a0c), passed in so its lazy chunk stays small. */
const weakenedReads = {
  objects: localObjects,
  digest,
  files: (state: Buffer) => parseNativeState(state).files,
};
/** Reads and checkout creation: they neither show a Lane as working nor count as its activity. */
/** A boolean option as given, else unset. */
const flag = (value: unknown) => (typeof value === 'boolean' ? value : undefined);
/** Actions that capture the working files themselves (a save) or snapshot them as part of their
 * own move (`snapshots`) take no snapshot first. */
/** Commands whose capability read carries the learned guard-set revision (13ea93bf). */
/** How long preflight waits for this checkout's just-returned save to settle before it says IN PROGRESS. */
const PREFLIGHT_SETTLE_MS = 30_000;
const guardAsking = new Set(['open', 'preflight', 'land']);
/** Actions whose first main read follows capability discovery at once (capabilities-main). */
const mainFirstActions = new Set(['start', 'sync', 'compose']);
const snapshotSkips = new Set(['save', 'checkpoint', 'finish', 'compose', 'snapshots', 'undo']);
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
  'flow',
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
const memberBudgetMutations = new Set([
  'projectHostedChecks:enqueue',
  'projectHostedCompose:prepare',
  'projectHostedLandingDesired:submit',
  'projectHostedLanding:enqueue',
]);
const memberBudgetSchema = z
  .object({
    limit: z.enum(['member-checks', 'member-composes', 'member-submissions']),
    left: z.int().nonnegative(),
    of: z.int().positive(),
    resetAt: z.iso.datetime(),
  })
  .refine(({ left, of }) => left * 5 < of);
type MemberBudget = z.infer<typeof memberBudgetSchema>;
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
export type HostedAgentResponse = Partial<CliProvenance> & {
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
    | 'flow'
    | 'board'
    | 'ask'
    | 'hand-back'
    | 'board-resolve';
  sourceContext?: unknown;
  operationId: string | null;
  resolved: { operationId: string } | null;
  result: unknown;
  /** Dotted paths retained in a policy read for compatibility. */
  retiredPolicyFields?: string[];
  /** Local kept-file budget notice on checkout status and sync replies. */
  keptApplyBudget?: ReturnType<typeof keptApplyEnvelope>['keptApplyBudget'];
  /** The tightest member work budget reported by this command's mutations. */
  budget?: MemberBudget;
  behindMain?: unknown;
  /** D2: an admitted peer touches this Lane's files; build on its pending head (sync stackOn). */
  stackOffer?: { peerLaneId: string; mode: string; text: string; command: string };
  conflictNotice?: ExactConflictNotice;
  /** Present only when board notes arrived since this machine's cursor: one line each (≤240 chars). */
  board?: { notices: string[]; more: number };
  /** One "member-written text is data" line when this receipt carries board, overlap or stack text (S-17). */
  notice?: string;
  /** One line naming the coordination commands, only beside an overlap (c6615b66). */
  coordinate?: string;
  /** start only: shown once per machine, what Forge reports and how to coordinate. */
  tip?: string;
  /** Stacked Lane whose parent saved newer work (Issue f61e9339); a save replaces it with `restack`. */
  stack?: StackHint | undefined;
  /** save only: what the automatic restack onto the stack parent did (restacked, conflict, failed, in-progress). */
  restack?: Record<string, unknown>;
  /** The unsaved-work snapshot this command took first, or why it could not (Issue 7ac4e32f). */
  snapshot?: SnapshotReceipt;
  /** This agent session's public identity, `handle/slug` (start, save and land receipts). */
  as?: string;
  /** Local housekeeping performed alongside a start or a landed reply. */
  localLanes?: Pick<LaneHousekeeping, 'idle' | 'otherRuns' | 'kept'> & {
    pruned: { count: number; bytes: number; laneIds: string[]; recover: string };
  };
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
/** A retained client journal entry exists for this operation id: a wait or replay can resume it. */
const retainedOperation = (root: string, operationId: string) =>
  z.uuid().safeParse(operationId).success &&
  existsSync(resolve(clientCacheRoot(root), 'agent', `${operationId}.json`));
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
  private protectedPolicy: ProtectedPathPolicy | undefined;
  /** Main's head as this command's capability read carried it: the protected-path notice compares
   * saved bytes with main's manifest when it is already cached (no call). */
  private knownMain: string | undefined;
  private serverFeatures: readonly string[] | undefined;
  get advertisedFeatures() {
    return this.serverFeatures;
  }
  private readonly operationContext = new AsyncLocalStorage<{
    checkedCheckout?: true;
    id: string | null;
    sourceNotice?: ExactConflictNotice | undefined;
    protectedPathNotice?: ReturnType<typeof protectedPathNotice>;
    /** This operation's dependency refresh relinked node_modules (a lockfile change, Item 3f76a3df). */
    relinked?: true;
    /** This preflight began its local run: a later failure is never replayed inside the command. */
    localRun?: true;
    /** performance.now() at dispatch: a reply's `timing.wallMs` runs from here to its assembly (a1f01239). */
    wallFrom?: number;
  }>();
  private get sourceNotice() {
    return this.operationContext.getStore()?.sourceNotice;
  }
  private set sourceNotice(notice: ExactConflictNotice | undefined) {
    const current = this.operationContext.getStore();
    if (current) current.sourceNotice = notice;
  }
  private get callerOperationId() {
    return this.operationContext.getStore()?.id ?? null;
  }
  private set callerOperationId(id: string | null) {
    const current = this.operationContext.getStore();
    if (current) current.id = id;
  }
  /** This agent session (run slug, Lane holder); undefined reads it from the client environment
   * (agentSessionKey), null declares none. */
  agentSession?: string | null;
  /** This session's agent slug (c29d0780), sent only to a server that advertised agent-slug. */
  agentSlug() {
    return sessionAgentSlug(this.agentSession);
  }
  private sentAgent() {
    return this.serverFeatures?.includes('agent-slug') ? this.agentSlug() : undefined;
  }
  /** The writing agent's slug and declared client/model for planning puts, ticks, start moves and comments. */
  private planningAgent(
    stamp?: ReturnType<typeof agentAuthorship>,
  ): { agent: string; agentClient?: string } | undefined {
    if (stamp?.authorship.kind === 'person') return undefined;
    const agent = stamp?.agentRun ?? this.agentSlug();
    const client = stamp?.agentClient ?? agentClient(process.env, this.agentSession);
    if (!agent && !client) return undefined;
    const slug = agent ?? agentSlug(`declared:${sessionAgentIdentity(this.agentSession).sessionId}`);
    return { agent: slug, ...(client ? { agentClient: client } : {}) };
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
  /** Plain status in a Lane: the operation read replaces the overlap read it does not display. */
  plainStatus = false;
  readonly cli = cliBuildProvenance();
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
    setMetricCliBuild(this.cli);
  }
  async dispatch(
    requestedAction: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<HostedAgentResponse> {
    if (requestedAction !== 'wait' && !(requestedAction === 'status' && input.files === true))
      await acknowledgeBackgroundSaveFailure(this.root, this.exchange);
    try {
      return withCliBuildProvenance(await this.dispatchReceipt(requestedAction, input, signal));
    } catch (error) {
      if (error instanceof ForgeError && error.code === 'SAVE_SETTLE_FAILED')
        await acknowledgeBackgroundSaveFailure(this.root, this.exchange);
      throw error;
    }
  }
  /** Board and Lane list already carry terminal failures. Fetch the original receipt only when
   * this checkout's exact save is among them, so healthy fast reads stay single-call. */
  private async settleVisibleSaveFailure(
    rows: readonly { laneId?: unknown; operationId?: unknown }[] | undefined,
  ) {
    if (!rows?.length) return;
    const pending = backgroundSave(this.root);
    if (pending && rows.some(row => row.laneId === pending.laneId && row.operationId === pending.operationId))
      await settleBackgroundSave(this.root, this.exchange);
  }
  private async dispatchReceipt(
    requestedAction: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<HostedAgentResponse> {
    input = planningIssueArguments(requestedAction, input);
    input = followResolutionLane(
      () => ({ root: hostedAgentRoot(this.root), address: this.address }),
      requestedAction,
      input,
    );
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
    if (requestedAction === 'lanes') {
      const response = await liveLanes(this, input);
      const rows = (
        response.result as { page?: { laneId?: unknown; saveFailure?: { operationId?: unknown } }[] }
      ).page;
      await this.settleVisibleSaveFailure(
        rows?.flatMap(row =>
          row.saveFailure ? [{ laneId: row.laneId, operationId: row.saveFailure.operationId }] : [],
        ),
      );
      return response;
    }
    if (requestedAction === 'abandon' && Object.hasOwn(input, 'intents')) {
      const { operationId, ...parameters } = input;
      const command = hostedAgentCommandSchemas.abandon.safeParse(parameters);
      invariant(
        command.success && typeof operationId === 'string' && z.uuid().safeParse(operationId).success,
        'BAD_ARGUMENT',
        'Use nforge agent ROOT abandon with an operationId, authorityEpoch, reason and the Intent selections from lanes.',
      );
      const { authorityEpoch, intents, reason } = command.data;
      try {
        return {
          schema: 1,
          transport: 'hosted',
          action: 'abandon',
          operationId,
          resolved: null,
          result: await this.mutation('projectLooseEndIntents:setAside', {
            operationId,
            request: JSON.stringify({ authorityEpoch, intents, reason }),
          }),
        };
      } catch (error) {
        if (
          error instanceof Error &&
          /Could not find (?:public )?function|No (?:public )?function found/i.test(error.message)
        )
          throw new ForgeError(
            'HOSTED_ACTION_UNSUPPORTED',
            'This deployment does not offer batch Intent set-aside yet.',
          );
        throw hostedActionError(error, 'Intent set-aside');
      }
    }
    if (requestedAction === 'diff')
      return {
        schema: 1,
        transport: 'hosted',
        action: 'diff',
        operationId: null,
        resolved: null,
        ...(await diffHostedSource(this, input)),
        ...this.unsavedDiffNotice(input),
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
    if (requestedAction === 'flow')
      return {
        schema: 1,
        transport: 'hosted',
        action: 'flow',
        operationId: null,
        resolved: null,
        result: await flowHostedSource(this, input),
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
    if (requestedAction === 'ask' || requestedAction === 'hand-back') {
      // Keep the conversation adapter out of the source-work startup graph.
      const { hostedConversation } = (await import(
        /* @vite-ignore */ new URL('./hosted-conversation.js', import.meta.url).href
      )) as typeof import('./hosted-conversation.js');
      return {
        schema: 1,
        transport: 'hosted',
        action: requestedAction,
        resolved: null,
        ...(await hostedConversation(this, requestedAction, input)),
        notice: memberDataNotice,
      };
    }
    if (Object.hasOwn(hostedBoardSchemas, requestedAction)) {
      const result = await boardHostedSource(this, requestedAction as keyof typeof hostedBoardSchemas, input);
      const { conflictNotice, notice, saveFailures } = result as {
        conflictNotice?: ExactConflictNotice;
        notice?: string;
        saveFailures?: { laneId?: unknown; operationId?: unknown }[];
      };
      await this.settleVisibleSaveFailure(saveFailures);
      return {
        schema: 1,
        transport: 'hosted',
        action: requestedAction as keyof typeof hostedBoardSchemas,
        operationId: null,
        resolved: null,
        result,
        ...(conflictNotice ? { conflictNotice, notice, ...coordinateField(conflictNotice) } : {}),
      };
    }
    if (requestedAction === 'peers') {
      const result = await peersHostedSource(this, input);
      return {
        schema: 1,
        transport: 'hosted',
        action: 'peers',
        operationId: null,
        resolved: null,
        result,
        ...(result.conflictNotice ? { conflictNotice: result.conflictNotice, notice: result.notice } : {}),
      };
    }
    const response = await this.operationContext
      .run({ id: typeof input.operationId === 'string' ? input.operationId : null }, () =>
        this.dispatchScoped(requestedAction, input, signal),
      )
      .catch(error => {
        // Refused by the local checks before the recorded dispatch (message limit, pending conflict).
        this.retainRefusal(requestedAction, input, error, null);
        throw error;
      });
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
    // A replay by operationId that names no message reuses the retained one (friction 54584edf).
    if (
      requestedAction === 'finish' &&
      input.message === undefined &&
      typeof input.operationId === 'string' &&
      z.uuid().safeParse(input.operationId).success
    ) {
      const message = retainedFinishMessage(this.root, input.operationId);
      if (message !== undefined) input = { ...input, message };
    }
    // The landing message limit is local knowledge: refuse before any server call (friction d8d357c2),
    // and before preflight runs a test when it is given the message it will land with (ad80e037).
    if (
      (requestedAction === 'finish' || requestedAction === 'preflight') &&
      typeof input.message === 'string'
    ) {
      // One normalisation for every route (JSON, --message-file, MCP), so a replay sent another way
      // keeps the same operation (friction 081135b9).
      input = { ...input, message: clientLandingMessage(input.message) };
      suppliedLandingMessage(input.message as string);
    }
    // A failed check's reply names its retry reason `next.retryReason`; land takes it as `reason`.
    // Either name lands the same request (ad80e037): one name reaches the journal and the server.
    if (requestedAction === 'finish' && Object.hasOwn(input, 'retryReason')) {
      const { retryReason, ...rest } = input;
      invariant(
        rest.reason === undefined || rest.reason === retryReason,
        'BAD_ARGUMENT',
        'Pass the retry reason once, as "reason" (the reply\'s next.retryReason value).',
      );
      input = { ...rest, reason: retryReason };
    }
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
          if (['finish', 'sync', 'compose'].includes(requestedAction))
            requireResolution(this.root, laneId, requestedAction);
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
          this.reconciledDispatch(requestedAction, input, signal),
        ),
      );
      this.retainCaller(requestedAction, { result: response.result }, response.operationId);
      this.touchLane(requestedAction, input, response);
      if (response.action === 'finish' && landPhase(response) === 'landed') {
        const replay = (response.result as { replayParameters?: Record<string, unknown> }).replayParameters;
        const laneIds = finishCommandLaneIds(input, running);
        if (replay) laneIds.push(...finishCommandLaneIds(replay));
        if (running && laneIds.length) laneIds.push(running);
        const localLanes = await this.sweepLandedLanes(laneIds, signal);
        if (localLanes) response.localLanes = localLanes;
      }
      return response;
    } catch (error) {
      this.retainRefusal(requestedAction, input, error, this.callerOperationId);
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
  /** A save, test read or preflight that failed for a transient cause replays its same retained
   * operation once inside this command, so a save that completed answers with its receipt instead of a
   * failure (Item 3f76a3df). The healthy path makes no extra call; the failure path makes one. */
  private async reconciledDispatch(
    requestedAction: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<HostedAgentResponse> {
    let attemptInput = input;
    for (let attempt = 1; ; attempt++) {
      const context = this.operationContext.getStore();
      if (context) {
        delete context.relinked;
        delete context.localRun;
      }
      try {
        return await this.dispatchCaller(requestedAction, attemptInput, signal);
      } catch (error) {
        // Only a failing command loads the replay rules (the CLI's import weight stays put).
        const { replayInside, replayTiming } = await import('./hosted-failure-reply.js');
        const cause =
          signal?.aborted || context?.localRun
            ? undefined
            : replayInside(requestedAction, error, attempt, context?.relinked === true);
        if (!cause) throw error;
        // The replay names the operation the first attempt retained, so it reads that receipt.
        const retained = this.callerOperationId;
        if (retained && retainedOperation(this.root, retained))
          attemptInput = { ...input, operationId: retained };
        process.stderr.write(
          `${requestedAction}: HOSTED_ACTION_FAILED (cause: ${cause}); replaying the same operation once to read its outcome.\n`,
        );
        await new Promise(resolve => setTimeout(resolve, replayTiming.delayMs));
      }
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
    // A submitted landing stays recorded until a land or wait sees it settle, so a later land finds it by Lane.
    const settled = /"phase":"(landed|terminal-failed)"/.test(text);
    const recorded = action === 'wait' && settled ? readLaneEntry(laneId)?.landing : undefined;
    const ownWaitLanded = Boolean(
      recorded && /"phase":"landed"/.test(text) && text.includes(recorded.operationId),
    );
    const state =
      action === 'reopen'
        ? null
        : action === 'abandon'
          ? ('abandoned' as const)
          : action === 'complete' || (action === 'finish' && /"phase":"landed"/.test(text)) || ownWaitLanded
            ? ('completed' as const)
            : undefined;
    // A save that replaced the live finish on purpose (supersedeFinish) ends that landing too (F2).
    const superseded = ['save', 'checkpoint'].includes(action) && /"supersededFinish"/.test(text);
    const landing =
      superseded || (recorded && text.includes(recorded.operationId))
        ? null
        : action !== 'finish' || !response.operationId
          ? undefined
          : /"phase":"finish"/.test(text) && !settled
            ? { operationId: response.operationId, at: Date.now() }
            : null;
    recordLane({
      laneId,
      ...(state !== undefined ? { state } : {}),
      ...(landing !== undefined ? { landing } : {}),
    });
  }
  /** status {laneId} reads the Lane's landing in flight only where this machine worked on the Lane
   * and either recorded a landing or lost its folder (7da396ed). Any other status keeps its budget. */
  private landingLookupDue(laneId: string) {
    const entry = readLaneEntry(laneId);
    return !!entry && (!!entry.landing || !existsSync(resolve(entry.root, '.forge/hosted-lane.json')));
  }
  /** A land for a Lane whose earlier landing from this machine is still live (7da396ed): a second
   * submission would queue the same Lane twice. No call unless this machine recorded one; then one
   * read of that operation, and a settled one is forgotten. */
  private async refuseLandingInFlight(input: Record<string, unknown>, operationId: unknown) {
    const laneId =
      typeof input.laneId === 'string' ? input.laneId : (markerIdentity(this.root)?.laneId ?? undefined);
    const recorded = laneId ? readLaneEntry(laneId)?.landing : undefined;
    if (!laneId || !recorded || recorded.operationId === operationId) return;
    // This folder's own finish selection already replays or retries an operation it retained.
    if (
      existsSync(
        resolve(clientCacheRoot(hostedAgentRoot(this.root)), 'agent', `${recorded.operationId}.json`),
      )
    )
      return;
    let phase: unknown;
    try {
      const page = (await this.observe({ operationId: recorded.operationId } as never)) as {
        submission?: { phase?: unknown };
      };
      phase = page?.submission?.phase;
    } catch {
      phase = undefined;
    }
    if (typeof phase !== 'string' || !['composing', 'queued', 'checking', 'ready'].includes(phase)) {
      const lastActionAt = readLaneEntry(laneId)?.lastActionAt;
      recordLane({ laneId, landing: null, ...(lastActionAt === undefined ? {} : { lastActionAt }) });
      return;
    }
    const wait = operationWait(hostedAgentRoot(this.root), {
      operationIds: [recorded.operationId],
      until: 'acceptance',
    });
    throw new ForgeError(
      'LANE_FINISH_ACTIVE',
      `Lane ${laneId} already has a landing in flight (operation ${recorded.operationId}, ${phase}); this land would queue it a second time. Wait for it with: ${wait.command}. To replace it on purpose, land --withdraw first, then land again.`,
      undefined,
      { laneId, operationId: recorded.operationId, phase, next: wait.next, command: wait.command },
    );
  }
  private readonly refusalsRetained = new WeakSet<object>();
  /** A refusal's outcome, once per error: one before the operation's journal opened still counts as
   * this land run, with its code (friction 0a9a5207), under its own or a fresh id. */
  private retainRefusal(action: string, input: Record<string, unknown>, error: unknown, id: string | null) {
    if (error && typeof error === 'object') {
      if (this.refusalsRetained.has(error)) return;
      this.refusalsRetained.add(error);
    }
    const own =
      typeof input.operationId === 'string' && z.uuid().safeParse(input.operationId).success
        ? input.operationId
        : undefined;
    this.retainCaller(action, { error }, id ?? own ?? randomUUID());
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
        ...(this.cli ? { cli: this.cli } : {}),
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
        return await executeHostedRecords(
          this,
          action as (typeof hostedAgentRecordActions)[number],
          input,
          prefix => resolvePlanningId(this, prefix),
        );
      const dispatchedAt = Date.now();
      const wallFrom = performance.now();
      const dispatchContext = this.operationContext.getStore();
      if (dispatchContext) dispatchContext.wallFrom = wallFrom;
      const observation = action === 'status' || action === 'observe';
      const { operationId, ...parameters } = input;
      // Client-only start placement: where to open the Lane, or open:false for pins only.
      const placement =
        action === 'start'
          ? {
              path: parameters.path,
              open: parameters.open,
              installScripts: parameters.installScripts,
              carryEdits: parameters.carryEdits,
            }
          : {};
      if (action === 'start') {
        delete parameters.path;
        delete parameters.open;
        delete parameters.installScripts;
        delete parameters.carryEdits;
        invariant(
          (placement.path === undefined || (typeof placement.path === 'string' && placement.path !== '')) &&
            (placement.open === undefined || typeof placement.open === 'boolean') &&
            (placement.installScripts === undefined || typeof placement.installScripts === 'boolean') &&
            (placement.carryEdits === undefined || typeof placement.carryEdits === 'boolean'),
          'BAD_ARGUMENT',
          'start path is a directory, open is true or false, and installScripts and carryEdits are true or false.',
        );
      }
      const command = hostedAgentCommandSchemas[action].safeParse(observation ? input : parameters);
      invariant(
        command.success,
        'BAD_ARGUMENT',
        `Invalid hosted ${requestedAction} parameters. ${command.success ? '' : describeIssues(command.error.issues, observation ? input : parameters)}.${requestedAction === 'finish' ? retryReasonHint(parameters) : ''} Run nforge agent ROOT ${requestedAction} --help.`,
      );
      if (!observation && operationId !== undefined)
        invariant(z.uuid().safeParse(operationId).success, 'BAD_ARGUMENT', 'operationId must be a UUID.');
      if (action === 'tests') {
        const read = command.data as z.infer<typeof hostedAgentCommandSchemas.tests>;
        if (!read.candidateId && read.runId) {
          const runId = read.runId;
          const [reports, plan] = await Promise.all([
            this.action<Record<string, unknown>>('projectHostedCheckDetail:reports', {
              runId,
              ...(read.cursor === undefined ? {} : { cursor: read.cursor }),
            }),
            this.action<{
              selection: { scope: string; browser?: boolean } | null;
              groups?: string[][];
            }>('projectHostedCheckSelection:detail', { runId }),
          ]);
          let browserShards: { shard: number; files: string[] }[] | null = null;
          if (plan.selection?.browser !== undefined) {
            browserShards = [];
            if (plan.selection.browser) {
              const { isBrowserTest } = await import('../scripts/test-browser-names.mjs');
              browserShards = (plan.groups ?? []).flatMap((group, shard) => {
                const files = group.filter(isBrowserTest);
                return files.length ? [{ shard, files }] : [];
              });
            }
          }
          return this.response(action, null, {
            runId,
            scope: plan.selection?.scope ?? null,
            browserShards,
            ...reports,
          });
        }
      }
      // A bare start has nothing to start. Refuse before any journal or call exists (Issue ec7bd1b5).
      if (action === 'start') {
        const asked = command.data as { planningItemId?: string; intentId?: string; outcome?: string };
        invariant(
          asked.planningItemId || asked.intentId || asked.outcome,
          'BAD_ARGUMENT',
          'start needs one of: planningItemId (an Issue id), intentId (join an Intent), or outcome (a new one).',
        );
      }
      // A wide metrics read is refused before capability discovery, so it costs no server call (Issue 686ecdde).
      if (action === 'metrics') agentMetricsRead(command.data as Parameters<typeof agentMetricsRead>[0]);
      // Policy needs no capability discovery: the server authorizes it, so each command is one call.
      if ((hostedAgentPolicyActions as readonly string[]).includes(action)) {
        const {
          operationId: policyOperationId,
          result,
          ...labels
        } = await executeHostedPolicy(
          this,
          action as (typeof hostedAgentPolicyActions)[number],
          command.data as Record<string, unknown>,
          operationId as string | undefined,
        );
        return { ...(await this.response(action, policyOperationId, result)), ...labels };
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
              : 'This deployment has no web address configured; the owner approves on the review page.'
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
      // git status: local, before capability discovery, so it makes no server call (ad80e037).
      // Passing laneId from the project root inspects that Lane's registered local checkout (0ca3c3ca).
      if (action === 'status' && (input as { files?: unknown }).files === true) {
        const selected = hostedAgentCommandSchemas.status.parse(input);
        const resolved =
          selected.laneId && markerIdentity(this.root)?.laneId !== selected.laneId
            ? openLaneRoot({ root: this.root, address: this.address }, selected.laneId)
            : null;
        const files = unsavedFiles(resolved ?? this.root, selected.laneId);
        return this.response(action, null, resolved ? { ...files, root: resolved } : files);
      }
      if (action === 'status' && Object.keys(input).length === 0 && readHostedMainSelection(this.root))
        return this.response(
          action,
          null,
          await cloneFreshness(
            this.root,
            mainCheckoutTransport(this.root, this.address, this.exchange),
            true,
          ),
        );
      const settling = backgroundSaveOperation(this.root);
      let discovery: unknown;
      let guardAsked = false;
      try {
        let options = capabilityOptions(
          this.root,
          bareStatus(action, input),
          action === 'start' && typeof input.intentId === 'string',
          action,
          input,
        );
        // The project's learned preflight guard set (13ea93bf) rides on this read for the commands
        // that preflight a checkout a start may not have reached on this machine; fresh copies skip it.
        const guardRevision = guardAsking.has(action)
          ? (await import('./preflight-guard-cache.js')).guardRevisionToAsk(this.root, this.address.projectId)
          : undefined;
        if (guardRevision !== undefined) options = { ...options, guardRevision };
        if (action === 'capabilities') options = requestFeedCapability(options);
        // Finish uses the discovery slot reserved for main-today on bare status.
        if (action === 'finish')
          options = { ...options, features: [...(options.features as string[]), 'landing-client-hold'] };
        if (action === 'undo')
          options = { ...options, features: [...(options.features as string[]), laneUndo] };
        if (action === 'withdraw' && typeof input.submissionId === 'string')
          options = { ...options, features: [...(options.features as string[]), landingCancelReason] };
        if (action === 'sync')
          options = { ...options, features: [...(options.features as string[]), syncResolutionReuse] };
        // The CLI may have started this exact read alongside its release check: take it once.
        let early = takeEarlyCapabilities(this.address, { clientVersion: CUTOVER_CLI_VERSION, ...options });
        for (;;) {
          try {
            discovery = await (early ??
              this.query('projectHostedAgent:capabilities', {
                clientVersion: CUTOVER_CLI_VERSION,
                ...options,
              }));
            guardAsked = 'guardRevision' in options;
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
              /extra field\s+[`'"]?(features|noticeVersion|resolveVersion|overlapVersion|overlapEvidenceVersion|mirrorVersion|metricReceiptVersion|planningVersion|defaultsVersion|landingMessageVersion|openLanesVersion|presenceVersion|boardVersion|settling|guardRevision)\b/i.exec(
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
        // A transient server or connection failure is not a missing API: it keeps its cause and the
        // command's own replay (Item 3f76a3df: the first wait after a save reported it as unavailable).
        if (
          hostedFailureCauseOf(safe.message) !== 'local-exception' &&
          !(error instanceof Error && /Could not find|No (?:public )?function/i.test(error.message))
        )
          throw safe;
        throw new ForgeError(
          'HOSTED_AGENT_UNAVAILABLE',
          'Hosted agent capability discovery is unavailable at this deployment. A compatible hosted agent API is required; no native owner or local listener fallback was attempted.',
        );
      }
      const capabilities = parseHostedResponse(
        hostedAgentCapabilitiesSchema,
        knownCapabilities(hostedAgentRoot(this.root), discovery),
      );
      if (guardAsked)
        (await import('./preflight-guard-cache.js')).storeGuardCandidates(
          this.root,
          capabilities.guardSet ?? null,
          this.address.projectId,
        );
      this.protectedPolicy = capabilities.protectedPathPolicy;
      this.knownMain = capabilities.main?.head;
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
            commentAgent: () => this.planningAgent(),
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
      const keepLaneId = keep ? markerIdentity(keep)?.laneId : undefined;
      const keepFinished = Boolean(keepLaneId && action !== 'reopen' && readLaneEntry(keepLaneId)?.state);
      if (keep && !keepFinished) {
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
        return await this.clientAction(
          action,
          command.data as Record<string, unknown>,
          capabilities.authority.epoch,
          saveContract(capabilities),
        );
      if (action === 'check-settings')
        return this.response(action, null, await hostedCheckSettings(this.query.bind(this), capabilities));
      if (observation && action === 'status' && (command.data as { whoami?: boolean }).whoami) {
        const identity = { ...sessionAgentIdentity(this.agentSession), person: capabilities.actor };
        const laneId =
          (command.data as { laneId?: string }).laneId ?? readHostedLaneCheckout(this.root)?.selection.laneId;
        const lane = laneId
          ? ((await this.observe({ laneId, whoami: true })) as Record<string, unknown>)
          : null;
        const holder = lane?.holder as { sessionId?: string; mine?: boolean } | undefined;
        return this.response(
          action,
          null,
          {
            identity: { ...identity, device: capabilities.device ?? null },
            lane: lane ? { ...lane, laneId } : null,
            holds: Boolean(holder?.mine && holder.sessionId === identity.sessionId),
            whyNone: !lane
              ? 'Outside a Lane checkout.'
              : !holder
                ? 'No session holder is recorded for this Lane.'
                : holder.mine && holder.sessionId === identity.sessionId
                  ? null
                  : 'Another session holds this Lane.',
          },
          laneId,
        );
      }
      if (observation && action === 'status' && Object.keys(command.data).length === 0) {
        const laneId = readHostedLaneCheckout(this.root)?.selection.laneId;
        const hold =
          laneId && this.plainStatus && capabilities.overlapVersion === 1
            ? await this.statusReview(laneId)
            : undefined;
        return this.response(
          action,
          null,
          {
            needsFix: capabilities.needsFix ?? [],
            ...(laneId
              ? { scratchPath: resolve(this.root, laneScratchPath), disk: await this.laneDisk(this.root) }
              : {}),
            ...(hold ? { landingHold: hold } : {}),
            ...(capabilities.githubMirror !== undefined ? { githubMirror: capabilities.githubMirror } : {}),
            ...(capabilities.mainDay ? { mainToday: await mainTodayFrom(capabilities.mainDay) } : {}),
          },
          capabilities.overlapVersion === 1 && hold === undefined ? laneId : undefined,
        );
      }
      if (observation) {
        const observed = (await this.observe(
          command.data as z.infer<typeof hostedAgentCommandSchemas.status>,
          action === 'observe',
        )) as Record<string, unknown>;
        return this.response(
          action,
          null,
          {
            ...observed,
            ...(capabilities.needsFix ? { needsFix: capabilities.needsFix } : {}),
            ...(capabilities.githubMirror !== undefined ? { githubMirror: capabilities.githubMirror } : {}),
            // Liveness: lastActivityAt above is the server record; this is the command this machine runs now.
            ...(typeof (command.data as { laneId?: string }).laneId === 'string'
              ? await this.localLane((command.data as { laneId: string }).laneId, observed)
              : {}),
          },
          capabilities.overlapVersion === 1 ? (command.data as { laneId?: string }).laneId : undefined,
        );
      }
      const root = hostedAgentRoot(this.root);
      this.gcClientCache(root, [markerIdentity(root)?.laneId, (command.data as { laneId?: unknown }).laneId]);
      if (action === 'start' || action === 'open') hostedRootLanePath(root, this.address);
      const replaying =
        typeof operationId === 'string' &&
        (existsSync(resolve(clientCacheRoot(root), 'agent', `${operationId}.json`)) ||
          // A fresh id that resumed a retained finish (Item 168e4ed8) replays it too.
          (action === 'finish' &&
            existsSync(resolve(clientCacheRoot(root), 'agent', `finish-resumed-${operationId}.json`))));
      if (action === 'finish' && !replaying) await this.refuseLandingInFlight(command.data, operationId);
      const pendingSync =
        action === 'finish' && !replaying ? await reconcileHostedSync(root, this.exchange) : null;
      if (pendingSync)
        return this.response(action, typeof operationId === 'string' ? operationId : null, pendingSync);
      const pendingSave =
        action === 'finish' && !replaying
          ? await reconcileHostedSave(
              root,
              this.exchange,
              capabilities.authority.epoch,
              saveContract(capabilities),
            )
          : null;
      if (pendingSave)
        return this.response(action, typeof operationId === 'string' ? operationId : null, pendingSave);
      const declaredAuthorship =
        this.serverFeatures?.includes('source-authorship-v1') &&
        ['start', 'save', 'finish', 'resolve', 'abandon', 'complete', 'reopen'].includes(action)
          ? agentAuthorship({
              ...((command.data as { model?: string }).model !== undefined
                ? { model: (command.data as { model: string }).model }
                : {}),
              required: action === 'start' && !replaying,
              fallbackSession: sessionAgentIdentity(this.agentSession).sessionId,
              ...(this.agentSession !== undefined ? { session: this.agentSession } : {}),
              ...(this.agentSlug() ? { run: this.agentSlug()! } : {}),
            })
          : undefined;
      // A start without a model records "unknown" and says once per machine how to name it (6b7d5a79).
      const { modelDefaulted, ...stamp } = declaredAuthorship ?? {};
      const authorship = declaredAuthorship ? (stamp as ReturnType<typeof agentAuthorship>) : undefined;
      if (modelDefaulted) {
        const tip = modelTipOnce();
        if (tip) process.stderr.write(`${tip}\n`);
      }
      const previousStart =
        action === 'start' && !operationId ? this.earlierStart(root, capabilities.actor, command.data) : null;
      const undoReplay =
        action === 'undo' && !operationId && capabilities.features?.includes(laneUndo)
          ? await (
              await import('./hosted-agent-undo.js')
            ).undoReplaySelection(root, this.address, capabilities.actor, command.data, laneId =>
              this.query('projectHostedLanes:select', { laneId }),
            )
          : null;
      // An identical auto-addressed request replays only while the state its receipt reports still
      // holds (Issue ca49dc6c): a sync whose pins this checkout moved past, a withdraw whose landing
      // ended, a settled save whose Lane files changed since, an open whose folder is gone. Each
      // is new work instead. Local reads only; every action declares its binding (replayBindings).
      let syncSaveInventory: import('./hosted-save-capture.js').SaveInventory | undefined;
      const supersededReplay =
        !operationId &&
        autoReplaySuperseded(action, {
          root,
          address: this.address,
          actor: capabilities.actor,
          command: command.data,
          rememberSyncInventory: inventory => {
            syncSaveInventory = inventory;
          },
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
              // A start without an operationId is always new work (6b7d5a79), even when the earlier
              // identical start's journal was pruned and only its index remains.
              action === 'start' || previousStart !== null || supersededReplay || undoReplay?.fresh === true,
            );
      metricOperationId(journal.operationId);
      this.callerOperationId = journal.operationId;
      this.onOperation?.(action, journal.operationId);
      // The receipt's existing client/run fields travel outside the request. Pin that envelope
      // too, so a lost reply followed by a model switch cannot change the original declaration.
      const sourceStamp =
        authorship && action === 'finish'
          ? await journal.retain('finish-authorship', () => authorship)
          : authorship;
      // The finish gate's judgement of the checkout's saved head, sent again with the landing.
      let gatedLane: LandGateEntry | undefined;
      let budget: MemberBudget | undefined;
      let budgetExpiresAt = 0;
      let carriedMain = mainFirstActions.has(action) ? capabilities.main : undefined;
      const fallbackLandingClient =
        !sourceStamp && this.serverFeatures?.includes('landing-agent-client') && this.agentSlug()
          ? agentClient(process.env, this.agentSession)
          : undefined;
      const hooks =
        (action === 'start' || action === 'save') &&
        (sourceStamp?.agentRun ?? this.sentAgent()) &&
        this.serverFeatures?.includes(agentHooksFeature)
          ? await (
              await import('./agent-hook-health.js')
            ).agentHookState(root, this.address.projectId, sessionAgentIdentity(this.agentSession).app)
          : undefined;
      const session: HostedAgentSession = {
        ...(undoReplay?.selection ? { undoSelection: undoReplay.selection } : {}),
        ...(syncSaveInventory ? { syncSaveInventory } : {}),
        checkedCheckout: () => {
          const context = this.operationContext.getStore();
          if (context) context.checkedCheckout = true;
        },
        root,
        address: this.address,
        exchange: this.exchange,
        capabilities,
        journal,
        ...(operationId === undefined ? { autoAddressed: true as const } : {}),
        ...(sourceStamp ? { authorship: sourceStamp } : {}),
        ...(hooks ? { hooks } : {}),
        ...(sourceStamp?.agentRun
          ? { agent: sourceStamp.agentRun }
          : this.sentAgent()
            ? { agent: this.sentAgent()! }
            : {}),
        ...(this.serverFeatures?.includes('lane-holder-v1')
          ? {
              holderSessionId: sessionAgentIdentity(this.agentSession).sessionId,
              sessionClaim: {
                ...(sessionAgentIdentity(this.agentSession).app
                  ? { app: sessionAgentIdentity(this.agentSession).app! }
                  : {}),
                ...(sessionAgentIdentity(this.agentSession).derivation
                  ? { identityFrom: sessionAgentIdentity(this.agentSession).derivation! }
                  : {}),
              },
            }
          : {}),
        ...(sourceStamp?.agentRun
          ? { landingAgent: sourceStamp.agentRun }
          : !sourceStamp && this.serverFeatures?.includes('landing-agent-run') && this.agentSlug()
            ? { landingAgent: this.agentSlug()! }
            : {}),
        ...(sourceStamp?.agentClient
          ? { landingClient: sourceStamp.agentClient }
          : fallbackLandingClient
            ? { landingClient: fallbackLandingClient }
            : {}),
        ...(this.serverFeatures?.includes('landing-tokens') ? { landingTokens: true as const } : {}),
        query: this.query.bind(this),
        mutation: async <T>(name: string, args: Record<string, unknown>) => {
          const memberWork = memberBudgetMutations.has(name);
          const includeBudget = memberWork && capabilities.features?.includes('member-work-budget');
          const reply = await this.mutation<T>(name, includeBudget ? { ...args, memberBudget: true } : args);
          if (!memberWork || !reply || typeof reply !== 'object' || !('budget' in reply)) return reply;
          const { budget: reported, ...payload } = reply as T & { budget: unknown };
          const parsed = memberBudgetSchema.safeParse(reported);
          if (parsed.success) {
            const now = Date.now();
            const expiresAt = Date.parse(parsed.data.resetAt);
            if (
              expiresAt > now &&
              (!budget ||
                budgetExpiresAt <= now ||
                parsed.data.left / parsed.data.of <= budget.left / budget.of)
            ) {
              budget = parsed.data;
              budgetExpiresAt = expiresAt;
            }
          }
          // The legacy payload still goes through its original strict parser or journal.
          return payload as T;
        },
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
        waitSource: async (operationId, initial, kind, timeoutSeconds, observe, settle) => {
          const result = await waitHostedAgentSource(
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
          );
          this.sourceNotice = (result as { conflictNotice?: ExactConflictNotice } | null)?.conflictNotice;
          return result;
        },
        waitUntil: this.waitUntil ?? dispatchedAt + AGENT_WAIT_SECONDS * 1000,
        landWhenRoom: this.serverFeatures?.includes('land-when-room') ?? false,
        ...(signal ? { signal } : {}),
        pathNotice: this.protectedPaths.bind(this),
        saveNotice: async capture => {
          if (!this.protectedPolicy) return;
          const files = new Map(capture.marker.state.files.map(file => [file.path, file]));
          for (const change of capture.changes) {
            if (change.after)
              files.set(change.path, { path: change.path, blob: change.after.blob, mode: change.after.mode });
            else files.delete(change.path);
          }
          await this.protectedNotice({
            ...capture.marker,
            state: { ...capture.marker.state, files: [...files.values()] },
          });
        },
        finishGates: async (
          laneId: string,
          head: string,
          tree?: string,
          message?: string,
          early?: Parameters<NonNullable<HostedAgentSession['finishGates']>>[4],
        ) => {
          await this.protectedNotice(readHostedLaneCheckout(root));
          const read = await this.overlapAdvice(laneId, capabilities.agentDefaults?.preflight !== 'off');
          const selected = readHostedLaneCheckout(root)?.selection;
          const changeBase = selected ? laneChangeBase(root, selected) : undefined;
          const advice =
            capabilities.agentDefaults?.preflight !== 'off' && selected?.laneId === laneId
              ? {
                  ...read,
                  changedPaths: await savedChangedPaths(
                    this,
                    { base: changeBase!, head },
                    read.changedPaths,
                    changeBase !== selected.base.head,
                  ),
                }
              : read;
          if (advice.changedPaths?.complete) this.protectedPaths(advice.changedPaths.paths);
          // The paths this landing carries, so its check failure can teach the next preflight.
          if (advice.changedPaths?.complete) rememberLandingPaths(root, laneId, advice.changedPaths.paths);
          const checkout = readHostedLaneCheckout(root);
          const hostedChecks =
            capabilities.agentDefaults?.preflight !== 'off' &&
            checkout?.selection.laneId === laneId &&
            checkout.selection.head === head
              ? await this.preflightHostedChecks(
                  root,
                  checkout,
                  changeBase ?? checkout.selection.base.head,
                  advice.changedPaths,
                )
              : undefined;
          // Cheap refusals first, together, before any heavy-slot wait or test (Item 168e4ed8): the
          // proof preview above is local, and the dirty scan is the one the preflight run repeats.
          const thisCheckout = selected?.laneId === laneId && selected.head === head;
          await early?.({
            queueProof: hostedChecks?.queueProof,
            dirty: thisCheckout && hostedLaneDirty(root, { refresh: true, selection: { laneId, head } }),
          });
          // The gates read the preflight planner and the test-selection graph; only a finish loads them.
          const { finishGates } = await import('./agent-default-gates.js');
          const gates = finishGates(
            root,
            capabilities.agentDefaults,
            {
              laneId,
              head,
              ...(tree ? { tree } : {}),
              ...(changeBase ? { base: changeBase } : {}),
            },
            advice,
            selected?.laneId === laneId && selected.head === head
              ? () =>
                  invariant(
                    !hostedLaneDirty(root, { refresh: true, selection: { laneId, head } }),
                    'LANE_DIRTY',
                    'Save first: inline preflight records a result for the saved head, and the files here differ from it. Replay land --save to save them.',
                  )
              : false,
            journal.get(finishRefusedKey) === 'PREFLIGHT_BUDGET_EXCEEDED',
          );
          Object.assign(gates, hostedChecks);
          // Weakened-test flags advise (never refuse); a reason line in the message clears them.
          if (checkout?.selection.laneId === laneId && checkout.selection.head === head) {
            const { laneWeakenedTestsReply } = await import('./preflight-weakened-tests.js');
            const weakened = laneWeakenedTestsReply(
              weakenedReads,
              root,
              laneChangeBase(root, checkout.selection),
              checkout.state.files,
              message,
            );
            if (weakened) gates.weakenedTests = weakened;
          }
          // The server requires this preflight result again at enqueue (Issue 029138ef).
          gatedLane = { laneId, head, preflight: preflightResult(gates.preflight) };
          if (this.serverFeatures?.includes('save-preflight-timing')) {
            const { readPreflightReceipt } = await import('./agent-preflight.js');
            const receipt = readPreflightReceipt(root, laneId);
            const saveMs = savedDuration(root, laneId, head);
            if (saveMs !== undefined) gatedLane.saveMs = saveMs;
            // Land's quick head run is reported in its own advisory, not as a preflight's duration.
            if (
              receipt &&
              !receipt.staticOnly &&
              !receipt.quick &&
              (receipt.tree && tree ? receipt.tree === tree : receipt.head === head)
            )
              gatedLane.preflightMs = Math.round(receipt.durationMs);
          }
          if (this.serverFeatures?.includes('preflight-guard-set')) {
            // What this head's preflight ran, so a failed check teaches the project's guard set (13ea93bf).
            // One lazy chunk: a second dynamic import would split shared modules out of the eager graph.
            const { guardGateFields, readPreflightReceipt } = await import('./agent-preflight.js');
            const receipt = readPreflightReceipt(root, laneId);
            const current = Boolean(
              receipt && (receipt.tree && tree ? receipt.tree === tree : receipt.head === head),
            );
            Object.assign(gatedLane, guardGateFields(root, laneId, receipt, current));
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
        // The same holder step as an open in the Lane folder; the checkout never sees its fields.
        const holder = await openLaneHolder(session, journal.operationId, capabilities.authority.epoch, open);
        result =
          'handedOff' in holder
            ? holder.handedOff
            : await openHostedRootLane(
                root,
                this.address,
                this.exchange,
                { ...holder.checkoutCommand, operationId: journal.operationId },
                undefined,
                holder.prepared,
              ).catch(error => {
                throw holderOpenFailure(session, holder.prepared, journal.operationId, error);
              });
      } else {
        if (action === 'finish') markLandStep('ready');
        result = await executeHostedAgent(session, action, command.data);
        // A source operation rewrote files: follow a changed lockfile before the next build.
        // Its time joins the reply's timing, with the command's wall time (friction a1f01239).
        if (['sync', 'resolve', 'revert', 'compose'].includes(action))
          result = withDependencyTiming(
            result,
            await this.refreshDependencies(root),
            wallFrom,
            performance.now(),
          );
        if (action === 'undo') {
          const applied = (result as { applied?: { root: string } }).applied;
          if (applied)
            result = withDependencyTiming(
              result,
              await this.refreshDependencies(applied.root),
              wallFrom,
              performance.now(),
            );
        }
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
                commentAgent: () => this.planningAgent(sourceStamp),
              },
              planningItemId,
              journal.operationId,
              // Builders claim the Item they start (d3357f40): this session's public identity, `handle/agent`.
              this.claimIdentity(),
            )
          : undefined;
        if (action === 'finish') result = await recoverHostedFinish(session, result);
        // Edits made in the shared clone since this Lane started: said once per set (Item e802a0f9).
        if ((action === 'save' || action === 'finish') && result && typeof result === 'object') {
          const laneId = (command.data as { laneId?: string }).laneId ?? markerIdentity(root)?.laneId;
          // Only a Lane started from a shared clone has one to look at; the module loads just then.
          const headsUp =
            laneId && readLaneEntry(laneId)?.cloneRoot
              ? (await import('./clone-local-edits.js')).cloneEditsHeadsUp(laneId, {
                  read: readLaneEntry,
                  record: recordLane,
                })
              : null;
          if (headsUp) result = { ...(result as object), localEditsNotice: headsUp };
        }
        if (action === 'start') {
          // The replay command keeps the client-only choice to run dependency install scripts.
          let startData: unknown =
            typeof placement.installScripts === 'boolean'
              ? { ...(command.data as object), installScripts: placement.installScripts }
              : command.data;
          if (placement.carryEdits === true) startData = { ...(startData as object), carryEdits: true };
          const { laneTitle, ...started } = parseHostedResponse(hostedStartResultSchema, result);
          const explicit = typeof placement.path === 'string' ? resolve(placement.path) : null;
          const local = Boolean(
            started.lane && placement.open !== false && hostedRootLanePath(root, this.address),
          );
          const pinned =
            started.lane && placement.open !== false
              ? journal.retainLocal('start-path', () => {
                  const laneId = started.lane!.laneId;
                  // Replays from older clients already pinned a checkout at the legacy default.
                  const title = journal.get('id:checkout')
                    ? undefined
                    : (journal.get<{ outcome?: string }>('start-planned-intent')?.outcome ??
                      laneTitle ??
                      (command.data as { outcome?: string }).outcome ??
                      'lane');
                  return (
                    explicit ??
                    (local
                      ? hostedRootLanePath(root, this.address, laneId, title)
                      : laneSiblingPath(root, laneId, title))
                  );
                })
              : null;
          const into = pinned && (explicit || local) ? (explicit ?? pinned) : null;
          if (started.lane) {
            // Later identical starts replay this Lane only while it is open (closedStart).
            await journal.retain('started-lane', () => started.lane!.laneId);
            // Report the Lane before its checkout downloads, so a slow or interrupted open never hides it.
            recordLane({
              laneId: started.lane.laneId,
              root: into ?? readLaneEntry(started.lane.laneId)?.root ?? root,
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
            result = (await import('./clone-local-edits.js')).noteCloneEdits(
              root,
              started.lane.laneId,
              result,
              placement.carryEdits === true,
              { record: recordLane, read: readLaneEntry },
              markerIdentity(root)?.laneId,
            );
          } else if (started.lane && placement.open !== false)
            // Pins only because ROOT has no default placement: say how to materialize this same Lane.
            result = {
              ...started,
              continuation: startContinuation(
                this.root,
                startData,
                journal.operationId,
                pinned!,
                'no-placement',
              ),
            };
          // Pins only (open:false, or no placement): the clone's edits are still worth naming.
          if (started.lane && !into)
            result = (await import('./clone-local-edits.js')).noteCloneEdits(
              root,
              started.lane.laneId,
              result,
              false,
              { record: recordLane, read: readLaneEntry },
              markerIdentity(root)?.laneId,
            );
          // An open resolution Lane beside the Lane it resolves: name both and the abandon command (d9e1ac62).
          const replaced = replacedOpenLanes(started.openLanes);
          if (replaced.length) result = { ...(result as object), replaced };
          if (started.lane)
            result = {
              ...(result as object),
              // Where to work is the one rule a new agent must learn at start (6b7d5a79).
              rules:
                'Edit only in this path; save and land from it. More: nforge agent ROOT capabilities or MCP forge_work_overview {command:{action:"capabilities"}}.',
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
          result = {
            ...(result as object),
            previousLane: {
              ...previousStart,
              note: `An identical start on this machine ran before (${previousStart.laneId ? `Lane ${previousStart.laneId}, ${previousStart.state}` : `operation ${(previousStart as { operationId: string }).operationId}`}); this opened a new Lane. If that start was yours and its reply was lost, use its Lane (start --open {laneId}) and abandon this one, or retry with its operationId.`,
            },
          };
        }
      }
      if (action === 'open' && (result as { kind?: string }).kind !== 'handoff-offered') {
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
      // Start housekeeping runs beside the overlap read.
      const started =
        action === 'start' ? (result as { lane?: { laneId?: string } | null; path?: string }) : undefined;
      const housekeeping = started
        ? boundedStep(
            this.housekeeping(
              'start',
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
      if (budget && budgetExpiresAt > Date.now()) response.budget = budget;
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
          : localShapeError(action, error);
      const safe = hostedActionError(error, `agent ${action}`);
      if (safe.code === 'PROJECT_WORK_INDEX_MISSING')
        throw new ForgeError(
          safe.code,
          'The Work index is unavailable. Ask the project owner to run the recovery command, then retry.',
          undefined,
          workIndexRecovery(this.address.url, this.address.projectId),
        );
      // An OCC conflict or 429/503 refusal ran nothing: keep its structured
      // retryable flag and retryAt instead of rebuilding it from code and message (72d50375).
      const refused = safe.code === 'HOSTED_CONFLICT' || safe.recovery?.outcome === 'refused';
      if (refused && safe.recovery?.retryable !== true)
        throw retryableExchangeError(safe, this.callerOperationId) ?? safe;
      const limited = limitRefusal(safe, this.callerOperationId);
      if (limited) throw limited;
      if (safe instanceof SourceAuthorityStaleError || safe.recovery) throw safe;
      // Version skew (either side) needs an upgrade, not a replay.
      if (
        safe.code === 'HOSTED_ACTION_UNSUPPORTED' ||
        safe.code === 'CLI_UPGRADE_REQUIRED' ||
        safe.code === 'HOSTED_SCHEMA_REJECTED'
      )
        throw safe;
      // Every HOSTED_ACTION_FAILED names its cause and one next command (Item 3f76a3df).
      if (safe.code === 'HOSTED_ACTION_FAILED')
        throw (await import('./hosted-failure-reply.js')).hostedFailureReply({
          root: hostedAgentRoot(this.root),
          action,
          safe,
          error,
          operationId: this.callerOperationId,
          retained: Boolean(this.callerOperationId && retainedOperation(this.root, this.callerOperationId)),
          input,
        });
      throw new ForgeError(
        safe.code,
        gateCodes.has(safe.code)
          ? safe.message
          : `${safe.message} Retry the original hosted agent action and parameters to reconcile its retained operation.`,
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
    // The full identity, so a start-time entry housekeeping dropped mid-download comes back prunable (7da396ed F1).
    recordLane({
      laneId,
      root: opened.value.root,
      url: this.address.url,
      projectId: this.address.projectId,
      agent: this.agentSlug() ?? null,
    });
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
   * relinked (or installed once into the shared cache). Silent when nothing changed; never fails the action.
   * Returns its elapsed milliseconds; a queued wait (another process's install of the same lockfile,
   * or a heavy slot for this one) says what it waits on while it waits (friction a1f01239). */
  private async refreshDependencies(path: string): Promise<number> {
    const started = performance.now();
    try {
      const shared = await shareDependencies(path, {
        refresh: true,
        announce: announceRegistryHosts,
        onWait: message => process.stderr.write(`${message}\n`),
      });
      const context = this.operationContext.getStore();
      if ('relinked' in shared && shared.relinked && context) context.relinked = true;
      if ('relinked' in shared && shared.relinked)
        process.stderr.write(
          shared.relinked.restored
            ? 'Restored node_modules after its shared install was pruned.\n'
            : `The lockfile changed: node_modules now links the install for the current one (was ${shared.relinked.from}).\n`,
        );
      else if (shared.status === 'stale' || shared.status === 'failed')
        process.stderr.write(
          `Forge could not relink node_modules: ${'reason' in shared ? shared.reason : shared.message}\n`,
        );
      const notice = installScriptsNotice(shared);
      if (notice && 'relinked' in shared) process.stderr.write(`${notice}\n`);
    } catch {
      /* Dependencies are a convenience the agent can still install itself. */
    }
    return Math.max(0, Math.round(performance.now() - started));
  }
  /** Never fails the action: dependencies are a convenience the agent can still install itself. */
  private async shareDependencies(path: string, runScripts?: boolean) {
    try {
      const shared = await shareDependencies(path, {
        runScripts,
        announce: announceRegistryHosts,
        onWait: message => process.stderr.write(`${message}\n`),
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
  /** A landed observation can clean other finished copies while protecting every input Lane. */
  async sweepLandedLanes(laneIds: string[], signal?: AbortSignal) {
    if (laneIds.length === 0 || signal?.aborted) return;
    const result = await boundedStep(this.housekeeping('landed', [this.root], laneIds, signal), 5_000);
    if (result.status === 'done') return result.value;
  }
  private async housekeeping(
    trigger: 'start' | 'landed',
    roots: string[],
    laneIds: string[],
    signal?: AbortSignal,
  ) {
    try {
      const { automaticLaneHousekeeping } = await import('./lane-prune-automatic.js');
      const budgetMs = trigger === 'start' ? Math.min(12_000, this.startBoundMs) : 5_000;
      const value = await automaticLaneHousekeeping({
        readStates: convexLaneStates(() => ({
          query: (name, args) => {
            const timeout = networkTimeout(Math.min(budgetMs, 2_000));
            return withExchangeProgress(
              { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, networkRetries: 0 },
              () => this.exchange.client.query(name as never, args as never),
            );
          },
        })),
        address: this.address,
        trigger,
        budgetMs,
        exclude: { roots, laneIds },
        run: this.agentSlug() ?? null,
      });
      if (
        !value ||
        (!value.idle.length && !value.otherRuns.length && !value.pruned.length && !value.kept.length)
      )
        return undefined;
      return {
        idle: value.idle,
        otherRuns: value.otherRuns,
        kept: value.kept,
        pruned: {
          count: value.pruned.length,
          bytes: value.pruned.reduce((sum, lane) => sum + lane.bytes, 0),
          laneIds: value.pruned.map(lane => lane.laneId),
          recover: 'Run nforge agent ROOT open with the Lane id to restore its saved checkout.',
        },
      };
    } catch {
      return undefined;
    }
  }
  private async protectedNotice(marker: ReturnType<typeof readHostedLaneCheckout>) {
    if (!marker || !this.protectedPolicy) return;
    const notice = checkoutProtectedPathNotice(this.root, marker, this.protectedPolicy, this.knownMain);
    this.reportProtectedNotice(notice);
  }
  private protectedPaths(paths: string[] | null) {
    if (!this.protectedPolicy) return;
    // The saved files only when a protected path matched: an ordinary save reads nothing more.
    const files = () => {
      try {
        return readHostedLaneCheckout(this.root)?.state.files;
      } catch {
        return undefined;
      }
    };
    const notice = protectedPathNotice(this.protectedPolicy, paths);
    this.reportProtectedNotice(
      notice?.coverage === 'complete' && this.knownMain
        ? mainFilteredNotice(this.root, this.protectedPolicy, paths, files(), this.knownMain)
        : notice,
    );
  }
  private reportProtectedNotice(notice: ReturnType<typeof protectedPathNotice>) {
    const context = this.operationContext.getStore();
    if (context?.protectedPathNotice?.coverage === 'complete' && notice?.coverage === 'unavailable') return;
    if (context && notice && JSON.stringify(notice) !== JSON.stringify(context.protectedPathNotice))
      process.stderr.write(
        `${notice.message} ${notice.paths.join(', ')}${notice.more ? ` (+${notice.more} more)` : ''}\n`,
      );
    if (context) context.protectedPathNotice = notice;
  }
  private async response(
    action: HostedAgentAction,
    operationId: string | null,
    result: unknown,
    overlapLaneId?: string,
  ): Promise<HostedAgentResponse> {
    const advice = overlapLaneId ? await this.overlapAdvice(overlapLaneId) : undefined;
    if (advice?.changedPaths?.complete && ['save', 'finish'].includes(action))
      this.protectedPaths(advice.changedPaths.paths);
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
      advice && overlapLaneId
        ? exactConflictNotice(overlapLaneId, liveConflicts(this.root, action, result, advice.conflicts))
        : this.sourceNotice;
    this.sourceNotice = undefined;
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
    // The wall time covers the overlap and conflict reads above too (review of a1f01239).
    const wallFrom = this.operationContext.getStore()?.wallFrom;
    if (wallFrom !== undefined) result = stampWallMs(result, wallFrom, performance.now());
    if (result && typeof result === 'object')
      result = hostedObservationContinuation(this.root, result as Record<string, unknown>);
    const missing = this.serverFeatures ? missingRequiredFeatures(this.serverFeatures) : [];
    return {
      schema: 1,
      transport: 'hosted',
      action,
      operationId,
      resolved: operationId ? { operationId } : null,
      result:
        this.operationContext.getStore()?.protectedPathNotice && result && typeof result === 'object'
          ? { ...result, protectedPathNotice: this.operationContext.getStore()!.protectedPathNotice }
          : result,
      ...(advice ? { behindMain: advice.behindMain } : {}),
      ...(advice?.stack ? { stack: advice.stack } : {}),
      ...(advice?.superseded ? { superseded: advice.superseded } : {}),
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
      // Forge teaches coordination itself (c6615b66): one line, only beside an overlap, or once on a
      // machine's first start.
      // The delivered presence is notice text; the shared-path reasons are on the raw advice.
      ...coordinateField(conflictNotice, presence ? advice?.presence : undefined),
      ...(action === 'start' && liveStart(result) ? tipField() : {}),
      ...this.nudge(action, result),
      ...(action === 'status' || action === 'sync'
        ? keptApplyEnvelope(this.root, action, action === 'status' && this.plainStatus)
        : {}),
      ...this.identity(action),
      ...(missing.length ? { serverContract: { missing } } : {}),
    };
  }
  /** The public identity a start claims an unowned Item for: `handle/agent`, or the handle for a person. */
  private claimIdentity(): string | undefined {
    if (!this.callerActor) return undefined;
    const slug = this.sentAgent();
    return slug ? `${this.callerActor}/${slug}` : this.callerActor;
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
      this.boardVersion ? boardReadPosition(this.root, laneId, this.serverFeatures ?? []) : undefined,
      this.overlapScope,
    );
    this.cachedAdvice = { laneId, value };
    return value;
  }
  /** unsavedFor and the checkpoint nudge, on Lane calls only; a local stat walk, no timers. */
  /** A diff of this checkout's own Lane compares saved bytes: say so when local edits are unsaved (6b7d5a79).
   * Local file times only, the same scan as the checkpoint nudge; no call. */
  private unsavedDiffNotice(input: Record<string, unknown>): { unsaved?: string } {
    const root = hostedAgentRoot(this.root);
    const laneId = readHostedLaneCheckout(root)?.selection.laneId;
    if (
      !laneId ||
      (input.laneId !== undefined && input.laneId !== laneId) ||
      input.state ||
      input.candidateId
    )
      return {};
    try {
      if (unsavedMinutes(root) === null) return {};
    } catch {
      return {};
    }
    return {
      unsaved: `Unsaved local edits are not in this diff (it compares saved bytes). Save first: nforge agent ${shellQuote(root)} save '{}', or list them: status '{"files":true}'.`,
    };
  }
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
    if (this.operationContext.getStore()?.checkedCheckout) return {};
    // A live landing froze this saved source: saving now would supersede it, so never advise it.
    const frozen = liveLanding(result) || ownsLiveLanding(root);
    return checkpointNudge(root, laneId, this.defaults, unsavedMinutes(root), frozen);
  }
  /** The Lane of an earlier identical `start` that this start must not replay. Within one agent
   * session: its Lane once finished (a follow-up start opens a new Lane), else null while it is open
   * (that replay is the idempotent retry). Without a session id nothing proves the earlier start was
   * this agent's, so any earlier Lane is reported and never replayed (no read). Local registry first;
   * one Lane read only when an earlier same-session start exists, so a first start makes no extra call. */
  /** A start without an operationId is always new work (6b7d5a79): no agent needs to make up an id, and
   * builders sharing one client session never get each other's Lane (b6ba9219, 3676f3e1). An identical
   * earlier start on this machine is named as `previousLane` so a lost reply is never silent. */
  private earlierStart(root: string, actor: string, command: unknown) {
    const previous = HostedAgentJournal.previous(root, this.address, actor, 'start', command);
    if (!previous) return null;
    const laneId = previous.values['started-lane'];
    return typeof laneId === 'string'
      ? { laneId, state: readLaneEntry(laneId)?.state ?? 'unknown' }
      : { laneId: null, operationId: previous.operationId, state: 'unknown' };
  }
  private async clientAction(
    action: 'preflight',
    input: Record<string, unknown>,
    epoch: number,
    features: SaveContract,
  ) {
    const root = hostedAgentRoot(this.root);
    // A save the client returned as pending may have completed on the server while the marker still
    // names the earlier head. Settle that original operation (no new save) before anything pins the
    // marker's head/tree. No pending file means no call.
    // An interrupted local apply leaves the marker describing other bytes; finish it first.
    finishPendingCheckoutDelta(root);
    await this.refreshDependencies(root);
    // A save that has just returned is usually still settling: wait for it (bounded by the clock: backing
    // off from 0.5 s to 4 s, 30 s in all; one progress read per poll, none when no save is pending)
    // instead of exiting 3. Only a save still unsettled after that is reported as IN PROGRESS.
    let pendingSave = await reconcileHostedSave(root, this.exchange, epoch, features);
    for (
      let delay = 500, deadline = Date.now() + PREFLIGHT_SETTLE_MS;
      pendingSave && Date.now() < deadline;
      delay = Math.min(delay * 2, 4000)
    ) {
      await new Promise(resolve => setTimeout(resolve, Math.min(delay, Math.max(0, deadline - Date.now()))));
      pendingSave = await reconcileHostedSave(root, this.exchange, epoch, features);
    }
    if (pendingSave) return this.response(action, null, pendingSave);
    const marker = readHostedLaneCheckout(root);
    const laneId = (input.laneId as string | undefined) ?? marker?.selection.laneId;
    invariant(laneId, 'BAD_ARGUMENT', `Select laneId, or run ${action} inside the Lane directory.`);
    const command = hostedAgentCommandSchemas.preflight.parse(input);
    if (marker?.selection.laneId !== laneId)
      throw checkoutRequired(
        { root: this.root, address: this.address },
        laneId,
        'Run preflight with the Lane folder printed by start as ROOT (not the project folder): it tests the saved files there.',
      );
    await this.protectedNotice(marker);
    const { preflightPlan, readPreflightReceipt, runPreflight, withPreflightSlot } =
      await import('./agent-preflight.js');
    // retry reruns what the last run left: the files it stopped for time, else the test files it
    // failed when it names every one and started every planned file (its passes are reused), so a
    // flake reruns alone (Item 29b2d1ca). Only a receipt of the saved source here: another save's
    // selection could name files this head no longer has and record a pass with no test run.
    const previous = command.retry ? readPreflightReceipt(root, laneId) : null;
    const last =
      previous &&
      (previous.tree && marker.tree ? previous.tree === marker.tree : previous.head === marker.selection.head)
        ? previous
        : null;
    const failedFiles =
      last?.outcome === 'failed' &&
      !last.staticOnly &&
      !last.stoppedForFailure &&
      last.failure?.files.length &&
      (last.failed ?? Infinity) <= last.failure.files.length
        ? last.failure.files
        : undefined;
    const stopped = last?.stopped?.length ? last.stopped : failedFiles;
    invariant(
      !command.retry || stopped?.length,
      'BAD_ARGUMENT',
      `The last preflight of this saved head stopped no file for time and left no failed test files to rerun alone; run preflight without "retry": ${hostedRecoveryCommand(root, 'preflight', { laneId })}.`,
    );
    const advice = await readHostedOverlapAdvice(this, laneId, true);
    // A resolution Lane a sync made is measured from the head the sync merged in (593fc2d7).
    const base = laneChangeBase(root, marker.selection);
    const changed = await savedChangedPaths(
      this,
      { base, head: marker.selection.head },
      advice.changedPaths,
      base !== marker.selection.base.head,
    );
    if (changed?.complete) this.protectedPaths(changed.paths);
    const hostedChecks = await this.preflightHostedChecks(root, marker, base, changed);
    if (hostedChecks?.queueProof)
      process.stderr.write(
        `preflight: ${hostedChecks.queueProof.message} The hosted check judges the composed Candidate.\n`,
      );
    const plan = preflightPlan(
      root,
      changed,
      { laneId, files: marker.state.files, base },
      { budgetSeconds: command.budgetSeconds, trim: command.trim, only: stopped },
    );
    const head = marker.selection.head;
    // Removed or loosened assertions, added skips, changed inputs: flags by file and test, local only.
    const { laneWeakenedTestsReply } = await import('./preflight-weakened-tests.js');
    const weakened = laneWeakenedTestsReply(weakenedReads, root, base, marker.state.files);
    const weakenedTests = weakened ? { weakenedTests: weakened } : {};
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
        ...hostedChecks,
        ...weakenedTests,
        ...(plan.status === 'unavailable' ? landNext : planNext),
      });
    const rerun = `Save, then run the same preflight again: ${hostedRecoveryCommand(root, 'save', {})}, then ${hostedRecoveryCommand(root, 'preflight', { ...command, laneId })}.`;
    const alreadyWaited = inheritedPreflightWait();
    const minutes = unsavedMinutes(root);
    invariant(
      alreadyWaited || minutes === null,
      'LANE_DIRTY',
      `Save first: preflight records a result for the saved head, and these files have unsaved edits. ${rerun}`,
    );
    // File times can miss an edit made while a save was uploading (the marker is rewritten after it).
    // The receipt must name the bytes under test, so confirm them against the saved baseline: a local
    // digest pass that skips files the stat index vouches for (and refreshes its racy entries).
    invariant(
      alreadyWaited || !hostedLaneDirty(root, { refresh: true, selection: { laneId, head } }),
      'LANE_DIRTY',
      `Save first: preflight records a result for the saved head, and the files here differ from it. ${rerun}`,
    );
    const context = this.operationContext.getStore();
    if (context) context.localRun = true;
    return withPreflightSlot(
      root,
      !!(plan.tests.length || plan.static?.selected.length || alreadyWaited),
      slot => {
        let runPlan = plan;
        let workingTree = false;
        if (slot?.waited || alreadyWaited) {
          const current = readHostedLaneCheckout(root);
          const edits = inspectUnsavedLane(root, { refresh: true, limit: Infinity });
          invariant(
            current?.selection.laneId === laneId && (!edits.dirty || edits.kind === 'changes'),
            'WORK_STALE',
            'The Lane checkout was replaced or could not be read while preflight waited. Run preflight again.',
          );
          workingTree = edits.dirty || current.selection.head !== head;
          if (workingTree) {
            const paths = new Set(changed?.paths);
            if (edits.dirty) for (const edit of edits.paths ?? []) paths.add(edit.path);
            if (current.selection.head !== head)
              for (const file of reviewPaths(marker.state.files, current.state.files))
                if (file.status !== 'unchanged') paths.add(file.path);
            process.stderr.write(
              'preflight: the Lane changed while queued. Testing the current working files.\n',
            );
            // Replan from disk, without source caches or a retry pinned to the earlier saved bytes.
            const fresh = preflightPlan(
              root,
              { paths: [...paths], complete: changed?.complete === true },
              undefined,
              {
                budgetSeconds: command.budgetSeconds,
                trim: command.trim,
              },
            );
            if (fresh.status !== 'planned') {
              process.stderr.write(`preflight: NOT COMPLETE; no checks ran. ${fresh.reason}.\n`);
              return this.response(action, null, {
                laneId,
                head,
                workingTree,
                plan: fresh,
                outcome: 'incomplete',
                failed: 0,
                ...landNext,
              });
            }
            runPlan = fresh;
          }
        }
        const receipt = runPreflight(
          root,
          laneId,
          head,
          runPlan,
          workingTree ? undefined : (marker.tree ?? sourceTree(marker.state.files)),
          false,
          // An unsaved run has no pinned base comparison.
          workingTree ? undefined : changed?.complete ? changed.paths : null,
          { heavySlot: slot ?? false, comparisonBase: base, workingTree },
        );
        const outcome = receipt.outcome ?? 'failed';
        return this.response(action, null, {
          laneId,
          head,
          outcome,
          failed: receipt.failed ?? 0,
          plan: runPlan,
          receipt,
          ...(workingTree ? { workingTree: true } : { ...hostedChecks, ...weakenedTests }),
          ...(outcome === 'failed' ? (workingTree ? {} : planNext) : landNext),
        });
      },
    );
  }
  private async preflightHostedChecks(
    root: string,
    marker: NonNullable<ReturnType<typeof readHostedLaneCheckout>>,
    base: string,
    changed: SavedChangedPaths | undefined,
  ) {
    // The manifest fallback can observe newer main than the capability read.
    const main = changed?.mainHead ?? this.knownMain;
    if (!main || (changed?.complete && !changed.paths.length)) return undefined;
    const { reportPreflightChecks } = await import('./preflight-hosted-checks.js');
    // Keep these shared readers on the eager side so the preview does not split them
    // into extra imports on the CLI's ordinary command path.
    return reportPreflightChecks(
      {
        ...weakenedReads,
        readSource,
        changedStatePaths,
        scanSecretPaths,
        allowFile: SECRET_SCAN_ALLOW_FILE,
        maxFileBytes: SECRET_SCAN_MAX_FILE_BYTES,
      },
      root,
      changed?.complete ? changed.paths : undefined,
      marker.state.files,
      base,
      main,
    );
  }
  async query<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    if (name === 'projectHostedCheckRead:status' && !args.features)
      args = { ...args, features: ['ci-status-check', 'check-report-detail'] };
    const priorityRead = [
      'projectHostedLanding:status',
      'projectHostedFinish:status',
      'projectHostedFinishObserve:page',
    ].includes(name);
    const request = {
      ...args,
      projectId: this.address.projectId,
      ...(priorityRead && this.serverFeatures?.includes('checkless-landing') ? { checklessInfo: 1 } : {}),
      ...(capsuleHistoryQueries.has(name) && this.serverFeatures?.includes('landing-capsules-v1')
        ? { capsuleProtocol: 1 }
        : {}),
    };
    const read = async (input: Record<string, unknown>) => {
      try {
        return await queryJournalPage(this.exchange.client, name, input, args =>
          this.exchange.client.query(makeFunctionReference<'query'>(name), args),
        );
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
      this.receiptActor && receiptMutations.has(name)
        ? takeCallerReceipts(
            outbox,
            this.receiptActor,
            this.serverFeatures?.includes('metric-cli-provenance') === true,
          )
        : null;
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
          throw (
            retryableExchangeError(typed, this.callerOperationId) ??
            limitRefusal(typed, this.callerOperationId) ??
            error
          );
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
      throw (
        retryableExchangeError(typed, this.callerOperationId) ??
        limitRefusal(typed, this.callerOperationId) ??
        typed
      );
    }
    return (typeof value === 'string' ? JSON.parse(value) : value) as T;
  }
  /** status {laneId}: this machine's liveness for the Lane and, when a sync conflict moved its folder
   * to a resolution Lane in place, that Lane (9bc3775b). Local files only. */
  private async laneDisk(root: string) {
    const { laneDiskUsage } = (await import(
      /* @vite-ignore */ new URL('./lane-disk-usage.js', import.meta.url).href
    )) as typeof import('./lane-disk-usage.js');
    return laneDiskUsage(root);
  }
  private async localLane(laneId: string, observed: unknown) {
    const successor = resolutionFollow({ root: hostedAgentRoot(this.root), address: this.address }, laneId);
    const inFlight = (observed as { inFlight?: { operationId?: unknown } } | null)?.inFlight;
    let root: string | undefined;
    let rootMarker: ReturnType<typeof markerIdentity> = null;
    for (const path of [readLaneEntry(laneId)?.root, this.root]) {
      const marker = path ? markerIdentity(path) : null;
      if (
        marker?.laneId === laneId &&
        marker.projectId === this.address.projectId &&
        marker.url === this.address.url
      ) {
        root = path;
        rootMarker = marker;
        break;
      }
    }
    const observedHead = (observed as { head?: unknown } | null)?.head;
    const staleCheckoutHead =
      rootMarker?.head && typeof observedHead === 'string' && rootMarker.head !== observedHead
        ? {
            checkoutHead: rootMarker.head,
            savedHead: observedHead,
            note: 'This folder’s marker head differs from the Lane’s hosted saved head; unsaved differences may include older copies of saved work.',
          }
        : undefined;
    return {
      // The landing in flight resumes from this folder by its own id, with or without the Lane folder.
      ...(typeof inFlight?.operationId === 'string'
        ? {
            next: operationWait(hostedAgentRoot(this.root), {
              operationIds: [inFlight.operationId],
              until: 'acceptance',
            }).command,
          }
        : {}),
      local: laneLiveness(laneId),
      ...(root ? { disk: await this.laneDisk(root) } : {}),
      ...(staleCheckoutHead ? { staleCheckoutHead } : {}),
      ...(successor
        ? {
            continuesAs: {
              ...successor,
              note: `A sync conflict moved this Lane's folder to resolution Lane ${successor.laneId}; save, preflight and land there.`,
            },
          }
        : {}),
    };
  }
  private async statusReview(laneId: string): Promise<LandingHold | null | undefined> {
    const entry = readLaneEntry(laneId);
    const operationId = entry?.landing?.operationId;
    if (!operationId || entry.state) return;
    const forgetSettled = () => {
      const current = readLaneEntry(laneId);
      if (current?.landing?.operationId === operationId)
        recordLane({ laneId, landing: null, lastActionAt: current.lastActionAt });
    };
    try {
      const observation = await this.query<Record<string, unknown>>('projectHostedFinishObserve:page', {
        operationId,
        nextVersion: Number.MAX_SAFE_INTEGER,
      });
      const submission = observation.submission as { observation?: { state?: string } } | undefined;
      if (submission?.observation?.state && submission.observation.state !== 'pending') forgetSettled();
      const hold = hostedObservationContinuation(this.root, observation).hold as LandingHold | undefined;
      return hold?.kind === 'review' ? hold : null;
    } catch (error) {
      if (hostedActionError(error, 'landing status').code !== 'NOT_FOUND') throw error;
      forgetSettled();
      return null;
    }
  }
  private async observe(command: z.infer<typeof hostedAgentCommandSchemas.status>, waiting = false) {
    const {
      laneId,
      operationId,
      submissionId,
      runId,
      kind,
      version,
      summary,
      reports,
      selection,
      cursor,
      main,
    } = command;
    if (main !== undefined) {
      invariant(
        [laneId, operationId, submissionId, runId, kind, version, summary, reports, selection, cursor].every(
          value => value === undefined,
        ),
        'BAD_ARGUMENT',
        'main reads one main red alone: pass main:true or main:N (its audit event sequence) without other fields.',
      );
      return this.query('projectMainRed:read', main === true ? {} : { sequence: main });
    }
    invariant(!summary || runId, 'BAD_ARGUMENT', 'summary:true reads one check run: pass runId.');
    invariant(
      !selection || (runId && !reports && !summary && cursor === undefined),
      'BAD_ARGUMENT',
      'Read selection with runId alone.',
    );
    const ids = [laneId, operationId, submissionId, runId].filter(Boolean).length;
    // A bare status is the project status (handled before this); an observe with no id lists landings.
    if (!ids) throw missingObserveId(this.address);
    invariant(
      ids === 1,
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
    if (runId && selection)
      return this.action('projectHostedCheckSelection:detail', {
        runId,
        ...(selection === 'timing-history' ? { timings: true } : {}),
      });
    if (runId)
      return this.query(`projectHostedCheckRead:${summary ? 'summary' : 'status'}`, {
        runId,
        ...(!summary
          ? {
              features: [
                'ci-status-check',
                'check-report-detail',
                ...(waiting && this.serverFeatures?.includes('source-epoch-recovery')
                  ? ['check-authority-epoch']
                  : []),
              ],
              ...(this.waitBoard && this.serverFeatures?.includes('run-board-wait')
                ? { board: { laneId: this.waitBoard.laneId, after: this.waitBoard.after } }
                : {}),
            }
          : this.serverFeatures?.includes('queue-switch-state')
            ? { mainMoveDecision: 1 }
            : {}),
      });
    if (laneId)
      return this.query('projectHostedLanes:head', {
        laneId,
        ...(this.serverFeatures?.includes('lane-status-state') ? { includeState: true } : {}),
        ...(this.serverFeatures?.includes('lane-status-landing') && this.landingLookupDue(laneId)
          ? { includeLanding: true }
          : {}),
        ...(command.whoami && this.serverFeatures?.includes('lane-holder-v1') ? { includeHolder: true } : {}),
      });
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
  undoSelection?: import('./hosted-lane.js').HostedLaneSelection;
  syncSaveInventory?: import('./hosted-save-capture.js').SaveInventory;
  checkedCheckout: () => void;
  authorship?: ReturnType<typeof agentAuthorship>;
  hooks?: import('./hosted-lane.js').AgentHooks;
  root: string;
  address: HostedAgentAddress;
  exchange: HostedAgentExchange;
  capabilities: HostedAgentCapabilities;
  journal: HostedAgentJournal;
  /** The caller named no operationId: the journal chose (or replays) the operation itself. */
  autoAddressed?: true;
  /** This agent session's slug when the server takes it (feature agent-slug); absent for a person. */
  agent?: string;
  /** The same slug for landing submissions, when the server records it on receipts (feature
   * landing-agent-run, d730121f); absent for a person or an older server. */
  landingAgent?: string;
  /** The agent client (harness and declared model) for landing receipts, when the server records
   * it (feature landing-agent-client, 81d12a32). */
  landingClient?: string;
  /** The server records agent-reported tokens at landing (feature landing-tokens, Item a61d3c91). */
  landingTokens?: true;
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
  /** The server takes `land {maxChecks}` (feature land-when-room, ad80e037). */
  landWhenRoom?: boolean;
  /** The command's cancel (SIGINT/SIGTERM, MCP cancel): a land waiting for queue room stops on it. */
  signal?: AbortSignal;
  query: <T = unknown>(name: string, args: Record<string, unknown>) => Promise<T>;
  mutation: <T = unknown>(name: string, args: Record<string, unknown>) => Promise<T>;
  /** A project action (the project id is added), for calls that run work as well as write. */
  action: <T = unknown>(name: string, args: Record<string, unknown>) => Promise<T>;
  main: () => Promise<z.infer<typeof hostedMainV2Schema>>;
  marker: () => ReturnType<typeof readHostedLaneCheckout>;
  /** Agent-default finish gates (preflight); refusals throw, advisories return. */
  pathNotice?: (paths: string[] | null) => void;
  saveNotice?: SaveContract['onCapture'];
  holderSessionId?: string;
  sessionClaim?: import('zod').infer<typeof import('./hosted-lane.js').sessionClaimSchema>;
  finishGates?: (
    laneId: string,
    head: string,
    tree?: string,
    message?: string,
    /** Called once with the local proof preview and dirty scan before any preflight run; throws to refuse. */
    early?: (found: {
      queueProof?: import('./hosted-agent-finish.js').QueueProofPreview | undefined;
      dirty?: boolean;
    }) => Promise<void>,
  ) => Promise<
    Record<string, unknown> & ReturnType<typeof import('./preflight-hosted-checks.js').reportPreflightChecks>
  >;
  /** The `gates` argument for this finish's landing (feature land-gates); undefined when not sent. */
  landGates?: (composeOperationId: string) => string | undefined;
};

/** An enclosing `nforge heavy` may have queued before this command had a chance to read the Lane. */
function inheritedPreflightWait() {
  try {
    const lease = JSON.parse(process.env.FORGE_HEAVY_PARENT || 'null') as {
      waited?: unknown;
      waitedMs?: unknown;
    } | null;
    return (
      lease?.waited === true ||
      (lease?.waited === undefined && typeof lease?.waitedMs === 'number' && lease.waitedMs >= 1000)
    );
  } catch {
    return false;
  }
}

/** Most candidate ids an ambiguous prefix lists; the server read returns one more to say "more". Same
 * value as planningIdMaxCandidates, kept local: this module already sits on every hosted command path.
 * Loaded with the transport the caller builds next, so it adds no chunk (7b2ae8d8). */
const MAX_CANDIDATES = 5;
/** The full id of the one project Lane whose id starts with `prefix`, for a short id this machine has
 * not opened (ad80e037). One indexed read, made only when the local lookup misses. A server without
 * the read returns undefined, so the command refuses the short id as before. */
export async function resolveHostedLaneId(
  transport: Pick<HostedAgentTransport, 'query'>,
  laneId: string,
): Promise<string | undefined> {
  const prefix = laneId.toLowerCase();
  let found: { ids: string[]; more?: boolean };
  try {
    found = await transport.query('projectHostedLaneHistory:resolveLaneId', { prefix });
  } catch (error) {
    if (
      error instanceof Error &&
      /(?:Could not find (?:public )?function|No (?:public )?function found|Function .* not found)/i.test(
        error.message,
      )
    )
      return undefined;
    throw error;
  }
  const { ids, more } = typeof found === 'string' ? JSON.parse(found) : found;
  invariant(
    ids.length > 0,
    'NOT_FOUND',
    `No Lane of this project starts with "${prefix}". nforge agent ROOT lanes '{}' lists your live Lanes with full ids.`,
  );
  if (ids.length > 1 || more)
    throw new ForgeError(
      'AMBIGUOUS_ID',
      `"${prefix}" starts ${more ? `more than ${MAX_CANDIDATES}` : ids.length} Lanes: ${ids.join(', ')}${more ? ', …' : ''}. Pass more characters or the full id.`,
      undefined,
      { candidates: ids },
    );
  return ids[0]!;
}

/** A start that opened or returned a Lane (not a refusal or a replay with no Lane). */
const liveStart = (result: unknown) =>
  Boolean(result && typeof result === 'object' && (result as { lane?: unknown }).lane);
const tipField = (): { tip?: string } => {
  const tip = firstStartTip();
  return tip ? { tip } : {};
};
/** A save settling in the background replies before the server publishes its new head (Item
 * 0487bccb): notices for the head it replaces (the marker's) are not live. A notice the server
 * already decided for the new head stays; an older server names no head, so all such notices go. */
function liveConflicts(root: string, action: string, result: unknown, conflicts: ExactConflicts = []) {
  if (action !== 'save' || (result as { status?: unknown } | null)?.status !== 'settling') return conflicts;
  const replaced = readHostedLaneCheckout(hostedAgentRoot(root))?.selection.head;
  return conflicts.filter(conflict => conflict.head !== undefined && conflict.head !== replaced);
}
