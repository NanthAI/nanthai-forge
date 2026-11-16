// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { isMainModule } from './main-module.mjs';

/** Two bounded read passes keep only numeric-id claim counts, never full profiles.
 * Re-read every page before applying so cross-page conflicts cannot be missed on
 * resume. Replaying a page after a lost reply is safe; no local identity copy. */
export async function backfill(run, { apply = false, cursor = null } = {}, report = console.log) {
  const claims = new Map();
  const pages = new Map();
  const digest = entries => createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  let next = null;
  do {
    const page = await run('authBackfill:readPage', { cursor: next });
    pages.set(next, digest(page.entries));
    for (const row of page.entries) for (const id of row.githubIds) claims.set(id, (claims.get(id) ?? 0) + 1);
    next = page.isDone ? null : page.cursor;
  } while (next !== null);
  const totals = { accounts: 0, matched: 0, unmatched: 0, conflicts: 0, userWrites: 0, accountWrites: 0 };
  let resumed = cursor === null;
  do {
    const start = next;
    const page = await run('authBackfill:readPage', { cursor: start });
    if (pages.get(start) !== digest(page.entries))
      throw new Error('Account identities changed during discovery. Repeat the backfill.');
    if (start === cursor) resumed = true;
    if (resumed) {
      const entries = [];
      for (const row of page.entries) {
        totals.accounts++;
        if (row.githubIds.length !== 1) {
          const kind = row.githubIds.length ? 'conflicts' : 'unmatched';
          totals[kind]++;
          report(JSON.stringify({ [kind]: row.handle }));
        } else
          entries.push({
            accountKey: row.accountKey,
            githubId: row.githubIds[0],
            ambiguous: claims.get(row.githubIds[0]) > 1,
          });
      }
      const result = await run('authBackfillStore:batch', { apply, entries });
      for (const key of ['matched', 'conflicts', 'userWrites', 'accountWrites']) totals[key] += result[key];
      report(JSON.stringify({ page: { cursor: page.cursor, isDone: page.isDone }, ...result }));
    }
    next = page.isDone ? null : page.cursor;
  } while (next !== null);
  if (!resumed) throw new Error('The resume cursor was not found. Restart from the first page.');
  report(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...totals }));
  return totals;
}

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      apply: { type: 'boolean', default: false },
      cursor: { type: 'string' },
      'convex-cwd': { type: 'string', default: process.cwd() },
    },
  });
  const run = async (name, args) => {
    try {
      const output = execFileSync('npx', ['convex', 'run', name, JSON.stringify(args)], {
        cwd: values['convex-cwd'],
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 1024 * 1024,
      });
      return JSON.parse(output);
    } catch {
      // Provider/CLI diagnostics can contain private inputs. Keep them off stdout.
      throw new Error(`Backfill ${name} failed; the last completed page is the resume point.`);
    }
  };
  try {
    // Applying always performs a complete read-only preview first.
    const preview = await backfill(run);
    if (values.apply) await backfill(run, { apply: true, cursor: values.cursor ?? null });
    else if (values.cursor) throw new Error('--cursor is only used with --apply.');
    process.exitCode = preview.conflicts ? 1 : 0;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
