// SPDX-License-Identifier: Apache-2.0
import { ForgeError } from './errors.js';
import type { NativeSource } from './native-source.js';
import type { WorkData } from './work-types.js';

export function staleLandingResult(error: unknown) {
  if (!(error instanceof ForgeError) || !['LANE_STALE', 'COMPOSITION_STALE'].includes(error.code)) return;
  return {
    status: 'interrupted' as const,
    code: error.code,
    message: `${error.message} Resubmit at current head.`,
    next: 'resubmit at current head',
  };
}

/** A new save supersedes observations, not a resolvable submitted Candidate.
 * Only unresolved unstarted inputs end here; checks/receipts keep their pins. */
export function interruptStaleLandingInputs(data: WorkData, channel: string, source: NativeSource) {
  const unstarted = new Set(
    (data.landingBatches ?? [])
      .filter(
        batch =>
          batch.channel === channel &&
          ['composing', 'checking'].includes(batch.status) &&
          batch.prefixes.every(
            prefix =>
              !data.runs.some(run => run.id === prefix.runId) &&
              !data.channelMoves.some(move => move.viewId === prefix.viewId && move.status === 'accepted'),
          ),
      )
      .map(batch => batch.id),
  );
  const superseded = new Set<string>();
  for (const entry of data.landingEntries ?? []) {
    const batch = data.landingBatches?.find(batch => batch.id === entry.batchId);
    if (
      entry.channel !== channel ||
      !(
        entry.status === 'queued' ||
        (entry.status === 'checking' && entry.batchId && unstarted.has(entry.batchId))
      )
    )
      continue;
    const view = data.views.find(view => view.id === entry.viewId);
    const changed = view?.inputs.filter(
      pin => data.lanes.find(lane => lane.id === pin.laneId)?.head !== pin.head,
    );
    if (!changed?.length) continue;
    const unresolved = changed.filter(pin => {
      if (!data.lanes.some(lane => lane.id === pin.laneId && lane.intentId === view!.intentId)) return true;
      try {
        // Saved Candidates are composed/retargeted from their immutable source,
        // even when a later checkpoint changes the live Lane and predictions.
        source.state(pin.head);
        return false;
      } catch (error) {
        if (!(error instanceof ForgeError) || error.code !== 'INVALID_NATIVE_SOURCE') throw error;
        return true;
      }
    });
    if (!unresolved.length) continue;
    const result = staleLandingResult(
      new ForgeError(
        'LANE_STALE',
        `Queued landing ${entry.id} cannot resolve saved input Lane(s): ${unresolved.map(pin => pin.laneId).join(', ')}.`,
      ),
    )!;
    entry.status = result.status;
    entry.terminalAt = new Date().toISOString();
    entry.error = { code: result.code, message: result.message };
    entry.reason = result.message;
    if (batch && unstarted.has(batch.id)) {
      batch.status = 'superseded';
      superseded.add(batch.id);
    }
  }
  for (const entry of data.landingEntries ?? [])
    if (
      entry.channel === channel &&
      entry.status === 'checking' &&
      entry.batchId &&
      superseded.has(entry.batchId)
    )
      entry.status = 'queued';
}
