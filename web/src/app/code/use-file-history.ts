// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// One file's landings (Item 3968a655): projectCode:fileHistory, one bounded read per step back and no subscription.
// A signed-out visitor of a public project reads the same pages from the site's cached public read.
import { useContext, useEffect, useReducer, useRef } from 'react';
import { useConvex } from 'convex/react';
import { makeFunctionReference } from 'convex/server';
import type { CodeFileHistoryPage, CodeHistoryRow } from '../../../../src/code-history';
import { VisitorCodeContext, hex, messageOf, parseReply, visitorGet, type ProjectId } from './code-data';

const fileHistoryRef = makeFunctionReference<
  'query',
  { projectId: ProjectId; path: string; before: number | null },
  string
>('projectCode:fileHistory');

/** Landing metadata includes viewer-specific identities. Each mount reads with current access. */
function useFileHistoryReader(projectId: ProjectId) {
  const client = useConvex();
  const visitor = useContext(VisitorCodeContext);
  return (path: string, before: number | null): Promise<CodeFileHistoryPage> =>
    visitor
      ? visitorGet(`${visitor.base}/file-history/${hex(path)}/${before ?? '-'}.json`)
      : client.query(fileHistoryRef, { projectId, path, before }).then(parseReply<CodeFileHistoryPage>);
}

/** The landings that touched one file, as far back as the reader has asked: one bounded read per step. */
export type FileHistoryView = {
  rows: CodeHistoryRow[];
  /** Examined receipts whose changed paths were not kept, so whether they touched the file is unknown. */
  missing: number;
  /** Receipts examined in all; null when a page did not say. */
  scanned: number | null;
  /** Where the next step starts; null at the first landing. */
  next: number | null;
  loading: boolean;
  /** The first step failed: nothing to show. */
  error: string;
  /** A later step is being read, or failed with the rows read so far kept. */
  busy: boolean;
  moreError: string;
  /** When the last step was read. */
  readAt: number | null;
  loadMore: () => void;
  retry: () => void;
};
type FileHistoryEntry = {
  pages: CodeFileHistoryPage[];
  error: string;
  busy: boolean;
  moreError: string;
  readAt: number | null;
  /** Which entry a read belongs to: a reply whose entry was evicted or replaced meanwhile is dropped. */
  made: number;
};
const FILE_HISTORIES_KEPT = 12;
let entriesMade = 0;
/** One file's landings, page by page (projectCode:fileHistory, no subscription). Steps already read stay for this
 * mount, keyed by project, path and start, so Back to an earlier path reads nothing again and a reply for a path the
 * reader has left lands under its own key, never on the path now shown. A reply whose entry was dropped from the
 * kept steps meanwhile is discarded, so a later step can never stand in for the steps before it. */
export function useFileHistory(
  projectId: ProjectId,
  path: string | null,
  before: number | null = null,
): FileHistoryView {
  const ask = useFileHistoryReader(projectId);
  const kept = useRef(new Map<string, FileHistoryEntry>());
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const key = path === null ? null : JSON.stringify([projectId, path, before]);
  const put = (at: string, change: (was: FileHistoryEntry) => FileHistoryEntry) => {
    const all = kept.current;
    const was = all.get(at) ?? {
      pages: [],
      error: '',
      busy: false,
      moreError: '',
      readAt: null,
      made: ++entriesMade,
    };
    all.delete(at);
    all.set(at, change(was));
    while (all.size > FILE_HISTORIES_KEPT) all.delete(all.keys().next().value!);
    redraw();
  };
  const step = (at: string, file: string, from: number | null) => {
    put(at, was => ({ ...was, busy: true, error: '', moreError: '' }));
    const made = kept.current.get(at)!.made;
    const current = () => kept.current.get(at)?.made === made;
    void ask(file, from).then(
      page =>
        current() &&
        put(at, was => ({
          ...was,
          pages: [...was.pages, page],
          error: '',
          busy: false,
          moreError: '',
          readAt: Date.now(),
        })),
      caught =>
        current() &&
        put(at, was =>
          was.pages.length
            ? { ...was, busy: false, moreError: messageOf(caught) }
            : { ...was, busy: false, error: messageOf(caught) },
        ),
    );
  };
  useEffect(() => {
    if (key !== null && path !== null && !kept.current.has(key)) step(key, path, before);
  }, [key]);
  const entry = key === null ? undefined : kept.current.get(key);
  const pages = entry?.pages ?? [];
  const next = pages.length ? pages.at(-1)!.nextBefore : null;
  return {
    rows: pages.flatMap(page => page.landings),
    missing: pages.reduce((total, page) => total + page.missing, 0),
    scanned: pages.every(page => page.scanned !== undefined)
      ? pages.reduce((total, page) => total + (page.scanned ?? 0), 0)
      : null,
    next,
    loading: key !== null && !pages.length && !entry?.error,
    error: entry?.error ?? '',
    busy: Boolean(entry?.busy && pages.length),
    moreError: entry?.moreError ?? '',
    readAt: entry?.readAt ?? null,
    loadMore: () => {
      if (key !== null && path !== null && next !== null && !entry?.busy) step(key, path, next);
    },
    retry: () => {
      if (key === null || path === null || entry?.busy) return;
      if (pages.length) step(key, path, next);
      else step(key, path, before);
    },
  };
}
