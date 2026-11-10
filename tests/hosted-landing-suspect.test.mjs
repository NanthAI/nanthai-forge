// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  failedGroupAction,
  failingStep,
  landingSuspect,
  memberExplainsFailure,
  passedAlone,
  repeatOffender,
  sourceStem,
  testStem,
} from '../dist/hosted-landing-suspect.js';
import { progressWakeDue, CHECK_PROGRESS_WAKE_MS } from '../dist/landing-stall.js';

test('a suspect is only an unproven entry named by combined-failure evidence', () => {
  const named = { likelyCulprit: true };
  for (const phase of ['composing', 'queued', 'checking'])
    assert(landingSuspect({ phase, batchDiagnostic: named }));
  // Its own exact check passed: suspicion ends there.
  assert(!landingSuspect({ phase: 'ready', batchDiagnostic: named }));
  assert(!landingSuspect({ phase: 'queued', batchDiagnostic: { likelyCulprit: false } }));
  assert(!landingSuspect({ phase: 'queued' }));
});

test('wave 1 51d09ad5: a failing test names the module it exercises, not only a changed test file', () => {
  const member = { paths: ['src/hosted-pull-budget.ts'], tests: [] };
  assert(memberExplainsFailure(member, 'tests/hosted-pull-budget.test.mjs'));
  // The built module named in a stack trace is the same change.
  assert(
    memberExplainsFailure(
      { paths: ['src/landing-train-plan.ts'], tests: [] },
      'tests/other.test.mjs',
      'at dist/landing-train-plan.js:12',
    ),
  );
  // Generic or very short stems say nothing about which change a test exercises.
  assert(!memberExplainsFailure({ paths: ['src/index.ts'], tests: [] }, 'tests/index.test.mjs'));
  assert(!memberExplainsFailure({ paths: ['src/wait.ts'], tests: [] }, 'tests/wait.test.mjs'));
  assert(
    !memberExplainsFailure({ paths: ['docs/status.md'], tests: [] }, 'tests/hosted-pull-budget.test.mjs'),
  );
  // Declared contract tests and changed test files still count.
  assert(memberExplainsFailure({ paths: [], tests: ['tests/x.test.mjs'] }, 'tests/x.test.mjs'));
});

test('test-to-source matching works by file name in any folder and common conventions', () => {
  const explains = (path, file) => memberExplainsFailure({ paths: [path], tests: [] }, file);
  // Monorepo, Python, Go, Java and Ruby layouts: none under tests/ or src/.
  assert(explains('packages/billing/lib/invoice.ts', 'packages/billing/__tests__/invoice.spec.ts'));
  assert(explains('apps/web/components/CartBadge.tsx', 'apps/web/components/CartBadge.test.tsx'));
  assert(explains('shop/refunds.py', 'tests/unit/test_refunds.py'));
  assert(explains('internal/ledger/posting.go', 'internal/ledger/posting_test.go'));
  assert(explains('src/main/java/com/acme/Ledger.java', 'src/test/java/com/acme/LedgerTest.java'));
  assert(explains('app/models/account.rb', 'spec/models/account_spec.rb'));
  // Dotted test classes and Go package reports.
  assert(explains('src/main/java/com/acme/Ledger.java', 'com.acme.LedgerTest'));
  assert(explains('internal/payments/charge.go', 'example.com/shop/internal/payments'));
  assert(!explains('internal/paymentsx/charge.go', 'example.com/shop/internal/payments'));
  // Forge's own layout still matches.
  assert(explains('convex/projectHostedCulprit.ts', 'tests/projectHostedCulprit.test.mjs'));
  // Different stems, test files, docs, generic and short names never match.
  assert(!explains('packages/billing/lib/invoices.ts', 'packages/billing/test/invoice.spec.ts'));
  assert(!explains('packages/billing/test/other.spec.ts', 'packages/billing/test/invoice.spec.ts'));
  assert(!explains('docs/invoice.md', 'test/invoice.test.ts'));
  assert(!explains('lib/index.ts', 'test/index.test.ts'));
  assert(!explains('lib/cart.ts', 'test/cart.test.ts'));
  assert.equal(testStem('a/b/userService.test.ts'), 'userservice');
  assert.equal(testStem('lib/latest.ts'), undefined);
  assert.equal(sourceStem('lib/userService.ts'), 'userservice');
  assert.equal(sourceStem('lib/userService.test.ts'), undefined);
  assert.equal(sourceStem('README.md'), undefined);
});

test('a member that failed the same files with different peers is the common factor', () => {
  assert(repeatOffender(['tests/a.test.mjs'], ['tests/b.test.mjs', 'tests/a.test.mjs']));
  assert(!repeatOffender(['tests/a.test.mjs'], ['tests/b.test.mjs']));
  assert(!repeatOffender(undefined, ['tests/a.test.mjs']));
});

test('failed group action: settle exact solos, unstack once below an unpassed predecessor, else split', () => {
  const base = {
    members: 1,
    suspects: 0,
    semanticOrBudget: false,
    stacked: false,
    exactMain: true,
    predecessorPending: false,
    previouslyFailed: false,
  };
  // A one-member group on exact main is its own exact check: re-running the same tree only repeats it.
  assert.equal(failedGroupAction(base), 'settle');
  assert.equal(failedGroupAction({ ...base, exactMain: false }), 'split');
  assert.equal(failedGroupAction({ ...base, members: 2 }), 'split');
  // Wave 1 b04828ed: a group stacked on a failing predecessor recomposed ~100 times.
  const stacked = { ...base, members: 3, stacked: true, predecessorPending: true };
  assert.equal(failedGroupAction(stacked), 'unstack');
  assert.equal(failedGroupAction({ ...stacked, suspects: 1 }), 'split', 'evidence names a member');
  assert.equal(failedGroupAction({ ...stacked, previouslyFailed: true }), 'split', 'unstack is tried once');
  assert.equal(failedGroupAction({ ...stacked, predecessorPending: false }), 'split');
  assert.equal(failedGroupAction({ ...stacked, semanticOrBudget: true }), 'split');
});

test('combination-only failure: the failing step is attributed from sealed summaries, nothing fetched', () => {
  const streams = [
    { descriptor: JSON.stringify({ shard: 0 }), seal: JSON.stringify({}), failureExcerpt: '' },
    {
      descriptor: JSON.stringify({ shard: 3 }),
      seal: JSON.stringify({
        failureSummary:
          '> build:web\nwriting dist\nllms-full.txt is 409868 bytes; the budget is 409600\nnpm ERR! code 1',
      }),
    },
  ];
  // The step's own line wins over npm's trailing `npm ERR!` noise.
  assert.deepEqual(failingStep(streams, 4), {
    job: 'job 3 (static)',
    excerpt: 'llms-full.txt is 409868 bytes; the budget is 409600',
  });
  const budget = failingStep(
    [
      {
        descriptor: JSON.stringify({ shard: 3 }),
        seal: JSON.stringify({ failureSummary: 'llms-full.txt is 409868 bytes; the budget is 409600' }),
      },
    ],
    4,
  );
  assert.deepEqual(budget, {
    job: 'job 3 (static)',
    excerpt: 'llms-full.txt is 409868 bytes; the budget is 409600',
  });
  assert.equal(failingStep([], 4), null);
  assert.equal(failingStep([{ descriptor: 'not json', seal: null }], 4), null);
});

test('w30 incident: a runner all-clear count (`ℹ fail 0`) is never named as the failing step', () => {
  // Tests passed, then the style step failed; node's summary line says `fail 0`.
  const step = failingStep(
    [
      {
        descriptor: JSON.stringify({ shard: 3 }),
        seal: JSON.stringify({
          failureSummary:
            'ℹ pass 8\nℹ fail 0\nsrc/discount.js:1 first line must start with "// tiny-shop:"\nsrc/discount.js:2 longer than 80 characters\nnpm error code 1',
        }),
      },
    ],
    4,
  );
  assert.equal(step.excerpt, 'src/discount.js:2 longer than 80 characters');
});

test('a member that passes alone after a shared failure is reported as combination-only, once', () => {
  const diagnostic = {
    sharedRunId: 'run-1',
    likelyCulprit: true,
    individualPassed: false,
    failedTests: [],
    message: 'Shared run failed.',
  };
  const passed = passedAlone(diagnostic);
  assert.equal(passed.likelyCulprit, false);
  assert.equal(passed.individualPassed, true);
  assert.match(
    passed.message,
    /run-1 failed \(its failing step\) but this member passed its own exact check/,
  );
  assert.equal(passedAlone(passed), passed, 'reported once');
  assert.equal(passedAlone(undefined), undefined);
});

test('incident c329d191: running-check progress reaches the queue at most once per window', () => {
  const now = Date.parse('2026-11-05T06:57:02Z');
  assert(progressWakeDue(undefined, now), 'first progress always reaches the queue');
  assert(!progressWakeDue(new Date(now - 10_000).toISOString(), now));
  assert(progressWakeDue(new Date(now - CHECK_PROGRESS_WAKE_MS).toISOString(), now));
});
