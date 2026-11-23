// SPDX-License-Identifier: Apache-2.0
// When the dev site deploys (Item ef6aa22a, scripts/site-deploy-plan.mjs): only when what it serves changed, at most
// once per window, and a missing record or an unlistable change always builds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  DEPLOY_WINDOW_SECONDS,
  shouldDeploy,
  buildFiles,
  deployPlan,
  servedChanges,
  servedSources,
} from '../scripts/site-deploy-plan.mjs';

const live = (deployedAt = '2026-11-23T10:00:00Z') => ({
  commit: 'a'.repeat(40),
  deployedAt,
  digest: 'd',
  sources: ['src/public-meta.ts', 'convex/_generated/api.js'],
});
const at = iso => Date.parse(iso);

test('a src/-only or test-only landing does not build; a bundled src/ file or any web file does', () => {
  const now = at('2026-11-23T12:00:00Z');
  for (const changed of [['src/lane.ts', 'tests/lane.test.mjs'], ['tests/x.test.mjs'], ['plans/next.md']])
    assert.deepEqual(deployPlan({ live: live(), changed, now }).build, false, changed.join(' '));
  for (const changed of [
    ['src/public-meta.ts'],
    ['web/src/app/App.tsx'],
    ['site/worker.ts'],
    ['docs/access.md'],
    ['package-lock.json'],
    ['convex/_generated/api.js'],
  ])
    assert.deepEqual(deployPlan({ live: live(), changed, now }), {
      build: true,
      reason: '1 served files changed since the deploy',
    });
});

test('a changed helper of the build counts as served', () => {
  const plan = deployPlan({
    live: live(),
    changed: ['scripts/docs-output-paths.mjs', 'scripts/check-test-signal.mjs'],
    build: ['scripts/docs-output-paths.mjs'],
    now: at('2026-11-23T12:00:00Z'),
  });
  assert.equal(plan.build, true);
  assert.deepEqual(
    servedChanges(['scripts/check-test-signal.mjs'], [], ['scripts/docs-output-paths.mjs']),
    [],
  );
});

test('landings inside the window are deferred to the next run after it; later ones build at once', () => {
  const deployed = '2026-11-23T12:00:00Z';
  const changed = ['web/src/x.ts'];
  const window = DEPLOY_WINDOW_SECONDS * 1000;
  const plan = now => deployPlan({ live: live(deployed), changed, now });
  assert.deepEqual(plan(at(deployed) + 60_000), {
    build: false,
    reason: '1 served files changed; deployed under a window ago, so the next run after it builds',
  });
  assert.equal(plan(at(deployed) + window - 1).build, false);
  assert.equal(plan(at(deployed) + window).build, true);
  assert.equal(plan(at(deployed) + 3_600_000).build, true);
  // A clock behind the record defers for at most one window, never for good.
  assert.equal(plan(at(deployed) - window + 1).build, false);
  assert.equal(plan(at(deployed) - window).build, true);
  // An unlistable change inside the window is deferred too; after it, it builds.
  assert.equal(deployPlan({ live: live(deployed), changed: null, now: at(deployed) + 60_000 }).build, false);
  assert.equal(deployPlan({ live: live(deployed), changed: null, now: at(deployed) + window }).build, true);
  // Nothing served changed: no build, even outside the window.
  assert.deepEqual(
    deployPlan({ live: live(deployed), changed: ['tests/a.test.mjs'], now: at(deployed) + window }),
    {
      build: false,
      reason: '1 files changed since the deploy; none is served',
    },
  );
});

test('a missing record or an unlistable change always builds: the rule only ever skips work', () => {
  const now = at('2026-11-23T12:00:00Z');
  for (const record of [null, {}, { ...live(), sources: undefined }, { ...live(), commit: 5 }])
    assert.deepEqual(deployPlan({ live: record, changed: [], now }), {
      build: true,
      reason: 'the site has no deploy record',
    });
  assert.equal(deployPlan({ live: live(), changed: null, now }).build, true);
});

test('a bundle records its repo files outside web/, never packages or virtual modules', () => {
  const root = '/repo';
  assert.deepEqual(
    servedSources(
      [
        '/repo/src/a.ts?commonjs-proxy',
        '/repo/convex/_generated/api.js',
        '/repo/web/src/main.tsx',
        '/repo/node_modules/react/index.js',
        '\0vite/preload-helper',
        '/elsewhere/x.js',
      ],
      root,
    ),
    ['convex/_generated/api.js', 'src/a.ts'],
  );
});

test('the build files follow relative imports and asset URLs from the entries, and stop at packages', t => {
  const root = mkdtempSync(join(tmpdir(), 'site-plan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write(
    'scripts/entry.mjs',
    "import { a } from './a.mjs';\nimport 'vite';\nconst x = new URL('./stub.mjs', import.meta.url);",
  );
  write('scripts/a.mjs', "export { b } from '../src/b';\nconst c = await import('./c.ts');");
  write('scripts/stub.mjs', '');
  write('scripts/c.ts', "import '../web/src/ds';");
  write('web/src/ds/index.ts', '');
  write('src/b.ts', "import x from './missing.js';");
  write('scripts/unused.mjs', '');
  assert.deepEqual(buildFiles(root, ['scripts/entry.mjs', 'scripts/absent.mjs']), [
    'scripts/a.mjs',
    'scripts/c.ts',
    'scripts/entry.mjs',
    'scripts/stub.mjs',
    'src/b.ts',
    'web/src/ds/index.ts',
  ]);
});

test('served documents, the generated references and the error codes count without importing all of src/', () => {
  const now = at('2026-11-23T12:00:00Z');
  for (const changed of [
    ['scripts/package-documents/guides/new.json'],
    ['src/cli.ts'],
    ['src/hosted-agent-help.ts'],
    ['src/error-teaching.ts'],
  ])
    assert.equal(deployPlan({ live: live(), changed, now }).build, true, changed[0]);
  // A code added or removed anywhere changes the error reference: the recorded digest differs.
  const record = { ...live(), errorCodes: 'before' };
  assert.equal(
    deployPlan({ live: record, changed: ['src/lane.ts'], now, errorCodes: 'before' }).build,
    false,
  );
  assert.equal(deployPlan({ live: record, changed: ['src/lane.ts'], now, errorCodes: 'after' }).build, true);
});

test('a scheduled or manual run counts any src/ or scripts/ change, so a deep change is never skipped for good', () => {
  const now = at('2026-11-23T12:00:00Z');
  const changed = ['src/hosted-agent-contract.ts', 'tests/a.test.mjs'];
  assert.equal(deployPlan({ live: live(), changed, now }).build, false);
  assert.deepEqual(deployPlan({ live: live(), changed, now, deep: true }), {
    build: true,
    reason: '1 served files changed since the deploy',
  });
  assert.equal(deployPlan({ live: live(), changed: ['tests/a.test.mjs'], now, deep: true }).build, false);
});

test('the same bytes are not uploaded again, except to replace a record without its commit', () => {
  const built = { digest: 'd1' };
  assert.equal(shouldDeploy({ ...live(), digest: 'd1' }, built), false);
  assert.equal(shouldDeploy({ ...live(), digest: 'd0' }, built), true);
  assert.equal(shouldDeploy({ ...live(), commit: null, digest: 'd1' }, built), true);
  assert.equal(shouldDeploy(null, built), true);
});
