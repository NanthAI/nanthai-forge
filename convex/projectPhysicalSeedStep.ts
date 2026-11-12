// SPDX-License-Identifier: Apache-2.0
'use node';
import type { ActionCtx } from './server';
import type { Id } from './_generated/dataModel';
import type { ObjectLocation } from './projectConvexSourceTransport';
import { convexSourceTransport } from './projectConvexSourceTransport';
import { sourceStorage, sourceR2Pin } from './projectConvexSourceStorage';
import { makeFunctionReference } from 'convex/server';
import { digest } from '../src/hash';
import { MemoryMergeSource, MemorySourceReader } from '../src/hosted-source-memory';
import {
  startPhysicalSeed,
  advancePhysicalSeed,
  parsePhysicalSeed,
  type PhysicalSeedIo,
} from '../src/physical-manifest-seed';
import type { PhysicalPin, PhysicalEntry } from '../src/physical-manifest-codec';
import type { WorkerPin } from '../src/hosted-source-worker-format';
import { physicalSourceBinding } from './projectConvexPhysicalManifest';
import { PhysicalManifestReader } from '../src/physical-manifest';
import { physicalKey } from '../src/physical-manifest-binary';
import { r2Key, r2Config, presignGet } from './r2';
import { readExactObject } from './projectR2ExactRead';
import { invariant } from '../src/errors';
import { logSourceStep } from '../src/hosted-source-io-error';
import type { SourceOutput } from './projectConvexSourceOutput';

/** Called only by the existing fenced Node source step, never by compose. */
export async function runPhysicalSeedStep(
  ctx: ActionCtx,
  input: { projectId: Id<'hostedProjects'>; jobId: string; step: number; generation?: number },
  state: {
    input: WorkerPin;
    cursor: string | null;
    locations: ObjectLocation[];
    physicalSeed: { state: WorkerPin; base?: WorkerPin };
  },
) {
  let durableReads = 0,
    durableBytes = 0;
  const started = performance.now(),
    transport = convexSourceTransport(ctx, input, state.locations),
    durable = sourceStorage(ctx, input.projectId, digest, transport.putMetrics.observer('progress')),
    ref = (name: string) => makeFunctionReference<'mutation'>(name),
    put = async (bytes: Uint8Array) => {
      const id = await transport.clock.write(() => durable.store(bytes));
      const pin = sourceR2Pin(id);
      invariant(pin, 'SOURCE_JOB_INVALID', 'Physical seed progress must live in R2.');
      return pin;
    },
    readRef = async (id: string) => {
      const bytes = await transport.clock.readBytes(() => durable.read(id));
      durableReads++;
      durableBytes += bytes.length;
      return bytes;
    },
    read = (pin: WorkerPin) => readRef(`r2source:${pin.sha256}:${pin.size}`);
  let parent: PhysicalManifestReader | null = null;
  if (state.physicalSeed.base) {
    const base = state.physicalSeed.base;
    await transport.io.describeBatch!([base.sha256]);
    const row = transport.locations.get(base.sha256)!;
    if (row.statePhysical)
      parent = await PhysicalManifestReader.open(base.sha256, row.statePhysical, async (pin: PhysicalPin) => {
        if (!pin.pack && pin.nonce === undefined) return read(pin);
        const range = pin.pack ? { offset: pin.pack.offset, total: pin.pack.size } : undefined,
          key = r2Key(
            input.projectId,
            physicalKey(pin.pack?.digest ?? pin.sha256, pin.pack?.nonce ?? pin.nonce),
          ),
          url = await presignGet(r2Config(), key),
          bytes = await transport.clock.readBytes(() =>
            readExactObject(
              { url, size: pin.size, ...(range ? { range } : {}) },
              {
                failed: 'Physical seed parent is unavailable.',
                exceeds: 'Physical seed parent range changed.',
              },
            ),
          );
        durableReads++;
        durableBytes += bytes.length;
        invariant(
          bytes.length === pin.size && digest(bytes) === pin.sha256,
          'SOURCE_HASH_MISMATCH',
          'Physical seed parent bytes changed.',
        );
        return bytes;
      });
  }
  const io: PhysicalSeedIo = {
    put,
    read,
    range: async (pin, offset, size) =>
      transport.clock.readBytes(async () => {
        const url = await presignGet(r2Config(), r2Key(input.projectId, pin.sha256));
        const bytes = await readExactObject(
          { url, size, range: { offset, total: pin.size } },
          { failed: 'Physical seed index is unavailable.', exceeds: 'Physical seed index range changed.' },
        );
        durableReads++;
        durableBytes += bytes.length;
        return bytes;
      }),
    describe: async ids => {
      // A catch-up copies only current membership out of the previous verified
      // root. Only genuinely new bindings need catalog resolution.
      const known = parent ? await parent.lookup(ids) : ids.map(() => null),
        missing = ids.filter((_id, at) => !known[at]);
      if (!missing.length) return { rows: known, next: ids.length };
      const found: { rows: (PhysicalEntry | null)[]; next: number } = JSON.parse(
        await transport.clock.call(() =>
          ctx.runMutation(ref('projectConvexSourceObjects:resolve'), {
            projectId: input.projectId,
            jobId: input.jobId,
            step: input.step,
            digests: missing,
            ancestry: false,
            known: [],
            seed: true,
            paged: true,
          }),
        ),
      );
      const values = new Map(missing.slice(0, found.next).map((id, at) => [id, found.rows[at] ?? null]));
      let next = 0;
      while (next < ids.length && (known[next] || values.has(ids[next]!))) next++;
      return { rows: ids.slice(0, next).map((id, at) => known[at] ?? values.get(id) ?? null), next };
    },
  };
  let progress,
    done = false,
    root: WorkerPin | null = null,
    objects: SourceOutput[] = [];
  if (!state.cursor) {
    const source = new MemoryMergeSource({}),
      reader = new MemorySourceReader(source, transport.io),
      selected = await reader.state(state.locations[0]!.descriptor);
    progress = await startPhysicalSeed(
      state.input,
      selected.files.map(file => file.blob),
      io,
    );
  } else {
    progress = parsePhysicalSeed(await readRef(state.cursor));
    invariant(
      progress.state.sha256 === state.input.sha256 && progress.state.size === state.input.size,
      'SOURCE_HASH_MISMATCH',
      'Physical seed resumed another State.',
    );
    const result = await advancePhysicalSeed(progress, io);
    done = result.done;
    root = result.root;
    objects = result.outputs.map(pin => ({ ...pin, r2Key: r2Key(input.projectId, pin.sha256) }));
  }
  if (root) {
    await transport.io.describeBatch!([state.input.sha256]);
    const row = transport.locations.get(state.input.sha256)!,
      binding = physicalSourceBinding(input.projectId, row);
    invariant(binding, 'SOURCE_HASH_MISMATCH', 'Physical seed State binding changed.');
    objects.push({
      ...state.input,
      statePhysical: root,
      ...(binding.recipe
        ? { recipe: binding.recipe }
        : {
            r2Key: r2Key(
              input.projectId,
              physicalKey(binding.pack?.digest ?? binding.sha256, binding.pack?.nonce ?? binding.nonce),
            ),
            ...(binding.pack
              ? {
                  pack: { digest: binding.pack.digest, size: binding.pack.size, offset: binding.pack.offset },
                }
              : {}),
          }),
    });
  }
  if (done && !root)
    console.info(
      'FORGE_SOURCE_BINDINGS',
      JSON.stringify({
        message: 'source bindings: catalog (background seed binding unavailable; original State retained)',
      }),
    );
  const saved = done
    ? null
    : await transport.clock.write(() => durable.store(Buffer.from(JSON.stringify(progress))));
  await transport.settle();
  await ctx.runMutation(ref('projectConvexSourceStore:commit'), {
    ...input,
    cursor: saved,
    objects,
    output: done && root ? state.input : null,
    failure: done && !root ? 'SOURCE_UNAVAILABLE' : null,
    timing: {
      ...transport.clock.value(),
      phase: `physical-seed>${done ? 'done' : 'page'}`,
      stop: done ? 'done' : 'page',
    },
  });
  logSourceStep(input, {
    runtime: 'node',
    kind: 'physical-seed',
    from: state.cursor ? 'page' : 'input',
    to: done ? (root ? 'done' : 'failed') : 'page',
    objects: transport.reads.objects + durableReads,
    bytes: transport.reads.bytes + durableBytes,
    outputs: objects.length,
    putBytes: transport.putMetrics.snapshot(),
    started,
  });
  return null;
}
