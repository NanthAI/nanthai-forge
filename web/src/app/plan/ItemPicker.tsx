// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { useId, useRef, useState } from 'react';
import { isLive, itemStatusLabel, type PlanRow } from '../../../../src/planning-model';
import { Key, Sheet } from '../../ds';
import { matches, statusOf, type PlanView } from './model';

export type SearchOpenItems = (text: string) => Promise<readonly PlanRow[]>;

/** Searches the loaded plan without a call; widening the search is an explicit one-shot action. */
export function ItemPicker({
  label,
  view,
  search,
  refusal,
  detail,
  choose,
  cancel,
  embedded = false,
}: {
  label: string;
  view: PlanView;
  search?: SearchOpenItems | undefined;
  refusal?: (row: PlanRow) => string | undefined;
  detail?: (row: PlanRow) => string | undefined;
  choose: (row: PlanRow) => void;
  cancel: () => void;
  /** The caller already draws a sheet, e.g. New Item or the handle’s menu. */
  embedded?: boolean;
}) {
  const [phone] = useState(
    () => typeof matchMedia === 'function' && matchMedia('(max-width: 860px)').matches,
  );
  const [text, setText] = useState('');
  const [active, setActive] = useState<string>();
  const [requested, setRequested] = useState('');
  const [answers, setAnswers] = useState<readonly PlanRow[] | 'failed' | null>(null);
  const [limit, setLimit] = useState(10);
  const cache = useRef(new Map<string, Promise<readonly PlanRow[]>>());
  const latest = useRef('');
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const query = text.trim().toLowerCase();
  const local = [...view.byId.values()].filter(
    row => row.kind === 'issue' && isLive(row) && matches(row, query),
  );
  const remote = requested === query && Array.isArray(answers) ? (answers as readonly PlanRow[]) : [];
  const rows = [...new Map([...remote, ...local].map(row => [row.id, row])).values()];
  const shown = rows.slice(0, limit);
  const canSearch = view.more && Boolean(search) && Boolean(query);
  const widen = async () => {
    if (!canSearch || !search) return;
    setRequested(query);
    setAnswers(null);
    setActive(undefined);
    latest.current = query;
    let pending = cache.current.get(query);
    if (!pending) {
      pending = search(query);
      cache.current.set(query, pending);
    }
    try {
      const found = await pending;
      if (latest.current === query) setAnswers(found);
    } catch {
      cache.current.delete(query);
      if (latest.current === query) setAnswers('failed');
    }
  };
  const change = (value: string) => {
    setText(value);
    latest.current = '';
    setRequested('');
    setAnswers(null);
    setActive(undefined);
    setLimit(10);
  };
  const body = (
    <div className="plan-picker">
      <div className="plan-picker-input">
        <input
          ref={input}
          className="inp"
          aria-label={label}
          placeholder="Search open Items by title or id"
          autoComplete="off"
          autoFocus
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={true}
          aria-controls={`${id}-items`}
          aria-activedescendant={active ? `${id}-${active}` : undefined}
          value={text}
          onChange={event => change(event.target.value)}
          onKeyDown={event => {
            if (!['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(event.key)) return;
            event.preventDefault();
            event.stopPropagation();
            if (event.key === 'Escape') return cancel();
            const at = shown.findIndex(row => row.id === active);
            if (event.key === 'Enter') {
              const option = shown[at];
              if (option && !refusal?.(option)) choose(option);
              else if (!option && canSearch) void widen();
              return;
            }
            if (!shown.length) return;
            const next =
              shown[
                at < 0
                  ? event.key === 'ArrowDown'
                    ? 0
                    : shown.length - 1
                  : (at + (event.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length
              ]!;
            setActive(next.id);
            document.getElementById(`${id}-${next.id}`)?.scrollIntoView({ block: 'nearest' });
          }}
        />
        <Key type="button" size="sm" kind="ghost" onClick={cancel}>
          Cancel
        </Key>
      </div>
      <div className="plan-picker-surface">
        <div id={`${id}-items`} role="listbox" aria-label="Open Items">
          {shown.map(row => {
            const why = refusal?.(row);
            return (
              <div
                id={`${id}-${row.id}`}
                key={row.id}
                role="option"
                aria-selected={active === row.id}
                aria-disabled={Boolean(why)}
                onMouseDown={event => event.preventDefault()}
                onClick={() => {
                  if (!why) choose(row);
                }}
              >
                <b dir="auto">{row.title}</b>
                {why ? <span>{why}</span> : null}
                <small>
                  {view.numbers.get(row.id) ?? row.id.slice(0, 8)} ·{' '}
                  {row.initiativeId
                    ? (view.byId.get(row.initiativeId)?.title ?? 'Initiative not shown')
                    : 'No Initiative'}{' '}
                  · {itemStatusLabel[statusOf(row)]}
                  {detail?.(row) ? ` · ${detail(row)}` : ''}
                </small>
              </div>
            );
          })}
        </div>
        <div className="plan-picker-footer">
          <span role="status">
            {requested === query && requested && answers === null
              ? 'Searching all open Items…'
              : answers === 'failed'
                ? 'Search could not be loaded. Try again.'
                : !rows.length
                  ? `No open Item matches “${text.trim()}”.`
                  : remote.length
                    ? `${rows.length} matches shown`
                    : `${local.length} ${local.length === 1 ? 'match' : 'matches'} in the loaded plan`}
          </span>
          {shown.length < rows.length ? (
            <Key size="sm" onClick={() => setLimit(limit + 10)}>
              Show more
            </Key>
          ) : null}
          {query ? (
            <Key
              size="sm"
              kind="ghost"
              onClick={() => {
                change('');
                input.current?.focus();
              }}
            >
              Clear
            </Key>
          ) : null}
          {canSearch ? (
            <Key size="sm" onClick={() => void widen()}>
              Search all open Items
            </Key>
          ) : null}
        </div>
      </div>
    </div>
  );
  return phone && !embedded ? (
    <Sheet
      open
      title={label}
      onOpenChange={open => {
        if (!open) cancel();
      }}
    >
      <div className="pad">{body}</div>
    </Sheet>
  ) : (
    body
  );
}
