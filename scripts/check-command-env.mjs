// SPDX-License-Identifier: Apache-2.0
// Inputs for a configured check command that is not Forge's own recipe
// (docs/workflows.md#check-command-scope). One small file, outside the Candidate.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Returns the variables for this job's command and `finish(passed)`, which checks a passing
 * command's optional scope report and always removes the file. Plans from older planners carry no changes. */
export function commandCheckInputs(plan, shard) {
  const groups = plan.groups ?? [];
  const sharded = groups.length > 0;
  const index = shard === 'static' ? -1 : Number(shard);
  if (shard !== 'static' && !(sharded && Number.isInteger(index) && groups[index]))
    throw new Error('Unselected command shard: this command declares no such shard.');
  const env = {};
  if (sharded) {
    env.FORGE_CHECK_PART = shard === 'static' ? 'static' : 'tests';
    if (shard !== 'static') {
      env.FORGE_CHECK_SHARD = `${index + 1}/${groups.length}`;
      env.FORGE_CHECK_SHARD_INDEX = String(index + 1);
      env.FORGE_CHECK_SHARD_TOTAL = String(groups.length);
    }
  }
  const changes = plan.selection?.changes;
  if (!changes) return { env, finish: () => {} };
  const directory = mkdtempSync(join(tmpdir(), 'forge-check-'));
  const file = join(directory, 'changes.json');
  writeFileSync(file, JSON.stringify(changes), { mode: 0o600, flag: 'wx' });
  Object.assign(env, {
    FORGE_CHECK_CHANGES: file,
    FORGE_CHECK_BASE: changes.base,
    FORGE_CHECK_HEAD: changes.head,
    FORGE_CHECK_SELECTION: join(directory, 'selection.json'),
    ...(changes.mode === 'full' ? { FORGE_CHECK_FULL: '1' } : { FORGE_CHECK_SCOPED: '1' }),
  });
  const finish = passed => {
    try {
      if (!passed) return;
      // Forge asked for everything: a command that reports a reduced scope fails, never passes as full.
      let report;
      try {
        report = JSON.parse(readFileSync(env.FORGE_CHECK_SELECTION, 'utf8'));
      } catch {
        report = undefined;
      }
      if (changes.mode === 'full' && report && report.scope !== 'full')
        throw new Error(
          `SCOPE_MISMATCH: Forge asked this command for a full run; it reported scope ${JSON.stringify(report.scope)}.`,
        );
      if (report?.scope) console.log(`Command-reported scope: ${String(report.scope).slice(0, 40)}`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
  return { env, finish };
}
