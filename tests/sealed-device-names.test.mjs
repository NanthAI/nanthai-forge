// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item fcfc7e62 review fixes: the given names of computers and CI machines survive on every surface that may show them,
// and the terminal prints a name only after cleaning it. Real sealed Convex modules on a synthetic hosted project;
// synthetic keys, names and values only.
import './check-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { server, setup } from './helpers/sealed-hosted.mjs';
import { device, owner } from './helpers/sealed-devices.mjs';
import { deviceFingerprint } from '../dist/sealed-join.js';
import { rotateLines, rotateList, unshareDevice } from '../dist/sealed-unshare.js';

const names = await import(moduleUrl('../convex/sealedSecretNames.ts'));
const code = expected => error => (error.code ?? error.data?.code) === expected;
const clear = result => {
  result?.key?.fill(0);
  for (const secret of result?.secrets ?? []) secret.value.fill(0);
};
const VALUE = Buffer.from('synthetic-names-value-0123456789'),
  ROTATED = Buffer.from('synthetic-rotated-value-9876543210');
const overview = (h, as = run => run()) =>
  as(() => server.overview._handler(h.s.ctx, { projectId: h.project }));
const set = h => [...h.s.tables.sealedSecretSets.values()].find(r => r.active && r.kind === 1);

test('review 1: a label the server supplies is cleaned and bounded where the terminal prints it', () => {
  const hostile = 'ci\n\x1b[2K\x1b[31mforged line‮‏' + 'x'.repeat(100);
  const lines = rotateLines([
    {
      name: 'API_TOKEN',
      devices: ['R2PA-9XNE'],
      deviceNames: { 'R2PA-9XNE': hostile },
      machines: [{ id: 'c876f11a', name: hostile }],
    },
  ]);
  assert.equal(lines.length, 1, 'one line per name');
  const [line] = lines;
  assert.equal(line.split('\n').length, 2, 'the label added no line break');
  assert.doesNotMatch(line, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮‎‏]/);
  assert.match(line, /“ci\[2K\[31mforged linex{40,60}” \(fp R2PA-9XNE\)/);
  assert.ok(line.length < 400, 'each label is bounded');
});

test('review 2: a computer listed under a placeholder takes its approved name on its next write; nothing is read for it', async t => {
  const h = setup(t),
    o = owner(h);
  await o.client.write('API_TOKEN', VALUE);
  // The signed entry says "this device" (this CLI was not told its name); the write took the sign-in's name beside it.
  assert.equal(set(h).entryNames?.length, 1);
  let people = (await overview(h)).sets[0].people.page[0];
  assert.deepEqual(
    people.computers.map(c => c.name),
    ['synthetic'],
  );
  // A set stored before the fix has no kept name: the code stands alone until the device writes again.
  delete set(h).entryNames;
  people = (await overview(h)).sets[0].people.page[0];
  assert.equal(people.computers[0].name, undefined);
  h.io.queries = 0;
  await overview(h);
  const reads = h.io.queries;
  await o.client.write('API_TOKEN', ROTATED);
  people = (await overview(h)).sets[0].people.page[0];
  assert.equal(people.computers[0].name, 'synthetic', 'healed by the next write');
  h.io.queries = 0;
  await overview(h);
  assert.equal(h.io.queries, reads, 'the page read is the same size before and after');
});

test('review 2: a kept name is shown only to its own account and drops out once the roster signs a name', async t => {
  const h = setup(t),
    o = owner(h);
  await o.client.write('API_TOKEN', VALUE);
  const m = device(h, t, 'fixture-member');
  await assert.rejects(m.client.read(), code('SECRETS_WAITING'));
  clear(await o.client.read());
  clear(await m.client.read());
  const own = await overview(h);
  const rows = own.sets[0].people.page;
  assert.deepEqual(
    rows.map(r => [r.mine === true, r.computers.map(c => c.name)]),
    [
      [true, ['synthetic']],
      [false, [undefined]],
    ],
    'another account computer shows its code alone',
  );
  // The writer's entry now carries a signed name: the kept one is dropped.
  const state = await o.client.read();
  const entry = state.pin.roster.entries.find(e => e.entryKind === 1 && e.accountId.length);
  const signed = { entries: [{ ...entry, displayName: 'MacBook Air' }] };
  assert.deepEqual(names.nextEntryNames(set(h), signed, { id: entry.id, name: 'x' }), []);
  clear(state);
});

test('review 3: a removed computer keeps its given name for the terminal and for its own account on the page', async t => {
  const h = setup(t),
    o = owner(h),
    m = device(h, t, 'fixture-member', { deviceName: 'dana-laptop' }),
    fp = deviceFingerprint(m.keys.id);
  await o.client.write('API_TOKEN', VALUE);
  await assert.rejects(m.client.read(), code('SECRETS_WAITING'));
  clear(await o.client.read());
  clear(await m.client.read());
  await unshareDevice(o.client, fp);
  // The page: the removed computer's own account sees its name beside the code; another account sees the code only.
  const mine = (await overview(h, m.as)).sets[0].rotate.page[0].devices[0];
  assert.deepEqual([mine.code, mine.name], [fp, 'dana-laptop']);
  const other = (await overview(h)).sets[0].rotate.page[0].devices[0];
  assert.deepEqual([other.code, other.name], [fp, undefined]);
  // The terminal: the read carries the server's name beside the signed records; the warning names the computer.
  const state = await o.client.read();
  const rotate = rotateList(state.pin.roster, state.pin.head, state.formerNames);
  assert.deepEqual(rotate[0].deviceNames, { [fp]: 'dana-laptop' });
  assert.match(rotateLines(rotate)[0], new RegExp(`API_TOKEN\\tremoved “dana-laptop” \\(fp ${fp}\\)`));
  assert.deepEqual(
    rotateList(state.pin.roster, state.pin.head)[0].deviceNames,
    undefined,
    'with no hint the code stands alone',
  );
  clear(state);
});

test('review 4: a computer removed before the fix recovers its name from the stored history, once', async t => {
  const h = setup(t),
    o = owner(h),
    m = device(h, t, 'fixture-member', { deviceName: 'dana-laptop' }),
    fp = deviceFingerprint(m.keys.id);
  await o.client.write('API_TOKEN', VALUE);
  await assert.rejects(m.client.read(), code('SECRETS_WAITING'));
  clear(await o.client.read());
  clear(await m.client.read());
  await unshareDevice(o.client, fp);
  // A set stored before names were kept: nothing on its row names the removed computer, and the roster that held it is gone.
  delete set(h).formerHandles;
  assert.equal((await overview(h, m.as)).sets[0].rotate.page[0].devices[0].name, undefined);
  await o.client.write('OTHER_TOKEN', VALUE);
  assert.equal((await overview(h, m.as)).sets[0].rotate.page[0].devices[0].name, 'dana-laptop');
  assert.equal(set(h).formerHandles.length, 1);
});

test('review 4: a removed entry nobody can name is marked, and no later write decodes the history again', async t => {
  const h = setup(t),
    o = owner(h);
  await o.client.write('API_TOKEN', VALUE);
  const id = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
  const roster = { former: [{ deviceId: Buffer.from(id), signPub: Buffer.alloc(0), lastEpoch: 1 }] };
  const first = names.nextHandles(set(h), [], roster, null);
  assert.deepEqual(
    first.formerHandles.map(f => f.name),
    [''],
    'a miss is recorded',
  );
  // The history is unreadable on purpose: decoding it again would throw.
  const poison = { genesis: new Uint8Array([1, 2, 3]).buffer, transitions: [new Uint8Array([4, 5]).buffer] };
  const again = names.nextHandles({ ...set(h), formerHandles: first.formerHandles }, [], roster, poison);
  assert.deepEqual(again.formerHandles, first.formerHandles);
});

test('walk 2026-11-25: an agent device that only proposes still keeps its approved name (real propose mutation)', async t => {
  const h = setup(t);
  // The walk's device: signed in as "MacBook Air", its roster entry signed before names were passed on ("this device").
  h.s.tables.cliCredentials.get('device-row').name = 'MacBook Air';
  const person = owner(h);
  await person.client.write('API_TOKEN', VALUE);
  assert.equal(set(h).entryNames?.[0]?.name, 'MacBook Air', 'a person write keeps it');
  delete set(h).entryNames; // a row stored before names were kept
  assert.equal((await overview(h)).sets[0].people.page[0].computers[0].name, undefined);
  // An agent never changes a held name directly: it proposes, which signs no head. That call must still name the device.
  const agent = person.make({ agent: true });
  const receipt = await agent.write('API_TOKEN', ROTATED);
  assert.ok(receipt.proposed, 'the agent made a proposal, not a head write');
  assert.equal(set(h).headVersion, 1, 'no head was written');
  assert.deepEqual(
    set(h).entryNames?.map(n => n.name),
    ['MacBook Air'],
    'the proposal recorded the device name',
  );
  assert.equal((await overview(h)).sets[0].people.page[0].computers[0].name, 'MacBook Air');
  // A second proposal adds nothing and never duplicates the entry.
  await agent.write('OTHER_TOKEN', ROTATED);
  await agent.write('API_TOKEN', VALUE);
  assert.equal(set(h).entryNames?.length, 1);
});

test('fcfc7e62 walk 2026-11-25: one computer shows one name in every set it holds, with no added read', async t => {
  const { checksClient } = await import('../dist/sealed-checks.js');
  const h = setup(t);
  await h.client.write('DEV_ONLY', VALUE);
  await (await checksClient(h.client)).write('CHECK_ONLY', VALUE);
  const sets = () => [...h.s.tables.sealedSecretSets.values()].filter(r => r.active);
  const dev = sets().find(r => r.kind === 1),
    checks = sets().find(r => r.kind === 2);
  // The walk: Development learned the name from a write; Checks has only the placeholder and no kept name yet.
  delete checks.entryNames;
  assert.equal(dev.entryNames?.length, 1);
  const names = read =>
    read.sets.map(s => [s.kind, s.people.page[0].computers.map(c => c.name)]).sort((a, b) => a[0] - b[0]);
  h.io.queries = 0;
  const before = await overview(h);
  const reads = h.io.queries;
  assert.deepEqual(names(before), [
    [1, ['synthetic']],
    [2, ['synthetic']],
  ]);
  // The stored Checks row is untouched: the name is shared at read time only.
  assert.equal(checks.entryNames, undefined);
  // The same read as before the change: nothing is added for the sharing.
  delete dev.entryNames;
  h.io.queries = 0;
  await overview(h);
  assert.equal(h.io.queries, reads, 'no added read');
});
