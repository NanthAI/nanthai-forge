// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
test('shared batch publication requires the server-selected verify check', async t => {
  const f = await batchesFixture(t, { count: 0 });
  const id = f.rawChecks.checkId;
  const definition = await f.rawChecks.configure(
    {
      kind: 'definition',
      checkId: id,
      command: { name: 'lint', executable: 'node', args: ['tools/lint.mjs'], environmentLabel: 'clean' },
    },
    f.rawChecks.definition.digest,
  );
  const check = {
    kind: 'request',
    checkId: id,
    expectedDefinition: definition.digest,
    expectedConfiguration: f.rawChecks.configuration.digest,
    expectedEnvironment: f.rawChecks.runner.environmentFingerprint,
  };
  await f.add(0, { request: { check } });
  await f.add(1, { request: { check } });
  await f.drain();
  assert.equal(f.runs().length, 1, 'one shared run reached the publication boundary');
  const main = f.currentMain();
  await f.rawChecks.configure({
    kind: 'definition',
    checkId: randomUUID(),
    command: { name: 'verify', executable: 'node', args: ['tools/verify.mjs'], environmentLabel: 'clean' },
  });
  await f.passChecks();
  await f.drain();
  assert.equal(f.currentMain().receipt.id, main.receipt.id);
  assert.equal(f.tables.projectHostedAcceptances.size, 0);
  assert.deepEqual(
    states(f).map(s => [s.phase, s.error?.code]),
    [
      ['terminal-failed', 'CHECK_NOT_PASSED'],
      ['terminal-failed', 'CHECK_NOT_PASSED'],
    ],
  );
});
