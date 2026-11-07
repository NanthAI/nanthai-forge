// SPDX-License-Identifier: Apache-2.0
import { retryActionsInfrastructure, actionsInfrastructureResponse } from '../dist/hosted-actions-retry.js';
import { networkFetch } from '../dist/network-fetch.js';
const pageSize = 20;
const maxBytes = 1024 * 1024;
const freeJobCap = 20;

/** The organization's concurrent-job limit, set by the pipeline that knows its plan
 * (Free 20, Team 60, ...). Absent or invalid keeps the conservative Free limit. */
export function actionsJobCap(env = process.env) {
  const value = env.FORGE_ACTIONS_JOB_CAP;
  const cap = /^[1-9]\d{0,2}$/.test(value ?? '') ? Number(value) : freeJobCap;
  return cap >= 3 ? cap : freeJobCap;
}

/** One bounded observation, not a poller or an admission rule. Repo demand is a
 * lower bound on org demand; enough observations to saturate the job cap are already read.
 * The token is sent only to GitHub, never logged or forwarded to Candidate code. */
export async function readActionsCapacity({
  repository,
  workflow = 'forge-check.yml',
  runId,
  token,
  request = networkFetch,
  jobCap = actionsJobCap(),
}) {
  if (
    !token ||
    !/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') ||
    !/^\d+$/.test(runId ?? '') ||
    !/^[\w.-]+\.ya?ml$/.test(workflow)
  )
    return undefined;
  try {
    const pages = await Promise.all(
      ['queued', 'in_progress'].map(status =>
        retryActionsInfrastructure(
          async signal => {
            const url = `https://api.github.com/repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/runs?status=${status}&per_page=${pageSize}`;
            const response = await actionsInfrastructureResponse(
              await request(url, {
                headers: {
                  authorization: `Bearer ${token}`,
                  accept: 'application/vnd.github+json',
                  'X-GitHub-Api-Version': '2026-03-10',
                },
                redirect: 'error',
                signal,
              }),
            );
            if (!response.ok || !response.body) throw new Error('Capacity unavailable');
            const reader = response.body.getReader(),
              decoder = new TextDecoder();
            let bytes = 0,
              text = '';
            try {
              for (;;) {
                const next = await reader.read();
                if (next.done) break;
                bytes += next.value.byteLength;
                if (bytes > maxBytes) throw new Error('Capacity page too large');
                text += decoder.decode(next.value, { stream: true });
              }
              text += decoder.decode();
            } finally {
              await reader.cancel();
            }
            const page = JSON.parse(text);
            if (!Array.isArray(page.workflow_runs) || page.workflow_runs.length > pageSize)
              throw new Error('Invalid capacity page');
            return page.workflow_runs;
          },
          5000,
          18_000,
        ),
      ),
    );
    const active = new Set([String(runId)]);
    for (const run of pages.flat()) {
      if (!['queued', 'in_progress'].includes(run.status)) continue;
      if (!/^\d+$/.test(String(run.id))) throw new Error('Invalid run identity');
      active.add(String(run.id));
    }
    return { activeChecks: Math.min(jobCap, active.size), jobCap };
  } catch {
    return undefined;
  } // An unavailable optimization never blocks a check.
}
