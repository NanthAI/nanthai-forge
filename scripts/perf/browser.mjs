// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { deadlineConvexClient } from '../../dist/network-convex-client.js';
import { makeFunctionReference } from 'convex/server';
import { launchBotBrowser, observeBotSession, signIn } from '../ui-shots/browser.mjs';
import { readBotCredentials } from '../ui-shots/bot-credentials.mjs';
import { passkeyDestination, passkeyLaneFile } from '../ui-shots/passkey-routes.mjs';
import { BotNoReaderGrant } from '../ui-bot-grant.mjs';

export function successfulSample(
  { mark, runtimeError, hasAlert, hasDiff, authenticated, routeMatches },
  kind,
) {
  return Boolean(
    authenticated &&
    routeMatches &&
    !runtimeError &&
    !hasAlert &&
    Number.isFinite(mark?.complete) &&
    mark.complete >= 0 &&
    (kind !== 'laneFirstDiff' || (hasDiff && Number.isFinite(mark.queries?.sourceDiff))),
  );
}

export async function browserSamples(config) {
  const result = { now: [], work: [], laneFirstDiff: [] };
  let browser;
  try {
    const credentials = await readBotCredentials(config.credentials, config.base);
    const project = config.project || credentials.projectId;
    if (!project) throw new Error('PERF_PROJECT');
    browser = await launchBotBrowser();
    const auth = await browser.newContext();
    const signInPage = await auth.newPage();
    const bot = observeBotSession(signInPage, credentials);
    signInPage.setDefaultTimeout(config.timeout);
    await signIn(signInPage, config.base, credentials, bot, config.timeout);
    // Resolve canonical readable URLs before timing, using this site's current read authority.
    const token = await bot.readyToken(config.timeout);
    const deployment = bot.deployment();
    if (!token || !deployment) throw new Error('PERF_PROJECT_CONNECTION');
    const client = deadlineConvexClient(deployment, { logger: false });
    client.setAuth(token);
    const identity = await client.query(makeFunctionReference('urlProjects:resolve'), { projectId: project });
    if (!identity) throw new BotNoReaderGrant();
    if (identity.id !== project) throw new Error('PERF_PROJECT_IDENTITY');
    // In memory only; no cookies, tokens, emails or browser storage are persisted.
    const storageState = await auth.storageState();
    await auth.close();
    for (const [kind, pageName, marker] of [
      ['now', 'now', 'Needs me'],
      ['work', 'intents', 'Plan'],
      ['laneFirstDiff', `lane:${config.lane}`, 'Lane first diff'],
    ]) {
      if (kind === 'laneFirstDiff' && !config.lane) continue;
      for (let i = 0; i < config.samples; i++) {
        const context = await browser.newContext({
          storageState,
          serviceWorkers: 'block',
          viewport: { width: 1500, height: 1000 },
        });
        const page = await context.newPage();
        page.setDefaultTimeout(config.timeout);
        const sampleBot = observeBotSession(page, credentials);
        let runtimeError = false;
        page.on('pageerror', () => {
          runtimeError = true;
        });
        const cdp = await context.newCDPSession(page);
        await cdp.send('Network.enable');
        await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
        const requested = passkeyDestination(config.base, identity, pageName);
        const startedAt = new Date().toISOString();
        try {
          await page.goto(requested, { waitUntil: 'domcontentloaded', timeout: config.timeout });
          if (kind === 'laneFirstDiff') await passkeyLaneFile(page).click();
          await page.waitForFunction(
            marker => Number.isFinite(window.__forgeCritical?.[marker]?.complete),
            marker,
            { timeout: config.timeout },
          );
          const observed = await page.evaluate(marker => {
            const visible = e =>
              Boolean(e.getClientRects().length) && getComputedStyle(e).visibility !== 'hidden';
            return {
              mark: window.__forgeCritical?.[marker],
              hasAlert: [...document.querySelectorAll('[role="alert"]')].some(
                e => visible(e) && e.textContent.trim(),
              ),
              hasDiff: [...document.querySelectorAll('.lr-file .hunk')].some(visible),
            };
          }, marker);
          const routeMatches = page.url() === requested;
          const authenticated = await sampleBot.authenticated();
          if (!successfulSample({ ...observed, authenticated, runtimeError, routeMatches }, kind))
            throw new Error('PERF_PAGE_FAILED');
          result[kind].push({
            startedAt,
            endedAt: new Date().toISOString(),
            durationMs: kind === 'laneFirstDiff' ? observed.mark.queries.sourceDiff : observed.mark.complete,
            firstContentMs: observed.mark.firstContent,
            criticalCompleteMs: observed.mark.complete,
            queries: observed.mark.queries,
          });
        } catch {
          // A signed-in page with no marker object at all is a frontend built without VITE_FORGE_PERF=1.
          const unmarked =
            (await Promise.resolve()
              .then(() => sampleBot.authenticated())
              .catch(() => false)) &&
            (await page.evaluate(() => window.__forgeCritical === undefined).catch(() => false));
          result[kind].push({
            startedAt,
            endedAt: new Date().toISOString(),
            durationMs: null,
            reason: unmarked
              ? 'Signed in, but no readiness marker was observed on the page; the usual cause is a frontend built without VITE_FORGE_PERF=1.'
              : 'Navigation, authentication, readiness marker or successful source diff was unavailable. No page content or error payload retained.',
          });
        } finally {
          await context.close();
        }
      }
    }
    return {
      samples: result,
      browserVersion: browser.version(),
      auth: credentials.kind,
      reason: config.lane
        ? undefined
        : 'Lane first diff unrun: supply a retained --lane with available base/head and changed files.',
    };
  } finally {
    await browser?.close();
  }
}
