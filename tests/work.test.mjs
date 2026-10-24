// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { WorkService } from '../dist/work.js';
import { branchFor, commitTree, workGit } from '../dist/work-git.js';
import { fixture, git, write, code } from './helpers.mjs';
import { serveRepository } from '../dist/http.js';

function setup(t) {
  const root = fixture(t, { 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 1;\n' });
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'Initial source']);
  const work = new WorkService(root);
  const run = command => work.execute(command, work.status().revision).result;
  const intent = run({
    action: 'intent',
    outcome: 'Improve the module',
    constraints: 'Keep exports compatible',
  });
  const lane = name => run({ action: 'lane', intentId: intent.id, name });
  const checkpoint = (id, file, text) => {
    const path = work.store.path(id);
    write(path, file, text);
    git(path, ['add', file]);
    const state = work.status().lanes.find(l => l.id === id);
    return run({
      action: 'checkpoint',
      laneId: id,
      expectedHead: state.actualHead,
      expectedTree: state.indexTree,
      message: `Update ${file}`,
    });
  };
  return { root, work, run, intent, lane, checkpoint };
}

test('Lanes isolate files, preserve original checkout, checkpoint staged files and compose exact heads', t => {
  const { root, work, run, intent, lane, checkpoint } = setup(t);
  const original = git(root, ['rev-parse', 'HEAD']).trim();
  const a = lane('API');
  const b = lane('UI');
  const first = checkpoint(a.id, 'a.ts', 'export const a = 2;\n');
  assert.equal(readFileSync(join(work.store.path(b.id), 'a.ts'), 'utf8'), 'export const a = 1;\n');
  const second = checkpoint(b.id, 'b.ts', 'export const b = 2;\n');
  const review = run({
    action: 'compose',
    intentId: intent.id,
    inputs: [
      { laneId: a.id, head: first.head },
      { laneId: b.id, head: second.head },
    ],
  });
  assert.equal(review.status, 'clean');
  assert.match(review.details, /\+export const a = 2/);
  assert.match(review.details, /\+export const b = 2/);
  assert.equal(git(root, ['rev-parse', 'HEAD']).trim(), original);
  assert.equal(readFileSync(join(root, 'a.ts'), 'utf8'), 'export const a = 1;\n');
  assert.equal(git(root, ['rev-parse', `refs/forge/views/${review.id}`]).trim(), review.head);
  run({ action: 'note', intentId: intent.id, text: 'Keep the small API.', kind: 'decision' });
  assert.equal(work.status().intents[0].notes[0].text, 'Keep the small API.');
});

test('conflicting compositions fail visibly; undo forks the checkpoint parent and preserves dirty work', t => {
  const { root, work, run, intent, lane, checkpoint } = setup(t);
  const a = lane('First approach');
  const b = lane('Second approach');
  const first = checkpoint(a.id, 'a.ts', 'export const a = 2;\n');
  const second = checkpoint(b.id, 'a.ts', 'export const a = 3;\n');
  const review = run({
    action: 'compose',
    intentId: intent.id,
    inputs: [
      { laneId: a.id, head: first.head },
      { laneId: b.id, head: second.head },
    ],
  });
  assert.equal(review.status, 'conflict');
  assert.match(review.details, /CONFLICT/);
  assert.equal(review.head, undefined);
  const path = work.store.path(a.id);
  write(path, 'a.ts', 'unfinished edits');
  const undone = run({ action: 'undo', laneId: a.id, expectedHead: first.head });
  assert.equal(readFileSync(join(work.store.path(undone.id), 'a.ts'), 'utf8'), 'export const a = 1;\n');
  assert.equal(readFileSync(join(path, 'a.ts'), 'utf8'), 'unfinished edits');
  assert.equal(readFileSync(join(root, 'a.ts'), 'utf8'), 'export const a = 1;\n');
});

test('stale metadata, heads and staged trees reject updates without overwriting source', t => {
  const { work, run, lane, checkpoint, intent } = setup(t);
  const before = work.status();
  const a = lane('Only Lane');
  assert.throws(
    () => work.execute({ action: 'intent', outcome: 'Stale' }, before.revision),
    code('WORK_STALE'),
  );
  const path = work.store.path(a.id);
  write(path, 'a.ts', 'export const a = 2;');
  git(path, ['add', 'a.ts']);
  const candidate = work.status().lanes[0];
  write(path, 'a.ts', 'export const a = 3;');
  git(path, ['add', 'a.ts']);
  assert.throws(
    () =>
      run({
        action: 'checkpoint',
        laneId: a.id,
        expectedHead: candidate.actualHead,
        expectedTree: candidate.indexTree,
        message: 'Old candidate',
      }),
    code('LANE_STALE'),
  );
  checkpoint(a.id, 'a.ts', 'export const a = 4;');
  assert.throws(
    () =>
      run({ action: 'compose', intentId: intent.id, inputs: [{ laneId: a.id, head: candidate.actualHead }] }),
    code('LANE_STALE'),
  );
  assert.equal(readFileSync(join(path, 'a.ts'), 'utf8'), 'export const a = 4;');
});

test('checkpoint journal reconciles interruption before and after a ref update exactly once', t => {
  const { work, lane } = setup(t);
  const a = lane('Recovery');
  const path = work.store.path(a.id);
  for (const updateRef of [false, true]) {
    const parent = git(path, ['rev-parse', 'HEAD']).trim();
    write(path, 'a.ts', `export const a = ${updateRef ? 3 : 2};`);
    git(path, ['add', 'a.ts']);
    const tree = git(path, ['write-tree']).trim();
    const head = commitTree(path, tree, [parent], 'Recovered');
    const metadata = work.store.load();
    metadata.lanes[0].pending = { parent, head, message: 'Recovered', at: new Date().toISOString() };
    work.store.save(metadata);
    if (updateRef) workGit(path, ['update-ref', branchFor(a.id), head, parent]);
    const recovered = new WorkService(work.store.root).status();
    assert.equal(recovered.lanes[0].actualHead, head);
    assert.equal(recovered.lanes[0].pending, undefined);
    const again = work.status();
    assert.equal(again.lanes[0].checkpoints.length, updateRef ? 2 : 1);
  }
});

test('work operations disable hooks and reject configured execution drivers', t => {
  const { root, work, lane } = setup(t);
  const marker = join(root, 'executed');
  writeFileSync(join(root, '.git/hooks/post-checkout'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  lane('No hooks');
  assert.equal(existsSync(marker), false);
  git(root, ['config', 'filter.evil.smudge', `touch '${marker}'`]);
  assert.throws(() => work.status(), code('UNSAFE_GIT_CONFIG'));
  assert.equal(existsSync(marker), false);
});

test('dead process locks recover and interrupted Lane creation resumes without duplicating records', t => {
  const { root, work, run, intent } = setup(t);
  const module = new URL('../dist/work-store.js', import.meta.url).href;
  execFileSync(process.execPath, [
    '--input-type=module',
    '-e',
    `import { WorkStore } from ${JSON.stringify(module)}; const store = new WorkStore(process.argv[1]); store.locked(() => process.exit(0));`,
    root,
  ]);
  assert.equal(existsSync(join(work.store.directory, 'lock')), true);
  const state = work.status();
  assert.equal(existsSync(join(work.store.directory, 'lock')), false);
  const id = randomUUID();
  state.lanes.push({
    id,
    intentId: intent.id,
    name: 'Interrupted',
    base: intent.base,
    head: intent.base,
    assignment: '',
    target: '',
    state: 'creating',
    checkpoints: [],
  });
  work.store.save(state);
  const resumed = run({ action: 'resume', laneId: id });
  assert.equal(resumed.state, 'active');
  assert.equal(work.status().lanes.length, 1);
  assert.equal(readFileSync(join(work.store.path(id), 'a.ts'), 'utf8'), 'export const a = 1;\n');
});

test('work HTTP is capability protected, bounds input and rejects stale revisions', async t => {
  const { root } = setup(t);
  const server = await serveRepository(root, 0);
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.port}/api/work`;
  const headers = { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(url)).status, 401);
  const data = await (await fetch(url, { headers })).json();
  const body = JSON.stringify({
    command: { action: 'intent', outcome: 'From HTTP' },
    revision: data.revision,
  });
  assert.equal(
    (await fetch(url, { method: 'POST', headers: { ...headers, Origin: 'https://other.invalid' }, body }))
      .status,
    403,
  );
  assert.equal((await fetch(url, { method: 'POST', headers, body })).status, 200);
  assert.equal((await fetch(url, { method: 'POST', headers, body })).status, 409);
  assert.equal((await fetch(url, { method: 'POST', headers, body: 'x'.repeat(17000) })).status, 400);
  assert.equal((await fetch(url, { method: 'POST', headers, body: 'null' })).status, 400);
});

test('dependency updates create exact new Views, retain decisions and old Views, and expose conflicts without moving inputs', t => {
  const { root, work, run, intent, lane, checkpoint } = setup(t);
  const source = lane('Dependency');
  const first = checkpoint(source.id, 'a.ts', 'export const a = 2;\n');
  const firstView = run({
    action: 'compose',
    intentId: intent.id,
    inputs: [{ laneId: source.id, head: first.head }],
  });
  const target = run({ action: 'intent', outcome: 'Use a pinned dependency' });
  const pin = { kind: 'view', viewId: firstView.id, head: firstView.head };
  const original = run({ action: 'compose', intentId: target.id, inputs: [], dependencies: [pin] });
  run({
    action: 'note',
    intentId: target.id,
    kind: 'decision',
    text: 'Decision for the original candidate.',
  });
  const second = checkpoint(source.id, 'a.ts', 'export const a = 3;\n');
  const secondView = run({
    action: 'compose',
    intentId: intent.id,
    inputs: [{ laneId: source.id, head: second.head }],
  });
  assert.deepEqual(
    work.status().views.find(v => v.id === original.id),
    original,
  );
  assert.equal(run({ action: 'compose', intentId: target.id, inputs: [] }).head, first.head); // Reads/compose never absorb drift.
  const nextPin = { ...pin, viewId: secondView.id, head: secondView.head };
  const updated = run({ action: 'compose', intentId: target.id, inputs: [], dependencies: [nextPin] });
  assert.notEqual(updated.id, original.id);
  assert.equal(updated.head, second.head);
  const competing = run({ action: 'lane', intentId: target.id, name: 'Competing change' });
  const changed = checkpoint(competing.id, 'a.ts', 'export const a = 9;\n');
  const conflict = run({
    action: 'compose',
    intentId: target.id,
    inputs: [{ laneId: competing.id, head: changed.head }],
    dependencies: [nextPin],
  });
  assert.equal(conflict.status, 'conflict');
  assert.match(conflict.details, /CONFLICT/);
  assert.deepEqual(conflict.dependencies, [nextPin]);
  const before = work.status();
  assert.throws(
    () =>
      run({
        action: 'compose',
        intentId: target.id,
        inputs: [],
        dependencies: [{ ...pin, head: second.head }],
      }),
    code('BAD_ARGUMENT'),
  );
  assert.throws(
    () =>
      run({
        action: 'compose',
        intentId: target.id,
        inputs: [],
        dependencies: [{ ...pin, viewId: conflict.id, head: second.head }],
      }),
    code('BAD_ARGUMENT'),
  );
  assert.throws(
    () => run({ action: 'compose', intentId: target.id, inputs: [], dependencies: [] }),
    code('BAD_ARGUMENT'),
  );
  assert.equal(work.status().revision, before.revision);
  assert.equal(
    work.status().intents.find(i => i.id === target.id).notes[0].text,
    'Decision for the original candidate.',
  );
  assert.equal(git(root, ['rev-parse', `refs/forge/views/${original.id}`]).trim(), original.head);
  assert.equal(git(work.store.path(source.id), ['rev-parse', 'HEAD']).trim(), second.head);
  assert.equal(git(root, ['rev-parse', 'HEAD']).trim(), intent.base);
});

test('dependency-only composition retains a newer Intent base and declared pin order', t => {
  const { root, work, run, intent, lane, checkpoint } = setup(t);
  const first = checkpoint(lane('Older dependency').id, 'a.ts', 'export const a = 2;\n');
  const view = run({
    action: 'compose',
    intentId: intent.id,
    inputs: [{ laneId: first.id, head: first.head }],
  });
  write(root, 'b.ts', 'export const b = 3;\n');
  git(root, ['add', 'b.ts']);
  git(root, ['commit', '-qm', 'Newer base']);
  const target = run({ action: 'intent', outcome: 'Compose from newer base' });
  const pin = { kind: 'view', viewId: view.id, head: view.head };
  const combined = run({ action: 'compose', intentId: target.id, inputs: [], dependencies: [pin] });
  assert.match(git(root, ['show', `${combined.head}:b.ts`]), /b = 3/);
  assert.match(git(root, ['show', `${combined.head}:a.ts`]), /a = 2/);
  assert.deepEqual(combined.dependencies, [pin]);
  assert.equal(work.status().intents.at(-1).base, target.base);
});

test('child Lanes pin current or historical committed parent source, preserve dirty work and recover lineage', t => {
  const { root, work, run, lane, checkpoint, intent } = setup(t);
  const parent = checkpoint(lane('Parent').id, 'a.ts', 'export const a = 2;\n');
  const path = work.store.path(parent.id);
  write(path, 'a.ts', 'unfinished parent edits');
  const input = { action: 'child-lane', parentLaneId: parent.id, expectedHead: parent.head, name: 'Child' };
  const child = run(input);
  assert.equal(child.base, parent.head);
  assert.deepEqual(child.parent, { laneId: parent.id, head: parent.head });
  assert.match(readFileSync(join(work.store.path(child.id), 'a.ts'), 'utf8'), /a = 2/);
  const older = run({ ...input, baseHead: parent.base, name: 'Historical child' });
  assert.equal(older.base, parent.base);
  assert.equal(readFileSync(join(path, 'a.ts'), 'utf8'), 'unfinished parent edits');
  assert.equal(git(root, ['rev-parse', 'HEAD']).trim(), intent.base);
  assert.throws(() => run({ ...input, expectedHead: parent.base }), code('LANE_STALE'));
  const other = checkpoint(lane('Unrelated candidate').id, 'b.ts', 'export const b = 4;\n');
  assert.throws(() => run({ ...input, baseHead: other.head }), code('BAD_ARGUMENT'));
  const saved = work.store.load();
  const interrupted = { ...child, id: randomUUID(), state: 'creating' };
  saved.lanes.push(interrupted);
  work.store.save(saved);
  const resumed = run({ action: 'resume', laneId: interrupted.id });
  assert.deepEqual(resumed.parent, child.parent);
  assert.equal(new WorkService(root).status().lanes.find(l => l.id === resumed.id).actualHead, parent.head);
});
