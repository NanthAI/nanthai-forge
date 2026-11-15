// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { acceptanceFixture, api } from './hosted-acceptance-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { editedPolicy, policyPreset } from '../dist/autonomy-policy.js';
const policies = await import(moduleUrl('../convex/projectAutonomy.ts'));
const unchecked = await import(moduleUrl('../convex/projectUncheckedLanding.ts'));
const settings = await import(moduleUrl('../convex/projectUncheckedLandingSettings.ts'));
const code = expected => error => (error.data?.code ?? error.code) === expected;
const choice = (mode = 'selected', people = ['contributor'], teams = []) => ({ mode, people, teams });
async function fixture(selection = choice(), visibility = 'public') {
  const f = await acceptanceFixture();
  const policy = policyPreset('supervised');
  policy.agentDefaults = { preflight: 'advise' };
  if (selection) policy.acceptance.withoutCheck = selection;
  f.patch('hostedProjects', f.projectId, { visibility, autonomyPolicy: policy });
  const memberId = f.insert('projectContributors', { projectId: f.projectId, contributor: 'contributor' });
  return { ...f, memberId };
}
async function prepare(f, actor = 'contributor', agent = false, checked = false) {
  const item = await f.makeCandidate(
    [],
    [],
    { governance: { version: 1, paths: ['src/app.ts'], ownerInputs: false } },
    typeof actor === 'string' ? actor : actor.subject,
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
      expectedHead: item.candidate.result.head,
      agent,
      check: run ? { kind: 'run', runId: run.id } : null,
    }),
    actor,
  );
  await f.drain();
  await f.transaction('prepareUnchecked', api.prepare, f.select(state), actor);
  for (const kind of ['inputs', 'dependencies'])
    for (const [index, page] of item.pages[kind].entries())
      await f.transaction(
        'stageUnchecked',
        api.stage,
        { ...f.select(state), kind, index, page: JSON.stringify(page.value) },
        actor,
      );
  return state;
}
for (const visibility of ['public', 'private']) {
  test(`selected write person explicitly lands unchecked on a ${visibility} supervised project`, async () => {
    const f = await fixture(choice(), visibility);
    const state = await prepare(f);
    const result = await f.accept(state, 'contributor');
    assert.equal(result.status, 'landed');
    assert.equal(result.receipt.check, null);
    assert.equal(result.receipt.automatic, false);
    assert.deepEqual(result.receipt.actor, { kind: 'person', id: 'contributor' });
  });
}
for (const mode of [undefined, 'owner']) {
  test(`owner-only ${mode ?? 'default'} keeps unchecked owner acceptance and refuses other people`, async () => {
    const f = await fixture(mode ? choice(mode) : null, 'private');
    const state = await prepare(f);
    await assert.rejects(f.accept(state, 'contributor'), code('CHECK_NOT_PASSED'));
    const g = await fixture(mode ? choice(mode) : null);
    const owner = await prepare(g, 'owner');
    assert.equal((await g.accept(owner)).status, 'landed');
  });
}
test('all write members may land unchecked without being individually listed', async () => {
  const f = await fixture(choice('writers', []));
  assert.equal((await f.accept(await prepare(f), 'contributor')).status, 'landed');
});
for (const revoke of ['removed', 'downgraded']) {
  test(`a selected person ${revoke} after preparation loses unchecked acceptance immediately`, async () => {
    const f = await fixture();
    const state = await prepare(f);
    f.tables.projectContributors.delete(f.memberId);
    if (revoke === 'downgraded')
      f.insert('projectReaders', { projectId: f.projectId, reader: 'contributor' });
    await assert.rejects(f.accept(state, 'contributor'), code('PROJECT_UNAVAILABLE'));
    assert.equal(f.currentMain().sourceRevision, 0);
  });
}
async function teamFixture() {
  const f = await fixture();
  const team = f.insert('teams', { owner: 'owner', name: 'Release team', operationId: randomUUID() });
  const membership = f.insert('teamMembers', { teamId: team, member: 'contributor' });
  const policy = f.tables.hostedProjects.get(f.projectId).autonomyPolicy;
  policy.acceptance.withoutCheck = choice('selected', [], [team]);
  return { ...f, team, membership };
}
test('a selected team member with current project write can land unchecked', async () => {
  const f = await teamFixture();
  assert.equal((await f.accept(await prepare(f), 'contributor')).status, 'landed');
});
for (const revoke of ['membership', 'team', 'project-write']) {
  test(`team ${revoke} revocation between preparation and acceptance removes the bypass`, async () => {
    const f = await teamFixture();
    const state = await prepare(f);
    if (revoke === 'membership') f.tables.teamMembers.delete(f.membership);
    if (revoke === 'team') f.patch('teams', f.team, { removal: 'deleting' });
    if (revoke === 'project-write') {
      f.tables.projectContributors.delete(f.memberId);
      f.insert('projectReaders', { projectId: f.projectId, reader: 'contributor' });
    }
    await assert.rejects(
      f.accept(state, 'contributor'),
      code(revoke === 'project-write' ? 'PROJECT_UNAVAILABLE' : 'CHECK_NOT_PASSED'),
    );
    assert.equal(f.currentMain().sourceRevision, 0);
  });
}
test('an explicitly downscoped selected person is still an agent and cannot land unchecked', async () => {
  const f = await fixture();
  const state = await prepare(f, 'contributor', true);
  await assert.rejects(f.accept(state, 'contributor'), code('CHECK_NOT_PASSED'));
});
test('device credentials belonging to a selected write person cannot land unchecked', async () => {
  const f = await fixture();
  const credentialId = 'synthetic-selected-device';
  f.insert('cliCredentials', {
    credentialId,
    owner: 'contributor',
    scope: 'cli',
    name: 'Synthetic',
    tokenHash: 'synthetic',
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60000,
    revoked: false,
  });
  const actor = { subject: 'contributor', forgeCredential: credentialId };
  const state = await prepare(f, actor, false);
  await assert.rejects(f.accept(state, actor), code('CHECK_NOT_PASSED'));
});

async function set(f, selection, extra = {}) {
  return f.transaction('uncheckedPolicy', policies.set, {
    projectId: f.projectId,
    command: JSON.stringify({
      action: 'set-policy',
      operationId: randomUUID(),
      acceptance: { withoutCheck: selection },
      ...extra,
    }),
  });
}
test('CLI policy picks by Forge handle and existing team name, stores accounts and team ids, and records retry-safe Undo history', async () => {
  const f = await fixture(null);
  f.insert('accountHandles', { handle: 'release-person', owner: 'contributor' });
  const team = f.insert('teams', { owner: 'owner', name: 'Release team', operationId: randomUUID() });
  const command = {
    action: 'set-policy',
    operationId: randomUUID(),
    acceptance: { withoutCheck: choice('selected', ['@release-person'], ['Release team']) },
  };
  const input = { projectId: f.projectId, command: JSON.stringify(command) };
  const result = await f.transaction('uncheckedPolicy', policies.set, input);
  assert.equal(result.policy.acceptance.withoutCheck.mode, 'selected');
  const stored = f.tables.hostedProjects.get(f.projectId).autonomyPolicy.acceptance.withoutCheck;
  assert.deepEqual(stored, choice('selected', ['contributor'], [team]));
  const count = f.tables.projectPolicyChanges.size;
  await f.transaction('uncheckedPolicyReplay', policies.set, input);
  assert.equal(f.tables.projectPolicyChanges.size, count);
  const history = await f.transaction('uncheckedHistory', settings.history, {
    projectId: f.projectId,
    paginationOpts: { cursor: null, numItems: 20 },
  });
  assert.equal(history.page.length, 1);
  await set(f, history.page[0].previous);
  assert.equal(f.tables.hostedProjects.get(f.projectId).autonomyPolicy.acceptance.withoutCheck.mode, 'owner');
});
test('picker and policy write refuse read-only people; selected names never grant write access', async () => {
  const f = await fixture(null);
  f.insert('accountHandles', { handle: 'read-person', owner: 'reader-account' });
  f.insert('projectReaders', { projectId: f.projectId, reader: 'reader-account' });
  await assert.rejects(
    f.transaction('pickReader', unchecked.pickPerson, { projectId: f.projectId, handle: '@read-person' }),
    code('BAD_ARGUMENT'),
  );
  await assert.rejects(set(f, choice('selected', ['@read-person'])), code('BAD_ARGUMENT'));
  assert.equal(f.tables.projectPolicyChanges.size, 0);
  assert.equal(f.tables.projectContributors.size, 1);
});
test('picker returns a public handle only after checking current write membership', async () => {
  const f = await fixture(null);
  f.insert('accountHandles', { handle: 'release-person', owner: 'contributor' });
  assert.deepEqual(
    await f.transaction('pickWriter', unchecked.pickPerson, {
      projectId: f.projectId,
      handle: '@release-person',
    }),
    { handle: 'release-person' },
  );
  await assert.rejects(
    f.transaction(
      'otherPicker',
      unchecked.pickPerson,
      { projectId: f.projectId, handle: 'release-person' },
      'contributor',
    ),
    code('PROJECT_UNAVAILABLE'),
  );
});
test('revoked selections can remain in the stored list while another selection is edited', async () => {
  const f = await fixture();
  f.tables.projectContributors.delete(f.memberId);
  await set(f, choice('selected', ['contributor', 'owner']));
  assert.deepEqual(f.tables.hostedProjects.get(f.projectId).autonomyPolicy.acceptance.withoutCheck.people, [
    'contributor',
    'owner',
  ]);
});

test('unchecked authority adds zero I/O on checked and disjoint landings at 10,050 retained records', async () => {
  const meters = [];
  const totals = [];
  for (const selection of [null, choice('selected', ['contributor'], ['not-a-team-id'])]) {
    const f = await fixture(selection);
    const policy = policyPreset('trusted');
    policy.agentDefaults = { preflight: 'advise' };
    if (selection) policy.acceptance.withoutCheck = selection;
    f.patch('hostedProjects', f.projectId, { autonomyPolicy: policy });
    for (let i = 0; i < 10050; i++)
      f.insert('projectHostedAcceptances', {
        projectId: f.projectId,
        receiptId: randomUUID(),
        submissionId: randomUUID(),
        attemptId: randomUUID(),
        sequence: i,
        value: '{}',
      });
    const state = await prepare(f, 'owner', true, true);
    const result = await f.accept(state);
    assert.equal(result.status, 'landed');
    const meter = f.counts.filter(value => value.name === 'acceptanceAccept').at(-1);
    assert.equal(meter.readDocumentsByTable?.teamMembers ?? 0, 0);
    assert.equal(meter.readDocumentsByTable?.teams ?? 0, 0);
    assert.equal(meter.readDocumentsByTable?.projectContributors ?? 0, 0);
    meters.push({ ranges: meter.ranges, documents: meter.documents, writes: meter.writes });
    totals.push(
      f.counts.reduce(
        (sum, row) => ({
          calls: sum.calls + 1,
          reads: sum.reads + row.documents,
          writes: sum.writes + row.writes,
        }),
        { calls: 0, reads: 0, writes: 0 },
      ),
    );
  }
  assert.deepEqual(
    meters[0],
    meters[1],
    'configured bypass lists add no landing calls, reads or writes when unused',
  );
  assert.deepEqual(
    totals[0],
    totals[1],
    'the complete checked operation adds zero calls, document reads or writes',
  );
  console.log(
    'Unchecked policy checked-path cost guard',
    JSON.stringify({ publication: meters, complete: totals }),
  );
});

test('revoking the unchecked selection after preparation is enforced against current policy', async () => {
  const f = await fixture();
  const state = await prepare(f);
  const project = f.tables.hostedProjects.get(f.projectId);
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: {
      ...project.autonomyPolicy,
      acceptance: { ...project.autonomyPolicy.acceptance, withoutCheck: choice('owner', []) },
    },
  });
  await assert.rejects(f.accept(state, 'contributor'), code('CHECK_NOT_PASSED'));
  assert.equal(f.currentMain().sourceRevision, 0);
});
test('unchecked selection edits never restart a checked landing', async () => {
  const f = await fixture();
  const state = await prepare(f, 'owner', false, true);
  const project = f.tables.hostedProjects.get(f.projectId);
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: {
      ...project.autonomyPolicy,
      acceptance: { ...project.autonomyPolicy.acceptance, withoutCheck: choice('writers', []) },
    },
  });
  assert.equal((await f.accept(state)).status, 'landed');
});
test('agent autonomy presets preserve the separate owner-selected unchecked person policy', () => {
  const before = policyPreset('supervised');
  before.acceptance.withoutCheck = choice();
  const after = editedPolicy(before, { action: 'set-policy', operationId: randomUUID(), preset: 'trusted' });
  assert.deepEqual(after.acceptance.withoutCheck, before.acceptance.withoutCheck);
});
