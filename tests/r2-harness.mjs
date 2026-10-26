// SPDX-License-Identifier: Apache-2.0
// Shared setup for the R2 write and read path tests: a Convex fixture with R2 enabled, a fake R2
// bucket on the fetch path, and a CLI exchange client wired straight to the fixture's functions.
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { fixture, modules } from './project-exchange-fixture.mjs';
import { startFakeR2, fakeR2Config } from './fake-r2.mjs';
import { digest } from '../dist/hash.js';
import { ConvexExchange } from '../dist/exchange-client.js';

const envNames = ['FORGE_BLOBS', 'R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
export const pinOf = text => ({ digest: digest(text), size: Buffer.byteLength(text) });

/** A Convex fixture with the R2 flag, credentials and the project opt-in set, plus a fake R2. */
export async function setup(t, { flag = 'r2', optIn = true, credentials = true } = {}) {
  const saved = Object.fromEntries(envNames.map(name => [name, process.env[name]])),
    fake = await startFakeR2(),
    restore = fake.install(),
    s = fixture();
  // Convex-stored objects (R2 off, or written before it was on) upload to the fixture's upload URL.
  const r2Fetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (url !== 'https://fixture.invalid/upload') return r2Fetch(url, init);
    const storageId = await s.ctx.storage.store(
      new Blob([init.body], { type: init.headers['Content-Type'] }),
    );
    return Response.json({ storageId });
  };
  if (flag) process.env.FORGE_BLOBS = flag;
  else delete process.env.FORGE_BLOBS;
  const env = {
    R2_ACCOUNT_ID: fakeR2Config.accountId,
    R2_BUCKET: fakeR2Config.bucket,
    R2_ACCESS_KEY_ID: fakeR2Config.accessKeyId,
    R2_SECRET_ACCESS_KEY: fakeR2Config.secretAccessKey,
  };
  for (const [name, value] of Object.entries(env))
    if (credentials) process.env[name] = value;
    else delete process.env[name];
  if (optIn) s.tables.hostedProjects.get('project').r2Writes = true;
  t.after(async () => {
    globalThis.fetch = r2Fetch;
    restore();
    await fake.close();
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });
  return { s, fake };
}
export function client(s) {
  const exchange = new ConvexExchange(
      'https://example.convex.cloud',
      'test-only',
      'project',
      randomUUID(),
      null,
    ),
    run = (ref, args) => {
      const [module, name] = getFunctionName(ref).split(':');
      return modules[module][name]._handler(s.ctx, args);
    };
  exchange.client = { query: run, mutation: run, action: run };
  return exchange;
}
