// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { useId, useRef, useState, type FormEvent } from 'react';
import { Key, Menu, Region } from '../../ds';
import { A } from '../frames';
import { hostedError, hostedErrorCode } from '../../snapshot';
import { isLive, type PlanRow } from '../../../../src/planning-model';
import type { BatchWrite } from '../../../../src/planning-batch';
import type { ReadItem } from './ItemDetail';
import type { EditItemPorts } from './item-edit';
import { ItemPicker, type SearchOpenItems } from './ItemPicker';
import { hierarchyMove, lastChildRank, parentRefusal, rankAfterParent } from './hierarchy';
import type { PlanView } from './model';
import { DoneWhen, Status } from './rows';

export type HierarchyProps = {
  row: PlanRow;
  view: PlanView;
  href: (id: string) => string;
  search?: SearchOpenItems | undefined;
  edit?: EditItemPorts | undefined;
  read?: ReadItem | undefined;
};

type Retry = () => Promise<readonly BatchWrite[] | undefined>;
export function useHierarchyChange(edit: EditItemPorts | undefined) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const pending = useRef<{ key: string; operationId: string } | undefined>(undefined);
  const apply = async (
    writes: readonly BatchWrite[],
    words: string,
    refresh?: Retry,
    onUndo?: () => void,
  ) => {
    if (!edit || running.current) return false;
    running.current = true;
    setBusy(true);
    setError('');
    const send = async (next: readonly BatchWrite[]) => {
      const key = JSON.stringify(next);
      if (pending.current?.key !== key) pending.current = { key, operationId: crypto.randomUUID() };
      return edit.run(next, {
        operationId: pending.current.operationId,
        ...(next.length > 1 ? { atomic: true } : {}),
      });
    };
    try {
      let retried = false;
      let outcome = await send(writes).catch(async cause => {
        if (hostedErrorCode(cause) !== 'ITEM_CHANGED' || !refresh) throw cause;
        const latest = await refresh();
        if (!latest) throw cause;
        retried = true;
        return send(latest);
      });
      let refusal = outcome.results.find(result => result.outcome === 'refused');
      // Only retry a wholly refused change. An independently applied comment/put cannot be replayed as a new batch.
      if (
        refusal?.code === 'ITEM_CHANGED' &&
        !retried &&
        refresh &&
        outcome.results.every(result => result.outcome === 'refused')
      ) {
        const latest = await refresh();
        if (latest) {
          outcome = await send(latest);
          refusal = outcome.results.find(result => result.outcome === 'refused');
        }
      }
      pending.current = undefined;
      if (refusal) {
        const message =
          refusal.code === 'ITEM_CHANGED'
            ? `This Item changed since the page read it${refusal.currentVersion ? ` (version ${refusal.currentVersion})` : ''}. Try again.`
            : (refusal.message ?? 'Forge refused this change.');
        if (outcome.undo.length) edit.undo(outcome, message);
        setError(message);
        return false;
      }
      edit.undo(outcome, words, onUndo);
      return true;
    } catch (cause) {
      setError(
        hostedErrorCode(cause) === 'ITEM_CHANGED'
          ? 'This Item changed. Nothing moved. Try again.'
          : cause instanceof Error
            ? hostedError(cause) || 'Forge could not confirm the change. Try again.'
            : 'Forge could not confirm the change. Try again.',
      );
      return false;
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return { apply, busy, error, setError };
}

const parentChange = ({ row, view, read }: HierarchyProps, parent: PlanRow | null) => {
  const initiative = parent ? (parent.initiativeId ?? null) : (row.initiativeId ?? null);
  const rank = parent ? lastChildRank(view, parent) : rankAfterParent(view, row);
  return {
    writes: hierarchyMove(view, [row], parent, initiative, rank),
    words: parent ? `Put “${row.title}” under “${parent.title}”.` : `Made “${row.title}” top level.`,
    refresh: read
      ? async () => {
          const latest = await read(row.id, true);
          if (
            !latest ||
            (latest.parentId ?? null) !== (row.parentId ?? null) ||
            (latest.initiativeId ?? null) !== (row.initiativeId ?? null)
          )
            return;
          return hierarchyMove(view, [{ ...row, version: latest.version }], parent, initiative, rank);
        }
      : undefined,
  };
};

const initiativeChange = (view: PlanView, child: PlanRow, parent: PlanRow) =>
  (child.initiativeId ?? null) === (parent.initiativeId ?? null)
    ? undefined
    : `also moves this Item to ${view.byId.get(parent.initiativeId ?? '')?.title ?? 'No Initiative'}`;

export function ParentFact(props: HierarchyProps) {
  const { row, view, href, search, edit } = props;
  const [picking, setPicking] = useState(false);
  const hint = useId();
  const { apply, busy, error } = useHierarchyChange(edit);
  const kids = view.children.get(row.id)?.length ?? 0;
  const parent = row.parentId ? view.byId.get(row.parentId) : undefined;
  const number = parent && view.numbers.get(parent.id);
  const change = async (target: PlanRow | null) => {
    const { writes, words, refresh } = parentChange(props, target);
    if (await apply(writes, words, refresh)) setPicking(false);
  };
  return (
    <>
      <div className="plan-parent">
        {parent ? (
          <A className="lk" href={href(parent.id)} dir="auto" title={parent.title}>
            {number ? `${number} · ` : ''}
            {parent.title}
          </A>
        ) : row.parentId ? (
          <A className="lk" href={href(row.parentId)}>
            Parent not in the loaded plan
          </A>
        ) : (
          <span className="t2">none, top level</span>
        )}
        {edit ? (
          <>
            <Key
              size="sm"
              disabled={busy || kids > 0}
              aria-describedby={kids ? hint : undefined}
              onClick={() => setPicking(!picking)}
            >
              {row.parentId ? 'Change…' : 'Set parent…'}
            </Key>
            {row.parentId ? (
              <Key size="sm" kind="ghost" disabled={busy} onClick={() => void change(null)}>
                Clear
              </Key>
            ) : null}
            {kids ? (
              <span className="t2" id={hint}>
                has {kids}
                {view.more ? '+' : ''} {kids === 1 && !view.more ? 'sub-item' : 'sub-items'}; one level only
              </span>
            ) : null}
          </>
        ) : null}
      </div>
      {picking && edit ? (
        <ItemPicker
          label="Find a parent"
          view={view}
          search={search}
          cancel={() => setPicking(false)}
          refusal={target => (busy ? 'Saving…' : parentRefusal(view, row, target))}
          detail={target => initiativeChange(view, row, target)}
          choose={target => void change(target)}
        />
      ) : null}
      {error ? (
        <p role="alert" className="pf">
          {error}
        </p>
      ) : null}
    </>
  );
}

export function ItemChildren(props: HierarchyProps) {
  const { row, view, href, search, edit } = props;
  const [mode, setMode] = useState<'create' | 'pick'>();
  const [draft, setDraft] = useState('');
  const fresh = useRef<{ title: string; id: string } | undefined>(undefined);
  const { apply, busy, error } = useHierarchyChange(edit);
  const children = view.children.get(row.id) ?? [];
  const canAdd = Boolean(edit && !row.parentId && isLive(row));
  const add = async (event: FormEvent) => {
    event.preventDefault();
    const title = draft.trim();
    if (!title || busy) return;
    if (fresh.current?.title !== title) fresh.current = { title, id: crypto.randomUUID() };
    if (
      await apply(
        [
          {
            action: 'put-planning-item',
            itemId: fresh.current.id,
            expectedVersion: 0,
            kind: 'issue',
            status: 'open',
            title,
            body: '',
            parentId: row.id,
            initiativeId: row.initiativeId ?? null,
          },
        ],
        `Added “${title}” under “${row.title}”.`,
      )
    ) {
      fresh.current = undefined;
      setDraft('');
    }
  };
  const move = async (child: PlanRow, parent: PlanRow | null) => {
    const { writes, words, refresh } = parentChange({ ...props, row: child }, parent);
    if (await apply(writes, words, refresh)) setMode(undefined);
  };
  return (
    <Region title="Children" count={children.length} countAtLeast={view.more}>
      {children.map(child => (
        <div className="plan-child" key={child.id}>
          <span className="rk">{view.numbers.get(child.id)}</span>
          <A className="ttl" href={href(child.id)} dir="auto" title={child.title}>
            {child.title}
          </A>
          {edit ? (
            <Menu
              label={`Actions for ${child.title}`}
              className="btn ghost sm"
              items={[
                { id: 'open', label: 'Open', href: href(child.id) },
                {
                  id: 'clear',
                  label: 'Make top level',
                  disabled: busy,
                  onAction: () => void move(child, null),
                },
              ]}
            >
              ⋯
            </Menu>
          ) : null}
          <div className="plan-child-meta">
            <Status row={child} />
            <DoneWhen counts={child.doneWhen} />
          </div>
        </div>
      ))}
      {canAdd ? (
        <div className="plan-hierarchy-actions">
          <Key size="sm" onClick={() => setMode('create')}>
            New child
          </Key>
          <Key size="sm" onClick={() => setMode('pick')}>
            Add existing…
          </Key>
        </div>
      ) : !children.length ? (
        <div className="quietline">No sub-items shown.</div>
      ) : null}
      {canAdd && mode === 'create' ? (
        <form className="plan-new-child" onSubmit={event => void add(event)}>
          <input
            className="inp"
            aria-label="Child title"
            placeholder="Child title"
            value={draft}
            onChange={event => setDraft(event.target.value)}
            autoFocus
            required
          />
          <Key kind="primary" size="sm" type="submit" disabled={busy || !draft.trim()}>
            Add
          </Key>
          <Key size="sm" onClick={() => setMode(undefined)}>
            Cancel
          </Key>
        </form>
      ) : null}
      {canAdd && mode === 'pick' ? (
        <div className="pad">
          <ItemPicker
            label="Find an existing child"
            view={view}
            search={search}
            cancel={() => setMode(undefined)}
            refusal={child => (busy ? 'Saving…' : parentRefusal(view, child, row))}
            detail={child => initiativeChange(view, child, row)}
            choose={child => void move(child, row)}
          />
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="pf">
          {error}
        </p>
      ) : null}
    </Region>
  );
}
