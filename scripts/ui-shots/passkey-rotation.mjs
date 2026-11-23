// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { makeFunctionReference } from 'convex/server';
import { deadlineConvexClient } from '../../dist/network-convex-client.js';
import { hrefFor } from '../../web/src/app/paths.ts';
import { botHandle, botPasskey } from './bot-credentials.mjs';
import { ShotError } from './options.mjs';
import {
  observePasskeySession,
  openNativeBotSignIn,
  signInWithPasskey,
  withBotAuthenticator,
} from './passkey-session.mjs';

const timeout = 45_000;
const std = id => id.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
const rows = list => list.passkeys ?? list;

/** A fresh browser signs in with this entry and the server confirms the bot account. */
async function verifies(browser, config, entry) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const session = observePasskeySession(page, config.deployment);
    await signInWithPasskey(page, botPasskey(entry, config.origin), session, timeout);
    return Boolean(await session.readyToken(timeout));
  } catch {
    return false;
  } finally {
    await context.close();
  }
}

/** Add one new passkey from Sign-in and devices and stage it in the private file before the server commits it. */
async function addPasskey(page, config, credentials, save, oldIds) {
  let pending;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  try {
    await page.exposeBinding('stageRotatedPasskey', async ({ frame }) => {
      if (frame !== page.mainFrame() || new URL(frame.url()).origin !== config.origin || pending)
        throw new ShotError('Could not bind the new bot passkey to the configured site.');
      const { credentials: held } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
      const fresh = held.filter(c => !oldIds.has(std(c.credentialId)));
      if (fresh.length !== 1) throw new ShotError('Expected one new bot passkey.');
      const { credentialId, privateKey, userHandle, rpId, isResidentCredential } = fresh[0];
      pending = {
        origin: config.origin,
        deployment: config.deployment,
        credential: { credentialId, privateKey, userHandle, rpId, isResidentCredential },
      };
      botPasskey(pending, config.origin);
      credentials.pendingPasskey = pending;
      await save();
    });
    const devices = new URL(hrefFor({ frame: 'account', place: 'devices' }), config.origin);
    await page.goto(devices.href, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      const create = navigator.credentials.create.bind(navigator.credentials);
      navigator.credentials.create = async options => {
        const made = await create(options);
        if (made && options?.publicKey) await window.stageRotatedPasskey();
        return made;
      };
    });
    await page.getByRole('button', { name: 'Add a passkey', exact: true }).click();
    for (const started = Date.now(); !pending && Date.now() - started < timeout;)
      await page.waitForTimeout(250);
    return pending;
  } finally {
    await cdp.send('WebAuthn.disable').catch(() => {});
    await cdp.detach().catch(() => {});
  }
}

/** Replace every passkey on the bot account with one new one. The old ones are removed only after a fresh browser
 * signs in with the new one, and a rerun after any lost step resumes from the staged replacement. Only
 * credential-id prefixes (8 characters) leave this function; keys and tokens never do. */
export async function rotateBotPasskey(browser, config, credentials, save) {
  const resume = credentials.pendingPasskey && (await verifies(browser, config, credentials.pendingPasskey));
  const signer = botPasskey(resume ? credentials.pendingPasskey : credentials.passkey, config.origin);
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);
    const session = observePasskeySession(page, config.deployment);
    await signInWithPasskey(page, signer, session, timeout);
    const token = await session.readyToken(timeout);
    if (!token) throw new ShotError('Could not verify the bot session before rotating its passkey.');
    const client = deadlineConvexClient(config.deployment, { logger: false });
    client.setAuth(token);
    const list = async () => rows(await client.query(makeFunctionReference('auth:listPasskeys'), {}));
    const oldIds = new Set([std(signer.credential.credentialId)]);
    let pending = resume ? credentials.pendingPasskey : undefined;
    if (!pending) {
      const before = (await list()).length;
      pending = await addPasskey(page, config, credentials, save, oldIds);
      const started = Date.now();
      while (Date.now() - started < timeout && (await list()).length <= before)
        await page.waitForTimeout(500);
      if (!pending || (await list()).length <= before)
        throw new ShotError('The new bot passkey was not stored.');
    }
    // Prove the replacement signs in before anything is revoked.
    if (!(await verifies(browser, config, pending)))
      throw new ShotError('The new bot passkey does not sign in; nothing was removed. Rerun --rotate.');
    const newId = std(pending.credential.credentialId);
    const removed = [];
    for (const key of await list()) {
      if (std(key.credentialId) === newId) continue;
      await client.mutation(makeFunctionReference('authPasskeys:remove'), { passkeyId: key.passkeyId });
      removed.push(std(key.credentialId).slice(0, 8));
    }
    const left = await list();
    if (left.length !== 1 || std(left[0].credentialId) !== newId)
      throw new ShotError('The bot account does not hold exactly the new passkey.');
    credentials.passkey = pending;
    delete credentials.pendingPasskey;
    delete credentials.retiredPasskey;
    await save();
    client.clearAuth();
    return { removed, added: newId.slice(0, 8) };
  } finally {
    await context.close();
  }
}

/** Prove an old credential is refused: the server must answer the assertion with a sign-in failure. A rate limit,
 * timeout or navigation problem is inconclusive and throws, so it never reads as proof. */
export async function oldPasskeyRefused(browser, config, oldEntry) {
  const credential = botPasskey(oldEntry, config.origin);
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    return await withBotAuthenticator(page, async (cdp, authenticatorId) => {
      await openNativeBotSignIn(page, config.origin);
      await cdp.send('WebAuthn.addCredential', { authenticatorId, credential: credential.credential });
      await page.getByLabel('Your handle', { exact: true }).fill(botHandle);
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      // A revoked credential is not in the server's allow list, so the ceremony ends with the page's own failure
      // words and no session. Wait for the page to settle on /signin before reading them.
      let said = '';
      for (let waited = 0; waited < 12_000; waited += 500) {
        await page.waitForTimeout(500);
        if (new URL(page.url()).pathname === '/account') return false;
        said =
          (await page
            .locator('form.signin [role="alert"]')
            .first()
            .textContent({ timeout: 500 })
            .catch(() => '')) ?? '';
        if (waited >= 5000 && said) break;
      }
      if (/^Too many sign-in attempts/.test(said.trim()))
        throw new ShotError(
          'The old-passkey check hit the sign-in rate limit: inconclusive. Wait and rerun.',
        );
      if (!said.trim())
        throw new ShotError('The old-passkey check showed no sign-in result: inconclusive. Rerun.');
      if (new URL(page.url()).pathname === '/account') return false;
      return true;
    });
  } finally {
    await context.close();
  }
}
