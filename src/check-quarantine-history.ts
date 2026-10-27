// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { runDetails } from './work-detail-store.js';
import { durableReplace } from './native-durability.js';
import type { WorkStore } from './work-store.js';
import type { TestObservation } from './check-flake-evidence.js';

const stateSchema = z.object({
  flakes: z.array(z.number()),
  quarantined: z.boolean(),
  consecutivePasses: z.number(),
});
export type QuarantineState = z.infer<typeof stateSchema>;
export function observeQuarantine(states: Map<string, QuarantineState>, observation: TestObservation) {
  const now = Date.parse(observation.at);
  for (const result of observation.tests) {
    const state = states.get(result.test) ?? { flakes: [], quarantined: false, consecutivePasses: 0 };
    state.flakes = state.flakes.filter(at => now - at <= 7 * 86400000);
    if (result.verdict === 'fixed') {
      state.flakes = [];
      state.quarantined = false;
      state.consecutivePasses = 0;
    } else if (result.verdict === 'passed') {
      state.consecutivePasses++;
      if (state.consecutivePasses >= 20) {
        state.quarantined = false;
        state.flakes = [];
      }
    } else {
      state.consecutivePasses = 0;
      if (
        result.verdict === 'flake' &&
        result.evidenceRunId &&
        ['unrelated-change', 'unchanged-source'].includes(result.recovery ?? '')
      ) {
        state.flakes.push(now);
        state.flakes = state.flakes.slice(-2);
        if (state.flakes.length >= 2) state.quarantined = true;
      }
    }
    if (state.quarantined || state.flakes.length) states.set(result.test, state);
    else states.delete(result.test);
  }
}
export const quarantineList = (states: Map<string, QuarantineState>) =>
  [...states]
    .filter(([, state]) => state.quarantined)
    .map(([test, state]) => ({ test, consecutivePasses: state.consecutivePasses }));

const snapshotSchema = z.object({
  revision: z.number().int().nonnegative().optional(),
  count: z.number().int().nonnegative(),
  pending: z.array(z.number().int().nonnegative()),
  fixes: z.array(z.string()),
  states: z.array(z.tuple([z.string(), stateSchema])),
});
function readSnapshot(store: WorkStore) {
  const path = join(store.directory, 'check-quarantine-ledger.json');
  let snapshot: z.infer<typeof snapshotSchema> = { count: 0, pending: [], fixes: [], states: [] };
  try {
    snapshot = snapshotSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return snapshot;
}
export const quarantineOverLimit = (store: WorkStore) =>
  readSnapshot(store).states.filter(([, state]) => state.quarantined).length > 10;

/** Incremental local projection. Clean checks write only their existing run receipt.
 * Metadata is paged by the record store; at most one run's test detail is hydrated at a time. */
export function quarantineHistory(store: WorkStore, fixes: TestObservation[], current?: TestObservation) {
  const path = join(store.directory, 'check-quarantine-ledger.json');
  let snapshot = readSnapshot(store);
  const tx = store.readRecords();
  const legacy = tx ? undefined : store.load().runs;
  const count = tx?.manifest.collections.runs?.count ?? legacy!.length;
  const revision = tx?.revision ?? store.revision?.();
  // An observation can pin older Work while another controller advances the cache.
  if (snapshot.count > count || (revision !== undefined && (snapshot.revision ?? 0) > revision))
    snapshot = { count: 0, pending: [], fixes: [], states: [] };
  const states = new Map(snapshot.states);
  const at = (i: number) => (tx ? tx.fieldsAt('runs', i).record : legacy![i]!);
  const pending: number[] = [];
  type Event = { at: string; id: string; position?: number; fix?: TestObservation };
  const events: Event[] = [],
    older: Event[] = [];
  let seed: { at: string; id: string; tests: { test: string; consecutivePasses: number }[] } | undefined;
  const positions = [...snapshot.pending];
  for (let i = snapshot.count; i < count; i++) positions.push(i);
  const cutoff = Date.parse(current?.at ?? new Date().toISOString()) - 7 * 86400000;
  for (const position of positions) {
    const run = at(position);
    if (run.id === current?.id || run.reusedFrom) continue;
    if (!run.endedAt || !['passed', 'failed'].includes(run.status)) {
      if (['queued', 'preparing', 'running'].includes(run.status)) pending.push(position);
      continue;
    }
    // Bootstrap reads a recent window, seeded by retained quarantine snapshots.
    if (!snapshot.count && Date.parse(run.endedAt) < cutoff) {
      older.push({ at: run.endedAt, id: run.id, position });
      if (
        run.backend?.quarantine !== undefined &&
        (!seed || run.endedAt > seed.at || (run.endedAt === seed.at && run.id > seed.id))
      )
        seed = { at: run.endedAt, id: run.id, tests: run.backend.quarantine };
      continue;
    }
    events.push({ at: run.endedAt, id: run.id, position });
  }
  if (seed) {
    for (const item of seed.tests)
      states.set(item.test, { flakes: [], quarantined: true, consecutivePasses: item.consecutivePasses });
    older.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
    for (const event of older) {
      if (!states.size) break;
      if (event.at < seed.at || (event.at === seed.at && event.id <= seed.id)) continue;
      const run = runDetails(store, at(event.position!));
      observeQuarantine(states, {
        id: event.id,
        at: event.at,
        tests: (run.backend?.testVerdicts ?? []).filter(item => states.has(item.test)),
      });
    }
  }
  for (const [test, state] of states)
    if (!state.quarantined) {
      state.flakes = state.flakes.filter(at => at >= cutoff);
      if (!state.flakes.length) states.delete(test);
    }
  for (const fix of fixes)
    if (!snapshot.fixes.includes(fix.id) && (!seed || fix.at > seed.at)) events.push({ ...fix, fix });
  if (current) events.push({ ...current, fix: current });
  events.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  let previousQuarantine = quarantineList(states);
  for (const event of events) {
    if (event.id === current?.id) previousQuarantine = quarantineList(states);
    const run = event.position === undefined ? undefined : runDetails(store, at(event.position));
    observeQuarantine(
      states,
      event.fix ?? { id: event.id, at: event.at, tests: run?.backend?.testVerdicts ?? [] },
    );
  }
  return {
    states,
    previousQuarantine,
    save() {
      durableReplace(
        path,
        JSON.stringify({ revision, count, pending, fixes: fixes.map(item => item.id), states: [...states] }),
      );
    },
  };
}
