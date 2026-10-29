// SPDX-License-Identifier: Apache-2.0
import type { HostedCheckRun } from './hosted-check.js';
import type { SourceWorkerTransport } from './hosted-source-worker-reader.js';
import { digest } from './hash.js';
import { objectRecipeSchema, objectChunkPageSchema } from './object-chunks.js';
import { invariant } from './errors.js';
export class ActionsJobClient {
  run: HostedCheckRun | null = null;
  private token = '';
  private expires = 0;
  constructor(
    readonly site: string,
    readonly projectId: string,
    readonly runId: string,
    private request = fetch,
  ) {}
  async call(command: unknown) {
    if (this.expires < Date.now() + 30_000) {
      const url = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL!);
      url.searchParams.set('audience', this.site);
      const response = await this.request(url, {
        headers: { authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
        signal: AbortSignal.timeout(20_000),
        redirect: 'error',
      });
      invariant(response.ok, 'RUNNER_UNAVAILABLE', 'GitHub OIDC token request failed.');
      const result = (await response.json()) as { value: string };
      this.token = result.value;
      this.expires =
        (JSON.parse(Buffer.from(this.token.split('.')[1]!, 'base64url').toString()).exp as number) * 1000;
    }
    const response = await this.request(`${this.site}/checks/actions`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: this.projectId,
        runId: this.runId,
        ...(this.run ? { fence: this.run.fence } : {}),
        command,
      }),
    });
    invariant(response.ok, 'RUNNER_UNAVAILABLE', `Convex Actions request failed (${response.status}).`);
    return response.json();
  }
  async session() {
    this.run = (await this.call({ kind: 'session' })) as HostedCheckRun;
    return this.run;
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
      }
    >();
    const resolve = async (digests: string[]) => {
      const missing = [...new Set(digests)].filter(id => !rows.has(id));
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
        const response = await this.request(row.url, {
          signal: AbortSignal.timeout(60_000),
          redirect: 'error',
        });
        invariant(response.ok && response.body, 'SOURCE_UNAVAILABLE', 'Source download failed.');
        return response.body as unknown as AsyncIterable<Uint8Array>;
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
        const response = await this.request(row.url, {
          redirect: 'error',
          signal: AbortSignal.timeout(60_000),
        });
        invariant(response.ok, 'SOURCE_UNAVAILABLE', 'Recipe metadata download failed.');
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
