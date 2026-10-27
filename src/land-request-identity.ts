// SPDX-License-Identifier: Apache-2.0
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { invariant } from './errors.js';
import { queuedOutcome, reviewedOutcome, submissionOutcome } from './landing-submission.js';
import type { WorkStore } from './work-store.js';
import { allRecords } from './agent-lifecycle.js';
import type { LandingEntry } from './landing-batch-types.js';
import type { LandEntry } from './land-journal.js';

/** An alias retains its own request identity but observes the original controller.
 * Resolve atomic journal snapshots without joining any owner or driver lock. */
export function resolveLandEntry(store: WorkStore, entry: LandEntry): LandEntry {
  if (!entry.sourceOperationId) return entry;
  const state = JSON.parse(
    readFileSync(join(store.directory, 'agent-land', `${entry.sourceOperationId}.json`), 'utf8'),
  ) as { entries: LandEntry[] };
  const original = state.entries.find(item => item.command.operationId === entry.command.operationId);
  invariant(
    original && !original.sourceOperationId,
    'INVALID_WORK_STORE',
    'Original landing entry is unavailable.',
  );
  return { ...original, inputs: entry.inputs, sourceOperationId: entry.sourceOperationId };
}

/** Called under admission's existing owner lock. Pending and landed heads share
 * work; a new operation may retry terminal failures without changing source. */
export function reuseLandSelection(
  store: WorkStore,
  operationId: string,
  channel: string,
  entries: LandEntry[],
) {
  const directory = join(store.directory, 'agent-land');
  if (!existsSync(directory)) return entries;
  const prior = readdirSync(directory)
    .filter(name => /^[0-9a-f-]+\.json$/.test(name) && name !== `${operationId}.json`)
    .flatMap(name => {
      const state = JSON.parse(readFileSync(join(directory, name), 'utf8')) as { entries: LandEntry[] };
      return state.entries
        .filter(entry => !entry.sourceOperationId && entry.command.accept?.channel === channel)
        .map(entry => ({ operationId: name.slice(0, -5), entry }));
    });
  const tx = store.readRecords();
  const queued = tx
    ? tx.manifest.collections.landingEntries
      ? allRecords<LandingEntry>(store, 'landingEntries')
      : []
    : (store.load().landingEntries ?? []);
  const reusable = (entry: LandEntry) => {
    const selected = queued.find(item => item.id === entry.command.operationId);
    return (
      submissionOutcome(
        selected
          ? queuedOutcome(store, selected)
          : reviewedOutcome(
              store,
              entry.result ?? { status: 'queued' },
              entry.single?.viewId ?? entry.viewId,
              channel,
            ),
      ).state !== 'terminal-failed'
    );
  };
  return entries.flatMap(entry => {
    const reused = new Map<string, LandEntry>();
    const remaining = entry.inputs.filter(pin => {
      const existing = prior.find(
        item =>
          item.entry.command.preview === entry.command.preview &&
          item.entry.command.checkId === entry.command.checkId &&
          item.entry.command.expectedDefinition === entry.command.expectedDefinition &&
          item.entry.inputs.some(old => old.laneId === pin.laneId && old.head === pin.head) &&
          reusable(item.entry),
      );
      if (!existing) {
        const shared = queued.find(
          item =>
            item.channel === channel &&
            item.preview === entry.command.preview &&
            item.checkId === entry.command.checkId &&
            item.definition === entry.command.expectedDefinition &&
            store
              .select('views', item.viewId)
              ?.inputs.some(old => old.laneId === pin.laneId && old.head === pin.head) &&
            submissionOutcome(queuedOutcome(store, item)).state !== 'terminal-failed',
        );
        if (!shared) return true;
        const reference = reused.get(shared.id) ?? {
          inputs: [],
          command: { ...entry.command, operationId: shared.id },
          viewId: shared.viewId,
          queued: true,
          sharedOperationId: shared.id,
        };
        reference.inputs.push(pin);
        reused.set(shared.id, reference);
        return false;
      }
      const key = existing.entry.command.operationId;
      const shared = reused.get(key) ?? {
        ...existing.entry,
        sourceOperationId: existing.operationId,
        inputs: [],
      };
      shared.inputs.push(pin);
      reused.set(key, shared);
      return false;
    });
    const first = remaining[0];
    return [
      ...reused.values(),
      ...(first
        ? [
            {
              ...entry,
              inputs: remaining,
              command: {
                ...entry.command,
                laneId: first.laneId,
                expectedHead: first.head,
                with: remaining.slice(1).map(pin => pin.laneId),
                withInputs: remaining.slice(1),
              },
            },
          ]
        : []),
    ];
  });
}
