// SPDX-License-Identifier: Apache-2.0
import { checkingWait } from './landing-waiting.js';
import { latestLandingProgress, landingStall } from './landing-stall.js';
import type { LandingEntry } from './landing-batch-types.js';
import type { WorkData } from './work-types.js';
export function entryProgress(
  data: Pick<WorkData, 'landingBatches' | 'runs' | 'channelMoves'>,
  entry: LandingEntry,
) {
  const batch = data.landingBatches?.find(batch => batch.id === entry.batchId);
  const runs = data.runs.filter(run => batch?.prefixes.some(prefix => prefix.runId === run.id));
  const waiting = entry.status === 'checking' ? checkingWait(data, entry) : entry.waitingFor;
  const step = entry.status === 'awaiting-review' ? 'review' : (waiting?.rule ?? 'unrecorded-wait');
  const owner = step === 'check' ? 'check runner' : step === 'review' ? 'reviewer' : 'landing controller';
  const at = latestLandingProgress([
    entry.arrivedAt,
    entry.firstSelectedAt,
    ...Object.values(batch?.timing ?? {}),
    ...(batch?.prefixes.map(prefix => prefix.reservedAt) ?? []),
    ...runs.flatMap(run => [run.startedAt, run.endedAt]),
    ...data.channelMoves
      .filter(
        move =>
          move.status === 'accepted' &&
          (move.id === entry.acceptanceId ||
            batch?.prefixes.some(
              prefix => prefix.entryIds.includes(entry.id) && prefix.viewId === move.viewId,
            )),
      )
      .map(move => move.at),
  ]);
  return { at, step, owner };
}
export function entryStall(data: Parameters<typeof entryProgress>[0], entry: LandingEntry, now = Date.now()) {
  if (!['queued', 'checking', 'awaiting-review'].includes(entry.status)) return undefined;
  const { at, step, owner } = entryProgress(data, entry);
  return landingStall(step, owner, at, now);
}
