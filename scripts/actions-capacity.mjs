// SPDX-License-Identifier: Apache-2.0
const pageSize = 20;
const maxBytes = 1024 * 1024;

/** One bounded observation, not a poller or an admission rule. Repo demand is a
 * lower bound on org demand; twenty observations already saturate the Free cap.
 * The token is sent only to GitHub, never logged or forwarded to Candidate code. */
export async function readActionsCapacity({
  repository,
  workflow = 'forge-check.yml',
  runId,
  token,
  request = fetch,
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
      ['queued', 'in_progress'].map(async status => {
        const url = `https://api.github.com/repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/runs?status=${status}&per_page=${pageSize}`;
        const response = await request(url, {
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2026-03-10',
          },
          redirect: 'error',
          signal: AbortSignal.timeout(5000),
        });
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
      }),
    );
    const active = new Set([String(runId)]);
    for (const run of pages.flat()) {
      if (!['queued', 'in_progress'].includes(run.status)) continue;
      if (!/^\d+$/.test(String(run.id))) throw new Error('Invalid run identity');
      active.add(String(run.id));
    }
    return { activeChecks: Math.min(20, active.size), jobCap: 20 };
  } catch {
    return undefined;
  } // An unavailable optimization never blocks a check.
}
