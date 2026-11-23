// SPDX-License-Identifier: Apache-2.0
import { httpsLink } from './check-log-policy.js';
import { verifyDownloadedOutput } from './hosted-output-reader.js';
import { z } from 'zod';
import { ForgeError, invariant } from './errors.js';
import { networkFetch } from './network-fetch.js';
import { outputSealSchema, outputStreamSchema } from './hosted-check-output.js';
import { checkTerminal } from './check-run-state.js';

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
      /** Published so far: a running check's stream has chunks before its seal. */
      bytes: z.number().optional(),
      maxSequence: z.number().optional(),
      seal: outputSealSchema.nullable(),
    }),
  ),
  isDone: z.boolean(),
  continueCursor: z.string(),
});
const manifestSchema = z.object({
  status: z.string(),
  complete: z.boolean(),
  progress: z
    .object({
      startedAt: z.string(),
      shardsReported: z.number(),
      shardCount: z.number().nullable(),
    })
    .optional(),
  fullLogs: z.string().optional(),
  // https only (review R-09); anything else reads as no link.
  providerUrl: z.string().nullable().optional().transform(httpsLink),
});
type Manifest = z.infer<typeof manifestSchema>;
/** Why the selection is empty. A run still in flight says what Forge knows of it (since when, how many
 * shards reported) and where to look next, instead of reading as "nothing is happening" (Item 0d14c456). */
export function emptyLogNote(manifest: Manifest, filtered = false) {
  const provider = manifest.providerUrl ? ` The provider's full log: ${manifest.providerUrl}` : '';
  if (checkTerminal(manifest.status) || !manifest.progress)
    return `Forge holds no retained output for this selection.${provider}`;
  const { startedAt, shardsReported, shardCount } = manifest.progress;
  const shards = shardCount === null ? '' : `, ${shardsReported} of ${shardCount} shards reported`;
  return `The check is ${manifest.status} (started ${startedAt}${shards}); ${filtered ? 'nothing is published for this selection yet' : 'no shard has published output yet'}. A shard publishes as it runs: read this again for new lines.${provider}`;
}
const isNotFound = (error: unknown) =>
  (error as { code?: string; data?: { code?: string } })?.code === 'NOT_FOUND' ||
  (error as { data?: { code?: string } })?.data?.code === 'NOT_FOUND';
const downloadSchema = z.object({
  object: z.object({ sha256: z.string(), size: z.number() }),
  envelope: z.object({ sha256: z.string(), size: z.number() }).optional(),
  url: z.string(),
});

/** The retained, redacted output of one hosted check run (the tail Forge keeps per job), read through
 * the same paged, access-checked accessors as the web view: no provider credential, no `gh`. A bounded tail
 * of the selected streams, newest chunks first. While the check runs, a stream not yet sealed is `live` and
 * its tail is the chunks its collector has published so far (Item 42b8bf0e), read once per call: run it again
 * for newer lines, nothing is pushed or polled. Calls: 1 manifest + 1 per 50 streams + 1 per chunk actually
 * needed (at most MAX_CHUNKS), each chunk one R2 GET; idle 0. */
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
    providerUrl: manifest.providerUrl,
    // What Forge knows of the run, so a read that finds other shards' output still shows how far it is.
    progress: manifest.progress ?? null,
    streams: chosen.map(row => ({
      shard: row.stream.shard,
      attempt: row.stream.attempt,
      stream: row.stream.stream,
      bytes: row.seal?.bytes ?? row.bytes ?? null,
      sealed: !!row.seal,
      live: !row.seal && !row.retired,
      retired: row.retired,
    })),
    live: chosen.some(row => !row.seal && !row.retired),
  };
  if (!chosen.length)
    return {
      ...base,
      text: '',
      truncated: false,
      note: emptyLogNote(
        manifest,
        command.stream !== undefined || command.shard !== undefined || command.attempt !== undefined,
      ),
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
    if (row.retired) continue;
    // A live stream's newest chunk can arrive before an older one: the tail stops at the first gap.
    const last = row.seal ? row.seal.chunks - 1 : (row.maxSequence ?? -1);
    for (let sequence = last; sequence >= 0; sequence--) {
      if (have >= command.tail) {
        complete = false;
        break walk;
      }
      if (fetched >= MAX_CHUNKS) {
        complete = false;
        break walk;
      }
      let signed;
      try {
        signed = await transport.mutation('projectHostedOutputRead:download', {
          ...identity,
          streamId: row.streamId,
          sequence,
        });
      } catch (error) {
        if (row.seal || !isNotFound(error)) throw error;
        complete = false;
        break walk;
      }
      const link = downloadSchema.parse(signed);
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
