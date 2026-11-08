// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '../dist/portable-hash.js';
import {
  learnFailures,
  learnFromLanding,
  learnedTests,
  rememberLandingPaths,
} from '../dist/preflight-learned.js';
import { preflightPlan } from '../dist/agent-preflight.js';
import { failedAuditTests } from '../dist/optimistic-evidence.js';
import { memberExplainsFailure, pathAliases } from '../dist/hosted-landing-suspect.js';
import { plausibleTestFile } from '../dist/test-file-name.js';

const laneId = '44444444-4444-4444-8444-444444444444';
const manifest = JSON.stringify({
  forge: { preflight: { tests: { glob: '**/*_test.go', command: ['go', 'test', '{files}'] } } },
});
function lane(t) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-any-ecosystem-'));
  const root = join(dir, 'lane');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const all = {
    'package.json': manifest,
    'go.mod': 'module example.com/billing\n',
    'pkg/a.go': 'package pkg\n',
    'pkg/a_test.go': 'package pkg\n',
    'pkg/b_test.go': 'package pkg\n',
  };
  for (const [path, body] of Object.entries(all)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return {
    root,
    files: Object.entries(all).map(([path, body]) => ({ path, blob: digest(body), mode: 'file' })),
  };
}
const failed = (...files) => ({
  submission: {
    error: { code: 'CHECK_FAILED' },
    testFiles: { counts: { failed: files.length }, failed: files.map(file => ({ file })) },
  },
});

test('a learned x_test.go runs again on the next change to the same path', t => {
  const { root, files } = lane(t);
  const plan = () => preflightPlan(root, { paths: ['pkg/a.go'], complete: true }, { laneId, files });
  assert.deepEqual(plan().tests, [], 'nothing names pkg/a.go yet');
  rememberLandingPaths(root, laneId, ['pkg/a.go']);
  learnFromLanding(root, failed('pkg/b_test.go'), laneId);
  assert.deepEqual(learnedTests(root, ['pkg/a.go']), ['pkg/b_test.go']);
  const after = plan();
  assert.deepEqual(after.tests, ['pkg/b_test.go']);
  assert.deepEqual(
    after.local.tiers.find(item => item.tier === 'learned'),
    {
      tier: 'learned',
      total: 1,
      local: 1,
    },
  );
  assert.match(after.command, /go test pkg\/b_test\.go/);
});

test('learned names must still be test files of the project runner', t => {
  const { root, files } = lane(t);
  // Stored by name shape, but this project's runner only reads *_test.go.
  learnFailures(root, ['pkg/a.go'], ['pkg/test_gone.py', 'pkg/b_test.go']);
  const plan = preflightPlan(root, { paths: ['pkg/a.go'], complete: true }, { laneId, files });
  assert.deepEqual(plan.tests, ['pkg/b_test.go']);
});

test('names that are not plain test files are never learned', t => {
  const { root } = lane(t);
  learnFailures(
    root,
    ['pkg/a.go'],
    ['../x_test.go', '/abs/x_test.go', 'pkg/notes.txt', 'a b_test.go', 'pkg/a.go'],
  );
  assert.deepEqual(learnedTests(root, ['pkg/a.go']), []);
  for (const good of [
    'x_test.go',
    'test_x.py',
    'src/FooTest.java',
    'src/FooTests.cs',
    'spec/x_spec.rb',
    'tests/x.test.mjs',
  ])
    assert(plausibleTestFile(good), good);
  for (const bad of ['', 'src/x.go', 'x_test.go/../y', '.hidden/x_test.go', 'x test.go', 42])
    assert(!plausibleTestFile(bad), String(bad));
});

test('retried audit failures accept Go, Python and Java test names, and refuse unsafe ones', t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'forge-audit-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const id = 'abc';
  const directory = join(dir, `check-${id}`);
  mkdirSync(directory);
  const audit = { id, head: 'head', backend: { pin: 'pin' }, check: { definition: 'def' } };
  const write = groups => {
    writeFileSync(
      join(directory, 'modal-plan.json'),
      JSON.stringify({ pin: 'pin', head: 'head', definition: 'def', groups }),
    );
    writeFileSync(
      join(directory, 'modal-shard-logs.json'),
      JSON.stringify([
        ...groups.map((_, index) => ({ index, attempt: 0, exitCode: 1 })),
        { index: groups.length, attempt: 0, exitCode: 0 },
      ]),
    );
  };
  write([['pkg/b_test.go'], ['tests/test_api.py'], ['src/test/java/com/acme/FooTest.java']]);
  assert.deepEqual(failedAuditTests({ directory: dir }, audit), [
    'pkg/b_test.go',
    'tests/test_api.py',
    'src/test/java/com/acme/FooTest.java',
  ]);
  write([['pkg/b_test.go'], ['../../etc/passwd']]);
  assert.equal(failedAuditTests({ directory: dir }, audit), undefined);
});

test('a JVM stack frame explains a failure through the changed class path', () => {
  assert.deepEqual(pathAliases('src/main/java/com/acme/billing/Invoice.java'), [
    'src/main/java/com/acme/billing/Invoice.java',
    'com.acme.billing.Invoice',
  ]);
  assert.deepEqual(pathAliases('app/src/main/kotlin/com/acme/Tax.kt').at(-1), 'com.acme.Tax');
  assert.deepEqual(pathAliases('src/a.ts'), ['src/a.ts', 'dist/a.js'], 'Forge paths keep their aliases');
  assert.deepEqual(pathAliases('pkg/a.go'), ['pkg/a.go']);
  const member = { paths: ['src/main/java/com/acme/billing/Invoice.java'], tests: [] };
  const trace = 'java.lang.AssertionError: total\n\tat com.acme.billing.Invoice.total(Invoice.java:42)';
  assert(memberExplainsFailure(member, 'com.acme.checkout.CartSuite', trace));
  assert(
    memberExplainsFailure(
      member,
      'com.acme.checkout.CartSuite',
      'at com.acme.billing.Invoice$Line.sum(X.java:9)',
    ),
  );
  // Another class that merely starts with the same letters is not this change.
  assert(
    !memberExplainsFailure(
      member,
      'com.acme.checkout.CartSuite',
      'at com.acme.billing.InvoiceFormatter.run(F.java:3)',
    ),
  );
  assert(
    !memberExplainsFailure(
      member,
      'com.acme.checkout.CartSuite',
      'at other.com.acme.billing.Invoice.total(I.java:1)',
    ),
  );
});
