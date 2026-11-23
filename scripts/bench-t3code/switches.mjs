// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Named switch arms (Item 0cba0afa) describe which tracked switches must be set.
// Cells keep only switch names and presence on the bench deployment.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const run = promisify(execFile);
const harnessRoot = join(import.meta.dirname, '..', '..');

/** Resolve a name to the expected state of every tracked switch. */
export function selectSwitchArm(config, name) {
  const arms = config.forge?.switchArms ?? {};
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name ?? '') || !Object.hasOwn(arms, name))
    throw Error('--switch-arm requires a name declared in config.forge.switchArms');
  const set = arms[name];
  const names = config.forge?.switches ?? [];
  const tracked = new Set(names);
  if (!Array.isArray(set) || set.some(switchName => !tracked.has(switchName)))
    throw Error(`switch arm ${name} must list switches from config.forge.switches`);
  const enabled = new Set(set);
  return {
    name,
    expected: Object.fromEntries(names.map(switchName => [switchName, enabled.has(switchName)])),
  };
}

/** Refusal reasons for a named arm whose starting snapshot differs from its declaration. */
export function switchArmProblems({ name, expected }, start) {
  return Object.entries(expected).flatMap(([switchName, set]) => {
    if (start[switchName] == null) return [`switch arm ${name}: switch ${switchName} unreadable`];
    if (start[switchName] !== set)
      return [`switch arm ${name}: expected ${switchName} ${set ? 'set' : 'unset'}`];
    return [];
  });
}

/** {NAME: true|false} for each configured switch, or {NAME: null} when unreadable. */
export async function readSwitches(config, { exactPresence = false, exec = run } = {}) {
  const names = config.forge?.switches ?? [];
  const out = {};
  for (const name of names) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw Error(`switch name ${name} is not an environment name`);
    try {
      const { stdout } = await exec(
        'npx',
        ['--no-install', 'convex', 'env', 'get', '--deployment', config.forge.deployment, name],
        { cwd: harnessRoot, maxBuffer: 1 << 20 },
      );
      // Convex prints a newline for a present value, even if that value is empty.
      out[name] = (exactPresence ? stdout : stdout.trim()).length > 0;
    } catch {
      out[name] = null;
    }
  }
  return out;
}

/** Problems that void a cell: an unreadable switch, or one that changed during the cell. */
export function switchProblems(start, end) {
  const problems = [];
  for (const name of new Set([...Object.keys(start ?? {}), ...Object.keys(end ?? {})])) {
    if (start?.[name] == null || end?.[name] == null) problems.push(`switch ${name} unreadable`);
    else if (start[name] !== end[name]) problems.push(`switch ${name} changed during cell`);
  }
  return problems;
}
