// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import {
  githubRepositoryOf,
  materializeSubmodules,
  submoduleFetchUrl,
  tokenHeader,
} from '../dist/submodule-materialize.js';
import { submoduleAccess } from '../dist/hosted-actions-job-source.js';
import {
  directCommandSchema,
  submoduleAccessReplySchema,
  submoduleRepositoryName,
} from '../dist/hosted-actions-direct.js';
import {
  actionsCommandForCapabilities,
  actionsSubmoduleAccessCapability,
  hostedActionsCapabilities,
} from '../dist/hosted-actions-capabilities.js';
import { digest } from '../dist/hash.js';
import {
  mergeSubmoduleAllowlist,
  submoduleAllowChangesSchema,
  submoduleAllowLimit,
  submoduleDecision,
} from '../dist/submodule-allowlist.js';

const { submoduleReadTokens, submoduleRepositoryLimit } = await import(
  moduleUrl('../convex/githubAppToken.ts')
);

const token = 'synthetic-installation-token';
const gitEnv = cwd => ({
  PATH: process.env.PATH,
  HOME: cwd,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
});
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv(cwd) }).trim();

/** A local Git smart-HTTP server standing in for GitHub: `/private/*` repositories need the
 * installation token as Basic auth (as GitHub does for a private repository), `/public/*` none. */
async function fakeGithub(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-private-submodule-'));
  const seen = [];
  const repo = (owner, name, text) => {
    const work = join(root, 'work', `${owner}-${name}`);
    mkdirSync(work, { recursive: true });
    git(work, 'init', '-q', '-b', 'main');
    writeFileSync(join(work, 'secret.c'), text);
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', name);
    const bare = join(root, 'srv', owner, name);
    mkdirSync(join(root, 'srv', owner), { recursive: true });
    git(root, 'clone', '-q', '--bare', work, bare);
    git(bare, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
    return git(work, 'rev-parse', 'HEAD');
  };
  const priv = repo('NanthAI', 'priv', 'int priv;\n');
  const pub = repo('NanthAI', 'pub', 'int pub;\n');
  const server = createServer((request, response) => {
    const path = request.url.split('?')[0];
    const authorization = request.headers.authorization ?? null;
    seen.push({ path, authorization });
    const needsAuth = path.startsWith('/NanthAI/priv/');
    if (
      needsAuth &&
      authorization?.replace(/^basic /i, 'Basic ') !==
        `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
    ) {
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="synthetic"' }).end();
      return;
    }
    const backend = spawn(
      join(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), 'git-http-backend'),
      {
        env: {
          PATH: process.env.PATH,
          GIT_PROJECT_ROOT: join(root, 'srv'),
          GIT_HTTP_EXPORT_ALL: '1',
          REQUEST_METHOD: request.method,
          PATH_INFO: path,
          QUERY_STRING: request.url.split('?')[1] ?? '',
          CONTENT_TYPE: request.headers['content-type'] ?? '',
          ...(request.headers['content-length'] ? { CONTENT_LENGTH: request.headers['content-length'] } : {}),
          ...(request.headers['git-protocol'] ? { GIT_PROTOCOL: request.headers['git-protocol'] } : {}),
          REMOTE_USER: 'fixture',
        },
      },
    );
    request.pipe(backend.stdin);
    const chunks = [];
    backend.stdout.on('data', chunk => chunks.push(chunk));
    backend.on('close', () => {
      const out = Buffer.concat(chunks),
        split = out.indexOf('\r\n\r\n');
      const headers = Object.fromEntries(
        out
          .subarray(0, split)
          .toString()
          .split('\r\n')
          .map(line => line.split(/: (.*)/s).slice(0, 2)),
      );
      response.writeHead(Number(headers.Status?.split(' ')[0] ?? 200), headers).end(out.subarray(split + 4));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, seen, base: `http://127.0.0.1:${server.address().port}`, priv, pub };
}

function workspace(t, modules, links) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-private-workspace-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const objects = new Map(),
    files = [];
  const put = (path, text, mode = 'file') => {
    const bytes = Buffer.from(text),
      blob = digest(bytes);
    objects.set(blob, bytes);
    files.push({ path, blob, mode });
    mkdirSync(join(directory, path, '..'), { recursive: true });
    writeFileSync(join(directory, path), bytes);
  };
  put('.gitmodules', modules);
  for (const link of links) put(link.path, link.commit, 'gitlink');
  return { directory, files, read: async blob => objects.get(blob) };
}

const cache = t => {
  const path = mkdtempSync(join(tmpdir(), 'forge-private-cache-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
};
const sandbox = t => {
  process.env.FORGE_TEST_SUBMODULE_FILE_URLS = '1';
  t.after(() => delete process.env.FORGE_TEST_SUBMODULE_FILE_URLS);
};
const everyFile = directory =>
  readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => readFileSync(join(entry.parentPath, entry.name), 'utf8'));

test('a private same-installation submodule materializes with a one-repository token; public ones never ask', async t => {
  sandbox(t);
  const github = await fakeGithub(t);
  const s = workspace(
    t,
    `[submodule "p"]\n\tpath = vendor/priv\n\turl = ${github.base}/NanthAI/priv\n[submodule "q"]\n\tpath = vendor/pub\n\turl = ${github.base}/NanthAI/pub\n`,
    [
      { path: 'vendor/priv', commit: github.priv },
      { path: 'vendor/pub', commit: github.pub },
    ],
  );
  const asked = [];
  const done = await materializeSubmodules(s.directory, s.files, s.read, {
    cache: cache(t),
    access: async repositories => {
      asked.push(repositories);
      return Object.fromEntries(repositories.map(name => [name, { token }]));
    },
  });
  assert.deepEqual(
    done.map(item => item.path),
    ['vendor/priv', 'vendor/pub'],
  );
  assert.equal(readFileSync(join(s.directory, 'vendor/priv/secret.c'), 'utf8'), 'int priv;\n');
  assert.equal(readFileSync(join(s.directory, 'vendor/pub/secret.c'), 'utf8'), 'int pub;\n');
  // Exactly the private repository was named, once; the public one was fetched anonymously.
  assert.deepEqual(asked, [['NanthAI/priv']]);
  assert(
    github.seen.filter(r => r.path.startsWith('/NanthAI/pub/')).every(r => r.authorization === null),
    'the token never goes to another repository',
  );
  assert(github.seen.some(r => r.path.startsWith('/NanthAI/priv/') && r.authorization !== null));
  // The token is only in the fetch's environment: not in the workspace or the cache's config.
  for (const text of [...everyFile(s.directory)]) assert(!text.includes(token));
});

test('the token header names exactly one repository URL and is not a command-line argument', () => {
  const header = tokenHeader('https://github.com/NanthAI/priv.git/', token);
  assert.equal(header.GIT_CONFIG_COUNT, '1');
  assert.equal(header.GIT_CONFIG_KEY_0, 'http.https://github.com/NanthAI/priv.git.extraheader');
  assert.equal(
    header.GIT_CONFIG_VALUE_0,
    `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
  );
});

test('a repository outside the installation, or unreachable access, refuses clearly and writes nothing', async t => {
  sandbox(t);
  const github = await fakeGithub(t);
  const link = `[submodule "p"]\n\tpath = vendor/priv\n\turl = ${github.base}/NanthAI/priv\n`;
  const attempt = async access => {
    const s = workspace(t, link, [{ path: 'vendor/priv', commit: github.priv }]);
    const error = await materializeSubmodules(s.directory, s.files, s.read, {
      cache: cache(t),
      ...(access ? { access } : {}),
    }).catch(error => error);
    assert.equal(error.code, 'SUBMODULE_NOT_MATERIALIZED');
    assert.equal(
      readFileSync(join(s.directory, 'vendor/priv'), 'utf8'),
      github.priv,
      'the pointer file is kept',
    );
    return error;
  };
  const outside = await attempt(async () => ({ 'NanthAI/priv': { refused: 'outside-installation' } }));
  assert.equal(outside.recovery.refusals[0].reason, 'outside-installation');
  assert.match(outside.message, /vendor\/priv/);
  assert.match(outside.message, /not in the project's GitHub App installation/);
  // Not allowed by the owner, or public check logs: the refusal names the owner's exact command.
  const denied = await attempt(async () => ({ 'NanthAI/priv': { refused: 'not-allowed' } }));
  assert.equal(denied.recovery.refusals[0].reason, 'not-allowed');
  assert.equal(denied.recovery.refusals[0].repository, 'NanthAI/priv');
  assert(
    denied.message.includes(
      `nforge agent ROOT configure-runner '{"provider":"github-actions","submodules":{"NanthAI/priv":true}}'`,
    ),
  );
  assert.match(denied.message, /project owner has not allowed checks to read NanthAI\/priv/);
  const exposed = await attempt(async () => ({ 'NanthAI/priv': { refused: 'public-logs' } }));
  assert.equal(exposed.recovery.refusals[0].reason, 'public-logs');
  assert.match(exposed.message, /check logs are public/);
  assert(exposed.message.includes(`"submodules":{"NanthAI/priv":"public-logs"}`));
  assert.equal(
    (await attempt(async () => ({ 'NanthAI/priv': { refused: 'unavailable' } }))).recovery.refusals[0].reason,
    'access-unavailable',
  );
  assert.equal(
    (await attempt(async () => Promise.reject(new Error('down')))).recovery.refusals[0].reason,
    'access-unavailable',
  );
  assert.equal((await attempt(async () => ({}))).recovery.refusals[0].reason, 'access-unavailable');
  // A token that GitHub does not accept, or a runner with no access path, stays a fetch failure.
  assert.equal(
    (await attempt(async () => ({ 'NanthAI/priv': { token: 'wrong' } }))).recovery.refusals[0].reason,
    'fetch-failed',
  );
  assert.equal((await attempt(undefined)).recovery.refusals[0].reason, 'fetch-failed');
});

test('a relative .gitmodules URL resolves against the project repository, then private access applies', async t => {
  sandbox(t);
  const github = await fakeGithub(t);
  assert.equal(
    githubRepositoryOf(submoduleFetchUrl('../priv.git', 'https://github.com/NanthAI/app').url),
    'NanthAI/priv',
  );
  assert.equal(githubRepositoryOf('https://example.invalid/NanthAI/priv'), null);
  assert.equal(githubRepositoryOf('https://github.com/NanthAI'), null);
  const s = workspace(t, '[submodule "p"]\n\tpath = vendor/priv\n\turl = ../priv\n', [
    { path: 'vendor/priv', commit: github.priv },
  ]);
  const asked = [];
  await assert.rejects(
    materializeSubmodules(s.directory, s.files, s.read, { cache: cache(t) }),
    error => error.recovery.refusals[0].reason === 'relative-url-without-origin',
  );
  await materializeSubmodules(s.directory, s.files, s.read, {
    cache: cache(t),
    origin: `${github.base}/NanthAI/app`,
    access: async repositories => {
      asked.push(repositories);
      return { 'NanthAI/priv': { token } };
    },
  });
  assert.deepEqual(asked, [['NanthAI/priv']]);
  assert.equal(readFileSync(join(s.directory, 'vendor/priv/secret.c'), 'utf8'), 'int priv;\n');
  assert(!existsSync(join(s.directory, 'vendor/priv/.git')));
});

test('the Actions job asks only when the server advertises the capability, and treats failures as unavailable', async () => {
  assert.equal(submoduleAccess({ capabilities: [] }), undefined);
  assert(hostedActionsCapabilities.includes(actionsSubmoduleAccessCapability));
  const calls = [];
  const client = reply => ({
    capabilities: [actionsSubmoduleAccessCapability],
    call: async command => {
      calls.push(command);
      return reply instanceof Error ? Promise.reject(reply) : reply;
    },
  });
  const ok = await submoduleAccess(client({ 'a/b': { token } }))(['a/b']);
  assert.deepEqual(ok, { 'a/b': { token } });
  assert.deepEqual(calls[0], { kind: 'submoduleAccess', repositories: ['a/b'] });
  for (const bad of [
    new Error('refused'),
    { 'a/b': { token, extra: 1 } },
    'text',
    { 'a/b': { refused: 'x' } },
  ])
    assert.deepEqual(await submoduleAccess(client(bad))(['a/b']), { 'a/b': { refused: 'unavailable' } });
  const cancelled = Object.assign(new Error('cancelled'), { code: 'CHECK_CANCELLED' });
  await assert.rejects(submoduleAccess(client(cancelled))(['a/b']), { code: 'CHECK_CANCELLED' });
});

test('the wire command is bounded and gated by the capability', () => {
  const command = { kind: 'submoduleAccess', repositories: ['NanthAI/priv'] };
  assert.equal(directCommandSchema.safeParse(command).success, true);
  for (const repositories of [[], ['../x'], ['a/b/c'], ['a'], Array.from({ length: 9 }, (_, i) => `a/b${i}`)])
    assert.equal(directCommandSchema.safeParse({ ...command, repositories }).success, false);
  assert.equal(submoduleRepositoryName.safeParse('NanthAI/priv.js').success, true);
  assert.throws(() => actionsCommandForCapabilities(command, []), { code: 'RUNNER_UNAVAILABLE' });
  assert.deepEqual(actionsCommandForCapabilities(command, [actionsSubmoduleAccessCapability]), command);
  assert.equal(
    submoduleAccessReplySchema.safeParse({ 'a/b': { token, refused: 'unavailable' } }).success,
    false,
  );
  for (const refused of ['not-allowed', 'public-logs'])
    assert.equal(submoduleAccessReplySchema.safeParse({ 'a/b': { refused } }).success, true);
});

test('the owner allowlist merges changes, refuses by default and needs a public-logs grant for public logs', () => {
  assert.equal(submoduleDecision(undefined, 'a/b', false), 'not-allowed');
  assert.equal(submoduleDecision([], 'a/b', false), 'not-allowed');
  const list = mergeSubmoduleAllowlist(undefined, { 'Acme/Lib': true, 'acme/open': 'public-logs' });
  assert.deepEqual(list, [{ repository: 'Acme/Lib' }, { repository: 'acme/open', publicLogs: true }]);
  assert.equal(submoduleDecision(list, 'acme/lib', false), 'allowed'); // GitHub names ignore case
  assert.equal(submoduleDecision(list, 'acme/lib', true), 'public-logs');
  assert.equal(submoduleDecision(list, 'acme/open', true), 'allowed');
  assert.equal(submoduleDecision(list, 'acme/other', false), 'not-allowed');
  // A change replaces one entry and keeps the others; false removes; empty stores nothing.
  assert.deepEqual(mergeSubmoduleAllowlist(list, { 'acme/lib': 'public-logs' }), [
    { repository: 'acme/lib', publicLogs: true },
    { repository: 'acme/open', publicLogs: true },
  ]);
  assert.equal(mergeSubmoduleAllowlist(list, { 'acme/lib': false, 'ACME/OPEN': false }), undefined);
  assert.deepEqual(
    mergeSubmoduleAllowlist(undefined, { 'b/b': true, 'a/a': true }),
    mergeSubmoduleAllowlist(undefined, { 'a/a': true, 'b/b': true }),
  );
  assert.throws(() =>
    mergeSubmoduleAllowlist(
      undefined,
      Object.fromEntries(Array.from({ length: submoduleAllowLimit + 1 }, (_, i) => [`a/r${i}`, true])),
    ),
  );
  assert.equal(submoduleAllowChangesSchema.safeParse({ '../x': true }).success, false);
  assert.equal(submoduleAllowChangesSchema.safeParse({ 'a/b': 'yes' }).success, false);
});

test('server: one read-only token per owner-allowed repository, only inside the project installation', async t => {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const saved = ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'FORGE_GITHUB_REPO_BINDINGS'].map(name => [
    name,
    process.env[name],
  ]);
  t.after(() => {
    for (const [name, value] of saved)
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });
  process.env.GITHUB_APP_ID = '123';
  process.env.GITHUB_APP_PRIVATE_KEY = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
  process.env.FORGE_GITHUB_REPO_BINDINGS = 'p1=synthetic/mirror';
  const calls = [];
  const request = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: init.method ?? 'GET', body: init.body && JSON.parse(init.body) });
    if (path === '/repos/synthetic/mirror/installation' || path === '/repos/synthetic/priv/installation')
      return new Response(JSON.stringify({ id: 42 }));
    if (path === '/repos/other/stranger/installation') return new Response(JSON.stringify({ id: 7 }));
    if (path === '/repos/synthetic/missing/installation') return new Response('{}', { status: 404 });
    if (path === '/repos/synthetic/broken/installation') return new Response('{}', { status: 500 });
    if (path === '/app/installations/42/access_tokens')
      return new Response(JSON.stringify({ token: 'synthetic-only-token' }));
    throw new Error(`unexpected ${path}`);
  };
  const everything = ['synthetic/priv', 'other/stranger', 'synthetic/missing', 'synthetic/broken'].map(
    repository => ({ repository }),
  );
  const run = (names, policy = { submodules: everything, logsPublic: false }) =>
    submoduleReadTokens({}, 'p1', 'synthetic/mirror', names, policy, request, 1_000_000);
  const minted = () =>
    calls.filter(
      call => call.path === '/app/installations/42/access_tokens' && call.body.permissions.contents,
    );
  // Not allowed (the default, an empty list): refused before any GitHub call.
  assert.deepEqual(await run(['synthetic/priv'], { submodules: [], logsPublic: false }), {
    'synthetic/priv': { refused: 'not-allowed' },
  });
  assert.deepEqual(calls, []);
  const result = await run([
    'synthetic/priv',
    'other/stranger',
    'synthetic/missing',
    'synthetic/priv',
    'synthetic/unlisted',
  ]);
  assert.deepEqual(result, {
    'synthetic/priv': { token: 'synthetic-only-token' },
    'other/stranger': { refused: 'outside-installation' },
    'synthetic/missing': { refused: 'outside-installation' },
    'synthetic/unlisted': { refused: 'not-allowed' },
  });
  const mints = minted();
  assert.equal(mints.length, 1, 'refused repositories mint nothing');
  assert.deepEqual(mints[0].body, { repositories: ['priv'], permissions: { contents: 'read' } });
  // 1 project lookup + lookup per distinct allowed repository + 1 mint; the duplicate and
  // the unlisted one cost nothing.
  assert.equal(calls.length, 1 + 3 + 1);
  assert(!calls.some(call => call.path.includes('unlisted')));

  // Public check logs: refused unless the owner also allowed that repository for public logs,
  // before any GitHub call.
  calls.length = 0;
  assert.deepEqual(await run(['synthetic/priv'], { submodules: everything, logsPublic: true }), {
    'synthetic/priv': { refused: 'public-logs' },
  });
  assert.deepEqual(calls, []);
  const publicGrant = { submodules: [{ repository: 'synthetic/priv', publicLogs: true }], logsPublic: true };
  assert.deepEqual(await run(['synthetic/priv'], publicGrant), {
    'synthetic/priv': { token: 'synthetic-only-token' },
  });
  assert.equal(minted().length, 1);
  // GitHub failures other than "not installed" are errors, never silently refused.
  await assert.rejects(run(['synthetic/broken']), { code: 'GITHUB_SYNC_API' });
  // Malformed and unbounded requests, or an unbound project, never reach GitHub.
  const before = calls.length;
  await assert.rejects(run(['../x/y']), { code: 'BAD_REPOSITORY' });
  await assert.rejects(run([]), { code: 'BAD_ARGUMENT' });
  await assert.rejects(
    run(Array.from({ length: submoduleRepositoryLimit + 1 }, (_, i) => `synthetic/r${i}`)),
    { code: 'BAD_ARGUMENT' },
  );
  await assert.rejects(
    submoduleReadTokens(
      { runQuery: async () => JSON.stringify({ page: [], isDone: true, continueCursor: '' }) },
      'p2',
      'synthetic/mirror',
      ['synthetic/priv'],
      { submodules: everything, logsPublic: false },
      request,
      1_000_000,
    ),
    { code: 'GITHUB_REPOSITORY_UNBOUND' },
  );
  assert(calls.slice(before).every(call => call.path !== '/app/installations/42/access_tokens'));
});
