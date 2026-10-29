// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mergeNativeText, markNativeTextConflicts } from '../dist/native-text-merge.js';
import { NativeSource } from '../dist/native-source.js';
import { initNative } from '../dist/native-work.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { agentSync, conflictPlan } from '../dist/agent-sync.js';

const bytes = text => Buffer.from(text);
const base = "import test from 'node:test';\nimport assert from 'node:assert/strict';\n";
const main = "\ntest('main addition', () => {\n  assert.equal(2 + 2, 4);\n});\n";
const lane = "\ntest('lane addition', () => {\n  assert.equal(3 + 3, 6);\n});\n";
const merge = (original, left, right, options) =>
  mergeNativeText(bytes(original), bytes(left), bytes(right), 'file.mjs', options);

test('EOF test-block additions merge main first, record the hunk and parse as JavaScript', () => {
  const resolutions = [];
  const result = merge(base, base + main, base + lane, { resolutions });
  assert.equal(result?.toString(), base + main + lane);
  assert.deepEqual(resolutions, [{ baseLine: 3, resolved: 'both-insertions' }]);
  const checked = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: result });
  assert.equal(checked.status, 0, checked.stderr?.toString());
});

test('same-anchor middle insertions retain complete blocks and surrounding base bytes', () => {
  const end = 'export const end = true;\n';
  assert.equal(merge(base + end, base + main + end, base + lane + end)?.toString(), base + main + lane + end);
});

for (const [name, other] of [
  ['modify', 'changed\nend\n'],
  ['delete', 'end\n'],
]) {
  test(`insertion versus base-line ${name} remains a conflict in either orientation`, () => {
    const original = 'anchor\nend\n',
      added = 'new\n' + original;
    for (const [left, right] of [
      [added, other],
      [other, added],
    ]) {
      assert.equal(merge(original, left, right), null);
      assert.equal(
        markNativeTextConflicts(bytes(original), bytes(left), bytes(right), ['main', 'lane']).conflicted,
        true,
      );
    }
  });
}

test('identical insertions use deduplication and do not claim a both-insertions resolution', () => {
  const resolutions = [];
  assert.equal(merge(base, base + main, base + main, { resolutions })?.toString(), base + main);
  assert.deepEqual(resolutions, []);
});

test('partial copies and textually overlapping additions remain conflicts', () => {
  for (const [left, right] of [
    ['one\n', 'one\ntwo\n'],
    ['two\n', 'one\ntwo\n'],
    ['one\nshared\n', 'shared\ntwo\n'],
    ['one\n🔥\n', '🔥\ntwo\n'],
    ['prefix\nshared\nsuffix\n', 'other\nshared\nlast\n'],
  ]) {
    for (const [a, b] of [
      [left, right],
      [right, left],
    ]) {
      assert.equal(merge(base, base + a, base + b), null);
      assert.equal(
        markNativeTextConflicts(bytes(base), bytes(base + a), bytes(base + b), ['main', 'lane']).conflicted,
        true,
      );
    }
  }
});

test('fragmentary additions cannot join lines, and CRLF insertions retain exact bytes', () => {
  assert.equal(merge(base, base + 'main', base + 'lane\n'), null);
  assert.equal(merge(base, base + 'main\n', base + 'lane'), null);
  const crlf = text => text.replaceAll('\n', '\r\n');
  assert.equal(merge(crlf(base), crlf(base + main), crlf(base + lane))?.toString(), crlf(base + main + lane));
});

test('conflict markers retain auto-resolved insertion hunks alongside a real modification conflict', () => {
  const original = 'anchor\nunchanged\nlast\n';
  const left = 'main\nanchor\nunchanged\nLEFT\n';
  const right = 'lane\nanchor\nunchanged\nRIGHT\n';
  const result = markNativeTextConflicts(bytes(original), bytes(left), bytes(right), ['main', 'lane']);
  assert.equal(result.conflicted, true);
  assert.equal(
    result.bytes.toString(),
    'main\nlane\nanchor\nunchanged\n<<<<<<< main\nLEFT\n=======\nRIGHT\n>>>>>>> lane\n',
  );
  assert.deepEqual(result.resolutions, [{ baseLine: 1, resolved: 'both-insertions' }]);
});

function fixture(t, withDocs = false) {
  const root = mkdtempSync(join(tmpdir(), 'forge-insertion-merge-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, 'file.mjs'), base);
  if (withDocs) writeFileSync(join(root, 'README.md'), '- base capability\n');
  const origin = initNative(root).head,
    source = new NativeSource(root);
  const state = (text, message, doc = '- base capability\n') =>
    source.writeState(
      [
        { path: 'file.mjs', mode: 'file', blob: source.put(bytes(text)) },
        ...(withDocs ? [{ path: 'README.md', mode: 'file', blob: source.put(bytes(doc)) }] : []),
      ],
      [origin],
      message,
      'now',
    );
  return { root, origin, source, state };
}

test('native composition reports and retains resolution provenance with original parent States', t => {
  const { source, state } = fixture(t);
  const mainHead = state(base + main, 'main'),
    laneHead = state(base + lane, 'lane');
  const result = source.compose(mainHead, laneHead, 'Combine', 'now');
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.resolutions, [{ path: 'file.mjs', baseLine: 3, resolved: 'both-insertions' }]);
  const merged = source.state(result.head);
  assert.equal(source.object(merged.files[0].blob).toString(), base + main + lane);
  assert.deepEqual(merged.parents, [mainHead, laneHead]);
  assert.match(merged.message, /both-insertions.*file\.mjs:3/);
  assert.deepEqual(source.compose(mainHead, laneHead, 'Combine', 'now'), result);
  assert.equal(source.object(source.state(mainHead).files[0].blob).toString(), base + main);
  assert.equal(source.object(source.state(laneHead).files[0].blob).toString(), base + lane);
});

test('Lane sync orders main before Lane and replays the same resolution receipt', async t => {
  const { root, source, state } = fixture(t);
  const agent = new AgentWorkflow(root);
  const started = (await agent.dispatch({ action: 'start', outcome: 'Append a test' })).result;
  writeFileSync(join(started.path, 'file.mjs'), base + lane);
  const checkpoint = (
    await agent.dispatch({ action: 'checkpoint', laneId: started.laneId, message: 'Lane test' })
  ).result;
  const target = state(base + main, 'main');
  const command = {
    operationId: randomUUID(),
    laneId: started.laneId,
    expectedHead: checkpoint.head,
    channel: 'main',
  };
  const result = agentSync(agent.work.store, command, { target }).result;
  assert.equal(result.status, 'merged');
  assert.equal(readFileSync(join(started.path, 'file.mjs'), 'utf8'), base + main + lane);
  assert.deepEqual(result.resolutions, [{ path: 'file.mjs', baseLine: 3, resolved: 'both-insertions' }]);
  assert.deepEqual(agentSync(agent.work.store, command, { target }).result, result);
  assert.match(source.state(result.head).message, /both-insertions/);
  assert.deepEqual(conflictPlan(source, checkpoint.head, target, 'main').conflicts, []);
});

test('a later unresolved hunk prevents publication of speculative resolution notes', () => {
  const resolutions = [];
  assert.equal(
    merge('anchor\nlast\n', 'main\nanchor\nLEFT\n', 'lane\nanchor\nRIGHT\n', { resolutions }),
    null,
  );
  assert.deepEqual(resolutions, []);
});

test('Markdown conflict resolution preserves main-first code insertions and their receipt', async t => {
  const { root, source, state } = fixture(t, true);
  const agent = new AgentWorkflow(root);
  const started = (await agent.dispatch({ action: 'start', outcome: 'Code and docs' })).result;
  writeFileSync(join(started.path, 'file.mjs'), base + lane);
  writeFileSync(join(started.path, 'README.md'), '- lane capability\n');
  const checkpoint = (
    await agent.dispatch({ action: 'checkpoint', laneId: started.laneId, message: 'Lane edits' })
  ).result;
  const target = state(base + main, 'main', '- main capability\n');
  const command = {
    operationId: randomUUID(),
    laneId: started.laneId,
    expectedHead: checkpoint.head,
    channel: 'main',
  };
  const result = agentSync(agent.work.store, command, {
    target,
    resolveDocs: true,
    automaticActor: 'synthetic',
  }).result;
  assert.equal(result.status, 'merged');
  assert.equal(readFileSync(join(started.path, 'file.mjs'), 'utf8'), base + main + lane);
  assert.equal(
    readFileSync(join(started.path, 'README.md'), 'utf8'),
    '- main capability\n- lane capability\n',
  );
  assert.deepEqual(result.docsResolution.paths, ['README.md']);
  assert.deepEqual(result.resolutions, [{ path: 'file.mjs', baseLine: 3, resolved: 'both-insertions' }]);
  assert.deepEqual(
    agentSync(agent.work.store, command, { target, resolveDocs: true, automaticActor: 'synthetic' }).result,
    result,
  );
  assert.match(source.state(result.head).message, /both-insertions/);
});
