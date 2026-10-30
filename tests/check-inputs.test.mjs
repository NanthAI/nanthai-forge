// SPDX-License-Identifier: Apache-2.0
import { readWorkBytes } from './work-store-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LegacyWorkService as WorkService } from './autonomy-fixture.mjs';
import { NativeSource } from '../dist/native-source.js';
import { initLegacyNative as initNative } from './autonomy-fixture.mjs';
import { restoreNativeWork } from '../dist/native-backup.js';
import { serveRepository } from '../dist/http.js';
import { fixture as gitFixture, git, write } from './helpers.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-check-inputs-')),
    root = join(directory, 'owner');
  mkdirSync(root);
  writeFileSync(join(root, 'a.ts'), 'export const a=1;\n');
  writeFileSync(join(root, 'other.ts'), 'export const other=1;\n');
  writeFileSync(join(root, 'tool.sh'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(root, 'tool.sh'), 0o700);
  const tool = join(directory, 'observed-tool');
  writeFileSync(tool, '#!/bin/sh\nexit 0\n');
  chmodSync(tool, 0o700);
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  const marker = join(directory, 'git-used');
  writeFileSync(join(bin, 'git'), '#!/bin/sh\necho used > "' + marker + '"\nexit 91\n');
  chmodSync(join(bin, 'git'), 0o700);
  const previous = process.env.PATH;
  process.env.PATH = bin + ':' + previous;
  t.after(() => {
    process.env.PATH = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  initNative(root);
  const w = new WorkService(root),
    act = command => w.execute(command, w.store.load().revision).result;
  const intent = act({ action: 'intent', outcome: 'Declared evidence observations' }),
    lane = act({ action: 'lane', intentId: intent.id, name: 'Source' });
  const compose = () =>
    act({
      action: 'compose',
      operationId: randomUUID(),
      intentId: intent.id,
      inputs: [{ laneId: lane.id, head: w.store.load().lanes[0].head }],
    });
  const view = compose(),
    define = patch =>
      act({
        action: 'define-check',
        name: 'Optional observations',
        executable: process.execPath,
        args: ['-e', 'console.log("actual selected command")'],
        ...patch,
      });
  const checkpoint = () => {
    const current = w.store.load().lanes[0],
      source = new NativeSource(root);
    return act({
      action: 'checkpoint',
      laneId: lane.id,
      expectedHead: current.head,
      expectedTree: source.tree(source.capture(w.store.path(lane.id), false, current.head)),
      message: 'Changed source',
    });
  };
  return { directory, root, w, act, intent, lane, view, compose, define, checkpoint, tool, marker };
}
async function run(w, check, view, expectedStatus = 'passed') {
  const command = {
    action: 'run-check',
    operationId: randomUUID(),
    viewId: view.id,
    expectedHead: view.head,
    checkId: check.id,
    expectedDefinition: check.definition,
    expectedEnvironment: w.status().environment.fingerprint,
  };
  await w.dispatch(command, w.store.load().revision);
  for (let i = 0; i < 200; i++) {
    const original = w.store.load().runs.find(item => item.id === command.operationId);
    if (original.endedAt) {
      assert.equal(original.status, expectedStatus);
      return { command, original };
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Selected check did not finish');
}
const assess = (w, original, view) =>
  w
    .dispatch(
      { action: 'assess-check-inputs', runId: original.id, viewId: view.id, expectedHead: view.head },
      0,
    )
    .then(value => value.result);

test('optional declarations bind actual source/tool/runtime observations and external claims without secrets or new execution gates', async t => {
  const f = setup(t),
    priorTZ = process.env.TZ;
  process.env.TZ = 'UTC';
  process.env.FORGE_DECLARED_SECRET = 'PRIVATE_NOT_FOR_OBSERVATION';
  t.after(() => {
    if (priorTZ === undefined) delete process.env.TZ;
    else process.env.TZ = priorTZ;
    delete process.env.FORGE_DECLARED_SECRET;
  });
  const plain = f.define(),
    disabled = f.define({ checkId: plain.id, declaredInputs: [] });
  assert.equal(disabled.definition, plain.definition);
  const declaredInputs = [
    { kind: 'source', path: 'a.ts' },
    { kind: 'tool', executable: f.tool },
    { kind: 'environment', name: 'TZ' },
    { kind: 'environment', name: 'FORGE_DECLARED_SECRET' },
    { kind: 'external', name: 'API contract', claimSha256: sha('caller claim') },
  ];
  const check = f.define({ checkId: plain.id, declaredInputs });
  assert.notEqual(check.definition, plain.definition);
  writeFileSync(join(f.w.store.path(f.lane.id), 'a.ts'), 'owner dirty work is not checked');
  const { original } = await run(f.w, check, f.view);
  assert.equal(original.inputObservations.length, 5);
  assert.equal(original.inputObservations[0].sha256, sha('export const a=1;\n'));
  assert.equal(original.inputObservations[1].sha256, sha(readFileSync(f.tool)));
  assert.equal(original.inputObservations[2].sha256, sha('UTC'));
  assert.equal(original.inputObservations[3].status, 'unknown');
  assert.equal(original.inputObservations[4].status, 'claimed');
  assert.equal((await assess(f.w, original, f.view)).applicability, 'unknown');
  assert.equal(f.w.status().runs[0].applicability, 'current');
  assert.equal(f.w.store.load().schema, 24);
  assert.equal(existsSync(f.marker), false);
  const bytes = readWorkBytes(join(f.w.store.directory, 'work.json'), 'utf8');
  assert.ok(!bytes.includes(process.env.FORGE_DECLARED_SECRET));
  assert.ok(!bytes.includes(sha(process.env.FORGE_DECLARED_SECRET)));
  assert.equal(
    readFileSync(join(f.w.store.path(f.lane.id), 'a.ts'), 'utf8'),
    'owner dirty work is not checked',
  );
  const policy = (
    await f.w.dispatch(
      {
        action: 'define-invariant',
        operationId: randomUUID(),
        invariantId: randomUUID(),
        intentId: f.intent.id,
        name: 'Selected existing policy',
        statement: '',
        checkIds: [check.id],
        reviewers: [],
      },
      f.w.store.load().revision,
    )
  ).result;
  const assessment = (
    await f.w.dispatch(
      {
        action: 'assess-invariant',
        id: policy.id,
        definition: policy.definition,
        viewId: f.view.id,
        expectedHead: f.view.head,
      },
      0,
    )
  ).result;
  assert.equal(assessment.satisfied, true);
  const acceptance = f.act({
    action: 'accept-channel',
    operationId: randomUUID(),
    channel: 'main',
    viewId: f.view.id,
    expectedHead: f.view.head,
    expectedPrevious: null,
    invariant: { id: policy.id, definition: policy.definition },
  });
  assert.equal(acceptance.status, 'accepted');
});

test('unchanged declared inputs stay current across unrelated source; bytes/tool/mode/runtime/definition changes retain immutable originals', async t => {
  const f = setup(t),
    priorTZ = process.env.TZ;
  process.env.TZ = 'UTC';
  t.after(() => {
    if (priorTZ === undefined) delete process.env.TZ;
    else process.env.TZ = priorTZ;
  });
  const check = f.define({
    declaredInputs: [
      { kind: 'source', path: 'a.ts' },
      { kind: 'tool', executable: f.tool },
      { kind: 'tool', executable: './tool.sh' },
      { kind: 'environment', name: 'TZ' },
    ],
  });
  const { original } = await run(f.w, check, f.view),
    stored = JSON.stringify(f.w.store.load().runs[0]);
  const exact = await assess(f.w, original, f.view);
  assert.equal(exact.applicability, 'current');
  assert.equal(exact.validation.exactPassedRun, true);
  assert.equal(exact.validation.reuse, 'disabled');
  assert.equal(exact.validation.humanReview, 'separate');
  writeFileSync(join(f.w.store.path(f.lane.id), 'other.ts'), 'export const other=2;\n');
  f.checkpoint();
  const unrelated = f.compose();
  const unrelatedAssessment = await assess(f.w, original, unrelated);
  assert.equal(unrelatedAssessment.applicability, 'current');
  assert.equal(unrelatedAssessment.validation.successfulOutcome, true);
  assert.equal(unrelatedAssessment.validation.exactView, false);
  assert.equal(unrelatedAssessment.validation.exactPassedRun, false);
  assert.equal(unrelatedAssessment.validation.reuse, 'disabled');
  assert.equal(f.w.status().runs[0].applicability, 'historical');
  assert.match((await assess(f.w, original, unrelated)).coverage, /Undeclared dependencies/);
  writeFileSync(f.tool, '#!/bin/sh\nexit 3\n');
  let changed = await assess(f.w, original, unrelated);
  assert.equal(changed.inputs[1].applicability, 'changed');
  writeFileSync(f.tool, '#!/bin/sh\nexit 0\n');
  chmodSync(f.tool, 0o755);
  changed = await assess(f.w, original, unrelated);
  assert.equal(changed.inputs[1].applicability, 'changed');
  chmodSync(f.tool, 0o700);
  process.env.TZ = 'Etc/GMT+3';
  changed = await assess(f.w, original, unrelated);
  assert.equal(changed.inputs[3].applicability, 'changed');
  process.env.TZ = 'UTC';
  writeFileSync(join(f.w.store.path(f.lane.id), 'a.ts'), 'export const a=2;\n');
  f.checkpoint();
  const sourceChanged = f.compose();
  changed = await assess(f.w, original, sourceChanged);
  assert.equal(changed.inputs[0].applicability, 'changed');
  assert.equal(changed.applicability, 'changed');
  f.define({
    checkId: check.id,
    declaredInputs: check.declaredInputs,
    args: ['-e', 'console.log("new definition")'],
  });
  changed = await assess(f.w, original, f.view);
  assert.equal(changed.applicability, 'changed');
  assert.match(changed.reasons[0], /definition changed/);
  assert.equal(JSON.stringify(f.w.store.load().runs[0]), stored);
  assert.equal(existsSync(f.marker), false);
});

test('old/no declarations and unavailable inputs remain unknown; original retries do not recapture or relaunch', async t => {
  const f = setup(t),
    counter = join(f.directory, 'executions');
  const old = f.define(),
    legacy = await run(f.w, old, f.view);
  assert.equal(legacy.original.inputObservations, undefined);
  assert.equal((await assess(f.w, legacy.original, f.view)).applicability, 'unknown');
  const check = f.define({
    args: ['-e', `require('node:fs').appendFileSync(${JSON.stringify(counter)},${JSON.stringify('once\n')})`],
    declaredInputs: [
      { kind: 'source', path: 'missing.ts' },
      { kind: 'tool', executable: '/missing-tool' },
      { kind: 'environment', name: 'NOT_FORWARDED' },
      { kind: 'external', name: 'Unobserved API' },
    ],
  });
  const { original, command } = await run(f.w, check, f.view);
  assert.equal((await assess(f.w, original, f.view)).applicability, 'unknown');
  f.define({ checkId: check.id, args: ['-e', 'throw Error("must not substitute")'] });
  const retry = await f.w.dispatch(command, 0);
  assert.deepEqual(retry.result, original);
  assert.equal(readFileSync(counter, 'utf8'), 'once\n');
  await assert.rejects(
    f.w.dispatch({ ...command, expectedDefinition: '0'.repeat(64) }, 0),
    error => error.code === 'EVIDENCE_CHANGED',
  );
  assert.equal(f.w.store.load().runs.length, 2);
});

test('matching declared bytes never promote failed/cancelled outcomes or user reviews into passed evidence; restart and retries retain original records', async t => {
  const f = setup(t),
    check = f.define({ args: ['-e', 'process.exit(7)'], declaredInputs: [{ kind: 'source', path: 'a.ts' }] });
  const failed = await run(f.w, check, f.view, 'failed');
  f.act({
    action: 'review-view',
    viewId: f.view.id,
    expectedHead: f.view.head,
    reviewer: 'Claimed human',
    decision: 'approve',
    text: 'Independent provenance',
  });
  const result = await assess(f.w, failed.original, f.view);
  assert.equal(result.applicability, 'current');
  assert.equal(result.validation.outcome, 'failed');
  assert.equal(result.validation.exactPassedRun, false);
  assert.equal(result.validation.humanReview, 'separate');
  const ready = join(f.directory, 'cancel-ready'),
    waiting = f.define({
      args: [
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000)`,
      ],
      declaredInputs: check.declaredInputs,
    });
  const command = {
    action: 'run-check',
    operationId: randomUUID(),
    viewId: f.view.id,
    expectedHead: f.view.head,
    checkId: waiting.id,
    expectedDefinition: waiting.definition,
    expectedEnvironment: f.w.status().environment.fingerprint,
  };
  await f.w.dispatch(command, f.w.store.load().revision);
  for (let i = 0; i < 200 && !existsSync(ready); i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(existsSync(ready), true);
  await f.w.dispatch({ action: 'cancel-check', operationId: command.operationId }, 0);
  let cancelled;
  for (let i = 0; i < 200; i++) {
    cancelled = f.w.status().runs.find(item => item.id === command.operationId);
    if (cancelled.endedAt) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(cancelled.status, 'cancelled');
  const cancelledAssessment = await assess(f.w, cancelled, f.view);
  assert.equal(cancelledAssessment.applicability, 'current');
  assert.equal(cancelledAssessment.validation.successfulOutcome, false);
  assert.equal(cancelledAssessment.validation.exactPassedRun, false);
  const restarted = new WorkService(f.root),
    before = readWorkBytes(join(f.w.store.directory, 'work.json'));
  assert.deepEqual(
    (await restarted.dispatch(command, 0)).result,
    f.w.store.load().runs.find(item => item.id === command.operationId),
  );
  assert.deepEqual((await restarted.dispatch(failed.command, 0)).result, failed.original);
  assert.equal((await assess(restarted, cancelled, f.view)).validation.reuse, 'disabled');
  assert.deepEqual(readWorkBytes(join(f.w.store.directory, 'work.json')), before);
  assert.equal(restarted.store.load().runs.length, 2);
});

test('passed labels require a full successful receipt and exact ordered source/dependency pins independently of declared-input matches', async t => {
  const f = setup(t),
    check = f.define({ declaredInputs: [{ kind: 'source', path: 'a.ts' }] }),
    { original } = await run(f.w, check, f.view);
  const { declaredInputApplicability } = await import('../dist/work-inputs.js');
  const data = f.w.store.load(),
    environment = f.w.status().environment,
    stored = readWorkBytes(join(f.w.store.directory, 'work.json'));
  const assessSnapshot = (run, view = f.view) =>
    declaredInputApplicability(f.w.store, data, run, environment, view);
  for (const patch of [
    { endedAt: undefined },
    { exitCode: 7 },
    { signal: 'SIGTERM' },
    { cancelRequested: true },
    { status: 'interrupted' },
    { status: 'running' },
  ]) {
    const assessed = assessSnapshot({ ...original, ...patch });
    assert.equal(assessed.applicability, 'current');
    assert.equal(assessed.validation.successfulOutcome, false);
    assert.equal(assessed.validation.exactPassedRun, false);
  }
  for (const patch of [
    { inputs: [] },
    { dependencies: [{ intentId: randomUUID(), viewId: randomUUID(), head: 'a'.repeat(64) }] },
    { base: 'a'.repeat(64) },
  ]) {
    const assessed = assessSnapshot(original, { ...f.view, ...patch });
    assert.equal(assessed.applicability, 'current');
    assert.equal(assessed.validation.exactView, false);
    assert.equal(assessed.validation.exactPassedRun, false);
  }
  assert.deepEqual(readWorkBytes(join(f.w.store.directory, 'work.json')), stored);
});

test('Git compatibility observes exact committed bytes/mode rather than dirty files', async t => {
  const root = gitFixture(t, { 'a.ts': 'export const a=1;\n' });
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'Baseline']);
  const w = new WorkService(root),
    act = command => w.execute(command, w.status().revision).result;
  const intent = act({ action: 'intent', outcome: 'Git input evidence' }),
    lane = act({ action: 'lane', intentId: intent.id, name: 'Candidate' });
  const view = act({
    action: 'compose',
    intentId: intent.id,
    inputs: [{ laneId: lane.id, head: lane.head }],
  });
  write(w.store.path(lane.id), 'a.ts', 'dirty file remains separate');
  const check = act({
    action: 'define-check',
    name: 'Git bytes',
    executable: process.execPath,
    args: ['-e', 'console.log("checked")'],
    declaredInputs: [{ kind: 'source', path: 'a.ts' }],
  });
  const { original } = await run(w, check, view);
  assert.equal(original.inputObservations[0].sha256, sha('export const a=1;\n'));
  assert.equal((await assess(w, original, view)).applicability, 'current');
  assert.equal(readFileSync(join(w.store.path(lane.id), 'a.ts'), 'utf8'), 'dirty file remains separate');
});

test('CLI/protected HTTP/real SDK MCP retain declarations and expose same read-only assessment without repeated execution', async t => {
  const f = setup(t),
    cli = resolve('dist/cli.js');
  const definition = {
    action: 'define-check',
    name: 'Shared observations',
    executable: process.execPath,
    args: ['-e', 'console.log("shared command")'],
    declaredInputs: [{ kind: 'source', path: 'a.ts' }],
  };
  const check = JSON.parse(
    execFileSync(
      process.execPath,
      [cli, 'work', f.root, JSON.stringify(definition), String(f.w.store.load().revision)],
      { encoding: 'utf8' },
    ),
  ).result;
  assert.deepEqual(check.declaredInputs, definition.declaredInputs);
  const { original } = await run(f.w, check, f.view);
  const command = {
      action: 'assess-check-inputs',
      runId: original.id,
      viewId: f.view.id,
      expectedHead: f.view.head,
    },
    before = readWorkBytes(join(f.w.store.directory, 'work.json'));
  const local = (await f.w.dispatch(command, 0)).result;
  assert.deepEqual(
    JSON.parse(
      execFileSync(process.execPath, [cli, 'work', f.root, JSON.stringify(command), '0'], {
        encoding: 'utf8',
      }),
    ).result,
    local,
  );
  const server = await serveRepository(f.root, 0);
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.port}/api/work`,
    body = JSON.stringify({ command, revision: 0 });
  assert.equal(
    (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status,
    401,
  );
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' },
    body,
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).result, local);
  const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cli, 'mcp', f.root, '--work'],
      env: f.w.status().environment.env,
      stderr: 'pipe',
    }),
    client = new Client({ name: 'input-parity', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const result = await client.callTool({ name: 'forge_work_command', arguments: { command, revision: 0 } });
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text).result, local);
  assert.deepEqual(readWorkBytes(join(f.w.store.directory, 'work.json')), before);
  const exported = JSON.parse(
    (await f.w.dispatch({ action: 'export-check', id: original.id }, 0)).result.json,
  );
  assert.deepEqual(exported.run.inputObservations, original.inputObservations);
});

test('complete fresh native format5 recovery retains observations and incompatible prior4 readers preserve bytes', async t => {
  const f = setup(t),
    check = f.define({ declaredInputs: [{ kind: 'source', path: 'a.ts' }] }),
    { original } = await run(f.w, check, f.view);
  const backup = (await f.w.dispatch({ action: 'export-work', archive: true }, f.w.store.load().revision))
      .result,
    fresh = join(f.directory, 'fresh');
  await restoreNativeWork(backup.archive.path, fresh);
  const restored = new WorkService(fresh);
  assert.deepEqual(restored.store.load(), f.w.store.load());
  assert.deepEqual(restored.store.load().runs[0].inputObservations, original.inputObservations);
  assert.equal((await assess(restored, original, f.view)).applicability, 'current');
  const legacyCli = process.env.FORGE_LEGACY_INPUT_CLI;
  if (legacyCli) {
    const originalBytes = readWorkBytes(join(f.w.store.directory, 'work.json')),
      older = join(f.directory, 'older-restored');
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [
            legacyCli,
            'work',
            f.root,
            JSON.stringify({
              action: 'note',
              intentId: f.intent.id,
              kind: 'comment',
              text: 'must not strip observations',
            }),
            String(f.w.store.load().revision),
          ],
          { encoding: 'utf8', stdio: 'pipe' },
        ),
      error => /INVALID_WORK_STORE/.test(error.stderr),
    );
    assert.deepEqual(readWorkBytes(join(f.w.store.directory, 'work.json')), originalBytes);
    assert.throws(() =>
      execFileSync(process.execPath, [legacyCli, 'restore-native', backup.archive.path, older], {
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    );
    assert.equal(existsSync(older), false);
  } else t.diagnostic('Actual older binary not provided; fresh current reader restore ran.');
  assert.equal(existsSync(f.marker), false);
});

test('Git declared inputs retain current Work through recovery', async t => {
  const legacyCli = process.env.FORGE_LEGACY_INPUT_CLI;
  const root = gitFixture(t, { 'a.ts': 'export const a=1;' });
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'Git baseline']);
  const w = new WorkService(root);
  w.execute(
    { action: 'define-check', name: 'Old Git definition', executable: process.execPath, args: [] },
    0,
  );
  assert.equal(w.store.load().schema, 24);
  w.execute(
    {
      action: 'define-check',
      name: 'Git declared source',
      executable: process.execPath,
      args: [],
      declaredInputs: [{ kind: 'source', path: 'a.ts' }],
    },
    w.store.load().revision,
  );
  assert.equal(w.store.load().schema, 24);
  assert.equal(w.store.load().nativeHead, undefined);
  const backup = (await w.dispatch({ action: 'export-work', archive: true }, w.store.load().revision)).result;
  const { restoreWork } = await import('../dist/work-backup.js'),
    fresh = join(root, 'git-inputs-restored');
  await restoreWork(backup.archive.path, fresh);
  assert.deepEqual(new WorkService(fresh).store.load(), w.store.load());
  const before = readWorkBytes(join(w.store.directory, 'work.json'));
  if (legacyCli)
    assert.throws(
      () => execFileSync(process.execPath, [legacyCli, 'work', root], { encoding: 'utf8', stdio: 'pipe' }),
      error => /INVALID_WORK_STORE/.test(error.stderr),
    );
  assert.deepEqual(readWorkBytes(join(w.store.directory, 'work.json')), before);
});

test('later native source contribution and collection preserve selected format5 observations and exact original retries', async t => {
  const f = setup(t),
    check = f.define({ declaredInputs: [{ kind: 'source', path: 'a.ts' }] }),
    { original } = await run(f.w, check, f.view);
  const common = (await f.w.dispatch({ action: 'export-work', archive: true }, f.w.store.load().revision))
      .result,
    incomingRoot = join(f.directory, 'incoming');
  await restoreNativeWork(common.archive.path, incomingRoot);
  const incoming = new WorkService(incomingRoot),
    act = command => incoming.execute(command, incoming.store.load().revision).result;
  const lane = act({ action: 'lane', intentId: f.intent.id, name: 'New contributor source' });
  writeFileSync(join(incoming.store.path(lane.id), 'a.ts'), 'export const a=2;\n');
  const source = new NativeSource(incomingRoot),
    checkpoint = act({
      action: 'checkpoint',
      laneId: lane.id,
      expectedHead: lane.head,
      expectedTree: source.tree(source.capture(incoming.store.path(lane.id), false, lane.head)),
      message: 'Candidate source',
    });
  const view = act({
    action: 'compose',
    intentId: f.intent.id,
    inputs: [{ laneId: lane.id, head: checkpoint.head }],
  });
  act({
    action: 'define-check',
    name: 'Archived check is not owner authority',
    executable: process.execPath,
    args: [],
    declaredInputs: [{ kind: 'external', name: 'Unverified input' }],
  });
  const proposal = (
    await incoming.dispatch({ action: 'export-work', archive: true }, incoming.store.load().revision)
  ).result;
  writeFileSync(join(f.w.store.path(f.lane.id), 'a.ts'), 'unfinished owner source');
  const before = f.w.store.load();
  const command = {
    action: 'import-native-contribution',
    operationId: randomUUID(),
    intentId: f.intent.id,
    expectedBase: f.intent.base,
    expectedHead: view.head,
    archivePath: proposal.archive.path,
    archiveSha256: proposal.archive.sha256,
    name: 'Received after declared inputs',
  };
  const receipt = await f.w.dispatch(command, before.revision);
  assert.equal(f.w.store.load().schema, 24);
  assert.deepEqual(f.w.store.load().checks, before.checks);
  assert.deepEqual(f.w.store.load().runs, before.runs);
  assert.deepEqual(f.w.store.load().runs[0].inputObservations, original.inputObservations);
  assert.equal(
    (await f.w.dispatch({ ...command, archivePath: '/missing-original-retry' }, 0)).result.id,
    receipt.result.id,
  );
  assert.equal(readFileSync(join(f.w.store.path(f.lane.id), 'a.ts'), 'utf8'), 'unfinished owner source');
  assert.equal((await f.w.dispatch({ action: 'inspect-native-objects' }, 0)).result.format, 24);
  await f.w.dispatch({ action: 'collect-native-objects' }, 0);
  assert.equal(f.w.store.load().schema, 24);
  const backup = (await f.w.dispatch({ action: 'export-work', archive: true }, f.w.store.load().revision))
      .result,
    fresh = join(f.directory, 'fresh-contribution-inputs');
  await restoreNativeWork(backup.archive.path, fresh);
  assert.deepEqual(new WorkService(fresh).store.load(), f.w.store.load());
  assert.equal(existsSync(f.marker), false);
});
