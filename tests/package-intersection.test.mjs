// SPDX-License-Identifier: Apache-2.0
// Issue fc215574 at package level: a scoped main-race recheck of a configured command gets the
// packages that can see both changes (FORGE_CHECK_PACKAGES), not every package this change reaches.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildPackageGraph, packageSelection } from '../dist/package-graph.js';
import { packageIntersection } from '../dist/package-intersection.js';
import { writeCheckPackages } from '../dist/package-graph-checkout.js';

const cargo = {
  'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n',
  'Cargo.lock': '',
  'crates/core/Cargo.toml': '[package]\nname = "fx-core"\n',
  'crates/core/src/lib.rs': '',
  'crates/api/Cargo.toml': '[package]\nname = "fx-api"\n\n[dependencies]\nfx-core = { path = "../core" }\n',
  'crates/api/src/lib.rs': '',
  'crates/cli/Cargo.toml': '[package]\nname = "fx-cli"\n\n[dependencies]\nfx-api = { path = "../api" }\n',
  'crates/cli/src/main.rs': '',
  'crates/tool/Cargo.toml': '[package]\nname = "fx-tool"\n',
  'crates/tool/src/main.rs': '',
};
const graph = buildPackageGraph(Object.keys(cargo), path => cargo[path]);
const names = selection => selection.packages.map(pkg => pkg.name).sort();

test('replay: a dependent pair rechecks exactly the packages that can see both changes', () => {
  // This change edits core (core, api, cli affected); main edited api (api, cli affected).
  const both = packageIntersection(graph, ['crates/core/src/lib.rs'], ['crates/api/src/lib.rs']);
  assert.equal(both.scope, 'scoped');
  assert.deepEqual(names(both), ['fx-api', 'fx-cli', 'fx-core']);
  // Main edited an unrelated crate: only this change's own crate, not its dependents.
  const apart = packageIntersection(graph, ['crates/core/src/lib.rs'], ['crates/tool/src/main.rs']);
  assert.deepEqual(names(apart), ['fx-core']);
  assert.deepEqual(
    names(packageSelection(graph, ['crates/core/src/lib.rs'])),
    ['fx-api', 'fx-cli', 'fx-core'],
    'before',
  );
  assert.match(apart.reason, /2 of this change's 3 affected package\(s\) are main-audit debt/);
  // A main path the graph cannot place reaches every package: this change's affected set.
  assert.deepEqual(names(packageIntersection(graph, ['crates/core/src/lib.rs'], ['Cargo.lock'])), [
    'fx-api',
    'fx-cli',
    'fx-core',
  ]);
  // An unplaced path in this change falls back to full.
  assert.equal(packageIntersection(graph, ['Cargo.lock'], ['crates/tool/src/main.rs']).scope, 'full');
  assert.equal(
    packageIntersection({ status: 'unknown', reason: 'x' }, ['crates/core/src/lib.rs'], []).scope,
    'full',
  );
});

test('writeCheckPackages hands a scoped recheck the intersection', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-intersection-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(cargo)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const file = writeCheckPackages(root, {
    mode: 'scoped',
    paths: ['crates/core/src/lib.rs'],
    mainPaths: ['crates/tool/src/main.rs'],
  });
  t.after(() => file?.remove());
  const written = JSON.parse(readFileSync(file.path, 'utf8'));
  assert.deepEqual(written.commands, [
    { ecosystem: 'cargo', cwd: '', argv: ['cargo', 'test', '-p', 'fx-core'] },
  ]);
  // Without main's delta (a contract or first check) the command keeps this change's affected set.
  const plain = writeCheckPackages(root, { mode: 'scoped', paths: ['crates/core/src/lib.rs'] });
  t.after(() => plain?.remove());
  assert.equal(JSON.parse(readFileSync(plain.path, 'utf8')).packages.length, 3);
});
