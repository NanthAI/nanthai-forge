// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { canonicalPayload } from './hosted-source-operation.js';
import { readSourceControlReply } from './hosted-source-control-reply.js';
import { invariant } from './errors.js';
import type {
  SourceDispatch,
  SourceDispatchResult,
  SourceJobProvider,
  SourceLookup,
} from './hosted-source-job.js';

const replySchema = z
  .object({
    dispatchKey: z.string(),
    input: z.string(),
    result: z.discriminatedUnion('status', [
      z.object({ status: z.literal('accepted'), executionId: z.string().min(1) }).strict(),
      z.object({ status: z.literal('found'), executionId: z.string().min(1) }).strict(),
      z.object({ status: z.literal('empty'), authoritative: z.literal(true) }).strict(),
      z.object({ status: z.literal('rejected'), definitive: z.literal(true) }).strict(),
      z.object({ status: z.literal('unknown') }).strict(),
    ]),
  })
  .strict();
/** Fixed Modal source bridge, isolated from the project-check bridge/credentials.
 * The bridge must reserve dispatchKey durably before the Modal SDK create and
 * reconcile that same reservation on retries. An uncertain SDK create remains
 * unknown. No adapter-level paid retry, provider fallback, or completion wait. */
export class ModalSourceProvider implements SourceJobProvider {
  readonly id = 'modal';
  constructor(
    private readonly config: {
      endpoint: string;
      token: string;
      worker: string;
      runtime: string;
      timeoutMs: number;
      fetch?: typeof fetch;
    },
  ) {
    const url = new URL(config.endpoint);
    invariant(
      url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        config.token.length > 0 &&
        Number.isSafeInteger(config.timeoutMs) &&
        config.timeoutMs > 0,
      'SOURCE_WORKER_UNAVAILABLE',
      'Configure the fixed trusted Modal source bridge.',
    );
  }
  private async request(action: 'dispatch' | 'lookup', input: SourceDispatch) {
    invariant(
      input.provider === this.id &&
        input.worker === this.config.worker &&
        input.runtime === this.config.runtime,
      'SOURCE_PROVIDER_CHANGED',
      'The exact source-worker route and runtime must remain pinned.',
    );
    try {
      const response = await (this.config.fetch ?? fetch)(this.config.endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(this.config.timeoutMs),
        headers: { authorization: `Bearer ${this.config.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ action, input }),
      });
      // HTTP errors, including 4xx, do not attest that an earlier paid create failed.
      if (!response.ok) return { status: 'unknown' } as const;
      const reply = replySchema.parse(await readSourceControlReply(response));
      if (reply.dispatchKey !== input.dispatchKey || reply.input !== canonicalPayload(input))
        return { status: 'unknown' } as const;
      return reply.result;
    } catch {
      return { status: 'unknown' } as const;
    }
  }
  async dispatch(input: SourceDispatch): Promise<SourceDispatchResult> {
    const result = await this.request('dispatch', input);
    if (result.status === 'accepted') return result;
    if (result.status === 'rejected') return { status: 'rejected' };
    return { status: 'unknown' };
  }
  async lookup(input: SourceDispatch): Promise<SourceLookup> {
    const result = await this.request('lookup', input);
    return result.status === 'found' || result.status === 'empty' ? result : { status: 'unknown' };
  }
}
