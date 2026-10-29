// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getFunctionName } from 'convex/server';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { hostedCheckDefinition, checkPin } from '../dist/hosted-check.js';
import { hostedMacRuntime } from '../dist/hosted-mac-lease.js';
import { checkEnvironment } from '../dist/check-environment.js';
import { policyPreset } from '../dist/autonomy-policy.js';
import { HostedAgentTransport } from '../dist/hosted-agent-transport.js';
import { hostedAgentActions } from '../dist/hosted-agent-contract.js';
import { hostedCheckKey } from '../dist/worker-cli.js';
const definitions = await import(moduleUrl('../convex/projectHostedCheckDefinitions.ts'));
const imports = await import(moduleUrl('../convex/projectHostedCheckImport.ts'));
const autonomy = await import(moduleUrl('../convex/projectAutonomy.ts'));
const actionsConfigure = await import(moduleUrl('../convex/projectHostedActionsConfigure.ts'));

/** Owner-proven repository bindings are a deployment setting; tests bind their own synthetic project. */
const bindRepository = (t, projectId, repo) => {
  const prior = process.env.FORGE_GITHUB_REPO_BINDINGS;
  process.env.FORGE_GITHUB_REPO_BINDINGS = `${projectId}=${repo}`;
  t.after(() => {
    if (prior === undefined) delete process.env.FORGE_GITHUB_REPO_BINDINGS;
    else process.env.FORGE_GITHUB_REPO_BINDINGS = prior;
  });
};

const code = value => error => (error.data?.code ?? error.code) === value;
const command = {
  name: 'verify',
  executable: 'node',
  args: ['scripts/forge-check.mjs'],
  environmentLabel: 'clean',
};

/** A dogfood-shaped project: a ready Work generation with a few thousand non-check
 * records, 20 checks and a redefined verify (older and newer definitions). */
function project({ verify = true } = {}) {
  const s = lanesFixture();
  const projectId = s.insert('hostedProjects', {
    key: 'synthetic',
    name: 'Synthetic',
    currentBackup: null,
    revision: 0,
    owner: 'owner',
    visibility: 'private',
    sourceAuthority: { mode: 'server', epoch: 1 },
    autonomyPolicy: policyPreset('supervised'),
  });
  s.insert('projectContributors', { projectId, contributor: 'peer' });
  const generationId = s.insert('projectWorkGenerations', {
    projectId,
    backupId: 'backup',
    format: 11,
    revision: 0,
    initialRevision: 0,
    nextBatch: 0,
    status: 'ready',
    metadata: JSON.stringify({ schema: 24 }),
  });
  s.patch('hostedProjects', projectId, {
    work: { generationId, backupId: 'backup', operationId: 'synthetic', initialRevision: 0, revision: 0 },
  });
  let position = 0;
  const put = (collection, key, value) =>
    s.insert('projectWorkRecords', {
      projectId,
      generationId,
      collection,
      key,
      parent: '',
      position: position++,
      value: JSON.stringify(value),
    });
  for (let i = 0; i < 3000; i++) put('intents', randomUUID(), { id: `intent-${i}` });
  const checks = [];
  for (let i = 0; i < 18; i++)
    checks.push(
      hostedCheckDefinition({ ...command, name: `check-${i}` }, randomUUID(), '2026-01-01T00:00:00.000Z'),
    );
  const older = hostedCheckDefinition(
    { ...command, args: ['old.mjs'] },
    randomUUID(),
    '2026-01-01T00:00:00.000Z',
  );
  const newer = hostedCheckDefinition(command, randomUUID(), '2026-02-01T00:00:00.000Z');
  if (verify) checks.push(newer, older);
  for (const check of checks) put('checks', check.id, check);
  return { s, projectId, newer, older };
}
const importRequest = (select, expected = null, operationId = randomUUID()) =>
  JSON.stringify({ operationId, authorityEpoch: 1, expected, select });
const settings = s => [...s.tables.projectHostedCheckSettings.values()];

test('fromWork imports the newest verify from hosted Work with bounded reads and replays its receipt', async () => {
  const { s, projectId, newer } = project();
  const operationId = randomUUID();
  const call = () =>
    s.call('fromWork', imports.fromWork, {
      projectId,
      request: importRequest({ name: 'verify' }, null, operationId),
    });
  const first = JSON.parse(await call());
  assert.deepEqual(first.value, newer);
  assert.equal(first.digest, newer.definition);
  assert.equal(first.key, newer.id);
  const meter = s.counts.at(-1);
  // Only the checks collection is scanned, never the thousands of other Work rows.
  assert(meter.documents <= 40 && meter.ranges <= 20, JSON.stringify(meter));
  assert(meter.writes <= 6, `writes ${meter.writes}`);
  assert.equal(await call(), JSON.stringify(first));
  assert.equal(settings(s).length, 1);
  assert.equal([...s.tables.projectHostedCheckSettingVersions.values()].length, 1);
  // A changed payload under the same operation is refused, not reinterpreted.
  await assert.rejects(
    s.call('fromWork', imports.fromWork, {
      projectId,
      request: importRequest({ name: 'check-1' }, null, operationId),
    }),
    code('WORK_OPERATION_CHANGED'),
  );
  // The imported definition is exactly what checkSelection reads back.
  const current = JSON.parse(await s.call('current', definitions.current, { projectId, checkId: newer.id }));
  assert.equal(current.check.definition, newer.definition);
});

test('fromWork enforces the expected digest and imports by checkId', async () => {
  const { s, projectId, newer, older } = project();
  await s.call('fromWork', imports.fromWork, { projectId, request: importRequest({ name: 'verify' }) });
  await assert.rejects(
    s.call('fromWork', imports.fromWork, { projectId, request: importRequest({ name: 'verify' }) }),
    code('EVIDENCE_CHANGED'),
  );
  await assert.rejects(
    s.call('fromWork', imports.fromWork, {
      projectId,
      request: importRequest({ name: 'verify' }, 'f'.repeat(64)),
    }),
    code('EVIDENCE_CHANGED'),
  );
  const again = JSON.parse(
    await s.call('fromWork', imports.fromWork, {
      projectId,
      request: importRequest({ name: 'verify' }, newer.definition),
    }),
  );
  assert.equal(again.version, 1);
  const byId = JSON.parse(
    await s.call('fromWork', imports.fromWork, { projectId, request: importRequest({ checkId: older.id }) }),
  );
  assert.deepEqual(byId.value, older);
});

test('fromWork fails cleanly when verify or hosted Work is missing, and refuses non-owners', async () => {
  const missing = project({ verify: false });
  await assert.rejects(
    missing.s.call('fromWork', imports.fromWork, {
      projectId: missing.projectId,
      request: importRequest({ name: 'verify' }),
    }),
    error => code('CHECK_NOT_FOUND')(error) && /named "verify"/.test(error.data?.message ?? error.message),
  );
  assert.equal(settings(missing.s).length, 0);
  assert.equal([...(missing.s.tables.projectHostedOperations?.values?.() ?? [])].length, 0);
  const { s, projectId } = project();
  s.patch('hostedProjects', projectId, { work: undefined });
  await assert.rejects(
    s.call('fromWork', imports.fromWork, { projectId, request: importRequest({ name: 'verify' }) }),
    code('WORK_STALE'),
  );
  const owned = project();
  for (const actor of ['peer', 'stranger'])
    await assert.rejects(
      owned.s.call(
        'fromWork',
        imports.fromWork,
        { projectId: owned.projectId, request: importRequest({ name: 'verify' }) },
        actor,
      ),
      code('PROJECT_UNAVAILABLE'),
    );
  assert.equal(settings(owned.s).length, 0);
});

/** The real CLI transport routed to the real Convex handlers on the fake store. */
function cli(t, fixture) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-configure-checks-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const handlers = {
    'projectHostedCheckDefinitions:list': definitions.list,
    'projectHostedCheckDefinitions:current': definitions.current,
    'projectHostedCheckDefinitions:configure': definitions.configure,
    'projectHostedCheckImport:fromWork': imports.fromWork,
    'projectAutonomy:read': autonomy.read,
    'projectAutonomy:set': autonomy.set,
  };
  const state = { actor: 'owner', calls: [], callback: true };
  const route = async (ref, args) => {
    const name = getFunctionName(ref);
    state.calls.push(name);
    if (name === 'projectHostedAgent:capabilities')
      return JSON.stringify({
        schema: 1,
        projectId: fixture.projectId,
        actor: state.actor,
        authority: { mode: 'server', epoch: 1 },
        actions: [...hostedAgentActions],
        mainReady: true,
        sourceWorkerConfigured: true,
        checkCallbackConfigured: state.callback,
        nativeOwnerRequired: false,
        observation: 'finite',
      });
    if (name === 'projectHostedActionsConfigure:configure')
      return actionsConfigure.configure._handler(
        {
          auth: { getUserIdentity: async () => ({ subject: state.actor }) },
          runMutation: (_ref, input) =>
            fixture.s.call('configure', definitions.configure, input, state.actor),
        },
        args,
      );
    assert(handlers[name], name);
    return fixture.s.call(name, handlers[name], args, state.actor);
  };
  const exchange = { projectId: fixture.projectId, client: { query: route, mutation: route, action: route } };
  const transport = new HostedAgentTransport(
    join(directory, 'root'),
    { url: 'https://fixture.invalid', projectId: fixture.projectId },
    exchange,
  );
  const run = async (action, input = {}) => {
    state.calls = [];
    return (await transport.dispatch(action, input)).result;
  };
  return { state, run };
}

test('CLI configures verify, a self-hosted runner and reports settings with bounded calls', async t => {
  const fixture = project();
  const { state, run } = cli(t, fixture);
  // Released clients parse advertised actions strictly; owner commands are not advertised.
  assert(
    !hostedAgentActions.some(action =>
      ['configure-check', 'configure-runner', 'check-settings'].includes(action),
    ),
  );
  const before = await run('check-settings');
  assert.deepEqual(before.definitions, []);
  assert.equal(before.runner, null);
  assert.equal(before.agentLandsOnPass, false);
  assert.equal(before.blockers.length, 3);
  assert(state.calls.length <= 4, state.calls.join());

  const imported = await run('configure-check');
  assert.equal(imported.digest, fixture.newer.definition);
  assert.deepEqual(state.calls, [
    'projectHostedAgent:capabilities',
    'projectHostedCheckDefinitions:list',
    'projectHostedCheckImport:fromWork',
  ]);
  // Identical parameters replay the retained operation and write nothing new.
  assert.deepEqual(await run('configure-check'), imported);
  assert.equal(state.calls.length, 2);
  assert.equal([...fixture.s.tables.projectHostedCheckSettingVersions.values()].length, 1);

  const runner = await run('configure-runner', { provider: 'mac' });
  assert.equal(runner.value.provider, 'self-hosted');
  assert.deepEqual(runner.value.platform, { os: process.platform, arch: process.arch });
  const displayed = await run('check-settings');
  assert.match(displayed.runner.description, /runner: self-hosted/);
  assert(
    displayed.runner.description.includes(
      `${process.platform}/${process.arch}, your machine; you pay nothing to Forge`,
    ),
  );
  assert.equal(runner.value.runtime, hostedMacRuntime);
  assert.equal(runner.value.environmentFingerprint, checkEnvironment().fingerprint);
  assert.equal(runner.digest, checkPin(runner.value));
  // A fresh operation keeps the configured machine and CASes on the current digest.
  const moved = await run('configure-runner', { provider: 'self-hosted', operationId: randomUUID() });
  assert.equal(moved.value.machineId, runner.value.machineId);
  assert.equal(moved.version, 1);
  await assert.rejects(
    run('configure-runner', { provider: 'mac', operationId: randomUUID(), expected: null }),
    code('EVIDENCE_CHANGED'),
  );
  // Legacy credential configurations still require this project's repository binding.
  bindRepository(t, fixture.projectId, 'example/repo');
  const actions = await run('configure-runner', {
    operationId: randomUUID(),
    configuration: {
      provider: 'github-actions',
      repository: 'example/repo',
      installationId: '1',
      runsOn: 'ubuntu-latest',
      runtime: 'a'.repeat(64),
      environmentFingerprint: 'b'.repeat(64),
      credential: { secretId: 'use-reference', version: 1, operation: 'actions' },
    },
  });
  assert.equal(actions.value.provider, 'github-actions');

  await fixture.s.call(
    'set',
    autonomy.set,
    {
      projectId: fixture.projectId,
      command: JSON.stringify({
        action: 'set-policy',
        operationId: randomUUID(),
        acceptance: { mode: 'auto-on-pass' },
      }),
    },
    'owner',
  );
  const after = await run('check-settings');
  assert.equal(after.finishCheck, fixture.newer.id);
  assert.equal(after.runner.digest, actions.digest);
  assert.equal(after.policy.acceptance.mode, 'auto-on-pass');
  assert.equal(after.agentLandsOnPass, true);
  assert.deepEqual(after.blockers, []);
});

test('CLI define-from-command replaces the same-named check; bad selections and non-owners are refused', async t => {
  const fixture = project({ verify: false });
  const { state, run } = cli(t, fixture);
  await assert.rejects(run('configure-check'), code('CHECK_NOT_FOUND'));
  const defined = await run('configure-check', { command });
  assert.equal(defined.value.name, 'verify');
  const replaced = await run('configure-check', { command: { ...command, args: ['b.mjs'] } });
  assert.equal(replaced.key, defined.key);
  assert.equal(replaced.version, 1);
  await assert.rejects(run('configure-check', { name: 'verify', command }), code('BAD_ARGUMENT'));
  await assert.rejects(run('configure-runner', {}), code('BAD_ARGUMENT'));
  state.actor = 'peer';
  await assert.rejects(run('configure-runner', { provider: 'mac' }), code('PROJECT_UNAVAILABLE'));
  await assert.rejects(
    run('configure-check', { command: { ...command, args: ['c.mjs'] } }),
    code('PROJECT_UNAVAILABLE'),
  );
  await assert.rejects(
    fixture.s.call(
      'set',
      autonomy.set,
      {
        projectId: fixture.projectId,
        command: JSON.stringify({
          action: 'set-policy',
          operationId: randomUUID(),
          acceptance: { mode: 'auto-on-pass' },
        }),
      },
      'peer',
    ),
    code('PROJECT_UNAVAILABLE'),
  );
});

test('the worker reads its collector key from env or an owner-only file', t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-check-key-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const file = join(directory, 'key');
  writeFileSync(file, 'synthetic-collector-key\n', { mode: 0o600 });
  assert.equal(hostedCheckKey('K1', { FORGE_HOSTED_CHECK_KEY_K1: 'from-env' }), 'from-env');
  assert.equal(hostedCheckKey('K1', { FORGE_HOSTED_CHECK_KEY_FILE: file }), 'synthetic-collector-key');
  chmodSync(file, 0o644);
  assert.throws(
    () => hostedCheckKey('K1', { FORGE_HOSTED_CHECK_KEY_FILE: file }),
    code('RUNNER_UNAVAILABLE'),
  );
  assert.throws(() => hostedCheckKey('K1', {}), code('RUNNER_UNAVAILABLE'));
  assert.throws(
    () => hostedCheckKey('K1', { FORGE_HOSTED_CHECK_KEY_FILE: join(directory, 'absent') }),
    code('RUNNER_UNAVAILABLE'),
  );
});

test('CLI configure-runner github-actions routes to the App action, derives the installation and reports it', async t => {
  const fixture = project();
  const { state, run } = cli(t, fixture);
  bindRepository(t, fixture.projectId, 'NanthAI/nanthai-forge');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const prior = { id: process.env.GITHUB_APP_ID, key: process.env.GITHUB_APP_PRIVATE_KEY };
  process.env.GITHUB_APP_ID = '12345';
  process.env.GITHUB_APP_PRIVATE_KEY = privateKey.export({ type: 'pkcs1', format: 'pem' });
  t.after(() => {
    for (const [name, value] of [
      ['GITHUB_APP_ID', prior.id],
      ['GITHUB_APP_PRIVATE_KEY', prior.key],
    ])
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });
  let permissions = { actions: 'write', contents: 'write', metadata: 'read' };
  const github = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    github.push([url, init.method]);
    assert.equal(url, 'https://api.github.com/repos/NanthAI/nanthai-forge/installation');
    return Response.json({ id: 77, permissions });
  });
  await assert.rejects(run('configure-runner', { provider: 'github-actions' }), code('BAD_ARGUMENT'));
  await assert.rejects(
    run('configure-runner', { provider: 'mac', repository: 'NanthAI/nanthai-forge' }),
    code('BAD_ARGUMENT'),
  );
  await assert.rejects(
    run('configure-runner', { provider: 'github-actions', repository: 'a/b', machineId: randomUUID() }),
    code('BAD_ARGUMENT'),
  );
  assert.equal(github.length, 0);

  // A pending Actions permission approval fails before any settings write.
  permissions = { contents: 'write', metadata: 'read' };
  await assert.rejects(
    run('configure-runner', {
      provider: 'github-actions',
      repository: 'NanthAI/nanthai-forge',
      operationId: randomUUID(),
    }),
    code('GITHUB_APP_PERMISSIONS'),
  );
  assert.equal(settings(fixture.s).length, 0);
  permissions = { actions: 'write', contents: 'write', metadata: 'read' };

  const operationId = randomUUID();
  const configured = await run('configure-runner', {
    provider: 'github-actions',
    repository: 'NanthAI/nanthai-forge',
    operationId,
  });
  assert.deepEqual(state.calls, [
    'projectHostedAgent:capabilities',
    'projectHostedCheckDefinitions:current',
    'projectHostedActionsConfigure:configure',
  ]);
  assert.equal(configured.value.provider, 'github-actions');
  assert.equal(configured.value.repository, 'NanthAI/nanthai-forge');
  assert.equal(configured.value.runsOn, 'ubuntu-latest');
  assert.equal(configured.value.installationId, undefined);
  assert.equal(configured.value.credential, undefined);
  assert.equal(configured.digest, checkPin(configured.value));
  // Installation lookup only: no token is minted to configure.
  assert.deepEqual(github.at(-1), ['https://api.github.com/repos/NanthAI/nanthai-forge/installation', 'GET']);
  assert(!github.some(([url]) => url.includes('access_tokens')));
  // The same operation replays its receipt without a second settings version.
  assert.deepEqual(
    await run('configure-runner', {
      provider: 'github-actions',
      repository: 'NanthAI/nanthai-forge',
      operationId,
    }),
    configured,
  );
  assert.equal(state.calls.length, 2);
  // A fresh operation keeps the current repository and CASes on its digest.
  const again = await run('configure-runner', { provider: 'github-actions', operationId: randomUUID() });
  assert.equal(again.digest, configured.digest);

  const shown = await run('check-settings');
  assert.equal(shown.runner.digest, configured.digest);
  assert.deepEqual(shown.actions, {
    mode: 'app-direct',
    repository: 'NanthAI/nanthai-forge',
    workflow: '.github/workflows/forge-check.yml',
    ref: 'main',
    runsOn: 'ubuntu-latest',
    runner: 'runner: ubuntu-latest',
    installation: 'derived per operation via the GitHub App',
    results: 'OIDC session plus workflow_run webhook',
  });
  assert(!shown.blockers.some(blocker => blocker.includes('runner')));

  // The dogfood-shaped Work fixture remains irrelevant to runner configuration.
  for (const runsOn of ['blacksmith-4vcpu-ubuntu-2404', ['self-hosted', 'linux', 'x64']]) {
    const start = fixture.s.counts.length;
    const labeled = await run('configure-runner', {
      provider: 'github-actions',
      runsOn,
      operationId: randomUUID(),
    });
    assert.deepEqual(labeled.value.runsOn, runsOn);
    assert.notEqual(labeled.digest, configured.digest);
    assert.notEqual(labeled.value.environmentFingerprint, configured.value.environmentFingerprint);
    assert.equal(state.calls.length, 3); // capabilities, current, action: no per-record calls.
    const meters = fixture.s.counts.slice(start);
    const reads = meters.reduce((n, meter) => n + meter.documents, 0);
    const writes = meters.reduce((n, meter) => n + meter.writes, 0);
    assert(reads < 30, `configuration reads ${reads}`);
    assert(writes <= 6, `configuration writes ${writes}`);
    const display = await run('check-settings');
    assert.deepEqual(display.actions.runsOn, runsOn);
    assert.match(display.actions.runner, /not GitHub-hosted: billed by your runner provider/);
    assert.equal(state.calls.length, 4); // capabilities plus three existing settings reads.
    t.diagnostic(
      `labeled configuration: 3 client calls, ${reads} document reads, ${writes} writes; settings: 4 client calls; idle: 0`,
    );
  }
  const reset = await run('configure-runner', { provider: 'github-actions', operationId: randomUUID() });
  assert.equal(reset.digest, configured.digest); // omission still means ubuntu-latest.
  const lookups = github.length,
    versions = settings(fixture.s).length;
  for (const runsOn of [
    '',
    '   ',
    'bad\nlabel',
    [],
    [42],
    42,
    null,
    'x'.repeat(257),
    Array(101).fill('linux'),
  ]) {
    await assert.rejects(
      run('configure-runner', {
        provider: 'github-actions',
        runsOn,
        operationId: randomUUID(),
      }),
      code('BAD_ARGUMENT'),
    );
  }
  await assert.rejects(run('configure-runner', { provider: 'mac', runsOn: 'linux' }), code('BAD_ARGUMENT'));
  assert.equal(github.length, lookups);
  assert.equal(settings(fixture.s).length, versions);

  state.actor = 'peer';
  await assert.rejects(
    run('configure-runner', {
      provider: 'github-actions',
      repository: 'NanthAI/nanthai-forge',
      operationId: randomUUID(),
    }),
    code('PROJECT_UNAVAILABLE'),
  );
});

test('CLI self-hosted labels remain pinned on replay and explicit empty labels clear the selection metadata', async t => {
  const fixture = project();
  const { run } = cli(t, fixture);
  const first = await run('configure-runner', { provider: 'self-hosted', labels: ['linux', 'build'] });
  assert.deepEqual(first.value.labels, ['linux', 'build']);
  assert.deepEqual(
    await run('configure-runner', { provider: 'self-hosted', labels: ['linux', 'build'] }),
    first,
  );
  const retained = await run('configure-runner', { provider: 'self-hosted', operationId: randomUUID() });
  assert.deepEqual(retained.value.labels, ['linux', 'build']);
  assert.equal(retained.value.machineId, first.value.machineId);
  const cleared = await run('configure-runner', {
    provider: 'self-hosted',
    labels: [],
    operationId: randomUUID(),
  });
  assert.deepEqual(cleared.value.labels, []);
  assert.notEqual(cleared.digest, first.digest);
  assert.deepEqual((await run('check-settings')).runner.configuration.labels, []);
  await assert.rejects(
    run('configure-runner', { provider: 'github-actions', labels: ['build'] }),
    code('BAD_ARGUMENT'),
  );
});
