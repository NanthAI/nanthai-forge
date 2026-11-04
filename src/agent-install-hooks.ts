// SPDX-License-Identifier: Apache-2.0
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { shellQuote } from './agent-brief-render.js';
import { mkdirBelow } from './mkdir-below.js';
import { writeRecoveryState } from './recovery-state.js';
import { editHooksEnabled, setEditHooksEnabled } from './agent-hook-settings.js';
import { editTarget, readEditMarkerIdentity } from './agent-edit-target.js';
import { refuseRealUserState } from './test-isolation.js';
import { invariant } from './errors.js';

type Group = { matcher?: string; hooks: { type: string; command?: string; timeout?: number }[] };
type Config = { hooks?: Record<string, Group[]>; [key: string]: unknown };
/** Only the named Forge command is added/removed; other client settings survive. */
export function installEditHooks(
  root: string,
  _laneId?: string,
  uninstall = false,
  home = homedir(),
  automatic = false,
) {
  for (const name of ['.claude', '.codex']) refuseRealUserState(join(home, name), 'agent hook config');
  if (automatic && !uninstall && !editHooksEnabled(undefined, home))
    return { status: 'disabled', files: [], changed: [], undo: '' };
  const runner = fileURLToPath(new URL('./agent-edit-hook.js', import.meta.url));
  const command = [process.execPath, runner, '--auto', '--forge-first-write'].map(shellQuote).join(' ');
  const files = [join(home, '.claude', 'settings.json'), join(home, '.codex', 'hooks.json')];
  // Validate both client files before changing either one.
  const updates = files.map(path => {
    const config: Config = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
    invariant(
      config && typeof config === 'object' && !Array.isArray(config),
      'BAD_ARGUMENT',
      'Client hook config must be an object.',
    );
    invariant(
      config.hooks === undefined ||
        (config.hooks && typeof config.hooks === 'object' && !Array.isArray(config.hooks)),
      'BAD_ARGUMENT',
      'Client hooks must be an object.',
    );
    config.hooks ??= {};
    for (const event of ['PreToolUse', 'UserPromptSubmit']) {
      invariant(
        config.hooks[event] === undefined || Array.isArray(config.hooks[event]),
        'BAD_ARGUMENT',
        'Client hook groups must be an array.',
      );
      for (const group of config.hooks[event] ?? [])
        invariant(
          group && Array.isArray(group.hooks),
          'BAD_ARGUMENT',
          'Client hook group must contain hooks.',
        );
      const groups = (config.hooks[event] ?? [])
        .map(group => ({
          ...group,
          hooks: group.hooks.filter(hook => !isForgeHook(hook.command, runner)),
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
    return { path, config };
  });
  if (!automatic) setEditHooksEnabled(!uninstall, undefined, home);
  const changed: string[] = [];
  for (const { path, config } of updates) {
    if (!existsSync(path) && uninstall) continue;
    const bytes = JSON.stringify(config);
    if (existsSync(path) && JSON.stringify(JSON.parse(readFileSync(path, 'utf8'))) === bytes) continue;
    mkdirBelow(home, join(home, path.includes('.claude') ? '.claude' : '.codex'));
    writeRecoveryState(path, config);
    changed.push(path);
  }
  return {
    status: uninstall ? 'uninstalled' : 'installed',
    files,
    changed,
    undo: `nforge x ${shellQuote(root)} ${uninstall ? 'install-hooks' : 'uninstall-hooks'} '{}'`,
  };
}

function isForgeHook(command: string | undefined, runner: string) {
  if (!command) return false;
  // Match only a shell-quoted Forge runner argument, including older per-Lane installs.
  return (
    command.includes(' ' + shellQuote(runner) + ' ') || command.endsWith(shellQuote('--forge-first-write'))
  );
}
export function configureEditHooks(root: string, input: Record<string, unknown>, uninstall: boolean) {
  if (input.scope === 'project') {
    const target = editTarget(join(root, '.forge-hook-target'));
    const main = join(root, '.forge', 'hosted-main.json');
    const project =
      target?.project ??
      (existsSync(main)
        ? readEditMarkerIdentity(main).selection.projectId
        : existsSync(join(root, '.forge', 'work'))
          ? realpathSync(root)
          : null);
    invariant(project, 'BAD_ARGUMENT', 'Select a Forge project or opened Lane.');
    setEditHooksEnabled(!uninstall, project);
    return {
      status: uninstall ? 'project-disabled' : 'project-enabled',
      undo: `nforge x ${shellQuote(root)} ${uninstall ? 'install-hooks' : 'uninstall-hooks'} '{"scope":"project"}'`,
    };
  }
  invariant(input.scope === undefined || input.scope === 'user', 'BAD_ARGUMENT', 'scope is project or user.');
  return installEditHooks(root, undefined, uninstall);
}
export function ensureEditHooks() {
  try {
    const result = installEditHooks(process.cwd(), undefined, false, homedir(), true);
    if (result.changed.length)
      process.stderr.write(
        `Forge installed first-write hooks: ${result.changed.join(', ')}. Undo: ${result.undo}\n`,
      );
  } catch {
    process.stderr.write(
      "Forge first-write hooks unavailable; setup incomplete; existing settings retained. Retry: nforge x . install-hooks '{}'\n",
    );
  }
}
