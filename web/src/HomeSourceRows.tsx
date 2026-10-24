// SPDX-License-Identifier: Apache-2.0
import type { FunctionReturnType } from 'convex/server';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { ImportRemoveAction } from './ImportRemoveAction';
import { StatusPill } from './ui/primitives';
type Import = FunctionReturnType<typeof api.sharingActions.list>['page'][number] & { shared: boolean };
type Saved = FunctionReturnType<typeof api.savedViews.list>['page'];
type Zone = FunctionReturnType<typeof api.zoneActions.shared>['page'][number];
export function HomeSourceRows({
  imports,
  bookmarks,
  zones,
  savedOnly,
  filter,
  busy,
  open,
  star,
  unstar,
}: {
  imports: Import[];
  bookmarks: Saved;
  zones: Zone[];
  savedOnly: Saved;
  filter: string;
  busy: string;
  open: (id: Id<'imports'>) => void;
  star: (id: Id<'imports'>, name: string) => Promise<void>;
  unstar: (id: Id<'imports'>, saved: Saved) => void;
}) {
  return (
    <>
      {imports.map(row => {
        const stars = bookmarks.filter(item => item.importId === row.id);
        const rootStar = stars.find(
          item => item.route.state && item.route.view === 'home' && !item.route.file,
        );
        const locations = stars.filter(item => item.id !== rootStar?.id);
        return (
          <div className="fx-home-row" key={row.id}>
            <div>
              <button className="fx-home-name" onClick={() => open(row.id)}>
                {row.repository}
              </button>
              <span className="fx-home-tag" title="Read-only code analysis; no editable main.">
                GitHub analysis
              </span>
              {row.shared && <span className="fx-home-tag">shared source</span>}
              <button
                className="fx-home-star"
                aria-label={rootStar ? `Unstar ${row.repository}` : `Star ${row.repository}`}
                aria-pressed={!!rootStar}
                disabled={busy === row.id}
                onClick={() => {
                  if (rootStar) {
                    unstar(row.id, [rootStar]);
                  } else void star(row.id, row.repository);
                }}
              >
                {rootStar ? '★' : '☆'}
              </button>
              <div className="fx-home-fact">{row.ref}</div>
              {locations.length > 0 && (
                <details className="fx-home-locations">
                  <summary>
                    {locations.length} starred {locations.length === 1 ? 'location' : 'locations'}
                  </summary>
                  {locations.map(item => (
                    <div className="fx-home-location" key={item.id}>
                      <a
                        className="fx-home-bookmark"
                        href={`/?${new URLSearchParams({ ...item.route, line: String(item.route.line), codescape: item.importId })}`}
                      >
                        {item.name}
                        {item.route.file && ` · ${item.route.file}:${item.route.line}`}
                      </a>
                      <button
                        className="fx-home-star"
                        aria-label={`Unstar ${item.name}`}
                        aria-pressed="true"
                        disabled={busy === row.id}
                        onClick={() => unstar(row.id, [item])}
                      >
                        ★
                      </button>
                    </div>
                  ))}
                </details>
              )}
            </div>
            <StatusPill tone={row.phase === 'ready' ? 'passed' : row.phase === 'error' ? 'failed' : 'plain'}>
              {row.phase === 'ready' ? 'Ready' : row.phase === 'error' ? 'Import failed' : 'Importing'}
            </StatusPill>
            {row.shared ? (
              <span className="fx-muted">—</span>
            ) : (
              <ImportRemoveAction id={row.id} repository={row.repository} />
            )}
          </div>
        );
      })}
      {zones.map(zone => (
        <div className="fx-home-row" key={zone.id}>
          <div>
            <a
              className="fx-home-name"
              href={`/?${new URLSearchParams({ codescape: zone.importId, zone: zone.id })}`}
            >
              {zone.name}
            </a>
            <span className="fx-home-tag">shared source</span>
            <div className="fx-home-fact">{zone.repository}</div>
          </div>
          <span className="fx-muted">Zone</span>
          <span className="fx-muted">—</span>
        </div>
      ))}
      {['all', 'starred'].includes(filter) &&
        savedOnly.map(item => (
          <div className="fx-home-row" key={item.id}>
            {item.route.state ? (
              <a
                className="fx-home-name"
                href={`/?${new URLSearchParams({ ...item.route, line: String(item.route.line), codescape: item.importId })}`}
              >
                ★ {item.name}
              </a>
            ) : (
              <span className="fx-home-name">★ {item.name}</span>
            )}
            <span className="fx-home-tag" title="Read-only code analysis; no editable main.">
              GitHub analysis
            </span>
            <span />
          </div>
        ))}
    </>
  );
}
