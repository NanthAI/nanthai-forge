// SPDX-License-Identifier: Apache-2.0
// GitHub's existing branch/PR/merge-queue protocol, with synthetic-only recovery.
import { resolveContributions } from './replay-source.mjs';
export async function landReplayGithub({
  task,
  ctx,
  github,
  run,
  expected,
  repeated,
  gate,
  recovered,
  second,
  sleep,
  now,
  event,
}) {
  const root = ctx.root;
  let recoveries = 0;
  await run(root, ['add', '-f', '--', ...task.edits.map(e => e.path)]);
  await run(root, ['commit', '-qm', `synthetic replay ${task.id}`]);
  await run(root, ['push', '-q', '-u', 'origin', ctx.branch]);
  const url = await github.gh([
    'pr',
    'create',
    '-R',
    github.repository,
    '--head',
    ctx.branch,
    '--base',
    'main',
    '--title',
    `synthetic replay ${task.id}`,
    '--body',
    'Deterministic zero-model diagnostic.',
  ]);
  const pr = Number(url.trim().match(/\/(\d+)$/)?.[1]);
  if (!pr) throw Error('Diagnostic divergence: PR identity missing');
  let landing;
  let queueError = null;
  const queue = async () => {
    try {
      await github.gh(['pr', 'merge', String(pr), '-R', github.repository, '--squash', '--auto']);
      queueError = null;
    } catch (error) {
      queueError = error;
      event({ event: 'replay-queue-error', task: task.id, error: error.message });
    }
  };
  await queue();
  let merged = false;
  for (let observation = 0; observation < 160; observation++) {
    const at = now();
    const status = JSON.parse(
      await github.gh([
        'pr',
        'view',
        String(pr),
        '-R',
        github.repository,
        '--json',
        'state,mergeStateStatus,autoMergeRequest,mergedAt,mergeCommit',
      ]),
    );
    event({
      event: 'replay-pr-read',
      task: task.id,
      startedAt: new Date(at).toISOString(),
      endedAt: new Date(now()).toISOString(),
      status,
    });
    if (status.state === 'MERGED') {
      if (!status.mergeCommit?.oid || !status.mergedAt)
        throw Error('Diagnostic divergence: merge receipt missing');
      landing = {
        landed: true,
        prs: [pr],
        mergeCommit: status.mergeCommit.oid,
        acceptedAt: github.fromGithub(status.mergedAt),
        mergedAt: github.fromGithub(status.mergedAt),
      };
      merged = true;
      break;
    }
    if (status.state !== 'OPEN') throw Error('Diagnostic divergence: PR closed without merging');
    if (queueError && status.mergeStateStatus !== 'DIRTY') throw queueError;
    if (status.mergeStateStatus === 'DIRTY' || !status.autoMergeRequest) {
      await run(root, ['fetch', '-q', 'origin']);
      try {
        await run(root, ['merge', '-q', '--no-edit', 'origin/main']);
      } catch (error) {
        const paths = (await run(root, ['diff', '--name-only', '--diff-filter=U', '-z']))
          .split('\0')
          .filter(Boolean);
        if (!paths.length) throw error;
        resolveContributions(root, paths, expected);
        await run(root, ['add', '-f', '--', ...paths]);
        await run(root, ['commit', '-qm', `synthetic recovery ${task.id}`]);
        recoveries++;
        if (task.id === 's10' && recoveries === 1) recovered.resolve();
        event({ event: 'replay-recovery', task: task.id, cycle: recoveries });
      }
      if (repeated && task.id === 's10' && recoveries === 1)
        await gate('second-peer-accepted', second.promise);
      await run(root, ['push', '-q', 'origin', ctx.branch]);
      await queue();
    }
    await sleep(15_000);
  }
  if (!merged) throw Error('Diagnostic divergence: existing GitHub observation budget exhausted');

  return { landing, recoveries };
}
