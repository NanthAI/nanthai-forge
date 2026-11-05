// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { shellQuote } from './shell-quote.js';
import { cliInstallation, stableCliRunner } from './cli-installation.js';
import { editHooksEnabled } from './agent-hook-settings.js';

const FIRST_WRITE = '--forge-first-write';
const TURN_END = '--forge-turn-end';
export const HOOK_FILES = ['.claude/settings.json', '.codex/hooks.json'] as const;

/** Shell-quoted words of a Forge hook command (`node RUNNER FLAGS...`). */
function words(command: string) {
  return [...command.matchAll(/'((?:[^']|'\\'')*)'/g)].map(match => match[1]!.replaceAll("'\\''", "'"));
}
/** The runner path of a Forge first-write or turn-end hook command, else null. Older per-Lane
 * installs have the same flags, so they are recognised as Forge hooks too. */
export function forgeHookRunner(command: string | undefined) {
  if (!command) return null;
  const flag = command.endsWith(shellQuote(FIRST_WRITE))
    ? FIRST_WRITE
    : command.endsWith(shellQuote(TURN_END))
      ? TURN_END
      : null;
  if (!flag) return null;
  const parsed = words(command);
  return parsed.length >= 2 && parsed.includes(flag) ? parsed[1]! : null;
}
/** The installed, auto-updated copy of this runner, or null for a Lane, temp or dev build. */
export function installedRunner(runner: string) {
  const stable = stableCliRunner(runner);
  return stable === runner ? null : stable;
}
/** A hook target counts as installed only inside an installation's `current` or a managed build. */
export function isInstalledTarget(target: string) {
  try {
    return existsSync(target) && cliInstallation(dirname(dirname(target))) !== null;
  } catch {
    return false;
  }
}
export function sameFile(a: string, b: string) {
  if (a === b) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

export type HookProblem = {
  file: string;
  reason: 'missing-target' | 'not-installed-cli' | 'missing-hook' | 'unreadable';
  target?: string;
};
export type HookHealth = {
  status: 'ok' | 'disabled' | 'attention';
  problems: HookProblem[];
  repair: string | null;
};
/** Read-only: report a Forge hook that is absent, unreadable, missing its target, or not an
 * installed CLI. Repair is the explicit install command, run with the installed `nforge`. */
export function hookHealth(root: string, home = homedir()): HookHealth {
  if (!editHooksEnabled(undefined, home)) return { status: 'disabled', problems: [], repair: null };
  const problems: HookProblem[] = [];
  for (const name of HOOK_FILES) {
    const file = join(home, name);
    if (!existsSync(file)) {
      problems.push({ file, reason: 'missing-hook' });
      continue;
    }
    let config: { hooks?: Record<string, { hooks?: { command?: string }[] }[]> };
    try {
      config = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      problems.push({ file, reason: 'unreadable' });
      continue;
    }
    const targets = new Map<string, string>();
    for (const [event, groups] of Object.entries(config?.hooks ?? {}))
      for (const group of Array.isArray(groups) ? groups : [])
        for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) {
          const runner = forgeHookRunner(hook?.command);
          if (runner) targets.set(`${event}:${runner}`, runner);
        }
    if (!targets.size) problems.push({ file, reason: 'missing-hook' });
    for (const target of new Set(targets.values()))
      if (!existsSync(target)) problems.push({ file, reason: 'missing-target', target });
      else if (!isInstalledTarget(target)) problems.push({ file, reason: 'not-installed-cli', target });
  }
  return problems.length
    ? { status: 'attention', problems, repair: `nforge x ${shellQuote(root)} install-hooks '{}'` }
    : { status: 'ok', problems: [], repair: null };
}
export function hookHealthText(health: HookHealth) {
  if (health.status !== 'attention') return null;
  const lines = health.problems.map(
    problem => `${problem.file}: ${problem.reason}${problem.target ? ` (${problem.target})` : ''}`,
  );
  return `Forge agent hooks need repair:\n${lines.join('\n')}\nRepair, with the installed nforge: ${health.repair}`;
}
