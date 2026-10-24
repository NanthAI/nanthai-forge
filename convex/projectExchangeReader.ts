// SPDX-License-Identifier: Apache-2.0
'use node';
import type { ActionCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { invariant } from '../src/errors';
import {
  rawMetadata as metadata,
  rawContent as content,
  objectContent,
  isRaw,
  rawKey,
} from './projectObjectContent';

import { reviewBytes } from './projectReviewBytes';

type Pin = { sha256: string; size: number };
export async function bytesFromRow(ctx: ActionCtx, row: Doc<'projectObjects'>, pin: Pin, actor?: string) {
  if (isRaw(row)) {
    await metadata(ctx, row, pin);
    return content(ctx, row, pin);
  }
  const subject = actor ?? (await ctx.auth.getUserIdentity())?.subject;
  invariant(subject, 'PROJECT_UNAVAILABLE', 'Sign in to read project source.');
  return objectContent(ctx, row, pin, subject);
}
export type ExchangeObjectReader = {
  read(projectId: Id<'hostedProjects'>, actor: string, pins: Pin[]): Promise<Buffer[]>;
};

/** One action owns this memo. It contains verified immutable bytes, never authority
 * or a Work snapshot. Every use resolves current project access and availability
 * before and after reading, including memo hits. Readers may additionally reuse raw bytes across
 * actions, after fresh current storage metadata checks; recipes always revalidate their closure. */
export function exchangeObjectReader(
  ctx: ActionCtx,
  reuseImmutableBytes = false,
  budget = 8 * 1024 * 1024,
): ExchangeObjectReader {
  const verified = new Map<string, Promise<Buffer>>();
  let retained = 0;
  const reservations = new WeakMap<Promise<Buffer>, number>();
  return {
    async read(projectId, actor, pins) {
      const args = { projectId, actor, digests: pins.map(pin => pin.sha256) };
      const rows: Doc<'projectObjects'>[] = await ctx.runQuery(internal.projectObjects.resolve, args);
      invariant(
        rows.length === pins.length,
        'INVALID_WORK_BACKUP',
        'Stored content lookup omitted selected bytes.',
      );
      const outcomes = await Promise.allSettled(
        rows.map(async (row, index) => {
          const pin = pins[index]!;
          // Recipes retain no whole-object memo: each read checks its current
          // project-bound closure, while raw immutable nodes use the existing memo.
          if (!isRaw(row))
            return objectContent(
              ctx,
              row,
              pin,
              actor,
              new Set(),
              reuseImmutableBytes ? reviewBytes : content,
            );
          // Storage metadata confirms the object still exists even on a memo hit.
          await metadata(ctx, row, pin);
          const key = JSON.stringify([projectId, pin.sha256, pin.size, rawKey(row)]);
          let pending = verified.get(key);
          if (!pending) {
            pending = reuseImmutableBytes ? reviewBytes(ctx, row, pin) : content(ctx, row, pin);
            // Reserve by the exact pin before awaiting: concurrent batches share
            // the same bounded budget. Oversized objects are read without caching.
            if (pin.size <= budget) {
              while (retained + pin.size > budget) {
                const oldest = verified.keys().next().value!;
                const previous = verified.get(oldest)!;
                verified.delete(oldest);
                retained -= reservations.get(previous) ?? 0;
              }
              verified.set(key, pending);
              reservations.set(pending, pin.size);
              retained += pin.size;
            }
            pending.catch(() => {
              if (verified.get(key) === pending) {
                verified.delete(key);
                retained -= pin.size;
              }
            });
          }
          return Buffer.from(await pending);
        }),
      );
      await ctx.runQuery(internal.projectObjects.resolve, args);
      const bytes: Buffer[] = [];
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') throw outcome.reason;
        bytes.push(outcome.value);
      }
      return bytes;
    },
  };
}
