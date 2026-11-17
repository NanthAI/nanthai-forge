// SPDX-License-Identifier: Apache-2.0
// The public read a visitor's page asks for (Items 8947a779, 6a60e89a): one GET of a cached JSON file per page, the
// same file crawlers and the agent lookup get. A visitor never opens a Convex connection: the site's shared cache
// answers, and the backend sees at most one call per page per cache period (convex/publicHttp.ts). Read once when the
// page mounts; no polling, no timer, nothing while the tab is idle.
import { useEffect, useState } from 'react';

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
export type ExploreOrder = 'active' | 'stars' | 'newest';
export type ExplorePage = {
  asOf: number;
  order: ExploreOrder;
  total: number;
  more: boolean;
  projects: ListedProject[];
};
export type ProfilePage = { asOf: number; handle: string; projects: ListedProject[] };
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
  project: {
    id: string;
    handle: string;
    slug: string;
    name: string;
    since: number;
    upstream?: { handle: string; slug: string };
  };
  stars: number;
  activity: { landings: number; days: number[]; main: MainCheck; lastAt?: number };
  lanes: {
    open: number;
    more: boolean;
    editing: number;
    saved: number;
    checking: number;
    ready: number;
    held: number;
    titles: { stage: string; held?: true; title?: string }[];
  };
  plan: PlanView;
};

/** Where the cached read lives: the site itself, so the shared cache answers. A local development server has no
 * site function, so it asks the development backend's public route directly. */
export function publicReadUrl(path: string) {
  const backend = import.meta.env.DEV
    ? (import.meta.env.VITE_CONVEX_SITE_URL as string | undefined)
    : undefined;
  return `${backend ? `${backend.replace(/\/$/, '')}/public/v1` : '/-/public/v1'}/${path}`;
}

export type Read<T> =
  | { state: 'loading' }
  | { state: 'missing' }
  | { state: 'failed' }
  | { state: 'ok'; data: T };

/** One cached JSON read for this page; `retry` asks again after a failure. */
export function usePublicRead<T>(path: string): [Read<T>, () => void] {
  const [read, setRead] = useState<Read<T>>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
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
