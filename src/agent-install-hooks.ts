// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { shellQuote } from './shell-quote.js';
import { mkdirBelow } from './mkdir-below.js';
import { writeRecoveryState, writeRecoveryText } from './recovery-state.js';
import { ANTIGRAVITY_HOOKS, editAntigravityHooks } from './agent-antigravity-install.js';
import {
  editHooksEnabled,
  readAddedDenyRules,
  setAddedDenyRules,
  setEditHooksEnabled,
} from './agent-hook-settings.js';
import { editTarget, readEditMarkerIdentity } from './agent-edit-target.js';
import { refuseRealUserState } from './test-isolation.js';
import { invariant } from './errors.js';
import { cliInstallation } from './cli-installation.js';
import {
  forgeHookRunner,
  hookHealth,
  hookHealthText,
  installedRunner,
  sameFile,
} from './agent-hook-health.js';

type Group = { matcher?: string; hooks: { type: string; command?: string; timeout?: number }[] };
type Config = {
  hooks?: Record<string, Group[]>;
  permissions?: { deny?: string[]; [key: string]: unknown };
  [key: string]: unknown;
};
/** Credential-file read deny rules installed in Claude Code's user settings (`permissions.deny`,
 * Item f3495abe). Guards the `Read` tool against common key/env files and Forge's own credential
 * and sealed-key stores; removed cleanly by `uninstall-hooks`. */
const CLAUDE_SECRET_DENY_RULES = [
  'Read(**/*.pem)',
  'Read(**/*.key)',
  'Read(**/.env*)',
  'Read(~/.config/forge/auth.json)',
  'Read(~/.config/forge/sealed/**)',
] as const;
/** Only the named Forge command is added/removed; other client settings survive. */
export function installEditHooks(
  root: string,
  _laneId?: string,
  uninstall = false,
  home = homedir(),
  automatic = false,
  /** `runner` is for tests: it stands in for the installed CLI's runner. */
  options: {
    runner?: string;
    beforeWrite?: (files: readonly { path: string; before: string | null }[]) => void;
  } = {},
) {
  for (const name of ['.claude', '.codex', '.gemini'])
    refuseRealUserState(join(home, name), 'agent hook config');
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
  const claudeSettings = join(home, '.claude', 'settings.json');
  const trackedDenyRules = readAddedDenyRules(home);
  let nextTrackedDenyRules: string[] | null = null;
  const updates = files.map(path => {
    const isClaude = path === claudeSettings;
    const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
    const config: Config = before === null ? {} : JSON.parse(before);
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
    if (isClaude) {
      invariant(
        config.permissions === undefined ||
          (config.permissions &&
            typeof config.permissions === 'object' &&
            !Array.isArray(config.permissions)),
        'BAD_ARGUMENT',
        'Client permissions must be an object.',
      );
      invariant(
        config.permissions?.deny === undefined ||
          (Array.isArray(config.permissions.deny) &&
            config.permissions.deny.every(entry => typeof entry === 'string')),
        'BAD_ARGUMENT',
        'Client permissions.deny must be an array of strings.',
      );
    }
    // An automatic run leaves hooks that point at another valid install alone; only an
    // explicit install-hooks takes them over. Missing or broken targets are still repaired.
    if (automatic && !uninstall && pointsAtOtherInstall(config, runner!)) return { path, before, config };
    const removedAny = { hooks: false };
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
      const beforeGroups = config.hooks[event] ?? [];
      const groups = beforeGroups.flatMap(group => {
        const hooks = group.hooks.filter(
          hook => !isForgeHook(hook.command, runner ?? own) && !isTurnEndHook(hook.command),
        );
        if (hooks.length !== group.hooks.length) removedAny.hooks = true;
        return hooks.length === group.hooks.length ? [group] : hooks.length ? [{ ...group, hooks }] : [];
      });
      // UserPromptSubmit only fed the retired native turn store: installs now remove it.
      if (!uninstall && event !== 'UserPromptSubmit')
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
    if (uninstall && removedAny.hooks && !Object.keys(config.hooks).length) delete config.hooks;
    if (isClaude) {
      if (!uninstall) {
        const existing = config.permissions?.deny ?? [];
        const missing = CLAUDE_SECRET_DENY_RULES.filter(rule => !existing.includes(rule));
        if (missing.length) {
          config.permissions ??= {};
          config.permissions.deny = [...existing, ...missing];
          nextTrackedDenyRules = [...new Set([...trackedDenyRules, ...missing])];
        }
      } else if (trackedDenyRules.length) {
        const forgeRules = new Set<string>(trackedDenyRules);
        if (config.permissions?.deny) {
          const remaining = config.permissions.deny.filter(rule => !forgeRules.has(rule));
          if (remaining.length !== config.permissions.deny.length) {
            if (remaining.length) config.permissions.deny = remaining;
            else delete config.permissions.deny;
            if (!Object.keys(config.permissions).length) delete config.permissions;
          }
        }
        nextTrackedDenyRules = [];
      }
    }
    return { path, before, config };
  });
  const changes = updates.filter(({ before, config }) =>
    before === null ? !uninstall : JSON.stringify(JSON.parse(before)) !== JSON.stringify(config),
  );
  options.beforeWrite?.(changes);
  if (!automatic) setEditHooksEnabled(!uninstall, undefined, home);
  const changed: string[] = [];
  for (const { path, before, config } of changes) {
    mkdirBelow(home, dirname(path));
    if (options.beforeWrite)
      invariant(
        (existsSync(path) ? readFileSync(path, 'utf8') : null) === before,
        'BAD_ARGUMENT',
        'A hook config changed during setup. Retry to preview the current settings.',
      );
    writeRecoveryState(path, config);
    changed.push(path);
  }
  if (nextTrackedDenyRules !== null) setAddedDenyRules(nextTrackedDenyRules, home);
  // Antigravity's entry is installed only by the person-run connect; an uninstall removes it too.
  if (uninstall) {
    const path = join(home, ANTIGRAVITY_HOOKS);
    const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
    const after = before === null ? null : editAntigravityHooks(before, null);
    if (after !== null && after !== before) {
      writeRecoveryText(path, after);
      changed.push(path);
    }
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

/** The product installation a hook runner file belongs to, or null (Lane, temp, dev build). */
function runnerInstallation(runner: string | null) {
  try {
    return runner && existsSync(runner) ? cliInstallation(dirname(dirname(runner))) : null;
  } catch {
    return null;
  }
}
/** Migrate only existing Forge hooks. Opt-outs and unrelated settings are preserved.
 * Validate both files first; each durable replacement is atomic. The updater keeps
 * old builds until every replacement succeeds, so interrupted migrations stay valid.
 * A hook whose runner lives in another existing installation stays with it: updating a
 * second installation (a bench's own CLI home) never takes over the user's hooks. */
export function migrateEditHookRunner(runner: string, home = homedir()) {
  const command = hookCommand(runner),
    stopCommand = turnEndCommand(turnEndRunner(runner));
  const own = runnerInstallation(runner);
  const elsewhere = (hookCommandText: string | undefined) => {
    const other = own ? runnerInstallation(forgeHookRunner(hookCommandText)) : null;
    return Boolean(other && other !== own);
  };
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
          if (elsewhere(hook.command)) continue;
          else if (isTurnEndHook(hook.command)) hook.command = stopCommand;
          else if (isForgeHook(hook.command, runner)) hook.command = command;
      }
    }
    return JSON.stringify(config) === JSON.stringify(JSON.parse(original)) ? [] : [{ path, config }];
  });
  for (const { path, config } of updates) writeRecoveryState(path, config);
  return updates.map(update => update.path);
}
