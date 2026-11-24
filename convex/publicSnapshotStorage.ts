// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { convexFetch, networkTimeout } from './networkFetch';
import { presign } from './presign';
import { r2Endpoint, type R2Config } from './r2';
import { readR2Object } from './r2Operations';
import { invariant } from '../src/errors';
import { sha256Hex } from '../src/verified-blob';
import { snapshotFence, snapshotRecord, type SnapshotFence } from '../src/public-snapshot-contract';
import { explorePackBytes, explorePackPages, explorePageBytes } from '../src/public-explore-pages';

type Address = { key: string; limit: number; packed?: true };
type PublishResult = 'obsolete' | 'unchanged' | 'conflict' | 'written';
type Selection =
  | { state: 'hidden'; generation: number; at: number; tailRevision?: number }
  | ({ state: 'public'; generation: number; asOf: number; tailRevision?: number } & (
      | { data: Record<string, unknown> }
      | { frames: readonly Record<string, unknown>[] }
    ));
const utf8 = new TextEncoder();
const json = (value: unknown) => utf8.encode(JSON.stringify(value));

/** Observe the serving key before selecting the authority's current projection. A hide that occurs
 * after selection either puts the new fence after this write or wins the ETag and refuses it.
 * Never delete the serving key: that would let an old create-only writer resurrect the snapshot. */
export async function publishSnapshot(
  config: R2Config,
  address: Address,
  select: () => Promise<Selection | null>,
  putAttempt?: () => void,
): Promise<PublishResult> {
  const observed = await observe(config, address);
  return replace(config, address, observed, await select(), putAttempt);
}

/** Observe each page before one authority check for the whole batch. An unknown result can be
 * retried as a unit: already stored pages become no-ops, including tombstones. */
export async function publishSnapshotBatch(
  config: R2Config,
  addresses: readonly Address[],
  select: () => Promise<readonly (Selection | null)[] | null>,
  putAttempt?: (index: number) => void,
) {
  invariant(addresses.length <= 16, 'BAD_ARGUMENT', 'Public snapshot writes need a bounded batch.');
  const observed = await Promise.all(addresses.map(address => observe(config, address)));
  const selection = await select();
  if (!selection) return addresses.map(() => 'obsolete' as const);
  invariant(
    selection.length === addresses.length,
    'BAD_ARGUMENT',
    'Public snapshot projection did not match its batch.',
  );
  const outcomes = await Promise.allSettled(
    addresses.map((address, i) =>
      replace(config, address, observed[i]!, selection[i]!, () => putAttempt?.(i)),
    ),
  );
  return outcomes.map(result => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  });
}

async function observe(config: R2Config, address: Address) {
  const previous = await readR2Object(config, address.key, address.limit);
  if (!previous) return null;
  invariant(previous.etag, 'SOURCE_CHANGED', 'Object storage omitted the public snapshot ETag.');
  if (address.packed)
    invariant(
      previous.bytes.length === explorePackBytes,
      'SOURCE_CHANGED',
      'The Explore pack has an invalid byte length.',
    );
  // The first frame commits the hash and generation of the whole object. R2 CAS protects every frame together.
  return {
    etag: previous.etag,
    fence: decode(address.packed ? previous.bytes.subarray(0, explorePageBytes) : previous.bytes),
  };
}

async function replace(
  config: R2Config,
  address: Address,
  previous: Awaited<ReturnType<typeof observe>>,
  selection: Selection | null,
  putAttempt?: () => void,
): Promise<PublishResult> {
  const old = previous?.fence;
  if (!selection || (old && old.generation > selection.generation)) return 'obsolete';
  if (old?.generation === selection.generation && old.state === 'hidden') {
    if (selection.state === 'hidden') return 'unchanged';
    // Only a newer directory publication can reopen a retired tail. Entity hides never carry a tail revision.
    if (old.tailRevision === undefined || (selection.tailRevision ?? -1) <= old.tailRevision)
      return 'obsolete';
  }
  const body = await snapshotBody(address, selection, old);
  if (!body) return 'unchanged';
  invariant(body.byteLength <= address.limit, 'BAD_ARGUMENT', 'The public snapshot exceeds its page budget.');
  const checksum = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', body))));
  const headers: Record<string, string> = {
    'content-length': String(body.byteLength),
    'x-amz-checksum-sha256': checksum,
    ...(previous ? { 'if-match': previous.etag } : { 'if-none-match': '*' }),
  };
  const url = await presign({
    method: 'PUT',
    ...r2Endpoint(config),
    path: `/${config.bucket}/${address.key}`,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    expires: 60,
    headers,
  });
  putAttempt?.();
  const response = await convexFetch(url, { method: 'PUT', headers, body, signal: networkTimeout(8_000) });
  await response.body?.cancel();
  // The same job re-observes and reselects on a conflict or an unknown outcome. It never replays old bytes.
  if (response.status === 412 || response.status === 409) return 'conflict';
  invariant(
    response.ok,
    'R2_UPLOAD_FAILED',
    'Could not publish the public snapshot; retry the same generation.',
  );
  return 'written';
}

async function snapshotBody(address: Address, selection: Selection, previous: SnapshotFence | undefined) {
  const { generation } = selection;
  const tombstone = (at: number) => ({ v: 1, state: 'hidden', generation, at }) as const;
  if (selection.state === 'hidden') {
    const hidden = {
      ...tombstone(selection.at),
      ...(selection.tailRevision === undefined ? {} : { tailRevision: selection.tailRevision }),
    };
    return address.packed ? encodePack([], hidden, hidden) : json(hidden);
  }
  const { asOf } = selection;
  const value = 'frames' in selection ? selection.frames : selection.data;
  const contentHash = await sha256Hex(json(value));
  if (
    previous?.state === 'public' &&
    previous.generation === generation &&
    previous.contentHash === contentHash
  )
    return null;
  const fence = { v: 1, state: 'public', generation, asOf, contentHash } as const;
  if ('frames' in selection) {
    invariant(
      address.packed && selection.frames.length > 0,
      'BAD_ARGUMENT',
      'Explore frames require a pack address.',
    );
    return encodePack(selection.frames, fence, tombstone(asOf));
  }
  invariant(!address.packed, 'BAD_ARGUMENT', 'An Explore pack needs fixed-width frames.');
  return json({ ...selection.data, ...fence });
}

function encodePack(frames: readonly Record<string, unknown>[], fence: SnapshotFence, hidden: SnapshotFence) {
  invariant(frames.length <= explorePackPages, 'BAD_ARGUMENT', 'Too many pages for one Explore pack.');
  const pack = new Uint8Array(explorePackBytes).fill(0x20);
  for (let index = 0; index < explorePackPages; index++) {
    const data = frames[index];
    const body = json(data ? { ...data, ...fence } : hidden);
    invariant(
      body.byteLength <= explorePageBytes,
      'BAD_ARGUMENT',
      'An Explore frame exceeds its page budget.',
    );
    pack.set(body, index * explorePageBytes);
  }
  return pack;
}

function decode(bytes: Uint8Array): SnapshotFence {
  const data = snapshotRecord(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  const fence = data && snapshotFence(data);
  invariant(fence, 'SOURCE_CHANGED', 'The public snapshot has no valid visibility fence.');
  return fence;
}
