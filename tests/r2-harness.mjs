// SPDX-License-Identifier: Apache-2.0
// Shared setup for the R2 write and read path tests: a Convex fixture with R2 enabled, a fake R2
// bucket on the fetch path, and a CLI exchange client wired straight to the fixture's functions.
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { fixture, modules } from './project-exchange-fixture.mjs';
import { startFakeR2, fakeR2Config } from './fake-r2.mjs';
import { digest } from '../dist/hash.js';
import { ConvexExchange } from '../dist/exchange-client.js';

const envNames = [
  'CONVEX_CLOUD_URL',
  'R2_ACCOUNT_ID',
  'R2_BUCKET',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
];
export const pinOf = text => ({ digest: digest(text), size: Buffer.byteLength(text) });

/** A Convex cloud deployment fixture (bytes always go to R2) with R2 credentials, plus a fake R2.
 * `optIn` only sets the retired per-project flag on the row; placement ignores it. */
export async function setup(t, { optIn = true, credentials = true } = {}) {
  const saved = Object.fromEntries(envNames.map(name => [name, process.env[name]])),
    fake = await startFakeR2(),
    restore = fake.install(),
    s = fixture();
  // Legacy Convex-stored objects (written before R2 was the only path) upload to the fixture's upload URL.
  const r2Fetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (url !== 'https://fixture.invalid/upload') return r2Fetch(url, init);
    const storageId = await s.ctx.storage.store(
      new Blob([init.body], { type: init.headers['Content-Type'] }),
    );
    return Response.json({ storageId });
  };
  process.env.CONVEX_CLOUD_URL = 'https://example.convex.cloud';
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
/** A reservation made before R2 was the only byte path: no placement, no bytes yet. */
export function pendingConvexRow(s, text, projectId = 'project') {
  const pin = pinOf(text),
    id = `pending-${pin.digest.slice(0, 12)}`;
  s.tables.projectObjects.set(id, {
    _id: id,
    _creationTime: Date.now(),
    projectId,
    ...pin,
    nonce: randomUUID(),
    removed: false,
  });
  return id;
}
export { legacyObject } from './project-exchange-fixture.mjs';
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
