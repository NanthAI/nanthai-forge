// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Pure: imports nothing; used by the web Plan screen and, loaded only when a read names one of these fields, by the
// agent `planning` read (Item e0a23825). One rule for both, so a saved web view is a shortcut to the same call.

/** Filter fields beyond kind, status and initiativeId (which the indexed read already takes). `owner: "none"` and
 * `relation: "none"` match Items with no owner or no relation. */
export type PlanFilter = {
  type?: string | undefined;
  owner?: string | undefined;
  relation?: 'depends-on' | 'duplicate-of' | 'related' | 'none' | undefined;
};

const handle = (value: string) => value.trim().toLowerCase().replace(/^@/, '');
export function planFilterMatch(
  row: {
    type?: string | null | undefined;
    owner?: string | null | undefined;
    relations?: readonly { kind: string }[] | undefined;
  },
  filter: PlanFilter,
) {
  if (filter.type && (row.type ?? '').toLowerCase() !== filter.type.trim().toLowerCase()) return false;
  if (filter.owner) {
    const want = handle(filter.owner);
    // A person's handle also matches the agents working for them (`handle/agent`).
    const owner = row.owner ? handle(row.owner) : '';
    if (
      want === 'none'
        ? Boolean(owner)
        : owner !== want && !(want.indexOf('/') < 0 && owner.startsWith(`${want}/`))
    )
      return false;
  }
  if (filter.relation) {
    const kinds = row.relations ?? [];
    if (filter.relation === 'none' ? kinds.length : !kinds.some(item => item.kind === filter.relation))
      return false;
  }
  return true;
}
