// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { on } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parse } from 'smol-toml';
import ts from 'typescript';
import { agentConnect } from '../dist/agent-connect-cli.js';
import { recordAgentConnection } from '../dist/agent-connect-receipt.js';
import { installEditHooks } from '../dist/agent-install-hooks.js';
import { temporaryDirectory } from '../scripts/test-temp.mjs';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { mcpTestEnvironment, requestOptions } from './mcp-runtime.mjs';

const connections = await import(moduleUrl('../convex/agentConnections.ts'));
const cli = resolve('dist/cli-entry.js');
const address = { url: 'https://connect-fixture.example.test', projectId: 'synthetic-project' };

function checkout(t) {
  const root = realpathSync(temporaryDirectory(t, 'forge-connect-'));
  const agent = join(`${root}.forge-client`, 'agent');
  mkdirSync(agent, { recursive: true });
  writeFileSync(join(agent, 'address.json'), JSON.stringify(address));
  return root;
}

const fixtures = {
  'claude-code': ['.mcp.json', 'mcpServers'],
  codex: ['.codex/config.toml', 'mcp_servers'],
  cursor: ['.cursor/mcp.json', 'mcpServers'],
  opencode: ['opencode.jsonc', 'mcp'],
  pi: ['.pi/mcp.json', 'mcpServers'],
};

function run(root, ...args) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return { receipt: JSON.parse(result.stdout), preview: result.stderr };
}

for (const [app, [path, group]] of Object.entries(fixtures)) {
  test(`${app} writes the documented stdio entry and can undo it without changing neighboring settings`, t => {
    const root = checkout(t);
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    const original =
      app === 'codex'
        ? '# keep the comment\nmode = "test"\n\n[mcp_servers.other]\ncommand = "other"\n'
        : app === 'opencode'
          ? '{\n  // keep the comment\n  "other": 4,\n  "mcp": {"servers": {"other": {"type":"remote","url":"https://example.test"}},},\n}\n'
          : '{"other":4,"mcpServers":{"other":{"command":"other"}}}\n';
    writeFileSync(file, original);
    const { receipt, preview } = run(root, 'connect', app);
    assert.equal(receipt.file, path);
    assert.match(preview, /PreToolUse first-write notice.*Stop turn-end guard/);
    assert.ok(preview.includes(receipt.undo));
    assert.equal(JSON.parse(readFileSync(receipt.backup, 'utf8')).before, original);
    const configured = readFileSync(file, 'utf8');
    const parseFile = text =>
      app === 'codex' ? parse(text) : ts.parseConfigFileTextToJson(path, text).config;
    const before = parseFile(original),
      after = parseFile(configured);
    const serverGroup = app === 'opencode' ? after[group].servers : after[group];
    const entry = serverGroup.forge;
    const { command, args } =
      app === 'opencode' ? { command: entry.command[0], args: entry.command.slice(1) } : entry;
    if (app === 'opencode') assert.equal(entry.type, 'local');
    assert.equal(command, process.execPath);
    assert.deepEqual(args.slice(1), ['mcp', root, '--agent', '--client', app]);
    delete serverGroup.forge;
    assert.deepEqual(after, before);
    assert.equal(run(root, 'connect', app).receipt.status, 'already-configured');
    assert.equal(run(root, ...receipt.undo.split(' ').slice(1)).receipt.status, 'undone');
    assert.equal(readFileSync(file, 'utf8'), original);

    const later = run(root, 'connect', app).receipt.undo;
    const newConfig = readFileSync(file, 'utf8');
    writeFileSync(
      file,
      app === 'codex' ? 'later = true\n' + newConfig : newConfig.replace('"other":', '"later":true,"other":'),
    );
    run(root, ...later.split(' ').slice(1));
    before.later = true;
    assert.deepEqual(parseFile(readFileSync(file, 'utf8')), before);
  });
}

test('undo removes a newly created config and is safe to replay', t => {
  const root = checkout(t);
  const { receipt } = run(root, 'connect', 'pi');
  const args = receipt.undo.split(' ').slice(1);
  assert.equal(run(root, ...args).receipt.status, 'undone');
  assert.equal(existsSync(join(root, receipt.file)), false);
  assert.equal(run(root, ...args).receipt.status, 'already-undone');
});

test('Codex inline server tables and OpenCode V1 enable-only entries keep their existing config shape', t => {
  const root = checkout(t);
  const codex = join(root, '.codex', 'config.toml');
  mkdirSync(dirname(codex));
  writeFileSync(codex, 'mcp_servers = { other = { command = "other" } }\n');
  const config = run(root, 'connect', 'codex').receipt;
  assert.equal(parse(readFileSync(codex, 'utf8')).mcp_servers.other.command, 'other');
  writeFileSync(codex, 'later = true\n' + readFileSync(codex, 'utf8'));
  run(root, ...config.undo.split(' ').slice(1));
  assert.deepEqual(
    parse(readFileSync(codex, 'utf8')),
    parse('later = true\nmcp_servers = {other = { command = "other" }}'),
  );

  const openCode = join(root, 'opencode.json');
  writeFileSync(openCode, '{"mcp":{"other":{"enabled":false}}}');
  run(root, 'connect', 'opencode');
  const parsed = JSON.parse(readFileSync(openCode, 'utf8'));
  assert.equal(parsed.mcp.other.enabled, false);
  assert.equal(parsed.mcp.forge.type, 'local');
});

test('connect backs up both first-run hook files and hook uninstall leaves unrelated hooks in place', t => {
  const root = checkout(t);
  const home = join(root, 'home'),
    hookRunner = join(root, 'agent-edit-hook.js');
  const paths = ['.claude/settings.json', '.codex/hooks.json'];
  const original =
    '{ "theme": "quiet", "hooks": { "Stop": [{"hooks":[{"type":"command","command":"other"}]}] } }';
  for (const name of paths) {
    const path = join(home, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, original);
  }
  const result = agentConnect(['cursor'], root, { home, hookRunner });
  assert.equal(result.hooks.status, 'installed');
  assert.match(result.hooks.uninstall, /uninstall-hooks/);
  assert.equal(existsSync(join(root, '.forge')), false);
  const directory = dirname(result.backup);
  const backups = readdirSync(directory).filter(name => /-(?:claude|codex)\.json$/.test(name));
  assert.equal(backups.length, 2);
  for (const backup of backups) assert.equal(readFileSync(join(directory, backup), 'utf8'), original);
  for (const name of paths) {
    const config = JSON.parse(readFileSync(join(home, name), 'utf8'));
    assert.equal(config.theme, 'quiet');
    assert.match(config.hooks.PreToolUse[0].matcher, /apply_patch/);
    assert.deepEqual(config.hooks.Stop[0].hooks, [{ type: 'command', command: 'other' }]);
    assert.match(config.hooks.Stop[1].hooks[0].command, /--forge-turn-end/);
  }
  installEditHooks(root, undefined, true, home, false, { runner: hookRunner });
  for (const name of paths)
    assert.deepEqual(JSON.parse(readFileSync(join(home, name), 'utf8')), JSON.parse(original));
});

test('antigravity: connect adds the forge MCP server and the first-write hook to the user config, once, and undo restores both', t => {
  const root = checkout(t);
  const home = join(root, 'home'),
    hookRunner = join(root, 'dist', 'agent-edit-hook.js');
  const mcp = join(home, '.gemini/config/mcp_config.json'),
    hooks = join(home, '.gemini/config/hooks.json');
  mkdirSync(dirname(mcp), { recursive: true });
  // Antigravity creates an empty mcp_config.json; another tool's named hook must survive.
  writeFileSync(mcp, '');
  const other =
    '{\n  "lint": { "PostToolUse": [{ "matcher": "run_command", "hooks": [{ "command": "./lint.sh" }] }] }\n}\n';
  writeFileSync(hooks, other);
  const result = agentConnect(['antigravity'], root, { home, hookRunner });
  assert.equal(result.status, 'configured');
  assert.equal(result.file, '~/.gemini/config/mcp_config.json');
  assert.equal(result.hooks.status, 'installed');
  assert.equal(existsSync(join(root, '.gemini')), false, 'nothing lands in the project checkout');
  const server = JSON.parse(readFileSync(mcp, 'utf8')).mcpServers.forge;
  assert.equal(server.command, process.execPath);
  assert.deepEqual(server.args.slice(1), ['mcp', root, '--agent', '--client', 'antigravity']);
  const coordination = JSON.parse(readFileSync(mcp, 'utf8')).mcpServers['forge-coordination'];
  assert.deepEqual(coordination, {
    command: process.execPath,
    args: [server.args[0], 'mcp-coordination', root],
  });
  const installed = JSON.parse(readFileSync(hooks, 'utf8'));
  assert.deepEqual(installed.lint, JSON.parse(other).lint);
  const entry = installed['forge-first-write'];
  // Never PreToolUse: there `allow` bypasses the user's permission rules and `{}` denies the tool.
  assert.deepEqual(Object.keys(entry).sort(), ['PostToolUse', 'PreInvocation']);
  assert.match(entry.PostToolUse[0].matcher, /write_file\|.*edit_file/);
  for (const command of [entry.PostToolUse[0].hooks[0].command, entry.PreInvocation[0].command]) {
    assert.ok(command.includes(join(root, 'dist', 'agent-antigravity-hook.js')), command);
    assert.match(command, /'--forge-first-write'$/);
  }
  assert.equal(agentConnect(['antigravity'], root, { home, hookRunner }).status, 'already-configured');
  assert.equal(
    agentConnect(['antigravity', '--undo', result.undo.split(' ').at(-1)], root, { home }).status,
    'undone',
  );
  assert.equal(readFileSync(mcp, 'utf8'), '');
  assert.equal(readFileSync(hooks, 'utf8'), other);
  // uninstall-hooks removes Forge's Antigravity entry as well and keeps the neighbour.
  agentConnect(['antigravity'], root, { home, hookRunner });
  installEditHooks(root, undefined, true, home, false, { runner: hookRunner });
  assert.deepEqual(JSON.parse(readFileSync(hooks, 'utf8')), JSON.parse(other));
});

test('antigravity undo touches only what its connect changed and puts back an earlier Forge hook', t => {
  const root = checkout(t);
  const home = join(root, 'home');
  const mcp = join(home, '.gemini/config/mcp_config.json'),
    hooks = join(home, '.gemini/config/hooks.json');
  const runner = name => join(root, name, 'agent-edit-hook.js');
  const undoId = result => result.undo.split(' ').at(-1);
  mkdirSync(dirname(mcp), { recursive: true });
  // Connect once with an older install, then uninstall only the hook: MCP stays configured.
  agentConnect(['antigravity'], root, { home, hookRunner: runner('old') });
  const earlier = JSON.parse(readFileSync(hooks, 'utf8'))['forge-first-write'];
  // A hooks-only connect (MCP already there) replaces the older Forge hook.
  const result = agentConnect(['antigravity'], root, { home, hookRunner: runner('new') });
  assert.equal(result.status, 'configured');
  // Later, the person adds an MCP server and a hook of their own.
  const servers = JSON.parse(readFileSync(mcp, 'utf8'));
  servers.mcpServers.other = { command: 'other-mcp', args: [] };
  writeFileSync(mcp, JSON.stringify(servers, null, 2));
  const config = JSON.parse(readFileSync(hooks, 'utf8'));
  config.lint = { PostToolUse: [] };
  writeFileSync(hooks, JSON.stringify(config));
  assert.equal(agentConnect(['antigravity', '--undo', undoId(result)], root, { home }).status, 'undone');
  // MCP was not changed by that connect: its Forge servers and the new one all stay.
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(mcp, 'utf8')).mcpServers).sort(), [
    'forge',
    'forge-coordination',
    'other',
  ]);
  const restored = JSON.parse(readFileSync(hooks, 'utf8'));
  assert.deepEqual(restored['forge-first-write'], earlier, 'the earlier Forge hook comes back');
  assert.deepEqual(restored.lint, { PostToolUse: [] }, "the person's own hook stays");
  assert.equal(
    agentConnect(['antigravity', '--undo', undoId(result)], root, { home }).status,
    'already-undone',
  );
  // The user config serves every workspace: another project's forge entry is never repointed.
  const other = checkout(t);
  assert.throws(
    () => agentConnect(['antigravity'], other, { home, hookRunner: runner('new') }),
    /already has a different forge server/,
  );
});

test('connect from outside a hosted checkout reports the right folder without writing config', t => {
  const root = temporaryDirectory(t, 'forge-connect-unbound-');
  const result = spawnSync(process.execPath, [cli, 'connect', 'pi'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FORGE_ROOT_UNAVAILABLE.*hosted project checkout/);
  assert.equal(existsSync(join(root, '.pi')), false);
});

test('the generated Pi command sends its authenticated connection when MCP initializes over stdio', async t => {
  const root = checkout(t);
  const { receipt } = run(root, 'connect', 'pi');
  const entry = JSON.parse(readFileSync(join(root, receipt.file), 'utf8')).mcpServers.forge;
  const preload = join(root, 'fake-connection-endpoint.mjs');
  writeFileSync(
    preload,
    `globalThis.fetch = async (url, init) => {
      const input = JSON.parse(init.body);
      if (new Headers(init.headers).get('authorization') === 'Bearer synthetic-authenticated-contact' &&
          input.path === 'agentConnections:record' && input.args[0].app === 'pi' &&
          input.args[0].projectId === 'synthetic-project' &&
          new URL(url).origin === 'https://connect-fixture.example.test') {
        process.stderr.write('synthetic authenticated contact\\n');
        return Response.json({ status: 'success', value: true });
      }
      return Response.json({ status: 'error', errorMessage: 'Unexpected fixture call' });
    };`,
  );
  const client = new Client({ name: 'Pi fixture', version: '1' });
  const transport = new StdioClientTransport({
    command: entry.command,
    args: ['--import', preload, ...entry.args],
    stderr: 'pipe',
    env: {
      ...mcpTestEnvironment(t),
      FORGE_AUTH_TOKEN: 'synthetic-authenticated-contact',
      FORGE_DEPLOYMENT_URL: address.url,
    },
  });
  t.after(() => client.close());
  await client.connect(transport, requestOptions('connect'));
  assert.equal((await client.listTools(undefined, requestOptions('listTools'))).tools.length, 8);
  let diagnostics = '';
  for await (const [chunk] of on(transport.stderr, 'data', { signal: AbortSignal.timeout(3_000) })) {
    diagnostics += String(chunk);
    if (diagnostics.includes('synthetic authenticated contact')) break;
  }
});

test('connection evidence is recorded once for the authenticated caller of an accessible project', async () => {
  const f = lanesFixture();
  const projectId = f.insert('hostedProjects', {
    key: 'synthetic',
    name: 'Synthetic',
    currentBackup: null,
    revision: 0,
    owner: 'owner',
    visibility: 'private',
  });
  f.insert('forgeAccounts', { owner: 'owner', handle: 'owner' });
  f.insert('forgeAccounts', { owner: 'peer', handle: 'peer' });
  const record = (app, actor) =>
    f.call('agentConnections:record', connections.record, { app, projectId }, actor);
  const read = actor => f.call('agentConnections:read', connections.read, {}, actor);
  const denied = code => error => (error.data?.code ?? error.code) === code;
  await assert.rejects(record('pi', null), denied('AUTH_REQUIRED'));
  await assert.rejects(record('pi', 'peer'), denied('PROJECT_UNAVAILABLE'));
  await assert.rejects(read(null), denied('AUTH_REQUIRED'));
  assert.deepEqual(await read('owner'), []);
  assert.equal(await record('pi', 'owner'), true);
  assert.equal(await record('pi', 'owner'), true);
  assert.equal(await record('opencode', 'owner'), true);
  assert.deepEqual(await read('owner'), ['pi', 'opencode']);
  assert.deepEqual(await read('peer'), []);
  assert.equal(
    f.counts
      .filter(call => call.name === 'agentConnections:record')
      .reduce((sum, call) => sum + call.writes, 0),
    2,
  );
});

test('a rejected authenticated contact can retry and a confirmed contact needs no further calls for that login', async t => {
  const url = 'https://agent-connect.example.test';
  const projectId = 'hostedProjects-1';
  const prior = { token: process.env.FORGE_AUTH_TOKEN, url: process.env.FORGE_DEPLOYMENT_URL };
  process.env.FORGE_AUTH_TOKEN = 'synthetic-connection-credential';
  process.env.FORGE_DEPLOYMENT_URL = url;
  t.after(() => {
    for (const [name, value] of [
      ['FORGE_AUTH_TOKEN', prior.token],
      ['FORGE_DEPLOYMENT_URL', prior.url],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  let accepted = false,
    requests = 0;
  t.mock.method(globalThis, 'fetch', async (endpoint, init) => {
    requests++;
    assert.equal(String(endpoint), url + '/api/mutation');
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer synthetic-connection-credential');
    assert.deepEqual(JSON.parse(init.body).args, [{ app: 'pi', projectId }]);
    return Response.json({ status: 'success', value: accepted });
  });
  await recordAgentConnection({ url, projectId }, 'pi');
  assert.equal(requests, 1);
  accepted = true;
  await recordAgentConnection({ url, projectId }, 'pi');
  assert.equal(requests, 2);
  await recordAgentConnection({ url, projectId }, 'pi');
  assert.equal(requests, 2);
});
