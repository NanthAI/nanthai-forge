// SPDX-License-Identifier: Apache-2.0
import { ShotError } from './options.mjs';

export async function signIn(page, base, credentials) {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.Clerk?.loaded);
  if (await page.evaluate(() => Boolean(window.Clerk.user)))
    throw new ShotError('Expected a fresh browser session.');
  await page.getByRole('button', { name: 'Sign in', exact: true }).first().click();
  const identifier = page.locator('input[name="identifier"]');
  await identifier.fill(credentials.email);
  await page.getByRole('button', { name: /^Continue$/ }).click();
  const password = page.locator('input[name="password"]');
  await password.fill(credentials.password);
  // Clerk renders the code input before its asynchronous send has completed.
  const prepared = page
    .waitForResponse(
      response =>
        /\/prepare_(?:first|second)_factor$/.test(new URL(response.url()).pathname) && response.ok(),
    )
    .then(response => response.finished())
    .catch(() => false);
  await page.getByRole('button', { name: /^Continue$/ }).click();
  // Clerk DEV test emails can require a new-device email code. No real email is sent.
  await page.waitForFunction(
    () =>
      Boolean(window.Clerk?.user) || Boolean(document.querySelector('input[autocomplete="one-time-code"]')),
  );
  if (!(await page.evaluate(() => Boolean(window.Clerk.user)))) {
    if (!credentials.email.includes('+clerk_test'))
      throw new ShotError('Sign-in requires an email code. Use a Clerk DEV test email.');
    if ((await prepared) === false) throw new ShotError('Clerk did not prepare DEV email verification.');
    const code = page.locator('input[autocomplete="one-time-code"]');
    // Clerk submits a complete six-digit code automatically.
    await code.fill('424242');
  }
  await page.waitForFunction(() => Boolean(window.Clerk?.user));
  const identity = await page.evaluate(() => ({
    id: window.Clerk.user.id,
    emails: window.Clerk.user.emailAddresses.map(e => e.emailAddress),
  }));
  if (identity.id !== credentials.userId || !identity.emails.includes(credentials.email))
    throw new ShotError('Signed-in identity does not match the configured bot.');
}

export async function waitForPage(page, kind) {
  await page.waitForFunction(kind => {
    const visible = element =>
      Boolean(element.getClientRects().length) && getComputedStyle(element).visibility !== 'hidden';
    const main = document.querySelector('main');
    if (!main || !window.Clerk?.user) return false;
    // Source may itself contain strings such as "Reading…"; those are review content.
    const text = [...main.querySelectorAll('p,h1,h2,h3,[role="status"]')]
      .filter(element => visible(element) && !element.closest('.fx-diff,.review-code,pre,code'))
      .map(element => element.textContent)
      .join('\n');
    if (/(?:Loading|Connecting|Checking|Reading|Preparing)[^\n]*(?:…|\.\.\.)/.test(text)) return false;
    const headings = [...main.querySelectorAll('h1,h2,h3')].filter(visible).map(e => e.textContent.trim());
    const patterns = {
      now: /^Now$/,
      intents: /^(Intents|Work)$/,
      lanes: /^(Lanes|Work)$/,
      home: /^Projects$/,
      settings:
        /^(?:General|How agents work|Autonomy|Checks|Access|Backups|Transfer & backups|Contributions|Appearance|Signed-in devices|GitHub)$/,
      planning: /^(Planning|Work)$/,
      activity: /^Activity$/,
      code: /^Code$/,
      'code-graph': /^Code$/,
      lane: /.+/,
      intent: /.+/,
      initiative: /.+/,
      view: /^View /,
      review: /.+/,
      device: /terminal|device|computer/i,
    };
    if (!headings.some(h => patterns[kind].test(h))) return false;
    if (kind === 'initiative' && !main.querySelector('.fx-initiative')) return false;
    if (kind === 'review' && !main.querySelector('.fx-review-page')) return false;
    if (kind === 'lane' && !main.querySelector('.fx-lane-page, .lane-context-bar')) return false;
    return ![...main.querySelectorAll('[role="alert"]')].some(e => visible(e) && e.textContent.trim());
  }, kind);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      [...document.images]
        .filter(i => !i.complete)
        .map(
          i =>
            new Promise(resolve => {
              i.onload = i.onerror = resolve;
            }),
        ),
    );
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

/** Match ConvexProviderWithClerk: the native integration uses the normal session JWT. */
export async function convexToken(page) {
  return page.evaluate(async () => {
    const session = window.Clerk?.session;
    if (!session) return null;
    const token = await session.getToken();
    if (!token) return null;
    const claims = JSON.parse(atob(token.split('.')[1].replaceAll('-', '+').replaceAll('_', '/')));
    return claims.aud === 'convex' ? token : session.getToken({ template: 'convex' });
  });
}
