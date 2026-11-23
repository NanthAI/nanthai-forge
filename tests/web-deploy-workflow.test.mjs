// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { SITE_INPUTS, buildFiles } from '../scripts/site-deploy-plan.mjs';
import { moduleUrl } from './convex-module.mjs';

const deployDispatch = await import(moduleUrl('../convex/projectDeployDispatch.ts'));
const workflow = readFileSync('.github/workflows/web-deploy.yml', 'utf8');
const step = name => workflow.indexOf(name);
const namedStep = name => {
  const entry = workflow.split(/^      - /m).find(text => text.startsWith(`name: ${name}\n`));
  assert(entry, `missing step: ${name}`);
  return entry;
};

test('Item 8b6efb50: dev web deploys from Forge workflow_dispatch and catch-up schedule on main, never mirror push', () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s+push:/m);
  assert.doesNotMatch(workflow, /pull_request/);
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main' && vars\.FORGE_RELEASE_PROJECT != ''/);
  assert.match(workflow, /environment: cloudflare-dev/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /node-version: '24\.22\.1'/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /^permissions:\n {2}contents: read\n {2}id-token: write$/m);
});

test('Item 8b6efb50: the Forge dispatch path filter covers everything the site deploy plan counts as served', () => {
  const covered = path => deployDispatch.WEB_DEPLOY_PATHS.some(re => re.test(path));
  // Every whole input, every file the build imports, and every folder a bundle may contain.
  const samples = [
    'web/x',
    'site/x',
    'docs/x',
    'skills/x',
    'README.md',
    'package.json',
    'package-lock.json',
    '.github/workflows/web-deploy.yml',
    'scripts/package-documents/x.json',
    'src/cli.ts',
  ];
  for (const input of SITE_INPUTS)
    assert(
      samples.some(path => input.test(path)),
      `${input}: add a sample here`,
    );
  for (const path of samples) assert(covered(path), `${path}: no dispatch path`);
  for (const file of buildFiles(process.cwd())) assert(covered(file), `${file}: no dispatch path`);
  for (const sample of ['src/x.ts', 'convex/x.ts', 'scripts/x.mjs']) assert(covered(sample), sample);
  assert(!covered('tests/x.test.mjs'), 'a test-only landing never dispatches a web deploy');
});

test('the plan gates every later step, and only a new digest reaches the deploy', () => {
  const steps = workflow.split(/^ {6}- /m).slice(1);
  const plan = steps.findIndex(text => text.includes('scripts/forge-deploy-ci.mjs plan'));
  assert(plan >= 2, 'checkout and Node come first, then the plan, before any install');
  assert.doesNotMatch(steps.slice(0, plan + 1).join(''), /npm ci/);
  for (const text of steps.slice(plan + 1))
    assert.match(
      text,
      /if: (?:always\(\) && )?(?:\()?steps\.(?:plan\.outputs\.build|compare\.outputs\.deploy) == 'true'/,
      text.slice(0, 60),
    );
  for (const text of steps.filter(text => /npm ci|build:web|build-site|cf deploy/.test(text)))
    assert.doesNotMatch(text, /skipped_unchanged/);
  for (const text of steps.filter(text => /site\/deploy|cf deploy/.test(text)))
    assert.match(text, /if: steps\.compare\.outputs\.deploy == 'true'/);
  // No runner waits out the window: a deferred change is taken by the next landing or the scheduled run.
  assert.doesNotMatch(workflow, /\bsleep\b/);
  // Every run builds Forge main's newest State, so a late or re-run job never deploys an older main over a newer one.
  assert.match(workflow, /actions\/checkout@[0-9a-f]{40} # v4\n\s+with:\n(?:\s+#.*\n)*\s+ref: main\n/);
  assert.match(workflow, /id-token: write/);
  assert.match(
    namedStep('Plan the deploy'),
    /forge-deploy-ci\.mjs plan --target web --site "\$SITE_URL" \$\{\{ github\.event_name == 'schedule' && '--deep' \|\| '' \}\}/,
  );
  assert.match(workflow, /^ {2}schedule:\n {4}- cron: '7 \*\/3 \* \* \*'$/m);
});

test('the deploy checks and uploads the same build, with the Cloudflare credential scoped to upload', () => {
  const order = [
    'scripts/forge-deploy-ci.mjs plan',
    'scripts/forge-deploy-ci.mjs checkout',
    'npm run build:web',
    'tests/web-bundle-node-free.test.mjs',
    'scripts/web-smoke-load.mjs hosted-web-dist VITE_CONVEX_URL',
    'scripts/build-site.mjs site-output --commit',
    'scripts/site-deploy-plan.mjs compare',
    'cf deploy --prebuilt --no-provision',
    'scripts/forge-deploy-ci.mjs smoke',
    'scripts/forge-deploy-ci.mjs report',
  ].map(step);
  assert(order.every(index => index > 0) && order.every((index, i) => i === 0 || index > order[i - 1]));
  const deploy = namedStep('Deploy to the dev site');
  assert.match(deploy, /working-directory: site-output/);
  assert.match(deploy, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
  assert.match(deploy, /CLOUDFLARE_ACCOUNT_ID: \$\{\{ vars\.CLOUDFLARE_ACCOUNT_ID \}\}/);
  assert.doesNotMatch(workflow.replace(deploy, ''), /\bCLOUDFLARE_API_TOKEN\b/);
  assert.equal(workflow.match(/secrets\./g).length, 2);
  for (const name of ['VITE_CONVEX_URL', 'VITE_CONVEX_SITE_URL']) {
    assert.equal(
      workflow.match(new RegExp(`${name}: \\$\\{\\{ vars\\.${name} \\}\\}`, 'g'))?.length,
      2,
      `${name} reaches build and smoke`,
    );
    assert(workflow.includes(`hosted-web-dist VITE_CONVEX_URL VITE_CONVEX_SITE_URL`));
  }
  assert.doesNotMatch(workflow, /echo[^\n]*(?:TOKEN|CLOUDFLARE)|set -x|--secrets-file/);
  assert.match(workflow, /CF_SEND_TELEMETRY: 'false'/);
  assert.equal(workflow.match(/VITE_FORGE_DEMO_REPOSITORY: \S+/g)?.length, 1);
  // Build version is read from /_forge/build.json at runtime so JS chunks never churn per head.
  assert.doesNotMatch(namedStep('Build the web app'), /VITE_FORGE_BUILD_VERSION/);
  // Unchanged rebuilds still run post-deploy smoke before reporting succeeded, and mark --unchanged so
  // receipts never falsely credit an un-uploaded head as the live build.
  assert.match(namedStep('Post-deploy smoke'), /steps\.compare\.outputs\.deploy != 'true'/);
  const report = namedStep('Report deploy outcome to Forge');
  assert.match(report, /if \[ "\$SMOKE_OK" = "true" \]/);
  assert.match(report, /PLAN_SKIPPED_UNCHANGED/);
  assert.match(report, /unchanged="--unchanged"/);
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
      JSON.stringify({ 'src/app/App.tsx': { file: 'assets/App-x.js' } }),
    );
    writeFileSync(join(dir, 'assets/App-x.js'), 'export const ok = 1;\n');
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
    writeFileSync(join(dir, 'assets/App-x.js'), 'export const url = "https://baked.example";\n');
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
      JSON.stringify({ 'src/app/App.tsx': { file: 'assets/App-x.js' } }),
    );
    writeFileSync(join(dir, 'hosted-web-dist/assets/App-x.js'), 'export const ok = 1;');
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
  // The deploy tool has its own exact pin and lockfile, so ordinary installs never download it.
  const pkg = JSON.parse(readFileSync('site/deploy/package.json', 'utf8'));
  const lock = JSON.parse(readFileSync('site/deploy/package-lock.json', 'utf8'));
  assert.match(pkg.devDependencies.cf ?? '', /^\d+\.\d+\.\d+(?:-[\w.]+)?$/);
  assert.equal(lock.packages['node_modules/cf'].version, pkg.devDependencies.cf);
  assert.match(lock.packages['node_modules/cf'].integrity, /^sha512-/);
  const root = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal({ ...root.dependencies, ...root.devDependencies }.cf, undefined);
  assert.match(workflow, /npm ci --ignore-scripts --prefix site\/deploy/);
  assert.match(workflow, /\.\.\/site\/deploy\/node_modules\/\.bin\/cf deploy/);
});
