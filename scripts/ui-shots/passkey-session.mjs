// SPDX-License-Identifier: Apache-2.0
import { EventEmitter, once } from 'node:events';
import { hrefFor } from '../../web/src/app/paths.ts';
import { botHandle } from './bot-credentials.mjs';
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
  return {
    viewer,
    async waitForViewer(timeout) {
      const known = viewer();
      if (known) return known;
      const pending = new AbortController();
      const timer = setTimeout(() => pending.abort(), timeout);
      try {
        return (await once(events, 'viewer', { signal: pending.signal }))[0];
      } finally {
        clearTimeout(timer);
      }
    },
    token: () => (viewer() === botHandle ? current.token : null),
  };
}

/** Use the application's existing WebAuthn ceremony with a credential enrolled by the owner. */
export async function signInWithPasskey(page, credentials, session, timeout) {
  let cdp;
  let problem = 'Could not open the native sign-in page.';
  try {
    const url = new URL(signInPath, credentials.origin);
    url.searchParams.set('next', accountPath);
    await page.goto(url.href, { waitUntil: 'domcontentloaded' });
    if (page.url() !== url.href) throw new ShotError('Expected a fresh browser on the native sign-in page.');
    problem = 'Could not load the enrolled passkey into Chromium.';
    // The form can also register a new handle. Only allow assertions with the enrolled tooling credential.
    await page.evaluate(() => {
      const create = navigator.credentials.create.bind(navigator.credentials);
      navigator.credentials.create = options =>
        options?.publicKey
          ? Promise.reject(new DOMException('Bot sign-in requires an enrolled passkey.', 'NotAllowedError'))
          : create(options);
    });
    cdp = await page.context().newCDPSession(page);
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
    await cdp.send('WebAuthn.addCredential', { authenticatorId, credential: credentials.credential });
    problem = 'Native bot passkey sign-in failed. Check enrollment and the configured site.';
    await page.getByLabel('Your handle', { exact: true }).fill(botHandle);
    if (page.url() !== url.href) throw new ShotError('Expected the native sign-in page.');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    // Check a form error without echoing its contents. The server-bound viewer is checked independently below.
    const outcome = await page.waitForFunction(
      ({ origin, accountPath }) =>
        location.origin !== origin ||
        location.pathname === accountPath ||
        Boolean(document.querySelector('form.signin [role="alert"]')?.getClientRects().length),
      { origin: credentials.origin, accountPath },
    );
    await outcome.dispose();
    if (page.url() !== new URL(accountPath, credentials.origin).href)
      throw new ShotError('The native passkey sign-in did not reach the account page.');
    // The router and the live viewer query can settle in either order.
    problem = 'Could not verify the native bot browser session on the configured Convex deployment.';
    if ((await session.waitForViewer(timeout)) !== botHandle || !session.token())
      throw new ShotError('Signed-in identity does not match the configured bot.');
  } catch (error) {
    if (error instanceof ShotError) throw error;
    throw new ShotError(problem);
  } finally {
    if (cdp) {
      await cdp.send('WebAuthn.disable').catch(() => {});
      await cdp.detach().catch(() => {});
    }
  }
}
