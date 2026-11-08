// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { cliReleaseKeyId, cliReleasePublicKey, signCliRelease } from '../dist/cli-release-trust.js';
import { CLI_RELEASE_VERIFY_MAX_STATES, verifyCliReleases } from '../dist/cli-release-verify.js';

const projectId = 'forge-source';
const [a, b, c] = ['a', 'b', 'c'].map(x => x.repeat(64));
function releaseKey() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const publicKey = cliReleasePublicKey(privateKey);
  return {
    pem: privateKey.export({ format: 'pem', type: 'pkcs8' }),
    key: { id: cliReleaseKeyId(publicKey), publicKey },
  };
}
/** A signature store spy: one read per State, never a write. */
function store(rows, main = c) {
  const reads = [];
  return {
    reads,
    source: {
      current: async () => ({ head: main }),
      signatures: async head => {
        reads.push(head);
        if (rows[head] instanceof Error) throw rows[head];
        return rows[head] ?? [];
      },
    },
  };
}

test('release-verify: stored v2 signatures verify in landing order with one read per State, no signature printed', async () => {
  const one = releaseKey();
  const rows = {
    [a]: [signCliRelease(one.pem, projectId, a, 10)],
    [b]: [signCliRelease(one.pem, projectId, b, 11)],
    [c]: [signCliRelease(one.pem, projectId, c, 14)],
  };
  const { reads, source } = store(rows);
  const result = await verifyCliReleases({ projectId, states: [a, b, c] }, source, [one.key]);
  assert.deepEqual(reads, [a, b, c]);
  assert.equal(result.ok, true);
  assert.equal(result.ordered, true);
  assert.deepEqual(result.keys, [one.key.id]);
  assert.deepEqual(
    result.checked.map(row => [row.status, row.keyId, row.release]),
    [
      ['verified', one.key.id, 10],
      ['verified', one.key.id, 11],
      ['verified', one.key.id, 14],
    ],
  );
  const printed = JSON.stringify(result);
  for (const signed of Object.values(rows).flat()) assert.ok(!printed.includes(signed.signature));
  // No State given: main's head, one release read and one signature read.
  const main = store(rows);
  const head = await verifyCliReleases({ projectId, states: [] }, main.source, [one.key]);
  assert.deepEqual(main.reads, [c]);
  assert.deepEqual(
    head.checked.map(row => row.release),
    [14],
  );
});

test('release-verify fails on any unsigned, wrong, unlisted, unnumbered or out-of-order State', async () => {
  const one = releaseKey(),
    other = releaseKey();
  const check = async (rows, states = [a, b]) =>
    verifyCliReleases({ projectId, states }, store(rows).source, [one.key]);
  const good = { [a]: [signCliRelease(one.pem, projectId, a, 10)] };
  const cases = {
    unsigned: { ...good },
    unlisted: { ...good, [b]: [signCliRelease(other.pem, projectId, b, 11)] },
    'read failed': { ...good, [b]: new Error('synthetic read failure') },
    // Signed for another State: a listed key's signature that does not match.
    invalid: { ...good, [b]: [{ ...signCliRelease(one.pem, projectId, c, 11) }] },
    unnumbered: { ...good, [b]: [signCliRelease(one.pem, projectId, b)] },
  };
  const expected = {
    unsigned: 'unsigned',
    unlisted: 'unsigned',
    'read failed': 'unsigned',
    invalid: 'invalid',
    unnumbered: 'unnumbered',
  };
  for (const [name, rows] of Object.entries(cases)) {
    const result = await check(rows);
    assert.equal(result.ok, false, name);
    assert.equal(result.checked[0].status, 'verified', name);
    assert.equal(result.checked[1].status, expected[name], name);
    assert.equal(result.checked[1].release, undefined, name);
  }
  // Each verifies, but the numbers do not go up in the order given (or repeat).
  for (const [first, second] of [
    [11, 10],
    [10, 10],
  ]) {
    const result = await check({
      [a]: [signCliRelease(one.pem, projectId, a, first)],
      [b]: [signCliRelease(one.pem, projectId, b, second)],
    });
    assert.ok(result.checked.every(row => row.status === 'verified'));
    assert.equal(result.ordered, false);
    assert.equal(result.ok, false);
  }
  await assert.rejects(check({}, ['abc']), { code: 'BAD_ARGUMENT' });
  await assert.rejects(check({}, Array(CLI_RELEASE_VERIFY_MAX_STATES + 1).fill(a)), { code: 'BAD_ARGUMENT' });
});
