// SPDX-License-Identifier: Apache-2.0
// Item 16093ed1, in a real browser on synthetic worst-case data (tests/browser/setting-change.tsx): a held settings
// change never scrolls the page sideways at desk or phone width, no direction override or zero-width character reaches
// the page as an acting character (each shows as a marker), and axe is clean in both themes, on the approve page's
// tokens and the design system's, compared or not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const axePath = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
const FIXTURE = 'tests/browser/setting-change.tsx';

async function buildFixture(out) {
  const { build } = await import(pathToFileURL(join(root, 'node_modules/vite/dist/node/index.js')).href);
  const result = await build({
    configFile: join(root, 'web/vite.config.ts'),
    root: join(root, 'web'),
    mode: 'hosted',
    logLevel: 'error',
    build: { outDir: out, emptyOutDir: true, rolldownOptions: { input: { fixture: join(root, FIXTURE) } } },
  });
  const output = (Array.isArray(result) ? result[0] : result).output;
  const entry = output.find(item => item.isEntry && item.facadeModuleId?.endsWith(FIXTURE));
  const css = output.filter(item => item.fileName.endsWith('.css')).map(item => item.fileName);
  return ds =>
    `<!doctype html><html lang="en" ${ds ? 'data-ds' : ''} data-theme="dark"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>Settings change fixture</title>${css.map(file => `<link rel="stylesheet" href="/${file}">`).join('')}</head><body style="margin:0;background:var(--bg, var(--fx-bg));color:var(--text, var(--fx-text))"><div id="root"></div><script type="module" src="/${entry.fileName}"></script></body></html>`;
}

test('a held settings change: no sideways scroll, hidden characters shown, axe clean', async t => {
  if (!existsSync(chromium.executablePath())) return t.skip('Playwright Chromium is not installed.');
  const out = mkdtempSync(join(tmpdir(), 'forge-setting-change-'));
  const page = await buildFixture(out);
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture');
    if (url.pathname === '/') {
      response.setHeader('content-type', 'text/html');
      return response.end(page(url.searchParams.has('ds')));
    }
    const file = join(out, url.pathname);
    if (!file.startsWith(out) || !existsSync(file)) return response.writeHead(404).end();
    response.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : 'text/css');
    response.end(readFileSync(file));
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const browser = await chromium.launch();
  try {
    for (const ds of [false, true])
      for (const none of [false, true])
        for (const width of [1440, 390, 375]) {
          const context = await browser.newContext({ viewport: { width, height: 900 } });
          const tab = await context.newPage();
          await tab.goto(
            `http://127.0.0.1:${server.address().port}/?${ds ? 'ds&' : ''}${none ? 'none' : ''}`,
          );
          await tab.waitForSelector('.sc');
          assert.equal(
            await tab.evaluate(() => document.querySelector('.sc-details').open),
            none,
            'Details opens only when nothing was compared',
          );
          await tab.evaluate(() => (document.querySelector('.sc-details').open = true));
          await tab.addScriptTag({ path: axePath });
          for (const theme of ['dark', 'light']) {
            const where = `${ds ? 'design system' : 'approve page'} ${none ? 'uncompared' : 'compared'} ${width} ${theme}`;
            await tab.evaluate(value => (document.documentElement.dataset.theme = value), theme);
            const [scroll, inner] = await tab.evaluate(() => [
              document.documentElement.scrollWidth,
              innerWidth,
            ]);
            assert.ok(scroll <= inner, `no sideways scroll, ${where}: ${scroll} > ${inner}`);
            const text = await tab.evaluate(() => document.body.innerText);
            assert.ok(!/[‪-‮⁦-⁩​]/.test(text), `no acting hidden character, ${where}`);
            assert.match(text, none ? /\\u202e/ : /U\+202E/, `the override shows, ${where}`);
            if (!none) assert.match(text, /U\+0430/, `the look-alike letter shows its code point, ${where}`);
            const violations = await tab.evaluate(async () =>
              (
                await window.axe.run(document, {
                  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
                })
              ).violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`),
            );
            assert.deepEqual(violations, [], `axe, ${where}`);
          }
          await context.close();
        }
  } finally {
    await browser.close();
    server.close();
    rmSync(out, { recursive: true, force: true });
  }
});
