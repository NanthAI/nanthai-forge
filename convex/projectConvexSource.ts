// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalAction, type ActionCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import {
  initialSourceStep,
  enqueueSourceObject,
  runSourceStep,
  type StepTransport,
  type SourceStepCursor,
} from '../src/hosted-source-step';
import type { WorkerObject } from '../src/hosted-source-worker-format';
import { applySourceFanout, type SourceFanout, type SourceTaskProgress } from '../src/hosted-source-fanout';
import { loadTaskData } from '../src/hosted-source-task-data';
import type { SourceOutput } from './projectConvexSourceOutput';
import { digest } from '../src/hash';
import {
  loadSourceProgress,
  saveSourceProgress,
  type SourceProgress,
} from '../src/hosted-source-step-progress';
import { ForgeError, invariant } from '../src/errors';
const identity = { projectId: v.id('hostedProjects'), jobId: v.string() };
const reference = (name: string) => makeFunctionReference<'mutation'>(name);
export const dispatch = internalAction({
  args: identity,
  returns: v.union(v.literal('idle'), v.literal('observed'), v.literal('unknown')),
  handler: async (ctx, input) => ctx.runMutation(reference('projectConvexSourceStore:dispatch'), input),
});
type ObjectLocation = { descriptor: WorkerObject; storageId: Id<'_storage'> | null; url: string | null };
export function convexSourceTransport(
  ctx: ActionCtx,
  { projectId, jobId, step }: { projectId: Id<'hostedProjects'>; jobId: string; step: number },
  initial: ObjectLocation[] = [],
) {
  // Fan-out tasks pass their wider identity; the object validator accepts only these fields.
  const input = { projectId, jobId, step };
  const locations = new Map<string, ObjectLocation>(initial.map(row => [row.descriptor.object.sha256, row])),
    outputs: SourceOutput[] = [];
  const resolve = async (
    ids: string[],
    ancestry = false,
    known: string[] = [],
    windows = 1,
  ): Promise<WorkerObject[]> => {
    const rows: ObjectLocation[] = JSON.parse(
      await ctx.runMutation(reference('projectConvexSourceObjects:resolve'), {
        ...input,
        digests: ids,
        ancestry,
        known,
        windows,
      }),
    );
    for (const row of rows) locations.set(row.descriptor.object.sha256, row);
    // A byte-bounded response can be a prefix; ordinary descriptor requests
    // continue the remainder without creating per-file RPCs.
    if (!ancestry && rows.length < ids.length) {
      invariant(rows.length > 0, 'SOURCE_UNAVAILABLE', 'Object window made no progress.');
      return [...rows.map(r => r.descriptor), ...(await resolve(ids.slice(rows.length)))];
    }
    return rows.map(row => row.descriptor);
  };
  const io: StepTransport = {
    publishRecipe: async (object, recipe) => {
      outputs.push({ ...object, recipe });
    },
    describeBatch: ids => resolve(ids),
    ancestry: (ids, known, windows = 1) => resolve(ids, true, known, windows),
    prepareRead: async pins => {
      const missing = [
        ...new Map(pins.filter(pin => !locations.has(pin.sha256)).map(pin => [pin.sha256, pin])).values(),
      ];
      for (let offset = 0; offset < missing.length; offset += 100)
        await resolve(missing.slice(offset, offset + 100).map(p => p.sha256));
    },
    read: async pin => {
      if (!locations.has(pin.sha256)) await resolve([pin.sha256]);
      const row = locations.get(pin.sha256)!;
      invariant(
        row.descriptor.object.size === pin.size,
        'SOURCE_HASH_MISMATCH',
        'Source physical size changed.',
      );
      const blob = row.storageId ? await ctx.storage.get(row.storageId) : null;
      if (blob)
        return (async function* () {
          const reader = blob.stream().getReader();
          try {
            for (;;) {
              const part = await reader.read();
              if (part.done) break;
              yield part.value;
            }
          } finally {
            await reader.cancel();
          }
        })();
      invariant(row.url, 'SOURCE_UNAVAILABLE', 'Exact source bytes are unavailable.');
      const response = await fetch(row.url, {
        headers: { 'accept-encoding': 'identity' },
        signal: AbortSignal.timeout(15000),
      });
      invariant(response.ok && response.body, 'SOURCE_UNAVAILABLE', 'Exact source download failed.');
      return response.body as unknown as AsyncIterable<Uint8Array>;
    },
    upload: async (pin, stream) => {
      const parts: Buffer[] = [];
      let size = 0;
      for await (const part of stream) {
        size += part.length;
        invariant(size <= pin.size, 'SOURCE_HASH_MISMATCH', 'Source output exceeded exact pin.');
        parts.push(Buffer.from(part));
      }
      const bytes = Buffer.concat(parts);
      invariant(
        bytes.length === pin.size && digest(bytes) === pin.sha256,
        'SOURCE_HASH_MISMATCH',
        'Source output changed.',
      );
      const storageId = await ctx.storage.store(
        new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' }),
      );
      outputs.push({ ...pin, storageId });
    },
    uploadBatch: async objects => {
      for (const object of objects) await io.upload(object.pin, object.bytes);
      while (outputs.length >= 100)
        await ctx.runMutation(reference('projectConvexSourceStore:stage'), {
          ...input,
          objects: outputs.splice(0, 100),
        });
    },
  };
  return { io, outputs };
}
export const step = internalAction({
  args: { ...identity, step: v.number() },
  returns: v.null(),
  handler: async (ctx, input): Promise<null> => {
    const loaded: string | null = await ctx.runMutation(reference('projectConvexSourceStore:begin'), input);
    if (!loaded) return null;
    const state = JSON.parse(loaded),
      { io, outputs } = convexSourceTransport(ctx, input, state.locations);
    let cursor: SourceStepCursor = initialSourceStep(state.input),
      progress: SourceProgress | null = null;
    if (state.cursor) {
      const blob = await ctx.storage.get(state.cursor);
      invariant(blob, 'SOURCE_UNAVAILABLE', 'Durable source cursor is absent.');
      const loaded = await loadSourceProgress(new Uint8Array(await blob.arrayBuffer()), async id => {
        const section = await ctx.storage.get(id as Id<'_storage'>);
        invariant(section, 'SOURCE_UNAVAILABLE', 'Durable source metadata is absent.');
        return new Uint8Array(await section.arrayBuffer());
      });
      cursor = loaded.cursor;
      progress = loaded.value;
    }
    let result,
      fanout: SourceFanout | null = null;
    io.fanout = plan => {
      fanout = plan;
    };
    try {
      if (state.batchId) {
        const joined = JSON.parse(
          await ctx.runMutation(reference('projectConvexSourceFanout:results'), input),
        );
        invariant(!joined.failure, joined.failure ?? 'SOURCE_WORKER_FAILED', 'A bounded source step failed.');
        const results: SourceTaskProgress[] = [];
        for (const ref of joined.outputs)
          if (ref)
            results.push(
              await loadTaskData(ref, async id => {
                const blob = await ctx.storage.get(id as Id<'_storage'>);
                invariant(blob, 'SOURCE_UNAVAILABLE', 'Source task result is absent.');
                return new Uint8Array(await blob.arrayBuffer());
              }),
            );
        applySourceFanout(cursor, joined, results, ref => enqueueSourceObject(cursor, ref));
      }
      result = await runSourceStep(cursor, io);
    } catch (error) {
      if (!(error instanceof ForgeError)) throw error;
      await ctx.runMutation(reference('projectConvexSourceStore:commit'), {
        ...input,
        cursor: state.cursor,
        objects: [],
        output: null,
        failure: error.code,
      });
      return null;
    }
    const saved =
      result.cursor.phase === 'done'
        ? null
        : (
            await saveSourceProgress(result.cursor, progress, bytes =>
              ctx.storage.store(new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' })),
            )
          ).id;
    if (fanout) {
      const plan = fanout as SourceFanout;
      await ctx.runMutation(reference('projectConvexSourceFanout:fork'), {
        ...input,
        cursor: saved,
        kind: plan.kind,
        end: plan.end,
        tasks: plan.tasks.map(task => JSON.stringify(task)),
      });
      return null;
    }
    await ctx.runMutation(reference('projectConvexSourceStore:commit'), {
      ...input,
      cursor: saved,
      objects: outputs,
      output: result.cursor.output,
      failure: null,
    });
    return null;
  },
});
