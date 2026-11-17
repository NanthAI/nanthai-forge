// SPDX-License-Identifier: Apache-2.0
// Plan views and filters (Item e0a23825): the views column (a picker on a phone, DESIGN.md rule 8), the toolbar with
// find, one chip per filter, sort and the List / Tree / Board choice (rule 7), all of it in the address. A saved view
// is a name for an address, kept on this browser only. Nothing here reads or writes Convex.
import { useState, type FormEvent } from 'react';
import { Chip, CodeBox, Key, Menu, Sheet } from '../../ds';
import { defaultItemTypes } from '../../../../src/planning-model';
import type { PlanRow } from '../../../../src/planning-model';
import { A } from '../frames';
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

/** The picker's Save choice; a saved view's name never starts with a NUL. */
const SAVE = '\u0000save';

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

/** The built-in views, then this browser's saved ones. */
function useViews(projectId: string) {
  const [views, setViews] = useState<SavedView[]>(() => loadViews(projectId));
  return [views, setViews] as const;
}

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

export function ViewsColumn(props: ViewsProps) {
  const [saved, setSaved] = useViews(props.projectId);
  const [saving, setSaving] = useState(false);
  // A view is its scope and filters; the order, layout and find stay as the reader set them when switching.
  const filters = (query: Partial<PlanQuery>) =>
    writeQuery({ ...query, sort: 'hand', layout: 'list', find: '' });
  const current = filters(props.query);
  const keep = { sort: props.query.sort, layout: props.query.layout };
  const href = (query: string) => props.base + writeQuery({ ...fromQuery(query), ...keep });
  const builtIn = views(props);
  const all = [...builtIn, ...saved.map(view => ({ ...view, n: undefined }))];
  const on = all.find(view => filters(fromQuery(view.query)) === current)?.name ?? 'This view';
  return (
    <>
      <nav className="pnav plan-views" aria-label="Plan views">
        {builtIn.map(view => (
          <A
            key={view.name}
            href={href(view.query)}
            className={filters(fromQuery(view.query)) === current ? 'on' : undefined}
            aria-current={filters(fromQuery(view.query)) === current ? 'page' : undefined}
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
            className={filters(fromQuery(view.query)) === current ? 'on' : undefined}
            aria-current={filters(fromQuery(view.query)) === current ? 'page' : undefined}
          >
            <span dir="auto">{view.name}</span>
            <span />
          </A>
        ))}
        <button type="button" className="btn ghost sm plan-save" onClick={() => setSaving(true)}>
          Save this view
        </button>
      </nav>
      {/* On a phone the views are one full-width native select (the phone's own picker), not a menu button. */}
      <div className="plan-picker">
        <select
          className="inp"
          aria-label="Plan view"
          value={all.some(view => view.name === on) ? on : ''}
          onChange={event => {
            const name = event.target.value;
            if (name === SAVE) return setSaving(true);
            const view = all.find(each => each.name === name);
            if (view) props.go({ ...fromQuery(view.query), ...keep });
          }}
        >
          {all.some(view => view.name === on) ? null : (
            <option value="" disabled>
              {on}
            </option>
          )}
          {all.map(view => (
            <option key={view.name} value={view.name}>
              {view.n === undefined ? view.name : `${view.name} · ${view.n.toLocaleString()}`}
            </option>
          ))}
          <option value={SAVE}>Save this view…</option>
        </select>
      </div>
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

/** Find, one chip per filter (set ones solid and removable, the rest offered), sort, and the layout choice. */
export function Toolbar({
  query,
  go,
  initiatives,
  owners,
  types,
  count,
  viewer,
}: Pick<ViewsProps, 'query' | 'go' | 'initiatives' | 'owners' | 'types' | 'viewer'> & { count: string }) {
  const initiative = initiatives.find(row => row.id === query.initiative);
  const typeNames = [...new Set([...defaultItemTypes, ...types.map(type => type.toLowerCase())])];
  const mine = viewer ? `@${viewer.replace(/^@/, '')}` : undefined;
  const ownerNames = [...new Set([...(mine ? [mine] : []), ...owners])].slice(0, 12);
  const facet = (
    label: string,
    value: string | undefined,
    clear: () => void,
    items: { id: string; label: string; onAction: () => void }[],
  ) =>
    value ? (
      <Chip key={label} label={label} value={value} onRemove={clear} />
    ) : (
      <Menu key={label} label={`${label}: any`} className="chip off" items={items}>
        <span>
          {label}
          <i>: any</i>
        </span>
      </Menu>
    );
  return (
    <div className="tbar plan-tbar" role="toolbar" aria-label="Find, filter and order">
      <label className="find">
        <span className="sr">Find in the plan</span>
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
      {facet(
        'Type',
        query.type,
        () => go({ type: undefined }),
        typeNames.map(type => ({
          id: type,
          label: type[0]!.toUpperCase() + type.slice(1),
          onAction: () => go({ type }),
        })),
      )}
      {facet('Owner', query.owner === 'none' ? 'no one' : query.owner, () => go({ owner: undefined }), [
        { id: 'none', label: 'No one yet', onAction: () => go({ owner: 'none' }) },
        ...ownerNames.map(owner => ({ id: owner, label: owner, onAction: () => go({ owner }) })),
      ])}
      {facet(
        'Initiative',
        initiative?.title ?? (query.initiative ? query.initiative.slice(0, 8) : undefined),
        () => go({ initiative: undefined }),
        initiatives.map(row => ({
          id: row.id,
          label: row.title,
          onAction: () => go({ initiative: row.id }),
        })),
      )}
      {facet(
        'Relation',
        query.relation ? relationWords[query.relation] : undefined,
        () => go({ relation: undefined }),
        (Object.keys(relationWords) as (keyof typeof relationWords)[]).map(kind => ({
          id: kind,
          label: relationWords[kind],
          onAction: () => go({ relation: kind }),
        })),
      )}
      <Menu
        label={`Order: ${sortWords[query.sort]}`}
        items={(Object.keys(sortWords) as Sort[]).map(sort => ({
          id: sort,
          label: sort === 'hand' ? 'By hand (shared)' : `By ${sortWords[sort]}`,
          onAction: () => go({ sort }),
        }))}
      />
      <span className="seg" role="group" aria-label="Show as">
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
      <span className="n" aria-live="polite">
        {count}
      </span>
    </div>
  );
}
