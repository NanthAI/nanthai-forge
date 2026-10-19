// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { initNative } from '../dist/native-work.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { NativeSource } from '../dist/native-source.js';
import { resolveMarkdownText, resolveDocsComposition } from '../dist/native-docs-resolve.js';
import { drainPostAccept } from '../dist/post-accept-main.js';
import { agentSync } from '../dist/agent-sync.js';
import { trustAgents } from './autonomy-fixture.mjs';

// Each fixture selects its own scope, independent of the outer check runner.
for (const name of ['FORGE_CHECK_FULL', 'FORGE_CHECK_SCOPED', 'FORGE_CHECK_INTERACTION'])
  Reflect.deleteProperty(process.env, name);

// Post-accept workers can briefly hold the fixture's Work lock under suite load.
async function retryWorkBusy(run) {
  for (const deadline = Date.now() + 60_000; ;) {
    try {
      return await run();
    } catch (error) {
      if (error?.code !== 'WORK_BUSY' || Date.now() > deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}
// Wait inside each workflow phase so default source pins cannot change on retry.
const dispatch = (agent, command) => agent.dispatch({ ...command, lockWaitMs: 60_000 });

const text = lines => Buffer.from(lines.map(line => `${line}\n`).join(''));
const resolveText = (base, main, lane) =>
  resolveMarkdownText(text(base), text(main), text(lane))?.toString('utf8') ?? null;
const items = Array.from({ length: 12 }, (_, i) => `- item ${i}`);
const insert = (at, ...added) => [...items.slice(0, at), ...added, ...items.slice(at)];

test('Markdown resolution keeps both sides deterministically, main first', () => {
  // Both sides insert at one point: union, main first, no markers.
  const both = resolveText(items, insert(6, '- main a', '- main b'), insert(6, '- lane a'));
  assert.equal(both, text(insert(6, '- main a', '- main b', '- lane a')).toString());
  // Replacement plus an insertion at its boundary keeps both.
  const prose = ['# Title', '', 'Para one.', 'Para two.', ''];
  assert.equal(
    resolveText(
      prose,
      ['# Title', '', 'Para one, edited.', 'Para two.', ''],
      [...prose.slice(0, 3), 'Lane line.', ...prose.slice(3)],
    ),
    text(['# Title', '', 'Para one, edited.', 'Lane line.', 'Para two.', '']).toString(),
  );
  // Overlapping list edits: both new rows survive, removed base rows stay removed.
  const main = items.map(line => (line === '- item 4' ? '- item 4 (main)' : line));
  const lane = items.map(line => (line === '- item 4' ? '- item 4 (lane)' : line));
  const list = resolveText(items, main, lane);
  assert.match(list, /- item 4 \(main\)\n- item 4 \(lane\)\n/);
  assert.doesNotMatch(list, /- item 4\n/);
  const table = ['| a | b |', '| - | - |', '| 1 | 2 |'];
  assert.equal(
    resolveText(table, ['| a | b |', '| - | - |', '| 1 | 3 |'], ['| a | b |', '| - | - |', '| 1 | 4 |']),
    text(['| a | b |', '| - | - |', '| 1 | 3 |', '| 1 | 4 |']).toString(),
  );
  // Identical edits are not duplicated.
  assert.equal(
    resolveText(items, insert(3, '- same'), insert(3, '- same')),
    text(insert(3, '- same')).toString(),
  );
  // Deterministic: same input, same bytes.
  assert.equal(resolveText(items, main, lane), list);
  // Ambiguous: prose modified differently on both sides, or an insertion inside a replaced range.
  assert.equal(
    resolveText(prose, ['# Title', '', 'Main.', 'Para two.', ''], ['# Title', '', 'Lane.', 'Para two.', '']),
    null,
  );
  assert.equal(resolveText(['a', 'b', 'c', 'd'], ['a', 'X', 'Y', 'd'], ['a', 'b', 'lane', 'c', 'd']), null);
  // A side without a final newline never joins two lines.
  assert.equal(
    resolveMarkdownText(Buffer.from('a\n'), Buffer.from('a\nmain'), Buffer.from('a\nlane')).toString(),
    'a\nmain\nlane',
  );
  assert.equal(resolveMarkdownText(Buffer.from('a\n'), Buffer.from([0, 1]), Buffer.from('a\n')), null);
});

async function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-docmerge-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  for (const dir of ['docs', 'src', 'tests']) mkdirSync(join(root, dir));
  writeFileSync(join(root, 'docs/status.md'), text(items));
  writeFileSync(join(root, 'src/left.ts'), 'export const left = 1;\n');
  writeFileSync(join(root, 'src/right.ts'), 'export const right = 1;\n');
  writeFileSync(join(root, 'tests/left.test.mjs'), "import '../dist/left.js';");
  writeFileSync(join(root, 'tests/right.test.mjs'), "import '../dist/right.js';");
  writeFileSync(
    join(root, 'runner.mjs'),
    `
    import { readFileSync, writeFileSync } from 'node:fs';
    import { pinnedComparison, standardSelection } from ${JSON.stringify(pathToFileURL(resolve('scripts/test-impact.mjs')).href)};
    const files = new Map(['src/left.ts', 'src/right.ts', 'tests/left.test.mjs', 'tests/right.test.mjs'].map(path => [path, readFileSync(path, 'utf8')]));
    if (readFileSync('docs/status.md', 'utf8').includes('<<<<<<<')) process.exit(1);
    writeFileSync(process.env.FORGE_CHECK_SELECTION, JSON.stringify(standardSelection({ ...pinnedComparison(), files })));
  `,
  );
  initNative(root);
  trustAgents(root);
  const agent = new AgentWorkflow(root);
  await dispatch(agent, {
    action: 'define-check',
    name: 'verify',
    executable: process.execPath,
    args: ['runner.mjs'],
  });
  const seed = (await dispatch(agent, { action: 'start', outcome: 'seed main' })).result;
  writeFileSync(join(seed.path, 'README.md'), 'seed\n');
  const initial = (
    await dispatch(agent, { action: 'finish', laneId: seed.laneId, message: 'seed', accept: true })
  ).result;
  assert.equal(initial.status, 'accepted');
  const a = (await dispatch(agent, { action: 'start', outcome: 'candidate' })).result;
  const b = (await dispatch(agent, { action: 'start', outcome: 'concurrent main' })).result;
  writeFileSync(join(a.path, 'docs/status.md'), text(insert(6, '- lane capability')));
  writeFileSync(join(b.path, 'docs/status.md'), text(insert(6, '- main capability')));
  return { root, agent, store: agent.work.store, a, b, initial };
}
const scoped = t => {
  const old = process.env.FORGE_CHECK_SCOPED;
  process.env.FORGE_CHECK_SCOPED = '1';
  t.after(() => {
    if (old === undefined) delete process.env.FORGE_CHECK_SCOPED;
    else process.env.FORGE_CHECK_SCOPED = old;
  });
};
const landed = (f, head) =>
  new NativeSource(f.root)
    .object(new NativeSource(f.root).state(head).files.find(file => file.path === 'docs/status.md').blob)
    .toString('utf8');

test('finish lands a docs-only sync conflict with docs scope and replays idempotently', async t => {
  scoped(t);
  const f = await setup(t);
  const main = (
    await dispatch(f.agent, { action: 'finish', laneId: f.b.laneId, message: 'main', accept: true })
  ).result;
  assert.equal(main.status, 'accepted');
  const request = {
    action: 'finish',
    operationId: randomUUID(),
    laneId: f.a.laneId,
    message: 'docs',
    accept: true,
  };
  const receipt = (await dispatch(f.agent, request)).result;
  assert.equal(receipt.status, 'accepted', JSON.stringify(receipt));
  assert.deepEqual(receipt.sync.docsResolution, {
    paths: ['docs/status.md'],
    rule: 'keep both sides, main first',
  });
  assert.match(receipt.sync.message, /resolved Markdown conflicts in docs\/status\.md/);
  assert.match(receipt.sync.undo, /undo-sync/);
  assert.equal(receipt.run.checkSelection.scope, 'docs');
  const bytes = landed(f, receipt.acceptance.head);
  assert.equal(bytes, text(insert(6, '- main capability', '- lane capability')).toString());
  assert.doesNotMatch(bytes, /<<<<<<<|=======|>>>>>>>/);
  const lane = f.store.select('lanes', f.a.laneId, 'id', true);
  assert.equal(lane.pendingMerge, undefined);
  // Finish the independent main audit before counting runs for replay.
  await drainPostAccept(f.store);
  // Same operation: identical terminal receipt, no second sync, check or acceptance.
  const runs = f.store.load().runs.length;
  const replay = (await dispatch(new AgentWorkflow(f.root), { ...request, ...receipt.resolved })).result;
  const { resolved: _resolved, ...withoutResolved } = receipt;
  assert.deepEqual(replay, withoutResolved);
  assert.equal(f.store.load().runs.length, runs);
  // A retried sync operation replays the recorded resolution from Work.
  const checkpoint = f.store
    .load()
    .lanes.find(item => item.id === f.a.laneId)
    .checkpoints.find(cp => cp.sync && cp.automatic);
  assert.match(checkpoint.automatic.summary, /resolved Markdown conflicts/);
  const sync = {
    operationId: receipt.sync.operationId,
    laneId: f.a.laneId,
    expectedHead: checkpoint.parent,
    channel: 'main',
  };
  const again = (
    await retryWorkBusy(() =>
      agentSync(f.store, sync, {
        target: checkpoint.sync.target,
        automaticActor: 'replay',
        identity: { action: 'sync', ...sync, target: checkpoint.sync.target },
        resolveDocs: true,
      }),
    )
  ).result;
  assert.equal(again.head, receipt.sync.head);
  assert.deepEqual(again.docsResolution, receipt.sync.docsResolution);
});

test('interaction retry after a docs conflict re-checks with docs scope and records the resolution', async t => {
  scoped(t);
  const f = await setup(t);
  writeFileSync(join(f.a.path, 'src/left.ts'), 'export const left = 2;\n');
  writeFileSync(join(f.b.path, 'src/right.ts'), 'export const right = 2;\n');
  const original = f.agent.work.dispatch.bind(f.agent.work);
  let advanced = false;
  f.agent.work.dispatch = async (command, ...args) => {
    if (command.action === 'accept-channel' && !advanced) {
      advanced = true;
      const main = (
        await dispatch(f.agent, { action: 'finish', laneId: f.b.laneId, message: 'main', accept: true })
      ).result;
      assert.equal(main.status, 'accepted');
    }
    return original(command, ...args);
  };
  const receipt = (
    await dispatch(f.agent, {
      action: 'finish',
      operationId: randomUUID(),
      laneId: f.a.laneId,
      message: 'c',
      accept: true,
    })
  ).result;
  assert.equal(receipt.status, 'accepted', JSON.stringify(receipt));
  assert.equal(receipt.attempts.length, 2);
  assert.deepEqual(receipt.sync.docsResolution.paths, ['docs/status.md']);
  assert.equal(receipt.run.checkSelection.scope, 'docs', JSON.stringify(receipt.run));
  assert.deepEqual(receipt.run.checkSelection.tests, []);
  assert.match(receipt.run.checkSelection.reason, /^Resolved Markdown-only interaction overlap/);
  assert.equal(receipt.run.interaction.basis, 'docs-overlap');
  assert.match(
    receipt.run.interaction.reason,
    /resolved conflicts in docs\/status\.md \(keep both sides, main first\)/,
  );
  assert.deepEqual(receipt.run.interaction.overlap, ['docs/status.md']);
  const bytes = landed(f, receipt.acceptance.head);
  assert.match(bytes, /- main capability\n- lane capability\n/);
  assert.equal(receipt.acceptance.postAccept.mode, 'full');
  await drainPostAccept(f.store);
});

test('mixed docs and code conflicts keep today’s stop-and-ask behavior', async t => {
  const f = await setup(t);
  writeFileSync(join(f.a.path, 'src/left.ts'), 'export const left = "lane";\n');
  writeFileSync(join(f.b.path, 'src/left.ts'), 'export const left = "main";\n');
  const main = (
    await dispatch(f.agent, { action: 'finish', laneId: f.b.laneId, message: 'main', accept: true })
  ).result;
  assert.equal(main.status, 'accepted');
  const source = new NativeSource(f.root),
    laneHead = (await dispatch(f.agent, { action: 'checkpoint', laneId: f.a.laneId, message: 'both' })).result
      .head;
  assert.equal(
    resolveDocsComposition(source, laneHead, main.acceptance.head, 'probe', new Date().toISOString()),
    null,
  );
  const receipt = (
    await dispatch(f.agent, { action: 'finish', laneId: f.a.laneId, message: 'both', accept: true })
  ).result;
  assert.equal(receipt.status, 'conflict');
  assert.deepEqual(
    receipt.conflicts.map(item => item.path),
    ['docs/status.md', 'src/left.ts'],
  );
  assert.equal(receipt.sync.docsResolution, undefined);
  const docs = readFileSync(join(f.a.path, 'docs/status.md'), 'utf8');
  assert.match(docs, /<<<<<<< lane/);
  assert.match(docs, /- lane capability/);
  assert.match(docs, /- main capability/);
});

test('manual sync keeps markers for docs conflicts', async t => {
  const f = await setup(t);
  await dispatch(f.agent, { action: 'finish', laneId: f.b.laneId, message: 'main', accept: true });
  await dispatch(f.agent, { action: 'checkpoint', laneId: f.a.laneId, message: 'docs' });
  const synced = (await dispatch(f.agent, { action: 'sync', laneId: f.a.laneId })).result;
  assert.equal(synced.status, 'conflict');
  assert.match(readFileSync(join(f.a.path, 'docs/status.md'), 'utf8'), /<<<<<<< lane/);
});
