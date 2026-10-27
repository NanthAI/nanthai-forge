import { compactProviderOutput } from './check-compact-output.js';
// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { collectHostedOutput, type OutputSink } from './hosted-output-collector.js';
import { actionsMappingMatches, type HostedActionsMapping } from './hosted-actions.js';
import type { HostedCheckRun } from './hosted-check.js';
import type { OutputSeal } from './hosted-check-output.js';
import { invariant } from './errors.js';

/** Fixed runner supervisor, installed/provisioned outside exported project code.
 * The trusted runner bootstrap obtains run/mapping/job pins and H12 sink using
 * its existing credential boundary. No collector key or transport reaches the
 * spawned project command. The sink durably spools chunks/seals before network
 * publication and replays pending records after reconnect, including on cancel.
 * Provider completion logs are deliberately not a source for this live path. */
export async function runHostedActionsJob(input: {
  run: HostedCheckRun;
  mapping: HostedActionsMapping;
  job: { id: number; runId: number; commit: string; head: string; shard: number; attempt: number };
  command: readonly [string, ...string[]];
  cwd: string;
  environment: Record<string, string>;
  redaction: { secrets: readonly string[]; paths: readonly string[] };
  sink(stream: 'stdout' | 'stderr'): OutputSink;
  chunkBytes?: number;
}) {
  const { run, mapping: m, job } = input;
  actionsMappingMatches(m, run);
  invariant(
    m.run === job.runId &&
      m.export?.commit === job.commit &&
      m.head === job.head &&
      run.executionId === String(m.run) &&
      run.plan &&
      job.shard < run.plan.shardCount &&
      job.shard >= 0 &&
      Number.isSafeInteger(job.shard) &&
      job.attempt === 0,
    'EVIDENCE_CHANGED',
    'Live output selected a different State, export commit, job or attempt.',
  );
  const child = spawn(input.command[0], input.command.slice(1), {
    cwd: input.cwd,
    env: input.environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  const exit = new Promise<{ exitCode: number | null; signal: string | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }));
  });
  // Attach immediately so a spawn error cannot become an unhandled rejection
  // while its pipes are draining.
  const streams = (['stdout', 'stderr'] as const).map(async stream => {
    let summary = '';
    const sealed: OutputSeal = await collectHostedOutput(
      compactProviderOutput(child[stream], value => {
        summary = value;
      }),
      {
        kind: 'summary',
        shard: job.shard,
        attempt: job.attempt,
        executionId: String(job.id),
        stream,
        name: '',
      },
      input.redaction,
      input.sink(stream),
      input.chunkBytes,
      true,
      () => summary,
    );
    return sealed;
  });
  const [result, seals] = await Promise.all([exit, Promise.all(streams)]);
  return { ...result, seals };
}
