// SPDX-License-Identifier: Apache-2.0
// T18 over the slice-2 sharing journeys (Gate B2 M2): automatic share, Undo by fingerprint, removal with re-key on
// the next write, unshare --marked and the key-store share log. Real sealed and contributor Convex modules on a
// synthetic hosted project; synthetic keys and values only. Code approvals and repair are covered where they run
// (tests/sealed-code.test.mjs, tests/sealed-repair.test.mjs); slice 1 in tests/sealed-client.test.mjs.
import './check-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { clone, setup } from './helpers/sealed-hosted.mjs';
import { device, owner } from './helpers/sealed-devices.mjs';
import { assertLocalFiles, assertNoPlaintext, deviceSecrets } from './helpers/sealed-no-plaintext.mjs';
import { deviceFingerprint } from '../dist/sealed-join.js';
import { removeMarked, unshareDevice } from '../dist/sealed-unshare.js';

const contributors = await import(moduleUrl('../convex/projectContributors.ts'));
const code = expected => error => (error.code ?? error.data?.code) === expected;
const values = [
  Buffer.from('synthetic-sh4re-one-0123456789'),
  Buffer.from('synthetic-sh4re-file-abcdef0123'),
  Buffer.from('synthetic-sh4re-rotated-9876543210'),
];

test('T18 slice-2 sharing journeys keep values and keys out of every stored row, call, notice and local file', async t => {
  const h = setup(t),
    o = owner(h),
    calls = h.calls,
    notices = [o.notices],
    setKeys = [];
  // Every read that opens the set key keeps a copy, so each epoch's key is checked.
  const read = async client => {
    const result = await client.read();
    try {
      if (result.key) setKeys.push(Buffer.from(result.key));
    } finally {
      result.key?.fill(0);
      for (const secret of result.secrets) secret.value.fill(0);
    }
  };
  const record = (transport, label) => {
    for (const action of ['read', 'write', 'join']) {
      const call = transport[action];
      transport[action] = async input => {
        calls.push(clone({ action, label, input }));
        return call(input);
      };
    }
  };
  record(o.transport, 'owner');
  // Recorded before the devices' clients send anything: each client holds this transport object.
  const join = account => {
    const d = device(h, t, account);
    record(d.transport, account);
    notices.push(d.notices);
    return d;
  };
  const joined = async account => {
    const d = join(account);
    await assert.rejects(d.client.read(), code('SECRETS_WAITING'));
    await read(o.client);
    await read(d.client);
    return d;
  };
  await o.client.write('API_TOKEN', values[0]);
  await o.client.write('CERT_FILE', values[1], { file: true });
  // Automatic share, then Undo by fingerprint (removal with re-key).
  const a = await joined('fixture-a');
  assert.equal((await unshareDevice(o.client, deviceFingerprint(a.keys.id))).already, false);
  await read(o.client);
  // A person who leaves is marked; the owner's next write removes and re-keys before its change.
  const b = await joined('fixture-b');
  await contributors.remove._handler(h.s.ctx, { projectId: h.project, contributor: 'fixture-b' });
  await o.client.write('API_TOKEN', values[2]);
  await read(o.client);
  // unshare --marked removes the next leaver in one write.
  const c = await joined('fixture-c');
  await contributors.remove._handler(h.s.ctx, { projectId: h.project, contributor: 'fixture-c' });
  assert.equal((await removeMarked(o.client)).removed.length, 1);
  await read(o.client);
  // Three re-keys after the first epoch, each key seen; the share log holds this device's automatic shares.
  assert.equal(new Set(setKeys.map(k => k.toString('hex'))).size, 4);
  assert.equal(h.pins.store.load().shares.length, 3);
  assert(['owner', 'fixture-a', 'fixture-b', 'fixture-c'].every(l => calls.some(x => x.label === l)));
  assert(calls.some(x => x.action === 'join'));

  const devices = [
    { label: 'owner', keys: h.f.keys, directory: h.directory },
    ...[a, b, c].map((d, i) => ({ label: `device-${i}`, keys: d.keys, directory: d.directory })),
  ];
  const keys = [...setKeys, ...devices.flatMap(d => deviceSecrets(d.keys))];
  assertNoPlaintext(
    'rows, calls and notices',
    {
      rows: Object.fromEntries(Object.entries(h.s.tables).map(([k, v]) => [k, [...v.values()]])),
      calls,
      notices,
    },
    { values, keys },
  );
  // Each device holds its key store (with the share log and join record) and its pins, all checked.
  const checked = assertLocalFiles(devices, { values, setKeys });
  for (const d of devices)
    assert(checked[d.label].includes('device.bin') && checked[d.label].length >= 3, d.label);
  // The guard still sees a planted leak, so it cannot pass by checking nothing.
  assert.throws(() => assertNoPlaintext('planted', { n: [values[1].toString('base64url')] }, { values }));
  assert.throws(() => assertNoPlaintext('planted', { k: Buffer.from(setKeys[3]) }, { keys }));
});
