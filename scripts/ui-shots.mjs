// SPDX-License-Identifier: Apache-2.0
import { routeUrlState, projectIdentity } from '../src/project-routes.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { deadlineConvexClient } from '../dist/network-convex-client.js';
import { makeFunctionReference } from 'convex/server';
import { options, usage, destination, selectedReviewRoute, ShotError } from './ui-shots/options.mjs';
import {
  botBrowserIdentity,
  launchBotBrowser,
  observeBotSession,
  signIn,
  waitForPage,
} from './ui-shots/browser.mjs';
import { readBotCredentials, botHandle } from './ui-shots/bot-credentials.mjs';
import { passkeyDestination, passkeyLaneFile } from './ui-shots/passkey-routes.mjs';
import { observeData } from './ui-shots/data.mjs';
import { BotNoReaderGrant, explainBotAccess } from './ui-bot-grant.mjs';
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
    const { captureLanding } = await import('./ui-shots/landing.mjs');
    await captureLanding(config);
  } else {
    stage = 'credentials';
    const credentials = await readBotCredentials(config.credentials, config.base);
    const passkey = credentials.kind === 'passkey';
    // The Clerk flow drove the earlier screens, which the site no longer serves (Item b0704959).
    if (!passkey && config.pages.some(p => p !== 'device'))
      throw new ShotError(
        'The earlier screens are no longer served. Enroll the bot passkey (scripts/ui-bot-setup.mjs) and capture again.',
      );
    const projectId = config.project || credentials.projectId;
    const needsProject = config.pages.some(
      p => p !== 'device' && !(passkey && ['home', 'settings:devices'].includes(p)),
    );
    if (needsProject && !projectId) throw new ShotError('Set --project or credentials.projectId.');
    if (
      passkey &&
      config.pages.some(p => p.startsWith('lane:')) &&
      config.variants.some(v => v !== 'unified')
    )
      throw new ShotError('The requested Lane variants are only available in the Clerk screenshot flow.');
    if (!passkey && config.pages.includes('stats'))
      throw new ShotError('Stats is only available in the native screenshot flow.');
    stage = 'launch (install Chromium with npx playwright install chromium)';
    browser = await launchBotBrowser(credentials);
    const context = await browser.newContext({
      ...(await botBrowserIdentity(browser, credentials)),
      viewport: { width: config.widths[0], height: config.height },
    });
    const page = await context.newPage();
    const timeout = 60_000;
    page.setDefaultTimeout(timeout);
    const settled = observeData(page, credentials.deployment);
    const session = observeBotSession(page, credentials);
    let runtimeError = false;
    page.on('pageerror', () => {
      runtimeError = true;
    });
    stage = 'browser sign-in';
    await signIn(page, config.base, credentials, session, timeout);
    stage = 'project access';
    // Use this site's actual deployment and the bot's browser identity. Queries only; no admin key.
    async function query(name, args) {
      const token = await session.readyToken(timeout);
      const deployment = session.deployment();
      if (!token || !deployment) throw new ShotError('Could not identify the signed-in Convex connection.');
      const client = deadlineConvexClient(deployment, { logger: false });
      client.setAuth(token);
      return client.query(makeFunctionReference(name), args);
    }
    let workspace, identity;
    if (needsProject) {
      if (!passkey) {
        await page.goto(destination(config.base, projectId, 'now'), { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => Boolean(window.Clerk?.session));
        try {
          await query('projectWork:state', { projectId });
        } catch (error) {
          throw explainBotAccess(error, session.deployment(), projectId);
        }
        const raw = await query('projectWorkIndex:workspace', { projectId });
        if (!raw)
          throw new ShotError('Project Work is not indexed yet. Open the project and retry after it loads.');
        workspace = JSON.parse(raw);
      }
      identity = await query('urlProjects:resolve', { projectId });
      if (passkey && !identity) throw new BotNoReaderGrant(session.deployment(), projectId, credentials.kind);
      if (passkey && identity?.id !== projectId)
        throw new ShotError('Could not resolve the requested project.');
      if (!passkey && identity) projectIdentity(identity.id, identity.handle, identity.name, identity.slug);
    }
    const routes = [];
    for (const selected of config.pages) {
      const [kind, id] = selected.split(':');
      if (passkey) {
        routes.push({ selected, kind, url: passkeyDestination(config.base, identity, selected, config) });
        continue;
      }
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
            await waitForPage(page, route.kind, passkey);
            if (passkey && config.diffFile && route.kind === 'lane') {
              await passkeyLaneFile(page, config.diffFile).click();
              await page.getByLabel(`Changes to ${config.diffFile}`, { exact: true }).waitFor();
            }
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
            if (
              !passkey &&
              variant !== 'map' &&
              config.diffFile &&
              ['lane', 'review', 'view'].includes(route.kind)
            ) {
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
            if (passkey) {
              if (page.url() !== route.url) throw new ShotError('Navigation left the requested route.');
              if ((await session.waitForViewer(timeout)) !== botHandle)
                throw new ShotError('Signed-in identity does not match the configured bot.');
            } else if (route.kind === 'review') {
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
