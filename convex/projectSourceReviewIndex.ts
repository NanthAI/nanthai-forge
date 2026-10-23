// SPDX-License-Identifier: Apache-2.0
'use node';
import type { FunctionReturnType } from 'convex/server';
import type { ActionCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { internal } from './_generated/api';
import { exchangeObjectReader } from './projectExchangeReader';
import { digest } from '../src/hash';
import { invariant } from '../src/errors';

/** A disposable index miss restarts the same exact-backup manifest reader. */
export class ReviewIndexUnavailable extends Error {}

/** Indexed blob pins avoid loading every retained object just to read two States or one file. */
export async function indexedReviewBytes(ctx: ActionCtx, backup: Doc<'projectBackups'>, actor: string) {
  const args = { projectId: backup.projectId, owner: actor };
  const reader = exchangeObjectReader(ctx, true);
  return async (ids: string[]): Promise<Buffer[]> => {
    for (const id of ids)
      invariant(/^[a-f0-9]{64}$/.test(id), 'BAD_ARGUMENT', 'Select an exact native source identity.');
    const rows: FunctionReturnType<typeof internal.projectWorkIndexStore.lookups> = [];
    try {
      // Bound individual metadata queries while keeping every requested object reachable.
      for (let offset = 0; offset < ids.length; offset += 100)
        rows.push(
          ...(await ctx.runQuery(internal.projectWorkIndexStore.lookups, {
            ...args,
            backupId: backup._id,
            keys: ids.slice(offset, offset + 100).map(key => ({ collection: 'sourceBlobs', key })),
          })),
        );
    } catch (error) {
      const value = error as { code?: string; data?: { code?: string } };
      if ((value.data?.code ?? value.code) === 'WORK_STALE') throw new ReviewIndexUnavailable();
      throw error;
    }
    if (rows.length !== ids.length) throw new ReviewIndexUnavailable();
    const pins = rows.map((row, index) => {
      if (!row) throw new ReviewIndexUnavailable();
      let pin: { sha256: string; size: number };
      try {
        pin = JSON.parse(row.value);
      } catch {
        throw new ReviewIndexUnavailable();
      }
      if (pin.sha256 !== ids[index] || !Number.isSafeInteger(pin.size) || pin.size < 0)
        throw new ReviewIndexUnavailable();
      return pin;
    });
    // This reader checks current access, storage health, size and content identity before/after bytes.
    let values: Buffer[];
    try {
      values = await reader.read(backup.projectId, actor, pins);
    } catch (error) {
      const value = error as { code?: string; data?: { code?: string } };
      if (['INVALID_WORK_BACKUP', 'INVALID_NATIVE_SOURCE'].includes(value.data?.code ?? value.code ?? ''))
        throw new ReviewIndexUnavailable();
      throw error;
    }
    invariant(
      values.length === pins.length &&
        values.every((bytes, i) => bytes.length === pins[i]!.size && digest(bytes) === ids[i]),
      'INVALID_NATIVE_SOURCE',
      'Stored source differs from its exact identity.',
    );
    return values;
  };
}
