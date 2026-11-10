// SPDX-License-Identifier: Apache-2.0
import { effectivePolicy } from '../dist/autonomy-policy.js';
import { workArchiveMetadata } from '../dist/work-archive-metadata.js';
import { currentOwnerDisplay } from './project-exchange-fixture.mjs';
import { readWorkBytes } from './work-store-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { WorkService } from '../dist/work.js';
import { restoreWork } from '../dist/work-backup.js';
import { digest } from '../dist/hash.js';
import { metadataRequest, applyHostedEvent, workBytes, parseWorkBytes } from '../dist/work-metadata.js';
import { fixture, git, code } from './helpers.mjs';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';
import { readHosted } from './hosted-read.mjs';
const actions = await import(moduleUrl('../convex/projectWorkActions.ts'));
const indexActions = await import(moduleUrl('../convex/projectWorkIndexActions.ts'));
const work = await import(moduleUrl('../convex/projectWork.ts'));
const backups = await import(moduleUrl('../convex/projectBackups.ts'));
const { previewWorkArchive } = await import(moduleUrl('../web/src/work-archive.ts'));

function hosted(bytes, preview) {
  const s = state([]),
    native = s.ctx.runQuery;
  s.tables.hostedProjects = new Map();
  s.tables.projectBackups = new Map();
  s.tables.projectWorkEvents = new Map();
  s.ctx.runQuery = s.ctx.runMutation = (ref, args) => {
    const [module, name] = getFunctionName(ref).split(':');
    return (
      { projectWork: work, projectBackups: backups }[module]?.[name]?._handler(s.ctx, args) ??
      native(ref, args)
    );
  };
  const projectId = 'project',
    backupId = 'backup';
  s.tables.hostedProjects.set(projectId, {
    _id: projectId,
    _creationTime: 1,
    owner: 'owner',
    key: randomUUID(),
    name: 'Forge fixture',
    currentBackup: backupId,
    revision: 1,
  });
  s.tables.projectBackups.set(backupId, {
    _id: backupId,
    _creationTime: 1,
    projectId,
    operationId: randomUUID(),
    request: 'a'.repeat(64),
    nonce: randomUUID(),
    previous: null,
    digest: digest(bytes),
    size: bytes.length,
    preview,
    status: 'stored',
    storageId: 'source',
  });
  s.files.set('source', { blob: new Blob([bytes], { type: 'application/gzip' }) });
  return { ...s, projectId, backupId };
}

test('hosted Intent authority reconciles original operations, retains concurrent work, paginates and restores full pinned source/evidence without mutating its local owner', async t => {
  for (const format of ['sha1', 'sha256']) {
    const root = fixture(t, { 'a.ts': 'export const a = 1;' });
    if (format === 'sha256') {
      rmSync(join(root, '.git'), { recursive: true });
      git(root, ['init', '-q', '--object-format=sha256']);
    }
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'Original native source']);
    const local = new WorkService(root),
      c = input => local.dispatch(input, local.status().revision);
    // Explicit project opt-in: this fixture exercises portable local-log recovery.
    const logPolicyData = local.store.load();
    logPolicyData.autonomyPolicy = {
      ...effectivePolicy(logPolicyData),
      checkLogs: { uploadLocal: true, retentionDays: 90 },
    };
    local.store.save(logPolicyData);
    const originalIntent = (await c({ action: 'intent', outcome: 'Original retained work' })).result;
    const lane = (await c({ action: 'lane', intentId: originalIntent.id, name: 'Original local Lane' }))
      .result;
    const view = (
      await c({
        action: 'compose',
        intentId: originalIntent.id,
        inputs: [{ laneId: lane.id, head: lane.head }],
      })
    ).result;
    await c({
      action: 'accept-channel',
      operationId: randomUUID(),
      channel: 'main',
      viewId: view.id,
      expectedHead: view.head,
      expectedPrevious: null,
    });
    const check = (
      await c({
        action: 'define-check',
        name: 'Retained local output',
        executable: process.execPath,
        args: ['-e', 'console.log("actual retained result")'],
      })
    ).result;
    const runId = randomUUID();
    await c({
      action: 'run-check',
      operationId: runId,
      viewId: view.id,
      expectedHead: view.head,
      checkId: check.id,
      expectedDefinition: check.definition,
      expectedEnvironment: local.status().environment.fingerprint,
    });
    for (let i = 0; i < 200 && ['preparing', 'running'].includes(local.status().runs[0].status); i++)
      await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(local.status().runs[0].status, 'passed');
    const exported = (await c({ action: 'export-work', archive: true })).result,
      bytes = readFileSync(exported.archive.path),
      originalWork = readWorkBytes(join(exported.path, 'work.json'));
    const preview = await previewWorkArchive(new File([bytes], 'source.tar.gz')),
      s = hosted(bytes, preview),
      initialRevision = preview.revision;
    const start = { projectId: s.projectId, backupId: s.backupId, operationId: randomUUID() };
    await actions.initialize._handler(s.ctx, start);
    await indexActions.ensure._handler(s.ctx, { projectId: s.projectId, rebuild: true });
    await actions.initialize._handler(s.ctx, start);
    await assert.rejects(
      actions.initialize._handler(s.ctx, { ...start, operationId: randomUUID() }),
      e => e.data.code === 'PROJECT_WORK_EXISTS',
    );
    await assert.rejects(
      actions.command._handler(s.ctx, {
        projectId: s.projectId,
        operationId: originalIntent.id,
        revision: initialRevision,
        command: JSON.stringify({ action: 'intent', outcome: 'Duplicate identity', base: view.head }),
      }),
      e => e.data.code === 'WORK_OPERATION_CHANGED',
    );
    const create = {
      projectId: s.projectId,
      operationId: randomUUID(),
      revision: initialRevision,
      command: JSON.stringify({
        action: 'intent',
        outcome: 'Created on Forge',
        constraints: 'Local runtime',
        base: view.head,
      }),
    };
    const native = s.ctx.runMutation;
    let dropped = false;
    s.ctx.runMutation = async (ref, input) => {
      const result = await native(ref, input);
      if (getFunctionName(ref) === 'projectWorkCommand:commandFromAction' && !dropped) {
        dropped = true;
        throw new Error('lost committed reply');
      }
      return result;
    };
    await assert.rejects(actions.command._handler(s.ctx, create));
    s.ctx.runMutation = native;
    const replay = await actions.command._handler(s.ctx, create);
    assert.equal(replay.operationId, create.operationId);
    assert.equal(s.tables.projectWorkEvents.size, 1);
    assert.equal(s.tables.projectWorkHeads.size, 1, 'journal revision lives outside the project row');
    // `state` is the head-free project record every tab holds; the live revision is the hydrated `get`.
    assert.equal(
      (await work.get._handler(s.ctx, { projectId: s.projectId, owner: 'owner' })).work.revision,
      replay.revision,
    );
    await assert.rejects(
      actions.command._handler(s.ctx, {
        ...create,
        command: create.command.replace('Created on Forge', 'changed'),
      }),
      e => e.data.code === 'WORK_OPERATION_CHANGED',
    );
    assert.equal(
      (await actions.command._handler(s.ctx, { ...create, revision: initialRevision + 100 }))._id,
      replay._id,
      'metadata retries reconcile by original operation and ignore an unrelated project revision',
    );
    await assert.rejects(
      actions.command._handler(s.ctx, {
        ...create,
        operationId: randomUUID(),
        revision: initialRevision + 1,
        command: '{"action":"run-check"}',
      }),
      e => e.data.code === 'BAD_ARGUMENT',
    );
    await assert.rejects(
      actions.command._handler(s.ctx, {
        ...create,
        operationId: randomUUID(),
        revision: initialRevision + 1,
        command: JSON.stringify({
          action: 'intent',
          outcome: 'foreign source',
          base: 'f'.repeat(format === 'sha1' ? 40 : 64),
        }),
      }),
      e => e.data.code === 'SOURCE_UNAVAILABLE',
    );
    const note = {
      projectId: s.projectId,
      operationId: randomUUID(),
      revision: initialRevision + 1,
      command: JSON.stringify({
        action: 'note',
        intentId: create.operationId,
        kind: 'decision',
        text: 'Commands remain local',
      }),
    };
    // Another operation commits before the metadata mutation; both independent commands survive.
    let raced = false;
    s.ctx.runMutation = async (ref, input) => {
      if (
        getFunctionName(ref) === 'projectWorkCommand:commandFromAction' &&
        input.operationId === note.operationId &&
        !raced
      ) {
        raced = true;
        await actions.command._handler(s.ctx, {
          ...note,
          operationId: randomUUID(),
          command: JSON.stringify({ action: 'intent-status', intentId: create.operationId, status: 'ready' }),
        });
      }
      return native(ref, input);
    };
    await actions.command._handler(s.ctx, note);
    s.ctx.runMutation = native;
    assert.equal(s.tables.projectWorkEvents.size, 3);
    assert.equal(
      (await actions.command._handler(s.ctx, create)).revision,
      initialRevision + 1,
      'Old replay cannot rewind current hosted Work.',
    );
    note.revision++;
    await actions.command._handler(s.ctx, note);
    for (let i = 0; i < 101; i++)
      await actions.command._handler(s.ctx, {
        ...note,
        operationId: randomUUID(),
        revision: initialRevision + 3 + i,
        command: JSON.stringify({
          action: 'note',
          intentId: create.operationId,
          kind: 'comment',
          text: `Original ${i}`,
        }),
      });
    const snapshot = JSON.parse(await readHosted(s.ctx, { projectId: s.projectId }));
    assert.equal(snapshot.events.length, 104);
    assert.equal(snapshot.data.revision, initialRevision + 104);
    assert.equal(snapshot.data.intents.find(item => item.id === create.operationId).notes.length, 102);
    assert.equal(snapshot.data.intents.find(item => item.id === create.operationId).status, 'active');
    assert.equal(snapshot.events[0].actor, 'owner');
    const journal = JSON.parse(await actions.exportJournal._handler(s.ctx, { projectId: s.projectId })),
      journalPath = join(root, 'hosted-work.json');
    writeFileSync(journalPath, JSON.stringify(journal));
    const target = join(root, 'hosted-restored');
    const restored = await restoreWork(exported.archive.path, target, journalPath);
    assert.equal(restored.restored, true);
    const recovered = new WorkService(target);
    assert.deepEqual(recovered.store.load(), snapshot.data);
    assert.equal(git(target, ['rev-parse', 'HEAD']).trim(), exported.head);
    for (const pin of JSON.parse(readFileSync(join(exported.path, 'manifest.json'))).refs)
      assert.equal(git(target, ['show-ref', '--verify', '--hash', pin.ref]).trim(), pin.head);
    assert.equal(recovered.status().lanes[0].available, true);
    assert.equal(recovered.status().runs[0].status, 'passed');
    assert.match(
      (await recovered.dispatch({ action: 'export-check', id: runId }, recovered.status().revision)).result
        .logs[0].path,
      /stdout/,
    );
    assert.deepEqual(readWorkBytes(join(local.store.directory, 'work.json')), originalWork);
    assert.deepEqual(readFileSync(exported.archive.path), bytes);
    await c({
      action: 'note',
      intentId: originalIntent.id,
      kind: 'comment',
      text: 'Local owner changed independently',
    });
    assert.equal(
      JSON.parse(await readHosted(s.ctx, { projectId: s.projectId })).data.revision,
      snapshot.data.revision,
    );
    for (const change of [
      j => {
        j.base.archiveSha256 = '0'.repeat(64);
      },
      j => {
        j.events[0].command.outcome = 'tampered';
      },
      j => {
        j.events.reverse();
      },
      j => {
        j.workSha256 = '0'.repeat(64);
      },
    ]) {
      const wrong = structuredClone(journal);
      change(wrong);
      writeFileSync(journalPath, JSON.stringify(wrong));
      await assert.rejects(
        restoreWork(exported.archive.path, join(root, 'invalid'), journalPath),
        code('INVALID_WORK_JOURNAL'),
      );
      assert.equal(existsSync(join(root, 'invalid')), false);
    }
    const invalidSource = structuredClone(journal),
      data = parseWorkBytes(originalWork);
    invalidSource.events[0].command.base = 'f'.repeat(format === 'sha1' ? 40 : 64);
    invalidSource.events[0].request = metadataRequest(invalidSource.events[0].command);
    for (const event of invalidSource.events) applyHostedEvent(data, event);
    invalidSource.workSha256 = digest(workBytes(data));
    writeFileSync(journalPath, JSON.stringify(invalidSource));
    await assert.rejects(
      restoreWork(exported.archive.path, join(root, 'invalid-source'), journalPath),
      code('SOURCE_UNAVAILABLE'),
    );
  }
});
