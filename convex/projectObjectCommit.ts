// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { action, internalQuery, internalMutation, type ActionCtx } from './cliServer';
import type { Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { activeProject } from './projectAuthority';
import { r2Config, headObject, checksumOf, presignGet, type HeadResult } from './r2';
import { invariant } from '../src/errors';
import { report } from './errors';
import { bindPackMembers } from './projectObjectPacks';
import { pointObject } from './projectObjectPointBinding';
import { findStoredObject } from './projectObjectFind';
import { readExactObject } from './projectR2ExactRead';
import { uploadPackMismatch } from '../src/object-pack-upload';
import { mapExchange } from '../src/exchange-parallel';

const member = v.object({ digest: v.string(), size: v.number() });
const pending = v.object({
  id: v.id('projectObjects'),
  digest: v.string(),
  size: v.number(),
  key: v.string(),
  /** An upload pack's members (feature upload-packs), checked by reading the pack. */
  members: v.optional(v.array(member)),
});
/** Rows of this caller's R2 uploads that still need a HEAD check. */
export const pendingRows = internalQuery({
  args: { actor: v.string(), ids: v.array(v.id('projectObjects')) },
  returns: v.array(pending),
  handler: async (ctx, { actor, ids }) => {
    try {
      const rows = [];
      for (const id of ids) {
        const row = await ctx.db.get(id);
        if (!row) {
          const receipt = await ctx.db
            .query('projectObjectReceipts')
            .withIndex('by_key', q => q.eq('key', id))
            .unique();
          invariant(receipt, 'PROJECT_UNAVAILABLE', 'This original upload is unavailable.');
          await activeProject(ctx, receipt.projectId, actor);
          const stored = receipt.sourceBinding
            ? pointObject(receipt, receipt.projectId, receipt.value)
            : await findStoredObject(ctx, receipt.projectId, receipt.value);
          invariant(
            stored &&
              !stored.removed &&
              (receipt.size === undefined || stored.size === receipt.size) &&
              (stored.recipe || stored.r2Committed),
            'PROJECT_UNAVAILABLE',
            'This original upload is unavailable.',
          );
          continue;
        }
        await activeProject(ctx, row.projectId, actor);
        invariant(
          row.location === 'r2' && row.r2Key,
          'BAD_ARGUMENT',
          'This object is not in object storage.',
        );
        invariant(
          row.r2Committed || row.r2SweepKey !== row.r2Key,
          'R2_OBJECT_MISSING',
          'Prepare this abandoned upload again before committing.',
        );
        if (!row.removed && !row.r2Committed)
          rows.push({
            id,
            digest: row.digest,
            size: row.size,
            key: row.r2Key,
            ...(row.packMembers ? { members: row.packMembers } : {}),
          });
      }
      return rows;
    } catch (error) {
      return report(error);
    }
  },
});
export const markCommitted = internalMutation({
  args: { rows: v.array(pending) },
  returns: v.null(),
  handler: async (ctx, { rows }) => {
    for (const expected of rows) {
      const id = expected.id;
      const row = await ctx.db.get(id);
      invariant(
        !row ||
          row.removed ||
          row.r2Committed ||
          (row.r2Key === expected.key && row.r2SweepKey !== expected.key),
        'R2_OBJECT_MISSING',
        'Prepare this upload again after storage maintenance.',
      );
      if (
        row &&
        row.r2Key === expected.key &&
        row.r2SweepKey !== expected.key &&
        row.digest === expected.digest &&
        row.size === expected.size &&
        row.location === 'r2' &&
        !row.removed &&
        !row.r2Committed
      ) {
        if (expected.members) {
          // The members this commit read and checked are the ones the row still names.
          invariant(
            JSON.stringify(row.packMembers) === JSON.stringify(expected.members),
            'R2_OBJECT_MISSING',
            'Prepare this upload pack again: its members changed.',
          );
          await bindPackMembers(
            ctx,
            { projectId: row.projectId, digest: row.digest, size: row.size, r2Key: expected.key },
            expected.members,
          );
        }
        await ctx.db.patch(id, { r2Committed: true, packMembers: undefined });
      }
    }
    return null;
  },
});

/** The first reason an object fails verification, or null when it matches. */
function mismatch(row: { digest: string; size: number }, head: HeadResult) {
  if (head.status === 'missing')
    return ['R2_OBJECT_MISSING', 'An uploaded object is not in object storage yet. Upload it again.'];
  if (head.status === 'error')
    return ['R2_VERIFY_FAILED', `Object storage could not confirm an upload (${head.detail}). Retry.`];
  if (head.size !== row.size)
    return ['R2_OBJECT_SIZE_MISMATCH', 'An uploaded object has a different size than declared.'];
  if (head.checksum && head.checksum !== checksumOf(row.digest))
    return ['R2_OBJECT_CHECKSUM_MISMATCH', 'An uploaded object has a different checksum than declared.'];
  return null;
}
/** Verify each new R2 object with one signed HEAD (in parallel), then mark the verified rows
 * committed. Failures leave their rows pending; retrying the same call is safe and cheap. */
export const commitBatch = action({
  args: { objects: v.array(v.object({ id: v.id('projectObjects') })) },
  returns: v.null(),
  handler: async (ctx, { objects }): Promise<null> => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to exchange project source.');
      await commitObjects(ctx, user.subject, objects);
      return null;
    } catch (error) {
      return report(error);
    }
  },
});
/** An upload pack (feature upload-packs) is read once, whole: R2's checksum covers the pack, not
 * its members, so every member digest is checked here before any member row exists. A mismatch
 * fails closed and binds nothing; the pending pack is swept like any abandoned upload, and a later
 * upload of the same digests prepares afresh. */
async function packMismatch(
  config: ReturnType<typeof r2Config>,
  row: { key: string; size: number; members: { digest: string; size: number }[] },
  held?: Map<string, Uint8Array>,
) {
  let bytes: Uint8Array;
  try {
    bytes = await readExactObject(
      { url: await presignGet(config, row.key), size: row.size },
      {
        failed: 'Object storage could not read an upload pack. Retry.',
        exceeds: 'An upload pack is larger than declared.',
      },
    );
  } catch {
    return ['R2_VERIFY_FAILED', 'Object storage could not read an upload pack. Retry.'];
  }
  if (uploadPackMismatch(bytes, row))
    return ['R2_OBJECT_CHECKSUM_MISMATCH', 'An upload pack member differs from its declared digest.'];
  // A save packs its blobs first and its pages (and input) last: hold from the end.
  let end = row.size;
  for (const member of [...row.members].reverse()) {
    const total = [...(held?.values() ?? [])].reduce((sum, value) => sum + value.length, 0);
    if (held && total + member.size <= heldBytes)
      held.set(member.digest, bytes.slice(end - member.size, end));
    end -= member.size;
  }
  return null;
}
/** Checked members the caller's step may read from memory (a save's delta page and input). */
const heldBytes = 128 * 1024;
/** The commit round of `commitBatch`, also run by `projectSourceRun:submit` before its submit.
 * Returns the pins this call committed after its HEAD matched their exact size AND their sha256
 * checksum (rows already committed, or a HEAD without a checksum, are not listed), and the members
 * of each upload pack it read and checked. `held` collects the small checked members' bytes. */
export async function commitObjects(
  ctx: ActionCtx,
  actor: string,
  objects: readonly { id: Id<'projectObjects'> }[],
  held?: Map<string, Uint8Array>,
  bindings?: Map<
    string,
    { sha256: string; size: number; r2Key: string; pack?: import('../src/object-pack-range').ObjectPack }
  >,
): Promise<{ sha256: string; size: number }[]> {
  invariant(objects.length <= 100, 'BAD_ARGUMENT', 'Commit content in pages of at most 100.');
  if (!objects.length) return [];
  const rows: {
    id: Id<'projectObjects'>;
    digest: string;
    size: number;
    key: string;
    members?: { digest: string; size: number }[];
  }[] = await ctx.runQuery(internal.projectObjectCommit.pendingRows, {
    actor,
    ids: objects.map(object => object.id),
  });
  if (!rows.length) return [];
  const config = r2Config();
  // Raw rows HEAD all at once; pack reads hold at most two packs (2 x 8 MiB) in memory.
  const [heads, packs] = await Promise.all([
    Promise.all(
      rows
        .filter(row => !row.members)
        .map(async row => {
          const head = await headObject(config, row.key);
          return {
            row,
            checked: head.status === 'ok' && head.checksum === checksumOf(row.digest),
            failure: mismatch(row, head),
          };
        }),
    ),
    mapExchange(
      rows.filter(row => row.members),
      2,
      async row => {
        const failure = await packMismatch(config, { ...row, members: row.members! }, held);
        return { row, checked: !failure, failure };
      },
    ),
  ]);
  const results = [...heads, ...packs];
  const verified = results.filter(r => !r.failure).map(r => r.row);
  if (verified.length) await ctx.runMutation(internal.projectObjectCommit.markCommitted, { rows: verified });
  const failed = results.find(r => r.failure);
  invariant(!failed, failed?.failure?.[0] ?? '', failed?.failure?.[1] ?? '');
  for (const { row, checked } of results) {
    if (!checked) continue;
    bindings?.set(row.digest, { sha256: row.digest, size: row.size, r2Key: row.key });
    let offset = 0;
    for (const member of row.members ?? []) {
      bindings?.set(member.digest, {
        sha256: member.digest,
        size: member.size,
        r2Key: row.key,
        pack: { digest: row.digest, size: row.size, offset },
      });
      offset += member.size;
    }
  }
  return results.flatMap(({ row, checked }) =>
    checked
      ? [
          { sha256: row.digest, size: row.size },
          ...(row.members ?? []).map(member => ({ sha256: member.digest, size: member.size })),
        ]
      : [],
  );
}
