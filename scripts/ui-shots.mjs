// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { mkdir, writeFile } from 'node:fs/promises';
import { deadlineConvexClient } from '../dist/network-convex-client.js';
import { makeFunctionReference } from 'convex/server';
import { options, usage, ShotError } from './ui-shots/options.mjs';
import { launchBotBrowser, observeBotSession, signIn, waitForPage } from './ui-shots/browser.mjs';
import { readBotCredentials, botHandle } from './ui-shots/bot-credentials.mjs';
import { passkeyDestination, passkeyLaneFile } from './ui-shots/passkey-routes.mjs';
import { observeData } from './ui-shots/data.mjs';
import { BotNoReaderGrant } from './ui-bot-grant.mjs';
import { join } from 'node:path';

let stage = 'arguments';
let browser;
const printError = console.error.bind(console);
try {
  const config = options(process.argv.slice(2));
  if (config.help) {
    console.log(usage);
  } else if (config.pages[0] === 'landing') {
    stage = 'signed-out landing';
    const { captureLanding } = await import('./ui-shots/landing.mjs');
    await captureLanding(config);
  } else {
    stage = 'credentials';
    const credentials = await readBotCredentials(config.credentials, config.base);
    const projectId = config.project || credentials.projectId;
    const needsProject = config.pages.some(p => !['home', 'settings:devices', 'device'].includes(p));
    if (needsProject && !projectId) throw new ShotError('Set --project or credentials.projectId.');
    stage = 'launch (install Chromium with npx playwright install chromium)';
    browser = await launchBotBrowser();
    const context = await browser.newContext({
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
    let identity;
    if (needsProject) {
      identity = await query('urlProjects:resolve', { projectId });
      if (!identity) throw new BotNoReaderGrant();
      if (identity.id !== projectId) throw new ShotError('Could not resolve the requested project.');
    }
    const routes = config.pages.map(selected => ({
      selected,
      kind: selected.split(':')[0],
      url: passkeyDestination(config.base, identity, selected, config),
    }));
    await mkdir(config.out, { recursive: true, mode: 0o700 });
    const shots = [];
    for (const theme of config.themes) {
      for (const width of config.widths) {
        await page.setViewportSize({ width, height: config.height });
        await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
        await page.evaluate(theme => localStorage.setItem('forge-theme', theme), theme);
        for (const route of routes) {
          stage = `${route.selected} ${width}px ${theme}`;
          runtimeError = false;
          await page.goto(route.url, { waitUntil: 'domcontentloaded' });
          await settled(route.kind !== 'device');
          await waitForPage(page, route.kind);
          if (config.diffFile && route.kind === 'lane') {
            await passkeyLaneFile(page, config.diffFile).click();
            await page.getByLabel(`Changes to ${config.diffFile}`, { exact: true }).waitFor();
          }
          await settled(route.kind !== 'device');
          if (runtimeError)
            throw new ShotError(
              'The page raised a JavaScript runtime error; no successful screenshot recorded.',
            );
          if (page.url() !== route.url) throw new ShotError('Navigation left the requested route.');
          if ((await session.waitForViewer(timeout)) !== botHandle)
            throw new ShotError('Signed-in identity does not match the configured bot.');
          const name = `${route.selected.replace(':', '-')}-${width}-${theme}`;
          const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
          if (scrollWidth > width)
            throw new ShotError(`Page overflows its ${width}px viewport (${scrollWidth}px).`);
          // Both the first viewport and the full page matter.
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
