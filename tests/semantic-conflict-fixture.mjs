// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { landingFixture } from './hosted-landing-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { semanticPayload } from '../dist/semantic-payload.js';
import { semanticVerdict, semanticConflictsSchema } from '../dist/intent-semantic-conflict.js';
const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
const contracts = await import(moduleUrl('../convex/projectSemanticContracts.ts'));
const at = '2026-01-01T00:00:00.000Z';
const contract = (candidateId, head, tests) => ({
  version: 1,
  operationId: randomUUID(),
  request: 'a'.repeat(64),
  candidateId,
  measuredOn: head,
  runId: randomUUID(),
  at,
  proposedTests: tests,
  tests: tests.map(path => ({ path, durationMs: 10 })),
  totalMs: tests.length * 10,
});
export async function fixture() {
  const f = await landingFixture();
  const primaryIntentId = randomUUID(),
    peer = randomUUID(),
    tests = ['tests/own.test.mjs', 'tests/peer.test.mjs'];
  const candidate = await f.candidate({
    intentId: primaryIntentId,
    semanticPlan: {
      primaryIntentId,
      members: [
        { intentId: peer, outcome: 'Peer outcome', version: 1, tests: [{ path: tests[1], durationMs: 10 }] },
      ],
    },
  });
  await f.run('semanticSeed', records.writeHostedRecord, {
    ...f.auth,
    expectedVersion: null,
    record: {
      kind: 'intent',
      id: primaryIntentId,
      version: 0,
      at,
      outcome: 'Own outcome',
      constraints: '',
      creatorAccountId: 'owner',
      assigneeAccountIds: [],
      base: candidate.base,
      status: 'active',
      testContracts: [contract(candidate.id, candidate.result.head, [tests[0]])],
    },
  });
  const request = f.request({
    candidateId: candidate.id,
    expectedHead: candidate.result.head,
    check: {
      kind: 'request',
      checkId: f.checkId,
      expectedDefinition: f.definition.digest,
      expectedConfiguration: f.configuration.digest,
      expectedEnvironment: f.runner.environmentFingerprint,
    },
  });
  return { ...f, makeCandidate: f.candidate, candidate, request, tests, primaryIntentId, peer };
}

export async function measureSemanticScale(size) {
  const f = await fixture();
  const members = Array.from({ length: size }, (_, i) => ({
    intentId: i === 0 ? f.primaryIntentId : randomUUID(),
    outcome: `Synthetic ${i}`,
    version: 1,
    tests: Array.from({ length: 20 }, (_, test) => ({
      path: `tests/prove-${test}.test.mjs`,
      durationMs: 10 + i / 1000,
    })),
  }));
  assert.equal(typeof global.gc, 'function');
  global.gc();
  const started = performance.now(),
    rss = process.memoryUsage().rss,
    heap = process.memoryUsage().heapUsed;
  const plan = contracts.mergeSemanticMembers(f.primaryIntentId, members, members);
  assert.equal(plan.members.length, size);
  const storedBytes = Buffer.byteLength(semanticPayload({ semanticPlan: plan }));
  assert(storedBytes < 512 * 1024, 'two-times dogfood declaration metadata fits a bounded record');
  const reports = Object.fromEntries(
    Array.from({ length: 20 }, (_, i) => [`tests/prove-${i}.test.mjs`, { durationMs: 10, failed: false }]),
  );
  assert.deepEqual(
    semanticVerdict(plan, reports, {
      candidateId: f.candidate.id,
      head: f.candidate.result.head,
      runId: randomUUID(),
    }).conflicts,
    [],
  );
  const failures = semanticVerdict(
    plan,
    { ...reports, 'tests/prove-0.test.mjs': { durationMs: 10, failed: true } },
    { candidateId: f.candidate.id, head: f.candidate.result.head, runId: randomUUID() },
  ).conflicts;
  assert.equal(failures.length, size - 1);
  const storedConflicts = semanticPayload({ semanticConflicts: failures });
  assert(Buffer.byteLength(storedConflicts) < 512 * 1024);
  assert.deepEqual(semanticConflictsSchema.parse(JSON.parse(storedConflicts).semanticConflicts), failures);
  const before = f.counts.length;
  const candidate = await f.makeCandidate({ intentId: f.primaryIntentId, semanticPlan: plan });
  // Current main provenance is selected by one receipt, one Candidate, one Intent.
  f.insert('projectHostedAcceptances', {
    projectId: f.projectId,
    receiptId: 'scale-receipt',
    submissionId: randomUUID(),
    attemptId: randomUUID(),
    sequence: 575,
    value: JSON.stringify({ candidate: { id: candidate.id } }),
  });
  const selected = await f.run(
    'semanticScale',
    ctx => contracts.mainSemanticMembers(ctx, f.auth, 'scale-receipt'),
    {},
  );
  assert.equal(selected.length, size);
  const count = f.counts.findLast(c => c.name === 'semanticScale');
  assert(count.documents <= 20);
  assert(count.ranges <= 20);
  assert(f.counts.length - before <= 2, 'one bounded metadata function, no loop of function calls');
  const elapsedMs = performance.now() - started;
  const peakRssBytes = process.resourceUsage().maxRSS * 1024;
  const rssAfter = process.memoryUsage().rss;
  global.gc();
  const retainedHeapBytes = Math.max(0, process.memoryUsage().heapUsed - heap);
  assert(retainedHeapBytes < 64 * 1024 * 1024, 'bounded retained metadata heap');
  assert(peakRssBytes < 256 * 1024 * 1024, 'bounded isolated process peak');
  assert(elapsedMs < 5000);
  return {
    intents: size,
    additionalFunctionCallsPerLanding: 0,
    selectedDocuments: count.documents,
    selectedRanges: count.ranges,
    metadataBytes: storedBytes,
    conflictBytes: Buffer.byteLength(storedConflicts),
    rawBytes: Buffer.byteLength(JSON.stringify(plan)),
    retainedHeapBytes,
    peakRssBytes,
    rssBefore: rss,
    rssAfter,
    elapsedMs,
  };
}
