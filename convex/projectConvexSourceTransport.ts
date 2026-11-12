// SPDX-License-Identifier: Apache-2.0
import { physicalKey } from '../src/physical-manifest-binary';
import { assertSourceStateSize, type SourceSizePhase } from '../src/source-state-size';
import type { StateSize } from '../src/state/size';
import { sourcePutMetrics } from './projectSourceBytes';
import { sourceStateChunks } from './projectConvexSourceChunks';
import { copyRecipeClosure } from '../src/object-pack-range';
import type { SignedDownload } from '../src/blob-download-format';
import { convexFetch, networkTimeout } from './networkFetch';
import { makeFunctionReference } from 'convex/server';
import type { ActionCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { WorkerObject, WorkerPin } from '../src/hosted-source-worker-format';
import { mapSourceOrdered, sourceIoConcurrency } from '../src/hosted-source-parallel';
import type { StepTransport } from '../src/hosted-source-step';
import type { SourceOutput } from './projectConvexSourceOutput';
import { digest } from '../src/state/hash';
import { sourceStorage, sourceR2Pin } from './projectConvexSourceStorage';
import { r2Key, presignGet, r2Config } from './r2';
import { r2Counts } from './presign';
import { ForgeError, invariant } from '../src/errors';
import { parseNativeState, type NativeFile } from '../src/state/format';
import { sourcePhysicalManifests } from './projectConvexPhysicalManifest';
import { nextStateGeneration, validStateGeneration, validStateParents } from '../src/state/generation';
import { SourceIoError, transientSourceStatus } from '../src/hosted-source-io-error';
import { retryR2Lag } from '../src/hosted-r2-retry';
import { sourceDomainError } from './projectConvexSourceErrors';
import { packHeaders, verifyPackRange, type PackRange, type ObjectPack } from '../src/object-pack-range';
import { sourceStepClock } from '../src/source-step-clock';
import { PhysicalManifestReader, manifestOrCatalog } from '../src/physical-manifest';
import type { PhysicalPin, PhysicalEntry } from '../src/physical-manifest-codec';
const reference = (name: string) => makeFunctionReference<'mutation'>(name);
/** Result manifests up to this size ride on the step's commit instead of a later R2 read. */
export const sourceResultInlineBytes = 64 * 1024;
export type ObjectLocation = {
  descriptor: WorkerObject;
  stateGeneration?: number;
  stateSize?: StateSize;
  stateParents?: string[];
  statePhysical?: WorkerPin;
  storageId: Id<'_storage'> | null;
  url: string | null;
  range?: PackRange;
  closure?: SignedDownload[];
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
    hash = digest,
    preloaded = [],
    observed = [],
    putMetrics = sourcePutMetrics(),
    physicalManifests = false,
    sourceKind,
    bindings = [],
  }: {
    overlapWrites?: boolean;
    /** Node supplies native SHA-256; V8 retains portable hashing. */
    hash?: (bytes: Uint8Array) => string;
    putMetrics?: ReturnType<typeof sourcePutMetrics>;
    /** Exact small texts the calling action already holds (an input it wrote, or one its caller
     * sent). A matching read is served from memory; a text that fails its pin is ignored. */
    preloaded?: readonly { sha256: string; size: number; text: string }[] | undefined;
    physicalManifests?: boolean;
    sourceKind?: string;
    bindings?: readonly { sha256: string; size: number; r2Key: string; pack?: ObjectPack }[] | undefined;
    observed?: ({ sha256: string; size: number } & StateSize)[] | undefined;
  } = {},
) {
  // Fan-out tasks pass their wider identity; the object validator accepts only these fields.
  const input = { projectId, jobId, step };
  const locations = new Map<string, ObjectLocation>(initial.map(row => [row.descriptor.object.sha256, row])),
    outputs: SourceOutput[] = [],
    reads = { objects: 0, bytes: 0 },
    clock = sourceStepClock(delegatedAt, r2Counts),
    // The last few small outputs, by digest: a step's final result manifest is one of them, so
    // commit can carry it to publication without a separate action re-reading it from R2.
    small = new Map<string, string>(),
    observedStates = new Map(observed.map(pin => [pin.sha256, pin])),
    outputSizes = new Map<string, StateSize>(),
    expectedStates = new Set<string>(),
    // Overlapped writes in upload order, at most sourceIoConcurrency in flight.
    writing: Promise<SourceOutput>[] = [];
  const settle = async () => {
    while (writing.length) outputs.push(await writing.shift()!);
  };
  const durable = sourceStorage(ctx, projectId, hash, putMetrics.observer('other'));
  // Retries and recompositions can generate exactly the same immutable State or
  // chunk. Confirm its checksum before sending its body again, including when a
  // previous action's successful PUT reply was lost before its commit.
  const stateStorage = sourceStorage(ctx, projectId, hash, putMetrics.observer('state'), true);
  const chunks = sourceStateChunks(
    projectId,
    hash,
    async (pin, bytes) => {
      const ref = await clock.write(() => stateStorage.store(bytes, pin)),
        r2 = sourceR2Pin(ref);
      invariant(
        r2 && r2.sha256 === pin.sha256 && r2.size === pin.size,
        'SOURCE_HASH_MISMATCH',
        'Source chunk storage changed.',
      );
      return { ...pin, r2Key: r2Key(projectId, pin.sha256) };
    },
    putMetrics.avoid,
  );
  const generations = new Map<string, number>(),
    parents = new Map<string, string[]>(),
    outputParents = new Map<string, readonly string[]>(),
    outputFiles = new Map<string, readonly NativeFile[]>();
  let sizePhase: SourceSizePhase | undefined;
  const checkSize = (pin: WorkerPin) => {
    if (sizePhase && expectedStates.has(pin.sha256) && !outputSizes.has(pin.sha256))
      assertSourceStateSize(sizePhase, locations.get(pin.sha256)?.stateSize);
  };
  const remember = (rows: ObjectLocation[]) => {
    for (const row of rows) {
      chunks.remember(row);
      locations.set(row.descriptor.object.sha256, row);
      if (validStateGeneration(row.stateGeneration))
        generations.set(row.descriptor.object.sha256, row.stateGeneration);
      if (validStateParents(row.stateParents)) parents.set(row.descriptor.object.sha256, row.stateParents);
    }
  };
  remember(initial);
  const held = new Map<string, Uint8Array>(),
    generatedKeys = new Map<string, string>();
  // Only the committing action supplies these, after checking their bodies. A
  // different project's committed pin never becomes a source read location.
  for (const binding of bindings) {
    if (binding.r2Key !== r2Key(projectId, binding.pack?.digest ?? binding.sha256)) continue;
    locations.set(binding.sha256, {
      ...locations.get(binding.sha256),
      descriptor: { object: { sha256: binding.sha256, size: binding.size }, recipe: null },
      storageId: null,
      url: null,
      ...(binding.pack ? { range: { offset: binding.pack.offset, total: binding.pack.size } } : {}),
    });
    generatedKeys.set(binding.sha256, binding.r2Key);
  }
  for (const value of preloaded) {
    const bytes = new TextEncoder().encode(value.text);
    if (bytes.length === value.size && hash(bytes) === value.sha256) held.set(value.sha256, bytes);
  }
  let heldBytes = [...held.values()].reduce((n, bytes) => n + bytes.length, 0);
  const bindingNotices = new Set<string>();
  const reportBindings = (message: string) => {
    if (bindingNotices.has(message)) return;
    bindingNotices.add(message);
    console.log(`FORGE_SOURCE_BINDINGS ${JSON.stringify({ message })}`);
  };
  const keep = (pin: WorkerPin, bytes: Uint8Array, verified = false) => {
    if (
      !held.has(pin.sha256) &&
      heldBytes + bytes.length <= 2 * 1024 * 1024 &&
      bytes.length === pin.size &&
      (verified || hash(bytes) === pin.sha256)
    ) {
      held.set(pin.sha256, bytes);
      heldBytes += bytes.length;
    }
  };
  const resolve = async (
    ids: string[],
    ancestry = false,
    known: string[] = [],
    windows = 1,
  ): Promise<WorkerObject[]> => {
    const roots = !ancestry && ids.length ? [...locations.values()].filter(row => row.statePhysical) : [];
    if (roots.length) {
      const found = await manifestOrCatalog(
        async () => {
          for (const row of roots) {
            const reader = await manifestReader(row);
            const entries = await reader.lookup(ids);
            if (!entries.every((entry): entry is PhysicalEntry => !!entry)) continue;
            const rows = await Promise.all(entries.map(manifestLocation));
            remember(rows);
            return rows.map(row => row.descriptor);
          }
          return null;
        },
        async () => null,
        reportBindings,
      );
      if (found) return found;
    } else if (!ancestry && ids.length)
      reportBindings('source bindings: catalog (physical manifest missing)');
    const rows: ObjectLocation[] = JSON.parse(
      await clock
        .call(() =>
          ctx.runMutation(reference('projectConvexSourceObjects:resolve'), {
            ...input,
            digests: ids,
            ancestry,
            ...(sizePhase ? { sizePhase, states: ids.filter(id => expectedStates.has(id)) } : {}),
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
    for (const row of rows) checkSize(row.descriptor.object);
    // A byte-bounded response can be a prefix; ordinary descriptor requests
    // continue the remainder without creating per-file RPCs.
    if (!ancestry && rows.length < ids.length) {
      invariant(rows.length > 0, 'SOURCE_UNAVAILABLE', 'Object window made no progress.');
      return [...rows.map(r => r.descriptor), ...(await resolve(ids.slice(rows.length)))];
    }
    return rows.map(row => row.descriptor);
  };
  const manifests = new Map<string, Promise<PhysicalManifestReader>>();
  const manifestLocation = async (entry: PhysicalEntry): Promise<ObjectLocation> => ({
    descriptor: { object: { sha256: entry.sha256, size: entry.size }, recipe: entry.recipe ?? null },
    storageId: null,
    url: entry.recipe
      ? null
      : await presignGet(
          r2Config(),
          r2Key(projectId, physicalKey(entry.pack?.digest ?? entry.sha256, entry.pack?.nonce ?? entry.nonce)),
          packHeaders(
            entry.pack ? { offset: entry.pack.offset, total: entry.pack.size } : undefined,
            entry.size,
          ),
        ),
    ...(entry.pack ? { range: { offset: entry.pack.offset, total: entry.pack.size } } : {}),
  });
  const readManifest = async (pin: PhysicalPin) => {
    const row = await manifestLocation(pin),
      bytes = new Uint8Array(pin.size);
    let at = 0;
    for await (const part of await clock.read(() => openRead(pin, row))) {
      invariant(at + part.length <= pin.size, 'SOURCE_HASH_MISMATCH', 'Physical manifest exceeds its pin.');
      bytes.set(part, at);
      at += part.length;
    }
    invariant(at === pin.size, 'SOURCE_HASH_MISMATCH', 'Physical manifest is incomplete.');
    return bytes;
  };
  const manifestReader = (row: ObjectLocation) => {
    const id = row.descriptor.object.sha256;
    let reader = manifests.get(id);
    if (!reader) {
      reader = PhysicalManifestReader.open(id, row.statePhysical!, readManifest);
      manifests.set(id, reader);
    }
    return reader;
  };
  const physical = sourcePhysicalManifests({
    enabled: physicalManifests,
    sourceKind,
    projectId,
    locations,
    outputs,
    key: id => generatedKeys.get(id)?.split('/').at(-1),
    reader: manifestReader,
    log: reportBindings,
    put: async bytes => {
      const pin = { sha256: hash(bytes), size: bytes.length };
      const ref = await clock.write(() => stateStorage.store(bytes, pin));
      invariant(
        sourceR2Pin(ref)?.sha256 === pin.sha256,
        'SOURCE_HASH_MISMATCH',
        'Physical manifest storage changed.',
      );
      return { ...pin, r2Key: r2Key(projectId, pin.sha256) };
    },
    describe: async (ids, seed) => {
      if (!seed) {
        await io.describeBatch!(ids);
        return ids.map(id => {
          const row = locations.get(id)!;
          if (row.descriptor.recipe) return { ...row.descriptor.object, recipe: row.descriptor.recipe };
          const key =
            generatedKeys.get(id)?.split('/').at(-1) ??
            (row.url ? new URL(row.url).pathname.split('/').at(-1) : undefined);
          return key && /^[a-f0-9]{64}$/.test(key)
            ? {
                ...row.descriptor.object,
                ...(row.range
                  ? { pack: { digest: key, size: row.range.total, offset: row.range.offset } }
                  : {}),
              }
            : null;
        });
      }
      const found: (PhysicalEntry | null)[] = [];
      for (let at = 0; at < ids.length; at += 2700)
        found.push(
          ...JSON.parse(
            await clock.call(() =>
              ctx.runMutation(reference('projectConvexSourceObjects:resolve'), {
                ...input,
                digests: ids.slice(at, at + 2700),
                ancestry: false,
                known: [],
                seed: true,
              }),
            ),
          ),
        );
      return found;
    },
  });
  const io: StepTransport = {
    hasPhysicalState: id => !!locations.get(id)?.statePhysical,
    ...(physical.seedPhysicalState ? { seedPhysicalState: physical.seedPhysicalState } : {}),
    ...(physical.writePhysicalState ? { writePhysicalState: physical.writePhysicalState } : {}),
    setSourceSizePhase: phase => {
      sizePhase = phase;
    },
    expectState: id => {
      expectedStates.add(id);
      const row = locations.get(id);
      if (row) checkSize(row.descriptor.object);
    },
    checkStateSize: checkSize,
    rememberLoadedState: (pin, fileCount) => {
      if (!locations.get(pin.sha256)?.stateSize && !outputSizes.has(pin.sha256))
        observedStates.set(pin.sha256, { ...pin, fileCount, manifestBytes: pin.size });
    },
    rememberOutputState: (pin, parents, files) => {
      if (files) outputSizes.set(pin.sha256, { fileCount: files.length, manifestBytes: pin.size });
      if (validStateParents(parents)) outputParents.set(pin.sha256, [...parents]);
      if (physicalManifests && files) outputFiles.set(pin.sha256, files);
    },
    recipeLeaves: id => locations.get(id)?.closure?.map(leaf => ({ sha256: leaf.digest, size: leaf.size })),
    rememberBytes: (pin, bytes) => {
      chunks.rememberBytes(pin, bytes, locations.get(pin.sha256));
      // The reader has just verified this exact whole-object pin. Keep one private
      // copy for the existing small fallback hand-off, without hashing it again.
      if (!held.has(pin.sha256) && heldBytes + pin.size <= 2 * 1024 * 1024 && bytes.length === pin.size) {
        held.set(pin.sha256, bytes.slice());
        heldBytes += pin.size;
      }
    },
    readInto: async (pin, destination) => {
      checkSize(pin);
      const prior = held.get(pin.sha256);
      if (prior && prior.length === pin.size) {
        destination.set(prior);
        return true;
      }
      const row = locations.get(pin.sha256);
      if (!row?.closure) return false;
      await readClosure(pin, row.closure, destination);
      return true;
    },
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
              ...(sizePhase ? { sizePhase, states: pending.filter(id => expectedStates.has(id)) } : {}),
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
      for (const row of result.rows) checkSize(row.descriptor.object);

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
      for (const pin of pins) checkSize(pin);
    },
    read: async pin => {
      checkSize(pin);
      const bytes = held.get(pin.sha256);
      if (bytes && bytes.length === pin.size)
        return (async function* () {
          yield bytes;
        })();
      if (!locations.has(pin.sha256)) await resolve([pin.sha256]);
      const row = locations.get(pin.sha256)!;
      checkSize(pin);
      if (row.closure)
        return (async function* () {
          yield await readClosure(pin, row.closure!);
        })();
      const stream = await clock.read(() => openRead(pin));
      if (heldBytes + pin.size > 2 * 1024 * 1024) return stream;
      return (async function* () {
        const parts: Uint8Array[] = [];
        let size = 0;
        for await (const part of stream) {
          size += part.length;
          invariant(size <= pin.size, 'SOURCE_HASH_MISMATCH', 'Source exceeds its exact size.');
          parts.push(new Uint8Array(part));
          yield part;
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const part of parts) {
          bytes.set(part, offset);
          offset += part.length;
        }
        keep(pin, bytes);
      })();
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
  async function readClosure(pin: WorkerPin, closure: SignedDownload[], destination?: Uint8Array) {
    return copyRecipeClosure(
      pin,
      closure,
      async (leaf, bytes) => {
        const physical = { sha256: leaf.digest, size: leaf.size };
        const row: ObjectLocation = {
          descriptor: { object: physical, recipe: null },
          storageId: null,
          url: leaf.url,
          ...(leaf.range ? { range: leaf.range } : {}),
        };
        let at = 0;
        for await (const part of await clock.read(() => openRead(physical, row))) {
          invariant(
            at + part.length <= leaf.size,
            'SOURCE_HASH_MISMATCH',
            'Recipe leaf exceeded its exact size.',
          );
          bytes.set(part, at);
          at += part.length;
        }
        invariant(
          at === leaf.size && hash(bytes) === leaf.digest,
          'SOURCE_HASH_MISMATCH',
          'Recipe leaf changed.',
        );
        return bytes;
      },
      destination,
    );
  }
  async function openRead(
    pin: WorkerPin,
    row = locations.get(pin.sha256)!,
  ): Promise<AsyncIterable<Uint8Array>> {
    if (!row.url && generatedKeys.has(pin.sha256))
      row.url = await presignGet(r2Config(), generatedKeys.get(pin.sha256)!);
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
    const bytes = new Uint8Array(pin.size);
    let size = 0;
    for await (const part of stream) {
      size += part.length;
      invariant(size <= pin.size, 'SOURCE_HASH_MISMATCH', 'Source output exceeded exact pin.');
      bytes.set(part, size - part.length);
    }
    invariant(
      size === pin.size && hash(bytes) === pin.sha256,
      'SOURCE_HASH_MISMATCH',
      'Source output changed.',
    );
    // These are hash-verified worker outputs. Only the exact State parent
    // list can select a generation; plans, display hints and uploads cannot.
    let stateGeneration: number | undefined,
      stateParents: string[] | undefined,
      stateFiles = outputFiles.get(pin.sha256);
    let stateSize = outputSizes.get(pin.sha256);
    const prefix = new TextDecoder().decode(bytes.subarray(0, 256));
    const ownParents = outputParents.get(pin.sha256);
    if (ownParents) {
      stateParents = [...ownParents];
      stateGeneration = nextStateGeneration(stateParents, id => generations.get(id));
      if (stateGeneration !== undefined) generations.set(pin.sha256, stateGeneration);
    } else if (prefix.includes('"kind":"forge-source-state"')) {
      try {
        const state = parseNativeState(bytes);
        if (physicalManifests) stateFiles = state.files;
        stateSize = { fileCount: state.files.length, manifestBytes: bytes.length };
        stateGeneration = nextStateGeneration(state.parents, id => generations.get(id));
        if (stateGeneration !== undefined) generations.set(pin.sha256, stateGeneration);
        if (validStateParents(state.parents)) stateParents = [...state.parents];
      } catch (error) {
        // An ordinary source blob may begin with State-looking JSON.
        if (!(error instanceof ForgeError) || error.code !== 'INVALID_NATIVE_SOURCE') throw error;
      }
    }
    if (stateSize) outputSizes.set(pin.sha256, stateSize);
    const dimensions = stateSize ? { stateSize } : {};
    if (bytes.length <= sourceResultInlineBytes) {
      small.delete(pin.sha256);
      small.set(pin.sha256, new TextDecoder().decode(bytes));
      if (small.size > 8) small.delete(small.keys().next().value!);
    }
    return {
      async store(): Promise<SourceOutput> {
        const manifest =
          stateParents && stateFiles ? await physical.output(pin, stateFiles, stateParents) : null;
        const projected = stateParents ? await chunks.output(pin, bytes) : null;
        if (projected) {
          // The closure is signed locally for later quanta only after each body
          // was confirmed; the commit still validates all physical bindings.
          const closure = await Promise.all(
            projected
              .physical!.filter(leaf => projected.recipeClosure!.some(pin => pin.sha256 === leaf.sha256))
              .map(async leaf => ({
                digest: leaf.sha256,
                size: leaf.size,
                url: await presignGet(
                  r2Config(),
                  leaf.r2Key,
                  packHeaders(
                    leaf.pack ? { offset: leaf.pack.offset, total: leaf.pack.size } : undefined,
                    leaf.size,
                  ),
                ),
                ...(leaf.pack ? { range: { offset: leaf.pack.offset, total: leaf.pack.size } } : {}),
              })),
          );
          const byDigest = new Map(closure.map(leaf => [leaf.digest, leaf]));
          remember([
            {
              descriptor: { object: pin, recipe: projected.recipe! },
              storageId: null,
              url: null,
              closure: projected.recipeClosure!.map(leaf => byDigest.get(leaf.sha256)!),
              ...(stateGeneration === undefined ? {} : { stateGeneration }),
              stateParents,
              ...(manifest ? { statePhysical: manifest.statePhysical } : {}),
              ...dimensions,
            },
          ]);
          return {
            ...projected,
            ...(stateGeneration === undefined ? {} : { stateGeneration }),
            stateParents,
            ...(manifest
              ? {
                  statePhysical: manifest.statePhysical,
                  physical: [...(projected.physical ?? []), ...manifest.physical],
                }
              : {}),
            ...dimensions,
          };
        }
        const ref = await clock.write(() => (stateParents ? stateStorage : durable).store(bytes, pin)),
          r2 = sourceR2Pin(ref);
        // This action just hash-verified and stored the bytes. Later quanta can read them
        // before the one final commit registers their rows; no descriptor RPC is needed.
        keep(pin, bytes, true);
        if (r2) generatedKeys.set(pin.sha256, r2Key(projectId, r2.sha256));
        remember([
          {
            descriptor: { object: pin, recipe: null },
            ...(stateGeneration === undefined ? {} : { stateGeneration }),
            ...(stateParents === undefined ? {} : { stateParents }),
            ...(manifest ? { statePhysical: manifest.statePhysical } : {}),
            ...dimensions,
            storageId: r2 ? null : (ref as Id<'_storage'>),
            url: null,
          },
        ]);
        return {
          ...pin,
          ...(stateGeneration === undefined ? {} : { stateGeneration }),
          ...(stateParents === undefined ? {} : { stateParents }),
          ...(manifest ?? {}),
          ...dimensions,
          ...(r2 ? { r2Key: r2Key(projectId, r2.sha256) } : { storageId: ref as Id<'_storage'> }),
        };
      },
    };
  }
  return {
    io,
    observedStates: () => [...observedStates.values()],
    outputs,
    putMetrics,
    /** Wait for overlapped writes; `outputs` is complete only after this. */
    settle,
    locations,
    reads,
    clock,
    /** Verified small UTF-8 texts only; delegation stays below the Node argument bound. */
    preloaded: () => {
      let sent = 0;
      return [...held].flatMap(([sha256, bytes]) => {
        try {
          const value = {
            sha256,
            size: bytes.length,
            text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
          };
          // UTF-8 bytes can expand sixfold when JSON escapes controls. Bound the
          // serialized hand-off too, leaving room for descriptors and the outer args.
          const size = new TextEncoder().encode(JSON.stringify(value)).length;
          if (sent + size > 2 * 1024 * 1024) return [];
          sent += size;
          return [value];
        } catch {
          return [];
        }
      });
    },
    /** This step's own small output with exactly this pin, as text; otherwise null. */
    smallOutput: (pin: { sha256: string; size: number } | null) => {
      const text = pin ? small.get(pin.sha256) : undefined;
      return text !== undefined && new TextEncoder().encode(text).length === pin!.size ? text : null;
    },
  };
}
