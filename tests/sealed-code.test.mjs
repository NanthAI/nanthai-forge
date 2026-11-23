// SPDX-License-Identifier: Apache-2.0
import './check-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync as read } from 'node:fs';
import { serialize, deserialize } from 'node:v8';
import { CodeApprover, CodeRequester, parseWords } from '../dist/sealed-code.js';
import { codeWords } from '../dist/sealed-words.js';
import { requireConfirmedBase, requireConfirmedOwner } from '../dist/sealed-anchors.js';
import { createTransition } from '../dist/sealed-transition.js';
import { forgeSecretId, framedHash } from '../dist/sealed-format.js';
import { deviceKeys, signBytes } from '../dist/sealed-keys.js';
import { headBytes, repinBytes } from '../dist/sealed-records.js';
import { verifySealedReply } from '../dist/sealed-verify.js';
import { FileKeyStore } from '../dist/sealed-local.js';
import { SecretPins } from '../dist/sealed-pins.js';
import { fixture } from './helpers/sealed-fixture.mjs';
import {
  codeDevice,
  freshPin,
  holder,
  newAccountDevice,
  publish,
  runCode,
} from './helpers/sealed-code-journey.mjs';
import { assertLocalFiles, assertNoPlaintext, deviceSecrets } from './helpers/sealed-no-plaintext.mjs';

const vectors = JSON.parse(read(new URL('./fixtures/sealed-v1.json', import.meta.url)));
const clone = value => deserialize(serialize(value));
const clear = result => {
  result.key?.fill(0);
  for (const secret of result.secrets) secret.value.fill(0);
};
const recipient = keys => ({ id: keys.id, enc: keys.enc, kind: 1 });
const delta = changes => ({
  added: [],
  removed: [],
  roles: [],
  droppedFormer: [],
  newSharingMode: null,
  newChecksPointer: null,
  supersede: null,
  epochBumped: 0,
  ...changes,
});
/** Independent of the module: read `count` 11-bit groups from the top of a big-endian hex string. */
function expectedWords(hex, count) {
  const value = BigInt(`0x${hex}`),
    total = BigInt(hex.length * 4);
  return Array.from(
    { length: count },
    (_, i) => codeWords[Number((value >> (total - BigInt(11 * (i + 1)))) & 0x7ffn)],
  );
}
function pinStore(t, keys) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-code-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new FileKeyStore(join(directory, 'device.bin'));
  store.save({ ...keys, pinCounter: 0 });
  const files = () =>
    Object.fromEntries(readdirSync(directory).map(name => [name, readFileSync(join(directory, name))]));
  return { directory, pins: new SecretPins(directory, store), files };
}
/** A Checks set with trusted Development; `member` (another account) is a Development member device. */
function checksWithMember() {
  const checks = fixture(17, 'fixture-project', 2),
    dev = fixture(17, 'fixture-project', 1),
    member = newAccountDevice(dev);
  dev.transition({ newChecksPointer: checks.request.development.roster.checksPointer });
  dev.transition({
    added: [
      dev.entry(member.keys, {
        accountId: member.accountId,
        role: 2,
        how: 2,
        addedAtRosterVersion: dev.reply.roster.rosterVersion + 1,
      }),
    ],
  });
  dev.wrap();
  const development = dev.pin();
  checks.request.development = development;
  const memberRequest = {
    forgeProjectId: checks.request.forgeProjectId,
    setKind: 2,
    firstContact: true,
    development,
    anchor: { kind: 'checks-genesis' },
  };
  return { checks, dev, development, member, memberRequest };
}

test('T11 the word list is the fixed 2,048-word list and code/reply words are the leading 44 and 22 bits', () => {
  assert.equal(codeWords.length, 2048);
  assert.equal(new Set(codeWords.map(w => w.slice(0, 4))).size, 2048);
  assert.equal(
    createHash('sha256')
      .update(`${codeWords.join('\n')}\n`)
      .digest('hex'),
    '2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda',
  );
  for (const purpose of [1, 2, 3, 4]) {
    const code = expectedWords(vectors[`code${purpose}`], 4).join(' '),
      reply = expectedWords(vectors[`reply${purpose}`], 2).join(' ');
    // The module's parser and the independent bit reader agree on each known-answer vector.
    assert.equal(parseWords(code, 4).length, 8);
    assert.equal(parseWords(reply, 2).length, 4);
  }
  assert.deepEqual(expectedWords(vectors.code1, 4), ['buzz', 'busy', 'universe', 'paper']);
  assert.deepEqual(parseWords('BUZZ-busy  univ paper', 4), parseWords('buzz busy universe paper', 4));
  for (const typed of [
    'buzz busy universe',
    'buzz busy universe paperx',
    'buz busy universe paper',
    'zzzz a b c',
  ])
    assert.equal(parseWords(typed, 4), null, typed);
});

test('T30/T36 Confirm: the holder needs the spoken code, and the new device pins only after the typed reply', async t => {
  const f = fixture(),
    value = Buffer.from('synthetic-code-journey-value-0123');
  f.bump();
  f.name('API_TOKEN', value);
  const joining = newAccountDevice(f),
    device = codeDevice(joining.keys, joining.accountId),
    own = holder(t, f),
    holderPin = await own.read(),
    view = f.reply.roster,
    requester = new CodeRequester(1, view, device);
  assert.equal(requester.words.length, 4);
  // A substituted device (the server's own keys) gives a different code; the spoken words never match it.
  const server = deviceKeys(joining.accountId, f.random);
  const fake = new CodeApprover({
    request: { ...requester.request, device: codeDevice(server, joining.accountId) },
    pin: holderPin,
    signer: f.keys,
    person: true,
  });
  assert.deepEqual(fake.type(requester.words.join(' ')), { matched: false, attemptsLeft: 2 });
  // Typing something that is not four list words costs no attempt.
  assert.deepEqual(fake.type('not words at all'), { matched: false, attemptsLeft: 2 });
  assert.deepEqual(fake.type(requester.words.join(' ')), { matched: false, attemptsLeft: 1 });
  assert.throws(() => fake.type(requester.words.join(' ')), { code: 'SECRETS_CODE_CLOSED' });
  assert.throws(() => fake.type(requester.words.join(' ')), { code: 'SECRETS_CODE_CLOSED' });
  // No agent path approves.
  assert.throws(
    () => new CodeApprover({ request: requester.request, pin: holderPin, signer: f.keys, person: false }),
    { code: 'PERSON_REQUIRED' },
  );
  // Gate B2 H1: a fresh read approves once; the next approval reads again.
  assert.throws(
    () => new CodeApprover({ request: requester.request, pin: holderPin, signer: f.keys, person: true }),
    { code: 'SECRETS_NOT_ALLOWED', message: /fresh read/ },
  );

  const approver = new CodeApprover({
    request: requester.request,
    pin: await own.read(),
    signer: f.keys,
    person: true,
  });
  // Before typing, the person sees what a match grants: another account's device, as a member.
  assert.deepEqual(approver.grant, {
    purpose: 1,
    accountHandle: 'fixture-member',
    displayName: 'new-device',
    fingerprint: joining.keys.id.subarray(0, 8).toString('hex'),
    ownAccount: false,
    role: 2,
  });
  const typed = approver.type(requester.words.join(' '));
  assert.equal(typed.matched, true);
  publish(f, typed);
  const entry = typed.roster.entries.find(e => e.id.equals(joining.keys.id));
  assert.equal(entry.role, 2);
  assert.equal(entry.how, 2);

  const c = pinStore(t, joining.keys),
    before = c.files();
  const plain = { forgeProjectId: f.request.forgeProjectId, setKind: 1, recipient: recipient(joining.keys) };
  await assert.rejects(c.pins.verifyAndSave(f.reply, plain, 1), { code: 'SECRETS_ROSTER_REFUSED' });
  assert.deepEqual(c.files(), before);
  // Wrong replies count; the right one returns the only anchor that pins this view.
  const wrong = typed.reply[0] === 'abandon' ? 'ability ability' : 'abandon abandon';
  assert.deepEqual(requester.confirm(wrong, typed.approval), {
    matched: false,
    attemptsLeft: 2,
  });
  const confirmed = requester.confirm(typed.reply.join(' '), typed.approval);
  assert.equal(confirmed.matched, true);
  assert.throws(() => requester.confirm(typed.reply.join(' '), typed.approval), {
    code: 'SECRETS_CODE_CLOSED',
  });
  const opened = await c.pins.verifyAndSave(f.reply, { ...plain, anchor: confirmed.anchor }, 1);
  assert(opened.secrets[0].value.equals(value));
  clear(opened);
  const pin = (await c.pins.load(f.request.forgeProjectId, 1)).pin;
  assert.equal(pin.confirmed, 'code');
  assert.equal(pin.roster.rosterVersion, 2);
  // T18 (Gate B2 M2): what the journey sends, signs and pins on either side holds no value, set key or device key.
  assertNoPlaintext(
    'code journey',
    { request: requester.request, words: requester.words, grant: approver.grant, typed },
    { values: [value], keys: [f.key, ...deviceSecrets(f.keys), ...deviceSecrets(joining.keys)] },
  );
  const checked = assertLocalFiles(
    [
      { label: 'requester', keys: joining.keys, directory: c.directory },
      { label: 'holder', keys: f.keys, directory: own.directory },
    ],
    { values: [value], setKeys: [f.key] },
  );
  for (const side of ['requester', 'holder']) assert(checked[side].length >= 3, side);
});

test('T36/T74 a staged approval on a fake roster gives a different reply and three wrong replies close the request', async t => {
  const f = fixture(),
    joining = newAccountDevice(f),
    device = codeDevice(joining.keys, joining.accountId),
    real = new CodeRequester(1, f.reply.roster, device),
    own = holder(t, f),
    holderPin = await own.read();
  // The server shows the requester a roster the holder never trusted: the holder refuses, nothing to type.
  const forged = fixture(23),
    shown = new CodeRequester(1, forged.reply.roster, device);
  assert.throws(
    () =>
      new CodeApprover({
        request: { ...shown.request, setId: f.reply.roster.setId, projectId: f.reply.roster.projectId },
        pin: holderPin,
        signer: f.keys,
        person: true,
      }),
    { code: 'SECRETS_CODE_ROSTER_MISMATCH' },
  );
  // A server-made approval on its own roster cannot answer the real request.
  const staged = new CodeApprover({
    request: { ...shown.request },
    pin: await freshPin(t, forged),
    signer: forged.keys,
    person: true,
  }).type(shown.words.join(' '));
  assert.throws(() => real.confirm(staged.reply.join(' '), staged.approval), {
    code: 'SECRETS_FORK',
  });
  // A roster view that moves closes the request: its nonce is wiped and a new request draws a new one.
  const nonce = Buffer.from(real.request.nonce);
  assert.equal(real.sameView(forged.reply.roster), false);
  assert(real.request.nonce.every(byte => byte === 0));
  assert.throws(() => real.confirm('abandon abandon', staged.approval), { code: 'SECRETS_CODE_CLOSED' });
  const again = new CodeRequester(1, f.reply.roster, device);
  assert.notDeepEqual(again.request.nonce, nonce);
  const typed = new CodeApprover({
    request: again.request,
    pin: await own.read(),
    signer: f.keys,
    person: true,
  }).type(again.words.join(' '));
  publish(f, typed);
  const wrong = typed.reply[0] === 'abandon' ? 'ability ability' : 'abandon abandon';
  assert.equal(again.confirm(wrong, typed.approval).attemptsLeft, 2);
  assert.equal(again.confirm(wrong, typed.approval).attemptsLeft, 1);
  assert.throws(() => again.confirm(wrong, typed.approval), {
    code: 'SECRETS_CODE_CLOSED',
  });
  assert.throws(() => again.confirm(typed.reply.join(' '), typed.approval), {
    code: 'SECRETS_CODE_CLOSED',
  });
});

test('F1 a code anchor is accepted only from a matched reply and only on the chain an existing pin walked', async t => {
  const f = fixture(),
    joining = newAccountDevice(f),
    device = codeDevice(joining.keys, joining.accountId),
    request = {
      forgeProjectId: f.request.forgeProjectId,
      setKind: 1,
      firstContact: true,
      recipient: recipient(joining.keys),
    };
  const handmade = { kind: 'code', value: { purpose: 1, roster: clone(f.reply.roster), headFloor: null } };
  const { anchor } = runCode(f, { purpose: 1, device, holderPin: await freshPin(t, f) });
  assert.throws(() => verifySealedReply(f.reply, null, { ...request, anchor: handmade }), {
    code: 'SECRETS_ROSTER_REFUSED',
  });
  const result = verifySealedReply(f.reply, null, { ...request, anchor });
  assert.equal(result.pin.confirmed, 'code');
  clear(result);
  // The same anchor offered against another set is refused.
  const other = fixture(29);
  assert.throws(
    () => verifySealedReply(other.reply, null, { ...request, forgeProjectId: 'fixture-project', anchor }),
    { code: 'SECRETS_ROSTER_REFUSED' },
  );
});

test('T70 raise: a member device becomes owner only through a purpose-raise code and a role-change transition', async t => {
  const f = fixture(),
    member = deviceKeys(f.account, f.random),
    device = codeDevice(member, f.account);
  f.transition({ added: [f.entry(member, { role: 2, how: 4, addedAtRosterVersion: 2 })] });
  f.wrap();
  const memberRequest = {
    forgeProjectId: f.request.forgeProjectId,
    setKind: 1,
    recipient: recipient(member),
  };
  const memberPin = verifySealedReply(f.reply, null, {
    ...memberRequest,
    machineAnchor: f.reply.genesis,
  }).pin;
  // Neither the member itself nor an approval without a code raises it.
  assert.throws(
    () => createTransition(f.reply.roster, delta({ roles: [{ id: member.id, role: 1 }] }), member),
    {
      code: 'SECRETS_ROSTER_REFUSED',
    },
  );
  assert.throws(() => new CodeRequester(2, f.reply.roster, codeDevice(f.keys, f.account)), {
    code: 'SECRETS_NOT_ALLOWED',
  });
  const { typed, anchor } = runCode(f, { purpose: 2, device, holderPin: await freshPin(t, f) });
  assert.deepEqual(typed.approval.transition.delta.roles, [{ id: member.id, role: 1 }]);
  const result = verifySealedReply(f.reply, memberPin, { ...memberRequest, anchor });
  assert.equal(result.pin.roster.entries.find(e => e.id.equals(member.id)).role, 1);
  assert.equal(result.pin.confirmed, 'code');
  clear(result);
});

test('d4/C7 a walk-only Checks pin is display-only until a proposer code upgrades it (T78)', async t => {
  const { checks, dev, development, member, memberRequest } = checksWithMember(),
    device = codeDevice(member.keys, member.accountId);
  const walked = verifySealedReply(checks.reply, null, memberRequest);
  assert.equal(walked.pin.confirmed, 'none');
  assert.equal(walked.pin.holder, false);
  for (const use of ['proposal', 'join', 'wrap'])
    assert.throws(() => requireConfirmedBase(walked.pin, use), { code: 'SECRETS_CODE_NEEDED' });
  // Holder without a code: a walk-only view cannot approve (it would sign a Checks head or a wrap).
  assert.throws(
    () =>
      new CodeApprover({
        request: new CodeRequester(3, checks.reply.roster, device).request,
        pin: walked.pin,
        signer: member.keys,
        development,
        person: true,
      }),
    { code: 'SECRETS_CODE_NEEDED' },
  );
  const { typed, anchor } = runCode(checks, {
    purpose: 3,
    view: walked.pin.roster,
    device,
    holderPin: await freshPin(t, checks),
    development: await freshPin(t, dev),
  });
  assert(typed.approval.head.proposers.some(p => p.deviceId.equals(member.keys.id)));
  const upgraded = verifySealedReply(checks.reply, walked.pin, {
    ...memberRequest,
    firstContact: false,
    anchor,
  });
  assert.equal(upgraded.pin.confirmed, 'code');
  requireConfirmedBase(upgraded.pin, 'proposal');
  requireConfirmedBase(upgraded.pin, 'join');
  // The upgrade survives later reads without a code.
  checks.bump();
  checks.signHead();
  const later = verifySealedReply(checks.reply, upgraded.pin, { ...memberRequest, firstContact: false });
  assert.equal(later.pin.confirmed, 'code');
  // A second request for a device already in proposers is refused before any code exists.
  const ownerPin = await freshPin(t, checks);
  assert.throws(
    () =>
      new CodeApprover({
        request: new CodeRequester(3, checks.reply.roster, device).request,
        pin: ownerPin,
        signer: checks.keys,
        development,
        person: true,
      }),
    { code: 'SECRETS_NOT_ALLOWED' },
  );
});

test('d4 a Checks wrap is never opened on a walk-only first contact; an add code makes the owner device a holder', async t => {
  const f = fixture(17, 'fixture-project', 2),
    owner = deviceKeys(f.account, f.random),
    device = codeDevice(owner, f.account, 'second-owner-device');
  // A Checks recipient always needs a person, even from a full owner device.
  const entry = f.entry(owner, { how: 4, addedAtRosterVersion: 2 });
  assert.throws(
    () =>
      createTransition(f.reply.roster, delta({ added: [entry] }), f.keys, {
        development: f.request.development.roster,
      }),
    { code: 'PERSON_REQUIRED' },
  );
  const view = f.reply.roster,
    { anchor } = runCode(f, {
      purpose: 1,
      view,
      device,
      holderPin: await freshPin(t, f),
      development: await freshPin(t, f.dev),
    });
  const c = pinStore(t, owner),
    before = c.files(),
    request = { ...f.request, recipient: recipient(owner) };
  await assert.rejects(c.pins.verifyAndSave(f.reply, { ...request, anchor: { kind: 'checks-genesis' } }, 1), {
    code: 'SECRETS_CODE_NEEDED',
  });
  assert.deepEqual(c.files(), before);
  clear(await c.pins.verifyAndSave(f.reply, { ...request, anchor }, 1));
  const pin = (await c.pins.load(f.request.forgeProjectId, 2)).pin;
  assert.equal(pin.holder, true);
  assert.equal(pin.confirmed, 'code');
  assert.equal(pin.roster.entries.find(e => e.id.equals(owner.id)).how, 4);
});

test('T95 re-pin by code restores a lost or too-old pin with the holder head as its floor, never a healthy one', async t => {
  const f = fixture(),
    second = deviceKeys(f.account, f.random),
    device = codeDevice(second, f.account, 'second-device');
  f.transition({ added: [f.entry(second, { how: 4, addedAtRosterVersion: 2 })] });
  f.wrap();
  const c = pinStore(t, second),
    request = { forgeProjectId: f.request.forgeProjectId, setKind: 1, recipient: recipient(second) };
  clear(await c.pins.verifyAndSave(f.reply, { ...request, machineAnchor: f.reply.genesis }, 1));
  const older = clone(f.reply);
  f.bump();
  f.name('API_TOKEN');
  const pinFile = join(
    c.directory,
    forgeSecretId('project', request.forgeProjectId).toString('hex') + '.bin',
  );
  const own = holder(t, f);
  const { anchor, typed } = runCode(f, { purpose: 4, device, holderPin: await own.read() });
  await assert.rejects(c.pins.repinWithCode(f.reply, { ...request, anchor }, true), {
    code: 'SECRETS_NOT_ALLOWED',
  });
  await assert.rejects(c.pins.repinWithCode(f.reply, { ...request, anchor }, false), {
    code: 'SECRETS_PIN_LOST',
  });
  unlinkSync(pinFile);
  // Below the floor, or a different head at the floor version: refused, nothing written.
  const before = c.files();
  await assert.rejects(c.pins.repinWithCode(older, { ...request, anchor }, true), {
    code: 'SECRETS_ROLLBACK',
  });
  const forkedHead = clone(f.reply);
  forkedHead.head.signedAt += 7;
  forkedHead.head.signature = signBytes(headBytes(forkedHead.head), f.keys.sign);
  await assert.rejects(c.pins.repinWithCode(forkedHead, { ...request, anchor }, true), {
    code: 'SECRETS_FORK',
  });
  assert.deepEqual(c.files(), before);
  assert.equal(typed.approval.head.headVersion, f.reply.head.headVersion);
  clear(await c.pins.repinWithCode(f.reply, { ...request, anchor }, true));
  assert.equal((await c.pins.load(request.forgeProjectId, 1)).pin.confirmed, 'code');
  // Past the ring a healthy-but-old pin is replaced the same way; the holder reads along in steps.
  for (let i = 0; i < 65; i++) {
    f.bump();
    f.transition({});
    if (i % 32 === 31) await own.read();
  }
  f.wrap();
  await assert.rejects(c.pins.verifyAndSave(f.reply, request, 1), { code: 'SECRETS_PIN_TOO_OLD' });
  const late = runCode(f, { purpose: 4, device, holderPin: await own.read() });
  clear(await c.pins.repinWithCode(f.reply, { ...request, anchor: late.anchor }, true));
  assert.equal(
    (await c.pins.load(request.forgeProjectId, 1)).pin.roster.rosterVersion,
    f.reply.roster.rosterVersion,
  );
});

test('Gate B2 L7 an owner write, removal or share on a trust-on-first-use pin needs the device own code first', () => {
  const root = new URL('../', import.meta.url);
  assert.throws(() => requireConfirmedOwner({ confirmed: 'tofu', holder: false }), {
    code: 'SECRETS_CODE_NEEDED',
  });
  for (const confirmed of ['code', 'holder', 'none', 'machine'])
    requireConfirmedOwner({ confirmed, holder: false });
  // The owner paths that rest on a pin all check it; a new owner write path must be reviewed against L7 first.
  const read = path => readFileSync(new URL(path, root), 'utf8');
  assert.match(read('src/sealed-client.ts'), /requireConfirmedOwner\(state\.pin\)/);
  assert.match(read('src/sealed-unshare.ts'), /requireConfirmedOwner\(state\.pin\)/);
  assert.match(read('src/sealed-auto-client.ts'), /pinConfirmation\(result\.pin\) === 'tofu'/);
});
test('d4/C6 every proposal or join builder in src and convex checks the confirmed base first', () => {
  const root = new URL('../', import.meta.url),
    exempt = new Set(['src/sealed-future-records.ts', 'src/sealed-format.ts', 'src/sealed-anchors.ts']),
    // Client code that signs or seals a sealed proposal or join (exchange proposals are unrelated code-change
    // records). The server only stores these as opaque bytes and holds no pin, so d4 is a client gate.
    builder = /\bproposal(Seal)?Bytes\b|\bjoin(Request)?Bytes\b/;
  const walk = dir =>
    readdirSync(new URL(dir, root), { withFileTypes: true }).flatMap(e =>
      e.isDirectory()
        ? e.name === '_generated' || e.name === 'node_modules'
          ? []
          : walk(`${dir}${e.name}/`)
        : /\.tsx?$/.test(e.name)
          ? [`${dir}${e.name}`]
          : [],
    );
  const unguarded = walk('src/').filter(path => {
    if (exempt.has(path)) return false;
    const text = readFileSync(new URL(path, root), 'utf8');
    return builder.test(text) && !text.includes('requireConfirmedBase(');
  });
  assert.deepEqual(unguarded, []);
  // The pattern still names the real builders, so the guard cannot go silently stale.
  assert.match(readFileSync(new URL('src/sealed-future-records.ts', root), 'utf8'), builder);
  // Wraps are produced only from a key verifyCore opened (which refuses a walk-only base) or from genesis.
  // A new wrap producer, or a new place that mints a code anchor, must be reviewed against d4 first.
  const callers = pattern =>
    [...walk('src/'), ...walk('convex/')]
      .filter(path => pattern.test(readFileSync(new URL(path, root), 'utf8')))
      .sort();
  // src/sealed-auto.ts (A3 Automatic share): Development only, behind requireConfirmedBase(pin, 'wrap').
  assert.deepEqual(callers(/\bwrapSetKey\(/), [
    'src/sealed-auto.ts',
    'src/sealed-genesis.ts',
    'src/sealed-keys.ts',
    'src/sealed-rekey.ts',
  ]);
  assert.deepEqual(callers(/\bcodeConfirmedAnchor\(/), ['src/sealed-anchors.ts', 'src/sealed-code.ts']);
});

test('T95 a server that drops one transition cannot make a healthy pin replaceable by re-pin', async t => {
  const f = fixture(),
    second = deviceKeys(f.account, f.random),
    device = codeDevice(second, f.account, 'second-device');
  f.transition({ added: [f.entry(second, { how: 4, addedAtRosterVersion: 2 })] });
  f.wrap();
  const c = pinStore(t, second),
    request = { forgeProjectId: f.request.forgeProjectId, setKind: 1, recipient: recipient(second) };
  clear(await c.pins.verifyAndSave(f.reply, { ...request, machineAnchor: f.reply.genesis }, 1));
  f.bump();
  f.transition({});
  f.transition({});
  f.wrap();
  const { anchor } = runCode(f, { purpose: 4, device, holderPin: await freshPin(t, f) });
  const gapped = clone(f.reply);
  gapped.transitions = gapped.transitions.filter(tr => tr.fromVersion !== 2);
  await assert.rejects(c.pins.verifyAndSave(gapped, request, 1), { code: 'SECRETS_PIN_TOO_OLD' });
  const before = c.files();
  await assert.rejects(c.pins.repinWithCode(gapped, { ...request, anchor }, true), {
    code: 'SECRETS_NOT_ALLOWED',
    message: /served history is incomplete/,
  });
  assert.deepEqual(c.files(), before);
});

/** Owner device `f.keys`, a second owner-account device `second` and a device `removed` that the owner then
 * removes with a re-key. `old` is the served reply from before the removal, still inside the holder's history. */
function removedSince() {
  const f = fixture(),
    second = deviceKeys(f.account, f.random),
    removed = deviceKeys(f.account, f.random);
  f.transition({
    added: [
      f.entry(second, { how: 4, addedAtRosterVersion: 2 }),
      f.entry(removed, { how: 4, addedAtRosterVersion: 2 }),
    ],
  });
  f.wrap();
  f.bump();
  f.name('API_TOKEN');
  const old = clone(f.reply);
  f.rekey({ removed: [removed.id], epochBumped: 1 });
  return { f, second, removed, old };
}
/** The attack of Gate B2 H1: the old roster, still listing `removed`, under a head `removed` signs above the floor. */
function headByRemoved(f, old, removed) {
  const attack = clone(old);
  attack.head = {
    ...attack.head,
    headVersion: f.reply.head.headVersion + 1,
    prevHeadHash: framedHash(headBytes(f.reply.head)),
    signerId: removed.id,
  };
  attack.head.signature = signBytes(headBytes(attack.head), removed.sign);
  return attack;
}

test('Gate B2 H1 the holder approves only its own current roster, read fresh: an old view it once trusted is refused', async t => {
  const { f, removed, old } = removedSince(),
    joining = newAccountDevice(f),
    device = codeDevice(joining.keys, joining.accountId),
    own = holder(t, f),
    fresh = await own.read();
  // The old view is inside the holder's 64-version history, but it is not the holder's current roster.
  assert(fresh.rosterHashes.some(e => e.version === old.roster.rosterVersion));
  assert(old.roster.entries.some(e => e.id.equals(removed.id)));
  const used = [];
  for (const purpose of [1, 4]) {
    const stale = new CodeRequester(
      purpose,
      old.roster,
      purpose === 1 ? device : codeDevice(f.keys, f.account, 'fixture-device'),
    );
    const pin = await own.read();
    used.push(pin);
    assert.throws(() => new CodeApprover({ request: stale.request, pin, signer: f.keys, person: true }), {
      code: 'SECRETS_CODE_ROSTER_MISMATCH',
    });
  }
  // Only a server read approves, once: never a pin loaded from disk, verified outside the pin store, saved from
  // this device's own write, or already used.
  const current = new CodeRequester(1, f.reply.roster, device).request,
    ownWrite = await own.pins.verifyAndSave(f.reply, f.request, 1);
  clear(ownWrite);
  for (const pin of [(await own.pins.load(f.request.forgeProjectId, 1)).pin, f.pin(), ownWrite.pin, used[0]])
    assert.throws(() => new CodeApprover({ request: current, pin, signer: f.keys, person: true }), {
      code: 'SECRETS_NOT_ALLOWED',
      message: /fresh read/,
    });
  // An add code pins the roster after the step the holder signed: the pre-step roster is a rollback.
  const before = clone(f.reply),
    { anchor } = runCode(f, { purpose: 1, device, holderPin: await own.read() }),
    request = {
      forgeProjectId: f.request.forgeProjectId,
      setKind: 1,
      firstContact: true,
      recipient: recipient(joining.keys),
      anchor,
    };
  assert.equal(anchor.value.roster.rosterVersion, before.roster.rosterVersion + 1);
  assert(anchor.value.roster.entries.some(e => e.id.equals(joining.keys.id)));
  assert.throws(() => verifySealedReply(before, null, request), { code: 'SECRETS_ROLLBACK' });
  clear(verifySealedReply(f.reply, null, request));
});

test('Gate B2 H1 after a re-pin by code, a head by a device removed since is refused and pin bytes stay unchanged', async t => {
  const { f, second, removed, old } = removedSince(),
    c = pinStore(t, second),
    request = { forgeProjectId: f.request.forgeProjectId, setKind: 1, recipient: recipient(second) },
    secondDevice = codeDevice(second, f.account, 'second-device'),
    own = holder(t, f),
    empty = c.files();
  // The H1 path: the second device has no pin and is served the old view. The holder refuses it now; what a
  // holder on the old rule signed (its current head over that view) no longer answers the request.
  const stale = new CodeRequester(4, old.roster, secondDevice),
    holderPin = await own.read();
  assert.throws(
    () => new CodeApprover({ request: stale.request, pin: holderPin, signer: f.keys, person: true }),
    { code: 'SECRETS_CODE_ROSTER_MISMATCH' },
  );
  const oldRule = signBytes(
    repinBytes(
      { ...f.reply.roster, rosterVersion: stale.request.rosterVersion },
      stale.request.rosterHash,
      f.reply.head,
      framedHash(headBytes(f.reply.head)),
      second.id,
      stale.request.nonce,
    ),
    f.keys.sign,
  );
  assert.throws(
    () =>
      stale.confirm('abandon abandon', {
        purpose: 4,
        head: f.reply.head,
        signerId: f.keys.id,
        signature: oldRule,
      }),
    { code: 'SECRETS_ROSTER_REFUSED' },
  );
  assert.deepEqual(c.files(), empty);
  // It re-pins by code with the holder's fresh current view.
  const { anchor } = runCode(f, { purpose: 4, device: secondDevice, holderPin: await own.read() });
  assert(!anchor.value.roster.entries.some(e => e.id.equals(removed.id)));
  clear(await c.pins.repinWithCode(f.reply, { ...request, anchor }, true));
  const pinned = c.files(),
    attack = headByRemoved(f, old, removed);
  // The served old roster still lists the removed device and its head is above the floor: refused both ways.
  await assert.rejects(c.pins.verifyAndSave(attack, request, 1), { code: 'SECRETS_ROLLBACK' });
  assert.throws(() => verifySealedReply(attack, null, { ...request, firstContact: true, anchor }), {
    code: 'SECRETS_ROLLBACK',
  });
  // On the current roster the removed device has no write authority either.
  const current = clone(f.reply);
  current.head = {
    ...attack.head,
    rosterVersion: f.reply.roster.rosterVersion,
    rosterHash: f.reply.head.rosterHash,
    epoch: f.reply.head.epoch,
  };
  current.head.signature = signBytes(headBytes(current.head), removed.sign);
  await assert.rejects(c.pins.verifyAndSave(current, request, 1), { code: 'SECRETS_ROSTER_REFUSED' });
  assert.deepEqual(c.files(), pinned);
  assert.equal((await c.pins.load(request.forgeProjectId, 1)).pin.confirmed, 'code');
});
