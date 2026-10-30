// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { landingApi } from './hosted-finish-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { hostedConflictAdvice } from '../dist/hosted-agent-resolution.js';
import { getFunctionName } from 'convex/server';
const composeApi = await import(moduleUrl('../convex/projectHostedCompose.ts'));
const prior = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
test('batch-member conflict advice names the rejected current Candidate and paths using only finite reads', async t => {
  const f = await batchesFixture(t, { conflict: true });
  await f.drain();
  await f.passChecks();
  await f.drain();
  const failed = states(f).find(state => state.error?.code === 'COMPOSITION_CONFLICT');
  assert(failed);
  const directory = mkdtempSync(join(tmpdir(), 'forge-conflict-advice-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const before = f.counts.length;
  const session = {
    root: join(directory, 'client'),
    exchange: {
      projectId: f.projectId,
      client: {
        mutation: async (ref, args) => {
          assert.equal(getFunctionName(ref), 'projectObjectDownloads:lanePage');
          assert.equal(args.projectId, f.projectId);
          // The fixture supplies conflict bytes through downloadBatch below.
          return args.digests.map(digest => ({ digest, size: f.c.objects.get(digest).length }));
        },
      },
      objects: async ids => ids.map(sha256 => ({ sha256, size: f.c.objects.get(sha256).length })),
      downloadBatch: async pins => pins.map(pin => f.c.objects.get(pin.sha256)),
    },
    query: async (name, args) =>
      JSON.parse(
        await f.transaction(
          'advice-read',
          name === 'projectHostedLanding:status' ? landingApi.status : composeApi.candidate,
          { projectId: f.projectId, ...args },
        ),
      ),
  };
  const result = await hostedConflictAdvice(session, { submission: failed });
  assert.notEqual(result.conflict.candidateId, failed.request.candidateId);
  assert(result.conflict.paths.length > 0 && result.conflict.paths.length <= 100);
  assert.equal(result.conflict.next.candidateId, result.conflict.candidateId);
  assert(result.conflict.command.includes(JSON.stringify({ candidateId: result.conflict.candidateId })));
  assert(failed.error.message.includes(JSON.stringify({ candidateId: result.conflict.candidateId })));
  assert(f.counts.slice(before).every(call => call.writes === 0));
  f.patch('hostedProjects', f.projectId, { removal: 'deleted' });
  await assert.rejects(
    hostedConflictAdvice(session, { submission: failed }),
    error => (error.data?.code ?? error.code) === 'PROJECT_UNAVAILABLE',
  );
});
