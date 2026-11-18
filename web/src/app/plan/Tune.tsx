// SPDX-License-Identifier: Apache-2.0
// The phone's Filter and view sheet (owner phone review 2026-11-17): the views, every filter, the order, the layout and
// the Initiative folds, each a native select or key so the phone shows its own picker (DESIGN.md rule 8). Every choice
// applies at once through the address, as on the desk toolbar; Done only closes the sheet. Mounted only while open.
import type { ReactNode } from 'react';
import { Key, Sheet } from '../../ds';
import type { PlanQuery, Sort } from './query';
import type { Facet, ViewList, ViewsProps } from './Views';

/** The View select's Save choice; a saved view's name never starts with a NUL. */
const SAVE = '\u0000save';

export function Tune({
  onOpenChange,
  views,
  facets,
  query,
  go,
  sortWords,
  layouts,
  folds,
}: {
  onOpenChange: (open: boolean) => void;
  views: ViewList;
  facets: readonly Facet[];
  query: PlanQuery;
  go: ViewsProps['go'];
  sortWords: Record<Sort, string>;
  layouts: ReactNode;
  folds?: ReactNode;
}) {
  return (
    <Sheet
      open
      onOpenChange={onOpenChange}
      title="Filter and view"
      footer={<Key onClick={() => onOpenChange(false)}>Done</Key>}
    >
      <div className="plan-tune">
        <label>
          <span>View</span>
          <select
            className="inp"
            value={views.on ?? ''}
            onChange={event => {
              if (event.target.value !== SAVE) return views.choose(event.target.value);
              onOpenChange(false);
              views.setSaving(true);
            }}
          >
            {views.on ? null : (
              <option value="" disabled>
                This view
              </option>
            )}
            {views.all.map(view => (
              <option key={view.name} value={view.name}>
                {view.n === undefined ? view.name : `${view.name} · ${view.n.toLocaleString()}`}
              </option>
            ))}
            <option value={SAVE}>Save this view…</option>
          </select>
        </label>
        {facets.map(facet => (
          <label key={facet.label}>
            <span>{facet.label}</span>
            <select
              className="inp"
              value={facet.raw ?? ''}
              onChange={event =>
                event.target.value
                  ? facet.items.find(item => item.id === event.target.value)?.onAction()
                  : facet.clear()
              }
            >
              <option value="">Any</option>
              {/* A value set by the address but not offered (an owner past the first 12) still shows as set. */}
              {facet.raw && !facet.items.some(item => item.id === facet.raw) ? (
                <option value={facet.raw}>{facet.value}</option>
              ) : null}
              {facet.items.map(item => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        ))}
        <label>
          <span>Order</span>
          <select
            className="inp"
            value={query.sort}
            onChange={event => go({ sort: event.target.value as Sort })}
          >
            {(Object.keys(sortWords) as Sort[]).map(sort => (
              <option key={sort} value={sort}>
                {sort === 'hand' ? 'By hand (shared)' : `By ${sortWords[sort]}`}
              </option>
            ))}
          </select>
        </label>
        <div className="plan-tune-row">
          <span>Show as</span>
          {layouts}
        </div>
        {folds ? (
          <div className="plan-tune-row" role="group" aria-label="Initiatives">
            <span aria-hidden="true">Initiatives</span>
            {folds}
          </div>
        ) : null}
      </div>
    </Sheet>
  );
}
