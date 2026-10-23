// SPDX-License-Identifier: Apache-2.0
import { queueStatus, queueFacts, queueHref, type QueueFact } from '../cockpit/queue-model';
import type { ConflictNotice } from '../../../src/agent-conflict-notice';
import { checkMeaning } from '../cockpit/check-meaning';
import type { FeedItem } from '../cockpit/attention';
import type { CockpitWork } from '../cockpit/model';
export type TimelineEvent = FeedItem & { lane?: { id: string; name: string } };

/** Work evidence and the Lane feed share one chronological timeline, newest first. */
export function laneTimeline(
  records: CockpitWork,
  laneId: string,
  events: readonly FeedItem[] = [],
  includeMilestones = false,
  notices: readonly ConflictNotice[] = records.repairNotices ?? [],
  queue?: ReadonlyMap<string, QueueFact>,
): TimelineEvent[] {
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
    detail: [save.actor?.name && `by ${save.actor.name}`, save.message].filter(Boolean).join(' · '),
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
  const status = queue ? undefined : queueStatus(records);
  const fact = (queue ?? (status ? queueFacts(status, notices) : undefined))?.get(laneId);
  const submissionEvents = fact?.events ?? [];
  const repairs: FeedItem[] = notices
    .filter(notice => notice.participants.some(pin => pin.lane === laneId))
    .flatMap(notice => {
      const check = notice.evidence?.find(item => item.kind === 'check');
      if (!check || check.kind !== 'check') return [];
      const run = records.runs.find(run => run.id === check.runId);
      const historical = notice.applicability === 'historical';
      return [
        {
          id: `notice:${notice.noticeId}`,
          at: run?.endedAt ?? run?.startedAt ?? '',
          tone: historical
            ? 'stale'
            : check.cause === 'check-failed' || (!check.cause && check.status === 'failed')
              ? 'failed'
              : 'plain',
          glyph: historical ? 'stale' : 'check',
          historical,
          text: `Repair notice · ${run?.checkName ?? run?.check?.name ?? 'Check'} ${check.status} on Candidate ${check.viewId.slice(0, 8)}`,
          links: historical
            ? []
            : [
                {
                  href: queueHref({
                    kind: 'run',
                    id: check.runId,
                    viewId: check.viewId,
                    intentId: records.views.find(view => view.id === check.viewId)?.intentId,
                    label: 'Open run',
                  }),
                  label: 'Open run',
                },
                ...(notice.applicability === 'current' && notice.repairIntentId
                  ? [
                      {
                        href: queueHref({
                          kind: 'repair-intent',
                          id: notice.repairIntentId,
                          label: 'Repair in Lane',
                        }),
                        label: 'Repair in Lane',
                      },
                    ]
                  : []),
              ],
        },
      ];
    });
  return [
    ...submissionEvents,
    ...(includeMilestones ? repairs : []),
    ...saves.filter(save => !submissionEvents.some(event => event.glyph === 'sync' && event.at === save.at)),
    ...(includeMilestones && lane.lifecycle?.[0]?.at
      ? [
          {
            id: `started:${lane.id}`,
            at: lane.lifecycle[0].at,
            tone: 'plain' as const,
            glyph: 'claim' as const,
            text: 'Lane started',
            ...(lane.startedBy?.name ? { detail: `by ${lane.startedBy.name}` } : {}),
          },
        ]
      : []),
    ...(includeMilestones ? records.views : [])
      .filter(view => views.has(view.id))
      .map(view => ({
        id: `candidate:${view.id}`,
        at: view.at,
        tone: 'plain' as const,
        glyph: 'file' as const,
        text: 'Candidate composed',
      })),
    ...(includeMilestones ? (records.channelMoves ?? []) : [])
      .filter(
        move =>
          !submissionEvents.some(event => event.id === `move:${'id' in move ? move.id : ''}`) &&
          views.has(move.viewId) &&
          move.status === 'accepted' &&
          move.at,
      )
      .map(move => ({
        id: `accepted:${move.viewId}:${move.at}`,
        at: move.at!,
        tone: 'passed' as const,
        glyph: 'passed' as const,
        text: `Accepted on ${move.channel}`,
      })),
    ...(lane.lifecycle ?? []).flatMap((entry, index): FeedItem[] =>
      includeMilestones && index === 0 && entry.to === 'active'
        ? []
        : [
            {
              id: `lifecycle:${lane.id}:${index}`,
              at: entry.at,
              tone: 'plain',
              glyph: 'file',
              text:
                entry.to === 'completed'
                  ? 'Done'
                  : entry.to === 'active'
                    ? 'Reopened'
                    : entry.to.charAt(0).toUpperCase() + entry.to.slice(1),
              detail: [entry.actor?.name && `by ${entry.actor.name}`, entry.reason]
                .filter(Boolean)
                .join(' · '),
            },
          ],
    ),
    ...records.runs
      .filter(run => views.has(run.viewId) && !submissionEvents.some(event => event.id === `run:${run.id}`))
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
