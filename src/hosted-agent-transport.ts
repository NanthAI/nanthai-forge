import { withSourceRecovery } from './hosted-agent-source-recovery.js';
import { readHostedOverlapAdvice } from './hosted-overlap-client.js';
import { waitHostedAgentSource } from './hosted-agent-source-wait.js';
import { recoverHostedFinish, hostedConflictAdvice } from './hosted-agent-resolution.js';
import type { HostedRunSubscription } from './hosted-agent-observe.js';
import { executeHostedRecords } from './hosted-agent-records.js';
import { hostedAgentRecordActions } from './hosted-agent-contract.js';
import { executeHostedMetrics } from './hosted-agent-metrics.js';
import { enrichHostedQueueAhead } from './queue-ahead-hosted.js';
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
import { hostedStartResultSchema } from './hosted-lane.js';
import { readHostedLaneCheckout } from './hosted-lane-checkout-marker.js';
import { HostedAgentJournal, hostedAgentRoot } from './hosted-agent-journal.js';
import {
  hostedAgentAction,
  hostedAgentAddressSchema,
  hostedAgentCapabilitiesSchema,
  hostedAgentOwnerActions,
  hostedAgentCommandSchemas,
  type HostedAgentAddress,
  type HostedAgentAction,
  type HostedAgentCapabilities,
} from './hosted-agent-contract.js';
import { executeHostedAgent, hostedCheckSettings } from './hosted-agent-actions.js';
import { selectHostedFinish } from './hosted-agent-finish-identity.js';
import { reconcileHostedSave } from './hosted-save-client.js';
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
};
/** The shared CLI/MCP transport. Source bytes use the existing verified exchange;
 * every dispatch is finite and every mutation is pinned before network IO. */
export class HostedAgentTransport {
  private priorityReads: boolean | undefined;
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
    if (
      ['capabilities', 'status', 'observe', 'landing', 'check-settings', 'metrics'].includes(requestedAction)
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
    const action = hostedAgentAction(requestedAction);
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
      const command = hostedAgentCommandSchemas[action].safeParse(observation ? input : parameters);
      invariant(
        command.success,
        'BAD_ARGUMENT',
        'Invalid hosted agent parameters. Read the hosted agent command help.',
      );
      if (!observation && operationId !== undefined)
        invariant(z.uuid().safeParse(operationId).success, 'BAD_ARGUMENT', 'operationId must be a UUID.');
      let discovery: unknown;
      try {
        let options: Record<string, 1> = {
          noticeVersion: 1,
          resolveVersion: 1,
          overlapVersion: 1,
          mirrorVersion: 1,
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
              /extra field\s+[`'"]?(noticeVersion|resolveVersion|overlapVersion|mirrorVersion)\b/i.exec(
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
      const capabilities = hostedAgentCapabilitiesSchema.parse(discovery);
      metricRequesterActor({ kind: 'agent', name: capabilities.actor });
      invariant(
        capabilities.projectId === this.address.projectId,
        'PROJECT_UNAVAILABLE',
        'Capabilities belong to a different project.',
      );
      invariant(
        capabilities.actions.includes(action as (typeof capabilities.actions)[number]) ||
          (capabilities.authority.mode !== 'native-owner' &&
            (hostedAgentOwnerActions as readonly string[]).includes(action)),
        'HOSTED_ACTION_UNSUPPORTED',
        'The project does not support this hosted action under its current source authority.',
      );
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
      if (action === 'capabilities') return this.response(action, null, capabilities);
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
          },
          capabilities.overlapVersion === 1 ? (command.data as { laneId?: string }).laneId : undefined,
        );
      const root = hostedAgentRoot(this.root);
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
        if (action === 'finish') result = await recoverHostedFinish(session, result);
        if (action === 'start' && hostedRootLanePath(root, this.address)) {
          const started = hostedStartResultSchema.parse(result);
          invariant(started.lane, 'SOURCE_UNAVAILABLE', 'Hosted start has no Lane source.');
          const opened = await openHostedRootLane(root, this.address, this.exchange, {
            laneId: started.lane.laneId,
            operationId: await journal.id('checkout'),
          });
          result = { ...started, path: opened.root, checkout: opened };
        }
      }
      const overlapLane =
        capabilities.overlapVersion === 1 && ['start', 'save'].includes(action)
          ? ((result as { lane?: { laneId?: string } }).lane?.laneId ??
            (command.data as { laneId?: string }).laneId ??
            readHostedLaneCheckout(root)?.selection.laneId)
          : undefined;
      return this.response(
        action,
        journal.operationId,
        await withSourceRecovery(session, action, command.data, result),
        overlapLane,
      );
    } catch (error) {
      const owner = nativeOwner(existsSync(this.root) ? realpathSync(this.root) : this.root);
      if (owner) rememberSourceAuthorityError(new WorkStore(owner), error, this.address.projectId);
      if (error instanceof z.ZodError)
        throw new ForgeError(
          'HOSTED_PROTOCOL_INVALID',
          'Hosted agent response does not match the supported contract.',
        );
      const safe = hostedActionError(error, `agent ${action}`);
      if (safe instanceof SourceAuthorityStaleError) throw safe;
      throw new ForgeError(
        safe.code,
        `${safe.code === 'HOSTED_ACTION_FAILED' ? `Hosted agent ${action} failed.` : safe.message} Retry the original hosted agent action and parameters to reconcile its retained operation.`,
      );
    }
  }
  private async response(
    action: HostedAgentAction,
    operationId: string | null,
    result: unknown,
    overlapLaneId?: string,
  ): Promise<HostedAgentResponse> {
    return {
      schema: 1,
      transport: 'hosted',
      action,
      operationId,
      resolved: operationId ? { operationId } : null,
      result: await hostedConflictAdvice(this, await enrichHostedQueueAhead(this, result)),
      ...(overlapLaneId ? await readHostedOverlapAdvice(this, overlapLaneId) : {}),
    };
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
    const request = { ...args, projectId: this.address.projectId };
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
};
