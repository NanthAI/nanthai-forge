// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { ForgeError, invariant } from './errors.js';
import { networkFetch } from './network-fetch.js';
import { SHOW_MAX_BYTES } from './agent-source-read.js';
import {
  cachedPacks,
  cachedHistoryMetadata,
  retainHistoryMetadata,
  ensureHistoryRepository,
  historyBlame,
  historyCacheDirectory,
  historyFile,
  historyLog,
  indexPack,
  resolveCommit,
} from './history-git.js';
import { PackTrees } from './git-pack-trees.js';
import { historyLogPage, loadHistoryMetadata } from './history-log-page.js';
import type { HostedAgentAddress } from './hosted-address.js';
import { landingHistory, noImportedHistory } from './hosted-history-landings.js';

export { hostedHistorySchema } from './hosted-history-schema.js';
import { hostedHistorySchema } from './hosted-history-schema.js';

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
  metadata?: { pack: string; data: string }[];
  metadataPacks?: string[];
  readBytes?: number;
  logFallback?: string;
  packs: {
    tip: string;
    packSha1: string;
    bytes: number;
    objects: number;
    chunks: { sha256: string; size: number; url: string }[];
  }[];
};
export type HistoryTransport = {
  readonly advertisedFeatures?: readonly string[] | undefined;
  action<T>(name: string, args: Record<string, unknown>): Promise<T>;
  query<T>(name: string, args: Record<string, unknown>): Promise<T>;
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
 * metadata (or explicit legacy pack links). Verified metadata is reused after current access
 * checks, without downloading file bodies or rereading cached packs on R2. A project with no
 * imported history answers a file log from its landings (hosted-history-landings.ts). */
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
  // A landing log's continuation is one query: only that log hands out a cursor.
  if (command.op === 'log' && command.cursor !== undefined)
    return landingHistory(transport, address.projectId, command);
  const repo = historyCacheDirectory(address);
  const cached = cachedPacks(repo);
  const metadata = command.op === 'log' ? cachedHistoryMetadata(repo) : new Map<string, Buffer>();
  const metadataReader = transport.advertisedFeatures?.includes('history-log') ?? true;
  let opened: Opened;
  try {
    opened = await transport.action<Opened>(
      'projectHistoryRead:open',
      command.op === 'log' && metadataReader
        ? {
            cached,
            cachedMetadata: [...metadata.keys()],
            log: {
              ...(command.commit ? { commit: command.commit } : {}),
              ...(command.path ? { path: command.path } : {}),
              limit: command.limit,
              skip: command.skip,
            },
          }
        : { cached },
    );
  } catch (error) {
    if (command.op === 'log' && noImportedHistory(error))
      return landingHistory(transport, address.projectId, command);
    const message = error instanceof Error ? error.message : '';
    if (
      command.op !== 'log' ||
      !/log|cachedMetadata/.test(message) ||
      !/ArgumentValidationError|extra field/.test(message)
    )
      throw error;
    // Older strict servers do not accept the optional reader yet. Preserve the
    // existing exact-source read, explicitly labelled, instead of adding an upgrade step.
    opened = {
      ...(await transport.action<Opened>('projectHistoryRead:open', { cached })),
      logFallback:
        'This server predates metadata-only history logs (history-log); this log uses the existing local pack cache.',
    };
  }
  if (command.op === 'log' && !metadataReader)
    opened.logFallback =
      'This server predates metadata-only history logs (history-log); this log uses the existing local pack cache.';
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
    packs: opened.metadataPacks?.length ?? opened.packs.length,
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
  const selectedCommit = command.commit ?? opened.head!;
  if (command.op === 'log' && opened.metadata && opened.metadataPacks) {
    try {
      const scan = new PackTrees(128 * 1024 * 1024, { commits: true });
      for (const item of opened.metadata) {
        invariant(
          /^[0-9a-f]{40}$/.test(item.pack),
          'HOSTED_PROTOCOL_INVALID',
          'Invalid history metadata pack.',
        );
        const bytes = Buffer.from(item.data, 'base64');
        metadata.set(item.pack, bytes);
      }
      for (const pack of opened.metadataPacks) {
        const bytes = metadata.get(pack);
        invariant(bytes, 'HOSTED_PROTOCOL_INVALID', 'History metadata cache is incomplete.');
        loadHistoryMetadata(scan, bytes);
      }
      const log = historyLogPage(scan, selectedCommit, command);
      for (const item of opened.metadata) retainHistoryMetadata(repo, item.pack, metadata.get(item.pack)!);
      return {
        ...summary,
        ...log,
        downloadedBytes: 0,
        readBytes: opened.readBytes ?? 0,
        readMode: 'metadata',
      };
    } catch {
      // A Git layout/encoding not represented by the metadata reader keeps the original reader.
      // This explicit compatibility continuation is used only for such a selection.
      const fallback = await transport.action<Opened>('projectHistoryRead:open', { cached });
      // Retain the first read's immutable anchor even if main moves between these calls.
      opened = {
        ...fallback,
        logFallback:
          'The cached metadata scanner cannot answer this selection; this log uses the existing local pack cache.',
      };
    }
  }
  if (command.op === 'log' && !opened.logFallback)
    opened.logFallback =
      'This server returned the original history format; this log uses the existing local pack cache.';
  ensureHistoryRepository(repo);
  let downloaded = 0;
  for (const pack of opened.packs) {
    if (cached.includes(pack.packSha1)) continue;
    invariant(pack.chunks.length, 'HOSTED_PROTOCOL_INVALID', 'History pack download links are missing.');
    await indexPack(repo, pack.packSha1, download(pack.chunks, request));
    downloaded += pack.bytes;
  }
  const commit = resolveCommit(repo, selectedCommit);
  const read = { ...summary, commit, downloadedBytes: downloaded };
  if (command.op === 'log')
    return {
      ...read,
      ...historyLog(repo, commit, { path: command.path, limit: command.limit, skip: command.skip }),
      readMode: 'pack-cache',
      note: opened.logFallback,
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
