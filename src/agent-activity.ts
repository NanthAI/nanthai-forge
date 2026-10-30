// SPDX-License-Identifier: Apache-2.0
import { PRESENCE } from './presence.js';
import { startPresenceWorker } from './presence-worker-start.js';
import { createHash } from 'node:crypto';
import { readHostState, updateHostState } from './host-binding.js';
import { localActor } from './work-actor.js';
import type { WorkStore } from './work-store.js';
import type { AgentAction } from './agent-workflow-schema.js';

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
/** Local presence only. Hosted lifecycle and coordination have their own authoritative APIs. */
export function recordAgentActivity(
  store: WorkStore,
  command: AgentAction | { action: 'activity'; laneId: string; actor?: string },
  result: unknown,
  waiting = false,
  signal?: string,
) {
  if (!signal && !actions.has(command.action)) return undefined;
  try {
    return store.observing(() => {
      const binding = readHostState(store).binding;
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
      if ('intentId' in command && command.intentId && !laneId) {
        for (let offset: number | null = 0; offset !== null;) {
          const page = store.page('lanes', offset, 100);
          for (const lane of page.records) if (lane.intentId === command.intentId) ids.add(lane.id);
          offset = page.nextOffset;
        }
      }
      if (command.action === 'complete-merged') for (const id of receipt?.lanes ?? []) ids.add(id);
      if (!ids.size) return undefined;
      updateHostState(
        store,
        state => {
          const revision = store.revision();
          for (const id of ids) {
            const lane = store.select('lanes', id, 'id', true);
            const intent = lane && store.select('intents', lane.intentId, 'id', true);
            if (!lane || !intent) continue;

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
            const fingerprint = JSON.stringify([
              command.action,
              revision,
              name,
              status,
              lane.head,
              lane.state,
              intent.status,
            ]);
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
          }
        },
        { ownerLock: false },
      );
      return { status: 'recorded' };
    });
  } catch {
    return { status: 'deferred' };
  }
}
