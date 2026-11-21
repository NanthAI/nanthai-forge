// SPDX-License-Identifier: Apache-2.0
// The Code place's reads. History is one live page (it re-runs only when a landing is accepted) plus earlier pages
// read once on request. Source reads are actions on exact States, which never change, so each answer is kept for the
// visit and asking again costs nothing. No read waits on a timer, and an idle or hidden tab sends nothing.
// A signed-out visitor of a public project (Item 4c164732) gets the same answers from the site's cached public read
// (VisitorCode below): one GET each, no Convex connection, no Lane or Item evidence.
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useConvex, useQuery } from 'convex/react';
import { makeFunctionReference } from 'convex/server';
import type { Id } from '../../../../convex/_generated/dataModel';
import { CODE_RECEIPT_ID, type CodeFileHistoryPage, type CodeHistoryRow } from '../../../../src/code-history';
import type { CodeChange, CodeDir } from '../../../../src/code-tree';
import { receiptWindow } from './code-words';
import { publicReadUrl } from '../../public/read';

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
  /** The folder whose subfolders this reply also lists. */
  ahead?: string;
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

const historyRef = makeFunctionReference<
  'query',
  { projectId: ProjectId; cursor: string | null; receiptId?: string },
  string
>('projectCode:history');
const browseRef = makeFunctionReference<'action', Record<string, unknown>, string>('projectCodeBrowse:read');
const fileHistoryRef = makeFunctionReference<
  'query',
  { projectId: ProjectId; path: string; before: number | null },
  string
>('projectCode:fileHistory');
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

/** The first page of a public project's code read (convex/publicCode.ts): the project, main's head and landings. */
export type VisitorHistory = {
  project: { id: string; handle: string; slug: string; name: string };
  main?: string | null;
  landings: CodeHistoryRow[];
  nextBefore: number | null;
};
/** Set by the public Code page: `base` is code/HANDLE/SLUG under the public read, `first` its first history page. */
type VisitorCode = { base: string; first: VisitorHistory };
export const VisitorCodeContext = createContext<VisitorCode | null>(null);

/** One cached public GET; a refusal reads like the members' error, in the product's words. */
async function visitorGet<T>(path: string): Promise<T> {
  const response = await fetch(publicReadUrl(path), {
    credentials: 'omit',
    headers: { accept: 'application/json' },
  });
  const type = response.headers.get('content-type') ?? '';
  const body = type.includes('json') ? ((await response.json()) as T & { message?: unknown }) : null;
  if (response.ok && body) return body;
  const message =
    response.status === 404
      ? 'No public project at this address.'
      : typeof body?.message === 'string'
        ? body.message
        : 'The read did not finish; try again.';
  throw Object.assign(new Error(message), { data: { message } });
}
const hex = (path: string) =>
  path
    ? Array.from(new TextEncoder().encode(path), byte => byte.toString(16).padStart(2, '0')).join('')
    : '-';
/** A source read's public address: every argument in the path (convex/publicCode.ts). */
function visitorPath(base: string, args: Record<string, unknown>): string {
  const state = String(args.state);
  const path = hex(String(args.path ?? ''));
  switch (args.want) {
    case 'more':
      return `${base}/${state}/more/${path}/${Number(args.cursor ?? 0)}.json`;
    case 'page':
      return `${base}/${state}/page/${path}/${Number(args.offset ?? 0)}.json`;
    case 'changes':
      return `${base}/${state}/changes/${String(args.base)}.json`;
    default:
      return `${base}/${state}/open/${path}.json`;
  }
}

/** Who answers source reads on this page: the members' action, or the visitor's cached GET. */
type Reader = { key: string; ask: (args: Record<string, unknown>) => Promise<string> };
export function useReader(): Reader {
  const client = useConvex();
  const visitor = useContext(VisitorCodeContext);
  return useMemo<Reader>(
    () =>
      visitor
        ? {
            key: visitor.base,
            ask: args =>
              visitorGet<unknown>(visitorPath(visitor.base, args)).then(body => JSON.stringify(body)),
          }
        : { key: '', ask: args => client.action(browseRef, args) },
    [client, visitor],
  );
}

/** Landing metadata includes viewer-specific identities. Each mount reads with current access. */
export function useFileHistoryReader(projectId: ProjectId, path: string) {
  const client = useConvex();
  const visitor = useContext(VisitorCodeContext);
  return (before: number | null): Promise<CodeFileHistoryPage> =>
    visitor
      ? visitorGet(`${visitor.base}/file-history/${hex(path)}/${before ?? '-'}.json`)
      : client.query(fileHistoryRef, { projectId, path, before }).then(parseReply<CodeFileHistoryPage>);
}

type History = { landings: CodeHistoryRow[]; nextCursor: string | null };
const fromVisitor = (page: VisitorHistory): History => ({
  landings: page.landings,
  nextCursor: page.nextBefore === null ? null : String(page.nextBefore),
});
/** The newest page, live (a visitor's is the cached first page); then earlier pages appended in order. */
export function useHistory(projectId: ProjectId) {
  const client = useConvex();
  const visitor = useContext(VisitorCodeContext);
  const live = useQuery(historyRef, visitor ? 'skip' : { projectId, cursor: null });
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
  const head = visitor ? fromVisitor(visitor.first) : live === undefined ? null : parseReply<History>(live);
  const seen = new Set(head?.landings.map(row => row.receiptId));
  const rows = [...(head?.landings ?? []), ...more.rows.filter(row => !seen.has(row.receiptId))];
  const next = more.rows.length ? more.next : (head?.nextCursor ?? null);
  const loadMore = () => {
    if (!next || more.loading) return;
    setMore(was => ({ ...was, loading: true, error: '' }));
    const earlier = visitor
      ? visitorGet<VisitorHistory>(`${visitor.base}/history/${next}.json`).then(fromVisitor)
      : client.query(historyRef, { projectId, cursor: next }).then(text => parseReply<History>(text));
    void earlier.then(
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
  return { loading: head === null, rows, next, loadMore, more };
}

const answers = new Map<string, Promise<unknown>>();
const ANSWERS_KEPT = 200;
/** One source read on an exact State, kept for the visit. A failed read is forgotten so Retry asks again. */
export function browse<T>(reader: Reader, args: Record<string, unknown>): Promise<T> {
  const key = reader.key + JSON.stringify(args);
  let pending = answers.get(key) as Promise<T> | undefined;
  if (!pending) {
    pending = reader.ask(args).then(text => parseReply<T>(text));
    answers.set(key, pending);
    pending.catch(() => answers.delete(key));
    if (answers.size > ANSWERS_KEPT) answers.delete(answers.keys().next().value!);
  }
  return pending;
}

type Async<T> = { value: T | null; error: string; loading: boolean };
/** Runs `read` when `key` changes (null: nothing to read). A refresh keeps the last value on screen. */
export function useRead<T>(key: string | null, read: () => Promise<T>, retry = 0): Async<T> {
  const [state, setState] = useState<Async<T> & { key: string | null }>({
    key,
    value: null,
    error: '',
    loading: key !== null,
  });
  useEffect(() => {
    if (key === null) return;
    let current = true;
    setState(was => ({ key, value: was.key === key ? was.value : null, loading: true, error: '' }));
    read().then(
      value => current && setState({ key, value, error: '', loading: false }),
      caught => current && setState(was => ({ ...was, loading: false, error: messageOf(caught) })),
    );
    return () => {
      current = false;
    };
  }, [key, retry]);
  return state.key === key ? state : { value: null, error: '', loading: key !== null };
}

export function useChanges(projectId: ProjectId, row: CodeHistoryRow | null) {
  const reader = useReader();
  return useRead<Changes>(row ? `changes:${row.base}:${row.head}` : null, () =>
    browse<Changes>(reader, { projectId, state: row!.head, base: row!.base, want: 'changes' }),
  );
}

/** A receipt outside the loaded list needs one exact read, not a scan of earlier pages. */
export function useCodeReceipt(projectId: ProjectId, receiptId: string, retry: number) {
  const client = useConvex();
  const visitor = useContext(VisitorCodeContext);
  return useRead<Pick<History, 'landings'>>(
    CODE_RECEIPT_ID.test(receiptId) ? `${projectId}:${receiptId}` : null,
    () =>
      visitor
        ? visitorGet(`${visitor.base}/history/${receiptId}.json`)
        : client
            .query(historyRef, { projectId, cursor: null, receiptId })
            .then(parseReply<Pick<History, 'landings'>>),
    retry,
  );
}

/** The existing landings read (its owner: projectHostedLandings) for one receipt: when it was asked to land, its
 * Lane and Item. The window is the receipt's own time, never the clock. Visitors get none: Lanes and Items are not
 * theirs to open here. */
export function useEvidence(
  projectId: ProjectId,
  row: CodeHistoryRow | null,
): LandingEvidence | null | undefined {
  const visitor = useContext(VisitorCodeContext);
  const window = row && !visitor ? receiptWindow(row.at) : null;
  const text = useQuery(landingsRef, window ? { projectId, ...window, limit: 30 } : 'skip');
  if (!row || visitor) return null;
  if (text === undefined) return undefined;
  return (
    parseReply<{ landings: LandingEvidence[] }>(text).landings.find(l => l.receiptId === row.receiptId) ??
    null
  );
}
