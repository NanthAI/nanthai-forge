// SPDX-License-Identifier: AGPL-3.0-only
// Synthetic component proof: no hosted credentials, deployments or project writes.
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export async function captureBootstrap(config) {
  const entry = `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { ConvexProvider } from 'convex/react';
    import NewHostedProject, { HostedProjectWelcome } from '/src/NewHostedProject.tsx';
    import '/src/legacy.css';
    import '/src/ui/tokens.css';
    import '/src/ui/components.css';
    import '/src/project-home.css';
    const h = React.createElement;
    let calls = [];
    window.bootstrapCalls = calls;
    const client = { action: async (_ref, input) => {
      calls.push(input);
      if (calls.length === 1) throw new Error('Synthetic lost response');
      return 'synthetic-project';
    }};
    function Fixture() {
      const [created, setCreated] = React.useState(false);
      return h(ConvexProvider, { client }, h('main', { className: 'fx', style: { padding: 24, maxWidth: 720, margin: '0 auto' } },
        created ? h(HostedProjectWelcome, { addAgent() {}, importSource() {}, dismiss() {} }) :
        h('section', { className: 'fx-panel', style: { padding: 24 } }, h('h2', null, 'New project'), h(NewHostedProject, { created: () => setCreated(true) }))));
    }
    createRoot(document.getElementById('root')).render(h(Fixture));
  `;
  const server = await createServer({
    root: resolve('web'),
    configFile: false,
    envDir: false,
    server: { host: '127.0.0.1', port: 0 },
    plugins: [
      {
        name: 'bootstrap-proof',
        configureServer(server) {
          server.middlewares.use('/__bootstrap', async (_req, res) => {
            res.setHeader('Content-Type', 'text/html');
            res.end(
              await server.transformIndexHtml(
                '/__bootstrap',
                '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/@id/virtual:bootstrap-proof"></script></body></html>',
              ),
            );
          });
        },
        resolveId(id) {
          if (id === 'virtual:bootstrap-proof') return id;
        },
        load(id) {
          if (id === 'virtual:bootstrap-proof') return entry;
        },
      },
    ],
  });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch();
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await mkdir(config.out, { recursive: true, mode: 0o700 });
    const shots = [];
    for (const theme of config.themes)
      for (const width of config.widths) {
        await page.setViewportSize({ width, height: config.height });
        await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
        await page.goto(`${server.resolvedUrls.local[0]}__bootstrap`);
        await page.evaluate(theme => (document.documentElement.dataset.theme = theme), theme);
        await page.getByLabel('Project name', { exact: true }).fill('Synthetic project');
        for (const stage of ['new-project', 'empty-project']) {
          if (stage === 'empty-project') {
            await page.getByRole('button', { name: 'Create project', exact: true }).click();
            await page.getByRole('button', { name: 'Retry creation', exact: true }).click();
            await page.getByRole('heading', { name: 'Your project is ready' }).waitFor();
            const calls = await page.evaluate(() => window.bootstrapCalls);
            if (calls.length !== 2 || JSON.stringify(calls[0]) !== JSON.stringify(calls[1]))
              throw new Error('Creation retry changed its operation or payload.');
          }
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
          if (overflow) throw new Error(`Bootstrap overflow at ${width}px.`);
          const file = `${stage}-${width}-${theme}.png`;
          await page.screenshot({ path: join(config.out, file), fullPage: true });
          shots.push({ file, width, theme, stage });
        }
      }
    if (errors.length) throw new Error(errors.join('\n'));
    await writeFile(
      join(config.out, `bootstrap-${config.widths.join('-')}-${config.themes.join('-')}.json`),
      JSON.stringify(
        {
          synthetic: true,
          shots,
          checks: {
            retryRetainsOperation: true,
            noHorizontalOverflow: true,
            runtimeErrors: 0,
          },
        },
        null,
        2,
      ) + '\n',
    );
    console.log(`Captured ${shots.length} synthetic bootstrap screenshots in ${config.out}`);
  } finally {
    await browser?.close();
    await server.close();
  }
}
