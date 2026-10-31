import { withSourceRecovery } from './hosted-agent-source-recovery.js';
import { readHostedOverlapAdvice, recordHostedOverlapDelivery } from './hosted-overlap-client.js';
import { hostedOverlapNotice, type HostedOverlapNotice } from './hosted-overlap-notice.js';
import { waitHostedAgentSource } from './hosted-agent-source-wait.js';
import { recoverHostedFinish, hostedConflictAdvice } from './hosted-agent-resolution.js';
import type { HostedRunSubscription } from './hosted-agent-observe.js';
import { executeHostedRecords } from './hosted-agent-records.js';
import {
  hostedAgentRecordActions,
  hostedAgentPlanningActions,
  hostedAgentPolicyActions,
} from './hosted-agent-contract.js';
import { executeHostedPolicy } from './hosted-agent-policy.js';
import { executeHostedPlanning, markPlanningStarted } from './hosted-agent-planning.js';
import { executeHostedMetrics } from './hosted-agent-metrics.js';
import { laneLiveness, recordLane, withLaneCommand } from './lane-registry.js';
import { convexLaneStates, laneHousekeeping, markerIdentity } from './lane-prune.js';
import { shareDependencies } from './shared-dependencies.js';
import { readClientSettings } from './client-settings.js';
import {
  knownCapabilities,
  protocolMismatchError,
  unadvertisedActionError,
  unknownActionError,
} from './hosted-agent-version.js';
import { enrichHostedQueueAhead } from './queue-ahead-hosted.js';
import { ackAnswers, checkpointNudge, finishGates, unsavedMinutes } from './agent-default-gates.js';
import { preflightPlan, runPreflight } from './agent-preflight.js';
import { agentDefaultLines, type EffectiveAgentDefaults } from './agent-parallel-defaults.js';
import { dirname, basename, resolve } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import {
  withLifecycleMetric,
  metricOperationId,
  metricRequesterActor,
  recordOwnerMutation,
} from './self-metrics-journal.js';
// SPDX-License-Identifier: Apache-2.0
import { SourceAuthorityStaleError } from './hosted-source-authority.js';
import { CUTOVER_CLI_VERSION } from './cutover-version.js';
import { rememberSourceAuthorityError } from './source-authority-client.js';
import { nativeOwner } from './native-source.js';
import { WorkStore } from './work-store.js';
import { makeFunctionReference } from 'convex/server';
import { z } from 'zod';
import { ConvexExchange } from './exchange-client.js';
import { hostedActionError } from './hosted-action-error.js';
import { ForgeError, invariant } from './errors.js';
import { hostedMainV2Schema } from './hosted-main.js';
import { hostedRootLanePath, openHostedRootLane } from './hosted-root-checkout.js';
import { gcNestedLanesHourly } from './client-cache-gc.js';
import { hostedStartResultSchema } from './hosted-lane.js';
import { readHostedLaneCheckout } from './hosted-lane-checkout-marker.js';
import { HostedAgentJournal, hostedAgentRoot } from './hosted-agent-journal.js';
import {
  hostedAgentAction,
  hostedAgentAddressSchema,
  hostedAgentCapabilitiesSchema,
  hostedAgentOwnerActions,
  hostedAgentClientActions,
  hostedAgentCommandSchemas,
  type HostedAgentAddress,
  type HostedAgentAction,
  type HostedAgentCapabilities,
} from './hosted-agent-contract.js';
import { executeHostedAgent, hostedCheckSettings } from './hosted-agent-actions.js';
import { publishClientSourcePack } from './source-pack-client.js';
import { HostedCheckoutDownloads } from './hosted-checkout-downloads.js';
import { selectHostedFinish } from './hosted-agent-finish-identity.js';
import { reconcileHostedSave } from './hosted-save-client.js';
import {
  callerReceipts,
  clearCallerReceipts,
  metricOutboxDirectory,
  takeCallerReceipts,
  writeCallerReceipts,
} from './hosted-metric-outbox.js';
/** Reads and checkout creation: they neither show a Lane as working nor count as its activity. */
const quietActions = new Set([
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
  'OVERLAP_UNANSWERED',
  'PREFLIGHT_REQUIRED',
  'SAVE_PENDING',
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
>;
export type HostedAgentResponse = {
  schema: 1;
  transport: 'hosted';
  action: HostedAgentAction;
  operationId: string | null;
  resolved: { operationId: string } | null;
  result: unknown;
  unacknowledgedOverlaps?: unknown;
  behindMain?: unknown;
  /** Present only while an overlap is unanswered: who, which files and the acknowledge or route-around command. */
  overlapNotice?: HostedOverlapNotice;
  /** start only: your idle open Lanes and finished Lane roots pruned on this machine. */
  localLanes?: { idle: unknown[]; pruned: { count: number; bytes: number } };
};
/** The shared CLI/MCP transport. Source bytes use the existing verified exchange;
 * every dispatch is finite and every mutation is pinned before network IO. */
export class HostedAgentTransport {
  private priorityReads: boolean | undefined;
  private defaults: EffectiveAgentDefaults | undefined;
  /** Effective project agent defaults from the latest capability read (undefined on older servers). */
  get agentDefaults() {
    return this.defaults;
  }
  private cachedAdvice:
    | { laneId: string; value: Awaited<ReturnType<typeof readHostedOverlapAdvice>> }
    | undefined;
  /** Requester whose deferred receipts this deployment accepts; unset until negotiated. */
  private receiptActor: string | undefined;
  private callerActor: string | null = null;
  private callerOperationId: string | null = null;
  /** CLI only: start reports the new Lane before its checkout downloads. */
  onStarted?: (lane: { laneId: string; path: string | null }) => void;
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
  ) {}
  async dispatch(
    requestedAction: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<HostedAgentResponse> {
    this.callerOperationId = typeof input.operationId === 'string' ? input.operationId : null;
    const running = quietActions.has(requestedAction)
      ? undefined
      : typeof input.laneId === 'string'
        ? input.laneId
        : (markerIdentity(this.root)?.laneId ?? undefined);
    try {
      const response = await withLaneCommand(running, requestedAction, () =>
        this.dispatchCaller(requestedAction, input, signal),
      );
      this.retainCaller(requestedAction, { result: response.result }, response.operationId);
      this.touchLane(requestedAction, input, response);
      return response;
    } catch (error) {
      this.retainCaller(requestedAction, { error }, this.callerOperationId);
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
    if (
      [
        'capabilities',
        'status',
        'observe',
        'landing',
        'check-settings',
        'metrics',
        'policy',
        ...hostedAgentPlanningActions,
      ].includes(requestedAction)
    )
      return this.dispatchRequest(requestedAction, input, signal);
    const metricRoot = resolve(this.root);
    return withLifecycleMetric(
      dirname(metricRoot),
      { ...input, action: requestedAction },
      () => this.dispatchRequest(requestedAction, input, signal),
      `${basename(metricRoot)}.forge-metrics.jsonl`,
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
      const observation = action === 'status' || action === 'observe';
      const { operationId, ...parameters } = input;
      // Client-only start placement: where to open the Lane, or open:false for pins only.
      const placement = action === 'start' ? { path: parameters.path, open: parameters.open } : {};
      if (action === 'start') {
        delete parameters.path;
        delete parameters.open;
        invariant(
          (placement.path === undefined || (typeof placement.path === 'string' && placement.path !== '')) &&
            (placement.open === undefined || typeof placement.open === 'boolean'),
          'BAD_ARGUMENT',
          'start path is a directory and open is true or false.',
        );
      }
      const command = hostedAgentCommandSchemas[action].safeParse(observation ? input : parameters);
      invariant(
        command.success,
        'BAD_ARGUMENT',
        'Invalid hosted agent parameters. Read the hosted agent command help.',
      );
      if (!observation && operationId !== undefined)
        invariant(z.uuid().safeParse(operationId).success, 'BAD_ARGUMENT', 'operationId must be a UUID.');
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
      let discovery: unknown;
      try {
        let options: Record<string, 1> = {
          noticeVersion: 1,
          resolveVersion: 1,
          overlapVersion: 1,
          mirrorVersion: 1,
          metricReceiptVersion: 1,
          planningVersion: 1,
          defaultsVersion: 1,
        };
        for (;;) {
          try {
            discovery = await this.query('projectHostedAgent:capabilities', {
              clientVersion: CUTOVER_CLI_VERSION,
              ...options,
            });
            break;
          } catch (error) {
            if (
              !(error instanceof Error) ||
              !error.message.includes('ArgumentValidationError') ||
              !Object.keys(options).length
            )
              throw error;
            const field =
              /extra field\s+[`'"]?(noticeVersion|resolveVersion|overlapVersion|mirrorVersion|metricReceiptVersion|planningVersion|defaultsVersion)\b/i.exec(
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
      const capabilities = hostedAgentCapabilitiesSchema.parse(
        knownCapabilities(hostedAgentRoot(this.root), discovery),
      );
      this.callerActor = capabilities.actor;
      this.receiptActor = capabilities.metricReceiptVersion === 1 ? capabilities.actor : undefined;
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
          [...hostedAgentOwnerActions, ...hostedAgentClientActions].includes(action as never)
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
      if (action === 'source-pack') {
        hostedAgentCommandSchemas['source-pack'].parse(command.data);
        const main = await this.query<{ head: string }>('projectHostedChannels:current', {});
        return this.response(
          action,
          null,
          await publishClientSourcePack({
            client: this.exchange.client as never,
            projectId: this.address.projectId,
            head: main.head,
            cacheRoot: `${hostedAgentRoot(this.root)}.forge-client`,
            transport: new HostedCheckoutDownloads(this.exchange),
          }),
        );
      }
      if (action === 'ack' || action === 'preflight')
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
              ? { local: laneLiveness((command.data as { laneId: string }).laneId) }
              : {}),
          },
          capabilities.overlapVersion === 1 ? (command.data as { laneId?: string }).laneId : undefined,
        );
      const root = hostedAgentRoot(this.root);
      this.gcClientCache(root, [markerIdentity(root)?.laneId, (command.data as { laneId?: unknown }).laneId]);
      if (action === 'start' || action === 'open') hostedRootLanePath(root, this.address);
      const replaying =
        typeof operationId === 'string' &&
        existsSync(resolve(`${root}.forge-client`, 'agent', `${operationId}.json`));
      const pendingSave =
        action === 'finish' && !replaying ? await reconcileHostedSave(root, this.exchange) : null;
      if (pendingSave)
        return this.response(action, typeof operationId === 'string' ? operationId : null, pendingSave);
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
                  : this.query('projectHostedFinishObserve:page', { operationId, nextVersion: 0 }),
            )
          : new HostedAgentJournal(
              root,
              this.address,
              capabilities.actor,
              action,
              command.data,
              operationId as string | undefined,
            );
      metricOperationId(journal.operationId);
      this.callerOperationId = journal.operationId;
      const session: HostedAgentSession = {
        root,
        address: this.address,
        exchange: this.exchange,
        capabilities,
        journal,
        query: this.query.bind(this),
        mutation: this.mutation.bind(this),
        main: async () => {
          const main = hostedMainV2Schema.parse(await this.query('projectHostedChannels:current', {}));
          invariant(
            main.projectId === this.address.projectId,
            'PROJECT_UNAVAILABLE',
            'Main belongs to another project.',
          );
          return main;
        },
        waitSource: (operationId, initial, kind) =>
          waitHostedAgentSource(this.address, operationId, initial, signal, this.subscribeSource, kind),
        finishGates: async (laneId: string, head: string) =>
          finishGates(
            root,
            capabilities.agentDefaults,
            { laneId, head },
            await this.overlapAdvice(laneId, capabilities.agentDefaults?.preflight !== 'off'),
          ),
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
        result = await executeHostedAgent(session, action, command.data);
        const planningItemId =
          action === 'start' && (command.data as { planningItemId?: string }).planningItemId;
        const planning = planningItemId
          ? await markPlanningStarted(
              { root, address: this.address, exchange: this.exchange, query: this.query.bind(this) },
              planningItemId,
              journal.operationId,
            )
          : undefined;
        if (action === 'finish') result = await recoverHostedFinish(session, result);
        if (action === 'start') {
          const started = hostedStartResultSchema.parse(result);
          const into =
            placement.open === false || !started.lane
              ? null
              : typeof placement.path === 'string'
                ? resolve(placement.path)
                : hostedRootLanePath(root, this.address)
                  ? hostedRootLanePath(root, this.address, started.lane.laneId)
                  : null;
          if (started.lane) {
            // Report the Lane before its checkout downloads, so a slow or interrupted open never hides it.
            recordLane({
              laneId: started.lane.laneId,
              root: into ?? root,
              url: this.address.url,
              projectId: this.address.projectId,
              ...(command.data && typeof (command.data as { outcome?: unknown }).outcome === 'string'
                ? { outcome: (command.data as { outcome: string }).outcome }
                : {}),
            });
            this.onStarted?.({ laneId: started.lane.laneId, path: into });
          }
          if (into) {
            invariant(started.lane, 'SOURCE_UNAVAILABLE', 'Hosted start has no Lane source.');
            // A checkout ROOT keeps its warm object cache for the new Lane, wherever it opens.
            const opened = await openHostedRootLane(
              hostedRootLanePath(root, this.address) ? root : into,
              this.address,
              this.exchange,
              { laneId: started.lane.laneId, operationId: await journal.id('checkout') },
              into,
            );
            recordLane({ laneId: started.lane.laneId, root: opened.root });
            result = {
              ...started,
              path: opened.root,
              checkout: opened,
              dependencies: await this.shareDependencies(opened.root),
            };
          }
        }
        if (planning) result = { ...(result as object), planning };
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
        result = { ...(result as object), dependencies: await this.shareDependencies(path) };
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
      const response = await this.response(
        action,
        journal.operationId,
        await withSourceRecovery(session, action, command.data, result),
        overlapLane,
      );
      if (action === 'start') {
        const started = result as { lane?: { laneId?: string } | null; path?: string };
        const localLanes = await this.housekeeping(
          [root, ...(started.path ? [started.path] : [])],
          [...(started.lane?.laneId ? [started.lane.laneId] : [])],
        );
        if (localLanes) response.localLanes = localLanes;
      }
      return response;
    } catch (error) {
      const owner = nativeOwner(existsSync(this.root) ? realpathSync(this.root) : this.root);
      if (owner) rememberSourceAuthorityError(new WorkStore(owner), error, this.address.projectId);
      if (error instanceof z.ZodError) throw protocolMismatchError();
      const safe = hostedActionError(error, `agent ${action}`);
      if (safe instanceof SourceAuthorityStaleError) throw safe;
      // Version skew needs an upgrade, not a replay.
      if (safe.code === 'HOSTED_ACTION_UNSUPPORTED' || safe.code === 'CLI_UPGRADE_REQUIRED') throw safe;
      throw new ForgeError(
        safe.code,
        gateCodes.has(safe.code)
          ? safe.message
          : `${safe.code === 'HOSTED_ACTION_FAILED' ? `Hosted agent ${action} failed.` : safe.message} Retry the original hosted agent action and parameters to reconcile its retained operation.`,
      );
    }
  }
  /** Never fails the action: dependencies are a convenience the agent can still install itself. */
  private async shareDependencies(path: string) {
    try {
      return await shareDependencies(path);
    } catch (error) {
      return { status: 'failed', message: error instanceof Error ? error.message : String(error) };
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
      });
      if (!value.idle.length && !value.pruned.length) return undefined;
      return {
        idle: value.idle,
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
    const notice =
      advice && overlapLaneId ? hostedOverlapNotice(this.root, overlapLaneId, advice) : undefined;
    // Delivered means returned on a Lane-changing action; a bare status read is not a delivery.
    if (advice && notice && overlapLaneId && ['start', 'save', 'sync', 'compose', 'finish'].includes(action))
      await recordHostedOverlapDelivery(this, overlapLaneId, action, advice);
    return {
      schema: 1,
      transport: 'hosted',
      action,
      operationId,
      resolved: operationId ? { operationId } : null,
      result: await hostedConflictAdvice(this, await enrichHostedQueueAhead(this, result)),
      ...(advice ? (({ changedPaths: _paths, ...shown }) => shown)(advice) : {}),
      ...(notice ? { overlapNotice: notice } : {}),
      ...this.nudge(action),
    };
  }
  /** One overlap read per dispatch: a finish gate and its receipt share it. */
  private async overlapAdvice(laneId: string, paths = false) {
    if (this.cachedAdvice?.laneId === laneId) return this.cachedAdvice.value;
    const value = await readHostedOverlapAdvice(this, laneId, paths);
    this.cachedAdvice = { laneId, value };
    return value;
  }
  /** unsavedFor and the checkpoint nudge, on Lane calls only; a local stat walk, no timers. */
  private nudge(action: HostedAgentAction) {
    if (!this.defaults || ['save', 'capabilities', 'metrics', 'check-settings'].includes(action)) return {};
    const root = hostedAgentRoot(this.root);
    const laneId = readHostedLaneCheckout(root)?.selection.laneId;
    return laneId ? checkpointNudge(root, laneId, this.defaults, unsavedMinutes(root)) : {};
  }
  private async clientAction(action: 'ack' | 'preflight', input: Record<string, unknown>) {
    const root = hostedAgentRoot(this.root);
    const marker = readHostedLaneCheckout(root);
    const laneId = (input.laneId as string | undefined) ?? marker?.selection.laneId;
    invariant(laneId, 'BAD_ARGUMENT', `Select laneId, or run ${action} inside the Lane directory.`);
    if (action === 'ack') {
      const { choice, text } = hostedAgentCommandSchemas.ack.parse(input);
      const answered = [];
      // A bounded loop answers an inbox larger than one read (each round: one read, one write).
      for (let round = 0; round < 20; round++) {
        // 50 notices per read: one read answers the usual inbox instead of one read per five.
        const advice = await readHostedOverlapAdvice(this, laneId, false, 50);
        const answers = ackAnswers(laneId, advice, choice, text);
        if (!answers.length) break;
        const recorded = await executeHostedRecords(this, 'overlap-acks', { answers });
        answered.push(...((recorded.result as { answers?: unknown[] }).answers ?? []));
      }
      return this.response(action, null, {
        status: answered.length ? 'recorded' : 'none',
        answered: answered.length,
        next: answered.length
          ? 'Land again; a newer overlap shows a new notice.'
          : 'No pending overlap notices.',
      });
    }
    const command = hostedAgentCommandSchemas.preflight.parse(input);
    invariant(
      marker?.selection.laneId === laneId,
      'HOSTED_CHECKOUT_REQUIRED',
      'Run preflight in the Lane checkout; it tests the saved files here.',
    );
    const advice = await readHostedOverlapAdvice(this, laneId, true);
    const plan = preflightPlan(root, advice.changedPaths);
    const head = marker.selection.head;
    if (plan.status === 'unavailable' || !command.run)
      return this.response(action, null, { laneId, head, plan });
    const minutes = unsavedMinutes(root);
    invariant(
      minutes === null,
      'LANE_DIRTY',
      'Save first: preflight records a result for the saved head, and these files have unsaved edits.',
    );
    return this.response(action, null, {
      laneId,
      head,
      plan,
      receipt: runPreflight(root, laneId, head, plan),
    });
  }
  async query<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    const priorityRead = [
      'projectHostedLanding:status',
      'projectHostedFinish:status',
      'projectHostedFinishObserve:page',
    ].includes(name);
    const request = { ...args, projectId: this.address.projectId };
    let value: unknown;
    if (priorityRead && this.priorityReads !== false) {
      try {
        value = await this.exchange.client.query(makeFunctionReference<'query'>(name), {
          ...request,
          priorityInfo: 1,
        });
        this.priorityReads = true;
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
        value = await this.exchange.client.query(makeFunctionReference<'query'>(name), request);
      }
    } else value = await this.exchange.client.query(makeFunctionReference<'query'>(name), request);
    return (typeof value === 'string' ? JSON.parse(value) : value) as T;
  }
  async mutation<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
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
        if (hostedActionError(error, name).code !== 'HOSTED_CONFLICT' || retry >= 3) throw error;
        await new Promise(resolve => setTimeout(resolve, 25 * 2 ** retry));
      }
    }
    if (pending) clearCallerReceipts(pending.files);
    const metricRoot = resolve(this.root);
    recordOwnerMutation(dirname(metricRoot), undefined, `${basename(metricRoot)}.forge-metrics.jsonl`);
    return (typeof value === 'string' ? JSON.parse(value) : value) as T;
  }
  private async observe(command: z.infer<typeof hostedAgentCommandSchemas.status>) {
    const { laneId, operationId, submissionId, runId, kind, version } = command;
    invariant(
      [laneId, operationId, submissionId, runId].filter(Boolean).length === 1,
      'BAD_ARGUMENT',
      'Choose exactly one Lane, source operation, submission or run.',
    );
    if (submissionId)
      return this.query('projectHostedFinish:status', {
        submissionId,
        ...(version === undefined ? {} : { version }),
      });
    if (runId) return this.query('projectHostedCheckRead:status', { runId });
    if (laneId) return this.query('projectHostedLanes:head', { laneId });
    if (!kind) return this.query('projectHostedFinishObserve:page', { operationId, nextVersion: 0 });
    const api = { save: 'Saves', compose: 'Compose', sync: 'Sync', revert: 'Sync', lifecycle: 'Lifecycle' }[
      kind
    ];
    return this.query(`projectHosted${api}:progress`, { operationId });
  }
}
export type HostedAgentSession = {
  root: string;
  address: HostedAgentAddress;
  exchange: HostedAgentExchange;
  capabilities: HostedAgentCapabilities;
  journal: HostedAgentJournal;
  waitSource: (
    operationId: string,
    initial: unknown,
    kind?: 'Sync' | 'Saves' | 'Compose',
  ) => Promise<unknown>;
  query: <T = unknown>(name: string, args: Record<string, unknown>) => Promise<T>;
  mutation: <T = unknown>(name: string, args: Record<string, unknown>) => Promise<T>;
  main: () => Promise<z.infer<typeof hostedMainV2Schema>>;
  marker: () => ReturnType<typeof readHostedLaneCheckout>;
  /** Agent-default finish gates (overlap, preflight); refusals throw, advisories return. */
  finishGates?: (laneId: string, head: string) => Promise<Record<string, unknown>>;
};
