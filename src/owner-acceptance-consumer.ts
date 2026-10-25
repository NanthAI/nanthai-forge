import { rememberSourceAuthorityError } from './source-authority-client.js';
import { hostedPaths } from './hosted-paths.js';
// SPDX-License-Identifier: Apache-2.0
import { queueOwnerRecheck } from './owner-recheck.js';
import { finishChild } from './agent-finish-journal.js';
import { applyOwnerLifecycle } from './owner-lifecycle.js';
import { ownerLifecycleSchema } from './owner-lifecycle-schema.js';
import { publishOwnerMetadata } from './owner-request-publication.js';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { makeFunctionReference } from 'convex/server';
import { ConvexHttpClient } from 'convex/browser';
import { coordinationCredentials } from './coordination-client.js';
import { readHostState, updateHostState } from './host-binding.js';
import { WorkService } from './work.js';
import { nativeChannels } from './native-work.js';
import { channelMoveSchema } from './work-types.js';
import { withQueueSlot } from './landing-queue.js';
import { ForgeError, invariant } from './errors.js';
import { intentHeader } from './work-hosted-index.js';
import { laneSummary, viewSummary, runSummary } from './work-hosted-summary.js';
import type { WorkStore } from './work-store.js';
import type { CoordinationTransport } from './coordination-client.js';
export type OwnerAcceptRequest = {
  authorityEpoch?: number;
  lifecycle?: string;
  recheck?: true;
  operationId: string;
  ownerId: string;
  viewId: string;
  head: string;
  expectedMain: string | null;
  requester: string;
  actorKind: 'person' | 'agent';
  channel: string;
};
/** Pins and local operation receipt reconcile even after the machine loses the hosted reply. */
export function acceptOwnerRequest(store: WorkStore, request: OwnerAcceptRequest) {
  const binding = readHostState(store).binding;
  invariant(
    store.native && binding?.operationId === request.ownerId && binding.acceptanceOwner === true,
    'PROJECT_UNAVAILABLE',
    'Select this bound native owner.',
  );
  return new WorkService(store.root, { kind: request.actorKind, id: request.requester }).dispatch(
    {
      action: 'accept-channel',
      operationId: request.operationId,
      channel: request.channel,
      viewId: request.viewId,
      expectedHead: request.head,
      expectedPrevious: request.expectedMain,
      ...(request.authorityEpoch === undefined ? {} : { authorityEpoch: request.authorityEpoch }),
    },
    store.revision(),
    {
      ownerRequest: true,
      attribution: { kind: request.actorKind, name: request.requester },
    },
  );
}
export async function consumeOwnerRequests(
  store: WorkStore,
  supplied?: Pick<CoordinationTransport, 'mutation'>,
) {
  const binding = readHostState(store).binding;
  if (!store.native || !binding || binding.acceptanceOwner !== true) return { consumed: 0 };
  const queued = await withQueueSlot(
    join(store.directory, 'owner-acceptance-queue'),
    async () => {
      let client = supplied;
      if (!client) {
        const credentials = coordinationCredentials(binding.deployment, process.env.FORGE_AUTH_TOKEN);
        const http = new ConvexHttpClient(credentials.url, {
          skipConvexDeploymentUrlCheck: true,
          logger: false,
          fetch: (input, init) =>
            fetch(input, { ...init, redirect: 'error', signal: AbortSignal.timeout(10_000) }),
        });
        http.setAuth(credentials.token);
        client = http;
      }
      const scope = { projectId: binding.projectId, ownerId: binding.operationId };
      const transport = client;
      const mutate = async (name: string, args: Record<string, unknown>) => {
        try {
          return await transport.mutation(makeFunctionReference<'mutation'>(name), args);
        } catch (error) {
          rememberSourceAuthorityError(store, error, binding.projectId);
          throw error;
        }
      };
      // One request per tick keeps activity sync and the local server responsive.
      const request = (await mutate('ownerAcceptance:poll', {
        ...scope,
        ...(binding.sourceAuthority ? { authorityEpoch: binding.sourceAuthority.epoch } : {}),
        name: hostname(),
        lastSeen: Date.now(),
        mainHead: nativeChannels(store.load()).find(c => c.name === 'main')?.head ?? null,
        command: 'nforge host ROOT --listen',
      })) as OwnerAcceptRequest | null;
      if (!request) return { consumed: 0 };
      invariant(
        request.ownerId === binding.operationId,
        'PROJECT_UNAVAILABLE',
        'Select this bound native owner.',
      );
      let receipt = readHostState(store).acceptanceReceipts?.[request.operationId];
      if (!receipt) {
        let result;
        try {
          if (request.recheck) {
            result = await queueOwnerRecheck(store, request);
          } else if (request.lifecycle) {
            const command = ownerLifecycleSchema.parse(JSON.parse(request.lifecycle));
            const lifecycle = applyOwnerLifecycle(store, command, request.operationId, {
              kind: request.actorKind,
              name: request.requester,
            });
            result = {
              status: 'accepted',
              command: request.lifecycle,
              lifecycle: { ...lifecycle, operationId: request.operationId, targetId: command.id },
            };
          } else {
            const accepted = await acceptOwnerRequest(store, request);
            result = { status: 'accepted', acceptance: channelMoveSchema.parse(accepted.result) };
          }
        } catch (error) {
          // Contention and transport interruption are retryable, not person rejections.
          if (
            store.select('channelMoves', request.operationId)?.status === 'accepted' ||
            (request.recheck && store.select('runs', finishChild(request.operationId, 'recheck-run'))) ||
            (request.lifecycle &&
              (() => {
                const target = ownerLifecycleSchema.parse(JSON.parse(request.lifecycle));
                return store
                  .select(target.collection, target.id)
                  ?.lifecycle?.some(event => event.operation?.id === request.operationId);
              })()) ||
            (error instanceof ForgeError && ['WORK_BUSY', 'WORK_STALE'].includes(error.code))
          )
            throw error;
          result = {
            status: 'rejected',
            code: error instanceof ForgeError ? error.code : 'OWNER_ACCEPT_FAILED',
            reason:
              error instanceof ForgeError
                ? error.message
                : 'Owner acceptance failed; retry on the owner for details.',
          };
        }
        receipt = JSON.stringify(hostedPaths(result));
        updateHostState(store, state => {
          (state.acceptanceReceipts ??= {})[request.operationId] = receipt!;
        });
      }
      const result = JSON.parse(receipt);
      if (request.recheck && result.recheck) {
        const data = store.load(),
          view = data.views.find(view => view.id === result.recheck.viewId)!;
        const run = result.recheck.runId ? data.runs.find(run => run.id === result.recheck.runId) : undefined;
        const metadata = JSON.stringify({
          ownerId: binding.operationId,
          revision: data.revision,
          entries: [
            { collection: 'views', key: view.id, parent: view.intentId, value: viewSummary(view) },
            ...(run ? [{ collection: 'runs', key: run.id, parent: view.id, value: runSummary(run) }] : []),
          ],
        });
        await publishOwnerMetadata(
          store,
          binding.projectId,
          request.operationId,
          data.revision,
          metadata,
          mutate,
        );
      } else if (result.status === 'accepted' && request.lifecycle) {
        const command = ownerLifecycleSchema.parse(JSON.parse(request.lifecycle));
        const data = store.load();
        const intents = data.intents.filter(
          i => i.id === command.id || data.lanes.some(l => l.id === command.id && l.intentId === i.id),
        );
        const lanes = data.lanes.filter(
          l => l.id === command.id || (command.cascade && l.intentId === command.id),
        );
        const metadata = JSON.stringify({
          ownerId: binding.operationId,
          revision: data.revision,
          entries: [
            ...intents.map(i => ({ collection: 'intents', key: i.id, parent: '', value: intentHeader(i) })),
            ...lanes.map(l => ({
              collection: 'lanes',
              key: l.id,
              parent: l.intentId,
              value: laneSummary(l),
            })),
          ],
        });
        await publishOwnerMetadata(
          store,
          binding.projectId,
          request.operationId,
          data.revision,
          metadata,
          mutate,
        );
      } else if (result.status === 'accepted') {
        const data = store.load(),
          move = channelMoveSchema.parse(result.acceptance);
        const view = data.views.find(v => v.id === move.viewId)!;
        // Project actual current main, including work accepted since this request.
        const current = nativeChannels(data).find(c => c.name === request.channel)!;
        const currentMove = data.channelMoves.find(m => m.id === current.moveId)!;
        const currentMetadata = JSON.stringify({
          ownerId: binding.operationId,
          revision: data.revision,
          entries: [
            ...view.inputs.flatMap(pin => {
              const lane = data.lanes.find(l => l.id === pin.laneId);
              return lane
                ? [{ collection: 'lanes', key: lane.id, parent: lane.intentId, value: laneSummary(lane) }]
                : [];
            }),
            ...data.intents
              .filter(i => i.id === view.intentId)
              .map(intent => ({
                collection: 'intents',
                key: intent.id,
                parent: '',
                value: intentHeader(intent),
              })),
            { collection: 'views', key: view.id, parent: view.intentId, value: viewSummary(view) },
            { collection: 'channelMoves', key: move.id, parent: request.channel, value: move },
            ...(currentMove.id === move.id
              ? []
              : [
                  {
                    collection: 'channelMoves',
                    key: currentMove.id,
                    parent: request.channel,
                    value: currentMove,
                  },
                ]),
            { collection: 'channels', key: request.channel, parent: '', value: current },
          ],
        });
        await publishOwnerMetadata(
          store,
          binding.projectId,
          request.operationId,
          data.revision,
          currentMetadata,
          mutate,
        );
      }
      await mutate('ownerAcceptance:complete', { ...scope, operationId: request.operationId, receipt });
      return { consumed: 1, operationId: request.operationId, status: result.status };
    },
    { waitMs: 15_000, anchor: store.directory },
  );
  return 'value' in queued ? queued.value : queued;
}
/** Hosted work is consumed while the owner server/listener runs; failures remain pending. */
export function startOwnerAcceptanceListener(
  store: WorkStore,
  onError: (error: unknown) => void = () => {},
  poll = () => consumeOwnerRequests(store),
) {
  let pending: Promise<unknown> | undefined;
  let stopped = false;
  const tick = () => {
    if (pending || stopped) return;
    pending = poll()
      .catch(onError)
      .finally(() => {
        pending = undefined;
      });
  };
  const timer = setInterval(tick, 5000);
  // A standalone host --listen keeps its interval referenced; HTTP owns its socket.
  void tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await pending;
  };
}
