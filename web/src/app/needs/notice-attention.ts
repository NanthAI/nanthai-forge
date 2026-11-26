// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { ProjectPlace } from '../paths';
import type { NeedsRead, Notice } from './count';

type Destination = { place: ProjectPlace; section?: string; rest?: string; anchor?: string };
export type NoticeLink = { label: string; to: Destination };
export type AttentionNotice = Notice & {
  action: NoticeLink | null;
  links: readonly NoticeLink[];
};

// Let recovery and an in-flight fix run for an hour before asking the project owner to investigate.
const MAIN_FIX_WINDOW_MS = 60 * 60_000;
export const deployStatusId = (target: string) => `deploy-status-${target}`;

export function noticeAttention(read: NeedsRead, now: number) {
  const notices: AttentionNotice[] = [];
  let nextAt = Infinity;
  const due = (at: number | undefined) => {
    if (at === undefined || !Number.isFinite(at)) return false;
    if (at <= now) return true;
    nextAt = Math.min(nextAt, at);
    return false;
  };
  const moreDue =
    read.canDecide && read.noticesMoreSince !== undefined && due(read.noticesMoreSince + MAIN_FIX_WINDOW_MS);
  for (const notice of read.notices ?? []) {
    // Legacy deploy notices have been replaced by the deploy status read.
    if (notice.kind === 'deploy') continue;
    if (notice.kind === 'source-proof') {
      const action: NoticeLink = notice.laneId
        ? { label: 'Inspect the Lane', to: { place: 'lanes', rest: notice.laneId } }
        : { label: 'Inspect landing history', to: { place: 'lanes', section: 'history' } };
      notices.push({ ...notice, action, links: [] });
      continue;
    }
    if (notice.kind === 'needs-fix' || (notice.kind === 'reverted' && !notice.taken)) {
      const item = { place: 'plan' as const, rest: notice.id };
      const evidence = notice.receiptId ? { place: 'code' as const, rest: notice.receiptId } : item;
      const lane = notice.repair?.laneId ? { place: 'lanes' as const, rest: notice.repair.laneId } : null;
      const overdue =
        notice.kind === 'needs-fix' &&
        read.canDecide &&
        notice.since !== undefined &&
        due(notice.since + MAIN_FIX_WINDOW_MS);
      notices.push({
        ...notice,
        action: overdue
          ? lane
            ? { label: 'Investigate the Lane', to: lane }
            : { label: 'Investigate main', to: evidence }
          : null,
        links: [
          ...(lane ? [{ label: 'Open the Lane', to: lane }] : []),
          { label: 'Open the Item', to: item },
          ...(notice.receiptId ? [{ label: 'View the landing', to: evidence }] : []),
        ],
      });
      continue;
    }
    const action: NoticeLink | null = notice.taken
      ? { label: 'Open the Lane', to: { place: 'lanes', rest: notice.taken.laneId } }
      : notice.kind === 'mirror'
        ? { label: 'Open the mirror', to: { place: 'settings', section: 'mirror' } }
        : null;
    notices.push({ ...notice, action, links: [] });
  }
  for (const target of read.deployStatus?.targets ?? []) {
    const failure = target.failure;
    if (!failure) continue;
    const since = Date.parse(failure.since);
    const work = failure.work;
    const status = { place: 'needs' as const, anchor: deployStatusId(target.target) };
    const destination = work
      ? ({ place: work.kind === 'lane' ? 'lanes' : 'plan', rest: work.id } as const)
      : null;
    const overdue = due(
      failure.attentionAt ?? (work && read.canDecide ? since + failure.attentionMinutes * 60_000 : undefined),
    );
    notices.push({
      kind: 'deploy',
      id: target.target,
      version: failure.key,
      since,
      summary:
        overdue && !work
          ? `Find someone to look at the ${target.label} deploy in ${target.environment}.`
          : `The ${target.label} deploy in ${target.environment} failed.`,
      next: overdue ? `It has been failing for at least ${failure.attentionMinutes} minutes.` : null,
      ...(work ? { who: work.who } : {}),
      action: overdue
        ? {
            label: work ? `Investigate the ${work.kind === 'lane' ? 'Lane' : 'Item'}` : 'Investigate deploy',
            to: destination ?? status,
          }
        : null,
      links: [
        { label: 'View deploy status', to: status },
        ...(destination
          ? [{ label: work?.kind === 'lane' ? 'Open the Lane' : 'Open the Item', to: destination }]
          : []),
      ],
    });
  }
  if (read.secrets) {
    notices.push({
      kind: 'secrets',
      id: 'secrets',
      summary: `${read.secrets.toLocaleString()} ${read.secrets === 1 ? 'secret change waits' : 'secret changes wait'} on you.`,
      next: 'Each is done in a terminal; the Secrets page lists them.',
      action: { label: 'Open Secrets', to: { place: 'settings', section: 'secrets' } },
      links: [],
    });
  }
  return { notices, nextAt, moreDue };
}
