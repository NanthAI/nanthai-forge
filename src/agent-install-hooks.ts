// SPDX-License-Identifier: Apache-2.0
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { shellQuote } from './shell-quote.js';
import { mkdirBelow } from './mkdir-below.js';
import { writeRecoveryState } from './recovery-state.js';
import { editHooksEnabled, setEditHooksEnabled } from './agent-hook-settings.js';
import { editTarget, readEditMarkerIdentity } from './agent-edit-target.js';
import { refuseRealUserState } from './test-isolation.js';
import { invariant } from './errors.js';
import {
  forgeHookRunner,
  hookHealth,
  hookHealthText,
  installedRunner,
  sameFile,
} from './agent-hook-health.js';

type Group = { matcher?: string; hooks: { type: string; command?: string; timeout?: number }[] };
type Config = { hooks?: Record<string, Group[]>; [key: string]: unknown };
/** Only the named Forge command is added/removed; other client settings survive. */
export function installEditHooks(
  root: string,
  _laneId?: string,
  uninstall = false,
  home = homedir(),
  automatic = false,
  /** `runner` is for tests: it stands in for the installed CLI's runner. */
  options: { runner?: string } = {},
) {
  for (const name of ['.claude', '.codex']) refuseRealUserState(join(home, name), 'agent hook config');
  if (automatic && !uninstall && !editHooksEnabled(undefined, home))
    return { status: 'disabled', files: [], changed: [], undo: '' };
  const own = options.runner ?? fileURLToPath(new URL('./agent-edit-hook.js', import.meta.url));
  // Only the installed, auto-updated CLI's paths are ever written: never a Lane, temp or dev build.
  const runner = options.runner ?? installedRunner(own);
  if (!runner && !uninstall) {
    const health = hookHealth(root, home);
    return {
      status: 'dev-build',
      files: [],
      changed: [],
      undo: '',
      health,
      warning:
        'This is not the installed Forge CLI, so agent hooks were not changed. ' +
        (hookHealthText(health) ??
          `Existing hooks are healthy. To (re)install them run the installed nforge: nforge x ${shellQuote(root)} install-hooks '{}'`),
    };
  }
  const command = hookCommand(runner ?? own);
  const stopCommand = turnEndCommand(turnEndRunner(runner ?? own));
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
    // An automatic run leaves hooks that point at another valid install alone; only an
    // explicit install-hooks takes them over. Missing or broken targets are still repaired.
    if (automatic && !uninstall && pointsAtOtherInstall(config, runner!)) return { path, config };
    config.hooks ??= {};
    for (const event of ['PreToolUse', 'UserPromptSubmit', 'Stop']) {
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
          hooks: group.hooks.filter(
            hook => !isForgeHook(hook.command, runner ?? own) && !isTurnEndHook(hook.command),
          ),
        }))
        .filter(group => group.hooks.length);
      if (!uninstall)
        groups.push(
          event === 'Stop'
            ? // Turn-end guard: blocks only a first stop while owned Forge work runs.
              { hooks: [{ type: 'command', command: stopCommand, timeout: 5 }] }
            : {
                ...(event === 'PreToolUse'
                  ? { matcher: '^(Edit|Write|MultiEdit|NotebookEdit|apply_patch)$' }
                  : {}),
                hooks: [{ type: 'command', command, timeout: 2 }],
              },
        );
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

const hookCommand = (runner: string) =>
  [process.execPath, runner, '--auto', '--forge-first-write'].map(shellQuote).join(' ');
const turnEndRunner = (runner: string) => join(dirname(runner), 'agent-stop-hook.js');
const turnEndCommand = (runner: string) =>
  [process.execPath, runner, '--forge-turn-end'].map(shellQuote).join(' ');
function pointsAtOtherInstall(config: Config, runner: string) {
  const mine = [runner, turnEndRunner(runner)];
  return Object.values(config.hooks ?? {}).some(
    groups =>
      Array.isArray(groups) &&
      groups.some(group =>
        (Array.isArray(group?.hooks) ? group.hooks : []).some(hook => {
          const target = forgeHookRunner(hook?.command);
          return Boolean(target && existsSync(target) && !mine.some(own => sameFile(own, target)));
        }),
      ),
  );
}
function isTurnEndHook(command: string | undefined) {
  return Boolean(command?.endsWith(' ' + shellQuote('--forge-turn-end')));
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
    if ('warning' in result && result.warning) {
      // A dev build never touches hooks.
      // Absent hooks are normal for a dev build (fresh HOME, CI); only a broken one is worth a line.
      if (result.health?.problems.some(problem => problem.reason !== 'missing-hook'))
        process.stderr.write(result.warning + '\n');
    } else if (result.changed.length)
      process.stderr.write(
        `Forge installed first-write hooks: ${result.changed.join(', ')}. Undo: ${result.undo}\n`,
      );
  } catch {
    process.stderr.write(
      "Forge first-write hooks unavailable; setup incomplete; existing settings retained. Retry: nforge x . install-hooks '{}'\n",
    );
  }
}

/** Migrate only existing Forge hooks. Opt-outs and unrelated settings are preserved.
 * Validate both files first; each durable replacement is atomic. The updater keeps
 * old builds until every replacement succeeds, so interrupted migrations stay valid. */
export function migrateEditHookRunner(runner: string, home = homedir()) {
  const command = hookCommand(runner),
    stopCommand = turnEndCommand(turnEndRunner(runner));
  const updates = ['.claude/settings.json', '.codex/hooks.json'].flatMap(name => {
    const path = join(home, name);
    refuseRealUserState(path, 'agent hook config');
    if (!existsSync(path)) return [];
    const original = readFileSync(path, 'utf8');
    const config: Config = JSON.parse(original);
    invariant(
      config && typeof config === 'object' && !Array.isArray(config),
      'BAD_ARGUMENT',
      'Client hook config must be an object.',
    );
    for (const groups of Object.values(config.hooks ?? {})) {
      invariant(Array.isArray(groups), 'BAD_ARGUMENT', 'Client hook groups must be an array.');
      for (const group of groups) {
        invariant(
          group && Array.isArray(group.hooks),
          'BAD_ARGUMENT',
          'Client hook group must contain hooks.',
        );
        for (const hook of group.hooks)
          if (isTurnEndHook(hook.command)) hook.command = stopCommand;
          else if (isForgeHook(hook.command, runner)) hook.command = command;
      }
    }
    return JSON.stringify(config) === JSON.stringify(JSON.parse(original)) ? [] : [{ path, config }];
  });
  for (const { path, config } of updates) writeRecoveryState(path, config);
  return updates.map(update => update.path);
}
