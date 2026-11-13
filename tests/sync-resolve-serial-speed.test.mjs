// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName, makeFunctionReference } from 'convex/server';
import { sourceActionProcess } from './source-action-process.mjs';
import { MemoryMergeSource, MemorySourceReader } from '../dist/hosted-source-memory.js';
import { buildHostedSyncState } from '../dist/hosted-sync-worker.js';
import { buildSavePages, saveBytes, savePin } from '../dist/hosted-save.js';
import { syncFixture, records } from './hosted-sync-fixture.mjs';
import { controls, environment } from './hosted-source-efficiency-fixture.mjs';
import speedBudgets from '../src/speed-budgets.json' with { type: 'json' };

const budget = id => speedBudgets.budgets.find(value => value.id === id).max;
const path = i => `src/deep/shared/components/features/generated/module-${String(i).padStart(6, '0')}.txt`;
function stateBytes(s, id) {
  const raw = s.objects.get(id);
  if (raw) return raw;
  const row = [...s.tables.projectObjects.values()].find(row => row.digest === id);
  assert(row?.recipeClosure, 'published State has exact trusted leaf pins');
  return Buffer.concat(
    row.recipeClosure.map(leaf => {
      const bytes = s.objects.get(leaf.pack?.digest ?? leaf.sha256);
      return leaf.pack ? bytes.subarray(leaf.pack.offset, leaf.pack.offset + leaf.size) : bytes;
    }),
  );
}
async function laneHead(f) {
  const row = await f.s.run('read-kept-source', ctx =>
    records.readHostedRecord(ctx, { ...f.s.auth, kind: 'lane', key: f.entry.laneId }),
  );
  return JSON.parse(row.value).head;
}
const at = '2026-01-01T00:00:00.000Z';

test('29k conflict drafting reuses one metadata merge per immutable calculation round', async t => {
  const source = new MemoryMergeSource({}),
    original = source.put(Buffer.from('first\nbase\nlast\n')),
    files = Array.from({ length: 29000 }, (_, i) => ({ path: path(i), mode: 'file', blob: original })),
    base = source.writeState(files, [], 'base', at),
    changed = text => [{ ...files[0], blob: source.put(Buffer.from(text)) }, ...files.slice(1)],
    left = source.writeState(changed('first\nleft\nlast\n'), [base], 'left', at),
    right = source.writeState(changed('first\nright\nlast\n'), [base], 'right', at),
    ref = id => ({ object: { sha256: id, size: source.object(id).length }, recipe: null });
  source.generated.clear();
  let merges = 0;
  source.mergeContent = () => {
    merges++;
    return null;
  };
  const reader = new MemorySourceReader(source, {
    read: async () => assert.fail('all exact inputs are resident'),
    upload: async () => {},
  });
  const plan = {
    schema: 1,
    kind: 'forge-hosted-sync-input',
    algorithm: 'forge-native-sync-v1',
    work: { mode: 'sync', left: ref(left), right: ref(right) },
    message: 'sync',
    at,
  };
  const result = await buildHostedSyncState(savePin(plan), plan, reader, source, async () => {});
  assert.equal(JSON.parse(source.object(result.output.sha256)).result.status, 'conflict');
  t.diagnostic(JSON.stringify({ files: files.length, metadataMerges: merges, state: result.head }));
  assert(merges <= budget('source-sync-metadata-merges'));
  const draft = source.verifiedState(result.head);
  assert.equal(draft.files.length, files.length);
  assert.match(source.object(draft.files[0].blob).toString(), /<<<<<<< lane/);
  // A later inline calculation can change an answer for the same exact tips.
  source.resetGenerated();
  source.mergeContent = () => original;
  const next = source.compose(left, right, 'next round', at, { insertionOrder: 'right-first' });
  assert(next.head, 'a prior conflict must not survive a new calculation round');
});

async function recovery(t, { files = 29000, text = 'first\nresolved\nlast\n' } = {}) {
  environment(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(at) });
  const s = await syncFixture({
      baselineFiles: Array.from({ length: files - 2 }, (_, i) => [path(i), 'unchanged\n']),
    }),
    baseline = JSON.parse(s.objects.get(s.baseline.sha256)).files,
    replace = text => baseline.map(file => (file.path === 'a.txt' ? s.file('a.txt', text) : file)),
    left = await s.lane(s.state(replace('first\nleft\nlast\n'), [s.baseline.sha256])),
    right = s.state(replace('first\nright\nlast\n'), [s.baseline.sha256]);
  s.moveMain(right.sha256, 'right');
  const request = s.request('sync', {
      laneId: left.laneId,
      expected: s.pins(left),
      target: { kind: 'main', head: right.sha256, receiptId: 'right' },
    }),
    conflict = (await s.execute(request)).terminal.outcome.result,
    entry = (await s.readLane(conflict.lane.laneId)).entry,
    draft = JSON.parse(s.objects.get(entry.head)),
    before = draft.files.find(file => file.path === 'a.txt'),
    chosen = s.put(text),
    pages = buildSavePages([
      {
        path: before.path,
        before: { blob: before.blob, mode: before.mode },
        after: { blob: chosen.sha256, mode: 'file', content: { object: chosen, recipe: null } },
      },
    ]),
    operationId = randomUUID(),
    then = {
      kind: 'resolve',
      operationId: randomUUID(),
      authorityEpoch: 1,
      lifecycleVersion: entry.lifecycleVersion,
      message: 'resolved',
    },
    c = controls(t, s);
  for (const id of [s.baseline.sha256, left.head, right.sha256, entry.head]) {
    const row = [...s.tables.projectObjects.values()].find(row => row.digest === id),
      state = JSON.parse(s.objects.get(id));
    s.patch('projectObjects', row._id, {
      stateParents: state.parents,
      stateSize: { fileCount: state.files.length, manifestBytes: row.size },
    });
  }
  const prepared = JSON.parse(
    await c.call('projectHostedSaves:prepare', {
      projectId: s.projectId,
      request: JSON.stringify({
        operationId,
        laneId: entry.laneId,
        authorityEpoch: 1,
        expected: s.pins(entry),
        message: 'save',
        pages: pages.root,
        pageCount: pages.pages.length,
        changeCount: 1,
        then,
      }),
    }),
  );
  for (const [index, page] of pages.pages.entries()) {
    s.put(saveBytes(page.value));
    await c.call('projectHostedSaves:stage', {
      projectId: s.projectId,
      operationId,
      index,
      page: JSON.stringify(page.value),
    });
  }
  const progress = JSON.parse(
    await c.call('projectHostedSaves:progress', { projectId: s.projectId, operationId }),
  );
  s.put(saveBytes(progress.input));
  const start = {
      calls: c.calls.length,
      gets: c.r2Gets.length,
      puts: c.r2Puts.length,
      counts: s.counts.length,
      readBytes: c.r2ReadBytes(),
      putBytes: c.r2PutBytes(),
      heads: c.r2Heads(),
    },
    submit = {
      projectId: s.projectId,
      operationId,
      kind: 'save',
      progress: true,
      input: Buffer.from(saveBytes(progress.input)).toString(),
    };
  return { s, c, start, submit, then, entry, draft, prepared };
}

function isolatedActions(t, f, beforeMutation = async () => {}) {
  const actions = [],
    runAction = f.c.context.runAction;
  f.c.context.runAction = async (ref, args) => {
    const name = getFunctionName(ref);
    f.c.calls.push(name);
    const result = await sourceActionProcess(
      name,
      args,
      async (name, args) => {
        await beforeMutation(name, args);
        return f.c.call(name, args);
      },
      name => f.c.calls.push(name),
    );
    actions.push(result.metrics);
    return result.value;
  };
  t.after(() => {
    f.c.context.runAction = runAction;
  });
  return actions;
}

test('29k Node save resolves in its own action without reading the saved and draft States again', async t => {
  const f = await recovery(t),
    actions = isolatedActions(t, f);
  const reply = JSON.parse(await f.c.call('projectSourceRun:submit', f.submit));
  assert.equal(reply.terminal.outcome.status, 'completed');
  // Execute the existing scheduled fallback explicitly on the baseline. The
  // candidate must return this same resolution without needing that fallback.
  if (!reply.chain) {
    await f.c.call('projectHostedResolveChain:run', {
      projectId: f.s.projectId,
      actor: 'owner',
      operationId: f.submit.operationId,
    });
    const chain = JSON.parse(
      await f.c.call('projectHostedSync:progress', {
        projectId: f.s.projectId,
        operationId: f.then.operationId,
      }),
    );
    reply.chain = { terminal: chain.terminal, state: chain.state };
  }
  assert.equal(reply.chain?.terminal?.outcome?.result?.status, 'resolved');
  assert.equal(reply.chainResult, undefined, 'private chain evidence stays server-side');
  const saved = reply.terminal.outcome.result,
    result = reply.chain.terminal.outcome.result,
    state = JSON.parse(stateBytes(f.s, result.lane.head));
  assert.deepEqual(state.parents, [saved.head, result.resolution.right]);
  assert.equal(state.files.length, 29000);
  const reads = f.c.r2Gets.slice(f.start.gets),
    calls = f.c.calls.slice(f.start.calls),
    savedGets = reads.filter(id => id === saved.head).length,
    draftGets = reads.filter(id => id === f.entry.head).length;
  const counts = f.s.counts.slice(f.start.counts);
  t.diagnostic(
    JSON.stringify({
      files: state.files.length,
      savedState: saved.head,
      resolvedState: result.lane.head,
      actionMetrics: actions,
      savedGets,
      draftGets,
      calls: calls.length,
      reads: reads.length,
      readBytes: f.c.r2ReadBytes() - f.start.readBytes,
      puts: f.c.r2Puts.length - f.start.puts,
      putBytes: f.c.r2PutBytes() - f.start.putBytes,
      heads: f.c.r2Heads() - f.start.heads,
      dbReadBytes: counts.reduce((n, row) => n + row.readBytes, 0),
      dbWriteBytes: counts.reduce((n, row) => n + row.writeBytes, 0),
      peakMiB: Math.ceil(Math.max(...actions.map(action => action.maxRssBytes)) / 1024 / 1024),
    }),
  );
  assert(
    f.c.r2ReadBytes() - f.start.readBytes <=
      f.s.objects.get(f.entry.head).length + budget('source-chain-extra-read-bytes'),
  );
  assert.equal(draftGets, 1, 'save reads the draft once; resolve reuses its verified parsed input');
  assert(
    calls.filter(name => name === 'projectConvexSourceNode:step').length <=
      budget('source-chain-node-actions'),
  );
  assert(!calls.includes('projectHostedResolveChain:run'), 'no scheduled chain is needed');
  assert(calls.length <= budget('source-chain-control-calls'));
  assert(f.c.r2Puts.length - f.start.puts <= 12);
  assert(f.c.r2PutBytes() - f.start.putBytes <= budget('source-recovery-output-bytes'));
  assert(counts.reduce((n, row) => n + row.readBytes + row.writeBytes, 0) < 320 * 1024);
  assert(Math.max(...actions.map(action => action.maxRssBytes)) <= 512 * 1024 * 1024);
  const jobs = f.s.tables.projectSourceSteps.size,
    puts = f.c.r2Puts.length,
    gets = f.c.r2Gets.length;
  const replay = JSON.parse(await f.c.call('projectSourceRun:submit', f.submit));
  assert.equal((replay.terminal ?? replay).outcome.status, 'completed');
  assert.equal(f.s.tables.projectSourceSteps.size, jobs, 'unknown-outcome replay creates no second job');
  assert.equal(f.c.r2Puts.length, puts);
  assert.equal(f.c.r2Gets.length, gets);
});

test('a Node save keeps its saved work when current authority changes before its cached resolve begins', async t => {
  const f = await recovery(t);
  isolatedActions(t, f, async name => {
    if (name === 'projectHostedResolveChainStore:prepare')
      f.s.patch('hostedProjects', f.s.projectId, { sourceAuthority: { mode: 'server', epoch: 2 } });
  });
  const before = f.s.tables.projectSourceSteps.size,
    reply = JSON.parse(await f.c.call('projectSourceRun:submit', f.submit));
  assert.equal(reply.terminal.outcome.status, 'completed');
  assert.equal(reply.chain?.status, 'submitted');
  assert.equal(
    f.s.tables.projectSourceSteps.size,
    before + 1,
    'no resolve job crosses the changed authority fence',
  );
  f.s.auth.authorityEpoch = 2;
  assert.equal(await laneHead(f), reply.terminal.outcome.result.head);
});

test('cached save inputs never bypass the resolved-content marker check', async t => {
  const f = await recovery(t, { text: '<<<<<<< lane\nleft\n=======\nright\n>>>>>>> target\n' });
  isolatedActions(t, f);
  const reply = JSON.parse(await f.c.call('projectSourceRun:submit', f.submit));
  const row = [...f.s.tables.projectHostedSyncs.values()].find(row => row.operationId === f.then.operationId);
  await f.c.call('projectHostedSyncJobs:complete', { projectId: f.s.projectId, jobId: row.jobId });
  const progress = JSON.parse(
    await f.c.call('projectHostedSync:progress', {
      projectId: f.s.projectId,
      operationId: f.then.operationId,
    }),
  );
  assert.equal(reply.terminal.outcome.status, 'completed');
  assert.equal(progress.terminal.outcome.status, 'failed');
  assert.equal(progress.terminal.outcome.error.code, 'CONFLICT_MARKERS');
  assert.equal(await laneHead(f), reply.terminal.outcome.result.head);
});

test('a save beyond the retained-input routing band keeps the independent resolve with the same source capability', async t => {
  const f = await recovery(t, { files: 51300 }),
    actions = isolatedActions(t, f),
    reply = JSON.parse(await f.c.call('projectSourceRun:submit', f.submit));
  let terminal = reply.chain?.terminal;
  if (!terminal) {
    const sync = [...f.s.tables.projectHostedSyncs.values()].find(
        row => row.operationId === f.then.operationId,
      ),
      step = [...f.s.tables.projectSourceSteps.values()].find(row => row.jobId === sync.jobId);
    const resumed = JSON.parse(
      await f.c.context.runAction(makeFunctionReference('projectConvexSourceNode:step'), {
        projectId: f.s.projectId,
        jobId: sync.jobId,
        step: step.step,
        generation: step.generation ?? 0,
      }),
    );
    terminal = resumed.terminal;
  }
  assert.equal(terminal.outcome.result.status, 'resolved');
  const result = terminal.outcome.result;
  assert.equal(JSON.parse(stateBytes(f.s, result.lane.head)).files.length, 51300);
  assert(actions.length >= 2, 'larger saves release the first heap before their independent resolve');
  assert(Math.max(...actions.map(action => action.maxRssBytes)) <= 512 * 1024 * 1024);
});
