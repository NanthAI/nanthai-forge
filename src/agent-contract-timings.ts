// SPDX-License-Identifier: Apache-2.0
import { checkEvidenceLines } from './check-compact-output.js';
import { createReadStream, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ContractTimingReader } from './contract-test-timings.js';
import { invariant } from './errors.js';
import type { WorkStore } from './work-store.js';
/** Run metadata goes through Work's selected-record accessor, never raw history fields. */
export async function candidateTimings(store: WorkStore, runId: string, candidateId: string, head: string) {
  const run = store.select('runs', runId);
  invariant(
    run && run.viewId === candidateId && run.head === head && ['passed', 'failed'].includes(run.status),
    'CONTRACT_TIMING_SOURCE',
    'Select a completed timing run on this exact Candidate head.',
  );
  const directory = join(store.directory, `check-${run.id}`),
    reader = new ContractTimingReader();
  const shards = join(directory, 'shards');
  const logs = existsSync(shards)
    ? readdirSync(shards)
        .filter(name => /^\d+(?:\.attempt-\d+)?\.log$/.test(name))
        .sort((a, b) => Number(/attempt-(\d+)/.exec(a)?.[1] ?? 1) - Number(/attempt-(\d+)/.exec(b)?.[1] ?? 1))
        .map(name => join(shards, name))
    : [join(directory, 'stdout.log')];
  for (const line of checkEvidenceLines(directory, true)) reader.accept(line + '\n');
  const timings: Record<string, number> = {};
  for (const log of logs) {
    if (!existsSync(log)) continue;
    const parser = new ContractTimingReader();
    for await (const chunk of createReadStream(log, { encoding: 'utf8' })) parser.accept(chunk as string);
    Object.assign(timings, parser.timings);
  }
  const modal = join(directory, 'modal-shard-logs.json');
  if (existsSync(modal)) {
    const executions = JSON.parse(readFileSync(modal, 'utf8')) as {
      attempt: number;
      tests?: Record<string, object>;
    }[];
    for (const execution of executions.sort((a, b) => a.attempt - b.attempt))
      for (const report of Object.values(execution.tests ?? {})) reader.report(report);
  }
  return { ...timings, ...reader.timings };
}
