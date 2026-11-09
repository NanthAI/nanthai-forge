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
    const supplied = files
      ? 'Keep the supplied subject\n\nKeep the body.\n\nReviewed-by: Synthetic Reviewer <review@example.invalid>\nCo-Authored-By: Synthetic Sol <noreply@openai.com>'
      : undefined;
    const { state, item } = await f.ready(null, supplied === undefined ? {} : { message: supplied });
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
    assert.equal(accepted.receipt.message, supplied);
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
        assert.deepEqual(JSON.parse(init.body).permissions, { contents: 'write' });
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
    assert.equal(
      JSON.parse(job.seed).message,
      `${supplied ?? 'An accepted outcome'}\n\nForge-State: ${github.head}\nForge-Acceptance: ${accepted.receipt.id}\nForge-View: ${accepted.receipt.candidate.id}`,
    );
    if (files) assert.equal(github.commits.get(github.remote()).message, JSON.parse(job.seed).message);
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

const inboundModule = await import(moduleUrl('../convex/projectGithubInboundQueue.ts'));
/** Two-way sync on the same synthetic project, with one published mirror commit recorded. */
async function twoWayFixture(inbound = true) {
  const f = fixture();
  const project = f.tables.hostedProjects.get(f.projectId);
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: {
      ...project.autonomyPolicy,
      githubMirror: { repo: 'Synthetic/Mirror', autoPush: true, laneRefs: false, inbound },
    },
  });
  const first = f.receipt();
  await f.enqueue(first);
  const entry = { ...mirrorFixture().root, acceptanceId: first.id, state: first.candidate.head };
  await f.run('commitMirror', store.commit._handler, {
    ...f.scheduled[0].args,
    cursor: null,
    mapping: JSON.stringify(entry),
  });
  const receive = after =>
    f.run('inboundReceive', inboundModule.receive._handler, {
      repository: 'synthetic/mirror',
      ref: 'refs/heads/main',
      after,
    });
  const queueRow = () => [...f.tables.projectGithubMirrors.values()][0];
  const jobs = () => [...f.tables.projectGithubMirrorJobs.values()];
  return { ...f, entry, first, receive, queueRow, jobs };
}
test('two-way: a GitHub push queues one inbound job; Forge pushes and one-way mirrors write nothing', async () => {
  const f = await twoWayFixture();
  assert.equal(f.queueRow().repositoryKey, 'synthetic/mirror');
  const scheduled = f.scheduled.length;
  await f.receive(f.entry.commit);
  const own = f.counts.at(-1);
  assert.equal(own.writes, 0, 'Forge’s own push writes nothing');
  assert(own.documents <= 2, `own push reads ${own.documents}`);
  await f.run('inboundReceive', inboundModule.receive._handler, {
    repository: 'synthetic/mirror',
    ref: 'refs/heads/other',
    after: 'b'.repeat(40),
  });
  assert.equal(f.scheduled.length, scheduled);
  await f.receive('b'.repeat(40));
  await f.receive('c'.repeat(40));
  const inbound = f.jobs().filter(job => job.inbound);
  assert.equal(inbound.length, 1, 'pushes coalesce while the job waits');
  assert.equal(inbound[0].sequence, 0);
  assert.equal(f.queueRow().activeId, inbound[0]._id);
  assert.equal(f.scheduled.length, scheduled + 1, 'one wake, no poller');
  assert.equal(f.scheduled.at(-1).name, 'projectGithubMirror:step');
  const oneWay = await twoWayFixture(false);
  const before = oneWay.scheduled.length;
  await oneWay.receive('b'.repeat(40));
  assert.equal(oneWay.counts.at(-1).writes, 0);
  assert.equal(oneWay.scheduled.length, before);
});
test('two-way: a publish that finds GitHub main moved yields to an inbound job instead of failing', async () => {
  const f = await twoWayFixture();
  const second = f.receipt();
  await f.enqueue(second);
  const publish = f.scheduled.at(-1).args;
  await f.run('mirrorFailed', store.failed._handler, {
    ...publish,
    code: 'GITHUB_SYNC_CHANGED',
    detail: 'GitHub main moved unexpectedly.',
  });
  const job = f.tables.projectGithubMirrorJobs.get(publish.jobId);
  assert.equal(job.status, 'queued');
  assert.equal(job.error, undefined);
  assert.equal(job.seed, undefined, 'it re-seeds from the mapping the inbound job records');
  const inbound = f.jobs().find(row => row.inbound);
  assert.equal(f.queueRow().activeId, inbound._id);
  assert.deepEqual(f.scheduled.at(-1).args, { jobId: inbound._id, step: 0 });
});
test('two-way: the inbound landing settles with the acceptance that landed it', async () => {
  for (const phase of ['landed', 'terminal-failed']) {
    const f = await twoWayFixture();
    // A Forge landing accepted while the inbound one was in flight waits behind it.
    await f.receive('b'.repeat(40));
    const job = f.jobs().find(row => row.inbound);
    const waiting = f.receipt();
    await f.enqueue(waiting);
    const older = f.jobs().find(row => row.receiptId === waiting.id);
    assert.equal(older.status, 'queued');
    const submissionId = randomUUID(),
      laneId = randomUUID();
    f.patch('projectGithubMirrorJobs', job._id, {
      status: 'running',
      inbound: JSON.stringify({
        phase: 'landing',
        commit: 'b'.repeat(40),
        tree: 'd'.repeat(40),
        message: 'Merge pull request #1',
        equivalent: 'e'.repeat(64),
        base: { head: f.first.candidate.head, receiptId: f.first.id },
        laneId,
        landingOperationId: randomUUID(),
        submissionId,
      }),
    });
    const landing = 'landing-row';
    // Pending: an acceptance changes nothing but queues its publish.
    f.tables.projectHostedLandingRequests.set(landing, {
      _id: landing,
      _creationTime: 1,
      projectId: f.projectId,
      submissionId,
      phase: 'checking',
      value: JSON.stringify({ phase: 'checking', error: null }),
    });
    const pendingReceipt = f.receipt();
    await f.enqueue(pendingReceipt);
    assert.equal(f.queueRow().activeId, job._id, 'the inbound job holds the queue while it lands');
    f.tables.projectHostedLandingRequests.set(landing, {
      ...f.tables.projectHostedLandingRequests.get(landing),
      phase,
      value: JSON.stringify({
        phase,
        error: phase === 'landed' ? null : { code: 'CHECK_NOT_PASSED', message: 'A test failed.' },
      }),
    });
    const base = f.receipt();
    const settled = {
      ...base,
      candidate: { ...base.candidate, id: randomUUID() },
      snapshot: { revision: 100 },
    };
    await f.enqueue(settled);
    const done = f.tables.projectGithubMirrorJobs.get(job._id);
    const mapping = JSON.parse(f.queueRow().mapping);
    assert.equal(mapping.commit, 'b'.repeat(40));
    assert.equal(mapping.tree, 'd'.repeat(40));
    assert.equal(mapping.state, 'e'.repeat(64), 'GitHub’s commit stands for its own tree');
    assert.equal(mapping.parent, f.entry.commit);
    const outcome = JSON.parse(f.queueRow().inbound);
    if (phase === 'landed') {
      assert.equal(done.status, 'done');
      assert.equal(mapping.acceptanceId, settled.id);
      for (const id of [waiting.id, pendingReceipt.id])
        assert.equal(
          f.jobs().find(row => row.receiptId === id).status,
          'done',
          'older publishes are contained',
        );
      const next = f.jobs().find(row => row.receiptId === settled.id);
      assert.equal(f.queueRow().activeId, next._id);
      assert.equal(outcome.note, undefined);
    } else {
      assert.equal(done.status, 'failed');
      assert.equal(done.error, 'GITHUB_INBOUND_FAILED');
      assert.match(done.detail, /did not land on Forge/);
      assert.equal(mapping.acceptanceId, f.first.id, 'the next inbound Lane starts from accepted main');
      const older2 = f.jobs().find(row => row.receiptId === waiting.id);
      assert.equal(f.queueRow().activeId, older2._id, 'older publishes run first, in order');
      assert.equal(f.jobs().find(row => row.receiptId === settled.id).status, 'queued');
      assert.equal(outcome.note, true);
      assert.equal(outcome.error, 'CHECK_NOT_PASSED: A test failed.');
    }
  }
});
const pullQueue = await import(moduleUrl('../convex/projectGithubPullQueue.ts'));
const prHead = (f, head, number = 7) =>
  f.run('pullReceive', pullQueue.receive._handler, {
    repository: 'Synthetic/Mirror',
    number,
    head,
    fork: true,
  });
const pullJobs = (f, number) => f.jobs().filter(job => job.pullKey === String(number));
const pullOf = job => JSON.parse(job.inbound).pull;
test('two-way PR: a head queues one check job; redelivery writes nothing; a newer head drops an unstarted one', async () => {
  const f = await twoWayFixture();
  const scheduled = f.scheduled.length;
  await prHead(f, 'b'.repeat(40));
  const [first] = pullJobs(f, 7);
  assert.equal(first.sequence, 0.5, 'after an inbound push job (0), before publishes');
  assert.deepEqual(JSON.parse(first.inbound), {
    phase: 'pending',
    pull: { number: 7, head: 'b'.repeat(40), fork: true },
  });
  assert.equal(f.queueRow().activeId, first._id);
  assert.equal(f.scheduled.length, scheduled + 1, 'one wake, no poller');
  assert.equal(f.scheduled.at(-1).name, 'projectGithubMirror:step');
  await prHead(f, 'b'.repeat(40));
  assert.equal(f.counts.at(-1).writes, 0, 'a redelivered head writes nothing');
  assert(f.counts.at(-1).documents <= 4, `redelivery reads ${f.counts.at(-1).documents}`);
  await prHead(f, 'd'.repeat(40), 8);
  const [waiting] = pullJobs(f, 8);
  assert.equal(waiting.status, 'queued');
  await prHead(f, 'e'.repeat(40), 8);
  const dropped = f.tables.projectGithubMirrorJobs.get(waiting._id);
  assert.equal(dropped.status, 'done');
  assert.equal(pullOf(dropped).outcome, 'superseded');
  assert.equal(pullJobs(f, 8).length, 2);
  assert.equal(f.scheduled.length, scheduled + 1, 'a dropped head posted nothing and woke nothing');
  // A GitHub push still gets its own inbound job; a queued PR job is not one to coalesce into.
  await f.receive('f'.repeat(40));
  const push = f.jobs().filter(job => job.inbound && !job.pullKey);
  assert.equal(push.length, 1);
  assert.equal(push[0].sequence, 0);
  const oneWay = await twoWayFixture(false);
  const before = oneWay.scheduled.length;
  await prHead(oneWay, 'b'.repeat(40));
  assert.equal(oneWay.counts.at(-1).writes, 0);
  assert.equal(oneWay.scheduled.length, before);
});
test('two-way PR: a terminal job failure releases the queue and settles forge/verify as error', async () => {
  const f = await twoWayFixture();
  await prHead(f, 'b'.repeat(40));
  const receipt = f.receipt();
  await f.enqueue(receipt);
  const [job] = pullJobs(f, 7);
  await f.run('mirrorFailed', store.failed._handler, {
    jobId: job._id,
    step: job.step,
    code: 'GITHUB_PULL_BEHIND',
    detail: 'The PR and GitHub main both changed src/a.ts; update the branch from main.',
  });
  const failed = f.tables.projectGithubMirrorJobs.get(job._id);
  assert.equal(failed.status, 'failed');
  assert.equal(pullOf(failed).outcome, 'error');
  const next = f.jobs().find(row => row.receiptId === receipt.id);
  assert.equal(f.queueRow().activeId, next._id, 'publishes never wait behind a failed PR check');
  const post = f.scheduled.find(row => row.name === 'projectGithubPullStatus:post');
  assert.equal(post.args.state, 'error');
  assert.equal(post.args.sha, 'b'.repeat(40));
  assert.match(post.args.description, /^GITHUB_PULL_BEHIND: /);
  assert(post.args.description.length <= 140);
});
test('two-way PR: the check run settles forge/verify once; a newer head supersedes a checking one', async () => {
  const f = await twoWayFixture();
  await prHead(f, 'b'.repeat(40));
  const [job] = pullJobs(f, 7);
  const { pullOperationId } = await import('../dist/github-pull-check.js');
  const runId = randomUUID(),
    composeOperationId = pullOperationId(),
    checkOperationId = pullOperationId(),
    laneId = randomUUID();
  const run = (id, operationId = checkOperationId) => ({
    projectId: f.projectId,
    id,
    status: 'passed',
    request: { operationId },
  });
  const checking = waitKey =>
    f.patch('projectGithubMirrorJobs', job._id, {
      status: 'done',
      waitKey,
      inbound: JSON.stringify({
        phase: 'checking',
        pull: { number: 7, head: 'b'.repeat(40), fork: true, ...(waitKey === runId ? { runId } : {}) },
        laneId,
        composeOperationId,
      }),
    });
  checking(composeOperationId);
  await f.run('composeDone', ctx => pullQueue.notifyPullCompose(ctx, f.projectId, composeOperationId));
  assert.deepEqual(f.scheduled.at(-1), {
    name: 'projectGithubPull:start',
    args: { jobId: job._id, key: composeOperationId },
  });
  checking(runId);
  // Every other run (version 4 operation id) skips the lookup: zero reads.
  await f.run('otherRun', ctx => pullQueue.notifyPullCheck(ctx, run(runId, randomUUID())));
  assert.equal(f.counts.at(-1).documents, 0, 'a non-PR run reads nothing');
  await f.run('otherCompose', ctx => pullQueue.notifyPullCompose(ctx, f.projectId, randomUUID()));
  assert.equal(f.counts.at(-1).documents, 0, 'a non-PR composition reads nothing');
  await f.run('otherPullRun', ctx => pullQueue.notifyPullCheck(ctx, run(randomUUID())));
  assert.equal(f.counts.at(-1).writes, 0, 'an unknown PR run reads one empty index range');
  await f.run('runDone', ctx => pullQueue.notifyPullCheck(ctx, run(runId)));
  const settle = f.scheduled.at(-1);
  assert.equal(settle.name, 'projectGithubPullQueue:settle');
  assert.deepEqual(settle.args, {
    jobId: job._id,
    outcome: 'success',
    description: 'Forge check passed.',
    runId,
  });
  await f.run('settle', pullQueue.settle._handler, settle.args);
  const posts = () => f.scheduled.filter(row => row.name === 'projectGithubPullStatus:post');
  assert.deepEqual(
    posts().map(row => [row.args.state, row.args.sha]),
    [['success', 'b'.repeat(40)]],
  );
  assert(
    f.scheduled.some(row => row.name === 'projectGithubPull:retire'),
    'the PR Lane is retired',
  );
  const settled = f.tables.projectGithubMirrorJobs.get(job._id);
  assert.equal(pullOf(settled).outcome, 'success');
  assert.equal(settled.waitKey, undefined);
  await f.run('settleAgain', pullQueue.settle._handler, settle.args);
  assert.equal(posts().length, 1, 'one final status per head');
  // A second PR still checking is superseded by its newer head: error status on the old head.
  await prHead(f, 'c'.repeat(40), 9);
  const [old] = pullJobs(f, 9);
  f.patch('projectGithubMirrorJobs', old._id, {
    status: 'done',
    waitKey: runId,
    inbound: JSON.stringify({
      phase: 'checking',
      pull: { number: 9, head: 'c'.repeat(40), fork: false, runId },
      laneId,
    }),
  });
  await prHead(f, 'd'.repeat(40), 9);
  assert.equal(pullOf(f.tables.projectGithubMirrorJobs.get(old._id)).outcome, 'superseded');
  assert.deepEqual(posts().at(-1).args, {
    projectId: f.projectId,
    repository: 'Synthetic/Mirror',
    sha: 'c'.repeat(40),
    state: 'error',
    description: 'Superseded by a newer push to this pull request.',
    link: null,
  });
});
test('two-way PR fork: the owner decision starts or settles the waiting head; expiry and a newer head close the request', async () => {
  const f = await twoWayFixture();
  const { pullOperationId, forkStatus } = await import('../dist/github-pull-check.js');
  const posts = () => f.scheduled.filter(row => row.name === 'projectGithubPullStatus:post');
  /** A fork head waiting on its Lane's approval request, as the fork gate leaves it. */
  const waitingFork = async (number, head) => {
    await prHead(f, head, number);
    const job = pullJobs(f, number).at(-1),
      approval = pullOperationId(),
      laneId = randomUUID();
    f.patch('projectGithubMirrorJobs', job._id, {
      status: 'done',
      waitKey: approval,
      inbound: JSON.stringify({ phase: 'checking', pull: { number, head, fork: true, approval }, laneId }),
    });
    const rowId = f.insert('projectHostedApprovals', {
      projectId: f.projectId,
      laneId,
      operationId: approval,
      requester: 'owner',
      reason: 'fork',
      head: 'a'.repeat(64),
      at: 1,
      status: 'requested',
      live: false,
      pullRequest: number,
      version: 1,
    });
    return { job, approval, row: () => f.tables.projectHostedApprovals.get(rowId) };
  };
  // Granted: one indexed read, the run starts under the request's key, nothing is written.
  const a = await waitingFork(7, 'b'.repeat(40));
  await f.run('granted', ctx => pullQueue.notifyPullApproval(ctx, a.row(), 'granted'));
  assert.deepEqual(f.scheduled.at(-1), {
    name: 'projectGithubPull:start',
    args: { jobId: a.job._id, key: a.approval },
  });
  assert.equal(f.counts.at(-1).writes, 0);
  assert.equal(posts().length, 0);
  // Nobody decided in 30 days: forge/verify settles error with that reason; the request closes.
  await f.run('expire', pullQueue.expire._handler, { jobId: a.job._id, key: a.approval });
  assert.deepEqual(
    posts().map(row => [row.args.state, row.args.sha, row.args.description]),
    [['error', 'b'.repeat(40), forkStatus.expired]],
  );
  assert.equal(a.row().live, false);
  assert.equal(a.row().ended.kind, 'settled');
  await f.run('expireAgain', pullQueue.expire._handler, { jobId: a.job._id, key: a.approval });
  await f.run('lateDecline', ctx => pullQueue.notifyPullApproval(ctx, a.row(), 'declined'));
  assert.equal(posts().length, 1, 'a settled head changes nothing more');
  // Declined or withdrawn: settled error, named.
  for (const [number, status] of [
    [8, 'declined'],
    [9, 'withdrawn'],
  ]) {
    const w = await waitingFork(number, String(number).repeat(40));
    await f.run(status, ctx => pullQueue.notifyPullApproval(ctx, w.row(), status));
    assert.equal(posts().at(-1).args.state, 'error');
    assert.equal(posts().at(-1).args.description, forkStatus[status]);
    assert.equal(pullOf(f.tables.projectGithubMirrorJobs.get(w.job._id)).outcome, 'error');
    assert.equal(w.row().ended.kind, 'settled');
  }
  // A newer push supersedes the waiting head and closes its request; the new head asks again.
  const s = await waitingFork(10, 'c'.repeat(40));
  await prHead(f, 'd'.repeat(40), 10);
  assert.equal(pullOf(f.tables.projectGithubMirrorJobs.get(s.job._id)).outcome, 'superseded');
  assert.equal(s.row().ended.kind, 'settled');
  assert.equal(f.tables.projectHostedApprovals.size, 4, 'fork requests are never live rows');
  assert(![...f.tables.projectHostedApprovals.values()].some(row => row.live));
});
