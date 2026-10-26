import { landingPositions, prepareLandingRecords } from './landing-records-index.js';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { assertLandingWorkerActive } from './landing-worker-context.js';
// SPDX-License-Identifier: Apache-2.0
import { optimisticLanding } from './autonomy-policy.js';
import { readPolicy } from './work-autonomy.js';
import { completeAccepted } from './agent-lifecycle.js';
import { composeLandingSource, savedStack } from './landing-compose-source.js';
import type { NativeSource } from './native-source.js';
import type { WorkService } from './work.js';
import type { WorkData } from './work-types.js';
import type { LandingEntry } from './landing-batch-types.js';

const undo = 'Reopen the Lane and finish again if it still has work to land.';
/** State metadata and merge parents are not source changes. */
export const sameLandingTree = (source: NativeSource, left: string, right: string) =>
  left === right || source.tree(source.state(left).files) === source.tree(source.state(right).files);
/** Exact Lane/head pins of an entry; equal keys are the same submitted source. */
export const entryPins = (data: WorkData, entry: LandingEntry) =>
  JSON.stringify(
    (data.views.find(view => view.id === entry.viewId)?.inputs ?? [])
      .map(pin => `${pin.laneId}:${pin.head}`)
      .sort(),
  );
/** Content already on main lands without a check, an acceptance or a Channel move. */
export function markAlreadyOnMain(entry: LandingEntry, main: string) {
  entry.status = 'accepted';
  entry.alreadyOnMain = main;
  entry.terminalAt = new Date().toISOString();
  entry.reason = `Already on main at ${main}; no check, acceptance or Channel move was needed.`;
}
/** Under the Work lock, before selection: saves known to predate completion
 * never run. Contained content is reported as landed; anything else is dropped
 * with an explicit reason and undo. Newer saves retain ordinary landing. */
export function settleCompletedLanes(
  work: WorkService,
  data: WorkData,
  channel: string,
  main: string | null,
  source: NativeSource,
) {
  for (const entry of data.landingEntries ?? []) {
    if (entry.channel !== channel || entry.status !== 'queued') continue;
    const candidate = data.views.find(view => view.id === entry.viewId);
    if (candidate?.status !== 'clean' || candidate.head !== entry.head) continue;
    const inputs = candidate.inputs;
    if (
      !inputs.length ||
      !inputs.every(pin => {
        const lane = data.lanes.find(lane => lane.id === pin.laneId);
        if (lane?.state !== 'completed') return false;
        const completed = [...(lane.lifecycle ?? [])].reverse().find(event => event.to === 'completed');
        const saved = [...lane.checkpoints].reverse().find(checkpoint => checkpoint.head === pin.head);
        // A later save is new work, even when completion metadata is unchanged.
        // Missing lifecycle timing cannot prove that a submitted save is stale.
        return completed && (!saved || saved.at < completed.at);
      })
    )
      continue;
    const result =
      main && composeLandingSource(work.store, source, candidate, main, 'Contained landing', entry.arrivedAt);
    if (main && result && result.head && sameLandingTree(source, result.head, main)) {
      markAlreadyOnMain(entry, main);
      continue;
    }
    entry.status = 'cancelled';
    entry.terminalAt = new Date().toISOString();
    entry.reason = `Every input Lane was completed before this landing ran, and its content is not on ${channel}; nothing landed. ${undo}`;
  }
}
/** Retain one composition verdict per live entry. Source objects are immutable;
 * ordinary entries depend on exact View/main and saved stack pins. Stacked
 * composition also consults parent/acceptance/no-op evidence, so its collection
 * versions conservatively invalidate that verdict when such evidence changes. */
const noopCompositions = new WeakMap<
  WorkService['store'],
  Map<string, { key: string; contained: boolean }>
>();
/** Reconcile queued no-ops before overlap/capacity selection, even while another
 * batch owns the train. Canonical main content takes precedence over a later save. */
export function settleQueuedNoops(work: WorkService, data: WorkData, channel: string, source: NativeSource) {
  const main =
    [...data.channelMoves].reverse().find(move => move.channel === channel && move.status === 'accepted')
      ?.head ?? data.nativeHead;
  let memo = noopCompositions.get(work.store);
  if (!memo) noopCompositions.set(work.store, (memo = new Map()));
  const queued = new Set(
    (data.landingEntries ?? []).filter(entry => entry.status === 'queued').map(entry => entry.id),
  );
  for (const id of memo.keys()) if (!queued.has(id)) memo.delete(id);
  for (const entry of data.landingEntries ?? []) {
    if (entry.channel !== channel || entry.status !== 'queued') continue;
    const candidate = data.views.find(view => view.id === entry.viewId);
    if (!main || candidate?.status !== 'clean' || candidate.head !== entry.head) continue;
    const stacks = candidate.inputs.map(pin => {
      const lane = work.store.select('lanes', pin.laneId);
      return lane ? savedStack(lane, pin.head) : undefined;
    });
    let evidence: unknown;
    if (stacks.some(stack => stack && !stack.detached)) {
      const tx = work.store.readRecords();
      try {
        evidence = tx
          ? (['lanes', 'views', 'channelMoves', 'landingEntries'] as const).map(
              name => tx.manifest.collections[name],
            )
          : work.store.load();
      } finally {
        tx?.dispose();
      }
    }
    const key = JSON.stringify([main, entry.head, candidate, stacks, evidence]);
    let cached = memo.get(entry.id);
    if (cached?.key !== key) {
      const result = composeLandingSource(
        work.store,
        source,
        candidate,
        main,
        'No-op landing',
        entry.arrivedAt,
      );
      cached = { key, contained: !!result.head && sameLandingTree(source, result.head, main) };
      memo.set(entry.id, cached);
    }
    if (cached.contained) {
      markAlreadyOnMain(entry, main);
      if (sameLandingTree(source, candidate.head!, candidate.base))
        entry.reason = `Empty against base; source is already on main at ${main}; no check, acceptance or Channel move was needed.`;
      delete entry.waitingFor;
      continue;
    }
    const newer = candidate.inputs.flatMap(pin => {
      const lane = data.lanes.find(lane => lane.id === pin.laneId);
      return lane && lane.head !== pin.head ? [{ laneId: pin.laneId, head: lane.head }] : [];
    });
    if (!newer.length) continue;
    entry.status = 'interrupted';
    entry.terminalAt = new Date().toISOString();
    entry.error = {
      code: 'LANDING_SUPERSEDED',
      message: `Desired head superseded by ${newer.map(pin => `Lane ${pin.laneId} head ${pin.head}`).join(', ')}. Original source is retained; submit the newer head to land it.`,
    };
    entry.reason = entry.error.message;
    delete entry.waitingFor;
  }
}
/** Complete the Lanes of entries that were already on main, as acceptance would.
 * Retry-safe: completion of an already completed Lane is a no-op. */
export async function completeAlreadyOnMain(work: WorkService, channel: string) {
  const policy = readPolicy(work.store);
  if (optimisticLanding(policy) || !policy.lifecycle.completeOnAccept) return;
  const tx = work.store.readRecords();
  if (tx) await prepareLandingRecords(work.store, tx);
  const entries = tx
    ? landingPositions(work.store, tx, 'landingEntries', [], channel, true)
    : (work.store.load().landingEntries ?? []).map(entry => entry.id);
  let turn = performance.now();
  try {
    for (const position of entries) {
      assertLandingWorkerActive();
      const entry =
        typeof position === 'number' && tx
          ? tx.at('landingEntries', position)
          : work.store.select('landingEntries', String(position));
      if (!entry || entry.channel !== channel || !entry.alreadyOnMain || entry.keepOpen) continue;
      const view = tx ? tx.find('views', entry.viewId)?.record : work.store.select('views', entry.viewId);
      if (
        view?.inputs.some(pin => {
          const lane = tx ? tx.fields('lanes', pin.laneId)?.record : work.store.select('lanes', pin.laneId);
          return lane && lane.head === pin.head && ['active', 'paused', 'ready'].includes(lane.state);
        })
      )
        await completeAccepted(work, entry.viewId);
      if (performance.now() - turn >= 8) {
        await yieldTurn();
        turn = performance.now();
      }
    }
  } finally {
    tx?.dispose();
  }
}
