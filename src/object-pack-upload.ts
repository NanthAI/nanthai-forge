// SPDX-License-Identifier: Apache-2.0
// Pure: also runs in the Convex non-Node runtime.
import { invariant } from './errors.js';
import { digest } from './state/hash.js';

/** Upload packs (feature upload-packs, Issue 98ee14e8): a client sends several new small objects
 * as one R2 object, in the GitHub import's pack format (members back to back, nothing between),
 * with one create-only PUT. `members` are indexes into the prepared pin list, ascending; their
 * bytes in that order are the pack. The server binds no member until its commit has read the pack
 * and checked every member digest, so a member never dedupes before it is verified. */
export type UploadPackProposal = { digest: string; size: number; members: number[] };
/** Bytes per client pack: one bounded buffer on the client, one bounded read in the commit. */
export const uploadPackMaxBytes = 8 * 1024 * 1024;
/** Members a client packs: source-sized objects. Larger raw objects keep their own checksum-bound
 * PUT, so a commit hashes only small members. */
export const uploadPackMemberMaxBytes = 256 * 1024;

/** The members a client packs from `pins`: the first occurrence of each non-empty digest of at
 * most `uploadPackMemberMaxBytes`, in order, within the pack's byte bound. Empty objects and later duplicates keep their own preparation.
 * Fewer than two members means no pack. */
export function uploadPackMembers(
  pins: readonly { sha256: string; size: number }[],
  maxBytes = uploadPackMaxBytes,
): number[] {
  const seen = new Set<string>(),
    members: number[] = [];
  let bytes = 0;
  for (const [index, pin] of pins.entries()) {
    if (
      pin.size <= 0 ||
      pin.size > uploadPackMemberMaxBytes ||
      seen.has(pin.sha256) ||
      bytes + pin.size > maxBytes
    )
      continue;
    seen.add(pin.sha256);
    members.push(index);
    bytes += pin.size;
  }
  return members.length > 1 ? members : [];
}

/** Read and check each member, then join them: the proposal and the exact bytes to PUT. */
export async function buildUploadPack(
  objects: readonly { pin: { sha256: string; size: number }; read: () => Uint8Array | Promise<Uint8Array> }[],
  members: readonly number[],
): Promise<{ proposal: UploadPackProposal; bytes: Uint8Array } | null> {
  if (members.length < 2) return null;
  const parts: Uint8Array[] = [];
  let size = 0;
  for (const index of members) {
    const object = objects[index]!,
      bytes = await object.read();
    invariant(
      bytes.length === object.pin.size && digest(bytes) === object.pin.sha256,
      'EXCHANGE_SOURCE_CHANGED',
      'Content differs from its original physical pin.',
    );
    parts.push(bytes);
    size += bytes.length;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return { proposal: { digest: digest(bytes), size, members: [...members] }, bytes };
}

/** Server check of a proposal against the pins it indexes; returns each member's pin and offset. */
export function uploadPackLayout(
  pins: readonly { digest: string; size: number }[],
  proposal: UploadPackProposal,
): { digest: string; size: number; offset: number }[] {
  const { members } = proposal;
  invariant(
    /^[0-9a-f]{64}$/.test(proposal.digest) &&
      Number.isSafeInteger(proposal.size) &&
      proposal.size > 0 &&
      proposal.size <= uploadPackMaxBytes &&
      members.length > 1 &&
      members.every(
        (index, i) =>
          Number.isInteger(index) &&
          index >= 0 &&
          index < pins.length &&
          (i === 0 || index > members[i - 1]!),
      ),
    'BAD_ARGUMENT',
    'Name an upload pack of at least two prepared objects within its byte bound.',
  );
  const layout: { digest: string; size: number; offset: number }[] = [],
    seen = new Set<string>();
  let offset = 0;
  for (const index of members) {
    const pin = pins[index]!;
    invariant(
      pin.size > 0 && !seen.has(pin.digest),
      'BAD_ARGUMENT',
      'Upload pack members are distinct, non-empty objects.',
    );
    seen.add(pin.digest);
    layout.push({ digest: pin.digest, size: pin.size, offset });
    offset += pin.size;
  }
  invariant(offset === proposal.size, 'BAD_ARGUMENT', 'Upload pack size differs from its members.');
  return layout;
}

/** The commit's member check over the pack bytes it read: every member's exact digest. */
export function uploadPackMismatch(
  bytes: Uint8Array,
  pack: { size: number; members: readonly { digest: string; size: number }[] },
): boolean {
  if (bytes.length !== pack.size) return true;
  let offset = 0;
  for (const member of pack.members) {
    if (digest(bytes.subarray(offset, offset + member.size)) !== member.digest) return true;
    offset += member.size;
  }
  return offset !== pack.size;
}
