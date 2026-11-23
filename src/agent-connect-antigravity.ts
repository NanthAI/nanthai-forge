// SPDX-License-Identifier: Apache-2.0
// `nforge connect antigravity` (Issue c6615b66). Antigravity keeps MCP servers and hooks only in the
// user config, so connect writes Forge's own keys there and nothing else: the `forge` and
// `forge-coordination` MCP servers and the `forge-first-write` hook. One backup and one undo cover
// both files; undo touches only a file this connect changed and puts back the Forge keys it found.
import { isDeepStrictEqual } from 'node:util';
import { readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import type { ConnectServer } from './agent-connect-formats.js';
import {
  ANTIGRAVITY_HOOKS,
  ANTIGRAVITY_HOOK_NAME,
  ANTIGRAVITY_MCP,
  ANTIGRAVITY_MCP_KEYS,
  antigravityHookEntry,
  editForgeKeys,
  forgeKeys,
} from './agent-antigravity-install.js';
import { installedRunner } from './agent-hook-health.js';
import { mkdirBelow } from './mkdir-below.js';
import { writeRecoveryState, writeRecoveryText } from './recovery-state.js';

type Change = {
  file: string;
  under: 'mcpServers' | null;
  keys: string[];
  before: string | null;
  after: string;
};
type Backup = { app: 'antigravity'; changes: Change[] };
const preview = (line: string) => process.stderr.write(line + '\n');

function read(path: string) {
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

export function connectAntigravity(input: {
  root: string;
  home: string;
  backup: string;
  undoCommand: string;
  server: ConnectServer;
  hookRunner?: string | undefined;
}) {
  const { home, server } = input;
  const coordination = { command: server.command, args: [server.args[0]!, 'mcp-coordination', input.root] };
  const wanted = { forge: server, 'forge-coordination': coordination };
  const mcpBefore = read(join(home, ANTIGRAVITY_MCP));
  // One user config serves every workspace: never silently repoint another project's entry.
  const found = forgeKeys(ANTIGRAVITY_MCP, mcpBefore, 'mcpServers', ANTIGRAVITY_MCP_KEYS);
  for (const key of ANTIGRAVITY_MCP_KEYS)
    invariant(
      found[key] === undefined || isDeepStrictEqual(found[key], wanted[key]),
      'BAD_ARGUMENT',
      `~/${ANTIGRAVITY_MCP} already has a different ${key} server (another project or build). Undo that connect or remove the entry, then retry.`,
    );
  const mcpAfter = editForgeKeys(ANTIGRAVITY_MCP, mcpBefore, 'mcpServers', wanted)!;
  preview(
    `~/${ANTIGRAVITY_MCP}: ${mcpAfter === mcpBefore ? 'keep' : 'add'} the forge and forge-coordination MCP servers for this project (user config: every Antigravity workspace).`,
  );
  // A dev build or Lane never writes its own path, like install-hooks.
  const runner =
    input.hookRunner ?? installedRunner(fileURLToPath(new URL('./agent-edit-hook.js', import.meta.url)));
  const hooksBefore = read(join(home, ANTIGRAVITY_HOOKS));
  const hooksAfter = runner
    ? editForgeKeys(ANTIGRAVITY_HOOKS, hooksBefore, null, {
        [ANTIGRAVITY_HOOK_NAME]: antigravityHookEntry(runner),
      })
    : hooksBefore;
  preview(
    runner
      ? `~/${ANTIGRAVITY_HOOKS}: ${hooksAfter === hooksBefore ? 'keep' : 'add'} the Forge first-write hook (PostToolUse check, PreInvocation notice; it never blocks a write).`
      : `~/${ANTIGRAVITY_HOOKS}: keep (development CLI). Run connect with the installed nforge.`,
  );
  const changes: Change[] = [];
  if (mcpAfter !== mcpBefore)
    changes.push({
      file: ANTIGRAVITY_MCP,
      under: 'mcpServers',
      keys: [...ANTIGRAVITY_MCP_KEYS],
      before: mcpBefore,
      after: digest(mcpAfter),
    });
  if (hooksAfter !== hooksBefore)
    changes.push({
      file: ANTIGRAVITY_HOOKS,
      under: null,
      keys: [ANTIGRAVITY_HOOK_NAME],
      before: hooksBefore,
      after: digest(hooksAfter!),
    });
  if (changes.length) {
    preview(`Backup: ${input.backup}. Undo: ${input.undoCommand}`);
    writeRecoveryState(input.backup, { app: 'antigravity', changes } satisfies Backup);
    invariant(
      read(join(home, ANTIGRAVITY_MCP)) === mcpBefore && read(join(home, ANTIGRAVITY_HOOKS)) === hooksBefore,
      'BAD_ARGUMENT',
      'The config changed during setup. Retry to preview its current contents.',
    );
    mkdirBelow(home, dirname(join(home, ANTIGRAVITY_MCP)));
    if (mcpAfter !== mcpBefore) writeRecoveryText(join(home, ANTIGRAVITY_MCP), mcpAfter);
    if (hooksAfter !== hooksBefore) writeRecoveryText(join(home, ANTIGRAVITY_HOOKS), hooksAfter!);
  }
  return {
    status: changes.length ? 'configured' : 'already-configured',
    file: `~/${ANTIGRAVITY_MCP}`,
    ...(changes.length ? { backup: input.backup, undo: input.undoCommand } : {}),
    hooks: {
      status: !runner ? 'dev-build' : hooksAfter === hooksBefore ? 'already-installed' : 'installed',
      files: [`~/${ANTIGRAVITY_HOOKS}`],
      undo: input.undoCommand,
    },
    scope: 'user',
  };
}

/** Each changed file: exact bytes back when nothing else touched it since, else only Forge's keys
 * back to what connect found (a previous Forge entry is restored, a new one removed). */
export function undoAntigravity(home: string, backup: string) {
  const text = read(backup);
  invariant(text, 'BAD_ARGUMENT', 'No connect backup was found in this project folder.');
  const record = JSON.parse(text) as Backup;
  invariant(
    record.app === 'antigravity' &&
      Array.isArray(record.changes) &&
      record.changes.every(change => change.file === ANTIGRAVITY_MCP || change.file === ANTIGRAVITY_HOOKS),
    'BAD_ARGUMENT',
    'The connect backup does not match this app.',
  );
  let undone = false;
  for (const change of record.changes) {
    const path = join(home, change.file);
    const current = read(path);
    if (current === null || current === change.before) continue;
    const next =
      digest(current) === change.after
        ? change.before
        : editForgeKeys(
            change.file,
            current,
            change.under,
            forgeKeys(change.file, change.before, change.under, change.keys),
          );
    if (next === current) continue;
    preview(`Undo Forge's entries in ~/${change.file}.`);
    if (next === null) unlinkSync(path);
    else writeRecoveryText(path, next);
    undone = true;
  }
  return { status: undone ? 'undone' : 'already-undone', file: `~/${ANTIGRAVITY_MCP}` };
}
