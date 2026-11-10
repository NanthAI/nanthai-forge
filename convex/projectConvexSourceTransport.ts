// SPDX-License-Identifier: Apache-2.0
import { convexFetch, networkTimeout } from './networkFetch';
import { makeFunctionReference } from 'convex/server';
import type { ActionCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { WorkerObject, WorkerPin } from '../src/hosted-source-worker-format';
import { mapSourceOrdered, sourceIoConcurrency } from '../src/hosted-source-parallel';
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
import { sourceStepClock } from '../src/source-step-clock';
import { r2SegmentStore } from './projectStateTreeStore';
import { validStateTreePointer, type StateTreePointer } from '../src/state-tree-store';
import { logStateTree } from '../src/state-tree-output';
const reference = (name: string) => makeFunctionReference<'mutation'>(name);
/** Result manifests up to this size ride on the step's commit instead of a later R2 read. */
export const sourceResultInlineBytes = 64 * 1024;
export type ObjectLocation = {
  descriptor: WorkerObject;
  stateGeneration?: number;
  stateParents?: string[];
  stateTree?: StateTreePointer;
  storageId: Id<'_storage'> | null;
  url: string | null;
  range?: PackRange;
};
export function convexSourceTransport(
  ctx: ActionCtx,
  { projectId, jobId, step }: { projectId: Id<'hostedProjects'>; jobId: string; step: number },
  initial: ObjectLocation[] = [],
  delegatedAt?: number,
  /** `upload` returns once the bytes are verified and lets the R2 write (PUT and HEAD) run on
   * behind the work after it; callers must `settle()` before they read `outputs`. */
  {
    overlapWrites = false,
    preloaded = [],
    trees = false,
    treeRead = false,
    treeBaseline = false,
    treeBase,
  }: {
    overlapWrites?: boolean;
    /** The project dual-writes States in tree form (`hostedProjects.stateTrees.write`). */
    trees?: boolean;
    /** The merge reader is switched to trees (`hostedProjects.stateTrees.read` has `merge`). */
    treeRead?: boolean;
    /** The save-baseline reader is switched to trees (`stateTrees.read` has `baseline`). */
    treeBaseline?: boolean;
    /** Self-heal: a State with a proven pointer that `begin` found for a save whose baseline is
     * flat (its nearest such ancestor, else main's head). */
    treeBase?: { state: string; pointer: StateTreePointer } | undefined;
    /** Exact small texts the calling action already holds (an input it wrote, or one its caller
     * sent). A matching read is served from memory; a text that fails its pin is ignored. */
    preloaded?: readonly { sha256: string; size: number; text: string }[] | undefined;
  } = {},
) {
  // Fan-out tasks pass their wider identity; the object validator accepts only these fields.
  const input = { projectId, jobId, step };
  const locations = new Map<string, ObjectLocation>(initial.map(row => [row.descriptor.object.sha256, row])),
    outputs: SourceOutput[] = [],
    reads = { objects: 0, bytes: 0 },
    clock = sourceStepClock(delegatedAt),
    // The last few small outputs, by digest: a step's final result manifest is one of them, so
    // commit can carry it to publication without a separate action re-reading it from R2.
    small = new Map<string, string>(),
    // Overlapped writes in upload order, at most sourceIoConcurrency in flight.
    writing: Promise<SourceOutput>[] = [];
  const settle = async () => {
    while (writing.length) outputs.push(await writing.shift()!);
    // A dual-write that overlapped its State's upload settled after that output was prepared.
    for (const output of outputs)
      if (output.stateParents && !output.stateTree && pointers.has(output.sha256))
        output.stateTree = pointers.get(output.sha256)!;
    // Each segment this step wrote gets its object row with the same commit.
    if (segments) outputs.push(...segments.written.splice(0));
  };
  const durable = sourceStorage(ctx, projectId);
  const generations = new Map<string, number>(),
    parents = new Map<string, string[]>(),
    pointers = new Map<string, StateTreePointer>();
  // Dual-write: segments are read by key and written beside the State; the outcome is counted
  // here and a refusal is the step's alarm (the flat State is recorded either way).
  const segments = trees || treeRead || treeBaseline ? r2SegmentStore(ctx, projectId) : null,
    tree = {
      written: 0,
      skipped: 0,
      refused: null as { state: string; code: string } | null,
      /** States the merge reader rebuilt from their trees instead of downloading the manifest. */
      derived: 0,
      bytes: 0,
      ms: 0,
    };
  const remember = (rows: ObjectLocation[]) => {
    for (const row of rows) {
      locations.set(row.descriptor.object.sha256, row);
      if (validStateGeneration(row.stateGeneration))
        generations.set(row.descriptor.object.sha256, row.stateGeneration);
      if (validStateParents(row.stateParents)) parents.set(row.descriptor.object.sha256, row.stateParents);
      if (validStateTreePointer(row.stateTree)) pointers.set(row.descriptor.object.sha256, row.stateTree);
    }
  };
  remember(initial);
  if (treeBase && validStateTreePointer(treeBase.pointer) && !pointers.has(treeBase.state))
    pointers.set(treeBase.state, treeBase.pointer);
  const held = new Map<string, Uint8Array>();
  for (const value of preloaded) {
    const bytes = new TextEncoder().encode(value.text);
    if (bytes.length === value.size && digest(bytes) === value.sha256) held.set(value.sha256, bytes);
  }
  const resolve = async (
    ids: string[],
    ancestry = false,
    known: string[] = [],
    windows = 1,
  ): Promise<WorkerObject[]> => {
    const rows: ObjectLocation[] = JSON.parse(
      await clock
        .call(() =>
          ctx.runMutation(reference('projectConvexSourceObjects:resolve'), {
            ...input,
            digests: ids,
            ancestry,
            known,
            windows,
          }),
        )
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
    ...(segments
      ? {
          trees: {
            write: trees,
            read: treeRead,
            baseline: treeBaseline,
            derived: (state, ok) => {
              if (ok) tree.derived++;
              else tree.refused ??= { state, code: 'SOURCE_DIGEST_MISMATCH' };
              logStateTree(
                { jobId, step },
                state,
                ok
                  ? { status: 'read' }
                  : {
                      status: 'refused',
                      code: 'SOURCE_DIGEST_MISMATCH',
                      message: 'A stored tree did not give its State.',
                    },
                { ms: 0, ...segments.stats },
              );
            },
            store: {
              ...segments.store,
              put: bytes => clock.write(() => segments.store.put(bytes)),
            },
            pointer: id => pointers.get(id),
            nearest: ids => {
              // Breadth first over the parents this step knows, so the closest pointer wins.
              const seen = new Set<string>();
              let level = [...ids];
              for (let depth = 0; level.length && depth < 64; depth++) {
                const next: string[] = [];
                for (const id of level) {
                  if (seen.has(id)) continue;
                  seen.add(id);
                  if (pointers.has(id)) return id;
                  next.push(...(parents.get(id) ?? []));
                }
                level = next;
              }
              return treeBase && pointers.has(treeBase.state) ? treeBase.state : undefined;
            },
            direct: pin => segments.direct(pin),
            settled: (state, result, ms) => {
              tree.ms += ms;
              if (result.status === 'written') {
                pointers.set(state, result.pointer);
                tree.written++;
                tree.bytes += result.bytes;
              } else if (result.status === 'skipped') tree.skipped++;
              else tree.refused ??= { state, code: result.code.slice(0, 64) };
              logStateTree({ jobId, step }, state, result, { ms, ...segments.stats });
            },
          },
        }
      : {}),
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
        await clock
          .call(() =>
            ctx.runMutation(reference('projectConvexSourceObjects:resolve'), {
              ...input,
              digests: pending,
              ancestry: !!hints,
              known: hints?.known ?? [],
              probe: true,
              ...(hints ? { windows: hints.windows } : {}),
            }),
          )
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
      // action's location cache and never select byte reads; the only edges they
      // supply are the stateParents the trusted worker recorded on a hint's row.
      const rest = remaining.length ? await io.probeStates!(remaining) : null;
      const unavailable = [...result.unavailable, ...(rest?.unavailable ?? [])];
      return {
        refs: ids.filter(id => !unavailable.includes(id)).map(id => locations.get(id)!.descriptor),
        unavailable,
      };
    },
    // A row this step already resolved (or was handed) is marked and fenced for this step, as
    // `read` and `prepareRead` already rely on; only the rest costs a resolve call.
    describeBatch: async ids => {
      const missing = [...new Set(ids.filter(id => !locations.has(id)))];
      if (missing.length) await resolve(missing);
      return ids.map(id => {
        const row = locations.get(id);
        invariant(row, 'SOURCE_UNAVAILABLE', 'Exact source object is absent.');
        return row.descriptor;
      });
    },
    ancestry: (ids, known, windows = 1) => resolve(ids, true, known, windows),
    prepareRead: async pins => {
      const missing = [
        ...new Map(
          pins
            .filter(pin => !locations.has(pin.sha256) && held.get(pin.sha256)?.length !== pin.size)
            .map(pin => [pin.sha256, pin]),
        ).values(),
      ];
      for (let offset = 0; offset < missing.length; offset += 100)
        await resolve(missing.slice(offset, offset + 100).map(p => p.sha256));
    },
    read: async pin => {
      const bytes = held.get(pin.sha256);
      if (bytes && bytes.length === pin.size)
        return (async function* () {
          yield bytes;
        })();
      if (!locations.has(pin.sha256)) await resolve([pin.sha256]);
      return clock.read(() => openRead(pin));
    },
    upload: async (pin, stream) => {
      const output = await prepareOutput(pin, stream);
      if (!overlapWrites) return void outputs.push(await output.store());
      // Content-addressed, create-only writes: digest checks and State generations above stay in
      // order, the write overlaps the merge work that follows, and outputs keep upload order.
      const stored = output.store();
      stored.catch(() => {});
      writing.push(stored);
      if (writing.length >= sourceIoConcurrency) outputs.push(await writing.shift()!);
    },
    uploadBatch: async objects => {
      await settle();
      // Digest checks and State generations stay in input order (a child State may
      // name a parent from this same batch); only the immutable R2 writes overlap.
      const prepared: { store(): Promise<SourceOutput> }[] = [];
      for (const object of objects) prepared.push(await prepareOutput(object.pin, object.bytes));
      outputs.push(...(await mapSourceOrdered(prepared, output => output.store())));
      while (outputs.length >= 100) {
        const objects = outputs.splice(0, 100);
        await clock.call(() =>
          ctx.runMutation(reference('projectConvexSourceStore:stage'), { ...input, objects }),
        );
      }
    },
  };
  async function openRead(pin: WorkerPin): Promise<AsyncIterable<Uint8Array>> {
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
  }
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
    if (bytes.length <= sourceResultInlineBytes) {
      small.delete(pin.sha256);
      small.set(pin.sha256, new TextDecoder().decode(bytes));
      if (small.size > 8) small.delete(small.keys().next().value!);
    }
    // Only a State this step proved in tree form carries a pointer (settled before its upload).
    const stateTree = stateParents === undefined ? undefined : pointers.get(pin.sha256);
    return {
      async store(): Promise<SourceOutput> {
        const ref = await clock.write(() => durable.store(bytes)),
          r2 = sourceR2Pin(ref);
        return {
          ...pin,
          ...(stateGeneration === undefined ? {} : { stateGeneration }),
          ...(stateParents === undefined ? {} : { stateParents }),
          ...(stateTree === undefined ? {} : { stateTree }),
          ...(r2 ? { r2Key: r2Key(projectId, r2.sha256) } : { storageId: ref as Id<'_storage'> }),
        };
      },
    };
  }
  return {
    io,
    outputs,
    /** Wait for overlapped writes; `outputs` is complete only after this. */
    settle,
    locations,
    reads,
    clock,
    /** Dual-write outcomes of this step, and its R2 segment traffic (null when off). */
    tree,
    treeIo: segments?.stats ?? null,
    /** This step's own small output with exactly this pin, as text; otherwise null. */
    smallOutput: (pin: { sha256: string; size: number } | null) => {
      const text = pin ? small.get(pin.sha256) : undefined;
      return text !== undefined && new TextEncoder().encode(text).length === pin!.size ? text : null;
    },
  };
}
