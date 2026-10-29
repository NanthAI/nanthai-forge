// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getFunctionName } from 'convex/server';
import { ConvexError } from 'convex/values';
import {
  fixture,
  checkpoint,
  preparedCheckpoint,
  modules,
  seedRecordCheckpoint,
  commitValidatedCheckpoint,
} from './project-exchange-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { land } from './source-landings-fixture.mjs';
import { workBytes } from '../dist/work-metadata.js';
import { sourceReturnChunks, validateSourceReturnChunk } from '../dist/work-source-return-chunks.js';
import { validateSourceReturn } from '../dist/work-source-return.js';
import { immutableDirectory } from './helpers/immutable-directory.mjs';
import { hostedSnapshot, restoreHosted } from './helpers/hosted-snapshot.mjs';
import { WorkStore } from '../dist/work-store.js';
import { initNative } from '../dist/native-work.js';
const index = await import(moduleUrl('../convex/projectWorkIndexActions.ts'));
const prepare = await import(moduleUrl('../convex/projectSourceReturnPrepare.ts'));
const code = expected => e => e.data?.code === expected || e.code === expected;
const snapshots = new Map();
const privateInput = immutableDirectory('forge-return-prepare-', async (root, records) => {
  const s = fixture();
  writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
  initNative(root);
  const first = await preparedCheckpoint(s, new WorkStore(root));
  land(first.store, 6);
  const data = first.store.load();
  // Independent records make retained Work large without a giant indivisible record.
  for (let i = 0; i < 300; i++)
    data.intents.push({
      id: randomUUID(),
      base: data.nativeHead,
      outcome: 'Synthetic retained work',
      constraints: '',
      status: 'completed',
      createdAt: 'now',
      notes: Array.from({ length: 15 }, () => ({ kind: 'comment', text: 'x'.repeat(4000), at: 'now' })),
    });
  data.revision++;
  first.store.save(data);
  const baseline = await preparedCheckpoint(s, first.store, 0, undefined, { records });
  const backupId = records
    ? await seedRecordCheckpoint(s, baseline)
    : await modules.projectExchangeActions.publish._handler(s.ctx, baseline.input);
  if (records) s.tables.projectBackups.get(backupId).ownerDerived = baseline.input.ownerDerived;
  await modules.projectWorkActions.initialize._handler(s.ctx, {
    projectId: 'project',
    backupId,
    operationId: randomUUID(),
  });
  await index.ensure._handler(s.ctx, { projectId: 'project' });
  const command = await modules.projectWorkActions.command._handler(s.ctx, {
    projectId: 'project',
    revision: data.revision,
    operationId: randomUUID(),
    command: JSON.stringify({
      action: 'note',
      intentId: data.intents[0].id,
      kind: 'comment',
      text: 'Hosted reconciliation',
    }),
  });
  // The real journal reader/reducer advances Work before the next checkpoint.
  const reconciled = await modules.projectWorkActions.load(s.ctx, 'project', 'owner');
  first.store.save(reconciled.data);
  land(first.store, 20);
  const changed = first.store.load();
  for (const intent of changed.intents.slice(6, 306))
    intent.notes.push({ kind: 'comment', text: 'Local landing observation', at: 'later' });
  first.store.save(changed);
  const candidate = await preparedCheckpoint(s, first.store, 0, undefined, {
    records,
    baseline: JSON.parse(
      readFileSync(join(first.store.directory, `exchange-${baseline.input.operationId}`, 'work.json')),
    ),
    journalRevision: command.revision,
  });
  candidate.input.previous = backupId;
  const candidateId = records
    ? await commitValidatedCheckpoint(s, candidate)
    : await modules.projectExchangeActions.publish._handler(s.ctx, candidate.input);
  snapshots.set(records, await hostedSnapshot(s));
  return {
    // Tests inspect the candidate's layout and journal delta, not its cached
    // WorkStore or the other immutable upload bodies.
    candidate: {
      tree: {
        root: candidate.tree.root,
        objects: new Map(
          [...candidate.tree.objects].filter(([hash]) => hash === candidate.tree.root.delta?.sha256),
        ),
      },
    },
    input: {
      projectId: 'project',
      backupId: candidateId,
      expectedBackupId: backupId,
      revision: command.revision,
      operationId: randomUUID(),
      continuation: true,
    },
  };
});

async function setup(t, records = true) {
  const { root, value } = await privateInput(records);
  value.input.operationId = randomUUID();
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return {
    ...value,
    s: await restoreHosted(fixture(), snapshots.get(records)),
    first: { store: new WorkStore(root) },
  };
}

for (const records of [true, false])
  test(`large ${records ? 'unvalidated record (after explicit validated refusal)' : 'legacy'} context prepares durably, with lost replies and cold resume`, async t => {
    const f = await setup(t, records),
      { s, input } = f;
    if (records) {
      const parsedDelta = JSON.parse(f.candidate.tree.objects.get(f.candidate.tree.root.delta.sha256));
      assert.equal(
        parsedDelta.base.journalRevision,
        input.revision,
        'client retains advanced hosted revision',
      );
      const pages = s.tables.projectReturnPages.size;
      await assert.rejects(
        modules.projectSourceReturn.returnSource._handler(s.ctx, input),
        error =>
          error.data?.code === 'WORK_RETURN_DELTA_UNAVAILABLE' &&
          /context-over-budget/.test(error.data.message),
      );
      assert.equal(s.tables.projectReturnPages.size, pages, 'validated records never enter full preparation');
      // An unmarked historical catalog still needs the existing compatibility path.
      s.tables.projectBackups.get(input.backupId).validatedWorkRecords = undefined;
    } else assert.equal(f.candidate.tree.root.schema, 1);
    // Compatibility preparation must be durable regardless of the record gate.
    const saved = prepare.PREPARE_BUDGET.chunks;
    prepare.PREPARE_BUDGET.chunks = 2;
    t.after(() => {
      prepare.PREPARE_BUDGET.chunks = saved;
    });
    let invocation = 0,
      lose = true;
    let cold = () => {};
    const workReads = new Map();
    const loadedByAction = new Map(),
      query = s.ctx.runQuery,
      mutate = s.ctx.runMutation;
    s.ctx.runQuery = (ref, args) => {
      if (getFunctionName(ref) === 'projectWork:events') {
        loadedByAction.set(invocation, (loadedByAction.get(invocation) ?? 0) + 1);
      }
      return query(ref, args);
    };
    s.ctx.runMutation = async (ref, args) => {
      const result = await mutate(ref, args);
      if (lose && getFunctionName(ref) === 'projectReturnIndexStage:prepare') {
        lose = false;
        throw new ConvexError({ code: 'HOSTED_ACTION_FAILED', message: 'lost prepare commit reply' });
      }
      return result;
    };
    const logs = [];
    t.mock.method(console, 'log', (...args) => {
      logs.push(args);
      const reads = workReads.get(invocation) ?? new Set();
      if (args[0] === 'source-return prepare load done') reads.add('previous');
      if (args[0] === 'source-return prepare source done') reads.add('candidate');
      workReads.set(invocation, reads);
    });
    const invoke = () => {
      cold();
      invocation++;
      return modules.projectSourceReturn.returnSource._handler(s.ctx, input);
    };
    await assert.rejects(invoke(), code('HOSTED_ACTION_FAILED'));
    const stage = [...s.tables.projectWorkGenerations.values()].find(
      g => g.returnOperationId === input.operationId,
    );
    assert.ok(stage.returnPrepareCursor, 'lost reply left durable preparation');
    const progress = await modules.projectSourceReturn.returnSource._handler(s.ctx, {
      ...input,
      statusOnly: true,
    });
    assert.equal(progress.resumed, true);
    assert.equal(JSON.parse(progress.progress).phase, 'journal');
    assert.equal(JSON.parse(progress.progress).done, 0);
    assert.equal(JSON.parse(progress.progress).total, 1);
    // No process memo participates in the preparation cursor.
    const cursors = await import(moduleUrl('../convex/projectSourceReturnCursor.ts'));
    cold = cursors.forgetReturnCursors;
    cold();
    let result;
    do result = await invoke();
    while (result.pending && invocation < 100);
    assert.ok(!result.pending);
    assert.ok([...workReads.values()].some(reads => reads.has('previous')));
    assert.ok([...workReads.values()].some(reads => reads.has('candidate')));
    assert.ok(
      [...workReads.values()].every(reads => reads.size <= 1),
      'no invocation loads both full Work copies',
    );
    assert.ok(invocation > 4, 'separate source loads and bounded validation invocations');
    assert.equal(result.revision, f.first.store.revision() + 1);
    assert.equal(stage.returnPrepareCursor, undefined, 'publication releases prepare cursor');
    const at = result.at;
    const replay = await invoke();
    assert.equal(replay.at, at);
    assert.equal(replay.operationId, input.operationId);
    t.diagnostic(JSON.stringify(logs.filter(([name]) => name === 'source-return record skip')));
    assert.ok(
      logs.some(
        ([name, value]) =>
          name === 'source-return record skip' && value.reason === 'candidate-records-unvalidated',
      ),
    );
    assert.ok(logs.some(([name]) => name === 'source-return prepare load done'));
    assert.ok(logs.some(([name]) => name === 'source-return prepare source done'));
    const hosted = await modules.projectWorkActions.load(s.ctx, 'project', 'owner');
    assert.equal(hosted.data.intents[0].notes.at(-1).text, 'Hosted reconciliation');
    assert.equal(hosted.data.hostedEvents.length, 2);
    t.diagnostic(
      JSON.stringify({
        workBytes: Buffer.byteLength(workBytes(f.first.store.load())),
        invocations: invocation,
        journalLoads: [...loadedByAction],
      }),
    );
  });

test('legacy transport large prepare resume rechecks authority, hosted revision and original operation pins', async t => {
  const f = await setup(t, false),
    { s, input } = f;
  await modules.projectSourceReturn.returnSource._handler(s.ctx, input);
  s.ctx.auth.getUserIdentity = async () => ({ subject: 'stranger' });
  await assert.rejects(
    modules.projectSourceReturn.returnSource._handler(s.ctx, input),
    code('PROJECT_UNAVAILABLE'),
  );
  s.ctx.auth.getUserIdentity = async () => ({ subject: 'owner' });
  await assert.rejects(
    modules.projectSourceReturn.returnSource._handler(s.ctx, { ...input, revision: input.revision + 1 }),
    code('WORK_STALE'),
  );
  const old = [...s.tables.projectWorkHeads.values()][0];
  old.revision++;
  await assert.rejects(modules.projectSourceReturn.returnSource._handler(s.ctx, input), code('WORK_STALE'));
  assert.equal(s.tables.hostedProjects.get('project').work.backupId, input.expectedBackupId);
});

test('chunked retained validation matches complete validation, including late history corruption', async t => {
  const s = fixture(),
    first = await checkpoint(t, s);
  land(first.store, 4);
  const current = first.store.load(),
    candidate = structuredClone(current);
  const manifest = (await preparedCheckpoint(s, first.store)).manifest;
  current.hostedEvents = Array.from({ length: 5 }, (_, i) => ({ id: String(i), text: 'Synthetic event' }));
  current.hostedChannelMoves = [{ id: 'synthetic-move', head: current.nativeHead }];
  candidate.hostedEvents = structuredClone(current.hostedEvents);
  candidate.hostedChannelMoves = structuredClone(current.hostedChannelMoves);
  for (const [collection, damage] of [
    ['hostedEvents', data => (data.hostedEvents.at(-1).text = 'rewritten')],
    ['hostedChannelMoves', data => data.hostedChannelMoves.push({ id: 'extra' })],
    ['intents', data => (data.intents.at(-1).outcome = 'rewritten')],
    ['channelMoves', data => (data.channelMoves.at(-1).head = 'f'.repeat(64))],
    ['lanes', data => data.lanes.pop()],
  ]) {
    const bad = structuredClone(candidate);
    damage(bad);
    assert.throws(() => validateSourceReturn(current, bad, manifest));
    assert.throws(() => {
      for (const chunk of sourceReturnChunks(current, 500)) validateSourceReturnChunk(chunk, bad, manifest);
    }, collection);
  }
  for (const chunk of sourceReturnChunks(current, 500)) validateSourceReturnChunk(chunk, candidate, manifest);
  assert.equal(readFileSync(join(first.store.directory, 'work.json')).length > 0, true);
});
