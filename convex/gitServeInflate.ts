// SPDX-License-Identifier: Apache-2.0
'use node';
import { gunzipSync } from 'node:zlib';
import { v } from 'convex/values';
import { internalAction } from './_generated/server';
import { ForgeError } from '../src/errors';

/** Git gzips request bodies over 1 KiB (fetches with many haves). The V8 runtime has no
 * DecompressionStream, so only those requests make this one extra call. */
export const gitRequestLimitBytes = 1024 * 1024;
export const gunzip = internalAction({
  args: { body: v.bytes() },
  returns: v.bytes(),
  handler: async (_ctx, { body }) => {
    try {
      const out = gunzipSync(Buffer.from(body), { maxOutputLength: gitRequestLimitBytes });
      return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
    } catch {
      throw new ForgeError('GIT_PROTOCOL', 'The Git request body is not valid gzip or is over 1 MiB.');
    }
  },
});
