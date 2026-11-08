// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { JunitReader, junitFile, junitLimits } from '../dist/junit-report.js';
import { mergeJunitReports, readJunitReports } from '../dist/junit-report-files.js';
import { ContractTimingReader } from '../dist/contract-test-timings.js';
import { checkFileSummary } from '../dist/check-file-summary.js';
import { checkFailureDetail } from '../dist/check-failure-detail.js';
import { diagnoseBatchFailure } from '../dist/hosted-batch-diagnosis.js';

const parse = (xml, checkout) => {
  const reader = new JunitReader(checkout);
  reader.accept(xml);
  return reader.finish();
};
const byFile = reports => Object.fromEntries((reports ?? []).map(report => [report.file, report]));
const directory = t => {
  const path = mkdtempSync(join(tmpdir(), 'forge-junit-test-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
};

// vitest --reporter=junit: suites and classnames are repository-relative test files.
const vitest = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="3" failures="1" errors="0" time="0.9">
  <testsuite name="packages/billing/test/invoice.spec.ts" tests="2" failures="1" time="0.4">
    <testcase classname="packages/billing/test/invoice.spec.ts" name="totals &amp; tax" time="0.25">
      <failure message="expected 12 to be 13" type="AssertionError"><![CDATA[AssertionError: expected 12 to be 13
 ❯ packages/billing/src/invoice.ts:41:9]]></failure>
    </testcase>
    <testcase classname="packages/billing/test/invoice.spec.ts" name="rounds" time="0.15"/>
  </testsuite>
  <testsuite name="apps/web/test/cart.spec.ts" tests="2" failures="0" time="0.5">
    <testcase classname="apps/web/test/cart.spec.ts" name="adds" time="0.5"/>
    <testcase classname="apps/web/test/cart.spec.ts" name="later"><skipped/></testcase>
  </testsuite>
</testsuites>`;

test('JUnit from any runner becomes per-file failures, first errors and timings', () => {
  const files = byFile(parse(vitest));
  assert.deepEqual(Object.keys(files).sort(), [
    'apps/web/test/cart.spec.ts',
    'packages/billing/test/invoice.spec.ts',
  ]);
  const failed = files['packages/billing/test/invoice.spec.ts'];
  assert.deepEqual(failed.counts, { total: 2, failed: 1 });
  assert.equal(failed.durationMs, 400);
  assert.match(failed.firstError, /^totals & tax: AssertionError: expected 12 to be 13\n/);
  assert.match(failed.firstError, /packages\/billing\/src\/invoice\.ts:41/);
  // A skipped test is not counted; passing files keep their measured duration.
  assert.deepEqual(files['apps/web/test/cart.spec.ts'].counts, { total: 1, failed: 0 });
  assert.equal(files['apps/web/test/cart.spec.ts'].durationMs, 500);
});

test('pytest dotted classnames, Surefire flaky reruns and Go packages name their files', () => {
  const files = byFile(
    parse(`<testsuites><testsuite name="pytest" tests="3">
      <testcase classname="tests.billing.test_refunds.TestRefund" name="test_partial" time="0.1">
        <error message="KeyError: 'amount'">Traceback ... app/refunds.py:7</error>
      </testcase>
      <testcase classname="tests.billing.test_refunds" name="test_full" time="0.2"/>
    </testsuite>
    <testsuite name="com.acme.LedgerTest" file="src/test/java/com/acme/LedgerTest.java">
      <testcase classname="com.acme.LedgerTest" name="posts" time="1.5">
        <flakyFailure message="timeout" type="java.lang.AssertionError">first attempt</flakyFailure>
      </testcase>
    </testsuite>
    <testsuite name="example.com/shop/internal/payments">
      <testcase classname="example.com/shop/internal/payments" name="TestCharge" time="0.01">
        <rerunFailure message="first">attempt 1</rerunFailure>
        <failure message="charge declined">payments_test.go:22</failure>
      </testcase>
    </testsuite></testsuites>`),
  );
  const python = files['tests/billing/test_refunds.py'];
  assert.deepEqual(python.counts, { total: 2, failed: 1 });
  assert.match(python.firstError, /^test_partial: KeyError: 'amount'\nTraceback/);
  const java = files['src/test/java/com/acme/LedgerTest.java'];
  assert.equal(java.flaky, true, 'a failed attempt that passed on rerun is a flake, not a failure');
  assert.equal(java.counts.failed, 0);
  assert.match(java.firstError, /^posts: java\.lang\.AssertionError: timeout/);
  const go = files['example.com/shop/internal/payments'];
  assert.equal(go.counts.failed, 1);
  assert.equal(go.flaky, undefined, 'a final failure after reruns is a failure');
  assert.match(go.firstError, /^TestCharge: charge declined\npayments_test\.go:22/, 'the final failure wins');
});

test('the reader is a stream: any chunking gives the same records', () => {
  const whole = parse(vitest);
  const reader = new JunitReader();
  for (let at = 0; at < vitest.length; at += 7) reader.accept(vitest.slice(at, at + 7));
  assert.deepEqual(reader.finish(), whole);
});

test('file names are repository-relative; machine paths outside the checkout keep only the name', () => {
  assert.equal(junitFile({ file: '/work/repo/pkg/a.test.ts' }, {}, '/work/repo'), 'pkg/a.test.ts');
  assert.equal(junitFile({ file: '/opt/elsewhere/x/a.test.ts' }, {}, '/work/repo'), 'a.test.ts');
  assert.equal(junitFile({ file: './lib\\b.test.js' }, {}), 'lib/b.test.js');
  assert.equal(junitFile({ classname: 'Cart adds items' }, { name: 'Cart' }), 'Cart adds items');
  assert.equal(junitFile({}, {}), 'junit');
});

test('malformed, entity-declaring, empty and oversized reports degrade to no JUnit records', t => {
  for (const xml of [
    '<testsuite><testcase name="a">',
    '<testsuite><testcase name="a"></testsuite></testcase>',
    '<!DOCTYPE x [<!ENTITY a "b">]><testsuite><testcase name="a"/></testsuite>',
    '<testsuite name="none"></testsuite>',
    'not xml at all',
    '',
  ])
    assert.equal(parse(xml), null, xml);
  // One unclosed token never buffers without bound.
  const reader = new JunitReader();
  reader.accept('<testsuite name="');
  for (let i = 0; i < 9; i++) reader.accept('x'.repeat(128 * 1024));
  assert.equal(reader.finish(), null);

  const dir = directory(t);
  writeFileSync(join(dir, 'bad.xml'), '<testsuite><testcase name="a">');
  writeFileSync(join(dir, 'notes.txt'), vitest);
  const huge = Buffer.alloc(junitLimits.fileBytes + 1, ' ');
  huge.write('<testsuites><testsuite name="t"><testcase name="a" classname="tests/a.test.js"/>');
  writeFileSync(join(dir, 'huge.xml'), huge);
  symlinkSync(join(dir, 'notes.txt'), join(dir, 'link.xml'));
  const read = readJunitReports(dir);
  assert.deepEqual(read.reports, []);
  assert.deepEqual(
    read.notes.map(note => note.split(' ')[2]),
    ['bad.xml', 'huge.xml', 'link.xml'],
    'each ignored report is named; a missing or non-XML file is not read',
  );
  assert.deepEqual(readJunitReports(join(dir, 'missing')).reports, []);
});

test('Forge markers win; JUnit adds only the files they did not report', t => {
  const dir = directory(t);
  writeFileSync(join(dir, 'a.xml'), vitest);
  writeFileSync(
    join(dir, 'b.xml'),
    '<testsuite name="x"><testcase classname="apps/web/test/cart.spec.ts" name="again" time="0.1"><failure message="boom"/></testcase></testsuite>',
  );
  const reader = new ContractTimingReader();
  reader.accept(
    '__FORGE_TESTS__' +
      JSON.stringify({
        file: 'packages/billing/test/invoice.spec.ts',
        complete: true,
        durationMs: 9,
        results: [{ name: 'own', passed: true }],
      }) +
      '\n',
  );
  const { reports } = readJunitReports(dir);
  assert.equal(mergeJunitReports(reader, reports), 1);
  assert.deepEqual(reader.reports['packages/billing/test/invoice.spec.ts'], { durationMs: 9, failed: false });
  // Two reports of one file add up: one failure fails the file.
  assert.equal(reader.reports['apps/web/test/cart.spec.ts'].failed, true);
  assert.equal(reader.reports['apps/web/test/cart.spec.ts'].durationMs, 600);
});

test('non-Forge red batch: JUnit names the culprit member without a full split', t => {
  const dir = directory(t);
  writeFileSync(join(dir, 'vitest.xml'), vitest);
  const members = [
    {
      submissionId: randomUUID(),
      intentId: randomUUID(),
      outcome: 'Invoice tax rounding',
      paths: ['packages/billing/src/invoice.ts'],
      tests: [],
    },
    {
      submissionId: randomUUID(),
      intentId: randomUUID(),
      outcome: 'Cart badge colour',
      paths: ['apps/web/src/components/Badge.tsx'],
      tests: [],
    },
    {
      submissionId: randomUUID(),
      intentId: randomUUID(),
      outcome: 'README wording',
      paths: ['README.md'],
      tests: [],
    },
  ];
  const semantic = { conflicts: [], overBudgetPairs: [] };
  const runOf = reader => ({
    id: randomUUID(),
    contractReports: reader.reports,
    testFiles: checkFileSummary(structuredClone(reader.reports)),
  });
  // Before: a non-Forge command prints no Forge markers, so nothing names a member.
  const before = diagnoseBatchFailure(members, runOf(new ContractTimingReader()), semantic);
  assert.deepEqual(before.failedTests, []);
  assert.deepEqual(before.suspects, []);
  // With its JUnit report the failing file names exactly the member that changed its module.
  const reader = new ContractTimingReader();
  mergeJunitReports(reader, readJunitReports(dir).reports);
  const run = runOf(reader);
  const failure = diagnoseBatchFailure(members, run, semantic);
  assert.deepEqual(failure.failedTests, ['packages/billing/test/invoice.spec.ts']);
  assert.deepEqual(failure.suspects, [members[0].submissionId]);
  assert.match(
    checkFailureDetail(run),
    /^Failing: packages\/billing\/test\/invoice\.spec\.ts \(totals & tax: AssertionError: expected 12 to be 13/,
  );
});
