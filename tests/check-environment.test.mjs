// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { initNative } from '../dist/native-work.js';
import { WorkService } from '../dist/work.js';
import { checkEnvironment, checkProcessEnvironment } from '../dist/check-environment.js';
import { runReceipt } from '../dist/agent-receipts.js';
import { agentClean } from '../dist/agent-clean.js';
import { standardSelection } from '../scripts/test-impact.mjs';
import { readWorkBytes } from './work-store-fixture.mjs';

function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}
function setup(t, files = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-clean-env-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'owner');
  mkdirSync(root);
  writeFileSync(join(root, 'a.txt'), 'source');
  for (const [path, value] of Object.entries(files)) writeFileSync(join(root, path), value);
  initNative(root);
  const work = new WorkService(root);
  const act = command => work.execute(command, work.store.revision()).result;
  const dispatch = command => work.dispatch(command, work.store.revision());
  const intent = act({ action: 'intent', outcome: 'Clean check environment' });
  const lane = act({ action: 'lane', intentId: intent.id, name: 'Candidate' });
  const view = act({
    action: 'compose',
    operationId: randomUUID(),
    intentId: intent.id,
    inputs: [{ laneId: lane.id, head: lane.head }],
  });
  const define = (script, patch = {}) =>
    act({
      action: 'define-check',
      name: 'Environment fixture',
      executable: process.execPath,
      args: ['-e', script],
      ...patch,
    });
  const run = async check => {
    const operationId = randomUUID();
    await dispatch({
      action: 'run-check',
      operationId,
      viewId: view.id,
      expectedHead: view.head,
      checkId: check.id,
      expectedDefinition: check.definition,
      expectedEnvironment: checkEnvironment().fingerprint,
    });
    return wait(() => work.store.select('runs', operationId));
  };
  const output = async run =>
    (await dispatch({ action: 'read-check-output', operationId: run.id, stream: 'stdout' })).result.text;
  return { directory, root, work, act, dispatch, define, run, output, view, lane, intent };
}
async function wait(read) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = read();
    if (result?.endedAt) return result;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail('Check did not finish');
}

test('legacy definitions get private HOME/XDG/temp and no ambient Forge, npm, cloud or CLI credentials', async t => {
  const f = setup(t, { '.env.local': 'S2_DOTENV=synthetic-dotenv-sentinel' });
  const home = join(f.directory, 'real-home');
  const config = join(home, '.config');
  const homeFiles = {
    '.ssh/id_ed25519': 'synthetic-ssh-sentinel',
    '.aws/credentials': 'synthetic-aws-sentinel',
    '.aws/config': 'synthetic-aws-config-sentinel',
    '.config/gcloud/application_default_credentials.json': 'synthetic-gcloud-sentinel',
    '.config/forge/auth.json': 'fake-saved-login',
    '.forge/auth.json': 'synthetic-forge-home-sentinel',
    '.env.local': 'S2_HOME_DOTENV=synthetic-home-dotenv-sentinel',
    '.npmrc': '//registry.npmjs.org/:_authToken=fake-npm-login',
  };
  for (const [path, value] of Object.entries(homeFiles)) {
    mkdirSync(dirname(join(home, path)), { recursive: true });
    writeFileSync(join(home, path), value);
  }
  const credentials = {
    FORGE_AUTH_TOKEN: 'fake-forge-token',
    FORGE_AGENT_TOKEN: 'fake-agent-token',
    FORGE_SECRET_KEYS: 'fake-forge-keyring',
    FORGE_NEW_CREDENTIAL: 'fake-future-token',
    GH_TOKEN: 'fake-gh-token',
    GITHUB_TOKEN: 'fake-github-token',
    NPM_TOKEN: 'fake-npm-token',
    AWS_ACCESS_KEY_ID: 'fake-aws-key',
    AWS_SECRET_ACCESS_KEY: 'fake-aws-secret',
    AWS_SESSION_TOKEN: 'fake-aws-session',
    AWS_SHARED_CREDENTIALS_FILE: join(home, '.aws/credentials'),
    AWS_CONFIG_FILE: join(home, '.aws/config'),
    GOOGLE_APPLICATION_CREDENTIALS: join(config, 'gcloud/application_default_credentials.json'),
    CLOUDSDK_CONFIG: join(config, 'gcloud'),
    AZURE_CLIENT_SECRET: 'fake-azure-secret',
    AZURE_CONFIG_DIR: join(home, '.azure'),
    CONVEX_DEPLOY_KEY: 'fake-convex-key',
    SSH_AUTH_SOCK: join(home, 'synthetic-agent.sock'),
    SSH_AGENT_PID: '99999999',
  };
  environment(t, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: config,
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_DATA_HOME: join(home, '.local/share'),
    XDG_STATE_HOME: join(home, '.local/state'),
    TMPDIR: join(home, 'tmp'),
    TMP: join(home, 'tmp'),
    TEMP: join(home, 'tmp'),
    ...credentials,
    NODE_OPTIONS: '--require=/missing-ambient-preload',
    npm_config_userconfig: join(home, '.npmrc'),
    LC_MESSAGES: 'C',
    H11_UNDECLARED: 'fixture-value',
  });
  const legacy = f.define(`
    const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
    const names=['HOME','USERPROFILE','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_DATA_HOME','XDG_STATE_HOME','TMPDIR','TEMP','TMP'];
    for(const name of names) { if(!fs.statSync(process.env[name]).isDirectory()) process.exit(2); }
    const paths=${JSON.stringify(Object.keys(homeFiles))}.map(p=>path.join(os.homedir(),p));
    paths.push(path.join(process.env.XDG_CONFIG_HOME,'forge/auth.json'),path.join(process.env.XDG_CONFIG_HOME,'gcloud/application_default_credentials.json'),'.env.local',process.env.npm_config_userconfig,process.env.npm_config_globalconfig);
    for(const p of paths) {
      try { fs.readFileSync(p); process.exit(3); }
      catch(error) { if(error.code!=='ENOENT') process.exit(5); }
    }
    for(const name of ${JSON.stringify([...Object.keys(credentials), 'NODE_OPTIONS', 'H11_UNDECLARED'])}) if(process.env[name]!==undefined) process.exit(4);
    // Report names and generated paths only; never dump inherited values or file bytes.
    console.log(JSON.stringify({names:Object.keys(process.env),unreadablePaths:paths.length,dirs:Object.fromEntries(names.map(n=>[n,process.env[n]])),ci:process.env.CI,locale:process.env.LC_MESSAGES,cache:process.env.npm_config_cache,userconfig:process.env.npm_config_userconfig}));
  `);
  assert.equal(legacy.env, undefined);
  assert.equal(legacy.credentials, undefined);
  const result = await f.run(legacy);
  assert.equal(result.status, 'passed');
  const observed = JSON.parse(await f.output(result));
  const runtime = join(f.work.store.directory, `check-${result.id}`, 'runtime');
  for (const value of Object.values(observed.dirs)) assert.ok(value.startsWith(runtime + '/'));
  assert.equal(observed.ci, 'true');
  assert.equal(observed.locale, 'C');
  assert.equal(observed.unreadablePaths, Object.keys(homeFiles).length + 5);
  for (const name of Object.keys(credentials)) assert.ok(!observed.names.includes(name));
  assert.ok(!observed.cache.startsWith(observed.dirs.HOME));
  assert.ok(observed.userconfig.startsWith(runtime + '/'));
  assert.equal(existsSync(runtime), false);
  assert.equal(existsSync(observed.cache), true);
  for (const [path, value] of Object.entries(homeFiles))
    assert.equal(readFileSync(join(home, path), 'utf8'), value);
  assert.equal(readFileSync(join(f.root, '.env.local'), 'utf8'), 'S2_DOTENV=synthetic-dotenv-sentinel');
  assert.equal(runReceipt(result).environmentMode, 'clean');
  assert.match(result.details, /Clean environment; no declared passthrough/);
});

test('passthrough is explicit, digest-bound, canonicalized and values never enter receipts', async t => {
  const f = setup(t);
  environment(t, {
    H11_VALUE: 'private-value-sentinel',
    FORGE_AUTH_TOKEN: 'explicit-secret-sentinel',
    FORGE_AUTH_TOKEN_EXTRA: 'undeclared-forge-sentinel',
    AWS_SECRET_ACCESS_KEY: 'undeclared-cloud-sentinel',
    H11_VALUE_OTHER: 'undeclared-value-sentinel',
  });
  const script = `const hash=v=>require('node:crypto').createHash('sha256').update(v||'').digest('hex');if(hash(process.env.H11_VALUE)!==${JSON.stringify(createHash('sha256').update('private-value-sentinel').digest('hex'))}||hash(process.env.FORGE_AUTH_TOKEN)!==${JSON.stringify(createHash('sha256').update('explicit-secret-sentinel').digest('hex'))})process.exit(8);for(const name of ['FORGE_AUTH_TOKEN_EXTRA','AWS_SECRET_ACCESS_KEY','H11_VALUE_OTHER'])if(process.env[name]!==undefined)process.exit(9)`;
  const base = f.define(script);
  const empty = f.define(script, { checkId: base.id, env: [], credentials: [] });
  assert.equal(empty.definition, base.definition);
  const declared = f.define(script, {
    checkId: base.id,
    env: ['H11_VALUE'],
    credentials: ['FORGE_AUTH_TOKEN'],
  });
  assert.notEqual(declared.definition, base.definition);
  const reordered = f.define(script, {
    checkId: base.id,
    env: ['H11_VALUE', 'H11_VALUE'],
    credentials: ['FORGE_AUTH_TOKEN'],
  });
  assert.equal(reordered.definition, declared.definition);
  const changed = f.define(script, { env: ['FORGE_AUTH_TOKEN', 'H11_VALUE'] });
  assert.notEqual(changed.definition, declared.definition);
  const result = await f.run(declared);
  assert.equal(result.status, 'passed');
  const receipt = runReceipt(result);
  assert.deepEqual(receipt.env, ['H11_VALUE']);
  assert.deepEqual(receipt.credentials, ['FORGE_AUTH_TOKEN']);
  const stored = readWorkBytes(join(f.work.store.directory, 'work.json'), 'utf8');
  assert.ok(!stored.includes('private-value-sentinel'));
  assert.ok(!stored.includes('explicit-secret-sentinel'));
  assert.ok(!JSON.stringify(result.environment).includes('sentinel'));
  assert.equal(result.environment.env.H11_VALUE, undefined);
  assert.equal(result.environment.env.FORGE_AUTH_TOKEN, undefined);
  assert.match(result.details, /declared passthrough: FORGE_AUTH_TOKEN, H11_VALUE/);
  assert.throws(() => f.define('', { env: ['BAD=NAME'] }), /Invalid|valid|command/i);
});

test('HOME and credential-file opt-ins override only the declared setting', async t => {
  const f = setup(t);
  const home = join(f.directory, 'synthetic-home');
  const ssh = join(home, '.ssh/id_ed25519');
  const aws = join(home, '.aws/credentials');
  for (const path of [ssh, aws]) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'synthetic-file-sentinel');
  }
  environment(t, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    AWS_SHARED_CREDENTIALS_FILE: aws,
    AWS_SECRET_ACCESS_KEY: 'undeclared-cloud-sentinel',
    FORGE_AUTH_TOKEN: 'undeclared-forge-sentinel',
  });
  const probe = `
    const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
    const home=${JSON.stringify(home)};
    if(process.env.USERPROFILE===home || process.env.XDG_CONFIG_HOME===path.join(home,'.config') || process.env.AWS_SECRET_ACCESS_KEY || process.env.FORGE_AUTH_TOKEN) process.exit(2);
    const readable=p=>{try{return fs.readFileSync(p,'utf8')==='synthetic-file-sentinel'}catch(e){if(e.code!=='ENOENT')throw e;return false}};
  `;
  const homeRun = await f.run(
    f.define(
      probe +
        `
    if(os.homedir()!==home || process.env.AWS_SHARED_CREDENTIALS_FILE!==undefined) process.exit(3);
    if(!readable(path.join(os.homedir(),'.ssh/id_ed25519')) || !readable(path.join(os.homedir(),'.aws/credentials'))) process.exit(4);
  `,
      { env: ['HOME'] },
    ),
  );
  assert.equal(homeRun.status, 'passed');
  assert.deepEqual(runReceipt(homeRun).env, ['HOME']);
  const fileRun = await f.run(
    f.define(
      probe +
        `
    if(os.homedir()===home || !readable(process.env.AWS_SHARED_CREDENTIALS_FILE)) process.exit(5);
    if(readable(path.join(os.homedir(),'.ssh/id_ed25519')) || readable(path.join(os.homedir(),'.aws/credentials'))) process.exit(6);
  `,
      { credentials: ['AWS_SHARED_CREDENTIALS_FILE'] },
    ),
  );
  assert.equal(fileRun.status, 'passed');
  assert.deepEqual(runReceipt(fileRun).credentials, ['AWS_SHARED_CREDENTIALS_FILE']);
  assert.equal(await f.output(homeRun), '');
  assert.equal(await f.output(fileRun), '');
});

test('clean settings do not sandbox known absolute paths, including a synthetic HOME', async t => {
  const f = setup(t);
  const home = join(f.directory, 'synthetic-home');
  const path = join(home, '.ssh/id_ed25519');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'synthetic-absolute-path-sentinel');
  environment(t, { HOME: home, FORGE_AUTH_TOKEN: 'undeclared-forge-sentinel' });
  const result = await f.run(
    f.define(`
    if(require('node:os').homedir()===${JSON.stringify(home)} || process.env.FORGE_AUTH_TOKEN) process.exit(2);
    // Read only this fixture, never an account database or the machine's actual home.
    const bytes=require('node:fs').readFileSync(${JSON.stringify(path)});
    if(require('node:crypto').createHash('sha256').update(bytes).digest('hex')!==${JSON.stringify(createHash('sha256').update('synthetic-absolute-path-sentinel').digest('hex'))})process.exit(3);
  `),
  );
  assert.equal(result.status, 'passed');
  assert.equal(await f.output(result), '');
});

test('failed legacy runs suggest omitted names without persisting their values; cleanup covers retained runtime', async t => {
  const f = setup(t);
  environment(t, { H11_NEEDED: 'do-not-record-this-value' });
  const result = await f.run(
    f.define(
      `require('node:fs').writeFileSync('a.txt','changed');if(!process.env.H11_NEEDED)process.exit(7)`,
    ),
  );
  assert.equal(result.status, 'failed');
  assert.ok(result.warnings.some(warning => /may need env passthrough:.*H11_NEEDED/.test(warning)));
  const bytes = readWorkBytes(join(f.work.store.directory, 'work.json'), 'utf8');
  assert.ok(!bytes.includes('do-not-record-this-value'));
  const runtime = join(f.work.store.directory, `check-${result.id}`, 'runtime');
  assert.equal(existsSync(runtime), true);
  const cleaned = agentClean(f.work.store, { action: 'clean', apply: true, kinds: ['check-workspaces'] });
  assert.ok(cleaned.result.removed.some(group => group.items.some(item => item.path === runtime)));
  assert.equal(existsSync(runtime), false);
});

test('Playbooks and event automations use the same clean runner and declared passthrough', async t => {
  const f = setup(t);
  environment(t, { FORGE_AUTH_TOKEN: 'ambient-secret', H11_STEP: 'allowed' });
  const first = f.define(`if(process.env.FORGE_AUTH_TOKEN||process.env.H11_STEP)process.exit(4)`);
  const second = f.define(
    `if(process.env.FORGE_AUTH_TOKEN||process.env.H11_STEP!=='allowed')process.exit(5)`,
    { env: ['H11_STEP'] },
  );
  const playbook = (
    await f.dispatch({ action: 'define-playbook', name: 'Clean steps', checkIds: [first.id, second.id] })
  ).result;
  const pins = {
    expectedDefinition: playbook.definition,
    expectedEnvironment: checkEnvironment().fingerprint,
    expectedChecks: [first, second].map(c => ({ id: c.id, definition: c.definition })),
  };
  const command = {
    action: 'run-playbook',
    operationId: randomUUID(),
    viewId: f.view.id,
    expectedHead: f.view.head,
    playbookId: playbook.id,
    onFailure: 'stop',
    ...pins,
  };
  await f.dispatch(command);
  const result = await wait(() => f.work.status().playbookRuns.find(r => r.id === command.operationId));
  assert.equal(result.status, 'passed');
  await f.dispatch({
    action: 'define-automation',
    automationId: randomUUID(),
    intentId: f.intent.id,
    name: 'Clean event',
    enabled: true,
    event: 'clean-view',
    playbookId: playbook.id,
    expectedPlaybook: playbook.definition,
    expectedEnvironment: pins.expectedEnvironment,
    expectedChecks: pins.expectedChecks,
    onFailure: 'stop',
  });
  f.act({
    action: 'compose',
    operationId: randomUUID(),
    intentId: f.intent.id,
    inputs: [{ laneId: f.lane.id, head: f.lane.head }],
  });
  const automated = await wait(() => f.work.status().playbookRuns.find(r => r.automation));
  assert.equal(automated.status, 'passed');
  assert.ok(f.work.status().runs.every(r => r.environment.mode === 'clean'));
});

test('npm ci installs offline from the dedicated shared content cache without npmrc credentials', async t => {
  const f = setup(t);
  const npmCli = [
    join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
    '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
    '/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js',
  ].find(existsSync);
  assert.ok(npmCli, 'npm is available to the standard check');
  const pack = join(f.directory, 'package');
  mkdirSync(pack);
  writeFileSync(
    join(pack, 'package.json'),
    JSON.stringify({ name: 'forge-h11-offline-fixture', version: '1.0.0' }),
  );
  const clean = checkProcessEnvironment(
    { env: [], credentials: [] },
    checkEnvironment(),
    join(f.directory, 'seed'),
  );
  clean.prepare();
  const npm = (cwd, ...args) =>
    execFileSync(process.execPath, [npmCli, ...args], {
      cwd,
      env: clean.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const packed = JSON.parse(npm(pack, 'pack', '--json', '--ignore-scripts'))[0];
  const tarball = join(pack, packed.filename);
  npm(pack, 'cache', 'add', tarball);
  const integrity = 'sha512-' + createHash('sha512').update(readFileSync(tarball)).digest('base64');
  const manifest = {
    name: 'offline-consumer',
    version: '1.0.0',
    dependencies: { 'forge-h11-offline-fixture': '1.0.0' },
  };
  const lock = {
    name: manifest.name,
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': manifest,
      'node_modules/forge-h11-offline-fixture': {
        version: '1.0.0',
        resolved: 'https://registry.invalid/forge-h11-offline-fixture/-/fixture.tgz',
        integrity,
      },
    },
  };
  writeFileSync(join(f.work.store.path(f.lane.id), 'package.json'), JSON.stringify(manifest));
  writeFileSync(join(f.work.store.path(f.lane.id), 'package-lock.json'), JSON.stringify(lock));
  // Invoke npm in an actual check, using a source-independent synthetic fixture.
  const script = `const fs=require('node:fs');fs.writeFileSync('package.json',${JSON.stringify(JSON.stringify(manifest))});fs.writeFileSync('package-lock.json',${JSON.stringify(JSON.stringify(lock))});require('node:child_process').execFileSync(process.execPath,[${JSON.stringify(npmCli)},'ci','--offline','--ignore-scripts','--no-audit','--no-fund'],{stdio:'inherit'});if(!fs.existsSync('node_modules/forge-h11-offline-fixture/package.json'))process.exit(9)`;
  const result = await f.run(f.define(script));
  assert.equal(result.status, 'passed', await f.output(result));
});

test('runner pins exact native comparison and records command selection in receipts', async t => {
  const f = setup(t);
  f.work.store.locked(() => {
    const data = f.work.store.load();
    const view = data.views.find(view => view.id === f.view.id);
    view.composedMain = f.view.head;
    view.mainCheck = { channel: 'main' };
    f.work.store.save(data);
  });
  environment(t, {
    FORGE_CHECK_FULL: '1',
    FORGE_CHECK_BASE: 'ambient-wrong-base',
    FORGE_CHECK_CHANGES: '/ambient',
    FORGE_CHECK_HEAD: 'ambient-wrong-head',
    FORGE_CHECK_SELECTION: '/ambient-selection',
    FORGE_CHECK_INTERACTION: 'ambient-interaction',
  });
  const fingerprint = checkEnvironment().fingerprint;
  process.env.FORGE_CHECK_FULL = '0';
  assert.notEqual(checkEnvironment().fingerprint, fingerprint);
  process.env.FORGE_CHECK_FULL = '1';
  const check = f.define(
    `
    const fs=require('node:fs');
    const input=JSON.parse(fs.readFileSync(process.env.FORGE_CHECK_CHANGES));
    if(input.version!==1 || input.base!==process.env.FORGE_CHECK_BASE || input.head!==process.env.FORGE_CHECK_HEAD || process.env.FORGE_CHECK_FULL!=='1')process.exit(9);
    if(process.env.FORGE_CHECK_INTERACTION!==undefined || process.env.FORGE_CHECK_SELECTION==='/ambient-selection')process.exit(10);
    fs.writeFileSync(process.env.FORGE_CHECK_SELECTION, JSON.stringify({scope:'scoped',reason:'synthetic selection',tests:['tests/fixture.test.mjs']}));
    console.log(JSON.stringify(input));
  `,
    {
      env: [
        'FORGE_CHECK_BASE',
        'FORGE_CHECK_CHANGES',
        'FORGE_CHECK_HEAD',
        'FORGE_CHECK_SELECTION',
        'FORGE_CHECK_INTERACTION',
      ],
    },
  );
  const result = await f.run(check);
  assert.equal(result.status, 'passed');
  const input = JSON.parse(await f.output(result));
  assert.equal(input.base, f.view.head);
  assert.equal(input.head, f.view.head);
  assert.deepEqual(input.paths, []);
  assert.deepEqual(input.mainCheck, { channel: 'main' });
  assert.deepEqual(result.mainCheck, input.mainCheck);
  assert.equal(result.comparisonBase, f.view.head);
  assert.equal(
    standardSelection({
      paths: input.paths,
      mainCheck: input.mainCheck,
      files: new Map([['tests/smoke.test.mjs', '']]),
      env: { FORGE_CHECK_SCOPED: '1' },
    }).scope,
    'full',
  );
  assert.equal(result.checkSelection.scope, 'scoped');
  assert.deepEqual(runReceipt(result).checkSelection.tests, ['tests/fixture.test.mjs']);
  assert.match(result.details, /Check selection: scoped/);
});

test('runtime passthrough retains batch pins when the adopting process differs', t => {
  environment(t, { PATH: '/recorded-runtime', FORGE_CHECK_FULL: '1' });
  const recorded = checkEnvironment();
  process.env.PATH = '/adopting-process';
  process.env.FORGE_CHECK_FULL = '0';
  const actual = checkProcessEnvironment({ env: ['PATH', 'FORGE_CHECK_FULL'] }, recorded, '/synthetic-run');
  assert.equal(actual.env.PATH, '/recorded-runtime');
  assert.equal(actual.env.FORGE_CHECK_FULL, '1');
});
