// SPDX-License-Identifier: Apache-2.0
// Forge has no Convex byte mode, so every test process gets R2 settings and an in-memory
// bucket behind them. It stores what is PUT and answers HEAD/GET/DELETE like R2, without
// checking signatures; tests of R2 behaviour itself use the stricter fake-r2.mjs.
// A test that replaces fetch passes R2 hosts to the previous fetch; a test that must observe
// or fail default-bucket requests uses interceptDefaultR2.
import { createHash } from 'node:crypto';

export const defaultR2Config = {
  accountId: 'forgetest',
  bucket: 'forge-test-blobs',
  accessKeyId: 'AKIDTEST',
  secretAccessKey: 'test-only-secret',
};
const host = `${defaultR2Config.accountId}.r2.cloudflarestorage.com`;
/** "bucket/key" -> bytes, shared by every fixture in this process. */
export const defaultR2Objects = new Map();

function list(url) {
  const bucket = decodeURIComponent(url.pathname).slice(1).split('/')[0],
    prefix = `${bucket}/${url.searchParams.get('prefix') ?? ''}`,
    after = url.searchParams.get('continuation-token') ?? '';
  const keys = [...defaultR2Objects.keys()]
    .filter(key => key.startsWith(prefix))
    .map(key => key.slice(bucket.length + 1))
    .sort()
    .filter(key => key > after);
  const page = keys.slice(0, Number(url.searchParams.get('max-keys') ?? 1000)),
    truncated = keys.length > page.length;
  return new Response(
    `<ListBucketResult><IsTruncated>${truncated}</IsTruncated>` +
      page.map(key => `<Contents><Key>${encodeURIComponent(key)}</Key></Contents>`).join('') +
      (truncated ? `<NextContinuationToken>${page.at(-1)}</NextContinuationToken>` : '') +
      '</ListBucketResult>',
    { status: 200, headers: { 'content-type': 'application/xml' } },
  );
}

let interceptor = null;
/** Routes every default-bucket request through `handler(input, init, serve)` until the returned restore runs. */
export function interceptDefaultR2(handler) {
  interceptor = handler;
  return () => {
    if (interceptor === handler) interceptor = null;
  };
}

export function installDefaultR2() {
  const env = {
    R2_ACCOUNT_ID: defaultR2Config.accountId,
    R2_BUCKET: defaultR2Config.bucket,
    R2_ACCESS_KEY_ID: defaultR2Config.accessKeyId,
    R2_SECRET_ACCESS_KEY: defaultR2Config.secretAccessKey,
  };
  // A test that sets its own settings (or none) keeps them.
  if (Object.keys(env).some(name => process.env[name] !== undefined)) return;
  Object.assign(process.env, env);
  const serve = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if ((init.method ?? 'GET').toUpperCase() === 'GET' && url.searchParams.get('list-type') === '2')
      return list(url);
    const id = decodeURIComponent(url.pathname).slice(1),
      method = (init.method ?? 'GET').toUpperCase(),
      object = defaultR2Objects.get(id);
    if (method === 'PUT') {
      if (new Headers(init.headers).get('if-none-match') === '*' && object)
        return new Response(null, { status: 412 });
      defaultR2Objects.set(id, Buffer.from(await new Response(init.body).arrayBuffer()));
      return new Response(null, { status: 200 });
    }
    if (method === 'DELETE') {
      defaultR2Objects.delete(id);
      return new Response(null, { status: 204 });
    }
    if (!object) return new Response(null, { status: 404 });
    const headers = {
      'content-length': String(object.length),
      'x-amz-checksum-sha256': createHash('sha256').update(object).digest('base64'),
    };
    const range = /^bytes=(\d+)-(\d+)?$/.exec(new Headers(init.headers).get('range') ?? '');
    if (method === 'GET' && range) {
      const from = Number(range[1]),
        to = Math.min(object.length - 1, range[2] === undefined ? Infinity : Number(range[2]));
      if (from >= object.length)
        return new Response(null, { status: 416, headers: { 'content-range': `bytes */${object.length}` } });
      return new Response(object.subarray(from, to + 1), {
        status: 206,
        headers: {
          'content-range': `bytes ${from}-${to}/${object.length}`,
          'content-length': String(to - from + 1),
        },
      });
    }
    return new Response(method === 'HEAD' ? null : object, { status: 200, headers });
  };
  const base = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.host !== host) return base(input, init);
    return interceptor ? interceptor(input, init, serve) : serve(input, init);
  };
}

/** Tests that drive project purge directly do not run the scheduled R2 prefix purge action;
 * this records its effect so the next purge step proceeds. */
export function settleR2Purge(project) {
  if (project?.r2Purge && !project.r2PrefixPurged) project.r2PrefixPurged = true;
}

/** The stored bytes of a project object row: R2 (this bucket) or a legacy Convex copy. */
export async function storedBytes(s, row) {
  if (row.storageId) return Buffer.from(await (await s.ctx.storage.get(row.storageId)).arrayBuffer());
  return defaultR2Objects.get(`${defaultR2Config.bucket}/${row.r2Key}`) ?? null;
}
