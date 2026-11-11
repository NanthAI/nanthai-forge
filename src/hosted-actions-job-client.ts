// SPDX-License-Identifier: Apache-2.0
import { expandSourceGrants } from './source-grant-wire.js';
import {
  rowsFromPhysicalRuns,
  type StateSourceRow,
  type StateSourceReply,
} from './hosted-actions-state-source.js';
import type { PhysicalGrantPlan, SignedPhysicalRun } from './physical-manifest-download.js';
import { actionsSourceStateCapability } from './hosted-actions-capabilities.js';
import { mapSourceOrdered } from './hosted-source-parallel.js';
import type { ResultBatchTargets } from './hosted-actions-result-batch.js';
import { networkFetch } from './network-fetch.js';
import { actionsPreflightTicketSchema, type ActionsPreflightTicket } from './hosted-actions-preflight.js';
import type { HostedCheckRun } from './hosted-check.js';
import type { SourceWorkerTransport } from './hosted-source-worker-reader.js';
import { sourcePackDownloadSchema, type SourcePackDownload } from './source-pack.js';
import { digest } from './hash.js';
import { objectRecipeSchema, objectChunkPageSchema } from './object-chunks.js';
import { ForgeError, invariant } from './errors.js';
import { packHeaders, verifyPackRange } from './object-pack-range.js';
import type { z } from 'zod';
import { directSourceWindow, directSourceBatch, type directCommandSchema } from './hosted-actions-direct.js';
import {
  actionsCommandForCapabilities,
  actionsRefusalReasons,
  actionsPreflightCapability,
  actionsSourceBatchCapability,
} from './hosted-actions-capabilities.js';
import {
  retryActionsInfrastructure,
  actionsInfrastructureResponse,
  actionsDeliveryDeadlineMs,
  actionsDeliveryPolicy,
} from './hosted-actions-retry.js';
import { parseTimingHistory, timingDurations } from '../scripts/test-shards.mjs';
import { createReadStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readCompleteRuns } from './hosted-checkout-runs.js';
import type { exchangeRequest } from './exchange-request.js';
import { SourceWorkerReader } from './hosted-source-worker-reader.js';
import type { SignedDownload } from './blob-download-format.js';
import {
  actionsSourceClosureCapability,
  actionsSourceRunsCapability,
} from './hosted-actions-capabilities.js';
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
  resultBatch: ResultBatchTargets | null = null;
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
    const delivery = command.kind === 'result' || command.kind === 'results' || command.kind === 'output';
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
          const body = (await response.json().catch(() => null)) as {
            reason?: unknown;
            code?: unknown;
          } | null;
          const reason = actionsRefusalReasons.find(value => value === body?.reason);
          throw Object.assign(
            new ForgeError(
              body?.code === 'SOURCE_UNAVAILABLE' || body?.code === 'CLI_UPGRADE_REQUIRED'
                ? body.code
                : reason === 'cancelled'
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
    return command.kind === 'source' ? expandSourceGrants(value) : value;
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
  get sourceWindow() {
    return this.capabilities.includes(actionsSourceBatchCapability) ? directSourceBatch : directSourceWindow;
  }
  transport(cache?: string) {
    const rows = new Map<string, StateSourceRow>();
    const bound = new Map<string, { sha256: string; size: number }>();
    let selectedState: string | null = null;
    const recipeOwners = new Map<string, string>(),
      authorizedStates = new Set<string>();
    let sourcePage = 0;
    const runFiles = new Map<string, string>();
    const signedLeaves = new Map<string, NonNullable<ReturnType<typeof rows.get>>>();
    const pending = new Map<string, Promise<void>>();
    const resolve = async (
      digests: string[],
      oneWindow = false,
      runs = false,
      states = false,
    ): Promise<number> => {
      const unique = [...new Set(digests)],
        waiting = unique.flatMap(id => (pending.has(id) ? [pending.get(id)!] : [])),
        missing = unique.filter(id => !rows.has(id) && !pending.has(id));
      const request = (async () => {
        for (let start = 0; start < missing.length;) {
          const owner = recipeOwners.get(missing[start]!);
          let page = missing.slice(start, start + this.sourceWindow);
          if (owner) {
            const other = page.findIndex(id => recipeOwners.get(id) !== owner);
            if (other >= 0) page = page.slice(0, other);
          }
          const stateRead = states;
          const batch = this.capabilities.includes(actionsSourceBatchCapability);
          const found = (await this.call({
            kind: 'source',
            digests: page,
            ...(owner
              ? { state: selectedState ?? owner, object: owner }
              : selectedState && !stateRead
                ? { state: selectedState }
                : this.capabilities.includes(actionsSourceStateCapability) && stateRead
                  ? { bound: true }
                  : {}),
            ...(batch ? { batch: true } : {}),
            ...(runs && batch && cache && this.capabilities.includes(actionsSourceRunsCapability)
              ? { runs: true }
              : {}),
            ...(batch && cache && this.capabilities.includes(actionsSourceClosureCapability)
              ? { closures: true }
              : {}),
          })) as
            | StateSourceRow[]
            | {
                rows: StateSourceRow[];
                physical?: { state: string; pin: { sha256: string; size: number } };
                plan?: PhysicalGrantPlan;
                extraStates?: StateSourceRow[];
              };
          const envelope = Array.isArray(found) ? null : found;
          if (envelope?.physical) bound.set(envelope.physical.state, envelope.physical.pin);
          const values = Array.isArray(found) ? found : found.rows;
          invariant(
            values.length > 0 && (batch ? values.length <= page.length : values.length === page.length),
            'SOURCE_HASH_MISMATCH',
            'Source descriptor window is incomplete.',
          );
          const pageKey = sourcePage++;
          [...values, ...(envelope?.extraStates ?? [])].forEach((row, index) => {
            invariant(
              index >= values.length || row.descriptor.object.sha256 === page[index],
              'SOURCE_HASH_MISMATCH',
              'Source descriptor changed.',
            );
            if (row.run) row.run = { ...row.run, key: `${pageKey}:${row.run.id}` };
            rows.set(row.descriptor.object.sha256, row);
            if (states) {
              authorizedStates.add(row.descriptor.object.sha256);
              if (row.statePhysical) bound.set(row.descriptor.object.sha256, row.statePhysical);
            }
            if (row.closure && cache) {
              invariant(
                row.descriptor.recipe &&
                  row.closure.length > 0 &&
                  row.closure.length <= 100 &&
                  row.closure.every(
                    leaf =>
                      /^[a-f0-9]{64}$/.test(leaf.digest) &&
                      Number.isSafeInteger(leaf.size) &&
                      leaf.size >= 0 &&
                      leaf.size <= 1024 * 1024,
                  ) &&
                  row.closure.reduce((n, leaf) => n + leaf.size, 0) === row.descriptor.object.size,
                'SOURCE_HASH_MISMATCH',
                'Recipe closure differs from its logical content.',
              );
              for (const leaf of row.closure) {
                const prior = rows.get(leaf.digest);
                invariant(
                  !prior || prior.descriptor.object.size === leaf.size,
                  'SOURCE_HASH_MISMATCH',
                  'Recipe leaf size changed.',
                );
                const signed = {
                  descriptor: { object: { sha256: leaf.digest, size: leaf.size }, recipe: null },
                  url: leaf.url,
                  ...(leaf.range ? { range: leaf.range } : {}),
                };
                signedLeaves.set(leaf.digest, signed);
                if (!prior) rows.set(leaf.digest, signed);
              }
            }
          });
          start += values.length;
          if (oneWindow) break;
        }
      })();
      for (const id of missing) pending.set(id, request);
      try {
        const results = await Promise.allSettled([request, ...waiting]);
        for (const result of results) if (result.status === 'rejected') throw result.reason;
      } finally {
        for (const id of missing) pending.delete(id);
      }
      const missingAt = unique.findIndex(id => !rows.has(id));
      // A concurrent single-window request may have returned only a prefix.
      // Full readers reconcile the remainder after that shared request settles.
      if (!oneWindow && missingAt >= 0) return resolve(unique, false, runs, states);
      return missingAt < 0 ? unique.length : missingAt;
    };
    const readRaw = async (
      pin: { sha256: string; size: number },
      row: NonNullable<ReturnType<typeof rows.get>>,
    ): Promise<AsyncIterable<Uint8Array>> => {
      if (!row.url && row.run) {
        // A partial or expired run retains the existing exact-object path. A run
        // URL cannot sign a member range, so request one fresh singleton grant.
        const reply = await this.call({
          kind: 'source',
          digests: [pin.sha256],
          ...(selectedState ? { state: selectedState } : {}),
        });
        const [single] = Array.isArray(reply) ? reply : reply.rows;
        invariant(
          single?.descriptor.object.sha256 === pin.sha256,
          'SOURCE_HASH_MISMATCH',
          'Source descriptor changed.',
        );
        row = single;
        rows.set(pin.sha256, row);
      }
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
    };
    let leaves: SourceWorkerReader | undefined;
    const leafReads = new Map<string, Promise<string>>();
    const transport: SourceWorkerTransport = {
      describeBatch: async digests => {
        await resolve(digests);
        return digests.map(id => {
          const row = rows.get(id)!;
          return cache && row.closure ? { object: row.descriptor.object, recipe: null } : row.descriptor;
        });
      },
      read: async pin => {
        await resolve([pin.sha256]);
        const row = rows.get(pin.sha256)!;
        const staged = runFiles.get(pin.sha256);
        if (staged)
          return (async function* () {
            try {
              yield* createReadStream(staged);
            } finally {
              runFiles.delete(pin.sha256);
              await rm(staged, { force: true });
            }
          })();
        if (cache && row.closure) {
          invariant(
            row.descriptor.object.size === pin.size,
            'SOURCE_HASH_MISMATCH',
            'Recipe object size changed.',
          );
          leaves ??= new SourceWorkerReader(cache, {
            read: async pin => {
              const leaf = signedLeaves.get(pin.sha256);
              invariant(leaf, 'SOURCE_UNAVAILABLE', 'Recipe leaf grant is unavailable.');
              return readRaw(pin, leaf);
            },
            upload: transport.upload,
          });
          const reader = leaves,
            closure = row.closure;
          const readLeaf = (leaf: SignedDownload) => {
            let read = leafReads.get(leaf.digest);
            if (!read) {
              read = reader
                .file({ object: { sha256: leaf.digest, size: leaf.size }, recipe: null })
                .finally(() => leafReads.delete(leaf.digest));
              leafReads.set(leaf.digest, read);
            }
            return read;
          };
          const unique = [...new Map(closure.map(leaf => [leaf.digest, leaf])).values()];
          // Use the existing disk cache and download-worker bound. Cold leaves
          // share a byte-bounded request wave instead of one RTT per leaf.
          for (let at = 0; at < unique.length;) {
            let end = at,
              bytes = 0;
            while (
              end < unique.length &&
              end - at < 16 &&
              (!bytes || bytes + unique[end]!.size <= 4 * 1024 * 1024)
            )
              bytes += unique[end++]!.size;
            await mapSourceOrdered(unique.slice(at, end), readLeaf, 16);
            at = end;
          }
          return (async function* () {
            for (const leaf of closure) yield* createReadStream(await readLeaf(leaf));
          })();
        }
        return readRaw(pin, row);
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
      const recipes = digests.flatMap(id => {
        const recipe = rows.get(id)!.descriptor.recipe;
        if (!recipe || (cache && rows.get(id)!.closure)) return [];
        if (
          this.capabilities.includes(actionsSourceStateCapability) &&
          (selectedState || authorizedStates.has(id))
        )
          recipeOwners.set(recipe.sha256, id);
        return [recipe];
      });
      await resolve(recipes.map(pin => pin.sha256));
      const frontier = [] as { sha256: string; size: number; height: number }[];
      for (const pin of recipes) {
        const tree = objectRecipeSchema.parse(await metadata(pin)).tree;
        const owner = recipeOwners.get(pin.sha256);
        if (owner) recipeOwners.set(tree.sha256, owner);
        frontier.push(tree);
      }
      const seen = new Set<string>();
      while (frontier.length) {
        const page = frontier.splice(0, 400).filter(pin => !seen.has(pin.sha256));
        await resolve(page.map(pin => pin.sha256));
        for (const pin of page) {
          seen.add(pin.sha256);
          if (pin.height) {
            const children = objectChunkPageSchema.parse(await metadata(pin)).children;
            const owner = recipeOwners.get(pin.sha256);
            if (owner) for (const child of children) recipeOwners.set(child.sha256, owner);
            frontier.push(...children);
          }
        }
      }
    };
    const prepareRuns = async (digests: string[]) => {
      if (!cache || !this.capabilities.includes(actionsSourceRunsCapability)) return;
      const files = digests.flatMap(id => {
        const row = rows.get(id);
        return row?.run && !runFiles.has(id)
          ? [{ pin: row.descriptor.object, path: join(cache, randomUUID()) }]
          : [];
      });
      if (!files.length) return;
      await mkdir(cache, { recursive: true });
      const request: typeof exchangeRequest = async (_call, url, init, consume) =>
        retryActionsInfrastructure(async signal =>
          consume(
            await actionsInfrastructureResponse(await this.request(url, { ...init, signal })),
            () => {},
          ),
        );
      try {
        const read = await readCompleteRuns(files, rows, request);
        for (const file of files) if (read.has(file.pin.sha256)) runFiles.set(file.pin.sha256, file.path);
      } catch (error) {
        // The shared scheduler drains all active runs before it rejects.
        await Promise.all(files.map(file => rm(file.path, { force: true })));
        throw error;
      }
    };
    const clientCall = (command: z.infer<typeof directCommandSchema>) =>
      this.call(command) as Promise<StateSourceReply>;
    const clientRequest = this.request;
    return {
      transport,
      resolveHeads: (ids: string[]) => resolve(ids, false, false, true),
      async selectState(state: string, all: boolean) {
        if (selectedState !== state) {
          for (const id of rows.keys()) if (!authorizedStates.has(id)) rows.delete(id);
          for (const [id, owner] of recipeOwners) if (!authorizedStates.has(owner)) recipeOwners.delete(id);
          for (const id of signedLeaves.keys()) if (!rows.has(id)) signedLeaves.delete(id);
          // Re-register State closure leaves after dropping the previous State's file bindings.
          for (const row of rows.values())
            for (const leaf of row.closure ?? []) {
              const signed = {
                descriptor: { object: { sha256: leaf.digest, size: leaf.size }, recipe: null },
                url: leaf.url,
                ...(leaf.range ? { range: leaf.range } : {}),
              };
              signedLeaves.set(leaf.digest, signed);
              rows.set(leaf.digest, signed);
            }
        }
        if (!bound.has(state)) {
          selectedState = null;
          return false;
        }
        selectedState = state;
        if (!all) return false;
        let reply = await clientCall({ kind: 'source', digests: [state], state, all: true, batch: true });
        if (reply.mode === 'runs') {
          try {
            const plan = reply.plan as PhysicalGrantPlan,
              pin = bound.get(state)!;
            invariant(
              plan && plan.state === state && plan.pin.sha256 === pin.sha256 && plan.pin.size === pin.size,
              'SOURCE_HASH_MISMATCH',
              'State manifest plan is unavailable.',
            );
            await rowsFromPhysicalRuns(
              plan,
              reply.runs as SignedPhysicalRun[],
              clientRequest,
              (id, row) => rows.set(id, row),
              `manifest-${sourcePage++}`,
            );
            console.log('source: State-bound physical manifest runs');
            return true;
          } catch {
            console.log('source: catalog fallback (physical manifest transfer invalid or unavailable)');
            reply = await clientCall({
              kind: 'source',
              digests: [state],
              state,
              all: true,
              batch: true,
              fallback: true,
            });
          }
        }
        invariant(reply.mode !== 'runs', 'SOURCE_HASH_MISMATCH', 'Catalog fallback reply changed.');
        const prefix = reply.digests;
        console.log('source: one-time windowed fallback; check publishes source pack');
        (reply.rows as StateSourceRow[]).forEach((row, index) => {
          invariant(
            row.descriptor.object.sha256 === prefix[index],
            'SOURCE_HASH_MISMATCH',
            'State source prefix changed.',
          );
          if (row.run) row.run = { ...row.run, key: `fallback-${sourcePage}:${row.run.id}` };
          rows.set(row.descriptor.object.sha256, row);
        });
        sourcePage++;
        return false;
      },
      resolve,
      prepareRuns,
      resolveWindow: (digests: string[]) => resolve(digests, true, true),
      prepareRecipes,
      resetCache: () => {
        leaves = undefined;
        leafReads.clear();
        runFiles.clear();
      },
    };
  }
}
