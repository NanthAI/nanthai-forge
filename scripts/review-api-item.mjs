// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The Item as review text for scripts/review-api.mjs and scripts/review-mock.mjs (Items f082efd6, 3bd3eb0f).

/** The Item as review text: title, body and comments (which can amend Done-when), one `planning` read. */
export async function readItem(deps, lane, itemId) {
  const read = await deps.nforge(lane, 'planning', { planningItemId: itemId });
  const it = read.result?.item;
  const list = read.result?.comments ?? [];
  const comments = list
    .map(c => `- ${c.body ?? c.text ?? ''}`)
    .join('\n')
    .slice(0, 8_000);
  return {
    text: `${it?.title ?? ''}\n${(it?.body ?? '').slice(0, 16_000)}${comments ? `\n\nComments (can amend Done-when):\n${comments}` : ''}`,
    notes: list.length >= 50 ? ['The Item has 50 or more comments; older ones may be missing.'] : [],
  };
}
