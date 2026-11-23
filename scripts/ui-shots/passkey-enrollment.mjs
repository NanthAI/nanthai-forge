// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { botHandle, botPasskey } from './bot-credentials.mjs';
import { ShotError } from './options.mjs';
import {
  observePasskeySession,
  openNativeBotSignIn,
  signInWithPasskey,
  submitNativeBotSignIn,
  withBotAuthenticator,
} from './passkey-session.mjs';

const timeout = 45_000;
const retainedHandle = Symbol('retained Forge handle');

async function withPage(browser, options, run) {
  const context = await browser.newContext(options);
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);
    return await run(page);
  } finally {
    await context.close();
  }
}

async function verify(browser, config, entry) {
  const credential = botPasskey(entry, config.origin);
  if (credential.deployment !== config.deployment)
    throw new ShotError('The saved passkey belongs to a different Convex deployment.');
  return withPage(browser, {}, async page => {
    const session = observePasskeySession(page, config.deployment);
    await signInWithPasskey(page, credential, session, timeout);
    const token = await session.readyToken(timeout);
    if (!token)
      throw new ShotError(
        'Could not verify the native bot browser session on the configured Convex deployment.',
      );
    return token;
  });
}

async function enroll(browser, config, stage) {
  const { origin, deployment } = config;
  return withPage(browser, {}, async page => {
    let sawDeployment = false;
    let pending;
    page.on('request', request => {
      if (new URL(request.url()).origin === deployment) sawDeployment = true;
    });
    page.on('websocket', socket => {
      const url = new URL(socket.url());
      if (url.protocol === 'wss:' && `https://${url.host}` === deployment) sawDeployment = true;
    });
    return withBotAuthenticator(page, async (cdp, authenticatorId) => {
      await page.exposeBinding('stageForgeBotPasskey', async ({ frame }) => {
        if (frame !== page.mainFrame() || new URL(frame.url()).origin !== origin || !sawDeployment || pending)
          throw new ShotError('Could not bind the new bot passkey to the configured site and deployment.');
        const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
        if (credentials.length !== 1) throw new ShotError('Expected one new bot passkey.');
        const { credentialId, privateKey, userHandle, rpId, isResidentCredential } = credentials[0];
        pending = {
          origin,
          deployment,
          credential: { credentialId, privateKey, userHandle, rpId, isResidentCredential },
        };
        botPasskey(pending, origin);
        // Persist before the app receives the attestation and can commit the registration.
        await stage(pending);
      });
      await page.addInitScript(
        ({ origin, botHandle }) => {
          if (location.origin !== origin || window !== window.top) return;
          const create = navigator.credentials.create.bind(navigator.credentials);
          navigator.credentials.create = async options => {
            if (options?.publicKey && options.publicKey.user.name !== botHandle)
              throw new DOMException(
                'The passkey request named a different Forge account.',
                'NotAllowedError',
              );
            const made = await create(options);
            if (made && options?.publicKey) await window.stageForgeBotPasskey();
            return made;
          };
        },
        { origin, botHandle },
      );

      const session = observePasskeySession(page, deployment);
      const signInUrl = await openNativeBotSignIn(page, origin);
      try {
        await submitNativeBotSignIn(page, origin, session, timeout);
      } catch (error) {
        if (
          !pending &&
          page.url() === signInUrl &&
          (await page
            .locator('form.signin [role="alert"]')
            .filter({ hasText: 'That handle is taken.' })
            .isVisible())
        )
          return retainedHandle;
        throw error;
      }
      if (!pending) throw new ShotError('The site did not create a bot passkey.');
      return pending;
    });
  });
}

export async function provisionBotPasskey(browser, config, credentials, save) {
  if (credentials.passkey && credentials.passkey.origin !== config.origin) {
    // A passkey belongs to one site address; after a site move it cannot sign in. Retire it and enrol for this one.
    credentials.retiredPasskey = credentials.passkey;
    delete credentials.passkey;
    await save();
  }
  if (credentials.passkey) return verify(browser, config, credentials.passkey);
  let passkey = credentials.pendingPasskey;
  let token;
  if (passkey) {
    if (passkey.origin !== config.origin || passkey.deployment !== config.deployment)
      throw new ShotError('The pending passkey belongs to a different site or deployment.');
    botPasskey(passkey, config.origin);
    // A prior browser may have lost its reply after the server committed registration.
    token = await verify(browser, config, passkey).catch(() => undefined);
  }
  if (!token) {
    const stage = async pending => {
      credentials.pendingPasskey = pending;
      await save();
    };
    passkey = await enroll(browser, config, stage);
    if (passkey === retainedHandle)
      throw new ShotError(
        'The Forge bot handle already has an account, but no saved passkey matches it. Restore the saved bot passkey.',
      );
    token = await verify(browser, config, passkey);
  }
  credentials.passkey = passkey;
  delete credentials.pendingPasskey;
  await save();
  return token;
}
