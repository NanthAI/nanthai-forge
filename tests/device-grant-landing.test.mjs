// SPDX-License-Identifier: Apache-2.0
// Issue df06081d (review 80132c2d, blockers 1-3): a folder-grant device's landing is held to its grant. Its own files
// (the Candidate's trusted net change) are checked at admission before any check, and at publication together with
// the credential it was submitted with. Whole-project devices are unchanged (lead decision).
import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptanceFixture } from './hosted-acceptance-fixture.mjs';
import { code } from './hosted-landing-fixture.mjs';
import { policyPreset } from '../dist/autonomy-policy.js';

const keyId = process.env.FORGE_HOSTED_CHECK_KEY_ID;
test.before(() => {
  process.env.FORGE_HOSTED_CHECK_KEY_ID = 'SYNTHETIC';
});
test.after(() => {
  if (keyId === undefined) delete process.env.FORGE_HOSTED_CHECK_KEY_ID;
  else process.env.FORGE_HOSTED_CHECK_KEY_ID = keyId;
});
const day = 86400000;
// A fixed instant for the fixtures and the code under test (incident 822fb3db).
const NOW = Date.parse('2026-11-22T12:00:00Z');
const fixClock = t => t.mock.timers.enable({ apis: ['Date'], now: NOW });
const device = { subject: 'owner', forgeCredential: 'grant-device' };
const message = error => error.data?.message ?? error.message;

/** The owner's agent device for the fixture project: `paths` makes it a folder grant, null a whole-project device. */
function credential(f, paths) {
  const now = NOW;
  f.insert('cliCredentials', {
    credentialId: device.forgeCredential,
    owner: 'owner',
    name: 'Agent sandbox',
    tokenHash: 'synthetic-hash',
    issuedAt: now,
    scope: 'cli',
    expiresAt: now + 30 * day,
    revoked: false,
    settings: {
      source: 'write',
      projects: { kind: 'project', projectId: f.projectId },
      ...(paths ? { paths } : {}),
    },
    ...(paths ? { grant: { at: now, usedAt: now } } : {}),
  });
  const row = () =>
    [...f.tables.cliCredentials.values()].find(r => r.credentialId === device.forgeCredential);
  return { row, change: fields => f.patch('cliCredentials', row()._id, fields) };
}
const requestCheck = f => ({
  kind: 'request',
  checkId: f.checkId,
  expectedDefinition: f.definition.digest,
  expectedConfiguration: f.configuration.digest,
  expectedEnvironment: f.runner.environmentFingerprint,
});
async function candidateChanging(f, paths) {
  // Server preflight gate (Issue 029138ef) has its own tests (hosted-landing-desired.test.mjs).
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: { ...policyPreset('trusted'), agentDefaults: { preflight: 'advise' } },
  });
  return f.makeCandidate([], [], { governance: { version: 1, paths, ownerInputs: false } });
}
/** A device landing whose exact check passed, staged and ready for the queue to publish. */
async function ready(f, paths) {
  const item = await candidateChanging(f, paths);
  const selection = { candidateId: item.candidate.id, expectedHead: item.candidate.result.head };
  const run = await f.rawChecks.enqueue(f.rawChecks.selection(selection));
  await f.rawChecks.pass(await f.rawChecks.activate(run.id));
  const s = await f.enqueue(
    f.request({ ...selection, agent: true, check: { kind: 'run', runId: run.id } }),
    device,
  );
  await f.drain();
  await f.stageAcceptance(s, item.pages);
  return (await f.status(s.id)).request;
}
const landingRow = (f, id) =>
  [...f.tables.projectHostedLandingRequests.values()].find(r => r.submissionId === id);
/** The queue's publication step: no signed-in device on this transaction. */
const publish = async (f, state) => f.commit(await f.claimAcceptance(state));

test('df06081d: an outside-grant file already in the Lane refuses at land with AUTH_SCOPE_DENIED, before any check', async t => {
  fixClock(t);
  const f = await acceptanceFixture();
  credential(f, ['docs/']);
  // Another writer (or the person) saved web/app.ts in this Lane: the Candidate's net change carries it.
  const item = await candidateChanging(f, ['docs/guide.md', 'web/app.ts']);
  const selection = { candidateId: item.candidate.id, expectedHead: item.candidate.result.head };
  await assert.rejects(
    f.enqueue(f.request({ ...selection, check: requestCheck(f) }), device),
    error =>
      code('AUTH_SCOPE_DENIED')(error) &&
      /changes web\/app\.ts, outside its device's folder grant \(docs\/\)/.test(message(error)) &&
      /unrestricted device/.test(message(error)),
  );
  assert.equal(f.tables.projectHostedLandingRequests.size, 0, 'nothing queued');
  assert.equal(f.tables.projectHostedCheckRuns.size, 0, 'no check dispatched');
  // The same files inside the grant queue a check and carry the grant stamp.
  const inside = await candidateChanging(f, ['docs/guide.md']);
  const s = await f.enqueue(
    f.request({
      candidateId: inside.candidate.id,
      expectedHead: inside.candidate.result.head,
      check: requestCheck(f),
    }),
    device,
  );
  assert.equal(f.tables.projectHostedCheckRuns.size, 1);
  assert.deepEqual(landingRow(f, s.id).grant, { credentialId: 'grant-device', paths: ['docs/'] });
});

test('df06081d: a grant narrowed after the save refuses the landing of a file it no longer covers', async t => {
  fixClock(t);
  const f = await acceptanceFixture();
  const grant = credential(f, ['docs/', 'web/']);
  const item = await candidateChanging(f, ['docs/guide.md', 'web/app.ts']);
  // The browser narrows the grant to docs/ after web/app.ts was saved under the wider grant.
  grant.change({
    settings: { ...grant.row().settings, paths: ['docs/'] },
    grant: { at: NOW, usedAt: NOW },
  });
  await assert.rejects(
    f.enqueue(
      f.request({ candidateId: item.candidate.id, expectedHead: item.candidate.result.head }),
      device,
    ),
    error => code('AUTH_SCOPE_DENIED')(error) && /web\/app\.ts/.test(message(error)),
  );
  assert.equal(f.tables.projectHostedLandingRequests.size, 0);
});

test('df06081d: a grant revoked, removed or ended between submit and publish stops publication with AUTH_EXPIRED', async t => {
  fixClock(t);
  for (const [label, ended] of [
    ['signed out', { revoked: true }],
    ['removed', { removed: true }],
    ['30 days after it was given', { grant: { at: NOW - 31 * day, usedAt: NOW - 3600_000 } }],
    ['7 days unused', { grant: { at: NOW - 10 * day, usedAt: NOW - 8 * day } }],
    ['folders cleared, which ends the grant', 'cleared'],
  ]) {
    const f = await acceptanceFixture();
    const grant = credential(f, ['docs/']);
    const state = await ready(f, ['docs/guide.md']);
    assert.equal(state.phase, 'ready', label);
    const before = f.currentMain();
    const live = { ...grant.row() };
    const claim = await f.claimAcceptance(state);
    grant.change(
      ended === 'cleared' ? { settings: { ...live.settings, paths: undefined }, grant: undefined } : ended,
    );
    await assert.rejects(
      f.commit(claim),
      error =>
        code('AUTH_EXPIRED')(error) &&
        /Land it from your Forge browser or an unrestricted device/.test(message(error)),
      label,
    );
    assert.deepEqual(f.currentMain(), before, `${label}: main does not move`);
    assert.equal(f.tables.projectHostedAcceptances.size, 0, label);
    // The same landing publishes once the device holds its grant again: only the grant stopped it.
    grant.change({
      revoked: live.revoked,
      removed: live.removed,
      grant: live.grant,
      settings: live.settings,
    });
    assert.equal((await f.commit(claim)).status, 'landed', label);
  }
  // A grant narrowed after submit applies at publication too.
  const f = await acceptanceFixture();
  const grant = credential(f, ['docs/', 'web/']);
  const state = await ready(f, ['web/app.ts']);
  const claim = await f.claimAcceptance(state);
  grant.change({ settings: { ...grant.row().settings, paths: ['docs/'] } });
  await assert.rejects(f.commit(claim), code('AUTH_SCOPE_DENIED'));
  // A device switched to coordination only may no longer write source.
  grant.change({ settings: { ...grant.row().settings, source: 'coordination', paths: ['docs/', 'web/'] } });
  await assert.rejects(f.commit(claim), code('AUTH_SCOPE_DENIED'));
});

test('df06081d: a folder-grant device cannot explicitly accept a landing another device or the person submitted', async t => {
  fixClock(t);
  const f = await acceptanceFixture();
  credential(f, ['web/']);
  const item = await candidateChanging(f, ['web/app.ts']);
  const selection = { candidateId: item.candidate.id, expectedHead: item.candidate.result.head };
  const run = await f.rawChecks.enqueue(f.rawChecks.selection(selection));
  await f.rawChecks.pass(await f.rawChecks.activate(run.id));
  // The same account's unrestricted agent submits; nothing is stamped.
  const s = await f.enqueue(f.request({ ...selection, agent: true, check: { kind: 'run', runId: run.id } }));
  await f.drain();
  await f.stageAcceptance(s, item.pages);
  const state = (await f.status(s.id)).request;
  assert.equal(landingRow(f, s.id).grant, undefined);
  await assert.rejects(f.accept(state, device), code('AUTH_SCOPE_DENIED'));
  assert.equal(f.tables.projectHostedAcceptances.size, 0);
});

test('df06081d: a whole-project device lands unchanged: no stamp, and a grant adds only one credential read at publish', async t => {
  fixClock(t);
  const counts = {};
  for (const [kind, paths] of [
    ['whole', null],
    ['grant', ['web/']],
  ]) {
    const f = await acceptanceFixture();
    credential(f, paths);
    const state = await ready(f, ['web/app.ts']);
    assert.equal(landingRow(f, state.id).grant === undefined, kind === 'whole', kind);
    assert.equal((await publish(f, state)).status, 'landed', kind);
    const last = name => f.counts.filter(c => c.name === name).at(-1);
    counts[kind] = { enqueue: last('landingEnqueue'), publish: last('acceptancePublish') };
  }
  const io = c => ({ documents: c.documents, ranges: c.ranges, writes: c.writes });
  assert.deepEqual(
    io(counts.grant.enqueue),
    io(counts.whole.enqueue),
    'the stamp rides on the existing write',
  );
  assert.deepEqual(
    io(counts.grant.publish),
    {
      ...io(counts.whole.publish),
      documents: counts.whole.publish.documents + 1,
      ranges: counts.whole.publish.ranges + 1,
    },
    'one indexed credential read at publication, grant landings only',
  );
});
