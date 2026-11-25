// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { digest } from './hash.js';
import { ForgeError, invariant } from './errors.js';
import { hostedAgentAddress } from './hosted-agent-address.js';
import {
  addCodexServer,
  addJsonServer,
  removeCodexServer,
  removeJsonServer,
  type ConnectServer,
} from './agent-connect-formats.js';
import { installEditHooks } from './agent-install-hooks.js';
import { ANTIGRAVITY_MCP } from './agent-antigravity-install.js';
import { connectAntigravity, undoAntigravity } from './agent-connect-antigravity.js';
import { authFile } from './auth-store.js';
import { stableCliRunner } from './cli-installation.js';
import { withCliRuntimeLock } from './cli-launcher.js';
import { mkdirBelow } from './mkdir-below.js';
import { writeRecoveryState, writeRecoveryText } from './recovery-state.js';
import { mcpServerConfig } from './setup.js';
import { shellQuote } from './shell-quote.js';
import { refuseRealUserState } from './test-isolation.js';

const files = {
  'claude-code': '.mcp.json',
  codex: '.codex/config.toml',
  cursor: '.cursor/mcp.json',
  opencode: 'opencode.json',
  pi: '.pi/mcp.json',
  // Antigravity reads MCP servers only from the user config, relative to HOME.
  antigravity: ANTIGRAVITY_MCP,
};
type App = keyof typeof files;
type Backup = {
  app: App;
  path: string;
  before: string | null;
  after: string;
  server: ConnectServer;
};
type ConnectFixture = { home?: string; hookRunner?: string };
const usage =
  'Use nforge connect <claude-code|codex|cursor|opencode|pi|antigravity> [--undo BACKUP_ID] from the project folder.';
const preview = (line: string) => process.stderr.write(line + '\n');

function localPath(root: string, path: string) {
  const parts = relative(root, path).split(sep);
  invariant(parts[0] !== '..', 'BAD_ARGUMENT', 'Agent config is outside its selected folder.');
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    const last = index === parts.length - 1;
    invariant(
      !stat || (last ? stat.isFile() : stat.isDirectory()),
      'BAD_ARGUMENT',
      'Forge needs a regular config file and ordinary parent directories.',
    );
  }
}

function readConfig(root: string, path: string) {
  localPath(root, path);
  try {
    const bytes = readFileSync(path);
    const text = bytes.toString('utf8');
    invariant(bytes.equals(Buffer.from(text)), 'BAD_ARGUMENT', 'Agent config must be UTF-8.');
    return text;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function undo(root: string, directory: string, app: App, id: string) {
  const backup = join(directory, id + '.json');
  const bytes = readConfig(directory, backup);
  invariant(bytes, 'BAD_ARGUMENT', 'No connect backup was found in this project folder.');
  const record = JSON.parse(bytes) as Backup;
  invariant(
    record.app === app &&
      (record.path === files[app] ||
        (app === 'opencode' && /^(?:\.opencode\/)?opencode\.jsonc?$/.test(record.path))) &&
      (record.before === null || typeof record.before === 'string'),
    'BAD_ARGUMENT',
    'The connect backup does not match this app.',
  );
  const path = join(root, record.path);
  const current = readConfig(root, path);
  if (current === null || current === record.before) return { status: 'already-undone', file: record.path };
  const exact = digest(current) === record.after;
  const next = exact
    ? record.before
    : app === 'codex'
      ? removeCodexServer(current, record.server)
      : removeJsonServer(record.path, current, record.server, app === 'opencode');
  if (current === next) return { status: 'already-undone', file: record.path };
  preview(`Undo the Forge MCP entry in ${record.path}.`);
  invariant(
    readConfig(root, path) === current,
    'BAD_ARGUMENT',
    'The config changed during undo. Retry the same command.',
  );
  if (next === null) unlinkSync(path);
  else writeRecoveryText(path, next);
  return { status: 'undone', file: record.path };
}

function connect(root: string, directory: string, app: App, fixture: ConnectFixture) {
  const path =
    (app === 'opencode' &&
      ['.opencode/opencode.jsonc', '.opencode/opencode.json', 'opencode.jsonc', 'opencode.json'].find(
        name => readConfig(root, join(root, name)) !== null,
      )) ||
    files[app];
  const selected = join(root, path);
  const before = readConfig(root, selected);
  const server: ConnectServer = mcpServerConfig(root, true);
  if (app === 'cursor') server.type = 'stdio';
  server.args[0] = stableCliRunner(server.args[0]!);
  server.args.push('--client', app);
  const id = randomUUID();
  const backup = join(directory, id + '.json');
  const undoCommand = `nforge connect ${app} --undo ${id}`;
  if (app === 'antigravity') {
    const home = realpathSync(fixture.home ?? homedir());
    return connectAntigravity({ root, home, backup, undoCommand, server, hookRunner: fixture.hookRunner });
  }
  const after =
    app === 'codex'
      ? addCodexServer(before, server)
      : addJsonServer(path, before, server, app === 'opencode');
  const changed = before !== after;
  preview(`${path}: ${changed ? 'add' : 'keep'} the forge MCP server for this project.`);
  if (changed) {
    preview(`Run ${[server.command, ...server.args].map(shellQuote).join(' ')} over stdio.`);
    preview(`Backup: ${backup}. Undo: ${undoCommand}`);
  }

  const home = realpathSync(fixture.home ?? homedir());
  const uninstallHooks = `nforge x ${shellQuote(root)} uninstall-hooks '{}'`;
  const hookPaths = ['.claude/settings.json', '.codex/hooks.json'];
  preview(
    'First-run hooks: PreToolUse first-write notice for Edit, Write, MultiEdit, NotebookEdit and apply_patch, the Stop turn-end guard, and Claude Code credential-file read deny rules.',
  );
  let hookStatus: string;
  try {
    for (const name of hookPaths) localPath(home, join(home, name));
    const hooks = installEditHooks(root, undefined, false, home, true, {
      ...(fixture.hookRunner ? { runner: fixture.hookRunner } : {}),
      beforeWrite: changes => {
        for (const name of hookPaths) {
          const update = changes.find(change => change.path === join(home, name));
          const hookBackup = join(directory, `${id}-${name.startsWith('.claude') ? 'claude' : 'codex'}.json`);
          preview(
            `~/${name}: ${update ? (update.before === null ? 'create' : `update Forge hooks. Backup: ${hookBackup}`) : 'keep'}.`,
          );
        }
        preview(`Remove Forge hooks from both apps: ${uninstallHooks}`);
        for (const [index, name] of hookPaths.entries()) {
          const update = changes.find(change => change.path === join(home, name));
          if (update && update.before !== null)
            writeRecoveryText(
              join(directory, `${id}-${index === 0 ? 'claude' : 'codex'}.json`),
              update.before,
            );
        }
      },
    });
    hookStatus = hooks.status;
  } catch {
    hookStatus = 'unavailable';
    preview(
      "Forge could not finish first-run hook setup. Check both hook files and retry with nforge x . install-hooks '{}'.",
    );
  }
  if (hookStatus === 'disabled' || hookStatus === 'dev-build')
    preview(
      `Keep ~/.claude/settings.json and ~/.codex/hooks.json (${hookStatus === 'disabled' ? 'hook setup is off' : 'development CLI'}). Remove Forge hooks from both apps: ${uninstallHooks}`,
    );

  if (changed) {
    writeRecoveryState(backup, { app, path, before, after: digest(after), server } satisfies Backup);
    invariant(
      readConfig(root, selected) === before,
      'BAD_ARGUMENT',
      'The config changed during setup. Retry to preview its current contents.',
    );
    mkdirBelow(root, dirname(selected));
    writeRecoveryText(selected, after);
  }
  return {
    status: changed ? 'configured' : 'already-configured',
    file: path,
    ...(changed ? { backup, undo: undoCommand } : {}),
    hooks: { status: hookStatus, files: hookPaths.map(name => `~/${name}`), uninstall: uninstallHooks },
  };
}

export function agentConnect(args: string[], folder = process.cwd(), fixture: ConnectFixture = {}) {
  const [name, flag, id] = args;
  if (flag === '--undo')
    invariant(
      args.length === 3 && id && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id),
      'BAD_ARGUMENT',
      usage,
    );
  else invariant(args.length === 1, 'BAD_ARGUMENT', usage);
  if (!name || !Object.hasOwn(files, name)) throw new ForgeError('BAD_ARGUMENT', usage);
  const app = name as App;
  const root = realpathSync(folder);
  invariant(
    id || hostedAgentAddress(root, {}),
    'FORGE_ROOT_UNAVAILABLE',
    'Run nforge connect from the hosted project checkout. If you just cloned it, change into that folder first.',
  );
  // Keep backups beside other private Forge client state. The checkout captures source and
  // rejects unknown files in .forge during sync; hook backups may contain other apps' secrets.
  const state = dirname(authFile());
  const directory = join(state, 'agent-connect', digest(root));
  refuseRealUserState(directory, 'agent connect backups');
  localPath(state, join(directory, 'runtime.lock'));
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirBelow(state, directory);
  return withCliRuntimeLock(
    directory,
    () =>
      id
        ? app === 'antigravity'
          ? undoAntigravity(realpathSync(fixture.home ?? homedir()), join(directory, id + '.json'))
          : undo(root, directory, app, id)
        : connect(root, directory, app, fixture),
    1000,
  );
}
