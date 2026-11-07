// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { batchesFixture, synthetic } from './hosted-landing-batches-fixture.mjs';
import { acceptanceFixture } from './hosted-acceptance-fixture.mjs';
import { mirrorFixture } from './hosted-github-mirror-fixture.mjs';
import {
  landingMessage,
  LANDING_MESSAGE_BYTES,
  lostTrailers,
  mirrorMessage,
} from '../dist/landing-message.js';
import { prepareMirror, stepMirror } from '../dist/hosted-github-mirror.js';
import { hostedAgentCommandSchemas } from '../dist/hosted-agent-contract.js';
import { hostedLandingStateSchema, hostedLandingRequestSchema } from '../dist/hosted-landing.js';
const store = await import(moduleUrl('../convex/projectGithubMirrorStore.ts'));
const landingApi = await import(moduleUrl('../convex/projectHostedLanding.ts'));
const observe = await import(moduleUrl('../convex/projectHostedFinishObserve.ts'));
const configuration = {
  ...synthetic,
  FORGE_GITHUB_SYNC_NAME: 'Forge Sync',
  FORGE_GITHUB_SYNC_EMAIL: '123+fixture@users.noreply.github.com',
};
const prior = Object.fromEntries(Object.keys(configuration).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, configuration));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const supplied = i =>
  `Supplied subject ${i}\n\nBody ${i}.\n\nReviewed-by: Reviewer ${i} <review@example.invalid>\nCo-Authored-By: Synthetic Sol ${i} <noreply@openai.com>`;
const trailers = r =>
  `Forge-State: ${r.candidate.head}\nForge-Acceptance: ${r.id}\nForge-View: ${r.candidate.id}`;

test('released strict wait and stack readers keep working while canonical messages stay frozen', async () => {
  const f = await acceptanceFixture();
  const { state: observed } = await f.ready(null, { message: supplied(0) });
  const row = [...f.tables.projectHostedLandingRequests.values()].find(r => r.submissionId === observed.id);
  const state = JSON.parse(row.value);
  state.message = supplied(0);
  f.patch('projectHostedLandingRequests', row._id, { value: JSON.stringify(state) });
  const released = hostedLandingStateSchema.omit({ message: true }).extend({
    request: hostedLandingRequestSchema.omit({ message: true }),
  });
  for (const priorityInfo of [undefined, 1]) {
    const args = { projectId: f.projectId, ...(priorityInfo ? { priorityInfo } : {}) };
    const status = JSON.parse(
      await f.transaction('messageReaderStatus', landingApi.status, {
        ...args,
        submissionId: state.id,
      }),
    );
    released.parse(status.request);
    const page = JSON.parse(
      await f.transaction('messageReaderEvents', observe.page, {
        ...args,
        operationId: state.operationId,
        nextVersion: 0,
      }),
    );
    released.parse(page.submission);
    for (const event of page.events) released.parse(event.submission);
  }
  const canonical = JSON.parse(f.tables.projectHostedLandingRequests.get(row._id).value);
  assert.equal(canonical.message, supplied(0));
  assert.equal(canonical.request.message, supplied(0));
  assert.equal((await f.accept(state)).receipt.message, supplied(0));
});

// Issue b30284de / class guard 8b7b97ce / eacfdb6e: run real finish, acceptance,
// the publication's own mirror enqueue, seed and Git publication. Fixtures that
// enqueue every receipt by hand, or use only an already-built mirror message,
// miss the repeated defect: the message never reaching that boundary. Batch
// 9f919ded (2026-11-05) lost a member's message and Co-Authored-By footer that way.
for (const [batching, legacy] of [
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])
  test(`finish-to-mirror guard: ${legacy ? 'pre-upgrade ' : ''}${batching ? 'cohort' : 'serial/train'} retains every supplied trailer across retries`, async t => {
    const messages = Array.from({ length: 3 }, (_, i) => supplied(i));
    const f = await batchesFixture(t, { count: 3, batching, memberMessages: messages, concurrency: 3 });
    if (legacy)
      for (const row of f.tables.projectHostedLandingRequests.values()) {
        const value = JSON.parse(row.value);
        delete value.message;
        delete value.request.message;
        f.patch('projectHostedLandingRequests', row._id, { value: JSON.stringify(value) });
      }
    // Mirror on before acceptance: publication enqueues exactly the jobs production does.
    const project = f.tables.hostedProjects.get(f.projectId);
    f.patch('hostedProjects', f.projectId, {
      autonomyPolicy: {
        ...project.autonomyPolicy,
        githubMirror: { repo: 'synthetic/mirror', autoPush: true, laneRefs: false },
      },
    });
    for (
      let tick = 0;
      [...f.tables.projectHostedLandingRequests.values()].some(r => JSON.parse(r.value).phase !== 'landed');
      tick++
    ) {
      assert(tick < 300, 'every finish reaches acceptance');
      if (f.runs().some(r => r.status === 'queued')) await f.passChecks();
      const task = f.pending()[0];
      // GitHub IO runs below against the Git API fixture.
      if (task.name === 'projectGithubMirror:step')
        f.patch('_scheduled_functions', task._id, { state: { kind: 'canceled' } });
      else await f.execute(task);
    }
    const receipts = [...f.tables.projectHostedAcceptances.values()].map(r => JSON.parse(r.value));
    assert.equal(receipts.length, 3);
    for (const [i, entry] of f.entries.entries()) {
      const r = receipts.find(r => r.submissionId === entry.state.id);
      assert.equal(r.message, messages[i], 'acceptance freezes each original finish message');
      assert.equal((await f.enqueue(entry.request)).phase, 'landed', 'unknown finish outcome reconciles');
    }
    const jobs = [...f.tables.projectGithubMirrorJobs.values()].sort((a, b) => a.sequence - b.sequence);
    assert.equal(jobs.length, batching ? 1 : 3, 'one mirror job per published main move');
    const first = receipts.find(r => r.id === jobs[0].receiptId);
    if (batching) assert.deepEqual(first.cohortMessages, messages);
    // Materialize an ordinary Git API fixture with the exact accepted bytes.
    const state = id => JSON.parse(f.c.objects.get(id));
    const files = id =>
      Object.fromEntries(
        state(id).files.map(file => [
          file.path,
          {
            mode: file.mode,
            text: Buffer.from(f.c.objects.get(file.blob)).toString(),
          },
        ]),
      );
    const github = mirrorFixture({ before: files(first.previous.head), after: files(first.candidate.head) });
    const run = (name, fn, input) => f.transaction(name, { _handler: fn }, input);
    // Accepted supplied prose must not depend on later mutable Intent records.
    for (const table of ['projectHostedRecords', 'projectHostedRecordHeads'])
      for (const [id, row] of f.tables[table]) if (row.kind === 'intent') f.tables[table].delete(id);
    const mapping = [...f.tables.projectGithubMirrors.values()][0];
    f.patch('projectGithubMirrors', mapping._id, {
      mapping: JSON.stringify({ ...github.root, state: first.previous.head }),
    });
    const identity = { jobId: jobs[0]._id, step: jobs[0].step };
    const seeds = await Promise.all([0, 1, 2].map(() => run('mirrorBegin', store.begin._handler, identity)));
    assert(
      seeds.every(s => s === seeds[0]),
      'concurrent/unknown begin outcomes retain exact commit bytes',
    );
    const { seed } = JSON.parse(seeds[0]);
    const expected = (batching ? messages : [first.message]).join('\n\n') + '\n\n' + trailers(first);
    assert.equal(seed.message, expected);
    const io = {
      ...github.io,
      states: async ids => ids.map(state),
      blobs: async ids =>
        ids.map(id => ({
          size: f.c.objects.get(id).length,
          read: async () => Buffer.from(f.c.objects.get(id)),
        })),
    };
    const initial = await prepareMirror(seed, io);
    github.lose('refs/heads/main');
    await assert.rejects(stepMirror(structuredClone(initial), io), /lost reply/);
    let plan = structuredClone(initial);
    while (plan.phase !== 'done') plan = await stepMirror(plan, io);
    const published = github.commits.get(github.remote()).message;
    assert.equal(published, expected);
    // The guard: no finish message this commit lands loses a trailer.
    for (const message of batching ? messages : [first.message])
      assert.deepEqual(lostTrailers(message, published), [], 'mirror commit keeps every finish trailer');
    assert.equal(github.commits.size, 2, 'one commit despite unknown ref outcome');
    assert.equal(plan.entry.author.email, github.root.committer.email, 'noreply sync identity stays');
    await run('mirrorCommit', store.commit._handler, {
      ...identity,
      cursor: null,
      mapping: JSON.stringify(plan.entry),
    });
    for (const job of jobs.slice(1)) {
      const receipt = receipts.find(r => r.id === job.receiptId);
      const nextIdentity = { jobId: job._id, step: job.step };
      const next = JSON.parse(await run('mirrorBegin', store.begin._handler, nextIdentity)).seed;
      assert.equal(
        next.message,
        receipt.message + '\n\n' + trailers(receipt),
        'jobs never borrow a peer message',
      );
      let continuation = await prepareMirror(next, io);
      while (continuation.phase !== 'done') continuation = await stepMirror(continuation, io);
      assert.equal(github.commits.get(github.remote()).message, next.message);
      assert.deepEqual(lostTrailers(receipt.message, next.message), []);
      await run('mirrorCommit', store.commit._handler, {
        ...nextIdentity,
        cursor: null,
        mapping: JSON.stringify(continuation.entry),
      });
    }
    assert.equal(github.commits.size, batching ? 2 : 4);
    assert.equal(
      [...f.tables.projectGithubMirrors.values()][0].activeId,
      null,
      'idle schedules no further mirror',
    );
    t.diagnostic(
      JSON.stringify({
        members: 3,
        mirrorJobs: jobs.length,
        acceptanceMessageBytes: messages.map(m => Buffer.byteLength(m)),
        sharedMessageBytes: Buffer.byteLength(seed.message),
        mirrorBeginCalls: 3,
        mirrorBeginReads: f.counts.filter(c => c.name === 'mirrorBegin').map(c => c.documents),
      }),
    );
  });

// Replays of the dropped-footer incidents: the check names the lost trailer.
const footer = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>';
const forge = (state, acceptance, view) =>
  `Forge-State: ${state}\nForge-Acceptance: ${acceptance}\nForge-View: ${view}`;
test('incident 5fdd87f9: an Issue-title mirror commit loses the finish footer', () => {
  const finish = `Preserve finish messages in GitHub mirror commits\n\nBody.\n\n${footer}`;
  const commit = `Preserve finish messages and requested authorship footers in GitHub mirror commits\n\n${forge('a'.repeat(64), '0e022bc8-bb0b-4c1d-9119-70103f6e46c2', 'view')}`;
  assert.deepEqual(lostTrailers(finish, commit), [footer]);
  // The old outcome-only construction is exactly that commit shape.
  assert.deepEqual(
    lostTrailers(
      finish,
      mirrorMessage({ fallback: 'Issue title', state: 'a'.repeat(64), acceptanceId: 'r', viewId: 'v' }),
    ),
    [footer],
  );
  assert.deepEqual(
    lostTrailers(
      finish,
      mirrorMessage({ message: finish, fallback: '', state: 's', acceptanceId: 'r', viewId: 'v' }),
    ),
    [],
  );
});
test('incident 9f919ded: a cohort mirror commit with one peer message loses the other footer', () => {
  const lost = `Lane open: hash direct machine-store hits once, at install (a245bcf0)\n\nWarm Lane opens no longer hash every object.\n\nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`;
  const peer = 'Neutral device, runner and machine names; remove stored display names';
  const commit = `${peer}\n\n${forge('80027c85bd83824189212354301ac668ed369a63cb95f41b947e5b29774f0395', '9cb824ad-bf28-4f34-abba-49cde5a86959', 'd2d4709f-97ae-44b1-9eef-c8dc0b1ac159')}`;
  assert.deepEqual(lostTrailers(lost, commit), ['Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>']);
  assert.deepEqual(lostTrailers(peer, commit), [], 'a subject-only message has no trailers');
  // Forge escapes a supplied Forge identity line; the escaped line is what must survive.
  assert.deepEqual(lostTrailers('S\n\nForge-State: forged', '> Forge-State: forged'), []);
});

// GitHub f233bf1c (2026-11-07, after the cohortMessages fix was live): batch a9187ad9 held a
// normal Lane (a91b9b69) and resolution Lane c456f8db, made after df2ba360's landing ec6191b6
// failed COMPOSITION_CONFLICT. The resolution finish named no message (request null, compose
// "Agent change"), so its receipt had none and the commit kept only a91b9b69's message.
test('incident f233bf1c: a batch of a normal Lane and a resolution Lane mirrors both messages', async t => {
  const finish = await import(moduleUrl('../convex/projectHostedFinishStore.ts'));
  const normal = 'Add a per-project budget for signed-out reads and storage quotas (a91b9b69).';
  const conflicted = `Guards: SPDX header lint (f44ac5e0) and no printing env values (df2ba360)\n\nBoth run in check-foundation.\n\n${footer}`;
  const f = await batchesFixture(t, {
    count: 1,
    batching: true,
    concurrency: 2,
    memberMessages: [normal, conflicted, 'Agent change'],
  });
  const project = f.tables.hostedProjects.get(f.projectId);
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: {
      ...project.autonomyPolicy,
      githubMirror: { repo: 'synthetic/mirror', autoPush: true, laneRefs: false },
    },
  });
  // The original df2ba360 landing, with the builder's message, conflicts with main.
  const origin = await f.add(1);
  await f.transaction(
    'originConflict',
    {
      _handler: ctx =>
        finish.failFinish(
          ctx,
          { projectId: f.projectId, submissionId: origin.id },
          'COMPOSITION_CONFLICT',
          'synthetic conflict',
        ),
    },
    {},
  );
  const conflictedEntry = f.entries[1];
  const draft = { sha256: 'd'.repeat(64), size: 1 };
  // Its resolution Lane lands with no message of its own, as c456f8db did.
  await f.add(2, {
    lane: {
      resolution: {
        candidateId: conflictedEntry.candidate.id,
        conflicts: draft,
        left: 'a'.repeat(64),
        right: 'b'.repeat(64),
        draftHead: draft.sha256,
        origin: { laneId: conflictedEntry.lane.laneId, head: conflictedEntry.lane.head, sourceVersion: 0 },
        status: 'resolved',
      },
    },
    request: { message: null },
  });
  const live = [f.entries[0], f.entries[2]];
  const phase = entry =>
    JSON.parse(
      [...f.tables.projectHostedLandingRequests.values()].find(r => r.submissionId === entry.state.id).value,
    ).phase;
  for (let tick = 0; live.some(entry => phase(entry) !== 'landed'); tick++) {
    assert(tick < 300, 'both live members reach acceptance');
    if (f.runs().some(r => r.status === 'queued')) await f.passChecks();
    const task = f.pending()[0];
    if (task.name === 'projectGithubMirror:step')
      f.patch('_scheduled_functions', task._id, { state: { kind: 'canceled' } });
    else await f.execute(task);
  }
  assert.equal(phase(conflictedEntry), 'terminal-failed');
  const receipts = [...f.tables.projectHostedAcceptances.values()].map(r => JSON.parse(r.value));
  assert.equal(receipts.length, 2);
  assert.equal(new Set(receipts.map(r => r.batchId)).size, 1, 'one batch, as a9187ad9');
  const resolution = receipts.find(r => r.submissionId === f.entries[2].state.id);
  assert.equal(resolution.message, conflicted, 'the resolution receipt keeps the conflicted message');
  const jobs = [...f.tables.projectGithubMirrorJobs.values()];
  assert.equal(jobs.length, 1, 'one mirror job for the batch');
  const mirrored = receipts.find(r => r.id === jobs[0].receiptId);
  assert.equal(mirrored.id, resolution.id, 'the resolution is main receipt, as 8ea87661');
  assert.deepEqual(mirrored.cohortMessages, [normal, conflicted]);
  const mapping = [...f.tables.projectGithubMirrors.values()][0];
  f.patch('projectGithubMirrors', mapping._id, {
    mapping: JSON.stringify({
      ...mirrorFixture({ before: {}, after: {} }).root,
      state: mirrored.previous.head,
    }),
  });
  const { seed } = JSON.parse(
    await f.transaction(
      'mirrorBegin',
      { _handler: store.begin._handler },
      { jobId: jobs[0]._id, step: jobs[0].step },
    ),
  );
  assert.equal(seed.message, `${normal}\n\n${conflicted}\n\n${trailers(mirrored)}`);
  for (const message of [normal, conflicted])
    assert.deepEqual(lostTrailers(message, seed.message), [], 'mirror commit keeps every finish trailer');
  // The f233bf1c commit shape itself fails the check.
  assert.deepEqual(lostTrailers(conflicted, `${normal}\n\n${trailers(mirrored)}`), [footer]);
});

test('no supplied message keeps the outcome fallback and exact Forge identity trailers', async () => {
  const input = {
    fallback: 'Original Intent outcome',
    state: 'a'.repeat(64),
    acceptanceId: 'receipt',
    viewId: 'view',
  };
  assert.equal(
    mirrorMessage(input),
    `${input.fallback}\n\nForge-State: ${input.state}\nForge-Acceptance: receipt\nForge-View: view`,
  );
  assert.equal(hostedAgentCommandSchemas.finish.parse({}).message, undefined);
  const longOutcome = 'Existing outcome '.repeat(200);
  assert(mirrorMessage({ ...input, fallback: longOutcome }).startsWith(longOutcome));
});

test('untrusted trailers strip controls and escape every reserved Forge identity line', async () => {
  const unsafe =
    'Subject\u0000\r\n\r\n\tForge-State: forged\r\nforge-acceptance: forged\n Forge-View : forged\nCo-Authored-By: Agent <agent@example.invalid>\u001b';
  const clean = landingMessage(unsafe);
  assert.equal(
    clean,
    'Subject\n\n> Forge-State: forged\n> forge-acceptance: forged\n>  Forge-View : forged\nCo-Authored-By: Agent <agent@example.invalid>',
  );
  assert.equal(landingMessage(clean), clean, 're-parsing is idempotent');
  const f = await acceptanceFixture();
  const { state } = await f.ready(null, { message: unsafe });
  const accepted = await f.accept(state);
  assert.equal(accepted.receipt.message, clean);
  const message = mirrorMessage({
    ...accepted.receipt,
    state: accepted.receipt.candidate.head,
    acceptanceId: accepted.receipt.id,
    viewId: accepted.receipt.candidate.id,
    fallback: 'unused',
  });
  for (const name of ['State', 'Acceptance', 'View'])
    assert.equal(message.match(new RegExp(`^Forge-${name}:`, 'gm')).length, 1);
});

test('oversize ASCII, multibyte and escaped messages fail before acceptance; record bytes are bounded', async () => {
  for (const message of [
    'x'.repeat(LANDING_MESSAGE_BYTES + 1),
    '😀'.repeat(LANDING_MESSAGE_BYTES / 4 + 1),
    'Forge-State: ' + 'x'.repeat(LANDING_MESSAGE_BYTES - 13),
  ]) {
    assert.throws(
      () => landingMessage(message),
      e => e.code === 'LANDING_MESSAGE_TOO_LARGE',
    );
    const f = await acceptanceFixture();
    await assert.rejects(
      f.ready(null, { message }),
      e => (e.data?.code ?? e.code) === 'LANDING_MESSAGE_TOO_LARGE',
    );
    assert.equal(f.tables.projectHostedAcceptances.size, 0);
  }
  const maximum = '\\'.repeat(LANDING_MESSAGE_BYTES);
  assert.equal(landingMessage(maximum), maximum);
  assert.equal(Buffer.byteLength(JSON.stringify({ message: maximum })), 2062);
  assert.equal(Buffer.byteLength(JSON.stringify({ cohortMessages: Array(8).fill(maximum) })), 16428);
});
