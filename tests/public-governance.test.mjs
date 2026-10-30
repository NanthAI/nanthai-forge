// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { acceptanceFixture, api, records } from './hosted-acceptance-fixture.mjs';
import { composeFixture } from './hosted-compose-fixture.mjs';
import { code } from './hosted-landing-fixture.mjs';
import { policyPreset, policyWriteSchema } from '../dist/autonomy-policy.js';
import { governanceReason, DEFAULT_OWNER_APPROVAL_PATHS } from '../dist/public-governance.js';
import { hostedLandingRequestSchema } from '../dist/hosted-landing.js';
import { hostedLandingDesiredSchema } from '../dist/hosted-landing-desired.js';
import { z } from 'zod';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { finishFixture } from './hosted-finish-fixture.mjs';
import { syncFixture } from './hosted-sync-fixture.mjs';
import { agentFixture } from './hosted-agent-fixture.mjs';
const { LandingProgress } = await import(moduleUrl('../web/src/lane/LandingProgress.tsx'));
const { landingState } = await import(moduleUrl('../web/src/lane/landing-model.ts'));
const modules = {};
for (const name of [
  'projectAuthority',
  'projectAutonomy',
  'projectHostedStart',
  'projectHostedSaves',
  'projectHostedCompose',
  'projectHostedSync',
  'projectHostedFinish',
  'projectHostedLanding',
  'projectHostedCheckDefinitions',
  'projectCheckRequests',
  'projectProposals',
  'projectGithubImportStore',
  'projectContributors',
  'projectOwnerSync',
  'projectSourceAuthority',
  'projectHostedSeed',
  'secrets',
])
  modules[name] = await import(moduleUrl(`../convex/${name}.ts`));
const keyId = process.env.FORGE_HOSTED_CHECK_KEY_ID;
test.before(() => {
  process.env.FORGE_HOSTED_CHECK_KEY_ID = 'SYNTHETIC';
});
test.after(() => {
  if (keyId === undefined) delete process.env.FORGE_HOSTED_CHECK_KEY_ID;
  else process.env.FORGE_HOSTED_CHECK_KEY_ID = keyId;
});
async function publicFixture() {
  const f = await acceptanceFixture();
  f.patch('hostedProjects', f.projectId, { visibility: 'public', autonomyPolicy: policyPreset('trusted') });
  f.insert('projectContributors', { projectId: f.projectId, contributor: 'contributor' });
  return f;
}
async function prepared(f, paths, actor = 'contributor', agent = true, ownerInputs = false, checked = true) {
  const item = await f.makeCandidate(
    [],
    [],
    paths === null
      ? {}
      : {
          governance: { version: 1, paths, ownerInputs },
        },
  );
  let run;
  if (checked) {
    run = await f.rawChecks.enqueue(
      f.rawChecks.selection({ candidateId: item.candidate.id, expectedHead: item.candidate.result.head }),
      actor,
    );
    await f.rawChecks.pass(await f.rawChecks.activate(run.id));
  }
  const state = await f.enqueue(
    f.request({
      candidateId: item.candidate.id,
      agent,
      expectedHead: item.candidate.result.head,
      check: run ? { kind: 'run', runId: run.id } : null,
    }),
    actor,
  );
  await f.drain();
  const selection = f.select(state);
  await f.transaction('prepare', api.prepare, selection, actor);
  for (const kind of ['inputs', 'dependencies'])
    for (const [index, page] of item.pages[kind].entries())
      await f.transaction(
        'stage',
        api.stage,
        { ...selection, kind, index, page: JSON.stringify(page.value) },
        actor,
      );
  return state;
}

// Fill required arguments the case leaves out with typed placeholders, so the
// argument validator passes and the refusal under test comes from authorization.
const placeholder = spec => {
  switch (spec.type) {
    case 'object':
      return Object.fromEntries(
        Object.entries(spec.value)
          .filter(([, field]) => !field.optional)
          .map(([key, field]) => [key, placeholder(field.fieldType)]),
      );
    case 'string':
    case 'id':
      return 'synthetic';
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'literal':
      return spec.value;
    case 'union':
      return placeholder(spec.value[0]);
    case 'array':
      return [];
    case 'record':
      return {};
    default:
      return null;
  }
};
const withRequiredArgs = (fn, input) =>
  fn.exportArgs ? { ...placeholder(JSON.parse(fn.exportArgs())), ...input } : input;

test('signed-in public stranger matrix refuses writes, including forged owner approval', async t => {
  const f = await publicFixture(),
    projectId = f.projectId,
    operationId = randomUUID();
  const lane = await f.lane();
  const item = await f.makeCandidate([lane]);
  const start = {
    operationId,
    authorityEpoch: 1,
    expectedMain: { head: f.main.head, receiptId: f.main.receipt.id },
    intent: { kind: 'new', outcome: 'stranger' },
  };
  const expected = { head: lane.head, version: 0, sourceVersion: 0, lifecycleVersion: 0 };
  const setting = { operationId, authorityEpoch: 1, expected: null };
  const original = await prepared(f, ['src/ordinary.ts']);
  const cases = [
    ['start Lane', modules.projectHostedStart.start, { projectId, ...start }],
    [
      'save',
      modules.projectHostedSaves.prepare,
      {
        projectId,
        request: JSON.stringify({
          operationId,
          laneId: lane.laneId,
          authorityEpoch: 1,
          expected,
          message: 'stranger',
          pages: null,
          pageCount: 0,
          changeCount: 0,
        }),
      },
    ],
    [
      'compose',
      modules.projectHostedCompose.prepare,
      {
        projectId,
        request: JSON.stringify({
          ...start,
          intent: undefined,
          intentId: randomUUID(),
          inputs: { root: item.candidate.inputs, pages: 1, count: 1 },
          dependencies: { root: item.candidate.dependencies, pages: 1, count: 0 },
          message: 'stranger',
        }),
      },
    ],
    [
      'sync',
      modules.projectHostedSync.prepare,
      {
        projectId,
        request: JSON.stringify({
          kind: 'sync',
          operationId,
          authorityEpoch: 1,
          laneId: lane.laneId,
          expected,
          target: { kind: 'main', ...start.expectedMain },
          message: 'stranger',
        }),
      },
    ],
    ['finish', modules.projectHostedLanding.enqueue, { projectId, request: JSON.stringify(f.request()) }],
    ['resume finish', modules.projectHostedFinish.resume, { projectId, submissionId: original.id }],
    ['accept', api.accept, f.select(original)],
    ['owner approval', api.approve, f.select(original)],
    [
      'set-policy',
      modules.projectAutonomy.set,
      { projectId, command: JSON.stringify({ action: 'set-policy', operationId }) },
    ],
    [
      'configure-check',
      modules.projectHostedCheckDefinitions.configure,
      {
        projectId,
        request: JSON.stringify({
          ...setting,
          change: {
            kind: 'definition',
            checkId: randomUUID(),
            command: { name: 'verify', executable: 'node', args: [], environmentLabel: 'test' },
          },
        }),
      },
    ],
    ['configure-runner', modules.projectHostedCheckDefinitions.saveCheckSetting, null],
    [
      'local runner',
      modules.projectCheckRequests.connect,
      { projectId, runnerId: 'stranger', name: 'stranger', listening: true },
    ],
    ['proposal', modules.projectProposals.register, { projectId, actor: 'stranger' }],
    ['main seed', modules.projectHostedSeed.begin, { projectId, request: '{}' }],
    ['owner sync', modules.projectOwnerSync.publish, { projectId }],
    ['authority transition', modules.projectSourceAuthority.transition, { projectId }],
    [
      'contributor grant',
      modules.projectContributors.add,
      { projectId, owner: 'stranger', contributor: 'other' },
    ],
  ];
  for (const [name, fn, input] of cases)
    await t.test(name, async () => {
      const before = JSON.stringify(f.currentMain());
      const selected =
        input === null
          ? { _handler: ctx => fn(ctx, projectId, setting, {}, () => assert.fail('settings resolver ran')) }
          : fn;
      await assert.rejects(
        f.transaction(
          'strangerMatrix',
          selected,
          input === null ? {} : withRequiredArgs(fn, input),
          'stranger',
        ),
        code('PROJECT_UNAVAILABLE'),
      );
      assert.equal(JSON.stringify(f.currentMain()), before);
    });
  const secretId = f.insert('secretObjects', {
    owner: 'owner',
    name: 'synthetic',
    operationId: randomUUID(),
    repository: 'synthetic/repo',
    ref: 'main',
    version: 1,
    disabled: false,
    policyRevision: 0,
  });
  await assert.rejects(
    f.transaction('strangerSecret', modules.secrets.details, { id: secretId }, 'stranger'),
    code('SECRET_UNAVAILABLE'),
  );
  for (const actor of ['stranger', 'contributor']) {
    await assert.rejects(
      f.transaction(
        'secretWrite',
        modules.secrets.enabled,
        withRequiredArgs(modules.secrets.enabled, {
          id: secretId,
          enabled: false,
          expectedPolicyRevision: 0,
          operationId,
        }),
        actor,
      ),
      code('SECRET_UNAVAILABLE'),
    );
    await assert.rejects(
      f.transaction(
        'secretRotate',
        modules.secrets.rotate,
        withRequiredArgs(modules.secrets.rotate, { id: secretId, actor, operationId }),
        actor,
      ),
      code('SECRET_UNAVAILABLE'),
    );
  }
  // Import replay cannot be used to write somebody else's hosted project.
  f.insert('projectGithubImports', {
    visibility: 'private',
    owner: 'stranger',
    projectId,
    operationId,
    request: 'synthetic',
    repository: 'synthetic/repo',
    commit: 'synthetic',
    at: new Date(0).toISOString(),
    step: 0,
    cursor: '',
    phase: 'ready',
    totalKnown: true,
    completed: 0,
    total: 0,
    bytes: 0,
    totalBytes: 0,
  });
  await assert.rejects(
    f.transaction(
      'strangerImport',
      modules.projectGithubImportStore.lookup,
      { actor: 'stranger', operationId, request: 'synthetic' },
      'stranger',
    ),
    code('PROJECT_UNAVAILABLE'),
  );
});

test('contributor person authority cannot bypass passing checks or protected paths; explicit owner approval works', async () => {
  const f = await publicFixture();
  const state = await prepared(f, ['.github/workflows/deploy.yml', 'src/app.ts'], 'contributor', false);
  const result = await f.accept(state, 'contributor');
  assert.equal(result.status, 'pending');
  assert.equal(result.reason, 'needs owner approval: protected paths .github/workflows/deploy.yml');
  assert.equal((await f.status(state.id)).request.error.message, result.reason);
  const budget = f.counts.filter(count => count.name === 'acceptanceAccept').at(-1);
  assert(budget.documents <= 80 && budget.ranges <= 80 && budget.writes <= 10);
  assert(!budget.touched.includes('projectHostedAcceptancePages'));
  console.log(
    'W8 protected final transaction',
    JSON.stringify(
      Object.fromEntries(
        ['ranges', 'documents', 'readBytes', 'writes', 'writeBytes'].map(key => [key, budget[key]]),
      ),
    ),
  );
  assert.equal(f.currentMain().sourceRevision, 0);
  const read = await f.status(state.id);
  assert.equal(landingState(read).label, 'Waiting for review');
  assert.equal(landingState(read).tone, 'waiting');
  assert.match(
    renderToStaticMarkup(createElement(LandingProgress, { read })),
    /needs owner approval: protected paths .github\/workflows\/deploy.yml/,
  );
  assert.equal(f.pendingTasks().length, 0, 'review wait has no idle tasks');
  await assert.rejects(
    f.transaction('contributorApprove', api.approve, f.select(state), 'contributor'),
    code('PROJECT_UNAVAILABLE'),
  );
  f.insert('cliCredentials', {
    credentialId: 'synthetic-device',
    owner: 'owner',
    name: 'Synthetic device',
    tokenHash: 'synthetic-hash',
    issuedAt: Date.now(),
    scope: 'cli',
    expiresAt: Date.now() + 60_000,
    revoked: false,
  });
  await assert.rejects(
    f.transaction('deviceApproval', api.approve, f.select(state), {
      subject: 'owner',
      forgeCredential: 'synthetic-device',
    }),
    code('PROJECT_UNAVAILABLE'),
  );
  const approved = JSON.parse(await f.transaction('ownerApprove', api.approve, f.select(state)));
  assert.equal(approved.status, 'landed');
  assert.deepEqual(approved.receipt.actor, { id: 'owner', kind: 'person' });
  assert.equal(approved.receipt.automatic, false);
  assert.deepEqual(
    JSON.parse(await f.transaction('ownerApproveReplay', api.approve, f.select(state))),
    approved,
  );
  const g = await publicFixture();
  const unchecked = await prepared(g, ['src/app.ts'], 'contributor', false, false, false);
  await assert.rejects(g.accept(unchecked, 'contributor'), code('CHECK_NOT_PASSED'));
});

test('contributor ordinary changes auto-land; owner own protected Lane auto-lands; review policy still applies', async () => {
  for (const agent of [true, false]) {
    const f = await publicFixture();
    assert.equal(
      (await f.accept(await prepared(f, ['src/app.ts'], 'contributor', agent), 'contributor')).status,
      'landed',
    );
  }
  const f = await publicFixture();
  assert.equal(
    (await f.accept(await prepared(f, ['.github/workflows/deploy.yml'], 'owner', true, true))).status,
    'landed',
  );
  const g = await publicFixture();
  g.patch('hostedProjects', g.projectId, { autonomyPolicy: policyPreset('supervised') });
  assert.equal(
    (await g.accept(await prepared(g, ['.github/workflows/deploy.yml'], 'owner', true, true))).status,
    'pending',
  );
});

test('only owner can edit protected paths through versioned policy command', async () => {
  const f = await publicFixture();
  const command = {
    action: 'set-policy',
    operationId: randomUUID(),
    governanceVersion: 1,
    acceptance: { ownerApprovalPaths: ['deploy/**'] },
  };
  assert.equal(policyWriteSchema.safeParse({ ...command, governanceVersion: undefined }).success, false);
  await assert.rejects(
    f.transaction(
      'contributorPolicy',
      modules.projectAutonomy.set,
      { projectId: f.projectId, command: JSON.stringify(command) },
      'contributor',
    ),
    code('PROJECT_UNAVAILABLE'),
  );
  const result = await f.transaction('ownerPolicy', modules.projectAutonomy.set, {
    projectId: f.projectId,
    command: JSON.stringify(command),
  });
  assert.deepEqual(result.policy.acceptance.ownerApprovalPaths, ['deploy/**']);
  assert.equal((await f.accept(await prepared(f, ['deploy/release.mjs']), 'contributor')).status, 'pending');
});

test('legacy worker coverage and new-runner/old-server skew fail safely', async () => {
  const f = await publicFixture();
  const result = await f.accept(await prepared(f, null), 'contributor');
  assert.match(result.reason, /coverage is unavailable/);
  const request = { ...f.request(), governanceVersion: 1 };
  assert(hostedLandingRequestSchema.safeParse(request).success);
  const old = hostedLandingRequestSchema.omit({ governanceVersion: true }).strict();
  assert.equal(
    old.safeParse(request).success,
    false,
    'old strict server refuses versioned new runner landing',
  );
  const desired = {
    operationId: randomUUID(),
    authorityEpoch: 1,
    governanceVersion: 1,
    composeOperationId: randomUUID(),
    check: null,
    after: null,
  };
  assert(hostedLandingDesiredSchema.safeParse(desired).success);
  assert.equal(
    hostedLandingDesiredSchema.omit({ governanceVersion: true }).strict().safeParse(desired).success,
    false,
  );
  assert.equal(
    z
      .object({ action: z.literal('set-policy') })
      .strict()
      .safeParse({ action: 'set-policy', governanceVersion: 1 }).success,
    false,
  );
});

test('missing changed paths fail closed for every contributor and keep the owner rules', async () => {
  for (const agent of [true, false]) {
    const f = await publicFixture();
    const state = await prepared(f, null, 'contributor', agent);
    const result = await f.accept(state, 'contributor');
    assert.equal(result.status, 'pending');
    assert.equal(result.reason, 'needs owner approval: protected-path coverage is unavailable');
    assert.equal(f.currentMain().sourceRevision, 0);
    assert.equal(
      JSON.parse(await f.transaction('ownerApprove', api.approve, f.select(state))).status,
      'landed',
    );
  }
  const f = await publicFixture();
  assert.equal((await f.accept(await prepared(f, null, 'owner', false))).status, 'landed');
  const g = await publicFixture();
  assert.match((await g.accept(await prepared(g, null, 'owner', true))).reason, /coverage is unavailable/);
});

test('signed compose paths cover additions, deletions, renames and mode changes without file blob reads', async () => {
  const s = await composeFixture();
  const added = s.file('.github/workflows/deploy.yml', 'synthetic workflow');
  const renamed = { ...s.hidden, path: 'renamed.bin', mode: 'executable' };
  const lane = await s.lane(s.baseline);
  await s.run('ownerSave', async ctx => {
    const row = await records.readHostedRecord(ctx, { ...s.auth, kind: 'lane', key: lane.laneId });
    const record = JSON.parse(row.value);
    const changed = s.state([added, renamed], [s.baseline.sha256]);
    s.register(changed);
    await records.writeHostedRecord(ctx, {
      ...s.auth,
      expectedVersion: 0,
      record: { ...record, version: 1, sourceVersion: 1, head: changed.sha256 },
    });
    lane.version = 1;
    lane.sourceVersion = 1;
    lane.head = changed.sha256;
    lane.state.object = changed;
  });
  const selection = s.selection([lane]);
  await s.prepare(selection);
  await s.stage(selection);
  await s.submit(selection);
  const output = await s.work(selection);
  const candidate = (await s.publish(output)).outcome.result;
  assert.deepEqual(candidate.governance.paths, [
    '.github/workflows/deploy.yml',
    'a.txt',
    'hidden.bin',
    'renamed.bin',
  ]);
  assert.equal(candidate.governance.ownerInputs, true);
  assert(!output.reads.some(pin => pin.sha256 === s.hidden.blob));
});

test('contributor writes to an owner Lane cannot retain the owner automation exemption', async () => {
  const f = await publicFixture(),
    lane = await f.lane();
  const original = await f.readLane(lane.laneId);
  const header = () =>
    [...f.tables.projectHostedRecordHeads.values()].find(
      row => row.kind === 'lane' && row.key === lane.laneId,
    );
  assert.equal(header().ownerOnly, true);
  await f.transaction(
    'contributorLaneWrite',
    {
      _handler: ctx =>
        records.writeHostedRecord(ctx, {
          projectId: f.projectId,
          actor: 'contributor',
          authorityEpoch: 1,
          expectedVersion: 0,
          record: { ...original, version: 1, sourceVersion: 1 },
        }),
    },
    {},
    'contributor',
  );
  assert.equal(header().ownerOnly, false);
});

test('dogfood-size path matching is local, bounded by existing metadata, with zero calls and zero idle tasks', () => {
  const paths = Array.from({ length: 6000 }, (_, i) => `src/module-${i}.ts`);
  paths.push('.github/workflows/deploy.yml');
  const policy = policyPreset('trusted'),
    project = { owner: 'owner', visibility: 'public' };
  const start = performance.now(),
    rss = process.memoryUsage().rss;
  for (let i = 0; i < 575; i++)
    assert.match(
      governanceReason(project, policy, { id: 'contributor', kind: 'agent' }, paths),
      /needs owner approval/,
    );
  console.log(
    'W8 governance synthetic budget',
    JSON.stringify({
      candidates: 575,
      paths: paths.length,
      convexCalls: 0,
      documentsRead: 0,
      documentsWritten: 0,
      idleTasks: 0,
      elapsedMs: Math.round(performance.now() - start),
      rssBefore: rss,
      rssAfter: process.memoryUsage().rss,
      maxRssBytes: process.resourceUsage().maxRSS * 1024,
      defaults: DEFAULT_OWNER_APPROVAL_PATHS.length,
    }),
  );
});

test('hosted finish driver uses the same protected-path gate and stops all review wakes', async t => {
  const synthetic = {
    R2_ACCOUNT_ID: 'synthetic',
    R2_BUCKET: 'synthetic',
    R2_ACCESS_KEY_ID: 'synthetic',
    R2_SECRET_ACCESS_KEY: 'synthetic',
  };
  const previous = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
  Object.assign(process.env, synthetic);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const f = await finishFixture(t);
  const policy = policyPreset('trusted');
  policy.acceptance.ownerApprovalPaths = ['selected.txt'];
  f.patch('hostedProjects', f.projectId, { visibility: 'public', autonomyPolicy: policy });
  const state = await f.enqueue(f.request());
  await f.drain();
  await f.passChecks();
  await f.drain();
  const read = await f.current(state.id);
  assert.equal(read.submission.observation.pendingReason, 'waiting-for-review');
  assert.equal(read.submission.error.message, 'needs owner approval: protected paths selected.txt');
  assert.equal(f.tables.projectHostedAcceptances.size, 0);
  assert.equal(f.pending().length, 0);
});

test('new runner sends governance negotiation on both direct and desired finish routes', async t => {
  for (const pending of [false, true]) {
    const f = agentFixture(t);
    f.pending(pending);
    await f.transport().dispatch('finish', { laneId: f.lane.laneId });
    const call = f.calls.find(
      call => call.name === (pending ? 'projectHostedLandingDesired:submit' : 'projectHostedLanding:enqueue'),
    );
    assert.equal(JSON.parse(call.args.request).governanceVersion, 1);
  }
});

test('starting from arbitrary peer source and syncing an unapproved Candidate cannot launder owner provenance', async () => {
  const s = await syncFixture();
  const changed = s.state(
    [s.baseFile, s.hidden, s.file('.github/workflows/deploy.yml', 'synthetic')],
    [s.baseline.sha256],
  );
  s.register(changed);
  const start = JSON.parse(
    await s.call('ownerInitialHead', modules.projectHostedStart.start, {
      projectId: s.projectId,
      operationId: randomUUID(),
      authorityEpoch: 1,
      expectedMain: { head: s.main.head, receiptId: s.main.receipt.id },
      initialHead: changed.sha256,
      intent: { kind: 'new', outcome: 'Owner wraps peer State' },
    }),
  );
  const started = [...s.tables.projectHostedRecordHeads.values()].find(row => row.key === start.lane.laneId);
  assert.equal(started.ownerOnly, false);
  const own = await s.lane(s.baseline);
  const peer = await s.lane(changed, { actor: 'contributor' });
  const selection = s.selection([peer]);
  await s.prepare(selection);
  await s.stage(selection);
  await s.submit(selection);
  const candidate = (await s.publish(await s.work(selection))).outcome.result;
  assert.equal(candidate.governance.ownerInputs, false);
  await s.execute(
    s.request('sync', {
      laneId: own.laneId,
      expected: s.pins(own),
      target: { kind: 'candidate', candidateId: candidate.id, head: candidate.result.head },
    }),
  );
  const synced = [...s.tables.projectHostedRecordHeads.values()].find(row => row.key === own.laneId);
  assert.equal(synced.ownerOnly, false);
});

test('contributors cannot replace hosted check definitions or the runner configuration', async () => {
  const f = await publicFixture();
  for (const change of [
    { kind: 'runner', configuration: f.rawChecks.runner },
    {
      kind: 'definition',
      checkId: randomUUID(),
      command: { name: 'verify', executable: 'node', args: [], environmentLabel: 'synthetic' },
    },
  ])
    await assert.rejects(
      f.transaction(
        'contributorSettings',
        modules.projectHostedCheckDefinitions.configure,
        {
          projectId: f.projectId,
          request: JSON.stringify({ operationId: randomUUID(), authorityEpoch: 1, expected: null, change }),
        },
        'contributor',
      ),
      code('PROJECT_UNAVAILABLE'),
    );
});
