// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { policyPreset, legacyPolicy, editedPolicy } from '../dist/autonomy-policy.js';
import { gateFor, gateForCandidates, acceptGate } from '../dist/contract-gate-policy.js';
const green = { status: 'green', unaudited: { count: 0, firstAt: null }, debt: false, hold: null };
const input = () => ({
  policy: policyPreset('trusted'),
  project: { owner: 'owner' },
  actor: { kind: 'agent', id: 'owner' },
  paths: ['src/leaf.ts'],
  contract: { version: 1, tests: [{ path: 'tests/leaf.test.mjs' }] },
  main: green,
});
for (const preset of ['trusted', 'autonomous', 'supervised'])
  test(`${preset} actor gate`, () => {
    const i = { ...input(), policy: policyPreset(preset) };
    assert.equal(gateFor(i).mode, preset === 'supervised' ? 'full' : 'contract');
  });
for (const kind of ['person', 'system', 'contributor', 'unlisted'])
  test(`${kind} actor stays full`, () => {
    const i = input();
    i.actor =
      kind === 'contributor'
        ? { kind: 'agent', id: 'outsider' }
        : kind === 'unlisted'
          ? i.actor
          : { kind, id: 'owner' };
    if (kind === 'unlisted') i.policy.acceptance.autoActors = ['other'];
    assert.equal(gateFor(i).mode, 'full');
  });
test('legacy is dark; edited custom policies retain their explicit gate', () => {
  const i = input();
  i.policy = legacyPolicy();
  assert.equal(i.policy.acceptance.gate, undefined);
  assert.equal(gateFor(i).mode, 'full');
  const p = editedPolicy(policyPreset('trusted'), {
    action: 'set-policy',
    operationId: crypto.randomUUID(),
    notify: { awaySummary: false },
  });
  assert.equal(p.preset, 'custom');
  assert.equal(p.acceptance.gate, 'contract');
});
test('legacy policy flipped with only gate contract: owner agent contract, every other actor class full', () => {
  const policy = editedPolicy(legacyPolicy(), {
    action: 'set-policy',
    operationId: crypto.randomUUID(),
    acceptance: { gate: 'contract' },
  });
  assert.equal(policy.preset, 'custom');
  assert.equal(policy.acceptance.mode, 'auto-on-pass');
  const gate = actor => gateFor({ ...input(), policy, actor }).mode;
  assert.equal(gate({ kind: 'agent', id: 'owner' }), 'contract');
  assert.equal(gate({ kind: 'agent', id: 'outsider' }), 'full');
  assert.equal(gate({ kind: 'person', id: 'owner' }), 'full');
  assert.equal(gate({ kind: 'system', id: 'owner' }), 'full');
  const supervised = editedPolicy(policy, {
    action: 'set-policy',
    operationId: crypto.randomUUID(),
    acceptance: { mode: 'review' },
  });
  assert.equal(gateFor({ ...input(), policy: supervised }).mode, 'full');
  const revert = editedPolicy(policy, {
    action: 'set-policy',
    operationId: crypto.randomUUID(),
    acceptance: { gate: 'full' },
  });
  assert.equal(gateFor({ ...input(), policy: revert }).mode, 'full');
});
test('batch gate unions member declarations and falls back to full for any ineligible Candidate', () => {
  const first = input();
  const second = {
    ...input(),
    contract: { version: 3, tests: [{ path: 'tests/peer.test.mjs' }, ...first.contract.tests] },
  };
  const gate = gateForCandidates([first, second]);
  assert.equal(gate.mode, 'contract');
  assert.deepEqual(gate.tests, ['tests/leaf.test.mjs', 'tests/peer.test.mjs']);
  assert.equal(gate.contractVersion, 3);
  assert.deepEqual(gateForCandidates([first]), gateFor(first));
  assert.equal(gateForCandidates([]).mode, 'full');
  for (const change of [
    { contract: null },
    { policy: policyPreset('supervised') },
    { actor: { kind: 'agent', id: 'contributor' } },
    { paths: null },
    { paths: ['.github/workflows/check.yml'] },
    { main: { ...green, status: 'red' } },
    { main: { ...green, debt: true } },
  ])
    assert.equal(gateForCandidates([first, { ...second, ...change }]).mode, 'full');
});
test('no contract, unknown/protected paths, red/unknown main or debt gets full at enqueue', () => {
  for (const change of [
    { contract: null },
    { paths: null },
    { paths: ['.github/workflows/check.yml'] },
    { main: { ...green, status: 'unknown' } },
    { main: { ...green, status: 'red' } },
    { main: { ...green, debt: true } },
  ])
    assert.equal(gateFor({ ...input(), ...change }).mode, 'full');
});
test('publish rechecks eligibility, version and test membership, holding red without blocking full fixes', () => {
  const i = input(),
    gate = { ...gateFor(i), effective: 'contract' };
  assert.equal(acceptGate(i, gate), 'pass');
  assert.equal(acceptGate({ ...i, main: { ...green, status: 'red' } }, gate), 'main-red');
  assert.equal(acceptGate({ ...i, policy: policyPreset('supervised') }, gate), 'full-required');
  assert.equal(acceptGate({ ...i, contract: { ...i.contract, version: 2 } }, gate), 'full-required');
  assert.equal(acceptGate(i, { ...gate, tests: [] }), 'full-required');
  for (const effective of ['full', 'docs'])
    assert.equal(acceptGate({ ...i, main: { ...green, status: 'red' } }, { ...gate, effective }), 'pass');
});

test('history declaration is source-independent while exact measurements remain pinned', async () => {
  const { confirmTestContract, candidateTestContract } = await import('../dist/intent-test-contract.js');
  const candidateId = crypto.randomUUID(),
    runId = crypto.randomUUID();
  const head = 'a'.repeat(64),
    measuredOn = 'b'.repeat(64);
  const contract = confirmTestContract({
    command: {
      operationId: crypto.randomUUID(),
      expectedHead: head,
      expectedVersion: 0,
      timingBasis: 'history',
    },
    candidateId,
    head,
    required: ['tests/leaf.test.mjs'],
    available: ['tests/leaf.test.mjs'],
    timings: { 'tests/leaf.test.mjs': 10 },
    version: 0,
    request: 'c'.repeat(64),
    at: '2026-01-01T00:00:00.000Z',
    history: { runId, measuredOn },
  });
  assert.equal(contract.measuredOn, measuredOn);
  assert.equal(contract.runId, runId);
  assert.equal(candidateTestContract({ testContracts: [contract] }, crypto.randomUUID(), head), contract);
});

test('entry files of every defined check and setup action select the full gate, like the default paths', () => {
  const checks = [
    {
      executable: 'bash',
      args: ['.bench/ci.sh'],
      actions: { setup: { executable: 'bash', args: ['.bench/setup.sh'] } },
    },
    { executable: 'node', args: ['tools/lint-check.mjs'] },
  ];
  const gate = paths => gateFor({ ...input(), paths, checks }).mode;
  assert.equal(gate(['src/leaf.ts']), 'contract');
  for (const path of ['.bench/ci.sh', '.bench/setup.sh', 'tools/lint-check.mjs'])
    assert.equal(gate([path, 'src/leaf.ts']), 'full', path);
  assert.equal(
    gateFor({ ...input(), paths: ['tools/lint-check.mjs'] }).mode,
    'contract',
    'no defined checks: unchanged',
  );
  const explicit = input();
  explicit.policy.acceptance.ownerApprovalPaths = ['deploy/**'];
  assert.equal(gateFor({ ...explicit, paths: ['.bench/ci.sh'], checks }).mode, 'contract');
  assert.equal(
    gateFor({ ...input(), paths: ['scripts/forge-check.mjs'] }).mode,
    'full',
    'Forge default unchanged',
  );
});
test('team members: policy decides eligibility, the owner is only the default', () => {
  const member = { kind: 'agent', id: 'member' };
  const gate = (change = {}) => gateFor({ ...input(), actor: member, ...change }).mode;
  const listed = (ids, extra = {}) => {
    const policy = policyPreset('trusted');
    policy.acceptance.autoActors = ids;
    return { policy, ...extra };
  };
  const level = value => ({ trust: { level: value, reason: `Trust: ${value}` } });
  // No list and no trust: only the owner's agent is eligible (unchanged default).
  assert.equal(gate(), 'full');
  assert.equal(gateFor(input()).mode, 'contract');
  // An explicit list makes a member eligible, and still excludes everyone else (owner included).
  assert.equal(gate(listed(['member'])), 'contract');
  assert.equal(gate(listed(['other'])), 'full');
  assert.equal(gateFor({ ...input(), ...listed(['other']) }).mode, 'full');
  assert.equal(gateFor({ ...input(), ...listed(['owner', 'member']) }).mode, 'contract');
  // With trust enabled, earned trust qualifies a member; supervised stays on the full gate.
  assert.equal(gate(level('trusted')), 'contract');
  assert.equal(gate(level('autonomous')), 'contract');
  assert.equal(gate(level('supervised')), 'full');
  assert.equal(gate(listed(['member'], level('supervised'))), 'full');
  // Trust never admits a person or system actor, nor an actor the list excludes.
  assert.equal(gate({ actor: { kind: 'person', id: 'member' }, ...level('autonomous') }), 'full');
  assert.equal(gate({ actor: { kind: 'system', id: 'member' }, ...level('autonomous') }), 'full');
  assert.equal(gate(listed(['other'], level('autonomous'))), 'full');
  // The owner keeps today's behaviour at every trust level the gate already handled.
  assert.equal(gateFor({ ...input(), ...level('trusted') }).mode, 'contract');
  assert.equal(gateFor({ ...input(), ...level('supervised') }).mode, 'full');
});
