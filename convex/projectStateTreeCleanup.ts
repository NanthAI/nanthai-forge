// SPDX-License-Identifier: Apache-2.0
// One-shot operator cleanup for the rolled-back "trees in packs" experiment (docs/decisions.md,
// Issue 676efbc2). It is deleted in the landing that follows its run. Everything here is internal.
import { v } from 'convex/values';
import { internalAction } from './_generated/server';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { internalMutation, internalQuery } from './server';
import { convexFetch, networkTimeout } from './networkFetch';
import { presignDelete, presignGet, r2Config, r2Key } from './r2';

const maxSegmentBytes = 2 * 1024 * 1024;
const row = v.object({ id: v.id('projectObjects'), digest: v.string(), size: v.number() });

/** One page of the project's object rows, newest first, from `after` (ms) on. Returns the plain
 * R2 rows that could be segments and the States that still carry a pointer. */
export const page = internalQuery({
  args: { projectId: v.id('hostedProjects'), cursor: v.union(v.string(), v.null()), after: v.number() },
  returns: v.any(),
  handler: async (ctx, { projectId, cursor, after }) => {
    const result = await ctx.db
      .query('projectObjects')
      .withIndex('by_project', q => q.eq('projectId', projectId))
      .order('desc')
      .paginate({ cursor, numItems: 200 });
    const rows = result.page.filter(object => object._creationTime >= after);
    return {
      cursor: result.continueCursor,
      done: result.isDone || rows.length < result.page.length,
      scanned: result.page.length,
      candidates: rows
        .filter(
          object =>
            !object.removed &&
            !object.stateParents &&
            !object.pack &&
            !object.recipe &&
            object.location === 'r2' &&
            object.r2Committed &&
            object.size >= 12 &&
            object.size <= maxSegmentBytes,
        )
        .map(object => ({ id: object._id, digest: object.digest, size: object.size })),
      pointers: rows
        .filter(object => object.stateTree)
        .map(object => ({ id: object._id, segment: (object.stateTree as { segment: string }).segment })),
    };
  },
});

/** Delete the named segment rows and clear the named pointers. A row is deleted only when it still
 * names the same digest and size and is a plain R2 object that is no State. */
export const drop = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    rows: v.array(row),
    pointers: v.array(v.id('projectObjects')),
    project: v.boolean(),
  },
  returns: v.object({ deleted: v.number(), cleared: v.number() }),
  handler: async (ctx, { projectId, rows, pointers, project }) => {
    let deleted = 0,
      cleared = 0;
    for (const expected of rows) {
      const object = await ctx.db.get(expected.id);
      if (
        object &&
        object.projectId === projectId &&
        object.digest === expected.digest &&
        object.size === expected.size &&
        !object.stateParents &&
        object.r2Key === r2Key(projectId, object.digest)
      ) {
        await ctx.db.delete(object._id);
        deleted++;
      }
    }
    for (const id of pointers) {
      const object = await ctx.db.get(id);
      if (object?.projectId === projectId && object.stateTree) {
        await ctx.db.patch(id, { stateTree: undefined });
        cleared++;
      }
    }
    if (project) await ctx.db.patch(projectId, { stateTrees: undefined });
    return { deleted, cleared };
  },
});

/** A tree segment ends with its header, the header's length and the magic FTS1. */
async function isSegment(projectId: string, digest: string, size: number) {
  const config = r2Config(),
    key = r2Key(projectId, digest);
  const ranged = async (start: number, end: number) => {
    const headers = { Range: `bytes=${start}-${end}` },
      response = await convexFetch(await presignGet(config, key, headers), {
        headers: { 'accept-encoding': 'identity', ...headers },
        redirect: 'error',
        signal: networkTimeout(15_000),
      });
    if (response.status !== 206) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    return new Uint8Array(await response.arrayBuffer());
  };
  const tail = await ranged(size - 8, size - 1);
  if (!tail || tail.length !== 8 || new TextDecoder().decode(tail.subarray(4)) !== 'FTS1') return false;
  const headerBytes = new DataView(tail.buffer, tail.byteOffset, 4).getUint32(0);
  if (headerBytes + 8 > size) return false;
  const header = await ranged(size - 8 - headerBytes, size - 9);
  try {
    return JSON.parse(new TextDecoder().decode(header ?? new Uint8Array())).kind === 'forge-tree-segment';
  } catch {
    return false;
  }
}

/** One page: find the segments among the page's candidates and, with `apply`, delete their R2
 * objects and rows and clear the pointers. Call again with `cursor` until `done`. `project` also
 * clears the project's `stateTrees` field (give it on the last call only). */
export const run = internalAction({
  args: {
    projectId: v.id('hostedProjects'),
    after: v.number(),
    cursor: v.union(v.string(), v.null()),
    apply: v.boolean(),
    project: v.optional(v.boolean()),
  },
  returns: v.any(),
  handler: async (ctx, { projectId, after, cursor, apply, project }) => {
    const page: {
      cursor: string;
      done: boolean;
      scanned: number;
      candidates: { id: Id<'projectObjects'>; digest: string; size: number }[];
      pointers: { id: Id<'projectObjects'>; segment: string }[];
    } = await ctx.runQuery(internal.projectStateTreeCleanup.page, { projectId, cursor, after });
    const found: typeof page.candidates = [];
    for (let at = 0; at < page.candidates.length; at += 10)
      await Promise.all(
        page.candidates.slice(at, at + 10).map(async candidate => {
          if (await isSegment(projectId, candidate.digest, candidate.size)) found.push(candidate);
        }),
      );
    let deleted = 0,
      cleared = 0,
      gone = 0;
    if (apply) {
      for (const segment of found) {
        const response = await convexFetch(
          await presignDelete(r2Config(), r2Key(projectId, segment.digest)),
          {
            method: 'DELETE',
            redirect: 'error',
            signal: networkTimeout(20_000),
          },
        );
        if (response.ok || response.status === 404) gone++;
        else throw new Error(`R2 delete answered ${response.status}`);
      }
      ({ deleted, cleared } = await ctx.runMutation(internal.projectStateTreeCleanup.drop, {
        projectId,
        rows: found,
        pointers: page.pointers.map(pointer => pointer.id),
        project: !!project && page.done,
      }));
    }
    return {
      cursor: page.cursor,
      done: page.done,
      scanned: page.scanned,
      segments: found.length,
      bytes: found.reduce((sum, segment) => sum + segment.size, 0),
      pointers: page.pointers.length,
      // Pointers whose segment is not among this page's finds (it may sit on another page).
      foundDigests: found.map(segment => segment.digest),
      pointerSegments: page.pointers.map(pointer => pointer.segment),
      gone,
      deleted,
      cleared,
    };
  },
});
