// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolutionFinishSelection } from '../dist/hosted-resolution-selection.js';
import { syncFixture, api, jobApi, records, code } from './hosted-sync-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { saveBytes } from '../dist/hosted-save.js';
import { batchEligible } from '../dist/hosted-landing-batch.js';
import { policyPreset } from '../dist/autonomy-policy.js';
import { checksFixture } from './hosted-checks-fixture.mjs';
const { pinLandingAttempt } = await import(moduleUrl('../convex/projectHostedLandingPins.ts'));
const { candidateOwnerInputs } = await import(moduleUrl('../convex/projectHostedProvenance.ts'));
const project = { owner: 'owner' },
  actor = { id: 'owner', kind: 'agent' };
const policy = policyPreset('trusted');
const priorKeyId = process.env.FORGE_HOSTED_CHECK_KEY_ID;
test.before(() => {
  process.env.FORGE_HOSTED_CHECK_KEY_ID = 'SYNTHETIC';
});
test.after(() => {
  if (priorKeyId === undefined) delete process.env.FORGE_HOSTED_CHECK_KEY_ID;
  else process.env.FORGE_HOSTED_CHECK_KEY_ID = priorKeyId;
});
const row = (s, id) => [...s.tables.projectHostedRecords.values()].filter(r => r.key === id).at(-1);
async function ownerLane(s, text) {
  const lane = await s.lane(s.baseline);
  return s.save(lane, [s.file('a.txt', text), s.hidden]);
}
async function compose(s, inputs, dependencies = []) {
  const x = s.selection(inputs, dependencies);
  await s.prepare(x);
  await s.stage(x);
  await s.submit(x);
  return (await s.publish(await s.work(x))).outcome.result;
}
const dependency = (s, c) => ({
  candidateId: c.id,
  head: c.result.head,
  state: { object: { sha256: c.result.head, size: s.objects.get(c.result.head).length }, recipe: null },
});
async function conflict(s, mixed = false, suffix = []) {
  const a = await ownerLane(s, 'left\n'),
    b = await ownerLane(s, 'right\n');
  if (mixed) {
    // Real contributor write to the original owner Lane clears its sticky proof.
    s.insert('projectContributors', { projectId: s.projectId, contributor: 'contributor' });
    const original = (await s.readLane(b.laneId)).record;
    await s.call(
      'contributorWrite',
      {
        _handler: ctx =>
          records.writeHostedRecord(ctx, {
            ...s.auth,
            actor: 'contributor',
            expectedVersion: original.version,
            record: { ...original, version: original.version + 1, sourceVersion: original.sourceVersion + 1 },
          }),
      },
      {},
      'contributor',
    );
    Object.assign(b, (await s.readLane(b.laneId)).entry);
  }
  return { a, b, candidate: await compose(s, [a, b, ...suffix]) };
}
async function recover(s, candidate, expected, onResolved = () => {}) {
  assert.equal(candidate.result.status, 'conflict');
  const r = s.request('resolution', { candidateId: candidate.id, conflicts: candidate.result.conflicts });
  const prepared = await s.prepareSync(r);
  assert.equal(prepared.state.ownerInputs, expected);
  const draft = (await s.execute(r)).terminal.outcome.result;
  assert.equal(row(s, draft.lane.laneId).ownerOnly, expected, 'draft retains authenticated inputs');
  const saved = await s.save((await s.readLane(draft.lane.laneId)).entry, [
    s.file('a.txt', 'chosen\n'),
    s.hidden,
  ]);
  assert.equal(row(s, saved.laneId).ownerOnly, expected, 'owner save cannot upgrade mixed/unknown work');
  const resolve = s.request('resolve', { laneId: saved.laneId, expected: s.pins(saved) });
  assert.equal((await s.prepareSync(resolve)).state.ownerInputs, expected);
  onResolved((await s.execute(resolve)).terminal.outcome.result);
  assert.equal(row(s, saved.laneId).ownerOnly, expected, 'resolve retains authenticated inputs');
  return (await s.readLane(saved.laneId)).entry;
}
for (const mixed of [false, true])
  test(`${mixed ? 'mixed-author' : 'owner-only'} multi-input recovery carries provenance through draft, save, resolve, compose and check pin`, async () => {
    const s = await syncFixture();
    const { a, b, candidate } = await conflict(s, mixed);
    assert.equal(row(s, candidate.id).ownerOnly, !mixed);
    assert.equal(
      candidate.governance,
      undefined,
      'conflict summaries are not complete changed-path governance',
    );
    // Later source versions cannot reinterpret the exact original conflict proof.
    await s.save(a, [s.file('a.txt', 'later\n'), s.hidden]);
    const resolved = await recover(s, candidate, !mixed);
    const clean = await compose(s, [resolved]);
    assert.equal(clean.governance.ownerInputs, !mixed);
    assert.equal(batchEligible(project, policy, actor, clean), !mixed);
    const checks = await checksFixture({
      store: s,
      projectId: s.projectId,
      candidate: clean,
      state: { sha256: clean.result.head, size: s.objects.get(clean.result.head).length },
    });
    s.patch('hostedProjects', s.projectId, { autonomyPolicy: policy });
    const config = checks;
    const attempt = await s.run('pinRecovered', ctx =>
      pinLandingAttempt(ctx, {
        projectId: s.projectId,
        actor,
        submissionId: randomUUID(),
        attemptId: randomUUID(),
        parentAttemptId: null,
        number: 0,
        at: new Date().toISOString(),
        operations: { check: randomUUID(), accept: randomUUID() },
        request: {
          operationId: randomUUID(),
          authorityEpoch: 1,
          channel: 'main',
          agent: true,
          expectedMain: clean.base,
          candidateId: clean.id,
          expectedHead: clean.result.head,
          finish: { composeOperationId: randomUUID(), after: null },
          check: {
            kind: 'request',
            checkId: config.checkId,
            expectedDefinition: config.definition.digest,
            expectedConfiguration: config.configuration.digest,
            expectedEnvironment: config.runner.environmentFingerprint,
          },
        },
      }),
    );
    assert.equal(attempt.deferredCheck === true, !mixed, 'only recovered owner work defers to grouping');
    assert.equal(attempt.check === null, !mixed);
    assert.equal(
      (await s.readLane(b.laneId)).record.actor,
      'owner',
      'requester/Lane actor alone cannot prove ownership',
    );
  });

test('unknown conflict metadata and another creator or epoch never grant the owner exemption', async () => {
  for (const mutation of ['unknown', 'missing-epoch', 'creator', 'epoch']) {
    const s = await syncFixture(),
      { candidate } = await conflict(s);
    const header = row(s, candidate.id);
    s.patch(
      'projectHostedRecords',
      header._id,
      mutation === 'unknown'
        ? { ownerOnly: undefined, provenanceEpoch: undefined }
        : mutation === 'missing-epoch'
          ? { provenanceEpoch: undefined }
          : mutation === 'creator'
            ? { creatorAccountId: 'contributor' }
            : { provenanceEpoch: 0 },
    );
    const resolved = await recover(s, candidate, false);
    const clean = await compose(s, [resolved]);
    assert.equal(clean.governance.ownerInputs, false);
  }
});

test('revocation and epoch movement fence prepared recovery and publication without granting provenance', async () => {
  const s = await syncFixture(),
    { candidate } = await conflict(s);
  const r = s.request('resolution', { candidateId: candidate.id, conflicts: candidate.result.conflicts });
  await s.prepareSync(r);
  await s.submitSync(r);
  const output = await s.workSync(r);
  s.patch('hostedProjects', s.projectId, { sourceAuthority: { mode: 'server', epoch: 2 } });
  await assert.rejects(s.publishSync(output), code('SOURCE_AUTHORITY_CHANGED'));
  await assert.rejects(s.prepareSync({ ...r, operationId: randomUUID() }), code('SOURCE_AUTHORITY_CHANGED'));
  const fresh = await s.prepareSync({ ...r, operationId: randomUUID(), authorityEpoch: 2 });
  assert.equal(fresh.state.ownerInputs, false, 'old-epoch proof is not reauthorized by an owner request');
  s.patch('hostedProjects', s.projectId, { sourceAuthority: { mode: 'server', epoch: 1 } });
  s.insert('projectContributors', { projectId: s.projectId, contributor: 'contributor' });
  const contributorRequest = { ...r, operationId: randomUUID() };
  await s.call(
    'contributorPrepare',
    api.prepare,
    { projectId: s.projectId, request: JSON.stringify(contributorRequest) },
    'contributor',
  );
  const contributorArgs = { projectId: s.projectId, operationId: contributorRequest.operationId };
  const progress = JSON.parse(
    await s.call('contributorProgress', api.progress, contributorArgs, 'contributor'),
  );
  s.put(saveBytes(progress.input));
  await s.withWorker(() => s.call('contributorSubmit', jobApi.submit, contributorArgs, 'contributor'));
  const contributorOutput = await s.compute(progress.input);
  const syncRow = [...s.tables.projectHostedSyncs.values()].find(
    row => row.operationId === contributorRequest.operationId,
  );
  const job = await s.activate(syncRow.jobId);
  await s.callback(job, { status: 'completed', output: contributorOutput.output });
  s.tables.projectContributors.clear();
  await assert.rejects(s.publishSync({ ...contributorOutput, jobId: job.id }), code('PROJECT_UNAVAILABLE'));
  await assert.rejects(
    s.call(
      'revokedPrepare',
      api.prepare,
      { projectId: s.projectId, request: JSON.stringify(contributorRequest) },
      'contributor',
    ),
    code('PROJECT_UNAVAILABLE'),
  );
  await assert.rejects(
    s.call(
      'revokedProgress',
      api.progress,
      { projectId: s.projectId, operationId: contributorRequest.operationId },
      'contributor',
    ),
    code('PROJECT_UNAVAILABLE'),
  );
  const result = await s.publishSync(output);
  assert.equal(row(s, result.outcome.result.lane.laneId).ownerOnly, true);
});

test('dependency-prefix conflicts retain the authenticated aggregate and the unmerged suffix', async () => {
  for (const mixed of [false, true]) {
    const s = await syncFixture();
    const { a, b } = await conflict(s, mixed);
    const left = await compose(s, [a]),
      right = await compose(s, [b]);
    const suffix = await s.lane(s.baseline);
    const savedSuffix = await s.save(suffix, [s.baseFile, s.hidden, s.file('suffix', 'retained')]);
    const deps = [dependency(s, left), dependency(s, right)];
    const candidate = await compose(s, [savedSuffix], deps);
    const resolved = await recover(s, candidate, !mixed);
    const prefix = await compose(s, [resolved]);
    const final = await compose(s, [savedSuffix], [dependency(s, prefix), ...deps]);
    assert.equal(final.result.status, 'clean');
    assert.equal(final.governance.ownerInputs, !mixed);
    assert(JSON.parse(s.objects.get(final.result.head)).files.some(f => f.path === 'suffix'));
  }
});

test('sync combines original Lane and unaccepted target provenance; accepted main cannot upgrade mixed work', async () => {
  const s = await syncFixture(),
    { a, b } = await conflict(s, true);
  const peer = await compose(s, [b]);
  for (const [lane, target, expected] of [
    [a, { kind: 'candidate', candidateId: peer.id, head: peer.result.head }, false],
    [b, { kind: 'main', head: s.main.head, receiptId: s.main.receipt.id }, false],
    [a, { kind: 'main', head: s.main.head, receiptId: s.main.receipt.id }, true],
  ]) {
    const r = s.request('sync', { laneId: lane.laneId, expected: s.pins(lane), target });
    assert.equal((await s.prepareSync(r)).state.ownerInputs, expected);
    const result = (await s.execute(r)).terminal.outcome.result;
    assert.equal(row(s, result.lane.laneId).ownerOnly, expected);
  }
});

test('creator provenance is required even when the input flag is true', () => {
  const candidate = { result: { status: 'conflict' } };
  assert.equal(
    candidateOwnerInputs(
      project,
      { creatorAccountId: 'contributor', ownerOnly: true, provenanceEpoch: 1 },
      candidate,
      1,
    ),
    false,
  );
  assert.equal(
    candidateOwnerInputs(
      project,
      { creatorAccountId: 'owner', ownerOnly: true, provenanceEpoch: 0 },
      candidate,
      1,
    ),
    false,
  );
});

test('resolution finish retains every exact multi-input suffix pin and rejects another conflict root', async t => {
  const s = await syncFixture();
  const suffix = await s.lane(s.baseline);
  const savedSuffix = await s.save(suffix, [s.baseFile, s.hidden, s.file('suffix', 'retained')]);
  const { a, b, candidate } = await conflict(s, false, [savedSuffix]);
  let source;
  const resolved = await recover(s, candidate, true, result => {
    source = result;
  });
  const root = mkdtempSync(join(tmpdir(), 'forge-provenance-selection-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(root + '.forge-client', { recursive: true, force: true });
  });
  const calls = [];
  const session = {
    root,
    query: async (name, input) => {
      calls.push({ name, input });
      assert.equal(input.candidateId, candidate.id);
      return candidate;
    },
    exchange: {
      projectId: s.projectId,
      client: {
        mutation: async (_ref, input) =>
          input.digests.map(digest => ({ digest, size: s.objects.get(digest).length })),
      },
      objects: async ids => ids.map(sha256 => ({ sha256, size: s.objects.get(sha256).length })),
      prepareDownloads: async () => {},
      downloadBatch: async pins => pins.map(pin => s.objects.get(pin.sha256)),
      downloadToFile: async (pin, path) => writeFileSync(path, s.objects.get(pin.sha256)),
    },
  };
  const selected = await resolutionFinishSelection(session, source);
  assert.deepEqual(
    selected.inputs.map(input => input.laneId),
    [resolved.laneId, a.laneId, b.laneId, savedSuffix.laneId],
  );
  assert.deepEqual(selected.inputs.at(-1).expected, s.pins(savedSuffix));
  assert.deepEqual(selected.dependencies, []);
  assert.equal(calls.length, 1, 'one authenticated Candidate read, no per-input RPC');
  await assert.rejects(
    resolutionFinishSelection(session, {
      ...source,
      resolution: {
        ...source.resolution,
        conflicts: { ...source.resolution.conflicts, sha256: 'f'.repeat(64) },
      },
    }),
    code('WORK_OPERATION_CHANGED'),
  );
});

test('a byte-identical mixed sync still clears ownership and cannot regain it on a later owner save', async () => {
  const s = await syncFixture();
  const owned = await s.lane(s.baseline);
  const mixed = await s.lane(s.baseline, { actor: 'contributor' });
  const peer = await compose(s, [mixed]);
  const r = s.request('sync', {
    laneId: owned.laneId,
    expected: s.pins(owned),
    target: { kind: 'candidate', candidateId: peer.id, head: peer.result.head },
  });
  const result = (await s.execute(r)).terminal.outcome.result;
  assert.equal(result.status, 'up-to-date');
  assert.equal(result.lane.head, owned.head);
  assert.equal(row(s, owned.laneId).ownerOnly, false);
  const saved = await s.save((await s.readLane(owned.laneId)).entry, [
    s.baseFile,
    s.hidden,
    s.file('owner', 'later'),
  ]);
  assert.equal(row(s, saved.laneId).ownerOnly, false);
});

test('pre-upgrade pending sync aggregates cannot grant ownership to a new conflict draft', async () => {
  const s = await syncFixture();
  const { a } = await conflict(s, true);
  const main = s.state([s.file('a.txt', 'accepted\n'), s.hidden], [s.baseline.sha256]);
  s.moveMain(main.sha256, 'accepted');
  const r = s.request('sync', {
    laneId: a.laneId,
    expected: s.pins(a),
    target: { kind: 'main', head: main.sha256, receiptId: 'accepted' },
  });
  await s.prepareSync(r);
  const row = [...s.tables.projectHostedSyncs.values()].find(row => row.operationId === r.operationId);
  const state = JSON.parse(row.value);
  delete state.ownerProvenance;
  state.ownerInputs = true; // Old target-only reducer, not an authenticated two-sided proof.
  s.patch('projectHostedSyncs', row._id, { value: JSON.stringify(state) });
  const draft = (await s.execute(r)).terminal.outcome.result;
  assert.equal(draft.status, 'conflict');
  const header = [...s.tables.projectHostedRecords.values()].find(row => row.key === draft.lane.laneId);
  assert.equal(header.ownerOnly, false);
});

// An in-flight old reducer cannot mint the new authenticated aggregate at publish.
for (const batch of [false, true])
  test(`pre-upgrade pending ${batch ? 'batch' : 'conflict'} composition cannot grant owner provenance`, async () => {
    const s = await syncFixture();
    const a = await ownerLane(s, 'left\n'),
      b = await ownerLane(s, 'right\n');
    const deps = batch ? [dependency(s, await compose(s, [a])), dependency(s, await compose(s, [b]))] : [];
    const selected = s.selection(batch ? [] : [a, b], deps);
    await s.prepare(selected);
    await s.stage(selected);
    const stateRow = [...s.tables.projectHostedComposes.values()].find(
      r => r.operationId === selected.request.operationId,
    );
    const state = JSON.parse(stateRow.value);
    assert.equal(state.ownerInputs, true);
    assert.equal(state.ownerProvenance, 1);
    delete state.ownerProvenance;
    if (batch) state.batch = { members: deps.map(d => d.candidateId) };
    s.patch('projectHostedComposes', stateRow._id, { value: JSON.stringify(state) });
    await s.submit(selected);
    const candidate = (await s.publish(await s.work(selected))).outcome.result;
    assert.equal(row(s, candidate.id).ownerOnly, false);
    if (batch) {
      assert.equal(candidate.result.status, 'clean');
      assert.equal(candidate.governance.ownerInputs, false);
    } else {
      assert.equal(candidate.result.status, 'conflict');
      await recover(s, candidate, false);
    }
  });
