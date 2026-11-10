// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { shellQuote } from './shell-quote.js';
import { actorLabel } from './agent-slug.js';
import { peerPhaseText, type PeerLanding } from './hosted-overlap-coordination.js';
import { owningPackage } from './hosted-coordination-client.js';
import { readHostedLaneCheckout } from './hosted-lane-checkout-marker.js';
import { hostedAgentRoot } from './hosted-agent-journal.js';

type Item = {
  noticeId: string;
  file: string;
  class?: 'blocking' | 'advisory';
  reason?: string;
  [extra: string]: unknown;
};
type Advice = {
  unacknowledgedOverlaps: { count: number | null; coverage: string; items: Item[] };
  stackOffer?: { command: string; text: string; mode: string; peerLaneId: string } | undefined;
};
/** The checkout's paths for naming each overlapping file's package; none outside a Lane checkout. */
function checkoutPaths(root: string): string[] {
  try {
    return readHostedLaneCheckout(hostedAgentRoot(root))?.state.files.map(file => file.path) ?? [];
  } catch {
    return [];
  }
}
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
  const paths = items.some(item => item.reason !== 'hot-file' && item.reason !== 'idle-lanes')
    ? checkoutPaths(root)
    : [];
  const offer = advice.stackOffer;
  return {
    required: items.some(item => item.class === 'blocking'),
    summary: `${count ?? items.length} file overlap(s) between this Lane and other open Lanes. Blocking notices need an answer before landing; advisory notices need no answer.`,
    count,
    coverage,
    items: items.map(item => ({
      noticeId: item.noticeId,
      class: item.class ?? 'advisory',
      reason: item.reason ?? 'unavailable',
      file: item.file,
      // D2: the package that owns the file, and where the peer's landing is (phase, ETA).
      ...(paths.length && owningPackage(paths, item.file) !== null
        ? { package: owningPackage(paths, item.file)! }
        : {}),
      ...(item.peerLanding !== undefined
        ? { peer: peerPhaseText(item.peerLanding as PeerLanding | null), peerLanding: item.peerLanding }
        : {}),
      with: ((item.participants ?? []) as Participant[]).filter(p => p.lane !== laneId),
      // A cross-file note names a symbol in another file: its text says what, `with` says who.
      // The idle-Lanes summary has no single peer: its text is the whole notice.
      ...(['cross-file-symbol', 'idle-lanes', 'hot-file', 'declared-scope'].includes(item.reason ?? '') &&
      typeof item.text === 'string'
        ? { note: item.text }
        : {}),
    })),
    choices,
    acknowledge: command(root, laneId, items, 'accept-order'),
    routeAround: command(root, laneId, items, 'split'),
    ...(offer ? { stack: { mode: offer.mode, text: offer.text, command: offer.command } } : {}),
  };
}
export type HostedOverlapNotice = NonNullable<ReturnType<typeof hostedOverlapNotice>>;

/** Missing range evidence means both Lanes changed this file and Forge cannot say where; the bare
 * code read as if the file or the peer were unknown (d730121f). */
const reasonLabel = (reason: string) =>
  reason === 'unavailable' ? 'same file; line ranges unknown' : reason;
/** Human banner for stderr; stdout stays one JSON receipt. One block per file, so a file three Lanes
 * touch is named once. An advisory notice is a single short summary; a blocking one stays complete. */
export function overlapBanner(notice: HostedOverlapNotice) {
  const byFile = new Map<string, typeof notice.items>();
  for (const item of notice.items)
    if (!item.note) byFile.set(item.file, [...(byFile.get(item.file) ?? []), item]);
  const summary = notice.required
    ? `${notice.count ?? notice.items.length} file overlap(s) between this Lane and other open Lanes. Blocking notices need an answer before landing; advisory notices need no answer.`
    : `${notice.count ?? notice.items.length} overlap(s) with other open Lanes; no answer needed.`;
  const lines = [
    '',
    notice.required ? '!!! OVERLAP NOTICE: ACTION REQUIRED !!!' : 'OVERLAP NOTICE: ADVISORY',
    summary,
    ...notice.items.flatMap(item => (item.note ? [`  - [advisory] ${item.note}`] : [])),
    ...[...byFile].flatMap(([file, items]) => [
      `  - [${items
        .map(item => item.class)
        .filter((v, i, all) => all.indexOf(v) === i)
        .join('/')}] ${file} (${reasonLabel(items[0]!.reason)})`,
      ...items.flatMap(item =>
        item.with.map(
          p =>
            `      also changed in Lane ${p.lane} by ${actorLabel(p.actor)}: ${p.intent}${item.peer ? ` (${item.peer})` : ''}`,
        ),
      ),
      ...(items[0]!.package ? [`      package: ${items[0]!.package}`] : []),
    ]),
    ...(notice.stack
      ? [
          `Stack (${notice.stack.mode}): ${notice.stack.text}`,
          ...(notice.stack.mode === 'offer' ? [`  ${notice.stack.command}`] : []),
        ]
      : []),
    ...(notice.count !== null && notice.count > notice.items.length
      ? [`  (${notice.count - notice.items.length} more; read Lane status for details)`]
      : []),
    ...(notice.required
      ? [
          'Acknowledge (keep your change, land in order):',
          `  ${notice.acknowledge}`,
          'Or route around (move off the file):',
          `  ${notice.routeAround}`,
        ]
      : []),
    '',
  ];
  return lines.join('\n');
}

const shown = new Set<string>();
/** A printed receipt's advisory notice is brief (receipt-slim: count and files, no items); a land
 * parent reads that receipt back from its detached child, so it may hold no items (c29d0780). */
const itemsOf = (notice: HostedOverlapNotice) => (Array.isArray(notice.items) ? notice.items : []);
/** The banner for notices this process has not printed yet, so an early print is never repeated at exit. */
/** A notice that turned blocking after it was printed as advisory is news: key by id and class. */
const shownKey = (item: HostedOverlapNotice['items'][number]) => `${item.noticeId}\0${item.class}`;
export function overlapBannerOnce(notice: HostedOverlapNotice) {
  const items = itemsOf(notice);
  const fresh = items.filter(item => !shown.has(shownKey(item)));
  for (const item of items) shown.add(shownKey(item));
  return fresh.length ? overlapBanner({ ...notice, items: fresh }) : '';
}
/** Record notices another path already printed (a relayed child process), without printing. */
export function markOverlapShown(notice: HostedOverlapNotice) {
  for (const item of itemsOf(notice)) shown.add(shownKey(item));
}
/** The banner for a refusal's own blocking notices (OVERLAP_UNANSWERED recovery), always printed:
 * an earlier banner in this process may have shown other or older notices (c8b842a9). */
export function refusalOverlapBanner(recovery: unknown) {
  const notice = (recovery as { overlapNotice?: HostedOverlapNotice } | undefined)?.overlapNotice;
  if (!notice || !itemsOf(notice).length) return '';
  markOverlapShown(notice);
  return overlapBanner(notice);
}
