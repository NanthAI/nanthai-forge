// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const workflow = readFileSync('.github/workflows/web-deploy.yml', 'utf8');
const step = name => workflow.indexOf(name);
const namedStep = name => {
  const entry = workflow.split(/^      - /m).find(text => text.startsWith(`name: ${name}\n`));
  assert(entry, `missing step: ${name}`);
  return entry;
};

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

test('the deploy checks and uploads the same build, with the Netlify credential scoped to upload', () => {
  const order = [
    'npm run build:web',
    'tests/web-bundle-node-free.test.mjs',
    'scripts/web-smoke-load.mjs hosted-web-dist VITE_CONVEX_URL',
    'npx --no-install netlify deploy',
  ].map(step);
  assert(order.every(index => index > 0) && order.every((index, i) => i === 0 || index > order[i - 1]));
  assert.match(workflow, /deploy --prod --no-build --dir hosted-web-dist --site "\$NETLIFY_SITE_ID"/);
  const deploy = namedStep('Deploy to the dev site');
  assert.match(deploy, /NETLIFY_AUTH_TOKEN: \$\{\{ secrets\.NETLIFY_AUTH_TOKEN \}\}/);
  assert.doesNotMatch(workflow.replace(deploy, ''), /\bNETLIFY_AUTH_TOKEN\b/);
  assert.match(workflow, /NETLIFY_SITE_ID: \$\{\{ vars\.NETLIFY_SITE_ID \}\}/);
  assert.equal(workflow.match(/secrets\./g).length, 2);
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

test('PostHog build configuration is scoped to the dev web build', () => {
  const build = namedStep('Build the web app');
  assert.match(
    build,
    /^          VITE_FORGE_POSTHOG_PROJECT_TOKEN: \$\{\{ secrets\.VITE_FORGE_POSTHOG_PROJECT_TOKEN \}\}$/m,
  );
  assert.match(build, /^          VITE_FORGE_POSTHOG_REGION: \$\{\{ vars\.VITE_FORGE_POSTHOG_REGION \}\}$/m);

  const postHogConfig = /\bVITE_FORGE_POSTHOG_(?:PROJECT_TOKEN|REGION)\b/;
  assert.doesNotMatch(workflow.replace(build, ''), postHogConfig);
  assert.doesNotMatch(readFileSync('netlify.toml', 'utf8'), postHogConfig, 'Netlify build configuration');
  for (const name of readdirSync('.github/workflows')) {
    if (name !== 'web-deploy.yml' && /\.ya?ml$/.test(name)) {
      assert.doesNotMatch(readFileSync(`.github/workflows/${name}`, 'utf8'), postHogConfig, name);
    }
  }
});

test('the headless smoke fails on a module-evaluation error or unbaked build config', () => {
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

test('React Aria keyboard setup loads with Screen but without the optional orientation API', () => {
  const keyboard = pathToFileURL(resolve('node_modules/react-aria/dist/private/utils/keyboard.mjs')).href;
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      './scripts/web-smoke-stub.mjs',
      '--input-type=module',
      '-e',
      `import assert from 'node:assert/strict';
      // Catch explicitly: the smoke stub ignores asynchronous render errors, not import failures.
      try {
        assert.equal(typeof window.screen, 'object');
        assert.equal(window.screen.orientation, undefined);
        await import(${JSON.stringify(keyboard)});
        console.log('keyboard setup loaded');
        process.exit(0);
      }
      catch (error) { console.error(error); process.exit(1); }`,
    ],
    { encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production' } },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /keyboard setup loaded/);
});

test('the smoke DOM supports module-level motion preferences through the root class list', () => {
  const motion = pathToFileURL(resolve('web/src/motion-pref.ts')).href;
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      './scripts/web-smoke-stub.mjs',
      '--input-type=module',
      '-e',
      `import assert from 'node:assert/strict';
    try {
      const { applyMotion } = await import(${JSON.stringify(motion)});
      applyMotion(true);
      assert.equal(document.documentElement.classList.contains('mk-motion-full'), true);
      applyMotion(false);
      assert.equal(document.documentElement.classList.contains('mk-motion-full'), false);
      console.log('motion preference loaded'); process.exit(0);
    } catch (error) { console.error(error); process.exit(1); }`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /motion preference loaded/);
});

test('the landing web build fails on an unevaluated lazy chunk without rebuilding for smoke', () => {
  const dir = mkdtempSync(join(tmpdir(), 'web-build-smoke-'));
  try {
    for (const path of ['scripts', 'node_modules/.bin', 'hosted-web-dist/assets', 'hosted-web-dist/.vite'])
      mkdirSync(join(dir, path), { recursive: true });
    for (const name of ['web-smoke-load.mjs', 'web-smoke-stub.mjs'])
      writeFileSync(join(dir, 'scripts', name), readFileSync(join('scripts', name)));
    const { scripts } = JSON.parse(readFileSync('package.json', 'utf8'));
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ type: 'module', scripts: { 'build:web': scripts['build:web'] } }),
    );
    // Vite's output is synthetic here; exercise the real build recipe and real chunk loader.
    writeFileSync(
      join(dir, 'node_modules/.bin/vite'),
      `#!${process.execPath}
      import { appendFileSync } from 'node:fs'; appendFileSync('builds', 'built\\n');`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(dir, 'hosted-web-dist/.vite/manifest.json'),
      JSON.stringify({ 'src/Hosted.tsx': { file: 'assets/Hosted-x.js' } }),
    );
    writeFileSync(join(dir, 'hosted-web-dist/assets/Hosted-x.js'), 'export const ok = 1;');
    const lazy = join(dir, 'hosted-web-dist/assets/behaviour-x.js');
    writeFileSync(lazy, 'throw new TypeError("lazy chunk broke");');
    const run = () => spawnSync('npm', ['run', '--silent', 'build:web'], { cwd: dir, encoding: 'utf8' });
    const bad = run();
    assert.equal(bad.status, 1, bad.stdout + bad.stderr);
    assert.match(bad.stderr, /behaviour-x\.js: TypeError: lazy chunk broke/);
    assert.equal(readFileSync(join(dir, 'builds'), 'utf8'), 'built\n');
    writeFileSync(lazy, 'export const ok = 1;');
    const good = run();
    assert.equal(good.status, 0, good.stdout + good.stderr);
    assert.match(good.stdout, /web smoke: 2\/2 chunks evaluated/);
    assert.equal(readFileSync(join(dir, 'builds'), 'utf8'), 'built\nbuilt\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the dev web build receives the GitHub App slug through its public Vite environment variable', () => {
  const build = namedStep('Build the web app');
  assert.match(build, /^          VITE_GITHUB_APP_SLUG: \$\{\{ vars\.VITE_GITHUB_APP_SLUG \}\}$/m);
  assert.doesNotMatch(build, /^\s+GITHUB_APP_SLUG:/m, 'GitHub reserves the GITHUB_ variable prefix');
});

test('workflow executables come from the lockfile rather than unlocked npx installs', () => {
  for (const name of readdirSync('.github/workflows').filter(name => /\.ya?ml$/.test(name))) {
    const source = readFileSync(`.github/workflows/${name}`, 'utf8');
    assert.doesNotMatch(source, /\bnpx\s+(?:--yes\b|[^\n]*?\b[\w/.-]+@[\w*.^~><=+-]+)/, name);
  }
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  assert.match(pkg.devDependencies['netlify-cli'] ?? '', /^\d+\.\d+\.\d+$/);
  assert.equal(lock.packages['node_modules/netlify-cli'].version, pkg.devDependencies['netlify-cli']);
  assert.match(workflow, /npx --no-install netlify deploy/);
});
