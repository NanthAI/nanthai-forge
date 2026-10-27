// SPDX-License-Identifier: Apache-2.0
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ForgeError } from './errors.js';
import type { WorkStore } from './work-store.js';

export type OwnerDrainBlocker = { kind: string; id: string; status: string };
const failures = new Set([
  'failed',
  'conflict',
  'cancelled',
  'interrupted',
  'retry-exhausted',
  'preview-excluded',
]);
export function terminalOwnerResult(result: Record<string, unknown> | undefined): boolean {
  if (!result || result.terminal === false) return false;
  return (
    result.complete === true ||
    result.terminal === true ||
    ['accepted', 'already-accepted', 'landed'].includes(String(result.status)) ||
    failures.has(String(result.status))
  );
}
/** Called under the owner lock, after closing native admission. Journals without
 * a known outcome remain blockers, including drivers that never made a batch. */
export function ownerDrainBlockers(store: WorkStore): OwnerDrainBlocker[] {
  const data = store.load(),
    blockers: OwnerDrainBlocker[] = [];
  const add = (kind: string, id: string, status: string) => blockers.push({ kind, id, status });
  for (const entry of data.landingEntries ?? []) {
    if (entry.status === 'accepted') {
      if (
        !entry.alreadyOnMain &&
        !data.channelMoves.some(m => m.id === entry.acceptanceId && m.status === 'accepted')
      )
        add('landing-entry', entry.id, 'missing-acceptance-receipt');
    } else if (!failures.has(entry.status)) add('landing-entry', entry.id, entry.status);
  }
  for (const batch of data.landingBatches ?? [])
    if (!['completed', 'superseded'].includes(batch.status)) add('landing-batch', batch.id, batch.status);
  for (const kind of ['agent-finish', 'agent-land', 'native-submissions']) {
    const directory = join(store.directory, kind);
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory).filter(n => /^[0-9a-f-]+\.json$/i.test(n))) {
      const state = JSON.parse(readFileSync(join(directory, name), 'utf8'));
      if (
        (kind === 'agent-finish' || state.command?.action === 'finish') &&
        !state.command?.accept &&
        !state.submitted
      )
        continue;
      let result = state.result;
      if (kind === 'native-submissions' && !terminalOwnerResult(result)) {
        const journal = join(
          store.directory,
          state.command?.action === 'land' ? 'agent-land' : 'agent-finish',
          name,
        );
        if (existsSync(journal)) {
          const saved = JSON.parse(readFileSync(journal, 'utf8'));
          if (saved.result) result = saved.result;
          else if (
            saved.entries?.length &&
            saved.entries.every((e: { result?: Record<string, unknown> }) => terminalOwnerResult(e.result))
          )
            result = { terminal: true };
        }
      }
      const terminal =
        kind === 'agent-land'
          ? state.entries.length > 0 &&
            state.entries.every((e: { result?: Record<string, unknown> }) => terminalOwnerResult(e.result))
          : terminalOwnerResult(result);
      if (!terminal) add(kind, name.slice(0, -5), state.result?.status ?? 'unknown-outcome');
    }
  }
  return blockers;
}
export function requireOwnerDrained(store: WorkStore) {
  const blockers = ownerDrainBlockers(store);
  if (blockers.length)
    throw new ForgeError(
      'SOURCE_AUTHORITY_DRAIN_REQUIRED',
      `Owner landing work must settle before switching authority: ${JSON.stringify(blockers)}. Resume the original requests; no submission was cancelled.`,
    );
}
