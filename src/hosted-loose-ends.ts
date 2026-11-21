// SPDX-License-Identifier: Apache-2.0
import { heavySlots, readClientSettings } from './client-settings.js';
import { heavySlotDirectory, heavySlotHolders } from './heavy-slots.js';
import type { HostedAgentAddress } from './hosted-agent-contract.js';
import { hostedAgentRoot } from './hosted-agent-journal.js';
import { markerIdentity } from './lane-prune.js';
import { laneCommandRunning, readLaneEntry } from './lane-registry.js';
import { LOOSE_ENDS_ACTIVITY_MS, withLooseEndsHolders } from './lane-quiet.js';
import { isPlanningUuid } from './planning-id.js';

/** Like the heavy status command, only this machine can observe its slots and running commands. */
export function withLocalLooseEndsHolders(reply: unknown, { projectId, url }: HostedAgentAddress) {
  const result = reply as {
    groups?: Parameters<typeof withLooseEndsHolders>[0];
  } | null;
  if (!result?.groups?.stopped?.reported) return reply;
  const { groups } = result;
  const rows = [...(groups.idle?.reported ? groups.idle.rows : []), ...groups.stopped.rows];
  if (!rows.length) return reply;
  let slots: ReturnType<typeof heavySlotHolders> = [];
  try {
    slots = heavySlotHolders(
      heavySlotDirectory(),
      heavySlots(readClientSettings().localHeavySlots),
      undefined,
      folder => {
        // A resolution can take over the original Lane's folder. The checkout names its current Lane.
        const marker = folder && markerIdentity(hostedAgentRoot(folder));
        return marker && marker.projectId === projectId && marker.url === url ? marker.laneId : null;
      },
    );
  } catch {
    // The local slot registry is advisory. An unreadable registry cannot fail the hosted page.
  }
  const holders = new Map<string, string>();
  const recentFrom = Date.now() - LOOSE_ENDS_ACTIVITY_MS;
  for (const { laneId } of rows) {
    if (!isPlanningUuid(laneId)) continue;
    const slot = slots.find(slot => slot.lane === laneId);
    if (slot) {
      holders.set(laneId, `Local heavy slot ${slot.slot}${slot.command ? ` (${slot.command})` : ''}`);
      continue;
    }
    const entry = readLaneEntry(laneId);
    if (!entry || entry.state || entry.projectId !== projectId || entry.url !== url) continue;
    if (laneCommandRunning(entry))
      holders.set(
        laneId,
        entry.agent ? `@${entry.agent} (running a local command)` : 'Running a local command',
      );
    else if (entry.lastActionAt >= recentFrom)
      holders.set(laneId, entry.agent ? `@${entry.agent} (recent activity)` : 'Recent local activity');
  }
  return holders.size ? { ...result, groups: withLooseEndsHolders(groups, holders) } : reply;
}
