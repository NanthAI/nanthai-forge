// SPDX-License-Identifier: Apache-2.0
import { hostedPaths, hostedText } from './hosted-paths.js';
import { PRESENCE } from './presence.js';
import { startPresenceWorker } from './presence-worker-start.js';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { makeFunctionReference } from 'convex/server';
import { ConvexHttpClient } from 'convex/browser';
import { coordinationCredentials } from './coordination-client.js';
import { readHostState, updateHostState } from './host-binding.js';
import { localActor } from './work-actor.js';
import { allRecords } from './agent-lifecycle.js';
import { laneSummary, viewSummary } from './work-hosted-summary.js';
import { intentHeader } from './work-hosted-index.js';
import { withQueueSlot } from './landing-queue.js';
import type { WorkStore } from './work-store.js';
import type { Lane } from './work-types.js';
import type { AgentAction } from './agent-workflow-schema.js';
import { ForgeError, invariant } from './errors.js';
import { activitySnapshot } from './agent-activity-snapshot.js';
import { readWorkFile } from './work-records.js';
import { workLockWaitMs } from './work-lock.js';

function sessionId(binding: string, lane: string, actor: string) {
  const bytes = createHash('sha256')
    .update(JSON.stringify([binding, lane, actor]))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const actions = new Set([
  'start',
  'take',
  'run',
  'observe',
  'cancel',
  'checkpoint',
  'sync',
  'finish',
  'accept',
  'complete',
  'abandon',
  'reopen',
  'complete-merged',
]);
/** Prepare source outside the owner lock; validate and queue before network work. */
export function queueAgentSync(
  store: WorkStore,
  command: AgentAction | { action: 'activity'; laneId: string; actor?: string },
  result: unknown,
  waiting = false,
  signal?: string,
) {
  if (!signal && !actions.has(command.action)) return undefined;
  let hostedSyncEnabled = false;
  try {
    const binding = readHostState(store).binding;
    hostedSyncEnabled = !!binding && binding.autoSync !== false;
    const receipt = (result ?? {}) as {
      laneId?: string;
      status?: string;
      view?: { viewId: string };
      acceptance?: { viewId?: string; acceptanceId?: string };
      acceptanceId?: string;
      viewId?: string;
      lanes?: string[];
    };
    const laneId = 'laneId' in command ? command.laneId : receipt?.laneId;
    const acceptance = receipt?.acceptance ?? (command.action === 'accept' ? receipt : undefined);
    const viewId =
      acceptance?.viewId ??
      receipt?.view?.viewId ??
      receipt?.viewId ??
      ('viewId' in command ? command.viewId : undefined);
    const view = viewId ? store.select('views', viewId) : undefined;
    const ids = new Set<string>([...(laneId ? [laneId] : []), ...(view?.inputs.map(i => i.laneId) ?? [])]);
    if ('intentId' in command && command.intentId && !laneId)
      for (const lane of allRecords<Lane>(store, 'lanes'))
        if (lane.intentId === command.intentId) ids.add(lane.id);
    if (command.action === 'complete-merged') for (const id of receipt?.lanes ?? []) ids.add(id);
    if (!ids.size) return undefined;
    const end = Date.now() + (workLockWaitMs() || 1000);
    const pathsByHead = new Map<string, string[]>();
    for (;;) {
      const prepared = activitySnapshot(store, ids, signal, pathsByHead, viewId, acceptance?.acceptanceId);
      try {
        updateHostState(store, state => {
          const pointer = readWorkFile(store.directory);
          invariant(
            prepared.pointer ? !!pointer && prepared.pointer.equals(pointer) : pointer === null,
            'WORK_STALE',
            'Work changed while preparing activity.',
          );
          const binding = state.binding;

          const queue =
            binding && binding.autoSync !== false
              ? (state.agentSync ??= { sequence: 0, pending: [] })
              : undefined;
          const revision = prepared.revision;
          for (const { lane, intent, paths } of prepared.rows) {
            const name =
              ('actor' in command ? command.actor : undefined) ??
              process.env.FORGE_AGENT_NAME ??
              process.env.FORGE_ACTOR ??
              lane.owner?.actor ??
              lane.startedBy?.name ??
              localActor('agent').name;

            const completed =
              ['completed', 'abandoned'].includes(lane.state) ||
              intent.status === 'abandoned' ||
              !!acceptance?.acceptanceId;
            const activityKind =
              signal ??
              (waiting
                ? 'check queued'
                : ['queued', 'preparing', 'running'].includes(receipt.status ?? '')
                  ? receipt.status === 'queued'
                    ? 'check queued'
                    : 'check running'
                  : command.action === 'take'
                    ? 'taken over'
                    : command.action === 'checkpoint'
                      ? 'saved'
                      : command.action === 'sync'
                        ? 'updated from main'
                        : command.action === 'start'
                          ? 'started'
                          : command.action === 'finish'
                            ? acceptance?.acceptanceId
                              ? 'accepted'
                              : 'checked'
                            : command.action === 'accept'
                              ? 'accepted'
                              : command.action === 'complete' || command.action === 'complete-merged'
                                ? 'completed'
                                : command.action === 'reopen'
                                  ? 'reopened'
                                  : 'checked');
            const status = completed
              ? 'completed'
              : signal?.startsWith('check ') || waiting
                ? 'working'
                : (command.action === 'finish' && receipt.status !== 'accepted') ||
                    (!signal && ['ready', 'paused'].includes(lane.state)) ||
                    ['awaiting-review', 'waiting to land', 'waiting-for-dependency', 'conflict'].includes(
                      receipt?.status ?? '',
                    )
                  ? 'waiting'
                  : 'working';
            const entries: { collection: string; key: string; parent: string; value: unknown }[] = [
              { collection: 'lanes', key: lane.id, parent: lane.intentId, value: laneSummary(lane) },
              { collection: 'intents', key: intent.id, parent: '', value: intentHeader(intent) },
            ];
            if (prepared.view)
              entries.push({
                collection: 'views',
                key: prepared.view.id,
                parent: prepared.view.intentId,
                value: viewSummary(prepared.view),
              });
            if (acceptance?.acceptanceId && (!store.native || binding?.acceptanceOwner === true)) {
              const move = prepared.move;
              if (move?.status === 'accepted') {
                entries.push({ collection: 'channelMoves', key: move.id, parent: move.channel, value: move });
                entries.push({
                  collection: 'channels',
                  key: move.channel,
                  parent: '',
                  value: { name: move.channel, head: move.head, moveId: move.id },
                });
              }
            }
            const fingerprint = JSON.stringify([command.action, revision, name, status, entries]);
            const session = sessionId(binding?.operationId ?? store.root, lane.id, name);
            const now = Date.now();
            const previous = state.presence?.[session];
            if (
              signal &&
              previous &&
              now - previous.lastActivity < PRESENCE.touchMs &&
              previous.activityKind === activityKind
            )
              continue;
            if (!signal && previous?.fingerprint === fingerprint) continue;
            if (queue) (queue.observations ??= {})[session] = fingerprint;
            const summary = signal ? (previous?.summary ?? intent.outcome) : intent.outcome.slice(0, 2000);
            (state.presence ??= {})[session] = {
              sessionId: session,
              name,
              environment: 'Local Lane',
              status,
              summary,
              lastSeen: now,
              lastActivity: now,
              activityKind,
              context: { laneId: lane.id, intentId: lane.intentId, head: lane.head },
              fingerprint,
            };
            if (!completed) startPresenceWorker(store);
            if (!binding || !queue) continue;
            const sequence = ++queue.sequence;
            queue.pending.push({
              operationId: randomUUID(),
              projectId: binding.projectId,
              deployment: binding.deployment,
              activity: hostedPaths({
                kind: 'activity',
                activityAt: now,
                activityKind,
                sessionId: session,
                sequence,
                name: name.slice(0, 120),
                environment: 'Local Lane',
                status,
                summary,
                context: {
                  laneId: lane.id,
                  intentId: lane.intentId,
                  head: lane.head,
                  paths: paths.slice(0, 100),
                },
              }),
              metadata: hostedText(
                JSON.stringify({
                  ownerId: binding.operationId,
                  revision,
                  entries: signal ? [] : entries,
                }),
              ),
            });
          }
        });
        break;
      } catch (error) {
        if (!(error instanceof ForgeError && error.code === 'WORK_STALE') || Date.now() >= end) throw error;
      }
    }
    if (!readHostState(store).binding || readHostState(store).binding?.autoSync === false) return undefined;
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('./cli.js', import.meta.url)), 'host', store.root, '--sync-agent'],
      { detached: true, stdio: 'ignore', env: process.env },
    );
    child.once('error', () => {});
    child.unref();
    return { status: 'queued', sourcePush: 'explicit', undo: 'nforge host ROOT --no-auto-sync' };
  } catch {
    // Local presence also uses the owner lock. Its failure is not a hosted-sync
    // deferral when this owner is unbound or has opted out.
    return hostedSyncEnabled ? { status: 'deferred', sourcePush: 'explicit' } : undefined;
  }
}

/** Serial replay retains exact UUIDs/payloads after offline, auth, or unknown outcomes. */
export async function flushAgentSync(store: WorkStore, supplied?: Pick<ConvexHttpClient, 'mutation'>) {
  return withQueueSlot(
    join(store.directory, 'hosted-agent-sync-queue'),
    async () => {
      const attempted = new Set<string>();
      for (;;) {
        const state = readHostState(store),
          pending = state.agentSync?.pending.find(item => !attempted.has(item.operationId));
        if (!pending || state.binding?.autoSync === false)
          return { pending: state.agentSync?.pending.length ?? 0 };
        attempted.add(pending.operationId);
        let activityPublished = false;
        try {
          let client = supplied;
          if (!client) {
            const credentials = coordinationCredentials(pending.deployment, process.env.FORGE_AUTH_TOKEN);
            const http = new ConvexHttpClient(credentials.url, {
              skipConvexDeploymentUrlCheck: true,
              logger: false,
              fetch: (input, init) =>
                fetch(input, { ...init, redirect: 'error', signal: AbortSignal.timeout(10_000) }),
            });
            http.setAuth(credentials.token);
            client = http;
          }
          await client.mutation(makeFunctionReference<'mutation'>('projectCoordination:publish'), {
            projectId: pending.projectId,
            operationId: pending.operationId,
            command: pending.activity,
          });
          activityPublished = true;
          await client.mutation(makeFunctionReference<'mutation'>('projectOwnerSync:publish'), {
            projectId: pending.projectId,
            operationId: pending.operationId,
            metadata: pending.metadata,
          });
          updateHostState(store, current => {
            if (current.agentSync)
              current.agentSync.pending = current.agentSync.pending.filter(
                item => item.operationId !== pending.operationId,
              );
          });
        } catch (error) {
          if (activityPublished) continue;
          return {
            pending: readHostState(store).agentSync?.pending.length ?? 0,
            code: error instanceof ForgeError ? error.code : 'HOSTED_SYNC_PENDING',
          };
        }
      }
    },
    { waitMs: 15_000, anchor: store.directory },
  );
}
