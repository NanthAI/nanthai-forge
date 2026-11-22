// SPDX-License-Identifier: Apache-2.0
import { ConvexError } from 'convex/values';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { ForgeError, invariant } from '../src/errors';
import { internal } from './_generated/api';
import { httpAction } from './_generated/server';
import { convexFetch, networkTimeout } from './networkFetch';
import { presignGet, r2Config } from './r2';

const noStore = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
function unavailable(code: string, message: string, status: number) {
  return Response.json({ code, message }, { status, headers: noStore });
}
const missing = () => unavailable('NOT_FOUND', 'This discussion attachment is unavailable.', 404);

/** The only buffer we own during the fetch is the exact committed size.
 * Even a chunked response with too many bytes is stopped before copying. */
async function readBytes(pin: { r2Key: string; size: number; digest: string }) {
  const response = await convexFetch(await presignGet(r2Config(), pin.r2Key), {
    headers: { 'Accept-Encoding': 'identity' },
    redirect: 'error',
    signal: networkTimeout(30_000),
  });
  const reader = response.body?.getReader();
  try {
    invariant(response.status === 200 && reader, 'R2_OBJECT_UNAVAILABLE', 'R2 attachment read failed.');
    const bytes = new Uint8Array(pin.size);
    const hash = sha256.create();
    let offset = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      invariant(
        offset + part.value.byteLength <= pin.size,
        'BLOB_DIGEST_MISMATCH',
        'Attachment exceeds its committed size.',
      );
      hash.update(part.value);
      bytes.set(part.value, offset);
      offset += part.value.byteLength;
    }
    invariant(
      offset === pin.size && bytesToHex(hash.digest()) === pin.digest,
      'BLOB_DIGEST_MISMATCH',
      'Attachment differs from its committed bytes.',
    );
    return bytes;
  } finally {
    if (reader) {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

/** Convex serializes response streams in chunks. Keep the verified buffer as
 * the backing store instead of constructing a second full response buffer. */
function downloadBody(bytes: Uint8Array<ArrayBuffer>) {
  let offset = 0;
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(controller) {
      if (offset === bytes.length) return controller.close();
      const end = Math.min(offset + 64 * 1024, bytes.length);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
  });
}

export const serve = httpAction(async (ctx, request) => {
  // Convex sends HEAD to the GET handler, but discards its response body.
  if (request.method !== 'GET')
    return new Response(null, { status: 405, headers: { ...noStore, Allow: 'GET' } });
  const params = new URL(request.url).searchParams;
  const projectId = params.get('projectId');
  const itemId = params.get('itemId');
  const commentId = params.get('commentId');
  const attachmentId = params.get('attachmentId');
  if (!projectId || !itemId || !commentId || !attachmentId)
    return unavailable('BAD_ARGUMENT', 'Select the project, Item, comment and attachment.', 400);
  const selection = { projectId, itemId, commentId, attachmentId };
  try {
    const pin = await ctx.runQuery(internal.discussionAttachmentRead.resolve, selection);
    if (!pin) return missing();
    let bytes;
    try {
      bytes = await readBytes(pin);
    } catch (error) {
      return error instanceof ForgeError && error.code === 'BLOB_DIGEST_MISMATCH'
        ? unavailable('BLOB_DIGEST_MISMATCH', 'Stored attachment bytes failed verification.', 502)
        : unavailable('R2_OBJECT_UNAVAILABLE', 'Stored attachment bytes are unavailable.', 502);
    }
    // An access revocation or binding removal during the network read must win.
    const current = await ctx.runQuery(internal.discussionAttachmentRead.resolve, selection);
    if (!current || current.r2Key !== pin.r2Key || current.digest !== pin.digest || current.size !== pin.size)
      return missing();
    return new Response(downloadBody(bytes), {
      headers: {
        ...noStore,
        'Content-Type': current.contentType,
        'Content-Length': String(current.size),
        'Content-Disposition': 'attachment',
        'Content-Security-Policy': 'sandbox',
      },
    });
  } catch (error) {
    if (error instanceof ConvexError) {
      const data = error.data as { code?: string } | null;
      if (data?.code === 'PROJECT_UNAVAILABLE')
        return unavailable(data.code, 'This discussion is unavailable with the current account.', 404);
      if (data?.code === 'AUTH_REVOKED' || data?.code === 'AUTH_REQUIRED')
        return unavailable(data.code, 'This sign-in is unavailable.', 401);
      if (data?.code === 'AUTH_SCOPE_DENIED')
        return unavailable(data.code, 'This credential cannot read this discussion.', 403);
    }
    return unavailable('HOSTED_REQUEST_FAILED', 'Forge could not read this discussion attachment.', 500);
  }
});
