// SPDX-License-Identifier: Apache-2.0
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, chmodSync, mkdtempSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { writeSourceLink } from './source-links.js';
import { networkDeadline } from './network-fetch.js';
import { invariant } from './errors.js';
import type { NativeState } from './native-state-format.js';
import type { HostedCheckRun } from './hosted-check.js';
import { proofTests, proofReportSchema } from './landing-proof.js';
import { digest } from './hash.js';
import { candidateIsolation, sharedIsolationRefusal, type CandidateIsolation } from './candidate-user.js';
import { childEnv } from '../scripts/child-env.mjs';
import { ContractTimingReader } from './contract-test-timings.js';
import type { ActionsJobClient } from './hosted-actions-job-client.js';

type ProofPlan = {
  tests: string[];
  delta: { path: string; mode?: string; bytes?: string }[];
  unavailable?: true;
};
/** Reuse cached, verified base bytes only: never add source calls for optional evidence.
 * A cold source without the old blobs records inconclusive proof, not a failed landing. */
export function prepareLandingProof(
  run: HostedCheckRun,
  standard: boolean,
  base: NativeState,
  head: NativeState,
  cache: string,
): ProofPlan | undefined {
  const tests = proofTests(run.proofOnLanding, standard, base, head);
  if (!tests.length) return undefined;
  const before = new Map(base.files.map(f => [f.path, f])),
    after = new Map(head.files.map(f => [f.path, f]));
  const delta: ProofPlan['delta'] = [];
  try {
    for (const path of new Set([...before.keys(), ...after.keys()])) {
      if (tests.includes(path)) continue;
      const old = before.get(path),
        next = after.get(path);
      if (old?.blob === next?.blob && old?.mode === next?.mode) continue;
      if (!old) {
        delta.push({ path });
        continue;
      }
      const bytes = readFileSync(join(cache, old.blob));
      if (digest(bytes) !== old.blob || old.mode === 'gitlink') throw new Error('Base unavailable');
      delta.push({ path, mode: old.mode, bytes: bytes.toString('base64') });
    }
    return { tests, delta };
  } catch {
    return { tests, delta: [], unavailable: true };
  }
}
/** The fixed supervisor spawns base project code with the same isolation as a shard.
 * Build/setup failures are errors; each changed test file runs once, with retries off. */
export async function executeLandingProof(
  client: ActionsJobClient,
  directory: string,
  plan: ProofPlan,
  isolation: CandidateIsolation = candidateIsolation(),
) {
  const run = client.run!;
  const ticket = client.proofTicket;
  if (!ticket || !run.proofOnLanding) return;
  client.holdRunnerTokens();
  const reports: { file: string; base: 'error' | 'passed' | 'failed' }[] = plan.tests.map(file => ({
    file,
    base: 'error',
  }));
  const baseDirectory = mkdtempSync(join(dirname(directory), 'forge-proof-'));
  const control = resolve(import.meta.dirname, '..');
  // No job artifact or ticket is readable by project code. Only the fixed executor and its imports are.
  const paths = { writable: [baseDirectory], readable: [control] };
  const launch = async (command: string[], reader?: ContractTimingReader) => {
    const env = {
      ...childEnv({ allow: ['CI', 'PATH'] }),
      FORGE_TEST_MAX_RETRIES: '0',
      FORGE_TEST_WORKERS: '1',
    } as Record<string, string>;
    const argv = isolation.mode === 'user' ? isolation.command(command, env, baseDirectory, paths) : command;
    return new Promise<number>(done => {
      const child = spawn(argv[0]!, argv.slice(1), {
        cwd: baseDirectory,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (text: string) => {
        reader?.accept(text);
        process.stdout.write(text);
      });
      child.stderr.on('data', (bytes: Buffer) => process.stderr.write(bytes));
      child.once('error', () => done(127));
      child.once('close', code => done(code ?? 128));
    });
  };
  try {
    if (plan.unavailable || sharedIsolationRefusal(isolation, run.configuration))
      throw new Error('Base unavailable');
    cpSync(directory, baseDirectory, { recursive: true, verbatimSymlinks: true });
    // Remove parents first: a head symlink replacing a base directory must be unlinked
    // before touching any old child path, so the cleanup never follows it.
    for (const entry of [...plan.delta].sort((a, b) => a.path.length - b.path.length))
      rmSync(join(baseDirectory, entry.path), { force: true, recursive: true });
    for (const entry of plan.delta
      .filter(e => e.bytes !== undefined)
      .sort((a, b) => Number(a.mode === 'symlink') - Number(b.mode === 'symlink'))) {
      const path = join(baseDirectory, entry.path);
      mkdirSync(dirname(path), { recursive: true });
      const bytes = Buffer.from(entry.bytes!, 'base64');
      if (entry.mode === 'symlink') writeSourceLink(bytes, path);
      else {
        writeFileSync(path, bytes);
        chmodSync(path, entry.mode === 'executable' ? 0o755 : 0o644);
      }
    }
    for (const command of [
      ['npm', 'ci', '--ignore-scripts'],
      ['npm', 'run', 'build:core'],
      ['npm', 'run', 'build:web'],
    ])
      if (await launch(command)) throw new Error('Base setup failed');
    for (const report of reports) {
      const reader = new ContractTimingReader();
      const code = await launch(
        [process.execPath, join(control, 'scripts/test-files.mjs'), report.file],
        reader,
      );
      const observed = reader.reports[report.file];
      report.base = observed ? (observed.failed ? 'failed' : code === 0 ? 'passed' : 'error') : 'error';
    }
  } catch {
    console.log('proof: base unavailable or setup failed; evidence is inconclusive');
  } finally {
    if (isolation.mode === 'user') isolation.remove(baseDirectory);
    else rmSync(baseDirectory, { recursive: true, force: true });
  }
  // Same single-call wire format as preflight; no Convex SDK in the control runtime.
  const input = {
    projectId: run.projectId,
    runId: run.id,
    head: run.request.expectedHead,
    executionId: run.executionId!,
    ticket: ticket.signature,
    report: JSON.stringify(proofReportSchema.parse({ kind: 'proof', reports })),
  };
  await networkDeadline(async signal => {
    const response = await client.request(`${ticket.endpoint}/api/mutation`, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: 'projectLandingProof:report',
        format: 'convex_encoded_json',
        args: [input],
      }),
    });
    const reply = (await response.json()) as { status?: string };
    invariant(
      response.ok && reply.status === 'success',
      'RUNNER_UNAVAILABLE',
      'Optional proof report was not retained.',
    );
  }, 120_000);
  console.log(`proof: reported ${reports.length} base test files`);
}
