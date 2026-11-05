// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installEditHooks } from '../dist/agent-install-hooks.js';
import { hookHealth, hookHealthText } from '../dist/agent-hook-health.js';
import { selectCliBuild } from '../dist/cli-installation.js';
import { readHostedCliStatus } from '../dist/hosted-cli-status.js';

const HELP_ARGS = ['agent', '/unused/help-only', 'view', '--help'];
const ALIAS = 'Deprecated: view is an alias for candidate; use candidate.\n';
const FILES = ['.claude/settings.json', '.codex/hooks.json'];
const DEV_RUNNER = fileURLToPath(new URL('../dist/agent-edit-hook.js', import.meta.url));
const q = value => `'${value}'`;
const edit = runner => `${q(process.execPath)} ${q(runner)} '--auto' '--forge-first-write'`;
const stop = runner =>
  `${q(process.execPath)} ${q(runner.replace('agent-edit-hook', 'agent-stop-hook'))} '--forge-turn-end'`;

/** Temp HOME plus a synthetic installation (builds/<hash>, current symlink) and a second install. */
function fixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'forge-hook-guard-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = join(directory, 'home');
  for (const name of ['.claude', '.codex']) mkdirSync(join(home, name), { recursive: true });
  const build = (installation, hash) => {
    const path = join(installation, 'builds', hash);
    mkdirSync(join(path, 'dist'), { recursive: true });
    writeFileSync(join(path, '.commit'), hash);
    writeFileSync(join(path, '.managed-cli'), '1');
    for (const name of ['agent-edit-hook.js', 'agent-stop-hook.js'])
      writeFileSync(join(path, 'dist', name), '// synthetic');
    selectCliBuild(installation, path);
    return join(installation, 'current', 'dist', 'agent-edit-hook.js');
  };
  const installed = build(join(directory, 'forge-cli'), 'a'.repeat(12));
  const other = build(join(directory, 'other-cli'), 'b'.repeat(12));
  const write = runner => {
    for (const file of FILES)
      writeFileSync(
        join(home, file),
        JSON.stringify({
          theme: 'synthetic',
          hooks: {
            PreToolUse: [
              { matcher: '^(Edit|Write)$', hooks: [{ type: 'command', command: edit(runner), timeout: 2 }] },
            ],
            Stop: [{ hooks: [{ type: 'command', command: stop(runner), timeout: 5 }] }],
          },
        }),
      );
  };
  const read = () => FILES.map(file => readFileSync(join(home, file), 'utf8'));
  return { directory, home, installed, other, write, read };
}

test('a dev build never writes its own path: automatic and explicit runs leave both files byte-identical', t => {
  const f = fixture(t);
  f.write(f.installed);
  const before = f.read();
  const automatic = installEditHooks(f.directory, undefined, false, f.home, true);
  const explicit = installEditHooks(f.directory, undefined, false, f.home);
  assert.equal(automatic.status, 'dev-build');
  assert.equal(explicit.status, 'dev-build');
  assert.deepEqual(explicit.changed, []);
  assert.match(explicit.warning, /not the installed Forge CLI/);
  assert.deepEqual(f.read(), before);
  assert.ok(!f.read().join().includes(DEV_RUNNER));
});

test('a dev build with no hooks yet writes nothing and reports the repair command', t => {
  const f = fixture(t);
  const result = installEditHooks(f.directory, undefined, false, f.home, true);
  assert.equal(result.status, 'dev-build');
  assert.match(result.warning, /install-hooks/);
  for (const file of FILES) assert.throws(() => readFileSync(join(f.home, file)), /ENOENT/);
});

test('a real dev-build CLI process with a temporary HOME leaves existing hooks byte-identical', t => {
  const f = fixture(t);
  f.write(f.installed);
  const before = f.read();
  const cli = fileURLToPath(new URL('../dist/cli-entry.js', import.meta.url));
  const run = spawnSync(process.execPath, [cli, ...HELP_ARGS], {
    env: {
      PATH: process.env.PATH,
      HOME: f.home,
      XDG_CONFIG_HOME: join(f.home, '.config'),
      FORGE_TEST_MODE: '1',
    },
    encoding: 'utf8',
  });
  assert.notEqual(run.signal, 'SIGKILL');
  assert.equal(run.stderr, ALIAS, 'healthy hooks: a dev build stays silent');
  assert.deepEqual(f.read(), before);
  assert.ok(!f.read().join().includes(DEV_RUNNER));

  // A broken (missing-target) hook is reported on stderr, still never rewritten.
  f.write(join(f.directory, 'gone-lane', 'dist', 'agent-edit-hook.js'));
  const broken = f.read();
  const second = spawnSync(process.execPath, [cli, ...HELP_ARGS], {
    env: {
      PATH: process.env.PATH,
      HOME: f.home,
      XDG_CONFIG_HOME: join(f.home, '.config'),
      FORGE_TEST_MODE: '1',
    },
    encoding: 'utf8',
  });
  assert.match(second.stderr, /not the installed Forge CLI.*missing-target.*install-hooks/s);
  assert.deepEqual(f.read(), broken);
});

test('a dev build with no hooks at all is silent and writes nothing', t => {
  const f = fixture(t);
  const cli = fileURLToPath(new URL('../dist/cli-entry.js', import.meta.url));
  const run = spawnSync(process.execPath, [cli, ...HELP_ARGS], {
    env: {
      PATH: process.env.PATH,
      HOME: f.home,
      XDG_CONFIG_HOME: join(f.home, '.config'),
      FORGE_TEST_MODE: '1',
    },
    encoding: 'utf8',
  });
  assert.equal(run.stderr, ALIAS);
  for (const file of FILES) assert.equal(existsSync(join(f.home, file)), false);
});

test('an explicit install from the installed CLI still works and is idempotent', t => {
  const f = fixture(t);
  f.write(f.other);
  const first = installEditHooks(f.directory, undefined, false, f.home, false, { runner: f.installed });
  assert.equal(first.status, 'installed');
  assert.equal(first.changed.length, 2);
  for (const content of f.read()) {
    assert.ok(content.includes(f.installed));
    assert.ok(!content.includes(f.other), 'explicit install takes over another valid install');
    assert.ok(content.includes('agent-stop-hook.js'));
  }
  const again = installEditHooks(f.directory, undefined, false, f.home, false, { runner: f.installed });
  assert.deepEqual(again.changed, []);
});

test('an automatic installed-CLI run leaves hooks that point at another valid install alone', t => {
  const f = fixture(t);
  f.write(f.other);
  const before = f.read();
  const result = installEditHooks(f.directory, undefined, false, f.home, true, { runner: f.installed });
  assert.deepEqual(result.changed, []);
  assert.deepEqual(f.read(), before);
});

test('an automatic installed-CLI run repairs a missing hook target and fresh homes', t => {
  const f = fixture(t);
  f.write(join(f.directory, 'deleted-lane', 'dist', 'agent-edit-hook.js'));
  const result = installEditHooks(f.directory, undefined, false, f.home, true, { runner: f.installed });
  assert.equal(result.changed.length, 2);
  for (const content of f.read()) assert.ok(content.includes(f.installed));
  const fresh = join(f.directory, 'fresh');
  mkdirSync(fresh);
  const added = installEditHooks(f.directory, undefined, false, fresh, true, { runner: f.installed });
  assert.equal(added.changed.length, 2);
});

test('uninstall still works from a dev build', t => {
  const f = fixture(t);
  f.write(f.installed);
  const result = installEditHooks(f.directory, undefined, true, f.home);
  assert.equal(result.status, 'uninstalled');
  for (const content of f.read()) assert.ok(!content.includes('agent-edit-hook'));
});

test('health reports a missing target, a Lane or dev path, unreadable and absent hooks with one repair command', t => {
  const f = fixture(t);
  f.write(f.installed);
  assert.deepEqual(hookHealth(f.directory, f.home), { status: 'ok', problems: [], repair: null });
  assert.equal(hookHealthText(hookHealth(f.directory, f.home)), null);

  f.write(join(f.directory, 'gone-lane', 'dist', 'agent-edit-hook.js'));
  let health = hookHealth(f.directory, f.home);
  assert.equal(health.status, 'attention');
  assert.deepEqual([...new Set(health.problems.map(p => p.reason))], ['missing-target']);
  assert.match(health.repair, /^nforge x '.*' install-hooks '\{\}'$/);
  assert.match(hookHealthText(health), /Repair, with the installed nforge: nforge x/);

  f.write(DEV_RUNNER);
  health = hookHealth(f.directory, f.home);
  assert.deepEqual([...new Set(health.problems.map(p => p.reason))], ['not-installed-cli']);

  writeFileSync(join(f.home, FILES[0]), '{broken');
  rmSync(join(f.home, FILES[1]));
  health = hookHealth(f.directory, f.home);
  assert.deepEqual(
    health.problems.map(p => p.reason),
    ['unreadable', 'missing-hook'],
  );
});

test('opted-out hooks are not reported as broken', t => {
  const f = fixture(t);
  installEditHooks(f.directory, undefined, true, f.home, false, { runner: f.installed });
  assert.equal(hookHealth(f.directory, f.home).status, 'disabled');
});

test('hosted status carries hook health in value and text', async t => {
  const f = fixture(t);
  f.write(join(f.directory, 'gone-lane', 'dist', 'agent-edit-hook.js'));
  const previous = process.env.HOME;
  process.env.HOME = f.home;
  t.after(() => {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  });
  const status = await readHostedCliStatus(f.directory, {
    dispatch: async () => ({
      result: { clone: { status: 'current', sourceRevisionsBehind: 0, next: null } },
    }),
  });
  assert.equal(status.value.hooks.status, 'attention');
  assert.match(status.text, /^Forge clone: current with main\.\nForge agent hooks need repair:/);
});
