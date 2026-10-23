// SPDX-License-Identifier: Apache-2.0
import { readFile, lstat } from 'node:fs/promises';
import { chromium } from 'playwright';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import { signIn, convexToken } from '../ui-shots/browser.mjs';
import { destination } from '../ui-shots/options.mjs';
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
    const info = await lstat(config.credentials);
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.uid !== process.getuid?.())
      throw new Error('PERF_CREDENTIALS');
    const credentials = JSON.parse(await readFile(config.credentials, 'utf8'));
    if (![credentials.email, credentials.password, credentials.userId].every(v => typeof v === 'string' && v))
      throw new Error('PERF_CREDENTIALS');
    const project = config.project || credentials.projectId;
    if (!project) throw new Error('PERF_PROJECT');
    browser = await chromium.launch({ args: ['--disable-blink-features=AutomationControlled'] });
    const cdp = await browser.newBrowserCDPSession();
    const { userAgent: rawAgent } = await cdp.send('Browser.getVersion');
    await cdp.detach();
    const userAgent = rawAgent.replace('HeadlessChrome', 'Chrome');
    const auth = await browser.newContext({ userAgent });
    const signInPage = await auth.newPage();
    let deployment;
    signInPage.on('websocket', socket => {
      const url = new URL(socket.url());
      if (url.hostname.endsWith('.convex.cloud')) deployment = `https://${url.hostname}`;
    });
    signInPage.setDefaultTimeout(config.timeout);
    await signIn(signInPage, config.base, credentials);
    // Resolve canonical readable URLs before timing, using this site's current read authority.
    await signInPage.goto(destination(config.base, project, 'now'), { waitUntil: 'domcontentloaded' });
    await signInPage.waitForFunction(() => Boolean(window.Clerk?.session));
    const token = await convexToken(signInPage);
    if (!token || !deployment) throw new Error('PERF_PROJECT_CONNECTION');
    const client = new ConvexHttpClient(deployment, { logger: false });
    client.setAuth(token);
    const identity = await client.query(makeFunctionReference('urlProjects:resolve'), { projectId: project });
    if (!identity) throw new Error('PERF_PROJECT_IDENTITY');
    projectIdentity(identity.id, identity.handle, identity.name, identity.slug);
    // In memory only; no cookies, tokens, emails or browser storage are persisted.
    const storageState = await auth.storageState();
    await auth.close();
    for (const [kind, pageName, marker] of [
      ['now', 'now', 'Now'],
      ['work', 'intents', 'Work'],
      ['laneFirstDiff', `lane:${config.lane}`, 'Lane'],
    ]) {
      if (kind === 'laneFirstDiff' && !config.lane) continue;
      for (let i = 0; i < config.samples; i++) {
        const context = await browser.newContext({
          storageState,
          userAgent,
          serviceWorkers: 'block',
          viewport: { width: 1500, height: 1000 },
        });
        const page = await context.newPage();
        let runtimeError = false;
        page.on('pageerror', () => {
          runtimeError = true;
        });
        const session = await context.newCDPSession(page);
        await session.send('Network.enable');
        await session.send('Network.setCacheDisabled', { cacheDisabled: true });
        const requested = destination(config.base, project, pageName);
        const startedAt = new Date().toISOString();
        try {
          await page.goto(requested, { waitUntil: 'domcontentloaded', timeout: config.timeout });
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
              authenticated: Boolean(window.Clerk?.user),
              hasAlert: [...document.querySelectorAll('[role="alert"]')].some(
                e => visible(e) && e.textContent.trim(),
              ),
              hasDiff: [...document.querySelectorAll('.fx-diff')].some(visible),
            };
          }, marker);
          const actual = routeUrlState(page.url()),
            expected = routeUrlState(requested);
          const routeMatches =
            new URL(page.url()).origin === new URL(requested).origin &&
            ['project', 'projectTab', 'lane'].every(
              key => expected.searchParams.get(key) === actual.searchParams.get(key),
            );
          if (!successfulSample({ ...observed, runtimeError, routeMatches }, kind))
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
          result[kind].push({
            startedAt,
            endedAt: new Date().toISOString(),
            durationMs: null,
            reason:
              'Navigation, authentication, readiness marker or successful source diff was unavailable. No page content or error payload retained.',
          });
        } finally {
          await context.close();
        }
      }
    }
    return {
      samples: result,
      browserVersion: browser.version(),
      reason: config.lane
        ? undefined
        : 'Lane first diff unrun: supply a retained --lane with available base/head and changed files.',
    };
  } finally {
    await browser?.close();
  }
}
