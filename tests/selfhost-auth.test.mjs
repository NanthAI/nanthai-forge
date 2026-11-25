// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Contract tests for scripts/selfhost-auth.mjs (Item de67c77d): real WebAuthn ES256
// registration/assertion verification via @simplewebauthn/server and full verifyConvexAuth flow.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { getFunctionAddress } from 'convex/server';
import { verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import { createSoftwarePasskey, smokeWebUrl, verifyConvexAuth } from '../scripts/selfhost-auth.mjs';

test('de67c77d: software passkey produces real WebAuthn registration and assertion payloads and fails on wrong origin or tampered signature', async () => {
  const passkey = createSoftwarePasskey(smokeWebUrl);
  const rpId = new URL(smokeWebUrl).hostname;
  const regChallenge = randomBytes(32).toString('base64url');
  const registration = passkey.register({
    rp: { id: rpId, name: 'Forge' },
    challenge: regChallenge,
  });
  const verifiedReg = await verifyRegistrationResponse({
    response: registration,
    expectedChallenge: regChallenge,
    expectedOrigin: smokeWebUrl,
    expectedRPID: rpId,
    requireUserVerification: true,
    supportedAlgorithmIDs: [-7],
  });
  assert.equal(verifiedReg.verified, true);
  assert.equal(verifiedReg.registrationInfo.credential.id, passkey.id);

  await assert.rejects(
    verifyRegistrationResponse({
      response: passkey.register(
        { rp: { id: rpId, name: 'Forge' }, challenge: regChallenge },
        { origin: 'https://wrong-origin.invalid' },
      ),
      expectedChallenge: regChallenge,
      expectedOrigin: smokeWebUrl,
      expectedRPID: rpId,
      requireUserVerification: true,
      supportedAlgorithmIDs: [-7],
    }),
    /origin/i,
  );

  const authChallenge = randomBytes(32).toString('base64url');
  const assertion = passkey.authenticate({ rpId, challenge: authChallenge });
  const verifiedAuth = await verifyAuthenticationResponse({
    response: assertion,
    expectedChallenge: authChallenge,
    expectedOrigin: smokeWebUrl,
    expectedRPID: rpId,
    credential: {
      id: passkey.id,
      publicKey: verifiedReg.registrationInfo.credential.publicKey,
      counter: 0,
    },
    requireUserVerification: true,
  });
  assert.equal(verifiedAuth.verified, true);
  assert.equal(verifiedAuth.authenticationInfo.newCounter, 1);

  const tampered = await verifyAuthenticationResponse({
    response: passkey.authenticate({ rpId, challenge: authChallenge }, { badSignature: true }),
    expectedChallenge: authChallenge,
    expectedOrigin: smokeWebUrl,
    expectedRPID: rpId,
    credential: {
      id: passkey.id,
      publicKey: verifiedReg.registrationInfo.credential.publicKey,
      counter: 0,
    },
    requireUserVerification: true,
  }).catch(() => ({ verified: false }));
  assert.equal(tampered.verified, false);
});

test('de67c77d: verifyConvexAuth exercises sign-up, owner isolation, negative JWTs, refresh rotation, revocation and restored passkey sign-in', async () => {
  const url = 'http://127.0.0.1:3399';
  const NOW = 1_800_000_000_000;
  const rpId = new URL(smokeWebUrl).hostname;
  const usersByHandle = new Map();
  const credentials = new Map();
  const challenges = new Map();
  const sessions = new Map();
  const refreshTokens = new Map();
  const teamsById = new Map();
  const teamsByOwnerOp = new Map();
  const issuedJwts = new Set();

  const makeJwt = (sessionId, userId) => {
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        iss: `${url}/components/auth`,
        aud: 'convex-auth',
        sub: sessionId,
        exp: Math.floor(NOW / 1000) + 3600,
      }),
    ).toString('base64url');
    const jwt = `${header}.${payload}.signed_${randomBytes(16).toString('base64url')}`;
    issuedJwts.add(jwt);
    return { jwt, userId };
  };

  const mintBundle = userId => {
    const sessionId = `sess_${randomUUID()}`;
    const refreshToken = `rt_${randomBytes(16).toString('hex')}`;
    sessions.set(sessionId, { userId });
    refreshTokens.set(refreshToken, { sessionId, userId });
    const { jwt } = makeJwt(sessionId, userId);
    return {
      accessToken: jwt,
      refreshToken,
      refreshTokenExpiresAt: NOW + 86_400_000,
      userId,
    };
  };

  const resolveCaller = token => {
    if (!token || !issuedJwts.has(token)) return null;
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    if (payload.iss !== `${url}/components/auth` || payload.aud !== 'convex-auth') return null;
    const session = sessions.get(payload.sub);
    if (!session) return null;
    const handle = [...usersByHandle.entries()].find(([, u]) => u.userId === session.userId)?.[0];
    return { userId: session.userId, accountKey: `user_${session.userId}`, handle };
  };

  const makeClient = (clientUrl, role = 'user') => {
    let token = null;
    const call = async (ref, args) => {
      const name = getFunctionAddress(ref).name;
      const viewer = role === 'user' ? resolveCaller(token) : null;
      if (name === 'auth:startSignInWithUsernamePasskey') {
        const challenge = randomBytes(32).toString('base64url');
        const existing = usersByHandle.get(args.username);
        if (existing) {
          challenges.set(challenge, { kind: 'auth', userId: existing.userId });
          return {
            success: true,
            step: 'authenticate',
            options: {
              rpId,
              challenge,
              allowCredentials: [{ id: existing.credentialId, type: 'public-key' }],
            },
          };
        }
        challenges.set(challenge, { kind: 'register', handle: args.username });
        return {
          success: true,
          step: 'register',
          options: { rp: { id: rpId, name: 'Forge' }, challenge },
        };
      }
      if (name === 'auth:finishSignUpWithUsernamePasskey') {
        const clientData = JSON.parse(
          Buffer.from(args.response.response.clientDataJSON, 'base64url').toString('utf8'),
        );
        const entry = challenges.get(clientData.challenge);
        challenges.delete(clientData.challenge);
        if (!entry || entry.kind !== 'register' || clientData.origin !== smokeWebUrl)
          return { status: 'error', userError: { error: 'PROTOCOL_ERROR' } };
        const verified = await verifyRegistrationResponse({
          response: args.response,
          expectedChallenge: clientData.challenge,
          expectedOrigin: smokeWebUrl,
          expectedRPID: rpId,
          requireUserVerification: true,
          supportedAlgorithmIDs: [-7],
        }).catch(() => ({ verified: false }));
        if (!verified.verified) return { status: 'error', userError: { error: 'PROTOCOL_ERROR' } };
        const userId = `u_${randomBytes(6).toString('hex')}`;
        const cred = verified.registrationInfo.credential;
        usersByHandle.set(args.username, { userId, credentialId: cred.id });
        credentials.set(cred.id, { userId, handle: args.username, publicKey: cred.publicKey });
        return { status: 'complete', tokens: mintBundle(userId) };
      }
      if (name === 'auth:finishSignInWithUsernamePasskey') {
        const clientData = JSON.parse(
          Buffer.from(args.response.response.clientDataJSON, 'base64url').toString('utf8'),
        );
        const entry = challenges.get(clientData.challenge);
        challenges.delete(clientData.challenge);
        const cred = credentials.get(args.response.id);
        if (!entry || entry.kind !== 'auth' || !cred || cred.userId !== entry.userId)
          return { status: 'error', userError: { error: 'PROTOCOL_ERROR' } };
        const verified = await verifyAuthenticationResponse({
          response: args.response,
          expectedChallenge: clientData.challenge,
          expectedOrigin: smokeWebUrl,
          expectedRPID: rpId,
          credential: { id: args.response.id, publicKey: cred.publicKey, counter: 0 },
          requireUserVerification: true,
        }).catch(() => ({ verified: false }));
        if (!verified.verified) return { status: 'error', userError: { error: 'PROTOCOL_ERROR' } };
        return { status: 'complete', username: cred.handle, tokens: mintBundle(cred.userId) };
      }
      if (name === 'auth:refreshSession') {
        const row = refreshTokens.get(args.refreshToken);
        if (!row || !sessions.has(row.sessionId)) return { kind: 'noSession' };
        refreshTokens.delete(args.refreshToken);
        const nextRefresh = `rt_${randomBytes(16).toString('hex')}`;
        refreshTokens.set(nextRefresh, row);
        const { jwt } = makeJwt(row.sessionId, row.userId);
        return {
          kind: 'rotated',
          tokens: {
            accessToken: jwt,
            refreshToken: nextRefresh,
            refreshTokenExpiresAt: NOW + 86_400_000,
            userId: row.userId,
          },
        };
      }
      if (name === 'auth:signOut') {
        const row = refreshTokens.get(args.refreshToken);
        if (row) sessions.delete(row.sessionId);
        return null;
      }
      if (name === 'auth:isAuthenticated') return Boolean(viewer);
      if (name === 'urlAccounts:current') return viewer ? { handle: viewer.handle } : null;
      if (name === 'teams:create') {
        if (token && !issuedJwts.has(token)) throw new Error('Failed to authenticate: invalid JWT signature');
        if (!viewer)
          throw Object.assign(new Error('Sign in to create a team.'), {
            data: { code: 'GITHUB_UNAVAILABLE' },
          });
        const key = `${viewer.accountKey}:${args.operationId}`;
        if (teamsByOwnerOp.has(key)) return teamsByOwnerOp.get(key);
        const id = `team_${randomUUID()}`;
        teamsById.set(id, viewer.accountKey);
        teamsByOwnerOp.set(key, id);
        return id;
      }
      if (name === 'teams:owned') {
        assert.equal(role, 'admin');
        assert.equal(teamsById.get(args.id), args.owner);
        return null;
      }
      if (name === 'teams:members') {
        if (!viewer || teamsById.get(args.id) !== viewer.accountKey)
          throw Object.assign(new Error('This team is unavailable with the current access.'), {
            data: { code: 'GITHUB_UNAVAILABLE' },
          });
        return { page: [], isDone: true, continueCursor: '' };
      }
      throw new Error(`Unexpected call: ${name}`);
    };
    return {
      url: clientUrl,
      setAuth: next => {
        token = next;
      },
      query: call,
      mutation: call,
      action: call,
    };
  };

  const clients = {
    anon: makeClient(url, 'anon'),
    outsider: makeClient(url, 'outsider'),
    admin: makeClient(url, 'admin'),
  };
  const capturedSecrets = [];
  const first = await verifyConvexAuth(clients, undefined, {
    secrets: capturedSecrets,
    makeClient: u => makeClient(u, 'user'),
    now: () => NOW,
  });
  assert.equal(first.accountKey, `user_${first.userId}`);
  assert.equal(first.badSignatureChecked, false);
  assert(capturedSecrets.length >= 4, 'access tokens and refresh tokens are tracked for redaction');

  const restored = await verifyConvexAuth(clients, first, {
    secrets: capturedSecrets,
    makeClient: u => makeClient(u, 'user'),
    now: () => NOW,
  });
  assert.equal(restored.userId, first.userId);
  assert.equal(restored.id, first.id);
  assert.equal(restored.badSignatureChecked, true);
  assert.equal(sessions.size, 0, 'both smoke sessions signed out cleanly');
});
