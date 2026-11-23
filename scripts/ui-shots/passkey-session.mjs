// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { EventEmitter, once } from 'node:events';
import { hrefFor } from '../../web/src/app/paths.ts';
import { botHandle, isBotHandle } from './bot-credentials.mjs';
import { convexFrames } from './convex-frames.mjs';
import { ShotError } from './options.mjs';

const signInPath = hrefFor({ frame: 'public', page: 'signin' });
const accountPath = hrefFor({ frame: 'account', place: 'projects' });

/** Reuse the native app's authenticated viewer query. Keep only its handle and the browser token in memory. */
export function observePasskeySession(page, deployment) {
  let current;
  const events = new EventEmitter();
  const viewer = () =>
    current?.token && current.acceptedVersion >= current.tokenVersion ? current.viewer : null;
  const deploymentSocket = new URL(deployment);
  deploymentSocket.protocol = 'wss:';
  page.on('websocket', socket => {
    const url = new URL(socket.url());
    if (url.origin !== deploymentSocket.origin || !/^\/api\/[^/]+\/sync$/.test(url.pathname)) return;
    const state = { token: null, viewer: null, queryId: null, tokenVersion: Infinity, acceptedVersion: 0 };
    current = state;
    convexFrames(socket, {
      sent(message) {
        if (message.type === 'Authenticate') {
          state.token =
            message.tokenType === 'User' && typeof message.value === 'string' ? message.value : null;
          state.tokenVersion = Number.isInteger(message.baseVersion) ? message.baseVersion + 1 : Infinity;
          if (!state.token) state.viewer = null;
        }
        if (message.type !== 'ModifyQuerySet' || !Array.isArray(message.modifications)) return;
        for (const change of message.modifications) {
          if (change.type === 'Add' && change.udfPath === 'urlAccounts:current') {
            state.queryId = change.queryId;
            state.viewer = null;
          }
          if (change.type === 'Remove' && change.queryId === state.queryId) {
            state.queryId = null;
            state.viewer = null;
          }
        }
      },
      received(message) {
        if (message.type === 'AuthError') state.token = state.viewer = null;
        if (message.type !== 'Transition' || !Array.isArray(message.modifications)) return;
        state.acceptedVersion = message.endVersion?.identity ?? state.acceptedVersion;
        for (const change of message.modifications) {
          if (change.queryId !== state.queryId) continue;
          const handle = change.value?.handle;
          state.viewer = change.type === 'QueryUpdated' && typeof handle === 'string' ? handle : null;
        }
        if (current === state && viewer()) events.emit('viewer', viewer());
      },
    });
    socket.on('close', () => {
      if (current === state) current = undefined;
    });
  });
  async function waitForViewer(timeout) {
    const known = viewer();
    if (known) return known;
    const pending = new AbortController();
    const timer = setTimeout(() => pending.abort(), timeout);
    try {
      return (await once(events, 'viewer', { signal: pending.signal }))[0];
    } finally {
      clearTimeout(timer);
    }
  }
  const token = () => (isBotHandle(viewer()) ? current.token : null);
  return {
    viewer,
    waitForViewer,
    token,
    /** The app re-authenticates right after sign-in; wait until the server confirms the bot on the new token. */
    async readyToken(timeout) {
      try {
        return isBotHandle(await waitForViewer(timeout)) ? token() : null;
      } catch {
        return null;
      }
    },
  };
}

export async function withBotAuthenticator(page, run) {
  const cdp = await page.context().newCDPSession(page);
  try {
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
    return await run(cdp, authenticatorId);
  } finally {
    await cdp.send('WebAuthn.disable').catch(() => {});
    await cdp.detach().catch(() => {});
  }
}

export async function openNativeBotSignIn(page, origin) {
  const url = new URL(signInPath, origin);
  url.searchParams.set('next', accountPath);
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  if (page.url() !== url.href) throw new ShotError('Expected a fresh browser on the native sign-in page.');
  return url.href;
}

export async function submitNativeBotSignIn(page, origin, session, timeout) {
  const url = page.url();
  await page.getByLabel('Your handle', { exact: true }).fill(botHandle);
  if (page.url() !== url) throw new ShotError('Expected the native sign-in page.');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  const outcome = await page.waitForFunction(
    ({ origin, accountPath }) =>
      location.origin !== origin ||
      location.pathname === accountPath ||
      // The page can show "The passkey prompt closed" for an aborted first ceremony, then finish a second one.
      (/^(?!The passkey prompt closed)/.test(
        document.querySelector('form.signin [role="alert"]:not([hidden])')?.textContent?.trim() ?? 'x',
      ) &&
        Boolean(document.querySelector('form.signin [role="alert"]')?.getClientRects().length)),
    { origin, accountPath },
  );
  await outcome.dispose();
  if (page.url() !== new URL(accountPath, origin).href) {
    // Only a recognised refusal gets its own fixed words; page text is never copied (it can carry provider detail).
    const said = await page
      .locator('form.signin [role="alert"]')
      .first()
      .textContent({ timeout: 1000 })
      .catch(() => '');
    throw new ShotError(
      /^Too many sign-in attempts/.test(said?.trim() ?? '')
        ? 'The native passkey sign-in hit the sign-in rate limit. Wait a minute, then retry.'
        : 'The native passkey sign-in did not reach the account page.',
    );
  }
  try {
    if (isBotHandle(await session.waitForViewer(timeout)) && session.token()) return;
  } catch {
    throw new ShotError(
      'Could not verify the native bot browser session on the configured Convex deployment.',
    );
  }
  throw new ShotError('Signed-in identity does not match the configured bot.');
}

/** Use the application's existing WebAuthn ceremony with a credential enrolled by the owner. */
export async function signInWithPasskey(page, credentials, session, timeout) {
  let problem = 'Could not open the native sign-in page.';
  try {
    await openNativeBotSignIn(page, credentials.origin);
    problem = 'Could not load the enrolled passkey into Chromium.';
    // The form can also register a new handle. Only allow assertions with the enrolled tooling credential.
    await page.evaluate(() => {
      const create = navigator.credentials.create.bind(navigator.credentials);
      navigator.credentials.create = options =>
        options?.publicKey
          ? Promise.reject(new DOMException('Bot sign-in requires an enrolled passkey.', 'NotAllowedError'))
          : create(options);
    });
    await withBotAuthenticator(page, async (cdp, authenticatorId) => {
      await cdp.send('WebAuthn.addCredential', { authenticatorId, credential: credentials.credential });
      problem = 'Native bot passkey sign-in failed. Check enrollment and the configured site.';
      await submitNativeBotSignIn(page, credentials.origin, session, timeout);
    });
  } catch (error) {
    if (error instanceof ShotError) throw error;
    throw new ShotError(problem);
  }
}
