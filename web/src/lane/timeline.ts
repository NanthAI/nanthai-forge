// SPDX-License-Identifier: Apache-2.0
import { checkMeaning } from '../cockpit/check-meaning';
import type { FeedItem } from '../cockpit/attention';
import type { CockpitWork } from '../cockpit/model';
/** Work evidence and the Lane feed share one chronological timeline, newest first. */
export function laneTimeline(
  records: CockpitWork,
  laneId: string,
  events: readonly FeedItem[] = [],
): FeedItem[] {
  const lane = records.lanes.find(lane => lane.id === laneId);
  if (!lane) return [];
  const views = new Set(
    records.views.filter(view => view.inputs?.some(input => input.laneId === laneId)).map(view => view.id),
  );
  const saves = (lane.checkpoints ?? []).map((save, index): FeedItem => ({
    id: `save:${lane.id}:${index}`,
    at: save.at,
    tone: 'plain',
    glyph: 'file',
    text: 'Saved',
    detail: save.message,
  }));
  if (!saves.length && lane.lastCheckpointAt)
    saves.push({
      id: `save:${lane.id}:last`,
      at: lane.lastCheckpointAt,
      tone: 'plain',
      glyph: 'file',
      text: 'Saved',
      detail: lane.lastCheckpointMessage,
    });
  return [
    ...saves,
    ...(lane.lifecycle ?? []).map((entry, index): FeedItem => ({
      id: `lifecycle:${lane.id}:${index}`,
      at: entry.at,
      tone: 'plain',
      glyph: 'file',
      text: entry.to.charAt(0).toUpperCase() + entry.to.slice(1),
      detail: [entry.reason, entry.actor?.name].filter(Boolean).join(' · '),
    })),
    ...records.runs
      .filter(run => views.has(run.viewId))
      .map((run): FeedItem => {
        const state = checkMeaning(records, run.viewId, run.status);
        return {
          id: `run:${run.id}`,
          at: run.endedAt ?? run.startedAt ?? '',
          tone: state.tone === 'running' ? 'active' : state.tone,
          glyph: state.glyph === 'running' ? 'sync' : state.glyph === 'plain' ? 'check' : state.glyph,
          text:
            'laterViewId' in state
              ? state.label
              : `Check ${run.checkName ?? run.check?.name ?? ''} ${state.label.toLowerCase()}`,
          ...('laterViewId' in state ? { laterViewId: state.laterViewId } : {}),
        };
      }),
    ...events.map(event => ({
      ...event,
      text: event.text
        .replace(` · ${lane.name}`, '')
        .replace(` for ${lane.name}`, '')
        .replace(`handed off ${lane.name}`, 'handed off work')
        .replace(
          /^.*? · (returned source|saved|accepted into)/i,
          (_, action: string) => action.charAt(0).toUpperCase() + action.slice(1),
        ),
    })),
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}
