// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

const position = z.tuple([z.string().regex(/^\d{1,19}$/), z.string().min(1).max(200).nullable()]);

export const encodeFeedPosition = (commit: bigint, id: string | null) =>
  btoa(JSON.stringify([String(commit), id]));

export function decodeFeedPosition(cursor: string) {
  if (cursor.length > 512) return undefined;
  try {
    const parsed = position.safeParse(JSON.parse(atob(cursor)));
    if (!parsed.success) return undefined;
    const [timestamp, id] = parsed.data;
    const commit = BigInt(timestamp);
    if (commit <= 2n ** 63n - 1n) return { commit, id };
  } catch {
    // Malformed cursor.
  }
}

export function laterFeedPosition(next: NonNullable<ReturnType<typeof decodeFeedPosition>>, after?: string) {
  const previous = after && decodeFeedPosition(after);
  return (
    !previous ||
    next.commit > previous.commit ||
    (next.commit === previous.commit && previous.id !== null && (next.id === null || next.id > previous.id))
  );
}
