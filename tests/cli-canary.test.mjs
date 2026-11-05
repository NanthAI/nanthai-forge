// SPDX-License-Identifier: Apache-2.0
// CLI canary (ac9c4ed4): the updater smoke-tests the NEW build before switching to it. Every
// installation root, HOME and XDG directory here is a temp directory; nothing touches the real
// forge-cli installation, the real hook files or any hosted state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childEnv } from '../scripts/child-env.mjs';
import { updateCli } from '../dist/cli-update.js';
import { cliBuildCommit, selectCliBuild } from '../dist/cli-installation.js';
import { migrateEditHookRunner } from '../dist/agent-install-hooks.js';
import { cliRollback } from '../dist/cli-rollback.js';
import {
  activeCliCanaryRefusal,
  cliCanaryBackoffMs,
  cliCanaryPreSwitch,
  readCliCanaryRefusal,
  rememberCanaryClone,
} from '../dist/cli-canary.js';

const a = 'a'.repeat(64),
  b = 'b'.repeat(64),
  c = 'c'.repeat(64);
const address = { url: 'https://synthetic.convex.cloud', projectId: 'forge-source' };
const OPERATION = '11111111-1111-4111-8111-111111111111';
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');

/** An entry that behaves like a CLI build: `mode` (a file in the build) says how it fails. */
const fakeEntry = `
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const build = new URL('..', import.meta.url).pathname.replace(/\\/$/, '');
const installation = join(build, '..', '..');
const head = readFileSync(join(build, '.commit'), 'utf8').trim();
const args = process.argv.slice(2);
const step = args[0] === '--version' ? 'version' : args[0] === 'status' ? 'status'
  : args[2] === 'wait' ? 'wait' : args[2] === 'planning' ? (JSON.parse(args[3]).id ? 'planning-item' : 'planning') : 'other';
appendFileSync(join(installation, 'canary-calls.log'), step + '\\n');
writeFileSync(join(installation, 'canary-env.json'), JSON.stringify({ home: process.env.HOME, xdg: process.env.XDG_CONFIG_HOME, canary: process.env.FORGE_CLI_CANARY }));
// A build that tried to write the user's hook files would hit this private HOME instead.
mkdirSync(join(process.env.HOME, '.claude'), { recursive: true });
writeFileSync(join(process.env.HOME, '.claude', 'settings.json'), '{"tripwire":true}');
const [kind, target] = readFileSync(join(build, 'mode'), 'utf8').trim().split(':');
if (target === step) {
  if (kind === 'exit') process.exit(3);
  if (kind === 'notfound') { process.stderr.write('{"error":{"code":"NOT_FOUND"}}\\n'); process.exit(1); }
  if (kind === 'badjson') { process.stdout.write('{not json\\n'); process.exit(0); }
  if (kind === 'hang') { writeFileSync(join(installation, 'hang.pid'), String(process.pid)); setInterval(() => {}, 1000); await new Promise(() => {}); }
}
const out = value => process.stdout.write(JSON.stringify(value) + '\\n');
if (step === 'version') process.stdout.write('nforge version fake\\n');
else if (step === 'status') out({ clone: { status: 'current' }, hooks: { status: 'ok' } });
else if (step === 'planning') out({ schema: 1, cliCommit: head, result: { items: [{ id: 'item-1' }] } });
else if (step === 'planning-item') out({ schema: 1, cliCommit: head, result: { item: { operationId: ${JSON.stringify(OPERATION)} } } });
else if (step === 'wait') { process.stdout.write('PUT-PLANNING-ITEM x finished\\n'); out({ schema: 1, cliCommit: head, result: {} }); }
`;

function fixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'forge-test-cli-canary-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const settings = join(directory, 'client.json');
  writeFileSync(settings, JSON.stringify({ localHeavySlots: 0 }));
  const previousSettings = process.env.FORGE_CLIENT_SETTINGS;
  process.env.FORGE_CLIENT_SETTINGS = settings;
  t.after(() => {
    if (previousSettings === undefined) delete process.env.FORGE_CLIENT_SETTINGS;
    else process.env.FORGE_CLIENT_SETTINGS = previousSettings;
  });
  // The updater process reads credentials/config from XDG_CONFIG_HOME; keep it temp too.
  const previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(directory, 'home', '.config');
  t.after(() => {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
  });
  const installation = join(directory, 'forge-cli'),
    home = join(directory, 'home'),
    clone = join(directory, 'clone');
  mkdirSync(join(clone, '.forge'), { recursive: true });
  writeFileSync(join(clone, '.forge', 'hosted-main.json'), '{}');
  const build = (head, mode = 'ok') => {
    const path = join(installation, 'builds', head);
    mkdirSync(join(path, 'dist'), { recursive: true });
    writeFileSync(join(path, '.commit'), head);
    writeFileSync(join(path, '.managed-cli'), '1');
    writeFileSync(join(path, 'mode'), mode);
    writeFileSync(join(path, 'package.json'), JSON.stringify({ name: '@nanthai/forge', type: 'module' }));
    writeFileSync(join(path, 'dist', 'cli-version.js'), '// synthetic controller capability');
    copyFileSync(new URL('../dist/cli-launcher.js', import.meta.url), join(path, 'dist', 'cli-launcher.js'));
    writeFileSync(join(path, 'dist', 'cli-entry.js'), fakeEntry);
    writeFileSync(join(path, 'dist', 'agent-edit-hook.js'), '// complete');
    return path;
  };
  const old = build(a);
  selectCliBuild(installation, old);
  const hooks = [join(home, '.claude', 'settings.json'), join(home, '.codex', 'hooks.json')];
  for (const file of hooks) {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              hooks: [
                {
                  type: 'command',
                  command: `'node' '${old}/dist/agent-edit-hook.js' '--auto' '--forge-first-write'`,
                },
              ],
            },
          ],
        },
      }),
    );
  }
  rememberCanaryClone(installation, clone);
  return { directory, installation, home, clone, old, build, hooks };
}
const dependencies = (f, head, canary) => ({
  source: { current: async () => ({ head, projectId: address.projectId }) },
  migrate: runner => migrateEditHookRunner(runner, f.home),
  preSwitch: canary,
});
const run = (f, head, canary) => updateCli(f.installation, address, undefined, dependencies(f, head, canary));
const calls = f =>
  existsSync(join(f.installation, 'canary-calls.log'))
    ? readFileSync(join(f.installation, 'canary-calls.log'), 'utf8').trim().split('\n').filter(Boolean)
    : [];
const current = f => cliBuildCommit(join(f.installation, 'current'));
const oldStillWorks = f => {
  const reply = spawnSync(
    process.execPath,
    [join(f.installation, 'current', 'dist', 'cli-entry.js'), '--version'],
    {
      env: childEnv({ extra: { HOME: join(f.directory, 'scratch-home') } }),
      encoding: 'utf8',
    },
  );
  mkdirSync(join(f.directory, 'scratch-home'), { recursive: true });
  return reply;
};

test('a broken new build (exits non-zero, hangs, prints bad JSON) is refused; the old build keeps working', async t => {
  const cases = [
    ['exit', 'exit:planning', /planning exited 3/],
    ['hang', 'hang:wait', /wait timed out/],
    ['badjson', 'badjson:status', /status printed bad JSON/],
    ['no version', 'exit:version', /version exited 3/],
  ];
  for (const [name, mode, reason] of cases) {
    const f = fixture(t);
    const bad = f.build(b, mode);
    mkdirSync(join(f.directory, 'scratch-home'), { recursive: true });
    const alerts = [],
      lines = [],
      before = f.hooks.map(hash);
    const canary = cliCanaryPreSwitch(f.installation, {
      timeoutMs: 2_500,
      home: f.home,
      alert: async record => alerts.push(record),
      log: line => lines.push(line),
    });
    const started = Date.now();
    await assert.rejects(run(f, b, canary), { code: 'CLI_CANARY_FAILED' }, name);
    assert.ok(Date.now() - started < 8_000, `${name}: hard limit bounds the canary`);
    // Refused: the previous build stays selected and works; the new one stays installed, inactive.
    assert.equal(current(f), a, name);
    assert.ok(existsSync(join(bad, '.managed-cli')), name);
    assert.equal(existsSync(join(f.installation, 'previous')), false, `${name}: nothing switched`);
    assert.equal(oldStillWorks(f).status, 0, name);
    // Why is recorded, with a back-off; one alert, one log line, never a loop.
    const record = readCliCanaryRefusal(f.installation);
    assert.equal(record.head, b);
    assert.match(record.reason, reason, name);
    assert.equal(record.attempts, 1);
    assert.equal(alerts.length, 1, name);
    assert.match(lines.join('\n'), /canary refused bbbbbbbb: .*previous build stays selected/);
    assert.equal(activeCliCanaryRefusal(f.installation, b)?.head, b);
    assert.equal(activeCliCanaryRefusal(f.installation, c), null, 'a new main is tried at once');
    assert.equal(
      activeCliCanaryRefusal(f.installation, b, record.nextRetryAt + 1),
      null,
      'the same build is tried again only after the back-off',
    );
    // A retry after the back-off refuses again, doubles the back-off and does not alert again.
    await assert.rejects(run(f, b, canary), { code: 'CLI_CANARY_FAILED' }, name);
    const second = readCliCanaryRefusal(f.installation);
    assert.equal(second.attempts, 2);
    assert.equal(alerts.length, 1, `${name}: alerted once per head`);
    assert.ok(second.nextRetryAt - Date.parse(second.at) >= cliCanaryBackoffMs(2) - 1_000);
    assert.ok(cliCanaryBackoffMs(2) === 2 * cliCanaryBackoffMs(1));
    if (mode.startsWith('hang')) {
      const pid = Number(readFileSync(join(f.installation, 'hang.pid'), 'utf8'));
      await until(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      }, 'the hung child to be killed');
    }
    // The canary ran on a private HOME: the user's hook files were unreachable and are unchanged.
    const env = JSON.parse(readFileSync(join(f.installation, 'canary-env.json'), 'utf8'));
    assert.notEqual(env.home, f.home);
    assert.ok(env.home.startsWith(realpathSync(tmpdir())) || env.home.startsWith(tmpdir()));
    assert.equal(existsSync(env.home), false, 'private home removed');
    assert.equal(env.xdg, join(f.home, '.config'), 'credentials stay reachable through XDG');
    assert.equal(env.canary, b);
    assert.deepEqual(f.hooks.map(hash), before, `${name}: hook files untouched`);
    assert.equal(existsSync(join(f.home, '.claude', 'tripwire')), false);
  }
});

test('a good build passes every step once, switches, keeps one previous build and clears refusals', async t => {
  const f = fixture(t);
  f.build(b);
  const lines = [];
  const canary = cliCanaryPreSwitch(f.installation, {
    home: f.home,
    log: line => lines.push(line),
    alert: async () => {},
  });
  const result = await run(f, b, canary);
  assert.equal(result.status, 'updated');
  assert.equal(current(f), b);
  assert.deepEqual(calls(f), ['version', 'status', 'planning', 'planning-item', 'wait']);
  assert.match(
    lines.join('\n'),
    /Forge CLI canary passed for bbbbbbbb in [\d.]+s: version \d+ms, status \d+ms, planning \d+ms, planning-item \d+ms, wait \d+ms\./,
  );
  // Exactly one previous build is kept, outside the pruning grace.
  assert.equal(realpathSync(join(f.installation, 'previous')), f.old);
  assert.equal(readCliCanaryRefusal(f.installation), null);
  // The vetted operation is remembered: the next canary reads one item less.
  const record = JSON.parse(readFileSync(join(f.installation, 'canary-clone.json'), 'utf8'));
  assert.equal(record.operationId, OPERATION);
  writeFileSync(join(f.installation, 'canary-calls.log'), '');
  f.build(c);
  await run(f, c, canary);
  assert.deepEqual(calls(f), ['version', 'status', 'planning', 'wait']);
  assert.equal(realpathSync(join(f.installation, 'previous')), join(f.installation, 'builds', b));
  assert.equal(current(f), c);
  assert.equal(readCliCanaryRefusal(f.installation), null);
});

test('with no Forge clone recorded the canary still runs the version step and says what it skipped', async t => {
  const f = fixture(t);
  rmSync(join(f.installation, 'canary-clone.json'));
  f.build(b);
  const lines = [];
  await run(f, b, cliCanaryPreSwitch(f.installation, { home: f.home, log: line => lines.push(line) }));
  assert.deepEqual(calls(f), ['version']);
  assert.match(lines.join('\n'), /skipped: no Forge clone recorded/);
  assert.equal(current(f), b);
});

test('a wait that fails refuses the build; an operation the project no longer knows does not', async t => {
  const f = fixture(t);
  const stored = () => JSON.parse(readFileSync(join(f.installation, 'canary-clone.json'), 'utf8'));
  writeFileSync(
    join(f.installation, 'canary-clone.json'),
    JSON.stringify({ root: f.clone, operationId: OPERATION }),
  );
  f.build(b, 'exit:wait');
  const quiet = { home: f.home, log: () => {}, alert: async () => {} };
  await assert.rejects(run(f, b, cliCanaryPreSwitch(f.installation, quiet)), { code: 'CLI_CANARY_FAILED' });
  assert.equal(current(f), a);
  assert.equal(stored().operationId, OPERATION, 'a refusal keeps the vetted operation');
  // NOT_FOUND on the stored and the derived operation: skipped, and the stored one is dropped.
  writeFileSync(join(f.build(b, 'notfound:wait'), 'mode'), 'notfound:wait');
  const lines = [];
  await run(f, b, cliCanaryPreSwitch(f.installation, { ...quiet, log: line => lines.push(line) }));
  assert.equal(current(f), b);
  assert.match(lines.join('\n'), /skipped: no finished operation known to the project/);
  assert.equal(stored().operationId, undefined);
});

test('the alert text names the step and exit class only, never output, paths or tokens', async t => {
  const f = fixture(t);
  f.build(b, 'exit:status');
  const sent = [];
  const { alertCliCanary } = await import('../dist/cli-canary.js');
  const canary = cliCanaryPreSwitch(f.installation, {
    home: f.home,
    log: () => {},
    alert: record =>
      alertCliCanary(record, {
        env: { FORGE_ALERT_WEBHOOK_URL: 'https://ntfy.invalid/synthetic-topic' },
        send: async (url, init) => {
          sent.push({ url, body: String(init.body), title: init.headers.title });
          return { status: 200 };
        },
      }),
  });
  await assert.rejects(run(f, b, canary), { code: 'CLI_CANARY_FAILED' });
  assert.equal(sent.length, 1);
  assert.match(sent[0].title, /CLI canary refused build bbbbbbbb/);
  assert.match(sent[0].body, /canary step status exited 3/);
  assert.doesNotMatch(sent[0].body, new RegExp(f.directory));
  assert.equal(readCliCanaryRefusal(f.installation).alerted, true);
});

// --- Calls while a canary runs, and rollback, through the real launcher ---------------------------

function launcherEnv(f) {
  return childEnv({
    allow: ['FORGE_CLIENT_SETTINGS'],
    extra: {
      HOME: f.home,
      USERPROFILE: f.home,
      XDG_CONFIG_HOME: join(f.home, '.config'),
      FORGE_TEST_MODE: '1',
      FORGE_AUTH_TOKEN: 'synthetic-launcher-token',
    },
  });
}
function launch(f, args) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [join(f.installation, 'launcher.mjs'), ...args], {
      env: launcherEnv(f),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.once('error', reject);
    child.once('exit', status => done({ status, stdout, stderr }));
  });
}
async function releaseFixture(t, f, head) {
  const counter = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(new URL('../scripts/package-cli-release-worker.mjs', import.meta.url), {
    workerData: { head, projectId: address.projectId, calls: counter.buffer },
  });
  t.after(() => worker.terminate());
  const url = await new Promise((done, reject) => {
    worker.once('message', done);
    worker.once('error', reject);
  });
  writeFileSync(join(f.installation, 'source.json'), JSON.stringify({ url, projectId: address.projectId }));
  const previous = process.env.FORGE_AUTH_TOKEN;
  process.env.FORGE_AUTH_TOKEN = 'synthetic-cli-test-token';
  t.after(() => {
    if (previous === undefined) delete process.env.FORGE_AUTH_TOKEN;
    else process.env.FORGE_AUTH_TOKEN = previous;
  });
  return counter;
}
/** A real controller entry: it runs the product's cliStartup, so it exercises the product's own
 * gate. Under the canary env it behaves like a build under test (`gate` file, then `canary-mode`). */
function controller(f, root, name) {
  const startup = pathToFileURL(fileURLToPath(new URL('../dist/cli-version.js', import.meta.url))).href;
  writeFileSync(
    join(root, 'dist', 'cli-entry.js'),
    `import { existsSync, appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const installation = ${JSON.stringify(f.installation)};
if (process.env.FORGE_CLI_CANARY) {
  appendFileSync(join(installation, 'canary-runs.log'), 'run\\n');
  while (!existsSync(join(installation, 'canary-gate'))) await new Promise(done => setTimeout(done, 20));
  if (readFileSync(join(installation, 'canary-gate'), 'utf8') === 'fail') process.exit(5);
  process.stdout.write('nforge version fake\\n');
  process.exit(0);
}
import(${JSON.stringify(startup)}).then(async ({ cliStartup }) => {
  if (await cliStartup(process.argv.slice(2), ${JSON.stringify(root)}, undefined, { validated: true }))
    process.stdout.write(JSON.stringify({ build: ${JSON.stringify(name)}, ran: process.argv.slice(2) }) + '\\n');
});
`,
  );
}
function installLauncher(f, manager) {
  // These controllers only print a version, so the canary runs just that step.
  rmSync(join(f.installation, 'canary-clone.json'), { force: true });
  selectCliBuild(f.installation, manager, 'manager');
  copyFileSync(new URL('../dist/cli-launcher.js', import.meta.url), join(f.installation, 'launcher.mjs'));
}
const refusals =
  /CLI_UPDATE_REQUIRED|CLI_UPDATE_SOURCE_REQUIRED|CLI_UPDATE_BUSY|CLI_RUNTIME_BUSY|CLI_RUNTIME_RETIRED|CLI_CANARY_FAILED/;
async function until(condition, what, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise(done => setTimeout(done, 25));
  }
}

for (const outcome of ['fail', 'pass']) {
  test(`12 concurrent calls while the canary runs are never refused (canary ${outcome}s)`, async t => {
    const f = fixture(t),
      counter = await releaseFixture(t, f, b),
      main = f.build(b);
    controller(f, f.old, 'old');
    controller(f, main, 'main');
    installLauncher(f, f.old);
    const d = f.directory;
    const reads = [
      ['agent', d, 'status'],
      ['agent', d, 'planning', '{}'],
      ['agent', d, 'wait', '{}'],
      ['agent', d, 'peers'],
      ['status'],
      ['wait', 'synthetic'],
    ];
    const writes = [
      ['agent', d, 'save'],
      ['agent', d, 'land'],
      ['agent', d, 'start'],
      ['agent', d, 'put-planning-item'],
      ['agent', d, 'comment-planning-item'],
      ['land', d],
    ];
    // Writes start first: one runs the foreground updater, which stops in the canary on the gate;
    // the others wait for that updater instead of being refused.
    const writeReplies = writes.map(args => launch(f, args));
    await until(() => existsSync(join(f.installation, 'canary-runs.log')), 'the canary to start');
    const readReplies = await Promise.all(reads.map(args => launch(f, args)));
    for (const [index, reply] of readReplies.entries()) {
      assert.equal(reply.status, 0, reply.stderr);
      assert.deepEqual(JSON.parse(reply.stdout), { build: 'old', ran: reads[index] });
      assert.doesNotMatch(reply.stderr, refusals);
    }
    assert.equal(current(f), a, 'reads ran on the current build during the canary');
    writeFileSync(join(f.installation, 'canary-gate'), outcome === 'fail' ? 'fail' : 'pass');
    const replies = await Promise.all(writeReplies);
    for (const [index, reply] of replies.entries()) {
      assert.equal(reply.status, 0, reply.stderr);
      assert.equal(reply.stdout.trim().split('\n').length, 1);
      assert.deepEqual(JSON.parse(reply.stdout), {
        build: outcome === 'fail' ? 'old' : 'main',
        ran: writes[index],
      });
      assert.doesNotMatch(reply.stderr, refusals);
    }
    const log = readFileSync(join(f.installation, 'canary-runs.log'), 'utf8').trim().split('\n');
    assert.equal(log.length, 1, 'one canary run; a waiter never repeats it');
    assert.equal(current(f), outcome === 'fail' ? a : b);
    if (outcome === 'fail') {
      const record = readCliCanaryRefusal(f.installation);
      assert.equal(record.head, b);
      assert.equal(record.attempts, 1);
      // The next call (a read or a write) still runs on the working build, with one notice line.
      const next = await launch(f, ['agent', d, 'save']);
      assert.equal(next.status, 0, next.stderr);
      assert.deepEqual(JSON.parse(next.stdout), { build: 'old', ran: ['agent', d, 'save'] });
      assert.match(next.stderr, /refused by its pre-switch canary/);
      assert.equal(
        readFileSync(join(f.installation, 'canary-runs.log'), 'utf8').trim().split('\n').length,
        1,
      );
    }
    assert.ok(Atomics.load(counter, 0) >= 1);
  });
}

test('the canary child makes no release read and starts no update', async t => {
  const f = fixture(t),
    counter = await releaseFixture(t, f, c),
    build = f.build(b);
  const startup = pathToFileURL(fileURLToPath(new URL('../dist/cli-version.js', import.meta.url))).href;
  writeFileSync(
    join(build, 'dist', 'cli-entry.js'),
    `import { cliStartup } from ${JSON.stringify(startup)};
if (await cliStartup(process.argv.slice(2), ${JSON.stringify(build)})) process.stdout.write('ran\\n');`,
  );
  const base = { env: { ...launcherEnv(f), FORGE_CLI_CANARY: b }, encoding: 'utf8' };
  const reply = spawnSync(
    process.execPath,
    [join(build, 'dist', 'cli-entry.js'), 'agent', f.directory, 'status'],
    base,
  );
  assert.equal(reply.status, 0, reply.stderr);
  assert.equal(reply.stdout, 'ran\n');
  assert.equal(Atomics.load(counter, 0), 0, 'zero release reads for the build under test');
  assert.equal(current(f), a);
});

test('rollback switches atomically to the one previous build and holds main until it moves', async t => {
  const f = fixture(t),
    counter = await releaseFixture(t, f, b),
    main = f.build(b);
  controller(f, f.old, 'old');
  controller(f, main, 'main');
  installLauncher(f, f.old);
  writeFileSync(join(f.installation, 'canary-gate'), 'pass');
  const migrated = [];
  // Nothing retained yet.
  await assert.rejects(cliRollback(f.installation, { migrate: () => {}, lockWaitMs: 0 }), {
    code: 'CLI_ROLLBACK_UNAVAILABLE',
  });
  // A normal call updates through a passing canary: main is current, the old build is previous.
  const first = await launch(f, ['agent', f.directory, 'save']);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout), { build: 'main', ran: ['agent', f.directory, 'save'] });
  assert.equal(current(f), b);
  assert.equal(realpathSync(join(f.installation, 'previous')), f.old);
  const reads = Atomics.load(counter, 0);
  const result = await cliRollback(f.installation, {
    migrate: runner => {
      migrated.push(runner);
      migrateEditHookRunner(runner, f.home);
    },
  });
  assert.equal(result.status, 'rolled-back');
  assert.equal(result.cliCommit, a);
  assert.equal(result.from, b);
  assert.equal(current(f), a);
  assert.equal(realpathSync(join(f.installation, 'manager')), f.old);
  assert.equal(realpathSync(join(f.installation, 'previous')), main, 'the build left becomes the previous');
  assert.deepEqual(migrated, [join(f.installation, 'current', 'dist', 'agent-edit-hook.js')]);
  assert.equal(existsSync(join(f.installation, 'update-lock', '1')), false, 'update lock released');
  // The next calls (read and write) run on the rolled-back build and do not install main again.
  for (const args of [
    ['agent', f.directory, 'status'],
    ['agent', f.directory, 'save'],
  ]) {
    const reply = await launch(f, args);
    assert.equal(reply.status, 0, reply.stderr);
    assert.deepEqual(JSON.parse(reply.stdout), { build: 'old', ran: args });
    assert.match(reply.stderr, /was rolled back .*held until main moves/);
    assert.doesNotMatch(reply.stderr, refusals);
  }
  assert.equal(current(f), a);
  assert.equal(Atomics.load(counter, 0), reads + 2, 'one release read per call; no install');
  // Through the CLI command, with an explicit directory: switches back and clears the hold.
  const back = await launch(f, ['cli', 'rollback', '--directory', f.installation]);
  assert.equal(back.status, 0, back.stderr);
  assert.equal(JSON.parse(back.stdout).cliCommit, b);
  assert.equal(current(f), b);
  assert.equal(readCliCanaryRefusal(f.installation), null);
  assert.equal(existsSync(f.hooks[0]), true);
  for (const file of f.hooks) JSON.parse(readFileSync(file, 'utf8'));
});

test('rollback needs no network and refuses under a measurement hold', async t => {
  const f = fixture(t);
  f.build(b);
  await run(f, b, cliCanaryPreSwitch(f.installation, { home: f.home, log: () => {} }));
  writeFileSync(join(f.installation, '.freeze'), '');
  await assert.rejects(cliRollback(f.installation, { migrate: () => {} }), { code: 'CLI_UPDATE_FROZEN' });
  rmSync(join(f.installation, '.freeze'));
  const result = await cliRollback(f.installation, { migrate: () => {} });
  assert.equal(result.cliCommit, a);
});
