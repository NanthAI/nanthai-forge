// SPDX-License-Identifier: Apache-2.0
import type { CockpitWork } from './model';
import type { DecisionItem, FeedItem } from './attention';
import { laneTimeline } from '../lane/timeline';
import type { AcceptedRow } from './now-model';

/** Open questions and handoffs have a single home in Needs you. History keeps completed events. */
export function activityItems(
  records: CockpitWork,
  accepted: readonly AcceptedRow[],
  decisions: readonly DecisionItem[],
  events: readonly FeedItem[] = [],
): FeedItem[] {
  const pending = new Set(decisions.flatMap(item => (item.messageId ? [item.messageId] : [])));
  const saved = records.lanes.flatMap(lane =>
    laneTimeline(records, lane.id).map(item => ({ ...item, laneId: lane.id })),
  );
  const seen = new Set<string>();
  return [
    ...saved,
    ...accepted.map((row): FeedItem => ({
      id: `accepted:${row.id}`,
      at: row.at,
      tone: 'passed',
      glyph: 'channel',
      text: `${row.title} · accepted into main`,
      ...(row.laneId ? { laneId: row.laneId } : {}),
      ...(row.by ? { detail: row.by } : {}),
    })),
    ...events.filter(item => !pending.has(item.id)),
  ]
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .filter(item => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
}
