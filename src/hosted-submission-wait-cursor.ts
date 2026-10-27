// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { WaitCursor } from './agent-wait-cursor.js';
import { invariant } from './errors.js';
import type { HostedAgentAddress } from './hosted-agent-contract.js';

const cursorSchema = z
  .object({
    schema: z.literal(1),
    scope: z.string(),
    versions: z.array(z.tuple([z.uuid(), z.number().int().nonnegative()])),
    seen: z.string(),
    authority: z.string(),
  })
  .strict();
/** Selection/actor/address scope is stable; authority changes resnapshot, never
 * transfer authority from this client-carried deduplication state. */
export class HostedSubmissionWaitCursor {
  readonly versions = new Map<string, number>();
  readonly seen: WaitCursor;
  authority = '';
  private readonly scope: string;
  constructor(address: HostedAgentAddress, actor: string, operations: string[], encoded?: string | null) {
    this.scope = JSON.stringify([address.url, address.projectId, actor, [...operations].sort()]);
    let parsed: z.infer<typeof cursorSchema> | undefined;
    if (encoded != null) {
      try {
        parsed = cursorSchema.parse(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')));
      } catch {
        invariant(
          false,
          'BAD_ARGUMENT',
          'Use a hosted wait cursor from the same project and operation selection.',
        );
      }
      invariant(
        parsed.scope === this.scope,
        'BAD_ARGUMENT',
        'Use a hosted wait cursor from the same project and operation selection.',
      );
      this.authority = parsed.authority;
      for (const [id, version] of parsed.versions) {
        invariant(operations.includes(id), 'BAD_ARGUMENT', 'Cursor contains an unselected operation.');
        this.versions.set(id, version);
      }
    }
    this.seen = new WaitCursor(
      this.scope,
      operations.map(id => ({ kind: 'operation', id })),
      parsed?.seen,
    );
  }
  encode() {
    return Buffer.from(
      JSON.stringify({
        schema: 1,
        scope: this.scope,
        authority: this.authority,
        versions: [...this.versions],
        seen: this.seen.encode(),
      }),
    ).toString('base64url');
  }
}
