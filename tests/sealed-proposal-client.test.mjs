// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The proposal commands (Item 6466c6a5) against the real sealed Convex module: an agent's change of an existing value
// is proposed, a person lists and applies it (kept, or adopted after a compaction), and rejects one. The client journal
// refuses a proposal it already resolved even when a server lists it again (L1); a writer trusted on first use applies
// nothing (L2). Synthetic keys and values only.
import './check-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { server, setup } from './helpers/sealed-hosted.mjs';
import { SealedClient } from '../dist/sealed-client.js';
import { sealedRead, sealedRefusal, sealedWrite, sealedWriteArgs } from '../dist/sealed-transport.js';
import { framedHash } from '../dist/sealed-format.js';
import { headBytes } from '../dist/sealed-records.js';
import { applyWaiting, listProposals, rejectWaiting } from '../dist/sealed-proposal-client.js';
import { teach } from '../dist/error-teaching.js';
import { decodeSealedWire, encodeSealedWire } from '../dist/sealed-wire.js';
import { decodeSealedProposal } from '../dist/sealed-decode.js';
import { sealProposal } from '../dist/sealed-proposal.js';
import { randomBytes } from 'node:crypto';

const code = expected => error => (error.code ?? error.data?.code) === expected;
const yes = async () => true;
const text = value => Buffer.from(value);
const clear = result => {
  result?.key?.fill(0);
  for (const secret of result?.secrets ?? []) secret.value.fill(0);
};
async function value(client, name) {
  const read = await client.read();
  try {
    return read.secrets.find(s => s.name === name)?.value.toString();
  } finally {
    clear(read);
  }
}
function harness(t) {
  const h = setup(t);
  h.notices = [];
  h.person = new SealedClient(h.project, h.account, h.keys, h.pins, h.transport, false, line =>
    h.notices.push(line),
  );
  h.agent = new SealedClient(h.project, h.account, h.keys, h.pins, h.transport, true);
  h.set = () => [...h.s.tables.sealedSecretSets.values()].find(s => s.kind === 1);
  h.stored = () => [...h.s.tables.sealedSecretProposals.values()];
  return h;
}

test('an agent proposes a change and a removal; a person lists and applies them as kept records', async t => {
  const h = harness(t);
  await h.person.write('API_TOKEN', text('synthetic-value-one'));
  const proposed = await h.agent.write('API_TOKEN', text('synthetic-value-two'));
  assert.match(proposed.proposed, /^[0-9a-f]{32}$/);
  assert.equal(await value(h.person, 'API_TOKEN'), 'synthetic-value-one');
  assert(h.notices.some(line => /1 proposal waits in Development: nforge secret proposals/.test(line)));
  const lines = await listProposals(h.person);
  assert.equal(lines.length, 1);
  assert.match(lines[0], new RegExp(`^${proposed.proposed.slice(0, 8)}\tchange\tAPI_TOKEN\tfp [0-9A-Z]{4}-`));
  assert(!lines[0].includes('synthetic-value'), 'a listing never shows a value');
  // An agent never applies, even its own proposal.
  await assert.rejects(applyWaiting(h.agent, proposed.proposed.slice(0, 8)), code('PERSON_REQUIRED'));
  const done = await applyWaiting(h.person, proposed.proposed.slice(0, 8), yes);
  assert.deepEqual([done.mode, done.op, done.name], ['kept', 'change', 'API_TOKEN']);
  assert.equal(await value(h.person, 'API_TOKEN'), 'synthetic-value-two');
  const record = h.person.pins;
  const pinned = await record.load(h.project, 1);
  assert.equal(
    Buffer.from(pinned.pin.head.names.find(n => n.name === 'API_TOKEN').proposalId).toString('hex'),
    proposed.proposed,
  );
  assert.equal(h.stored().length, 0);
  assert.deepEqual(await listProposals(h.person), []);
  // A second apply finds nothing waiting.
  await assert.rejects(applyWaiting(h.person, proposed.proposed.slice(0, 8), yes), code('WORK_CONFLICT'));
  // A removal is proposed too; removing a missing name proposes nothing.
  assert.equal((await h.agent.write('MISSING_TOKEN', null)).proposed, undefined);
  const removal = await h.agent.write('API_TOKEN', null);
  assert.equal((await applyWaiting(h.person, removal.proposed, yes)).op, 'remove');
  assert.equal(await value(h.person, 'API_TOKEN'), undefined);
});

test('a proposal overtaken by compaction is adopted and the write names it as resolved', async t => {
  const h = harness(t),
    f = h.f;
  let base = null;
  const publish = async () => {
    const wire = sealedWrite(f.reply, randomUUID(), base);
    const result = await h.s.transaction(() =>
      server.write._handler(h.s.ctx, { ...sealedWriteArgs(wire), kind: 1, projectId: h.project }),
    );
    assert.equal(result.accepted, true);
    base = { headHash: Buffer.from(wire.headHash), rosterVersion: f.reply.roster.rosterVersion };
  };
  f.name('API_TOKEN', text('synthetic-value-one'));
  await publish();
  assert.equal(await value(h.person, 'API_TOKEN'), 'synthetic-value-one');
  const proposed = await h.agent.write('API_TOKEN', text('synthetic-adopted-value'));
  // The owner's other device compacts: a tombstone at version 7 is written and dropped, raising the floor to 7.
  f.bump();
  f.name('OLDEST_TOKEN', Buffer.alloc(0), { kind: 3, valueVersion: 7 });
  await publish();
  f.bump();
  f.reply.head.names = f.reply.head.names.filter(n => n.name !== 'OLDEST_TOKEN');
  f.reply.head.versionFloor = 7;
  f.signHead();
  await publish();
  const done = await applyWaiting(h.person, proposed.proposed.slice(0, 10), yes);
  assert.equal(done.mode, 'adopted');
  assert.equal(await value(h.person, 'API_TOKEN'), 'synthetic-adopted-value');
  assert.equal(h.stored().length, 0);
  assert.equal(h.set().proposals?.length ?? 0, 0);
  assert(h.set().resolvedProposals.some(id => Buffer.from(id).toString('hex') === proposed.proposed));
});

test('L1 an applied addition served again after removal and compaction is refused by the client journal', async t => {
  const h = harness(t),
    f = h.f;
  await h.person.write('API_TOKEN', text('synthetic-value-one'));
  await h.person.write('API_TOKEN', null);
  // Over a tombstone the agent's write is an addition proposal.
  const proposed = await h.agent.write('API_TOKEN', text('synthetic-added-value'));
  assert.match((await listProposals(h.person))[0], /\tadd\tAPI_TOKEN\t/);
  const [row] = await h.transport.proposals({ kind: 1 });
  assert.equal((await applyWaiting(h.person, proposed.proposed, yes)).mode, 'kept');
  await h.person.write('API_TOKEN', null);
  // The owner's other device compacts the tombstone away, so the old addition's base looks unchanged again.
  Object.assign(f.reply, sealedRead(await h.transport.read({ kind: 1 })));
  const base = { headHash: framedHash(headBytes(f.reply.head)), rosterVersion: f.reply.roster.rosterVersion };
  f.bump();
  const tombstone = f.reply.head.names.find(n => n.name === 'API_TOKEN');
  assert.equal(tombstone.kind, 3);
  f.reply.head.names = f.reply.head.names.filter(n => n !== tombstone);
  f.reply.head.versionFloor = Math.max(f.reply.head.versionFloor, tombstone.valueVersion);
  f.signHead();
  const wire = sealedWrite(f.reply, randomUUID(), base);
  assert.equal(
    (
      await h.s.transaction(() =>
        server.write._handler(h.s.ctx, { ...sealedWriteArgs(wire), kind: 1, projectId: h.project }),
      )
    ).accepted,
    true,
  );
  // A replaying server lists the applied addition again.
  const replaying = { ...h.transport, proposals: async () => [row] };
  const person = new SealedClient(h.project, h.account, h.keys, h.pins, replaying, false);
  const writes = h.s.tables.sealedSecretHistory.size;
  await assert.rejects(applyWaiting(person, proposed.proposed, yes), error => {
    assert.equal(error.code, 'WORK_CONFLICT');
    assert.match(error.message, /already applied or rejected on this device/);
    return true;
  });
  assert.equal(h.s.tables.sealedSecretHistory.size, writes, 'nothing was written');
  assert.equal(await value(h.person, 'API_TOKEN'), undefined);
});

test('L2 a device that trusted Development on first use applies nothing', async t => {
  const h = harness(t);
  await h.person.write('API_TOKEN', text('synthetic-value-one'));
  const proposed = await h.agent.write('API_TOKEN', text('synthetic-value-two'));
  const person = new SealedClient(h.project, h.account, h.keys, h.pins, h.transport, false);
  const read = person.read.bind(person);
  person.read = async (...args) => {
    const state = await read(...args);
    state.pin.confirmed = 'tofu';
    return state;
  };
  let listed = 0;
  const proposals = h.transport.proposals;
  h.transport.proposals = async input => (listed++, proposals(input));
  await assert.rejects(applyWaiting(person, proposed.proposed, yes), code('SECRETS_CODE_NEEDED'));
  assert.equal(listed, 0, 'no proposal is fetched for a tofu writer');
  assert.equal(h.stored().length, 1);
});

test('a person rejects a proposal; the journal then refuses it as resolved', async t => {
  const h = harness(t);
  await h.person.write('API_TOKEN', text('synthetic-value-one'));
  const proposed = await h.agent.write('API_TOKEN', text('synthetic-value-two'));
  const [row] = await h.transport.proposals({ kind: 1 });
  await assert.rejects(rejectWaiting(h.person, 'abc'), code('BAD_ARGUMENT'));
  // An agent withdraws its own device's proposal only; another device's needs a person.
  const decoded = decodeSealedProposal(decodeSealedWire(new Uint8Array(row)));
  const forged = Uint8Array.from(
    encodeSealedWire({ ...decoded, proposerId: Buffer.alloc(decoded.proposerId.length, 7) }),
  ).buffer;
  const otherList = { ...h.transport, proposals: async () => [forged] };
  const agent = new SealedClient(h.project, h.account, h.keys, h.pins, otherList, true);
  await assert.rejects(rejectWaiting(agent, proposed.proposed), code('PERSON_REQUIRED'));
  assert.equal(h.stored().length, 1);
  assert.equal((await rejectWaiting(h.person, proposed.proposed.slice(0, 8))).id, proposed.proposed);
  assert.equal(h.stored().length, 0);
  assert.equal(await value(h.person, 'API_TOKEN'), 'synthetic-value-one');
  const replaying = { ...h.transport, proposals: async () => [row] };
  const person = new SealedClient(h.project, h.account, h.keys, h.pins, replaying, false);
  await assert.rejects(applyWaiting(person, proposed.proposed, yes), code('WORK_CONFLICT'));
  // An agent withdraws its own proposal.
  const again = await h.agent.write('API_TOKEN', text('synthetic-value-three'));
  assert.equal((await rejectWaiting(h.agent, again.proposed)).id, again.proposed);
  assert.equal(h.stored().length, 0);
});

test('review F2: a stale proposal the server still lists teaches reject; one no longer current teaches listing', async t => {
  const reject = error => teach(error.code, { argv: ['secret', 'apply'] }, undefined, error.message);
  const h = harness(t);
  await h.person.write('API_TOKEN', text('synthetic-value-one'));
  const proposed = await h.agent.write('API_TOKEN', text('synthetic-value-two'));
  // The base changed: the server keeps listing the proposal, so the next step is reject, not a new listing.
  await h.person.write('API_TOKEN', text('synthetic-value-three'));
  const changed = await applyWaiting(h.person, proposed.proposed, yes).catch(error => error);
  assert.equal(changed.code, 'WORK_CONFLICT');
  assert.equal(reject(changed).next, 'nforge secret reject ID', changed.message);
  // A listing that fails the public checks on this view (a forged proposer).
  const [row] = await h.transport.proposals({ kind: 1 });
  const decoded = decodeSealedProposal(decodeSealedWire(new Uint8Array(row)));
  const forged = Uint8Array.from(
    encodeSealedWire({ ...decoded, proposerId: Buffer.alloc(decoded.proposerId.length, 7) }),
  ).buffer;
  const person = new SealedClient(
    h.project,
    h.account,
    h.keys,
    h.pins,
    { ...h.transport, proposals: async () => [forged] },
    false,
  );
  const invalid = await applyWaiting(person, proposed.proposed, yes).catch(error => error);
  assert.notEqual(invalid.code, 'WORK_CONFLICT');
  assert.equal(reject(invalid).next, 'nforge secret reject ID', invalid.message);
  // Nothing waits under this id any more, and storage's own refusal is its fixed client text.
  await rejectWaiting(h.person, proposed.proposed);
  const gone = await applyWaiting(h.person, proposed.proposed, yes).catch(error => error);
  assert.equal(reject(gone).next, 'nforge secret proposals', gone.message);
  const refused = sealedRefusal(
    Object.assign(new Error('server wording'), { data: { code: 'WORK_CONFLICT' } }),
  );
  assert.equal(reject(refused).next, 'nforge secret proposals', refused.message);
  assert.match(reject(refused).learn, /retry/);
});

test('review F1: apply shows the exact proposal and signs only it; no stores nothing, a swap after the prompt is a conflict', async t => {
  const h = harness(t);
  await h.person.write('API_TOKEN', text('synthetic-value-one'));
  const { pin } = await h.person.pins.load(h.project, 1);
  const id = Buffer.alloc(16, 0xab);
  // A hand-built proposer picks its own id: the change and a removal under the same id.
  const sealed = value =>
    Uint8Array.from(
      encodeSealedWire(
        sealProposal({
          pin,
          proposer: { id: h.keys.id, sign: h.keys.sign },
          name: 'API_TOKEN',
          value,
          now: pin.head.signedAt,
          random: n => (n === 16 ? id : randomBytes(n)),
        }).proposal,
      ),
    ).buffer;
  const change = sealed(text('synthetic-value-two')),
    removal = sealed(null);
  await h.transport.propose({ kind: 1, proposal: change });
  const listing = [change];
  const person = new SealedClient(
    h.project,
    h.account,
    h.keys,
    h.pins,
    { ...h.transport, proposals: async () => listing },
    false,
  );
  // Without a person to ask, nothing is applied.
  await assert.rejects(applyWaiting(person, 'abababab'), code('PERSON_REQUIRED'));
  // The proposer replaced the change by a removal under the same prefix: the prompt shows the removal, and no stores nothing.
  listing[0] = removal;
  const history = h.s.tables.sealedSecretHistory.size;
  const shown = [];
  await assert.rejects(
    applyWaiting(person, 'abababab', async summary => (shown.push(summary), false)),
    code('CANCELLED'),
  );
  assert.equal(shown.length, 1);
  assert.match(
    shown[0],
    new RegExp(
      `^Apply remove API_TOKEN \\(removal\\) from fp [0-9A-Z]{4}-.* min ago, id ${id.toString('hex')}\\?$`,
    ),
  );
  assert(!shown[0].includes('synthetic-value'));
  assert.equal(h.s.tables.sealedSecretHistory.size, history, 'nothing was written');
  // A yes signs the shown change only: when a lost race makes it list again and the bytes changed, it is a conflict.
  listing[0] = change;
  const error = await applyWaiting(person, 'abababab', async summary => {
    assert.match(summary, /^Apply change API_TOKEN \(env\) /);
    listing[0] = removal;
    await h.person.write('OTHER_TOKEN', text('synthetic-other-value'));
    return true;
  }).catch(e => e);
  assert.equal(error.code, 'WORK_CONFLICT');
  assert.match(error.message, /changed after you confirmed it/);
  assert.equal(await value(h.person, 'API_TOKEN'), 'synthetic-value-one');
});

test('review N3: a device that trusted Development on first use rejects only its own proposals', async t => {
  const h = harness(t);
  await h.person.write('API_TOKEN', text('synthetic-value-one'));
  const proposed = await h.agent.write('API_TOKEN', text('synthetic-value-two'));
  const [row] = await h.transport.proposals({ kind: 1 });
  const decoded = decodeSealedProposal(decodeSealedWire(new Uint8Array(row)));
  const forged = Uint8Array.from(
    encodeSealedWire({ ...decoded, proposerId: Buffer.alloc(decoded.proposerId.length, 7) }),
  ).buffer;
  const tofu = transport => {
    const person = new SealedClient(h.project, h.account, h.keys, h.pins, transport, false);
    const read = person.read.bind(person);
    person.read = async (...args) => {
      const state = await read(...args);
      state.pin.confirmed = 'tofu';
      return state;
    };
    return person;
  };
  await assert.rejects(
    rejectWaiting(tofu({ ...h.transport, proposals: async () => [forged] }), proposed.proposed),
    code('SECRETS_CODE_NEEDED'),
  );
  assert.equal(h.stored().length, 1);
  // Its own proposal it withdraws.
  assert.equal((await rejectWaiting(tofu(h.transport), proposed.proposed)).id, proposed.proposed);
  assert.equal(h.stored().length, 0);
});
