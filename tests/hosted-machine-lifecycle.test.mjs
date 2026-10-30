// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { childEnv } from '../scripts/child-env.mjs';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { machineInterruptions, hostedMachineLifecycleDrill } from './hosted-machine-lifecycle-drill.mjs';
import { sourceCutoverDrill } from './source-cutover-drill.mjs';
import { hostedMachineSourceDrill, hostedMachineCancelDrill } from './hosted-machine-source-drill.mjs';
const synthetic = {
  FORGE_HOSTED_CHECK_KEY_ID: 'SYNTHETIC',
  FORGE_SOURCE_PROVIDER: 'modal',
  FORGE_SOURCE_WORKER: 'fixed-worker',
  FORGE_SOURCE_RUNTIME: 'a'.repeat(64),
  FORGE_SOURCE_KEY_ID: 'SYNTHETIC',
  R2_ACCOUNT_ID: 'synthetic',
  R2_BUCKET: 'synthetic',
  R2_ACCESS_KEY_ID: 'synthetic',
  R2_SECRET_ACCESS_KEY: 'synthetic',
};
const prior = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
for (const interruption of machineInterruptions)
  test(`Q4 hosted ${interruption.name}: one passed check and one acceptance survive reconnect`, async t => {
    t.diagnostic(JSON.stringify(await hostedMachineLifecycleDrill(t, interruption)));
  });
test('Q4 selected reconnect stays bounded with dogfood source and twice retained landing history', async t => {
  // Isolate peak RSS from earlier tests and make the snapshot fake collect its
  // discarded whole-database copies within a finite heap on large CI machines.
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      '--max-old-space-size=384',
      '--import',
      './tests/check-runtime.mjs',
      fileURLToPath(new URL('./hosted-machine-lifecycle-scale-worker.mjs', import.meta.url)),
    ],
    { env: childEnv({ allow: Object.keys(synthetic) }), maxBuffer: 1024 * 1024 },
  );
  const result = JSON.parse(stdout);
  t.diagnostic(JSON.stringify(result));
  assert(result.functionTransactions <= 50, 'selected lifecycle transaction budget');
  assert(result.documentsRead <= 500, 'no collection/history hydration');
  assert(result.documentsWritten <= 160, 'bounded selected lifecycle writes');
  assert(result.maxDocumentsPerTransaction <= 60, 'bounded transaction window');
  assert(result.peakRssMiB <= 1024, 'synthetic provider snapshot harness memory budget');
});
test('Q4 hosted acceptance is recoverable on a clean root with no native acceptance owner', async t => {
  const result = await sourceCutoverDrill(t);
  assert.equal(result.metrics[3].dropped, 0);
  t.diagnostic(
    JSON.stringify({ synthetic: true, recoveredHead: result.recoveredHead, receiptId: result.receiptId }),
  );
});
test('Q4 starts, saves once and opens exact saved bytes from an independent root', async t => {
  t.diagnostic(JSON.stringify(await hostedMachineSourceDrill(t)));
});
test('Q4 cancellation and abandonment survive replay and late passing checks', async t => {
  t.diagnostic(JSON.stringify(await hostedMachineCancelDrill(t)));
});
test('Q4 snapshot fake keeps nested reads and failed writes isolated from retained rows', async () => {
  const f = lanesFixture();
  const id = f.insert('hostedProjects', {
    key: 'synthetic',
    name: 'Synthetic',
    currentBackup: null,
    revision: 0,
    owner: 'owner',
    visibility: 'private',
    sourceAuthority: { mode: 'server', epoch: 1 },
  });
  const failure = Error('synthetic interrupted transaction');
  await assert.rejects(
    f.call('interrupted-snapshot', {
      _handler: async ctx => {
        const read = await ctx.db.get(id);
        read.sourceAuthority.epoch = 99;
        assert.equal((await ctx.db.get(id)).sourceAuthority.epoch, 1);
        await ctx.db.patch(id, { sourceAuthority: { mode: 'server', epoch: 2 } });
        assert.equal((await ctx.db.get(id)).sourceAuthority.epoch, 2);
        throw failure;
      },
    }),
    error => error === failure,
  );
  assert.equal(f.tables.hostedProjects.get(id).sourceAuthority.epoch, 1);
});
