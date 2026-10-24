// SPDX-License-Identifier: Apache-2.0
'use node';
import type { ActionCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { invariant } from '../src/errors';
import { mapExchange } from '../src/exchange-parallel';
/** Validate project-bound immutable receipts in pages; never cache authority. */
export async function validateExchangePins(
  ctx: ActionCtx,
  projectId: Id<'hostedProjects'>,
  actor: string,
  pins: { sha256: string; size: number }[],
) {
  const sizes = new Map<string, number>();
  for (const pin of pins) {
    invariant(
      !sizes.has(pin.sha256) || sizes.get(pin.sha256) === pin.size,
      'INVALID_WORK_BACKUP',
      'Identical content has inconsistent sizes.',
    );
    sizes.set(pin.sha256, pin.size);
  }
  const unique = [...new Map(pins.map(pin => [pin.sha256, pin])).values()];
  const pages = [];
  for (let offset = 0; offset < unique.length; offset += 100) pages.push(unique.slice(offset, offset + 100));
  await mapExchange(pages, 4, async page => {
    const rows: Doc<'projectObjects'>[] = await ctx.runQuery(internal.projectObjects.resolve, {
      projectId,
      actor,
      digests: page.map(pin => pin.sha256),
    });
    invariant(
      rows.length === page.length && rows.every((row, index) => row.size === page[index]!.size),
      'INVALID_WORK_BACKUP',
      'Checkpoint content size differs from uploaded bytes.',
    );
  });
}

/** A first-host project contains essentially this one closure. A paged index scan
 * is linear in stored rows and keeps missing/size checks exact, including holes
 * in the middle of a backfill. It is not a persistent validation cache. */
export async function validateHostedClosure(
  ctx: ActionCtx,
  projectId: Id<'hostedProjects'>,
  actor: string,
  pins: { sha256: string; size: number }[],
) {
  const remaining = new Map<string, number>();
  for (const pin of pins) {
    invariant(
      !remaining.has(pin.sha256) || remaining.get(pin.sha256) === pin.size,
      'INVALID_WORK_BACKUP',
      'Identical content has inconsistent sizes.',
    );
    remaining.set(pin.sha256, pin.size);
  }
  let cursor: string | null = null;
  while (remaining.size) {
    const result: {
      pins: { digest: string; size: number; stored: boolean }[];
      isDone: boolean;
      cursor: string;
    } = await ctx.runQuery(internal.projectObjectValidation.page, { projectId, actor, cursor });
    for (const pin of result.pins)
      if (remaining.has(pin.digest)) {
        invariant(
          pin.stored && remaining.get(pin.digest) === pin.size,
          'INVALID_WORK_BACKUP',
          'Checkpoint content size differs from uploaded bytes.',
        );
        remaining.delete(pin.digest);
      }
    if (result.isDone) break;
    cursor = result.cursor;
  }
  invariant(!remaining.size, 'INVALID_WORK_BACKUP', 'A retained history content object is unavailable.');
}
