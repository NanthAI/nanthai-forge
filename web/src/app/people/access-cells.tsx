// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The access table's yes / no cells, shared by the people rows and the linked-team rows of People and access.
export const Yes = ({ what }: { what: string }) => (
  <span className="yes" role="img" aria-label={`may ${what}`}>
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="m3 8.5 3.2 3.2L13 4.8" />
    </svg>
  </span>
);
export const No = ({ what }: { what: string }) => (
  <span className="t3" role="img" aria-label={`may not ${what}`}>
    –
  </span>
);
export const Cell = ({ k, on }: { k: string; on: boolean }) => (
  <span className="c">
    <span className="k">{k}</span>
    {on ? <Yes what={k.toLowerCase()} /> : <No what={k.toLowerCase()} />}
  </span>
);
