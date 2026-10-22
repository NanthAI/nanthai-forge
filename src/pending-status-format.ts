// SPDX-License-Identifier: Apache-2.0
import type { PendingStatus } from './pending-status.js';
const pin = (head: string | null) => head?.slice(0, 12) ?? 'unknown';
const elapsed = (ms: number | null) => (ms === null ? 'unknown' : `${Math.floor(ms / 60_000)}m`);
const oneLine = (value: string) => value.replace(/[\r\n\t\x00-\x1f\x7f]/g, ' ');
export function formatPendingStatus(value: PendingStatus) {
  const h = value.hosted,
    r = h.recovery;
  const handoffs = value.lanes.filter(lane => lane.handoff);
  const handoff = handoffs[0];
  const stacks = value.lanes.filter(lane => lane.stack);
  const groups = value.overlap.groups;
  const examples = value.lanes
    .filter(lane => ['ready', 'waiting', 'checking'].includes(lane.status))
    .map(lane => `${lane.status} ${lane.laneId.slice(0, 8)} ${oneLine(lane.name).slice(0, 70)}`);
  const lines = [
    `Pending work · revision ${value.snapshot.workRevision} · ${value.snapshot.observedAt}`,
    `Main: ${pin(value.main.head)}${value.integrationPreview ? ` · Integration preview: ${oneLine(value.integrationPreview)}` : ''}`,
    `Lanes: ${value.counts.ready} ready · ${value.counts.waiting} waiting · ${value.counts.checking} checking (recorded states)`,
    ...(handoff
      ? [
          handoffs.length === 1
            ? `Handoff ${handoff.laneId.slice(0, 8)}: ${oneLine(handoff.handoff!.summary)} · ${handoff.handoff!.tests.commands} self-reported commands · ${handoff.handoff!.recordedChecks.length} Forge-recorded checks · handoff-read {laneId:${handoff.laneId}}`
            : `Handoffs: ${handoffs.length} Lanes · ${handoffs.reduce((n, lane) => n + lane.handoff!.tests.commands, 0)} self-reported commands · ${handoffs.reduce((n, lane) => n + lane.handoff!.recordedChecks.length, 0)} Forge-recorded checks · see --json and handoff-read`,
        ]
      : []),
    ...(stacks.length
      ? [
          stacks.length === 1
            ? `Stack: ${stacks[0]!.stack!.summary}`
            : `Stacks: ${stacks.length} Lanes · see peers`,
        ]
      : []),
    `Overlap: ${groups.length === 1 ? `${groups[0]!.paths.map(oneLine).join(', ')} · land ${groups[0]!.order.map(id => id.slice(0, 8)).join(' → ')}; compose each on accepted main` : `${groups.length} groups${groups.length ? ' · see --json and peers for paths and landing order' : ''}`} · coverage ${value.overlap.coverage}`,
    `Hosted main: ${pin(h.mainHead)} · ${h.source} · capture age ${elapsed(h.captureAgeMs)}`,
    `Recovery: ${r?.captureId ?? 'unknown'} · history ${r?.completeHistory == null ? 'unknown' : r.completeHistory ? 'complete' : 'incomplete'} · unavailable ${r?.unavailable?.length ?? 'unknown'}`,
    `Pending: Work ${h.work} · evidence ${h.evidence} · age ${elapsed(h.pendingAgeMs)}`,
    `Transfers: ${h.pendingPushes.length} pending · ${h.metadataPending} metadata (source coverage separate)`,
    `Automatic hosted push: ${h.autoExchange?.status ?? 'unknown'} · spend ${h.autoExchange?.spend.availability ?? 'unknown'} · ${h.autoExchange?.spend.reason ?? 'unavailable'} · rolling delta USD ${h.autoExchange?.spend.deltaUsd ?? 'unknown'}${h.autoExchange?.status === 'paused' ? ` · ${h.autoExchange.resume}` : ''}`,
    `GitHub main: ${pin(value.github.mainHead)} · ${value.github.source} · ${value.github.status} · age ${elapsed(value.github.ageMs)}`,
    `Checks: ${value.checks.length} queued/preparing/running (process liveness unknown)`,
    `Audits: ${value.audits.filter(a => ['pending', 'queued', 'preparing', 'running'].includes(a.status)).length} pending · ${value.audits.filter(a => a.status === 'failed').length} failed`,
    `Deployment: ${pin(value.deployment?.head ?? null)} · ${value.deployment?.source ?? 'unknown'} (last observation); installed source unknown`,
  ];
  // Delivery and overlap summaries share the compact view's existing line budget.
  lines.splice(3, 0, ...examples.slice(0, Math.min(3, Math.max(0, 15 - lines.length))));
  return lines.join('\n');
}
