// SPDX-License-Identifier: Apache-2.0
// The Plan toolbar and the browser-local Save this view sheet.
import { useState, type FormEvent, type ReactNode } from 'react';
import { Chip, CodeBox, Key, Menu, Sheet } from '../../ds';
import { defaultItemTypes } from '../../../../src/planning-model';
import type { PlanRow } from '../../../../src/planning-model';
import { PlaceIcon } from '../places';
import { useProjectPages } from '../project-pages';
import { navigate } from '../router';
import { Tune } from './Tune';
import { planViewLinks, type PlanViewCounts } from './view-links';
import {
  agentRead,
  agentReadNote,
  loadViews,
  removeView,
  saveView,
  writeQuery,
  type PlanQuery,
  type SavedView,
  type Sort,
} from './query';

const sortWords: Record<Sort, string> = {
  hand: 'by hand',
  title: 'title',
  status: 'status',
  owner: 'owner',
  type: 'type',
};
const relationWords = {
  'depends-on': 'Waiting on another',
  'duplicate-of': 'Duplicates',
  related: 'Related to another',
  none: 'No relations',
} as const;

export type ViewsProps = {
  projectId: string;
  query: PlanQuery;
  /** The Plan path without a query; links add the view's query. */
  base: string;
  go: (patch: Partial<PlanQuery>) => void;
  viewer: string | undefined;
  initiatives: readonly PlanRow[];
  owners: readonly string[];
  types: readonly string[];
  counts?: PlanViewCounts | undefined;
};

function useSavedViews(projectId: string) {
  const navigation = useProjectPages();
  const [local, setLocal] = useState<SavedView[]>(() => (navigation ? [] : loadViews(projectId)));
  const [saving, setSaving] = useState(false);
  return {
    saved: navigation?.saved ?? local,
    setSaved: navigation?.setSaved ?? setLocal,
    saving,
    setSaving,
  };
}

function SaveView({
  open,
  onOpenChange,
  query,
  saved,
  onSave,
  onRemove,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  query: PlanQuery;
  saved: readonly SavedView[];
  onSave: (name: string) => boolean;
  onRemove: (name: string) => void;
}) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = name.trim().slice(0, 60);
    if (!text) return;
    if (onSave(text)) {
      setName('');
      setError('');
      onOpenChange(false);
    } else setError('This browser keeps nothing (private window or storage off), so the view was not saved.');
  };
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Save this view"
      footer={
        <>
          <Key onClick={() => onOpenChange(false)}>Cancel</Key>
          <Key kind="primary" type="submit" form="plan-save-view" disabled={!name.trim()}>
            Save
          </Key>
        </>
      }
    >
      <form id="plan-save-view" className="plan-capture" onSubmit={submit}>
        <label>
          <span>Name</span>
          <input
            className="inp"
            value={name}
            maxLength={60}
            onChange={event => setName(event.target.value)}
            autoFocus
          />
        </label>
        <p className="t2">Kept on this browser. Agents read the same view with:</p>
        <CodeBox label="Agent command">{agentRead(query)}</CodeBox>
        {agentReadNote(query) ? <p className="t3">{agentReadNote(query)}</p> : null}
        {saved.length ? (
          <div className="plan-saved">
            {saved.map(view => (
              <Chip key={view.name} label={view.name} onRemove={() => onRemove(view.name)} />
            ))}
          </div>
        ) : null}
        {error ? (
          <p className="pf" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </Sheet>
  );
}

/** One filter: its name, the value set (as shown), the raw value in the address, and the choices. */
export type Facet = {
  label: string;
  value: string | undefined;
  raw: string | undefined;
  clear: () => void;
  items: { id: string; label: string; onAction: () => void }[];
};

/** Find, one chip per filter (set ones solid and removable, the rest offered), sort, and the layout choice. On a
 * phone the offered filters, the order and the layout fold into Tune; find and
 * the filters already set stay on the bar. */
export function Toolbar({
  query,
  go,
  initiatives,
  owners,
  types,
  count,
  viewer,
  projectId,
  base,
  counts,
  folds,
}: ViewsProps & {
  count: string;
  /** Collapse all and Expand all, when the list has groups to fold. */
  folds?: ReactNode;
}) {
  const [tuning, setTuning] = useState(false);
  const { saved, setSaved, saving, setSaving } = useSavedViews(projectId);
  const views = planViewLinks(base, query, viewer, saved, counts);
  const initiative = initiatives.find(row => row.id === query.initiative);
  const typeNames = [...new Set([...defaultItemTypes, ...types.map(type => type.toLowerCase())])];
  const mine = viewer ? `@${viewer.replace(/^@/, '')}` : undefined;
  const ownerNames = [...new Set([...(mine ? [mine] : []), ...owners])].slice(0, 12);
  const facets: Facet[] = [
    {
      label: 'Type',
      value: query.type,
      raw: query.type,
      clear: () => go({ type: undefined }),
      items: typeNames.map(type => ({
        id: type,
        label: type[0]!.toUpperCase() + type.slice(1),
        onAction: () => go({ type }),
      })),
    },
    {
      label: 'Owner',
      value: query.owner === 'none' ? 'no one' : query.owner,
      raw: query.owner,
      clear: () => go({ owner: undefined }),
      items: [
        { id: 'none', label: 'No one yet', onAction: () => go({ owner: 'none' }) },
        ...ownerNames.map(owner => ({ id: owner, label: owner, onAction: () => go({ owner }) })),
      ],
    },
    {
      label: 'Initiative',
      value: initiative?.title ?? (query.initiative ? query.initiative.slice(0, 8) : undefined),
      raw: query.initiative,
      clear: () => go({ initiative: undefined }),
      items: initiatives.map(row => ({
        id: row.id,
        label: row.title,
        onAction: () => go({ initiative: row.id }),
      })),
    },
    {
      label: 'Relation',
      value: query.relation ? relationWords[query.relation] : undefined,
      raw: query.relation,
      clear: () => go({ relation: undefined }),
      items: (Object.keys(relationWords) as (keyof typeof relationWords)[]).map(kind => ({
        id: kind,
        label: relationWords[kind],
        onAction: () => go({ relation: kind }),
      })),
    },
  ];
  return (
    <div className="tbar plan-tbar" role="toolbar" aria-label="Find, filter and order">
      <label className="find">
        <span className="sr">Find in the plan</span>
        <PlaceIcon name="find" size={14} />
        <input
          className="inp"
          name="find"
          type="search"
          autoComplete="off"
          placeholder="Find…"
          value={query.find}
          onChange={event => go({ find: event.target.value })}
        />
      </label>
      <Key className="plan-phone" aria-haspopup="dialog" onClick={() => setTuning(true)}>
        Tune
      </Key>
      <Menu
        className="btn sm plan-view-picker"
        label={`View: ${views.on?.name ?? 'This view'}`}
        items={views.all.map(view => ({
          id: view.id,
          label: view.n === undefined ? view.name : `${view.name} · ${view.n.toLocaleString()}`,
          href: views.href(view.query),
        }))}
        onNavigate={navigate}
      />
      {facets.map(facet =>
        facet.value ? (
          <Chip key={facet.label} label={facet.label} value={facet.value} onRemove={facet.clear} />
        ) : (
          <Menu key={facet.label} label={`${facet.label}: any`} className="chip off" items={facet.items}>
            <span>
              {facet.label}
              <i>: any</i>
            </span>
          </Menu>
        ),
      )}
      <Menu
        label={`Order: ${sortWords[query.sort]}`}
        className="btn sm plan-desk"
        items={(Object.keys(sortWords) as Sort[]).map(sort => ({
          id: sort,
          label: sort === 'hand' ? 'By hand (shared)' : `By ${sortWords[sort]}`,
          onAction: () => go({ sort }),
        }))}
      />
      <Layouts query={query} go={go} className="seg plan-desk" />
      <Key className="plan-save" size="sm" onClick={() => setSaving(true)}>
        Save this view
      </Key>
      {/* The region's head shows the count; this says it again only to assistive tech when a filter changes it. */}
      <span className="sr" aria-live="polite">
        {count}
      </span>
      {tuning ? (
        <Tune
          onOpenChange={setTuning}
          facets={facets}
          query={query}
          go={go}
          sortWords={sortWords}
          layouts={<Layouts query={query} go={go} className="seg" />}
          folds={folds}
        />
      ) : null}
      {saving ? (
        <SaveView
          open={saving}
          onOpenChange={setSaving}
          query={query}
          saved={saved}
          onSave={name => {
            const next = saveView(projectId, { name, query: writeQuery(query) });
            if (next) setSaved(next);
            return Boolean(next);
          }}
          onRemove={name => setSaved(removeView(projectId, saved, name))}
        />
      ) : null}
    </div>
  );
}

/** List, Tree or Board. */
function Layouts({ query, go, className }: Pick<ViewsProps, 'query' | 'go'> & { className: string }) {
  return (
    <span className={className} role="group" aria-label="Show as">
      {(['list', 'tree', 'board'] as const).map(layout => (
        <button
          key={layout}
          type="button"
          aria-pressed={query.layout === layout}
          onClick={() => go({ layout })}
        >
          {layout[0]!.toUpperCase() + layout.slice(1)}
        </button>
      ))}
    </span>
  );
}
