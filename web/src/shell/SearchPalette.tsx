import { ErrorToast } from '../ui/Toast';
// SPDX-License-Identifier: Apache-2.0
import { useEffect, useMemo, useRef, useState } from 'react';
import { Glyph } from '../ui/Glyph';
import { navigate } from '../ui/navigation';
import { searchGroups, type SearchItem } from './search-model';
import { useAttention } from './attention-context';
import { useVisibleDecisions } from './visible-decisions';
import './search.css';
export type SearchSource = { items: SearchItem[]; loading: boolean; error: string };
/** Native dialog supplies focus containment, Escape and focus restoration. */
export function SearchPalette({
  project,
  source,
  open,
  close,
}: {
  project: string;
  source: SearchSource;
  open: boolean;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const attention = useAttention();
  const { shown } = useVisibleDecisions(attention?.decisions ?? []);
  const [expanded, expand] = useState('');
  const [query, setQuery] = useState('');
  const [selected, select] = useState(0);
  const key = `forge.search.recent:${project}`;
  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => {
    try {
      setRecent(JSON.parse(localStorage.getItem(key) ?? '[]') as string[]);
    } catch {
      setRecent([]);
    }
  }, [key, open]);
  useEffect(() => {
    const element = dialog.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (open) {
      setQuery('');
      select(0);
      element?.showModal();
      input.current?.focus();
      return () => {
        // The parent unmounts the palette on close; do not leave restoration to native cancel.
        element?.close();
        if (opener?.isConnected) opener.focus();
      };
    }
    element?.close();
  }, [open]);
  const needs = shown.flatMap(item =>
    item.laneId ? [`lane:${item.laneId}`] : item.viewId ? [`view:${item.viewId}`] : [],
  );
  const groups = searchGroups(source.items, query, recent, [...new Set(needs)], expanded);
  const results = useMemo(() => groups.flatMap(group => group.items), [groups]);
  const index = Math.min(selected, Math.max(0, results.length - 1));
  const choose = (item: SearchItem) => {
    const next = [item.id, ...recent.filter(id => id !== item.id)];
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* Search still works without storage. */
    }
    setRecent(next);
    close();
    navigate(item.href);
  };
  useEffect(() => {
    document.getElementById(`forge-result-${index}`)?.scrollIntoView({ block: 'nearest' });
  }, [index, query]);
  return (
    <dialog
      ref={dialog}
      className="fx fx-search-dialog"
      aria-label="Search project"
      onCancel={close}
      onClick={event => {
        if (event.target === dialog.current) {
          const box = dialog.current.getBoundingClientRect();
          if (
            event.clientX < box.left ||
            event.clientX > box.right ||
            event.clientY < box.top ||
            event.clientY > box.bottom
          )
            close();
        }
      }}
    >
      <div className="fx-search-input">
        <Glyph name="search" size={16} />
        <input
          ref={input}
          aria-label="Search Intents, Lanes, Views and files"
          placeholder="Search Intents, Lanes, Views and files"
          value={query}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={
            groups.map(group => `forge-search-${group.name.replaceAll(' ', '-')}`).join(' ') || undefined
          }
          aria-activedescendant={results.length ? `forge-result-${index}` : undefined}
          onChange={event => {
            setQuery(event.target.value);
            select(0);
            expand('');
          }}
          onKeyDown={event => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              select(
                (index + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % Math.max(1, results.length),
              );
            }
            if (event.key === 'Enter' && results[index]) {
              event.preventDefault();
              choose(results[index]);
            }
          }}
        />
        <button className="fx-icon-btn" aria-label="Close search" onClick={close}>
          <Glyph name="close" size={14} />
        </button>
      </div>
      <div id="forge-search-results" className="fx-search-results" data-empty={results.length === 0}>
        {groups.map(group => (
          <section key={group.name} aria-label={group.name}>
            <div className="fx-search-caption">{group.name}</div>
            <ul
              id={`forge-search-${group.name.replaceAll(' ', '-')}`}
              role="listbox"
              aria-label={`${group.name} results`}
              className="fx-search-group"
            >
              {group.items.map(item => {
                const i = results.indexOf(item);
                return (
                  <li
                    id={`forge-result-${i}`}
                    key={item.id}
                    role="option"
                    aria-selected={i === index}
                    onPointerMove={() => select(i)}
                  >
                    <a
                      href={item.href}
                      className={item.kind === 'Intent' ? 'fx-search-intent' : undefined}
                      tabIndex={-1}
                      onClick={event => {
                        if (event.metaKey || event.ctrlKey || event.shiftKey) return;
                        event.preventDefault();
                        choose(item);
                      }}
                    >
                      <Glyph
                        name={
                          item.kind === 'File'
                            ? 'code'
                            : (item.kind.toLowerCase() as 'intent' | 'lane' | 'view')
                        }
                        size={15}
                      />
                      <span
                        className={item.kind === 'File' ? 'fx-search-path' : 'fx-search-title'}
                        title={item.title}
                      >
                        {item.title}
                      </span>
                      {item.secondary && <small>{item.secondary}</small>}
                    </a>
                  </li>
                );
              })}
            </ul>
            {query.trim() && group.total > 5 && expanded !== group.kind && (
              <button
                className="fx-search-all"
                onClick={() => {
                  expand(group.kind);
                  const next = searchGroups(source.items, query, recent, needs, group.kind).flatMap(
                    section => section.items,
                  );
                  select(next.findIndex(item => item.id === group.items[0]?.id));
                  input.current?.focus();
                }}
              >
                Show all{!source.loading ? ` ${group.total}` : ''}
              </button>
            )}
          </section>
        ))}
      </div>
      <div className="fx-search-foot" role="status">
        {source.error ? (
          <ErrorToast read error={source.error} />
        ) : source.loading ? (
          'Reading project…'
        ) : results.length ? (
          ''
        ) : (
          'No matches. Try another search.'
        )}
      </div>
    </dialog>
  );
}
