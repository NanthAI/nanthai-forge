// SPDX-License-Identifier: Apache-2.0
import { isUnifiedWork } from './work-unified-types.js';
import { automaticCleanup } from './work-auto-clean.js';
import { randomUUID } from 'node:crypto';
import type { WorkStore } from './work-store.js';
import type { WorkRecordTransaction } from './work-record-transaction.js';
import type { LocalWorkCommand, Lane } from './work-types.js';
import { applyIntentMetadata } from './work-metadata.js';
import { invariant } from './errors.js';
import { NativeSource } from './native-source.js';
import { validateAnchorView, validateAnchorFile } from './work-source-anchor.js';
import { headAt } from './work-git.js';
type ScopedMetadataCommand = Extract<LocalWorkCommand, { action: 'note' | 'intent-status' | 'lane-status' }>;
export const scopedMetadata = (
  command: LocalWorkCommand,
): command is
  | ScopedMetadataCommand
  | (Extract<LocalWorkCommand, { action: 'intent' }> & { baseChannel?: undefined }) =>
  ['note', 'intent-status', 'lane-status'].includes(command.action) ||
  (command.action === 'intent' && !command.baseChannel);
export function recordMetadata(
  store: WorkStore,
  command: LocalWorkCommand,
  revision: number,
  options: {
    compact?: boolean;
    recover?: (tx: WorkRecordTransaction) => void;
    workspace?: (lane: Lane) => unknown;
  } = {},
) {
  const execute = () =>
    store.locked(
      () => {
        let tx = store.records();
        if (options.recover) {
          options.recover(tx);
          tx = store.records();
        }
        if (command.action === 'intent' && command.operationId) {
          const original = tx.fields('intents', command.operationId)?.record;
          if (original) {
            invariant(
              original.outcome === command.outcome && original.constraints === command.constraints,
              'WORK_OPERATION_CHANGED',
              'Replay the original Intent creation.',
            );
            return { revision: tx.revision, result: original };
          }
        }
        invariant(
          Number.isSafeInteger(revision) && revision === tx.revision,
          'WORK_STALE',
          'Work changed. Refresh before retrying; nothing was overwritten.',
        );
        const data = tx.data(),
          at = new Date().toISOString();
        let result: unknown;
        if (command.action === 'intent') {
          result = applyIntentMetadata(
            data,
            { ...command, base: store.native ? data.nativeHead! : headAt(store.root) },
            { id: command.operationId ?? randomUUID(), at },
          );
          tx.append('intents', data.intents[0]!);
        } else if (command.action === 'note') {
          if (command.anchor) {
            validateAnchorView(
              tx.fields('views', command.anchor.viewId)?.record,
              command.intentId,
              command.anchor,
            );
            const source = new NativeSource(store.root),
              state = source.state(
                command.anchor.side === 'before' ? command.anchor.base : command.anchor.head,
              );
            const file = state.files.find(file => file.path === command.anchor!.file);
            validateAnchorFile(command.anchor, file, file ? source.object(file.blob) : undefined);
          }
          const note = {
            text: command.text,
            kind: command.kind,
            at,
            ...(command.anchor ? { anchor: command.anchor } : {}),
          };
          const position = tx.appendField('intents', command.intentId, 'notes', note);
          result = options.compact
            ? { id: command.intentId, note, detailDeferred: true }
            : tx.at('intents', position);
        } else if (command.action === 'intent-status') {
          const found = tx.fields('intents', command.intentId);
          invariant(found, 'NOT_FOUND', 'Intent not found.');
          // Schema 16 derives Ready as attention; the request stays as lifecycle history.
          const status =
            command.status === 'ready' && isUnifiedWork(tx.manifest.fields) ? 'active' : command.status;
          if (status !== command.status)
            tx.appendField('intents', command.intentId, 'lifecycle', {
              from: found.record.status,
              to: command.status,
              at,
            });
          else if (command.status === 'completed' || Object.hasOwn(found.counts, 'lifecycle')) {
            if (found.record.status !== command.status)
              tx.appendField('intents', command.intentId, 'lifecycle', {
                from: found.record.status,
                to: command.status,
                at,
              });
          }
          const position = tx.patchFields('intents', command.intentId, { status });
          result = options.compact
            ? {
                ...found.record,
                status,
                historyCounts: tx.fields('intents', command.intentId)!.counts,
                detailDeferred: true,
              }
            : tx.at('intents', position);
        } else {
          invariant(command.action === 'lane-status', 'BAD_ARGUMENT', 'Select a supported metadata action.');
          const found = tx.fields('lanes', command.laneId);
          invariant(found, 'NOT_FOUND', 'Lane not found.');
          invariant(
            !command.expectedHead || found.record.head === command.expectedHead,
            'LANE_STALE',
            'Lane has later work; leave that head open.',
          );
          options.workspace?.(found.record);
          if (command.state === 'completed' || Object.hasOwn(found.counts, 'lifecycle')) {
            if (found.record.state !== command.state)
              tx.appendField('lanes', command.laneId, 'lifecycle', {
                from: found.record.state,
                to: command.state,
                at,
              });
          }
          const position = tx.patchFields('lanes', command.laneId, { state: command.state });
          result = options.compact
            ? {
                ...found.record,
                state: command.state,
                historyCounts: tx.fields('lanes', command.laneId)!.counts,
                detailDeferred: true,
              }
            : tx.at('lanes', position);
        }
        return { revision: store.commitRecords(tx), result };
      },
      { operation: command.action },
    );
  const response =
    command.action === 'lane-status'
      ? store.laneLocked(command.laneId, execute, { operation: 'lane metadata' })
      : execute();
  if (command.action === 'lane-status' && command.state === 'completed') {
    const cleanup = automaticCleanup(
      store,
      `complete:${command.laneId}:${response.revision}`,
      'Lane lifecycle',
      { laneIds: [command.laneId] },
    );
    if (cleanup) return { revision: store.revision(), result: { ...(response.result as object), cleanup } };
  }
  return response;
}
