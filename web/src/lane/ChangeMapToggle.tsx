// SPDX-License-Identifier: Apache-2.0
import { lazy, Suspense, useState } from 'react';
import type { ChangeMapData } from '../../../src/change-map';
import type { Id } from '../../../convex/_generated/dataModel';
export type MapPeer = { id: string; name: string; base: string; head: string };
export type MapSource = {
  kind: 'lane' | 'view';
  id: string;
  base: string;
  head: string;
  projectId?: Id<'hostedProjects'>;
  backupId?: Id<'projectBackups'>;
  peers?: MapPeer[];
  exclude?: string[];
};
const ChangeMap = lazy(() => import('./ChangeMap'));
/** Keep the imported panel mounted after first use, caching this exact head through Files/Map switches. */
function MapToggle({
  source,
  selected,
  select,
  children,
  showDiff,
}: {
  source: MapSource;
  selected: string;
  select: (path: string, node: ChangeMapData['nodes'][number]) => void;
  children: React.ReactNode;
  showDiff?: boolean;
}) {
  const [mode, setMode] = useState('files');
  const [asked, setAsked] = useState(false);
  const [toolbar, setToolbar] = useState<HTMLSpanElement | null>(null);
  return (
    <>
      <div className="fx-map-toggle" role="group" aria-label="Changed file display">
        <div className="fx-map-modes">
          {['files', 'map'].map(value => (
            <button
              type="button"
              key={value}
              aria-pressed={mode === value}
              onClick={() => {
                setMode(value);
                if (value === 'map') setAsked(true);
              }}
            >
              {value === 'files' ? 'Files' : 'Map'}
            </button>
          ))}
        </div>
        <span className="fx-map-toolbar-actions" ref={setToolbar} hidden={mode !== 'map'} />
      </div>
      <div hidden={mode !== 'files'}>{children}</div>
      {asked && (
        <div hidden={mode !== 'map'} className="fx-change-map">
          <Suspense
            fallback={
              <p className="fx-map-loading" role="status">
                Reading Map…
              </p>
            }
          >
            <ChangeMap
              key={`${source.id}:${source.head}:${source.backupId ?? ''}`}
              toolbar={toolbar}
              source={source}
              showDiff={showDiff}
              selected={selected}
              select={select}
            />
          </Suspense>
        </div>
      )}
    </>
  );
}

export function ChangeMapToggle(props: Parameters<typeof MapToggle>[0]) {
  return (
    <MapToggle
      key={`${props.source.id}:${props.source.base}:${props.source.head}:${props.source.backupId ?? ''}`}
      {...props}
    />
  );
}
