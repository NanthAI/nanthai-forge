// SPDX-License-Identifier: Apache-2.0
import { useState, type ReactNode } from 'react';
import { Key } from '../../ds';

/** Shown at most this many per band; the rest open in place, oldest last (DESIGN.md rule 43). */
export const CAP = 4;

/** The first rows, then the rest opening in place (oldest last). A count beyond the read says so (rule 1). */
export function Capped<T>({
  rows,
  more,
  atLeast,
  cap = CAP,
  order = 'longest held first',
  children,
}: {
  rows: readonly T[];
  more: number;
  atLeast: boolean;
  cap?: number;
  order?: string;
  children: (row: T) => ReactNode;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, cap);
  const hidden = rows.length - shown.length;
  return (
    <>
      {shown.map(children)}
      {hidden ? (
        <div className="pf needs-fold">
          <span>
            {shown.length} of {rows.length + more}
            {atLeast ? ' or more' : ''}, {order}
          </span>
          <Key size="sm" onClick={() => setAll(true)}>
            Show {hidden} more
          </Key>
        </div>
      ) : more ? (
        <div className="pf">
          {rows.length} of {atLeast ? 'at least ' : ''}
          {rows.length + more} shown; the rest are in Lanes.
        </div>
      ) : null}
    </>
  );
}
