// SPDX-License-Identifier: Apache-2.0
import type { PendingStatus } from './pending-status.js';
const pin = (head: string | null) => head?.slice(0, 12) ?? 'unknown';
const elapsed = (ms: number | null) => (ms === null ? 'unknown' : `${Math.floor(ms / 60_000)}m`);
const oneLine = (value: string) => value.replace(/[\r\n\t\x00-\x1f\x7f]/g, ' ');
export function formatPendingStatus(value: PendingStatus) {
  const h = value.hosted,
    r = h.recovery;
  const examples = value.lanes
    .filter(lane => ['ready', 'waiting', 'checking'].includes(lane.status))
    .slice(0, 3)
    .map(lane => `${lane.status} ${lane.laneId.slice(0, 8)} ${oneLine(lane.name).slice(0, 70)}`);
  return [
    `Pending work · revision ${value.snapshot.workRevision} · ${value.snapshot.observedAt}`,
    `Main: ${pin(value.main.head)}`,
    `Lanes: ${value.counts.ready} ready · ${value.counts.waiting} waiting · ${value.counts.checking} checking (recorded states)`,
    ...examples,
    ...value.lanes
      .filter(lane => lane.handoff)
      .map(
        lane =>
          `Handoff ${lane.laneId.slice(0, 8)}: ${oneLine(lane.handoff!.summary)} · ${lane.handoff!.tests.commands} self-reported commands · ${lane.handoff!.recordedChecks.length} Forge-recorded checks · handoff-read {laneId:${lane.laneId}}`,
      ),
    `Hosted main: ${pin(h.mainHead)} · ${h.source} · capture age ${elapsed(h.captureAgeMs)}`,
    `Recovery: ${r?.captureId ?? 'unknown'} · history ${r?.completeHistory == null ? 'unknown' : r.completeHistory ? 'complete' : 'incomplete'} · unavailable ${r?.unavailable?.length ?? 'unknown'}`,
    `Pending: Work ${h.work} · evidence ${h.evidence} · age ${elapsed(h.pendingAgeMs)}`,
    `Transfers: ${h.pendingPushes.length} pending · ${h.metadataPending} metadata (source coverage separate)`,
    `GitHub main: ${pin(value.github.mainHead)} · ${value.github.source} · ${value.github.status} · age ${elapsed(value.github.ageMs)}`,
    `Checks: ${value.checks.length} queued/preparing/running (process liveness unknown)`,
    `Audits: ${value.audits.filter(a => ['pending', 'queued', 'preparing', 'running'].includes(a.status)).length} pending · ${value.audits.filter(a => a.status === 'failed').length} failed`,
    `Deployment: ${pin(value.deployment?.head ?? null)} · ${value.deployment?.source ?? 'unknown'} (last observation); installed source unknown`,
  ].join('\n');
}
