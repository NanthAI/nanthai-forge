// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Slice 5 review F3 (Item 41a0df87): `nforge secret machine rm` revokes a leaked CI machine key. One owner-signed
// Checks step removes the machine and re-keys, the same mutation drops its reader row, and the rotate list names
// what the key could open. Generated test material only: every value below is synthetic.
import './check-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { clone, setup } from './helpers/sealed-hosted.mjs';
import { addMachine, checksClient } from '../dist/sealed-checks.js';
import { removeMachine } from '../dist/sealed-machine-rm.js';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { removalReply, rotateList } from '../dist/sealed-unshare.js';
import { machineRunFor } from '../dist/sealed-run.js';
import { decodeMachineBundle, machineReadToken } from '../dist/sealed-machine.js';
import { sealedRead } from '../dist/sealed-transport.js';
import { verifySealedReply } from '../dist/sealed-verify.js';
import { MAX_FORMER } from '../dist/sealed-roster.js';
import { sealedCli } from '../dist/sealed-cli.js';
import { assertLocalFiles, assertNoPlaintext } from './helpers/sealed-no-plaintext.mjs';

const machines = await import(moduleUrl('../convex/sealedMachines.ts'));
const { SEALED_WRITE_WORK } = await import(moduleUrl('../convex/sealedSecretGate.ts'));
const code = error =>
  error.code ?? (typeof error.data === 'string' ? JSON.parse(error.data).code : error.data?.code);
const synthetic = label => Buffer.from(`synthetic-${label}-${randomBytes(6).toString('hex')}`);
const wipe = result => {
  result?.key?.fill(0);
  for (const secret of result?.secrets ?? []) secret.value.fill(0);
};

/** An owner with Checks holding three names and two CI machines: `ci` (to remove) and `ci-kept`. */
async function project(t, names = ['API_TOKEN', 'DB_URL', 'OTHER']) {
  const h = setup(t);
  await h.client.write('DEV_ONLY', synthetic('dev'));
  const checks = await checksClient(h.client);
  const values = names.map(name => synthetic(name.toLowerCase()));
  for (const [i, name] of names.entries()) await checks.write(name, Buffer.from(values[i]));
  const leaked = await addMachine(checks, 'ci');
  const kept = await addMachine(checks, 'ci-kept');
  const transport = { read: input => machines.read._handler(h.s.ctx, { projectId: h.project, ...input }) };
  const run = (bundle, via = transport) =>
    machineRunFor({ bundle, forgeProjectId: h.project, transport: via });
  const rows = () => [...h.s.tables.sealedMachineReaders.values()];
  const readers = () => rows().filter(r => !r.removed).length;
  const writes = () => h.calls.filter(c => c.action === 'write').length;
  const view = async () => {
    const state = await checks.read();
    wipe(state);
    return state.pin;
  };
  /** What a copy of the database gives anyone: the stored Checks rows, served without any token check. */
  const copy = {
    read: async () => {
      const set = [...h.s.tables.sealedSecretSets.values()].find(r => r.kind === 2 && r.active);
      const row = [...h.s.tables.sealedSecretHistory.values()].find(r => r.kind === 2);
      return { payload: set.payload, history: { genesis: row.genesis, transitions: row.transitions } };
    },
  };
  return { ...h, checks, values, leaked, kept, transport, run, rows, readers, writes, view, copy };
}

test('F3 machine rm: one write removes the machine, re-keys Checks and drops its reader; the leaked key opens nothing new', async t => {
  const p = await project(t);
  const before = await p.view();
  assert.equal(p.readers(), 2);
  wipe(await p.run(p.leaked.bundle));
  const writes = p.writes();
  const done = await removeMachine(p.checks, p.leaked.machineId.slice(0, 8));
  assert.deepEqual(
    { label: done.label, machineId: done.machineId, already: done.already, rotate: done.rotate },
    { label: 'ci', machineId: p.leaked.machineId, already: false, rotate: ['API_TOKEN', 'DB_URL', 'OTHER'] },
  );
  // One write: the step, the re-key and the reader row, together.
  assert.equal(p.writes() - writes, 1);
  assert.equal(p.readers(), 1);
  const after = await p.view();
  assert.equal(after.roster.epoch, before.roster.epoch + 1);
  assert.equal(after.roster.rosterVersion, before.roster.rosterVersion + 1);
  assert.ok(!after.roster.entries.some(e => e.id.toString('hex') === p.leaked.machineId));
  // Forge stops serving the removed machine at once: its read is refused like any stranger's.
  await assert.rejects(p.run(p.leaked.bundle), error => code(error) === 'AUTH_REQUIRED');
  // A new value after the removal: the kept machine opens it under the new key; the leaked key, even with a full copy
  // of the database rows (no token check at all), has no wrap and opens nothing.
  const fresh = synthetic('api-rotated');
  await p.checks.write('API_TOKEN', Buffer.from(fresh));
  const opened = await p.run(p.kept.bundle);
  assert.ok(opened.secrets.find(s => s.name === 'API_TOKEN').value.equals(fresh));
  wipe(opened);
  await assert.rejects(p.run(p.leaked.bundle, p.copy), { code: 'SECRETS_ROSTER_REFUSED' });
  // The rotate list names the machine for each value it could open until that value changes.
  const pin = await p.view();
  assert.deepEqual(
    rotateList(pin.roster, pin.head).map(r => [r.name, r.machines]),
    [
      ['DB_URL', [{ id: p.leaked.machineId.slice(0, 8) }]],
      ['OTHER', [{ id: p.leaked.machineId.slice(0, 8) }]],
    ],
  );
  // Rotating the rest empties the list.
  for (const name of ['DB_URL', 'OTHER']) await p.checks.write(name, synthetic(`${name}-rotated`));
  const rotated = await p.view();
  assert.deepEqual(rotateList(rotated.roster, rotated.head), []);
});

test('F3 machine rm with an unknown outcome reconciles on retry and removes and re-keys once', async t => {
  for (const shape of ['reached', 'lost', 'aged-out']) {
    const p = await project(t);
    const before = await p.view();
    const write = p.checks.transport.write;
    // The request reaches the server (or not), and the answer is lost.
    p.checks.transport.write = async input => {
      if (shape !== 'lost') await write(input);
      throw new Error('synthetic connection reset');
    };
    let operationId;
    await assert.rejects(removeMachine(p.checks, 'ci'), error => {
      operationId = error.recovery?.operationId;
      return (
        error.code === 'SECRETS_WRITE_UNKNOWN' && error.message.includes(`--operation-id ${operationId}`)
      );
    });
    p.checks.transport.write = write;
    // The server's event ring no longer remembers the request: the roster decides.
    if (shape === 'aged-out')
      for (const row of p.s.tables.sealedSecretHistory.values()) if (row.kind === 2) row.events = [];
    const writes = p.writes();
    const done = await removeMachine(p.checks, 'ci', { operationId });
    assert.equal(done.machineId, p.leaked.machineId, shape);
    assert.deepEqual(done.rotate, ['API_TOKEN', 'DB_URL', 'OTHER'], shape);
    // The journalled request is re-sent as it was: one write, never a second step or re-key.
    assert.equal(p.writes() - writes, 1, shape);
    const after = await p.view();
    assert.equal(after.roster.epoch, before.roster.epoch + 1, shape);
    assert.equal(after.roster.rosterVersion, before.roster.rosterVersion + 1, shape);
    assert.equal(p.readers(), 1, shape);
    // Repeating the finished operation reports the removal again and writes nothing.
    const again = await removeMachine(p.checks, 'ci', { operationId });
    assert.equal(again.already, true, shape);
    assert.deepEqual(again.rotate, done.rotate, shape);
    assert.equal(p.writes() - writes, 1, shape);
    await assert.rejects(p.run(p.leaked.bundle), error => code(error) === 'AUTH_REQUIRED');
    wipe(await p.run(p.kept.bundle));
  }
});

test('F3 machine rm stays one write within the work cap, however many values it re-seals', async t => {
  const names = Array.from({ length: SEALED_WRITE_WORK + 1 }, (_, i) => `VALUE_${i}`);
  const p = await project(t, names);
  const writes = p.writes();
  const done = await removeMachine(p.checks, p.leaked.machineId);
  // A re-key keeps every value version, so the gate counts no changed record and no added entry.
  assert.equal(done.rotate.length, names.length);
  assert.equal(p.writes() - writes, 1);
  const opened = await p.run(p.kept.bundle);
  assert.equal(opened.secrets.length, names.length);
  wipe(opened);
});

test('F3 a hostile server replaying the pre-removal roster gets no new value sealed to the removed key', async t => {
  const p = await project(t);
  const old = clone(await p.checks.transport.read({ kind: 2 }));
  await removeMachine(p.checks, 'ci');
  const pin = await p.pins.load(p.project, 2);
  const read = p.checks.transport.read;
  p.checks.transport.read = async input => (input.kind === 2 ? clone(old) : read(input));
  t.after(() => (p.checks.transport.read = read));
  await assert.rejects(p.checks.read(), { code: 'SECRETS_ROLLBACK' });
  // The owner device never seals a value under the old key: the write stops before anything is sent.
  const writes = p.writes();
  await assert.rejects(p.checks.write('API_TOKEN', synthetic('api-replay')), { code: 'SECRETS_ROLLBACK' });
  assert.equal(p.writes(), writes);
  assert.deepEqual(await p.pins.load(p.project, 2), pin);
  // Served the old rows, the removed key opens only what it already could: exactly the rotate list.
  const opened = await p.run(p.leaked.bundle, { read: async () => clone(old) });
  assert.deepEqual(opened.secrets.map(s => s.name).sort(), ['API_TOKEN', 'DB_URL', 'OTHER']);
  wipe(opened);
});

test('F3 machine rm names one machine, and a person runs it', async t => {
  const p = await project(t);
  const writes = p.writes();
  // The unmatched input is not echoed: a pasted value or token must never reach an error line.
  const pasted = `tok_${randomBytes(8).toString('hex')}`;
  await assert.rejects(removeMachine(p.checks, pasted), error => {
    assert.equal(error.code, 'BAD_ARGUMENT');
    assert.match(
      error.message,
      /No machine in Checks matches that id or label.* Machines: ci \(id [0-9a-f]{8}\), ci-kept \(id [0-9a-f]{8}\)/,
    );
    assert.ok(!error.message.includes(pasted));
    return true;
  });
  const agentDev = Object.assign(Object.create(Object.getPrototypeOf(p.client)), p.client, { agent: true });
  await assert.rejects(removeMachine(await checksClient(agentDev), 'ci'), { code: 'PERSON_REQUIRED' });
  assert.equal(p.writes(), writes);
});

test('T18 machine rm, with an unknown outcome on the way, keeps values and keys out of every row, call and local file', async t => {
  const p = await project(t);
  const setKey = async () => {
    const state = await p.checks.read();
    try {
      return Buffer.from(state.key);
    } finally {
      wipe(state);
    }
  };
  const setKeys = [await setKey()];
  const write = p.checks.transport.write;
  p.checks.transport.write = async () => {
    throw new Error('synthetic connection reset');
  };
  let operationId;
  await assert.rejects(removeMachine(p.checks, 'ci'), error =>
    Boolean((operationId = error.recovery?.operationId)),
  );
  p.checks.transport.write = write;
  // The journal holds the unknown request between the two attempts.
  assertLocalFiles([{ label: 'owner', keys: p.f.keys, directory: p.directory }], {
    values: p.values,
    setKeys,
  });
  await removeMachine(p.checks, 'ci', { operationId });
  setKeys.push(await setKey());
  assert.ok(!setKeys[0].equals(setKeys[1]));
  const machineKeys = [p.leaked, p.kept].map(m => decodeMachineBundle(m.bundle).enc);
  assertNoPlaintext(
    'rows and calls',
    {
      rows: Object.fromEntries(Object.entries(p.s.tables).map(([k, v]) => [k, [...v.values()]])),
      calls: p.calls,
    },
    { values: p.values, keys: [...setKeys, ...machineKeys] },
  );
  const checked = assertLocalFiles([{ label: 'owner', keys: p.f.keys, directory: p.directory }], {
    values: p.values,
    setKeys: [...setKeys, ...machineKeys],
  });
  assert.ok(checked.owner.some(path => path.startsWith('operations/')));
});

/** What a holder that pins after the removal learns: a kept machine's bundle walks the signed history from its own roster. */
async function freshView(p, machine) {
  const b = decodeMachineBundle(machine.bundle);
  const token = machineReadToken(b);
  const wire = await p.transport.read({
    kind: 2,
    machineId: Uint8Array.from(b.machineId).buffer,
    token: Uint8Array.from(token).buffer,
  });
  const result = verifySealedReply(sealedRead(wire), null, {
    forgeProjectId: p.project,
    setKind: 2,
    machine: true,
    machineAnchor: b.roster,
    headFloor: b.headFloor,
    recipient: { id: b.machineId, enc: b.enc, kind: 2 },
  });
  wipe(result);
  return result.pin;
}
const journalFiles = p =>
  readdirSync(join(p.directory, 'operations')).map(n => join(p.directory, 'operations', n));

test('review 5b51e7f3 F1: an old machine-add retry, after its receipt and event aged out, never brings a removed key back', async t => {
  const p = await project(t);
  await removeMachine(p.checks, 'ci');
  // Forge keeps the removed reader as a tombstone: it opens nothing and its id is never registered again.
  const tomb = p.rows().find(r => r.removed);
  assert.equal(tomb.verifier.byteLength, 0);
  // Rotate every name and remove the other machine: the roster forgets the first machine, so only the server's
  // tombstone stands between the stale retry and the revoked key.
  for (const name of ['API_TOKEN', 'DB_URL', 'OTHER'])
    await p.checks.write(name, synthetic(`${name}-rotated`));
  await removeMachine(p.checks, 'ci-kept');
  const state = await p.view();
  assert.ok(!state.roster.former.some(f => f.deviceId.toString('hex') === p.leaked.machineId));
  // The local receipt and the server event for the original add are gone.
  for (const file of journalFiles(p)) rmSync(file);
  for (const row of p.s.tables.sealedSecretHistory.values()) if (row.kind === 2) row.events = [];
  const writes = p.writes();
  await assert.rejects(addMachine(p.checks, 'ci', { operationId: p.leaked.operationId }), {
    code: 'SECRETS_NOT_ALLOWED',
  });
  assert.equal(p.writes() - writes, 1);
  assert.equal(p.readers(), 0);
  assert.ok(!(await p.view()).roster.entries.some(e => e.id.toString('hex') === p.leaked.machineId));
  await assert.rejects(p.run(p.leaked.bundle), error => code(error) === 'AUTH_REQUIRED');
  // A tombstone never answers a read, even for a token that matched before.
  for (const row of p.s.tables.sealedMachineReaders.values()) assert.ok(row.removed);
  // Control: with the tombstone gone, the same retry registers the revoked key again. The tombstone is the barrier.
  for (const [id, row] of [...p.s.tables.sealedMachineReaders])
    if (row.machineId && row.removed) p.s.tables.sealedMachineReaders.delete(id);
  const again = await addMachine(p.checks, 'ci', { operationId: p.leaked.operationId });
  assert.equal(again.machineId, p.leaked.machineId);
});

test('review 5b51e7f3 F2: a removal retry removes the machine it first named, never a later one with the same label', async t => {
  for (const shape of ['reached-event-kept', 'reached-event-forgotten', 'lost-then-overtaken']) {
    const p = await project(t);
    const write = p.checks.transport.write;
    p.checks.transport.write = async input => {
      if (shape !== 'lost-then-overtaken') await write(input);
      throw new Error('synthetic connection reset');
    };
    let operationId;
    await assert.rejects(removeMachine(p.checks, 'ci'), error =>
      Boolean((operationId = error.recovery?.operationId)),
    );
    p.checks.transport.write = write;
    // A replacement machine takes the label while the outcome is unknown.
    const original = p.leaked.machineId;
    if (shape !== 'lost-then-overtaken') await removeMachine(p.checks, original, { operationId });
    const replacement = await addMachine(p.checks, 'ci');
    if (shape === 'reached-event-forgotten')
      for (const row of p.s.tables.sealedSecretHistory.values()) if (row.kind === 2) row.events = [];
    const writes = p.writes();
    const done = await removeMachine(p.checks, 'ci', { operationId }).catch(error => error);
    if (shape === 'lost-then-overtaken') {
      // The request never reached Forge and another head overtook it: it is rebuilt for the same machine id.
      assert.equal(done.machineId, original, shape);
      assert.equal(done.already, false, shape);
    } else {
      assert.equal(done.machineId, original, shape);
      assert.equal(done.already, true, shape);
      assert.equal(p.writes(), writes, shape);
    }
    const roster = (await p.view()).roster;
    const live = roster.entries.filter(e => e.entryKind === 2).map(e => e.id.toString('hex'));
    assert.deepEqual(live.sort(), [p.kept.machineId, replacement.machineId].sort(), shape);
    wipe(await p.run(replacement.bundle));
    await assert.rejects(p.run(p.leaked.bundle), error => code(error) === 'AUTH_REQUIRED', shape);
    // A settled receipt stays under the retry id: asking again reports the same machine, writes nothing.
    const again = await removeMachine(p.checks, 'ci', { operationId: done.operationId });
    assert.equal(again.machineId, original, shape);
    assert.equal(again.already, true, shape);
  }
});

test('review 5b51e7f3 F2: a retry id this device no longer keeps removes nothing, and a retry names the machine it started with', async t => {
  const p = await project(t);
  const writes = p.writes();
  await assert.rejects(
    removeMachine(p.checks, 'ci', {
      operationId: randomBytes(16)
        .toString('hex')
        .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5'),
    }),
    {
      code: 'NOT_FOUND',
    },
  );
  assert.equal(p.writes(), writes);
  assert.equal(p.readers(), 2);
  const write = p.checks.transport.write;
  p.checks.transport.write = async () => {
    throw new Error('synthetic connection reset');
  };
  let operationId;
  await assert.rejects(removeMachine(p.checks, 'ci'), error =>
    Boolean((operationId = error.recovery?.operationId)),
  );
  p.checks.transport.write = write;
  await assert.rejects(removeMachine(p.checks, 'ci-kept', { operationId }), {
    code: 'WORK_OPERATION_REUSED',
  });
  assert.equal(p.readers(), 2);
});

test('review 5b51e7f3 F3: the rotate list is signed in the roster, so a holder pinning later and repeated removals still see it', async t => {
  const p = await project(t);
  const extra = [];
  for (const label of ['x1', 'x2']) extra.push(await addMachine(p.checks, label));
  await removeMachine(p.checks, 'ci');
  for (const m of extra) await removeMachine(p.checks, m.machineId);
  const expected = [p.leaked, ...extra].map(m => m.machineId.slice(0, 8)).sort();
  const listed = pin => rotateList(pin.roster, pin.head).map(r => [r.name, r.machines.map(m => m.id).sort()]);
  // The owner's pin, and a holder that never saw the removals: both read the same signed record.
  for (const pin of [await p.view(), await freshView(p, p.kept)])
    assert.deepEqual(listed(pin), [
      ['API_TOKEN', expected],
      ['DB_URL', expected],
      ['OTHER', expected],
    ]);
  // Changing one name clears it everywhere; the others stay until each changes.
  await p.checks.write('API_TOKEN', synthetic('api-rotated'));
  for (const pin of [await p.view(), await freshView(p, p.kept)])
    assert.deepEqual(
      listed(pin).map(r => r[0]),
      ['DB_URL', 'OTHER'],
    );
  await p.checks.write('DB_URL', synthetic('db-rotated'));
  await p.checks.write('OTHER', synthetic('other-rotated'));
  // A removal once nothing needs rotating drops the old entries, so the list never fills with finished work.
  await removeMachine(p.checks, 'ci-kept');
  assert.deepEqual(
    (await p.view()).roster.former.map(f => f.deviceId.toString('hex')),
    [p.kept.machineId],
  );
});

test('review 5b51e7f3 F3: at the bound a removal stops with the way out and evicts no outstanding rotation', async t => {
  const p = await project(t);
  const state = await p.checks.read();
  try {
    const roster = state.pin.roster;
    const former = Array.from({ length: MAX_FORMER }, (_, i) => ({
      deviceId: Buffer.concat([Buffer.alloc(12), Buffer.from([0, 0, i >> 8, i & 255])]),
      signPub: Buffer.alloc(0),
      lastEpoch: roster.epoch,
    }));
    const crowded = { ...state, pin: { ...state.pin, roster: { ...roster, former } } };
    const entry = roster.entries.find(e => e.entryKind === 2);
    assert.throws(() => removalReply(p.checks, crowded, [entry]), {
      code: 'SECRETS_NOT_ALLOWED',
      message: /still hold values that were never changed/,
    });
  } finally {
    wipe(state);
  }
});

test('review 5b51e7f3: the CLI refuses an agent with PERSON_REQUIRED before it sets up any client or reads the project', async () => {
  // No terminal here, so this is an agent: the answer is the same whatever the project, set up or not.
  await assert.rejects(
    sealedCli(['machine', 'rm', 'ci', '--set', 'checks', '--root', '/nonexistent/forge-root']),
    {
      code: 'PERSON_REQUIRED',
    },
  );
});
