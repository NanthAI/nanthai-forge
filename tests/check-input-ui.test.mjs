// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LegacyWorkService as WorkService } from './autonomy-fixture.mjs';
import { initLegacyNative as initNative } from './autonomy-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const { checkInputFields } = await import(moduleUrl('../web/src/check-input-form.ts'));

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-check-input-ui-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, 'a.ts'), 'export const selectedInput=1;\n');
  initNative(root);
  const w = new WorkService(root),
    act = command => w.execute(command, w.store.load().revision).result;
  const intent = act({ action: 'intent', outcome: 'Declared browser evidence', constraints: '' });
  const lane = act({ action: 'lane', intentId: intent.id, name: 'Own source' });
  const view = act({
    action: 'compose',
    intentId: intent.id,
    inputs: [{ laneId: lane.id, head: lane.head }],
  });
  const inputs = [
    { kind: 'source', path: 'a.ts' },
    { kind: 'tool', executable: process.execPath },
    { kind: 'environment', name: 'PATH' },
    { kind: 'external', name: 'API <script>claim</script>', claimSha256: 'a'.repeat(64) },
  ];
  const check = act({
    action: 'define-check',
    name: 'Original declaration',
    executable: process.execPath,
    args: ['-e', 'console.log("synthetic checked")'],
    declaredInputs: inputs,
  });
  return { w, act, view, check, inputs };
}
async function run(f) {
  const status = f.w.status(),
    operationId = randomUUID();
  await f.w.dispatch(
    {
      action: 'run-check',
      operationId,
      viewId: f.view.id,
      expectedHead: f.view.head,
      checkId: f.check.id,
      expectedDefinition: f.check.definition,
      expectedEnvironment: status.environment.fingerprint,
    },
    status.revision,
  );
  for (let n = 0; n < 200; n++) {
    const data = f.w.status(),
      run = data.runs.find(item => item.id === operationId);
    if (run?.endedAt) return { data, run };
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw Error('Synthetic selected check did not finish');
}

test('browser edit serialization retains all four declarations through the real native definition owner and execution', async t => {
  const f = setup(t),
    original = structuredClone(f.inputs);
  const edited = f.act({
    action: 'define-check',
    checkId: f.check.id,
    name: 'Renamed in browser',
    executable: f.check.executable,
    args: f.check.args,
    declaredInputs: checkInputFields(f.check.declaredInputs),
  });
  assert.deepEqual(edited.declaredInputs, original);
  assert.deepEqual(f.inputs, original);
  assert.equal(f.w.store.load().schema, 5);
  f.check = edited;
  const { run: observed } = await run(f);
  assert.equal(observed.status, 'passed');
  assert.deepEqual(observed.check.declaredInputs, original);
  assert.equal(observed.inputObservations.length, 4);
  assert.equal(observed.inputObservations[0].producer, 'selected-source');
  assert.equal(observed.inputObservations[2].producer, 'forwarded-runtime');
  assert.equal(observed.declaredInputApplicability.applicability, 'unknown');
  assert.equal(observed.inputObservations[3].status, 'claimed');
});

test('declaration serialization preserves optional inputs and rejects malformed claims', () => {
  const inputs = [
    { kind: 'source', path: ' a.ts' },
    { kind: 'tool', executable: 'node' },
    { kind: 'environment', name: 'TZ' },
    { kind: 'external', name: 'API', claimSha256: 'b'.repeat(64) },
  ];
  assert.deepEqual(checkInputFields(inputs), inputs);
  assert.deepEqual(checkInputFields([]), []);
  assert.deepEqual(checkInputFields([{ kind: 'source', path: ' ' }]), [{ kind: 'source', path: ' ' }]);
  assert.throws(
    () => checkInputFields([{ kind: 'source', path: '' }]),
    /Remove it to leave the check undeclared/,
  );
  assert.throws(
    () => checkInputFields([{ kind: 'external', name: 'API', claimSha256: 'wrong' }]),
    /64-character lowercase SHA-256/,
  );
  assert.deepEqual(checkInputFields([{ kind: 'external', name: ' API ', claimSha256: ' ' }]), [
    { kind: 'external', name: 'API' },
  ]);
});
