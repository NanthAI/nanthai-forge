// SPDX-License-Identifier: Apache-2.0
// Standard code verification: installs and exercises the actual local npm archive.
import assert from 'node:assert/strict';
import { cleanupOwner } from '../tests/owner-cleanup.mjs';
import { Worker } from 'node:worker_threads';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
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
  args.length === 0 || (args.length === 2 && args[0] === '--artifact-dir'),
  'Use --artifact-dir NEW_DIRECTORY.',
);
const kept = option('--artifact-dir');
let directory = kept ? resolve(kept) : mkdtempSync(join(tmpdir(), 'forge-package-'));
if (kept) {
  assert.equal(existsSync(directory), false, 'Artifact directory must be new.');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
}
directory = realpathSync(directory);
const npm = process.env.npm_execpath || createRequire(import.meta.url).resolve('npm/bin/npm-cli.js');
const buildEnv = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const originalPath = process.env.PATH;
let client, releaseService;
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
  const runtimeScripts = JSON.parse(readFileSync(join(root, 'package.json'))).files.filter(file =>
    file.startsWith('scripts/'),
  );
  for (const file of runtimeScripts) assert.ok(names.includes(file), `Missing package runtime: ${file}`);
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
      notices.includes(file) ||
        runtimeScripts.includes(file) ||
        file.startsWith('node_modules/') ||
        /^dist\/[^/]+\.(?:js|d\.ts)$/.test(file) ||
        // The speed budget file (b7851c44), read by the CLI's metrics report.
        file === 'dist/speed-budgets.json',
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
    manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')),
    cli = join(installed, manifest.bin.nforge);
  assert.equal(realpathSync(join(prefix, 'node_modules', '.bin', 'nforge')), realpathSync(cli));
  assert.ok(statSync(cli).mode & 0o111, 'Installed CLI must be executable.');
  for (const notice of [...notices, ...runtimeScripts].filter(
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
  assert.equal(manifest.engines.node, '>=24.22.1 <25');
  const bin = join(directory, 'no-git');
  mkdirSync(bin);
  const gitCalled = join(directory, 'git-called');
  writeFileSync(join(bin, 'git'), '#!/bin/sh\n/usr/bin/touch "$FORGE_PACKAGE_GIT_CALLED"\nexit 91\n', {
    mode: 0o700,
  });
  symlinkSync(process.execPath, join(bin, 'node'));
  for (const name of ['tar', 'gzip']) symlinkSync(`/usr/bin/${name}`, join(bin, name));
  const home = join(directory, 'synthetic-home');
  mkdirSync(home);
  const env = {
    PATH: bin,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    FORGE_TEST_MODE: '1',
    FORGE_PACKAGE_GIT_CALLED: gitCalled,
  };
  const unconfiguredHelp = spawnSync(process.execPath, [cli, '--help'], { env, encoding: 'utf8' });
  assert.equal(unconfiguredHelp.status, 0, unconfiguredHelp.stderr);
  assert.match(unconfiguredHelp.stdout, /nforge host ROOT/);
  // Valid work needs a release source; --version only prints (381c62df), so probe with a real command.
  const unconfigured = spawnSync(process.execPath, [cli, 'queue', 'list'], { env, encoding: 'utf8' });
  assert.equal(unconfigured.status, 1);
  assert.equal(JSON.parse(unconfigured.stderr).error.code, 'CLI_UPDATE_SOURCE_REQUIRED');
  const installation = join(directory, 'forge-cli');
  mkdirSync(join(installation, 'builds'), { recursive: true });
  symlinkSync(installed, join(installation, 'current'), 'dir');
  symlinkSync(installed, join(installation, 'manager'), 'dir');
  copyFileSync(join(installed, 'dist', 'cli-launcher.js'), join(installation, 'launcher.mjs'));
  writeFileSync(join(installed, '.cli-installation'), installation);
  const head = 'a'.repeat(64),
    projectId = 'synthetic-cli-source';
  writeFileSync(join(installed, '.commit'), head);
  const releaseCalls = new Int32Array(new SharedArrayBuffer(4));
  releaseService = new Worker(new URL('./package-cli-release-worker.mjs', import.meta.url), {
    workerData: { head, projectId, calls: releaseCalls.buffer },
  });
  const releaseUrl = await new Promise((done, reject) => {
    releaseService.once('message', done);
    releaseService.once('error', reject);
  });
  writeFileSync(join(installation, 'source.json'), JSON.stringify({ url: releaseUrl, projectId }));
  env.FORGE_AUTH_TOKEN = 'synthetic-package-release-token';

  // In-process public SDK calls receive the same unavailable Git boundary as CLI/MCP.
  process.env.PATH = bin;
  process.env.FORGE_PACKAGE_GIT_CALLED = gitCalled;
  const command = (...argv) => JSON.parse(run(process.execPath, [cli, ...argv], { env }));
  assert.match(run(join(prefix, 'node_modules', '.bin', 'nforge'), ['--help'], { env }), /nforge host ROOT/);
  assert.equal(Atomics.load(releaseCalls, 0), 0, 'Installed help must make zero release reads.');
  run(join(prefix, 'node_modules', '.bin', 'nforge'), ['--version'], { env });
  assert.equal(Atomics.load(releaseCalls, 0), 0, 'Installed --version only prints: zero release reads.');
  run(join(prefix, 'node_modules', '.bin', 'nforge'), ['docs'], { env });
  assert.equal(Atomics.load(releaseCalls, 0), 1, 'Valid installed work retains one freshness read.');
  const beforeLauncher = Atomics.load(releaseCalls, 0);
  assert.match(
    run(process.execPath, [join(installation, 'launcher.mjs'), '--help'], { env }),
    /nforge host ROOT/,
  );
  assert.equal(
    Atomics.load(releaseCalls, 0) - beforeLauncher,
    0,
    'Stable launcher help must make zero release reads.',
  );
  run(process.execPath, [join(installation, 'launcher.mjs'), '--version'], { env });
  assert.equal(
    Atomics.load(releaseCalls, 0) - beforeLauncher,
    0,
    'Stable launcher --version makes zero release reads.',
  );
  run(process.execPath, [join(installation, 'launcher.mjs'), 'docs'], { env });
  assert.equal(
    Atomics.load(releaseCalls, 0) - beforeLauncher,
    1,
    'Stable launcher valid work retains one per-process release read.',
  );
  const owner = join(directory, 'project');
  mkdirSync(owner);
  writeFileSync(join(owner, 'a.ts'), 'export const answer = 1;\n');
  writeFileSync(join(owner, 'README.md'), '# Package acceptance\n');
  writeFileSync(join(owner, '.env'), 'PACKAGE_SYNTHETIC_SECRET=excluded\n', { mode: 0o600 });
  // A hosted checkout has no Git metadata; its local code index must not need Git either.
  mkdirSync(join(owner, '.forge'));
  writeFileSync(
    join(owner, '.forge', 'hosted-main.json'),
    JSON.stringify({ selection: { schema: 1, projectId: 'package-synthetic-project', channel: 'main' } }),
  );
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
  const { Client } = await import(
    pathToFileURL(runtimeResolver.resolve('@modelcontextprotocol/sdk/client/index.js'))
  );
  const { StdioClientTransport } = await import(
    pathToFileURL(runtimeResolver.resolve('@modelcontextprotocol/sdk/client/stdio.js'))
  );
  client = new Client({ name: 'forge-package-acceptance', version: '1.0.0' });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', owner], env, stderr: 'pipe' }),
  );
  const tools = (await client.listTools()).tools;
  for (const name of ['forge_current', 'forge_source', 'forge_reindex'])
    assert.ok(tools.some(tool => tool.name === name));
  const call = async (name, arguments_ = {}) => {
    const result = await client.callTool({ name, arguments: arguments_ });
    assert.ok(!result.isError, `Installed MCP ${name} failed`);
    return JSON.parse(result.content[0].text);
  };
  assert.equal(
    (await call('forge_source', { file: 'a.ts', start: 1, end: 1 })).results[0].text,
    'export const answer = 1;',
  );
  await client.close();
  client = undefined;
  const plugin = command('plugin-config', owner, join(prefix, 'forge-plugin'));
  const pluginMcp = JSON.parse(readFileSync(join(plugin.plugin, '.mcp.json'))).mcpServers.forge;
  assert.equal(pluginMcp.command, process.execPath);
  assert.equal(pluginMcp.args[0], cli);
  assert.equal(command('plugin-config', owner, plugin.directory).reused, true);
  const pluginSkill = readFileSync(join(plugin.plugin, 'skills/forge-agent/SKILL.md'), 'utf8');
  assert.ok(readFileSync(new URL(pluginSkill.match(/\[hosted parity\]\(([^)]+)\)/)[1])).length > 0);
  // One client mode: a folder without a hosted marker is refused with the nforge host next step.
  const plain = join(directory, 'plain');
  mkdirSync(plain);
  const refused = spawnSync(process.execPath, [cli, 'agent', plain, 'status', '{}'], {
    env,
    encoding: 'utf8',
  });
  assert.equal(refused.status, 1);
  const refusal = JSON.parse(refused.stderr).error;
  assert.equal(refusal.code, 'FORGE_ROOT_UNAVAILABLE');
  assert.match(refusal.message, /nforge host/);
  assert.match(readFileSync(join(installed, 'skills/forge-agent/SKILL.md'), 'utf8'), /name: forge-agent/);
  assert.equal(existsSync(gitCalled), false, 'Installed source workflow invoked Git.');
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
    gitCalls: 0,
    sdk: 'passed',
    sdkTypes: 'passed',
    cli: 'passed',
    mcp: 'passed',
    hostedOnlyRefusal: 'passed',
    registryPublication: 'unrun',
    retained: !!kept,
  };
  writeFileSync(join(directory, 'acceptance.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  const { files: packageFiles, ...summary } = result;
  console.log(JSON.stringify({ ...summary, fileCount: packageFiles.length }, null, 2));
} finally {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  delete process.env.FORGE_PACKAGE_GIT_CALLED;
  await client?.close();
  await releaseService?.terminate();
  if (!kept) await cleanupOwner(directory, join(directory, 'installed/node_modules/@nanthai/forge/dist'));
}
