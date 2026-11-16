// SPDX-License-Identifier: Apache-2.0
// Keyboard navigation of the frames: ⌘K or Ctrl+K opens go to or run, ? lists every key, 1–6 go to the project's
// places. Keys never fire while the reader types in a field or holds a modifier other than the palette's. The palette
// and the keys sheet are the design system's (they arrive with the behaviour layer; a key pressed first waits for it).
import { useEffect } from 'react';
import { Palette, Sheet, type PaletteGroup } from '../ds';
import { accountPlaces, hrefFor, projectPlaces, type AppRoute } from './paths';
import { accountPlaceLabels, projectPlaceLabels } from './places';
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
      else if (go.route.frame === 'project')
        navigate(hrefFor({ ...go.route, place: projectPlaces[action.place]!, section: '', rest: '' }));
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [go.route]);
}

function groupsFor(go: Go): PaletteGroup[] {
  const groups: PaletteGroup[] = [];
  const { route } = go;
  if (route.frame === 'project')
    groups.push({
      title: 'Go to',
      entries: projectPlaces.map((place, index) => ({
        id: `place-${place}`,
        label: projectPlaceLabels[place],
        keys: String(index + 1),
        onAction: () => navigate(hrefFor({ ...route, place, section: '', rest: '' })),
      })),
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
      { id: 'sign-out', label: 'Sign out', onAction: go.signOut },
    ],
  });
  return groups;
}

const keyList: readonly [string, string][] = [
  ['⌘K or Ctrl+K', 'Go to or run'],
  ['1 to 6', 'Needs me, Lanes, Plan, Code, Stats, Settings'],
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
}: {
  go: Go;
  palette: boolean;
  setPalette: (open: boolean) => void;
  keys: boolean;
  setKeys: (open: boolean) => void;
}) {
  return (
    <>
      <Palette
        open={palette}
        onOpenChange={setPalette}
        groups={groupsFor(go)}
        placeholder="Go to a place or run…"
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
