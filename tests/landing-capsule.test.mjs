// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import { ticketState } from './landing-ticket-fixture.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { finishFixture } from './hosted-finish-fixture.mjs';
import { synthetic } from './hosted-landing-batches-fixture.mjs';
import { landingFixture, api, code } from './hosted-landing-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { canonicalPayload } from '../dist/hosted-source-operation.js';
import { encodeLandingCapsule, decodeLandingCapsule } from '../dist/landing-capsule-bytes.js';
const observe = await import(moduleUrl('../convex/projectHostedFinishObserve.ts'));
const capsuleStore = await import(moduleUrl('../convex/projectLandingCapsuleStore.ts'));
const ledger = await import(moduleUrl('../convex/projectLandingCapsuleLedger.ts'));
const acceptanceStore = await import(moduleUrl('../convex/projectHostedAcceptanceStore.ts'));
const attemptStore = await import(moduleUrl('../convex/projectHostedLandingAttemptRead.ts'));
const cold = await import(moduleUrl('../convex/projectLandingCapsuleRead.ts'));
const people = await import(moduleUrl('../convex/publicPeople.ts'));
const finish = await import(moduleUrl('../convex/projectHostedFinish.ts'));
const lanes = await import(moduleUrl('../convex/projectHostedLanes.ts'));
const checks = await import(moduleUrl('../convex/projectHostedCheckRead.ts'));
const queries = {
  'projectHostedFinishObserve:page': observe.page,
  'publicPeople:resolve': people.resolve,
  'projectHostedLanding:status': api.status,
  'projectHostedLanding:attempts': api.attempts,
  'projectHostedLanding:candidate': api.candidate,
  'projectHostedFinish:inputs': finish.inputs,
  'projectHostedLanes:states': lanes.states,
  'projectHostedCheckRead:status': checks.status,
};
const owner = 'user_syntheticOwnerAAAA',
  reader = 'user_syntheticReaderBBB';

async function fixture(t) {
  const f = await landingFixture();
  f.patch('hostedProjects', f.projectId, { owner, visibility: 'public' });
  f.tables.forgeAccounts.set('forgeAccounts-synthetic', {
    _id: 'forgeAccounts-synthetic',
    _creationTime: 0,
    owner,
    handle: 'synthetic-owner',
  });
  const state = await f.enqueue(f.request(), owner);
  await f.call(
    'capsuleCancel',
    api.cancel,
    {
      projectId: f.projectId,
      request: JSON.stringify({ operationId: randomUUID(), authorityEpoch: 1, submissionId: state.id }),
    },
    owner,
  );
  const row = [...f.tables.projectHostedLandingRequests.values()].find(r => r.submissionId === state.id);
  const rows = [...f.tables.projectHostedLandingObservations.values()].filter(
    r => r.submissionId === state.id,
  );
  const capsule = {
    protocol: 1,
    projectId: f.projectId,
    submissionId: state.id,
    anchor: ticketState(f, row),
    tables: {
      projectHostedLandingObservations: rows.map(row => canonicalPayload(row)),
      projectHostedLandingAttempts: [...f.tables.projectHostedLandingAttempts.values()]
        .filter(r => r.submissionId === state.id)
        .map(row => canonicalPayload(row)),
    },
  };
  const encoded = encodeLandingCapsule(capsule);
  const request = { projectId: f.projectId, operationId: state.operationId, nextVersion: 0, priorityInfo: 1 };
  const query = actor => f.call('capsuleObserve', observe.page, request, actor);
  const relocate = (includeAttempts = false) => {
    f.patch('projectHostedLandingRequests', row._id, { capsule: encoded.pointer });
    for (const row of rows) f.tables.projectHostedLandingObservations.delete(row._id);
    if (includeAttempts)
      for (const row of [...f.tables.projectHostedLandingAttempts.values()])
        if (row.submissionId === state.id) f.tables.projectHostedLandingAttempts.delete(row._id);
  };
  const run = (actor, query = 'projectHostedFinishObserve:page', selected = request) =>
    cold.history._handler(
      {
        auth: { getUserIdentity: async () => ({ subject: actor }) },
        runQuery: (ref, args) => {
          const name = getFunctionName(ref);
          assert(queries[name], name);
          return f.call('capsuleNestedQuery', queries[name], args, actor);
        },
      },
      { projectId: f.projectId, query, request: JSON.stringify(selected) },
    );
  const synthetic = {
    R2_ACCOUNT_ID: 'synthetic',
    R2_BUCKET: 'synthetic',
    R2_ACCESS_KEY_ID: 'synthetic',
    R2_SECRET_ACCESS_KEY: 'synthetic',
    R2_ENDPOINT: 'https://synthetic.invalid',
  };
  const prior = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
  Object.assign(process.env, synthetic);
  t.after(() => {
    for (const [key, value] of Object.entries(prior))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  return { f, state, row, capsule, encoded, request, query, relocate, run };
}

test('landing capsule round trip preserves exact original row bytes and every table digest, excluding reuse aliases', async t => {
  const h = await fixture(t);
  assert.deepEqual(
    decodeLandingCapsule(h.encoded.body, h.encoded.pointer, h.f.projectId, h.state.id),
    h.capsule,
  );
  assert.throws(
    () =>
      decodeLandingCapsule(
        h.encoded.body,
        { ...h.encoded.pointer, rawSize: h.encoded.pointer.rawSize - 1 },
        h.f.projectId,
        h.state.id,
      ),
    code('EVIDENCE_CHANGED'),
  );
  assert.throws(
    () => encodeLandingCapsule({ ...h.capsule, tables: { projectHostedLandingAttempts: ['{'] } }),
    code('EVIDENCE_CHANGED'),
  );
  const changed = Buffer.from(h.encoded.body);
  changed[changed.length - 1] ^= 1;
  assert.throws(
    () => decodeLandingCapsule(changed, h.encoded.pointer, h.f.projectId, h.state.id),
    code('EVIDENCE_CHANGED'),
  );
  assert.throws(
    () =>
      decodeLandingCapsule(h.encoded.body, { ...h.encoded.pointer, tables: '[]' }, h.f.projectId, h.state.id),
    code('EVIDENCE_CHANGED'),
  );
  assert.throws(
    () =>
      encodeLandingCapsule({
        ...h.capsule,
        tables: {
          ...h.capsule.tables,
          projectHostedCheckCallbacks: [
            canonicalPayload({
              _id: 'synthetic-alias',
              projectId: h.f.projectId,
              eventId: 'reuse:synthetic',
            }),
          ],
        },
      }),
    code('EVIDENCE_CHANGED'),
  );
});

test('server-only capsuled observations match live redacted bytes for owner and public reader; old protocol gets the skew error', async t => {
  const h = await fixture(t);
  const before = new Map();
  for (const actor of [owner, reader]) before.set(actor, await h.query(actor));
  h.relocate();
  let fetches = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    fetches++;
    assert.equal(
      new URL(url).pathname,
      `/synthetic/v1/p/${h.f.projectId}/landing-capsules/${h.encoded.pointer.sha256}`,
    );
    return new Response(h.encoded.body);
  });
  await assert.rejects(h.query(owner), code('CLI_UPGRADE_REQUIRED'));
  assert.equal(fetches, 0);
  for (const actor of [owner, reader]) {
    const result = await h.run(actor);
    assert.equal(result, before.get(actor));
    assert(!result.includes(owner));
    assert(!result.includes('https://synthetic.invalid'));
    assert.equal(JSON.parse(result).landingCapsule, undefined);
  }
  assert.equal(fetches, 2, 'one verified GET per cold history read, no client object grant');
});

test('capsule history rechecks current project access before reading and after an in-flight revocation', async t => {
  const h = await fixture(t);
  h.relocate();
  h.f.patch('hostedProjects', h.f.projectId, { visibility: 'private' });
  let fetches = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetches++;
    h.f.patch('hostedProjects', h.f.projectId, { visibility: 'private' });
    return new Response(h.encoded.body);
  });
  await assert.rejects(h.query(reader), code('PROJECT_UNAVAILABLE'));
  await assert.rejects(h.run(reader), code('PROJECT_UNAVAILABLE'));
  assert.equal(fetches, 0);
  h.f.patch('hostedProjects', h.f.projectId, { visibility: 'public' });
  await assert.rejects(h.run(reader), code('PROJECT_UNAVAILABLE'));
  assert.equal(fetches, 1, 'revocation during the GET refuses before returning archived bytes');
});

test('capsuled landing status, Candidate, attempt and input replies preserve live redacted bytes after raw attempt rows move', async t => {
  const h = await fixture(t);
  const selections = [
    ['projectHostedLanding:status', { submissionId: h.state.id, priorityInfo: 1 }],
    ['projectHostedLanding:candidate', { candidateId: h.state.request.candidateId }],
    ['projectHostedLanding:attempts', { submissionId: h.state.id, cursor: null }],
    ['projectHostedFinish:inputs', { submissionId: h.state.id, attemptId: h.state.attemptId, index: 0 }],
  ];
  const before = new Map();
  for (const actor of [owner, reader])
    for (const [name, request] of selections)
      before.set(
        `${actor}:${name}`,
        await h.f.call(
          'capsuleBaseline',
          queries[name],
          {
            ...request,
            projectId: h.f.projectId,
            capsuleProtocol: 1,
          },
          actor,
        ),
      );
  h.relocate(true);
  t.mock.method(globalThis, 'fetch', async () => new Response(h.encoded.body));
  for (const actor of [owner, reader])
    for (const [name, request] of selections) {
      const result = await h.run(actor, name, request);
      assert.equal(result, before.get(`${actor}:${name}`), name);
      assert(!result.includes(owner), name);
      assert(!result.includes('/landing-capsules/'), name);
    }
});

test('archived observations use the current owner handle rather than freezing identity at packing time', async t => {
  const h = await fixture(t);
  h.relocate();
  h.f.tables.forgeAccounts.get('forgeAccounts-synthetic').handle = 'renamed-owner';
  t.mock.method(globalThis, 'fetch', async () => new Response(h.encoded.body));
  const result = await h.run(owner);
  assert.equal(JSON.parse(result).events[0].submission.actor, 'renamed-owner');
  assert(!result.includes('synthetic-owner'));
  assert(!result.includes(owner));
});

test('cold finish inputs retain exact selected heads and current Lane-relative superseded outcomes', async t => {
  const prior = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
  Object.assign(process.env, synthetic);
  t.after(() => {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const f = await finishFixture(t);
  const initial = await f.enqueue(f.request());
  await f.drain();
  await f.passChecks();
  await f.drain();
  const row = [...f.tables.projectHostedLandingRequests.values()].find(r => r.submissionId === initial.id);
  const state = ticketState(f, row);
  await f.changeLane(f.lane.laneId, { head: 'a'.repeat(64), sourceVersion: 1 });
  const request = { projectId: f.projectId, submissionId: state.id, attemptId: state.attemptId, index: 0 };
  const before = await f.tx('capsuleInputBaseline', finish.inputs, request);
  assert.equal(JSON.parse(before).entries[0].state, 'superseded');
  const names = [
    'projectHostedLandingAttempts',
    'projectHostedAcceptancePlans',
    'projectHostedAcceptancePages',
  ];
  const tables = Object.fromEntries(
    names.map(name => [name, [...f.tables[name].values()].map(row => canonicalPayload(row))]),
  );
  const encoded = encodeLandingCapsule({
    protocol: 1,
    projectId: f.projectId,
    submissionId: state.id,
    anchor: state,
    tables,
  });
  f.patch('projectHostedLandingRequests', row._id, { capsule: encoded.pointer });
  for (const text of tables.projectHostedAcceptancePages) {
    const page = JSON.parse(text);
    f.insert('projectFinishReadRows', {
      kind: ledger.capsulePageKind,
      projectId: f.projectId,
      sourceId: ledger.capsulePageKey(f.projectId, page.receiptId, page.kind, page.index),
      submissionId: state.id,
      value: ledger.compactCapsulePage(page),
    });
  }
  for (const name of names) f.tables[name].clear();
  for (const text of tables.projectHostedAcceptancePages) {
    const page = JSON.parse(text);
    const restored = await f.tx(
      'capsuleTransactionInput',
      {
        _handler: ctx =>
          acceptanceStore.acceptancePage(ctx, {
            projectId: f.projectId,
            receiptId: page.receiptId,
            kind: page.kind,
            index: page.index,
          }),
      },
      {},
    );
    assert.equal(canonicalPayload(restored), text, 'transactional Lane pins and page identity remain exact');
  }
  t.mock.method(globalThis, 'fetch', async () => new Response(encoded.body));
  const result = await cold.history._handler(
    {
      auth: { getUserIdentity: async () => ({ subject: 'owner' }) },
      runQuery: (ref, args) => f.tx('capsuleInputQuery', queries[getFunctionName(ref)], args),
    },
    { projectId: f.projectId, query: 'projectHostedFinish:inputs', request: JSON.stringify(request) },
  );
  assert.equal(result, before);
  // The current snapshot/stop-hook probe never opens historical bytes or requires protocol support.
  const probe = JSON.parse(
    await f.tx('capsulePastEnd', observe.page, {
      projectId: f.projectId,
      operationId: state.operationId,
      nextVersion: Number.MAX_SAFE_INTEGER,
    }),
  );
  assert.equal(probe.landingCapsule, undefined);
  assert.equal(probe.events.length, 0);
});

test('public-project writer revocation changes the cold marker even when the live context names only the viewer', async t => {
  const h = await fixture(t);
  h.relocate();
  h.f.tables.projectContributors.set('projectContributors-synthetic', {
    _id: 'projectContributors-synthetic',
    _creationTime: 0,
    projectId: h.f.projectId,
    contributor: reader,
  });
  const read = () =>
    h.f.call('capsuleRole', observe.page, { ...h.request, capsuleProtocol: 1 }, reader).then(JSON.parse);
  const before = await read();
  h.f.tables.projectContributors.delete('projectContributors-synthetic');
  const after = await read();
  assert.notEqual(before.landingCapsule.viewVersion, after.landingCapsule.viewVersion);
  assert(!JSON.stringify(after.landingCapsule).includes(reader));
});

test('a new live attempt after packing keeps current status live and merges archived attempts and observation versions', async t => {
  const h = await fixture(t);
  h.relocate(true);
  const original = JSON.parse(h.capsule.tables.projectHostedLandingAttempts[0]);
  const attempt = JSON.parse(original.value);
  attempt.id = randomUUID();
  attempt.parentAttemptId = h.state.attemptId;
  attempt.number++;
  const latest = { ...h.capsule.anchor, attemptId: attempt.id, version: h.capsule.anchor.version + 1 };
  h.f.patch('projectHostedLandingRequests', h.row._id, {
    attemptId: attempt.id,
    value: canonicalPayload(latest),
  });
  h.f.insert('projectHostedLandingAttempts', {
    projectId: h.f.projectId,
    submissionId: h.state.id,
    attemptId: attempt.id,
    number: attempt.number,
    value: canonicalPayload(attempt),
  });
  h.f.insert('projectHostedLandingObservations', {
    projectId: h.f.projectId,
    submissionId: h.state.id,
    version: latest.version,
    value: canonicalPayload({ submission: latest, pendingAttempt: null }),
  });
  // Build the live oracle from the same exact original rows, then relocate them again.
  for (const [table, rows] of Object.entries(h.capsule.tables))
    for (const text of rows) {
      const row = JSON.parse(text);
      h.f.tables[table].set(row._id, row);
    }
  h.f.patch('projectHostedLandingRequests', h.row._id, { capsule: undefined });
  const selections = [
    ['projectHostedFinishObserve:page', h.request],
    [
      'projectHostedLanding:attempts',
      { projectId: h.f.projectId, submissionId: h.state.id, cursor: null, capsuleProtocol: 1 },
    ],
  ];
  const before = new Map();
  for (const [name, args] of selections)
    before.set(name, await h.f.call('capsuleTailOracle', queries[name], args, owner));
  h.relocate(true);
  // relocate removed the new live attempt too: restore only that row, as a post-pack retry would.
  h.f.insert('projectHostedLandingAttempts', {
    projectId: h.f.projectId,
    submissionId: h.state.id,
    attemptId: attempt.id,
    number: attempt.number,
    value: canonicalPayload(attempt),
  });
  t.mock.method(globalThis, 'fetch', async () => new Response(h.encoded.body));
  const status = JSON.parse(
    await h.f.call(
      'capsuleTailStatus',
      api.status,
      {
        projectId: h.f.projectId,
        submissionId: h.state.id,
      },
      owner,
    ),
  );
  assert.equal(status.attempt.id, attempt.id);
  assert.equal(status.landingCapsule, undefined);
  for (const [name, args] of selections) assert.equal(await h.run(owner, name, args), before.get(name), name);
});

test('a capsule response exceeding its exact content pin is cancelled before decode or a history reply', async t => {
  const h = await fixture(t);
  h.relocate();
  let cancelled = false;
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(Buffer.concat([h.encoded.body, Buffer.alloc(1)]));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  await assert.rejects(h.run(owner), code('EVIDENCE_CHANGED'));
  assert.equal(cancelled, true);
});

test('declaring capsule support retains a valid native cursor on uncapsuled attempt history', async t => {
  const h = await fixture(t);
  const first = JSON.parse(
    await h.f.call(
      'capsuleNativeCursor',
      api.attempts,
      {
        projectId: h.f.projectId,
        submissionId: h.state.id,
        cursor: null,
      },
      owner,
    ),
  );
  const legacy = JSON.parse(
    await h.f.call(
      'capsuleNativeContinuation',
      api.attempts,
      {
        projectId: h.f.projectId,
        submissionId: h.state.id,
        cursor: first.continueCursor,
      },
      owner,
    ),
  );
  const capable = JSON.parse(
    await h.f.call(
      'capsuleCapableContinuation',
      api.attempts,
      {
        projectId: h.f.projectId,
        submissionId: h.state.id,
        cursor: first.continueCursor,
        capsuleProtocol: 1,
      },
      owner,
    ),
  );
  assert.deepEqual(capable.page, legacy.page);
  assert.equal(capable.isDone, legacy.isDone);
});

test('the separate capsule pointer preserves exact server transaction pins without adding its private summary to public replies', async t => {
  const h = await fixture(t);
  const expected = await h.f.call(
    'capsulePointerBaseline',
    api.status,
    {
      projectId: h.f.projectId,
      submissionId: h.state.id,
    },
    owner,
  );
  const raw = JSON.parse(h.capsule.tables.projectHostedLandingAttempts[0]);
  const attempt = JSON.parse(raw.value);
  // External pointers are published only after the approved grace; legacy inline pins remain readable immediately.
  t.mock.method(Date, 'now', () => Date.parse(h.capsule.anchor.at) + 8 * 86_400_000);
  h.relocate(true);
  h.f.patch('projectHostedLandingRequests', h.row._id, { capsule: undefined });
  h.f.insert('projectFinishReadRows', {
    kind: capsuleStore.capsuleKind,
    projectId: h.f.projectId,
    sourceId: h.row._id,
    submissionId: h.state.id,
    attemptId: attempt.id,
    value: canonicalPayload({ ...h.encoded.pointer, summary: canonicalPayload({ attempt }) }),
  });
  const pins = await h.f.run(
    'capsulePrivateAttempt',
    ctx =>
      attemptStore.loadLandingAttempt(ctx, {
        projectId: h.f.projectId,
        attemptId: attempt.id,
      }),
    {},
  );
  assert.deepEqual(pins, attempt);
  const marker = await h.f.call(
    'capsulePointerMarker',
    api.status,
    {
      projectId: h.f.projectId,
      submissionId: h.state.id,
      capsuleProtocol: 1,
    },
    owner,
  );
  assert(!marker.includes('summary'));
  assert(!marker.includes(owner));
  t.mock.method(globalThis, 'fetch', async () => new Response(h.encoded.body));
  assert.equal(await h.run(owner, 'projectHostedLanding:status', { submissionId: h.state.id }), expected);
});
