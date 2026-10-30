// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { acceptanceFixture, records } from './hosted-acceptance-fixture.mjs';
import { checksFixture } from './hosted-checks-fixture.mjs';
import { policyPreset, editedPolicy, effectivePolicy } from '../dist/autonomy-policy.js';
import { gateFor } from '../dist/contract-gate-policy.js';
import { hostedRecordSchema } from '../dist/hosted-records.js';
import { decisionRecordSchema, decideInputSchema } from '../dist/decision-types.js';
import {
  TRUST_DEFAULTS,
  applyCulprit,
  applyLanding,
  areaOf,
  candidateLevel,
  emptyTrust,
  landingWeight,
  levelAt,
  pathLevels,
  resolvedTrustConfig,
  trustConfigSchema,
} from '../dist/agent-trust.js';
import { moduleUrl } from './convex-module.mjs';

const trust = await import(moduleUrl('../convex/projectHostedTrust.ts'));
const gate = await import(moduleUrl('../convex/projectHostedGate.ts'));
const decisions = await import(moduleUrl('../convex/projectHostedDecisions.ts'));
const at = '2026-10-01T00:00:00.000Z';
const day = n => new Date(Date.parse(at) + n * 86_400_000).toISOString();
const cfg = (extra = {}) => resolvedTrustConfig({ enabled: true, ...extra });
const land = (state, id, paths, tests = 0, when = at, config = cfg()) =>
  applyLanding(state, config, { id, paths, contractTests: tests, at: when });
const score = (state, area) => state.areas.find(a => a.area === area)?.score;

test('weights grow with contract size and areas are directories two deep', () => {
  assert.deepEqual([0, 1, 3, 7, 40].map(landingWeight), [1, 2, 3, 4, 4]);
  assert.equal(areaOf('convex/a.ts'), 'convex');
  assert.equal(areaOf('web/src/ui/x.tsx'), 'web/src');
  assert.equal(areaOf('README.md'), '.');
});

test('a new actor is supervised everywhere; trust is earned per area from weighted green landings', () => {
  let s = emptyTrust(at);
  const config = cfg({ trustedAt: 6, autonomousAt: 12, probationLandings: 0 });
  assert.equal(candidateLevel(s, config, 'a', ['src/x.ts'], Date.parse(at)).level, 'supervised');
  s = land(s, 'l1', ['src/x.ts'], 7, at, config); // weight 4
  assert.equal(candidateLevel(s, config, 'a', ['src/x.ts'], Date.parse(at)).level, 'supervised');
  s = land(s, 'l2', ['src/y.ts'], 3, at, config); // 4 + 3 = 7
  assert.equal(candidateLevel(s, config, 'a', ['src/x.ts'], Date.parse(at)).level, 'trusted');
  assert.equal(candidateLevel(s, config, 'a', ['docs/x.md'], Date.parse(at)).level, 'supervised');
  // A Candidate takes the lowest level of the areas it touches.
  assert.match(
    candidateLevel(s, config, 'a', ['src/x.ts', 'docs/x.md'], Date.parse(at)).reason,
    /supervised on docs/,
  );
  assert.equal(candidateLevel(s, config, 'a', null, Date.parse(at)).level, 'supervised');
});

test('a replayed landing or culprit finding never counts twice', () => {
  const s = land(emptyTrust(at), 'l1', ['src/x.ts'], 1);
  assert.equal(land(s, 'l1', ['src/x.ts'], 1), s);
  const c = applyCulprit(s, cfg(), { id: 'c1', paths: ['src/x.ts'], at });
  assert.equal(applyCulprit(c, cfg(), { id: 'c1', paths: ['src/x.ts'], at }), c);
});

test('a culprit finding lowers trust on its own areas only; unknown paths lower every area', () => {
  const config = cfg({ trustedAt: 6, autonomousAt: 12, probationLandings: 0, culpritKeep: 0.1 });
  let s = emptyTrust(at);
  for (let i = 0; i < 4; i++) s = land(s, `a${i}`, ['src/x.ts', 'docs/x.md'], 7, at, config);
  const level = (state, path) => pathLevels(state, config, 'a', [path], Date.parse(at))[0].level;
  assert.equal(level(s, 'src/x.ts'), 'autonomous');
  const hit = applyCulprit(s, config, { id: 'c1', paths: ['src/x.ts'], at });
  assert.equal(level(hit, 'src/x.ts'), 'supervised');
  assert.equal(level(hit, 'docs/x.md'), 'autonomous');
  assert.equal(hit.areas.find(a => a.area === 'src').culprits, 1);
  const all = applyCulprit(s, config, { id: 'c2', paths: null, at });
  assert.equal(level(all, 'docs/x.md'), 'supervised');
});

test('trust decays with idle time and is never recomputed from history', () => {
  const config = cfg({ trustedAt: 6, autonomousAt: 100, halfLifeDays: 10, probationLandings: 0 });
  const s = land(emptyTrust(at), 'l1', ['src/x.ts'], 7, at, config); // 4
  const s2 = land(s, 'l2', ['src/x.ts'], 7, at, config); // 8
  assert.equal(pathLevels(s2, config, 'a', ['src/x.ts'], Date.parse(at))[0].level, 'trusted');
  assert.equal(pathLevels(s2, config, 'a', ['src/x.ts'], Date.parse(day(10)))[0].level, 'supervised'); // 4
  assert.equal(land(s2, 'l3', ['src/x.ts'], 0, day(10), config).areas[0].score, 5);
});

test('a new vendor stays supervised through probation; an established vendor and a delegation do not', () => {
  const config = cfg({
    trustedAt: 2,
    probationLandings: 3,
    vendors: { b: 'acme' },
    establishedVendors: ['acme'],
  });
  let s = emptyTrust(at);
  for (let i = 0; i < 2; i++) s = land(s, `l${i}`, ['src/x.ts'], 7, at, config);
  const now = Date.parse(at);
  const probation = pathLevels(s, config, 'a', ['src/x.ts'], now)[0];
  assert.deepEqual([probation.level, probation.source], ['supervised', 'new-vendor']);
  assert.equal(pathLevels(s, config, 'b', ['src/x.ts'], now)[0].level, 'trusted'); // established vendor
  const delegated = {
    ...s,
    delegations: [{ decisionId: randomUUID(), patterns: ['docs/**'], level: 'autonomous' }],
  };
  assert.equal(pathLevels(delegated, config, 'a', ['docs/a.md'], now)[0].level, 'autonomous');
  assert.equal(pathLevels(delegated, config, 'a', ['src/a.ts'], now)[0].level, 'supervised');
  const expired = {
    ...s,
    delegations: [{ decisionId: randomUUID(), patterns: ['docs/**'], level: 'trusted', until: day(-1) }],
  };
  assert.equal(pathLevels(expired, config, 'a', ['docs/a.md'], now)[0].level, 'supervised');
  assert.equal(land(s, 'l2', ['src/x.ts'], 7, at, config).landings, 3);
  assert.equal(
    pathLevels(land(s, 'l2', ['src/x.ts'], 7, at, config), config, 'a', ['src/x.ts'], now)[0].level,
    'trusted',
  );
});

test('proposed defaults are ordered and unspecified policy fields fall back to them', () => {
  const resolved = resolvedTrustConfig({ enabled: false });
  assert.equal(resolved.trustedAt, TRUST_DEFAULTS.trustedAt);
  assert(TRUST_DEFAULTS.trustedAt < TRUST_DEFAULTS.autonomousAt);
  assert.equal(levelAt(TRUST_DEFAULTS.trustedAt, resolved), 'trusted');
  assert.equal(levelAt(TRUST_DEFAULTS.autonomousAt, resolved), 'autonomous');
  assert.throws(() => trustConfigSchema.parse({ enabled: true, extra: 1 }));
  assert.throws(() => trustConfigSchema.parse({ enabled: true, culpritKeep: 2 }));
});

test('trust is off unless the policy has a trust block, survives preset changes, and only demotes the gate', () => {
  const base = policyPreset('trusted');
  assert.equal(effectivePolicy({ autonomyPolicy: base }).trust, undefined);
  const edited = editedPolicy(base, {
    action: 'set-policy',
    operationId: randomUUID(),
    trust: { enabled: false },
  });
  assert.deepEqual(edited.trust, { enabled: false });
  const reset = editedPolicy(edited, {
    action: 'set-policy',
    operationId: randomUUID(),
    preset: 'autonomous',
  });
  assert.deepEqual(reset.trust, { enabled: false });
  const green = { status: 'green', unaudited: { count: 0, firstAt: null }, debt: false, hold: null };
  const input = {
    policy: base,
    project: { owner: 'owner' },
    actor: { kind: 'agent', id: 'owner' },
    paths: ['src/leaf.ts'],
    contract: { version: 1, tests: [{ path: 'tests/leaf.test.mjs' }] },
    main: green,
  };
  assert.equal(gateFor(input).mode, 'contract');
  assert.equal(
    gateFor({ ...input, trust: { level: 'trusted', reason: 'Trust: trusted on src' } }).mode,
    'contract',
  );
  const demoted = gateFor({ ...input, trust: { level: 'supervised', reason: 'Trust: supervised on src' } });
  assert.deepEqual([demoted.mode, demoted.reason], ['full', 'Trust: supervised on src']);
  // Trust never grants a contract gate that the policy withholds.
  const supervised = gateFor({
    ...input,
    policy: policyPreset('supervised'),
    trust: { level: 'autonomous', reason: 'x' },
  });
  assert.equal(supervised.mode, 'full');
});

test('a delegation is a decision record and parses with its owner-only fields', () => {
  const input = {
    operationId: randomUUID(),
    target: { kind: 'project' },
    decidedBy: 'Owner',
    what: 'Delegate docs to the writer agent',
    why: 'It has landed docs for weeks',
    delegation: { actor: 'agent-1', paths: ['docs/**'], level: 'trusted' },
  };
  assert.deepEqual(decideInputSchema.parse(input).delegation, input.delegation);
  assert.throws(() => decideInputSchema.parse({ ...input, delegation: { ...input.delegation, paths: [] } }));
  assert.throws(() =>
    decideInputSchema.parse({ ...input, delegation: { ...input.delegation, level: 'supervised' } }),
  );
  assert(decisionRecordSchema.shape.delegation);
});

// ---- Convex-level behavior on the synthetic acceptance fixture ----

const leaf = 'tests/leaf.test.mjs';
async function landed(trustPolicy, paths = ['src/leaf.ts']) {
  const f = await acceptanceFixture();
  const item = await f.makeCandidate([], [], { governance: { version: 1, paths, ownerInputs: false } });
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: { ...policyPreset('trusted'), ...(trustPolicy ? { trust: trustPolicy } : {}) },
  });
  f.insert('projectHostedMainAudits', {
    projectId: f.projectId,
    lastGreen: { sequence: 0, head: item.candidate.base.head, runId: randomUUID() },
  });
  const hash = 'a'.repeat(64);
  const intent = hostedRecordSchema.options[0].parse({
    kind: 'intent',
    id: item.candidate.intentId,
    version: 0,
    at,
    outcome: 'Synthetic trust',
    constraints: '',
    creatorAccountId: 'owner',
    assigneeAccountIds: [],
    base: item.candidate.base,
    status: 'active',
    testContracts: [
      {
        version: 1,
        operationId: randomUUID(),
        request: hash,
        candidateId: item.candidate.id,
        measuredOn: item.candidate.result.head,
        runId: randomUUID(),
        at,
        proposedTests: [leaf],
        tests: [{ path: leaf, durationMs: 10 }],
        totalMs: 10,
      },
    ],
  });
  await f.run('trustIntent', records.writeHostedRecord, { ...f.auth, expectedVersion: null, record: intent });
  const run = await f.rawChecks.enqueue(
    f.rawChecks.selection({ candidateId: item.candidate.id, expectedHead: item.candidate.result.head }),
  );
  await f.rawChecks.pass(await f.rawChecks.activate(run.id));
  const row = [...f.tables.projectHostedCheckRuns.values()].find(r => r.runId === run.id);
  const value = JSON.parse(row.value);
  value.gate = {
    mode: 'contract',
    tests: [leaf, 'tests/b.test.mjs', 'tests/c.test.mjs'],
    contractVersion: 1,
    effective: 'contract',
  };
  f.patch('projectHostedCheckRuns', row._id, { gate: value.gate, value: JSON.stringify(value) });
  const { state } = await f.ready(item, { agent: true, check: { kind: 'run', runId: run.id } });
  const result = await f.commit(await f.claimAcceptance(state));
  return { f, result, item };
}
const rows = f => [...(f.tables.projectHostedTrust?.values() ?? [])];

test('no trust policy: a landing writes and reads nothing extra', async () => {
  const { f, result } = await landed(null);
  assert.equal(result.status, 'landed');
  assert.equal(rows(f).length, 0);
});

test('shadow mode records the landing on one bounded row, weighted by contract size, with one read and one write', async () => {
  const off = await landed(null),
    on = await landed({ enabled: false });
  const [row] = rows(on.f);
  assert.equal(rows(on.f).length, 1);
  assert.equal(row.landings, 1);
  assert.deepEqual(
    row.areas.map(a => [a.area, a.score, a.landings]),
    [['src', 3, 1]],
  ); // 3 tests -> weight 3
  const publishOf = x => x.f.counts.find(c => c.name === 'acceptancePublish');
  assert.equal(publishOf(on).writes, publishOf(off).writes + 1);
  assert.equal(publishOf(on).documents, publishOf(off).documents + 1);
  assert.equal(publishOf(on).ranges, publishOf(off).ranges + 1);
});

test('enforced trust demotes a new actor to the full gate and returns to the contract gate once trusted', async () => {
  const { f, item } = await landed({ enabled: false });
  const policy = f.tables.hostedProjects.get(f.projectId).autonomyPolicy;
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: {
      ...policy,
      trust: { enabled: true, trustedAt: 2, probationLandings: 1, autonomousAt: 50 },
    },
  });
  const project = f.tables.hostedProjects.get(f.projectId);
  const docs = { ...item.candidate, governance: { version: 1, paths: ['docs/new.md'], ownerInputs: false } };
  const inputFor = candidate =>
    f.runAcceptance(
      'gateInput',
      ctx =>
        gate.hostedGateInput(
          ctx,
          project,
          candidate,
          { kind: 'agent', id: rows(f)[0].actor },
          {
            version: 1,
            tests: [{ path: leaf }],
          },
        ),
      {},
    );
  // The first landing already earned weight 2 on src for the fixture's acting agent.
  const earned = await inputFor(item.candidate);
  assert.deepEqual([earned.trust.level, gateFor(earned).mode], ['trusted', 'contract']);
  const untrusted = await inputFor(docs);
  assert.equal(untrusted.trust.level, 'supervised');
  assert.equal(gateFor(untrusted).mode, 'full');
  assert.match(gateFor(untrusted).reason, /Trust: supervised on docs/);
  // An explicit delegation lifts docs only.
  const [row] = rows(f);
  f.patch('projectHostedTrust', row._id, {
    delegations: [{ decisionId: randomUUID(), patterns: ['docs/**'], level: 'trusted' }],
  });
  assert.equal(gateFor(await inputFor(docs)).mode, 'contract');
  const scripts = { ...docs, governance: { version: 1, paths: ['scripts/x.mjs'], ownerInputs: false } };
  assert.equal(gateFor(await inputFor(scripts)).mode, 'full');
});

test('shadow mode never changes a gate', async () => {
  const { f, item } = await landed({ enabled: false });
  const project = f.tables.hostedProjects.get(f.projectId);
  const input = await f.runAcceptance(
    'gateInput',
    ctx =>
      gate.hostedGateInput(
        ctx,
        project,
        item.candidate,
        { kind: 'agent', id: 'someone-new' },
        { version: 1, tests: [{ path: leaf }] },
      ),
    {},
  );
  assert.equal(input.trust, undefined);
});

test('a culprit finding lowers the culprit landing areas only, once', async () => {
  const { f, result } = await landed({ enabled: false, culpritKeep: 0.1 });
  const [row] = rows(f);
  // A second area earned by an unrelated landing.
  f.patch('projectHostedTrust', row._id, {
    areas: [...row.areas, { area: 'docs', score: 9, at: row.areas[0].at, landings: 3, culprits: 0 }],
  });
  const project = f.tables.hostedProjects.get(f.projectId);
  const hit = () =>
    f.runAcceptance('culprit', ctx => trust.noteTrustCulprit(ctx, project, result.receipt.id), {});
  await hit();
  const after = rows(f)[0];
  assert.equal(after.areas.find(a => a.area === 'src').score < 1, true);
  assert.equal(after.areas.find(a => a.area === 'src').culprits, 1);
  assert.equal(after.areas.find(a => a.area === 'docs').score, 9);
  const once = after.areas.find(a => a.area === 'src').score;
  await hit();
  assert.equal(rows(f)[0].areas.find(a => a.area === 'src').score, once);
});

test('delegation materialises from a decision record, is owner-only, and a superseding decision revokes it', async () => {
  const f = await checksFixture();
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: { ...policyPreset('trusted'), trust: { enabled: true } },
    sourceAuthority: { mode: 'server', epoch: 1 },
  });
  const decide = (actor, extra) =>
    f.transaction(
      'decide',
      decisions.decide,
      {
        projectId: f.projectId,
        request: JSON.stringify({
          operationId: randomUUID(),
          target: { kind: 'project' },
          decidedBy: 'Owner',
          what: 'Delegate docs',
          why: 'Track record',
          ...extra,
        }),
      },
      actor,
    );
  const delegation = { actor: 'writer', paths: ['docs/**'], level: 'trusted' };
  const granted = JSON.parse(await decide('owner', { delegation }));
  assert.deepEqual(granted.delegation, delegation);
  const [row] = [...f.tables.projectHostedTrust.values()];
  assert.deepEqual(row.delegations, [{ decisionId: granted.id, patterns: ['docs/**'], level: 'trusted' }]);
  const revoked = JSON.parse(
    await decide('owner', { supersedes: granted.id, what: 'Revoke docs delegation' }),
  );
  assert.equal(revoked.supersedes, granted.id);
  assert.deepEqual([...f.tables.projectHostedTrust.values()][0].delegations, []);
  // Negative: a non-owner, even one who may record decisions, cannot delegate.
  f.insert('projectContributors', { projectId: f.projectId, contributor: 'maintainer' });
  f.insert('projectHostedDecisionMaintainers', {
    projectId: f.projectId,
    actor: 'maintainer',
    enabled: true,
    operationId: randomUUID(),
    request: 'x',
  });
  await assert.rejects(decide('maintainer', { delegation }), /owner delegates/);
});
