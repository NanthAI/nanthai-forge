// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { openBotCredentialStore } from '../scripts/ui-shots/bot-credential-store.mjs';
import { readBotCredentials } from '../scripts/ui-shots/bot-credentials.mjs';
import { launchBotBrowser } from '../scripts/ui-shots/browser.mjs';
import { provisionBotPasskey } from '../scripts/ui-shots/passkey-enrollment.mjs';

const origin = 'https://forge-bot.example.test';
const deployment = 'https://fixture-backend.example.test';
const handle = 'forge-ui-bot';
const token = 'synthetic-bot-session';
const config = { origin, deployment };

async function privateHome(t) {
  const path = await mkdtemp(join(tmpdir(), 'forge-bot-setup-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('the shared credential store keeps private modes and detects a changed file before overwriting it', async t => {
  const home = await privateHome(t);
  const first = await openBotCredentialStore(home);
  const second = await openBotCredentialStore(home);
  first.data.projectId = 'first';
  await first.save();
  second.data.projectId = 'second';
  await assert.rejects(second.save(), /Another setup changed the bot credentials/);
  assert.equal((await openBotCredentialStore(home)).data.projectId, 'first');
  const dir = join(home, '.config', 'forge-ui-bot');
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(dir, 'credentials.json'))).mode & 0o777, 0o600);
});

test('per-user Forge state is allowed in the resolved home directory', async t => {
  const root = await privateHome(t);
  const home = join(root, 'home');
  const linkedHome = join(root, 'linked-home');
  await mkdir(join(home, '.forge', 'check-queue'), { recursive: true });
  await mkdir(join(home, '.nforge'));
  await symlink(home, linkedHome);

  const store = await openBotCredentialStore(linkedHome);
  store.data.projectId = 'synthetic-project';
  await store.save();
  assert.equal((await openBotCredentialStore(home)).data.projectId, 'synthetic-project');
});

for (const marker of [
  '.git',
  '.forge-client',
  '.forge/hosted-lane.json',
  '.forge/hosted-main.json',
  '.forge/native.json',
  '.forge/work',
]) {
  test(`a home that is a project checkout (${marker}) refuses to create a credential directory`, async t => {
    const home = await privateHome(t);
    const path = join(home, marker);
    if (marker.endsWith('.json')) {
      await mkdir(dirname(path));
      await writeFile(path, '{}');
    } else await mkdir(path, { recursive: true });
    await assert.rejects(openBotCredentialStore(home), /outside repositories/);
    assert.equal(existsSync(join(home, '.config')), false);
  });
}

test('a home nested in a Forge client checkout cache cannot hold bot credentials', async t => {
  const root = await privateHome(t);
  const home = join(root, 'fixture.forge-client', 'lanes', 'home');
  await mkdir(home, { recursive: true });
  await assert.rejects(openBotCredentialStore(home), /outside repositories/);
  assert.equal(existsSync(join(home, '.config')), false);
});

test('a config symlink into a repository is refused before creating the bot credential directory', async t => {
  const home = await privateHome(t);
  const repo = join(home, 'fixture-repo');
  await mkdir(join(repo, '.git'), { recursive: true });
  await symlink(repo, join(home, '.config'));
  await assert.rejects(openBotCredentialStore(home), /outside repositories/);
  assert.equal(existsSync(join(repo, 'forge-ui-bot')), false);
});

test('passkey setup with per-user Forge state reaches the first-run project check', async t => {
  const home = await privateHome(t);
  await mkdir(join(home, '.forge', 'check-queue'), { recursive: true });
  await assert.rejects(
    promisify(execFile)(process.execPath, ['scripts/ui-bot-setup.mjs', '--passkey'], {
      env: { ...process.env, HOME: home },
    }),
    /Supply --project on the first run/,
  );
});

test('setup rejects any site or deployment other than Forge dev before touching the private store', async t => {
  const home = await privateHome(t);
  for (const option of ['--base', '--deployment']) {
    await assert.rejects(
      promisify(execFile)(process.execPath, ['scripts/ui-bot-setup.mjs', '--passkey', option, origin], {
        env: { ...process.env, HOME: home },
      }),
      /for the Forge dev site and deployment/,
    );
  }
  assert.equal(existsSync(join(home, '.config')), false);
});

const form = `<form class="signin"><label>Your handle<input name="username"></label>
  <button>Continue</button><span hidden role="alert"></span></form>`;
function browserFixture({ challenge, credentialId, loseReply, reservedHandle, registrationHandle }) {
  return `<!doctype html>
    ${form}
    <script>
      const form = document.querySelector('form');
      const bytes = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
      const b64 = buffer => btoa(String.fromCharCode(...new Uint8Array(buffer)));
      const challenge = bytes(${JSON.stringify(challenge.toString('base64'))});
      const rpId = location.hostname;
      const viewer = () => {
        const socket = new WebSocket(${JSON.stringify(deployment.replace('https:', 'wss:') + '/api/fixture/sync')});
        socket.onopen = () => {
          socket.send(JSON.stringify({ type: 'Authenticate', tokenType: 'User', baseVersion: 0, value: ${JSON.stringify(token)} }));
          socket.send(JSON.stringify({ type: 'ModifyQuerySet', modifications: [{ type: 'Add', queryId: 0, udfPath: 'urlAccounts:current' }] }));
        };
      };
      if (location.pathname === '/account') viewer();

      const register = async () => {
        await fetch(${JSON.stringify(deployment + '/fixture-challenge')});
        const made = await navigator.credentials.create({ publicKey: {
          challenge, rp: { name: 'Fixture', id: rpId },
          user: { id: bytes('AAAA'), name: ${JSON.stringify(registrationHandle)}, displayName: 'Fixture bot' },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
          authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        } });
        const response = await fetch('/fixture-register', { method: 'POST', body: JSON.stringify({ id: b64(made.rawId) }) });
        if (!response.ok) throw Error();
      };
      if (form) form.onsubmit = async event => {
        event.preventDefault();
        try {
          if (form.username.value !== ${JSON.stringify(handle)}) throw Error();
          const credentialId = ${JSON.stringify(credentialId)};
          if (!credentialId && ${reservedHandle}) {
            const alert = form.querySelector('[role="alert"]');
            alert.textContent = 'That handle is taken. If it is yours, sign in with its passkey or GitHub.';
            alert.hidden = false;
            return;
          }
          if (credentialId) {
            const assertion = await navigator.credentials.get({ publicKey: {
              challenge, rpId, userVerification: 'required',
              allowCredentials: [{ id: bytes(credentialId), type: 'public-key' }],
            } });
            const response = assertion.response;
            const valid = await fetch('/fixture-sign-in', { method: 'POST', body: JSON.stringify({
              id: b64(assertion.rawId), data: b64(response.clientDataJSON),
              auth: b64(response.authenticatorData), sig: b64(response.signature),
            }) }).then(result => result.ok);
            if (!valid) throw Error();
          } else {
            await register();
            if (${loseReply}) throw Error();
          }
          location.assign(new URLSearchParams(location.search).get('next'));
        } catch {
          form.querySelector('[role="alert"]').hidden = false;
          form.querySelector('[role="alert"]').textContent = 'SYNTHETIC_PROVIDER_ERROR';
        }
      };
    </script>`;
}

async function setupBrowser(
  t,
  home,
  { reservedHandle = false, loseReply = false, registrationHandle = handle } = {},
) {
  const executablePath = process.env.FORGE_UI_BROWSER || chromium.executablePath();
  if (!existsSync(executablePath)) {
    t.skip('A test browser is not installed. Set FORGE_UI_BROWSER.');
    return null;
  }
  const realBrowser = await launchBotBrowser({ executablePath });
  t.after(() => realBrowser.close());
  const challenge = randomBytes(32);
  let credentialId = null;
  let publicKey;
  const ceremonies = [];
  const browser = {
    newBrowserCDPSession: () => realBrowser.newBrowserCDPSession(),
    async newContext(options) {
      const context = await realBrowser.newContext(options);
      const socketUrl = deployment.replace('https:', 'wss:') + '/api/fixture/sync';
      context.on('page', page => {
        void page.routeWebSocket(socketUrl, mock => {
          const socket = new EventEmitter();
          socket.url = () => socketUrl;
          page.emit('websocket', socket);
          let authenticated = false;
          mock.onMessage(raw => {
            socket.emit('framesent', { payload: raw });
            const message = JSON.parse(String(raw));
            if (message.type === 'Authenticate') authenticated = message.value === token;
            if (message.type !== 'ModifyQuerySet') return;
            socket.emit('framereceived', {
              payload: JSON.stringify({
                type: 'Transition',
                endVersion: { identity: authenticated ? 1 : 0 },
                modifications: [
                  { type: 'QueryUpdated', queryId: 0, value: authenticated ? { handle } : null },
                ],
              }),
            });
          });
        });
      });
      await context.route(deployment + '/fixture-challenge', route =>
        route.fulfill({ headers: { 'access-control-allow-origin': origin }, body: 'fixture challenge' }),
      );
      await context.route(origin + '/**', async route => {
        const url = new URL(route.request().url());
        switch (url.pathname) {
          case '/fixture-register': {
            const { id } = route.request().postDataJSON();
            const { data } = await openBotCredentialStore(home);
            const staged = data.pendingPasskey?.credential;
            if (!staged || staged.credentialId !== id) return route.fulfill({ status: 409 });
            credentialId = id;
            publicKey = createPublicKey({
              key: Buffer.from(staged.privateKey, 'base64'),
              format: 'der',
              type: 'pkcs8',
            });
            ceremonies.push('register');
            return route.fulfill({ body: 'accepted' });
          }
          case '/fixture-sign-in': {
            const proof = route.request().postDataJSON();
            const data = Buffer.from(proof.data, 'base64');
            const auth = Buffer.from(proof.auth, 'base64');
            const signature = Buffer.from(proof.sig, 'base64');
            const valid =
              proof.id === credentialId &&
              auth.readUInt32BE(33) === 0 &&
              JSON.parse(data).origin === origin &&
              verify(
                'sha256',
                Buffer.concat([auth, createHash('sha256').update(data).digest()]),
                publicKey,
                signature,
              );
            if (valid) ceremonies.push('assert');
            return route.fulfill({ status: valid ? 200 : 403 });
          }
          default:
            return route.fulfill({
              contentType: 'text/html',
              body: browserFixture({
                challenge,
                credentialId,
                loseReply,
                reservedHandle,
                registrationHandle,
              }),
            });
        }
      });
      return context;
    },
  };
  return { browser, ceremonies };
}

for (const scenario of [
  { name: 'enrolls a new handle', loseReply: false },
  { name: 'reuses the staged key after registration committed and its reply was lost', loseReply: true },
]) {
  test(`Chromium setup ${scenario.name}`, async t => {
    const home = await privateHome(t);
    const fixture = await setupBrowser(t, home, scenario);
    if (!fixture) return;
    const state = await openBotCredentialStore(home);
    const setup = ({ data, save }) => provisionBotPasskey(fixture.browser, config, data, save);
    if (scenario.loseReply)
      await assert.rejects(setup(state), error => {
        assert.doesNotMatch(error.message, /SYNTHETIC_PROVIDER_ERROR/);
        return /did not reach the account page/.test(error.message);
      });
    else assert.equal(await setup(state), token);

    const reloaded = await openBotCredentialStore(home);
    assert.equal(await setup(reloaded), token);
    const readerFile = join(home, '.config', 'forge-ui-bot', 'credentials.json');
    const stored = await readBotCredentials(readerFile, origin);
    assert.equal(stored.credential.signCount, -1);
    assert.equal(reloaded.data.pendingPasskey, undefined);
    assert.deepEqual(
      fixture.ceremonies,
      scenario.loseReply ? ['register', 'assert'] : ['register', 'assert', 'assert'],
    );
  });
}

test('a taken bot handle without its saved passkey stops and creates no second account', async t => {
  const home = await privateHome(t);
  const fixture = await setupBrowser(t, home, { reservedHandle: true });
  if (!fixture) return;
  const { data, save } = await openBotCredentialStore(home);
  await assert.rejects(
    provisionBotPasskey(fixture.browser, config, data, save),
    /already has an account, but no saved passkey matches it/,
  );
  assert.deepEqual(fixture.ceremonies, []);
  assert.equal(data.pendingPasskey, undefined);
  assert.equal(data.passkey, undefined);
});
