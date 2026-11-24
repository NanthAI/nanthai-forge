// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The FYI region (Needs me) and the Held page ("Held, redone or refused"): what the reader may want to know but need
// not act on, newest first, from projectNeedsFyi:read plus the held Lanes that ask nobody. On Needs me it shows the
// first rows and links to the Held page; there (`all`) it shows every row, with the same filter and Clear all.
import { useState, type ReactNode } from 'react';
import { Key, Region, Row, Segment, State, Who } from '../../ds';
import { A } from '../frames';
import { Capped } from './Capped';
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
];

/** "09:58" today, "Yesterday", or the date: when a row happened, in the reader's time. */
function when(at: number, now: number) {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const date = new Date(at);
  if (at >= day.getTime()) return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (at >= day.getTime() - 86_400_000) return 'Yesterday';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function Fyi({
  handle,
  view,
  state,
  drawnAt,
  dismiss,
  announce,
  href,
  heldHref,
  taken,
  all = false,
}: {
  handle: ReactNode;
  view: ReturnType<typeof fyiView> | null;
  state: FyiState | undefined;
  drawnAt: number;
  dismiss: Dismiss;
  announce: (text: string) => void;
  href: (to: FyiRow['links'][number]['to']) => string;
  /** The Held page's link (Needs me); absent on the Held page itself. */
  heldHref?: string;
  /** Bring a taken-out Lane back or leave it out (J08); absent on the Held page. */
  taken?: TakenActions;
  /** The Held page: every row, not the first few. */
  all?: boolean;
}) {
  const [filter, setFilter] = useState<'all' | Area>('all');
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
  return (
    <Region
      title="FYI"
      weight="watch"
      count={view ? view.counts.all : undefined}
      handle={handle}
      sum={view ? fyiSum(view) : undefined}
      hint={view ? `nothing to act on; counted ${sinceText(view.since, drawnAt)}` : undefined}
      tools={
        view && view.rows.length ? (
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
                onChange={setFilter}
              />
            </div>
          ) : null}
          {rows.length ? (
            <Capped
              rows={rows}
              more={0}
              atLeast={false}
              cap={all ? rows.length : FYI_CAP}
              order="newest first"
            >
              {row => (
                <Row key={row.key} cols="auto minmax(0, 1fr) auto auto" className="fyi-row">
                  <span className="mono t3 fyi-at">{when(row.at, drawnAt)}</span>
                  <span className="ttl" dir="auto">
                    <State word={row.word}>{row.tag}</State> {row.title}
                    <span className="meta fyi-fact">
                      {row.who ? (
                        <>
                          <Who handle={row.who} />
                          {row.fact ? ' · ' : ''}
                        </>
                      ) : null}
                      {row.fact}
                    </span>
                  </span>
                  <span className="fyi-links">
                    {row.links.map(link => (
                      <A
                        key={link.label}
                        className="lk"
                        href={link.focusLane ? focusHref(href(link.to), link.focusLane) : href(link.to)}
                      >
                        {link.label}
                      </A>
                    ))}
                    {row.taken ? (
                      <TakenKeys
                        target={row.taken}
                        title={row.taken.title}
                        actions={taken}
                        announce={announce}
                        quiet
                      />
                    ) : null}
                  </span>
                  {row.taken ? null : (
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
                </Row>
              )}
            </Capped>
          ) : (
            <div className="quietline">
              {view.rows.length ? 'Nothing of this kind.' : `Nothing new ${sinceText(view.since, drawnAt)}.`}
            </div>
          )}
          {heldHref ? (
            <Row cols="minmax(0, 1fr) auto">
              <A href={heldHref} className="lk">
                Everything Forge held, redid or refused
              </A>
              <span className="t3" aria-hidden="true">
                ›
              </span>
            </Row>
          ) : null}
        </>
      )}
    </Region>
  );
}
