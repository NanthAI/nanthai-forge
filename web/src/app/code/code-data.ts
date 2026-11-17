// SPDX-License-Identifier: Apache-2.0
// The Code place's reads. History is one live page (it re-runs only when a landing is accepted) plus earlier pages
// read once on request. Source reads are actions on exact States, which never change, so each answer is kept for the
// visit and asking again costs nothing. No read waits on a timer, and an idle or hidden tab sends nothing.
import { useEffect, useState } from 'react';
import { useConvex, useQuery } from 'convex/react';
import { makeFunctionReference } from 'convex/server';
import type { Id } from '../../../../convex/_generated/dataModel';
import type { CodeHistoryRow } from '../../../../src/code-history';
import type { CodeChange, CodeDir } from '../../../../src/code-tree';
import { receiptWindow } from './code-words';

export type ProjectId = Id<'hostedProjects'>;
export type { CodeHistoryRow, CodeDir, CodeChange };
/** A text page of one file (16,000 characters), or a binary file's size. */
export type FilePage =
  | { kind: 'text'; text: string; offset: number; nextOffset: number | null; totalCharacters: number }
  | { kind: 'binary'; size: number };
export type CodeFile =
  | {
      available: true;
      path: string;
      blob: string | null;
      mode: string | null;
      page: FilePage | null;
      submodule?: unknown;
    }
  | { available: false; reason?: string };
export type Opened = {
  state: string;
  files?: number;
  kind?: 'dir' | 'file';
  dirs?: CodeDir[];
  file?: CodeFile;
  missing?: string;
  available?: false;
  reason?: string;
};
type Changes = { changes: CodeChange[]; total: number; available?: false; reason?: string };
export type LandingEvidence = {
  receiptId: string;
  laneId: string | null;
  intentId: string | null;
  submittedAt: string | null;
  committedAt: string | null;
};

const historyRef = makeFunctionReference<'query', { projectId: ProjectId; cursor: string | null }, string>(
  'projectCode:history',
);
const browseRef = makeFunctionReference<'action', Record<string, unknown>, string>('projectCodeBrowse:read');
const landingsRef = makeFunctionReference<
  'query',
  { projectId: ProjectId; from: string; to: string; limit?: number },
  string
>('projectHostedLandings:read');

/** Replies are JSON text; a refused read throws a structured error whose message is in the product's words. */
export const parseReply = <T>(text: string): T => JSON.parse(text) as T;
export function messageOf(error: unknown): string {
  const data = (error as { data?: { message?: unknown } })?.data;
  return typeof data?.message === 'string'
    ? data.message
    : 'The read did not finish. Your work is safe; try again.';
}

type History = { landings: CodeHistoryRow[]; nextCursor: string | null };
/** The newest page, live; then earlier pages appended in order. */
export function useHistory(projectId: ProjectId) {
  const client = useConvex();
  const first = useQuery(historyRef, { projectId, cursor: null });
  const [more, setMore] = useState<{
    rows: CodeHistoryRow[];
    next: string | null;
    loading: boolean;
    error: string;
  }>({
    rows: [],
    next: null,
    loading: false,
    error: '',
  });
  const head = first === undefined ? null : parseReply<History>(first);
  const seen = new Set(head?.landings.map(row => row.receiptId));
  const rows = [...(head?.landings ?? []), ...more.rows.filter(row => !seen.has(row.receiptId))];
  const next = more.rows.length ? more.next : (head?.nextCursor ?? null);
  const loadMore = () => {
    if (!next || more.loading) return;
    setMore(was => ({ ...was, loading: true, error: '' }));
    void client
      .query(historyRef, { projectId, cursor: next })
      .then(text => parseReply<History>(text))
      .then(
        page =>
          setMore(was => ({
            rows: [...was.rows, ...page.landings],
            next: page.nextCursor,
            loading: false,
            error: '',
          })),
        caught => setMore(was => ({ ...was, loading: false, error: messageOf(caught) })),
      );
  };
  return { loading: first === undefined, rows, next, loadMore, more };
}

const answers = new Map<string, Promise<unknown>>();
const ANSWERS_KEPT = 200;
/** One source read on an exact State, kept for the visit. A failed read is forgotten so Retry asks again. */
export function browse<T>(client: ReturnType<typeof useConvex>, args: Record<string, unknown>): Promise<T> {
  const key = JSON.stringify(args);
  let pending = answers.get(key) as Promise<T> | undefined;
  if (!pending) {
    pending = client.action(browseRef, args).then(text => parseReply<T>(text));
    answers.set(key, pending);
    pending.catch(() => answers.delete(key));
    if (answers.size > ANSWERS_KEPT) answers.delete(answers.keys().next().value!);
  }
  return pending;
}

type Async<T> = { value: T | null; error: string; loading: boolean };
/** Runs `read` when `key` changes (null: nothing to read). A refresh keeps the last value on screen. */
export function useRead<T>(key: string | null, read: () => Promise<T>, retry = 0): Async<T> {
  const [state, setState] = useState<Async<T>>({ value: null, error: '', loading: key !== null });
  useEffect(() => {
    if (key === null) return;
    let current = true;
    setState(was => ({ ...was, loading: true, error: '' }));
    read().then(
      value => current && setState({ value, error: '', loading: false }),
      caught => current && setState(was => ({ ...was, loading: false, error: messageOf(caught) })),
    );
    return () => {
      current = false;
    };
  }, [key, retry]);
  return state;
}

export function useChanges(projectId: ProjectId, row: CodeHistoryRow | null) {
  const client = useConvex();
  return useRead<Changes>(row ? `changes:${row.base}:${row.head}` : null, () =>
    browse<Changes>(client, { projectId, state: row!.head, base: row!.base, want: 'changes' }),
  );
}

/** The existing landings read (its owner: projectHostedLandings) for one receipt: when it was asked to land, its
 * Lane and Item. The window is the receipt's own time, never the clock. */
export function useEvidence(
  projectId: ProjectId,
  row: CodeHistoryRow | null,
): LandingEvidence | null | undefined {
  const window = row ? receiptWindow(row.at) : null;
  const text = useQuery(landingsRef, window ? { projectId, ...window, limit: 30 } : 'skip');
  if (!row) return null;
  if (text === undefined) return undefined;
  return (
    parseReply<{ landings: LandingEvidence[] }>(text).landings.find(l => l.receiptId === row.receiptId) ??
    null
  );
}
