// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { shellQuote } from './shell-quote.js';
import { cliInstallation, stableCliRunner } from './cli-installation.js';
import { editHooksEnabled } from './agent-hook-settings.js';
import { ANTIGRAVITY_HOOKS, antigravityHookRunner } from './agent-antigravity-install.js';
import type { AgentHooks } from './hosted-lane.js';

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
  /** Agent apps with a working Forge first-write hook. Antigravity is optional (person-run connect). */
  covered?: string[];
};
const ANTIGRAVITY_REPAIR = 'nforge connect antigravity';
/** Antigravity counts only once connected; a broken entry needs the person-run connect again. */
function antigravityHealth(home: string): { covered: boolean; problem?: HookProblem } {
  const file = join(home, ANTIGRAVITY_HOOKS);
  if (!existsSync(file)) return { covered: false };
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { covered: false, problem: { file, reason: 'unreadable' } };
  }
  const entry = antigravityHookRunner(text);
  if ('unreadable' in entry) return { covered: false, problem: { file, reason: 'unreadable' } };
  if (!entry.installed) return { covered: false };
  const target = forgeHookRunner(entry.command);
  if (!target || !existsSync(target))
    return { covered: false, problem: { file, reason: 'missing-target', ...(target ? { target } : {}) } };
  if (!isInstalledTarget(target))
    return { covered: false, problem: { file, reason: 'not-installed-cli', target } };
  return { covered: true };
}
/** Read-only: report a Forge hook that is absent, unreadable, missing its target, or not an
 * installed CLI. Repair is the explicit install command, run with the installed `nforge`. */
export function hookHealth(root: string, home = homedir(), project?: string): HookHealth {
  if (!editHooksEnabled(project, home)) return { status: 'disabled', problems: [], repair: null };
  const problems: HookProblem[] = [];
  const covered: string[] = [];
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
    const before = problems.length;
    for (const target of new Set(targets.values()))
      if (!existsSync(target)) problems.push({ file, reason: 'missing-target', target });
      else if (!isInstalledTarget(target)) problems.push({ file, reason: 'not-installed-cli', target });
    if (targets.size && problems.length === before)
      covered.push(name.startsWith('.claude') ? 'claude-code' : 'codex');
  }
  const antigravity = antigravityHealth(home);
  if (antigravity.covered) covered.push('antigravity');
  const installRepair = problems.length ? `nforge x ${shellQuote(root)} install-hooks '{}'` : null;
  if (antigravity.problem) problems.push(antigravity.problem);
  const repair = [installRepair, antigravity.problem ? ANTIGRAVITY_REPAIR : null].filter(Boolean).join('; ');
  return problems.length
    ? { status: 'attention', problems, repair, covered }
    : { status: 'ok', problems: [], repair: null, covered };
}
export function hookHealthText(health: HookHealth) {
  if (health.status !== 'attention') return null;
  const lines = health.problems.map(
    problem => `${problem.file}: ${problem.reason}${problem.target ? ` (${problem.target})` : ''}`,
  );
  return `Forge agent hooks need repair:\n${lines.join('\n')}\nRepair, with the installed nforge: ${health.repair}`;
}

/** Only the state leaves the machine. Health problems, paths and settings stay local. */
export async function agentHookState(
  root: string,
  project: string,
  app: string | null,
  home = homedir(),
): Promise<AgentHooks> {
  try {
    const health = hookHealth(root, home, project);
    if (health.status === 'disabled' || (await appHooksOff(app, home))) return 'off';
    if (app && health.covered?.includes(app)) return 'configured';
  } catch {
    // Bad or unreadable local configuration must not prevent a Lane action.
  }
  return 'unavailable';
}

async function appHooksOff(app: string | null, home: string) {
  if (app === 'claude-code') {
    const file = join(home, HOOK_FILES[0]);
    return existsSync(file) && JSON.parse(readFileSync(file, 'utf8'))?.disableAllHooks === true;
  }
  if (app === 'codex') {
    const file = join(home, '.codex', 'config.toml');
    if (!existsSync(file)) return false;
    const { parse: parseToml } = await import('smol-toml');
    const features = parseToml(readFileSync(file, 'utf8')).features as
      | { hooks?: boolean; codex_hooks?: boolean }
      | undefined;
    return (features?.hooks ?? features?.codex_hooks) === false;
  }
  return false;
}
