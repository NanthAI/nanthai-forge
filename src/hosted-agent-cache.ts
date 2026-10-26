// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { readHostState } from './host-binding.js';
import { sourceAuthority, SourceAuthorityStaleError } from './hosted-source-authority.js';
import { hostedAgentCapabilitiesSchema } from './hosted-agent-contract.js';
import { HostedAgentTransport } from './hosted-agent-transport.js';
import { HostedObjectStore, cacheHostedState } from './hosted-object-store.js';
import { NativeSource } from './native-source.js';
import { durableReplace } from './native-durability.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { hostedLaneSelectionSchema } from './hosted-lane.js';
import { saveBoundInput, captureBoundInputs } from './hosted-agent-bound-save.js';
import { startCache, type CachedOperation } from './hosted-agent-cache-start.js';
import { parseAgentAction } from './agent-action-parse.js';
import { type AgentAction } from './agent-workflow-schema.js';
import { localActor } from './work-actor.js';
import { withQueueSlot } from './landing-queue.js';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import type { WorkStore } from './work-store.js';

type Command = Extract<AgentAction, { action: 'start' | 'checkpoint' }>;
type Retained = CachedOperation;
const read = (path: string): Retained => JSON.parse(readFileSync(path, 'utf8'));

/** Bound server projects retain only a local Work/source cache. Hosted saves
 * publish first; a crash before local acknowledgement cannot lose a saved head. */
export async function boundAgentCache(
  store: WorkStore,
  input: unknown,
  native: (input: unknown) => Promise<{ revision: number; result: unknown }>,
  supplied?: HostedAgentTransport,
) {
  const raw = input as Record<string, unknown>;
  const binding = readHostState(store).binding;
  if (!store.native || !binding || sourceAuthority(binding).mode !== 'server') return native(input);
  if (!['start', 'checkpoint'].includes(String(raw?.action))) return native(input);
  const directory = join(store.directory, 'hosted-cache-operations');
  const operationId = z.uuid().parse(raw.operationId ?? randomUUID());
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${operationId}.json`);
  const retained = store.locked(() => {
    const previous = existsSync(path) ? read(path) : undefined;
    const command = parseAgentAction({ ...previous?.command, ...raw, operationId }) as Command;
    invariant(
      command.action === 'start' || command.action === 'checkpoint',
      'BAD_ARGUMENT',
      'Select start or checkpoint.',
    );
    if (previous) {
      const comparable = (value: unknown) =>
        canonicalPayload(
          Object.fromEntries(
            Object.entries(value as object).filter(
              ([key]) => !['waitMs', 'lockWaitMs', 'detail', 'scope'].includes(key),
            ),
          ),
        );
      invariant(
        comparable(command) === comparable(previous.command) &&
          previous.address.url === binding.deployment &&
          previous.address.projectId === binding.projectId,
        'WORK_OPERATION_CHANGED',
        'Replay the original bound cache operation and project.',
      );
      return previous;
    }
    const lane = command.action === 'checkpoint' ? store.select('lanes', command.laneId) : undefined;
    if (command.action === 'checkpoint') {
      invariant(lane, 'NOT_FOUND', 'Selected Lane not found.');
      invariant(
        !command.expectedHead || command.expectedHead === lane.head,
        'LANE_STALE',
        'The saved Lane changed.',
      );
    }
    const next: Retained = {
      command,
      address: { url: binding.deployment, projectId: binding.projectId },
      inputs: lane
        ? [{ laneId: lane.id, head: lane.head, baseline: lane.head, intentId: lane.intentId }]
        : [],
    };
    durableReplace(path, canonicalPayload(next));
    return next;
  });
  const transport = supplied ?? new HostedAgentTransport(store.root, retained.address);
  const result = await withQueueSlot(
    join(directory, `${operationId}.lock`),
    async () => {
      Object.assign(retained, read(path));
      const command = retained.command as Command;
      // Even a completed local receipt must not turn cached bytes into authority.
      const capabilities = hostedAgentCapabilitiesSchema.parse(
        (await transport.dispatch('capabilities', {})).result,
      );
      if (capabilities.authority.mode !== 'server')
        throw new SourceAuthorityStaleError(capabilities.authority);
      if (retained.result)
        return {
          revision: store.revision(),
          result:
            command.action === 'start'
              ? {
                  ...retained.result,
                  currentHead:
                    store.select('lanes', String(retained.result.laneId))?.head ?? retained.result.head,
                }
              : retained.result,
        };
      if (command.action === 'start')
        return startCache(store, transport, command, retained, path, operationId);
      captureBoundInputs(store, retained, path);
      const saved = await saveBoundInput(store, transport, operationId, retained.inputs[0]!, command.message);
      if (saved.outcome?.status !== 'completed')
        return {
          revision: store.revision(),
          result: {
            operationId,
            laneId: command.laneId,
            transport: 'hosted',
            status: 'pending',
            complete: false,
            progress: saved.result,
          },
        };
      const receipt = z.object({ head: z.string(), at: z.string() }).parse(saved.outcome.result);
      const source = new NativeSource(store.root);
      await cacheHostedState(
        source,
        new HostedObjectStore(join(store.directory, 'hosted-objects'), transport.exchange),
        receipt.head,
      );
      // Recheck authority and Lane identity after transfer; newer saved work stays hosted.
      const selected = hostedLaneSelectionSchema.parse(
        await transport.query('projectHostedLanes:select', { laneId: command.laneId }),
      );
      invariant(
        selected.projectId === retained.address.projectId && selected.laneId === command.laneId,
        'PROJECT_UNAVAILABLE',
        'Select this hosted Lane.',
      );
      if (selected.authority.mode !== 'server') throw new SourceAuthorityStaleError(selected.authority);
      store.locked(() => {
        const tx = store.records(),
          lane = tx.find('lanes', command.laneId)?.record;
        invariant(
          lane && (lane.head === retained.inputs[0]!.baseline || lane.head === receipt.head),
          'LANE_STALE',
          'The local saved Lane changed during hosted save.',
        );
        if (!tx.fieldFind('lanes', lane.id, 'checkpoints', operationId, 'operation')) {
          tx.setSchema(12);
          tx.appendField('lanes', lane.id, 'checkpoints', {
            head: receipt.head,
            parent: retained.inputs[0]!.baseline,
            message: command.message,
            at: receipt.at,
            actor: localActor('agent', command.actor, command.tool),
            operation: { id: operationId, request: digest(canonicalPayload(command)) },
          });
          tx.patchFields('lanes', lane.id, { head: receipt.head });
          store.commitRecords(tx, undefined, { advisory: false });
        }
        retained.result = {
          operationId,
          laneId: lane.id,
          head: receipt.head,
          parent: retained.inputs[0]!.baseline,
          message: command.message,
          path: store.path(lane.id),
          transport: 'hosted',
        };
        durableReplace(path, canonicalPayload(retained));
      });
      return { revision: store.revision(), result: retained.result };
    },
    { anchor: store.directory, waitMs: typeof raw.waitMs === 'number' ? raw.waitMs : 60000 },
  );
  return 'value' in result
    ? result.value
    : {
        revision: store.revision(),
        result: { operationId, transport: 'hosted', status: 'pending', complete: false },
      };
}
