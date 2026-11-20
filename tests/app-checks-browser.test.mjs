// SPDX-License-Identifier: Apache-2.0
// Connect CI and connect your agent (Items 0c9207b8, c3e4a838) in a browser: the real Landing and checks and start
// screens with synthetic reads. The first question is the CI, four answers alike with the one main's files point to
// chosen ahead, and every answer has a route. The owner picks from the workflows on main, a tags-only file cannot be
// picked, the one trigger line shows as the exact change, one press sends one runner setting, the chosen check says
// whether it has decided a landing yet, and every layout passes axe in both themes at 1440 and 390 without sideways
// scroll.
import test from 'node:test';
import { settleBrowserPage } from './browser-runtime.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const shots = process.env.FORGE_CHECKS_SHOTS;

test('the owner connects CI from the workflows on main, and the agent steps include Cursor, with accessible layouts', async t => {
  const executablePath = process.env.FORGE_UI_BROWSER || chromium.executablePath();
  if (!existsSync(executablePath)) return t.skip('A test browser is not installed; set FORGE_UI_BROWSER.');
  const temp = mkdtempSync(join(tmpdir(), 'forge-checks-ui-'));
  const out = join(temp, 'out');
  const html = join(temp, 'fixture.html');
  const shim = join(temp, 'convex.ts');
  writeFileSync(
    shim,
    `export * from ${JSON.stringify(join(root, 'node_modules/convex/dist/esm/react/index.js'))};
    export function useConvex() { return window.client; }`,
  );
  writeFileSync(
    html,
    '<!doctype html><html lang="en" data-ds><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Landing and checks · Forge</title></head><body><main id="root"></main><script type="module" src="./fixture.tsx"></script></body></html>',
  );
  writeFileSync(
    join(temp, 'fixture.tsx'),
    `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { getFunctionName } from 'convex/server';
    import LandingChecks from ${JSON.stringify(join(root, 'web/src/app/checks/LandingChecks.tsx'))};
    import Start from ${JSON.stringify(join(root, 'web/src/app/start/Start.tsx'))};
    import ${JSON.stringify(join(root, 'web/src/app/app.css'))};
    import ${JSON.stringify(join(root, 'web/src/ds/tokens.css'))};
    import ${JSON.stringify(join(root, 'web/src/ds/base.css'))};
    import ${JSON.stringify(join(root, 'web/src/ds/core.css'))};
    import ${JSON.stringify(join(root, 'web/src/ds/parts.css'))};
    import ${JSON.stringify(join(root, 'web/src/ds/review.css'))};
    const q = new URLSearchParams(location.search);
    const HEAD = 'a'.repeat(64);
    const rootNames = q.has('gitlab') ? ['src', '.gitlab-ci.yml'] : q.has('none') ? ['src', 'README.md'] : ['.github', 'src', 'README.md'];
    const files = q.has('none') || q.has('gitlab') ? {} : {
      '.github/workflows/ci.yml': 'name: CI\\non:\\n  push:\\n    branches: [main]\\n  pull_request:\\njobs:\\n  test:\\n    runs-on: ubuntu-latest\\n',
      '.github/workflows/nightly.yml': "on:\\n  schedule:\\n    - cron: '0 3 * * *'\\n",
      '.github/workflows/release.yml': "on:\\n  push:\\n    tags: ['v*']\\n",
    };
    const mirror = q.has('nomirror') ? null : { repository: 'example/parser', at: 1800000000000 };
    const check = q.has('chosen') ? { kind: 'ci-file', repository: 'example/parser', workflow: '.github/workflows/ci.yml', chosenAt: 1800000000000 } : null;
    if (q.has('covered')) files['.github/workflows/ci.yml'] = "on:\\n  push:\\n    branches: [main, 'forge/candidates/**']\\n";
    const landings = q.has('landed') ? [{ title: 'Add the trigger line', committedAt: '2027-01-15T10:09:00.000Z', checkRunIds: ['run-1'] }] : [];
    const setup = { owner: 'ada', viewerIsOwner: true, created: { at: 1800000000000, by: 'ada' }, repository: { fullName: 'example/parser', at: 1800000000000, by: 'ada' }, mirror, check, firstLanding: null, approvalsAnswered: false };
    const policy = { acceptance: { mode: q.has('auto') ? 'auto-on-pass' : 'review', protectedPaths: ['.github/workflows/**'], autoActors: [] } };
    const main = { schema: 2, projectId: 'p', snapshotId: 's', sourceRevision: 1, authority: { mode: 'server', epoch: 3 }, channel: 'main', head: HEAD, receipt: { id: 'r', kind: 'hosted', previousHead: null, previousReceiptId: null } };
    window.calls = [];
    window.client = {
      query: async ref => {
        const name = getFunctionName(ref);
        window.calls.push({ name });
        if (name === 'projectSetup:read') return setup;
        if (name === 'projectAutonomy:read') return policy;
        if (name === 'projectHostedMainAudit:status') return JSON.stringify({ landing: null });
        if (name === 'projectHostedChannels:current') return JSON.stringify(main);
        if (name === 'projectHostedCheckDefinitions:current') return JSON.stringify({ configurationDigest: null });
        if (name === 'projectHostedLandings:read') return JSON.stringify({ schema: 1, landings });
        throw new Error('unexpected query ' + name);
      },
      action: async (ref, args) => {
        window.calls.push({ name: getFunctionName(ref), args });
        if (args.want === 'more' && args.path === '') return JSON.stringify({ state: HEAD, dirs: [{ path: '', entries: rootNames.map(name => ({ name, path: name, kind: name.includes('.') && name !== '.github' ? 'file' : 'dir' })), total: rootNames.length, next: null }] });
        if (args.want === 'more') return JSON.stringify({ state: HEAD, dirs: [{ path: args.path, entries: Object.keys(files).map(path => ({ name: path.split('/').at(-1), path, kind: 'file' })), total: Object.keys(files).length, next: null }] });
        const text = files[args.path];
        if (text === undefined) return JSON.stringify({ state: HEAD, file: { available: true, path: args.path, blob: null, mode: null, page: null } });
        return JSON.stringify({ state: HEAD, file: { available: true, path: args.path, blob: 'b', mode: 'file', page: { kind: 'text', text, offset: 0, nextOffset: null, totalCharacters: text.length } } });
      },
      mutation: async (ref, args) => {
        window.calls.push({ name: getFunctionName(ref), args });
        setup.check = { kind: 'ci-file', repository: 'example/parser', workflow: JSON.parse(args.request).change.configuration.ci.workflow, chosenAt: 1800000000000 };
        return JSON.stringify({ rule: 'runner' });
      },
    };
    const route = { frame: 'project', handle: 'example', project: 'parser', place: 'settings', section: 'checks', rest: '' };
    const feed = { main: { head: HEAD }, lanes: [], more: 0, moreIsLowerBound: false };
    createRoot(document.getElementById('root')).render(q.has('start') ? <Start /> : <LandingChecks route={route} projectId="synthetic" projectName="Parser" feed={feed} viewerHandle="ada" />);
  `,
  );
  const { build } = await import('vite');
  await build({
    configFile: join(root, 'web/vite.config.ts'),
    root: temp,
    base: '/',
    envDir: false,
    logLevel: 'error',
    resolve: {
      alias: [
        { find: /^convex\/react$/, replacement: shim },
        { find: /^react\//, replacement: dirname(require.resolve('react/package.json')) + '/' },
        { find: /^react$/, replacement: dirname(require.resolve('react/package.json')) },
        { find: /^react-dom\//, replacement: dirname(require.resolve('react-dom/package.json')) + '/' },
        { find: /^convex\/server$/, replacement: join(root, 'node_modules/convex/dist/esm/server/index.js') },
      ],
    },
    build: { outDir: out, emptyOutDir: true, rolldownOptions: { input: html } },
  });
  if (shots) mkdirSync(shots, { recursive: true });
  const browser = await chromium.launch({ executablePath });
  t.after(async () => {
    await browser.close();
    rmSync(temp, { recursive: true, force: true });
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'forge.test') return route.abort();
    const path = url.pathname.slice(1);
    const file = path.startsWith('fonts/') ? join(root, 'web/public', path) : join(out, path);
    const asset = path && existsSync(file);
    return route.fulfill({
      contentType: !asset
        ? 'text/html'
        : file.endsWith('.js')
          ? 'text/javascript'
          : file.endsWith('.css')
            ? 'text/css'
            : 'application/octet-stream',
      body: readFileSync(asset ? file : join(out, 'fixture.html')),
    });
  });
  const layouts = async name => {
    for (const width of [1440, 390])
      for (const theme of ['dark', 'light']) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(value => (document.documentElement.dataset.theme = value), theme);
        await settleBrowserPage(page);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
          `${name} ${width}`,
        );
        await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
        const result = await page.evaluate(() =>
          window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }),
        );
        assert.deepEqual(
          result.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })),
          [],
          `${name} ${width} ${theme}`,
        );
        if (shots)
          await page.screenshot({ path: join(shots, `${name}-${width}-${theme}.png`), fullPage: true });
      }
  };

  await page.goto('https://forge.test/-/example/parser/settings/checks');
  const workflows = page.getByRole('radiogroup', { name: 'Which workflow must pass' });
  await workflows.waitFor();
  assert.equal(await workflows.getByRole('radio', { name: /ci\.yml/ }).getAttribute('aria-checked'), 'true');
  assert.equal(await workflows.getByRole('radio', { name: /release\.yml/ }).isDisabled(), true, 'tags only');
  assert.equal(
    await workflows.getByRole('radio', { name: /nightly\.yml/ }).isDisabled(),
    true,
    'schedule only',
  );
  assert.match(
    await page.getByRole('region', { name: /The change to/ }).textContent(),
    /forge\/candidates\/\*\*/,
  );
  const cis = page.getByRole('radiogroup', { name: 'Which CI do you have' });
  assert.deepEqual(
    await cis
      .getByRole('radio')
      .evaluateAll(rows => rows.map(row => [row.querySelector('b').textContent, row.disabled])),
    [
      ['GitHub Actions', false],
      ['GitLab CI', false],
      ['Another CI, or your own machines', false],
      ['No CI yet', false],
    ],
    'every CI is a choice of the same shape; none is switched off',
  );
  assert.equal(
    await cis.getByRole('radio', { name: /GitHub Actions/ }).getAttribute('aria-checked'),
    'true',
    'main holds workflow files, so GitHub Actions is chosen ahead',
  );
  assert.match(
    await cis.getByRole('radio', { name: /GitHub Actions/ }).textContent(),
    /3 workflow files on main/,
  );
  await layouts('checks-found');
  const before = (await page.evaluate(() => window.calls)).length;
  await page.getByRole('button', { name: 'Use ci.yml' }).click();
  await page.getByRole('button', { name: 'Change' }).waitFor();
  const calls = await page.evaluate(() => window.calls);
  const written = calls.filter(c => c.name === 'projectHostedCheckDefinitions:configure');
  assert.equal(written.length, 1, 'one press writes once');
  assert.equal(
    JSON.parse(written[0].args.request).change.configuration.ci.workflow,
    '.github/workflows/ci.yml',
  );
  assert.equal(
    calls.slice(before).filter(c => c.name === 'projectCodeBrowse:read').length,
    0,
    'the workflow list is not read again after the choice',
  );
  // A saved setting is not a connected CI: the page says no landing was checked, and what the file still needs.
  await page.getByText('No landing checked yet').waitFor();
  await page.getByText('ci.yml on main does not run on Forge’s branches yet.').waitFor();
  assert.match(
    await page.getByRole('region', { name: /The change to/ }).textContent(),
    /forge\/candidates\/\*\*/,
  );
  await page.getByRole('button', { name: 'Give this to your agent' }).waitFor();
  const opened = await page.evaluate(() => window.calls);
  assert.equal(
    opened.slice(before).filter(c => c.name === 'projectHostedLandings:read').length,
    1,
    'one landings read says whether the check has decided a landing',
  );
  await layouts('checks-chosen');

  // The trigger line is on main and nothing has landed: nothing to change, the next landing is its first run.
  await page.goto('https://forge.test/-/example/parser/settings/checks?chosen=1&covered=1');
  await page.getByText('Its first run is the next landing.').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Give this to your agent' }).count(), 0);

  // Once a landing carries a check run, the evidence is one fact and the setup text is gone.
  await page.goto('https://forge.test/-/example/parser/settings/checks?chosen=1&landed=1');
  await page.getByText(/First landing checked:/).waitFor();
  assert.equal(await page.getByText('No landing checked yet').count(), 0);
  assert.equal(await page.getByText(/forge\/candidates/).count(), 0, 'no standing trigger text');
  assert.equal(
    (await page.evaluate(() => window.calls)).filter(c => c.name === 'projectCodeBrowse:read').length,
    0,
    'a connected check reads no source',
  );
  await layouts('checks-landed');

  // How a landing is checked: one shut line per setting with its value and source; the explanation opens in place.
  // While a person approves each landing nothing is grouped, so no grouping setting is listed.
  const settings = page.getByRole('region', { name: 'How a landing is checked' });
  const values = () =>
    settings.locator('details').evaluateAll(rows => rows.map(row => row.querySelector('.val').textContent));
  assert.deepEqual(await values(), ['Strictdefault', 'Ondefault', 'Ondefault']);
  await page.goto('https://forge.test/-/example/parser/settings/checks?chosen=1&landed=1&auto=1');
  await page.getByText(/First landing checked:/).waitFor();
  assert.deepEqual(
    await settings
      .locator('details')
      .evaluateAll(rows => rows.map(row => [row.open, row.querySelector('.val').textContent])),
    [
      [false, 'Strictdefault'],
      [false, 'Offdefault'],
      [false, 'Up to 8Automatic'],
      [false, 'Ondefault'],
      [false, 'Ondefault'],
    ],
    'shut by default: a value and where it comes from, no standing explanation',
  );
  assert.equal(
    await settings
      .getByText(/set-policy/)
      .first()
      .isVisible(),
    false,
  );
  await settings.getByText('Check before the queue').click();
  await settings.getByText(/pays one more check per change/).waitFor();
  assert.match(
    await settings.getByLabel('The command that changes Check before the queue').textContent(),
    /set-policy '\{"acceptance":\{"admissionCheck":VALUE\}\}'/,
  );
  await settings
    .locator('details[open]')
    .getByText(/the change waits for your approval on the web\. Once it applies, landings waiting/)
    .waitFor();
  await layouts('checks-settings-open');

  await page.goto('https://forge.test/-/example/parser/settings/checks?nomirror=1');
  await page.getByRole('link', { name: 'Turn on the mirror' }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: /^Use / }).count(),
    0,
    'nothing to press while the mirror is off',
  );
  await layouts('checks-mirror-off');

  // No CI file on main: "No CI yet" is chosen ahead, one root read, and both places a command can run are offered.
  await page.goto('https://forge.test/-/example/parser/settings/checks?none=1');
  const none = page.getByRole('radio', { name: /No CI yet/ });
  await page.getByRole('link', { name: 'How to set up a machine you run' }).waitFor();
  assert.equal(await none.getAttribute('aria-checked'), 'true');
  await page.getByRole('link', { name: 'How to set up Forge’s check workflow' }).waitFor();
  assert.equal(
    (await page.evaluate(() => window.calls)).filter(c => c.name === 'projectCodeBrowse:read').length,
    1,
    'no .github folder: the workflows folder is not read',
  );
  await page.getByRole('radio', { name: /GitHub Actions/ }).click();
  await page.getByText(/has no workflow file on main/).waitFor();
  await layouts('checks-none');

  // Another CI's file on main: that CI is chosen ahead and leads to a route that works today.
  await page.goto('https://forge.test/-/example/parser/settings/checks?gitlab=1');
  const gitlab = page.getByRole('radio', { name: /GitLab CI/ });
  await page.getByText('Forge cannot publish to GitLab yet', { exact: false }).waitFor();
  assert.equal(await gitlab.getAttribute('aria-checked'), 'true');
  assert.match(await gitlab.textContent(), /\.gitlab-ci\.yml on main/);
  await page.getByRole('link', { name: 'How to set up a machine you run' }).waitFor();
  await layouts('checks-gitlab');
  await page.getByRole('radio', { name: /Another CI/ }).click();
  await page.getByRole('link', { name: 'How to set up a machine you run' }).waitFor();
  assert.equal(await page.getByText('Forge cannot publish to GitLab yet', { exact: false }).count(), 0);

  await page.goto('https://forge.test/-/new?start=1');
  await page.getByRole('button', { name: 'Connect your agent app yourself' }).click();
  // Before a pick no app is pressed and the steps every app shares are already there.
  await page.getByRole('list', { name: 'Steps for any agent app' }).waitFor();
  assert.equal(await page.locator('[aria-label="Your agent app"] [aria-pressed="true"]').count(), 0);
  await layouts('start-any');
  await page.getByRole('button', { name: 'Cursor', exact: true }).click();
  assert.match(
    await page.getByRole('list', { name: 'Steps for Cursor' }).textContent(),
    /\.cursor\/mcp\.json/,
  );
  await layouts('start-cursor');
  assert.deepEqual(errors, []);
});
