// SPDX-License-Identifier: Apache-2.0
// Deterministic fake R2/Convex fixtures for 1323a44c: page-scoped HEAD retry and
// skip, reliable resume with retained evidence, and approved class 4 scope.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verificationIo } from '../scripts/lib/legacy-storage-verify.mjs';
import { headPins, MAX_SKIPPED_PAGES } from '../scripts/lib/legacy-storage-heads.mjs';
import { applyFilePages } from '../scripts/lib/legacy-storage-cleanup.mjs';
import { resumeWrites, maintenanceWindow, FLAG_NAMES } from '../scripts/lib/legacy-storage-window.mjs';
import { redactProviderText } from '../scripts/lib/legacy-storage-operator.mjs';
import { class4Approval } from '../scripts/lib/legacy-storage-class4.mjs';
import { parseCleanup } from '../scripts/lib/legacy-storage-cleanup-args.mjs';
const config = {
  R2_ACCOUNT_ID: 'synthetic',
  R2_BUCKET: 'bucket',
  R2_ACCESS_KEY_ID: 'synthetic',
  R2_SECRET_ACCESS_KEY: 'synthetic',
};
const digest = 'a'.repeat(64);
const okHead = () =>
  new Response(null, {
    headers: {
      'content-length': '7',
      'x-amz-checksum-sha256': Buffer.from(digest, 'hex').toString('base64'),
    },
  });
const noSleep = [];
const sleep = async ms => {
  noSleep.push(ms);
};
const pin = (id, keys = ['v1/p/p/o/' + digest]) => ({ storageId: id, class: 3, digest, size: 7, keys });

test('HEAD failures retain status class, HTTP status and timeout/network code without URLs', async () => {
  const cases = [
    [
      async () => {
        throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      },
      { statusClass: 'none', timeout: true, network: 'TimeoutError' },
    ],
    [
      async () => {
        throw Object.assign(new TypeError('fetch failed https://x/?X-Amz-Signature=s'), {
          cause: { code: 'ECONNRESET' },
        });
      },
      { statusClass: 'none', timeout: false, network: 'ECONNRESET' },
    ],
    [async () => new Response(null, { status: 503 }), { httpStatus: 503, statusClass: '5xx' }],
  ];
  for (const [fetcher, expected] of cases) {
    const metrics = {};
    const error = await verificationIo(config, metrics, fetcher)
      .headR2('v1/p/p/o/' + digest, 7, digest)
      .then(
        () => null,
        e => e,
      );
    assert.equal(error.message, 'VERIFY_HEAD_UNAVAILABLE');
    assert.deepEqual(error.head, expected);
    assert.doesNotMatch(JSON.stringify(error.head), /https?:|Signature/);
    assert.equal(metrics.r2Heads, 1);
  }
});

test('page HEAD retry: transient failure retries only failing files with backoff; integrity failure is not retried', async () => {
  noSleep.length = 0;
  let calls = 0;
  const flaky = new Map([['b', 1]]);
  const heads = {
    headR2: async key => {
      calls++;
      const id = key.split('#')[1];
      if ((flaky.get(id) ?? 0) > 0) {
        flaky.set(id, flaky.get(id) - 1);
        throw Object.assign(new Error('VERIFY_HEAD_UNAVAILABLE'), {
          head: { statusClass: 'none', timeout: true },
        });
      }
    },
  };
  const pins = ['a', 'b', 'c'].map(id => pin(id, ['k#' + id]));
  const ok = await headPins(pins, heads, { sleep });
  assert.equal(ok.ok, true);
  assert.equal(ok.attempts, 2);
  assert.equal(calls, 4); // three files, then only the failing one again
  assert.deepEqual(noSleep, [1000]);
  assert.ok(pins.every(p => p.recheckedAt));
  // Exhausted transient retry: bounded attempts, last failure keeps metadata.
  flaky.set('b', 99);
  noSleep.length = 0;
  calls = 0;
  const exhausted = await headPins(
    ['a', 'b'].map(id => pin(id, ['k#' + id])),
    heads,
    { sleep },
  );
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.attempts, 3);
  assert.equal(calls, 4);
  assert.deepEqual(noSleep, [1000, 4000]);
  assert.deepEqual(
    exhausted.failures.map(f => [f.storageId, f.code, f.transient, f.timeout, f.attempt]),
    [['b', 'VERIFY_HEAD_UNAVAILABLE', true, true, 3]],
  );
  // Checksum mismatch: never retried.
  calls = 0;
  const integrity = await headPins([pin('x')], {
    headR2: async () => {
      calls++;
      throw new Error('VERIFY_HEAD_CHECKSUM_MISMATCH');
    },
  });
  assert.equal(integrity.ok, false);
  assert.equal(integrity.attempts, 1);
  assert.equal(calls, 1);
  assert.equal(integrity.failures[0].transient, false);
});

test('an exhausted HEAD page is skipped and reported while other approved pages continue; skip limit stops dispatch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-head-skip-'));
  try {
    const pages = [0, 1, 2, 3, 4, 5].map(p => [
      pin('f' + p + 'a', ['k#' + p]),
      pin('f' + p + 'b', ['k#' + p]),
    ]);
    pages[5].push({ storageId: 'c4', class: 4, digest, size: 7, keys: [] });
    const calls = [];
    const io = {
      backup: async () => ({ checkedAt: new Date().toISOString() }),
      call: async (name, args) => {
        calls.push(args.part);
        assert.ok(args.pins.every(p => p.recheckedAt));
        return { deleted: args.pins.length, bytes: args.pins.length * 7, changedRows: 0, excluded: [] };
      },
    };
    const heads = {
      headR2: async key => {
        if (key === 'k#2')
          throw Object.assign(new Error('VERIFY_HEAD_UNAVAILABLE'), { head: { statusClass: 'none' } });
      },
    };
    const { results, skipped } = await applyFilePages({
      pages,
      heads,
      io,
      out: dir,
      backup: await io.backup(),
      retry: { sleep },
      request: index => ({ operationId: 'op', part: `delete-${index}` }),
    });
    assert.deepEqual(calls.sort(), ['delete-0', 'delete-1', 'delete-3', 'delete-4', 'delete-5']);
    assert.equal(skipped.length, 1);
    assert.equal(results[2].skipped, true);
    assert.equal(results[2].deleted, 0);
    assert.deepEqual(
      results[2].excluded.map(e => e.code),
      ['VERIFY_HEAD_UNAVAILABLE', 'VERIFY_HEAD_UNAVAILABLE'],
    );
    const report = JSON.parse(await readFile(join(dir, 'skipped-page-2.json')));
    assert.equal(report.attempts, 3);
    assert.equal(report.files, 2);
    assert.deepEqual(report.classes, { 3: { files: 2, bytes: 14 } });
    assert.equal(report.failures[0].statusClass, 'none');
    assert.ok((await readdir(dir)).every(f => !f.startsWith('request-2')));
    // Class 4 pins have no R2 copy to HEAD; they are rechecked by the mutation's metadata pins.
    assert.ok(pages[5][2].recheckedAt);
    // Systematic failure: more than MAX_SKIPPED_PAGES skipped pages stop dispatch.
    let mutations = 0;
    await assert.rejects(
      applyFilePages({
        pages: Array.from({ length: 20 }, (_, i) => [pin('g' + i)]),
        heads: { headR2: async () => Promise.reject(new Error('VERIFY_HEAD_MISSING')) },
        io: { ...io, call: async () => mutations++ },
        out: join(dir, 'limit'),
        backup: await io.backup(),
        retry: { sleep },
        request: index => ({ part: `delete-${index}` }),
      }),
      /CLEANUP_PAGE_FAILED/,
    );
    assert.equal(mutations, 0);
    assert.ok((await readdir(join(dir, 'limit'))).length <= MAX_SKIPPED_PAGES + 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** Deployment fake: env removal can fail once and can become visible late. */
function deployment({
  failFirstRemoval = false,
  hiddenProofs = 0,
  fenceFailures = 0,
  proofFailures = 0,
} = {}) {
  const env = new Set(FLAG_NAMES),
    log = [];
  let active = 0,
    overlap = false,
    visibleAfter = new Map(),
    proofs = 0,
    fence = 0,
    removals = 0;
  return {
    env,
    log,
    overlap: () => overlap,
    io: {
      endWindow: async () => {
        log.push('fence');
        if (fence++ < fenceFailures)
          throw Object.assign(new Error('CLEANUP_PROVIDER_FAILED'), {
            provider: { exitCode: 1, signal: null, timedOut: false, stderr: 'network' },
          });
        return { ended: true };
      },
      unsetFlag: async name => {
        active++;
        if (active > 1) overlap = true;
        await new Promise(r => setImmediate(r));
        active--;
        log.push('unset:' + name);
        if (failFirstRemoval && removals++ === 0)
          throw Object.assign(new Error('CLEANUP_PROVIDER_FAILED'), {
            provider: { exitCode: 1, signal: null, timedOut: false, stderr: 'conflict' },
          });
        env.delete(name);
        visibleAfter.set(name, proofs + hiddenProofs);
      },
      flagsPresent: async () => {
        proofs++;
        log.push('proof');
        if (proofs <= proofFailures) throw new Error('CLEANUP_PROVIDER_FAILED');
        return FLAG_NAMES.filter(n => env.has(n) || (visibleAfter.get(n) ?? 0) >= proofs);
      },
      flagsAbsent: async () => env.size === 0,
    },
  };
}

test('resume closes the fence first, removes flags sequentially, retains a failed first removal and proves absence', async () => {
  noSleep.length = 0;
  const d = deployment({ failFirstRemoval: true });
  const proof = await resumeWrites(d.io, 'op', { sleep });
  assert.equal(proof.flagsAbsent, true);
  assert.equal(proof.fenceClosed, true);
  assert.equal(d.overlap(), false);
  assert.equal(d.log[0], 'fence');
  assert.ok(d.log.indexOf('fence') < d.log.findIndex(e => e.startsWith('unset')));
  const failed = proof.resume.removals.filter(r => !r.ok);
  assert.equal(failed.length, 1);
  assert.deepEqual(failed[0].error, {
    code: 'CLEANUP_PROVIDER_FAILED',
    provider: { exitCode: 1, signal: null, timedOut: false, stderr: 'conflict' },
  });
  assert.equal(proof.resume.proofs.at(-1).present.length, 0);
  assert.equal(d.env.size, 0);
});

test('delayed visibility gets another proof before removal is repeated; failed proofs and fence retries are bounded', async () => {
  noSleep.length = 0;
  const d = deployment({ hiddenProofs: 1, fenceFailures: 1, proofFailures: 1 });
  const proof = await resumeWrites(d.io, 'op', { sleep });
  assert.equal(proof.flagsAbsent, true);
  assert.equal(proof.resume.fence.length, 2);
  assert.equal(proof.resume.fence[0].error.code, 'CLEANUP_PROVIDER_FAILED');
  // Round 1 proof failed -> remove both; round 2 still shows them (delayed) -> no repeat; round 3 absent.
  assert.equal(proof.resume.removals.length, 2);
  assert.equal(proof.resume.proofs[0].present, null);
  assert.deepEqual(proof.resume.proofs.at(-1).present, []);
  // Permanent failure: bounded rounds, structured evidence, never "success".
  const stuck = deployment();
  stuck.io.unsetFlag = async () => {
    throw new Error('CLEANUP_PROVIDER_FAILED');
  };
  const error = await resumeWrites(stuck.io, 'op', { sleep }).then(
    () => null,
    e => e,
  );
  assert.equal(error.message, 'CLEANUP_RESUME_FAILED');
  assert.equal(error.proof.flagsAbsent, false);
  assert.equal(error.proof.resume.proofs.length, 6);
  assert.ok(error.proof.resume.removals.length <= 10);
});

test('window: original work failure is preserved when the first resume fails and outer recovery proves absence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-resume-window-'));
  try {
    const d = deployment();
    d.env.clear();
    let removalCalls = 0;
    const io = {
      ...d.io,
      beginWindow: async () => ({ active: true }),
      setFlag: async n => d.env.add(n),
      flagsAbsent: async () => d.env.size === 0,
      // First resume attempt: every removal fails (as observed live); outer recovery succeeds.
      unsetFlag: async name => {
        if (removalCalls++ < 10) throw new Error('CLEANUP_PROVIDER_FAILED');
        d.env.delete(name);
      },
    };
    const run = maintenanceWindow(
      {
        out: dir,
        deployment: 'dev:fixture',
        operationId: 'op',
        leadGo: 'synthetic go',
        resumeRetry: { sleep },
      },
      async () => {
        throw Object.assign(new Error('VERIFY_HEAD_UNAVAILABLE'), { head: { statusClass: 'none' } });
      },
      io,
    );
    await assert.rejects(run, /VERIFY_HEAD_UNAVAILABLE/);
    assert.equal(d.env.size, 0);
    const receipt = JSON.parse(await readFile(join(dir, 'window.json')));
    assert.equal(receipt.status, 'ended');
    assert.equal(receipt.flagsAbsent, true);
    assert.equal(receipt.fenceClosed, true);
    assert.equal(receipt.workFailure.code, 'VERIFY_HEAD_UNAVAILABLE');
    assert.deepEqual(
      receipt.resumeAttempts.map(a => [a.ok, a.error?.code ?? null]),
      [
        [false, 'CLEANUP_RESUME_FAILED'],
        [true, null],
      ],
    );
    assert.ok(
      receipt.resumeAttempts[0].resume.removals.every(r => r.error.code === 'CLEANUP_PROVIDER_FAILED'),
    );
    assert.doesNotMatch(JSON.stringify(receipt), /synthetic secret/);
    // Both attempts failing: resume failure is reported with the original work failure attached.
    const dir2 = join(dir, 'second');
    const stuck = { ...io, unsetFlag: async () => Promise.reject(new Error('CLEANUP_PROVIDER_FAILED')) };
    const error = await maintenanceWindow(
      { out: dir2, deployment: 'dev:fixture', operationId: 'op2', leadGo: 'go', resumeRetry: { sleep } },
      async () => {
        throw new Error('VERIFY_HEAD_UNAVAILABLE');
      },
      stuck,
    ).then(
      () => null,
      e => e,
    );
    assert.equal(error.message, 'CLEANUP_RESUME_FAILED');
    assert.equal(error.workFailure, 'VERIFY_HEAD_UNAVAILABLE');
    assert.equal(JSON.parse(await readFile(join(dir2, 'window.json'))).status, 'resume-failed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('provider stderr evidence keeps flag names but redacts URLs, assignments and tokens', () => {
  const text = redactProviderText(
    'Error removing FORGE_R2_MAINTENANCE (fetch https://example-123.convex.cloud/api/x?sig=abcd) CONVEX_DEPLOY_KEY=dev:abc|tok eyJhbGciOiJIUzI1NiJ9abcdefghijklmnop',
  );
  assert.match(text, /FORGE_R2_MAINTENANCE/);
  assert.match(text, /\[url\]/);
  assert.doesNotMatch(text, /example-123|sig=|dev:abc|eyJhbGci/);
});

test('class 4 approval keeps reachable sections, live or unattributed history; deleted-project links may go', () => {
  const file = (id, sha) => ({ storageId: id, sha256: sha, bytes: 7, references: [], matchingCopies: [] });
  const h = c => c.repeat(64);
  const audit = {
    deployment: 'dev:fixture',
    coverage: { fullyPaged: true },
    projects: [
      { id: 'gone', removal: 'deleted' },
      { id: 'live', removal: null },
    ],
    files: [
      file('reach', h('1')),
      file('live', h('2')),
      file('unattr', h('3')),
      file('gone', h('4')),
      file('free', h('5')),
    ],
  };
  const attribution = {
    complete: true,
    deployment: 'dev:fixture',
    auditSha256: 'x',
    finishedAt: 't',
    matches: [
      { sha256: h('2'), project: 'live' },
      { sha256: h('3'), project: 'unattributed' },
      { sha256: h('4'), project: 'gone' },
    ],
  };
  const bodyProof = { complete: true, failures: [], sha256: 'p', references: [{ storageId: 'reach' }] };
  const a = class4Approval({ audit, auditSha256: 'x', attribution, bodyProof, decision: 'owner 2026-11-05' });
  assert.deepEqual(
    a.files.map(f => f.storageId),
    ['gone', 'free'],
  );
  assert.deepEqual(a.retained, {
    reachable: { files: 1, bytes: 7 },
    liveHistory: { files: 2, bytes: 7 * 2 },
  });
  assert.deepEqual(a.deletedProjectLinked, { files: 1, bytes: 7 });
  assert.match(a.sha256, /^[a-f0-9]{64}$/);
  assert.throws(
    () => class4Approval({ audit, auditSha256: 'y', attribution, bodyProof, decision: 'x' }),
    /CLASS4_ATTRIBUTION/,
  );
  assert.throws(
    () =>
      class4Approval({
        audit,
        auditSha256: 'x',
        attribution,
        bodyProof: { ...bodyProof, complete: false },
        decision: 'x',
      }),
    /CLEANUP_BODY_COVERAGE_REQUIRED/,
  );
});

test('remaining-only arguments refuse a bench manifest; class 4 approval requires remaining-only', () => {
  const base = [
    'apply',
    '--deployment',
    'dev:x',
    '--audit',
    '/a',
    '--verification',
    '/v',
    '--body-coverage',
    '/b',
  ];
  const go = [
    '--out',
    '/private/out',
    '--operation-id',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '--lead-go',
    'go',
  ];
  assert.equal(parseCleanup([...base, ...go, '--remaining-only']).remainingOnly, true);
  assert.throws(
    () => parseCleanup([...base, ...go, '--remaining-only', '--bench-manifest', '/m']),
    /ARGUMENT_INVALID/,
  );
  assert.throws(() => parseCleanup([...base, ...go, '--class4-approval', '/c']), /ARGUMENT_INVALID/);
  assert.equal(
    parseCleanup([...base, ...go, '--remaining-only', '--class4-approval', '/c']).class4Approval,
    '/c',
  );
});
