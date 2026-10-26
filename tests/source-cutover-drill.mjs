// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acceptanceFixture } from './hosted-acceptance-fixture.mjs';
import { recoveryFixture } from './recovery-fixture.mjs';
import { cutoverFixture, discovery } from './source-cutover-fixture.mjs';
import { NativeSource, nativeOwner } from '../dist/native-source.js';
import { WorkStore } from '../dist/work-store.js';
import { recoverOwner } from '../dist/recovery-owner.js';
import { hostedMacRuntime } from '../dist/hosted-mac-lease.js';
import { canonicalPayload } from '../dist/hosted-source-operation.js';
import { hostedRecoveryRows } from '../dist/recovery-hosted.js';

/** All IO is synthetic and private. The landing's actual H14 receipt is recovered. */
export async function sourceCutoverDrill(t) {
  const seconds = {};
  const timed = async (name, action) => {
    const start = performance.now();
    const result = await action();
    seconds[name] = Number(((performance.now() - start) / 1000).toFixed(3));
    console.error(`B1.5b ${name}: ${seconds[name]}s`);
    return result;
  };
  const r = await recoveryFixture(t),
    initial = await acceptanceFixture();
  Object.assign(initial.main, {
    head: r.main.head,
    snapshotId: 'seed',
    receipt: { id: r.main.id, kind: 'native', previousHead: null, previousReceiptId: null },
  });
  const f = await cutoverFixture(initial);
  await timed('cutover dry-run', () => f.dryRun());
  const forward = await timed('cutover apply', () => f.applyCutover());
  // Build a new State offline; after this point the landing uses only hosted metadata.
  const source = new NativeSource(r.root);
  const bytes = 'landed with all Macs offline\n',
    blob = source.put(Buffer.from(bytes));
  const head = source.writeState(
    [{ path: 'source.ts', blob, mode: 'file' }],
    [r.main.head],
    'Hosted-only drill',
    '2026-10-26T00:00:00.000Z',
  );
  f.put(source.object(head));
  const defaultState = {
    schema: 1,
    kind: 'forge-source-state',
    parents: [],
    files: [],
    message: 'synthetic check source',
    at: '2026-01-01T00:00:00.000Z',
  };
  source.put(Buffer.from(JSON.stringify(defaultState)));
  f.insert('projectHostedStates', {
    projectId: f.projectId,
    head,
    size: source.object(head).length,
    input: 'a'.repeat(64),
    jobId: randomUUID(),
    output: 'b'.repeat(64),
  });
  // Remove the check fixture's placeholder Candidate; the drill uses a canonical empty selection.
  for (const table of ['projectHostedRecordBodies', 'projectHostedRecords', 'projectHostedRecordHeads'])
    f.tables[table].clear();
  const item = await f.makeCandidate([], [], {
    base: { head: r.main.head, receiptId: r.main.id },
    algorithm: 'forge-native-compose-v1',
    result: { status: 'clean', head },
  });
  for (const page of [...item.pages.inputs, ...item.pages.dependencies])
    source.put(Buffer.from(canonicalPayload(page.value)));
  const landed = await timed('hosted CAS landing; Macs offline', async () => {
    const { state } = await f.ready(item);
    const result = await f.accept(state);
    assert.equal(result.status, 'landed');
    return result;
  });
  await timed('old CLI refused', async () => {
    await assert.rejects(
      f.cutoverCall('oldCli', discovery.capabilities, { clientVersion: '0.3.0' }),
      e => e.data.code === 'CLI_UPGRADE_REQUIRED',
    );
  });
  assert.equal(f.tables.projectHostedAcceptances.size, 1);
  assert.equal(f.currentMain().receipt.id, landed.receipt.id);
  r.request.projectId = r.selection.projectId = f.projectId;
  r.selection.authority = forward.authority;
  r.selection.hostedMain = f.currentMain();
  const download = r.transport.download;
  r.transport.download = async pin => {
    try {
      return source.object(pin.sha256);
    } catch {
      return download(pin);
    }
  };
  r.transport.objects = async ids => ids.map(sha256 => ({ sha256, size: source.object(sha256).length }));
  r.transport.hostedPage = async (_selection, table, cursor) => {
    const all = [...f.tables[table].values()].filter(row => row.projectId === f.projectId);
    const offset = Number(cursor ?? 0),
      rows = all.slice(offset, offset + 32).map(canonicalPayload);
    const done = offset + rows.length === all.length;
    return { table, rows, cursor: done ? null : String(offset + rows.length), done };
  };
  r.transport.reconnect = async () => {
    assert.fail('Route B must not restore local acceptance authority');
  };
  const configuration = {
    provider: 'mac',
    machineId: randomUUID(),
    runtime: hostedMacRuntime,
    environmentFingerprint: 'd'.repeat(64),
  };
  Object.assign(r.transport, {
    current: async () => structuredClone(f.currentMain()),
    configuration: async () => configuration,
    downloadToFile: async (pin, path) => writeFileSync(path, await r.transport.download(pin)),
    register: async request => ({
      status: 'completed',
      result: {
        projectId: f.projectId,
        machineId: configuration.machineId,
        sessionId: request.operationId,
        configuration: 'synthetic',
        keyId: 'SYNTHETIC',
      },
    }),
  });
  assert(!existsSync(r.target));
  const recovered = await timed('Route B; clean machine', () =>
    recoverOwner(r.target, r.request, r.transport),
  );
  assert.equal(recovered.coverage.main.head, head);
  assert.equal(
    recovered.role,
    'runner-cache',
    'Route B requires the B1.5a2 runner/cache recovery implementation',
  );
  assert.equal(recovered.coverage.main.receipt.id, landed.receipt.id);
  assert.equal(nativeOwner(r.target), null);
  assert.throws(() => new WorkStore(r.target));
  // A runner/cache recovery is not an owner; read its hosted rows from the coverage pointer.
  const restored = new NativeSource(r.target);
  const receipts = [...hostedRecoveryRows(restored, recovered.coverage.hosted, 'projectHostedAcceptances')];
  assert.equal(JSON.parse(receipts[0].value).id, landed.receipt.id);
  assert.equal(restored.object(blob).toString(), bytes);
  assert.equal(readFileSync(join(r.target, 'source.ts'), 'utf8'), bytes);
  assert.equal(r.counters().reconnects, 0);
  assert.equal(f.tables.projectHostedAcceptances.size, 1, 'recovery does not repeat acceptance');
  const reverse = { operationId: randomUUID(), mode: 'native-owner', pins: await f.pins() };
  const rollback = await timed('one-authority rollback CAS', () => f.applyCutover(reverse));
  assert.equal(rollback.authority.epoch, 2);
  assert.equal(rollback.main.head, head);
  assert.equal(rollback.main.receipt.id, landed.receipt.id);
  assert.deepEqual(await f.applyCutover(reverse), rollback);
  return {
    synthetic: true,
    seconds,
    recoveredHead: head,
    receiptId: landed.receipt.id,
    authorityEpochs: [0, forward.authority.epoch, rollback.authority.epoch],
    metrics: {
      3: { queued: 1, landed: 1, dropped: 0 },
      5: { queueNudges: 0, restarts: 0, landingRetries: 0, productionRate: null },
      7: {
        before: 'owner-hosted',
        after: 'hosted-cache',
        cutoverAt: forward.at,
        productionP50: null,
        productionP95: null,
        contradictionMinutes: null,
      },
    },
    productionRouteA: 'unrun',
    productionRouteB: 'unrun',
    sevenDayWatch: 'unrun',
  };
}
