// SPDX-License-Identifier: Apache-2.0
import { botHandle, botPasskey } from './bot-credentials.mjs';
import { botBrowserIdentity, finishClerkBotSignIn } from './browser.mjs';
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

async function linkExistingBot(page, { origin, deployment, clerkHandle }, clerk) {
  const url = new URL('/-/signin?link=existing', origin);
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  if (page.url() !== url.href) throw new ShotError('Expected the existing-account passkey page.');
  await page.getByRole('button', { name: 'Continue with your existing sign-in', exact: true }).click();
  await finishClerkBotSignIn(page, clerk);
  if ((await clerkHandle(page, deployment)) !== botHandle)
    throw new ShotError('The existing Clerk sign-in does not own the Forge bot handle.');
  if (page.url() !== url.href) throw new ShotError('Expected the existing-account passkey page.');
  await page.getByRole('button', { name: 'Add a passkey to this account', exact: true }).click();
  const added = page.getByRole('heading', { name: 'Your account has a passkey', exact: true });
  await added.or(page.locator('.signin [role="alert"]:visible')).first().waitFor();
  if (!(await added.isVisible()))
    throw new ShotError('Could not attach a passkey to the existing Forge bot account.');
}

async function enroll(browser, config, clerk, stage) {
  const { origin, deployment } = config;
  const options = clerk ? await botBrowserIdentity(browser, { kind: 'clerk' }) : {};
  return withPage(browser, options, async page => {
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

      if (clerk) await linkExistingBot(page, config, clerk);
      else {
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
      }
      if (!pending) throw new ShotError('The site did not create a bot passkey.');
      return pending;
    });
  });
}

export async function provisionBotPasskey(browser, config, credentials, save) {
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
    const clerk =
      credentials.email === 'forge-ui-bot+clerk_test@example.com' &&
      credentials.deployment === config.deployment &&
      typeof credentials.password === 'string' &&
      credentials.password &&
      typeof credentials.userId === 'string' &&
      credentials.userId
        ? credentials
        : undefined;
    const stage = async pending => {
      credentials.pendingPasskey = pending;
      await save();
    };
    passkey = await enroll(browser, config, undefined, stage);
    if (passkey === retainedHandle) {
      if (!clerk)
        throw new ShotError(
          'The existing Forge bot needs its saved Clerk credentials to attach a first passkey.',
        );
      passkey = await enroll(browser, config, clerk, stage);
    }
    token = await verify(browser, config, passkey);
  }
  credentials.passkey = passkey;
  delete credentials.pendingPasskey;
  await save();
  return token;
}
