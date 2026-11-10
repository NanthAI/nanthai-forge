// SPDX-License-Identifier: Apache-2.0
import { networkFetch } from './network-fetch.js';
import { actionsPreflightTicketSchema, type ActionsPreflightTicket } from './hosted-actions-preflight.js';
import type { HostedCheckRun } from './hosted-check.js';
import type { SourceWorkerTransport } from './hosted-source-worker-reader.js';
import { sourcePackDownloadSchema, type SourcePackDownload } from './source-pack.js';
import { digest } from './hash.js';
import { objectRecipeSchema, objectChunkPageSchema } from './object-chunks.js';
import { ForgeError, invariant } from './errors.js';
import { packHeaders, verifyPackRange, type PackRange } from './object-pack-range.js';
import type { z } from 'zod';
import type { directCommandSchema } from './hosted-actions-direct.js';
import {
  actionsCommandForCapabilities,
  actionsRefusalReasons,
  actionsPreflightCapability,
} from './hosted-actions-capabilities.js';
import {
  retryActionsInfrastructure,
  actionsInfrastructureResponse,
  actionsDeliveryDeadlineMs,
  actionsDeliveryPolicy,
} from './hosted-actions-retry.js';
import { parseTimingHistory, timingDurations } from '../scripts/test-shards.mjs';
/** The Actions job tokens the supervisor's environment holds: OIDC requests and the cache/artifact service. */
export const runnerTokenNames = ['ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_RUNTIME_TOKEN'] as const;
export class ActionsJobClient {
  run: HostedCheckRun | null = null;
  timings: Record<string, number> = {};
  capabilities: string[] = [];
  sourcePack: SourcePackDownload | null = null;
  preflightTicket: ActionsPreflightTicket | null = null;
  proofTicket: ActionsPreflightTicket | null = null;
  /** Shard pool claim targets from the plan bundle (unvalidated until used). */
  poolClaims: unknown = null;
  private token = '';
  private expires = 0;
  private oidcRequest: { url: string | undefined; token: string | undefined } | null = null;
  private refreshing: Promise<void> | null = null;
  constructor(
    readonly site: string,
    readonly projectId: string,
    readonly runId: string,
    readonly request = networkFetch,
  ) {}
  async call(command: z.infer<typeof directCommandSchema>) {
    // Session/source are reads; plan is digest-CAS; output is create-only;
    // result is deduped by run/index/digest; sourcePack uses its immutable key.
    const body = JSON.stringify({
      projectId: this.projectId,
      runId: this.runId,
      ...(this.run ? { fence: this.run.fence } : {}),
      command: actionsCommandForCapabilities(command, this.capabilities),
    });
    // A finished check's output and result outlast a write outage (72d50375).
    const delivery = command.kind === 'result' || command.kind === 'output';
    const { response, value } = await retryActionsInfrastructure(
      async signal => {
        // Per attempt: a long delivery window outlives one OIDC token.
        if (this.expires < Date.now() + 30_000) {
          this.refreshing ??= this.refreshToken().finally(() => {
            this.refreshing = null;
          });
          await this.refreshing;
        }
        const response = await actionsInfrastructureResponse(
          await this.request(`${this.site}/checks/actions`, {
            method: 'POST',
            redirect: 'error',
            signal,
            headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
            body,
          }),
        );
        if (!response.ok) {
          // Only a fixed reason vocabulary may reach logs; never echo a response body.
          const body = (await response.json().catch(() => null)) as { reason?: unknown } | null;
          const reason = actionsRefusalReasons.find(value => value === body?.reason);
          throw Object.assign(
            new ForgeError(
              reason === 'cancelled'
                ? 'CHECK_CANCELLED'
                : reason === 'limit'
                  ? 'CONVEX_VALUE_LIMIT'
                  : 'RUNNER_UNAVAILABLE',
              `Convex Actions request failed (${response.status}${reason ? `; reason: ${reason}` : ''}).`,
            ),
            // Callers tell a request Forge refused as invalid (deterministic) from an unavailable runner.
            { refusal: reason ?? null },
          );
        }
        return { response, value: await response.json() };
      },
      60_000,
      delivery ? actionsDeliveryDeadlineMs : undefined,
      delivery ? actionsDeliveryPolicy : undefined,
    );
    if (
      command.kind === 'session' &&
      Array.isArray(value.capabilities) &&
      value.capabilities.includes(actionsPreflightCapability)
    ) {
      let raw: unknown;
      try {
        raw = JSON.parse(response.headers.get('X-Forge-Actions-Preflight') ?? 'null');
      } catch {
        raw = null;
      }
      const ticket = actionsPreflightTicketSchema.safeParse(raw);
      invariant(ticket.success, 'RUNNER_UNAVAILABLE', 'Pre-spawn authorization is unavailable.');
      this.preflightTicket = ticket.data;
    }
    if (command.kind === 'plan' && this.run?.proofOnLanding) {
      this.proofTicket = null;
      try {
        const ticket = actionsPreflightTicketSchema.safeParse(
          JSON.parse(response.headers.get('X-Forge-Landing-Proof') ?? 'null'),
        );
        this.proofTicket = ticket.success ? ticket.data : null;
      } catch {
        // Optional evidence must never fail the required planning job.
      }
    }
    return value;
  }
  /**
   * Keeps the runner's OIDC request credentials in this client and removes the job's tokens from
   * the supervisor's own environment, so nothing started later inherits or reads them from it
   * (Issue 3b67363d). Defence in depth only: separating project code from the supervisor is the
   * Candidate user's job (src/candidate-user.ts). Idempotent; the first token use calls it too.
   */
  holdRunnerTokens() {
    this.oidcRequest ??= {
      url: process.env.ACTIONS_ID_TOKEN_REQUEST_URL,
      token: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    };
    for (const name of runnerTokenNames) delete process.env[name];
    return this.oidcRequest;
  }
  private async refreshToken() {
    const oidc = this.holdRunnerTokens();
    const url = new URL(oidc.url!);
    url.searchParams.set('audience', this.site);
    const result = await retryActionsInfrastructure(async signal => {
      const response = await actionsInfrastructureResponse(
        await this.request(url, {
          headers: { authorization: `Bearer ${oidc.token}` },
          signal,
          redirect: 'error',
        }),
      );
      invariant(response.ok, 'RUNNER_UNAVAILABLE', 'GitHub OIDC token request failed.');
      return (await response.json()) as { value: string };
    }, 20_000);
    this.token = result.value;
    this.expires =
      (JSON.parse(Buffer.from(this.token.split('.')[1]!, 'base64url').toString()).exp as number) * 1000;
  }
  async session(timings = false) {
    // Bootstrap with the oldest request, even when timing history is desired.
    const { capabilities, ...run } = (await this.call({ kind: 'session' })) as HostedCheckRun & {
      capabilities?: string[];
    };
    invariant(
      !run.cancelRequested && run.status !== 'cancelled',
      'CHECK_CANCELLED',
      'The check was cancelled.',
    );
    this.run = run as HostedCheckRun;
    this.capabilities = Array.isArray(capabilities)
      ? capabilities.filter(value => typeof value === 'string')
      : [];
    this.timings = {};
    this.sourcePack = null;
    if (timings && this.capabilities.includes('session.timingHistory')) {
      const result = (await this.call({ kind: 'session', timings: true })) as {
        run: HostedCheckRun;
        timingHistory: string;
        sourcePack?: SourcePackDownload;
      };
      this.run = result.run;
      if (this.capabilities.includes('sourcePack')) {
        const pack = sourcePackDownloadSchema.safeParse(result.sourcePack);
        this.sourcePack = pack.success ? pack.data : null;
      }
      this.timings = timingDurations(parseTimingHistory(result.timingHistory));
    }
    return this.run;
  }
  async preflight() {
    // If bootstrap is already needed here, its live session is the pre-spawn check.
    if (!this.run) return this.session();
    const run = this.run;
    invariant(
      !run.cancelRequested && run.status !== 'cancelled',
      'CHECK_CANCELLED',
      'The check was cancelled.',
    );
    if (!this.capabilities.includes(actionsPreflightCapability)) return run; // oldest server
    const ticket = actionsPreflightTicketSchema.safeParse(this.preflightTicket);
    invariant(ticket.success, 'RUNNER_UNAVAILABLE', 'Pre-spawn authorization is unavailable.');
    const reply = await retryActionsInfrastructure(async signal => {
      const response = await actionsInfrastructureResponse(
        await this.request(`${ticket.data.endpoint}/api/query`, {
          method: 'POST',
          redirect: 'error',
          signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            path: 'projectHostedActionsPreflight:check',
            format: 'convex_encoded_json',
            args: [
              {
                projectId: this.projectId,
                runId: this.runId,
                fence: run.fence,
                signature: ticket.data.signature,
              },
            ],
          }),
        }),
      );
      const reply = (await response.json().catch(error => {
        if (error instanceof SyntaxError) return null;
        throw error;
      })) as {
        status?: string;
        value?: { status?: string };
      } | null;
      invariant(
        response.ok &&
          reply?.status === 'success' &&
          ['active', 'cancelled'].includes(reply.value?.status ?? ''),
        'RUNNER_UNAVAILABLE',
        'Pre-spawn authorization failed.',
      );
      return reply;
    });
    invariant(reply.value?.status !== 'cancelled', 'CHECK_CANCELLED', 'The check was cancelled.');
    return run;
  }
  transport() {
    const rows = new Map<
      string,
      {
        descriptor: {
          object: { sha256: string; size: number };
          recipe: { sha256: string; size: number } | null;
        };
        url: string | null;
        range?: PackRange;
      }
    >();
    const pending = new Map<string, Promise<void>>();
    const resolve = async (digests: string[]) => {
      const unique = [...new Set(digests)],
        waiting = unique.flatMap(id => (pending.has(id) ? [pending.get(id)!] : [])),
        missing = unique.filter(id => !rows.has(id) && !pending.has(id));
      const request = (async () => {
        for (let start = 0; start < missing.length; start += 400) {
          const page = missing.slice(start, start + 400);
          const found = (await this.call({ kind: 'source', digests: page })) as (typeof rows extends Map<
            string,
            infer T
          >
            ? T
            : never)[];
          invariant(
            found.length === page.length,
            'SOURCE_HASH_MISMATCH',
            'Source descriptor window is incomplete.',
          );
          found.forEach((row, index) => {
            invariant(
              row.descriptor.object.sha256 === page[index],
              'SOURCE_HASH_MISMATCH',
              'Source descriptor changed.',
            );
            rows.set(page[index]!, row);
          });
        }
      })();
      for (const id of missing) pending.set(id, request);
      try {
        const results = await Promise.allSettled([request, ...waiting]);
        for (const result of results) if (result.status === 'rejected') throw result.reason;
      } finally {
        for (const id of missing) pending.delete(id);
      }
    };
    const transport: SourceWorkerTransport = {
      describeBatch: async digests => {
        await resolve(digests);
        return digests.map(id => rows.get(id)!.descriptor);
      },
      read: async pin => {
        await resolve([pin.sha256]);
        const row = rows.get(pin.sha256)!;
        invariant(
          row.url && row.descriptor.object.size === pin.size,
          'SOURCE_UNAVAILABLE',
          'Exact raw source location is unavailable.',
        );
        const stream = new TransformStream<Uint8Array, Uint8Array>();
        const writer = stream.writable.getWriter();
        let offset = 0;
        void retryActionsInfrastructure(async signal => {
          if (offset === pin.size && offset > 0) return;
          const range = offset
            ? { offset: (row.range?.offset ?? 0) + offset, total: row.range?.total ?? pin.size }
            : row.range;
          const response = await actionsInfrastructureResponse(
            await this.request(row.url!, {
              headers: packHeaders(range, pin.size - offset),
              signal,
              redirect: 'error',
            }),
          );
          invariant(response.ok && response.body, 'SOURCE_UNAVAILABLE', 'Source download failed.');
          verifyPackRange(response, range, pin.size - offset);
          for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
            invariant(offset + chunk.length <= pin.size, 'SOURCE_HASH_MISMATCH', 'Source exceeds its pin.');
            await writer.write(chunk);
            offset += chunk.length;
          }
          invariant(offset === pin.size, 'SOURCE_HASH_MISMATCH', 'Source download is incomplete.');
        })
          .then(
            () => writer.close(),
            error => writer.abort(error),
          )
          .catch(() => {});
        return stream.readable as unknown as AsyncIterable<Uint8Array>;
      },
      upload: async () => {
        throw new Error('Source upload is not part of an Actions check.');
      },
    };
    const prepareRecipes = async (digests: string[]) => {
      await resolve(digests);
      const metadata = async (pin: { sha256: string; size: number }) => {
        invariant(pin.size <= 2 * 1024 * 1024, 'SOURCE_PAGE_INVALID', 'Recipe metadata must be paged.');
        const row = rows.get(pin.sha256)!;
        invariant(row.url, 'SOURCE_UNAVAILABLE', 'Recipe metadata needs raw storage.');
        return retryActionsInfrastructure(async signal => {
          const response = await actionsInfrastructureResponse(
            await this.request(row.url!, {
              headers: packHeaders(row.range, pin.size),
              redirect: 'error',
              signal,
            }),
          );
          invariant(response.ok, 'SOURCE_UNAVAILABLE', 'Recipe metadata download failed.');
          verifyPackRange(response, row.range, pin.size);
          invariant(response.body, 'SOURCE_UNAVAILABLE', 'Recipe metadata is unavailable.');
          const buffers: Uint8Array[] = [];
          let size = 0;
          for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
            size += chunk.length;
            invariant(size <= pin.size, 'SOURCE_HASH_MISMATCH', 'Recipe metadata exceeds its pinned size.');
            buffers.push(chunk);
          }
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const chunk of buffers) {
            bytes.set(chunk, offset);
            offset += chunk.length;
          }
          invariant(
            bytes.length === pin.size && digest(bytes) === pin.sha256,
            'SOURCE_HASH_MISMATCH',
            'Recipe metadata bytes changed.',
          );
          return JSON.parse(new TextDecoder().decode(bytes));
        });
      };
      const recipes = digests.flatMap(id =>
        rows.get(id)!.descriptor.recipe ? [rows.get(id)!.descriptor.recipe!] : [],
      );
      await resolve(recipes.map(pin => pin.sha256));
      const frontier = [] as { sha256: string; size: number; height: number }[];
      for (const pin of recipes) frontier.push(objectRecipeSchema.parse(await metadata(pin)).tree);
      const seen = new Set<string>();
      while (frontier.length) {
        const page = frontier.splice(0, 400).filter(pin => !seen.has(pin.sha256));
        await resolve(page.map(pin => pin.sha256));
        for (const pin of page) {
          seen.add(pin.sha256);
          if (pin.height) frontier.push(...objectChunkPageSchema.parse(await metadata(pin)).children);
        }
      }
    };
    return { transport, resolve, prepareRecipes };
  }
}
