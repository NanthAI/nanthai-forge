// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { isBotHandle } from './bot-credentials.mjs';
import { observePasskeySession, signInWithPasskey } from './passkey-session.mjs';

export async function launchBotBrowser(options = {}) {
  // Playwright wire logging can include the credential and both browser session tokens.
  // Clear debug output before importing Playwright on either private CLI path.
  delete process.env.DEBUG;
  delete process.env.DEBUG_FILE;
  delete process.env.PWDEBUG;
  const { chromium } = await import('playwright');
  return chromium.launch(options);
}

export function observeBotSession(page, credentials) {
  const session = observePasskeySession(page, credentials.deployment);
  return {
    ...session,
    deployment: () => credentials.deployment,
    authenticated: () => isBotHandle(session.viewer()),
  };
}

export async function signIn(page, base, credentials, session, timeout) {
  return signInWithPasskey(page, credentials, session, timeout);
}

export async function waitForPage(page, kind) {
  await page.waitForFunction(kind => {
    const main = document.querySelector('main');
    const visible = element =>
      Boolean(element.getClientRects().length) && getComputedStyle(element).visibility !== 'hidden';
    if (
      !main?.querySelector('h1') ||
      [...main.querySelectorAll('[aria-busy="true"], [role="alert"]')].some(visible)
    )
      return false;
    if (
      [...main.querySelectorAll('.head .tools a')].some(link =>
        /^Open the current .* screen$/.test(link.textContent),
      )
    )
      return false;
    if (['intents', 'planning'].includes(kind) && !main.querySelector('.plan-with-views')) return false;
    if (kind === 'initiative' && !main.querySelector('.plan-ini')) return false;
    if (kind === 'lane' && !main.querySelector('.lr-file, .lr-lead, .stops')) return false;
    return true;
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
