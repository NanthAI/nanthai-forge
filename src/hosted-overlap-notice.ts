// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { shellQuote } from './agent-brief-render.js';

type Item = { noticeId: string; file: string; [extra: string]: unknown };
type Advice = { unacknowledgedOverlaps: { count: number | null; coverage: string; items: Item[] } };
type Participant = { lane: string; actor: string; intent: string };
const choices = {
  'accept-order': 'Keep your change; the peer Lane and yours will land in order.',
  swap: 'Ask the peer Lane to land first and sync before you finish.',
  split: 'Route around: move your edit off this file or into a separate Lane.',
};
/** Stable per Lane and notice, so repeating a printed command replays the same answer. */
export const answerId = (laneId: string, noticeId: string) => {
  const hex = createHash('sha256').update(`overlap-answer\0${laneId}\0${noticeId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const command = (root: string, laneId: string, items: Item[], choice: keyof typeof choices) =>
  `nforge agent ${shellQuote(root)} overlap-acks ${shellQuote(
    JSON.stringify({
      answers: items.map(item => ({
        operationId: answerId(laneId, item.noticeId),
        laneId,
        noticeId: item.noticeId,
        choice,
      })),
    }),
  )}`;

/** Structured, self-describing overlap notice for agents that read JSON receipts. Absent when nothing is pending. */
export function hostedOverlapNotice(root: string, laneId: string, advice: Advice) {
  const { items, count, coverage } = advice.unacknowledgedOverlaps;
  if (!items.length) return undefined;
  return {
    required: true as const,
    summary: `${count ?? items.length} file overlap(s) between this Lane and other open Lanes. Acknowledge, coordinate through the Lanes named here, or route around before you finish.`,
    count,
    coverage,
    items: items.map(item => ({
      noticeId: item.noticeId,
      file: item.file,
      with: ((item.participants ?? []) as Participant[]).filter(p => p.lane !== laneId),
    })),
    choices,
    acknowledge: command(root, laneId, items, 'accept-order'),
    routeAround: command(root, laneId, items, 'split'),
  };
}
export type HostedOverlapNotice = NonNullable<ReturnType<typeof hostedOverlapNotice>>;

/** Human banner for stderr; stdout stays one JSON receipt. */
export function overlapBanner(notice: HostedOverlapNotice) {
  const lines = [
    '',
    '!!! OVERLAP NOTICE: ACTION REQUIRED !!!',
    notice.summary,
    ...notice.items.flatMap(item => [
      `  - ${item.file}`,
      ...item.with.map(p => `      also changed in Lane ${p.lane} by ${p.actor}: ${p.intent}`),
    ]),
    ...(notice.count !== null && notice.count > notice.items.length
      ? [`  (${notice.count - notice.items.length} more; acknowledge these and read again)`]
      : []),
    'Acknowledge (keep your change, land in order):',
    `  ${notice.acknowledge}`,
    'Or route around (move off the file):',
    `  ${notice.routeAround}`,
    '',
  ];
  return lines.join('\n');
}
