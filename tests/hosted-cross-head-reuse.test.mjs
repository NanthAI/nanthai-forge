// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { getFunctionName } from 'convex/server';
import { analyzeCrossHeadReuse } from '../dist/hosted-cross-head-analysis.js';
import { validCrossHeadProof } from '../dist/hosted-cross-head-proof.js';
import { digest } from '../dist/hash.js';
import { finishFixture, landingApi } from './hosted-finish-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { hostedAcceptanceSchema } from '../dist/hosted-acceptance.js';
import { policyPreset } from '../dist/autonomy-policy.js';
const reuse = await import(moduleUrl('../convex/projectHostedReuseStore.ts'));
const mainAudit = await import(moduleUrl('../convex/projectHostedMainAudit.ts'));
const reuseAction = await import(moduleUrl('../convex/projectHostedReuse.ts'));
const synthetic = {
  FORGE_HOSTED_CHECK_KEY_ID: 'SYNTHETIC',
  FORGE_SOURCE_PROVIDER: 'convex',
  FORGE_SOURCE_WORKER: 'fixed-worker',
  FORGE_SOURCE_RUNTIME: 'a'.repeat(64),
  FORGE_SOURCE_KEY_ID: 'SYNTHETIC',
  R2_ACCOUNT_ID: 'synthetic',
  R2_BUCKET: 'synthetic',
  R2_ACCESS_KEY_ID: 'synthetic',
  R2_SECRET_ACCESS_KEY: 'synthetic',
};
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const baselineFiles = [
  ['package.json', '{"scripts":{}}'],
  ['package-lock.json', '{"lockfileVersion":3,"packages":{}}'],
  ['convex/projectConvexSourceOutput.ts', 'export const cost = 1;'],
  ['src/native-projection.ts', 'export const old = 1;'],
  ['tests/convex-source-r2.test.mjs', "import '../convex/projectConvexSourceOutput.ts';"],
  ['tests/native-projection.test.mjs', "import '../dist/native-projection.js';"],
];
async function passWithSelection(f, id, selection) {
  const prepared = await f.rawChecks.prepare(id, 2, { selection });
  await f.rawChecks.control(id, { kind: 'reserve', owner: prepared.owner, token: prepared.token });
  const running = await f.rawChecks.control(id, {
    kind: 'observe',
    owner: prepared.owner,
    token: prepared.token,
    result: { status: 'accepted', executionId: 'synthetic-passed-full' },
  });
  await f.rawChecks.pass(running.run);
  return f.rawChecks.status(id);
}
async function seedFullMain(f, selection, previousMain = f.main) {
  const main = f.currentMain();
  const item = await f.makeCandidate([], [], {
    result: { status: 'clean', head: main.head },
    base: { head: previousMain.head, receiptId: previousMain.receipt.id },
  });
  const queued = await f.rawChecks.enqueue(
    f.rawChecks.selection({ candidateId: item.candidate.id, expectedHead: main.head }),
  );
  const run = await passWithSelection(f, queued.id, selection);
  const candidateRow = [...f.tables.projectHostedRecords.values()].find(row => row.key === item.candidate.id);
  const id = main.receipt.id;
  const receipt = hostedAcceptanceSchema.parse({
    schema: 1,
    id,
    projectId: f.projectId,
    channel: 'main',
    submissionId: randomUUID(),
    operationId: randomUUID(),
    attemptId: randomUUID(),
    at: new Date().toISOString(),
    authorityEpoch: 1,
    previous: { head: previousMain.head, receiptId: previousMain.receipt.id },
    candidate: {
      id: item.candidate.id,
      digest: candidateRow.digest,
      head: main.head,
      inputs: item.candidate.inputs,
      dependencies: item.candidate.dependencies,
      algorithm: item.candidate.algorithm,
    },
    actor: { kind: 'agent', id: 'owner' },
    policyDigest: 'a'.repeat(64),
    check: {
      runId: run.id,
      checkId: run.check.id,
      definition: run.check.definition,
      configuration: run.request.expectedConfiguration,
      environment: run.request.expectedEnvironment,
      terminalDigest: run.terminalDigest,
      planDigest: run.planDigest,
      executionId: run.executionId,
    },
    snapshot: { id, previousId: previousMain.snapshotId, revision: previousMain.sourceRevision + 1 },
    completion: { root: 'b'.repeat(64), pages: 0, lanes: 0, enabled: false },
    automatic: true,
    undo: { kind: 'revert', receiptId: id },
  });
  f.insert('projectHostedAcceptances', {
    projectId: f.projectId,
    receiptId: id,
    submissionId: receipt.submissionId,
    attemptId: receipt.attemptId,
    sequence: receipt.snapshot.revision,
    value: JSON.stringify(receipt),
  });
  f.patch('projectHostedChannels', f.mainId, {
    selection: JSON.stringify({ ...main, snapshotId: id, sourceRevision: receipt.snapshot.revision }),
  });
  return run;
}
async function readyRace(t, { mainFiles, extra = [], disabled = false } = {}) {
  const f = await finishFixture(t, {
    baselineFiles: [...baselineFiles, ...extra],
    selectedFiles: [['convex/projectConvexSourceOutput.ts', 'export const cost = 2;']],
    mainFiles: mainFiles ?? [['src/native-projection.ts', 'export const old = 2;']],
  });
  if (disabled) {
    const policy = policyPreset('trusted');
    policy.acceptance.hostedCrossHeadReuse = false;
    f.patch('hostedProjects', f.projectId, { autonomyPolicy: policy });
  }
  const state = await f.enqueue(f.request({ agent: true }));
  await f.drain();
  const before = (await f.status(state.id)).attempt;
  const selection = f.c.put(
    JSON.stringify({
      scope: 'full',
      tests: ['tests/convex-source-r2.test.mjs', 'tests/native-projection.test.mjs'],
    }),
  );
  await passWithSelection(f, before.check.runId, selection);
  while ((await f.current(state.id)).submission.phase !== 'ready') await f.execute();
  f.moveMain();
  const parent = await seedFullMain(f, selection);
  return { f, state, before, parent };
}
async function pendingProof(f, state) {
  for (let n = 0; n < 80; n++) {
    const pending = JSON.parse(f.row(state.id).value).pending;
    const source =
      pending &&
      [...f.tables.projectHostedComposes.values()].find(
        row => row.operationId === pending.operations.compose,
      );
    if (source && JSON.parse(source.value).status === 'completed')
      return { projectId: f.projectId, submissionId: state.id, pendingId: pending.id, owner: randomUUID() };
    await f.execute();
  }
  assert.fail('completed recomposition');
}

function fixture({ shared = false, unknown = false, overlap = false, corrupt = false, size = 0 } = {}) {
  const blobs = new Map();
  let calls = 0,
    maxWindow = 0;
  const put = bytes => {
    bytes = Buffer.from(bytes);
    const sha = digest(bytes);
    blobs.set(sha, bytes);
    return sha;
  };
  const file = ([path, text]) => ({ path, blob: put(text), mode: 'file' });
  const extra = Array.from({ length: size }, (_, i) => [`src/scale-${i}.ts`, `export const x = ${i};`]);
  const original = [
    ...baselineFiles,
    ...extra,
    ...(shared
      ? [
          [
            'tests/shared.test.mjs',
            "import '../convex/projectConvexSourceOutput.ts'; import '../dist/native-projection.js';",
          ],
        ]
      : []),
  ].map(file);
  const state = files =>
    put(
      JSON.stringify({
        schema: 1,
        kind: 'forge-source-state',
        parents: [],
        files,
        message: 'synthetic',
        at: '2026-10-30T07:42:55.000Z',
      }),
    );
  const base = state(original),
    changed = file(['convex/projectConvexSourceOutput.ts', 'export const cost = 2;']);
  const candidate = [...original.filter(f => f.path !== changed.path), changed];
  if (unknown) candidate.push(file(['unknown.config', 'unknown']));
  const mainDelta = overlap
    ? file([changed.path, 'export const cost = 3;'])
    : file(['src/native-projection.ts', 'export const old = 2;']);
  const main = [...original.filter(f => f.path !== mainDelta.path), mainDelta];
  const merged = [...candidate.filter(f => f.path !== mainDelta.path), mainDelta];
  if (corrupt) merged.push(file(['extra.txt', 'unexpected recomposition']));
  const heads = [base, state(candidate), state(main), state(merged)];
  const selection = put(
    JSON.stringify({
      scope: 'full',
      tests: [
        ...baselineFiles.map(([p]) => p).filter(p => p.startsWith('tests/')),
        ...(shared ? ['tests/shared.test.mjs'] : []),
      ],
    }),
  );
  const basis = {
    checked: { id: randomUUID(), head: heads[1], digest: 'a'.repeat(64) },
    checkedBase: { head: heads[0], receiptId: 'before' },
    main: { head: heads[2], receiptId: 'b18' },
    head: heads[3],
    runId: randomUUID(),
    terminalDigest: 'b'.repeat(64),
    planDigest: 'c'.repeat(64),
    audit: {
      source: 'main-receipt',
      head: heads[2],
      runId: randomUUID(),
      terminalDigest: 'd'.repeat(64),
      planDigest: 'e'.repeat(64),
      selection,
      sequence: 1,
      coverage: 'main-audit-debt',
    },
  };
  const read = async hashes => {
    calls++;
    maxWindow = Math.max(maxWindow, hashes.length);
    return hashes.map(h => blobs.get(h));
  };
  return { basis, selection, read, blobs, metrics: () => ({ calls, maxWindow }) };
}

test('disjoint conservative impact proof records both deltas and all four inventories', async () => {
  const f = fixture(),
    proof = await analyzeCrossHeadReuse(f.basis, f.selection, f.read);
  assert(proof);
  assert(validCrossHeadProof(proof));
  assert.deepEqual(proof.candidateTests, ['tests/convex-source-r2.test.mjs']);
  assert.deepEqual(proof.mainTests, ['tests/native-projection.test.mjs']);
  assert.equal(proof.candidateSelections.length, 4);
  assert.equal(proof.checked.head, f.basis.checked.head);
  assert.equal(proof.head, f.basis.head);
});
for (const option of ['shared', 'unknown', 'overlap', 'corrupt'])
  test(`${option} evidence keeps the exact recheck`, async () => {
    const f = fixture({ [option]: true });
    assert.equal(await analyzeCrossHeadReuse(f.basis, f.selection, f.read), null);
  });
test('missing checked test coverage cannot transfer a pass', async () => {
  const f = fixture();
  const bytes = Buffer.from('{"tests":[]}'),
    pin = digest(bytes);
  f.blobs.set(pin, bytes);
  assert.equal(await analyzeCrossHeadReuse(f.basis, pin, f.read), null);
});
test('source analysis unavailable falls back through the internal action, without a partial proof', async () => {
  const f = fixture(),
    mutations = [];
  await reuseAction.prove._handler(
    {
      runQuery: async (_ref, args) =>
        args.digests
          ? args.digests.map(sha256 => ({ object: { sha256, size: 3 * 1024 * 1024 } }))
          : { pendingId: 'same-attempt', actor: 'owner', basis: f.basis, selection: f.selection },
      runMutation: async (ref, args) => {
        if (getFunctionName(ref).endsWith(':claim')) return 'analysis-owner';
        if (getFunctionName(ref).endsWith(':renew')) return true;
        mutations.push(args);
        return null;
      },
    },
    { projectId: 'synthetic', submissionId: randomUUID(), pendingId: 'same-attempt' },
  );
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].proof, null);
});
test('doubled dogfood inventory reads bounded pages and keeps source text off heap', async () => {
  const f = fixture({ size: 6000 });
  // The action runs compiled code, with no TypeScript compiler/test-module cache.
  const code = `import{analyzeCrossHeadReuse}from './dist/hosted-cross-head-analysis.js';let input='';for await(const chunk of process.stdin)input+=chunk;const f=JSON.parse(input),blobs=new Map(f.blobs.map(([k,v])=>[k,Buffer.from(v,'base64')]));let calls=0,maxWindow=0;const start=performance.now();const proof=await analyzeCrossHeadReuse(f.basis,f.selection,async hashes=>{calls++;maxWindow=Math.max(maxWindow,hashes.length);return hashes.map(h=>blobs.get(h));});console.log(JSON.stringify({passed:!!proof,calls,maxWindow,rss:process.resourceUsage().maxRSS*1024,wallMs:performance.now()-start}));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', chunk => (stdout += chunk));
  child.stderr.on('data', chunk => (stderr += chunk));
  child.stdin.end(
    JSON.stringify({
      basis: f.basis,
      selection: f.selection,
      blobs: [...f.blobs].map(([k, v]) => [k, v.toString('base64')]),
    }),
  );
  const exit = await new Promise(resolve => child.on('close', resolve));
  assert.equal(exit, 0, stderr);
  const metrics = JSON.parse(stdout);
  assert(metrics.passed);
  assert(metrics.calls <= 65);
  assert(metrics.maxWindow <= 100);
  assert(metrics.rss < 512 * 1024 * 1024);
  console.log('cross-head scale', JSON.stringify(metrics));
});

test('READY pass survives a source-and-impact-disjoint main advance: one passed check, no CHECKING retry', async t => {
  const { f, state, before, parent } = await readyRace(t);
  // Drain only the foreground lifecycle; audit debt intentionally owns one future wake.
  for (let n = 0; n < 80 && (await f.current(state.id)).submission.phase !== 'landed'; n++) {
    assert(f.pending().length, JSON.stringify(await f.current(state.id)));
    await f.execute();
  }
  const current = await f.current(state.id);
  assert.equal(current.submission.phase, 'landed');
  assert.equal(
    f.tables.projectHostedCheckRuns.size,
    2,
    'one Candidate check plus the existing full main check',
  );
  const receipt = JSON.parse(
    [...f.tables.projectHostedAcceptances.values()].find(row => row.submissionId === state.id).value,
  );
  assert.equal(receipt.check.runId, before.check.runId);
  assert(receipt.crossHeadProof);
  assert.notEqual(receipt.candidate.head, receipt.crossHeadProof.checked.head);
  const audit = [...f.tables.projectHostedMainAudits.values()][0];
  assert.equal(audit.unaudited.count, 1);
  assert.equal(audit.lastGreen.runId, parent.id);
  assert(audit.wake);
  const replay = await f.tx('reuseReplay', reuse.complete, {
    projectId: f.projectId,
    submissionId: state.id,
    pendingId: randomUUID(),
    owner: 'already-completed',
    proof: null,
  });
  assert.equal(replay, null);
  assert.equal(f.tables.projectHostedCheckRuns.size, 2);
  await f.tx('reuseAuditStart', mainAudit.start, { projectId: f.projectId });
  const selected = [...f.tables.projectHostedCheckRuns.values()]
    .map(row => JSON.parse(row.value))
    .find(run => run.gate?.mode === 'audit');
  assert.equal(selected.request.expectedHead, receipt.candidate.head);
  const running = await f.rawChecks.activate(selected.id);
  for (let i = 0; i < running.plan.shardCount; i++)
    await f.rawChecks.callback(f.rawChecks.shard(running, i, 'failed'));
  await f.rawChecks.callback(f.rawChecks.complete(running, 'failed'));
  const red = [...f.tables.projectHostedMainAudits.values()][0];
  assert.equal(red.red.runId, selected.id);
  assert.equal(red.lastGreen.runId, parent.id);
  assert(
    f.pending().some(task => task.name === 'projectHostedCulprit:startRedClassification'),
    'failure enters the existing culprit/fix-forward/compensating-revert path',
  );
});

test('two disjoint main advances re-prove the original pass without inherited-check chains or replacement checks', async t => {
  const { f, state, before, parent } = await readyRace(t);
  let prepared = false;
  for (let n = 0; n < 80; n++) {
    const selected = await f.status(state.id);
    if (selected.attempt.crossHeadProof && selected.request.phase === 'ready') {
      prepared = true;
      break;
    }
    await f.execute();
  }
  assert(prepared);
  const previous = f.currentMain();
  f.moveMain();
  await seedFullMain(f, parent.plan.selection, previous);
  for (let n = 0; n < 80 && (await f.current(state.id)).submission.phase !== 'landed'; n++) await f.execute();
  const selected = await f.status(state.id);
  assert.equal(selected.request.phase, 'landed');
  assert.equal(selected.attempt.crossHeadProof.checked.head, before.candidate.head);
  assert.equal(selected.attempt.check.runId, before.check.runId);
  assert.equal(
    f.tables.projectHostedCheckRuns.size,
    3,
    'one Candidate check plus two independently accepted full main checks',
  );
});

test('a slow proof has one renewable owner; watchdogs do not duplicate it and expiry falls back once', async t => {
  const { f, state } = await readyRace(t),
    args = await pendingProof(f, state);
  const owner = await f.tx('proofClaim', reuse.claim, args);
  assert(owner);
  assert.equal(await f.tx('proofClaimLostReply', reuse.claim, args), owner);
  assert.equal(await f.tx('proofDuplicateClaim', reuse.claim, { ...args, owner: randomUUID() }), null);
  f.advanceClock(45_000);
  assert.equal(await f.tx('proofRenew', reuse.renew, { ...args, owner }), true);
  const until = f.row(state.id).reuseLease.until;
  await f.execute(f.pending().find(task => task.name === 'projectHostedFinishDriver:drive'));
  assert.equal(f.row(state.id).wake.at, until);
  assert.equal(f.tables.projectHostedCheckRuns.size, 2);
  f.advanceClock(60_001);
  assert.equal(await f.tx('proofLateRenew', reuse.renew, { ...args, owner }), false);
  assert.equal(await f.tx('proofLateCallback', reuse.complete, { ...args, owner, proof: null }), null);
  await f.execute(f.pending().find(task => task.name === 'projectHostedFinishDriver:drive'));
  assert.equal(f.row(state.id).reuseLease, undefined);
  for (let n = 0; n < 20 && (await f.current(state.id)).submission.phase !== 'checking'; n++)
    await f.execute();
  assert.equal(f.tables.projectHostedCheckRuns.size, 3, 'only one fallback check');
  const attempt = (await f.status(state.id)).attempt.id;
  await f.tx('proofOldCallbackAgain', reuse.complete, { ...args, owner, proof: null });
  assert.equal((await f.status(state.id)).attempt.id, attempt);
});

test('cancellation during proof analysis fences completion and cannot revive a submission', async t => {
  const { f, state } = await readyRace(t),
    args = await pendingProof(f, state);
  const owner = await f.tx('proofClaimBeforeCancel', reuse.claim, args);
  assert(owner);
  await f.tx('proofCancel', landingApi.cancel, {
    projectId: f.projectId,
    request: JSON.stringify({ operationId: randomUUID(), authorityEpoch: 1, submissionId: state.id }),
  });
  assert.equal(await f.tx('cancelledProofRenew', reuse.renew, { ...args, owner }), false);
  await f.tx('cancelledProofComplete', reuse.complete, { ...args, owner, proof: null });
  assert.equal((await f.current(state.id)).submission.phase, 'terminal-failed');
  assert.equal(f.tables.projectHostedCheckRuns.size, 2);
});

for (const incident of [true, false])
  test(
    incident
      ? 'a39b1cdb READY 07:42–07:43 then B1.8 at 07:44:00: disjoint paths still recheck when conservative Convex impacts overlap'
      : 'explicit hostedCrossHeadReuse:false retains the exact recheck',
    async t => {
      // Selected real changed path names; synthetic source bytes preserve privacy.
      const { f, state } = await readyRace(
        t,
        incident
          ? {
              extra: [['convex/projectFreshness.ts', 'export const freshness = 1;']],
              mainFiles: [['convex/projectFreshness.ts', null]],
            }
          : { disabled: true },
      );
      for (let n = 0; n < 80 && (await f.current(state.id)).submission.phase !== 'checking'; n++)
        await f.execute();
      assert.equal((await f.current(state.id)).submission.phase, 'checking');
      assert.equal(
        f.tables.projectHostedCheckRuns.size,
        3,
        'existing main pass plus original and replacement Candidate checks',
      );
      assert.equal((await f.status(state.id)).attempt.crossHeadProof, undefined);
    },
  );
