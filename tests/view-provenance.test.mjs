// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { initNative } from '../dist/native-work.js';
import { assertCurrentWorkFormat } from '../dist/work-format.js';
import { WorkService } from '../dist/work.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { readFileProvenance } from '../dist/view-provenance.js';
import { prepareViewProvenance as prepare } from './view-provenance-fixture.mjs';
import { alignment } from '../dist/view-line-attribution.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-provenance-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, 'a.ts'), 'a\nb\nc\nd\ne\nf\ng\nh\n');
  writeFileSync(join(root, 'private.txt'), 'REPOSITORY_TEXT_MUST_NOT_APPEAR');
  initNative(root);
  return { root, work: new WorkService(root), agent: new AgentWorkflow(root) };
}
test('multi-Lane provenance follows pinned saves, later overrides, independent hunks and supersession', async t => {
  const f = fixture(t),
    p = await prepare(f.root, f.work);
  const read = command => f.agent.dispatch(command).then(response => response.result);
  const detail = await read({ action: 'view', viewId: p.view.id });
  assert.equal(detail.status, 'ready');
  assert.deepEqual(
    detail.inputs.map(i => i.saveIndex),
    [1, 0],
  );
  assert.deepEqual(detail.files.items, [{ path: 'a.ts', status: 'modified', additions: 3, deletions: 3 }]);
  assert.equal((await read({ action: 'view', viewId: p.earlier.id })).status, 'superseded');
  const result = await read({ action: 'provenance', viewId: p.view.id, lines: true, limit: 1 });
  const file = result.files.items[0];
  assert.equal(file.contributors.length, 2);
  assert.deepEqual(
    file.contributors[0].saves.map(s => s.message),
    ['First edit', 'Override first edit'],
  );
  assert.ok(file.contributors[0].saves.every(s => s.actor.kind === 'person'));
  const attributed = f.work.store.load();
  assert.equal(attributed.schema, 24);
  assert.throws(() => assertCurrentWorkFormat({ ...attributed, schema: 11 }), {
    code: 'WORK_UPGRADE_REQUIRED',
  });
  delete attributed.lanes.find(lane => lane.id === p.first.id).checkpoints[0].actor;
  attributed.revision++;
  f.work.store.save(attributed);
  const legacy = await read({ action: 'provenance', viewId: p.view.id });
  assert.equal(legacy.files.items[0].contributors[0].saves[0].actor, null);
  assert.equal(legacy.files.items[0].contributors[0].saves[0].actorSource, 'not-recorded');

  assert.equal(file.why[0].outcome, 'Combine both hunks');
  assert.deepEqual(
    file.why[0].notes.map(n => [n.id, n.excerpt]),
    [[`${p.intent.id}:0`, 'Keep both contributors']],
  );
  assert.equal(file.lines.status, 'available');
  const at = line => file.lines.ranges.find(range => range.startLine <= line && range.endLine >= line);
  assert.deepEqual(at(2).attributions, [{ laneId: p.first.id, saveIndex: 1, head: detail.inputs[0].head }]);
  assert.deepEqual(at(3).attributions, at(2).attributions);
  assert.equal(at(7).attributions[0].laneId, p.second.id);
  assert.equal(at(7).attributions[0].saveIndex, 0);
  assert.equal(at(8).source, 'base');
  assert.ok(!JSON.stringify(result).includes('REPOSITORY_TEXT_MUST_NOT_APPEAR'));
  const old = await read({ action: 'provenance', viewId: p.earlier.id, lines: true });
  assert.deepEqual(
    old.files.items[0].contributors[0].saves.map(s => s.saveIndex),
    [0],
  );
  const data = f.work.store.load();
  data.channelMoves.push({
    id: randomUUID(),
    viewId: p.view.id,
    head: p.view.head,
    channel: 'main',
    previous: null,
    at: '2026-01-01T00:00:00Z',
    status: 'accepted',
    provenance: 'user-declared-local',
    acceptedBy: { kind: 'person', name: 'Synthetic owner' },
  });
  data.revision++;
  f.work.store.save(data);
  const views = await read({ action: 'views', laneId: p.first.id, limit: 1 });
  assert.equal(views.total, 2);
  assert.equal(views.nextOffset, 1);
  assert.equal(views.items[0].status, 'accepted');
  assert.equal(views.items[0].accepted[0].actor.name, 'Synthetic owner');
  assert.equal(views.items[0].accepted[0].at, '2026-01-01T00:00:00Z');
  await assert.rejects(read({ action: 'view', viewId: randomUUID() }), error => error.code === 'NOT_FOUND');
});
test('line attribution aligns insertion/deletion, final newline, repeated lines and bounded files', async () => {
  const diff = alignment(Buffer.from('x\nx\ny\n'), Buffer.from('x\ny\n'));
  assert.equal(
    diff.edits.reduce((n, e) => n + e.end - e.start, 0),
    1,
  );
  assert.equal(alignment(Buffer.from('x'), Buffer.from('x\n')).edits.length, 1);
  const plan = {
    path: 'huge',
    status: 'added',
    before: null,
    after: { blob: 'huge', path: 'huge', mode: 'file' },
    contributors: [],
  };
  const result = await readFileProvenance(
    plan,
    async () => assert.fail('oversized files are not loaded'),
    true,
    () => 2 * 1024 * 1024,
  );
  assert.equal(result.lines.status, 'unavailable');
  assert.match(result.lines.reason, /Too large/);
  const binary = await readFileProvenance(plan, async () => Buffer.from([0, 255]), true);
  assert.equal(binary.lines.status, 'unavailable');
});
test('file pages, dependency provenance, conflicts and no-op saves retain exact lineage', async t => {
  const f = fixture(t),
    p = await prepare(f.root, f.work);
  writeFileSync(join(f.work.store.path(p.first.id), 'z.txt'), 'SECRET_BODY');
  p.checkpoint(p.first, 'a\nB2\nC2\nd\ne\nf\ng\nh\n', 'Add second file');
  const latest = p.act({
    action: 'compose',
    operationId: randomUUID(),
    intentId: p.intent.id,
    inputs: [p.first, p.second].map(lane => ({
      laneId: lane.id,
      head: f.work.store.select('lanes', lane.id).head,
    })),
  });
  const read = command => f.agent.dispatch(command).then(response => response.result);
  const page = await read({ action: 'provenance', viewId: latest.id, limit: 1 });
  assert.equal(page.files.total, 2);
  assert.equal(page.files.nextOffset, 1);
  const next = await read({
    action: 'provenance',
    viewId: latest.id,
    offset: page.files.nextOffset,
    limit: 1,
  });
  assert.equal(next.files.items[0].path, 'z.txt');
  assert.equal(next.files.nextOffset, null);
  assert.equal(next.files.items[0].contributors[0].saves.length, 1);
  assert.ok(!JSON.stringify(next).includes('SECRET_BODY'));
  const intent = p.act({ action: 'intent', outcome: 'Depend on the composed work' });
  const dependency = p.act({
    action: 'compose',
    operationId: randomUUID(),
    intentId: intent.id,
    inputs: [],
    dependencies: [{ kind: 'view', viewId: latest.id, head: latest.head }],
  });
  const derived = await read({ action: 'provenance', viewId: dependency.id, lines: true });
  assert.equal(derived.files.items[0].contributors.length, 2);
  assert.equal(derived.files.items[0].why[0].outcome, intent.outcome);
  assert.equal(derived.files.items[0].why[1].outcome, p.intent.outcome);
  p.checkpoint(p.second, 'a\nconflicts\nc\nd\ne\nf\nG7\nh\n', 'Conflict with sibling');
  const conflict = p.act({
    action: 'compose',
    operationId: randomUUID(),
    intentId: p.intent.id,
    inputs: [p.first, p.second].map(lane => ({
      laneId: lane.id,
      head: f.work.store.select('lanes', lane.id).head,
    })),
  });
  assert.equal((await read({ action: 'view', viewId: conflict.id })).status, 'conflict');
  const { saveChain } = await import('../dist/view-read-model.js');
  const lane = {
    checkpoints: [
      { head: 'one', parent: 'base', at: '1' },
      { head: 'two', parent: 'one', at: '2' },
      { head: 'two', parent: 'two', at: '4' },
    ],
  };
  assert.deepEqual(
    saveChain(lane, 'two', 'base').map(s => s.saveIndex),
    [0, 1, 2],
  );
  assert.deepEqual(
    saveChain(lane, 'two', 'base', '3').map(s => s.saveIndex),
    [0, 1],
  );
});

test('successive insertion and deletion diffs preserve surviving attribution', async () => {
  const { advanceAttribution, attributionRanges } = await import('../dist/view-line-attribution.js');
  const first = { laneId: 'lane', saveIndex: 0, head: 'first' },
    second = { laneId: 'lane', saveIndex: 1, head: 'second' };
  const initial = Buffer.from('a\nb\nc\n'),
    saved = Buffer.from('a\nx\nb\nc\n'),
    final = Buffer.from('x\nb\nZ\n');
  const one = advanceAttribution(initial, saved, [null, null, null], first);
  assert.deepEqual(one, [null, first, null, null]);
  const two = advanceAttribution(saved, final, one, second);
  assert.deepEqual(two, [first, null, second]);
  assert.deepEqual(
    attributionRanges(
      two.map(tag => (tag ? [tag] : [])),
      [false, true, false],
    ).map(range => range.source),
    ['save', 'base', 'save'],
  );
});
