// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { Doc } from './_generated/dataModel';

type ItemPurge = NonNullable<Doc<'hostedProjects'>['itemPurges']>[number];

/** Same-ID Intent-born Items can retain the standalone sentinel. A verified foreign binding
 * is authoritative; old in-progress purges also retained a visited legacy key list. */
export function purgeOwnsIntent(purge: ItemPurge, intentId: string, itemId?: string | null) {
  return (
    !purge.commentId &&
    (itemId
      ? itemId === purge.itemId
      : intentId === purge.itemId || purge.intentKeys?.includes(intentId) === true)
  );
}

/** The publication mutation has already selected the project. Its read fences a concurrent purge. */
export function itemLandingNotesPurging(project: Doc<'hostedProjects'>, itemId: string) {
  return project.itemPurges?.some(purge => !purge.commentId && purge.itemId === itemId) === true;
}
