// SPDX-License-Identifier: Apache-2.0
import { closeSync, openSync, rmSync, writeSync } from 'node:fs';
import { createHash, type Hash } from 'node:crypto';
import { checkoutIo } from './checkout-io.js';
import { invariant } from './errors.js';
import { exchangeRequest } from './exchange-request.js';
import { packHeaders, verifyPackRange } from './object-pack-range.js';
import type { ContentPin } from './native-exchange.js';
import { mapExchange } from './exchange-parallel.js';

export type SignedRun = { url: string; offset: number; length: number; total: number };
export type RunMember = { pin: ContentPin; path: string; offset: number };
/** A described row as the transports keep it: `run.key` is unique per describe page. */
export type PackRunBinding = Omit<SignedRun, 'url'> & { key: string; url?: string | undefined };
export type RunRow = { range?: { offset: number } | undefined; run?: PackRunBinding | undefined };
type File = { pin: ContentPin; path: string };

/** Download windows (16 MiB, or one larger unit alone) that never split a pack run. */
export function runGroups(pins: ContentPin[], row: (digest: string) => RunRow | undefined): ContentPin[][] {
  const runs = new Map<string, ContentPin[]>(),
    units: ContentPin[][] = [],
    groups: ContentPin[][] = [];
  for (const pin of pins) {
    const key = row(pin.sha256)?.run?.key;
    if (key && runs.has(key)) runs.get(key)!.push(pin);
    else {
      const unit = [pin];
      if (key) runs.set(key, unit);
      units.push(unit);
    }
  }
  let group: ContentPin[] = [],
    size = 0;
  for (const unit of units) {
    const bytes = unit.reduce((sum, pin) => sum + pin.size, 0);
    if (group.length && size + bytes > 16 * 1024 * 1024) {
      groups.push(group);
      group = [];
      size = 0;
    }
    group.push(...unit);
    size += bytes;
  }
  if (group.length) groups.push(group);
  return groups;
}

/** Reads every run whose members are all in `files` (one ranged GET each, eight at a time)
 * and returns their digests. Everything else, including a run whose signature expired
 * (403), stays with the caller's per-object path, which signs each object on its own. */
export async function readCompleteRuns(
  files: File[],
  rows: ReadonlyMap<string, RunRow>,
  request?: typeof exchangeRequest,
): Promise<Set<string>> {
  const runs = new Map<string, { run: PackRunBinding; files: (File & { offset: number })[] }>(),
    urls = new Map<string, string>(),
    read = new Set<string>();
  for (const row of rows.values()) if (row.run?.url) urls.set(row.run.key, row.run.url);
  for (const file of files) {
    const row = rows.get(file.pin.sha256);
    if (!row?.run || !row.range) continue;
    const entry = runs.get(row.run.key) ?? { run: row.run, files: [] };
    entry.files.push({ ...file, offset: row.range.offset });
    runs.set(row.run.key, entry);
  }
  const complete = [...runs.values()].filter(
    entry =>
      entry.files.length > 1 &&
      urls.has(entry.run.key) &&
      entry.files.reduce((sum, file) => sum + file.pin.size, 0) === entry.run.length,
  );
  await mapExchange(
    complete,
    8,
    async entry => {
      if (
        (await readPackRun({ ...entry.run, url: urls.get(entry.run.key)! }, entry.files, request)) === 'done'
      )
        for (const file of entry.files) read.add(file.pin.sha256);
    },
    { bytes: 64 * 1024 * 1024, size: entry => entry.run.length },
  );
  return read;
}

export function writeAll(fd: number, bytes: Uint8Array) {
  for (let at = 0; at < bytes.length;) {
    const count = writeSync(fd, bytes, at, bytes.length - at);
    invariant(count > 0, 'EXCHANGE_DOWNLOAD_FAILED', 'Checkout staging write was incomplete.');
    at += count;
  }
}

/** Members must tile the run exactly: the server signed only their bytes. */
export function orderedRunMembers(run: Omit<SignedRun, 'url'>, members: RunMember[]) {
  const ordered = [...members].sort((a, b) => a.offset - b.offset);
  let at = run.offset;
  for (const member of ordered) {
    invariant(
      member.offset === at && member.pin.size > 0,
      'INVALID_NATIVE_SOURCE',
      'Pack run members differ from their signed interval.',
    );
    at += member.pin.size;
  }
  invariant(at === run.offset + run.length, 'INVALID_NATIVE_SOURCE', 'Pack run length differs.');
  return ordered;
}

/** One ranged GET streamed into each member's file, each digest checked as it completes.
 * A failed or retried attempt removes every file it opened. `expired` means a 403: the
 * caller signs the members again (per object). */
export async function readPackRun(
  run: SignedRun,
  members: RunMember[],
  request: typeof exchangeRequest = exchangeRequest,
): Promise<'done' | 'expired'> {
  const ordered = orderedRunMembers(run, members);
  return request(
    'Checkout pack run download',
    run.url,
    { headers: { 'accept-encoding': 'identity', ...packHeaders(run, run.length) } },
    async (response, progressed) => {
      if (response.status === 403) {
        await response.body?.cancel();
        return 'expired' as const;
      }
      invariant(
        response.ok,
        'EXCHANGE_DOWNLOAD_DENIED',
        `Stored content download failed (HTTP ${response.status}).`,
      );
      verifyPackRange(response, run, run.length);
      const opened: string[] = [],
        reader = response.body?.getReader();
      let index = -1,
        fd = -1,
        left = 0,
        hash: Hash | null = null,
        complete = false;
      const next = async () => {
        index++;
        if (index >= ordered.length) return;
        const member = ordered[index]!;
        fd = await checkoutIo(async () => openSync(member.path, 'wx', 0o600));
        opened.push(member.path);
        hash = createHash('sha256');
        left = member.pin.size;
      };
      const finish = async () => {
        const member = ordered[index]!;
        await checkoutIo(async () => closeSync(fd));
        fd = -1;
        invariant(
          hash!.digest('hex') === member.pin.sha256,
          'INVALID_NATIVE_SOURCE',
          'Downloaded source is truncated or corrupt.',
        );
        await next();
      };
      try {
        await next();
        if (reader)
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            let bytes = chunk.value;
            while (bytes.length) {
              invariant(
                index < ordered.length,
                'INVALID_NATIVE_SOURCE',
                'Downloaded source exceeds its run.',
              );
              const part = bytes.subarray(0, Math.min(left, bytes.length));
              hash!.update(part);
              await checkoutIo(async () => writeAll(fd, part));
              left -= part.length;
              bytes = bytes.subarray(part.length);
              if (left === 0) await finish();
            }
            progressed();
          }
        invariant(
          index === ordered.length,
          'INVALID_NATIVE_SOURCE',
          'Downloaded source is truncated or corrupt.',
        );
        complete = true;
        return 'done' as const;
      } finally {
        await checkoutIo(async () => {
          if (fd >= 0) closeSync(fd);
          if (!complete) for (const path of opened) rmSync(path, { force: true });
        });
        await reader?.cancel().catch(() => undefined);
        reader?.releaseLock();
      }
    },
  );
}
