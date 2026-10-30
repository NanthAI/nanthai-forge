// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { initNative } from '../dist/native-work.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { integrationPreview, previewPinned } from '../dist/integration-preview.js';
import { PreviewChecks } from '../dist/integration-preview-checks.js';
import { previewClosure } from '../dist/integration-preview-inputs.js';
import { PeersSource } from '../dist/agent-peers-source.js';
import { CoordinationJournal } from '../dist/agent-coordination-journal.js';
import { agentPeers } from '../dist/agent-peers.js';

async function fixture(t, { script, files = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'forge-preview-correctness-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  for (const [path, bytes] of Object.entries({ 'a.txt': '0', 'b.txt': '0', 'c.txt': '0', ...files })) {
    writeFileSync(join(root, path), bytes);
  }
  const initial = initNative(root),
    agent = new AgentWorkflow(root),
    store = agent.work.store;
  store.locked(() => {
    const tx = store.records();
    tx.append('channelMoves', {
      id: randomUUID(),
      channel: 'main',
      viewId: randomUUID(),
      head: initial.head,
      previous: null,
      at: new Date().toISOString(),
      status: 'accepted',
      provenance: 'user-declared-local',
    });
    store.commitRecords(tx);
  });
  const define = async (args, extra = {}) =>
    (
      await agent.dispatch({
        action: 'define-check',
        name: 'Synthetic static',
        static: true,
        executable: process.execPath,
        args,
        ...extra,
      })
    ).result;
  if (script) await define(['-e', script]);
  const start = async (extra = {}) =>
    (await agent.dispatch({ action: 'start', outcome: 'Synthetic S10', ...extra })).result;
  const save = async (lane, path, text) => {
    writeFileSync(join(lane.path, path), text);
    lane.head = (
      await agent.dispatch({ action: 'checkpoint', laneId: lane.laneId, message: 'Synthetic save' })
    ).result.head;
  };
  const edit = fn =>
    store.locked(() => {
      const data = store.load();
      fn(data);
      store.save(data);
    });
  return {
    root,
    store,
    agent,
    start,
    save,
    define,
    edit,
    initial,
    integrate: (input = {}) => integrationPreview(store, input).result,
  };
}
const readFlags = `const fs=require('node:fs'); const flags=['a','b','c'].map(n=>fs.readFileSync(n+'.txt','utf8')==='1');`;

test('R5/R6: BlobId/archiveSource interface passes separately and fails after disjoint composition', async t => {
  const f = await fixture(t, {
    files: {
      'archive.ts':
        'export type BlobId = string & {readonly blob: unique symbol};\nexport function archiveSource(): {blob: BlobId} {return {blob: "id" as BlobId};}\n',
      'consumer.ts': 'import {archiveSource} from "./archive";\nexport const source = archiveSource();\n',
    },
  });
  await f.define([
    resolve('node_modules/typescript/lib/tsc.js'),
    '--noEmit',
    '--strict',
    '--skipLibCheck',
    'archive.ts',
    'consumer.ts',
  ]);
  const r5 = await f.start(),
    r6 = await f.start();
  await f.save(
    r5,
    'archive.ts',
    'export type BlobId = string & {readonly blob: unique symbol};\nexport function archiveSource(): {blob?: BlobId} {return {};}\n',
  );
  await f.save(
    r6,
    'consumer.ts',
    'import {archiveSource, type BlobId} from "./archive";\nexport const source: BlobId = archiveSource().blob;\n',
  );
  const result = f.integrate();
  assert.equal(result.status, 'clash');
  assert.equal(result.baseline.status, 'passed');
  assert.ok(result.individual.every(row => row.result.status === 'passed'));
  assert.match(result.pairs[0].errors.join('\n'), /BlobId|undefined/);
  assert.ok(result.observations.every(row => row.result.head));
  for (const lane of [r5, r6])
    assert.equal(new CoordinationJournal(f.store).context(lane.laneId).notices.length, 1);
});

test('all pairs pass but a three-way static failure retains all participants and controls', async t => {
  const f = await fixture(t, {
    script: readFlags + "if(flags.every(Boolean)) { console.error('three-way interface'); process.exit(1); }",
  });
  const lanes = [];
  for (const name of ['a', 'b', 'c']) {
    const lane = await f.start();
    await f.save(lane, name + '.txt', '1');
    lanes.push(lane);
  }
  const result = f.integrate();
  assert.equal(result.status, 'clash');
  assert.equal(result.pairs.length, 0);
  assert.equal(result.interactions.length, 1);
  assert.equal(result.interactions[0].laneIds.length, 3);
  assert.equal(result.interactions[0].minimization, 'incomplete');
  assert.equal(
    result.observations.filter(row => row.laneIds.length === 2 && row.result.status === 'passed').length,
    3,
  );
  assert.equal(result.notices[0].participants.length, 3);
  for (const lane of lanes)
    assert.equal(new CoordinationJournal(f.store).context(lane.laneId).notices.length, 1);
  assert.equal(f.store.load().runs.length, 0);
  assert.equal(f.store.load().channelMoves.length, 1);
});

test('Intent dependency closure makes an otherwise failing standalone control pass', async t => {
  const f = await fixture(t, { script: readFlags + 'if(flags[1] && !flags[0]) process.exit(1);' });
  const parent = await f.start();
  await f.save(parent, 'a.txt', '1');
  const view = (
    await f.agent.dispatch({
      action: 'compose',
      operationId: randomUUID(),
      intentId: parent.intentId,
      inputs: [{ laneId: parent.laneId, head: parent.head }],
      dependencies: [],
    })
  ).result;
  const child = await f.start();
  await f.save(child, 'b.txt', '1');
  f.edit(data => {
    data.intents.find(row => row.id === child.intentId).dependencies = [
      { kind: 'view', viewId: view.viewId, head: view.head },
    ];
  });
  const result = f.integrate({ laneIds: [child.laneId] });
  assert.equal(result.status, 'clean');
  assert.ok(result.dependencies[0].heads.includes(view.head));
  assert.deepEqual(result.coverage.omittedLaneIds, [parent.laneId]);
  assert.match(result.coverage.gaps.join(' '), /unsaved/);
  const oldKey = result.key;
  f.edit(data => {
    data.intents.find(row => row.id === child.intentId).dependencies = [];
  });
  const changed = f.integrate({ laneIds: [child.laneId] });
  assert.notEqual(changed.key, oldKey);
  assert.equal(changed.status, 'failed');
});

test('missing or cyclic dependencies are inconclusive rather than a standalone failure', async t => {
  const f = await fixture(t, { script: 'process.exit(0)' });
  const a = await f.start(),
    b = await f.start();
  await f.save(a, 'a.txt', '1');
  await f.save(b, 'b.txt', '1');
  f.edit(data => {
    data.lanes.find(row => row.id === a.laneId).after = { intentId: b.intentId };
    data.lanes.find(row => row.id === b.laneId).after = { intentId: a.intentId };
  });
  assert.match(
    previewClosure(f.store.load(), [f.store.select('lanes', a.laneId)])[0].errors.join(' '),
    /Cyclic/,
  );
  assert.equal(f.integrate().status, 'inconclusive');
  f.edit(data => {
    delete data.lanes.find(row => row.id === a.laneId).after;
    data.intents.find(row => row.id === a.intentId).dependencies = [
      { kind: 'view', viewId: randomUUID(), head: a.head },
    ];
  });
  const result = f.integrate({ laneIds: [a.laneId] });
  assert.equal(result.status, 'inconclusive');
  assert.equal(result.combined.code, 'INTEGRATION_DEPENDENCY_UNAVAILABLE');
  assert.equal(result.notices.length, 0);
});

test('external input verdicts are historical and reexecuted even for an unchanged tuple', async t => {
  const external = join(mkdtempSync(join(tmpdir(), 'forge-preview-external-')), 'flag');
  t.after(() => rmSync(resolve(external, '..'), { recursive: true, force: true }));
  writeFileSync(external, '0');
  const f = await fixture(t, {
    script: `if(require('node:fs').readFileSync(${JSON.stringify(external)},'utf8')==='1') process.exit(1);`,
  });
  const a = await f.start();
  await f.save(a, 'a.txt', '1');
  const before = f.integrate();
  writeFileSync(external, '1');
  const after = f.integrate();
  assert.equal(after.key, before.key);
  assert.equal(after.cached, false);
  assert.deepEqual(after.historical, { key: before.key, status: 'clean' });
  assert.equal(after.status, 'baseline-failed');
});

test('old saved pins are visibly historical and do not republish obsolete notices', async t => {
  const f = await fixture(t, { script: readFlags + 'if(flags[0] && flags[1]) process.exit(1);' });
  const a = await f.start(),
    b = await f.start();
  await f.save(a, 'a.txt', '1');
  await f.save(b, 'b.txt', '1');
  const pins = [a, b].map(lane => ({ laneId: lane.laneId, head: lane.head }));
  await f.save(b, 'b.txt', '0');
  const result = previewPinned(f.store, undefined, pins).result;
  assert.equal(result.status, 'clash');
  assert.equal(result.applicability, 'historical');
  assert.equal(new CoordinationJournal(f.store).context().notices.length, 0);
});

test('configuration drift invalidates current peer notices without another saved head', async t => {
  const f = await fixture(t, { script: readFlags + 'if(flags[0] && flags[1]) process.exit(1);' });
  const a = await f.start(),
    b = await f.start();
  await f.save(a, 'a.txt', '1');
  await f.save(b, 'b.txt', '1');
  const before = f.integrate();
  assert.ok(agentPeers(f.store, { laneId: a.laneId }).notices.some(n => /Integration preview/.test(n.text)));
  const check = f.store.load().checks[0];
  await f.define(['-e', 'process.exit(0)'], { checkId: check.id });
  assert.ok(
    !agentPeers(f.store, { laneId: a.laneId }).notices?.some(n => /Integration preview/.test(n.text)),
  );
  assert.notEqual(f.integrate().key, before.key);
});

test('each static control gets pristine dependency bytes; no command mutates a later control', async t => {
  const files = { 'package.json': '{}', 'package-lock.json': '{}' };
  const f = await fixture(t, { files });
  mkdirSync(join(f.root, 'node_modules'));
  writeFileSync(join(f.root, 'node_modules/fixture.txt'), 'pristine');
  const runner = new PreviewChecks(
    f.store,
    new PeersSource(f.store, ''),
    [],
    [
      {
        name: 'mutator',
        executable: process.execPath,
        args: [
          '-e',
          `const fs=require('node:fs'); if(fs.readFileSync('node_modules/fixture.txt','utf8')!=='pristine') process.exit(1); fs.writeFileSync('node_modules/fixture.txt','changed');`,
        ],
      },
    ],
  );
  try {
    assert.equal(runner.run(f.initial.head).status, 'passed');
    assert.equal(runner.run(f.initial.head).status, 'passed');
    assert.equal(readFileSync(join(f.root, 'node_modules/fixture.txt'), 'utf8'), 'pristine');
  } finally {
    runner.dispose();
  }
});

test('unavailable exact lockfile dependencies remain inconclusive without installation', async t => {
  const f = await fixture(t, {
    files: { 'package.json': '{}', 'package-lock.json': '{}' },
    script: 'process.exit(0)',
  });
  const a = await f.start();
  await f.save(a, 'a.txt', '1');
  const result = f.integrate();
  assert.equal(result.status, 'inconclusive');
  assert.equal(result.combined.code, 'INTEGRATION_DEPENDENCIES_UNAVAILABLE');
  assert.equal(result.notices.length, 0);
});

test('transitive ordering dependencies and stack parents are checked at their frozen heads', async t => {
  const f = await fixture(t, {
    script: readFlags + 'if(flags[2] && (!flags[0] || !flags[1])) process.exit(1);',
  });
  const a = await f.start(),
    b = await f.start(),
    c = await f.start();
  await f.save(a, 'a.txt', '1');
  await f.save(b, 'b.txt', '1');
  await f.save(c, 'c.txt', '1');
  const savedParent = a.head;
  f.edit(data => {
    data.lanes.find(row => row.id === b.laneId).stack = {
      laneId: a.laneId,
      head: savedParent,
      startHead: savedParent,
      channel: 'main',
    };
    data.lanes.find(row => row.id === c.laneId).after = { intentId: b.intentId };
  });
  await f.save(a, 'a.txt', '0');
  const result = f.integrate({ laneIds: [c.laneId] });
  assert.equal(result.status, 'clean');
  assert.deepEqual(result.dependencies[0].heads, [savedParent, b.head, c.head]);
});

test('a newer checkpoint during execution makes the arriving result historical', async t => {
  const f = await fixture(t);
  const lane = await f.start();
  await f.save(lane, 'a.txt', '1');
  const workflow = resolve('dist/agent-workflow.js');
  await f.define([
    '--input-type=module',
    '-e',
    `
    import {writeFileSync} from 'node:fs';
    const {AgentWorkflow}=await import(${JSON.stringify(workflow)});
    writeFileSync(${JSON.stringify(join(lane.path, 'a.txt'))},'2');
    await new AgentWorkflow(${JSON.stringify(f.root)}).dispatch({action:'checkpoint',laneId:${JSON.stringify(lane.laneId)},message:'Concurrent synthetic save'});
  `,
  ]);
  const result = f.integrate();
  assert.equal(result.status, 'clean');
  assert.equal(result.inputs[0].head, lane.head);
  assert.notEqual(f.store.select('lanes', lane.laneId).head, lane.head);
  assert.equal(result.applicability, 'historical');
});

test('a later observation with unchanged tuple supersedes obsolete external-input advice', async t => {
  const external = join(mkdtempSync(join(tmpdir(), 'forge-preview-advice-')), 'flag');
  t.after(() => rmSync(resolve(external, '..'), { recursive: true, force: true }));
  writeFileSync(external, '1');
  const f = await fixture(t, {
    script:
      readFlags +
      `if(flags[0] && flags[1] && fs.readFileSync(${JSON.stringify(external)},'utf8')==='1') process.exit(1);`,
  });
  const a = await f.start(),
    b = await f.start();
  await f.save(a, 'a.txt', '1');
  await f.save(b, 'b.txt', '1');
  assert.equal(f.integrate().status, 'clash');
  writeFileSync(external, '0');
  assert.equal(f.integrate().status, 'clean');
  assert.ok(
    !agentPeers(f.store, { laneId: a.laneId }).notices?.some(n => /Integration preview/.test(n.text)),
  );
  const context = new CoordinationJournal(f.store).context(a.laneId);
  assert.ok(context.notices.every(n => n.integration.applicability === 'historical'));
  assert.equal(context.messages.filter(m => m.actor === 'Integration preview').length, 0);
});

test('a failed combination with interrupted base control is inconclusive, not baseline-failed', async t => {
  const f = await fixture(t, {
    script: readFlags + `if(flags[0]) process.exit(1); process.kill(process.pid,'SIGTERM');`,
  });
  const a = await f.start();
  await f.save(a, 'a.txt', '1');
  const result = f.integrate();
  assert.equal(result.combined.status, 'failed');
  assert.equal(result.baseline.status, 'inconclusive');
  assert.equal(result.status, 'inconclusive');
  assert.equal(result.notices.length, 0);
});
