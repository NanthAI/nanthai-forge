// SPDX-License-Identifier: Apache-2.0
// Plan views and filters (Item e0a23825): the views column, the toolbar with find, one chip per filter, sort and the
// List / Tree / Board choice (rule 7), all of it in the address; on a phone the views, filters, order and layout are
// one Filter and view sheet (Tune.tsx, the phone's own pickers, DESIGN.md rule 8). A saved view
// is a name for an address, kept on this browser only. Nothing here reads or writes Convex.
import { useState, type FormEvent, type ReactNode } from 'react';
import { Chip, CodeBox, Key, Menu, Sheet } from '../../ds';
import { defaultItemTypes } from '../../../../src/planning-model';
import type { PlanRow } from '../../../../src/planning-model';
import { A } from '../frames';
import { PlaceIcon } from '../places';
import { Tune } from './Tune';
import {
  agentRead,
  loadViews,
  removeView,
  saveView,
  writeQuery,
  type Layout,
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
  counts: { open: number; mine: number; unowned: number };
};

function views(props: ViewsProps) {
  const mine = props.viewer ? `@${props.viewer.replace(/^@/, '')}` : undefined;
  return [
    { name: 'Open work', query: '', n: props.counts.open },
    ...(mine ? [{ name: 'Mine', query: writeQuery({ owner: mine }), n: props.counts.mine }] : []),
    { name: 'No owner', query: writeQuery({ owner: 'none' }), n: props.counts.unowned },
    { name: 'Closed', query: writeQuery({ scope: 'closed' }) },
    { name: 'Everything', query: writeQuery({ scope: 'all' }) },
  ];
}

/** This browser's saved views and whether the Save sheet is open; held by the screen so the desk column and the
 * phone's Filter and view sheet share them. */
export function useSavedViews(projectId: string) {
  const [saved, setSaved] = useState<SavedView[]>(() => loadViews(projectId));
  const [saving, setSaving] = useState(false);
  return { saved, setSaved, saving, setSaving };
}

/** The built-in views, then the saved ones, and which one is on. */
export function viewList(
  props: ViewsProps,
  { saved, setSaved, saving, setSaving }: ReturnType<typeof useSavedViews>,
) {
  // A view is its scope and filters; the order, layout and find stay as the reader set them when switching.
  const filters = (query: Partial<PlanQuery>) =>
    writeQuery({ ...query, sort: 'hand', layout: 'list', find: '' });
  const current = filters(props.query);
  const keep = { sort: props.query.sort, layout: props.query.layout };
  const builtIn = views(props);
  const all = [...builtIn, ...saved.map(view => ({ ...view, n: undefined as number | undefined }))];
  const isOn = (query: string) => filters(fromQuery(query)) === current;
  return {
    saved,
    setSaved,
    saving,
    setSaving,
    builtIn,
    all,
    isOn,
    /** The view on now, or undefined when the filters match none. */
    on: all.find(view => isOn(view.query))?.name,
    href: (query: string) => props.base + writeQuery({ ...fromQuery(query), ...keep }),
    choose: (name: string) => {
      const view = all.find(each => each.name === name);
      if (view) props.go({ ...fromQuery(view.query), ...keep });
    },
  };
}
export type ViewList = ReturnType<typeof viewList>;

/** The desk's views column; on a phone the same views are the first choice in Filter and view. */
export function ViewsColumn({
  views: list,
  ...props
}: Pick<ViewsProps, 'projectId' | 'query'> & { views: ViewList }) {
  const { saved, setSaved, saving, setSaving, isOn, href } = list;
  return (
    <>
      <nav className="pnav plan-views" aria-label="Plan views">
        {list.builtIn.map(view => (
          <A
            key={view.name}
            href={href(view.query)}
            className={isOn(view.query) ? 'on' : undefined}
            aria-current={isOn(view.query) ? 'page' : undefined}
          >
            <span>{view.name}</span>
            {view.n === undefined ? <span /> : <span className="num">{view.n.toLocaleString()}</span>}
          </A>
        ))}
        {saved.length ? <div className="plan-views-h">Saved on this browser</div> : null}
        {saved.map(view => (
          <A
            key={view.name}
            href={href(view.query)}
            className={isOn(view.query) ? 'on' : undefined}
            aria-current={isOn(view.query) ? 'page' : undefined}
          >
            <span dir="auto">{view.name}</span>
            <span />
          </A>
        ))}
        <button type="button" className="btn ghost sm plan-save" onClick={() => setSaving(true)}>
          Save this view
        </button>
      </nav>
      <SaveView
        open={saving}
        onOpenChange={setSaving}
        query={props.query}
        saved={saved}
        onSave={name => {
          const next = saveView(props.projectId, saved, { name, query: writeQuery(props.query) });
          if (next) setSaved(next);
          return Boolean(next);
        }}
        onRemove={name => setSaved(removeView(props.projectId, saved, name))}
      />
    </>
  );
}

/** A view's query back as the fields `go` takes (unset fields are cleared). */
function fromQuery(text: string): Partial<PlanQuery> {
  const params = new URLSearchParams(text);
  return {
    scope: (params.get('scope') as PlanQuery['scope']) ?? 'open',
    type: params.get('type') ?? undefined,
    owner: params.get('owner') ?? undefined,
    relation: (params.get('relation') as PlanQuery['relation']) ?? undefined,
    initiative: params.get('initiative') ?? undefined,
    sort: (params.get('sort') as Sort) ?? 'hand',
    layout: (params.get('view') as Layout) ?? 'list',
    find: params.get('q') ?? '',
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
 * phone the offered filters, the order and the layout fold into one Filter and view sheet with the views; find and
 * the filters already set stay on the bar. */
export function Toolbar({
  query,
  go,
  initiatives,
  owners,
  types,
  count,
  viewer,
  views: list,
  folds,
}: Pick<ViewsProps, 'query' | 'go' | 'initiatives' | 'owners' | 'types' | 'viewer'> & {
  count: string;
  views: ViewList;
  /** Collapse all and Expand all, when the list has groups to fold. */
  folds?: ReactNode;
}) {
  const [tuning, setTuning] = useState(false);
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
        Filter and view
      </Key>
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
      {/* The region's head shows the count; this says it again only to assistive tech when a filter changes it. */}
      <span className="sr" aria-live="polite">
        {count}
      </span>
      {tuning ? (
        <Tune
          onOpenChange={setTuning}
          views={list}
          facets={facets}
          query={query}
          go={go}
          sortWords={sortWords}
          layouts={<Layouts query={query} go={go} className="seg" />}
          folds={folds}
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
