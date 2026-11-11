// SPDX-License-Identifier: Apache-2.0
import { verifyDownloadedOutput } from './hosted-output-reader.js';
import { z } from 'zod';
import { ForgeError, invariant } from './errors.js';
import { networkFetch } from './network-fetch.js';
import { outputSealSchema, outputStreamSchema } from './hosted-check-output.js';

/** Default and largest tail, in bytes; Forge retains at most 64 KiB of redacted output per job. */
export const CHECK_LOG_TAIL = 8 * 1024;
export const CHECK_LOG_TAIL_MAX = 64 * 1024;
/** Chunk downloads one read may make, newest first: the tail is what is asked for. */
const MAX_CHUNKS = 16;

export const hostedCheckLogSchema = z
  .object({
    action: z.literal('log').optional(),
    runId: z.uuid(),
    tail: z.number().int().min(1).max(CHECK_LOG_TAIL_MAX).default(CHECK_LOG_TAIL),
    stream: z.enum(['stdout', 'stderr']).optional(),
    shard: z.number().int().min(0).optional(),
    attempt: z.number().int().min(0).optional(),
    /** Accepted for symmetry with other verbs; a run belongs to the project, not a Lane. */
    laneId: z.uuid().optional(),
  })
  .strict();

export type CheckLogTransport = {
  query<T>(name: string, args: Record<string, unknown>): Promise<T>;
  mutation<T>(name: string, args: Record<string, unknown>): Promise<T>;
};

const pageSchema = z.object({
  page: z.array(
    z.object({
      streamId: z.string(),
      retired: z.boolean(),
      stream: outputStreamSchema,
      seal: outputSealSchema.nullable(),
    }),
  ),
  isDone: z.boolean(),
  continueCursor: z.string(),
});
const manifestSchema = z.object({
  status: z.string(),
  complete: z.boolean(),
  fullLogs: z.string().optional(),
  providerUrl: z.string().nullable().optional(),
});
const downloadSchema = z.object({
  object: z.object({ sha256: z.string(), size: z.number() }),
  envelope: z.object({ sha256: z.string(), size: z.number() }).optional(),
  url: z.string(),
});

/** The retained, redacted output of one hosted check run (the tail Forge keeps per job), read through
 * the same paged, access-checked accessors as the web view: no provider credential, no `gh`. A bounded tail
 * of the selected streams, newest chunks first. Calls: 1 manifest + 1 per 50 streams + 1 per chunk
 * actually needed (at most MAX_CHUNKS), each chunk one R2 GET; idle 0. */
export async function hostedCheckLog(input: unknown, transport: CheckLogTransport, request?: typeof fetch) {
  const command = hostedCheckLogSchema.parse(input);
  const identity = { runId: command.runId };
  const manifest = manifestSchema.parse(await transport.query('projectHostedOutputRead:manifest', identity));
  const rows: z.infer<typeof pageSchema>['page'] = [];
  let cursor: string | null = null;
  do {
    const page = pageSchema.parse(
      await transport.query('projectHostedOutputRead:streams', { ...identity, cursor }),
    );
    rows.push(...page.page);
    cursor = page.isDone ? null : page.continueCursor;
  } while (cursor !== null);
  const chosen = rows
    .filter(
      row =>
        row.stream.stream !== 'artifact' &&
        (command.stream === undefined || row.stream.stream === command.stream) &&
        (command.shard === undefined || row.stream.shard === command.shard) &&
        (command.attempt === undefined || row.stream.attempt === command.attempt),
    )
    .sort(
      (a, b) =>
        a.stream.attempt - b.stream.attempt ||
        a.stream.shard - b.stream.shard ||
        a.stream.stream.localeCompare(b.stream.stream),
    );
  const base = {
    runId: command.runId,
    status: manifest.status,
    providerUrl: manifest.providerUrl ?? null,
    streams: chosen.map(row => ({
      shard: row.stream.shard,
      attempt: row.stream.attempt,
      stream: row.stream.stream,
      bytes: row.seal?.bytes ?? null,
      sealed: !!row.seal,
      retired: row.retired,
    })),
  };
  if (!chosen.length)
    return {
      ...base,
      text: '',
      truncated: false,
      note: manifest.providerUrl
        ? `Forge holds no retained output for this selection. The provider's full log: ${manifest.providerUrl}`
        : 'Forge holds no retained output for this selection.',
    };
  invariant(
    chosen.some(row => !row.retired),
    'LOG_PROVIDER_HELD',
    `Full logs are provider-held or expired; read the retained summary${manifest.providerUrl ? ` and the provider link ${manifest.providerUrl}` : ''}.`,
  );
  // Newest bytes first: walk streams from the last, chunks from the last, until the tail is full.
  const parts: Uint8Array[] = [];
  let have = 0,
    fetched = 0,
    complete = true;
  walk: for (const row of [...chosen].reverse()) {
    if (row.retired || !row.seal) continue;
    for (let sequence = row.seal.chunks - 1; sequence >= 0; sequence--) {
      if (have >= command.tail) {
        complete = false;
        break walk;
      }
      if (fetched >= MAX_CHUNKS) {
        complete = false;
        break walk;
      }
      const link = downloadSchema.parse(
        await transport.mutation('projectHostedOutputRead:download', {
          ...identity,
          streamId: row.streamId,
          sequence,
        }),
      );
      fetched++;
      const response = await networkFetch(
        link.url,
        { headers: { 'accept-encoding': 'identity' }, redirect: 'error' },
        { request, totalTimeoutMs: 60_000 },
      );
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new ForgeError(
          'SOURCE_UNAVAILABLE',
          `Check output download answered ${response.status}; retry.`,
        );
      }
      const bytes = verifyDownloadedOutput(link, new Uint8Array(await response.arrayBuffer()));
      parts.unshift(bytes);
      have += bytes.length;
    }
  }
  const all = Buffer.concat(parts);
  const tail = all.subarray(Math.max(0, all.length - command.tail));
  // A tail can start inside a multi-byte character: drop the partial lead bytes.
  let start = 0;
  while (start < tail.length && start < 3 && (tail[start]! & 0xc0) === 0x80) start++;
  return {
    ...base,
    text: tail.subarray(start).toString('utf8'),
    truncated:
      !complete || tail.length < all.length || have < base.streams.reduce((n, s) => n + (s.bytes ?? 0), 0),
    chunksRead: fetched,
  };
}
