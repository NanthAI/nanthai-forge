// SPDX-License-Identifier: Apache-2.0
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { shellQuote } from './agent-brief-render.js';
import { mkdirBelow } from './mkdir-below.js';
import { writeRecoveryState } from './recovery-state.js';
import { invariant } from './errors.js';

type Group = { matcher?: string; hooks: { type: string; command?: string; timeout?: number }[] };
type Config = { hooks?: Record<string, Group[]>; [key: string]: unknown };
/** Only the named Forge command is added/removed; other client settings survive. */
export function installEditHooks(root: string, laneId: string, uninstall = false, home = homedir()) {
  const runner = fileURLToPath(new URL('./agent-edit-hook.js', import.meta.url));
  const command = [process.execPath, runner, root, laneId].map(shellQuote).join(' ');
  const files = [join(home, '.claude', 'settings.json'), join(home, '.codex', 'hooks.json')];
  for (const path of files) {
    const config: Config = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
    invariant(
      config && typeof config === 'object' && !Array.isArray(config),
      'BAD_ARGUMENT',
      'Client hook config must be an object.',
    );
    config.hooks ??= {};
    for (const event of ['PreToolUse', 'UserPromptSubmit']) {
      const groups = (config.hooks[event] ?? [])
        .map(group => ({
          ...group,
          hooks: group.hooks.filter(hook => hook.command !== command),
        }))
        .filter(group => group.hooks.length);
      if (!uninstall)
        groups.push({
          ...(event === 'PreToolUse' ? { matcher: '^(Edit|Write|MultiEdit|NotebookEdit|apply_patch)$' } : {}),
          hooks: [{ type: 'command', command, timeout: 2 }],
        });
      if (groups.length) config.hooks[event] = groups;
      else delete config.hooks[event];
    }
    if (!existsSync(path) && uninstall) continue;
    mkdirBelow(home, join(home, path.includes('.claude') ? '.claude' : '.codex'));
    writeRecoveryState(path, config);
  }
  return {
    status: uninstall ? 'uninstalled' : 'installed',
    files,
    undo: `nforge agent ${shellQuote(root)} ${uninstall ? 'install-hooks' : 'uninstall-hooks'} '${JSON.stringify({ laneId })}'`,
  };
}
