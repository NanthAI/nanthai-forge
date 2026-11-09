// SPDX-License-Identifier: Apache-2.0
// Global risk for every ecosystem (Issue c2f6a26a): a passed check is reused after main moved, and a
// newer landing overtakes an older one, only when neither side touched a file that can change every
// test or build. Harness and build files are matched by shape at any depth, plus declared globs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkEntryPaths,
  checkRunEntryPaths,
  FIRST_CHECK_RISK_RULE,
  firstCheckRisk,
  globalRiskBetween,
  sharedSequenceFolders,
} from '../dist/first-check-risk.js';
import { validCrossHeadProof } from '../dist/hosted-cross-head-proof.js';
import { unrelatedChanges } from '../dist/landing-overtake.js';
import { hostedCheckDefinition } from '../dist/hosted-check.js';

/** One fixture per ecosystem: harness or build files a disjoint main change can alter for every test. */
const HARNESS = {
  'js/vitest': ['packages/x/vitest.setup.ts', 'vitest.workspace.ts', 'apps/web/vitest.workspace.mts'],
  'js/jest': [
    'packages/x/jest.setup.js',
    'libs/a/jest.preset.js',
    'apps/web/src/setupTests.ts',
    'packages/a/src/__mocks__/axios.js',
    'apps/web/jest.config.json',
    'e2e/playwright.global-setup.ts',
    'packages/x/global-setup.ts',
  ],
  'js/mocha-karma-cypress': ['packages/a/.mocharc.yml', 'web/karma.conf.js', 'cypress/support/e2e.ts'],
  'js/test-folder': ['packages/a/test/setup.ts', 'packages/a/tests/globals.d.ts'],
  'ruby/rspec': [
    'spec/spec_helper.rb',
    'spec/rails_helper.rb',
    'engines/billing/spec/spec_helper.rb',
    'spec/support/factory_bot.rb',
    'engines/billing/.rspec',
    'engines/billing/Rakefile',
    'engines/billing/billing.gemspec',
    'test/test_helper.rb',
  ],
  elixir: [
    'apps/core/mix.exs',
    'apps/core/mix.lock',
    'apps/core/test/test_helper.exs',
    'apps/core/test/support/data_case.ex',
  ],
  swift: ['Sources/Package.swift', 'pkgs/kit/Package.resolved', 'ios/Podfile'],
  dart: ['app/pubspec.yaml', 'app/pubspec.lock', 'app/analysis_options.yaml'],
  php: ['php/phpunit.xml', 'php/phpunit.xml.dist', 'php/tests/bootstrap.php'],
  scala: ['svc/build.sbt', 'svc/project/plugins.sbt', 'svc/project/build.properties'],
  deno: ['web/deno.json', 'web/deno.jsonc', 'web/deno.lock'],
  bun: ['app/bunfig.toml'],
  nix: ['nix/flake.nix', 'flake.lock', 'tools/shell.nix'],
  python: ['py/constraints-dev.txt', 'py/.coveragerc', 'py/tests/support/db.py'],
  environment: ['svc/.env.test', 'svc/docker-compose.test.yml', 'svc/compose.yaml'],
  'c-cpp': ['native/meson.build', 'native/rules.mk', 'native/conanfile.txt', 'native/vcpkg.json'],
  'js/workspace-tools': ['turbo.json', 'apps/a/project.json', 'nx.json'],
};
/** Root `.txt` build inputs v3 read as prose. */
const ROOT_TEXT = ['constraints.txt', 'meson_options.txt', 'conanfile.txt'];

for (const [ecosystem, paths] of Object.entries(HARNESS))
  test(`replay (${ecosystem}): a harness file on main makes a disjoint code change recheck`, () => {
    for (const path of paths) {
      assert.notEqual(firstCheckRisk(path), null, path);
      assert.equal(globalRiskBetween(['src/cart.ts'], [path]), true, path);
      assert.equal(globalRiskBetween([path], ['src/cart.ts']), true, path);
      assert.equal(unrelatedChanges(['src/cart.ts'], [path], []), false, `overtake ${path}`);
    }
    // Before (rule v3) at least one of them landed on a check that never saw it.
    assert.ok(
      paths.some(path => firstCheckRisk(path, [], 'first-check-risk-v3') === null),
      `${ecosystem}: v3 missed none, so this fixture replays nothing`,
    );
  });

test('a root build input named *.txt is risk from v4; prose names stay reusable', () => {
  for (const path of ROOT_TEXT) {
    assert.equal(firstCheckRisk(path, [], 'first-check-risk-v3'), null, `v3 ${path}`);
    assert.notEqual(firstCheckRisk(path), null, path);
  }
  for (const path of [
    'README.txt',
    'LICENSE-Apache-2.0.txt',
    'THIRD_PARTY_NOTICES.txt',
    'llms.txt',
    'CHANGELOG.txt',
  ])
    assert.equal(firstCheckRisk(path), null, path);
});

test('ordinary source, tests and fixtures stay reusable under v4', () => {
  for (const path of [
    'src/setup.ts',
    'src/hosted-bootstrap.ts',
    'src/workspace.ts',
    'src/helpers.ts',
    'tests/bootstrap-interval.test.mjs',
    'tests/bench-teardown.test.mjs',
    'test/setup.test.ts',
    'spec/models/user_spec.rb',
    'spec/helpers/user_helper_spec.rb',
    'tests/fixtures/a.json',
    'pkg/a/testdata/x.json',
    'docs/setup.md',
    'app/lib/main.dart',
    'apps/core/lib/core.ex',
    'Sources/Kit/Kit.swift',
  ])
    assert.equal(firstCheckRisk(path), null, path);
  assert.equal(globalRiskBetween(['src/cart.ts'], ['src/price.ts']), false);
});

test('declared globalRiskPaths are risk for reuse and overtaking, with ** globs', () => {
  const check = {
    executable: 'bash',
    args: ['ci/check.sh'],
    globalRiskPaths: ['tools/harness/**', 'fixtures/shared/*.json'],
  };
  const entries = checkRunEntryPaths(check);
  assert.deepEqual(entries, ['ci/check.sh', 'tools/harness/**', 'fixtures/shared/*.json']);
  for (const path of ['tools/harness/env.sh', 'tools/harness/deep/x.py', 'fixtures/shared/a.json']) {
    assert.equal(globalRiskBetween(['src/cart.ts'], [path]), false, `undeclared ${path}`);
    assert.equal(globalRiskBetween(['src/cart.ts'], [path], entries), true, path);
    assert.equal(unrelatedChanges(['src/cart.ts'], [path], entries), false, path);
  }
  assert.equal(globalRiskBetween(['src/cart.ts'], ['fixtures/shared/sub/a.json'], entries), false);
  // Governance protects command entries only, never the declared risk globs.
  assert.deepEqual(checkEntryPaths(check), ['ci/check.sh']);
  // The declaration is part of the definition digest, so a reused run proves the same declaration.
  const base = { name: 'verify', executable: 'bash', args: ['ci/check.sh'], environmentLabel: '' };
  const id = '00000000-0000-4000-8000-000000000001';
  const at = '2026-11-08T00:00:00.000Z';
  const plain = hostedCheckDefinition(base, id, at);
  const declared = hostedCheckDefinition({ ...base, globalRiskPaths: ['tools/harness/**'] }, id, at);
  assert.notEqual(plain.definition, declared.definition);
  assert.deepEqual(declared.globalRiskPaths, ['tools/harness/**']);
  assert.throws(() => hostedCheckDefinition({ ...base, globalRiskPaths: ['../x'] }, id, at));
  assert.throws(() => hostedCheckDefinition({ ...base, globalRiskPaths: [] }, id, at));
});

test('a proof keeps the rule it was decided under: v3 receipts stay valid, v4 refuses a harness file', () => {
  const proof = riskRule => ({
    algorithm: 'clean-disjoint-v2',
    candidatePaths: ['src/cart.ts'],
    mainPaths: ['packages/x/vitest.setup.ts'],
    docsOverlap: [],
    checkEntries: [],
    riskRule,
  });
  assert.equal(validCrossHeadProof(proof('first-check-risk-v5')), false);
  assert.equal(validCrossHeadProof(proof('first-check-risk-v3')), true);
  assert.equal(validCrossHeadProof(proof('first-check-risk-v4')), false);
  // A placed v3 proof is re-checked under v3, not under the newer list.
  const placed = riskRule => ({
    ...proof(riskRule),
    candidatePaths: ['packages/c/package.json'],
    mainPaths: ['packages/a/src/x.ts', 'packages/a/vitest.setup.ts'],
    placedRisk: [{ path: 'packages/c/package.json', reach: ['js:packages/c'] }],
  });
  assert.equal(validCrossHeadProof(placed('first-check-risk-v3')), true);
  assert.equal(validCrossHeadProof(placed('first-check-risk-v4')), false);
  assert.equal(validCrossHeadProof(placed('first-check-risk-v2')), false);
});

// Hermeticity (Issue c6b81429): a folder tests read as a whole (snapshots, fixtures, golden files,
// test data) is risk when both sides changed a file in the same one, like a migrations folder.
test('v5: both sides changing the same fixture or snapshot folder is risk; apart they stay reusable', () => {
  assert.equal(FIRST_CHECK_RISK_RULE, 'first-check-risk-v5');
  for (const [a, b, folder] of [
    ['tests/fixtures/a.json', 'tests/fixtures/b.json', 'tests/fixtures'],
    ['src/__snapshots__/a.test.ts.snap', 'src/__snapshots__/b.test.ts.snap', 'src/__snapshots__'],
    ['pkg/a/testdata/x.golden', 'pkg/a/testdata/y.golden', 'pkg/a/testdata'],
    ['spec/fixtures/files/a.csv', 'spec/fixtures/users.yml', 'spec/fixtures'],
    ['test/cassettes/a.yml', 'test/cassettes/b.yml', 'test/cassettes'],
    ['tests/golden/a.txt', 'tests/golden/b.txt', 'tests/golden'],
  ]) {
    assert.deepEqual(sharedSequenceFolders([a], [b]), [folder], a);
    assert.equal(globalRiskBetween([a], [b]), true, a);
    assert.equal(unrelatedChanges([a], [b], []), false, `overtaking ${a}`);
    assert.equal(globalRiskBetween([a], [b], [], 'first-check-risk-v4'), false, `v4 ${a}`);
  }
  // Different folders, or a fixture on one side only, keep the change reusable.
  assert.equal(globalRiskBetween(['pkg/a/testdata/x.json'], ['pkg/b/testdata/y.json']), false);
  assert.equal(globalRiskBetween(['tests/fixtures/a.json'], ['src/cart.ts']), false);
  assert.equal(globalRiskBetween(['src/fixture-loader.ts'], ['src/fixtures.ts']), false);
  // Migrations keep their own rule inside a fixtures folder.
  assert.deepEqual(
    sharedSequenceFolders(['tests/fixtures/migrations/1.sql'], ['tests/fixtures/migrations/2.sql']),
    ['tests/fixtures/migrations'],
  );
  // A v4 proof stays valid under v4; v5 refuses the same pair.
  const proof = riskRule => ({
    algorithm: 'clean-disjoint-v2',
    candidatePaths: ['tests/fixtures/a.json'],
    mainPaths: ['tests/fixtures/b.json'],
    docsOverlap: [],
    checkEntries: [],
    riskRule,
  });
  assert.equal(validCrossHeadProof(proof('first-check-risk-v4')), true);
  assert.equal(validCrossHeadProof(proof('first-check-risk-v5')), false);
});
