// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { agentActionSchema, type AgentAction } from './agent-workflow-schema.js';
import { nativeChannels } from './native-work.js';
import { channelStatus } from './work-channel.js';
import { invariant } from './errors.js';
import type { WorkStore } from './work-store.js';
import { allRecords } from './agent-lifecycle.js';
import type { Check, WorkView } from './work-types.js';

/** The Channel head an agent would observe now; null for a new Channel. */
export function currentChannelHead(store: WorkStore, name: string): string | null {
  const tx = store.readRecords(),
    data = tx ? { ...tx.data(), channelMoves: tx.all('channelMoves', name, 'channel') } : store.load();
  const channels = store.native ? nativeChannels(data) : channelStatus(store, data);
  return channels.find(item => item.name === name)?.head ?? null;
}
const checks = (store: WorkStore) => allRecords<Check>(store, 'checks');
/** `verify` when defined, else the only check. */
export function defaultCheck(store: WorkStore): Check {
  const all = checks(store),
    named = all.filter(check => check.name.trim().toLowerCase() === 'verify');
  const selected = named.length === 1 ? named[0] : all.length === 1 ? all[0] : undefined;
  invariant(
    selected,
    'CHECK_REQUIRED',
    all.length
      ? `Choose checkId, or name one check "verify". Defined checks: ${all.map(check => `${check.name} (${check.id})`).join(', ')}.`
      : 'Define a check first (define-check), preferably named "verify".',
  );
  return selected;
}
function laneHead(store: WorkStore, laneId: string) {
  const lane = store.select('lanes', laneId, 'id', true);
  invariant(lane, 'NOT_FOUND', 'Lane not found.');
  return lane.head;
}
/** The latest clean View that composed this Lane. */
function laneView(store: WorkStore, laneId: string | undefined): string {
  invariant(laneId, 'BAD_ARGUMENT', 'Send viewId, or laneId to use that Lane’s latest clean View.');
  invariant(store.select('lanes', laneId, 'id', true), 'NOT_FOUND', 'Lane not found.');
  const views = allRecords<WorkView>(store, 'views').filter(
    view => view.status === 'clean' && view.head && view.inputs.some(input => input.laneId === laneId),
  );
  invariant(views.length, 'NOT_FOUND', 'No clean View for this Lane. Run finish first.');
  return views[views.length - 1]!.id;
}
function viewHead(store: WorkStore, viewId: string) {
  const view = store.select('views', viewId);
  invariant(view, 'NOT_FOUND', 'View not found.');
  invariant(view.status === 'clean' && view.head, 'VIEW_STALE', 'Select a clean View.');
  return view.head;
}
/** Fill omitted pins from current state before any request identity is hashed.
 * `resolved` lists only the filled values; send them back to retry an unknown outcome. */
export function resolveAgentDefaults(
  store: WorkStore,
  command: AgentAction,
): { command: AgentAction; resolved?: Record<string, unknown> } {
  const resolved: Record<string, unknown> = {};
  const pin = <T>(key: string, value: T | undefined, fallback: () => T): T => {
    if (value !== undefined) return value;
    return (resolved[key] = fallback()) as T;
  };
  let next: Record<string, unknown> = command;
  switch (command.action) {
    case 'start':
      next = { ...command, operationId: pin('operationId', command.operationId, randomUUID) };
      break;
    case 'take':
    case 'abandon':
    case 'undo-sync':
    case 'report':
    case 'peer-ack':
      next = { ...command, operationId: pin('operationId', command.operationId, randomUUID) };
      break;
    case 'checkpoint':
    case 'sync':
      next = {
        ...command,
        operationId: pin('operationId', command.operationId, randomUUID),
        expectedHead: pin('expectedHead', command.expectedHead, () => laneHead(store, command.laneId)),
      };
      break;
    case 'finish': {
      const lane = store.select('lanes', command.laneId, 'id', true);
      invariant(lane, 'NOT_FOUND', 'Lane not found.');
      const siblings = command.with ?? [];
      invariant(
        new Set([command.laneId, ...siblings]).size === siblings.length + 1,
        'BAD_ARGUMENT',
        'Select each Lane once.',
      );
      const withInputs =
        command.with === undefined
          ? command.withInputs
          : pin('withInputs', command.withInputs, () =>
              siblings.map(laneId => ({ laneId, head: laneHead(store, laneId) })),
            );
      invariant(
        (withInputs?.length ?? 0) === siblings.length &&
          (withInputs ?? []).every((pin, i) => pin.laneId === siblings[i]),
        'BAD_ARGUMENT',
        'Sibling pins must match with Lane ids in order.',
      );
      for (const pin of withInputs ?? [])
        invariant(
          store.select('lanes', pin.laneId, 'id', true)?.intentId === lane.intentId,
          'BAD_ARGUMENT',
          'Joint landing requires sibling Lanes of the same Intent.',
        );
      const after = command.after ?? lane.after;
      if (!command.after && after) resolved.after = after;
      const checkId = pin('checkId', command.checkId, () => defaultCheck(store).id);
      let accept = command.accept;
      if (accept === true || (accept && accept.expectedPrevious === undefined)) {
        const channel = accept === true ? 'main' : accept.channel;
        accept = {
          ...(accept === true ? { channel } : accept),
          expectedPrevious: currentChannelHead(store, channel),
        };
        resolved.accept = accept;
      }
      next = {
        ...command,
        ...(withInputs ? { withInputs } : {}),
        ...(after ? { after } : {}),
        operationId: pin('operationId', command.operationId, randomUUID),
        expectedHead: pin('expectedHead', command.expectedHead, () => laneHead(store, command.laneId)),
        checkId,
        expectedDefinition: pin('expectedDefinition', command.expectedDefinition, () => {
          const check = store.select('checks', checkId);
          invariant(check, 'NOT_FOUND', 'Check not found.');
          return check.definition;
        }),
        ...(accept ? { accept } : {}),
      };
      break;
    }
    case 'run': {
      const viewId = pin('viewId', command.viewId, () => laneView(store, command.laneId));
      next = {
        ...command,
        viewId,
        operationId: pin('operationId', command.operationId, randomUUID),
        expectedHead: pin('expectedHead', command.expectedHead, () => viewHead(store, viewId)),
        checkId: pin('checkId', command.checkId, () => defaultCheck(store).id),
      };
      break;
    }
    case 'accept':
      next = {
        ...command,
        operationId: pin('operationId', command.operationId, randomUUID),
        expectedHead: pin('expectedHead', command.expectedHead, () => viewHead(store, command.viewId)),
        expectedPrevious: pin('expectedPrevious', command.expectedPrevious, () =>
          currentChannelHead(store, command.channel),
        ),
      };
      break;
    default:
      return { command };
  }
  // Re-parse for canonical key order: a retry with explicit pins hashes identically.
  const canonical = agentActionSchema.parse(next);
  return { command: canonical, ...(Object.keys(resolved).length ? { resolved } : {}) };
}
