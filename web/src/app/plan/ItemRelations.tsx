// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { useState } from 'react';
import { Band, Key, Region } from '../../ds';
import { A } from '../frames';
import type { PlanRow, RelationKind } from '../../../../src/planning-model';
import { ItemPicker } from './ItemPicker';
import { useHierarchyChange, type HierarchyProps } from './ItemHierarchy';
import { itemPut } from './hierarchy';

export type Related = { kind: string; id: string; title: string };
const bands = ['Depends on', 'Blocks', 'Duplicate of', 'Duplicated by', 'Related'] as const;
const labels = { 'depends-on': 'Depends on', 'duplicate-of': 'Duplicate of', related: 'Related' } as const;
const choices = ['depends-on', 'duplicate-of', 'related'] as const;
type Link = {
  id: string;
  title: string;
  band: (typeof bands)[number];
  kind: RelationKind;
  incoming?: true;
  detail?: string;
};

export function ItemRelations({
  row,
  view,
  href,
  edit,
  search,
  read,
  related,
  more,
}: HierarchyProps & {
  related?: readonly Related[] | undefined;
  more?: boolean | undefined;
}) {
  const [choice, setChoice] = useState<RelationKind>();
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const { apply, busy, error, setError } = useHierarchyChange(edit);
  const links = new Map<string, Link>();
  const key = (link: Link) => `${link.band}:${link.id}`;
  const add = (link: Link) => {
    if (!links.has(key(link))) links.set(key(link), link);
  };
  const title = (id: string) =>
    view.byId.get(id)?.title ?? related?.find(link => link.id === id)?.title ?? `Item ${id.slice(0, 8)}`;
  for (const link of row.relations ?? []) {
    const detail = related?.find(other => other.id === link.id && /^Split /.test(other.kind))?.kind;
    add({ ...link, title: title(link.id), band: labels[link.kind], ...(detail ? { detail } : {}) });
  }
  const inbound = (other: Pick<PlanRow, 'id' | 'title'>, kind: RelationKind, detail?: string) => {
    const band = kind === 'depends-on' ? 'Blocks' : kind === 'duplicate-of' ? 'Duplicated by' : 'Related';
    const link: Link = {
      id: other.id,
      title: other.title,
      kind,
      band,
      incoming: true,
      ...(detail ? { detail } : {}),
    };
    if (!removed.has(key(link))) add(link);
  };
  for (const link of related ?? []) {
    if (link.kind === 'Parent' || link.kind === 'Initiative') continue;
    if (link.kind === 'Depends on' || link.kind === 'Duplicate of') {
      const band = link.kind;
      const forward: Link = {
        id: link.id,
        title: link.title,
        band,
        kind: band === 'Depends on' ? ('depends-on' as const) : ('duplicate-of' as const),
      };
      if (row.relations === undefined && !removed.has(key(forward))) add(forward);
      continue;
    }
    const kind =
      link.kind === 'Blocks' ? 'depends-on' : link.kind === 'Duplicated by' ? 'duplicate-of' : 'related';
    const other = view.byId.get(link.id);
    if (other && !other.relations?.some(edge => edge.id === row.id && edge.kind === kind)) continue;
    inbound(link, kind, link.kind === 'Related' || link.kind === 'Blocks' ? undefined : link.kind);
  }
  for (const other of view.byId.values())
    for (const link of other.relations ?? []) if (link.id === row.id) inbound(other, link.kind);

  const change = async (
    owner: PlanRow,
    id: string,
    kind: RelationKind,
    remove: boolean,
    onUndo?: () => void,
  ) => {
    const patch = (base: PlanRow) => {
      const relations = base.relations ?? [];
      return itemPut(base, {
        relations: remove
          ? relations.filter(link => link.kind !== kind || link.id !== id)
          : [...relations, { kind, id }],
      });
    };
    const same = (base: PlanRow) =>
      base.relations?.some(link => link.id === id && link.kind === kind) ?? false;
    const ok = await apply(
      [patch(owner)],
      remove ? 'Removed the relation.' : 'Added the relation.',
      read
        ? async () => {
            const latest = await read(owner.id, true);
            if (!latest) return;
            const current = { ...owner, version: latest.version, relations: latest.relations ?? [] };
            if (same(current) !== same(owner) || (!remove && current.relations.length >= 20)) return;
            return [patch(current)];
          }
        : undefined,
      onUndo,
    );
    if (ok) setChoice(undefined);
    return ok;
  };
  const remove = async (link: Link) => {
    try {
      const targetId = link.incoming ? row.id : link.id;
      const sourceId = link.incoming ? link.id : row.id;
      const shown = link.incoming ? view.byId.get(sourceId) : row;
      const hasLink = (item: Pick<PlanRow, 'relations'> | undefined) =>
        item?.relations?.some(edge => edge.kind === link.kind && edge.id === targetId);
      const loaded = hasLink(shown) ? shown : undefined;
      const full = !loaded && read ? await read(sourceId, true) : null;
      const owner =
        loaded ??
        (full && { ...full, status: 'open' as const, position: 0, relations: full.relations ?? [] });
      if (!owner) return setError('The Item could not be read. Try again.');
      if (!hasLink(owner))
        return setError('The relation has already changed. Reopen the Item to refresh it.');
      const restore = () =>
        setRemoved(previous => {
          const next = new Set(previous);
          next.delete(key(link));
          return next;
        });
      if ((await change(owner, targetId, link.kind, true, loaded ? undefined : restore)) && !loaded)
        setRemoved(previous => new Set(previous).add(key(link)));
    } catch {
      setError('The other Item could not be read. Try again.');
    }
  };
  const count = row.relations?.length ?? 0;
  return (
    <Region title="Relations" count={links.size} countAtLeast={Boolean(more)}>
      {bands.map(band => {
        const rows = [...links.values()].filter(link => link.band === band);
        return rows.length ? (
          <div key={band}>
            <Band
              title={band}
              count={rows.length}
              hint={band === 'Blocks' ? 'set on the other Item' : undefined}
            />
            {rows.map(link => (
              <div className="plan-relation" key={key(link)}>
                <A className="lk ttl" href={href(link.id)} dir="auto">
                  {link.title}
                </A>
                {edit ? (
                  <Key
                    size="sm"
                    kind="ghost"
                    disabled={busy}
                    aria-label={`Remove ${band.toLowerCase()}: ${link.title}`}
                    onClick={() => void remove(link)}
                  >
                    ×
                  </Key>
                ) : null}
                {link.detail ? <span className="t2">{link.detail}</span> : null}
              </div>
            ))}
          </div>
        ) : null;
      })}
      {!links.size ? <div className="quietline">No relations shown.</div> : null}
      {edit ? (
        <div className="plan-relation-add">
          {choice ? (
            <>
              <div className="seg" role="group" aria-label="Relation kind">
                {choices.map(kind => (
                  <button
                    key={kind}
                    type="button"
                    aria-pressed={choice === kind}
                    onClick={() => setChoice(kind)}
                  >
                    {labels[kind]}
                  </button>
                ))}
              </div>
              <ItemPicker
                label="Find a related Item"
                view={view}
                search={search}
                cancel={() => setChoice(undefined)}
                refusal={target =>
                  busy
                    ? 'Saving…'
                    : target.id === row.id
                      ? 'This Item'
                      : row.relations?.some(link => link.id === target.id && link.kind === choice)
                        ? `Already ${labels[choice]}`
                        : choice === 'depends-on' &&
                            target.relations?.some(link => link.id === row.id && link.kind === 'depends-on')
                          ? 'It already depends on this Item'
                          : undefined
                }
                choose={target => void change(row, target.id, choice, false)}
              />
            </>
          ) : (
            <div className="plan-parent">
              <Key size="sm" disabled={count >= 20} onClick={() => setChoice('depends-on')}>
                Add relation
              </Key>
              {count >= 20 ? <span className="t2">20 relations, the most an Item holds</span> : null}
            </div>
          )}
        </div>
      ) : null}
      {error ? (
        <p className="pf" role="alert">
          {error}
        </p>
      ) : null}
    </Region>
  );
}
