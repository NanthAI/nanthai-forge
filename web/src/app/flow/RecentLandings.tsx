// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { State } from '../../ds';
import { A } from '../frames';
import type { LineFeed } from '../Line';
import { clock } from './model';

export function RecentLandings({
  rows,
  fyiLandings,
  history,
  drawnAt,
}: {
  rows: LineFeed['recentLandings'];
  fyiLandings?: readonly { receiptId: string; title: string | null }[] | undefined;
  history: string;
  drawnAt: number;
}) {
  if (!rows) return null;
  return (
    <nav className="flow-recent" aria-label="Recent landings">
      <b>Recent landings</b>
      {rows.length ? (
        <ol>
          {rows.map(row => {
            // FYI already resolves message references for the receipts it returns.
            const title =
              row.title ?? fyiLandings?.find(landing => landing.receiptId === row.receiptId)?.title;
            return (
              <li key={row.receiptId}>
                <A href={`${history}/${encodeURIComponent(row.receiptId)}`}>
                  <span className="flow-recent-title cut" dir="auto" title={title ?? undefined}>
                    {title ?? 'Landing'}
                  </span>
                  <span className="flow-recent-id num" dir="ltr">
                    #{row.sequence}
                  </span>
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
            );
          })}
        </ol>
      ) : (
        <span className="nr">Nothing has landed yet.</span>
      )}
    </nav>
  );
}
