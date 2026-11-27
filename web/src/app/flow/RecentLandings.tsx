// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { State } from '../../ds';
import { A } from '../frames';
import type { LineFeed } from '../Line';
import { clock } from './model';

export function RecentLandings({
  rows,
  history,
  drawnAt,
}: {
  rows: LineFeed['recentLandings'];
  history: string;
  drawnAt: number;
}) {
  if (!rows) return null;
  return (
    <nav className="flow-recent" aria-label="Recent landings">
      <b>Recent landings</b>
      {rows.length ? (
        <ol>
          {rows.map(row => (
            <li key={row.receiptId}>
              <A href={`${history}/${encodeURIComponent(row.receiptId)}`}>
                <span dir="auto">{row.title ?? `Landing ${row.sequence.toLocaleString()}`}</span>
                <time className="num" dateTime={row.at} title={new Date(row.at).toLocaleString()}>
                  {clock(Date.parse(row.at), drawnAt)}
                </time>
                {row.takenOut ? (
                  <State word="Set aside">Taken out of main</State>
                ) : row.revert ? (
                  <State word="Set aside">Revert</State>
                ) : null}
              </A>
            </li>
          ))}
        </ol>
      ) : (
        <span className="nr">Nothing has landed yet.</span>
      )}
    </nav>
  );
}
