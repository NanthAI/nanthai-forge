// SPDX-License-Identifier: Apache-2.0
// Design 5.1 Automatic sharing: the Gate B1 M2 `automatic-join` anchor, the nine guards, the join request
// mutation and the holder wrap, against the real sealed Convex module on a synthetic hosted project.
import './check-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { clone, server, setup } from './helpers/sealed-hosted.mjs';
import { device, owner } from './helpers/sealed-devices.mjs';
import { fixture } from './helpers/sealed-fixture.mjs';
import { forgeSecretId } from '../dist/sealed-format.js';
import { deviceKeys } from '../dist/sealed-keys.js';
import { wipeDeviceKeys } from '../dist/sealed-local.js';
import { SealedClient } from '../dist/sealed-client.js';
import { runWithSecrets } from '../dist/secret-run.js';
import { sealedRunFor } from '../dist/sealed-run.js';
import {
  automaticShareReply,
  joinRequestBytes,
  ownDevicesNotice,
  planAutomaticShares,
} from '../dist/sealed-auto.js';
import { deviceFingerprint, encodeJoinRequest } from '../dist/sealed-join.js';
import { verifySealedReply } from '../dist/sealed-verify.js';
import { unshareDevice } from '../dist/sealed-unshare.js';
import { automaticJoinAnchor } from '../dist/sealed-anchors.js';
import { reserveShares, sharesLeftToday } from '../dist/sealed-share-log.js';
import { sealedRefusal } from '../dist/sealed-transport.js';
import { teachingByCode } from '../dist/error-teaching.js';
import { ForgeError } from '../dist/errors.js';
import { signBytes } from '../dist/sealed-keys.js';
import { headBytes } from '../dist/sealed-records.js';

const code = expected => error => (error.code ?? error.data?.code) === expected;
const clear = result => {
  result?.key?.fill(0);
  for (const secret of result?.secrets ?? []) secret.value.fill(0);
};
const VALUE = Buffer.from('synthetic-automatic-value-0123456789');
const sha = value => createHash('sha256').update(value).digest('hex');

function freshLane(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-sealed-lane-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'temp'));
  writeFileSync(join(root, '.env.example'), 'API_TOKEN\n');
  return root;
}
async function run(root, who) {
  let output = '';
  const sink = new Writable({
    write(chunk, _encoding, done) {
      output += chunk;
      done();
    },
  });
  const quiet = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const status = await runWithSecrets(
    {
      root,
      command: [
        process.execPath,
        '-e',
        "process.stdout.write(require('node:crypto').createHash('sha256').update(process.env.API_TOKEN ?? '').digest('hex'))",
      ],
    },
    input => sealedRunFor(who.client, input.set),
    { source: {}, stdout: sink, stderr: quiet, tempRoot: join(root, 'temp') },
  );
  return { status, output };
}
const set = h => [...h.s.tables.sealedSecretSets.values()][0];
const mine = h => owner(h).client;

test('Done-when: a new write member on Automatic runs nforge run in a fresh Lane and gets Development with nobody asked', async t => {
  const h = setup(t),
    o = owner(h),
    m = device(h, t, 'fixture-member'),
    fp = deviceFingerprint(m.keys.id),
    lane = freshLane(t);
  await o.client.write('API_TOKEN', VALUE);
  const calls = h.calls.length;
  // First run in a fresh Lane: the member's device posts its own join request and waits, printing its fingerprint.
  await assert.rejects(run(lane, m), e => e.code === 'SECRETS_WAITING' && e.message.includes(fp));
  assert.equal(set(h).joinRequests.length, 1);
  // The owner's next ordinary run wraps for it, in one signed write; the owner is told, with the Undo command.
  const ownerRun = await run(freshLane(t), o);
  assert.equal(ownerRun.status, 0);
  assert.equal(ownerRun.output, sha(VALUE));
  assert(o.notices.some(line => line.includes(fp) && line.includes(`nforge secret unshare ${fp}`)));
  assert.equal(set(h).joinRequests, undefined, 'only the matching roster step clears the request');
  // The member's next run gets the set: nobody typed a code, answered a prompt or ran a sharing command.
  const memberRun = await run(lane, m);
  assert.equal(memberRun.status, 0);
  assert.equal(memberRun.output, sha(VALUE));
  assert(m.notices.some(line => line.includes('trusting Forge on first use') && line.includes(fp)));
  const pinned = await m.client.pins.load(h.project, 1);
  assert.equal(pinned.pin.confirmed, 'tofu');
  assert.equal(pinned.pin.holder, true);
  // Scale budget: owner 1 read + 1 write for the share; no owner-side call while the member waits.
  const ownerCalls = h.calls.slice(calls).map(c => c.action);
  assert.deepEqual(ownerCalls, ['read', 'write']);
});

test('Done-when: a Checks recipient always needs a person: no join, anchor or automatic wrap exists for Checks', async t => {
  const h = setup(t),
    o = owner(h),
    m = device(h, t, 'fixture-member');
  await o.client.write('API_TOKEN', VALUE);
  const request = Uint8Array.from(joinRequestBytes(h.project, 'fixture-member', m.keys)).buffer;
  await assert.rejects(m.transport.join({ kind: 2, request }), code('SECRETS_NOT_ALLOWED'));
  const checks = fixture(17, 'fixture-project', 2),
    joiner = deviceKeys(forgeSecretId('account', 'fixture-member'), checks.random);
  checks.wrap();
  assert.throws(
    () =>
      verifySealedReply(checks.reply, null, {
        ...checks.request,
        recipient: { id: joiner.id, enc: joiner.enc, kind: 1 },
        anchor: automaticAnchor(joiner, 'fixture-member'),
      }),
    { code: 'SECRETS_ROSTER_REFUSED', message: /Checks and Production always need a person/ },
  );
  const plan = planAutomaticShares({
    roster: checks.reply.roster,
    revoked: [],
    requests: [joinRequestBytes('fixture-project', 'fixture-member', joiner)],
    self: checks.keys.id,
    quota: 3,
  });
  assert.deepEqual(plan.entries, []);
  // A hand-built automatic entry in Checks is refused by the one transition rule every writer and reader uses.
  assert.throws(
    () =>
      automaticShareReply(
        checks.reply,
        checks.key,
        [autoEntry(checks, joiner, 'fixture-member')],
        checks.keys,
        2,
        { roster: checks.reply.roster, holder: true, confirmed: 'holder' },
      ),
    code('SECRETS_ROSTER_REFUSED'),
  );
  // GB-08 d4 first: a walk-only Checks view never makes a wrap at all.
  assert.throws(
    () =>
      automaticShareReply(checks.reply, checks.key, [], checks.keys, 2, {
        roster: checks.reply.roster,
        holder: false,
        confirmed: 'none',
      }),
    code('SECRETS_CODE_NEEDED'),
  );
});

const automaticAnchor = (keys, account, requestedAt = 1) => ({
  kind: 'automatic-join',
  value: {
    id: keys.id,
    accountId: forgeSecretId('account', account),
    signPub: keys.signPub,
    encPub: keys.encPub,
    requestedAt,
  },
});
const autoEntry = (f, keys, account, more = {}) =>
  f.entry(keys, {
    accountId: forgeSecretId('account', account),
    role: 2,
    how: 3,
    addedBy: f.keys.id,
    addedAtRosterVersion: f.reply.roster.rosterVersion + 1,
    ...more,
  });
/** An owner-genesis Development fixture in Automatic mode with `joiner` added automatically. */
function automaticSet(options = {}) {
  const f = fixture(),
    joiner = deviceKeys(forgeSecretId('account', 'fixture-member'), f.random);
  if (options.mode !== 2) f.transition({ newSharingMode: 1 });
  f.transition({ added: [autoEntry(f, joiner, 'fixture-member', options.entry)] });
  f.name();
  f.wrap();
  const request = {
    forgeProjectId: f.request.forgeProjectId,
    setKind: 1,
    firstContact: true,
    recipient: { id: joiner.id, enc: joiner.enc, kind: 1 },
    anchor: automaticAnchor(joiner, 'fixture-member'),
  };
  return { f, joiner, request };
}

test('M2 the automatic-join anchor pins a Development roster that lists this device as its own automatic member, as tofu', () => {
  const { f, request } = automaticSet();
  const result = verifySealedReply(f.reply, null, request);
  assert.equal(result.pin.confirmed, 'tofu');
  assert.equal(result.secrets.length, 1);
  clear(result);
  // A later read carries the tofu mark; it never turns into a confirmed pin by itself.
  const later = verifySealedReply(f.reply, result.pin, { ...request, anchor: undefined });
  assert.equal(later.pin.confirmed, 'tofu');
  clear(later);
});

test('M2 the automatic-join anchor refuses Confirm mode, a non-automatic entry, another account, another device and no own request', () => {
  const confirm = automaticSet({ mode: 2 });
  assert.throws(
    () => verifySealedReply(confirm.f.reply, null, confirm.request),
    code('SECRETS_ROSTER_REFUSED'),
  );
  const cases = [
    ['confirm-added entry', s => s.request, { how: 2 }],
    ['another account', s => ({ ...s.request, anchor: automaticAnchor(s.joiner, 'someone-else') })],
    ['another device', s => ({ ...s.request, recipient: { id: s.f.keys.id, enc: s.f.keys.enc, kind: 1 } })],
    ['no own request', s => ({ ...s.request, anchor: automaticAnchor(s.joiner, 'fixture-member', 0) })],
  ];
  for (const [label, request, entry] of cases) {
    const s = automaticSet({ entry });
    assert.throws(
      () => verifySealedReply(s.f.reply, null, request(s)),
      { code: 'SECRETS_ROSTER_REFUSED', message: /^Automatic join trusts only/ },
      label,
    );
  }
  // A machine verification never takes this anchor, checked by the anchor itself.
  const s = automaticSet();
  assert.throws(
    () => automaticJoinAnchor(s.f.reply, { ...s.request, machine: true }, s.request.anchor.value),
    {
      code: 'SECRETS_ROSTER_REFUSED',
      message: /Development only/,
    },
  );
  assert.equal(automaticJoinAnchor(s.f.reply, s.request, s.request.anchor.value), s.f.reply.roster);
});

test('guard 1: Automatic sharing is a constant for kind development; the server refuses Checks and Production join requests', async t => {
  const h = setup(t),
    m = device(h, t, 'fixture-member');
  await mine(h).write('API_TOKEN', VALUE);
  const request = Uint8Array.from(joinRequestBytes(h.project, 'fixture-member', m.keys)).buffer;
  for (const kind of [2, 3])
    await assert.rejects(m.transport.join({ kind, request }), code('SECRETS_NOT_ALLOWED'));
  assert.equal(set(h).joinRequests, undefined);
});

test('guard 2: a second device of an account with an entry is never wrapped automatically, by the holder or the server', async t => {
  const h = setup(t),
    o = owner(h),
    first = device(h, t, 'fixture-member');
  await o.client.write('API_TOKEN', VALUE);
  await assert.rejects(first.client.read(), code('SECRETS_WAITING'));
  await o.client.read();
  clear(await first.client.read());
  const second = device(h, t, 'fixture-member', { member: false });
  await assert.rejects(
    second.client.read(),
    e => e.code === 'SECRETS_NOT_ALLOWED' && /already has a device/.test(e.message),
  );
  // A request the server took before the first device was added is still skipped by the holder.
  const state = await o.client.read();
  const plan = planAutomaticShares({
    roster: state.pin.roster,
    revoked: [],
    requests: [joinRequestBytes(h.project, 'fixture-member', second.keys)],
    self: o.client.keys.id,
    quota: 3,
  });
  clear(state);
  assert.deepEqual(plan.entries, []);
  assert.match(plan.skipped[0], /already has a device/);
});

test('guard 3: the new entry, its wrap and the head are one write; every other holder derives the notice from the signed step', async t => {
  const h = setup(t),
    o = owner(h),
    m = device(h, t, 'fixture-member'),
    fp = deviceFingerprint(m.keys.id);
  await o.client.write('API_TOKEN', VALUE);
  const lagging = await o.client.read(); // a holder view from before the share
  const pinBefore = lagging.pin;
  clear(lagging);
  await assert.rejects(m.client.read(), code('SECRETS_WAITING'));
  const writes = h.calls.filter(c => c.action === 'write').length;
  clear(await o.client.read());
  assert.equal(h.calls.filter(c => c.action === 'write').length, writes + 1);
  const history = [...h.s.tables.sealedSecretHistory.values()][0];
  assert.equal(history.transitions.length, 1);
  // A holder pinned before the share sees the notice from the walked transition, never from a server string.
  const wire = await server.read._handler(h.s.ctx, { projectId: h.project, kind: 1, rosterVersion: 1 });
  const { sealedRead } = await import('../dist/sealed-transport.js');
  const seen = verifySealedReply(sealedRead(wire), pinBefore, o.client.request());
  clear(seen);
  assert(seen.notices.some(line => line.includes(`fp ${fp}`) && line.includes('shared automatically')));
  // A server that hides the step and serves a head without it is refused as a fork, not shown a quieter set.
  const hidden = sealedRead(wire);
  hidden.transitions = [];
  assert.throws(() => verifySealedReply(hidden, pinBefore, o.client.request()), code('SECRETS_PIN_TOO_OLD'));
});

test('guard 4: the wrapping device keeps its notice across restarts, also after an agent command, until a person sees it on a terminal', async t => {
  const h = setup(t),
    o = owner(h, { agent: true }),
    m = device(h, t, 'fixture-member'),
    fp = deviceFingerprint(m.keys.id);
  await owner(h).client.write('API_TOKEN', VALUE);
  await assert.rejects(m.client.read(), code('SECRETS_WAITING'));
  clear(await o.client.read(true)); // the share runs inside an agent's command
  const kept = line =>
    line.includes(fp) &&
    line.startsWith(`This device shared Development of project ${h.project} automatically`);
  for (let restart = 0; restart < 2; restart++) {
    const again = owner(h, { agent: true });
    clear(await again.client.read(true));
    assert(again.notices.some(kept), 'restart without a terminal still shows the kept notice');
  }
  const person = owner(h, { terminal: true });
  clear(await person.client.read(true));
  assert(person.notices.some(kept));
  const after = owner(h, { terminal: true });
  clear(await after.client.read(true));
  assert(!after.notices.some(kept), 'cleared once shown to a person on a terminal');
});

test('guard 5: a machine or person key never wraps, and a fourth automatic share in a day is refused', async t => {
  const f = fixture();
  f.transition({ newSharingMode: 1 });
  f.wrap();
  const joiners = ['a', 'b', 'c', 'd'].map(a => ({
    account: `fixture-${a}`,
    keys: deviceKeys(forgeSecretId('account', `fixture-${a}`), f.random),
  }));
  const requests = joiners.map(j => joinRequestBytes('fixture-project', j.account, j.keys));
  const machine = f.random(16);
  const roster = {
    ...f.reply.roster,
    entries: [
      ...f.reply.roster.entries,
      {
        ...f.entry(),
        entryKind: 2,
        id: machine,
        signPub: Buffer.alloc(0),
        accountId: Buffer.alloc(0),
        role: 3,
      },
    ],
  };
  assert.deepEqual(
    planAutomaticShares({ roster, revoked: [], requests, self: machine, quota: 3 }).entries,
    [],
  );
  const plan = planAutomaticShares({
    roster: f.reply.roster,
    revoked: [],
    requests,
    self: f.keys.id,
    quota: 3,
  });
  assert.equal(plan.entries.length, 3);
  assert.match(plan.skipped[0], /3 automatic shares today/);
  // Across runs the quota is this device's own kept count of shares in the last day.
  const h = setup(t),
    o = owner(h);
  await o.client.write('API_TOKEN', VALUE);
  const members = [];
  for (const a of ['a', 'b', 'c', 'd']) {
    const m = device(h, t, `member-${a}`);
    await assert.rejects(m.client.read(), code('SECRETS_WAITING'));
    members.push(m);
    clear(await o.make().read());
  }
  const state = await o.client.read();
  clear(state);
  assert.equal(state.pin.roster.entries.length, 4, 'owner plus three automatic shares');
  assert.equal(set(h).joinRequests.length, 1);
  assert(o.notices.some(line => /3 automatic shares today/.test(line)));
});

test('guard 6: an automatic entry is always a member device of the requesting account; owner or person entries are refused', () => {
  const s = automaticSet();
  const entry = s.f.reply.roster.entries.find(e => e.how === 3);
  assert.equal(entry.role, 2);
  assert.equal(entry.entryKind, 1);
  for (const more of [{ role: 1 }, { entryKind: 3, role: 4, bindSig: Buffer.alloc(0) }]) {
    const f = fixture(),
      joiner = deviceKeys(forgeSecretId('account', 'fixture-member'), f.random);
    f.transition({ newSharingMode: 1 });
    f.wrap();
    assert.throws(
      () =>
        automaticShareReply(f.reply, f.key, [autoEntry(f, joiner, 'fixture-member', more)], f.keys, 2, {
          roster: f.reply.roster,
          holder: true,
        }),
      code('SECRETS_ROSTER_REFUSED'),
    );
  }
  // Whatever a request says, the holder builds role member, how auto, a device entry.
  const f = fixture(),
    joiner = deviceKeys(forgeSecretId('account', 'fixture-member'), f.random);
  f.transition({ newSharingMode: 1 });
  const plan = planAutomaticShares({
    roster: f.reply.roster,
    revoked: [],
    requests: [joinRequestBytes('fixture-project', 'fixture-member', joiner)],
    self: f.keys.id,
    quota: 3,
  });
  assert.deepEqual(
    plan.entries.map(e => [e.entryKind, e.role, e.how]),
    [[1, 2, 3]],
  );
});

test('guard 7: Undo removes the automatic device and re-keys, so it opens nothing written after, and lists what to rotate', async t => {
  const h = setup(t),
    o = owner(h),
    m = device(h, t, 'fixture-member'),
    fp = deviceFingerprint(m.keys.id);
  await o.client.write('API_TOKEN', VALUE);
  await assert.rejects(m.client.read(), code('SECRETS_WAITING'));
  clear(await o.client.read());
  clear(await m.client.read());
  await assert.rejects(unshareDevice(o.make({ agent: true }), fp), code('PERSON_REQUIRED'));
  const result = await unshareDevice(o.client, fp);
  assert.deepEqual(result, { removed: fp, rotate: ['API_TOKEN'], already: false });
  // Repeated after an unknown outcome: already gone, and the rotate list is still printed.
  assert.deepEqual(await unshareDevice(o.client, fp), { removed: fp, rotate: ['API_TOKEN'], already: true });
  assert.deepEqual(await unshareDevice(o.client, m.keys.id.toString('hex')), {
    removed: fp,
    rotate: ['API_TOKEN'],
    already: true,
  });
  const state = await o.client.read();
  clear(state);
  assert.equal(state.pin.roster.epoch, 2);
  assert(!state.pin.roster.entries.some(e => e.id.equals(m.keys.id)));
  await o.client.write('API_TOKEN', Buffer.from('synthetic-rotated-value-9876543210'));
  await assert.rejects(m.client.read(), code('SECRETS_ROSTER_REFUSED'));
  // The removed device never comes back automatically: it needs a code.
  const plan = planAutomaticShares({
    roster: state.pin.roster,
    revoked: [],
    requests: [joinRequestBytes(h.project, 'fixture-member', m.keys)],
    self: o.client.keys.id,
    quota: 3,
  });
  assert.deepEqual(plan.entries, []);
});

test('guard 8: the trust-on-first-use residual stays bounded to the joiner its own request named', async t => {
  // A request posted for another account, or one not bound to this project, is refused by the server.
  const h = setup(t),
    m = device(h, t, 'fixture-member');
  await mine(h).write('API_TOKEN', VALUE);
  const other = deviceKeys(forgeSecretId('account', 'fixture-other'));
  for (const request of [
    joinRequestBytes(h.project, 'fixture-other', other),
    joinRequestBytes('another-project', 'fixture-member', m.keys),
  ])
    await assert.rejects(
      m.transport.join({ kind: 1, request: Uint8Array.from(request).buffer }),
      code('SECRETS_FORMAT_REFUSED'),
    );
  // Keys that do not match their signed binding are refused before storage.
  const forged = encodeJoinRequestUnchecked(h.project, 'fixture-member', m.keys, other);
  await assert.rejects(m.transport.join({ kind: 1, request: forged }), code('SECRETS_FORMAT_REFUSED'));
  assert.equal(set(h).joinRequests, undefined);
  // A device the roster lists without this device's own local join record is never trusted on first use: its
  // request reached the server another way (here, posted outside its client), and the holder shared it.
  const request = Uint8Array.from(joinRequestBytes(h.project, 'fixture-member', m.keys)).buffer;
  await m.transport.join({ kind: 1, request });
  clear(await mine(h).read());
  assert(!set(h).joinRequests?.length, 'shared');
  await assert.rejects(m.client.read(), code('SECRETS_ROSTER_REFUSED'));
  assert.equal(await m.client.pins.load(h.project, 1), null);
});
function encodeJoinRequestUnchecked(project, account, keys, other) {
  const bytes = joinRequestBytes(project, account, keys);
  // Swap in another device's encryption key after encoding: the binding no longer matches.
  const at = Buffer.from(bytes).indexOf(keys.encPub);
  const copy = Buffer.from(bytes);
  other.encPub.copy(copy, at);
  return Uint8Array.from(copy).buffer;
}

test('guard 9 / T85: the waiting device, its first run and the holder notice show one fingerprint; own-account devices are listed when they change', async t => {
  const h = setup(t),
    o = owner(h),
    m = device(h, t, 'fixture-member'),
    fp = deviceFingerprint(m.keys.id);
  await o.client.write('API_TOKEN', VALUE);
  await assert.rejects(m.client.read(), e => e.code === 'SECRETS_WAITING' && e.message.includes(fp));
  clear(await o.client.read());
  clear(await m.client.read());
  assert(o.notices.some(line => line.includes(`fp ${fp}`)));
  assert(m.notices.some(line => line.includes(`Its fingerprint: ${fp}`)));
  assert(
    m.notices.some(
      line => line.startsWith("Your account's devices in Development: this one") && line.includes(fp),
    ),
  );
  // A device later added for the same account is named on the next read, with its Undo.
  const s = automaticSet();
  const joined = verifySealedReply(s.f.reply, null, s.request);
  clear(joined);
  const sibling = deviceKeys(forgeSecretId('account', 'fixture-member'), s.f.random);
  s.f.bump();
  s.f.transition({
    added: [
      s.f.entry(sibling, {
        accountId: s.joiner.bindSig && forgeSecretId('account', 'fixture-member'),
        role: 2,
        how: 2,
        addedAtRosterVersion: s.f.reply.roster.rosterVersion + 1,
      }),
    ],
  });
  const line = ownDevicesNotice(joined.pin.roster, s.f.reply.roster, s.joiner.id);
  assert.match(
    line,
    new RegExp(`fp ${deviceFingerprint(sibling.id)}.*nforge secret unshare ${deviceFingerprint(sibling.id)}`),
  );
  assert.equal(ownDevicesNotice(s.f.reply.roster, s.f.reply.roster, s.joiner.id), null);
});

test('join requests: write members only, one per account, idempotent, bounded, and only in Automatic mode', async t => {
  const h = setup(t),
    o = owner(h);
  await o.client.write('API_TOKEN', VALUE);
  const reader = device(h, t, 'fixture-reader', { member: false });
  const readerRequest = Uint8Array.from(joinRequestBytes(h.project, 'fixture-reader', reader.keys)).buffer;
  await assert.rejects(
    reader.transport.join({ kind: 1, request: readerRequest }),
    code('PROJECT_UNAVAILABLE'),
  );
  const m = device(h, t, 'fixture-member');
  const request = Uint8Array.from(joinRequestBytes(h.project, 'fixture-member', m.keys)).buffer;
  assert.deepEqual(await m.transport.join({ kind: 1, request }), { accepted: true, replay: false });
  assert.deepEqual(await m.transport.join({ kind: 1, request }), { accepted: true, replay: true });
  const newer = deviceKeys(forgeSecretId('account', 'fixture-member'));
  const replacing = Uint8Array.from(joinRequestBytes(h.project, 'fixture-member', newer)).buffer;
  await m.transport.join({ kind: 1, request: replacing });
  assert.equal(set(h).joinRequests.length, 1, 'the newest device of an account replaces its earlier request');
  assert(Buffer.from(set(h).joinRequests[0].deviceId).equals(newer.id));
  for (let i = 0; i < 31; i++) {
    const d = device(h, t, `bulk-${i}`);
    await d.transport.join({
      kind: 1,
      request: Uint8Array.from(joinRequestBytes(h.project, `bulk-${i}`, d.keys)).buffer,
    });
  }
  const late = device(h, t, 'late-member');
  await assert.rejects(
    late.transport.join({
      kind: 1,
      request: Uint8Array.from(joinRequestBytes(h.project, 'late-member', late.keys)).buffer,
    }),
    code('SECRETS_NOT_ALLOWED'),
  );
  assert.equal(set(h).joinRequests.length, 32);
});

test('join requests are refused while Development uses Confirm, and the device names the code route with its fingerprint', async t => {
  const h = setup(t),
    o = owner(h);
  await o.client.write('API_TOKEN', VALUE);
  const row = set(h);
  const { decodeSealedWire, encodeSealedWire } = await import('../dist/sealed-wire.js');
  const payload = decodeSealedWire(new Uint8Array(row.payload));
  const m = device(h, t, 'fixture-member');
  const request = Uint8Array.from(joinRequestBytes(h.project, 'fixture-member', m.keys)).buffer;
  row.payload = encodeSealedWire({ ...payload, roster: { ...payload.roster, sharingMode: 2 } }).buffer;
  await assert.rejects(m.transport.join({ kind: 1, request }), code('SECRETS_NOT_ALLOWED'));
  await assert.rejects(
    m.client.read(),
    e => e.code === 'SECRETS_NOT_ALLOWED' && e.message.includes(deviceFingerprint(m.keys.id)),
  );
  assert.equal(set(h).joinRequests, undefined);
});

test('A2 review Low 4: an argument-validation refusal of a sealed write is a terminal update-the-CLI error, not an endless unknown', async t => {
  const h = setup(t);
  const client = new SealedClient(
    h.project,
    h.account,
    h.keys,
    h.pins,
    {
      ...h.transport,
      write: async () => {
        throw new Error(
          '[Request ID: synthetic] Server Error ArgumentValidationError: Object contains extra field `headHash`',
        );
      },
    },
    false,
  );
  const operationId = '00000000-0000-4000-8000-000000000001';
  await assert.rejects(client.write('API_TOKEN', VALUE, { operationId }), code('CLI_UPDATE_REQUIRED'));
  // The request was dropped as refused: the same operation is a fresh attempt, not a stuck unknown replay.
  await assert.rejects(client.write('API_TOKEN', VALUE, { operationId }), code('CLI_UPDATE_REQUIRED'));
  assert.equal(h.s.tables.sealedSecretSets.size, 0);
});

test('encodeJoinRequest refuses text that is not display-safe', () => {
  const keys = deviceKeys(forgeSecretId('account', 'fixture-member'));
  assert.throws(
    () =>
      encodeJoinRequest({
        v: 1,
        projectId: forgeSecretId('project', 'p'),
        setKind: 1,
        accountId: forgeSecretId('account', 'fixture-member'),
        id: keys.id,
        signPub: keys.signPub,
        encPub: keys.encPub,
        bindSig: keys.bindSig,
        displayName: 'evil\u001b[2Jname',
      }),
    code('SECRETS_FORMAT_REFUSED'),
  );
});

test('review 1: a share the server stores but reports as not stored keeps the holder notice and its quota slot', async t => {
  const h = setup(t),
    m = device(h, t, 'fixture-member'),
    fp = deviceFingerprint(m.keys.id),
    notices = [];
  const tables = () => ({
    sets: clone([...h.s.tables.sealedSecretSets]),
    history: clone([...h.s.tables.sealedSecretHistory]),
  });
  const restore = saved => {
    for (const [name, rows] of [
      ['sealedSecretSets', saved.sets],
      ['sealedSecretHistory', saved.history],
    ]) {
      h.s.tables[name].clear();
      for (const [k, v] of rows) h.s.tables[name].set(k, v);
    }
  };
  let lie = false,
    fork = null;
  const lying = {
    ...h.transport,
    write: async input => {
      if (!lie) return h.transport.write(input);
      const before = tables();
      await h.transport.write(input);
      fork = tables(); // kept for the joiner; the holder is shown the old head and told "not accepted"
      restore(before);
      return { accepted: false, replay: false };
    },
  };
  const holder = terminal =>
    new SealedClient(
      h.project,
      h.account,
      h.pins.store.load(),
      h.pins,
      lying,
      false,
      l => notices.push(l),
      terminal,
    );
  await holder(false).write('API_TOKEN', VALUE);
  await assert.rejects(m.client.read(), code('SECRETS_WAITING'));
  lie = true;
  clear(await holder(false).read());
  assert(fork, 'the holder signed and sent the wrap');
  lie = false;
  for (const row of h.s.tables.sealedSecretSets.values()) delete row.joinRequests;
  notices.length = 0;
  clear(await holder(true).read());
  assert(
    notices.some(l => l.includes(fp) && /did not confirm storing it/.test(l)),
    'the holder is told on a terminal',
  );
  const kept = h.pins.store.load();
  // The record stays (unconfirmed, shown once on the terminal) and so keeps its slot in the daily count.
  assert.deepEqual(
    kept.shares.map(r => [r.deviceId, r.state, r.shown]),
    [[m.keys.id.toString('hex'), 'unconfirmed', true]],
  );
  wipeDeviceKeys(kept);
  restore(fork);
  clear(await m.client.read()); // the joiner is served the fork the holder signed
});

test('review 9: concurrent runs on one holder never reserve more than three automatic shares a day', async t => {
  const h = setup(t),
    at = Date.UTC(2026, 10, 22, 12),
    ids = n => Array.from({ length: n }, (_, i) => Buffer.alloc(16, i + n * 16));
  const grants = await Promise.all([
    reserveShares(h.pins, h.project, ids(3), at),
    reserveShares(h.pins, h.project, ids(4), at),
  ]);
  assert.equal(grants.flat().length, 3);
  assert.equal(sharesLeftToday(h.pins, at), 0);
  // The same device again reuses its record instead of taking a new slot.
  const again = await reserveShares(h.pins, h.project, [grants.flat()[0]], at);
  assert.equal(again.length, 1);
  assert.equal(sharesLeftToday(h.pins, at), 0);
});

test('review 2: a join request whose fingerprint equals a listed, removed or planned device is never shared', () => {
  const f = fixture(),
    joiner = deviceKeys(forgeSecretId('account', 'fixture-member'), f.random);
  f.transition({ newSharingMode: 1 });
  const twin = Buffer.concat([joiner.id.subarray(0, 5), Buffer.alloc(11, 7)]);
  assert.equal(deviceFingerprint(twin), deviceFingerprint(joiner.id));
  const plan = planAutomaticShares({
    roster: { ...f.reply.roster, former: [{ deviceId: twin, signPub: Buffer.alloc(32, 1), lastEpoch: 1 }] },
    revoked: [],
    requests: [joinRequestBytes('fixture-project', 'fixture-member', joiner)],
    self: f.keys.id,
    quota: 3,
  });
  assert.deepEqual(plan.entries, []);
  assert.match(plan.skipped[0], /fingerprint of another device/);
});

test('review 5: a roster step drops join requests it made stale', async t => {
  const h = setup(t),
    o = owner(h),
    m = device(h, t, 'fixture-member');
  await o.client.write('API_TOKEN', VALUE);
  await assert.rejects(m.client.read(), code('SECRETS_WAITING'));
  // A request taken earlier for an account that has an entry by now (here, the owner's own account).
  const stale = deviceKeys(forgeSecretId('account', h.account));
  set(h).joinRequests.push({
    deviceId: Uint8Array.from(stale.id).buffer,
    request: Uint8Array.from(joinRequestBytes(h.project, h.account, stale)).buffer,
    at: 1,
  });
  clear(await o.client.read());
  assert.equal(set(h).joinRequests, undefined, 'the shared request and the stale one are both gone');
});

test('review 7: Development trusted on first use never anchors Checks, and a rebuild from its own head stays tofu', () => {
  const checks = fixture(17, 'fixture-project', 2);
  checks.wrap();
  const tofu = { ...checks.request, development: { ...checks.request.development, confirmed: 'tofu' } };
  assert.throws(() => verifySealedReply(checks.reply, null, tofu), {
    code: 'SECRETS_ROSTER_REFUSED',
    message: /trusted Development on first use/,
  });
  clear(verifySealedReply(checks.reply, null, checks.request)); // the same reply without tofu verifies
  // Rebuild (device-head anchor) of an automatically added device: the signed entry keeps the pin tofu.
  const s = automaticSet();
  s.f.reply.head.signerId = s.joiner.id;
  s.f.reply.head.signature = signBytes(headBytes(s.f.reply.head), s.joiner.sign);
  const rebuilt = verifySealedReply(s.f.reply, null, {
    ...s.request,
    anchor: { kind: 'device-head', value: { id: s.joiner.id, signPub: s.joiner.signPub } },
  });
  clear(rebuilt);
  assert.equal(rebuilt.pin.confirmed, 'tofu');
});

test('review 8: a refused share pauses automatic sharing on that holder for a day, with one notice', async t => {
  const h = setup(t),
    m = device(h, t, 'fixture-member'),
    notices = [];
  let writes = 0,
    refuse = false;
  const transport = {
    ...h.transport,
    write: async input => {
      if (!refuse) return h.transport.write(input);
      writes++;
      throw new ForgeError('AUTH_SCOPE_DENIED', 'synthetic scope refusal');
    },
  };
  const holder = () =>
    new SealedClient(h.project, h.account, h.pins.store.load(), h.pins, transport, false, l =>
      notices.push(l),
    );
  await holder().write('API_TOKEN', VALUE);
  await assert.rejects(m.client.read(), code('SECRETS_WAITING'));
  refuse = true;
  clear(await holder().read());
  clear(await holder().read());
  assert.equal(writes, 1, 'the second run does not retry the refused write');
  assert.equal(notices.filter(l => /refused by Forge \(AUTH_SCOPE_DENIED\)/.test(l)).length, 1);
});

test('review 3 and Gate B2 L1: SECRETS_WAITING teaches no replay loop; a sealed refusal shows fixed client text, never the server wording', () => {
  assert.equal(teachingByCode.SECRETS_WAITING.next, undefined);
  const refused = sealedRefusal(new ForgeError('SECRETS_NOT_ALLOWED', '32 devices are waiting\u001b[2J.'));
  assert.equal(refused.code, 'SECRETS_NOT_ALLOWED');
  assert.equal(
    refused.message,
    'Secret storage refused this operation: this device or account is not allowed to make that change here; local trust was not changed.',
  );
  assert.doesNotMatch(refused.message, /waiting|\u001b/);
  assert.equal(sealedRefusal(new ForgeError('AUTH_REQUIRED', 'x')).message.includes('x'), false);
});
