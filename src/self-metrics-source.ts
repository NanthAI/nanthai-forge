// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { digest } from './hash.js';
import { readHostState } from './host-binding.js';
import { nativeOwner } from './native-source.js';
import { sourceAuthority } from './hosted-source-authority.js';
import { hostedAgentAddress } from './hosted-agent-address.js';
import { ConvexExchange } from './exchange-client.js';
import { makeFunctionReference } from 'convex/server';
import { readHostedMetricPages, type MetricQuery } from './self-metrics-hosted-pages.js';
import type { WorkStore } from './work-store.js';
import type { MetricRecords, MetricPeriod } from './self-metrics-types.js';
import type { HostedAgentAddress } from './hosted-agent-contract.js';

type StoreAccess = Pick<WorkStore, 'directory'>;

/** Inspect only retained addressing. Never construct a WorkStore or wake an owner. */
export function metricAddress(root: string): { owner: string; address: HostedAgentAddress | null } {
  const owner = nativeOwner(realpathSync(root)) ?? realpathSync(root);
  const binding = readHostState({ directory: join(owner, '.forge', 'work') } as StoreAccess).binding;
  return {
    owner,
    address: binding
      ? sourceAuthority(binding).mode === 'server'
        ? { url: binding.deployment, projectId: binding.projectId }
        : null
      : hostedAgentAddress(root, {}),
  };
}
export function metricQuery(address: HostedAgentAddress): MetricQuery {
  const exchange = new ConvexExchange(address.url, process.env.FORGE_AUTH_TOKEN, address.projectId, '', null);
  return Object.assign(
    (name: string, args: Record<string, unknown>) =>
      exchange.client.query(makeFunctionReference<'query'>(name), { ...args, projectId: address.projectId }),
    {
      objects: (pins: import('./self-metrics-hosted-inputs.js').MetricPin[]) => exchange.downloadBatch(pins),
    },
  );
}
/** Join by authority time, retaining context on each side but never counting a
 * stale post-cutover native move. The seam itself is always visible in coverage. */
export function joinMetricAuthority(
  native: MetricRecords,
  hosted: MetricRecords,
  cutover: string,
): MetricRecords {
  const before = (row: { at: string }) => Date.parse(row.at) < Date.parse(cutover);
  const after = (row: { at: string }) => !before(row);
  const merge = <T extends { at: string }>(left: T[], right: T[]) => [
    ...left.filter(before),
    ...right.filter(after),
  ];
  const seam = `Authority seam at ${cutover}: native before cutover, hosted at/after cutover; authority epochs and collection gaps remain separate.`;
  // Native history supplies landings before the hosted context horizon.
  const joined = { ...hosted };
  delete joined.billHistoryFrom;
  return {
    ...joined,
    moves: merge(native.moves, hosted.moves),
    submissions: merge(native.submissions, hosted.submissions),
    runs: merge(native.runs, hosted.runs),
    receipts: merge(native.receipts, hosted.receipts),
    observations: merge(native.observations ?? [], hosted.observations ?? []),
    checkRequests: merge(native.checkRequests ?? [], hosted.checkRequests ?? []),
    finishTimings: merge(native.finishTimings ?? [], hosted.finishTimings ?? []),
    diskSamples: (native.diskSamples ?? []).filter(before),
    surfaceGaps: [...(native.surfaceGaps ?? []), ...(hosted.surfaceGaps ?? []), seam],
    gaps: [...native.gaps, ...hosted.gaps, seam],
    source: { ...hosted.source, kind: 'joined' },
  };
}
export async function readMetricRecords(
  root: string,
  period: MetricPeriod,
  options: {
    pointer?: Buffer | null | undefined;
    query?: MetricQuery;
    summary?: boolean;
    /** Read only the check runs stream (the flake list needs nothing else). */
    runsOnly?: boolean;
    /** Days of pre-window history the hosted read adds as context (default 2, at most 30). */
    contextDays?: number | undefined;
    address?: HostedAgentAddress;
  } = {},
) {
  const selected = options.address ? { owner: root, address: options.address } : metricAddress(root);
  const readNative = async () => {
    const { nativeSelfMetricsReader } = await import('./self-metrics-native.js');
    return nativeSelfMetricsReader(
      selected.owner,
      options.pointer ? { pointer: options.pointer } : {},
    ).read();
  };
  if (!selected.address) return readNative();
  const query = options.query ?? metricQuery(selected.address);
  const { records, cutover } = await readHostedMetricPages(
    Object.assign((name: string, args: Record<string, unknown>) => query(name, args), {
      objects: query.objects ?? (pins => metricQuery(selected.address!).objects!(pins)),
    }),
    period,
    options.summary,
    options.runsOnly,
    options.contextDays,
  );
  if (cutover && Date.parse(period.from) < Date.parse(cutover)) {
    // Hosted-only checkouts have no owner history. Do not manufacture native evidence.
    try {
      const native = await readNative();
      return joinMetricAuthority(native, records, cutover);
    } catch (error) {
      if (!(error instanceof Error) || !/Owner Work records are unavailable|ENOENT/.test(error.message))
        throw error;
      records.surfaceGaps!.push(
        `Authority seam at ${cutover}: pre-cutover native records are unavailable in this checkout.`,
      );
    }
  } else if (!cutover)
    records.surfaceGaps!.push(
      'Hosted cutover timestamp is unavailable; native history cannot be joined safely.',
    );
  return records;
}

/** How long the pages of a stopped or paged read stay answerable on this machine. */
export const METRICS_RESUME_TTL_MS = 60 * 60 * 1000;

/** The read's identity: project, exact window and context horizon. Paging fields are not part of it. */
export const metricsReadToken = (
  address: { url: string; projectId: string },
  period: { from: string; to: string },
  contextDays: number,
) =>
  digest(
    JSON.stringify([
      'forge-metrics-read',
      address.url,
      address.projectId,
      period.from,
      period.to,
      contextDays,
    ]),
  ).slice(0, 16);

/**
 * Every answered server call of one metrics read is appended to a local file (the project's agent
 * cache, mode 0600) under the read's token. The same window asked again within the hour answers the
 * recorded calls from the file and asks the server only for the rest, so a page is never read twice
 * and a read stopped by its deadline continues where it ended (ad80e037). `finish(true)` keeps the
 * file for the next page of a paged reply (Item 686ecdde: four 153 MB reads of one window in 12
 * minutes on 2026-11-22); `finish(false)` deletes it, so a later read starts fresh. R2 object
 * downloads are not recorded: they are not Convex reads, and the machine object cache keeps them.
 */
export async function openMetricsRead(
  root: string,
  token: string,
  base: MetricQuery,
  /** True when the caller continues a paged reply; a read without a cursor never serves a finished paged record. */
  continuing = false,
) {
  // Loaded on demand: the agent paths that read metrics have it already; no other command pays for it.
  const { hostedAgentDirectory } = await import('./hosted-agent-journal.js');
  const directory = join(hostedAgentDirectory(root), 'metrics-read');
  const file = join(directory, `${token}.jsonl`);
  const answers = new Map<string, unknown>();
  let lines: string[] = [];
  try {
    if (Date.now() - statSync(file).mtimeMs < METRICS_RESUME_TTL_MS)
      lines = readFileSync(file, 'utf8').split('\n');
    else rmSync(file, { force: true });
  } catch {
    // No recorded read of this window: a fresh read.
  }
  let paged = false;
  for (const line of lines) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as { k?: string; v?: unknown; paged?: true };
      if (entry.paged) paged = true;
      else if (entry.k !== undefined) answers.set(entry.k, entry.v);
    } catch {
      // A line cut by a killed process: that call is asked again.
    }
  }
  if (paged && !continuing) {
    // A finished paged record serves its own next pages only; any other read of the window starts fresh.
    answers.clear();
    rmSync(file, { force: true });
  }
  if (!answers.size) pruneStoppedReads(directory);
  const reused = answers.size;
  const read = { answered: reused };
  const query: MetricQuery = Object.assign(
    async (name: string, args: Record<string, unknown>) => {
      const key = JSON.stringify([name, args]);
      if (answers.has(key)) return answers.get(key);
      const value = await base(name, args);
      answers.set(key, value);
      if (read.answered === reused) mkdirSync(directory, { recursive: true, mode: 0o700 });
      appendFileSync(file, `${JSON.stringify({ k: key, v: value })}\n`, { mode: 0o600 });
      read.answered++;
      return value;
    },
    base.objects ? { objects: base.objects } : {},
  );
  return {
    query,
    read,
    reused,
    finish(keep: boolean) {
      if (!keep) rmSync(file, { force: true });
      else appendFileSync(file, `${JSON.stringify({ paged: true })}\n`, { mode: 0o600 });
    },
  };
}

/** The next page of a paged reply, when there is one. */
export const hasNextPage = (reply: unknown) =>
  Boolean((reply as { page?: { nextCursor?: unknown } } | null)?.page?.nextCursor);

/** Stopped reads older than the resume window are deleted when a new read starts. */
function pruneStoppedReads(directory: string) {
  let names: string[] = [];
  try {
    names = readdirSync(directory);
  } catch {
    return;
  }
  for (const name of names)
    try {
      if (Date.now() - statSync(join(directory, name)).mtimeMs >= METRICS_RESUME_TTL_MS)
        rmSync(join(directory, name), { force: true });
    } catch {
      // Removed by a concurrent read.
    }
}
