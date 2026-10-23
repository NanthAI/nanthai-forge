import { workArchiveMetadata } from '../dist/work-archive-metadata.js';
// SPDX-License-Identifier: Apache-2.0
import { currentOwnerDisplay } from './project-exchange-fixture.mjs';
import { readWorkBytes } from './work-store-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
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
const work = await import(moduleUrl('../convex/projectWork.ts'));
const returns = await import(moduleUrl('../convex/projectSourceReturn.ts'));
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
      if (getFunctionName(ref) === 'projectWork:append' && !dropped) {
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
    assert.equal(
      (await work.state._handler(s.ctx, { projectId: s.projectId })).work.revision,
      replay.revision,
    );
    await assert.rejects(
      actions.command._handler(s.ctx, {
        ...create,
        command: create.command.replace('Created on Forge', 'changed'),
      }),
      e => e.data.code === 'WORK_OPERATION_CHANGED',
    );
    await assert.rejects(
      actions.command._handler(s.ctx, { ...create, operationId: randomUUID() }),
      e => e.data.code === 'WORK_STALE',
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
    // A second original operation commits after the first action read but before its atomic append.
    let raced = false;
    s.ctx.runMutation = async (ref, input) => {
      if (getFunctionName(ref) === 'projectWork:append' && input.operationId === note.operationId && !raced) {
        raced = true;
        await actions.command._handler(s.ctx, {
          ...note,
          operationId: randomUUID(),
          command: JSON.stringify({ action: 'intent-status', intentId: create.operationId, status: 'ready' }),
        });
      }
      return native(ref, input);
    };
    await assert.rejects(actions.command._handler(s.ctx, note), e => e.data.code === 'WORK_STALE');
    s.ctx.runMutation = native;
    assert.equal(s.tables.projectWorkEvents.size, 2);
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
    assert.equal(snapshot.data.intents.find(item => item.id === create.operationId).status, 'ready');
    assert.equal(snapshot.events[0].actor, 'owner');
    const journal = JSON.parse(await actions.exportJournal._handler(s.ctx, { projectId: s.projectId })),
      journalPath = join(root, 'hosted-work.json');
    writeFileSync(journalPath, JSON.stringify(journal));
    const target = join(root, 'hosted-restored');
    const restored = JSON.parse(
      execFileSync(
        process.execPath,
        ['dist/cli.js', 'restore-work', exported.archive.path, target, '--journal', journalPath],
        { encoding: 'utf8' },
      ),
    );
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

    // A real restored local owner edits/checkpoints source, accepts a View, and returns its full archive.
    const rc = input => recovered.dispatch(input, recovered.status().revision);
    const contribution = (
      await rc({ action: 'lane', intentId: create.operationId, name: 'Hosted Intent local edit' })
    ).result;
    const workspace = recovered.store.path(contribution.id);
    writeFileSync(join(workspace, 'a.ts'), 'export const a = 2;');
    git(workspace, ['add', 'a.ts']);
    const changed = (
      await rc({
        action: 'checkpoint',
        laneId: contribution.id,
        expectedHead: contribution.head,
        expectedTree: git(workspace, ['write-tree']).trim(),
        message: 'Local source returned to hosted Forge',
      })
    ).result;
    const changedView = (
      await rc({
        action: 'compose',
        intentId: create.operationId,
        inputs: [{ laneId: changed.id, head: changed.head }],
      })
    ).result;
    await rc({
      action: 'accept-channel',
      operationId: randomUUID(),
      channel: 'main',
      viewId: changedView.id,
      expectedHead: changedView.head,
      expectedPrevious: view.head,
    });
    const saveCandidate = async () => {
      const value = (await rc({ action: 'export-work', archive: true })).result,
        bytes = readFileSync(value.archive.path),
        id = randomUUID(),
        storageId = randomUUID();
      s.tables.projectBackups.set(id, {
        ...s.tables.projectBackups.get(s.backupId),
        _id: id,
        storageId,
        digest: digest(bytes),
        size: bytes.length,
        preview: await previewWorkArchive(new File([bytes], 'return.tar.gz')),
        ...(await currentOwnerDisplay(s, recovered.store, recovered.store.load(), s.projectId)),
      });
      s.files.set(storageId, { blob: new Blob([bytes], { type: 'application/gzip' }) });
      return { id, exported: value };
    };
    const retainedWork = recovered.store.load();
    for (const damage of [
      data => data.intents.find(item => item.id === create.operationId).notes.pop(),
      data => {
        data.channelMoves[0].head = changedView.head;
      },
      data => {
        data.lanes.shift();
      },
    ]) {
      const wrong = structuredClone(retainedWork);
      damage(wrong);
      recovered.store.save(wrong);
      const damaged = await saveCandidate();
      await assert.rejects(
        returns.returnSource._handler(s.ctx, {
          projectId: s.projectId,
          backupId: damaged.id,
          expectedBackupId: s.backupId,
          revision: snapshot.data.revision,
          operationId: randomUUID(),
        }),
        e => e.data.code === 'INVALID_WORK_JOURNAL',
      );
      assert.equal(s.tables.hostedProjects.get(s.projectId).work.backupId, s.backupId);
      recovered.store.save(retainedWork);
    }
    const candidate = await saveCandidate(),
      returned = {
        projectId: s.projectId,
        backupId: candidate.id,
        expectedBackupId: s.backupId,
        revision: snapshot.data.revision,
        operationId: randomUUID(),
      };
    dropped = false;
    s.ctx.runMutation = async (ref, input) => {
      const result = await native(ref, input);
      if (getFunctionName(ref) === 'projectWork:returnSource' && !dropped) {
        dropped = true;
        throw new Error('lost source-return reply');
      }
      return result;
    };
    await assert.rejects(returns.returnSource._handler(s.ctx, returned));
    s.ctx.runMutation = native;
    const receipt = await returns.returnSource._handler(s.ctx, returned);
    assert.equal(receipt.operationId, returned.operationId);
    assert.equal(s.tables.projectWorkEvents.size, 105);
    await assert.rejects(
      returns.returnSource._handler(s.ctx, { ...returned, revision: returned.revision - 1 }),
      e => e.data.code === 'WORK_OPERATION_CHANGED',
    );
    await actions.initialize._handler(s.ctx, start); // Original initialization reconciles without rewinding source.
    const moved = JSON.parse(await readHosted(s.ctx, { projectId: s.projectId }));
    assert.equal(moved.backupId, candidate.id);
    assert.equal(moved.data.revision, s.tables.projectBackups.get(candidate.id).preview.revision + 1);
    assert.equal(moved.events.length, 105);
    assert.equal(moved.channels.find(pin => pin.name === 'main').head, changedView.head);
    const returnedJournal = JSON.parse(
      await actions.exportJournal._handler(s.ctx, { projectId: s.projectId }),
    );
    assert.equal(
      returnedJournal.events.length,
      1,
      'Earlier hosted events are already retained in the returned archive, not replayed twice.',
    );
    writeFileSync(journalPath, JSON.stringify(returnedJournal));
    const returnedRoot = join(root, 'returned-restored');
    await restoreWork(candidate.exported.archive.path, returnedRoot, journalPath);
    const returnedLocal = new WorkService(returnedRoot);
    assert.deepEqual(returnedLocal.store.load(), moved.data);
    assert.equal(
      readFileSync(join(returnedLocal.store.path(changed.id), 'a.ts'), 'utf8'),
      'export const a = 2;',
    );
    assert.equal(returnedLocal.status().runs[0].status, 'passed');
    const forged = structuredClone(returnedJournal);
    forged.events[0].command.workSha256 = '0'.repeat(64);
    forged.events[0].request = metadataRequest(forged.events[0].command);
    writeFileSync(journalPath, JSON.stringify(forged));
    await assert.rejects(
      restoreWork(candidate.exported.archive.path, join(root, 'forged-return'), journalPath),
      code('INVALID_WORK_JOURNAL'),
    );
    // The old local owner lacks the new source-return event and cannot erase current hosted operations.
    const stale = await saveCandidate();
    await assert.rejects(
      returns.returnSource._handler(s.ctx, {
        ...returned,
        backupId: stale.id,
        expectedBackupId: candidate.id,
        revision: moved.data.revision,
        operationId: randomUUID(),
      }),
      e => e.data.code === 'INVALID_WORK_JOURNAL',
    );
    const updated = await returnedLocal.dispatch(
      { action: 'note', intentId: create.operationId, kind: 'comment', text: 'Second local handoff' },
      returnedLocal.status().revision,
    );
    const nextExport = (
        await returnedLocal.dispatch({ action: 'export-work', archive: true }, updated.revision)
      ).result,
      nextBytes = readFileSync(nextExport.archive.path),
      nextId = randomUUID();
    s.tables.projectBackups.set(nextId, {
      ...s.tables.projectBackups.get(candidate.id),
      _id: nextId,
      storageId: nextId,
      digest: digest(nextBytes),
      size: nextBytes.length,
      preview: await previewWorkArchive(new File([nextBytes], 'second.tar.gz')),
    });
    s.files.set(nextId, { blob: new Blob([nextBytes]) });
    const nextRequest = {
      ...returned,
      backupId: nextId,
      expectedBackupId: candidate.id,
      revision: moved.data.revision,
      operationId: randomUUID(),
    };
    raced = false;
    s.ctx.runMutation = async (ref, input) => {
      if (getFunctionName(ref) === 'projectWork:returnSource' && !raced) {
        raced = true;
        await actions.command._handler(s.ctx, {
          projectId: s.projectId,
          operationId: randomUUID(),
          revision: moved.data.revision,
          command: JSON.stringify({
            action: 'note',
            intentId: create.operationId,
            kind: 'comment',
            text: 'Concurrent hosted edit remains',
          }),
        });
      }
      return native(ref, input);
    };
    await assert.rejects(
      returns.returnSource._handler(s.ctx, nextRequest),
      e => e.data.code === 'WORK_STALE',
    );
    s.ctx.runMutation = native;
    const concurrent = JSON.parse(await readHosted(s.ctx, { projectId: s.projectId }));
    assert.equal(concurrent.backupId, candidate.id);
    assert.equal(
      concurrent.data.intents.find(item => item.id === create.operationId).notes.at(-1).text,
      'Concurrent hosted edit remains',
    );
    assert.ok(s.tables.projectBackups.has(nextId));
    assert.equal((await returns.returnSource._handler(s.ctx, returned)).operationId, returned.operationId);
    assert.equal((await actions.command._handler(s.ctx, create)).operationId, create.operationId);
    writeFileSync(journalPath, await actions.exportJournal._handler(s.ctx, { projectId: s.projectId }));
    const reconciledRoot = join(root, 'concurrent-restored');
    await restoreWork(candidate.exported.archive.path, reconciledRoot, journalPath);
    const reconciledLocal = new WorkService(reconciledRoot);
    await reconciledLocal.dispatch(
      {
        action: 'note',
        intentId: create.operationId,
        kind: 'comment',
        text: 'Local work after current hosted handoff',
      },
      reconciledLocal.status().revision,
    );
    const reconciledExport = (
        await reconciledLocal.dispatch(
          { action: 'export-work', archive: true },
          reconciledLocal.status().revision,
        )
      ).result,
      reconciledBytes = readFileSync(reconciledExport.archive.path),
      reconciledId = randomUUID();
    s.tables.projectBackups.set(reconciledId, {
      ...s.tables.projectBackups.get(candidate.id),
      _id: reconciledId,
      storageId: reconciledId,
      digest: digest(reconciledBytes),
      size: reconciledBytes.length,
      preview: await previewWorkArchive(new File([reconciledBytes], 'reconciled.tar.gz')),
    });
    s.files.set(reconciledId, { blob: new Blob([reconciledBytes]) });
    const finalReturn = {
      ...returned,
      backupId: reconciledId,
      expectedBackupId: candidate.id,
      revision: concurrent.data.revision,
      operationId: randomUUID(),
    };
    const query = s.ctx.runQuery;
    let switched = false;
    s.ctx.runQuery = async (ref, input) => {
      if (getFunctionName(ref) === 'projectWork:events' && !switched) {
        switched = true;
        await returns.returnSource._handler(s.ctx, finalReturn);
      }
      return query(ref, input);
    };
    const earlierRead = JSON.parse(await readHosted(s.ctx, { projectId: s.projectId }));
    s.ctx.runQuery = query;
    assert.equal(
      earlierRead.data.revision,
      concurrent.data.revision,
      'A source return during a pinned read cannot mix the new base with old events.',
    );
    const latest = JSON.parse(await readHosted(s.ctx, { projectId: s.projectId }));
    assert.equal(latest.backupId, reconciledId);
    assert.equal(latest.events.length, 107);
    assert.equal(
      latest.data.intents.find(item => item.id === create.operationId).notes.at(-2).text,
      'Concurrent hosted edit remains',
    );
    assert.equal(
      latest.data.intents.find(item => item.id === create.operationId).notes.at(-1).text,
      'Local work after current hosted handoff',
    );
    // Canonical hosted selection is a signed-in owner operation, separate from local acceptance.
    const selectedAcceptance = latest.data.channelMoves.find(move => move.viewId === changedView.id),
      oldAcceptance = latest.data.channelMoves[0];
    const select = {
      projectId: s.projectId,
      operationId: randomUUID(),
      revision: latest.data.revision,
      command: JSON.stringify({
        action: 'accept-hosted-channel',
        channel: 'main',
        acceptanceId: selectedAcceptance.id,
        viewId: changedView.id,
        head: changedView.head,
        previousId: null,
        archiveSha256: latest.backupDigest,
      }),
    };
    await assert.rejects(actions.command._handler(s.ctx, select), e => e.data.code === 'BAD_ARGUMENT');
    dropped = false;
    s.ctx.runMutation = async (ref, input) => {
      const result = await native(ref, input);
      if (getFunctionName(ref) === 'projectWork:append' && !dropped) {
        dropped = true;
        throw new Error('lost hosted acceptance reply');
      }
      return result;
    };
    await assert.rejects(actions.acceptChannel._handler(s.ctx, select));
    s.ctx.runMutation = native;
    assert.equal((await actions.acceptChannel._handler(s.ctx, select)).operationId, select.operationId);
    const accepted = JSON.parse(await readHosted(s.ctx, { projectId: s.projectId }));
    assert.equal(accepted.hostedChannels[0].head, changedView.head);
    assert.equal(accepted.hostedChannels[0].actor, 'owner');
    assert.equal(accepted.hostedChannels[0].provenance, 'signed-in-owner-selection');
    await assert.rejects(
      actions.acceptChannel._handler(s.ctx, {
        ...select,
        command: select.command.replace('"main"', '"other"'),
      }),
      e => e.data.code === 'WORK_OPERATION_CHANGED',
    );
    for (const [change, expected] of [
      [
        command => {
          command.previousId = null;
        },
        'CHANNEL_CHANGED',
      ],
      [
        command => {
          command.head = view.head;
        },
        'SOURCE_UNAVAILABLE',
      ],
      [
        command => {
          command.archiveSha256 = '0'.repeat(64);
        },
        'WORK_STALE',
      ],
    ]) {
      const command = JSON.parse(select.command);
      command.previousId = select.operationId;
      change(command);
      await assert.rejects(
        actions.acceptChannel._handler(s.ctx, {
          ...select,
          operationId: randomUUID(),
          revision: accepted.data.revision,
          command: JSON.stringify(command),
        }),
        e => e.data.code === expected,
      );
    }
    const rollback = {
      ...select,
      operationId: randomUUID(),
      revision: accepted.data.revision,
      command: JSON.stringify({
        ...JSON.parse(select.command),
        acceptanceId: oldAcceptance.id,
        viewId: oldAcceptance.viewId,
        head: oldAcceptance.head,
        previousId: select.operationId,
      }),
    };
    await actions.acceptChannel._handler(s.ctx, rollback);
    const rolled = JSON.parse(await readHosted(s.ctx, { projectId: s.projectId }));
    assert.equal(rolled.hostedChannels[0].head, view.head);
    const resume = {
      ...select,
      operationId: randomUUID(),
      revision: rolled.data.revision,
      command: JSON.stringify({ ...JSON.parse(select.command), previousId: rollback.operationId }),
    };
    await actions.acceptChannel._handler(s.ctx, resume);
    await actions.acceptChannel._handler(s.ctx, select);
    const current = JSON.parse(await readHosted(s.ctx, { projectId: s.projectId }));
    assert.equal(current.hostedChannels[0].id, resume.operationId);
    assert.equal(current.data.hostedChannelMoves.length, 3);
    const fromHosted = {
      ...create,
      operationId: randomUUID(),
      revision: current.data.revision,
      command: JSON.stringify({
        action: 'intent',
        outcome: 'From canonical Forge source',
        base: changedView.head,
        hostedBase: { name: 'main', head: changedView.head, acceptanceId: resume.operationId },
      }),
    };
    await actions.command._handler(s.ctx, fromHosted);
    const canonical = JSON.parse(await readHosted(s.ctx, { projectId: s.projectId }));
    assert.equal(
      canonical.data.intents.find(item => item.id === fromHosted.operationId).hostedBase.acceptanceId,
      resume.operationId,
    );
    await assert.rejects(
      actions.command._handler(s.ctx, {
        ...fromHosted,
        operationId: randomUUID(),
        revision: canonical.data.revision,
        command: fromHosted.command.replace(resume.operationId, select.operationId),
      }),
      e => e.data.code === 'CHANNEL_CHANGED',
    );
    writeFileSync(journalPath, await actions.exportJournal._handler(s.ctx, { projectId: s.projectId }));
    const canonicalRoot = join(root, 'canonical-restored');
    await restoreWork(reconciledExport.archive.path, canonicalRoot, journalPath);
    const canonicalLocal = new WorkService(canonicalRoot);
    assert.deepEqual(canonicalLocal.store.load(), canonical.data);
    assert.equal(
      digest(readWorkBytes(join(canonicalLocal.store.directory, 'work.json'))),
      canonical.workDigest,
    );
    const hostedLane = await canonicalLocal.dispatch(
      { action: 'lane', intentId: fromHosted.operationId, name: 'From hosted accepted source' },
      canonicalLocal.status().revision,
    );
    assert.equal(hostedLane.result.base, changedView.head);
    assert.equal(
      readFileSync(join(canonicalLocal.store.path(hostedLane.result.id), 'a.ts'), 'utf8'),
      'export const a = 2;',
    );
    const correctChannel = canonicalLocal.store.load(),
      wrongChannel = structuredClone(correctChannel);
    wrongChannel.hostedChannelMoves[0].head = view.head;
    canonicalLocal.store.save(wrongChannel);
    const wrongExport = (
        await canonicalLocal.dispatch(
          { action: 'export-work', archive: true },
          canonicalLocal.status().revision,
        )
      ).result,
      wrongBytes = readFileSync(wrongExport.archive.path),
      wrongId = randomUUID();
    s.tables.projectBackups.set(wrongId, {
      ...s.tables.projectBackups.get(reconciledId),
      _id: wrongId,
      storageId: wrongId,
      digest: digest(wrongBytes),
      size: wrongBytes.length,
      preview: await previewWorkArchive(new File([wrongBytes], 'wrong-channel.tar.gz')),
    });
    s.files.set(wrongId, { blob: new Blob([wrongBytes]) });
    await assert.rejects(
      returns.returnSource._handler(s.ctx, {
        ...returned,
        backupId: wrongId,
        expectedBackupId: reconciledId,
        revision: canonical.data.revision,
        operationId: randomUUID(),
      }),
      e => e.data.code === 'INVALID_WORK_JOURNAL',
    );
    canonicalLocal.store.save(correctChannel);
    const goodExport = (
        await canonicalLocal.dispatch(
          { action: 'export-work', archive: true },
          canonicalLocal.status().revision,
        )
      ).result,
      goodBytes = readFileSync(goodExport.archive.path),
      goodId = randomUUID();
    s.tables.projectBackups.set(goodId, {
      ...s.tables.projectBackups.get(reconciledId),
      _id: goodId,
      storageId: goodId,
      digest: digest(goodBytes),
      size: goodBytes.length,
      preview: await previewWorkArchive(new File([goodBytes], 'good-channel.tar.gz')),
    });
    s.files.set(goodId, { blob: new Blob([goodBytes]) });
    await returns.returnSource._handler(s.ctx, {
      ...returned,
      backupId: goodId,
      expectedBackupId: reconciledId,
      revision: canonical.data.revision,
      operationId: randomUUID(),
    });
    const afterAcceptedReturn = JSON.parse(await readHosted(s.ctx, { projectId: s.projectId }));
    assert.equal(
      afterAcceptedReturn.hostedChannels[0].id,
      resume.operationId,
      'Source return preserves canonical hosted selection.',
    );
    assert.equal(
      (await actions.acceptChannel._handler(s.ctx, select)).operationId,
      select.operationId,
      'Older acceptance remains reconcilable after source return.',
    );
    writeFileSync(journalPath, await actions.exportJournal._handler(s.ctx, { projectId: s.projectId }));
    const afterReturnRoot = join(root, 'accepted-return-restored');
    await restoreWork(goodExport.archive.path, afterReturnRoot, journalPath);
    assert.deepEqual(new WorkService(afterReturnRoot).store.load(), afterAcceptedReturn.data);
    const racingSelection = {
      ...resume,
      operationId: randomUUID(),
      revision: afterAcceptedReturn.data.revision,
      command: JSON.stringify({
        ...JSON.parse(select.command),
        archiveSha256: afterAcceptedReturn.backupDigest,
        previousId: resume.operationId,
      }),
    };
    raced = false;
    s.ctx.runMutation = async (ref, input) => {
      if (
        getFunctionName(ref) === 'projectWork:append' &&
        input.operationId === racingSelection.operationId &&
        !raced
      ) {
        raced = true;
        await actions.command._handler(s.ctx, {
          ...note,
          operationId: randomUUID(),
          revision: afterAcceptedReturn.data.revision,
        });
      }
      return native(ref, input);
    };
    await assert.rejects(
      actions.acceptChannel._handler(s.ctx, racingSelection),
      e => e.data.code === 'WORK_STALE',
    );
    s.ctx.runMutation = native;
    assert.equal(
      JSON.parse(await readHosted(s.ctx, { projectId: s.projectId })).hostedChannels[0].id,
      resume.operationId,
    );
    const beforeReads = s.reads();
    for (const caller of [undefined, 'other']) {
      s.caller(caller);
      for (const call of [
        () => work.state._handler(s.ctx, { projectId: s.projectId }),
        () => readHosted(s.ctx, { projectId: s.projectId }),
        () => actions.exportJournal._handler(s.ctx, { projectId: s.projectId }),
        () => actions.command._handler(s.ctx, create),
        () => actions.initialize._handler(s.ctx, start),
        () => returns.returnSource._handler(s.ctx, returned),
        () => actions.acceptChannel._handler(s.ctx, select),
      ])
        await assert.rejects(call());
    }
    assert.equal(s.reads(), beforeReads, 'Anonymous/other users are denied before source storage reads.');
    s.caller('owner');
    const getUrl = s.ctx.storage.getUrl,
      fetchNative = globalThis.fetch;
    let archiveUrl;
    s.ctx.storage.getUrl = async id => (archiveUrl = await getUrl(id));
    globalThis.fetch = async (input, init) => {
      const response = await fetchNative(input, init);
      if (String(input) !== archiveUrl) return response;
      assert.ok(response.body);
      const reader = response.body.getReader();
      return new Response(
        new ReadableStream({
          async pull(controller) {
            const chunk = await reader.read();
            if (chunk.done) controller.close();
            else {
              s.tables.hostedProjects.get(s.projectId).owner = 'other';
              controller.enqueue(chunk.value);
            }
          },
          async cancel(reason) {
            await reader.cancel(reason);
          },
        }),
        { status: response.status, headers: response.headers },
      );
    };
    try {
      await assert.rejects(
        actions.exportJournal._handler(s.ctx, { projectId: s.projectId }),
        e => e.data.code === 'PROJECT_UNAVAILABLE',
      );
    } finally {
      globalThis.fetch = fetchNative;
      s.ctx.storage.getUrl = getUrl;
    }
    assert.equal(
      s.tables.projectWorkEvents.size,
      113,
      'A change during streamed source transfer preserves original Work.',
    );
  }
});
test('native hosted source, Intent, local return, Channel and journal recovery retain original States and evidence with Git unavailable', async t => {
  const { mkdirSync, chmodSync, symlinkSync } = await import('node:fs');
  const { initNative } = await import('../dist/native-work.js'),
    { restoreNativeWork } = await import('../dist/native-backup.js');
  const { NativeSource } = await import('../dist/native-source.js');
  const dir = fixture(t),
    bin = join(dir, 'bin'),
    root = join(dir, 'native');
  mkdirSync(bin);
  mkdirSync(root);
  const called = join(dir, 'git-called');
  writeFileSync(join(bin, 'git'), `#!/bin/sh\n/usr/bin/touch '${called}'\nexit 91\n`);
  chmodSync(join(bin, 'git'), 0o700);
  for (const tool of ['tar', 'gzip']) symlinkSync(`/usr/bin/${tool}`, join(bin, tool));
  const previous = process.env.PATH;
  process.env.PATH = bin;
  t.after(() => {
    process.env.PATH = previous;
  });
  writeFileSync(join(root, 'a.ts'), 'export const a = 1;');
  initNative(root);
  const local = new WorkService(root),
    act = command => local.dispatch(command, local.status().revision);
  const intent = (await act({ action: 'intent', outcome: 'Native source hosted privately' })).result;
  const lane = (await act({ action: 'lane', intentId: intent.id, name: 'Initial native Lane' })).result;
  const view = (
    await act({ action: 'compose', intentId: intent.id, inputs: [{ laneId: lane.id, head: lane.head }] })
  ).result;
  const accepted = (
    await act({
      action: 'accept-channel',
      operationId: randomUUID(),
      channel: 'main',
      viewId: view.id,
      expectedHead: view.head,
      expectedPrevious: null,
    })
  ).result;
  const check = (
    await act({
      action: 'define-check',
      name: 'Native command',
      executable: process.execPath,
      args: ['-e', 'console.log("actual native output")'],
    })
  ).result;
  const runId = randomUUID();
  await act({
    action: 'run-check',
    operationId: runId,
    viewId: view.id,
    expectedHead: view.head,
    checkId: check.id,
    expectedDefinition: check.definition,
    expectedEnvironment: local.status().environment.fingerprint,
  });
  for (let i = 0; i < 200 && ['preparing', 'running'].includes(local.status().runs[0].status); i++)
    await new Promise(r => setTimeout(r, 20));
  assert.equal(local.status().runs[0].status, 'passed');
  const exported = (await act({ action: 'export-work', archive: true })).result,
    bytes = readFileSync(exported.archive.path);
  const preview = await previewWorkArchive(new File([bytes], 'native.tar.gz'));
  assert.equal(preview.format, 'native');
  assert.deepEqual(preview.channels, [{ name: 'main', head: view.head }]);
  const s = hosted(bytes, preview),
    start = { projectId: s.projectId, backupId: s.backupId, operationId: randomUUID() };
  await actions.initialize._handler(s.ctx, start);
  const create = {
    projectId: s.projectId,
    operationId: randomUUID(),
    revision: preview.revision,
    command: JSON.stringify({
      action: 'intent',
      outcome: 'Created on hosted native Forge',
      base: view.head,
      baseChannel: { name: 'main', head: view.head, acceptanceId: accepted.id },
    }),
  };
  const native = s.ctx.runMutation;
  let dropped = false;
  s.ctx.runMutation = async (ref, args) => {
    const result = await native(ref, args);
    if (getFunctionName(ref) === 'projectWork:append' && !dropped) {
      dropped = true;
      throw Error('lost committed reply');
    }
    return result;
  };
  await assert.rejects(actions.command._handler(s.ctx, create));
  s.ctx.runMutation = native;
  await actions.command._handler(s.ctx, create);
  const initial = JSON.parse(await readHosted(s.ctx, { projectId: s.projectId }));
  assert.equal(initial.sourceKind, 'native');
  assert.equal(initial.events.length, 1);
  await assert.rejects(
    actions.command._handler(s.ctx, {
      ...create,
      operationId: randomUUID(),
      revision: initial.data.revision,
      command: JSON.stringify({ action: 'intent', outcome: 'Missing State', base: 'f'.repeat(64) }),
    }),
    e => e.data.code === 'SOURCE_UNAVAILABLE',
  );
  const blobId = new NativeSource(root).state(view.head).files[0].blob;
  await assert.rejects(
    actions.command._handler(s.ctx, {
      ...create,
      operationId: randomUUID(),
      revision: initial.data.revision,
      command: JSON.stringify({ action: 'intent', outcome: 'Blob is not a State', base: blobId }),
    }),
    e => e.data.code === 'SOURCE_UNAVAILABLE',
  );
  const journalPath = join(dir, 'journal.json');
  writeFileSync(journalPath, await actions.exportJournal._handler(s.ctx, { projectId: s.projectId }));
  const target = join(dir, 'restored'),
    restored = JSON.parse(
      execFileSync(
        process.execPath,
        ['dist/cli.js', 'restore-native', exported.archive.path, target, '--journal', journalPath],
        { encoding: 'utf8' },
      ),
    );
  assert.equal(restored.restored, true);
  const recovered = new WorkService(target);
  assert.deepEqual(recovered.store.load(), initial.data);
  assert.equal(existsSync(join(target, '.git')), false);
  assert.equal(recovered.status().runs[0].status, 'passed');
  assert.match(
    readFileSync(join(recovered.store.directory, `check-${runId}/stdout.log`), 'utf8'),
    /actual native output/,
  );
  const rc = command => recovered.dispatch(command, recovered.status().revision),
    edit = (await rc({ action: 'lane', intentId: create.operationId, name: 'Hosted native change' })).result;
  writeFileSync(join(recovered.store.path(edit.id), 'a.ts'), 'export const a = 2;');
  const observation = recovered.status().lanes.find(item => item.id === edit.id);
  const checkpoint = (
    await rc({
      action: 'checkpoint',
      laneId: edit.id,
      expectedHead: edit.head,
      expectedTree: observation.indexTree,
      message: 'Native source return',
    })
  ).result;
  const changed = (
    await rc({
      action: 'compose',
      intentId: create.operationId,
      inputs: [{ laneId: edit.id, head: checkpoint.head }],
    })
  ).result;
  const localAcceptance = (
    await rc({
      action: 'accept-channel',
      operationId: randomUUID(),
      channel: 'main',
      viewId: changed.id,
      expectedHead: changed.head,
      expectedPrevious: view.head,
    })
  ).result;
  const candidate = (await rc({ action: 'export-work', archive: true })).result,
    candidateBytes = readFileSync(candidate.archive.path),
    backupId = randomUUID();
  s.tables.projectBackups.set(backupId, {
    ...s.tables.projectBackups.get(s.backupId),
    _id: backupId,
    storageId: backupId,
    digest: digest(candidateBytes),
    size: candidateBytes.length,
    preview: await previewWorkArchive(new File([candidateBytes], 'return.tar.gz')),
    ...(await currentOwnerDisplay(
      s,
      recovered.store,
      JSON.parse(Buffer.from((await workArchiveMetadata(new Blob([candidateBytes]))).work)),
      s.projectId,
    )),
  });
  s.files.set(backupId, { blob: new Blob([candidateBytes]) });
  const returning = {
    projectId: s.projectId,
    backupId,
    expectedBackupId: s.backupId,
    revision: initial.data.revision,
    operationId: randomUUID(),
  };
  await returns.returnSource._handler(s.ctx, returning);
  await returns.returnSource._handler(s.ctx, returning);
  const returned = JSON.parse(await readHosted(s.ctx, { projectId: s.projectId }));
  assert.equal(returned.channels[0].head, changed.head);
  assert.equal(returned.events.length, 2);
  const selection = {
    projectId: s.projectId,
    operationId: randomUUID(),
    revision: returned.data.revision,
    command: JSON.stringify({
      action: 'accept-hosted-channel',
      channel: 'main',
      acceptanceId: localAcceptance.id,
      viewId: changed.id,
      head: changed.head,
      previousId: null,
      archiveSha256: digest(candidateBytes),
    }),
  };
  await actions.acceptChannel._handler(s.ctx, selection);
  await actions.acceptChannel._handler(s.ctx, selection);
  const final = JSON.parse(await readHosted(s.ctx, { projectId: s.projectId }));
  assert.equal(final.hostedChannels[0].head, changed.head);
  assert.equal(final.events.length, 3);
  writeFileSync(journalPath, await actions.exportJournal._handler(s.ctx, { projectId: s.projectId }));
  const finalTarget = join(dir, 'final-restored');
  await restoreNativeWork(candidate.archive.path, finalTarget, journalPath);
  const finalOwner = new WorkService(finalTarget);
  assert.deepEqual(finalOwner.store.load(), final.data);
  assert.equal(digest(readWorkBytes(join(finalOwner.store.directory, 'work.json'))), final.workDigest);
  assert.equal(new NativeSource(finalTarget).state(changed.head).message, 'Native source return');
  assert.equal(readFileSync(join(finalOwner.store.path(edit.id), 'a.ts'), 'utf8'), 'export const a = 2;');
  const originalJournal = JSON.parse(readFileSync(journalPath));
  originalJournal.base.archiveSha256 = '0'.repeat(64);
  writeFileSync(journalPath, JSON.stringify(originalJournal));
  await assert.rejects(
    restoreNativeWork(candidate.archive.path, join(dir, 'wrong-journal'), journalPath),
    code('INVALID_WORK_JOURNAL'),
  );
  assert.equal(existsSync(join(dir, 'wrong-journal')), false);
  await assert.rejects(restoreNativeWork(candidate.archive.path, finalTarget), code('RESTORE_TARGET_EXISTS'));
  const beforeReads = s.reads();
  for (const caller of [undefined, 'other']) {
    s.caller(caller);
    for (const call of [
      () => readHosted(s.ctx, { projectId: s.projectId }),
      () => actions.command._handler(s.ctx, create),
      () => actions.exportJournal._handler(s.ctx, { projectId: s.projectId }),
      () => actions.acceptChannel._handler(s.ctx, selection),
      () => returns.returnSource._handler(s.ctx, returning),
    ])
      await assert.rejects(call());
  }
  assert.equal(s.reads(), beforeReads);
  assert.equal(existsSync(called), false);
  assert.deepEqual(readFileSync(exported.archive.path), bytes);
});
