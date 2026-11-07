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
  CLI_CANARY_DEPLOY_RETRY_MS,
  CLI_CANARY_DEPLOY_WINDOW_MS,
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
if (step === 'wait') writeFileSync(join(installation, 'canary-wait-args.json'), args[3]);
writeFileSync(join(installation, 'canary-env-' + head.slice(0, 8) + '.json'), JSON.stringify({ home: process.env.HOME, xdg: process.env.XDG_CONFIG_HOME, canary: process.env.FORGE_CLI_CANARY }));
// A build that tried to write the user's hook files would hit this private HOME instead.
mkdirSync(join(process.env.HOME, '.claude'), { recursive: true });
writeFileSync(join(process.env.HOME, '.claude', 'settings.json'), '{"tripwire":true}');
const [kind, target] = readFileSync(join(build, 'mode'), 'utf8').trim().split(':');
if (target === step) {
  if (kind === 'exit') process.exit(3);
  if (kind === 'notfound') { process.stderr.write('{"error":{"code":"NOT_FOUND"}}\\n'); process.exit(1); }
  // The 7a16c630 case: the id belongs to another request on this machine (a planning put).
  if (kind === 'changed') { process.stderr.write('{"error":{"code":"WORK_OPERATION_CHANGED"}}\\n'); process.exit(1); }
  if (kind === 'running') { process.stdout.write('{"schema":1,"result":{"status":"IN_PROGRESS","reason":"budget"}}\\n'); process.exit(3); }
  if (kind === 'fail') { process.stderr.write('{"error":{"code":"HOSTED_ACTION_FAILED"}}\\n'); process.exit(1); }
  // Version skew: this build and the server it talks to differ (3205f7e6: deploy not live yet).
  if (kind === 'skew') { process.stderr.write('{"error":{"code":"HOSTED_PROTOCOL_INVALID"}}\\n'); process.exit(1); }
  if (kind === 'badjson') { process.stdout.write('{not json\\n'); process.exit(0); }
  if (kind === 'hang') { writeFileSync(join(installation, 'hang.pid'), String(process.pid)); setInterval(() => {}, 1000); await new Promise(() => {}); }
}
// behind:STEP: the server this build talks to lacks a contract feature the build cannot do without.
const behind = kind === 'behind' && target === step ? { serverContract: { missing: ['future-feature'] } } : {};
const out = value => process.stdout.write(JSON.stringify({ ...value, ...behind }) + '\\n');
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
  writeFileSync(
    join(clone, '.forge', 'hosted-main.json'),
    JSON.stringify({ selection: { projectId: address.projectId } }),
  );
  // A landing this machine saw land (written by wait, edcb0fc8): the only waitable source.
  const landed = (ids = [OPERATION]) => {
    mkdirSync(join(home, '.local', 'state', 'forge'), { recursive: true });
    writeFileSync(
      join(home, '.local', 'state', 'forge', 'landed-operations.json'),
      JSON.stringify({ [address.projectId]: ids }),
    );
  };
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
  landed();
  return { directory, installation, home, clone, old, build, hooks, landed };
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
    const env = JSON.parse(readFileSync(join(f.installation, `canary-env-${b.slice(0, 8)}.json`), 'utf8'));
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
  assert.deepEqual(calls(f), ['version', 'status', 'planning', 'wait']);
  assert.match(
    lines.join('\n'),
    /Forge CLI canary passed for bbbbbbbb in [\d.]+s: version \d+ms, status \d+ms, planning \d+ms, wait \d+ms\./,
  );
  // Exactly one previous build is kept, outside the pruning grace.
  assert.equal(realpathSync(join(f.installation, 'previous')), f.old);
  assert.equal(readCliCanaryRefusal(f.installation), null);
  // The vetted landing operation is remembered: the next canary waits on it first.
  const record = JSON.parse(readFileSync(join(f.installation, 'canary-clone.json'), 'utf8'));
  assert.equal(record.operationId, OPERATION);
  assert.equal(record.operationKind, 'landing');
  writeFileSync(join(f.installation, 'canary-calls.log'), '');
  f.build(c);
  await run(f, c, canary);
  assert.deepEqual(calls(f), ['version', 'status', 'planning', 'wait']);
  assert.equal(realpathSync(join(f.installation, 'previous')), join(f.installation, 'builds', b));
  assert.equal(current(f), c);
  assert.equal(readCliCanaryRefusal(f.installation), null);
});

test('a server that lacks a feature the build needs holds the switch with the back-off, no alert, until it advertises it (a83b6fd5)', async t => {
  const f = fixture(t);
  f.build(b, 'behind:planning');
  const alerts = [],
    lines = [];
  // A fixed clock: the refusal record stamps `at` and `nextRetryAt` with separate clock reads, so a
  // real clock that ticks a millisecond between them made the back-off equality flake under CPU load.
  const clockMs = Date.parse('2026-11-06T02:10:00Z');
  const canary = cliCanaryPreSwitch(f.installation, {
    home: f.home,
    now: () => clockMs,
    alert: async record => alerts.push(record),
    log: line => lines.push(line),
  });
  await assert.rejects(run(f, b, canary), { code: 'CLI_CANARY_FAILED' });
  assert.equal(current(f), a, 'the previous build keeps serving');
  const record = readCliCanaryRefusal(f.installation);
  assert.equal(record.step, 'server-capabilities');
  assert.match(record.reason, /server does not yet advertise future-feature that this build needs/);
  assert.equal(record.attempts, 1);
  assert.equal(record.nextRetryAt - Date.parse(record.at), cliCanaryBackoffMs(1));
  assert.equal(alerts.length, 0, 'deploy order is not a broken build');
  assert.match(
    lines.join('\n'),
    /Forge CLI canary held bbbbbbbb: the server does not yet advertise future-feature .*previous build stays selected, next retry after \d\d:\d\d UTC \(attempt 1\)\./,
  );
  assert.equal(activeCliCanaryRefusal(f.installation, b, clockMs)?.step, 'server-capabilities');
  const { cliCanaryNotice } = await import('../dist/cli-canary.js');
  assert.match(cliCanaryNotice(f.installation, record, a), /was held by its pre-switch canary/);
  // Still behind after the back-off: held again, the back-off doubles (bounded by its maximum).
  await assert.rejects(run(f, b, canary), { code: 'CLI_CANARY_FAILED' });
  assert.equal(readCliCanaryRefusal(f.installation).attempts, 2);
  assert.equal(alerts.length, 0);
  // The server's deploy arrives: the next attempt switches and clears the hold.
  writeFileSync(join(f.installation, 'builds', b, 'mode'), 'ok');
  assert.equal((await run(f, b, canary)).status, 'updated');
  assert.equal(current(f), b);
  assert.equal(readCliCanaryRefusal(f.installation), null);
});

test('incident replay 3205f7e6: version skew right after main moves is retried every minute without an alert, then refused', async t => {
  const f = fixture(t);
  f.build(b, 'skew:planning');
  const alerts = [],
    lines = [];
  let clockMs = Date.parse('2026-11-06T02:10:00Z');
  const canary = cliCanaryPreSwitch(f.installation, {
    home: f.home,
    now: () => clockMs,
    alert: async record => alerts.push(record),
    log: line => lines.push(line),
  });
  await assert.rejects(run(f, b, canary), { code: 'CLI_CANARY_FAILED' });
  assert.equal(current(f), a, 'the previous build keeps serving');
  let record = readCliCanaryRefusal(f.installation);
  assert.equal(record.deployPending, true);
  assert.equal(record.deployPendingSince, clockMs);
  assert.equal(record.nextRetryAt - clockMs, CLI_CANARY_DEPLOY_RETRY_MS);
  assert.equal(record.attempts, 0, 'a deploy-window hold is not a refusal attempt');
  assert.equal(alerts.length, 0, 'no phone alert while the deploy may still be running');
  assert.match(
    lines.at(-1),
    /canary held bbbbbbbb: .*probably not live yet.*next retry after 02:11 UTC \(deploy window ends 02:25 UTC\)/,
  );
  const { cliCanaryNotice } = await import('../dist/cli-canary.js');
  assert.match(cliCanaryNotice(f.installation, record, a), /was held by its pre-switch canary/);
  // Five minutes later, still skewed: still a hold, same window start.
  clockMs += 5 * 60_000;
  await assert.rejects(run(f, b, canary), { code: 'CLI_CANARY_FAILED' });
  record = readCliCanaryRefusal(f.installation);
  assert.equal(record.deployPendingSince, Date.parse('2026-11-06T02:10:00Z'));
  assert.equal(alerts.length, 0);
  // Skew that outlasts the window is a real refusal: back-off and one alert.
  clockMs = Date.parse('2026-11-06T02:10:00Z') + CLI_CANARY_DEPLOY_WINDOW_MS;
  await assert.rejects(run(f, b, canary), { code: 'CLI_CANARY_FAILED' });
  record = readCliCanaryRefusal(f.installation);
  assert.equal(record.deployPending, undefined);
  assert.equal(record.attempts, 1);
  assert.equal(record.nextRetryAt - clockMs, cliCanaryBackoffMs(1));
  assert.equal(alerts.length, 1);
  assert.match(lines.at(-1), /canary refused bbbbbbbb/);
});

test('version skew that clears inside the deploy window switches at the next retry and clears the hold', async t => {
  const f = fixture(t);
  f.build(b, 'skew:planning');
  const alerts = [];
  const canary = cliCanaryPreSwitch(f.installation, {
    home: f.home,
    alert: async record => alerts.push(record),
  });
  await assert.rejects(run(f, b, canary), { code: 'CLI_CANARY_FAILED' });
  assert.equal(readCliCanaryRefusal(f.installation).deployPending, true);
  // The server deploy lands: the same build now passes.
  writeFileSync(join(f.installation, 'builds', b, 'mode'), 'ok');
  assert.equal((await run(f, b, canary)).status, 'updated');
  assert.equal(current(f), b);
  assert.equal(readCliCanaryRefusal(f.installation), null);
  assert.equal(alerts.length, 0);
});

test('a non-skew failure the current build passes is still refused at once with an alert', async t => {
  const f = fixture(t);
  f.build(b, 'fail:planning');
  const alerts = [];
  const canary = cliCanaryPreSwitch(f.installation, {
    home: f.home,
    alert: async record => alerts.push(record),
  });
  await assert.rejects(run(f, b, canary), { code: 'CLI_CANARY_FAILED' });
  const record = readCliCanaryRefusal(f.installation);
  assert.equal(record.deployPending, undefined);
  assert.equal(record.attempts, 1);
  assert.equal(alerts.length, 1);
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

test('a wait that fails where the current build passes refuses; an unusable operation is skipped and dropped', async t => {
  const f = fixture(t);
  const stored = () => JSON.parse(readFileSync(join(f.installation, 'canary-clone.json'), 'utf8'));
  f.build(b, 'exit:wait');
  const lines = [];
  const quiet = { home: f.home, log: line => lines.push(line), alert: async () => {} };
  await assert.rejects(run(f, b, cliCanaryPreSwitch(f.installation, quiet)), { code: 'CLI_CANARY_FAILED' });
  assert.equal(current(f), a);
  // Both results are in the log: the new build failed, the current one passed the same step.
  assert.match(
    lines.join('\n'),
    /canary refused bbbbbbbb: canary step wait exited 3; the current build aaaaaaaa passes the same step/,
  );
  assert.deepEqual(calls(f), ['version', 'status', 'planning', 'wait', 'wait']);
  // NOT_FOUND: skipped with a log line, never a refusal, and nothing is remembered.
  writeFileSync(join(f.build(b, 'notfound:wait'), 'mode'), 'notfound:wait');
  lines.length = 0;
  await run(f, b, cliCanaryPreSwitch(f.installation, quiet));
  assert.equal(current(f), b);
  assert.match(lines.join('\n'), /skipped: wait on operation 11111111 skipped: NOT_FOUND/);
  assert.equal(stored().operationId, undefined);
});

// Issue edcb0fc8 replay: the old canary took the newest Issue's operation id (7a16c630, a planning
// put written on this machine); wait on it says WORK_OPERATION_CHANGED on both builds, so every
// build was refused.
test('incident replay 7a16c630: a non-waitable operation never refuses an identical build; a real wait failure still does', async t => {
  const PUT = '7a16c630-0000-4000-8000-000000000000';
  const f = fixture(t);
  writeFileSync(join(f.old, 'mode'), 'changed:wait');
  // The record the old canary left: the planning put's id, no landing kind.
  writeFileSync(
    join(f.installation, 'canary-clone.json'),
    JSON.stringify({ root: f.clone, operationId: PUT }),
  );
  f.landed([]);
  f.build(b, 'changed:wait');
  const lines = [],
    alerts = [];
  const canary = cliCanaryPreSwitch(f.installation, {
    home: f.home,
    log: line => lines.push(line),
    alert: async record => alerts.push(record),
  });
  assert.equal((await run(f, b, canary)).status, 'updated');
  assert.deepEqual(calls(f), ['version', 'status', 'planning'], 'the put id is never waited on');
  assert.match(lines.join('\n'), /skipped: no landed operation recorded on this machine for the wait/);
  assert.equal(
    JSON.parse(readFileSync(join(f.installation, 'canary-clone.json'), 'utf8')).operationId,
    undefined,
  );
  // A landed operation that turns out unusable on this machine is skipped the same way.
  f.landed([PUT, OPERATION]);
  writeFileSync(join(f.installation, 'canary-calls.log'), '');
  lines.length = 0;
  writeFileSync(join(f.build(c, 'changed:wait'), 'mode'), 'changed:wait');
  assert.equal((await run(f, c, canary)).status, 'updated');
  assert.match(
    lines.join('\n'),
    /wait on operation 7a16c630 skipped: WORK_OPERATION_CHANGED.*wait on operation 11111111 skipped: WORK_OPERATION_CHANGED/,
  );
  assert.equal(alerts.length, 0);
  // A build whose wait truly fails, while the current build's wait passes, is still refused.
  writeFileSync(join(f.installation, 'builds', c, 'mode'), 'ok');
  const d = 'd'.repeat(64);
  f.build(d, 'fail:wait');
  f.landed([OPERATION]);
  lines.length = 0;
  await assert.rejects(run(f, d, canary), { code: 'CLI_CANARY_FAILED' });
  assert.equal(current(f), c);
  assert.match(
    lines.join('\n'),
    /canary refused dddddddd: canary step wait exited 1; the current build cccccccc passes the same step/,
  );
});

// e28539cf replay: refused on "canary step wait timed out" while its server deploy finished; the
// build was fine. The wait is now one non-blocking read; running or blocking never refuses alone.
test('incident replay e28539cf: a still-running or blocking wait never refuses; a build that alone blocks still does', async t => {
  const f = fixture(t);
  const lines = [],
    alerts = [];
  const canary = cliCanaryPreSwitch(f.installation, {
    home: f.home,
    timeoutMs: 3_000,
    log: line => lines.push(line),
    alert: async record => alerts.push(record),
  });
  f.build(b, 'running:wait');
  assert.equal((await run(f, b, canary)).status, 'updated');
  assert.deepEqual(JSON.parse(readFileSync(join(f.installation, 'canary-wait-args.json'), 'utf8')), {
    operationIds: [OPERATION],
    timeoutSeconds: 0,
  });
  assert.match(lines.join('\n'), /wait on operation 11111111 skipped: still running/);
  // Both builds block on the wait (the server is mid-deploy): compared, skipped, switched.
  writeFileSync(join(f.installation, 'builds', b, 'mode'), 'hang:wait');
  f.build(c, 'hang:wait');
  lines.length = 0;
  const started = Date.now();
  assert.equal((await run(f, c, canary)).status, 'updated');
  assert.ok(Date.now() - started < 10_000, 'both runs stay inside their limits');
  assert.match(
    lines.join('\n'),
    /step wait fails on both builds, not a regression \(new: canary step wait timed out .*; current build bbbbbbbb: canary step wait timed out/,
  );
  assert.equal(alerts.length, 0);
  // Only the new build blocks: refused, with both results in the log.
  writeFileSync(join(f.installation, 'builds', c, 'mode'), 'ok');
  const d = 'd'.repeat(64);
  f.build(d, 'hang:wait');
  lines.length = 0;
  await assert.rejects(run(f, d, canary), { code: 'CLI_CANARY_FAILED' });
  assert.match(
    lines.join('\n'),
    /canary refused dddddddd: canary step wait timed out .*; the current build cccccccc passes the same step/,
  );
});

test('differential canary: a step both builds fail is logged with both results and does not refuse (edcb0fc8)', async t => {
  const f = fixture(t);
  writeFileSync(join(f.old, 'mode'), 'exit:planning');
  f.build(b, 'exit:planning');
  const lines = [];
  const canary = cliCanaryPreSwitch(f.installation, {
    home: f.home,
    log: line => lines.push(line),
    alert: async () => {},
  });
  assert.equal((await run(f, b, canary)).status, 'updated');
  assert.match(
    lines.join('\n'),
    /Forge CLI canary passed for bbbbbbbb .*skipped: step planning fails on both builds, not a regression \(new: canary step planning exited 3; current build aaaaaaaa: canary step planning exited 3\)/,
  );
  // The re-run happens only on failure: one extra planning call, the other steps once each.
  assert.deepEqual(calls(f), ['version', 'status', 'planning', 'planning', 'wait']);
  // The current build ran pinned to its own commit like a canary child (no freshness read, no
  // update) on the same private HOME and real XDG directories.
  const env = JSON.parse(readFileSync(join(f.installation, `canary-env-${a.slice(0, 8)}.json`), 'utf8'));
  assert.equal(env.canary, a);
  assert.notEqual(env.home, f.home);
  assert.equal(env.xdg, join(f.home, '.config'));
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
if (process.env.FORGE_CLI_CANARY && ${JSON.stringify(name)} === 'old') {
  // The working current build, when the differential canary re-runs a failed step on it.
  process.stdout.write('nforge version fake\\n');
  process.exit(0);
}
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
