// SPDX-License-Identifier: Apache-2.0
// Optional release acceptance: installs and exercises the actual local npm archive.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { componentManifestSha256 } from './selfhost-notices.mjs';
import { packageDocuments } from './package-documents.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const option = name => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
assert.ok(
  args.length === 0 ||
    (args.length === 2 && args[0] === '--artifact-dir') ||
    (args.length === 4 && args[0] === '--artifact-dir' && args[2] === '--browser-session'),
  'Use --artifact-dir NEW_DIRECTORY [--browser-session PRIVATE_JSON].',
);
const kept = option('--artifact-dir');
const sessionPath = option('--browser-session');
let directory = kept ? resolve(kept) : mkdtempSync(join(tmpdir(), 'forge-package-'));
if (kept) {
  assert.equal(existsSync(directory), false, 'Artifact directory must be new.');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
}
directory = realpathSync(directory);
const npm = process.env.npm_execpath || createRequire(import.meta.url).resolve('npm/bin/npm-cli.js');
const buildEnv = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const originalPath = process.env.PATH;
let server,
  client,
  success = false;
const run = (executable, argv, options = {}) => {
  const reply = spawnSync(executable, argv, {
    cwd: directory,
    env: buildEnv,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  assert.equal(
    reply.status,
    0,
    `${executable} ${argv[0]} failed: ${reply.stderr || reply.stdout || reply.error}`,
  );
  return reply.stdout;
};
try {
  // Clean generated outputs, preventing an earlier hosted build or stray private file entering the package.
  rmSync(join(root, 'dist'), { recursive: true, force: true });
  run(process.execPath, [npm, 'run', 'build:core'], { cwd: root });
  const packed = JSON.parse(
    run(process.execPath, [join(root, 'scripts', 'package-local.mjs'), '--out', directory], {
      cwd: root,
      env: { ...buildEnv, npm_execpath: npm },
    }),
  )[0];
  const names = packed.files.map(file => file.path);
  const componentRoot = 'docs/vendor-notices/native-components';
  const componentManifestBytes = readFileSync(join(root, componentRoot, 'manifest.json'));
  assert.equal(
    hash(componentManifestBytes),
    componentManifestSha256,
    'Original native component notice manifest changed.',
  );
  const componentManifest = JSON.parse(componentManifestBytes);
  assert.equal(componentManifest.coverage, 'PARTIAL');
  assert.equal(componentManifest.originals.length, 39);
  const componentNotices = [
    `${componentRoot}/manifest.json`,
    `${componentRoot}/PARTIAL.md`,
    ...componentManifest.originals.map(item => `${componentRoot}/${item.path}`),
  ];
  const notices = [
    'skills/forge-agent/SKILL.md',
    'README.md',
    'LICENSE.md',
    'LICENSE-Apache-2.0.txt',
    'LICENSE-AGPL-3.0-only.txt',
    'THIRD_PARTY_NOTICES.txt',
    'web/src/assets/NOTICE.md',
    ...packageDocuments,
    'docs/vendor-notices/convex-backend-LICENSE.md',
    ...componentNotices,
    'package.json',
    'forge-package-lock.json',
  ];
  for (const file of notices) assert.ok(names.includes(file), `Missing package notice/document: ${file}`);
  for (const file of names)
    assert.ok(
      notices.includes(file) || file.startsWith('node_modules/') || /^dist\/[^/]+\.(?:js|d\.ts)$/.test(file),
      `Unexpected package file: ${file}`,
    );
  assert.ok(names.includes('dist/cli.js'));
  const archive = join(directory, packed.filename),
    prefix = join(directory, 'installed');
  mkdirSync(prefix, { mode: 0o700 });
  run(process.execPath, [
    npm,
    'install',
    '--prefix',
    prefix,
    '--ignore-scripts',
    '--offline',
    '--cache',
    join(directory, 'empty-install-cache'),
    '--no-audit',
    '--no-fund',
    archive,
  ]);
  const installed = join(prefix, 'node_modules', '@nanthai', 'forge'),
    cli = join(installed, 'dist', 'cli.js');
  assert.equal(realpathSync(join(prefix, 'node_modules', '.bin', 'nforge')), realpathSync(cli));
  assert.ok(statSync(cli).mode & 0o111, 'Installed CLI must be executable.');
  const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
  for (const notice of notices.filter(
    file => !['package.json', 'forge-package-lock.json', 'THIRD_PARTY_NOTICES.txt'].includes(file),
  ))
    assert.equal(
      hash(readFileSync(join(installed, notice))),
      hash(readFileSync(join(root, notice))),
      `Installed notice changed: ${notice}`,
    );
  assert.equal(
    hash(readFileSync(join(installed, 'forge-package-lock.json'))),
    hash(readFileSync(join(root, 'package-lock.json'))),
  );
  for (const item of componentManifest.originals) {
    const bytes = readFileSync(join(installed, componentRoot, item.path));
    assert.equal(bytes.length, item.size);
    assert.equal(hash(bytes), item.sha256, `Installed original component notice changed: ${item.path}`);
  }
  // Independently regenerate from the installed archive's actual closure and its original lock.
  const noticeScript = join(root, 'scripts', 'package-notices.mjs'),
    installedNotice = join(installed, 'THIRD_PARTY_NOTICES.txt'),
    expectedNotice = join(directory, 'installed-expected-notices.txt');
  const noticeArgs = [noticeScript, '--root', installed, '--lock', 'forge-package-lock.json', '--installed'];
  const noticeSummary = JSON.parse(run(process.execPath, [...noticeArgs, '--out', expectedNotice]));
  assert.deepEqual(
    readFileSync(installedNotice),
    readFileSync(expectedNotice),
    'Installed notices differ from actual locked production closure.',
  );
  run(process.execPath, [...noticeArgs, '--check']);
  const rejected = expected => {
    const reply = spawnSync(process.execPath, [...noticeArgs, '--check'], {
      env: buildEnv,
      encoding: 'utf8',
    });
    assert.notEqual(reply.status, 0, 'Altered/incomplete upstream notices unexpectedly passed.');
    assert.match(reply.stderr, expected);
  };
  const noticeBytes = readFileSync(installedNotice);
  try {
    writeFileSync(installedNotice, Buffer.concat([noticeBytes, Buffer.from('corrupted QA notice\n')]));
    rejected(/Third-party notices differ/);
  } finally {
    writeFileSync(installedNotice, noticeBytes);
  }
  const upstreamLicense = join(installed, 'node_modules', 'zod', 'LICENSE'),
    upstreamBytes = readFileSync(upstreamLicense);
  try {
    rmSync(upstreamLicense);
    rejected(/Upstream notices incomplete/);
  } finally {
    writeFileSync(upstreamLicense, upstreamBytes);
  }
  const requiredManifest = join(installed, 'node_modules', 'zod', 'package.json'),
    requiredBytes = readFileSync(requiredManifest);
  try {
    rmSync(requiredManifest);
    rejected(/Upstream notices incomplete/);
  } finally {
    writeFileSync(requiredManifest, requiredBytes);
  }
  run(process.execPath, [...noticeArgs, '--check']);
  const sourceLock = JSON.parse(readFileSync(join(root, 'package-lock.json')));
  const installLock = JSON.parse(readFileSync(join(prefix, 'package-lock.json')));
  for (const [path, entry] of Object.entries(installLock.packages)) {
    if (!path || path.endsWith('/@nanthai/forge')) continue;
    // npm may nest dependency paths below this library's package boundary.
    const originalPath = path.replace('node_modules/@nanthai/forge/node_modules/', 'node_modules/');
    assert.equal(
      entry.version,
      sourceLock.packages[originalPath]?.version,
      `Installed dependency pin drift: ${path}`,
    );
  }
  assert.equal(manifest.private, true);
  assert.equal(manifest.license, 'Apache-2.0');
  assert.equal(manifest.engines.node, '>=22.12 <25');
  const bin = join(directory, 'no-git');
  mkdirSync(bin);
  const gitCalled = join(directory, 'git-called');
  writeFileSync(join(bin, 'git'), '#!/bin/sh\n/usr/bin/touch "$FORGE_PACKAGE_GIT_CALLED"\nexit 91\n', {
    mode: 0o700,
  });
  symlinkSync(process.execPath, join(bin, 'node'));
  for (const name of ['tar', 'gzip']) symlinkSync(`/usr/bin/${name}`, join(bin, name));
  const env = { PATH: bin, FORGE_PACKAGE_GIT_CALLED: gitCalled };
  // In-process public SDK calls receive the same unavailable Git boundary as CLI/MCP.
  process.env.PATH = bin;
  process.env.FORGE_PACKAGE_GIT_CALLED = gitCalled;
  const command = (...argv) => JSON.parse(run(process.execPath, [cli, ...argv], { env }));
  assert.match(run(join(prefix, 'node_modules', '.bin', 'nforge'), ['--help'], { env }), /init-native/);
  const owner = join(directory, 'native');
  mkdirSync(owner);
  writeFileSync(join(owner, 'a.ts'), 'export const answer = 1;\n');
  writeFileSync(join(owner, 'README.md'), '# Package acceptance\n');
  writeFileSync(join(owner, '.env'), 'PACKAGE_SYNTHETIC_SECRET=excluded\n', { mode: 0o600 });
  const initial = command('init-native', owner);
  command('set-policy', owner, JSON.stringify({ operationId: randomUUID(), preset: 'trusted' }));
  assert.equal(initial.engine, 'forge-native');
  assert.equal(existsSync(join(owner, '.git')), false);
  command('index', owner);
  assert.equal(command('source', owner, 'a.ts', '1', '1').results[0].text, 'export const answer = 1;');
  const resolver = createRequire(join(prefix, 'package.json'));
  const runtimeResolver = createRequire(join(installed, 'package.json'));
  const sdk = await import(pathToFileURL(resolver.resolve('@nanthai/forge')));
  const querySdk = await import(pathToFileURL(resolver.resolve('@nanthai/forge/query')));
  assert.equal(sdk.openRepository(owner).freshness, 'current');
  assert.equal(
    new querySdk.RepositoryQuery(owner).status().sourceId,
    sdk.openRepository(owner).pack.source.id,
  );
  assert.ok(
    existsSync(join(installed, manifest.exports['.'].types)) &&
      existsSync(join(installed, manifest.exports['./query'].types)),
  );
  const consumer = join(prefix, 'consumer.mts');
  writeFileSync(
    consumer,
    'import { openRepository, type GraphPack } from "@nanthai/forge";\nimport { RepositoryQuery } from "@nanthai/forge/query";\nconst pack: GraphPack = openRepository("fixture").pack;\nconst query = new RepositoryQuery("fixture");\nvoid pack; void query;\n',
  );
  run(
    process.execPath,
    [
      runtimeResolver.resolve('typescript/bin/tsc'),
      '--noEmit',
      '--strict',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--target',
      'ES2022',
      consumer,
    ],
    { cwd: prefix, env },
  );
  const status = () => command('work', owner, '--compact');
  const act = input => command('work', owner, JSON.stringify(input), String(status().revision)).result;
  const intent = act({ action: 'intent', outcome: 'Installed package native workflow' });
  const lane = act({ action: 'lane', intentId: intent.id, name: 'Package Lane' });
  const selected = () => command('work', owner).lanes.find(item => item.id === lane.id);
  const lanePath = selected().path;
  writeFileSync(join(lanePath, 'a.ts'), 'export const answer = 2;\n');
  writeFileSync(join(lanePath, 'binary.bin'), Buffer.from([0, 128, 255]));
  writeFileSync(join(lanePath, 'executable.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const before = selected();
  const checkpoint = act({
    action: 'checkpoint',
    laneId: lane.id,
    expectedHead: before.actualHead,
    expectedTree: before.indexTree,
    message: 'Installed native edit',
  });
  const view = act({
    action: 'compose',
    operationId: randomUUID(),
    intentId: intent.id,
    inputs: [{ laneId: lane.id, head: checkpoint.head }],
  });
  assert.equal(view.status, 'clean');
  const { Client } = await import(
    pathToFileURL(runtimeResolver.resolve('@modelcontextprotocol/sdk/client/index.js'))
  );
  const { StdioClientTransport } = await import(
    pathToFileURL(runtimeResolver.resolve('@modelcontextprotocol/sdk/client/stdio.js'))
  );
  client = new Client({ name: 'forge-package-acceptance', version: '1.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [cli, 'mcp', owner, '--work'],
      env,
      stderr: 'pipe',
    }),
  );
  const tools = (await client.listTools()).tools;
  for (const name of ['forge_current', 'forge_source', 'forge_work_status', 'forge_work_command'])
    assert.ok(tools.some(tool => tool.name === name));
  const call = async (name, arguments_ = {}) => {
    const result = await client.callTool({ name, arguments: arguments_ });
    assert.ok(!result.isError, `Installed MCP ${name} failed`);
    return JSON.parse(result.content[0].text);
  };
  await call('forge_reindex', { laneId: lane.id });
  assert.equal(
    (await call('forge_source', { laneId: lane.id, file: 'a.ts', start: 1, end: 1 })).results[0].text,
    'export const answer = 2;',
  );
  assert.equal((await call('forge_current', { laneId: lane.id })).sourceContext.laneId, lane.id);
  assert.equal((await call('forge_work_status', { compact: true })).nativeHead, initial.head);
  await client.close();
  client = undefined;
  assert.match(run(process.execPath, [cli, 'local-checks', '--help'], { env }), /FORGE_AUTH_TOKEN/);
  const plugin = command('plugin-config', owner, join(prefix, 'forge-plugin'));
  const pluginMcp = JSON.parse(readFileSync(join(plugin.plugin, '.mcp.json'))).mcpServers.forge;
  assert.equal(pluginMcp.command, process.execPath);
  assert.equal(pluginMcp.args[0], cli);
  assert.equal(command('plugin-config', owner, plugin.directory).reused, true);
  const pluginSkill = readFileSync(join(plugin.plugin, 'skills/forge-agent/SKILL.md'), 'utf8');
  assert.ok(readFileSync(new URL(pluginSkill.match(/\[source exchange\]\(([^)]+)\)/)[1])).length > 0);
  client = new Client({ name: 'forge-installed-plugin', version: '1' });
  await client.connect(
    new StdioClientTransport({ command: pluginMcp.command, args: pluginMcp.args, env, stderr: 'pipe' }),
  );
  for (const name of ['forge_task', 'forge_check', 'forge_review', 'forge_work_overview'])
    assert.ok((await client.listTools()).tools.some(tool => tool.name === name));
  const pluginStatus = await call('forge_work_overview', {
    command: { action: 'status', intentId: intent.id },
  });
  assert.equal(pluginStatus.result.lanes.total, 1);
  await client.close();
  client = undefined;
  const acceptance = act({
    action: 'accept-channel',
    operationId: randomUUID(),
    channel: 'main',
    viewId: view.id,
    expectedHead: view.head,
    expectedPrevious: null,
  });
  assert.equal(acceptance.status, 'accepted');
  const inspected = act({ action: 'inspect-native-objects' });
  assert.equal(inspected.candidates.length, 0);
  const collected = act({ action: 'collect-native-objects' });
  assert.equal(collected.removed.length, 0);
  assert.ok(collected.format >= 3);
  const proposal = act({ action: 'export-work', archive: true });
  const original = command('work', owner);
  const incoming = act({
    action: 'import-native-contribution',
    operationId: randomUUID(),
    intentId: intent.id,
    expectedBase: initial.head,
    expectedHead: view.head,
    archivePath: proposal.archive.path,
    archiveSha256: proposal.archive.sha256,
    name: 'Installed source contribution',
  });
  const contributed = command('work', owner);
  assert.equal(contributed.schema, 4);
  assert.equal(contributed.channels[0].head, original.channels[0].head);
  assert.equal(contributed.runs.length, original.runs.length);
  assert.equal(contributed.lanes.find(item => item.id === incoming.id).head, view.head);
  assert.equal(contributed.nativeContributionReceipts[0].archiveSha256, proposal.archive.sha256);
  const backup = act({ action: 'export-work', archive: true });
  const restored = join(directory, 'restored');
  command('restore-native', backup.archive.path, restored);
  const restoredWork = command('work', restored);
  assert.equal(restoredWork.schema, 4);
  assert.equal(restoredWork.nativeContributionReceipts[0].archiveSha256, proposal.archive.sha256);
  assert.equal(restoredWork.nativeHead, initial.head);
  assert.equal(restoredWork.channels[0].head, view.head);
  const restoredLane = restoredWork.lanes.find(item => item.id === lane.id);
  assert.equal(readFileSync(join(restoredLane.path, 'a.ts'), 'utf8'), 'export const answer = 2;\n');
  assert.deepEqual(readFileSync(join(restoredLane.path, 'binary.bin')), Buffer.from([0, 128, 255]));
  assert.ok(statSync(join(restoredLane.path, 'executable.sh')).mode & 0o111);
  assert.equal(existsSync(join(restored, '.env')), false);
  assert.equal(existsSync(join(restored, '.git')), false);
  command('index', restoredLane.path);
  // The shipped skill and ergonomic CLI must work from the installed closure,
  // including original operation recovery in the opt-in versioned Work format.
  assert.match(readFileSync(join(installed, 'skills/forge-agent/SKILL.md'), 'utf8'), /name: forge-agent/);
  assert.match(run(process.execPath, [cli, 'agent', '--help'], { env }), /checkpoint/);
  const agentOwner = join(directory, 'agent-native');
  mkdirSync(agentOwner);
  writeFileSync(join(agentOwner, 'answer.txt'), 'one\n');
  command('init-native', agentOwner);
  command('set-policy', agentOwner, JSON.stringify({ operationId: randomUUID(), preset: 'trusted' }));
  const agent = (action, input = {}) => command('agent', agentOwner, action, JSON.stringify(input)).result;
  const startRequest = { operationId: randomUUID(), outcome: 'Installed agent acceptance' };
  const task = agent('start', startRequest);
  writeFileSync(join(task.path, 'answer.txt'), 'two\n');
  const agentCheckpoint = agent('checkpoint', {
    operationId: randomUUID(),
    laneId: task.laneId,
    expectedHead: task.head,
    message: 'Installed agent edit',
  });
  const agentView = agent('compose', {
    operationId: randomUUID(),
    intentId: task.intentId,
    inputs: [{ laneId: task.laneId, head: agentCheckpoint.head }],
  });
  const agentCheck = agent('define-check', {
    name: 'Installed agent check',
    executable: process.execPath,
    args: [
      '-e',
      "if(require('fs').readFileSync('answer.txt','utf8')!=='two\\n')process.exit(1);console.log('installed-agent-checked')",
    ],
  });
  const runRequest = {
    operationId: randomUUID(),
    viewId: agentView.viewId,
    expectedHead: agentView.head,
    checkId: agentCheck.checkId,
  };
  const checked = agent('run', runRequest);
  assert.equal(checked.status, 'passed');
  assert.equal(checked.checkDefinition, agentCheck.definition);
  assert.equal(checked.environmentFingerprint.length, 64);
  assert.deepEqual(agent('run', runRequest), checked);
  const agentAccepted = agent('accept', {
    operationId: randomUUID(),
    viewId: agentView.viewId,
    expectedHead: agentView.head,
    expectedPrevious: null,
  });
  assert.equal(agentAccepted.head, agentView.head);
  const nextTask = agent('start', { operationId: randomUUID(), outcome: 'Installed agent finish' });
  writeFileSync(join(nextTask.path, 'answer.txt'), 'three\n');
  const finishCheck = agent('define-check', {
    name: 'Installed finish check',
    executable: process.execPath,
    args: [
      '-e',
      "if(require('fs').readFileSync('answer.txt','utf8')!=='three\\n')process.exit(1);console.log('installed-finish-checked')",
    ],
  });
  const finishRequest = {
    operationId: randomUUID(),
    laneId: nextTask.laneId,
    expectedHead: nextTask.head,
    message: 'Installed finish edit',
    checkId: finishCheck.checkId,
    expectedDefinition: finishCheck.definition,
    accept: { expectedPrevious: agentView.head },
  };
  const finished = agent('finish', finishRequest);
  assert.equal(finished.complete, true);
  assert.equal(finished.status, 'accepted');
  assert.equal(finished.run.status, 'passed');
  assert.equal(finished.run.runId, finished.run.operationId);
  assert.equal(finished.acceptance.acceptanceId, finished.acceptance.operationId);
  assert.deepEqual(agent('finish', finishRequest), finished);
  const agentWork = command('work', agentOwner, '--compact');
  assert.equal(agentWork.schema, 7);
  assert.equal(agentWork.runs.length, 2);
  const agentBackup = command(
    'work',
    agentOwner,
    JSON.stringify({ action: 'export-work', archive: true }),
    String(agentWork.revision),
  ).result;
  const agentRestored = join(directory, 'agent-restored');
  command('restore-native', agentBackup.archive.path, agentRestored);
  const agentRecovered = command('work', agentRestored, '--compact');
  assert.equal(agentRecovered.schema, 7);
  assert.equal(
    command('agent', agentRestored, 'start', JSON.stringify(startRequest)).result.laneId,
    task.laneId,
  );
  assert.deepEqual(command('agent', agentRestored, 'run', JSON.stringify(runRequest)).result, checked);
  assert.equal(agentRecovered.channels[0].head, finished.view.head);
  assert.deepEqual(command('agent', agentRestored, 'finish', JSON.stringify(finishRequest)).result, {
    ...finished,
    checkpoint: { ...finished.checkpoint, path: join(agentRestored, '.forge/work/lane-' + nextTask.laneId) },
  });
  const output = join(directory, 'browser.stdout'),
    errors = join(directory, 'browser.stderr');
  const out = openSync(output, 'wx', 0o600),
    err = openSync(errors, 'wx', 0o600);
  server = spawn(process.execPath, [cli, 'serve', restoredLane.path, '--port', '0'], {
    cwd: directory,
    env,
    detached: true,
    stdio: ['ignore', out, err],
  });
  closeSync(out);
  closeSync(err);
  server.unref();
  let url;
  for (let attempt = 0; attempt < 300; attempt++) {
    url = readFileSync(output, 'utf8').match(/http:\/\/127\.0\.0\.1:\d+\/#token=[0-9a-f]+/)?.[0];
    if (url) break;
    assert.equal(server.exitCode, null, readFileSync(errors, 'utf8'));
    await pause(50);
  }
  assert.ok(url, 'Installed local server did not start.');
  const address = new URL(url),
    token = new URLSearchParams(address.hash.slice(1)).get('token');
  const headers = { Authorization: `Bearer ${token}` };
  assert.equal((await fetch(`${address.origin}/api/work`)).status, 401);
  const webWork = await fetch(`${address.origin}/api/work?compact=true`, { headers }).then(response =>
    response.json(),
  );
  assert.equal(webWork.channels[0].head, view.head);
  for (const path of ['/', '/api/source?file=a.ts'])
    assert.equal((await fetch(`${address.origin}${path}`, { headers })).status, 404, `${path} is not served`);
  assert.equal(existsSync(gitCalled), false, 'Native installed workflow invoked Git.');
  const result = {
    package: manifest.name,
    version: manifest.version,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    archive: packed.filename,
    bytes: statSync(archive).size,
    sha256: hash(readFileSync(archive)),
    files: names,
    lifecycleScripts: 'disabled during pack/install',
    installedDependencyPins: 'passed',
    registryInstall: 'offline with initially empty cache',
    notices: 'installed locked production closure verified; static original documents byte-identical',
    noticeSummary,
    noticeNegativeChecks:
      'corrupted aggregate, missing upstream license and absent required dependency rejected',
    nativeComponentNotices: {
      coverage: 'PARTIAL',
      originalMembers: 39,
      installedSourceAndManifestBytes: 'verified',
      executableRedistribution: false,
      binarySbom: false,
    },
    sourceState: initial.head,
    candidateState: view.head,
    viewId: view.id,
    acceptanceId: acceptance.id,
    restoredSchema: restoredWork.schema,
    gitCalls: 0,
    sdk: 'passed',
    sdkTypes: 'passed',
    cli: 'passed',
    mcp: 'passed',
    nativeRecovery: 'passed',
    agentWorkflow: {
      skill: 'installed byte-identical',
      cli: 'passed without SDK scripts or indexing',
      originalRunReplay: 'passed',
      schema7Recovery: 'passed',
      finish: {
        status: finished.status,
        replay: 'passed',
        runId: finished.run.runId,
        acceptanceId: finished.acceptance.acceptanceId,
        viewId: finished.view.viewId,
        head: finished.view.head,
      },
      viewId: agentView.viewId,
      head: agentView.head,
    },
    browserAssetsAndApi: 'passed',
    browserRendering: 'unrun',
    registryPublication: 'unrun',
    retained: !!kept,
  };
  writeFileSync(join(directory, 'acceptance.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  if (sessionPath)
    writeFileSync(
      resolve(sessionPath),
      `${JSON.stringify({ url, pid: server.pid, directory, installed, sourceRoot: restoredLane.path, acceptance: join(directory, 'acceptance.json') }, null, 2)}\n`,
      { mode: 0o600 },
    );
  success = true;
  const { files: packageFiles, ...summary } = result;
  console.log(JSON.stringify({ ...summary, fileCount: packageFiles.length }, null, 2));
} finally {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  delete process.env.FORGE_PACKAGE_GIT_CALLED;
  await client?.close();
  if (server && (!success || !sessionPath)) {
    try {
      process.kill(server.pid, 'SIGTERM');
    } catch {
      /* Already exited. */
    }
  }
  if (!kept) rmSync(directory, { recursive: true, force: true });
}
