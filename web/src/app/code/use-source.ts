// SPDX-License-Identifier: Apache-2.0
// The folders and the file the reader has opened at one exact State. A deep link asks once for the path with its
// folders; after that a click in a known folder asks only for that file's first page. Every folder read also lists its
// subfolders (listing.ts), so a folder the reader can see opens with no read, and opening it fetches the level below in
// the background. Nothing is read twice in a visit (code-data.ts keeps every answer) and the whole State never is.
import { useEffect, useReducer, useRef, useState } from 'react';
import {
  browse,
  useReader,
  messageOf,
  type CodeDir,
  type CodeFile,
  type FilePage,
  type Opened,
  type ProjectId,
} from './code-data';
import { keepListing, listingNeed, type Listing } from './listing';

export type Source = {
  dirs: ReadonlyMap<string, CodeDir>;
  files: number | null;
  kind: 'dir' | 'file' | 'missing' | null;
  file: { path: string; head: CodeFile; pages: Extract<FilePage, { kind: 'text' }>[] } | null;
  loading: boolean;
  error: string;
  unavailable: string;
  openDir: (dir: string, cursor?: number) => void;
  morePage: () => void;
  retry: () => void;
};

const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

export function useSource(projectId: ProjectId, state: string | null, path: string): Source {
  const reader = useReader();
  const listing = useRef<Listing>({ dirs: new Map(), ahead: new Set() });
  const at = useRef<string | null>(null);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const [files, setFiles] = useState<number | null>(null);
  const [kind, setKind] = useState<Source['kind']>(null);
  const [file, setFile] = useState<Source['file']>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [unavailable, setUnavailable] = useState('');
  const [attempt, retry] = useReducer((n: number) => n + 1, 0);
  if (at.current !== state) {
    at.current = state;
    listing.current = { dirs: new Map(), ahead: new Set() };
  }
  const dirs = listing.current.dirs;
  const keep = (reply: { dirs?: readonly CodeDir[]; ahead?: string }, append?: string) => {
    keepListing(listing.current, reply, append);
    redraw();
  };
  const ask = <T>(args: Record<string, unknown>) => browse<T>(reader, { projectId, state, ...args });

  useEffect(() => {
    if (!state) return;
    let current = true;
    const known = dirs.get(parentOf(path))?.entries.find(entry => entry.path === path);
    const fail = (caught: unknown) => current && (setLoading(false), setError(messageOf(caught)));
    setError('');
    if (path === '' || known?.kind === 'dir') {
      setKind('dir');
      setFile(null);
      if (dirs.has(path)) {
        if (listingNeed(listing.current, path) === 'ahead') openDir(path);
        return;
      }
      setLoading(true);
      void ask<Opened>({ want: path === '' ? 'open' : 'more', path, cursor: 0 }).then(reply => {
        if (!current) return;
        setLoading(false);
        if (reply.available === false) return setUnavailable(reply.reason ?? 'This source is not available.');
        if (reply.files !== undefined) setFiles(reply.files);
        keep(reply);
      }, fail);
      return () => void (current = false);
    }
    setLoading(true);
    const reply = known
      ? ask<{ file: CodeFile }>({ want: 'page', path }).then(value => ({
          kind: 'file' as const,
          file: value.file,
        }))
      : ask<Opened>({ want: 'open', path });
    void reply.then(value => {
      if (!current) return;
      setLoading(false);
      const opened = value as Opened;
      if (opened.available === false) return setUnavailable(opened.reason ?? 'This source is not available.');
      if (opened.files !== undefined) setFiles(opened.files);
      keep(opened);
      if (opened.missing !== undefined) {
        setKind('missing');
        setFile(null);
        return;
      }
      setKind(opened.kind ?? 'file');
      const head = opened.file ?? null;
      setFile(
        head ? { path, head, pages: head.available && head.page?.kind === 'text' ? [head.page] : [] } : null,
      );
    }, fail);
    return () => void (current = false);
  }, [state, path, attempt]);

  // A listed folder shows at once; this only fetches what is not listed yet (the folder, or the level below it).
  function openDir(dir: string, cursor = 0) {
    const need = cursor > 0 ? 'read' : listingNeed(listing.current, dir);
    if (!state || need === 'none') return;
    void ask<Opened>({ want: 'more', path: dir, cursor }).then(
      reply => keep(reply, cursor > 0 ? dir : undefined),
      // A failed look ahead stays quiet: the folder is on screen, and the next open asks again.
      caught => need === 'read' && setError(messageOf(caught)),
    );
  }
  const morePage = () => {
    const last = file?.pages.at(-1);
    if (!state || !file || !last || last.nextOffset === null) return;
    void ask<{ file: CodeFile }>({ want: 'page', path: file.path, offset: last.nextOffset }).then(
      reply => {
        const next = reply.file.available ? reply.file.page : null;
        if (next?.kind === 'text')
          setFile(was => (was && was.path === file.path ? { ...was, pages: [...was.pages, next] } : was));
      },
      caught => setError(messageOf(caught)),
    );
  };
  return { dirs, files, kind, file, loading, error, unavailable, openDir, morePage, retry };
}
