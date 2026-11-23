#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFileSync } from 'node:fs';
import { microAdmission } from './micro-report.mjs';
const exec = promisify(execFile);

/** No Convex access. Actions keeps the admission history even when a run crashes. */
export async function previousMicroStarts({ repository, runId, now = Date.now(), api }) {
  const starts = [];
  const cutoff = now - 24 * 60 * 60_000;
  for (let page = 1; ; page++) {
    const reply = await api(
      `repos/${repository}/actions/workflows/landing-micro-bench.yml/runs?per_page=100&page=${page}`,
    );
    for (const run of reply.workflow_runs) {
      // Old workflow reruns keep their original created_at. Scan metadata pages,
      // then fetch jobs only for runs whose most recent attempt started today.
      if (Date.parse(run.run_started_at) < cutoff) continue;
      for (let jobPage = 1; ; jobPage++) {
        const { jobs } = await api(
          `repos/${repository}/actions/runs/${run.id}/jobs?filter=all&per_page=100&page=${jobPage}`,
        );
        for (const job of jobs) {
          const step = job.steps?.find(s => s.name === 'Run measured scenario');
          if (step?.started_at && step.conclusion !== 'skipped') starts.push(step.started_at);
        }
        if (jobs.length < 100) break;
      }
    }
    if (reply.workflow_runs.length < 100) break;
  }
  return starts;
}

if (process.argv[1]?.endsWith('/micro-gate.mjs')) {
  try {
    const starts = await previousMicroStarts({
      repository: process.env.GITHUB_REPOSITORY,
      runId: process.env.GITHUB_RUN_ID,
      api: async path => JSON.parse((await exec('gh', ['api', path], { maxBuffer: 8 << 20 })).stdout),
    });
    const verdict = microAdmission(starts);
    appendFileSync(process.env.GITHUB_OUTPUT, `admitted=${verdict.admitted}\n`);
    console.log(JSON.stringify(verdict));
  } catch {
    console.error('Admission history unavailable; no benchmark started.');
    process.exitCode = 1;
  }
}
