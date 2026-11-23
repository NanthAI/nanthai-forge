// SPDX-License-Identifier: Apache-2.0
/** Builds the web site for Cloudflare (Item ef6aa22a): the static files from hosted-web-dist (run `npm run build:web`
 * first) plus the site Worker (site/worker.ts), as Build Output that `cf deploy --prebuilt --no-provision` uploads.
 *
 *   node scripts/build-site.mjs OUTPUT_DIRECTORY [--name WORKER_NAME] [--commit SHA]
 *
 * The output holds no account details or secrets: the Worker's settings are secrets set on the Worker itself
 * (docs/development.md#web-site). It also writes the site's deploy record, /_forge/build.json
 * (scripts/site-deploy-plan.mjs): the commit, the build time, a digest of every other served byte and the src/ files
 * the bundles contain. The same inputs give the same digest. */
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'vite';
import { SITE_RECORD, errorCodeDigest, servedSources } from './site-deploy-plan.mjs';
import { headersFile } from '../site/headers.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { name: { type: 'string', default: 'nanthai-forge-dev' }, commit: { type: 'string' } },
});
const destination = positionals[0];
if (!destination)
  throw new Error('Usage: node scripts/build-site.mjs OUTPUT_DIRECTORY [--name NAME] [--commit SHA]');
const root = fileURLToPath(new URL('..', import.meta.url));
const web = join(root, 'hosted-web-dist');
const output = resolve(destination, '.cloudflare/output/v0');
const worker = join(output, 'workers/default');
const assets = join(worker, 'assets');
const module = 'site-worker.js';
await rm(output, { recursive: true, force: true });
await mkdir(worker, { recursive: true });

// Static files: everything the web build serves, never its build metadata (.vite/).
const webSources = JSON.parse(await readFile(join(web, '.vite/served-sources.json'), 'utf8'));
await cp(web, assets, { recursive: true, filter: path => !relative(web, path).split(sep).includes('.vite') });
const workerSources = [];
await build({
  configFile: false,
  publicDir: false,
  logLevel: 'warn',
  build: {
    ssr: join(root, 'site/worker.ts'),
    target: 'es2022',
    outDir: join(worker, 'bundle'),
    emptyOutDir: false,
    rollupOptions: { output: { entryFileNames: module } },
  },
  plugins: [
    {
      name: 'forge-site-sources',
      generateBundle() {
        workerSources.push(...servedSources(this.getModuleIds(), root));
      },
    },
  ],
});
// The static files' headers come from the Worker's own source (site/headers.ts), so the two halves cannot drift.
await writeFile(join(assets, '_headers'), headersFile());

const name = values.name;
if (!/^[a-z0-9-]{1,63}$/.test(name))
  throw new Error('The Worker name is lowercase letters, digits and dashes.');
await writeFile(join(output, 'config.json'), JSON.stringify({ buildContext: { isPreview: false } }));
const secret = { type: 'secret' };
await writeFile(
  join(worker, 'worker.config.json'),
  JSON.stringify({
    name,
    compatibilityDate: '2026-10-01',
    workersDev: true,
    previewUrls: false,
    // A static file is served first and free; a file name without its .html serves that page; anything else runs
    // the Worker.
    assets: { htmlHandling: 'auto-trailing-slash', notFoundHandling: 'none' },
    env: {
      ASSETS: { type: 'assets' },
      // Per-address backstops before any backend call: 60 public reads and 10 sign-in starts a minute.
      PUBLIC_LIMIT: { type: 'rate-limit', namespace: '7201', simple: { limit: 60, period: 60 } },
      DEVICE_LIMIT: { type: 'rate-limit', namespace: '7202', simple: { limit: 10, period: 60 } },
      FORGE_WEB_URL: secret,
      FORGE_CONVEX_SITE_URL: secret,
      FORGE_PUBLIC_READ_SECRET: secret,
      // FORGE_PUBLIC_CODE_WORKER_URL is optional (docs/r2-storage-plan.md#dev-deployment): declare it here when the
      // public code Worker route is turned on, because every declared secret is required.
      FORGE_CLIENT_HASH_KEY: secret,
      FORGE_SITE_DEVICE_KEY: secret,
    },
    manifest: { type: 'complete', mainModule: module, modules: { [module]: { type: 'esm' } } },
  }),
);

async function files(directory) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter(entry => entry.isFile())
    .map(entry => relative(output, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .filter(path => path !== `workers/default/assets/${SITE_RECORD}`)
    .sort();
}
const digest = createHash('sha256');
for (const path of await files(output))
  digest.update(
    `${path}\0${createHash('sha256')
      .update(await readFile(join(output, path)))
      .digest('hex')}\n`,
  );
await mkdir(join(assets, '_forge'), { recursive: true });
await writeFile(
  join(assets, SITE_RECORD),
  `${JSON.stringify({
    commit: values.commit ?? null,
    deployedAt: new Date().toISOString(),
    digest: digest.digest('hex'),
    errorCodes: errorCodeDigest(root),
    sources: [...new Set([...webSources, ...workerSources])].sort(),
  })}\n`,
);
console.log(`site: ${(await files(assets)).length} static files and the Worker in ${output}`);
