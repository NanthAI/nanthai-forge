// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { deadlineConvexClient } from '../../dist/network-convex-client.js';
import { makeFunctionReference } from 'convex/server';
import { botBrowserIdentity, launchBotBrowser, observeBotSession, signIn } from '../ui-shots/browser.mjs';
import { readBotCredentials } from '../ui-shots/bot-credentials.mjs';
import { destination } from '../ui-shots/options.mjs';
import { passkeyDestination, passkeyLaneFile } from '../ui-shots/passkey-routes.mjs';
import { BotNoReaderGrant, explainBotAccess } from '../ui-bot-grant.mjs';
import { routeUrlState, projectIdentity } from '../../src/project-routes.ts';

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
    const passkey = credentials.kind === 'passkey';
    const project = config.project || credentials.projectId;
    if (!project) throw new Error('PERF_PROJECT');
    browser = await launchBotBrowser(credentials);
    const browserIdentity = await botBrowserIdentity(browser, credentials);
    const auth = await browser.newContext(browserIdentity);
    const signInPage = await auth.newPage();
    const bot = observeBotSession(signInPage, credentials);
    signInPage.setDefaultTimeout(config.timeout);
    await signIn(signInPage, config.base, credentials, bot, config.timeout);
    // Resolve canonical readable URLs before timing, using this site's current read authority.
    if (!passkey) {
      await signInPage.goto(destination(config.base, project, 'now'), { waitUntil: 'domcontentloaded' });
      await signInPage.waitForFunction(() => Boolean(window.Clerk?.session));
    }
    const token = await bot.readyToken(config.timeout);
    const deployment = bot.deployment();
    if (!token || !deployment) throw new Error('PERF_PROJECT_CONNECTION');
    const client = deadlineConvexClient(deployment, { logger: false });
    client.setAuth(token);
    if (!passkey) {
      try {
        await client.query(makeFunctionReference('projectWork:state'), { projectId: project });
      } catch (error) {
        throw explainBotAccess(error, deployment, project);
      }
    }
    const identity = await client.query(makeFunctionReference('urlProjects:resolve'), { projectId: project });
    if (passkey && !identity) throw new BotNoReaderGrant(deployment, project, credentials.kind);
    if (identity?.id !== project) throw new Error('PERF_PROJECT_IDENTITY');
    if (!passkey) projectIdentity(identity.id, identity.handle, identity.name, identity.slug);
    // In memory only; no cookies, tokens, emails or browser storage are persisted.
    const storageState = await auth.storageState();
    await auth.close();
    for (const [kind, pageName, legacyMarker, nativeMarker] of [
      ['now', 'now', 'Now', 'Needs me'],
      ['work', 'intents', 'Work', 'Plan'],
      ['laneFirstDiff', `lane:${config.lane}`, 'Lane', 'Lane first diff'],
    ]) {
      if (kind === 'laneFirstDiff' && !config.lane) continue;
      const marker = passkey ? nativeMarker : legacyMarker;
      for (let i = 0; i < config.samples; i++) {
        const context = await browser.newContext({
          storageState,
          ...browserIdentity,
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
        const requested = passkey
          ? passkeyDestination(config.base, identity, pageName)
          : destination(config.base, project, pageName);
        const startedAt = new Date().toISOString();
        try {
          await page.goto(requested, { waitUntil: 'domcontentloaded', timeout: config.timeout });
          if (passkey && kind === 'laneFirstDiff') await passkeyLaneFile(page).click();
          await page.waitForFunction(
            marker => Number.isFinite(window.__forgeCritical?.[marker]?.complete),
            marker,
            { timeout: config.timeout },
          );
          const observed = await page.evaluate(
            ({ marker, passkey }) => {
              const visible = e =>
                Boolean(e.getClientRects().length) && getComputedStyle(e).visibility !== 'hidden';
              return {
                mark: window.__forgeCritical?.[marker],
                hasAlert: [...document.querySelectorAll('[role="alert"]')].some(
                  e => visible(e) && e.textContent.trim(),
                ),
                hasDiff: [...document.querySelectorAll(passkey ? '.lr-file .hunk' : '.fx-diff')].some(
                  visible,
                ),
              };
            },
            { marker, passkey },
          );
          const routeMatches = passkey ? page.url() === requested : legacyRouteMatches(page.url(), requested);
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

function legacyRouteMatches(actualUrl, requested) {
  const actual = routeUrlState(actualUrl),
    expected = routeUrlState(requested);
  return (
    actual.origin === expected.origin &&
    ['project', 'projectTab', 'lane'].every(
      key => expected.searchParams.get(key) === actual.searchParams.get(key),
    )
  );
}
