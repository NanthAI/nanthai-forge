// SPDX-License-Identifier: Apache-2.0
import { routeUrlState, projectIdentity } from '../src/project-routes.ts';
import { readFile, lstat, mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import { captureLanding } from './ui-shots/landing.mjs';
import { options, usage, destination, selectedReviewRoute, ShotError } from './ui-shots/options.mjs';
import { signIn, waitForPage, convexToken } from './ui-shots/browser.mjs';
import { observeData } from './ui-shots/data.mjs';
import { join } from 'node:path';

let stage = 'arguments';
let browser;
const printError = console.error.bind(console);
try {
  const config = options(process.argv.slice(2));
  if (config.help) {
    console.log(usage);
  } else if (config.pages[0] === 'bootstrap') {
    stage = 'synthetic browser bootstrap';
    const { captureBootstrap } = await import('./ui-shots/bootstrap.mjs');
    await captureBootstrap(config);
  } else if (config.pages[0] === 'landing') {
    stage = 'signed-out landing';
    await captureLanding(config);
  } else {
    stage = 'credentials';
    const info = await lstat(config.credentials);
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.uid !== process.getuid?.())
      throw new ShotError('Bot credentials must be a user-owned 0600 regular file.');
    const credentials = JSON.parse(await readFile(config.credentials, 'utf8'));
    if (![credentials.email, credentials.password, credentials.userId].every(v => typeof v === 'string' && v))
      throw new ShotError('Bot credentials need email, password and userId.');
    const projectId = config.project || credentials.projectId;
    if (config.pages.some(p => p !== 'device') && !projectId)
      throw new ShotError('Set --project or credentials.projectId.');
    stage = 'launch (install Chromium with npx playwright install chromium)';
    // Clerk classifies headless/WebDriver browsers as offline during uncached token refresh.
    browser = await chromium.launch({ args: ['--disable-blink-features=AutomationControlled'] });
    const cdp = await browser.newBrowserCDPSession();
    const { userAgent } = await cdp.send('Browser.getVersion');
    await cdp.detach();
    const context = await browser.newContext({
      userAgent: userAgent.replace('HeadlessChrome', 'Chrome'),
      viewport: { width: config.widths[0], height: config.height },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    const settled = observeData(page);
    let deployment;
    page.on('websocket', socket => {
      const url = new URL(socket.url());
      if (url.hostname.endsWith('.convex.cloud')) deployment = `https://${url.hostname}`;
    });
    let runtimeError = false;
    page.on('pageerror', () => {
      runtimeError = true;
    });
    stage = 'Clerk sign-in';
    await signIn(page, config.base, credentials);
    stage = 'project access';
    // Use this site's actual deployment and the bot's browser identity. Queries only; no admin key.
    async function query(name, args) {
      const token = await convexToken(page);
      if (!token || !deployment) throw new ShotError('Could not identify the signed-in Convex connection.');
      const client = new ConvexHttpClient(deployment, { logger: false });
      client.setAuth(token);
      return client.query(makeFunctionReference(name), args);
    }
    let workspace;
    if (config.pages.some(p => p !== 'device')) {
      await page.goto(destination(config.base, projectId, 'now'), { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => Boolean(window.Clerk?.session));
      await query('projectWork:state', { projectId });
      const raw = await query('projectWorkIndex:workspace', { projectId });
      if (!raw)
        throw new ShotError('Project Work is not indexed yet. Open the project and retry after it loads.');
      workspace = JSON.parse(raw);
      const identity = await query('urlProjects:resolve', { projectId });
      if (identity) projectIdentity(identity.id, identity.handle, identity.name, identity.slug);
    }
    const routes = [];
    for (const selected of config.pages) {
      const [kind, id] = selected.split(':');
      let intentId;
      if (kind === 'lane' || kind === 'review') {
        stage = `${kind} selection`;
        const detail = await query('projectWorkIndex:detail', {
          projectId,
          generationId: workspace.generationId,
          collection: kind === 'lane' ? 'lanes' : 'views',
          id,
        });
        if (!detail.value) throw new ShotError(`Requested ${kind} is not in this project's current Work.`);
        intentId = JSON.parse(detail.value).intentId;
      }
      const url = new URL(destination(config.base, projectId, selected, intentId));
      if (kind === 'intents' && config.intentLayout)
        url.searchParams.set('intentLayout', config.intentLayout);
      if (['code', 'code-graph'].includes(kind) && config.diffFile)
        url.searchParams.set('file', config.diffFile);
      routes.push({ selected, kind, url: url.href });
    }
    await mkdir(config.out, { recursive: true, mode: 0o700 });
    const shots = [];
    for (const theme of config.themes) {
      for (const width of config.widths) {
        await page.setViewportSize({ width, height: config.height });
        await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
        await page.evaluate(theme => localStorage.setItem('forge-theme', theme), theme);
        for (const route of routes) {
          for (const variant of ['lane', 'view'].includes(route.kind) ? config.variants : ['unified']) {
            stage = `${route.selected} ${width}px ${theme} ${variant}`;
            await page.evaluate(variant => {
              localStorage.setItem(
                'forge.diff.mode',
                ['split', 'inline'].includes(variant) ? variant : 'unified',
              );
              localStorage.setItem('forge.lane.side', variant === 'side-closed' ? 'closed' : 'open');
              localStorage.setItem('forge.lane.files', variant === 'files-closed' ? 'closed' : 'open');
            }, variant);
            runtimeError = false;
            await page.goto(route.url, { waitUntil: 'domcontentloaded' });
            await settled(route.kind !== 'device');
            await waitForPage(page, route.kind);
            if (variant === 'map') {
              await page
                .getByRole('group', { name: 'Changed file display' })
                .getByRole('button', { name: 'Map', exact: true })
                .click();
              await page
                .locator('.fx-change-map')
                .locator('svg[aria-label="File import graph"], [role="alert"], .code-graph-empty')
                .first()
                .waitFor();
            }
            if (variant !== 'map' && config.diffFile && ['lane', 'review', 'view'].includes(route.kind)) {
              if (route.kind === 'view') {
                const file = page
                  .locator('.fx-provenance-file')
                  .filter({ has: page.locator('summary code', { hasText: config.diffFile }) });
                await file.locator('summary').click();
                await file.getByRole('button', { name: 'Show line attribution' }).click();
                await file.locator('.fx-provenance-lines table').waitFor();
              } else {
                await page.locator('.fx-files button').filter({ hasText: config.diffFile }).click();
                await page.locator('.fx-diff').waitFor();
              }

              await waitForPage(page, route.kind);
            }
            await settled(route.kind !== 'device');
            if (runtimeError)
              throw new ShotError(
                'The page raised a JavaScript runtime error; no successful screenshot recorded.',
              );
            const requested = routeUrlState(route.url),
              observed = routeUrlState(page.url());
            if (route.kind === 'review') {
              if (!selectedReviewRoute(page.url(), route.url, projectId, route.selected.split(':')[1]))
                throw new ShotError('Navigation left the requested route.');
            } else {
              for (const key of ['project', 'projectTab', 'intent', 'lane', 'reviewView', 'viewId']) {
                if (route.kind === 'settings' && key === 'projectTab') continue;
                if (
                  requested.searchParams.has(key) &&
                  requested.searchParams.get(key) !== observed.searchParams.get(key)
                )
                  throw new ShotError('Navigation left the requested route.');
              }
              if (
                route.kind === 'settings' &&
                observed.searchParams.get('settingsSection') !== (route.selected.split(':')[1] || 'general')
              )
                throw new ShotError('Navigation left the requested Settings page.');
              if (
                requested.origin !== observed.origin ||
                (route.kind === 'device' && new URL(page.url()).pathname !== '/device')
              )
                throw new ShotError('Navigation left the requested route.');
            }
            const name = `${route.selected.replace(':', '-')}-${width}-${theme}${variant === 'unified' ? '' : `-${variant}`}`;
            const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
            if (scrollWidth > width)
              throw new ShotError(`Page overflows its ${width}px viewport (${scrollWidth}px).`);
            // Both the first viewport and full page matter: tall legacy wrappers can hide the cockpit.
            await page.screenshot({ path: join(config.out, `${name}.png`), animations: 'disabled' });
            await page.screenshot({
              path: join(config.out, `${name}-full.png`),
              fullPage: true,
              animations: 'disabled',
            });
            const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
            shots.push({
              pageWidth,
              page: route.selected,
              variant,
              width,
              height: config.height,
              theme,
              url: page.url(),
              viewport: `${name}.png`,
              fullPage: `${name}-full.png`,
            });
            console.log(
              `Saved ${name}.png and ${name}-full.png${pageWidth > width ? ` · OVERFLOW ${pageWidth}px` : ''}`,
            );
          }
        }
      }
    }
    await writeFile(
      join(config.out, 'manifest.json'),
      JSON.stringify({ base: config.base, projectId, capturedAt: new Date().toISOString(), shots }, null, 2) +
        '\n',
      { mode: 0o600 },
    );
  }
} catch (error) {
  const code = /^[A-Z_]+$/.test(error?.data?.code) ? ` (${error.data.code})` : '';
  // Never print library errors, stacks, browser logs, network bodies or credentials.
  printError(
    `ui-shots failed during ${stage}${code}: ${error instanceof ShotError ? error.message : 'Details redacted. Check credentials, access, connectivity and page readiness.'}`,
  );
  process.exitCode = 1;
} finally {
  await browser?.close();
}
