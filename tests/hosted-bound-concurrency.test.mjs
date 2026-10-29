// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { finishFixture, compose } from './hosted-finish-fixture.mjs';
import { ConvexError } from 'convex/values';
import { HostedAgentTransport } from '../dist/hosted-agent-transport.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const synthetic = {
  FORGE_HOSTED_CHECK_KEY_ID: 'SYNTHETIC',
  FORGE_SOURCE_PROVIDER: 'modal',
  FORGE_SOURCE_WORKER: 'synthetic-worker',
  FORGE_SOURCE_RUNTIME: 'a'.repeat(64),
  FORGE_SOURCE_KEY_ID: 'SYNTHETIC',
  R2_ACCOUNT_ID: 'synthetic',
  R2_BUCKET: 'synthetic',
  R2_ACCESS_KEY_ID: 'synthetic',
  R2_SECRET_ACCESS_KEY: 'synthetic',
};
for (const count of [2, 8])
  test(`${count} concurrent finishes on one main settle through hosted CAS with no native owner`, async t => {
    const previous = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
    Object.assign(process.env, synthetic);
    t.after(() => {
      for (const [k, v] of Object.entries(previous)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
    const f = await finishFixture(t);
    const requests = [];
    for (let i = 0; i < count; i++) {
      const state = f.c.state(
        [f.c.baseFile, f.c.hidden, f.c.file(`concurrent-${i}.txt`, `submission ${i}\n`)],
        [f.c.baseline.sha256],
      );
      const lane = await f.c.lane(state),
        selection = f.c.selection([lane]);
      const candidate = await compose(f.c, selection);
      requests.push(
        f.request({
          candidateId: candidate.id,
          expectedHead: candidate.result.head,
          finish: { composeOperationId: selection.request.operationId, after: null },
        }),
      );
    }
    const directory = mkdtempSync(join(tmpdir(), 'forge-offline-finishes-'));
    t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    const transport = new HostedAgentTransport(
      join(directory, 'offline-client'),
      { url: 'https://fixture.invalid', projectId: f.projectId },
      {
        projectId: f.projectId,
        client: {
          mutation: async (_ref, args) => {
            try {
              return await f.enqueue(JSON.parse(args.request));
            } catch (error) {
              // The fake intentionally stops after the provider's finite OCC window.
              // Surface the same provider error the deployed adapter returns; retain
              // its retry budget and exercise the real transport reconciliation.
              if (error.code === 'ERR_ASSERTION' && error.message === 'bounded fake OCC retries')
                throw new ConvexError({
                  code: 'HOSTED_CONFLICT',
                  message: 'Synthetic provider OCC exhaustion.',
                });
              throw error;
            }
          },
        },
      },
    );
    const queued = await Promise.all(
      requests.map(r => transport.mutation('projectHostedLanding:enqueue', { request: JSON.stringify(r) })),
    );
    assert.equal(new Set(queued.map(s => s.id)).size, count);
    const states = async () => Promise.all(queued.map(s => f.current(s.id)));
    for (let round = 0; round < count * 4; round++) {
      await f.drain();
      await f.passChecks();
      await f.drain();
      if ((await states()).every(s => s.submission.observation.state !== 'pending')) break;
    }
    const final = await states();
    assert(
      final.every(s => ['landed', 'terminal-failed'].includes(s.submission.observation.state)),
      'each original request has a durable terminal outcome',
    );
    assert(
      final.every(s => s.submission.phase === 'landed'),
      'disjoint saved inputs all land',
    );
    assert(final.every(s => s.submission.error?.code !== 'WORK_STALE'));
    const files = JSON.parse(f.c.objects.get(f.currentMain().head).toString()).files;
    for (let i = 0; i < count; i++) assert(files.some(file => file.path === `concurrent-${i}.txt`));
    assert.equal(f.tables.projectHostedAcceptances.size, count);
    assert.equal(f.pending().length, 0);
    for (const [i, request] of requests.entries()) assert.equal((await f.enqueue(request)).id, queued[i].id);
    t.diagnostic(
      `metrics 2/3 fixture: ${count} finishes, 0 agent-visible WORK_STALE, 0 dropped submissions; owner process absent`,
    );
  });
