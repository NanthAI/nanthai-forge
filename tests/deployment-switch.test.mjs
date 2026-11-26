// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

async function fixture(t) {
  const { recordDeploymentSwitch, deploymentSwitchReceipts } =
    await import('../scripts/deployment-switch.mjs');
  const directory = mkdtempSync(join(tmpdir(), 'forge-deployment-switch-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const request = {
    id: randomUUID(),
    deployment: 'synthetic-dev-1',
    name: 'FORGE_JOURNAL_SEGMENTS',
    enabled: true,
  };
  let state = false,
    marker = null,
    time = 100,
    lost = false,
    readsAvailable = true;
  const apply = (changes = {}) =>
    recordDeploymentSwitch(
      directory,
      { ...request, ...changes },
      {
        actor: () => 'operator',
        now: () => time++,
        readSetting: async (_deployment, name) => {
          if (!readsAvailable) throw Error('unexpected access to deployment');
          return name === request.name ? (state ? '1' : null) : marker;
        },
        writeSetting: async ({ enabled, id }) => {
          state = enabled;
          marker = id;
          if (lost) throw Error('SWITCH_WRITE_UNKNOWN');
        },
      },
    );
  const receipts = (deployments = []) => deploymentSwitchReceipts(directory, 100, 200, deployments);
  return {
    apply,
    receipts,
    loseReply: () => {
      lost = true;
    },
    moveSwitch: (enabled, id) => {
      state = enabled;
      marker = id;
    },
    disconnect: () => {
      readsAvailable = false;
    },
    current: () => state,
  };
}

test('deployment flips leave an attributed spend receipt and completed replays need no deployment access', async t => {
  const f = await fixture(t);
  const on = await f.apply();
  const off = await f.apply({ id: randomUUID(), enabled: false });
  const repeat = await f.apply({ id: randomUUID(), enabled: false });
  assert.equal(f.current(), false);
  assert.deepEqual(f.receipts(['synthetic-dev-1']), [on, off, repeat]);
  assert.deepEqual(f.receipts(['other-dev-2']), []);
  assert.deepEqual(
    [on, off, repeat].map(row => [row.actor, row.enabled, row.status]),
    [
      ['operator', true, 'applied'],
      ['operator', false, 'applied'],
      ['operator', false, 'unchanged'],
    ],
  );
  assert.ok(on.startedAt <= on.at && on.at < off.startedAt);
  f.disconnect();
  assert.deepEqual(await f.apply(), on);
  await assert.rejects(f.apply({ deployment: 'other-dev-2' }), /SWITCH_OPERATION_CHANGED/);
  await assert.rejects(f.apply({ deployment: 'dev' }), /SWITCH_ARGUMENTS/);
  await assert.rejects(f.apply({ name: 'FORGE_CLI_SECRET' }), /SWITCH_ARGUMENTS/);
});

test('a lost flip reply preserves the attempt and replay never overwrites a later switch change', async t => {
  const f = await fixture(t);
  f.loseReply();
  await assert.rejects(f.apply(), /SWITCH_WRITE_UNKNOWN/);
  const [pending] = f.receipts();
  assert.equal(pending.status, 'pending');
  assert.equal(pending.at, null);
  f.moveSwitch(true, randomUUID());
  await assert.rejects(f.apply(), /SWITCH_WRITE_UNKNOWN/);
  assert.equal(f.current(), true);
  assert.deepEqual(f.receipts(), [pending]);
  f.moveSwitch(false, pending.id);
  const observed = await f.apply();
  assert.deepEqual(observed, { ...pending, status: 'observed', at: 101 });
  assert.deepEqual(f.receipts(), [observed]);
});

test('the Convex CLI adapter distinguishes an absent switch from a failed read', async () => {
  const { readSwitchSetting } = await import('../scripts/deployment-switch.mjs');
  const name = 'FORGE_JOURNAL_SEGMENTS',
    message = `Environment variable "${name}" not found (on dev deployment synthetic-dev-1)\n`,
    offline = new Error('synthetic CLI failure');
  const read = (stdout, stderr, error = null) =>
    readSwitchSetting('synthetic-dev-1', name, async () => ({ stdout, stderr, error }));
  assert.equal(await read('', message), null);
  assert.equal(await read('', message, offline), null);
  assert.equal(await read('1\n', ''), '1');
  assert.equal(await read(' 1\n', ''), ' 1');
  await assert.rejects(read('', 'synthetic permission refusal', offline), { message: 'SWITCH_READ_FAILED' });
});
