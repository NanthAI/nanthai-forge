// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The public read a visitor's page asks for (Items 8947a779, 6a60e89a): one GET of a cached JSON file per page, the
// same data crawlers get. A visitor never opens a Convex connection: the site's shared cache answers. The document
// may already supply its snapshot; otherwise read once. No polling, timer or calls while the tab is idle.
import { useEffect, useRef, useState } from 'react';
import type { ProfileRead } from '../../../src/person-days';
import {
  collectPublicSearch,
  readSearchShard,
  searchShardPath,
  type ExploreOrder,
  type SearchRow,
} from '../../../src/public-explore-pages';
export type { ExploreOrder } from '../../../src/public-explore-pages';

export type MainCheck = 'passing' | 'unchecked';
export type ListedProject = {
  id: string;
  handle: string;
  slug: string;
  name: string;
  since: number;
  stars: number;
  landings: number;
  days: number[];
  main: MainCheck;
};
export type ExplorePage = {
  asOf: number;
  starLookup?: true;
  order: ExploreOrder;
  page?: number;
  start?: number;
  search?: true;
  active?: number;
  deployment?: string;
  total: number;
  more: boolean;
  projects: ListedProject[];
};
export type ProfilePage = {
  asOf: number;
  moreCount?: number;
  starLookup?: true;
  handle: string;
  projects: ListedProject[];
  /** Contributions on public projects (Item 6a251b23); absent from a page cached before it shipped. */
  contributions?: ProfileRead;
};
export type PlanView =
  | { shown: false }
  | {
      shown: true;
      left: number;
      inProgress: number;
      initiatives: { id: string; title: string; left: number; inProgress: number }[];
      next: { id: string; title: string; initiative?: string }[];
    };
export type ProjectPage = {
  asOf: number;
  moreCount?: number;
  starLookup?: true;
  /** The source deployment, absent from pages cached before it was included. */
  deployment?: string;
  project: {
    id: string;
    handle: string;
    slug: string;
    name: string;
    since: number;
    /** Missing for ordinary projects. Null means the fork's upstream is no longer publicly available. */
    upstream?: { handle: string; slug: string } | null;
  };
  stars: number;
  activity: { landings: number; days: number[]; main: MainCheck; lastAt?: number; recordedSince?: number };
  lanes: {
    open: number;
    more: boolean;
    editing: number;
    saved: number;
    /** Absent from a page cached before the In queue stop (Item 85f456c1). */
    queued?: number;
    checking: number;
    ready: number;
    held: number;
    titles: { stage: string; held?: true; title?: string }[];
  };
  plan: PlanView;
};

/** Local development can name the deployed site cache; browser builds never receive the service key. */
export function publicReadUrl(path: string) {
  const site = import.meta.env.DEV ? (import.meta.env.VITE_FORGE_WEB_URL as string | undefined) : undefined;
  return `${site ? site.replace(/\/$/, '') : ''}/-/public/v1/${path}`;
}

export type Read<T> =
  | { state: 'loading' }
  | { state: 'missing' }
  | { state: 'failed' }
  | { state: 'ok'; data: T };

function embeddedRead<T>(path: string): Read<T> | undefined {
  const template = document.getElementById('forge-public-snapshot');
  if (!(template instanceof HTMLTemplateElement) || template.dataset.path !== path) return undefined;
  try {
    const data = JSON.parse(template.content.textContent ?? '') as T | null;
    return data === null ? { state: 'missing' } : { state: 'ok', data };
  } catch {
    return undefined;
  }
}

/** The first search loads the compact index once. Keystrokes and order changes filter it locally. */
export function useExploreDirectory(first: ExplorePage | undefined, searching: boolean) {
  const [attempt, setAttempt] = useState(0);
  const deployment = first?.search && first.deployment;
  const [result, setResult] = useState<{ deployment: string; projects: SearchRow[] | null }>();
  const current = result?.deployment === deployment ? result : undefined;
  useEffect(() => {
    if (!searching || !deployment || current) return;
    const controller = new AbortController();
    void collectPublicSearch(deployment, async number => {
      const response = await fetch(publicReadUrl(searchShardPath(number)), {
        signal: controller.signal,
        credentials: 'omit',
        headers: { accept: 'application/json' },
      });
      if (!response.ok || !response.headers.get('content-type')?.includes('json'))
        throw new Error('Explore is unavailable.');
      const shard = readSearchShard(await response.json());
      if (!shard) throw new Error('Explore search is unavailable.');
      return shard;
    }).then(
      projects => {
        if (!controller.signal.aborted) setResult({ deployment, projects });
      },
      () => {
        if (!controller.signal.aborted) setResult({ deployment, projects: null });
      },
    );
    return () => controller.abort();
  }, [deployment, searching, current, attempt]);
  return {
    projects: current?.projects,
    retry: () => {
      setResult(undefined);
      setAttempt(number => number + 1);
    },
  };
}

/** Reuse the document's page, or read one cached JSON file for a client navigation or explicit retry. */
export function usePublicRead<T>(path: string): [Read<T>, () => void] {
  const [read, setRead] = useState<Read<T>>(() => embeddedRead<T>(path) ?? { state: 'loading' });
  const initialPath = useRef(read.state === 'loading' ? null : path);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (initialPath.current === path && attempt === 0) {
      document.getElementById('forge-public-snapshot')?.remove();
      return;
    }
    initialPath.current = null;
    let live = true;
    setRead({ state: 'loading' });
    fetch(publicReadUrl(path), { credentials: 'omit', headers: { accept: 'application/json' } })
      .then(async response => {
        if (response.status === 404) return { state: 'missing' } as const;
        const type = response.headers.get('content-type') ?? '';
        if (!response.ok || !type.includes('json')) return { state: 'failed' } as const;
        return { state: 'ok', data: (await response.json()) as T } as const;
      })
      .catch(() => ({ state: 'failed' }) as const)
      .then(next => live && setRead(next));
    return () => {
      live = false;
    };
  }, [path, attempt]);
  return [read, () => setAttempt(n => n + 1)];
}
