// SPDX-License-Identifier: Apache-2.0
import { observerProjectionBudget } from './observer-projection-budget.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { acceptanceFixture, api, records } from './hosted-acceptance-fixture.mjs';
import { composeFixture } from './hosted-compose-fixture.mjs';
import { code } from './hosted-landing-fixture.mjs';
import { policyPreset as preset, policyWriteSchema } from '../dist/autonomy-policy.js';
// Server preflight gate (Issue 029138ef) has its own tests (hosted-landing-desired.test.mjs).
const policyPreset = name => ({ ...preset(name), agentDefaults: { preflight: 'advise' } });
import { governanceReason, DEFAULT_OWNER_APPROVAL_PATHS } from '../dist/public-governance.js';
import { protectedGatePaths } from '../dist/contract-gate-policy.js';
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
  'projectHostedApprovals',
  'projectCheckRequests',
  'projectProposals',
  'projectGithubImportStore',
  'projectContributors',
  'projectGithubStatus',
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
    // The submitter authors its Candidate: only the author or the owner may submit it (8809fba5).
    actor,
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
    ['owner sync', modules.projectGithubStatus.publish, { projectId }],
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
  const source = observerProjectionBudget(budget);
  assert(source.documents <= 80 && source.ranges <= 80 && source.writes <= 10);
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

// Issue 56bf031f: every project's own check entry files are owner-approval paths by default.
async function projectCheckFixture(args) {
  const f = await publicFixture();
  f.rawChecks.definition = await f.rawChecks.configure(
    {
      kind: 'definition',
      checkId: f.rawChecks.checkId,
      command: { name: 'verify', environmentLabel: 'clean', executable: 'bash', args },
    },
    f.rawChecks.definition.digest,
  );
  // The fixture's selection captured the first definition; select the reconfigured one.
  const select = f.rawChecks.selection;
  f.rawChecks.selection = overrides =>
    select({ expectedDefinition: f.rawChecks.definition.digest, ...overrides });
  return f;
}
test('a contributor change to the project check entry needs owner approval; Forge defaults and ordinary paths are unchanged', async () => {
  const f = await projectCheckFixture(['.bench/ci.sh']);
  const state = await prepared(f, ['.bench/ci.sh', 'src/app.ts'], 'contributor', true);
  const result = await f.accept(state, 'contributor');
  assert.equal(result.status, 'pending');
  assert.equal(result.reason, 'needs owner approval: protected paths .bench/ci.sh');
  assert.equal(f.currentMain().sourceRevision, 0);
  assert.equal(
    JSON.parse(await f.transaction('ownerApprove', api.approve, f.select(state))).status,
    'landed',
  );
  // Forge's own protected path still needs approval; an ordinary path still auto-lands.
  const g = await projectCheckFixture(['.bench/ci.sh']);
  assert.match(
    (await g.accept(await prepared(g, ['.github/workflows/deploy.yml']), 'contributor')).reason,
    /protected paths \.github\/workflows\/deploy\.yml/,
  );
  const h = await projectCheckFixture(['.bench/ci.sh']);
  assert.equal((await h.accept(await prepared(h, ['src/app.ts']), 'contributor')).status, 'landed');
  // Issue 470ef29b: an owner-account agent is held like any agent, even on its own owner-only Lane.
  const i = await projectCheckFixture(['.bench/ci.sh']);
  const held = await i.accept(await prepared(i, ['.bench/ci.sh'], 'owner', true, true));
  assert.equal(held.status, 'pending');
  assert.equal(held.reason, 'needs owner approval: protected paths .bench/ci.sh');
});

test('check entry protection is a default: unrelated project files, path-free checks and explicit lists are unaffected', () => {
  const project = { owner: 'owner', visibility: 'public' },
    actor = { id: 'contributor', kind: 'agent' },
    policy = policyPreset('trusted'),
    check = { executable: 'bash', args: ['.bench/ci.sh'] };
  const reason = (paths, run, p = policy) => governanceReason(project, p, actor, paths, run);
  assert.equal(reason(['.bench/ci.sh']), null, 'no check: not protected');
  assert.match(reason(['.bench/ci.sh'], check), /protected paths \.bench\/ci\.sh/);
  assert.equal(reason(['.bench/other.sh', 'src/a.ts'], check), null);
  assert.equal(reason(['package.json'], { executable: 'npm', args: ['test'] }), null);
  assert.match(reason(['scripts/forge-check.mjs'], check), /protected paths/);
  const explicit = { ...policy, acceptance: { ...policy.acceptance, ownerApprovalPaths: ['deploy/**'] } };
  assert.equal(reason(['.bench/ci.sh'], check, explicit), null, 'an explicit list replaces the defaults');
  assert.equal(protectedGatePaths(policy, ['.bench/ci.sh']), false);
  assert.equal(protectedGatePaths(policy, ['.bench/ci.sh'], check), true);
  assert.equal(protectedGatePaths(policy, ['src/a.ts'], check), false);
});

// Issue 8eccbea9: every defined check and setup action, not only the gating check, is protected.
test('entry files of every defined check and setup action need owner approval; explicit lists and Forge paths unchanged', async () => {
  const gating = {
    executable: 'bash',
    args: ['.bench/ci.sh'],
    actions: { setup: { executable: 'bash', args: ['.bench/setup.sh'] } },
  };
  const other = { executable: 'node', args: ['tools/lint-check.mjs'] };
  const project = { owner: 'owner', visibility: 'public' },
    actor = { id: 'contributor', kind: 'agent' },
    policy = policyPreset('trusted');
  const reason = (paths, checks, p = policy) => governanceReason(project, p, actor, paths, checks);
  assert.match(reason(['.bench/setup.sh'], gating), /protected paths \.bench\/setup\.sh/);
  assert.match(reason(['tools/lint-check.mjs'], [gating, other]), /protected paths tools\/lint-check\.mjs/);
  assert.equal(reason(['tools/lint-check.mjs'], gating), null, 'a check not passed in is not known');
  assert.equal(reason(['src/a.ts', 'tools/other.mjs'], [gating, other]), null);
  const explicit = { ...policy, acceptance: { ...policy.acceptance, ownerApprovalPaths: ['deploy/**'] } };
  assert.equal(reason(['.bench/setup.sh', 'tools/lint-check.mjs'], [gating, other], explicit), null);
  assert.equal(protectedGatePaths(policy, ['.bench/setup.sh'], gating), true);
  assert.equal(protectedGatePaths(policy, ['tools/lint-check.mjs'], [gating, other]), true);
  assert.equal(protectedGatePaths(policy, ['tools/lint-check.mjs'], [gating]), false);
});

test('a contributor change to a non-gating check or a setup action needs owner approval at acceptance', async () => {
  const entry = async (f, args, actions) =>
    f.rawChecks.configure(
      {
        kind: 'definition',
        checkId: randomUUID(),
        command: {
          name: 'lint',
          environmentLabel: 'clean',
          executable: 'node',
          args,
          ...(actions ? { actions } : {}),
        },
      },
      null,
    );
  for (const [path, args, actions] of [
    ['tools/lint-check.mjs', ['tools/lint-check.mjs']],
    ['.bench/prepare.sh', ['--version'], { setup: { executable: 'bash', args: ['.bench/prepare.sh'] } }],
  ]) {
    const f = await projectCheckFixture(['.bench/ci.sh']);
    await entry(f, args, actions);
    assert.deepEqual(
      f.tables.hostedProjects.get(f.projectId).checkEntries,
      ['.bench/ci.sh', path].sort(),
      'derived list on the project row',
    );
    const result = await f.accept(await prepared(f, [path, 'src/app.ts']), 'contributor');
    assert.equal(result.status, 'pending', path);
    assert.equal(result.reason, `needs owner approval: protected paths ${path}`);
    // An ordinary path next to the same definitions still auto-lands.
    const g = await projectCheckFixture(['.bench/ci.sh']);
    await entry(g, args, actions);
    assert.equal((await g.accept(await prepared(g, ['src/app.ts']), 'contributor')).status, 'landed', path);
  }
});

test('declared globalRiskPaths fold into the project row apart from protected check entries', async () => {
  const f = await projectCheckFixture(['.bench/ci.sh']);
  await f.rawChecks.configure(
    {
      kind: 'definition',
      checkId: randomUUID(),
      command: {
        name: 'lint',
        environmentLabel: 'clean',
        executable: 'node',
        args: ['tools/lint-check.mjs'],
        globalRiskPaths: ['spec/harness/**', 'tools/env.sh'],
      },
    },
    null,
  );
  const project = f.tables.hostedProjects.get(f.projectId);
  assert.deepEqual(project.checkEntries, ['.bench/ci.sh', 'tools/lint-check.mjs']);
  assert.deepEqual(project.globalRiskPaths, ['spec/harness/**', 'tools/env.sh']);
  // Risk for landing order and reuse only: a contributor change there needs no owner approval.
  const result = await f.accept(await prepared(f, ['spec/harness/env.rb', 'src/app.ts']), 'contributor');
  assert.equal(result.status, 'landed');
});

test('contributor ordinary changes auto-land; owner-account agents hold on protected paths; review policy still applies', async () => {
  for (const agent of [true, false]) {
    const f = await publicFixture();
    assert.equal(
      (await f.accept(await prepared(f, ['src/app.ts'], 'contributor', agent), 'contributor')).status,
      'landed',
    );
  }
  // Issue 470ef29b: owner-only inputs no longer exempt the owner's agent from the owner-approval list.
  const f = await publicFixture();
  assert.match(
    (await f.accept(await prepared(f, ['.github/workflows/deploy.yml'], 'owner', true, true))).reason,
    /needs owner approval: protected paths \.github\/workflows\/deploy\.yml/,
  );
  const ordinary = await publicFixture();
  assert.equal(
    (await ordinary.accept(await prepared(ordinary, ['src/app.ts'], 'owner', true, true))).status,
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

// Issue 470ef29b: an agent signed in with the owner's account (a device credential) is an agent.
const DEVICE = { subject: 'owner', forgeCredential: 'synthetic-owner-device' };
function ownerDevice(f) {
  f.insert('cliCredentials', {
    credentialId: DEVICE.forgeCredential,
    owner: 'owner',
    name: 'Synthetic owner device',
    tokenHash: 'synthetic-owner-hash',
    issuedAt: Date.now(),
    scope: 'cli',
    expiresAt: Date.now() + 600_000,
    revoked: false,
  });
}
const policyCommand = fields =>
  JSON.stringify({ action: 'set-policy', operationId: randomUUID(), ...fields });

test('an owner-account agent changing the check entry file holds for the owner person, on public and private projects', async () => {
  for (const visibility of ['public', 'private']) {
    const f = await projectCheckFixture(['.bench/ci.sh']);
    f.patch('hostedProjects', f.projectId, { visibility });
    ownerDevice(f);
    // Owner-only inputs (the owner's own Lane), submitted and accepted from an owner device sign-in.
    const state = await prepared(f, ['.bench/ci.sh', 'src/app.ts'], 'owner', true, true);
    const held = await f.accept(state, DEVICE);
    assert.equal(held.status, 'pending', visibility);
    assert.equal(held.reason, 'needs owner approval: protected paths .bench/ci.sh', visibility);
    assert.equal(f.currentMain().sourceRevision, 0);
    // The same device cannot approve it; the owner person can, in one step.
    await assert.rejects(
      f.transaction('deviceApprove', api.approve, f.select(state), DEVICE),
      code('PROJECT_UNAVAILABLE'),
    );
    const approved = JSON.parse(await f.transaction('ownerApprove', api.approve, f.select(state)));
    assert.equal(approved.status, 'landed', visibility);
    assert.deepEqual(approved.receipt.actor, { id: 'owner', kind: 'person' });
  }
  // A private project's ordinary owner-agent change is unchanged: it auto-lands.
  const g = await projectCheckFixture(['.bench/ci.sh']);
  g.patch('hostedProjects', g.projectId, { visibility: 'private' });
  ownerDevice(g);
  assert.equal(
    (await g.accept(await prepared(g, ['src/app.ts'], 'owner', true, true), DEVICE)).status,
    'landed',
  );
  // The owner person keeps the fast path, protected paths included.
  const h = await projectCheckFixture(['.bench/ci.sh']);
  assert.equal(
    (await h.accept(await prepared(h, ['.bench/ci.sh'], 'owner', false, true), 'owner')).status,
    'landed',
  );
});

test('owner-device settings writes apply before the first landing and are held for the owner person after it', async () => {
  const f = await publicFixture();
  ownerDevice(f);
  const settings = {
    policy: (actor, command) =>
      f.transaction('policy', modules.projectAutonomy.set, { projectId: f.projectId, command }, actor),
    definition: (actor, operationId = randomUUID()) =>
      f.rawChecks.configure(
        {
          kind: 'definition',
          checkId: f.rawChecks.checkId,
          command: { name: 'verify', environmentLabel: 'clean', executable: 'bash', args: ['ci.sh'] },
        },
        f.rawChecks.definition.digest,
        operationId,
        actor,
      ),
    runner: (actor, operationId = randomUUID()) =>
      f.rawChecks.configure(
        { kind: 'runner', configuration: { ...f.rawChecks.runner, runsOn: 'ubuntu-24.04' } },
        f.rawChecks.configuration.digest,
        operationId,
        actor,
      ),
  };
  // Bootstrap: no accepted landing yet, so an agent's setup writes still apply directly.
  const boot = await settings.policy(DEVICE, policyCommand({ acceptance: { protectedPaths: ['boot/**'] } }));
  assert.equal(boot.rule, 'bootstrap');
  assert.deepEqual(boot.policy.acceptance.protectedPaths, ['boot/**']);
  const bootDefinition = await settings.definition(DEVICE);
  assert.equal(bootDefinition.rule, 'bootstrap');
  f.rawChecks.definition = bootDefinition;
  const bootRunner = await settings.runner(DEVICE);
  assert.equal(bootRunner.rule, 'bootstrap');
  f.rawChecks.configuration = bootRunner;
  // The first accepted landing ends the bootstrap.
  f.rawChecks.selection = (
    select => overrides =>
      select({
        expectedDefinition: f.rawChecks.definition.digest,
        expectedConfiguration: f.rawChecks.configuration.digest,
        ...overrides,
      })
  )(f.rawChecks.selection);
  assert.equal((await f.accept(await prepared(f, ['src/app.ts']), 'contributor')).status, 'landed');

  // fe7d67a8: switching fast landing on relaxes what lands on its own check, so an agent's switch is held
  // although the landing mode is outside the pinned digest; going back to strict needs no one.
  const fast = await settings.policy(DEVICE, policyCommand({ acceptance: { landingMode: 'fast' } }));
  assert.equal(fast.rule, 'held');
  assert.equal(fast.policy.acceptance.landingMode ?? 'strict', 'strict');
  const strict = await settings.policy(DEVICE, policyCommand({ acceptance: { landingMode: 'strict' } }));
  assert.equal(strict.rule, 'no-gate-change');
  // Policy: an edit that changes what landings may accept is held; nothing changes until a grant.
  const command = policyCommand({ acceptance: { protectedPaths: [] } });
  const held = await settings.policy(DEVICE, command);
  assert.equal(held.rule, 'held');
  assert.deepEqual(held.policy.acceptance.protectedPaths, ['boot/**']);
  assert.equal(held.approval.id, 'setting:policy');
  assert.match(held.approval.next, /wait '\{"approval":"setting:policy"\}'/);
  assert.deepEqual(await settings.policy(DEVICE, command), held, 'a retry returns the same request');
  // An edit no landing depends on still applies directly.
  const stacking = await settings.policy(DEVICE, policyCommand({ agentDefaults: { stacking: 'auto' } }));
  assert.equal(stacking.rule, 'no-gate-change');
  assert.equal(stacking.policy.agentDefaults.stacking, 'auto');

  // Definitions and the runner configuration are held the same way.
  const definitionOperation = randomUUID();
  const heldDefinition = await settings.definition(DEVICE, definitionOperation);
  assert.equal(heldDefinition.rule, 'held');
  assert.equal(heldDefinition.approval.id, `setting:check-definition:${f.rawChecks.checkId}`);
  const heldRunner = await settings.runner(DEVICE);
  assert.equal(heldRunner.rule, 'held');
  assert.equal(heldRunner.approval.id, 'setting:runner');
  const current = JSON.parse(
    await f.transaction('current', modules.projectHostedCheckDefinitions.current, {
      projectId: f.projectId,
      checkId: f.rawChecks.checkId,
    }),
  );
  assert.equal(
    current.configurationDigest,
    f.rawChecks.configuration.digest,
    'a held runner change is not applied',
  );

  // The owner person grants each request in one step on the approve link; the grant applies it.
  const observe = laneId =>
    f
      .transaction('observe', modules.projectHostedApprovals.observe, {
        projectId: f.projectId,
        laneId,
        detail: 1,
      })
      .then(JSON.parse);
  const decide = async (laneId, decision, actor = 'owner') =>
    JSON.parse(
      await f.transaction(
        'decide',
        modules.projectHostedApprovals.decide,
        {
          projectId: f.projectId,
          operationId: randomUUID(),
          laneId,
          decision,
          head: (await observe(laneId)).currentHead,
        },
        actor,
      ),
    );
  const page = await observe('setting:policy');
  assert.equal(page.status, 'requested');
  assert.equal(page.live, true);
  assert.deepEqual(page.change.acceptance, { protectedPaths: [] });
  await assert.rejects(decide('setting:policy', 'grant', DEVICE), code('PROJECT_UNAVAILABLE'));
  const granted = await decide('setting:policy', 'grant');
  assert.equal(granted.approval.status, 'granted');
  assert.equal(granted.applied.rule, 'owner-approved');
  assert.deepEqual(granted.applied.policy.acceptance.protectedPaths, []);
  // The agent's retry of its original operation now returns the applied receipt.
  const replay = await settings.policy(DEVICE, command);
  assert.equal(replay.rule, 'owner-approved');
  assert.deepEqual(replay.policy.acceptance.protectedPaths, []);

  const grantedDefinition = await decide(heldDefinition.approval.id, 'grant');
  assert.equal(grantedDefinition.applied.rule, 'owner-approved');
  assert.equal((await settings.definition(DEVICE, definitionOperation)).rule, 'owner-approved');
  const declined = await decide('setting:runner', 'decline');
  assert.equal(declined.approval.status, 'declined');
  assert.equal(declined.applied, undefined);

  // The owner person is unchanged: direct writes, rule owner-person.
  const person = await settings.policy('owner', policyCommand({ acceptance: { protectedPaths: ['x/**'] } }));
  assert.equal(person.rule, 'owner-person');
  assert.deepEqual(person.policy.acceptance.protectedPaths, ['x/**']);
  const personRunner = await f.rawChecks.configure(
    { kind: 'runner', configuration: { ...f.rawChecks.runner, runsOn: 'ubuntu-22.04' } },
    f.rawChecks.configuration.digest,
  );
  assert.equal(personRunner.rule, 'owner-person');
  // Settings requests never hold a landing: the gate's live read does not see them.
  assert.equal([...f.tables.projectHostedApprovals.values()].filter(row => row.live).length, 0);
});
