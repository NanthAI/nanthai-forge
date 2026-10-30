// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync('.github/workflows/web-deploy.yml', 'utf8');
const step = name => workflow.indexOf(name);

test('dev web deploys only from main pushes inside the locked environment', () => {
  assert.match(workflow, /push:\n\s+branches: \[main\]/);
  assert.doesNotMatch(workflow, /pull_request/);
  assert.match(workflow, /environment: netlify-dev/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /node-version: '24\.22\.1'/);
  assert.match(workflow, /cancel-in-progress: false/);
  for (const path of ['web/**', 'src/**', 'package.json', 'package-lock.json'])
    assert(workflow.includes(`      - '${path}'`), `paths filter covers ${path}`);
});

test('the deploy builds, guards, smoke-loads, then deploys the same build, and never exposes the token', () => {
  const order = [
    'npm run build:web',
    'tests/web-bundle-node-free.test.mjs',
    'scripts/web-smoke-load.mjs hosted-web-dist VITE_CONVEX_URL',
    'netlify-cli@',
  ].map(step);
  assert(order.every(index => index > 0) && order.every((index, i) => i === 0 || index > order[i - 1]));
  assert.match(workflow, /deploy --prod --no-build --dir hosted-web-dist --site "\$NETLIFY_SITE_ID"/);
  assert.match(workflow, /NETLIFY_AUTH_TOKEN: \$\{\{ secrets\.NETLIFY_AUTH_TOKEN \}\}/);
  assert.match(workflow, /NETLIFY_SITE_ID: \$\{\{ vars\.NETLIFY_SITE_ID \}\}/);
  assert.equal(workflow.match(/secrets\./g).length, 1);
  for (const name of ['VITE_CONVEX_URL', 'VITE_CONVEX_SITE_URL', 'VITE_CLERK_PUBLISHABLE_KEY']) {
    assert.equal(
      workflow.match(new RegExp(`${name}: \\$\\{\\{ vars\\.${name} \\}\\}`, 'g'))?.length,
      2,
      `${name} reaches build and smoke`,
    );
    assert(
      workflow.includes(`hosted-web-dist VITE_CONVEX_URL VITE_CONVEX_SITE_URL VITE_CLERK_PUBLISHABLE_KEY`),
    );
  }
  assert.doesNotMatch(workflow, /echo[^\n]*(?:TOKEN|NETLIFY)|set -x|--auth/);
  // The build step carries the demo repository that netlify.toml gives Netlify's own build.
  const demo = readFileSync('netlify.toml', 'utf8').match(/VITE_FORGE_DEMO_REPOSITORY = "([^"]+)"/)?.[1];
  assert(demo && workflow.includes(`VITE_FORGE_DEMO_REPOSITORY: ${demo}`));
});

test('the headless smoke fails on a module-evaluation error or unbaked build config', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'web-smoke-'));
  try {
    mkdirSync(join(dir, 'assets'));
    mkdirSync(join(dir, '.vite'));
    writeFileSync(
      join(dir, '.vite/manifest.json'),
      JSON.stringify({ 'src/Hosted.tsx': { file: 'assets/Hosted-x.js' } }),
    );
    writeFileSync(join(dir, 'assets/Hosted-x.js'), 'export const ok = 1;\n');
    writeFileSync(
      join(dir, 'assets/Shell-x.js'),
      'throw new TypeError("createRequire is not a function");\n',
    );
    const run = () => spawnSync(process.execPath, ['scripts/web-smoke-load.mjs', dir], { encoding: 'utf8' });
    const bad = run();
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /Shell-x\.js: TypeError: createRequire is not a function/);
    rmSync(join(dir, 'assets/Shell-x.js'));
    assert.equal(run().status, 0);
    const config = env =>
      spawnSync(process.execPath, ['scripts/web-smoke-load.mjs', dir, 'VITE_CONVEX_URL'], {
        encoding: 'utf8',
        env,
      });
    const missing = config({ PATH: process.env.PATH });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /VITE_CONVEX_URL is not set/);
    writeFileSync(join(dir, 'assets/Hosted-x.js'), 'export const url = "https://baked.example";\n');
    assert.match(
      config({ PATH: process.env.PATH, VITE_CONVEX_URL: 'https://other.example' }).stderr,
      /not baked/,
    );
    assert.equal(config({ PATH: process.env.PATH, VITE_CONVEX_URL: 'https://baked.example' }).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
