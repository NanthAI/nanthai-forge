// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import type { ActionCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { WorkerObject } from '../src/hosted-source-worker-format';
import type { StepTransport } from '../src/hosted-source-step';
import type { SourceOutput } from './projectConvexSourceOutput';
import { digest } from '../src/portable-hash';
import { sourceStorage, sourceR2Pin } from './projectConvexSourceStorage';
import { r2Key } from './r2';
import { invariant } from '../src/errors';
const reference = (name: string) => makeFunctionReference<'mutation'>(name);
export type ObjectLocation = {
  descriptor: WorkerObject;
  storageId: Id<'_storage'> | null;
  url: string | null;
};
export function convexSourceTransport(
  ctx: ActionCtx,
  { projectId, jobId, step }: { projectId: Id<'hostedProjects'>; jobId: string; step: number },
  initial: ObjectLocation[] = [],
) {
  // Fan-out tasks pass their wider identity; the object validator accepts only these fields.
  const input = { projectId, jobId, step };
  const locations = new Map<string, ObjectLocation>(initial.map(row => [row.descriptor.object.sha256, row])),
    outputs: SourceOutput[] = [];
  const durable = sourceStorage(ctx, projectId);
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
      const blob = !row.url && row.storageId ? await ctx.storage.get(row.storageId) : null;
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
      const parts: Uint8Array[] = [];
      let size = 0;
      for await (const part of stream) {
        size += part.length;
        invariant(size <= pin.size, 'SOURCE_HASH_MISMATCH', 'Source output exceeded exact pin.');
        parts.push(new Uint8Array(part));
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.length;
      }
      invariant(
        bytes.length === pin.size && digest(bytes) === pin.sha256,
        'SOURCE_HASH_MISMATCH',
        'Source output changed.',
      );
      const ref = await durable.store(bytes),
        r2 = sourceR2Pin(ref);
      outputs.push({
        ...pin,
        ...(r2 ? { r2Key: r2Key(projectId, r2.sha256) } : { storageId: ref as Id<'_storage'> }),
      });
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
  return { io, outputs, locations };
}
