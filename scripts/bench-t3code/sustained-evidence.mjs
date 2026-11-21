// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveAuthToken } from '../../dist/auth-store.js';
import { checkCause } from '../../dist/check-run-state.js';
import { ConvexExchange } from '../../dist/exchange-client.js';
import { HostedAgentTransport } from '../../dist/hosted-agent-transport.js';
import { HostedCheckoutCache } from '../../dist/hosted-checkout-cache.js';
import { ConvexLaneTransport } from '../../dist/hosted-lane-transport.js';
import { selectExactHostedSource, selectHostedMain } from '../../dist/mcp-hosted-source.js';
import { parseNativeState } from '../../dist/state/format.js';
import { readBenchJobs } from './sustained-capacity.mjs';
import { certifyingSustainedCheck } from './sustained-score.mjs';

const time = value => (typeof value === 'number' ? value : Date.parse(value));
const unique = values => [...new Set(values.filter(Boolean))];

/** Batch each State's fixture blobs, verify hashes and reselect the same State before
 * returning bytes. Reading a later main would miss transient red certifications. */
function stateReader({ checkout, projectId, deployment, scratch }) {
  const token = resolveAuthToken(deployment);
  const exchange = new ConvexExchange(deployment, token, projectId, '', null);
  const transport = new HostedAgentTransport(checkout, { url: deployment, projectId }, exchange);
  const objects = new ConvexLaneTransport(exchange);
  const cache = new HostedCheckoutCache(join(scratch, 'oracle-cache'), objects);
  const exact = async state => {
    await selectExactHostedSource(transport, { state });
    await cache.ensure([state]);
    const manifest = parseNativeState(readFileSync(join(cache.objects, state)));
    const files = manifest.files.filter(file => file.path.startsWith('bench-workload/'));
    objects.selectState(state, manifest.files);
    await cache.ensure(files.map(file => file.blob));
    const bytes = Object.fromEntries(
      files.map(file => [file.path, readFileSync(join(cache.objects, file.blob), 'utf8')]),
    );
    await selectExactHostedSource(transport, { state });
    return bytes;
  };
  return { exact, main: () => selectHostedMain(transport) };
}

async function readPages(read, action, body, listKey, cursorKey, onPage = () => {}) {
  const rows = [];
  let cursor;
  do {
    const page = await read(action, { ...body, ...(cursor === undefined ? {} : cursor) });
    onPage(page);
    rows.push(...page[listKey]);
    cursor = page[cursorKey]
      ? { [cursorKey === 'nextCursor' ? 'cursor' : 'beforeAttempt']: page[cursorKey] }
      : undefined;
  } while (cursor);
  return rows;
}

/** Evidence is read after the arm, while the repo and check logs still exist. */
export async function collectSustained({
  config,
  setup,
  plan,
  release,
  observedThroughMs,
  arm,
  traceEvent,
  read,
  readLog,
}) {
  const provider = (await readBenchJobs(setup.repo)).filter(run => run.createdAtMs >= release.startedAtMs);
  const runsByProvider = new Map(provider.map(run => [run.checkId, run]));
  const source = stateReader({ ...setup, deployment: config.deployment, scratch: config.scratch });
  const observedMain = await source.main();
  const landings = await readPages(
    read,
    'landings',
    {
      from: new Date(release.startedAtMs).toISOString(),
      to: new Date(observedThroughMs + 1).toISOString(),
    },
    'landings',
    'nextCursor',
  );
  const attemptHistory = [];
  let attemptHistoryComplete = true;
  for (const id of unique(release.submissions.flatMap(task => task.submissionIds ?? []))) {
    attemptHistory.push({
      id,
      attempts: await readPages(
        read,
        'queue',
        { submissionId: id },
        'attempts',
        'nextBeforeAttempt',
        page => {
          if (page.historyPartial) attemptHistoryComplete = false;
        },
      ),
    });
  }
  traceEvent({ event: 'retained-landings', landings, attemptHistory });
  const runIds = unique([
    ...provider.map(run => run.checkId),
    ...release.submissions.map(submission => submission.acceptance?.proofRunId),
    ...landings.flatMap(landing => [...landing.checkRunIds, landing.followingAudit?.runId]),
    ...attemptHistory.flatMap(({ attempts }) => attempts.map(attempt => attempt.runId)),
  ]);
  const runs = new Map();
  for (const id of runIds) {
    const run = await read('status', { runId: id });
    const log = run.status === 'failed' ? await readLog(id) : '';
    const soloRedTasks = [...log.matchAll(/BENCH_SOLO_RED (s\d{2})\b/g)].map(match => match[1]);
    const jointRedPairs = [...log.matchAll(/BENCH_JOINT_RED (s\d{2}\+s\d{2})\b/g)].map(match => match[1]);
    runs.set(id, { ...run, soloRedTasks, jointRedPairs });
    traceEvent({
      event: 'retained-check',
      run,
      soloRedTasks,
      jointRedPairs,
      provider: runsByProvider.get(id),
    });
  }
  const submissions = release.submissions.map(submission => {
    if (submission.outcome !== 'terminal-failed') return submission;
    const latest = attemptHistory.find(item => item.id === submission.submissionIds.at(-1))?.attempts[0];
    const runId = latest?.runId;
    return { ...submission, runId, outcome: runs.get(runId)?.status === 'failed' ? 'check-failed' : 'error' };
  });
  const expectedRedChecks = new Set(
    submissions
      .filter(
        submission =>
          plan.tasks.find(task => task.id === submission.taskId)?.soloRed &&
          runs.get(submission.runId)?.soloRedTasks.includes(submission.taskId),
      )
      .map(submission => submission.runId),
  );
  const publications = [];
  const used = new Set();
  let lastHead = release.baseHead;
  let publicationsComplete = true;
  for (const landing of landings) {
    if (landing.landedHead === lastHead) continue;
    if (lastHead && landing.landedBase.head !== lastHead) publicationsComplete = false;
    lastHead = landing.landedHead;
    const proofRunId = submissions.find(submission => submission.acceptance?.receiptId === landing.receiptId)
      ?.acceptance.proofRunId;
    const runId = certifyingSustainedCheck({ ...landing, head: lastHead, proofRunId }, runs);
    used.add(runId);
    publications.push({
      head: lastHead,
      atMs: time(landing.committedAt),
      runId,
      files: await source.exact(lastHead),
    });
  }
  const checks = [...runs].map(([id, run]) => {
    const audit = run.gate?.mode === 'audit';
    const providerJobs = runsByProvider.get(id)?.jobs ?? [];
    const shardsValid = ['forge-hosted-0', 'forge-hosted-1'].every(name =>
      providerJobs.some(
        job => job.name === name && time(job.completed_at) - time(job.started_at) >= plan.shardMs,
      ),
    );
    return {
      id,
      kind: audit ? 'audit' : 'landing',
      status: run.status,
      finishedAtMs: time(run.endedAt),
      soloRedTasks: run.soloRedTasks,
      jointRedPairs: run.jointRedPairs,
      disposition: audit
        ? 'audit'
        : used.has(id)
          ? 'accepted'
          : expectedRedChecks.has(id)
            ? 'expected-red'
            : 'discarded',
      jobIds: providerJobs.map(job => job.id),
      ...(audit || used.has(id) || expectedRedChecks.has(id) ? { shardsValid } : {}),
    };
  });
  const jobs = provider.flatMap(run =>
    run.jobs.map(job => ({
      id: job.id,
      name: job.name,
      conclusion: job.conclusion,
      queuedAtMs: time(job.created_at),
      startedAtMs: time(job.started_at),
      endedAtMs: time(job.completed_at),
    })),
  );
  const holds = attemptHistory.flatMap(({ attempts }) =>
    attempts.flatMap(attempt =>
      (attempt.periods ?? [])
        .filter(period => period.endedAt && period.phase !== 'checking')
        .map(period => ({
          reason: period.phase,
          startedAtMs: time(period.startedAt),
          endedAtMs: time(period.endedAt),
        })),
    ),
  );
  for (const landing of landings)
    if (landing.cohortHold?.status === 'released')
      holds.push({
        reason: 'cohort-hold',
        startedAtMs: time(landing.cohortHold.startedAt),
        endedAtMs: time(landing.cohortHold.endedAt),
      });
  for (const job of jobs)
    if (job.conclusion !== 'skipped' && job.startedAtMs >= job.queuedAtMs)
      holds.push({ reason: 'runner-queue', startedAtMs: job.queuedAtMs, endedAtMs: job.startedAtMs });
  const idsByTask = new Map(
    submissions.map(submission => [submission.taskId, submission.submissionIds ?? []]),
  );
  const overlapHeldPairs = plan.pairs
    .filter(pair => {
      const [a, b] = pair.members.map(id => idsByTask.get(id));
      return landings.some(landing => {
        const other = a.includes(landing.submissionId) ? b : b.includes(landing.submissionId) ? a : [];
        return (landing.orderWaits ?? []).some(
          wait => wait.footprints === 'overlap' && other.includes(wait.submissionId),
        );
      });
    })
    .map(pair => pair.id);
  const attemptsById = new Map(attemptHistory.map(record => [record.id, record.attempts]));
  const refusals = plan.pairs
    .filter(
      pair =>
        overlapHeldPairs.includes(pair.id) &&
        pair.members
          .flatMap(taskId => idsByTask.get(taskId))
          .some(id =>
            attemptsById
              .get(id)
              ?.some(attempt =>
                [checkCause.mainMoved, checkCause.admissionFollowup].includes(attempt.checkCause),
              ),
          ),
    )
    .map(pair => pair.id);
  return {
    ...release,
    submissions,
    arm,
    observedThroughMs,
    publicationsComplete: publicationsComplete && lastHead === observedMain.head,
    attemptHistoryComplete,
    observedMainHead: observedMain.head,
    publications,
    checks,
    jobs,
    holds,
    refusals,
    overlapHeldPairs,
  };
}
