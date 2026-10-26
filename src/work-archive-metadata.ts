// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { logRecordSchema } from './check-log-policy.js';
import { nativeDependencyHead, nativeDependencyLookup } from './native-pr-pins.js';
import type { WorkData } from './work-types.js';
export const fileSchema = z.object({
  path: z.string(),
  size: z.number().safe().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export const manifestSchema = z.object({
  schema: z.literal(1),
  kind: z.literal('forge-source-and-work'),
  id: z.uuid(),
  at: z.string(),
  head: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/),
  format: z.enum(['sha1', 'sha256']),
  revision: z.number().safe().nonnegative(),
  refs: z.array(z.object({ ref: z.string(), head: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/) })),
  files: z.array(fileSchema),
  unavailable: z.array(z.string()),
  coverage: z.string(),
  checkLogs: z.array(logRecordSchema).optional(),
});

export const nativeFileSchema = z
  .object({
    path: z
      .string()
      .regex(
        /^(?:work\.json|objects\/[0-9a-f]{64}|check-[0-9a-f-]{36}\/(?:stdout\.log|stderr\.log|result\.json|test-reports\.json|modal-plan\.json|modal-shard-logs\.json|changes\.json|resources\.txt|artifacts\/artifact-[0-9]+\.bin))$/,
      ),
    size: z.number().safe().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
const nativeManifestFields = {
  kind: z.literal('forge-native-work-backup'),
  id: z.string().uuid(),
  head: z.string().regex(/^[0-9a-f]{64}$/),
  revision: z.number().int().nonnegative(),
  files: z.array(nativeFileSchema),
  unavailable: z.array(z.string()).default([]),
  coverage: z.string(),
  checkLogs: z.array(logRecordSchema).optional(),
};
const artifactPath = z.string().regex(/^check-[0-9a-f-]{36}\/artifacts\/artifact-[0-9]+\.bin$/);
const artifactAliasSchema = z.object({ path: artifactPath, target: artifactPath }).strict();
export const nativeManifestSchema = z
  .discriminatedUnion('schema', [
    z.object({ schema: z.literal(1), ...nativeManifestFields }).strict(),
    z
      .object({
        schema: z.literal(2),
        ...nativeManifestFields,
        artifactAliases: z.array(artifactAliasSchema),
      })
      .strict(),
  ])
  .superRefine((manifest, context) => {
    if (manifest.schema !== 2) return;
    const files = new Map(manifest.files.map((file, index) => [file.path, { ...file, index }]));
    const aliases = new Set(manifest.artifactAliases.map(alias => alias.path));
    if (files.size !== manifest.files.length || aliases.size !== manifest.artifactAliases.length) {
      context.addIssue({
        code: 'custom',
        message: 'Native backup repeats logical file or artifact alias paths.',
      });
    }
    for (const [index, alias] of manifest.artifactAliases.entries()) {
      const file = files.get(alias.path),
        target = files.get(alias.target);
      if (
        !file ||
        !target ||
        alias.path === alias.target ||
        aliases.has(alias.target) ||
        target.index >= file.index ||
        file.size !== target.size ||
        file.sha256 !== target.sha256 ||
        manifest.unavailable.includes(alias.path) ||
        manifest.unavailable.includes(alias.target)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['artifactAliases', index],
          message: 'Artifact aliases require an earlier physical artifact with the same size and SHA-256.',
        });
      }
    }
  });
export const sourceManifestSchema = z.union([manifestSchema, nativeManifestSchema]);
export function workSourcePins(data: WorkData) {
  const lookup = data.nativeHead ? nativeDependencyLookup(data) : undefined;
  return [
    ...new Set([
      ...(data.nativeHead ? [data.nativeHead] : []),
      ...(data.nativeContributionReceipts ?? []).flatMap(item => [item.base, item.head]),
      ...(data.historicalWork ?? []).map(item => item.destination.head),
      // Planned schema-16 Intents carry no pin until their first Lane.
      ...data.intents.flatMap(item => (item.base ? [item.base] : [])),
      ...data.intents.flatMap(
        item =>
          item.external?.observations.flatMap(observation =>
            observation.native
              ? [observation.native.base, observation.native.head, observation.native.projection.state]
              : [],
          ) ?? [],
      ),
      ...data.lanes.flatMap(item => [
        item.base,
        item.head,
        ...item.checkpoints.flatMap(pin => [pin.head, pin.parent]),
        ...(item.pending ? [item.pending.head, item.pending.parent] : []),
        ...(item.parent ? [item.parent.head] : []),
      ]),
      ...data.views.flatMap(item => [
        item.base,
        ...(item.head ? [item.head] : []),
        ...item.inputs.map(pin => pin.head),
        ...(item.dependencies ?? []).map(pin =>
          data.nativeHead ? nativeDependencyHead(data, pin, lookup) : pin.head,
        ),
      ]),
      ...data.channelMoves.flatMap(item => [item.head, ...(item.previous ? [item.previous] : [])]),
    ]),
  ];
}
export type ArchiveSource =
  | { head: string; refs: { ref: string; head: string }[] }
  | { head: string; states: string[] };
function nativeManifestObjects(manifest: z.infer<typeof nativeManifestSchema>) {
  return new Set(
    manifest.files.filter(file => file.path === `objects/${file.sha256}`).map(file => file.sha256),
  );
}
export function archiveSource(manifest: z.infer<typeof sourceManifestSchema>, data: WorkData): ArchiveSource {
  if (manifest.kind === 'forge-source-and-work') return manifest;
  const objects = nativeManifestObjects(manifest);
  return { head: manifest.head, states: workSourcePins(data).filter(head => objects.has(head)) };
}
export function retainedSource(source: ArchiveSource, head: string, ref?: string) {
  return 'states' in source
    ? source.states.includes(head)
    : ref
      ? source.refs.some(pin => pin.ref === ref && pin.head === head)
      : [source.head, ...source.refs.map(pin => pin.head)].includes(head);
}
export function archiveChannels(
  manifest: z.infer<typeof sourceManifestSchema>,
  data: { channelMoves: { channel: string; head: string; status: string }[] },
) {
  if (manifest.kind === 'forge-source-and-work')
    return manifest.refs
      .filter(pin => pin.ref.startsWith('refs/forge/channels/'))
      .map(pin => ({ name: pin.ref.slice('refs/forge/channels/'.length), head: pin.head }));
  const objects = nativeManifestObjects(manifest);
  return [
    ...new Map(
      data.channelMoves
        .filter(move => move.status === 'accepted' && objects.has(move.head))
        .map(move => [move.channel, { name: move.channel, head: move.head }]),
    ).values(),
  ];
}

// Shared bounded metadata reader; full source/history/evidence validation remains in native local restore.
// Blob.stream() may yield the complete backing buffer (including in Node 24).
// Slice before reading so compressed source/history never become one copied chunk.
function archiveStream(input: Blob | ReadableStream<Uint8Array<ArrayBuffer>>) {
  if (!(input instanceof Blob)) {
    const reader = input.getReader();
    let pending = new Uint8Array(0),
      position = 0,
      finished = false;
    let stopping: Promise<void> | undefined;
    const stop = (reason?: unknown) =>
      (stopping ??= (async () => {
        if (finished) return;
        finished = true;
        pending = new Uint8Array(0);
        try {
          await reader.cancel(reason);
        } finally {
          reader.releaseLock();
        }
      })());
    const stream = new ReadableStream<Uint8Array<ArrayBuffer>>(
      {
        async pull(controller) {
          while (position === pending.length) {
            const next = await reader.read();
            if (next.done) {
              finished = true;
              reader.releaseLock();
              controller.close();
              return;
            }
            pending = next.value;
            position = 0;
          }
          const end = Math.min(position + 64 * 1024, pending.length);
          controller.enqueue(pending.subarray(position, end));
          position = end;
        },
        cancel: stop,
      },
      { highWaterMark: 0 },
    );
    return { stream, stop };
  }
  let offset = 0;
  const stream = new ReadableStream<Uint8Array<ArrayBuffer>>(
    {
      async pull(controller) {
        if (offset === input.size) {
          controller.close();
          return;
        }
        const end = Math.min(offset + 64 * 1024, input.size);
        controller.enqueue(new Uint8Array(await input.slice(offset, end).arrayBuffer()));
        offset = end;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, stop: async () => undefined };
}
export async function workArchiveMetadata(
  input: Blob | ReadableStream<Uint8Array<ArrayBuffer>>,
  members?: {
    select(name: string, prefix: Uint8Array): boolean;
    read(name: string, bytes: Uint8Array): void | Promise<void>;
  },
  progressed?: () => void,
): Promise<{ manifest: Uint8Array; work: Uint8Array }> {
  const compressed = archiveStream(input),
    upstream = compressed.stream.getReader(),
    decoder = new DecompressionStream('gzip');
  const writer = decoder.writable.getWriter(),
    reader = decoder.readable.getReader();
  let queuedInput: Promise<ReadableStreamReadResult<Uint8Array<ArrayBuffer>>> | undefined,
    writing: Promise<void> | undefined,
    upstreamDone = false;
  // Feed only while metadata needs decoded output. pipeThrough eagerly drains the
  // compressed source in Node 22, even when metadata is followed by large artifacts.
  async function decoded() {
    let ready = false;
    const output = reader.read().then(
      value => {
        ready = true;
        return value;
      },
      error => {
        ready = true;
        throw error;
      },
    );
    await Promise.resolve();
    while (!ready) {
      if (writing) {
        await Promise.race([output, writing]);
        if (ready) break;
        writing = undefined;
      }
      if (upstreamDone) return output;
      queuedInput ??= upstream.read();
      void queuedInput.catch(() => undefined);
      const next = await Promise.race([
        output.then(value => ({ output: value })),
        queuedInput.then(value => ({ input: value })),
      ]);
      if ('output' in next) return next.output;
      queuedInput = undefined;
      if (next.input.done) {
        upstreamDone = true;
        writing = writer.close();
      } else {
        if (next.input.value.length) progressed?.();
        writing = writer.write(next.input.value);
      }
      // A decoded result can win the race; retain the write for the next read and
      // handle a later rejection even if metadata is already complete.
      void writing.catch(() => undefined);
    }
    return output;
  }
  let pending = new Uint8Array(0),
    position = 0;
  async function take(size: number): Promise<Uint8Array> {
    const bytes = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      if (position === pending.length) {
        const next = await decoded();
        if (next.done) throw new Error('The source and Work archive is incomplete.');
        pending = next.value;
        position = 0;
      }
      const count = Math.min(size - offset, pending.length - position);
      bytes.set(pending.subarray(position, position + count), offset);
      position += count;
      offset += count;
    }
    return bytes;
  }
  async function entry(name: string, extra = false) {
    const header = await take(512),
      text = new TextDecoder(),
      field = (start: number, end: number) =>
        text
          .decode(header.slice(start, end))
          .replace(/[\0 ]+$/g, '')
          .trim();
    const sum = header.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (
      field(0, 100) !== name ||
      header.slice(345, 500).some(byte => byte !== 0) ||
      ![0, 48].includes(header[156]!) ||
      !/^[0-7]+$/.test(field(124, 136)) ||
      !/^[0-7]+$/.test(field(148, 156)) ||
      sum !== parseInt(field(148, 156), 8)
    )
      throw new Error('Select an archive produced by Forge source and Work export.');
    const size = parseInt(field(124, 136), 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Archive metadata size is invalid.');
    const prefix = await take(Math.min(size, 256));
    const selected = !extra || members!.select(name, prefix);
    let bytes = prefix;
    if (selected) {
      bytes = new Uint8Array(size);
      bytes.set(prefix);
      bytes.set(await take(size - prefix.length), prefix.length);
    } else {
      for (let remaining = size - prefix.length; remaining > 0;) {
        const count = Math.min(remaining, 65536);
        await take(count);
        remaining -= count;
      }
    }
    await take((512 - (size % 512)) % 512);
    if (extra && selected) await members!.read(name, bytes);
    return bytes;
  }
  try {
    const manifest = await entry('manifest.json'),
      work = await entry('work.json');
    if (members) {
      const value = sourceManifestSchema.parse(JSON.parse(new TextDecoder().decode(manifest)));
      const aliases = new Set(
        value.kind === 'forge-native-work-backup' && value.schema === 2
          ? value.artifactAliases.map(a => a.path)
          : [],
      );
      for (const file of value.files)
        if (file.path !== 'work.json' && !aliases.has(file.path)) await entry(file.path, true);
    }
    return { manifest, work };
  } finally {
    await reader.cancel().catch(() => undefined);
    await writer.abort().catch(() => undefined);
    await upstream.cancel().catch(() => undefined);
    reader.releaseLock();
    writer.releaseLock();
    upstream.releaseLock();
    await compressed.stop().catch(() => undefined);
  }
}
