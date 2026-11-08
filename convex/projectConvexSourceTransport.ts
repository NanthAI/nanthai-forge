// SPDX-License-Identifier: Apache-2.0
import { convexFetch, networkTimeout } from './networkFetch';
import { makeFunctionReference } from 'convex/server';
import type { ActionCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { WorkerObject, WorkerPin } from '../src/hosted-source-worker-format';
import { mapSourceOrdered } from '../src/hosted-source-parallel';
import type { StepTransport } from '../src/hosted-source-step';
import type { SourceOutput } from './projectConvexSourceOutput';
import { digest } from '../src/portable-hash';
import { sourceStorage, sourceR2Pin } from './projectConvexSourceStorage';
import { r2Key } from './r2';
import { ForgeError, invariant } from '../src/errors';
import { parseNativeState } from '../src/native-state-format';
import { nextStateGeneration, validStateGeneration, validStateParents } from '../src/state-generation';
import { SourceIoError, transientSourceStatus } from '../src/hosted-source-io-error';
import { retryR2Lag } from '../src/hosted-r2-retry';
import { sourceDomainError } from './projectConvexSourceErrors';
import { packHeaders, verifyPackRange, type PackRange } from '../src/object-pack-range';
const reference = (name: string) => makeFunctionReference<'mutation'>(name);
export type ObjectLocation = {
  descriptor: WorkerObject;
  stateGeneration?: number;
  stateParents?: string[];
  storageId: Id<'_storage'> | null;
  url: string | null;
  range?: PackRange;
};
export function convexSourceTransport(
  ctx: ActionCtx,
  { projectId, jobId, step }: { projectId: Id<'hostedProjects'>; jobId: string; step: number },
  initial: ObjectLocation[] = [],
) {
  // Fan-out tasks pass their wider identity; the object validator accepts only these fields.
  const input = { projectId, jobId, step };
  const locations = new Map<string, ObjectLocation>(initial.map(row => [row.descriptor.object.sha256, row])),
    outputs: SourceOutput[] = [],
    reads = { objects: 0, bytes: 0 };
  const durable = sourceStorage(ctx, projectId);
  const generations = new Map<string, number>(),
    parents = new Map<string, string[]>();
  const remember = (rows: ObjectLocation[]) => {
    for (const row of rows) {
      locations.set(row.descriptor.object.sha256, row);
      if (validStateGeneration(row.stateGeneration))
        generations.set(row.descriptor.object.sha256, row.stateGeneration);
      if (validStateParents(row.stateParents)) parents.set(row.descriptor.object.sha256, row.stateParents);
    }
  };
  remember(initial);
  const resolve = async (
    ids: string[],
    ancestry = false,
    known: string[] = [],
    windows = 1,
  ): Promise<WorkerObject[]> => {
    const rows: ObjectLocation[] = JSON.parse(
      await ctx
        .runMutation(reference('projectConvexSourceObjects:resolve'), {
          ...input,
          digests: ids,
          ancestry,
          known,
          windows,
        })
        .catch(error => {
          // Nested mutations carry domain codes in ConvexError.data. Summary
          // acquisition needs the reconstructed ForgeError for its narrow allowlist.
          const domain = sourceDomainError(error);
          if (domain) throw domain;
          throw new SourceIoError(error, 'source-descriptors', ids.length === 1 ? ids[0]! : null);
        }),
    );
    remember(rows);
    // A byte-bounded response can be a prefix; ordinary descriptor requests
    // continue the remainder without creating per-file RPCs.
    if (!ancestry && rows.length < ids.length) {
      invariant(rows.length > 0, 'SOURCE_UNAVAILABLE', 'Object window made no progress.');
      return [...rows.map(r => r.descriptor), ...(await resolve(ids.slice(rows.length)))];
    }
    return rows.map(row => row.descriptor);
  };
  const io: StepTransport = {
    stateGeneration: id => generations.get(id),
    stateParents: id => parents.get(id),
    rememberStateGenerations: values => {
      for (const [id, value] of Object.entries(values))
        if (validStateGeneration(value)) generations.set(id, value);
    },
    publishRecipe: async (object, recipe) => {
      outputs.push({ ...object, recipe });
    },
    probeStates: async (ids, hints) => {
      const pending = ids.filter(id => !locations.has(id));
      if (!pending.length) return { refs: ids.map(id => locations.get(id)!.descriptor), unavailable: [] };
      const result: { rows: ObjectLocation[]; unavailable: string[] } = JSON.parse(
        await ctx
          .runMutation(reference('projectConvexSourceObjects:resolve'), {
            ...input,
            digests: pending,
            ancestry: !!hints,
            known: hints?.known ?? [],
            probe: true,
            ...(hints ? { windows: hints.windows } : {}),
          })
          .catch(error => {
            const domain = sourceDomainError(error);
            if (domain) throw domain;
            throw new SourceIoError(error, 'source-descriptors', null);
          }),
      );
      remember(result.rows);
      const remaining = pending.filter(id => !locations.has(id) && !result.unavailable.includes(id));
      invariant(remaining.length < pending.length, 'SOURCE_UNAVAILABLE', 'Object window made no progress.');
      // As with ordinary resolution, complete the byte-bounded descriptor pages
      // before handing the frontier to sourceWindows. Hints warm only this
      // action's location cache; they never select byte reads or supply edges.
      const rest = remaining.length ? await io.probeStates!(remaining) : null;
      const unavailable = [...result.unavailable, ...(rest?.unavailable ?? [])];
      return {
        refs: ids.filter(id => !unavailable.includes(id)).map(id => locations.get(id)!.descriptor),
        unavailable,
      };
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
      reads.objects++;
      reads.bytes += pin.size;
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
      let response: Response;
      try {
        const url = row.url;
        // A committed object that answers 404 may be read-after-write lag; the
        // shared bound retries it, then the exact SOURCE_UNAVAILABLE stands.
        response = await retryR2Lag(
          () =>
            convexFetch(url, {
              headers: { 'accept-encoding': 'identity', ...packHeaders(row.range, pin.size) },
              signal: networkTimeout(15000),
            }),
          lagged => lagged.status === 404,
          lagged => lagged.body?.cancel().catch(() => {}),
        );
      } catch (error) {
        throw new SourceIoError(error, 'source-headers', pin.sha256);
      }
      if (transientSourceStatus(response.status)) {
        await response.body?.cancel().catch(() => {});
        throw new SourceIoError(null, 'source-headers', pin.sha256, response.status);
      }
      invariant(response.ok && response.body, 'SOURCE_UNAVAILABLE', 'Exact source download failed.');
      verifyPackRange(response, row.range, pin.size);
      return (async function* () {
        try {
          yield* response.body as unknown as AsyncIterable<Uint8Array>;
        } catch (error) {
          throw new SourceIoError(error, 'source-body', pin.sha256, response.status);
        }
      })();
    },
    upload: async (pin, stream) => {
      const output = await prepareOutput(pin, stream);
      outputs.push(await output.store());
    },
    uploadBatch: async objects => {
      // Digest checks and State generations stay in input order (a child State may
      // name a parent from this same batch); only the immutable R2 writes overlap.
      const prepared: { store(): Promise<SourceOutput> }[] = [];
      for (const object of objects) prepared.push(await prepareOutput(object.pin, object.bytes));
      outputs.push(...(await mapSourceOrdered(prepared, output => output.store())));
      while (outputs.length >= 100)
        await ctx.runMutation(reference('projectConvexSourceStore:stage'), {
          ...input,
          objects: outputs.splice(0, 100),
        });
    },
  };
  async function prepareOutput(pin: WorkerPin, stream: AsyncIterable<Uint8Array>) {
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
    // These are hash-verified worker outputs. Only the exact State parent
    // list can select a generation; plans, display hints and uploads cannot.
    let stateGeneration: number | undefined, stateParents: string[] | undefined;
    const prefix = new TextDecoder().decode(bytes.subarray(0, 256));
    if (prefix.includes('"kind":"forge-source-state"')) {
      try {
        const state = parseNativeState(bytes);
        stateGeneration = nextStateGeneration(state.parents, id => generations.get(id));
        if (stateGeneration !== undefined) generations.set(pin.sha256, stateGeneration);
        if (validStateParents(state.parents)) stateParents = [...state.parents];
      } catch (error) {
        // An ordinary source blob may begin with State-looking JSON.
        if (!(error instanceof ForgeError) || error.code !== 'INVALID_NATIVE_SOURCE') throw error;
      }
    }
    return {
      async store(): Promise<SourceOutput> {
        const ref = await durable.store(bytes),
          r2 = sourceR2Pin(ref);
        return {
          ...pin,
          ...(stateGeneration === undefined ? {} : { stateGeneration }),
          ...(stateParents === undefined ? {} : { stateParents }),
          ...(r2 ? { r2Key: r2Key(projectId, r2.sha256) } : { storageId: ref as Id<'_storage'> }),
        };
      },
    };
  }
  return { io, outputs, locations, reads };
}
