// SPDX-License-Identifier: Apache-2.0
// Gate B1 server conditions C17 (arguments bound to the payload), C18 (server-appended history ring),
// C19 (server-owned markers and join requests) and C22 (one portable format module, fixed X25519 probe).
import './check-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serialize } from 'node:v8';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { getConvexSize } from 'convex/values';
import { fixture } from './helpers/sealed-fixture.mjs';
import { server, setup } from './helpers/sealed-hosted.mjs';
import { headBytes } from '../dist/sealed-records.js';
import { forgeSecretId, framedHash } from '../dist/sealed-format.js';
import { deviceKeys } from '../dist/sealed-keys.js';
import { sealedRead, sealedWrite, sealedWriteArgs } from '../dist/sealed-transport.js';
import { encodeSealedWire } from '../dist/sealed-wire.js';
import { verifySealedReply } from '../dist/sealed-verify.js';

const code = expected => error => (error.code ?? error.data?.code) === expected;
const bytes = buffer => new Uint8Array(buffer);
const wireBytes = value => encodeSealedWire(value).buffer;
function harness(t) {
  const h = setup(t);
  h.publish = async (base, extra = {}, f = h.f) => {
    const wire = sealedWrite(f.reply, randomUUID(), base),
      args = { ...sealedWriteArgs(wire), kind: 1, projectId: h.project, ...extra };
    const result = await h.s.transaction(() => server.write._handler(h.s.ctx, args));
    return {
      args,
      result,
      base: { headHash: Buffer.from(wire.headHash), rosterVersion: f.reply.roster.rosterVersion },
    };
  };
  h.rows = () =>
    serialize({
      sets: [...h.s.tables.sealedSecretSets.values()],
      history: [...h.s.tables.sealedSecretHistory.values()],
    });
  h.set = () => [...h.s.tables.sealedSecretSets.values()][0];
  h.history = () => [...h.s.tables.sealedSecretHistory.values()][0];
  h.read = input => server.read._handler(h.s.ctx, { projectId: h.project, kind: 1, ...input });
  return h;
}
const payloadWith = (reply, patch) => {
  const { genesis: _genesis, transitions: _transitions, ...current } = reply;
  return wireBytes({ ...current, ...patch });
};

test('C17 the stored hash, versions and set id come from the signed payload, so forged arguments cannot wedge the set', async t => {
  const h = harness(t);
  h.f.name();
  const forged = {
    headHash: new ArrayBuffer(32),
    headVersion: 9,
    rosterVersion: 9,
    setId: new ArrayBuffer(16),
    prevHeadHash: new ArrayBuffer(32),
  };
  const first = await h.publish(null, forged);
  assert.deepEqual(first.result, { accepted: true, replay: false });
  const row = h.set();
  assert.deepEqual(bytes(row.headHash), bytes(framedHash(headBytes(h.f.reply.head))));
  assert.deepEqual(bytes(row.setId), bytes(h.f.reply.roster.setId));
  assert.equal(row.headVersion, 1);
  assert.equal(row.rosterVersion, 1);
  h.f.bump();
  h.f.name('NEXT_TOKEN');
  assert.deepEqual((await h.publish(first.base, forged)).result, { accepted: true, replay: false });
});

test('C17 a head bound to another project, kind or roster, or carrying markers, proposals or nested replies, is refused and stores nothing', async t => {
  const h = harness(t);
  h.f.name();
  const other = fixture(17, 'other-project');
  other.name();
  const unhashed = fixture();
  unhashed.name();
  unhashed.reply.head.rosterHash = Buffer.alloc(32, 9);
  unhashed.signHead();
  const proposal = {
    proposalId: Buffer.alloc(16, 1),
    epoch: 1,
    op: 1,
    name: 'API_TOKEN',
    kind: 1,
    baseValueVersion: 0,
    valueCommit: Buffer.alloc(0),
    changeSig: Buffer.alloc(64),
    ephPub: Buffer.alloc(32),
    ciphertext: Buffer.alloc(48),
    ciphertextHash: Buffer.alloc(32),
    proposerId: Buffer.alloc(16, 2),
    proposedAt: 1,
    signature: Buffer.alloc(64),
  };
  const genesis = sealedWriteArgs(sealedWrite(h.f.reply, randomUUID(), null)).genesis;
  for (const args of [
    { ...sealedWriteArgs(sealedWrite(h.f.reply, randomUUID(), null)), kind: 2 },
    sealedWriteArgs(sealedWrite(other.reply, randomUUID(), null)),
    sealedWriteArgs(sealedWrite(unhashed.reply, randomUUID(), null)),
    {
      operationId: randomUUID(),
      genesis,
      transition: null,
      payload: payloadWith(h.f.reply, { revoked: [Buffer.alloc(16, 3)] }),
    },
    {
      operationId: randomUUID(),
      genesis,
      transition: null,
      payload: payloadWith(h.f.reply, { proposals: [proposal] }),
    },
    // Nested replies carry their own markers, which only the server may supply.
    {
      operationId: randomUUID(),
      genesis,
      transition: null,
      payload: payloadWith(h.f.reply, { previous: other.reply }),
    },
  ])
    await assert.rejects(
      h.s.transaction(() => server.write._handler(h.s.ctx, { kind: 1, projectId: h.project, ...args })),
      code('SECRETS_FORMAT_REFUSED'),
    );
  assert.equal(h.s.tables.sealedSecretSets.size, 0);
  assert.equal(h.s.tables.sealedSecretHistory.size, 0);
});

test('C17 a head that does not extend the stored head is a lost race and changes nothing', async t => {
  const h = harness(t);
  h.f.name();
  await h.publish(null);
  const before = h.rows(),
    rival = fixture(18);
  rival.name();
  assert.deepEqual((await h.publish(null, {}, rival)).result, { accepted: false, replay: false });
  assert.deepEqual(h.rows(), before);
});

test('C18 the server appends the one step a write introduces and a lagging reader verifies through it', async t => {
  const h = harness(t);
  h.f.name();
  const first = await h.publish(null);
  h.f.rekey();
  const step = await h.publish(first.base);
  assert.equal(step.result.accepted, true);
  assert.equal(h.history().transitions.length, 1);
  assert.deepEqual(bytes(h.history().transitions[0]), bytes(step.args.transition));
  const lagging = await h.read({ rosterVersion: 1 });
  assert.equal(lagging.history.transitions.length, 1);
  const result = verifySealedReply(sealedRead(lagging), null, h.f.request);
  assert.equal(result.pin.roster.rosterVersion, 2);
  assert.equal(result.secrets[0].value.toString(), 'synthetic-value-0123456789');
  result.key?.fill(0);
  for (const secret of result.secrets) secret.value.fill(0);
});

test('C18 a roster change without its step, a step that does not chain, a step at genesis and a client ring are refused or ignored', async t => {
  const h = harness(t);
  h.f.name();
  const early = fixture();
  early.name();
  // Still head version 1 over a zero previous hash, so only the step makes this write invalid.
  early.transition({
    added: [
      early.entry(deviceKeys(early.account, early.random), { role: 2, how: 4, addedAtRosterVersion: 2 }),
    ],
  });
  early.wrap();
  const earlyStep = wireBytes(early.reply.transitions[0]);
  await assert.rejects(h.publish(null, { transition: earlyStep }, early), code('SECRETS_FORMAT_REFUSED'));
  const first = await h.publish(null);
  const kept = h.rows();
  h.f.rekey();
  const stranger = fixture(19);
  stranger.rekey();
  for (const transition of [null, wireBytes(stranger.reply.transitions[0])])
    await assert.rejects(h.publish(first.base, { transition }), code('SECRETS_FORMAT_REFUSED'));
  assert.deepEqual(h.rows(), kept);
  const ring = {
    genesis: new ArrayBuffer(3),
    transitions: [new ArrayBuffer(5)],
    rotateLists: [new ArrayBuffer(7)],
  };
  const quiet = fixture();
  quiet.name();
  const h2 = harness(t),
    start = await h2.publish(null, {}, quiet);
  quiet.bump();
  quiet.name('NEXT_TOKEN');
  assert.equal((await h2.publish(start.base, { history: ring }, quiet)).result.accepted, true);
  assert.deepEqual(h2.history().transitions, []);
  // A rotate list is derived from signed records on the client; the server stores none, whatever is sent.
  assert.equal(h2.history().rotateLists, undefined);
});

test('C19 server-owned markers and join requests reach every read, survive head writes and are cleared only by their own step', async t => {
  const h = harness(t);
  h.f.name();
  let last = await h.publish(null);
  const second = deviceKeys(h.f.account, h.f.random),
    absent = deviceKeys(h.f.account, h.f.random),
    joinerAccount = forgeSecretId('account', 'fixture-member'),
    joiner = deviceKeys(joinerAccount, h.f.random);
  h.f.bump();
  h.f.transition({ added: [h.f.entry(second, { role: 2, how: 4, addedAtRosterVersion: 2 })] });
  h.f.wrap();
  last = await h.publish(last.base);
  const request = wireBytes(h.f.entry(joiner, { accountId: joinerAccount, role: 2, how: 2 }));
  Object.assign(h.set(), {
    revoked: [Uint8Array.from(second.id).buffer, Uint8Array.from(absent.id).buffer],
    joinRequests: [{ deviceId: Uint8Array.from(joiner.id).buffer, request, at: 1 }],
  });
  const full = await h.read({}),
    hit = await h.read({ headHash: h.set().headHash });
  for (const reply of [full, hit]) {
    assert.deepEqual(reply.revoked.map(bytes), [bytes(second.id), bytes(absent.id)]);
    assert.deepEqual(reply.joinRequests.map(bytes), [bytes(request)]);
  }
  assert.equal(hit.payload, null);
  assert.equal(sealedRead(hit, sealedRead(full)).revoked.length, 2);
  h.f.bump();
  h.f.name('NEXT_TOKEN');
  last = await h.publish(last.base);
  assert.equal(h.set().revoked.length, 2);
  assert.equal(h.set().joinRequests.length, 1);
  h.f.rekey({ removed: [second.id], epochBumped: 1 });
  last = await h.publish(last.base);
  assert.deepEqual(h.set().revoked.map(bytes), [bytes(absent.id)]);
  h.f.bump();
  h.f.transition({
    added: [h.f.entry(joiner, { accountId: joinerAccount, role: 2, how: 2, addedAtRosterVersion: 4 })],
  });
  h.f.wrap();
  await h.publish(last.base);
  assert.equal(h.set().joinRequests, undefined);
});

test('C18/C19 a step whose delta does not match the signed roster is refused and keeps the markers', async t => {
  const h = harness(t);
  h.f.name();
  let last = await h.publish(null);
  const second = deviceKeys(h.f.account, h.f.random),
    entry = h.f.entry(second, { role: 2, how: 4, addedAtRosterVersion: 2 });
  h.f.bump();
  h.f.transition({ added: [entry] });
  h.f.wrap();
  last = await h.publish(last.base);
  h.set().revoked = [Uint8Array.from(second.id).buffer];
  const kept = h.rows();
  // Hashes chain, but the device "removed" is still in the signed roster: it must not clear its marker.
  h.f.rekey({ removed: [second.id], added: [entry], epochBumped: 1 });
  await assert.rejects(h.publish(last.base), code('SECRETS_FORMAT_REFUSED'));
  assert.deepEqual(h.rows(), kept);
});

test('C18 a first head starts its own ring and never inherits steps from an older history row', async t => {
  const h = harness(t);
  h.f.name();
  const first = await h.publish(null);
  h.f.rekey();
  await h.publish(first.base);
  assert.equal(h.history().transitions.length, 1);
  h.s.tables.sealedSecretSets.clear();
  const again = fixture();
  again.name();
  assert.equal((await h.publish(null, {}, again)).result.accepted, true);
  assert.deepEqual(h.history().transitions, []);
});

test('C19 the owner CLI honours a server-owned marker: a marked reader is refused, a marker naming no entry blocks nothing', async t => {
  const h = harness(t);
  await h.client.write('API_TOKEN', Buffer.from('marker-synthetic-value'));
  h.set().revoked = [new Uint8Array(16).fill(4).buffer];
  // Design 5.5: markers name entries to remove; this one names none, so the write goes ahead. Removal of a marked
  // entry, the re-key and the agent refusal (SECRETS_REKEY_PENDING) are in tests/sealed-removal.test.mjs.
  await h.client.write('NEXT_TOKEN', Buffer.from('unblocked-synthetic-value'));
  h.set().revoked = [Uint8Array.from(h.client.keys.id).buffer];
  await assert.rejects(
    h.client.write('LAST_TOKEN', Buffer.from('blocked-synthetic-value')),
    code('SECRETS_ROSTER_REFUSED'),
  );
});

// One bundle of the shared module and the server gate, run where Convex runs code: V8 with no Buffer,
// no node: builtins and, here, no random source at all.
const root = fileURLToPath(new URL('..', import.meta.url));
const bundled = await build({
  stdin: {
    contents: [
      "export { checkRoster } from './src/sealed-roster.ts';",
      "export { checkAgreementKey, framedHash, verifyBytes } from './src/sealed-portable.ts';",
      "export { headBytes } from './src/sealed-records.ts';",
      "export { sealedWriteFacts, nextSealedState } from './convex/sealedSecretGate.ts';",
      "export { decodeSealedWire } from './src/sealed-wire.ts';",
    ].join('\n'),
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'gate',
  platform: 'browser',
  logLevel: 'silent',
});
// A decoder that takes no options, so the wire decode cannot depend on { fatal: true } support.
class OptionlessTextDecoder extends TextDecoder {
  constructor(label, options) {
    if (options !== undefined) throw new TypeError('This runtime takes no decoder options.');
    super(label);
  }
}
const runtime = () => {
  const context = vm.createContext({ TextEncoder, TextDecoder: OptionlessTextDecoder, performance });
  vm.runInContext(bundled.outputFiles[0].text, context);
  assert.equal(
    vm.runInContext('typeof Buffer + typeof require + typeof crypto + typeof process', context),
    'undefinedundefinedundefinedundefined',
  );
  return context;
};
const hexKey = text => Uint8Array.from(Buffer.from(text, 'hex'));
const lowOrder = [
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0100000000000000000000000000000000000000000000000000000000000000',
  'e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800',
  '5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
];

test('C22 the wire header must be exact UTF-8 without decoder options: invalid bytes and a BOM are refused', () => {
  const context = runtime();
  const wireOf = header => {
    const out = new Uint8Array(12 + header.length),
      view = new DataView(out.buffer);
    out.set([0x46, 0x53, 0x53, 1]);
    view.setUint32(4, header.length);
    view.setUint32(8, 0);
    out.set(header, 12);
    return out;
  };
  const text = Buffer.from('{"a":1}');
  context.wires = [
    text,
    Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), text]),
  ].map(h => wireOf(Uint8Array.from(h)));
  const outcomes = vm.runInContext(
    'wires.map(w => { try { return JSON.stringify(gate.decodeSealedWire(new Uint8Array(w))); } catch (e) { return e.code; } })',
    context,
  );
  assert.deepEqual([...outcomes], ['{"a":1}', 'SECRETS_FORMAT_REFUSED', 'SECRETS_FORMAT_REFUSED']);
});

test('C22 the fixed X25519 probe refuses every low-order point and accepts a real key with no random source', () => {
  const context = runtime();
  context.keys = [...lowOrder.map(hexKey), Uint8Array.from(fixture().keys.encPub)];
  const outcomes = vm.runInContext(
    'keys.map(key => { try { gate.checkAgreementKey(new Uint8Array(key)); return "ok"; } catch (e) { return e.code; } })',
    context,
  );
  assert.deepEqual([...outcomes], [...lowOrder.map(() => 'SECRETS_WRAP_REFUSED'), 'ok']);
});

test('C22/C23 measured server gate and full public roster check at 100 recipients and 200 names', async t => {
  const h = harness(t),
    f = h.f;
  const members = Array.from({ length: 99 }, (_, i) => {
    const account = forgeSecretId('account', `fixture-member-${i}`);
    return f.entry(deviceKeys(account, f.random), {
      accountId: account,
      role: 2,
      how: 2,
      addedAtRosterVersion: 2,
    });
  });
  for (let i = 0; i < 200; i++) f.name(`TOKEN_${i}`, Buffer.alloc(128, 65 + (i % 20)));
  const first = await h.publish(null);
  f.bump();
  f.transition({ added: members });
  f.wrap();
  assert.equal(f.reply.roster.entries.length, 100);
  assert.equal(f.reply.wraps.length, 100);
  const before = { ...h.io },
    began = performance.now();
  const step = await h.publish(first.base);
  const handlerMs = performance.now() - began;
  assert.equal(step.result.accepted, true);
  const io = Object.fromEntries(Object.keys(before).map(k => [k, h.io[k] - before[k]]));
  assert.equal(io.writes, 2);
  // Same bytes, inside the V8 bundle: the stage 1-2 gate as built, and the stage 3 public roster check.
  const context = runtime();
  context.input = {
    projectId: h.project,
    payload: step.args.payload,
    transition: step.args.transition,
    stored: { genesis: first.args.genesis, transitions: [] },
    set: { ...h.set(), headHash: first.base.headHash.buffer.slice(0), headVersion: 1, rosterVersion: 1 },
    storedPayload: first.args.payload,
  };
  const timings = vm.runInContext(
    `(() => {
      const runs = [];
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        const facts = gate.sealedWriteFacts(input.projectId, 1, input.payload);
        gate.nextSealedState({ set: { ...input.set, payload: input.storedPayload }, facts, genesis: null, transition: input.transition, stored: input.stored });
        const t1 = performance.now();
        gate.checkRoster(facts.roster);
        gate.checkRoster(facts.roster);
        const ok = gate.verifyBytes(gate.headBytes(facts.head), facts.head.signature, facts.roster.entries.find(e => e.role === 1).signPub);
        runs.push({ gateMs: t1 - t0, verifierMs: performance.now() - t1, ok });
      }
      return runs;
    })()`,
    context,
  );
  assert(timings.every(r => r.ok));
  const median = key => [...timings].map(r => r[key]).sort((a, b) => a - b)[2];
  const round = n => Math.round(n * 10) / 10;
  console.log(
    'SEALED_GATE_BUDGET ' +
      JSON.stringify({
        recipients: 100,
        names: 200,
        payloadBytes: step.args.payload.byteLength,
        transitionBytes: step.args.transition.byteLength,
        setBytes: getConvexSize(h.set()),
        historyBytes: getConvexSize(h.history()),
        mutationCalls: 1,
        handlerMs: round(handlerMs),
        dbQueries: io.queries,
        dbDocumentsRead: io.documents,
        dbReadBytes: io.readBytes,
        dbWrites: io.writes,
        v8GateMsFirst: round(timings[0].gateMs),
        v8GateMsMedian: round(median('gateMs')),
        v8FullRosterCheckMsFirst: round(timings[0].verifierMs),
        v8FullRosterCheckMsMedian: round(median('verifierMs')),
      }),
  );
});
