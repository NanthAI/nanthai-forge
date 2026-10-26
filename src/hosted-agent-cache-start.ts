// SPDX-License-Identifier: Apache-2.0
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { NativeSource, nativeOwner } from './native-source.js';
import { HostedObjectStore, cacheHostedState } from './hosted-object-store.js';
import { hostedMainV2Schema } from './hosted-main.js';
import { recordMetricCache } from './self-metrics-source-observations.js';
import { hostedStartResultSchema, hostedLaneSelectionSchema } from './hosted-lane.js';
import { durableReplace } from './native-durability.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { localActor } from './work-actor.js';
import { nativeChannels } from './native-work.js';
import { invariant } from './errors.js';
import type { AgentAction } from './agent-workflow-schema.js';
import type { RetainedBoundSubmission } from './hosted-agent-bound.js';
import type { WorkStore } from './work-store.js';
import type { Lane } from './work-types.js';
import type { HostedAgentTransport } from './hosted-agent-transport.js';
export type CachedOperation = RetainedBoundSubmission & {
  address: { url: string; projectId: string };
  startSource?: {
    head: string;
    stack?: Lane['stack'];
    after?: Lane['after'];
    channel?: { name: string; head: string; acceptanceId: string };
  };
};
type Retained = CachedOperation;
type Command = Extract<AgentAction, { action: 'start' | 'checkpoint' }>;

async function selectStartSource(
  store: WorkStore,
  transport: HostedAgentTransport,
  command: Extract<Command, { action: 'start' }>,
  retained: Retained,
  path: string,
) {
  if (
    !retained.startSource &&
    (command.stackOn || command.channel === null || (command.channel && command.channel !== 'main'))
  ) {
    if (command.stackOn) {
      const parent = hostedLaneSelectionSchema.parse(
        await transport.query('projectHostedLanes:select', { laneId: command.stackOn }),
      );
      invariant(
        parent.projectId === transport.address.projectId && parent.laneId === command.stackOn,
        'PROJECT_UNAVAILABLE',
        'Select this hosted parent Lane.',
      );
      retained.startSource = {
        head: parent.head,
        stack: {
          laneId: parent.laneId,
          startHead: parent.head,
          head: parent.head,
          channel: command.channel ?? 'main',
        },
        after: command.after ?? { intentId: parent.intentId },
      };
      // Pin the selected parent before any download can fail or be interrupted.
      durableReplace(path, canonicalPayload(retained));
    } else
      store.locked(() => {
        const data = store.load();
        const channel =
          command.channel === null ? undefined : nativeChannels(data).find(c => c.name === command.channel);
        invariant(
          command.channel === null || (channel?.head && channel.moveId && !channel.diagnostic),
          'CHANNEL_CHANGED',
          'Selected Channel has no intact acceptance receipt.',
        );
        retained.startSource = {
          head: channel?.head ?? data.nativeHead!,
          ...(channel?.head && channel.moveId
            ? { channel: { name: channel.name, head: channel.head, acceptanceId: channel.moveId } }
            : {}),
        };
      });
    durableReplace(path, canonicalPayload(retained));
  }
  if (retained.startSource) {
    const source = new NativeSource(store.root),
      objects = new HostedObjectStore(join(store.directory, 'hosted-objects'), transport.exchange);
    if (retained.startSource.stack) await cacheHostedState(source, objects, retained.startSource.head);
    // Upload the complete selected State before it can become a hosted pointer.
    for (const file of source.state(retained.startSource.head).files)
      await objects.put(source.object(file.blob));
    await objects.put(source.object(retained.startSource.head));
  }
  return retained.startSource?.head;
}

export async function startCache(
  store: WorkStore,
  transport: HostedAgentTransport,
  command: Extract<Command, { action: 'start' }>,
  retained: Retained,
  path: string,
  operationId: string,
) {
  const initialHead = await selectStartSource(store, transport, command, retained, path);
  const response = await transport.dispatch('start', {
    ...(initialHead ? { initialHead } : {}),
    operationId,
    outcome: command.outcome,
    constraints: command.constraints,
    ...(command.intentId ? { intentId: command.intentId } : {}),
  });
  const started = hostedStartResultSchema.parse(response.result),
    lane = started.lane;
  invariant(lane, 'SOURCE_UNAVAILABLE', 'Hosted start has no Lane source.');
  const main = hostedMainV2Schema.parse(await transport.query('projectHostedChannels:current', {}));
  recordMetricCache(store.directory, main, 'authority', operationId);
  const source = new NativeSource(store.root);
  await cacheHostedState(
    source,
    new HostedObjectStore(join(store.directory, 'hosted-objects'), transport.exchange),
    lane.head,
  );
  const authorized = hostedLaneSelectionSchema.parse(
    await transport.query('projectHostedLanes:select', { laneId: lane.laneId }),
  );
  invariant(
    authorized.projectId === retained.address.projectId && authorized.laneId === lane.laneId,
    'PROJECT_UNAVAILABLE',
    'Select this hosted Lane.',
  );
  store.locked(() => {
    const tx = store.records();
    if (retained.startSource?.stack) tx.setSchema(21);
    else if (command.after) tx.setSchema(12);
    if (!tx.find('intents', started.intentId))
      tx.append('intents', {
        id: started.intentId,
        outcome: command.outcome,
        constraints: command.constraints,
        base: lane.head,
        status: 'active',
        notes: [],
        createdAt: started.at,
      });
    if (!tx.find('lanes', lane.laneId))
      tx.append('lanes', {
        id: lane.laneId,
        intentId: started.intentId,
        base: lane.head,
        head: lane.head,
        name: command.name ?? command.outcome,
        assignment: command.assignment,
        target: command.target,
        state: 'creating',
        checkpoints: [],
        startedAt: started.at,
        startedBy: localActor('agent', command.actor, command.tool),
        ...(command.scope ? { scope: command.scope } : {}),
        ...((retained.startSource?.after ?? command.after)
          ? { after: retained.startSource?.after ?? command.after }
          : {}),
        ...(retained.startSource?.stack ? { stack: retained.startSource.stack } : {}),
      });
    store.commitRecords(tx, undefined, { advisory: false });
  });
  store.laneLocked(lane.laneId, () => {
    const cached = store.select('lanes', lane.laneId)!;
    if (cached.state === 'creating' && !existsSync(store.path(lane.laneId)))
      source.materialize(lane.head, store.path(lane.laneId));
    invariant(
      nativeOwner(store.path(lane.laneId)) === store.root,
      'LANE_UNAVAILABLE',
      'The materialised Lane belongs to another cache.',
    );
    store.locked(() => {
      const tx = store.records();
      if (tx.find('lanes', lane.laneId)?.record.state === 'creating')
        tx.patchFields('lanes', lane.laneId, { state: 'active' });
      store.commitRecords(tx, undefined, { advisory: false });
      retained.result = {
        operationId,
        outcome: command.outcome,
        laneId: lane.laneId,
        intentId: started.intentId,
        base: lane.head,
        head: lane.head,
        currentHead: lane.head,
        path: store.path(lane.laneId),
        state: 'active',
        transport: 'hosted',
        baseChannel:
          command.channel === null
            ? null
            : (retained.startSource?.channel ?? {
                name: 'main',
                head: lane.base.head,
                acceptanceId: lane.base.receiptId,
              }),
      };
      durableReplace(path, canonicalPayload(retained));
    });
  });
  // Record only the revision actually materialised, never a newer observed main.
  if (lane.head === main.head) recordMetricCache(store.directory, main, 'replica', operationId);
  return { revision: store.revision(), result: retained.result };
}
