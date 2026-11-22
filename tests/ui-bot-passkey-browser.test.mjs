// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { readBotCredentials } from '../scripts/ui-shots/bot-credentials.mjs';
import { observeBotSession, signIn } from '../scripts/ui-shots/browser.mjs';
import { passkeyDestination } from '../scripts/ui-shots/passkey-routes.mjs';
import { BotNoReaderGrant } from '../scripts/ui-bot-grant.mjs';

const base = 'https://forge.example.test';
const deployment = 'https://backend.example.test';
const ws = 'wss://backend.example.test/api/fixture/sync';
const handle = 'forge-ui-bot';
const fixtureToken = 'synthetic-browser-session';

async function credentialsFile(t) {
  const dir = await mkdtemp(join(tmpdir(), 'forge-bot-fixture-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'credentials.json');
}

function credentialFixture() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const credentialId = randomBytes(32);
  return {
    publicKey,
    credentialId,
    config: {
      origin: base,
      deployment,
      credential: {
        credentialId: credentialId.toString('base64'),
        privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
        userHandle: randomBytes(32).toString('base64'),
        rpId: new URL(base).hostname,
        isResidentCredential: true,
        signCount: 0,
      },
    },
  };
}

test('tooling keeps existing Clerk files working and refuses an invalid or mismatched passkey without falling back', async t => {
  const file = await credentialsFile(t);
  const clerk = { email: 'fixture@example.test', password: 'fixture-secret', userId: 'fixture-user' };
  await writeFile(file, JSON.stringify(clerk), { mode: 0o600 });
  assert.deepEqual(await readBotCredentials(file, base), { ...clerk, kind: 'clerk', projectId: undefined });
  await symlink(file, file + '.link');
  await assert.rejects(readBotCredentials(file + '.link', base), /private bot credentials/);
  const { config } = credentialFixture();
  await writeFile(file, JSON.stringify({ ...clerk, passkey: config }));
  await assert.rejects(readBotCredentials(file, 'https://wrong.example.test'), /web origin/);
  const invalid = { ...config, credential: { ...config.credential, privateKey: 'FIXTURE-PRIVATE-KEY' } };
  await writeFile(file, JSON.stringify({ ...clerk, passkey: invalid }));
  await assert.rejects(readBotCredentials(file, base), error => {
    assert.match(error.message, /resident credential/);
    assert.doesNotMatch(error.message, /FIXTURE-PRIVATE-KEY|fixture-secret/);
    return true;
  });
  const denied = new BotNoReaderGrant(deployment, 'fixture-secret', 'passkey');
  assert.match(denied.message, /native UI bot cannot read/);
  assert.doesNotMatch(denied.message, /fixture-secret|ui-bot-setup/);
});

test('browser handoff uses only a verified bot viewer on the configured deployment and clears on sign-out', async () => {
  const page = new EventEmitter();
  const session = observeBotSession(page, { kind: 'passkey', deployment });
  const attach = url => {
    const socket = new EventEmitter();
    socket.url = () => url;
    page.emit('websocket', socket);
    const send = (event, message) => socket.emit(event, { payload: JSON.stringify(message) });
    const transition = (handle, identity = 1) =>
      send('framereceived', {
        type: 'Transition',
        endVersion: { identity },
        modifications: [{ type: 'QueryUpdated', queryId: 7, value: { handle } }],
      });
    send('framesent', { type: 'Authenticate', tokenType: 'User', baseVersion: 0, value: fixtureToken });
    send('framesent', {
      type: 'ModifyQuerySet',
      modifications: [{ type: 'Add', queryId: 7, udfPath: 'urlAccounts:current' }],
    });
    return { transition, send, socket };
  };
  attach('wss://wrong.example.test/api/fixture/sync').transition(handle);
  assert.equal(session.token(), null);
  const actual = attach(ws);
  actual.transition(handle, 0);
  assert.equal(session.token(), null);
  actual.transition('other-account');
  assert.equal(await session.waitForViewer(1000), 'other-account');
  assert.equal(session.token(), null);
  const handoff = attach(ws);
  const waiting = session.waitForViewer(1000);
  actual.transition(handle);
  assert.equal(session.token(), null);
  const update = JSON.stringify({
    type: 'Transition',
    endVersion: { identity: 1 },
    modifications: [{ type: 'QueryUpdated', queryId: 7, value: { handle } }],
  });
  const parts = [update.slice(0, 32), update.slice(32)];
  const fragment = partNumber =>
    handoff.send('framereceived', {
      type: 'TransitionChunk',
      transitionId: 'fixture-viewer',
      totalParts: parts.length,
      partNumber,
      chunk: parts[partNumber],
    });
  fragment(0);
  assert.equal(session.token(), null);
  fragment(1);
  assert.equal(await waiting, handle);
  assert.equal(session.token(), fixtureToken);
  handoff.send('framesent', { type: 'Authenticate', tokenType: 'None', baseVersion: 1 });
  assert.equal(session.authenticated(), false);
  assert.equal(session.token(), null);
});

test('project access waits through the re-authentication the app sends right after native sign-in (lead check 2026-11-22)', async () => {
  const page = new EventEmitter();
  const session = observeBotSession(page, { kind: 'passkey', deployment });
  const socket = new EventEmitter();
  socket.url = () => ws;
  page.emit('websocket', socket);
  const send = (event, message) => socket.emit(event, { payload: JSON.stringify(message) });
  const confirm = identity =>
    send('framereceived', {
      type: 'Transition',
      endVersion: { identity },
      modifications: [{ type: 'QueryUpdated', queryId: 7, value: { handle } }],
    });
  send('framesent', { type: 'Authenticate', tokenType: 'User', baseVersion: 0, value: 'first-token' });
  send('framesent', {
    type: 'ModifyQuerySet',
    modifications: [{ type: 'Add', queryId: 7, udfPath: 'urlAccounts:current' }],
  });
  confirm(1);
  assert.equal(await session.readyToken(1000), 'first-token');
  // The refreshed token is pending until the server confirms it; an immediate read must wait, not fail.
  send('framesent', { type: 'Authenticate', tokenType: 'User', baseVersion: 1, value: fixtureToken });
  assert.equal(session.token(), null);
  const ready = session.readyToken(1000);
  confirm(2);
  assert.equal(await ready, fixtureToken);
  send('framesent', { type: 'Authenticate', tokenType: 'User', baseVersion: 2, value: 'never-confirmed' });
  assert.equal(await session.readyToken(50), null);
});

test('native capture uses rebuilt addresses and refuses legacy-only screens explicitly', () => {
  const project = { handle: 'fixture-owner', slug: 'fixture-project' };
  const root = `${base}/fixture-owner/fixture-project`;
  assert.equal(passkeyDestination(base, project, 'now'), root);
  assert.equal(
    passkeyDestination(base, project, 'intents', { intentLayout: 'board' }),
    `${root}/plan?view=board`,
  );
  assert.equal(passkeyDestination(base, project, 'lane:example'), `${root}/lanes/example`);
  assert.equal(passkeyDestination(base, project, 'stats'), `${root}/stats`);
  assert.equal(
    passkeyDestination(base, project, 'code', { diffFile: 'src/has space.ts' }),
    `${root}/code/files/src/has%20space.ts`,
  );
  assert.equal(passkeyDestination(base, undefined, 'device'), `${base}/device`);
  assert.throws(() => passkeyDestination(base, project, 'intent:example'), /Clerk screenshot flow/);
  assert.throws(() => passkeyDestination(base, project, 'review:example'), /Clerk screenshot flow/);
});

test('signed-in Chromium suppresses opted-in wire logging before any credential payload can be recorded', async t => {
  const executablePath = process.env.FORGE_UI_BROWSER || chromium.executablePath();
  if (!existsSync(executablePath)) return t.skip('A test browser is not installed; set FORGE_UI_BROWSER.');
  const log = await credentialsFile(t);
  const sentinel = 'SYNTHETIC_SECRET_IN_BROWSER_PAYLOAD';
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
      import { launchBotBrowser } from './scripts/ui-shots/browser.mjs';
      const browser = await launchBotBrowser({ kind: 'passkey' }, { executablePath: process.argv[1] });
      try {
        const page = await browser.newPage();
        if (await page.evaluate(value => value, process.argv[2]) !== process.argv[2]) process.exitCode = 1;
      } finally {
        await browser.close();
      }
    `,
      executablePath,
      sentinel,
    ],
    { env: { ...process.env, DEBUG: 'pw:*', DEBUG_FILE: log } },
  );
  assert.doesNotMatch(stdout + stderr, new RegExp(sentinel));
  assert.equal(existsSync(log), false);
});

test('Chromium signs in with the enrolled passkey and a fresh context resumes the same browser session', async t => {
  const executablePath = process.env.FORGE_UI_BROWSER || chromium.executablePath();
  if (!existsSync(executablePath)) return t.skip('A test browser is not installed; set FORGE_UI_BROWSER.');
  const browser = await chromium.launch({ executablePath });
  t.after(() => browser.close());
  const file = await credentialsFile(t);
  const fixture = credentialFixture();
  const challenge = randomBytes(32);
  await writeFile(file, JSON.stringify({ passkey: fixture.config }), { mode: 0o600 });
  const credentials = await readBotCredentials(file, base);
  const payloads = [];

  async function setup(context, missing = false) {
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const session = observeBotSession(page, credentials);
    await context.routeWebSocket(ws, mock => {
      // Playwright's in-page mock does not create a browser network socket. Relay its actual frames to the observer.
      const socket = new EventEmitter();
      socket.url = () => ws;
      page.emit('websocket', socket);
      let authenticated = false;
      mock.onMessage(raw => {
        socket.emit('framesent', { payload: raw });
        const message = JSON.parse(String(raw));
        if (message.type === 'Authenticate') authenticated = message.value === fixtureToken;
        if (message.type !== 'ModifyQuerySet') return;
        const payload = JSON.stringify({
          type: 'Transition',
          endVersion: { identity: authenticated ? 1 : 0 },
          modifications: [{ type: 'QueryUpdated', queryId: 0, value: authenticated ? { handle } : null }],
        });
        socket.emit('framereceived', { payload });
        mock.send(payload);
      });
    });
    await context.route(`${base}/**`, async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/fixture-finish') {
        payloads.push(route.request().postDataJSON());
        return route.fulfill({ body: fixtureToken });
      }
      const form = `<form class="signin"><label>Your handle<input name="username"></label>
        <button>Continue</button><span hidden role="alert"></span></form>`;
      const body = url.pathname === '/signin' ? form : '<main><h1>Projects</h1></main>';
      await route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html>${body}<script>
          const form = document.querySelector('form');
          const token = localStorage.getItem('synthetic-session');
          if (token) {
            const socket = new WebSocket(${JSON.stringify(ws)});
            socket.onopen = () => {
              socket.send(JSON.stringify({ type: 'Authenticate', tokenType: 'User', baseVersion: 0, value: token }));
              socket.send(JSON.stringify({ type: 'ModifyQuerySet', modifications: [{ type: 'Add', queryId: 0, udfPath: 'urlAccounts:current' }] }));
            };
          }
          const bytes = encoded => Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
          const b64 = buffer => btoa(String.fromCharCode(...new Uint8Array(buffer)));
          const challenge = bytes(${JSON.stringify(challenge.toString('base64'))});
          if (form) form.onsubmit = async event => {
            event.preventDefault();
            try {
              if (form.username.value !== ${JSON.stringify(handle)}) throw Error();
              const rpId = location.hostname;
              const assertion = ${missing} ? await navigator.credentials.create({ publicKey: {
                challenge, rp: { name: 'Fixture', id: rpId },
                user: { id: bytes('AAAA'), name: form.username.value, displayName: 'Synthetic bot' },
                pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
              } }) : await navigator.credentials.get({ publicKey: {
                challenge, rpId, userVerification: 'required',
                allowCredentials: [{ id: bytes(${JSON.stringify(fixture.config.credential.credentialId)}), type: 'public-key' }],
              } });
              const response = assertion.response;
              const token = await fetch('/fixture-finish', { method: 'POST', body: JSON.stringify({
                id: b64(assertion.rawId), data: b64(response.clientDataJSON),
                auth: b64(response.authenticatorData), sig: b64(response.signature),
              }) }).then(response => response.text());
              localStorage.setItem('synthetic-session', token);
              location.assign(new URLSearchParams(location.search).get('next'));
            } catch {
              form.querySelector('[role="alert"]').hidden = false;
              form.querySelector('[role="alert"]').textContent = 'SYNTHETIC_PRIVATE_PROVIDER_ERROR';
            }
          };
        </script>`,
      });
    });
    return { page, session };
  }

  const auth = await browser.newContext();
  const first = await setup(auth);
  await signIn(first.page, base, credentials, first.session, 5000);
  assert.equal(first.session.token(), fixtureToken);
  assert.equal(payloads.length, 1);
  const proof = payloads[0];
  const data = Buffer.from(proof.data, 'base64');
  const authenticator = Buffer.from(proof.auth, 'base64');
  assert.deepEqual(Buffer.from(proof.id, 'base64'), fixture.credentialId);
  assert.equal(JSON.parse(data).origin, base);
  assert.equal(JSON.parse(data).challenge, challenge.toString('base64url'));
  assert.equal(authenticator.readUInt32BE(33), 0, 'the enrolled key can be reused without counter rollback');
  assert.ok(
    verify(
      'sha256',
      Buffer.concat([authenticator, createHash('sha256').update(data).digest()]),
      fixture.publicKey,
      Buffer.from(proof.sig, 'base64'),
    ),
  );

  const storageState = await auth.storageState();
  await auth.close();
  const next = await setup(await browser.newContext({ storageState }));
  await next.page.goto(`${base}/account`);
  assert.equal(await next.session.waitForViewer(5000), handle);
  assert.equal(next.session.token(), fixtureToken);
  assert.equal(payloads.length, 1, 'cold contexts need only the web session');
  const absent = await setup(await browser.newContext(), true);
  await assert.rejects(signIn(absent.page, base, credentials, absent.session, 5000), error => {
    assert.match(error.message, /did not reach the account page/);
    assert.doesNotMatch(error.message, /SYNTHETIC_PRIVATE_PROVIDER_ERROR/);
    return true;
  });
  assert.equal(payloads.length, 1, 'the tooling cannot enroll an account through the native form');
});
