// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { createContext, Fragment, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Key, Menu, Sheet } from '../ds';
import { hrefFor, placeSections, projectPlaces, type AppRoute, type ProjectPlace } from './paths';
import { loadViews, readQuery, savedViewStorageKey, type SavedView } from './plan/query';
import { planViewLinks, type PlanViewCounts } from './plan/view-links';
import { PlaceIcon, projectPlaceLabels, sectionLabels } from './places';
import { followLink, navigate } from './router';

export type ProjectRoute = Extract<AppRoute, { frame: 'project' }>;
type Current = 'page' | 'true' | undefined;
export type PageLink = {
  id: string;
  href: string;
  label: string;
  current?: Current;
  seam?: boolean;
  saved?: boolean;
  count?: number | undefined;
  counter?: boolean;
};

export function placeHref(route: ProjectRoute, place: ProjectPlace) {
  return hrefFor({ ...route, place, section: '', rest: '' });
}

const ProjectPages = createContext<{
  route: ProjectRoute;
  pages: Record<ProjectPlace, PageLink[]>;
  saved: SavedView[];
  setSaved: (saved: SavedView[]) => void;
  setCounts: (counts: PlanViewCounts | undefined) => void;
} | null>(null);

export function useProjectPages() {
  return useContext(ProjectPages);
}

export function ProjectPagesProvider({
  route,
  projectId,
  viewer,
  secrets,
  children,
}: {
  route: ProjectRoute;
  projectId: string | null;
  viewer: string | undefined;
  /** What waits on the reader in sealed secrets (Needs me's read), shown beside the Secrets page. */
  secrets?: number | undefined;
  children: ReactNode;
}) {
  const stored = useMemo(() => (projectId ? loadViews(projectId) : []), [projectId]);
  const [edited, edit] = useState<{ projectId: string | null; saved: SavedView[] }>();
  const [counts, setCounts] = useState<PlanViewCounts>();
  useEffect(() => {
    if (!projectId) return;
    const key = savedViewStorageKey(projectId);
    const sync = (event: StorageEvent) => {
      if (event.key === key || event.key === null) edit({ projectId, saved: loadViews(projectId) });
    };
    addEventListener('storage', sync);
    return () => removeEventListener('storage', sync);
  }, [projectId]);
  const saved = edited?.projectId === projectId ? edited.saved : stored;
  const search = typeof location === 'undefined' ? '' : location.search;
  const pages = useMemo(
    () => pagesFor(route, viewer, saved, counts, search, secrets),
    [route, viewer, saved, counts, search, secrets],
  );
  return (
    <ProjectPages.Provider
      value={{ route, pages, saved, setSaved: saved => edit({ projectId, saved }), setCounts }}
    >
      {children}
    </ProjectPages.Provider>
  );
}

export function pagesFor(
  route: ProjectRoute,
  viewer: string | undefined,
  saved: readonly SavedView[],
  counts: PlanViewCounts | undefined,
  search: string,
  secrets?: number,
): Record<ProjectPlace, PageLink[]> {
  const here = (place: ProjectPlace, section: string): Current =>
    route.place === place && route.section === section ? (route.rest ? 'true' : 'page') : undefined;
  const plan = planViewLinks(
    placeHref(route, 'plan'),
    readQuery(new URLSearchParams(route.place === 'plan' ? search : '')),
    viewer,
    saved,
    route.place === 'plan' ? counts : undefined,
  );
  const sections = (place: ProjectPlace): PageLink[] =>
    placeSections[place].map(section => ({
      id: section,
      label: sectionLabels[place][section]!,
      href: hrefFor({ ...route, place, section, rest: '' }),
      current: here(place, section),
      seam: place === 'settings' && section === 'you',
      // The Secrets page shows how many rows wait on the reader; nothing at zero.
      ...(place === 'settings' && section === 'secrets' && secrets ? { count: secrets, counter: true } : {}),
    }));
  return {
    needs: sections('needs'),
    lanes: sections('lanes'),
    code: sections('code'),
    stats: sections('stats'),
    settings: sections('settings'),
    plan: plan.all.map(view => ({
      id: view.id,
      label: view.name,
      href: plan.href(view.query),
      current: view === plan.on ? here('plan', '') : undefined,
      saved: view.saved ?? false,
      seam: view.seam ?? false,
      count: view.n,
      counter: ['open', 'mine', 'unowned'].includes(view.id),
    })),
  };
}

export function PageLinks({
  pages,
  fly = false,
  compact = false,
  onFollow,
  icon,
}: {
  pages: readonly PageLink[];
  fly?: boolean;
  compact?: boolean;
  onFollow?: () => void;
  icon?: ReactNode;
}) {
  const saved = pages.filter(page => page.saved);
  const hidden = compact ? saved.slice(8) : [];
  const shown = hidden.length ? pages.filter(page => !hidden.includes(page)) : pages;
  return (
    <>
      {shown.map((page, index) => (
        <Fragment key={page.id}>
          {page.seam ? <div className="page-seam" aria-hidden="true" /> : null}
          {page.saved && !shown[index - 1]?.saved ? (
            <p className="page-group-title">Saved on this browser</p>
          ) : null}
          <a
            className={icon ? 'page-link page-link-icon' : 'page-link'}
            href={page.href}
            aria-current={page.current}
            tabIndex={fly ? -1 : undefined}
            onClick={event => {
              followLink(event);
              if (event.defaultPrevented) onFollow?.();
            }}
          >
            {icon}
            <span className="cut" dir="auto" title={page.saved ? page.label : undefined}>
              {page.label}
            </span>
            {page.counter ? <span className="page-count">{page.count?.toLocaleString()}</span> : null}
          </a>
        </Fragment>
      ))}
      {hidden.length ? (
        <Menu
          label="All saved views"
          className="page-link"
          excludeFromTabOrder={fly}
          aria-current={hidden.some(page => page.current) ? 'true' : undefined}
          items={saved.map(({ id, label, href }) => ({ id, label, href }))}
          onNavigate={href => {
            navigate(href);
            onFollow?.();
          }}
        />
      ) : null}
    </>
  );
}

function PageSheet({
  title,
  open,
  setOpen,
  children,
}: {
  title: string;
  open: boolean;
  setOpen: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Sheet
      open={open}
      onOpenChange={setOpen}
      title={title}
      headerAction={
        <Key size="sm" kind="ghost" onClick={() => setOpen(false)}>
          Close
        </Key>
      }
    >
      <div className="page-sheet">{children}</div>
    </Sheet>
  );
}

function usePageSheet() {
  const [open, setOpen] = useState(false);
  // When React Aria releases the dialog scope, put focus on the destination instead of the old trigger.
  const follow = () => {
    setOpen(false);
    requestAnimationFrame(() => document.getElementById('main')?.focus({ preventScroll: true }));
  };
  return { open, setOpen, follow };
}

export function PhonePageTitle() {
  const navigation = useProjectPages();
  const { open, setOpen, follow } = usePageSheet();
  const route = navigation?.route;
  useEffect(() => {
    if (route) setOpen(false);
  }, [route, setOpen]);
  if (!navigation || !route) return null;
  const place = projectPlaceLabels[route.place];
  const pages = navigation.pages[route.place];
  if (pages.length < 2) return <span className="phone-page-title">{place}</span>;
  const label = pages.find(page => page.current)?.label ?? 'This view';
  return (
    <>
      <button
        type="button"
        className="phone-page-title page-picker"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${place}: ${label}. Choose a page`}
        onClick={() => setOpen(true)}
      >
        <span>{place}</span>
        <span aria-hidden="true">/</span>
        <b className="cut" dir="auto">
          {label}
        </b>
      </button>
      <PageSheet title={place} open={open} setOpen={setOpen}>
        <PageLinks pages={pages} onFollow={follow} />
      </PageSheet>
    </>
  );
}

export function ProjectMore({ icon }: { icon: ReactNode }) {
  const navigation = useProjectPages()!;
  const { open, setOpen, follow } = usePageSheet();
  const { route, pages } = navigation;
  useEffect(() => setOpen(false), [route, setOpen]);
  return (
    <>
      <button
        type="button"
        className="tabs-more"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-current={route.place === 'stats' || route.place === 'settings' ? 'true' : undefined}
        onClick={() => setOpen(true)}
      >
        {icon}More
      </button>
      <PageSheet title="More" open={open} setOpen={setOpen}>
        <PageLinks pages={pages.stats} onFollow={follow} icon={<PlaceIcon name="stats" />} />
        <p className="page-group-title">Settings</p>
        <PageLinks pages={pages.settings} onFollow={follow} />
      </PageSheet>
    </>
  );
}

export function projectPaletteEntries(pages: Record<ProjectPlace, PageLink[]>) {
  return projectPlaces.flatMap(place =>
    pages[place].flatMap(page => {
      if (place === 'stats') return [];
      return [
        {
          id: `page-${place}-${page.id}`,
          label: `${projectPlaceLabels[place]}: ${page.label}`,
          onAction: () => navigate(page.href),
        },
      ];
    }),
  );
}
