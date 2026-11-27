// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// FYI opens the already bounded window a page at a time, with the same kind filter and Clear all.
import { useState, type ReactNode } from 'react';
import { Key, Region, Segment, State, Who } from '../../ds';
import { A } from '../frames';
import { checkAttemptHref } from '../check/route';
import { NeedsCard } from './NeedsCard';
import { focusHref, fyiSum, sinceText, type Area, type FyiRow, type FyiState, type fyiView } from './fyi';
import type { Dismiss } from './NeedsMe';
import { TakenKeys } from './TakenKeys';
import type { TakenActions } from './taken-actions';

/** FYI rows shown before "Show more". */
const FYI_CAP = 6;

const FILTERS: { value: 'all' | Area; text: string }[] = [
  { value: 'all', text: 'All' },
  { value: 'code', text: 'Code' },
  { value: 'outside', text: 'Outside the code' },
  { value: 'messages', text: 'Messages' },
];

/** "09:58" today, "Yesterday", or the date: when a row happened, in the reader's time. */
function when(at: number, now: number) {
  if (at <= 0 || !Number.isFinite(at)) return '';
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const date = new Date(at);
  if (at >= day.getTime()) return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (at >= day.getTime() - 86_400_000) return 'Yesterday';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function Fyi({
  handle,
  view: preview,
  state,
  drawnAt,
  dismiss,
  announce,
  href,
  history,
  sectionLinked,
  headingRef,
  taken,
}: {
  handle: ReactNode;
  view: ReturnType<typeof fyiView> | null;
  state: FyiState | undefined;
  drawnAt: number;
  dismiss: Dismiss;
  announce: (text: string) => void;
  href: (to: FyiRow['links'][number]['to']) => string;
  history: () => ReturnType<typeof fyiView> | null;
  sectionLinked: boolean;
  headingRef: (heading: HTMLHeadingElement | null) => void;
  taken?: TakenActions;
}) {
  const [filter, setFilter] = useState<'all' | Area>('all');
  const [limit, setLimit] = useState<number>();
  const pageSize = limit ?? (sectionLinked ? 2 * FYI_CAP : FYI_CAP);
  const expanded = pageSize > FYI_CAP;
  const view = expanded ? history() : preview;
  const [undo, setUndo] = useState<FyiState | null>(null);
  const [busy, setBusy] = useState(false);
  const send = async (input: Parameters<Dismiss>[0], done: string) => {
    setBusy(true);
    try {
      const reply = JSON.parse(await dismiss(input)) as { before?: FyiState; error?: { message?: string } };
      if (reply.error) announce(`Not done: ${reply.error.message ?? 'Forge refused it.'}`);
      else {
        announce(done);
        return reply.before ?? null;
      }
    } catch {
      announce('Not done: Forge could not be reached. Nothing changed; try again.');
    } finally {
      setBusy(false);
    }
    return null;
  };
  const rows = view ? view.rows.filter(row => filter === 'all' || row.area === filter) : [];
  const changeFilter = (kind: typeof filter) => {
    setFilter(kind);
    setLimit(expanded ? 2 * FYI_CAP : FYI_CAP);
  };
  return (
    <Region
      title="FYI"
      headingRef={headingRef}
      weight="watch"
      count={view ? view.counts.all : undefined}
      handle={handle}
      sum={view ? fyiSum(view) : undefined}
      hint={view ? `nothing to act on; counted ${sinceText(view.since, drawnAt)}` : undefined}
      tools={
        view && view.rows.some(row => !expanded || !row.currentHold) ? (
          <Key
            size="sm"
            kind="ghost"
            disabled={busy || !state}
            onClick={async () => {
              const before = await send({ clearAll: true }, 'Cleared. Newer rows still show here.');
              if (before) setUndo(before);
            }}
          >
            Clear all
          </Key>
        ) : undefined
      }
    >
      {!view ? (
        <div className="quietline" aria-busy="true">
          Loading what happened…
        </div>
      ) : (
        <>
          {undo ? (
            <div className="pf needs-fold">
              <span>Cleared.</span>
              <Key
                size="sm"
                disabled={busy}
                onClick={async () => {
                  if (await send({ restore: undo }, 'The list is back as it was.')) setUndo(null);
                }}
              >
                Undo
              </Key>
            </div>
          ) : null}
          {view.rows.length ? (
            <div className="fyi-filter">
              <Segment
                label="Show"
                value={filter}
                options={FILTERS.map(option => ({
                  value: option.value,
                  text: `${option.text} ${view.counts[option.value].toLocaleString('en')}`,
                }))}
                onChange={changeFilter}
              />
            </div>
          ) : null}
          {rows.length ? (
            rows.slice(0, pageSize).map(row => (
              <NeedsCard
                key={row.key}
                className="fyi-row"
                status={
                  <>
                    <span className="mono t3 fyi-at">{when(row.at, drawnAt)}</span>
                    <State word={row.word}>{row.tag}</State>
                  </>
                }
                title={row.title}
                next={row.next}
                actions={
                  <>
                    {row.links.map(link =>
                      link.to.anchor ? (
                        <a key={link.label} className="lk" href={`#${link.to.anchor}`}>
                          {link.label}
                        </a>
                      ) : (
                        <A
                          key={link.label}
                          className="lk"
                          href={
                            link.focusLane
                              ? focusHref(href(link.to), link.focusLane)
                              : checkAttemptHref(href(link.to), link.checkAttempt)
                          }
                        >
                          {link.label}
                        </A>
                      ),
                    )}
                    {row.taken ? (
                      <TakenKeys
                        target={row.taken}
                        title={row.taken.title}
                        actions={taken}
                        announce={announce}
                        quiet
                      />
                    ) : null}
                    {row.taken || (expanded && row.currentHold) ? null : (
                      <button
                        type="button"
                        className="fyi-x"
                        aria-label={`Dismiss: ${row.title}`}
                        title="Dismiss"
                        disabled={busy}
                        onClick={() =>
                          void send({ keys: [row.key] }, 'Dismissed. It shows again if it changes.')
                        }
                      >
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 16 16"
                          aria-hidden="true"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.6"
                        >
                          <path d="M4 4l8 8M12 4l-8 8" />
                        </svg>
                      </button>
                    )}
                  </>
                }
              >
                {row.who || row.fact ? (
                  <p className="meta fyi-fact" dir="auto">
                    {row.who ? <Who handle={row.who} /> : null}
                    {row.who && row.fact ? ' · ' : null}
                    {row.fact}
                  </p>
                ) : null}
              </NeedsCard>
            ))
          ) : (
            <div className="quietline">
              {view.rows.length ? 'Nothing of this kind.' : `Nothing new ${sinceText(view.since, drawnAt)}.`}
            </div>
          )}
          <div className="pf needs-fold">
            {expanded ? (
              <Key size="sm" onClick={() => setLimit(FYI_CAP)}>
                Show fewer
              </Key>
            ) : (
              <Key
                size="sm"
                title="Everything Forge held, redid or refused"
                onClick={() => setLimit(2 * FYI_CAP)}
              >
                Show all
              </Key>
            )}
            {expanded && rows.length > pageSize ? (
              <Key size="sm" onClick={() => setLimit(pageSize + FYI_CAP)}>
                Show {Math.min(FYI_CAP, rows.length - pageSize)} more
              </Key>
            ) : null}
          </div>
        </>
      )}
    </Region>
  );
}
