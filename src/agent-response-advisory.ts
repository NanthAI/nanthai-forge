import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withQueueSlot } from './landing-queue.js';
import { mkdirBelow } from './mkdir-below.js';
import { writeRecoveryState } from './recovery-state.js';
// SPDX-License-Identifier: Apache-2.0
import { indexedReceiptPeers, retainIndexedPeers, recordIndexedOverlapSave } from './agent-receipt-peers.js';
import { scheduleIntegrationPreview } from './integration-preview-auto.js';
import { frictionReceipt } from './friction-auto.js';
import { overlapReceipt } from './agent-overlap-receipt.js';
import { recordOverlapAlerts } from './agent-overlap-alerts.js';
import { duplicateStartWarnings } from './agent-ownership.js';
import { autoSnapshotNotices } from './lane-auto-snapshot.js';
import { indexPeerSource } from './agent-peers-index.js';
import { CoordinationJournal } from './agent-coordination-journal.js';
import { agentPeers, RECEIPT_PEER_LIMIT } from './agent-peers.js';
import { queueAgentSync } from './agent-hosted-sync.js';
import { agentLinks } from './agent-links.js';
import { retryWorkPhase } from './work-retry.js';
import { ForgeError } from './errors.js';
import { syncSummary } from './agent-operation-summary.js';
import { READ_ONLY_ACTIONS } from './agent-read-actions.js';
import type { WorkStore } from './work-store.js';
import type { AgentAction } from './agent-workflow-schema.js';

/** Receipt enrichment is optional observation, independent of the saved effect.
 * A background refresh never marks an overlap as delivered to the caller. */
export async function agentResponseAdvisory(
  store: WorkStore,
  command: AgentAction,
  response: { revision: number; result: unknown },
  resolved?: Record<string, unknown>,
  warnings: string[] = [],
  liveMcp = false,
  delivered = true,
  wait = true,
  indexed = false,
) {
  if (
    !indexed &&
    (command.action === 'start' ||
      command.action === 'checkpoint' ||
      (command.action === 'sync' && (response.result as { status?: string }).status !== 'conflict'))
  )
    scheduleIntegrationPreview(store);
  if (!wait && (command.action === 'finish' || command.action === 'land')) {
    const peers =
      command.action === 'finish'
        ? overlapReceipt(store, command.laneId, undefined, false, false, command.operationId)
        : undefined;
    return {
      ...response,
      result: {
        ...(response.result as object),
        ...(peers ? { peers } : {}),
        ...(resolved ? { resolved } : {}),
      },
    };
  }
  if (indexed && command.action === 'checkpoint') await recordIndexedOverlapSave(store, command.laneId);
  const friction = delivered ? frictionReceipt(store, command, response.result) : {};
  const ownershipStop =
    command.action === 'take' && (response.result as { status: string }).status === 'ownership';
  const hostedSync =
    !delivered || ownershipStop || command.action === 'handoff' || READ_ONLY_ACTIONS.has(command.action)
      ? undefined
      : queueAgentSync(store, command, response.result, false, liveMcp ? 'MCP call' : undefined);
  let links: unknown;
  if (delivered && ['checkpoint', 'finish'].includes(command.action) && 'laneId' in command) {
    try {
      links = await agentLinks(store, { laneId: command.laneId }, indexed);
    } catch (error) {
      links = {
        error: {
          code: error instanceof ForgeError ? error.code : 'HOST_IDENTITY_UNAVAILABLE',
          message: 'Forge URLs could not be resolved; use link to retry the read.',
        },
      };
    }
  }
  if (!indexed && ['start', 'checkpoint', 'sync', 'finish', 'accept'].includes(command.action)) {
    const laneId =
      command.action === 'start'
        ? (response.result as { laneId: string }).laneId
        : (command as { laneId?: string }).laneId;
    if (laneId)
      try {
        indexPeerSource(store, laneId);
      } catch {
        /* Observation reports unavailable source below. */
      }
  }
  let overlapCoverage: string | undefined;
  if (!indexed && (command.action === 'checkpoint' || command.action === 'sync')) {
    try {
      overlapCoverage = await retryWorkPhase(
        command.operationId!,
        () =>
          store.observing(() =>
            recordOverlapAlerts(store, command.laneId, RECEIPT_PEER_LIMIT, command.action === 'checkpoint'),
          ),
        ['SOURCE_CHANGED'],
      );
    } catch {
      overlapCoverage = 'local-incomplete';
    }
  }
  if (!indexed && !READ_ONLY_ACTIONS.has(command.action) && 'laneId' in command && command.laneId) {
    try {
      const retained = indexedReceiptPeers(store, { laneId: command.laneId, detail: true });
      new CoordinationJournal(store).record(retained.conflicts ?? []);
    } catch {
      overlapCoverage = 'local-incomplete';
    }
  }
  let peers =
    ['start', 'checkpoint', 'sync', 'finish'].includes(command.action) ||
    (command.action === 'status' && command.laneId)
      ? (indexed ? indexedReceiptPeers : agentPeers)(
          store,
          {
            laneId:
              command.action === 'start'
                ? (response.result as { laneId: string }).laneId
                : (command as { laneId: string }).laneId,
            scope: (command as { scope?: { paths: string[] } }).scope,
            detail: true,
          },
          { receipt: true },
        )
      : undefined;
  if (delivered && command.action === 'start') {
    const result = response.result as { laneId: string; warnings?: string[] };
    try {
      const duplicates = duplicateStartWarnings(store, result.laneId, command.outcome, peers?.overlaps);
      if (duplicates.length) result.warnings = [...(result.warnings ?? []), ...duplicates];
    } catch {
      Object.assign(result, { ownershipCoverage: 'local-incomplete' });
    }
    // A restarted agent learns that its earlier open Lane holds recovered unsaved edits.
    const recovered = command.actor
      ? autoSnapshotNotices(store, command.actor).filter(item => item.laneId !== result.laneId)
      : [];
    if (recovered.length)
      result.warnings = [
        ...(result.warnings ?? []),
        ...recovered.map(item => `Lane ${item.laneId} (${item.path}): ${item.notice}`),
      ];
  }
  if (peers) {
    if (overlapCoverage === 'local-incomplete') {
      delete peers.clear;
      peers.v = 1;
      peers.coverage = 'local-incomplete';
    }
    try {
      const journal = new CoordinationJournal(store);
      if (command.action !== 'status') journal.record(peers.conflicts ?? []);
      const laneId =
        command.action === 'start'
          ? (response.result as { laneId: string }).laneId
          : (command as { laneId: string }).laneId;
      if (peers.conflicts) peers.conflicts = peers.conflicts.map(notice => journal.decorate(notice, laneId));
    } catch {
      peers.coverage = 'local-incomplete';
    }
    const detail = 'detail' in command && command.detail === true;
    if (!detail && ['checkpoint', 'sync'].includes(command.action)) delete peers.changes;
  }
  if (!delivered) {
    const laneId =
      command.action === 'start'
        ? (response.result as { laneId: string }).laneId
        : 'laneId' in command
          ? command.laneId
          : undefined;
    if (laneId && peers) retainIndexedPeers(store, laneId, peers);
    return response;
  }
  const receiptLane =
    command.action === 'start'
      ? (response.result as { laneId: string }).laneId
      : 'laneId' in command
        ? command.laneId
        : undefined;
  if (receiptLane && (peers || ['handoff', 'complete', 'abandon'].includes(command.action)))
    peers = overlapReceipt(
      store,
      receiptLane,
      peers,
      !delivered || READ_ONLY_ACTIONS.has(command.action),
      'detail' in command && command.detail === true,
      (indexed || ['finish', 'handoff'].includes(command.action)) && 'operationId' in command
        ? command.operationId
        : undefined,
    );
  const summary =
    command.action === 'sync'
      ? syncSummary(response.result as Parameters<typeof syncSummary>[0], command.channel)
      : command.action === 'checkpoint'
        ? (response.result as { head: string; parent: string }).head ===
          (response.result as { parent: string }).parent
          ? 'Lane checkpoint unchanged'
          : 'saved Lane checkpoint'
        : undefined;
  return {
    ...(summary ? { summary } : {}),
    ...response,
    result: {
      ...(response.result as object),
      ...friction,
      ...(peers ? { peers } : {}),
      ...(hostedSync ? { hostedSync } : {}),
      ...(links ? { links } : {}),
      ...(resolved ? { resolved } : {}),
      ...(warnings.length ? { warnings } : {}),
    },
  };
}

/** Enrichment is retained locally without publishing Work or entering its writer
 * queue. Replays preserve the returned observation even after caches refresh. */
export async function durableResponseAdvisory(
  store: WorkStore,
  command: Extract<AgentAction, { action: 'start' | 'checkpoint' }>,
  response: { revision: number; result: unknown },
  resolved?: Record<string, unknown>,
  warnings: string[] = [],
  liveMcp = false,
) {
  const directory = join(store.directory, 'agent-response-receipts');
  mkdirBelow(store.directory, directory);
  const path = join(directory, `${command.operationId}.json`);
  const retained = await withQueueSlot(
    join(directory, `${command.operationId}-lock`),
    async () => {
      try {
        return JSON.parse(readFileSync(path, 'utf8')) as typeof response;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const enriched = await agentResponseAdvisory(
        store,
        command,
        response,
        resolved,
        warnings,
        liveMcp,
        true,
        true,
        true,
      );
      writeRecoveryState(path, enriched);
      return enriched;
    },
    { anchor: store.directory, phase: 'agent receipt enrichment' },
  );
  if (!('value' in retained)) throw new ForgeError('WORK_BUSY', 'Receipt enrichment is busy.');
  const receipt = {
    ...retained.value,
    // Restore core optional fields which JSON omits (e.g. Git captureCoverage).
    result: { ...(response.result as object), ...(retained.value.result as object) },
  };
  // Stacked start's original head/base are immutable; currentHead is explicitly live.
  const current = response.result as { currentHead?: string; stack?: unknown };
  return command.action === 'start' && command.stackOn
    ? { ...receipt, result: { ...(receipt.result as object), currentHead: current.currentHead } }
    : receipt;
}
