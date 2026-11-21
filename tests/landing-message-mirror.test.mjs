// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import { ticketState, patchTicketState } from './landing-ticket-fixture.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
const landingPriority = await import(moduleUrl('../convex/projectHostedLandingPriority.ts'));
const acceptanceApi = await import(moduleUrl('../convex/projectHostedAcceptance.ts'));
const code = await import(moduleUrl('../convex/projectCode.ts'));
const history = await import(moduleUrl('../convex/projectLandingReads.ts'));
const needsFyi = await import(moduleUrl('../convex/projectNeedsFyi.ts'));
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
/** The mirror shape for supplied(i) members: prose in order, then one trailer block. */
const singleBlock = (members, forgeTrailers) =>
  members.map(i => `Supplied subject ${i}\n\nBody ${i}.`).join('\n\n') +
  '\n\n' +
  members
    .map(
      i =>
        `Reviewed-by: Reviewer ${i} <review@example.invalid>\nCo-Authored-By: Synthetic Sol ${i} <noreply@openai.com>`,
    )
    .join('\n') +
  '\n' +
  forgeTrailers;

test('released strict wait and stack readers keep working while canonical messages stay frozen', async () => {
  const f = await acceptanceFixture();
  const { state: observed } = await f.ready(null, { message: supplied(0) });
  const row = [...f.tables.projectHostedLandingRequests.values()].find(r => r.submissionId === observed.id);
  const state = ticketState(f, row);
  state.message = supplied(0);
  patchTicketState(f, row, state);
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
  const canonical = ticketState(f, f.tables.projectHostedLandingRequests.get(row._id));
  assert.equal(canonical.message, supplied(0));
  assert.equal(canonical.request.message, supplied(0));
  assert.equal((await f.accept(state)).receipt.message, supplied(0));
});

test('inline and referenced cohort messages give identical receipt, history, Needs me and mirror replies', async t => {
  const f = await batchesFixture(t, { count: 0 });
  const messages = [supplied(0), '', null, supplied(3)];
  for (const [index, message] of messages.entries()) await f.add(index, { request: { message } });
  const { projectId } = f;
  const run = (fn, args) => f.transaction('readLandingMessage', fn, { projectId, ...args });
  const priorityRequest = {
    submissionId: f.entries.at(-1).state.id,
    operationId: randomUUID(),
    priority: 'normal',
    expectedVersion: 0,
    authorityEpoch: 1,
  };
  await run(landingPriority.prioritize, priorityRequest);
  const project = f.tables.hostedProjects.get(f.projectId);
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: {
      ...project.autonomyPolicy,
      githubMirror: { repo: 'synthetic/mirror', autoPush: true, laneRefs: false },
    },
  });
  const tickets = () =>
    [...f.tables.projectHostedLandingRequests.values()].sort((a, b) => a.sequence - b.sequence);
  for (let tick = 0; tickets().some(row => row.phase !== 'landed'); tick++) {
    assert(tick < 300, 'the cohort reaches acceptance');
    if (f.runs().some(run => run.status === 'queued')) await f.passChecks();
    await f.execute(f.pending()[0]);
  }
  const rows = [...f.tables.projectHostedAcceptances.values()].sort((a, b) => a.sequence - b.sequence);
  const last = rows.at(-1);
  const receipt = JSON.parse(last.value);
  assert.deepEqual(
    receipt.cohortMessages,
    messages.filter(message => message !== null),
  );
  const job = [...f.tables.projectGithubMirrorJobs.values()][0];
  const mapping = [...f.tables.projectGithubMirrors.values()][0];
  const binding = mirrorFixture({ before: {}, after: {} }).root;
  const mirrors = async (state = receipt.previous.head) => {
    f.patch('projectGithubMirrors', mapping._id, { mapping: JSON.stringify({ ...binding, state }) });
    f.patch('projectGithubMirrorJobs', job._id, { seed: undefined });
    return JSON.parse(await f.transaction('mirrorMessage', store.begin, { jobId: job._id, step: job.step }))
      .seed.message;
  };
  const views = async () => ({
    receipt: await run(acceptanceApi.receipt, { receiptId: receipt.id }),
    acceptReplay: await run(acceptanceApi.accept, {
      submissionId: receipt.submissionId,
      attemptId: receipt.attemptId,
    }),
    landingReplay: await run(landingApi.enqueue, { request: JSON.stringify(f.entries.at(-1).request) }),
    priorityReplay: await run(landingPriority.prioritize, priorityRequest),
    landings: JSON.parse(await run(landingApi.list, { channel: 'main', cursor: null })).page,
    landing: await run(landingApi.candidate, { candidateId: tickets().at(-1).candidateId }),
    code: await run(code.history, { cursor: null }),
    history: await run(history.list, { view: 'recent' }),
    fyi: await run(needsFyi.read, {}),
    mirror: await mirrors(),
    catchUp: await mirrors('9'.repeat(64)),
  });
  const inline = await views();
  assert.equal(JSON.parse(inline.receipt).receipt.message, messages.at(-1));
  assert.equal(JSON.parse(inline.acceptReplay).receipt.message, messages.at(-1));
  assert(JSON.parse(inline.landing).receipt.cohortMessages.length > 1);
  for (const value of [inline.code, inline.history, inline.fyi, inline.mirror])
    assert.match(value, /Supplied subject 0/);
  assert.deepEqual(lostTrailers(messages.at(-1), inline.mirror), []);

  // The reader-first release leaves the writer inline. Exercise the proposed storage shape with
  // the exact same accepted identities and a mixed cohort (inline, reference, omitted and empty).
  let lastRef;
  for (const [index, row] of rows.entries()) {
    const value = JSON.parse(row.value);
    if (index !== 0 && value.message !== undefined) {
      lastRef = f.insert('projectHostedLandingBodies', { messageProjectId: projectId, value: value.message });
      const ticket = tickets().find(ticket => ticket.submissionId === row.submissionId);
      const state = ticketState(f, ticket);
      assert.equal(state.request.message, value.message);
      delete state.request.message;
      state.messageRef = { id: lastRef, source: 'request' };
      patchTicketState(f, ticket, state);
      delete value.message;
      value.messageRef = lastRef;
    }
    if (index === rows.length - 1) {
      delete value.cohortMessages;
      value.cohortSize = rows.length;
    }
    f.patch('projectHostedAcceptances', row._id, { value: JSON.stringify(value) });
  }
  assert.deepEqual(await views(), inline);
  assert.match(inline.catchUp, /^Catch up 4 Forge landings/);
  const referenced = JSON.parse(f.tables.projectHostedAcceptances.get(last._id).value);
  f.patch('projectHostedAcceptances', last._id, {
    value: JSON.stringify({ ...referenced, cohortSize: rows.length - 1 }),
  });
  await assert.rejects(run(acceptanceApi.receipt, { receiptId: receipt.id }), {
    data: { code: 'EVIDENCE_CHANGED', message: 'The ordered landing cohort is incomplete.' },
  });
  f.patch('projectHostedAcceptances', last._id, { value: JSON.stringify(referenced) });
  f.patch('projectHostedLandingBodies', lastRef, { value: 'Forge-State: synthetic spoof' });
  await assert.rejects(run(acceptanceApi.receipt, { receiptId: receipt.id }), {
    data: { code: 'EVIDENCE_CHANGED', message: 'The stored landing message is not canonical.' },
  });
  f.patch('projectHostedLandingBodies', lastRef, { messageProjectId: 'hostedProjects-999' });
  await assert.rejects(run(acceptanceApi.receipt, { receiptId: receipt.id }), error => {
    assert.equal(error.data?.code, 'EVIDENCE_CHANGED');
    assert(!error.message.includes(messages.at(-1)));
    return true;
  });
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
        const value = ticketState(f, row);
        delete value.message;
        delete value.request.message;
        patchTicketState(f, row, value);
      }
    if (!legacy)
      for (const row of f.tables.projectHostedLandingRequests.values())
        f.patch('projectHostedLandingRequests', row._id, { agentClient: 'codex:gpt-6.1-sol' });
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
    if (!legacy) assert.equal(first.agentClient, 'codex:gpt-6.1-sol');
    // Each supplied message already names its co-author, so the receipt's client adds no credit;
    // every member's trailers join Forge's in one final block.
    const members = batching ? [0, 1, 2] : [messages.indexOf(first.message)];
    const expected = singleBlock(members, trailers(first));
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
        singleBlock([messages.indexOf(receipt.message)], trailers(receipt)),
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
async function batchConflictMessages(t, recomposed, choice) {
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
  // L10/95a0b4d failed on a child Candidate after main moved. The request
  // remains pinned to its original Candidate, while the resolution selects the child.
  const origin = await f.add(1, choice ? { request: { message: choice.message } } : {});
  let conflictCandidateId = f.entries[1].candidate.id;
  if (recomposed) {
    const landingStore = await import(moduleUrl('../convex/projectHostedLandingStore.ts'));
    const composeSource = await import(moduleUrl('../convex/projectHostedFinishCompose.ts'));
    const prepared = await f.transaction(
      'prepareRecomposedSource',
      {
        _handler: async ctx => {
          const input = { projectId: f.projectId, submissionId: origin.id };
          const { value } = await finish.loadFinish(ctx, input);
          const main = f.currentMain();
          return composeSource.prepareFinishCompose(ctx, input, {
            ...value,
            source: { ...value.source, message: choice?.composeMessage ?? 'Agent change' },
            pending: {
              id: choice?.cached ? randomUUID() : 'bb286e7a-e1a4-49cf-9442-cb1127316bca',
              parentAttemptId: origin.attemptId,
              number: 1,
              at: new Date().toISOString(),
              main: { head: main.head, receiptId: main.receipt.id },
              operations: { compose: randomUUID(), check: randomUUID(), accept: randomUUID() },
            },
          });
        },
      },
      {},
    );
    conflictCandidateId = prepared.state.candidateId;
    // Publication indexes the exact Candidate; source execution itself is outside this replay.
    f.patch('projectHostedComposes', prepared.row._id, { candidateId: conflictCandidateId });
    const operationRow = [...f.tables.projectHostedOperations.values()].find(
      row => row.operationId === prepared.state.request.operationId,
    );
    const operation = JSON.parse(operationRow.value);
    if (!choice?.cached) {
      // Retained pre-upgrade requests have no explicit submission reservation.
      delete operation.firstAttempt.ids.submission;
    }
    if (choice?.mismatch) operation.firstAttempt.id = origin.attemptId;
    if (choice?.wrongSourceCandidate) operation.firstAttempt.ids.candidate = f.entries[1].candidate.id;
    f.patch('projectHostedOperations', operationRow._id, { value: JSON.stringify(operation) });

    await f.transaction(
      'recomposeOrigin',
      {
        _handler: async ctx => {
          const { row, state } = await landingStore.loadLanding(ctx, {
            projectId: f.projectId,
            submissionId: origin.id,
          });
          const parent = await landingStore.loadLandingAttempt(ctx, {
            projectId: f.projectId,
            attemptId: state.attemptId,
          });
          const child = {
            ...parent,
            id: 'bb286e7a-e1a4-49cf-9442-cb1127316bca',
            parentAttemptId: parent.id,
            number: parent.number + 1,
            candidate: { ...parent.candidate, id: conflictCandidateId },
          };
          await landingStore.insertLandingAttempt(ctx, child);
          await landingStore.writeLanding(
            ctx,
            row,
            { ...state, version: state.version + 1, attemptId: child.id },
            false,
          );
        },
      },
      {},
    );
  }
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
        candidateId: conflictCandidateId,
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
  const retainedResolution = ticketState(
    f,
    [...f.tables.projectHostedLandingRequests.values()].find(
      row => row.submissionId === f.entries[2].state.id,
    ),
  );
  if (choice) {
    assert.equal(
      retainedResolution.message,
      choice.mismatch || choice.wrongSourceCandidate ? undefined : (choice.message ?? undefined),
      'resolution retains the exact landing choice, independently of compose text',
    );
    return;
  }
  assert.equal(
    retainedResolution.message,
    conflicted,
    'the retained landing note survives the child Candidate',
  );
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
  // The footer ends `conflicted`, so it opens the one final trailer block (Item 3968a655).
  assert.equal(seed.message, `${normal}\n\n${conflicted}\n${trailers(mirrored)}`);
  for (const message of [normal, conflicted])
    assert.deepEqual(lostTrailers(message, seed.message), [], 'mirror commit keeps every finish trailer');
  // The f233bf1c commit shape itself fails the check.
  assert.deepEqual(lostTrailers(conflicted, `${normal}\n\n${trailers(mirrored)}`), [footer]);
}

test('incident f233bf1c: a batch of a normal Lane and a resolution Lane mirrors both messages', t =>
  batchConflictMessages(t, false));
test('incident 95a0b4d: a batch preserves a recomposed conflict message through another resolution', t =>
  batchConflictMessages(t, true));

test('a recomposed resolution preserves an explicit default subject', t =>
  batchConflictMessages(t, true, { message: 'Agent change' }));
test('a recomposed resolution preserves an explicitly empty note', t =>
  batchConflictMessages(t, true, { message: '' }));
test('a recomposed resolution preserves omission despite custom compose text', t =>
  batchConflictMessages(t, true, { message: null, composeMessage: 'Compose note omitted by the landing' }));
test('a recomposed resolution keeps the landing override of its compose note', t =>
  batchConflictMessages(t, true, { message: 'Landing note', composeMessage: 'Different compose note' }));

test('a child Candidate never inherits a note from a mismatched landing attempt', t =>
  batchConflictMessages(t, true, { message: 'Wrong Candidate note', mismatch: true }));

test('an adopted cached precompose retains the exact landing note across new attempt ids', t =>
  batchConflictMessages(t, true, { message: 'Cached landing note', cached: true }));
test('an adopted cached precompose preserves explicit omission', t =>
  batchConflictMessages(t, true, {
    message: null,
    composeMessage: 'Omitted cached compose note',
    cached: true,
  }));

test('a cached source with another Candidate never inherits its reserved submission note', t =>
  batchConflictMessages(t, true, {
    message: 'Wrong source Candidate',
    cached: true,
    wrongSourceCandidate: true,
  }));

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
  // Every byte escapes to two in JSON: one message and an eight-message batch, exactly.
  assert.equal(Buffer.byteLength(JSON.stringify({ message: maximum })), 2 * LANDING_MESSAGE_BYTES + 14);
  const batch = Buffer.byteLength(JSON.stringify({ cohortMessages: Array(8).fill(maximum) }));
  assert.equal(batch, 8 * (2 * LANDING_MESSAGE_BYTES + 2) + 28);
  assert(
    batch < (512 * 1024) / 4,
    'eight worst-case messages stay a small part of the 512 KiB publication budget',
  );
});

test('friction 330d1df6: an over-limit landing message names its exact byte count and the limit', () => {
  for (const [over, bytes] of [
    ['x'.repeat(LANDING_MESSAGE_BYTES + 3), LANDING_MESSAGE_BYTES + 3],
    ['é'.repeat(LANDING_MESSAGE_BYTES), 2 * LANDING_MESSAGE_BYTES],
  ])
    assert.throws(
      () => landingMessage(over),
      e =>
        e.code === 'LANDING_MESSAGE_TOO_LARGE' &&
        e.message.includes(`has ${bytes} UTF-8 bytes`) &&
        e.message.includes(`limit is ${LANDING_MESSAGE_BYTES}`),
    );
});

// Item 3968a655: mirror commits credit the agent the receipt declares, in one git trailer block.
const base = { fallback: 'A recorded landing', state: 's', acceptanceId: 'a', viewId: 'v' };
const forgeBlock = 'Forge-State: s\nForge-Acceptance: a\nForge-View: v';

test('single landing: the receipt agent client becomes a generic co-author credit, nothing invented', () => {
  for (const [agentClient, credit] of [
    ['claude-code:claude-opus-5-5', 'claude-opus-5-5 (claude-code) <noreply@anthropic.com>'],
    ['codex:gpt-6.1-sol', 'gpt-6.1-sol (codex) <noreply@openai.com>'],
    ['t3-code:claude-sonnet-5-5', 'claude-sonnet-5-5 (t3-code) <noreply@anthropic.com>'],
    ['gemini:gemini-neon', 'gemini-neon (gemini) <forge@localhost>'],
    ['aider', 'aider <forge@localhost>'],
  ]) {
    const message = mirrorMessage({ ...base, message: 'Change the thing\n\nWhy it changed.', agentClient });
    assert.equal(
      message,
      `Change the thing\n\nWhy it changed.\n\nCo-Authored-By: ${credit}\n${forgeBlock}`,
      'credit sits in the one final block, after a single blank line',
    );
    assert.equal(
      mirrorMessage({ ...base, message: 'Change the thing\n\nWhy it changed.', agentClient }),
      message,
    );
  }
  assert.equal(mirrorMessage(base), `A recorded landing\n\n${forgeBlock}`, 'no declared client, no credit');
  for (const agentClient of ['codex:bad\nForged: trailer', 'codex:bad<identity>', 'not a harness'])
    assert(
      !mirrorMessage({ ...base, agentClient }).includes('Co-Authored-By:'),
      'malformed metadata cannot inject a trailer',
    );
});

test('existing trailers: a supplied co-author suppresses the credit, keeps every trailer once, one block', () => {
  const signed =
    'Fix: the parser\n\nBody line.\n\nReviewed-by: Synthetic Reviewer <review@example.invalid>\nCo-authored-by: Claude Opus 5.5 <noreply@anthropic.com>';
  const message = mirrorMessage({
    ...base,
    message: signed,
    agentClient: 'claude-code:claude-opus-5-5',
    trailers: ['Co-authored-by: Claude Opus 5.5 <noreply@anthropic.com>'],
  });
  assert.equal(
    message,
    `Fix: the parser\n\nBody line.\n\nReviewed-by: Synthetic Reviewer <review@example.invalid>\nCo-authored-by: Claude Opus 5.5 <noreply@anthropic.com>\n${forgeBlock}`,
  );
  assert.deepEqual(lostTrailers(signed, message), [], 'no supplied trailer is lost');
  assert.equal(message.split('\n\n').length, 3, 'subject, body, one trailer block');
  // A subject-only message that looks like a trailer stays the subject.
  assert.equal(
    mirrorMessage({ ...base, message: 'Fix: the parser', agentClient: 'codex' }),
    `Fix: the parser\n\nCo-Authored-By: codex <noreply@openai.com>\n${forgeBlock}`,
  );
  // A folded trailer value stays with its trailer.
  assert.equal(
    mirrorMessage({ ...base, message: 'Subject\n\nNote: first line\n  continued' }),
    `Subject\n\nNote: first line\n  continued\n${forgeBlock}`,
  );
});

test('batch with two agents: each member credits its own agent unless its own message names one', () => {
  const cohortMessages = [
    'First member\n\nReviewed-by: Synthetic Reviewer <review@example.invalid>',
    'Second member\n\nCo-Authored-By: GPT-6.1 (Codex) <noreply@openai.com>',
    'Third member',
  ];
  const members = [
    { message: cohortMessages[0], agentClient: 'claude-code:claude-opus-5-5' },
    { message: cohortMessages[1], agentClient: 'codex:gpt-6.1-sol' },
    { message: cohortMessages[2], agentClient: 'claude-code:claude-opus-5-5' },
    { agentClient: 'codex:gpt-6.1-sol' },
  ];
  assert.equal(
    mirrorMessage({ ...base, message: cohortMessages[2], cohortMessages, members }),
    [
      'First member\n\nSecond member\n\nThird member',
      '',
      'Reviewed-by: Synthetic Reviewer <review@example.invalid>',
      'Co-Authored-By: GPT-6.1 (Codex) <noreply@openai.com>',
      'Co-Authored-By: claude-opus-5-5 (claude-code) <noreply@anthropic.com>',
      'Co-Authored-By: gpt-6.1-sol (codex) <noreply@openai.com>',
      forgeBlock,
    ].join('\n'),
    'members without a message are still credited; repeated credits appear once',
  );
});

test('catch-up commit: a covered landing whose prose is summarised keeps its own co-author', () => {
  const members = [
    {
      message: 'Signed\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>',
      agentClient: 'claude-code',
    },
    { message: 'Unsigned', agentClient: 'codex:gpt-6.1-sol' },
  ];
  assert.equal(
    mirrorMessage({
      ...base,
      fallback: 'Catch up 2 Forge landings\n\n- Signed (a)\n- Unsigned (b)',
      members,
    }),
    [
      'Catch up 2 Forge landings\n\n- Signed (a)\n- Unsigned (b)',
      '',
      'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>',
      'Co-Authored-By: gpt-6.1-sol (codex) <noreply@openai.com>',
      forgeBlock,
    ].join('\n'),
  );
});

test('a message at the 1,024-byte limit keeps its exact prose, its credit and the Forge trailers', () => {
  const [head, tail] = ['Near the limit\n\n', '\n\nReviewed-by: R <r@example.invalid>'];
  const atLimit = head + 'x'.repeat(LANDING_MESSAGE_BYTES - Buffer.byteLength(head + tail)) + tail;
  assert.equal(Buffer.byteLength(atLimit), LANDING_MESSAGE_BYTES);
  const mirrored = mirrorMessage({ ...base, message: atLimit, agentClient: 'claude-code:claude-opus-5-5' });
  assert.equal(
    mirrored,
    `${atLimit}\nCo-Authored-By: claude-opus-5-5 (claude-code) <noreply@anthropic.com>\n${forgeBlock}`,
    'the credit is added after the limit check, so a full message never loses bytes or fails',
  );
  assert.equal(landingMessage(atLimit), atLimit);
});

test('batch with two agents end to end: the mirror seed credits each member from its own receipt', async t => {
  const memberMessages = ['Member one\n\nBody one.', 'Member two\n\nBody two.'];
  const clients = ['claude-code:claude-opus-5-5', 'codex:gpt-6.1-sol'];
  const f = await batchesFixture(t, { count: 2, batching: true, memberMessages, concurrency: 2 });
  for (const [i, entry] of f.entries.entries()) {
    const row = [...f.tables.projectHostedLandingRequests.values()].find(
      r => r.submissionId === entry.state.id,
    );
    f.patch('projectHostedLandingRequests', row._id, { agentClient: clients[i] });
  }
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
    assert(tick < 300, 'both members reach acceptance');
    if (f.runs().some(r => r.status === 'queued')) await f.passChecks();
    const task = f.pending()[0];
    if (task.name === 'projectGithubMirror:step')
      f.patch('_scheduled_functions', task._id, { state: { kind: 'canceled' } });
    else await f.execute(task);
  }
  const receipts = [...f.tables.projectHostedAcceptances.values()].map(r => JSON.parse(r.value));
  assert.equal(new Set(receipts.map(r => r.batchId)).size, 1, 'one batch');
  const [job] = [...f.tables.projectGithubMirrorJobs.values()];
  const main = receipts.find(r => r.id === job.receiptId);
  assert.deepEqual(main.cohortMessages, memberMessages);
  const mapping = [...f.tables.projectGithubMirrors.values()][0];
  f.patch('projectGithubMirrors', mapping._id, {
    mapping: JSON.stringify({ ...mirrorFixture({ before: {}, after: {} }).root, state: main.previous.head }),
  });
  const identity = { jobId: job._id, step: job.step };
  const begin = () => f.transaction('mirrorBegin', { _handler: store.begin._handler }, identity);
  const { seed } = JSON.parse(await begin());
  assert.equal(
    seed.message,
    [
      'Member one\n\nBody one.\n\nMember two\n\nBody two.',
      '',
      'Co-Authored-By: claude-opus-5-5 (claude-code) <noreply@anthropic.com>',
      'Co-Authored-By: gpt-6.1-sol (codex) <noreply@openai.com>',
      trailers(main),
    ].join('\n'),
  );
  assert.equal(JSON.parse(await begin()).seed.message, seed.message, 'a replayed begin pins the same bytes');
});
