// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Keyboard navigation of the frames: ⌘K or Ctrl+K opens go to or run, ? lists every key, 1–6 go to the project's
// places. Keys never fire while the reader types in a field or holds a modifier other than the palette's. The palette
// and the keys sheet are the design system's (they arrive with the behaviour layer; a key pressed first waits for it).
import { useContext, useEffect, useState } from 'react';
import type { Id } from '../../../convex/_generated/dataModel';
import { Palette, Sheet, type PaletteGroup } from '../ds';
import { RailControls } from '../ds/rail-state';
import { useIdPalette } from './id-palette';
import { accountPlaces, hrefFor, projectPlaces, type AppRoute } from './paths';
import { accountPlaceLabels, projectPlaceLabels } from './places';
import { projectPaletteEntries, useProjectPages } from './project-pages';
import { keyAction, navigate } from './router';

export type Go = {
  route: Exclude<AppRoute, { frame: 'public' }>;
  openPalette: () => void;
  openKeys: () => void;
  signOut: () => void;
};

export function useFrameKeys(go: Go) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const action = keyAction(event, event.target, go.route.frame === 'project');
      if (!action) return;
      event.preventDefault();
      if (action === 'palette') go.openPalette();
      else if (action === 'keys') go.openKeys();
      else if (typeof action === 'object' && go.route.frame === 'project')
        navigate(hrefFor({ ...go.route, place: projectPlaces[action.place]!, section: '', rest: '' }));
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [go.route]);
}

/** The deployed build stamped onto `<html data-build-version>` by scripts/build-site.mjs; a diagnostic, so it lives in
 * the palette (reachable at every width), never in the sidebar's list of places. */
function buildStamp() {
  return typeof document === 'undefined' ? null : (document.documentElement.dataset.buildVersion ?? null);
}

function useGroups(go: Go): PaletteGroup[] {
  const groups: PaletteGroup[] = [];
  const { route } = go;
  const navigation = useProjectPages();
  const rail = useContext(RailControls);
  if (route.frame === 'project')
    groups.push({
      title: 'Go to',
      entries: [
        ...projectPlaces.map((place, index) => ({
          id: `place-${place}`,
          label: projectPlaceLabels[place],
          keys: String(index + 1),
          onAction: () => navigate(hrefFor({ ...route, place, section: '', rest: '' })),
        })),
        ...(navigation ? projectPaletteEntries(navigation.pages) : []),
      ],
    });
  groups.push({
    title: 'Account',
    entries: accountPlaces.map(place => ({
      id: `account-${place}`,
      label: accountPlaceLabels[place],
      onAction: () => navigate(hrefFor({ frame: 'account', place })),
    })),
  });
  groups.push({
    title: 'Run',
    entries: [
      { id: 'keys', label: 'Show every key', keys: '?', onAction: go.openKeys },
      ...(rail
        ? [
            {
              id: 'rail',
              label: rail.shut ? 'Expand sidebar' : 'Collapse sidebar',
              keys: '[',
              onAction: rail.toggle,
            },
          ]
        : []),
      ...(buildStamp()
        ? [
            {
              id: 'build',
              label: `Deployed build record: ${buildStamp()}`,
              onAction: () => location.assign('/_forge/build.json'),
            },
          ]
        : []),
      { id: 'sign-out', label: 'Sign out', onAction: go.signOut },
    ],
  });
  return groups;
}

const keyList: readonly [string, string][] = [
  ['⌘K or Ctrl+K', 'Go to or run'],
  ['1 to 6', 'Needs me, Lanes, Plan, Code, Stats, Settings'],
  ['Hold Alt or Option', 'Show the numbers beside the sidebar places'],
  ['[', 'Collapse or expand the sidebar'],
  ['→ or ↓', 'Enter the pages of a collapsed sidebar place'],
  ['↑ or ↓', 'Move between pages in the flyout'],
  ['← or Esc', 'Return to the place icon from its flyout'],
  ['?', 'Every key'],
  ['Tab', 'Next link or control; the first Tab offers "Skip to the page"'],
  ['Esc', 'Close a sheet or the palette'],
];

export function Keys({
  go,
  palette,
  setPalette,
  keys,
  setKeys,
  projectId,
}: {
  go: Go;
  palette: boolean;
  setPalette: (open: boolean) => void;
  keys: boolean;
  setKeys: (open: boolean) => void;
  /** In a project, a pasted id finds the Item, Lane or landing it names (id-palette.ts). */
  projectId?: Id<'hostedProjects'> | null;
}) {
  // The search text, kept only while the palette is open: a reopened palette starts empty.
  const [query, setQuery] = useState('');
  const found = useIdPalette(projectId, go.route, palette, palette ? query : '');
  const groups = useGroups(go);
  return (
    <>
      <Palette
        open={palette}
        onOpenChange={open => {
          if (!open) setQuery('');
          setPalette(open);
        }}
        groups={[...found.groups, ...groups]}
        placeholder={
          go.route.frame === 'project' ? 'Go to a place, or paste an id…' : 'Go to a place or run…'
        }
        onInputChange={setQuery}
        {...(found.empty ? { empty: found.empty } : {})}
      />
      <Sheet open={keys} onOpenChange={setKeys} title="Keys">
        <dl className="keylist">
          {keyList.map(([key, does]) => (
            <div key={key}>
              <dt>
                <kbd>{key}</kbd>
              </dt>
              <dd>{does}</dd>
            </div>
          ))}
        </dl>
      </Sheet>
    </>
  );
}
