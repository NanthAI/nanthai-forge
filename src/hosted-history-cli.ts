// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { ForgeError, invariant } from './errors.js';
import { networkFetch } from './network-fetch.js';
import { safeRelative } from './safe-relative.js';
import { SHOW_MAX_BYTES } from './agent-source-read.js';
import {
  cachedPacks,
  ensureHistoryRepository,
  historyBlame,
  historyCacheDirectory,
  historyFile,
  historyLog,
  indexPack,
  resolveCommit,
} from './history-git.js';
import type { HostedAgentAddress } from './hosted-address.js';

export const hostedHistorySchema = z
  .object({
    action: z.literal('history').optional(),
    op: z.enum(['status', 'log', 'blame', 'show', 'limit', 'retry']).default('status'),
    /** Full or abbreviated hex commit id; default: the newest stored main commit. */
    commit: z
      .string()
      .regex(/^[0-9a-f]{4,40}$/)
      .optional(),
    path: z.string().refine(safeRelative).optional(),
    limit: z.number().int().min(1).max(1000).default(50),
    skip: z.number().int().min(0).default(0),
    start: z.number().int().positive().optional(),
    end: z.number().int().positive().optional(),
    bytes: z.number().int().min(0).optional(),
    force: z.boolean().default(false),
    /** Accepted for symmetry with show; history is per project, not per Lane. */
    laneId: z.uuid().optional(),
  })
  .strict()
  .refine(input => !['blame', 'show'].includes(input.op) || input.path, 'blame and show need path.')
  .refine(input => input.op !== 'limit' || input.bytes !== undefined, 'limit needs bytes.')
  .refine(input => input.end === undefined || (input.start ?? 1) <= input.end, 'start must not exceed end.');

type Opened = {
  status: string;
  repository: string;
  importCommit: string;
  importState: string;
  head?: string;
  headState?: string | null;
  main?: { commit: string; state: string } | null;
  catchUp?: { code: string; message: string };
  bytes: number;
  limitBytes: number;
  error?: { code: string; message: string };
  packs: {
    tip: string;
    packSha1: string;
    bytes: number;
    objects: number;
    chunks: { sha256: string; size: number; url: string }[];
  }[];
};
export type HistoryTransport = {
  action<T>(name: string, args: Record<string, unknown>): Promise<T>;
  mutation<T>(name: string, args: Record<string, unknown>): Promise<T>;
};

async function* download(chunks: Opened['packs'][number]['chunks'], request: typeof fetch | undefined) {
  for (const chunk of chunks) {
    const response = await networkFetch(
      chunk.url,
      { headers: { 'accept-encoding': 'identity' }, redirect: 'error' },
      { request, totalTimeoutMs: 5 * 60_000 },
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new ForgeError(
        'SOURCE_UNAVAILABLE',
        `History download answered ${response.status}; retry the read.`,
      );
    }
    yield { bytes: new Uint8Array(await response.arrayBuffer()), sha256: chunk.sha256, size: chunk.size };
  }
}

/** `history` for hosted projects: log, blame and file-at-commit over the project's
 * imported Git history. One server action per read checks current access and lists
 * packs; R2 downloads happen only for packs this machine has not indexed yet. */
export async function hostedHistory(
  address: HostedAgentAddress,
  input: unknown,
  transport: HistoryTransport,
  request?: typeof fetch,
) {
  const command = hostedHistorySchema.parse(input);
  if (command.op === 'limit')
    return transport.mutation('projectHistoryStore:setLimit', { limitBytes: command.bytes! });
  if (command.op === 'retry') return transport.mutation('projectHistoryStore:retry', {});
  const repo = historyCacheDirectory(address);
  const cached = cachedPacks(repo);
  const opened = await transport.action<Opened>('projectHistoryRead:open', { cached });
  const summary = {
    status: opened.status,
    repository: opened.repository,
    importCommit: opened.importCommit,
    importState: opened.importState,
    head: opened.head ?? null,
    headState: opened.headState ?? null,
    main: opened.main ?? null,
    bytes: opened.bytes,
    limitBytes: opened.limitBytes,
    packs: opened.packs.length,
    ...(opened.error ? { error: opened.error } : {}),
    ...(opened.catchUp ? { catchUp: opened.catchUp } : {}),
  };
  if (command.op === 'status') return { ...summary, cachedPacks: cached.length };
  if (opened.status !== 'ready')
    throw new ForgeError(
      opened.status === 'over-limit'
        ? 'HISTORY_OVER_LIMIT'
        : opened.status === 'pending'
          ? 'HISTORY_PENDING'
          : 'HISTORY_UNAVAILABLE',
      opened.status === 'pending'
        ? 'History is still being imported; retry shortly.'
        : `${opened.error?.message ?? 'History is unavailable.'} Stored ${opened.bytes} of a ${opened.limitBytes}-byte limit; the owner can raise it (history {"op":"limit","bytes":N}) and retry (history {"op":"retry"}).`,
    );
  ensureHistoryRepository(repo);
  let downloaded = 0;
  for (const pack of opened.packs) {
    if (cached.includes(pack.packSha1)) continue;
    invariant(pack.chunks.length, 'HOSTED_PROTOCOL_INVALID', 'History pack download links are missing.');
    await indexPack(repo, pack.packSha1, download(pack.chunks, request));
    downloaded += pack.bytes;
  }
  const commit = resolveCommit(repo, command.commit ?? opened.head!);
  const read = { ...summary, commit, downloadedBytes: downloaded };
  if (command.op === 'log')
    return {
      ...read,
      ...historyLog(repo, commit, { path: command.path, limit: command.limit, skip: command.skip }),
    };
  if (command.op === 'blame')
    return {
      ...read,
      path: command.path!,
      ...historyBlame(
        repo,
        commit,
        command.path!,
        command.start || command.end ? { start: command.start ?? 1, end: command.end } : undefined,
      ),
    };
  const file = historyFile(repo, commit, command.path!, command.force ? null : SHOW_MAX_BYTES);
  return { ...read, path: command.path!, ...file };
}
