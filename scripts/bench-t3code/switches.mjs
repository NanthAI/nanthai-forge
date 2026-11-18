// SPDX-License-Identifier: Apache-2.0
// Named switch arms (Item 0cba0afa): each cell records which deployment switches were set when
// it started and ended. Only set/unset is read and kept, never a value. The names come from
// config.forge.switches; the bench deployment is config.forge.deployment.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const run = promisify(execFile);
const harnessRoot = join(import.meta.dirname, '..', '..');

/** {NAME: true|false} for each configured switch, or {NAME: null} when unreadable. */
export async function readSwitches(config, { exec = run } = {}) {
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
      out[name] = stdout.trim().length > 0;
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
