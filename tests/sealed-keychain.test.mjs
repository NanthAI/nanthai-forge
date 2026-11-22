// SPDX-License-Identifier: Apache-2.0
// OS keychain device key store (Item a9f9b608). The keychain tools are mocked: no test reaches the
// real login keychain or a real Secret Service. All keys are synthetic.
import './check-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileKeyStore, ensureSecretDevice, openSecretDevice, wipeDeviceKeys } from '../dist/sealed-local.js';
import {
  KEYCHAIN_TIMEOUT_MS,
  forgetKeychainCache,
  linuxKeychain,
  macosKeychain,
  platformKeychain,
  runTool,
} from '../dist/sealed-keychain.js';
import { forgeSecretId } from '../dist/sealed-format.js';

const account = forgeSecretId('account', 'synthetic-keychain-account');
const TOKEN = /nforge-kek-v1:([A-Za-z0-9_-]{43})/;

/** A fake `security` / `secret-tool`: records every call and keeps items in memory. */
function fakeTool(kind, behave = {}) {
  const items = new Map(),
    calls = [];
  const run = (command, args, input, timeoutMs) => {
    calls.push({ command, args: [...args], input, timeoutMs });
    const op = { '-i': 'write', store: 'write', 'delete-generic-password': 'remove', clear: 'remove' }[
      args[0]
    ];
    const fail = behave[op ?? 'read'];
    if (fail === 'timeout') return { status: null, stdout: '', stderr: '', failed: true };
    if (fail === 'locked')
      return { status: 51, stdout: '', stderr: 'User interaction is not allowed.', failed: false };
    // Real `security -i` can exit 0 although its inner command failed.
    if (fail === 'silent') return { status: 0, stdout: 'security> ', stderr: '', failed: false };
    if (op === 'remove') {
      items.delete(args[args.indexOf(kind === 'mac' ? '-a' : 'account') + 1]);
      return { status: 0, stdout: '', stderr: '', failed: false };
    }
    if (kind === 'mac') {
      if (args[0] === '-i') {
        const words = input.trim().split(/\s+/);
        assert.equal(words[0], 'add-generic-password');
        items.set(words[words.indexOf('-a') + 1], words[words.indexOf('-w') + 1]);
        return { status: 0, stdout: 'security> ', stderr: '', failed: false };
      }
      const value = items.get(args[args.indexOf('-a') + 1]);
      if (value === undefined)
        return {
          status: 44,
          stdout: '',
          stderr: 'The specified item could not be found in the keychain.',
          failed: false,
        };
      return { status: 0, stdout: `${behave.readValue ?? value}\n`, stderr: '', failed: false };
    }
    const at = args.indexOf('account') + 1;
    if (args[0] === 'store') {
      items.set(args[at], input);
      return { status: 0, stdout: '', stderr: '', failed: false };
    }
    const value = items.get(args[at]);
    if (value === undefined) return { status: 1, stdout: '', stderr: '', failed: false };
    return { status: 0, stdout: behave.readValue ?? value, stderr: '', failed: false };
  };
  const keychain =
    kind === 'mac' ? macosKeychain(run, '/fake/security') : linuxKeychain(run, '/fake/secret-tool');
  return { keychain, calls, items };
}
function directory(t) {
  const path = mkdtempSync(join(tmpdir(), 'forge-sealed-keychain-'));
  t.after(() => {
    forgetKeychainCache();
    rmSync(path, { recursive: true, force: true });
  });
  forgetKeychainCache();
  return path;
}
/** Every secret representation a leak could take: raw bytes, hex and base64 forms. */
function secretForms(keys, items) {
  const forms = [];
  for (const name of ['sign', 'enc', 'pinKey'])
    forms.push(keys[name].toString('hex'), keys[name].toString('base64'), keys[name].toString('base64url'));
  for (const token of items.values()) {
    const key = Buffer.from(TOKEN.exec(token)[1], 'base64url');
    forms.push(token, TOKEN.exec(token)[1], key.toString('hex'), key.toString('base64'));
  }
  return forms;
}
function assertNoSecret(text, forms, where) {
  for (const form of forms) assert.equal(String(text).includes(form), false, `${where} holds key material`);
}
const rawBytes = (bytes, keys, items) => {
  for (const name of ['sign', 'enc', 'pinKey']) assert.equal(bytes.includes(keys[name]), false);
  for (const token of items.values())
    assert.equal(bytes.includes(Buffer.from(TOKEN.exec(token)[1], 'base64url')), false);
};

for (const kind of ['mac', 'linux'])
  test(`${kind} keychain migration keeps device keys and pin counter, removes the plain file, and passes key material only on stdin`, async t => {
    const dir = directory(t),
      file = new FileKeyStore(join(dir, 'device.bin'));
    const original = await ensureSecretDevice(dir, account, null);
    file.save({ ...original, pinCounter: 7, pinned: { ab: [1, 2] } });
    const { keychain, calls, items } = fakeTool(kind);

    const opened = await openSecretDevice(dir, account, keychain);
    assert.equal(existsSync(join(dir, 'device.bin')), false, 'plain file removed after a verified move');
    assert.equal(existsSync(join(dir, 'device.kc')), true);
    for (const name of ['id', 'sign', 'enc', 'pinKey', 'signPub', 'encPub', 'bindSig'])
      assert.deepEqual(opened.keys[name], original[name]);
    assert.equal(opened.keys.pinCounter, 7);
    assert.deepEqual(opened.keys.pinned, { ab: [1, 2] });
    assert.equal(calls.length, 2, 'one write and one read-back');

    const forms = secretForms(original, items);
    for (const call of calls) {
      assertNoSecret(call.args.join(' '), forms, 'argv');
      assert.equal(call.timeoutMs, KEYCHAIN_TIMEOUT_MS);
    }
    const write = calls[0];
    if (kind === 'mac') assert.deepEqual(write.args, ['-i']);
    assert.match(write.input, TOKEN, 'the wrapping key goes on stdin');
    rawBytes(readFileSync(join(dir, 'device.kc')), original, items);

    // A later command (fresh process cache) makes one keychain read however often it loads keys.
    opened.store.save({ ...opened.keys, pinCounter: 8 });
    forgetKeychainCache();
    calls.length = 0;
    const again = await openSecretDevice(dir, account, keychain);
    for (let i = 0; i < 3; i++) wipeDeviceKeys(again.store.load());
    assert.equal(calls.length, 1);
    assert.equal(calls[0].input, undefined, 'reads send nothing on stdin');
    assert.equal(again.keys.pinCounter, 8, 'pin counter survives re-login');
    assert.deepEqual(again.keys.sign, original.sign);
    for (const keys of [original, opened.keys, again.keys]) wipeDeviceKeys(keys);
  });

test('a new device created with a keychain never writes a plain key file', async t => {
  const dir = directory(t),
    { keychain, items } = fakeTool('mac');
  const keys = await ensureSecretDevice(dir, account, keychain);
  assert.equal(existsSync(join(dir, 'device.bin')), false);
  rawBytes(readFileSync(join(dir, 'device.kc')), keys, items);
  forgetKeychainCache();
  const again = await ensureSecretDevice(dir, account, keychain);
  assert.deepEqual(again.id, keys.id);
  wipeDeviceKeys(keys);
  wipeDeviceKeys(again);
});

for (const failure of [
  { name: 'write timeout', behave: { write: 'timeout' } },
  { name: 'locked refusal', behave: { write: 'locked' } },
  { name: 'read-back timeout', behave: { read: 'timeout' } },
  { name: 'read-back mismatch', behave: { readValue: `nforge-kek-v1:${'A'.repeat(43)}` } },
  { name: 'interactive write that exits 0 but stores nothing', behave: { write: 'silent' } },
])
  test(`a keychain ${failure.name} keeps the existing private file and defers the next attempt a day`, async t => {
    const dir = directory(t),
      path = join(dir, 'device.bin');
    const original = await ensureSecretDevice(dir, account, null);
    const before = readFileSync(path);
    const { keychain, calls, items } = fakeTool('mac', failure.behave);
    const opened = await openSecretDevice(dir, account, keychain);
    assert(readFileSync(path).equals(before), 'private file unchanged');
    assert.equal(existsSync(join(dir, 'device.kc')), false);
    assert.equal(opened.store.path, path);
    assert.deepEqual(opened.keys.sign, original.sign);
    assert.equal(items.size, 0, 'a failed attempt leaves no orphaned keychain item');
    const retry = readFileSync(join(dir, 'keychain-retry.bin'));
    rawBytes(retry, original, items);
    calls.length = 0;
    wipeDeviceKeys(await ensureSecretDevice(dir, account, keychain));
    assert.equal(calls.length, 0, 'no keychain call until the retry time');
    for (const keys of [original, opened.keys]) wipeDeviceKeys(keys);
    before.fill(0);
  });

test('keys held only behind the keychain fail closed without prompting or creating new keys', async t => {
  const dir = directory(t),
    { keychain, items } = fakeTool('linux');
  const keys = await ensureSecretDevice(dir, account, keychain);
  const forms = secretForms(keys, items);
  forgetKeychainCache();
  const errors = [];
  for (const attempt of [
    null,
    fakeTool('linux', { read: 'timeout' }).keychain,
    fakeTool('linux', { read: 'locked' }).keychain,
    fakeTool('mac').keychain,
  ]) {
    const error = await openSecretDevice(dir, account, attempt).catch(e => e);
    assert.equal(error.code, 'SECRETS_KEYCHAIN_UNAVAILABLE');
    errors.push(error);
  }
  // A keychain that lost the item cannot open the file either: refuse, never mint keys.
  const empty = fakeTool('linux');
  errors.push(await openSecretDevice(dir, account, empty.keychain).catch(e => e));
  assert.equal(errors.at(-1).code, 'SECRETS_KEYCHAIN_UNAVAILABLE');
  for (const error of errors) {
    assertNoSecret(error.message, forms, 'error message');
    assertNoSecret(JSON.stringify({ ...error, stack: error.stack }), forms, 'error');
  }
  assert.equal(existsSync(join(dir, 'device.bin')), false, 'no new plain key file');
  const back = await ensureSecretDevice(dir, account, keychain);
  assert.deepEqual(back.id, keys.id);
  wipeDeviceKeys(keys);
  wipeDeviceKeys(back);
});

test('an unfinished move keeps the private file authoritative, and a finished one removes it', async t => {
  const dir = directory(t),
    path = join(dir, 'device.bin'),
    { keychain, items } = fakeTool('mac');
  const original = await ensureSecretDevice(dir, account, null);
  const plain = readFileSync(path);
  wipeDeviceKeys(await ensureSecretDevice(dir, account, keychain));
  // Crash between publishing device.kc and removing device.bin: identical records finish the move.
  writeFileSync(path, plain, { mode: 0o600 });
  const finished = await openSecretDevice(dir, account, keychain);
  assert.equal(existsSync(path), false);
  assert.equal(finished.store.path, join(dir, 'device.kc'));
  // A differing plain record (a newer counter written by the file store) wins and the copy goes.
  new FileKeyStore(path).save({ ...original, pinCounter: 3 });
  const kept = await openSecretDevice(dir, account, keychain);
  assert.equal(kept.store.path, path);
  assert.equal(kept.keys.pinCounter, 3);
  assert.equal(existsSync(join(dir, 'device.kc')), false);
  assert.equal(items.size, 0, 'the dropped copy takes its keychain item with it');
  // With no usable keychain the plain file is used and the keychain copy is kept, not deleted.
  wipeDeviceKeys(await ensureSecretDevice(dir, account, keychain));
  new FileKeyStore(path).save({ ...original, pinCounter: 4 });
  forgetKeychainCache();
  const headless = await openSecretDevice(dir, account, null);
  assert.equal(headless.keys.pinCounter, 4);
  assert.equal(existsSync(join(dir, 'device.kc')), true);
  for (const keys of [original, finished.keys, kept.keys, headless.keys]) wipeDeviceKeys(keys);
  plain.fill(0);
});

test('a restored older private copy never replaces the newer keychain record', async t => {
  const dir = directory(t),
    path = join(dir, 'device.bin'),
    { keychain } = fakeTool('linux');
  const original = await ensureSecretDevice(dir, account, null);
  const old = readFileSync(path);
  const moved = await openSecretDevice(dir, account, keychain);
  moved.store.save({ ...moved.keys, pinCounter: 9 });
  writeFileSync(path, old, { mode: 0o600 }); // a backup or sync tool brings the plain file back
  const opened = await openSecretDevice(dir, account, keychain);
  assert.equal(opened.keys.pinCounter, 9);
  assert.equal(opened.store.path, join(dir, 'device.kc'));
  assert.equal(existsSync(path), false, 'the stale plain key copy is removed');
  for (const keys of [original, moved.keys, opened.keys]) wipeDeviceKeys(keys);
  old.fill(0);
});

test('a private key file for a different device next to the keychain record is refused and both are kept', async t => {
  const dir = directory(t),
    path = join(dir, 'device.bin'),
    { keychain, items } = fakeTool('mac');
  const keys = await ensureSecretDevice(dir, account, keychain);
  const other = join(dir, 'other');
  const foreign = await ensureSecretDevice(other, account, null);
  writeFileSync(path, readFileSync(join(other, 'device.bin')), { mode: 0o600 });
  const before = { plain: readFileSync(path), sealed: readFileSync(join(dir, 'device.kc')) };
  const error = await openSecretDevice(dir, account, keychain).catch(e => e);
  assert.equal(error.code, 'SECRETS_KEYCHAIN_UNAVAILABLE');
  assertNoSecret(error.message, [...secretForms(keys, items), ...secretForms(foreign, new Map())], 'error');
  assert(readFileSync(path).equals(before.plain));
  assert(readFileSync(join(dir, 'device.kc')).equals(before.sealed));
  for (const k of [keys, foreign]) wipeDeviceKeys(k);
});

test('FORGE_SECRET_KEYCHAIN=off moves keys back to the private file and stops later moves', async t => {
  const dir = directory(t),
    path = join(dir, 'device.bin'),
    { keychain, calls, items } = fakeTool('linux');
  const keys = await ensureSecretDevice(dir, account, keychain);
  const opened = await openSecretDevice(dir, account, keychain);
  opened.store.save({ ...opened.keys, pinCounter: 5 });
  forgetKeychainCache();
  const back = await openSecretDevice(dir, account, keychain, false);
  assert.equal(back.store.path, path);
  assert.equal(back.keys.pinCounter, 5);
  assert.deepEqual(back.keys.sign, keys.sign);
  assert.equal(existsSync(join(dir, 'device.kc')), false);
  assert.equal(items.size, 0, 'the unused keychain item is removed');
  calls.length = 0;
  const again = await openSecretDevice(dir, account, keychain, false);
  assert.equal(calls.length, 0, 'the opt-out never calls the keychain for a private file');
  assert.equal(again.store.path, path);
  for (const k of [keys, opened.keys, back.keys, again.keys]) wipeDeviceKeys(k);
});

test('tests never select a real keychain', () => {
  assert.equal(platformKeychain(), null);
});

test('a keychain tool that waits for a prompt is killed at the timeout and has no terminal', () => {
  // The child never exits by itself, so returning at all proves the timeout killed it.
  // test-signal: allow a child that never exits is the prompt-wait being proven
  const hung = runTool(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], undefined, 300);
  assert.equal(hung.failed, true);
  assert.equal(hung.status, null, 'killed, not exited');
  const tty = runTool(
    process.execPath,
    [
      '-e',
      "try { require('fs').openSync('/dev/tty', 'r'); process.stdout.write('tty') } catch { process.stdout.write('none') }",
    ],
    undefined,
    5_000,
  );
  assert.equal(tty.stdout, 'none', 'no controlling terminal to prompt on');
  const echo = runTool(
    process.execPath,
    ['-e', 'process.stdin.pipe(process.stdout)'],
    'synthetic-stdin',
    5_000,
  );
  assert.equal(echo.stdout, 'synthetic-stdin');
});
