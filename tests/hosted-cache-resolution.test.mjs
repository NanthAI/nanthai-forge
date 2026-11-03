// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolutionFixture } from './hosted-agent-resolution-fixture.mjs';

for (const legacy of [false, true])
  test(`parent housekeeping cannot obstruct a completed nested resolution (legacy=${legacy})`, async t => {
    const s = await resolutionFixture(t, { overlap: true });
    const root = join(dirname(s.root), 'arbitrary project.with spaces');
    const parent = () => s.transport(root);
    s.f.moveMain({ overlap: true });
    await parent().dispatch('open', { laneId: s.f.lane.laneId });
    const conflict = (await parent().dispatch('sync', { laneId: s.f.lane.laneId })).result.conflict;
    const legacyFile = join(conflict.root, '.forge', 'cache-use.json');
    if (legacy) {
      rmSync(join(`${conflict.root}.forge-client`, 'cache-use.json'));
      writeFileSync(legacyFile, JSON.stringify({ bytes: 12345 }));
    }
    await parent().dispatch('save', { operationId: randomUUID(), message: 'Parent mutation' });
    t.diagnostic(
      `nested metadata after parent mutation: ${readdirSync(join(conflict.root, '.forge')).join(', ')}`,
    );
    writeFileSync(join(conflict.root, 'a.txt'), 'chosen\nb\nc\n');
    const command = { ...conflict.next };
    delete command.action;
    let result;
    try {
      result = await s.transport(conflict.root).dispatch('resolve', command);
    } catch (error) {
      t.diagnostic(
        `server resolution after local failure: ${(await s.f.readLane(conflict.laneId)).resolution.status}`,
      );
      throw error;
    }
    assert.equal(result.result.source.outcome.result.status, 'resolved');
    assert.equal(readFileSync(join(conflict.root, 'a.txt'), 'utf8'), 'chosen\nb\nc\n');
    assert(!existsSync(legacyFile));
    const usage = JSON.parse(readFileSync(join(`${conflict.root}.forge-client`, 'cache-use.json')));
    assert(usage.bytes >= 0);
    if (legacy) assert.equal(usage.bytes, 12345);
    const replay = await s.transport(conflict.root).dispatch('resolve', command);
    assert.equal(replay.result.applied.replayed, true);
    const resolves = s.calls
      .filter(call => call.name === 'projectHostedSync:prepare')
      .map(call => JSON.parse(call.args.request))
      .filter(request => request.kind === 'resolve');
    assert.equal(new Set(resolves.map(request => request.operationId)).size, 1);
  });

for (const obstruction of ['unknown metadata', 'unsaved edit'])
  test(`completed resolution reports and preserves ${obstruction}; original resolve replay recovers`, async t => {
    const s = await resolutionFixture(t, { overlap: true });
    s.f.moveMain({ overlap: true });
    await s.transport().dispatch('open', { laneId: s.f.lane.laneId });
    const conflict = (await s.transport().dispatch('sync', { laneId: s.f.lane.laneId })).result.conflict;
    await s.transport().dispatch('save', { operationId: randomUUID(), message: 'Parent mutation' });
    writeFileSync(join(conflict.root, 'a.txt'), 'chosen\nb\nc\n');
    const relative = obstruction === 'unknown metadata' ? '.forge/private-note.json' : 'a.txt';
    const path = join(conflict.root, relative);
    const command = { ...conflict.next };
    delete command.action;
    // Interleave after server publication, before the real local installer validates.
    const mutation = s.exchange.client.mutation;
    let inserted = false;
    s.exchange.client.mutation = async (ref, args) => {
      const result = await mutation(ref, args);
      if (!inserted && getFunctionName(ref) === 'projectHostedSyncJobs:submit') {
        inserted = true;
        writeFileSync(path, 'preserve these local bytes');
      }
      return result;
    };
    await assert.rejects(s.transport(conflict.root).dispatch('resolve', command), error => {
      assert.equal(error.code, 'WORK_CONFLICT');
      assert(error.message.includes(relative), error.message);
      assert.match(error.message, /Source already completed; only local apply is pending/);
      return true;
    });
    const resolved = await s.f.readLane(conflict.laneId);
    assert.equal(resolved.resolution.status, 'resolved');
    assert.equal(readFileSync(path, 'utf8'), 'preserve these local bytes');
    const jobs = s.calls.filter(call => call.name === 'projectHostedSyncJobs:submit').length;
    if (obstruction === 'unknown metadata') rmSync(path); // caller resolves its own obstruction
    else writeFileSync(path, 'chosen\nb\nc\n');
    const replay = await s.transport(conflict.root).dispatch('resolve', command);
    assert.equal(replay.result.applied.head, resolved.head);
    assert.equal(s.calls.filter(call => call.name === 'projectHostedSyncJobs:submit').length, jobs);
    assert.equal(readFileSync(join(conflict.root, 'a.txt'), 'utf8'), 'chosen\nb\nc\n');
  });

// Production wrappers must retain and execute recovery for both direct resolve and
// finish's reconciliation of an already-published source operation.
for (const wrapper of ['cli', 'mcp'])
  for (const entry of ['resolve', 'finish'])
    for (const interruption of [null, 'after-preserve', 'after-baseline', 'after-receipt'])
      test(`response-shape guard: ${wrapper} ${entry} local-apply blocker has executable preservation recovery (${interruption})`, async t => {
        const { hostedAgentCli } = await import('../dist/hosted-agent-cli.js');
        const { registerHostedAgentWorkflow } = await import('../dist/mcp-hosted-agent.js');
        const { describeFailure } = await import('../dist/system-errors.js');
        const { assertAgentResponseShape } = await import('./agent-response-shape.mjs');
        const s = await resolutionFixture(t, { overlap: true });
        s.f.moveMain({ overlap: true });
        await s.transport().dispatch('open', { laneId: s.f.lane.laneId });
        const conflict = (await s.transport().dispatch('sync', { laneId: s.f.lane.laneId })).result.conflict;
        writeFileSync(join(conflict.root, 'a.txt'), 'chosen\nb\nc\n');
        const { action, ...resolveCommand } = conflict.next;
        const transport = s.transport(conflict.root),
          tools = new Map();
        t.after(
          registerHostedAgentWorkflow(
            {
              registerTool(name, _config, call) {
                tools.set(name, call);
              },
            },
            transport,
          ),
        );
        const invoke = async (action, command) => {
          if (wrapper === 'cli') {
            try {
              return await hostedAgentCli(conflict.root, action, command, s.address, transport);
            } catch (error) {
              return { error: describeFailure(error) };
            }
          }
          const reply = await tools.get('forge_task')({ command: { action, ...command } }, {});
          return JSON.parse(reply.content[0].text);
        };
        const mutation = s.exchange.client.mutation;
        let inserted = false;
        s.exchange.client.mutation = async (ref, args) => {
          const result = await mutation(ref, args);
          if (!inserted && getFunctionName(ref) === 'projectHostedSyncJobs:submit') {
            inserted = true;
            writeFileSync(
              join(conflict.root, '.forge', 'private-note.json'),
              'keep all of these local bytes',
            );
            writeFileSync(join(conflict.root, 'extra-local.txt'), 'also preserve me');
          }
          return result;
        };
        const first = await invoke(action, resolveCommand);
        assert.equal(first.error.code, 'WORK_CONFLICT');
        const response =
          entry === 'finish' ? await invoke('finish', { message: 'Continue original work' }) : first;
        const next = assertAgentResponseShape(response, conflict.root);
        const recovery = response.error.recovery;
        assert.equal(recovery.operationId, resolveCommand.operationId);
        assert.equal(recovery.laneId, conflict.laneId);
        assert.equal(recovery.blockers[0].kind, 'unknown-metadata');
        const jobs = s.calls.filter(call => call.name === 'projectHostedSyncJobs:submit').length;
        if (interruption) {
          const fs = (await import('node:fs')).default;
          const { syncBuiltinESMExports } = await import('node:module');
          const rename = fs.renameSync;
          let interrupted = false;
          t.mock.method(fs, 'renameSync', (from, to) => {
            const value = rename(from, to);
            const match =
              interruption === 'after-preserve'
                ? from === conflict.root && String(to).endsWith('/checkout')
                : interruption === 'after-baseline'
                  ? String(from).includes('/baseline-') && to === conflict.root
                  : String(to).endsWith('/receipt.json') && JSON.parse(readFileSync(to)).restored;
            if (!interrupted && match) {
              interrupted = true;
              throw Error('Synthetic interrupted recovery');
            }
            return value;
          });
          syncBuiltinESMExports();
          let interruptedReply;
          try {
            interruptedReply = await invoke(next.action, next.body);
          } finally {
            fs.renameSync.mock.restore();
            syncBuiltinESMExports();
          }
          assert(interrupted);
          const resumed = assertAgentResponseShape(interruptedReply, conflict.root, recovery);
          assert.deepEqual(resumed.body, next.body);
          fs.mkdirSync(conflict.root, { recursive: true });
          writeFileSync(join(conflict.root, 'new-note.txt'), 'draft created after interruption');
          // A replay of the original source action also retains typed recovery,
          // even when its local marker was lost with the interrupted rename.
          const replayBlocked = await invoke(
            entry === 'finish' ? 'finish' : action,
            entry === 'finish' ? { message: 'Continue original work' } : resolveCommand,
          );
          assertAgentResponseShape(replayBlocked, conflict.root, recovery);
        }
        const recovered = await invoke(next.action, next.body);
        assert(!recovered.error, JSON.stringify(recovered));
        const retained = recovered.result;
        assert.equal(retained.status, 'applied');
        assert.equal(retained.applyOperationId, recovery.applyOperationId);
        assert.equal(
          readFileSync(join(retained.preservedAt, '.forge', 'private-note.json'), 'utf8'),
          'keep all of these local bytes',
        );
        assert.equal(readFileSync(join(retained.preservedAt, 'extra-local.txt'), 'utf8'), 'also preserve me');
        assert(retained.undo.includes(retained.preservedAt));
        if (interruption) {
          assert(retained.additionalPreservedAt?.some(path => existsSync(join(path, 'new-note.txt'))));
          const path = retained.additionalPreservedAt.find(path => existsSync(join(path, 'new-note.txt')));
          assert.equal(readFileSync(join(path, 'new-note.txt'), 'utf8'), 'draft created after interruption');
        }
        assert(!readdirSync(dirname(retained.preservedAt)).some(name => name.startsWith('baseline-')));
        const replay = await invoke(
          retained.next.action,
          Object.fromEntries(Object.entries(retained.next).filter(([key]) => key !== 'action')),
        );
        assert.equal(replay.result.next.action, 'finish');
        assert.equal(replay.result.applied.head, retained.applied.head);
        assert.equal(
          s.calls.filter(call => call.name === 'projectHostedSyncJobs:submit').length,
          jobs,
          'no source republication',
        );
        const again = await invoke(next.action, next.body);
        assert.equal(again.result.preservedAt, retained.preservedAt);
        assert.equal(again.result.applied.replayed, true);
      });

test('dead-end guard rejects incident error and unchanged retry while blockers remain', async () => {
  const { assertAgentResponseShape } = await import('./agent-response-shape.mjs');
  const root = '/synthetic';
  assert.throws(
    () =>
      assertAgentResponseShape(
        {
          error: {
            code: 'WORK_CONFLICT',
            message:
              'Source already completed; only local apply is pending. Retry the same original operation.',
          },
        },
        root,
      ),
    /lost its recovery/,
  );
  assert.throws(
    () =>
      assertAgentResponseShape(
        {
          error: {
            code: 'WORK_CONFLICT',
            message: 'Blocked',
            recovery: {
              phase: 'local-apply',
              status: 'blocked',
              sourceCompleted: true,
              operationId: 'retained',
              applyOperationId: 'apply',
              laneId: 'lane',
              root,
              from: { head: 'before' },
              to: { head: 'after' },
              blockers: [{ path: 'private', kind: 'extra-source' }],
              next: { action: 'resolve', operationId: 'retained' },
              command: `nforge agent '${root}' resolve '{"operationId":"retained"}'`,
            },
          },
        },
        root,
      ),
    /Unchanged retry/,
  );
});

test('preserved resolution checkout survives removal of all disposable client caches', async t => {
  const { recoverLocalApply } = await import('../dist/hosted-apply-recovery.js');
  const { ConvexLaneTransport } = await import('../dist/hosted-lane-transport.js');
  const s = await resolutionFixture(t, { overlap: true });
  s.f.moveMain({ overlap: true });
  await s.transport().dispatch('open', { laneId: s.f.lane.laneId });
  const conflict = (await s.transport().dispatch('sync', { laneId: s.f.lane.laneId })).result.conflict;
  writeFileSync(join(conflict.root, 'a.txt'), 'chosen\nb\nc\n');
  const mutation = s.exchange.client.mutation;
  let inserted = false;
  s.exchange.client.mutation = async (ref, args) => {
    const result = await mutation(ref, args);
    if (!inserted && getFunctionName(ref) === 'projectHostedSyncJobs:submit') {
      inserted = true;
      writeFileSync(join(conflict.root, '.forge', 'private-note.json'), 'keep beyond cache cleanup');
    }
    return result;
  };
  const { action, ...command } = conflict.next;
  let recovery;
  try {
    await s.transport(conflict.root).dispatch(action, command);
    assert.fail('obstruction expected');
  } catch (error) {
    recovery = error.recovery;
  }
  const result = await recoverLocalApply(
    conflict.root,
    recovery.applyOperationId,
    new ConvexLaneTransport(s.exchange),
  );
  assert(!result.preservedAt.startsWith(s.root + '.forge-client/'));
  rmSync(s.root + '.forge-client', { recursive: true, force: true });
  assert.equal(
    readFileSync(join(result.preservedAt, '.forge', 'private-note.json'), 'utf8'),
    'keep beyond cache cleanup',
  );
});
