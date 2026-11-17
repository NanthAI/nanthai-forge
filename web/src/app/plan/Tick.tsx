// SPDX-License-Identifier: Apache-2.0
// One row's tick box on the Plan screen (Item 65b0e706): one press, one row; nothing else is selected for you.
import type { PlanRow } from '../../../../src/planning-model';

export type Ticker = { picked: ReadonlySet<string>; tick: (id: string) => void };

export function Tick({ row, ticker }: { row: Pick<PlanRow, 'id' | 'title'>; ticker: Ticker }) {
  return (
    <label className="ckhit">
      <input
        type="checkbox"
        className="ckb"
        aria-label={`Select ${row.title}`}
        checked={ticker.picked.has(row.id)}
        onChange={() => ticker.tick(row.id)}
      />
    </label>
  );
}
