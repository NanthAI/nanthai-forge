// SPDX-License-Identifier: Apache-2.0
'use node';
import { ownerDerivedSchema, OWNER_DERIVED_MAX_BYTES, type OwnerDerived } from '../src/owner-derived';
import { ownerDerivedRows } from './projectOwnerDerived';
import type { Cursor } from './projectSourceReturnStep';
import type { IndexEntry } from '../src/work-hosted-index';
export type OwnerCoverage = {
  parents: OwnerDerived['parents'];
  stats: OwnerDerived['stats'];
  views: [number, IndexEntry[]][];
  trees: OwnerDerived['trees'];
};
/** Validate independent display facts independently. Missing rows must not discard
 * valid rows from another phase (or another item in the same phase). */
export function ownerCoverage(c: Cursor, value: unknown): OwnerCoverage | undefined {
  if (Buffer.byteLength(JSON.stringify(value)) > OWNER_DERIVED_MAX_BYTES) return;
  const parsed = ownerDerivedSchema.safeParse(value);
  if (!parsed.success || parsed.data.work !== JSON.parse(c.final.command).workSha256) return;
  const d = parsed.data;
  const empty: OwnerDerived = {
    schema: 2,
    work: d.work,
    parents: [],
    ancestry: [],
    stats: [],
    views: [],
    trees: [],
  };
  const cursor = (changes: Partial<Cursor> = {}): Cursor => ({
    ...c,
    pending: [],
    parents: [],
    heads: [],
    diffstats: undefined,
    delta: {
      entries: [],
      removed: [],
      views: [],
      summaries: [],
      positions: {},
      stopParents: [],
      trees: [],
      readBytes: 0,
      payloadReplacements: 0,
    },
    ...changes,
  });
  const coverage: OwnerCoverage = { parents: [], stats: [], views: [], trees: [] };
  const unique = <T extends readonly [string, ...unknown[]]>(rows: T[]) =>
    rows.filter(
      ([key], i) =>
        rows.findIndex(([other]) => key === other) === i &&
        rows.filter(([other]) => key === other).length === 1,
    );
  for (const row of unique(d.parents)) {
    const unit = cursor({ pending: [row[0]] });
    unit.delta!.stopParents = row[1];
    if (ownerDerivedRows(unit, { ...empty, parents: [row] })) coverage.parents.push(row);
  }
  for (const row of unique(d.stats)) {
    const [base, head] = row[0].split(':');
    const unit = cursor({
      diffstats: {
        index: 0,
        cache: [],
        records: [
          { collection: 'lanes', key: '', parent: '', position: 0, value: JSON.stringify({ base, head }) },
        ],
      },
    });
    if (ownerDerivedRows(unit, { ...empty, stats: [row] })) coverage.stats.push(row);
  }
  for (const row of unique(d.views)) {
    const index = c.snapshot.data.views.findIndex(view => view.id === row[0]);
    if (index < 0) continue;
    const unit = cursor();
    unit.delta!.views = [index];
    const rows = ownerDerivedRows(unit, { ...empty, views: [row] });
    if (rows) coverage.views.push([index, rows]);
  }
  for (const row of unique(d.trees)) {
    const unit = cursor();
    unit.delta!.trees = [row[0]];
    if (ownerDerivedRows(unit, { ...empty, trees: [row] })) coverage.trees.push(row);
  }
  return coverage;
}
