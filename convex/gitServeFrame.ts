// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { internalAction, type ActionCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { r2Config, r2Key, presignGet } from './r2';
import { convexFetch } from './networkFetch';
import { storeSourceBytes } from './projectSourceBytes';
import { discardHistoryChunks } from './projectHistoryImport';
import { historyChunk, historyChunkBytes } from './projectHistoryFields';
import { digest } from '../src/portable-hash';
import { ForgeError } from '../src/errors';
import { PackFramer } from '../src/git-worker-plan';
import { setTrailer } from './gitServeWorker';

type Chunk = { sha256: string; size: number };

/** Frames stored packs for Git protocol v2 on the Worker path (Issue 7c36abfb;
 * docs/git-serving.md): reads each pack's R2 chunks once and writes the side-band framed
 * copy as content-addressed R2 chunks of at most historyChunkBytes, then records them on
 * the pack rows in one mutation. One chunk (and one frame) is buffered at a time. Objects
 * whose record failed are deleted. */
async function framePacks(
  ctx: ActionCtx,
  projectId: Id<'hostedProjects'>,
  packs: { tip: string; bytes: number; chunks: Chunk[] }[],
): Promise<{ tip: string; framed: Chunk[] }[]> {
  const config = r2Config(),
    created: string[] = [],
    out: { tip: string; framed: Chunk[] }[] = [];
  try {
    for (const pack of packs) {
      const framer = new PackFramer(pack.bytes),
        framed: Chunk[] = [];
      let parts: Uint8Array[] = [],
        buffered = 0;
      const flush = async () => {
        if (!buffered) return;
        const bytes = Buffer.concat(parts, buffered);
        parts = [];
        buffered = 0;
        const pin = { sha256: digest(bytes), size: bytes.length };
        await storeSourceBytes(ctx, projectId, bytes, pin, false, wrote => {
          if (wrote) created.push(pin.sha256);
        });
        framed.push(pin);
      };
      const add = async (frames: Uint8Array[]) => {
        for (const piece of frames)
          for (let at = 0; at < piece.length;) {
            const take = Math.min(piece.length - at, historyChunkBytes - buffered);
            parts.push(piece.subarray(at, at + take));
            buffered += take;
            at += take;
            if (buffered === historyChunkBytes) await flush();
          }
      };
      for (const chunk of pack.chunks) {
        const response = await convexFetch(
          await presignGet(config, r2Key(projectId, chunk.sha256)),
          {},
          { totalTimeoutMs: 10 * 60_000 },
        );
        if (!response.ok || !response.body)
          throw new ForgeError(
            'GIT_PACK_UNAVAILABLE',
            `Stored history could not be read (R2 ${response.status}).`,
          );
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await add(framer.push(value));
        }
      }
      framer.end();
      await flush();
      out.push({ tip: pack.tip, framed });
    }
    const gone: string[] = await ctx.runMutation(internal.gitServeWorkerStore.setFramed, {
      projectId,
      packs: out,
    });
    const missing = new Set(gone);
    if (missing.size)
      await discardHistoryChunks(
        ctx,
        projectId,
        out.filter(pack => missing.has(pack.tip)).flatMap(pack => pack.framed.map(chunk => chunk.sha256)),
      );
    console.log(
      `FORGE_GIT_WORKER_METRIC ${JSON.stringify({ projectId, phase: 'frame', packs: packs.length, bytes: packs.reduce((sum, pack) => sum + pack.bytes, 0), chunks: out.reduce((sum, pack) => sum + pack.framed.length, 0) })}`,
    );
    return out.filter(pack => !missing.has(pack.tip));
  } catch (error) {
    await discardHistoryChunks(ctx, projectId, created);
    throw error;
  }
}

/** On a v2 Worker fetch of packs not framed yet (normally done ahead by `prepare`). */
export const frame = internalAction({
  args: {
    projectId: v.id('hostedProjects'),
    packs: v.array(v.object({ tip: v.string(), bytes: v.number(), chunks: v.array(historyChunk) })),
  },
  returns: v.array(v.object({ tip: v.string(), framed: v.array(historyChunk) })),
  handler: (ctx, { projectId, packs }): Promise<{ tip: string; framed: Chunk[] }[]> =>
    framePacks(ctx, projectId, packs),
});

/** Scheduled once when a pack is recorded on a project the Worker serves, so no clone waits:
 * frames the packs without a copy and caches the clone set's joined trailer. One query, then
 * one read of each new pack (and one of the set when it has several packs). */
export const prepare = internalAction({
  args: { projectId: v.id('hostedProjects') },
  returns: v.null(),
  handler: async (ctx, { projectId }): Promise<null> => {
    const loaded = await ctx.runQuery(internal.projectHistoryStore.load, { projectId });
    if (!loaded || loaded.row.status !== 'ready' || !loaded.packs.length) return null;
    const missing = loaded.packs.filter(pack => !pack.framed);
    if (missing.length)
      await framePacks(
        ctx,
        projectId,
        missing.map(({ tip, bytes, chunks }) => ({ tip, bytes, chunks })),
      );
    if (loaded.packs.length > 1) await setTrailer(ctx, projectId, loaded.packs, loaded.row.joined);
    return null;
  },
});
