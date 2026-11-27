// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The Code place's words for times, people, States and addresses. Pure, so the screens and their tests share them.
import type { CodeHistoryRow } from '../../../../src/code-history';
export { landedBy } from '../../../../src/code-history';
import { mainToday, sameUtcDay } from '../../../../src/flow-day';

/** `?at=` pins an exact State (a landing's, a Lane's or a Candidate's); without it the files follow main. */
export function pinnedState(search: string): string | null {
  const at = new URLSearchParams(search).get('at');
  return at && /^[a-f0-9]{64}$/.test(at) ? at : null;
}

/** Landings today for the sentence over History (Item 6bd1cf57): the live figure the top bar shows when the shell's feed
 * has one, else the listed rows on the UTC project day (a lower bound when more rows exist than were read). */
export function landedTodaySentence(
  rows: readonly Pick<CodeHistoryRow, 'at'>[],
  more: boolean,
  flow: unknown,
  now: number,
): { n: number; atLeast: boolean } {
  if (flow) return { n: mainToday(flow, now).landed, atLeast: false };
  const n = rows.filter(row => sameUtcDay(Date.parse(row.at), now)).length;
  return { n, atLeast: n === rows.length && more };
}

export const titleOf = (row: Pick<CodeHistoryRow, 'title' | 'head'>) =>
  row.title ?? `Landing ${short(row.head)}`;

/** What landed narrowed to one file: `?path=` (Item 3968a655), read verbatim (a file name may start with a space).
 * Anything else lists every landing. */
export function timelinePath(search: string): string | null {
  const path = new URLSearchParams(search).get('path') ?? '';
  return path && path.length <= 4096 ? path : null;
}
/** A path typed in the find field: edge spaces and a leading slash are typing, not part of the name. */
export const typedPath = (typed: string): string | null =>
  timelinePath(`?${new URLSearchParams({ path: typed.trim().replace(/^\/+/, '') })}`);
/** An address of What landed that keeps the path it is narrowed to. */
export const pathHref = (href: string, path: string | null) =>
  path ? `${href}?path=${encodeURIComponent(path).replace(/%2F/g, '/')}` : href;

export function selectedLine(hash: string): number | null {
  const match = /^#L(\d{1,7})$/.exec(hash);
  return match ? Number(match[1]) : null;
}

export const isMarkdown = (path: string) => /\.(md|markdown|mdown)$/i.test(path);

/** The landings-read window that holds one receipt: from just before its acceptance time to a minute after (the row
 * is written in the same transaction). Derived from the receipt, never from the clock. */
export function receiptWindow(iso: string): { from: string; to: string } | null {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  return { from: new Date(at - 1000).toISOString(), to: new Date(at + 60_000).toISOString() };
}

const minute = 60_000;
/** "09:58" today, "9 Nov" this year, "9 Nov 2025" before; the exact time is the title. */
export function landedAt(iso: string, now = Date.now()) {
  const at = new Date(iso);
  const today = new Date(now);
  if (at.toDateString() === today.toDateString())
    return at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return at.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(at.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  });
}
export function ago(iso: string, now = Date.now()) {
  const ms = Math.max(0, now - Date.parse(iso));
  if (ms < minute) return 'just now';
  if (ms < 60 * minute) return `${Math.round(ms / minute)} min ago`;
  if (ms < 24 * 60 * minute) return `${Math.round(ms / (60 * minute))} h ago`;
  const days = Math.round(ms / (24 * 60 * minute));
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}
/** "5 min 12 s" between two times; null when either is missing. */
export function between(from: string | null | undefined, to: string | null | undefined) {
  const ms = Date.parse(to ?? '') - Date.parse(from ?? '');
  if (!Number.isFinite(ms) || ms < 0) return null;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}
export const short = (state: string) => state.slice(0, 8);
export const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

/** The repository path a Markdown file's relative link or image names, read from the folder of the file that holds it:
 * `./a`, `../b` and a leading `/` (the repository root) resolve; a reference that climbs above the root, or names no
 * path, is null. A `?query` or `#fragment` is dropped. */
export function repoPathFrom(file: string, reference: string): string | null {
  let target: string;
  try {
    target = decodeURIComponent(reference.split(/[?#]/)[0] ?? '');
  } catch {
    return null;
  }
  if (!target) return null;
  const parts = target.startsWith('/') ? [] : file.split('/').slice(0, -1);
  for (const part of target.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (!parts.pop()) return null;
    } else parts.push(part);
  }
  return parts.length ? parts.join('/') : null;
}
