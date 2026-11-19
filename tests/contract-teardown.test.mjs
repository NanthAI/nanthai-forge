// SPDX-License-Identifier: Apache-2.0
// scripts/contract-teardown.mjs removes the nightly contract resources. `cf` exits 0 when a
// non-interactive delete aborts, so the teardown must re-read each resource after deleting it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { teardown } from '../scripts/contract-teardown.mjs';

const options = { bucket: 'synthetic-bucket', 'cf-token-name': 'synthetic-token', environment: 'contracts' };
const fakeCli = ({ deletes = true } = {}) => {
  const present = { bucket: true, token: true },
    calls = [];
  const cli = (command, args) => {
    calls.push([command, ...args].join(' '));
    const [area, kind, verb] = args;
    if (area === 'r2' && kind === 'buckets' && verb === 'list')
      return { buckets: present.bucket ? [{ name: 'synthetic-bucket' }] : [] };
    if (area === 'r2' && kind === 'objects' && verb === 'list') return [];
    if (area === 'r2' && kind === 'buckets' && verb === 'delete') present.bucket = !deletes;
    if (area === 'accounts' && verb === 'list')
      return present.token ? [{ name: 'synthetic-token', id: 'synthetic-id' }] : [];
    if (area === 'accounts' && verb === 'delete') present.token = !deletes;
    return null;
  };
  return { cli, calls };
};

test('dry run reads each resource and deletes nothing', () => {
  const { cli, calls } = fakeCli();
  const results = teardown(options, cli, () => {});
  assert.deepEqual(
    results.map(r => r.result),
    ['would delete', 'would delete'],
  );
  assert.ok(calls.every(call => !/ delete /.test(` ${call} `)));
});

test('apply re-reads each resource and reports one an aborted delete left in place', () => {
  const done = teardown({ ...options, apply: true }, fakeCli().cli, () => {});
  assert.deepEqual(
    done.map(r => r.result),
    ['deleted', 'deleted'],
  );
  const aborted = teardown({ ...options, apply: true }, fakeCli({ deletes: false }).cli, () => {});
  assert.deepEqual(
    aborted.map(r => r.result),
    ['STILL PRESENT', 'STILL PRESENT'],
  );
});
