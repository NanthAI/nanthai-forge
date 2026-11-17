// SPDX-License-Identifier: Apache-2.0
// Docs are independently readable static pages: no auth/backend, safe Markdown, current contracts, and a usable tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, existsSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium } from 'playwright';
import { hostedAgentHelpEntries } from '../dist/hosted-agent-help.js';
const root = fileURLToPath(new URL('../', import.meta.url));
const axePath = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
const read = (out, path) => readFileSync(join(out, path), 'utf8');

test('docs are static, contract-generated and usable without account or backend calls at both widths and themes', async t => {
  const out = mkdtempSync(join(tmpdir(), 'forge-docs-site-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  await build({
    root: join(root, 'web'),
    configFile: join(root, 'web/vite.config.ts'),
    mode: 'hosted',
    logLevel: 'error',
    build: {
      outDir: out,
      emptyOutDir: true,
      rolldownOptions: { input: { docs: join(root, 'web/docs.html') } },
    },
  });
  const home = read(out, 'docs/index.html');
  assert.match(home, /<h1 id="forge-documentation">Forge documentation<\/h1>/);
  assert.match(home, /Your first project/);
  assert.doesNotMatch(home, /<!--docs-content-->|\/src\//);
  // Every docs page links the draft Terms and Privacy pages (a9f4654f).
  assert.match(home, /<a href="\/-\/terms">Terms<\/a><a href="\/-\/privacy">Privacy policy<\/a>/);
  const cli = read(out, 'docs/reference/cli.md');
  for (const entry of hostedAgentHelpEntries) {
    assert.ok(cli.includes(`## ${entry.command}\n`), entry.command);
    assert.ok(cli.includes(JSON.stringify(entry.schema, null, 2)), `${entry.command} schema drift`);
  }
  assert.match(read(out, 'docs/reference/errors.md'), /COMPOSITION_CONFLICT.*help conflict/);
  const mcp = read(out, 'docs/reference/mcp.md');
  for (const name of [
    'forge_task',
    'forge_check',
    'forge_planning',
    'forge_current',
    'forge_source',
    'forge_review',
    'forge_wait',
    'forge_work_overview',
  ])
    assert.ok(mcp.includes(`## ${name}\n`), name);
  for (const name of [
    'forge_context',
    'forge_inspect',
    'forge_reindex',
    'forge_coordination_watch',
    'forge_hosted_work',
  ])
    assert.ok(mcp.includes(`### ${name}\n`), `${name} source contract`);
  assert.doesNotMatch(cli, /^## (?:put-issue|comment-issue|issues)\b/m);
  // Every docs link on the landing is an emitted page or Markdown asset, including first-run destinations.
  for (const [, url] of home.matchAll(/href="(\/docs\/[^"#]*)(?:#[^"]*)?"/g))
    assert.ok(existsSync(join(out, url.endsWith('/') ? `${url}index.html` : url)), url);
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    const file = join(out, path.endsWith('/') ? `${path}index.html` : path);
    if (!existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }
    res.setHeader(
      'Content-Type',
      {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.woff2': 'font/woff2',
        '.svg': 'image/svg+xml',
      }[extname(file)] ?? 'text/plain',
    );
    res.end(readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await t.test(
    'docs tree, copy, keyboard, accessibility and no-JavaScript reading in both themes and widths',
    { skip: !existsSync(chromium.executablePath()) && 'Playwright Chromium is not installed.' },
    async t => {
      const browser = await chromium.launch({ headless: true });
      t.after(() => browser.close());
      for (const width of [1440, 390])
        for (const theme of ['dark', 'light']) {
          const context = await browser.newContext({
            viewport: { width, height: width === 390 ? 844 : 1000 },
            permissions: ['clipboard-read', 'clipboard-write'],
          });
          const page = await context.newPage();
          const errors = [],
            backend = [];
          page.on('pageerror', error => errors.push(error.message));
          page.on('request', request => {
            if (!request.url().startsWith(origin)) backend.push(request.url().split('?')[0]);
          });
          await page.addInitScript(theme => localStorage.setItem('forge-theme', theme), theme);
          await page.goto(`${origin}/docs/`);
          await page.locator('h1').waitFor();
          assert.equal(await page.title(), 'Forge documentation · Forge docs');
          assert.equal(await page.locator('h1').innerText(), 'Forge documentation');
          assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme);
          await page.addScriptTag({ path: axePath });
          const violations = await page.evaluate(async () =>
            (await axe.run(document, { rules: { 'color-contrast': { enabled: true } } })).violations.map(
              item => ({ id: item.id, nodes: item.nodes.map(node => node.target) }),
            ),
          );
          assert.deepEqual(violations, [], `${width}/${theme} accessibility`);
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
            false,
            `${width}/${theme} sideways scroll`,
          );
          if (process.env.FORGE_DOCS_SHOTS) {
            mkdirSync(process.env.FORGE_DOCS_SHOTS, { recursive: true });
            await page.screenshot({
              path: join(process.env.FORGE_DOCS_SHOTS, `docs-${width}-${theme}.png`),
              fullPage: false,
            });
          }
          if (width === 390) await page.locator('.docs-contents > summary').click();
          const search = page.getByRole('searchbox');
          await search.fill('no-page-with-this-title');
          assert.equal(
            await page.getByRole('status').filter({ hasText: 'No matching pages' }).isVisible(),
            true,
          );
          await search.fill('Review and land');
          await page
            .getByRole('navigation', { name: 'Documentation', exact: true })
            .getByRole('link', { name: 'Review and land a change', exact: true })
            .click();
          await page.locator('h1').waitFor();
          assert.equal(await page.locator('h1').innerText(), 'Review and land a change');
          await page.getByRole('button', { name: 'Copy code' }).first().click();
          await page.waitForFunction(
            () => document.querySelector('.docs-copy-status')?.textContent === 'Copied',
          );
          assert.equal(await page.locator('.docs-copy-status').first().textContent(), 'Copied');
          assert.match(await page.evaluate(() => navigator.clipboard.readText()), /nforge agent ROOT status/);
          await page.keyboard.press('Tab');
          assert.ok(await page.evaluate(() => document.activeElement !== document.body));
          assert.deepEqual(errors, []);
          assert.deepEqual(backend, [], 'docs make no auth, Convex or remote asset calls');
          assert.deepEqual(await context.cookies(), [], 'docs set no cookies');
          await context.close();
        }
      const noJs = await browser.newContext({ javaScriptEnabled: false });
      const page = await noJs.newPage();
      await page.goto(`${origin}/docs/guides/agents/`);
      assert.equal(await page.locator('h1').innerText(), 'Start a Lane and land it');
      assert.ok((await page.locator('pre').first().innerText()).includes('nforge mcp ROOT --agent'));
      await page
        .getByRole('link', { name: 'Import GitHub source into a hosted project', exact: true })
        .click();
      assert.equal(await page.locator('h1').innerText(), 'Import GitHub source into a hosted project');
      await noJs.close();
    },
  );
});
