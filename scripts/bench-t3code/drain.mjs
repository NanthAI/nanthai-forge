// SPDX-License-Identifier: Apache-2.0
// Freeze coordination (97c7a123). Under its hold the driver waits until the runs it is given
// are gone: since the exit plan's "Quiet rule and deploys" (lead 2026-11-09) that is a Convex
// deploy in flight, plus (lead acdbee8b) a queued or checking dogfood landing that changes
// landing-path convex/ files (`landingPathQueue`). Other dogfood landings keep going and their
// main moves are recorded.
// It only reads: nothing is cancelled, superseded or restricted. A wait that does not end in
// time releases the hold and retries. `hostedQueueEntries` reads the dogfood queue for reports.
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { offLandingPath } from './versions.mjs';

const run = promisify(execFile);

/** One bounded `queue` read (a single Convex query) of the dogfood project; every listed
 * entry is an admitted, unfinished landing. Returns short labels, one per entry. An unreadable
 * queue throws: the caller treats it as not drained. */
export async function hostedQueueEntries({ cli, url, projectId, root }, exec = run) {
  await mkdir(root, { recursive: true });
  const { stdout } = await exec(
    '/usr/local/bin/node',
    [cli, 'agent', root, 'queue', JSON.stringify({ url, projectId, limit: 20 })],
    { maxBuffer: 8 << 20 },
  );
  const line = stdout
    .split('\n')
    .filter(l => l.startsWith('{'))
    .at(-1);
  const view = line ? JSON.parse(line).result : null;
  if (!view || !Array.isArray(view.entries)) throw Error('queue reply has no entries');
  const labels = view.entries.map(e => `${e.phase ?? 'queued'} ${String(e.laneId ?? '').slice(0, 8)}`.trim());
  // A page shorter than the queue still counts every entry.
  while (labels.length < (view.total ?? 0)) labels.push('queued (not listed)');
  return labels;
}

/** Queued or checking dogfood landings that change landing-path convex/ files (exit plan
 * "Quiet rule and deploys", lead acdbee8b): one `queue` read, plus one `diff` summary (the
 * Lane's changed paths) per submission not in `cache` (submissionId -> paths). An entry whose
 * paths cannot be read counts, and so does an entry past the listed page (counts when unsure).
 * src/, tests/, docs/ and off-path convex/ landings do not. Returns one label per blocking
 * entry; an unreadable queue throws (the caller treats it as not drained). */
export async function landingPathQueue(
  { cli, url, projectId, root },
  { cache = new Map(), exec = run } = {},
) {
  await mkdir(root, { recursive: true });
  const call = async (action, body) => {
    const { stdout } = await exec(
      '/usr/local/bin/node',
      [cli, 'agent', root, action, JSON.stringify({ url, projectId, ...body })],
      { maxBuffer: 8 << 20 },
    );
    const line = stdout
      .split('\n')
      .filter(l => l.startsWith('{'))
      .at(-1);
    const reply = line ? JSON.parse(line) : null;
    if (!reply?.result) throw Error(`${action} reply: ${reply?.error?.code ?? 'no result'}`);
    return reply.result;
  };
  const view = await call('queue', { limit: 20 });
  if (!Array.isArray(view.entries)) throw Error('queue reply has no entries');
  const labels = [];
  for (const e of view.entries) {
    const tag = `${e.phase ?? 'queued'} ${String(e.laneId ?? '').slice(0, 8)}`.trim();
    let paths = e.submissionId ? cache.get(e.submissionId) : undefined;
    if (!paths)
      try {
        if (!e.laneId) throw Error('no laneId');
        const d = await call('diff', { laneId: e.laneId, summary: true });
        if (d.truncated || d.nextCursor || !Array.isArray(d.items)) throw Error('diff truncated');
        paths = d.items.map(i => i.path);
        if (e.submissionId) cache.set(e.submissionId, paths);
      } catch (error) {
        labels.push(`${tag} (changed paths unreadable: ${String(error.message).slice(0, 80)}; counts)`);
        continue;
      }
    const on = paths.filter(p => p.startsWith('convex/') && !offLandingPath(p));
    if (on.length)
      labels.push(
        `${tag} changes ${on.slice(0, 3).join(', ')}${on.length > 3 ? ` (+${on.length - 3})` : ''}`,
      );
  }
  for (let n = view.entries.length; n < (view.total ?? 0); n++) labels.push('queued (not listed; counts)');
  return labels;
}

/** Wait, under the hold, until neither a workflow run nor an admitted hosted submission is in
 * flight. `runs()` and `queue()` return arrays; a failed read counts as in flight. False when
 * the deadline passes first (the caller releases the hold; nothing was cancelled). */
export async function drainBatch({ key, runs, queue, deadlineMs, pauseMs, say, wait, now = Date.now }) {
  const until = now() + deadlineMs;
  for (;;) {
    const actions = await runs().catch(e => [{ name: `unreadable: ${e.message}` }]);
    const admitted = await queue().catch(e => [`unreadable: ${e.message}`]);
    if (!actions.length && !admitted.length) return true;
    if (now() > until) return false;
    const parts = [];
    if (actions.length)
      parts.push(
        `${actions.length} nanthai-forge run(s) still in flight (${actions.map(x => x.workflowName ?? x.name).join(', ')})`,
      );
    if (admitted.length)
      parts.push(`${admitted.length} admitted hosted submission(s) not finished (${admitted.join(', ')})`);
    say(`WAIT ${key}: holding; ${parts.join('; ')}`);
    await wait(pauseMs);
  }
}
