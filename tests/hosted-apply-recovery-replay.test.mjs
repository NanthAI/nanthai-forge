// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fixture } from './hosted-sync-client-fixture.mjs';
import { applyHostedSync } from '../dist/hosted-sync-client.js';
import { recoverLocalApply } from '../dist/hosted-apply-recovery.js';
import { clientCacheRoot } from '../dist/root-paths.js';
import { describeFailure } from '../dist/system-errors.js';
import { assertAgentResponseShape } from './agent-response-shape.mjs';

const boundaries = [
  'receipt',
  'stage-marker',
  'preserve',
  'baseline',
  'prior-backup',
  'restored-receipt',
  'apply-publication',
  'apply-receipt',
  'additional-receipt',
  'additional-preserve',
];
for (const boundary of boundaries)
  for (const timing of ['before', 'after'])
    test(`retained recovery converges with editor activity after SIGKILL ${timing} ${boundary}`, async t => {
      const s = await fixture(t),
        request = s.command();
      fs.writeFileSync(join(s.root, 'a'), 'original local draft');
      let retained;
      await assert.rejects(applyHostedSync(s.root, request, s.transport), error => {
        retained = error.recovery;
        return error.code === 'WORK_CONFLICT';
      });
      const previous = join(clientCacheRoot(s.root), 'previous');
      fs.mkdirSync(previous);
      fs.writeFileSync(join(previous, 'earlier-note'), 'prior installer bytes');
      const childEnv = { ...process.env };
      delete childEnv.NODE_TEST_CONTEXT;
      const crash = (boundary, timing) =>
        spawnSync(
          process.execPath,
          [fileURLToPath(new URL('./hosted-apply-recovery-crash-child.mjs', import.meta.url))],
          {
            env: childEnv,
            input: JSON.stringify({
              root: s.root,
              request,
              boundary,
              timing,
              objects: [...s.objects].map(([id, bytes]) => [id, bytes.toString('base64')]),
            }),
            encoding: 'utf8',
          },
        );
      if (boundary.startsWith('additional-')) {
        const first = crash('preserve', 'after');
        assert.equal(first.signal, 'SIGKILL', first.stdout + first.stderr);
        fs.mkdirSync(s.root, { recursive: true });
        fs.writeFileSync(join(s.root, 'between-crashes.txt'), 'draft between two interruptions');
      }
      const child = crash(boundary, timing);
      assert.equal(child.signal, 'SIGKILL', child.stdout + child.stderr);
      fs.mkdirSync(s.root, { recursive: true });
      fs.writeFileSync(join(s.root, 'new-note.txt'), 'new local draft after crash');
      let recovered;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          recovered = await recoverLocalApply(s.root, request.operationId, s.transport);
          break;
        } catch (error) {
          assertAgentResponseShape({ error: describeFailure(error) }, s.root, retained);
        }
      }
      assert.equal(recovered?.status, 'applied');
      assert.equal(recovered.applyOperationId, request.operationId);
      assert.equal(fs.readFileSync(join(recovered.preservedAt, 'a'), 'utf8'), 'original local draft');
      const notePaths = [s.root, recovered.preservedAt, ...(recovered.additionalPreservedAt ?? [])];
      assert(
        notePaths.some(path => fs.existsSync(join(path, 'new-note.txt'))),
        'recreated user content retained',
      );
      if (boundary.startsWith('additional-'))
        assert(
          notePaths.some(path => fs.existsSync(join(path, 'between-crashes.txt'))),
          'draft from the prior interrupted round retained',
        );
      assert.equal(
        fs.readFileSync(join(s.root, 'a'), 'utf8'),
        'after\n',
        'completed apply never reverts to its old baseline',
      );
      assert.equal(
        fs.readFileSync(join(recovered.priorPreservedAt, 'earlier-note'), 'utf8'),
        'prior installer bytes',
      );
      assert(
        !fs.readdirSync(dirname(recovered.preservedAt)).some(name => name.startsWith('baseline-')),
        'no unused baseline stage',
      );
      const replay = await recoverLocalApply(s.root, request.operationId, s.transport);
      assert.equal(replay.applied.replayed, true);
      assert.equal(replay.preservedAt, recovered.preservedAt);
    });

test('dead-end guard requires recovery for retained stale errors independently of wording', () => {
  const error = {
    code: 'WORK_STALE',
    message:
      'The client baseline changed before applying the pinned sync result. Retry the original hosted agent action and parameters to reconcile its retained operation.',
  };
  assert.throws(
    () => assertAgentResponseShape({ error }, '/synthetic', { sourceCompleted: true }),
    /lost its recovery/,
  );
  assert.throws(
    () => assertAgentResponseShape({ error: { ...error, message: 'Changed' } }, '/synthetic'),
    /lost its recovery/,
  );
  assert.throws(
    () =>
      assertAgentResponseShape({ error: { ...error, terminal: true } }, '/synthetic', {
        sourceCompleted: true,
      }),
    /lost its recovery/,
  );
  assert.equal(
    assertAgentResponseShape(
      { error: { code: 'FORBIDDEN', message: 'Access refused', terminal: true } },
      '/synthetic',
    ),
    undefined,
  );
});

test('concurrent recovery replays serialize their private baseline stage and preserve the same checkout', async t => {
  const s = await fixture(t),
    request = s.command();
  fs.writeFileSync(join(s.root, 'a'), 'concurrent recovery draft');
  await assert.rejects(applyHostedSync(s.root, request, s.transport), { code: 'WORK_CONFLICT' });
  const results = await Promise.all([
    recoverLocalApply(s.root, request.operationId, s.transport),
    recoverLocalApply(s.root, request.operationId, s.transport),
  ]);
  for (const result of results) {
    assert.equal(result.status, 'applied');
    assert.equal(fs.readFileSync(join(result.preservedAt, 'a'), 'utf8'), 'concurrent recovery draft');
    assert(!fs.readdirSync(dirname(result.preservedAt)).some(name => name.startsWith('baseline-')));
  }
  assert.equal(results[0].preservedAt, results[1].preservedAt);
  assert.equal(fs.readFileSync(join(s.root, 'a'), 'utf8'), 'after\n');
});

test('interrupted recovery keeps executable identities without exposing unstructured failure text', async t => {
  const { syncBuiltinESMExports } = await import('node:module');
  const s = await fixture(t),
    request = s.command();
  fs.writeFileSync(join(s.root, 'a'), 'preserve local draft');
  await assert.rejects(applyHostedSync(s.root, request, s.transport), { code: 'WORK_CONFLICT' });
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (from === s.root) throw Error('PRIVATE_UNSTRUCTURED_FAILURE_TEXT');
    return rename(from, to);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(recoverLocalApply(s.root, request.operationId, s.transport), error => {
      assert.equal(error.code, 'LOCAL_APPLY_INTERRUPTED');
      assert(!error.message.includes('PRIVATE_UNSTRUCTURED_FAILURE_TEXT'));
      const next = assertAgentResponseShape({ error: describeFailure(error) }, s.root, {
        sourceCompleted: true,
        applyOperationId: request.operationId,
      });
      assert.equal(next.body.applyOperationId, request.operationId);
      return true;
    });
  } finally {
    fs.renameSync.mock.restore();
    syncBuiltinESMExports();
  }
  const recovered = await recoverLocalApply(s.root, request.operationId, s.transport);
  assert.equal(recovered.status, 'applied');
  assert.equal(fs.readFileSync(join(recovered.preservedAt, 'a'), 'utf8'), 'preserve local draft');
});
