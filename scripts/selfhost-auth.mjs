// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// End-to-end Convex Auth passkey verification for selfhost-smoke (Item de67c77d):
// exercises real ES256 signed JWTs minted by ctx.auth.signJwt and verified against
// /.well-known/jwks.json, session resolution, refresh rotation, revocation and restore survival.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { deadlineConvexClient } from '../dist/network-convex-client.js';
import { api, internal } from '../convex/_generated/api.js';

export const smokeWebUrl = 'https://selfhost-smoke.invalid';

function decodeJwtPayload(token) {
  assert(typeof token === 'string' && token.split('.').length === 3, 'Expected a three-part JWT.');
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

function forgeJwtPayload(token, patch) {
  const parts = token.split('.');
  const claims = { ...decodeJwtPayload(token), ...patch };
  return [parts[0], Buffer.from(JSON.stringify(claims)).toString('base64url'), parts[2]].join('.');
}

function signUntrustedJwt(claims) {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: 'untrusted' })).toString(
    'base64url',
  );
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signingInput = `${header}.${payload}`;
  const sig = sign('sha256', Buffer.from(signingInput), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${sig.toString('base64url')}`;
}

const paginationOpts = { numItems: 1, cursor: null };
const signedOutDenied = error => error?.data?.code === 'GITHUB_UNAVAILABLE';
const invalidBearerDenied = error =>
  signedOutDenied(error) ||
  /\b(?:jwt|token|signature|issuer|unauthenticated|auth)\b|failed to authenticate/i.test(
    String(error?.message ?? ''),
  );

async function retryWriteThrottle(run) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (!String(error?.message ?? error).includes('TooManyWrites') || attempt >= 5) throw error;
      await new Promise(done => setTimeout(done, 400 * (attempt + 1)));
    }
  }
}

/** Pure-Node WebAuthn ES256 (P-256) software authenticator for self-host passkey smoke checks. */
export function createSoftwarePasskey(origin = smokeWebUrl) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');
  assert.equal(x.length, 32);
  assert.equal(y.length, 32);
  // COSE EC2 P-256 public key map: { 1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y }.
  const cosePublicKey = Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
    x,
    Buffer.from([0x22, 0x58, 0x20]),
    y,
  ]);
  const credentialId = randomBytes(32);
  const id = credentialId.toString('base64url');
  let signCount = 0;

  return {
    id,
    origin,
    register(options, overrides = {}) {
      const rpId = overrides.rpId ?? options.rp.id;
      const ceremonyOrigin = overrides.origin ?? origin;
      const rpIdHash = createHash('sha256').update(rpId).digest();
      const flags = Buffer.from([0x45]); // UP (0x01) | UV (0x04) | AT (0x40)
      const counter = Buffer.alloc(4);
      const aaguid = Buffer.alloc(16);
      const idLength = Buffer.alloc(2);
      idLength.writeUInt16BE(credentialId.length, 0);
      const authData = Buffer.concat([
        rpIdHash,
        flags,
        counter,
        aaguid,
        idLength,
        credentialId,
        cosePublicKey,
      ]);
      const authDataHeader =
        authData.length < 256
          ? Buffer.from([0x58, authData.length])
          : Buffer.from([0x59, authData.length >> 8, authData.length & 0xff]);
      // CBOR map: { "fmt": "none", "attStmt": {}, "authData": <bytes> }.
      const attestationObject = Buffer.concat([
        Buffer.from([0xa3, 0x63]),
        Buffer.from('fmt'),
        Buffer.from([0x64]),
        Buffer.from('none'),
        Buffer.from([0x67]),
        Buffer.from('attStmt'),
        Buffer.from([0xa0]),
        Buffer.from([0x68]),
        Buffer.from('authData'),
        authDataHeader,
        authData,
      ]);
      const clientData = Buffer.from(
        JSON.stringify({
          type: 'webauthn.create',
          challenge: options.challenge,
          origin: ceremonyOrigin,
          crossOrigin: false,
        }),
      );
      return {
        id,
        rawId: id,
        type: 'public-key',
        response: {
          clientDataJSON: clientData.toString('base64url'),
          attestationObject: attestationObject.toString('base64url'),
        },
        clientExtensionResults: {},
      };
    },
    authenticate(options, overrides = {}) {
      const rpId = overrides.rpId ?? options.rpId;
      const ceremonyOrigin = overrides.origin ?? origin;
      const rpIdHash = createHash('sha256').update(rpId).digest();
      const flags = Buffer.from([0x05]); // UP (0x01) | UV (0x04)
      const counter = Buffer.alloc(4);
      counter.writeUInt32BE(++signCount, 0);
      const authenticatorData = Buffer.concat([rpIdHash, flags, counter]);
      const clientData = Buffer.from(
        JSON.stringify({
          type: 'webauthn.get',
          challenge: options.challenge,
          origin: ceremonyOrigin,
          crossOrigin: false,
        }),
      );
      const clientDataHash = createHash('sha256').update(clientData).digest();
      const signature = Buffer.from(
        sign('sha256', Buffer.concat([authenticatorData, clientDataHash]), privateKey),
      );
      if (overrides.badSignature) signature[signature.length - 1] ^= 0xff;
      return {
        id,
        rawId: id,
        type: 'public-key',
        response: {
          clientDataJSON: clientData.toString('base64url'),
          authenticatorData: authenticatorData.toString('base64url'),
          signature: signature.toString('base64url'),
        },
        clientExtensionResults: {},
      };
    },
  };
}

/**
 * Verify Convex Auth end to end on a live self-hosted backend without admin auth on user calls.
 * First invocation signs up a fresh passkey account and creates an owner-scoped team;
 * later invocations (after snapshot restore, restart, upgrade or rollback) sign back in with the
 * same passkey and confirm ownership, refresh rotation, negative checks and live session revocation.
 */
export async function verifyConvexAuth(
  clients,
  original,
  {
    secrets = [],
    webUrl = smokeWebUrl,
    makeClient = url => deadlineConvexClient(url, { logger: false }),
    now = () => Date.now(),
  } = {},
) {
  const url = clients.anon.url;
  const remember = tokens => {
    if (tokens?.accessToken) secrets.push(tokens.accessToken);
    if (tokens?.refreshToken) secrets.push(tokens.refreshToken);
  };
  let retained = original;
  let tokens;

  if (!retained) {
    const passkey = createSoftwarePasskey(webUrl);
    // Negative passkey registration: wrong origin must fail cleanly without creating an account.
    const wrongOriginHandle = `smoke-neg-${randomBytes(4).toString('hex')}`;
    const negativeStart = await retryWriteThrottle(() =>
      clients.anon.mutation(api.auth.startSignInWithUsernamePasskey, { username: wrongOriginHandle }),
    );
    assert.equal(negativeStart.success, true);
    assert.equal(negativeStart.step, 'register');
    const negativeFinish = await retryWriteThrottle(() =>
      clients.anon.mutation(api.auth.finishSignUpWithUsernamePasskey, {
        username: wrongOriginHandle,
        response: passkey.register(negativeStart.options, { origin: 'https://wrong-origin.invalid' }),
      }),
    );
    assert.deepEqual(negativeFinish, { status: 'error', userError: { error: 'PROTOCOL_ERROR' } });

    const handle = `smoke-auth-${randomBytes(4).toString('hex')}`;
    const started = await retryWriteThrottle(() =>
      clients.anon.mutation(api.auth.startSignInWithUsernamePasskey, { username: handle }),
    );
    assert.equal(started.success, true);
    assert.equal(started.step, 'register');
    const finished = await retryWriteThrottle(() =>
      clients.anon.mutation(api.auth.finishSignUpWithUsernamePasskey, {
        username: handle,
        response: passkey.register(started.options),
      }),
    );
    assert.equal(finished.status, 'complete');
    tokens = finished.tokens;
    remember(tokens);
    retained = {
      handle,
      passkey,
      userId: tokens.userId,
      accountKey: `user_${tokens.userId}`,
      operationId: randomUUID(),
      id: null,
      badSignatureChecked: false,
    };
  } else {
    if (!retained.badSignatureChecked) {
      // Negative passkey assertion: a tampered signature must be refused before minting a session.
      const negativeStart = await retryWriteThrottle(() =>
        clients.anon.mutation(api.auth.startSignInWithUsernamePasskey, { username: retained.handle }),
      );
      assert.equal(negativeStart.success, true);
      assert.equal(negativeStart.step, 'authenticate');
      const negativeFinish = await retryWriteThrottle(() =>
        clients.anon.mutation(api.auth.finishSignInWithUsernamePasskey, {
          response: retained.passkey.authenticate(negativeStart.options, { badSignature: true }),
        }),
      );
      assert.deepEqual(negativeFinish, { status: 'error', userError: { error: 'PROTOCOL_ERROR' } });
      retained.badSignatureChecked = true;
    }
    const started = await retryWriteThrottle(() =>
      clients.anon.mutation(api.auth.startSignInWithUsernamePasskey, { username: retained.handle }),
    );
    assert.equal(started.success, true);
    assert.equal(started.step, 'authenticate');
    assert.equal(started.options.allowCredentials.length, 1);
    const finished = await retryWriteThrottle(() =>
      clients.anon.mutation(api.auth.finishSignInWithUsernamePasskey, {
        response: retained.passkey.authenticate(started.options),
      }),
    );
    assert.equal(finished.status, 'complete');
    assert.equal(finished.username, retained.handle);
    assert.equal(finished.tokens.userId, retained.userId);
    tokens = finished.tokens;
    remember(tokens);
  }

  const claims = decodeJwtPayload(tokens.accessToken);
  assert.equal(claims.iss, `${url}/components/auth`);
  assert.equal(claims.aud, 'convex-auth');
  assert(typeof claims.sub === 'string' && claims.sub.length > 0 && claims.exp * 1000 > now());

  const client = makeClient(url);
  client.setAuth(tokens.accessToken);
  assert.equal(await client.query(api.auth.isAuthenticated, {}), true);
  assert.equal((await client.query(api.urlAccounts.current, {}))?.handle, retained.handle);

  const createTeam = () =>
    client.mutation(api.teams.create, {
      name: 'Convex Auth native restore QA',
      operationId: retained.operationId,
    });
  if (!retained.id) retained.id = await createTeam();

  // The team is owned by this account and by nobody else: the owner reads it, every other caller is refused.
  assert.equal(
    await clients.admin.query(internal.teams.owned, { id: retained.id, owner: retained.accountKey }),
    null,
    'the lookup returns nothing for the owner',
  );
  await assert.rejects(clients.admin.query(internal.teams.owned, { id: retained.id, owner: 'someone_else' }));
  await client.query(api.teams.members, { id: retained.id, paginationOpts });
  for (const caller of [clients.anon, clients.outsider, clients.admin])
    await assert.rejects(caller.query(api.teams.members, { id: retained.id, paginationOpts }));

  // Negative JWT checks: a tampered payload and an untrusted-signer ES256 JWT must never write.
  const invalid = makeClient(url);
  invalid.setAuth(forgeJwtPayload(tokens.accessToken, { sub: 'forge_native_smoke' }));
  await assert.rejects(
    invalid.mutation(api.teams.create, {
      name: 'Tampered token must not write',
      operationId: randomUUID(),
    }),
    invalidBearerDenied,
  );
  invalid.setAuth(
    signUntrustedJwt({
      iss: `${url}/components/auth`,
      aud: 'convex-auth',
      sub: claims.sub,
      iat: Math.floor(now() / 1000),
      exp: Math.floor(now() / 1000) + 3600,
    }),
  );
  await assert.rejects(
    invalid.mutation(api.teams.create, {
      name: 'Untrusted signer must not write',
      operationId: randomUUID(),
    }),
    invalidBearerDenied,
  );

  // Refresh rotation preserves the exact Forge account and reconciles idempotent writes.
  const refreshed = await retryWriteThrottle(() =>
    clients.anon.mutation(api.auth.refreshSession, { refreshToken: tokens.refreshToken }),
  );
  assert.equal(refreshed.kind, 'rotated');
  assert.equal(refreshed.tokens.userId, retained.userId);
  remember(refreshed.tokens);
  client.setAuth(refreshed.tokens.accessToken);
  assert.equal(await client.query(api.auth.isAuthenticated, {}), true);
  assert.equal(await createTeam(), retained.id);

  // Live session revocation: signing out immediately invalidates the still-unexpired access token.
  await retryWriteThrottle(() =>
    clients.anon.mutation(api.auth.signOut, { refreshToken: refreshed.tokens.refreshToken }),
  );
  assert.equal(await client.query(api.auth.isAuthenticated, {}), false);
  assert.equal(await client.query(api.urlAccounts.current, {}), null);
  await assert.rejects(client.query(api.teams.members, { id: retained.id, paginationOpts }));
  await assert.rejects(
    client.mutation(api.teams.create, {
      name: 'Revoked session must not write',
      operationId: randomUUID(),
    }),
    signedOutDenied,
  );
  const afterSignOut = await retryWriteThrottle(() =>
    clients.anon.mutation(api.auth.refreshSession, { refreshToken: refreshed.tokens.refreshToken }),
  );
  assert.equal(afterSignOut.kind, 'noSession');

  return retained;
}
