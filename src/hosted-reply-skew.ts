// SPDX-License-Identifier: Apache-2.0
import { ForgeError } from './errors.js';
import { hostedContractFeatures } from './hosted-contract-features.js';
import type { ReplySkew } from './hosted-response.js';

/** Which side of a reply-contract mismatch is older (Issue 71ef0a66). The server advertises the
 * subset of this CLI's contract features its code implements, so a missing one means the server's
 * deploy is older than this CLI; with none missing, the server is the newer side. No call: it reads
 * the capability reply the command already made. */
export function replySkewSide(features: unknown): 'server-older' | 'cli-older' {
  const advertised = Array.isArray(features) ? features : [];
  return hostedContractFeatures.some(name => !advertised.includes(name)) ? 'server-older' : 'cli-older';
}
const sideText = {
  'server-older': 'this CLI is newer than the server, whose deploy has not reached it yet',
  'cli-older': 'the server is newer than this CLI; update it with `nforge update`',
} as const;

/** The receipt field a read reports when it read a reply only in part. */
export function contractSkew(skew: ReplySkew, side: ReturnType<typeof replySkewSide>) {
  return {
    ...skew,
    side,
    message: `The server reply differs from this CLI's contract at ${skew.paths.join(', ')} (${sideText[side]}). ${
      skew.stable
        ? 'The outcome was read from its stable fields; other fields are shown as sent.'
        : `Left out: ${skew.dropped.join(', ')}; the outcome is complete.`
    }`,
  };
}

/** The read still could not tell the outcome: say so, and how to check it without this read. */
export function replySkewError(
  what: string,
  paths: readonly string[],
  side: ReturnType<typeof replySkewSide>,
  check: { outcome: string; command: string },
) {
  return new ForgeError(
    'HOSTED_PROTOCOL_INVALID',
    `Hosted ${what} reply does not match this CLI's contract at ${paths.join(', ') || 'reply'} (${sideText[side]}). ${check.outcome} Check it with: ${check.command}`,
  );
}
