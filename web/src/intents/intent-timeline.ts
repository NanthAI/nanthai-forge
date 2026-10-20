// SPDX-License-Identifier: Apache-2.0
import type { CockpitWork } from '../cockpit/model';
import type { FeedItem } from '../cockpit/attention';
import { laneTimeline, type TimelineEvent } from '../lane/timeline';
import { eventContext, type ActivityEvent } from '../coordination-view';

/** A shared Candidate event belongs to the Intent; individual Lane events retain their origin. */
export function intentTimeline(
  records: Omit<CockpitWork, 'intents'> & {
    intents: readonly (CockpitWork['intents'][number] & {
      lifecycle?: readonly { to: string; at: string; reason?: string; actor?: { name: string } }[];
    })[];
  },
  intentId: string,
  events: readonly FeedItem[] = [],
): TimelineEvent[] {
  const intent = records.intents.find(item => item.id === intentId);
  if (!intent) return [];
  const lanes = records.lanes.filter(lane => lane.intentId === intentId);
  const merged = new Map<string, TimelineEvent>();
  for (const lane of lanes) {
    for (const event of laneTimeline(
      records,
      lane.id,
      events.filter(item => item.laneId === lane.id),
      true,
    )) {
      const previous = merged.get(event.id);
      if (previous) {
        const shared = { ...previous };
        delete shared.lane;
        merged.set(event.id, shared);
      } else merged.set(event.id, { ...event, lane: { id: lane.id, name: lane.name } });
    }
  }
  if (intent.createdAt)
    merged.set(`created:${intent.id}`, {
      id: `created:${intent.id}`,
      at: intent.createdAt,
      tone: 'plain',
      glyph: 'file',
      text: 'Created',
    });
  for (const [index, entry] of (intent.lifecycle ?? []).entries())
    merged.set(`intent:${intent.id}:${index}`, {
      id: `intent:${intent.id}:${index}`,
      at: entry.at,
      tone: 'plain',
      glyph: 'file',
      text:
        entry.to === 'completed'
          ? 'Done'
          : entry.to === 'active'
            ? 'Reopened'
            : entry.to === 'abandoned'
              ? 'Abandoned'
              : 'Ready',
      detail: [entry.reason, entry.actor?.name].filter(Boolean).join(' · '),
    });
  for (const event of events.filter(event => !event.laneId)) merged.set(event.id, event);
  return [...merged.values()].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}

/** Scope by the message's recorded context, including acknowledgements of Lane messages. */
export function intentEvents(records: CockpitWork, intentId: string, events: readonly ActivityEvent[]) {
  const lanes = new Set(records.lanes.filter(lane => lane.intentId === intentId).map(lane => lane.id));
  return events.filter(event => {
    const context = eventContext(event, [...events]);
    return context.laneId ? lanes.has(context.laneId) : context.intentId === intentId;
  });
}
