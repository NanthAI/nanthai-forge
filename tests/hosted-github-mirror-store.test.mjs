// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { effectivePolicy, policyPreset } from '../dist/autonomy-policy.js';
import { mirrorFixture } from './hosted-github-mirror-fixture.mjs';
import { acceptanceFixture } from './hosted-acceptance-fixture.mjs';
const queue = await import(moduleUrl('../convex/projectGithubMirrorQueue.ts'));
const store = await import(moduleUrl('../convex/projectGithubMirrorStore.ts'));
const objects = await import(moduleUrl('../convex/projectGithubMirrorObjects.ts'));
const action = await import(moduleUrl('../convex/projectGithubMirror.ts'));

/** Owner-proven repository bindings are a deployment setting; tests bind their own synthetic project. */
const bindRepository = (t, projectId, repo) => {
  const prior = process.env.FORGE_GITHUB_REPO_BINDINGS;
  process.env.FORGE_GITHUB_REPO_BINDINGS = `${projectId}=${repo}`;
  t.after(() => {
    if (prior === undefined) delete process.env.FORGE_GITHUB_REPO_BINDINGS;
    else process.env.FORGE_GITHUB_REPO_BINDINGS = prior;
  });
};

function fixture() {
  const f = lanesFixture(),
    scheduled = [],
    blobs = new Map();
  const projectId = f.insert('hostedProjects', {
    key: 'synthetic',
    name: 'Synthetic',
    currentBackup: null,
    revision: 0,
    owner: 'owner',
    sourceAuthority: { mode: 'server', epoch: 1 },
    autonomyPolicy: {
      ...policyPreset('supervised'),
      githubMirror: { repo: 'synthetic/mirror', autoPush: true, laneRefs: false },
    },
  });
  f.decorateContext(ctx => {
    ctx.db.system = { get: ctx.db.get };
    ctx.scheduler = {
      runAfter: async (_delay, ref, args) => {
        scheduled.push({ name: getFunctionName(ref), args });
        return `scheduled-${scheduled.length}`;
      },
    };
  });
  const run = (name, fn, input) => f.transaction(name, { _handler: fn }, input);
  const receipt = () => ({
    id: randomUUID(),
    authorityEpoch: 1,
    snapshot: { revision: scheduled.length + 1 },
    candidate: { head: 'a'.repeat(64) },
  });
  const enqueue = r =>
    run('enqueueMirror', async ctx => queue.enqueueGithubMirror(ctx, await ctx.db.get(projectId), r));
  return { ...f, run, projectId, scheduled, blobs, receipt, enqueue };
}
test('idle schedules zero; acceptance wakes once; retries and queued landings serialize', async () => {
  const f = fixture();
  assert.equal(f.scheduled.length, 0);
  const first = f.receipt();
  await f.enqueue(first);
  await f.enqueue(first);
  const second = f.receipt();
  await f.enqueue(second);
  assert.equal(f.scheduled.length, 1);
  const original = f.scheduled[0].args;
  const entry = { ...mirrorFixture().root, acceptanceId: first.id, state: first.candidate.head };
  await f.run('commitMirror', store.commit._handler, {
    ...original,
    cursor: null,
    mapping: JSON.stringify(entry),
  });
  assert.equal(f.scheduled.length, 2, 'exactly one next job');
  await f.run('replayCommit', store.commit._handler, {
    ...original,
    cursor: null,
    mapping: JSON.stringify(entry),
  });
  assert.equal(f.scheduled.length, 2);
  const next = f.scheduled[1].args;
  await f.run('commitMirror', store.commit._handler, {
    ...next,
    cursor: null,
    mapping: JSON.stringify({ ...entry, acceptanceId: second.id }),
  });
  assert.equal(f.scheduled.length, 2, 'drained queue has no idle wake');
  assert.equal([...f.tables.projectGithubMirrors.values()][0].activeId, null);
});
test('policy disabled, native authority and changed repository never block main or schedule work', async () => {
  const f = fixture();
  const project = f.tables.hostedProjects.get(f.projectId);
  f.patch('hostedProjects', f.projectId, { sourceAuthority: { mode: 'native-owner', epoch: 1 } });
  await f.enqueue(f.receipt());
  f.patch('hostedProjects', f.projectId, {
    sourceAuthority: project.sourceAuthority,
    autonomyPolicy: {
      ...project.autonomyPolicy,
      githubMirror: { repo: 'synthetic/mirror', autoPush: false, laneRefs: false },
    },
  });
  await f.enqueue(f.receipt());
  assert.equal(f.scheduled.length, 0);
  f.patch('hostedProjects', f.projectId, project);
  await f.enqueue(f.receipt());
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: {
      ...project.autonomyPolicy,
      githubMirror: { repo: 'synthetic/other', autoPush: true, laneRefs: false },
    },
  });
  await f.enqueue(f.receipt());
  assert.equal(f.scheduled.length, 1);
  assert([...f.tables.projectGithubMirrorJobs.values()].some(j => j.error === 'GITHUB_SYNC_BINDING'));
});
test('continuations fence stale actions and failure recovery resumes the same step', async () => {
  const f = fixture();
  await f.enqueue(f.receipt());
  const input = f.scheduled[0].args;
  await f.run('advanceMirror', store.commit._handler, { ...input, cursor: 'cursor-1', mapping: null });
  assert.equal(f.scheduled.length, 2);
  await f.run('oldFailure', store.failed._handler, {
    ...input,
    code: 'GITHUB_SYNC_FAILED',
    detail: 'old failure',
  });
  const active = f.scheduled[1].args;
  await f.run('mirrorFailed', store.failed._handler, {
    ...active,
    code: 'GITHUB_SYNC_CHANGED',
    detail: 'GitHub main moved',
  });
  assert.equal(f.scheduled.length, 2, 'failure never installs a poller');
  await f.run('mirrorResume', store.resume._handler, { jobId: active.jobId });
  assert.deepEqual(f.scheduled[2].args, { ...active, step: active.step + 2 });
});
test('source resolution batches 100 descriptors with bounded document reads, fails closed on changed authority', async t => {
  const f = fixture();
  await f.enqueue(f.receipt());
  const input = f.scheduled[0].args,
    digests = [];
  for (let i = 0; i < 100; i++) {
    const digest = i.toString(16).padStart(64, '0');
    digests.push(digest);
    f.insert('projectObjects', {
      projectId: f.projectId,
      digest,
      size: 4,
      nonce: 'synthetic',
      storageId: `storage-${i}`,
      removed: false,
    });
  }
  const result = JSON.parse(
    await f.run(
      'resolveMirror',
      (ctx, input) => {
        delete ctx.db.patch;
        return objects.resolve._handler(ctx, input);
      },
      { ...input, digests },
    ),
  );
  assert.equal(result.length, 100);
  const counts = f.counts.at(-1);
  assert(counts.documents <= 105, 'one function call per 100 source objects');
  assert.equal(counts.writes, 0);
  assert(!counts.touched.includes('projectWorkRecords'));
  f.patch('hostedProjects', f.projectId, { sourceAuthority: { mode: 'native-owner', epoch: 2 } });
  await assert.rejects(
    f.run(
      'resolveMirror',
      (ctx, input) => {
        delete ctx.db.patch;
        return objects.resolve._handler(ctx, input);
      },
      { ...input, digests },
    ),
    e => e.code === 'SOURCE_AUTHORITY_CHANGED',
  );
  t.diagnostic(
    JSON.stringify({
      descriptors: 100,
      calls: 1,
      documents: counts.documents,
      writes: counts.writes,
      readBytes: counts.readBytes,
    }),
  );
});
test('real hosted main publication queues exactly one mirror even when completion is disabled', async () => {
  const f = await acceptanceFixture();
  const project = f.tables.hostedProjects.get(f.projectId);
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: {
      ...effectivePolicy(project),
      githubMirror: { repo: 'synthetic/mirror', autoPush: true, laneRefs: false },
    },
  });
  const { state } = await f.ready();
  const result = await f.accept(state);
  assert.equal(result.status, 'landed');
  await f.accept(state);
  const mirrors = [...f.tables._scheduled_functions.values()].filter(
    t => t.name === 'projectGithubMirror:step',
  );
  assert.equal(mirrors.length, 1);
  assert.equal([...f.tables.projectGithubMirrorJobs.values()][0].state, result.receipt.candidate.head);
});
test('source action verifies raw hashes and reconstructs recipes using project-bound descriptors', async () => {
  const { digest } = await import('../dist/hash.js');
  const { buildObjectRecipe } = await import('../dist/object-chunks.js');
  const data = Buffer.alloc(3 * 1024 * 1024, 77),
    built = buildObjectRecipe(data);
  const raw = new Map(built.objects);
  raw.set(digest(built.bytes), built.bytes);
  const logical = { sha256: digest(data), size: data.length };
  const calls = [];
  const reader = action.mirrorSource(
    {
      runQuery: async (_ref, input) => {
        calls.push(input.digests.length);
        return JSON.stringify(
          input.digests.map(id => ({
            descriptor:
              id === logical.sha256
                ? { object: logical, recipe: { sha256: digest(built.bytes), size: built.bytes.length } }
                : { object: { sha256: id, size: raw.get(id).length }, recipe: null },
            storageId: id,
            url: null,
          })),
        );
      },
      storage: { get: async id => new Blob([raw.get(id)]) },
    },
    { jobId: 'synthetic', step: 0 },
  );
  const [blob] = await reader.blobs([logical.sha256]);
  assert.deepEqual(await blob.read(), data);
  assert(calls.every(n => n <= 100));
  raw.set(digest(built.bytes), Buffer.from('wrong bytes'));
  const [bad] = await reader.blobs([logical.sha256]);
  await assert.rejects(bad.read(), e => e.code === 'SOURCE_HASH_MISMATCH');
});

for (const { files, gitlinks = false } of [
  { files: 0 },
  { files: 2 },
  { files: 5000 },
  { files: 5000, gitlinks: true },
])
  test(`real Convex action mirrors ${files} changed ${gitlinks ? 'gitlinks' : 'files'} with bounded calls`, async t => {
    const f = await acceptanceFixture();
    bindRepository(t, f.projectId, 'synthetic/mirror');
    const project = f.tables.hostedProjects.get(f.projectId);
    f.patch('hostedProjects', f.projectId, {
      autonomyPolicy: {
        ...effectivePolicy(project),
        githubMirror: { repo: 'synthetic/mirror', autoPush: true, laneRefs: false },
      },
    });
    const { state, item } = await f.ready();
    const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
    await f.runAcceptance('mirrorSeedIntent', records.writeHostedRecord, {
      ...f.auth,
      expectedVersion: null,
      record: {
        kind: 'intent',
        id: item.candidate.intentId,
        version: 0,
        at: '2026-01-01T00:00:00.000Z',
        outcome: 'An accepted outcome',
        constraints: '',
        creatorAccountId: 'owner',
        assigneeAccountIds: [],
        base: { head: f.main.head, receiptId: f.main.receipt.id },
        status: 'active',
      },
    });
    const accepted = await f.accept(state);
    const input = [...f.tables._scheduled_functions.values()].find(t => t.name === 'projectGithubMirror:step')
      .args[0];
    const before = {},
      after = {};
    for (let i = 0; i < files; i++) {
      before[`file-${i}`] = gitlinks
        ? { mode: 'gitlink', text: i.toString(16).padStart(40, '0') }
        : `old ${i}`;
      after[`file-${i}`] = gitlinks
        ? { mode: 'gitlink', text: (i + files).toString(16).padStart(40, '0') }
        : `new ${i}`;
    }
    const github = mirrorFixture({ before, after });
    const receiptRow = [...f.tables.projectHostedAcceptances.values()][0];
    f.patch('projectHostedAcceptances', receiptRow._id, {
      value: JSON.stringify({
        ...accepted.receipt,
        previous: { ...accepted.receipt.previous, head: github.seed.previous },
        candidate: { ...accepted.receipt.candidate, head: github.head },
      }),
    });
    f.patch('projectGithubMirrorJobs', input.jobId, { state: github.head });
    const queueRow = [...f.tables.projectGithubMirrors.values()][0];
    f.patch('projectGithubMirrors', queueRow._id, { mapping: JSON.stringify(github.root) });
    const storage = new Map();
    for (const [id, value] of github.states) storage.set(id, new Blob([JSON.stringify(value)]));
    for (const [id, value] of github.objects) storage.set(id, new Blob([value]));
    for (const [id, blob] of storage)
      f.insert('projectObjects', {
        projectId: f.projectId,
        digest: id,
        size: blob.size,
        removed: false,
        nonce: 'synthetic',
        storageId: id,
      });
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const names = [
      'GITHUB_APP_ID',
      'GITHUB_APP_PRIVATE_KEY',
      'FORGE_GITHUB_SYNC_NAME',
      'FORGE_GITHUB_SYNC_EMAIL',
    ];
    const prior = Object.fromEntries(names.map(name => [name, process.env[name]]));
    Object.assign(process.env, {
      GITHUB_APP_ID: '123',
      GITHUB_APP_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      FORGE_GITHUB_SYNC_NAME: 'Forge Sync',
      FORGE_GITHUB_SYNC_EMAIL: files === 0 ? 'noreply@forge.example' : '123+fixture@users.noreply.github.com',
    });
    const previousFetch = globalThis.fetch,
      calls = [],
      authCalls = [];
    globalThis.fetch = async (url, init) => {
      if (new URL(url).hostname.endsWith('.r2.cloudflarestorage.com')) return previousFetch(url, init);
      if (url.endsWith('/installation')) {
        authCalls.push(url);
        return new Response(JSON.stringify({ id: 42 }));
      }
      if (url.includes('/access_tokens')) {
        authCalls.push(url);
        return new Response(JSON.stringify({ token: 'synthetic-token' }));
      }
      return new Response(
        JSON.stringify(
          await github.io.api(new URL(url).pathname, init.method, init.body && JSON.parse(init.body)),
        ),
      );
    };
    t.after(() => {
      globalThis.fetch = previousFetch;
      for (const name of names) {
        if (prior[name] === undefined) delete process.env[name];
        else process.env[name] = prior[name];
      }
    });
    const modules = { begin: store.begin, commit: store.commit, failed: store.failed };
    const ctx = {
      runMutation: async (ref, args) => {
        const name = getFunctionName(ref);
        calls.push(name);
        const result = await f.transaction('mirrorMutation', modules[name.split(':')[1]], args);
        if (files === 2 && name.endsWith(':begin') && calls.length === 1) {
          process.env.FORGE_GITHUB_SYNC_NAME = 'Changed after lost begin reply';
          calls.push(`${name} (lost reply retry)`);
          const replay = await f.transaction('mirrorMutation', store.begin, args);
          assert.equal(
            result,
            replay,
            'the original commit identity and message are durable before API writes',
          );
        }
        return result;
      },
      runQuery: async (ref, args) => {
        const name = getFunctionName(ref);
        calls.push(name);
        return f.transaction(
          'mirrorQuery',
          {
            _handler: (ctx, input) => {
              delete ctx.db.patch;
              return objects.resolve._handler(ctx, input);
            },
          },
          args,
        );
      },
      storage: {
        get: async id => storage.get(id),
        store: async blob => {
          const id = `cursor-${storage.size}`;
          storage.set(id, blob);
          return id;
        },
      },
    };
    const start = performance.now();
    await action.step._handler(ctx, input);
    let job = f.tables.projectGithubMirrorJobs.get(input.jobId);
    while (job.status === 'running') {
      await action.step._handler(ctx, { jobId: job._id, step: job.step });
      job = f.tables.projectGithubMirrorJobs.get(input.jobId);
    }
    assert.equal(job.status, 'done', job.detail);
    assert.equal(JSON.parse(job.mapping).state, github.head);
    assert.equal(JSON.parse(job.mapping).committer.name, 'Forge Sync');
    if (files === 0) assert.equal(JSON.parse(job.mapping).committer.email, 'noreply@forge.example');
    assert.equal(JSON.parse(job.mapping).message, JSON.parse(job.seed).message);
    const steps = Math.max(1, Math.ceil(files / 100));
    assert.equal(calls.length, 2 * steps + 1 + (files ? steps : 0) + (files === 2 ? 1 : 0));
    assert.equal(authCalls.length, 2 * steps);
    assert.equal(JSON.parse(job.mapping).tree, github.expected());
    const metrics = f.counts.filter(c => c.name.startsWith('mirrorMutation') || c.name === 'mirrorQuery');
    assert(metrics.every(c => c.documents <= 105 && c.writes <= 3));
    assert(!metrics.some(c => c.touched.includes('projectWorkRecords')));
    assert.equal(github.calls.length, files ? (gitlinks ? 4 : files + 4) : 1);
    const completedCalls = calls.length;
    await action.step._handler(ctx, input);
    assert.equal(github.commits.size, files ? 2 : 1, 'replay creates no second commit');
    assert.equal(calls.length, completedCalls + 1);
    t.diagnostic(
      JSON.stringify({
        files,
        gitlinks,
        convexCalls: completedCalls,
        documents: metrics.reduce((n, c) => n + c.documents, 0),
        writes: metrics.reduce((n, c) => n + c.writes, 0),
        steps,
        authCalls: authCalls.length,
        gitDataCalls: github.calls.length,
        elapsedMs: performance.now() - start,
        rssBytes: process.memoryUsage().rss,
      }),
    );
  });
