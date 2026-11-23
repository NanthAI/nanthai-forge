// SPDX-License-Identifier: Apache-2.0
import './check-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  existsSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serialize, deserialize } from 'node:v8';
import { randomUUID } from 'node:crypto';
import { getConvexSize } from 'convex/values';
import { moduleUrl } from './convex-module.mjs';
import { state, projectRow } from './hosted-fixture.mjs';
import { headBytes } from '../dist/sealed-records.js';
import { forgeSecretId, framedHash } from '../dist/sealed-format.js';
import { fixture } from './helpers/sealed-fixture.mjs';
import { assertNoPlaintext, deviceSecrets } from './helpers/sealed-no-plaintext.mjs';
import { clone, server, setup } from './helpers/sealed-hosted.mjs';
import { FileKeyStore } from '../dist/sealed-local.js';
import { deviceKeys } from '../dist/sealed-keys.js';
import { SealedJournal } from '../dist/sealed-journal.js';
import { SecretPins } from '../dist/sealed-pins.js';
import { pipedValue } from '../dist/sealed-cli.js';
import { NetworkTransportError } from '../dist/network-fetch.js';
import { SealedClient } from '../dist/sealed-client.js';
import { sealedWrite, sealedWriteArgs } from '../dist/sealed-transport.js';
import { decodeSealedWire } from '../dist/sealed-wire.js';
import { runWithSecrets } from '../dist/secret-run.js';
import { Writable } from 'node:stream';
import { writeFileSync } from 'node:fs';
function clear(result) {
  result?.key?.fill(0);
  for (const secret of result?.secrets ?? []) secret.value.fill(0);
}
const code = expected => error => (error.code ?? error.data?.code) === expected;

for (const journey of [
  'member second device',
  'another project with existing local trust',
  'owner first set on a new project',
])
  test(`first contact on ${journey} refuses a server-made owner roster before any value write`, async t => {
    const { directory, pins, f } = setup(t),
      account = journey === 'member second device' ? 'fixture-member' : 'fixture-owner',
      project =
        journey === 'another project with existing local trust' ? 'new-project' : f.request.forgeProjectId,
      attacker = fixture(19, project),
      keys = account === 'fixture-owner' ? f.keys : deviceKeys(forgeSecretId('account', account), f.random),
      store = new FileKeyStore(join(directory, 'device.bin'));
    store.save({ ...keys, pinCounter: 0 });
    if (journey === 'another project with existing local trust')
      clear(await pins.verifyAndSave(f.reply, f.request, 1));
    attacker.transition({
      added: [
        attacker.entry(keys, {
          accountId: forgeSecretId('account', account),
          role: 1,
          how: account === 'fixture-owner' ? 4 : 6,
          addedAtRosterVersion: 2,
        }),
      ],
    });
    attacker.wrap();
    const response = sealedWrite(attacker.reply, randomUUID(), null),
      writes = [];
    const transport = {
      read: async () => response,
      write: async input => {
        writes.push(input);
        return { accepted: true, replay: false };
      },
    };
    const client = new SealedClient(project, account, keys, pins, transport, false);
    const bytes = () =>
      Object.fromEntries(readdirSync(directory).map(name => [name, readFileSync(join(directory, name))]));
    const before = bytes();
    await assert.rejects(client.write('NEW_TOKEN', Buffer.from('synthetic-never-sent-secret')), {
      code: 'SECRETS_ROSTER_REFUSED',
    });
    assert.equal(writes.length, 0, 'no sealed request reaches the hostile transport');
    assert.deepEqual(bytes(), before);
    await assert.rejects(client.read(), { code: 'SECRETS_ROSTER_REFUSED' });
    assert.deepEqual(bytes(), before);
  });

test('owner genesis set/list/change/remove and cache reads use the real bounded server record', async t => {
  const { client, calls, s, pins, project } = setup(t);
  await client.write('API_TOKEN', Buffer.from('first-synthetic-value'));
  let read = await client.read();
  assert.equal(read.secrets[0].value.toString(), 'first-synthetic-value');
  clear(read);
  await client.write('API_TOKEN', Buffer.from('second-synthetic-value'));
  read = await client.read(true);
  assert.equal(read.secrets[0].value.toString(), 'second-synthetic-value');
  clear(read);
  await client.write('API_TOKEN', null);
  read = await client.read();
  assert.equal(read.secrets.length, 0);
  assert.equal(read.pin.head.names[0].kind, 3);
  clear(read);
  assert.equal(s.tables.sealedSecretSets.size, 1);
  assert.equal(s.tables.sealedSecretHistory.size, 1);
  assert(await pins.load(project, 1));
  assert.equal(calls.filter(c => c.action === 'write').length, 3);
});
test('a direct write advances a retained live version past the compacted floor', async t => {
  const { client, f, pins, project, transport } = setup(t);
  const publishFixture = async previous => {
    f.wrap();
    const base = previous && { headHash: previous, rosterVersion: f.reply.roster.rosterVersion };
    await transport.write({ ...sealedWriteArgs(sealedWrite(f.reply, randomUUID(), base)), kind: 1 });
    return framedHash(headBytes(f.reply.head));
  };
  f.name('API_TOKEN');
  const initial = await publishFixture(null);
  f.bump();
  f.name('OLDEST_TOKEN', Buffer.alloc(0), { kind: 3, valueVersion: 7 });
  const withOldest = await publishFixture(initial);
  f.bump();
  for (let index = 0; index < 398; index++) {
    f.name(`REMOVED_TOKEN_${index}`, Buffer.alloc(0), { kind: 3 });
  }
  await publishFixture(withOldest);
  clear(await client.read());

  await client.write('NEW_TOKEN', Buffer.from('synthetic-value-for-new-name'));
  const compacted = await pins.load(project, 1);
  assert.equal(compacted.pin.head.versionFloor, 7);
  assert.equal(compacted.pin.head.names.find(entry => entry.name === 'API_TOKEN').valueVersion, 1);
  assert.equal(
    compacted.pin.head.names.some(entry => entry.name === 'OLDEST_TOKEN'),
    false,
  );

  await client.write('API_TOKEN', Buffer.from('synthetic-value-for-retained-name'));
  const accepted = await client.read();
  try {
    assert.equal(accepted.pin.head.names.find(entry => entry.name === 'API_TOKEN').valueVersion, 8);
  } finally {
    clear(accepted);
  }
});
test('a crash after accepted receipt compaction but before first pin publication recovers through the local creator proof', async t => {
  const { client, pins, project, calls, directory } = setup(t),
    operationId = randomUUID(),
    original = pins.verifyAndSave.bind(pins);
  pins.verifyAndSave = async () => {
    throw Error('synthetic crash before first pin publication');
  };
  await assert.rejects(
    client.write('API_TOKEN', Buffer.from('synthetic-crash-recovery-value'), { operationId }),
    /synthetic crash/,
  );
  pins.verifyAndSave = original;
  assert.equal(await pins.load(project, 1), null);
  const receiptPath = join(directory, 'operations', operationId + '.bin');
  assert.equal(deserialize(readFileSync(receiptPath)).state, 'accepted');
  assert.equal(readFileSync(receiptPath).includes(Buffer.from('synthetic-crash-recovery-value')), false);
  const before = calls.filter(call => call.action === 'write').length;
  assert.equal(
    (await client.write('API_TOKEN', Buffer.from('synthetic-crash-recovery-value'), { operationId })).replay,
    true,
  );
  assert.equal(calls.filter(call => call.action === 'write').length, before);
  assert(await pins.load(project, 1));
});
test('T8 concurrent owner commands reconcile a CAS loser without losing either name', async t => {
  const { client, transport, pins, keys, project, account } = setup(t);
  await client.write('BASE_TOKEN', Buffer.from('base-synthetic-value'));
  const peer = new SealedClient(project, account, keys, pins, transport, false);
  const original = transport.read;
  let arrivals = 0,
    release;
  const barrier = new Promise(r => (release = r));
  transport.read = async input => {
    const result = await original(input);
    if (arrivals < 2) {
      arrivals++;
      if (arrivals === 2) release();
      await barrier;
    }
    return result;
  };
  await Promise.all([
    client.write('FIRST_TOKEN', Buffer.from('first-concurrent-value')),
    peer.write('SECOND_TOKEN', Buffer.from('second-concurrent-value')),
  ]);
  const read = await client.read();
  assert.deepEqual(read.secrets.map(s => s.name).sort(), ['BASE_TOKEN', 'FIRST_TOKEN', 'SECOND_TOKEN']);
  clear(read);
});
test('T18 all slice-1 journey writes, reads, rm, retry, cached and child delivery keep values out of every stored row and call', async t => {
  const { client, calls, s, directory, pins, transport, keys } = setup(t),
    values = [
      Buffer.from('synthetic-c4nary-one-0123456789'),
      Buffer.from('synthetic-c4nary-two-9876543210'),
      Buffer.from('synthetic-file-c4nary-abcdef'),
    ];
  const id = randomUUID();
  await client.write('API_TOKEN', values[0], { operationId: id });
  await client.write('API_TOKEN', values[0], { operationId: id });
  await client.write('SECOND_TOKEN', values[1]);
  await client.write('CERT_FILE', values[2], { file: true });
  const read = await client.read(true);
  unlinkSync(join(directory, forgeSecretId('project', client.project).toString('hex') + '.bin'));
  const repinned = await pins.rebuild(read.reply, client.request(), true, async () => true);
  clear(repinned);
  const root = join(directory, 'tree');
  mkdirSync(root);
  mkdirSync(join(directory, 'temp'));
  writeFileSync(join(root, '.env.example'), 'API_TOKEN\nSECOND_TOKEN\nCERT_FILE\n');
  let output = '';
  const sink = new Writable({
    write(chunk, _encoding, done) {
      output += chunk;
      done();
    },
  });
  assert.equal(
    await runWithSecrets(
      {
        root,
        command: [
          process.execPath,
          '-e',
          "process.stdout.write(process.env.API_TOKEN); process.stdout.write(require('node:fs').readFileSync(process.env.CERT_FILE))",
        ],
      },
      async () => ({ secrets: read.secrets }),
      { source: {}, stdout: sink, stderr: sink, tempRoot: join(directory, 'temp') },
    ),
    0,
  );
  assert(output.includes('[secret:API_TOKEN]'));
  assert(output.includes('[secret:CERT_FILE]'));
  await client.write('API_TOKEN', null);
  const originalWrite = transport.write;
  const unknownOperation = randomUUID();
  transport.write = async input => {
    await originalWrite(input);
    throw Error('synthetic journal lost reply');
  };
  await assert.rejects(
    client.write('SECOND_TOKEN', values[0], { operationId: unknownOperation }),
    code('SECRETS_WRITE_UNKNOWN'),
  );
  const retainedUnknown = readFileSync(join(directory, 'operations', unknownOperation + '.bin'));
  transport.write = originalWrite;
  assert.equal((await client.resolve(unknownOperation)).resolved, 'accepted');
  const discardedOperation = randomUUID();
  transport.write = async () => {
    throw Error('synthetic unconfirmed request');
  };
  await assert.rejects(
    client.write('NEW_TOKEN', values[1], { operationId: discardedOperation }),
    code('SECRETS_WRITE_UNKNOWN'),
  );
  const discardedUnknown = readFileSync(join(directory, 'operations', discardedOperation + '.bin'));
  transport.write = originalWrite;
  assert.equal((await client.resolve(discardedOperation, async () => true)).resolved, 'discarded');
  assertNoPlaintext(
    'slice-1 rows, calls and journal',
    {
      rows: Object.fromEntries(Object.entries(s.tables).map(([k, v]) => [k, [...v.values()]])),
      calls,
      retainedUnknown,
      discardedUnknown,
      journal: readdirSync(join(directory, 'operations')).map(n =>
        readFileSync(join(directory, 'operations', n)),
      ),
    },
    { values, keys: deviceSecrets(keys) },
  );
  for (const call of calls.filter(c => c.action === 'write')) {
    const reply = decodeSealedWire(new Uint8Array(call.input.payload), bytes => Buffer.from(bytes));
    for (const c of reply.ciphertexts)
      assert(
        [256, 512, 1024, 2048, 4096].includes(c.stored.length - 60) || (c.stored.length - 60) % 4096 === 0,
      );
  }
});
test('stable owner device gate refuses scoped/read-only devices, another account, browser and keyless agent credentials', async t => {
  const { s, f, identity, project } = setup(t),
    wire = { ...sealedWriteArgs(sealedWrite(f.reply, randomUUID(), null)), kind: 1, projectId: project };
  const row = s.tables.cliCredentials.get('device-row'),
    original = clone(row);
  for (const patch of [
    { settings: { source: 'write', projects: { kind: 'project', projectId: project } } },
    { settings: { source: 'read', projects: { kind: 'all' } } },
    { deviceKey: undefined },
  ]) {
    Object.assign(row, original, patch);
    await assert.rejects(
      s.transaction(() => server.write._handler(s.ctx, wire)),
      code('AUTH_SCOPE_DENIED'),
    );
  }
  Object.assign(row, original);
  identity.subject = 'another-account';
  await assert.rejects(
    s.transaction(() => server.write._handler(s.ctx, wire)),
    code('AUTH_REVOKED'),
  );
  identity.subject = 'fixture-owner';
  const withDevice = clone(identity);
  delete identity.forgeCredential;
  delete identity.forgeSignIn;
  await assert.rejects(
    s.transaction(() => server.write._handler(s.ctx, wire)),
    code('AUTH_SCOPE_DENIED'),
  );
  Object.assign(identity, withDevice);
  s.tables.hostedProjects.get(project).owner = 'someone-else';
  await assert.rejects(
    s.transaction(() => server.write._handler(s.ctx, wire)),
    code('PROJECT_UNAVAILABLE'),
  );
  assert.equal(s.tables.sealedSecretSets.size, 0);
});
test('sealed reads and writes refuse stable devices without a current approval', async t => {
  const { s, f, project, client } = setup(t),
    wire = { ...sealedWriteArgs(sealedWrite(f.reply, randomUUID(), null)), kind: 1, projectId: project },
    row = s.tables.cliCredentials.get('device-row');
  for (const deviceApprovedAt of [undefined, Date.now() - 2 * 365 * 86400000]) {
    row.deviceApprovedAt = deviceApprovedAt;
    await assert.rejects(client.read(), code('AUTH_REVOKED'));
    await assert.rejects(
      s.transaction(() => server.write._handler(s.ctx, wire)),
      code('AUTH_REVOKED'),
    );
  }
  assert.equal(s.tables.sealedSecretSets.size, 0);
  assert.equal(s.tables.sealedSecretHistory.size, 0);
});
test('agent entry points add new names but cannot change or remove any existing record', async t => {
  const { client, project, account, keys, pins, transport } = setup(t),
    agent = new SealedClient(project, account, keys, pins, transport, true);
  await agent.write('API_TOKEN', Buffer.from('agent-new-synthetic-value'));
  await assert.rejects(agent.write('API_TOKEN', Buffer.from('agent-changed-value')), code('PERSON_REQUIRED'));
  await assert.rejects(agent.write('API_TOKEN', null), code('PERSON_REQUIRED'));
  await assert.rejects(
    agent.write('PIP_INDEX_URL', Buffer.from('https://synthetic.invalid')),
    code('PERSON_REQUIRED'),
  );
  const read = await client.read();
  assert.equal(read.secrets[0].value.toString(), 'agent-new-synthetic-value');
  clear(read);
});
test('an unknown write outcome replays its exact ciphertext rather than sealing a second mutation', async t => {
  const { client, transport, calls } = setup(t),
    original = transport.write,
    id = randomUUID();
  let fail = true;
  transport.write = async input => {
    const result = await original(input);
    if (fail) {
      fail = false;
      throw Error('synthetic connection loss');
    }
    return result;
  };
  await assert.rejects(
    client.write('API_TOKEN', Buffer.from('retry-synthetic-value'), { operationId: id }),
    code('SECRETS_WRITE_UNKNOWN'),
  );
  const receipt = await client.write('API_TOKEN', Buffer.from('retry-synthetic-value'), { operationId: id });
  assert.equal(receipt.replay, true);
  const writes = calls.filter(c => c.action === 'write');
  assert.deepEqual(writes[0].input, writes[1].input);
});
test('unknown outcomes outside the event ring never reseal, while confirmed receipts recheck access without writes', async t => {
  const { client, transport, s, calls, directory, pins } = setup(t),
    original = transport.write;
  const unknownId = randomUUID(),
    confirmedId = randomUUID();
  transport.write = async input => {
    await original(input);
    throw Error('synthetic lost reply');
  };
  await assert.rejects(
    client.write('API_TOKEN', Buffer.from('unknown-original-value'), { operationId: unknownId }),
    code('SECRETS_WRITE_UNKNOWN'),
  );
  transport.write = original;
  await client.write('API_TOKEN', Buffer.from('confirmed-newer-value'), { operationId: confirmedId });
  // Exercise the real pruning mutation with an already-full bounded event ring.
  const row = [...s.tables.sealedSecretHistory.values()][0];
  row.events = [
    row.events[0],
    ...Array.from({ length: 49 }, () => ({
      operationId: randomUUID(),
      headHash: row.events[0].headHash,
      at: Date.now(),
    })),
  ];
  await client.write('OTHER_TOKEN', Buffer.from('current-other-value'));
  assert(![...s.tables.sealedSecretHistory.values()][0].events.some(e => e.operationId === unknownId));
  const before = serialize([...s.tables.sealedSecretSets.values()]);
  const writesBefore = calls.filter(c => c.action === 'write').length;
  await assert.rejects(
    client.write('API_TOKEN', Buffer.from('unknown-original-value'), { operationId: unknownId }),
    e => {
      assert.equal(e.code, 'SECRETS_WRITE_UNKNOWN');
      assert(e.message.includes('nforge secret list'));
      assert(e.message.includes('new operation'));
      return true;
    },
  );
  assert.equal(calls.filter(c => c.action === 'write').length, writesBefore + 1);
  assert.deepEqual(serialize([...s.tables.sealedSecretSets.values()]), before);
  assert.equal(deserialize(readFileSync(join(directory, 'operations', unknownId + '.bin'))).state, 'unknown');
  const writes = calls.filter(c => c.action === 'write').length;
  await assert.rejects(
    client.write('API_TOKEN', Buffer.from('a replay is not a new change'), { operationId: confirmedId }),
    code('WORK_OPERATION_REUSED'),
  );
  assert.equal((await client.resolve(confirmedId)).resolved, 'accepted');
  assert.equal(calls.filter(c => c.action === 'write').length, writes);
  transport.read = async () => {
    throw Object.assign(Error('synthetic revoked'), { data: { code: 'AUTH_REVOKED' } });
  };
  await assert.rejects(client.resolve(confirmedId), code('AUTH_REVOKED'));
  const journal = new SealedJournal(directory, pins.lock);
  assert.equal(
    (
      await journal.read(confirmedId, {
        project: client.project,
        name: 'API_TOKEN',
        removing: false,
        file: false,
      })
    ).state,
    'accepted',
  );
});
test('confirmed refusals delete the sealed request; crash after accept before compaction retains an exact retry', async t => {
  const { client, transport, directory, calls } = setup(t),
    original = transport.write;
  const refused = randomUUID(),
    crashed = randomUUID();
  transport.write = async () => {
    throw Object.assign(Error('synthetic refusal'), { data: { code: 'AUTH_SCOPE_DENIED' } });
  };
  await assert.rejects(
    client.write('API_TOKEN', Buffer.from('refused-canary'), { operationId: refused }),
    code('AUTH_SCOPE_DENIED'),
  );
  assert.equal(existsSync(join(directory, 'operations', refused + '.bin')), false);
  transport.write = original;
  const accept = SealedJournal.prototype.accept;
  SealedJournal.prototype.accept = async () => {
    throw Error('synthetic crash at post-accept boundary');
  };
  try {
    await assert.rejects(
      client.write('API_TOKEN', Buffer.from('crash-canary'), { operationId: crashed }),
      code('SECRETS_WRITE_UNKNOWN'),
    );
  } finally {
    SealedJournal.prototype.accept = accept;
  }
  const path = join(directory, 'operations', crashed + '.bin');
  assert.equal(deserialize(readFileSync(path)).state, 'unknown');
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(join(directory, 'operations')).mode & 0o777, 0o700);
  assert.equal(
    (await client.write('API_TOKEN', Buffer.from('crash-canary'), { operationId: crashed })).replay,
    true,
  );
  assert.deepEqual(
    calls.filter(c => c.action === 'write').map(c => c.input)[0],
    calls.filter(c => c.action === 'write').map(c => c.input)[1],
  );
  const receipt = deserialize(readFileSync(path));
  assert.equal(receipt.state, 'accepted');
  assert.equal(receipt.wire, undefined);
  assert(readFileSync(path).length < 512);
});
test('set/history caps apply to complete documents and the server prunes its own transition ring', async t => {
  const { s, f, project } = setup(t),
    wire = { ...sealedWriteArgs(sealedWrite(f.reply, randomUUID(), null)), kind: 1, projectId: project };
  await assert.rejects(
    s.transaction(() => server.write._handler(s.ctx, { ...wire, payload: new ArrayBuffer(512 * 1024) })),
    code('SECRETS_FORMAT_REFUSED'),
  );
  await assert.rejects(
    s.transaction(() => server.write._handler(s.ctx, { ...wire, genesis: new ArrayBuffer(128 * 1024) })),
    code('SECRETS_FORMAT_REFUSED'),
  );
  await s.transaction(() => server.write._handler(s.ctx, wire));
  const history = [...s.tables.sealedSecretHistory.values()][0];
  // Opaque stored steps the server wrote earlier; it never re-reads them.
  history.transitions = Array.from({ length: 64 }, () => new ArrayBuffer(1));
  const base = { headHash: framedHash(headBytes(f.reply.head)), rosterVersion: 1 };
  f.rekey();
  const step = sealedWriteArgs(sealedWrite(f.reply, randomUUID(), base));
  await s.transaction(() => server.write._handler(s.ctx, { ...step, kind: 1, projectId: project }));
  const ring = [...s.tables.sealedSecretHistory.values()][0].transitions;
  assert.equal(ring.length, 64);
  assert.deepEqual(new Uint8Array(ring.at(-1)), new Uint8Array(step.transition));
  assert.equal(s.tables.sealedSecretSets.size, 1);
});
test('cache hits recheck access and only typed transport faults can use the verified offline cache', async t => {
  const { client, transport, identity, project, s } = setup(t);
  await client.write('API_TOKEN', Buffer.from('cached-synthetic-value'));
  const current = await client.pins.load(project, 1),
    hash = sealedWrite(current.cache, randomUUID(), null).headHash;
  const hit = await transport.read({ kind: 1, headHash: hash });
  assert.equal(hit.payload, null);
  assert(getConvexSize(hit) <= 64);
  const originalRead = transport.read;
  transport.read = async () => {
    throw new NetworkTransportError('EXCHANGE_REQUEST_FAILED', 'Synthetic disconnected transport.');
  };
  const offline = await client.read(true);
  assert.equal(offline.secrets[0].value.toString(), 'cached-synthetic-value');
  clear(offline);
  transport.read = async () => {
    throw Error('Synthetic unexpected server failure.');
  };
  await assert.rejects(client.read(true), /unexpected server/);
  transport.read = originalRead;
  identity.subject = 'different-account';
  await assert.rejects(client.read(true));
  assert.equal(s.tables.sealedSecretSets.size, 1);
});
test('set/list/rm and cache hit/miss keep constant function/document budgets and no background work', async t => {
  const { client, calls, io, s } = setup(t);
  await client.write('API_TOKEN', Buffer.from('budget-synthetic-value'));
  const measure = async operation => {
    const before = { ...io },
      count = calls.length;
    const result = await operation();
    clear(result);
    return {
      calls: calls.length - count,
      queries: io.queries - before.queries,
      documents: io.documents - before.documents,
      writes: io.writes - before.writes,
    };
  };
  assert.deepEqual(await measure(() => client.read()), { calls: 1, queries: 3, documents: 3, writes: 0 });
  assert.deepEqual(await measure(() => client.read(true)), { calls: 1, queries: 3, documents: 3, writes: 0 });
  assert.deepEqual(
    await measure(() => client.write('API_TOKEN', Buffer.from('next-budget-synthetic-value'))),
    { calls: 2, queries: 7, documents: 7, writes: 2 },
  );
  assert.deepEqual(await measure(() => client.write('API_TOKEN', null)), {
    calls: 2,
    queries: 7,
    documents: 7,
    writes: 2,
  });
  assert.equal(s.scheduled.length, 0);
});

test('20/200-name record and request budgets stay bounded with zero idle/landing writes', async t => {
  const results = [];
  for (const names of [20, 200]) {
    const { s, f, project, transport } = setup(t),
      began = performance.now();
    for (let i = 0; i < names; i++) f.name(`TOKEN_${i}`, Buffer.alloc(128, 65 + (i % 20)));
    const sealed = sealedWrite(f.reply, randomUUID(), null),
      wire = { ...sealedWriteArgs(sealed), kind: 1, projectId: project };
    await s.transaction(() => server.write._handler(s.ctx, wire));
    const set = [...s.tables.sealedSecretSets.values()][0],
      history = [...s.tables.sealedSecretHistory.values()][0];
    const full = await transport.read({ kind: 1 });
    const hit = await transport.read({ kind: 1, headHash: sealed.headHash });
    const metric = {
      names,
      setBytes: getConvexSize(set),
      historyBytes: getConvexSize(history),
      writeRequestBytes: getConvexSize(wire),
      fullReplyBytes: getConvexSize(full),
      hitReplyBytes: getConvexSize(hit),
      wallMs: Math.round(performance.now() - began),
      rssBytes: process.memoryUsage().rss,
    };
    assert(metric.setBytes <= 512 * 1024 && metric.historyBytes <= 128 * 1024 && metric.hitReplyBytes <= 64);
    assert.equal(s.scheduled.length, 0);
    results.push(metric);
  }
  console.log('SEALED_RECORD_BUDGET ' + JSON.stringify(results));
});

test('L5 a different value cannot replay an unknown or confirmed operation', async t => {
  const { client, transport, calls } = setup(t),
    original = transport.write,
    id = randomUUID();
  transport.write = async input => {
    await original(input);
    throw Error('synthetic lost receipt');
  };
  await assert.rejects(
    client.write('API_TOKEN', Buffer.from('retained-original-value'), { operationId: id }),
    code('SECRETS_WRITE_UNKNOWN'),
  );
  transport.write = original;
  const before = calls.filter(c => c.action === 'write').length;
  await assert.rejects(
    client.write('API_TOKEN', Buffer.from('different-pending-value'), { operationId: id }),
    code('WORK_OPERATION_REUSED'),
  );
  assert.equal(calls.filter(c => c.action === 'write').length, before);
  await client.write('API_TOKEN', Buffer.from('retained-original-value'), { operationId: id });
  await assert.rejects(
    client.write('API_TOKEN', Buffer.from('different-confirmed-value'), { operationId: id }),
    code('WORK_OPERATION_REUSED'),
  );
  assert.equal((await client.resolve(id)).resolved, 'accepted');
});
test('L6 resolve compacts a verified accepted change, preserves cancelled unknowns and permits explicit local discard without access', async t => {
  const { client, transport, directory } = setup(t),
    original = transport.write,
    accepted = randomUUID();
  transport.write = async input => {
    await original(input);
    throw Error('synthetic lost receipt');
  };
  await assert.rejects(
    client.write('API_TOKEN', Buffer.from('resolve-accepted-value'), { operationId: accepted }),
    code('SECRETS_WRITE_UNKNOWN'),
  );
  transport.write = original;
  assert.equal((await client.resolve(accepted)).resolved, 'accepted');
  assert.equal(deserialize(readFileSync(join(directory, 'operations', accepted + '.bin'))).state, 'accepted');
  const unknown = randomUUID();
  transport.write = async () => {
    throw Error('synthetic unsent request');
  };
  await assert.rejects(
    client.write('OTHER_TOKEN', Buffer.from('resolve-unknown-value'), { operationId: unknown }),
    code('SECRETS_WRITE_UNKNOWN'),
  );
  transport.write = original;
  const path = join(directory, 'operations', unknown + '.bin'),
    before = readFileSync(path);
  await assert.rejects(
    client.resolve(unknown, async () => false),
    code('CANCELLED'),
  );
  assert.deepEqual(readFileSync(path), before);
  const agent = new SealedClient(client.project, client.account, client.keys, client.pins, transport, true);
  await assert.rejects(
    agent.resolve(unknown, async () => true),
    code('PERSON_REQUIRED'),
  );
  transport.read = async () => {
    throw Object.assign(Error('synthetic deleted project'), { data: { code: 'PROJECT_UNAVAILABLE' } });
  };
  assert.equal((await client.resolve(unknown, async () => true)).resolved, 'discarded');
  assert(!existsSync(path));
});
test('L7 a valid CAS cannot replace the first stored genesis and changes neither row', async t => {
  const { f, s, project } = setup(t);
  const first = sealedWriteArgs(sealedWrite(f.reply, randomUUID(), null));
  await s.transaction(() => server.write._handler(s.ctx, { ...first, projectId: project, kind: 1 }));
  const base = { headHash: framedHash(headBytes(f.reply.head)), rosterVersion: 1 };
  f.bump();
  f.name('NEXT_TOKEN');
  const wire = sealedWriteArgs(sealedWrite(f.reply, randomUUID(), base));
  const before = serialize({
    sets: [...s.tables.sealedSecretSets.values()],
    history: [...s.tables.sealedSecretHistory.values()],
  });
  for (const genesis of [Uint8Array.from([1, 2, 3]).buffer, first.genesis])
    await assert.rejects(
      s.transaction(() => server.write._handler(s.ctx, { ...wire, genesis, projectId: project, kind: 1 })),
      code('SECRETS_FORMAT_REFUSED'),
    );
  assert.deepEqual(
    serialize({
      sets: [...s.tables.sealedSecretSets.values()],
      history: [...s.tables.sealedSecretHistory.values()],
    }),
    before,
  );
});

test('Gate B2 nit: a piped env value drops exactly one trailing newline; a file value keeps every byte', () => {
  const env = text => pipedValue(Buffer.from(text), false).toString(),
    file = text => pipedValue(Buffer.from(text), true).toString();
  assert.equal(env('TOKEN\n'), 'TOKEN');
  assert.equal(env('TOKEN\r\n'), 'TOKEN');
  assert.equal(env('TOKEN\n\n'), 'TOKEN\n', 'only one newline goes');
  assert.equal(env('TOKEN'), 'TOKEN');
  assert.equal(env('A\nB'), 'A\nB');
  assert.equal(env('\n'), '');
  for (const text of ['TOKEN\n', 'TOKEN\n\n', 'TOKEN\r\n', 'TOKEN']) assert.equal(file(text), text);
});
