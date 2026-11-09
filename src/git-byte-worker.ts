// SPDX-License-Identifier: Apache-2.0
/** Cloudflare Worker for Git packs over the Convex response limit (Issue 09367fb2;
 * docs/git-serving.md). Deployed as the compiled dist/git-byte-worker.js, so it imports
 * nothing. It forwards each Git request on a signed session path to the configured Forge
 * backend, which checks the token and current access on every request. When the backend
 * answers with a byte plan, the Worker streams the R2 objects it names from its bucket
 * binding by native piping: JavaScript never touches pack bytes, so a clone fits the
 * Workers Free CPU limit. The Worker holds no secret and reads only keys the backend
 * names (never one from the client), in the stored-object key space. It answers the Git
 * protocol v2 capability advertisement itself: that reply is fixed text with no repository
 * data, and every request that returns refs or bytes still goes to the backend, which
 * rechecks the session and current access (one backend round trip fewer per clone).
 * Git can also clone the Worker's own /git/<handle>/<slug>.git address (Issue ae7ceb1b):
 * the Worker answers the v2 advertisement and forwards the rest to the backend's direct
 * /git/ route, which checks the presented login and current access on every request as it
 * does for any client, and answers large fetches with byte plans. No redirect, no session. */

type Env = {
  /** The Forge backend's HTTP actions origin, for example https://NAME.convex.site. */
  FORGE_CONVEX_SITE: string;
  /** The backend's R2 bucket (read only). */
  FORGE_R2: {
    get(
      key: string,
      options?: { range?: { offset: number; length: number } },
    ): Promise<{ body: ReadableStream<Uint8Array> } | null>;
  };
};
type Context = { waitUntil(promise: Promise<unknown>): void };
type Part = { key: string; offset?: number; length?: number };
type Plan = { head: string; parts: Part[]; tail: string };

const planType = 'application/x-forge-git-byte-plan';
/** Workers Free allows 1,000 reads of Cloudflare services per request. */
const maxParts = 900;
const storedKey = /^v1\/p\/[A-Za-z0-9_-]{1,64}\/o\/[0-9a-f]{64}$/;
/** Request headers passed to the backend. `authorization` is the login git sends after a
 * listing that names a Lane answers 401 on an anonymous session (public projects); the backend
 * checks it like the direct route. */
const forwarded = [
  'content-type',
  'content-encoding',
  'accept',
  'git-protocol',
  'user-agent',
  'authorization',
];

/** Equal to advertiseV2() in src/git-serve-protocol.ts (tests/hosted-history.test.mjs). */
export const v2Advertisement = ['version 2', 'agent=forge/1', 'ls-refs', 'fetch', 'object-format=sha1']
  .map(line => `${(line.length + 5).toString(16).padStart(4, '0')}${line}\n`)
  .join('')
  .concat('0000');
const v2Request = /(^|[:\s])version=2($|[:\s])/;
/** Equal to workerViaHeader in src/git-worker-plan.ts (tests/hosted-history.test.mjs). It only
 * lets the direct route answer a large fetch with a byte plan; it grants no access. */
export const viaHeader = 'x-forge-git-worker';

const plain = (status: number, text: string) =>
  new Response(`${text}\n`, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
const decode = (text: string) => Uint8Array.from(atob(text), c => c.charCodeAt(0));

const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
/** A plan from the backend is still checked: bounded, stored-object keys, sane ranges. */
export function checkedPlan(value: unknown): Plan | null {
  const plan = value as Plan;
  if (!plan || typeof plan.head !== 'string' || typeof plan.tail !== 'string') return null;
  if (!Array.isArray(plan.parts) || plan.parts.length > maxParts) return null;
  for (const part of plan.parts) {
    if (typeof part?.key !== 'string' || !storedKey.test(part.key)) return null;
    const ranged = part.offset !== undefined || part.length !== undefined;
    if (ranged && !(count(part.offset) && count(part.length) && part.length! > 0)) return null;
  }
  return plan;
}

async function pump(plan: Plan, bucket: Env['FORGE_R2'], writable: WritableStream<Uint8Array>) {
  const write = async (bytes: Uint8Array) => {
    const writer = writable.getWriter();
    await writer.write(bytes);
    writer.releaseLock();
  };
  try {
    await write(decode(plan.head));
    for (const part of plan.parts) {
      const object = await bucket.get(
        part.key,
        part.length === undefined ? {} : { range: { offset: part.offset!, length: part.length } },
      );
      if (!object) throw new Error('A stored pack object is missing.');
      await object.body.pipeTo(writable, { preventClose: true });
    }
    await write(decode(plan.tail));
    await writable.close();
  } catch (error) {
    // Without side-band there is no error channel; a cut pack fails Git's trailer check.
    await writable.abort(error).catch(() => {});
  }
}

export default {
  fetch: async (request: Request, env: Env, context: Context): Promise<Response> => {
    const url = new URL(request.url);
    const direct = url.pathname.startsWith('/git/');
    if (!direct && !url.pathname.startsWith('/gitw/')) return plain(404, 'Repository not found.');
    if (request.method !== 'GET' && request.method !== 'POST') return plain(405, 'Method not allowed.');
    if (
      request.method === 'GET' &&
      url.pathname.endsWith('/info/refs') &&
      url.searchParams.get('service') === 'git-upload-pack' &&
      v2Request.test(request.headers.get('git-protocol') ?? '')
    )
      return new Response(v2Advertisement, {
        headers: {
          'content-type': 'application/x-git-upload-pack-advertisement',
          'cache-control': 'no-cache, max-age=0, must-revalidate',
        },
      });
    const headers = new Headers();
    for (const name of forwarded) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    if (direct) headers.set(viaHeader, '1');
    const upstream = await globalThis.fetch(`${env.FORGE_CONVEX_SITE}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      redirect: 'manual',
      // A fetch whose joined trailer is not cached yet hashes the pack first (seconds).
      signal: AbortSignal.timeout(5 * 60_000),
      ...(request.method === 'POST' ? { body: await request.arrayBuffer() } : {}),
    });
    if (!(upstream.headers.get('content-type') ?? '').toLowerCase().startsWith(planType)) return upstream;
    const plan = checkedPlan(await upstream.json());
    if (!plan) return plain(502, 'Forge sent an invalid byte plan.');
    const native = (globalThis as { IdentityTransformStream?: typeof TransformStream })
      .IdentityTransformStream;
    const { readable, writable } = new (native ?? TransformStream)<Uint8Array, Uint8Array>();
    context.waitUntil(pump(plan, env.FORGE_R2, writable));
    return new Response(readable, {
      status: 200,
      headers: {
        'content-type': 'application/x-git-upload-pack-result',
        'cache-control': 'no-cache, max-age=0, must-revalidate',
      },
    });
  },
};
