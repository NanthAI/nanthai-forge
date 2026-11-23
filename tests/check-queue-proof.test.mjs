// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { REGISTRY } from '../scripts/core-queue-paths.mjs';
import { verifyQueueProof } from '../scripts/test-queue-proof.mjs';
import { checkFailureDetail } from '../dist/check-failure-detail.js';
import { failingStep } from '../dist/hosted-landing-suspect.js';
import { slimReceipt } from '../dist/receipt-slim.js';
import { temporaryDirectory } from '../scripts/test-temp.mjs';

const wake = 'convex/projectHostedFinishWake.ts';
const order = 'convex/projectHostedLandingOrder.ts';
const proofPath = '.nforge/queue-proofs/wake.json';
const incident = '5e3c3a3c';
const replayTest =
  'incident 5e3c3a3c: passed followers land within the pass-to-land ceiling while the holder re-checks';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = hash('synthetic wake when the order holder starts another check');
const replayProof = {
  version: 1,
  kind: 'replay',
  changes: { [wake]: digest },
  replay: { incident, test: replayTest, receipt: randomUUID() },
  authorModel: 'gpt-6.2-sol',
  authorSession: randomUUID(),
  review: { model: 'gpt-6.2-sol', session: randomUUID(), receipt: randomUUID() },
};
const benchProof = {
  version: 1,
  kind: 'bench',
  receipt: randomUUID(),
  changes: { [wake]: digest },
  rule: 'N1',
  cell: {
    cellId: 'synthetic-parked-head',
    landed: 10,
    voided: [],
    failed: [],
    paths: {
      N1: {
        on: true,
        precondition: true,
        reached: true,
        label: 'on path',
        evidence: '1 passed follower held behind a re-checking holder, 1 landed first',
      },
    },
  },
};

function fixture(t) {
  const root = temporaryDirectory(t, 'queue-proof-');
  function write(path, value) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    return file;
  }
  write(wake, 'synthetic wake when the order holder starts another check');
  write(order, 'synthetic order rule');
  write(REGISTRY, {
    schema: 1,
    replays: [
      { incident, test: replayTest, file: 'tests/hosted-landing-queue-sim.test.mjs', paths: [wake] },
      { incident, test: 'order replay', file: 'tests/hosted-landing-order.test.mjs', paths: [order] },
    ],
  });
  function hosted(queueProof) {
    return { FORGE_ACTIONS_PLAN: write('plan.json', { standard: true, selection: { queueProof } }) };
  }
  function machine(paths, extra) {
    const base = 'a'.repeat(64);
    const head = 'b'.repeat(64);
    return {
      FORGE_CHECK_BASE: base,
      FORGE_CHECK_HEAD: head,
      FORGE_CHECK_CHANGES: write('changes.json', {
        version: 1,
        comparison: 'main',
        base,
        head,
        paths,
        ...extra,
      }),
    };
  }
  return { root, write, hosted, machine };
}

test('the 8bc06644 wake path accepts a replay reviewed by the same model in a fresh session', async t => {
  const { root, write, hosted } = fixture(t);
  write(proofPath, replayProof);
  await verifyQueueProof(hosted({ source: [wake], receipts: [proofPath] }), root);
});

test('the author session cannot review its own replay proof even with a different model', async t => {
  const { root, write, hosted } = fixture(t);
  write(proofPath, {
    ...replayProof,
    review: {
      ...replayProof.review,
      model: 'claude-opus-5-5',
      session: ` ${replayProof.authorSession.toUpperCase()} `,
    },
  });
  await assert.rejects(
    verifyQueueProof(hosted({ source: [wake], receipts: [proofPath] }), root),
    /QUEUE_PROOF_REQUIRED/,
  );
});

test('the standard machine check accepts an on-path bench cell for the exact wake bytes', async t => {
  const { root, write, machine } = fixture(t);
  write(proofPath, benchProof);
  await verifyQueueProof(machine([wake, proofPath]), root);
});

test('verify refuses the 8bc06644 wake change without proof before starting any build', t => {
  const { root, hosted } = fixture(t);
  const entry = fileURLToPath(new URL('../scripts/verify.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [entry], {
    cwd: root,
    env: hosted({ source: [wake], receipts: [] }),
    encoding: 'utf8',
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /QUEUE_PROOF_REQUIRED:.*convex\/projectHostedFinishWake\.ts/);
  assert.equal(result.stdout, '');
});

test('the compact landing failure keeps the static proof code and first safe message line', t => {
  const { root, hosted } = fixture(t);
  const control = String.fromCharCode(27);
  const controlPath = wake.replace('.ts', control + '[2J.ts');
  const { stderr, status } = spawnSync(
    process.execPath,
    [new URL('../scripts/verify.mjs', import.meta.url).pathname],
    {
      cwd: root,
      env: hosted({ source: [controlPath], receipts: [] }),
      encoding: 'utf8',
    },
  );
  assert.equal(status, 1);
  const diagnostic = stderr.trim();
  assert(!diagnostic.includes(control));
  assert(diagnostic.includes('Wake\\u001b[2J.ts'));
  const message = checkFailureDetail(
    {},
    failingStep(
      [
        { descriptor: JSON.stringify({ shard: 0 }), seal: null, failureExcerpt: 'unrelated job output' },
        {
          descriptor: JSON.stringify({ shard: 1 }),
          seal: JSON.stringify({
            failureSummary: `${diagnostic} ${control}token=fixture-value\nError: Command failed (exit 1)`,
          }),
        },
      ],
      2,
    ),
  );
  const reply = slimReceipt({
    transport: 'hosted',
    action: 'wait',
    result: {
      submissions: [
        {
          submission: {
            phase: 'terminal-failed',
            error: { code: 'CHECK_FAILED', message },
          },
        },
      ],
    },
  });
  const error = reply.result.submissions[0].submission.error;
  assert.equal(error.code, 'CHECK_FAILED');
  assert.equal(error.message, `Failing job 1 (static): ${diagnostic} token=[redacted]`);
});

test('only a matching replay and an independently reviewed change or a healthy on-path cell cover the wake', async t => {
  const { root, write, hosted } = fixture(t);
  const env = hosted({ source: [wake], receipts: [proofPath] });
  const invalid = [
    { ...replayProof, authorSession: undefined },
    { ...replayProof, review: { ...replayProof.review, session: ' ' } },
    { ...replayProof, review: { ...replayProof.review, receipt: undefined } },
    { ...replayProof, replay: { ...replayProof.replay, test: 'unregistered replay' } },
    { ...replayProof, replay: { ...replayProof.replay, test: 'order replay' } },
    { ...replayProof, changes: { [wake]: hash('different wake bytes') } },
    { ...benchProof, cell: { ...benchProof.cell, voided: ['scenario failed'] } },
    { ...benchProof, cell: { ...benchProof.cell, failed: ['landing failed'] } },
    {
      ...benchProof,
      rule: 'O4',
      cell: { ...benchProof.cell, paths: { O4: benchProof.cell.paths.N1 } },
    },
    {
      ...benchProof,
      cell: {
        ...benchProof.cell,
        paths: { N1: { ...benchProof.cell.paths.N1, reached: false, label: 'path not reached' } },
      },
    },
  ];
  for (const proof of invalid) {
    write(proofPath, proof);
    await assert.rejects(verifyQueueProof(env, root), /QUEUE_PROOF_REQUIRED:.*projectHostedFinishWake/);
  }
});

test('a proof only covers its listed paths and deletions need a null digest', async t => {
  const { root, write, machine } = fixture(t);
  write(proofPath, replayProof);
  const env = machine([wake, order, proofPath]);
  await assert.rejects(verifyQueueProof(env, root), /for convex\/projectHostedLandingOrder\.ts\./);
  rmSync(join(root, wake));
  await assert.rejects(verifyQueueProof(machine([wake, proofPath]), root), /QUEUE_PROOF_REQUIRED/);
  write(proofPath, { ...replayProof, changes: { [wake]: null } });
  await verifyQueueProof(machine([wake, proofPath]), root);
});

test('the machine guard uses only the pinned Candidate comparison and leaves direct verification and audits alone', async t => {
  const { root, write, machine } = fixture(t);
  write(proofPath, replayProof);
  await assert.rejects(verifyQueueProof(machine([wake]), root), /QUEUE_PROOF_REQUIRED/);
  await verifyQueueProof({ ...machine([wake]), FORGE_SELECTED_TESTS: '{"scope":"partial"}' }, root);
  await verifyQueueProof(machine([wake], { mainCheck: { channel: 'main' } }), root);
  await verifyQueueProof(machine(['README.md']), root);
  await verifyQueueProof({}, root);
});
