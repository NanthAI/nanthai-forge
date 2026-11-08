// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkEnvironment, checkProcessEnvironment } from '../dist/check-environment.js';

function sandbox(t) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-cache-isolation-'));
  const saved = process.env.HOME;
  process.env.HOME = join(directory, 'home');
  mkdirSync(process.env.HOME);
  t.after(() => {
    process.env.HOME = saved;
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
const prepared = (directory, run, scope) => {
  const clean = checkProcessEnvironment(
    { env: [], credentials: [] },
    checkEnvironment(),
    join(directory, run),
    scope,
  );
  clean.prepare();
  return clean.env;
};
const sharedNames = ['GOMODCACHE', 'GOCACHE', 'PIP_CACHE_DIR', 'UV_CACHE_DIR', 'NUGET_PACKAGES'];

test('every shared check cache is segmented per project', t => {
  const directory = sandbox(t);
  const one = prepared(directory, 'r1', 'project-one'),
    again = prepared(directory, 'r2', 'project-one'),
    two = prepared(directory, 'r3', 'project-two');
  for (const name of sharedNames) {
    assert.equal(one[name], again[name], `${name} is stable within a project`);
    assert.notEqual(one[name], two[name], `${name} differs between projects`);
  }
  assert.notEqual(one.MAVEN_ARGS, two.MAVEN_ARGS);
  assert.equal(one.MAVEN_ARGS, again.MAVEN_ARGS);
  // The recorded environment, and so the fingerprint, does not depend on the project.
  assert.equal(checkEnvironment().fingerprint, checkEnvironment().fingerprint);
});

test('executable tool configuration written by one check never reaches the next check or another project', t => {
  const directory = sandbox(t);
  const first = prepared(directory, 'r1', 'project-one');
  // A hostile check plants tool configuration and ordinary cache content.
  mkdirSync(join(first.GRADLE_USER_HOME, 'init.d'), { recursive: true });
  writeFileSync(join(first.GRADLE_USER_HOME, 'init.d', 'x.gradle'), 'println "planted"');
  writeFileSync(join(first.GRADLE_USER_HOME, 'gradle.properties'), 'org.gradle.jvmargs=-javaagent:x.jar');
  writeFileSync(join(first.CARGO_HOME, 'config.toml'), '[build]\nrustc-wrapper = "x"');
  mkdirSync(join(first.GRADLE_USER_HOME, 'caches', 'modules-2'), { recursive: true });
  writeFileSync(join(first.GRADLE_USER_HOME, 'caches', 'modules-2', 'dep.jar'), 'jar');
  mkdirSync(join(first.CARGO_HOME, 'registry'), { recursive: true });
  writeFileSync(join(first.CARGO_HOME, 'registry', 'crate'), 'crate');

  const same = prepared(directory, 'r2', 'project-one');
  for (const planted of [
    join(same.GRADLE_USER_HOME, 'init.d'),
    join(same.GRADLE_USER_HOME, 'gradle.properties'),
    join(same.CARGO_HOME, 'config.toml'),
  ])
    assert.equal(existsSync(planted), false, `${planted} did not persist`);
  // The dependency content itself stays warm within the project.
  assert.equal(readFileSync(join(same.GRADLE_USER_HOME, 'caches', 'modules-2', 'dep.jar'), 'utf8'), 'jar');
  assert.equal(readFileSync(join(same.CARGO_HOME, 'registry', 'crate'), 'utf8'), 'crate');
  assert.ok(lstatSync(join(same.CARGO_HOME, 'registry')).isSymbolicLink());

  const other = prepared(directory, 'r3', 'project-two');
  assert.equal(existsSync(join(other.GRADLE_USER_HOME, 'caches', 'modules-2', 'dep.jar')), false);
  assert.equal(existsSync(join(other.CARGO_HOME, 'registry', 'crate')), false);
  // Neither tool home is a shared directory: both sit inside the run.
  assert.ok(first.CARGO_HOME.startsWith(join(directory, 'r1') + '/'));
  assert.ok(first.GRADLE_USER_HOME.startsWith(join(directory, 'r1') + '/'));
});
