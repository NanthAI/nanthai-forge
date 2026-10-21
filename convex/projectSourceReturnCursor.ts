// SPDX-License-Identifier: Apache-2.0
'use node';
import { createGzip, createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseJsonStream } from '../src/json-stream';
import { blobStore } from './blobStore';
import type { ActionCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { invariant } from '../src/errors';
import { jsonChunks } from '../src/json-chunks';
import { digest } from '../src/hash';
import { storageDigest } from './storageDigest';

// Source-return cursor and snapshot bodies are immutable once stored: a new
// position is always a new storage ID. This process keeps the gzip bodies it
// wrote or read, so a warm worker resumes its own committed cursor without
// transferring it again. A memo hit still requires current storage metadata
// with the same size and SHA-256. The stage row (read fresh) selects which ID
// applies, and every step and the final publication recheck current authority.
const memo = new Map<string, { body: Buffer; sha256: string }>();
let memoBytes = 0;
const MEMO_BYTES = 64 * 1024 * 1024;

function remember(id: string, body: Buffer) {
  forget(id);
  if (body.length > MEMO_BYTES) return;
  while (memoBytes + body.length > MEMO_BYTES) forget(memo.keys().next().value!);
  memo.set(id, { body, sha256: digest(body) });
  memoBytes += body.length;
}
function forget(id: string) {
  const entry = memo.get(id);
  if (!entry) return;
  memo.delete(id);
  memoBytes -= entry.body.length;
}
async function recall(ctx: ActionCtx, id: Id<'_storage'>) {
  const entry = memo.get(id);
  if (!entry) return undefined;
  const metadata = await blobStore(ctx).getMetadata(id);
  if (!metadata || metadata.size !== entry.body.length || storageDigest(metadata.sha256) !== entry.sha256) {
    forget(id);
    return undefined;
  }
  memo.delete(id);
  memo.set(id, entry);
  return entry.body;
}
/** Test hook: model a cold worker. */
export function forgetReturnCursors() {
  memo.clear();
  memoBytes = 0;
}

export async function storeReturnJson(ctx: ActionCtx, value: unknown): Promise<Id<'_storage'>> {
  const compressed: Buffer[] = [];
  await pipeline(Readable.from(jsonChunks(value)), createGzip(), async source => {
    for await (const chunk of source) compressed.push(chunk as Buffer);
  });
  const body = Buffer.concat(compressed);
  const id = await blobStore(ctx).store(new Blob([body], { type: 'application/gzip' }));
  remember(id, body);
  return id;
}
export async function deleteReturnJson(ctx: ActionCtx, id: Id<'_storage'>) {
  forget(id);
  await blobStore(ctx).delete(id);
}
/** Reads gzip bodies and legacy plain JSON cursors/snapshots. */
export async function readReturnJson<T>(
  ctx: ActionCtx,
  id: Id<'_storage'>,
  message: string,
  transform?: Parameters<typeof parseJsonStream>[1],
): Promise<T> {
  let body = await recall(ctx, id);
  if (!body) {
    const blob = await blobStore(ctx).get(id);
    invariant(blob, 'WORK_STALE', message);
    body = Buffer.from(await blob.arrayBuffer());
    remember(id, body);
  }
  // A Blob/Buffer slice is only a view; do not give zlib one complete inflated
  // snapshot or JSON.parse one complete UTF-16 copy.
  async function* chunks() {
    for (let offset = 0; offset < body!.length; offset += 65536) yield body!.subarray(offset, offset + 65536);
  }
  const stream = Readable.from(chunks());
  return (await parseJsonStream(
    body[0] === 0x1f && body[1] === 0x8b ? stream.pipe(createGunzip()) : stream,
    transform,
  )) as T;
}
