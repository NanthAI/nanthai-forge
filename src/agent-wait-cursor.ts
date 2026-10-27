// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { digest } from './hash.js';
import { invariant } from './errors.js';

const schema = z.object({
  version: z.literal(1),
  scope: z.string(),
  seen: z.array(z.tuple([z.string(), z.string()])),
});
/** Client-carried deduplication only. Every reconnect rereads the authoritative records. */
export class WaitCursor {
  readonly seen = new Map<string, string>();
  private readonly scope: string;
  constructor(directory: string, targets: { kind: string; id: string }[], cursor?: string | null) {
    this.scope = digest(JSON.stringify([directory, targets.map(t => `${t.kind}:${t.id}`).sort()]));
    if (cursor == null) return;
    let raw: unknown;
    try {
      raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    } catch {
      raw = undefined;
    }
    const parsed = schema.safeParse(raw);
    invariant(
      parsed.success && parsed.data.scope === this.scope,
      'BAD_ARGUMENT',
      'Use a wait cursor from the same owner and Lane/operation selection.',
    );
    for (const [key, hash] of parsed.data.seen) this.seen.set(key, hash);
  }
  encode() {
    return Buffer.from(JSON.stringify({ version: 1, scope: this.scope, seen: [...this.seen] })).toString(
      'base64url',
    );
  }
}
