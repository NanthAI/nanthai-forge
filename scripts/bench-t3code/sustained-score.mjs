// SPDX-License-Identifier: Apache-2.0
import { replayDigest } from './replay-schedule.mjs';
import { sustainedVerdict } from './sustained-oracle.mjs';

const minute = 60_000;
const minutes = milliseconds => (milliseconds === null ? null : milliseconds / minute);
const percentile = (sorted, p) => sorted[Math.ceil(sorted.length * p) - 1] ?? null;
const sum = values => values.reduce((total, value) => total + value, 0);
const ratio = (numerator, denominator) => (denominator ? numerator / denominator : null);
const unique = values => [...new Set(values)];

function scoreMain(plan, publications, missing) {
  const landed = new Map();
  const states = [];
  let previous = new Set();
  for (const publication of publications) {
    if (!publication.head || !Number.isFinite(publication.atMs) || !publication.files) {
      missing.push('exact published State bytes or timestamp');
      continue;
    }
    const verdict = sustainedVerdict(plan, new Map(Object.entries(publication.files)));
    const present = new Set(verdict.present);
    const lost = [...previous].filter(task => !present.has(task));
    for (const task of lost) landed.delete(task);
    for (const task of present) {
      if (!landed.has(task) && verdict.green && !lost.length) landed.set(task, publication);
    }
    states.push({
      head: publication.head,
      atMs: publication.atMs,
      ...verdict,
      lost,
      falseCertification: !verdict.green || lost.length > 0,
    });
    previous = present;
  }
  return { states, landed };
}

function scoreJobs(checks, jobs, missing) {
  const byId = new Map(jobs.map(job => [job.id, job]));
  const counted = new Set();
  let discardedMinutes = 0;
  let runnerMinutes = 0;
  for (const check of checks) {
    if (
      !check.jobIds?.length ||
      !['accepted', 'audit', 'discarded', 'expected-red'].includes(check.disposition)
    )
      missing.push(`check ${check.id} job list or disposition`);
    for (const id of check.jobIds ?? []) {
      if (counted.has(id)) {
        missing.push(`duplicate job ${id}`);
        continue;
      }
      counted.add(id);
      const job = byId.get(id);
      if (!job) {
        missing.push(`job ${id}`);
        continue;
      }
      if (job.conclusion === 'skipped') continue;
      if (
        !Number.isFinite(job.startedAtMs) ||
        !Number.isFinite(job.endedAtMs) ||
        job.endedAtMs < job.startedAtMs
      ) {
        missing.push(`job ${id} timing`);
        continue;
      }
      const billed = Math.ceil(minutes(job.endedAtMs - job.startedAtMs));
      runnerMinutes += billed;
      if (check.disposition === 'discarded') discardedMinutes += billed;
    }
  }
  if (jobs.some(job => !counted.has(job.id))) missing.push('unattributed runner jobs');
  return { runnerMinutes, discardedMinutes };
}

function decisions(metrics) {
  const {
    arm,
    backlogGrowth,
    p90Minutes,
    p50Minutes,
    checksPerGreen,
    mainReds,
    falseCertifications,
    durableGreensInWindow,
    coldStartCeiling,
    checkToCommitP90Seconds,
    backlog,
    discardShare,
  } = metrics;
  const isFast = arm === 'dogfood';
  const within = (value, max) => value !== null && value <= max;
  const greater = (value, max) => value !== null && value > max;
  return {
    fable: isFast
      ? backlogGrowth > 0 || greater(checksPerGreen, 3) || checksPerGreen === 3
        ? 'collapse'
        : backlogGrowth === 0 && within(p90Minutes, 35) && within(checksPerGreen, 2.3)
          ? 'collapse-refuted'
          : 'inconclusive'
      : backlogGrowth > 0
        ? 'groups-saturated'
        : backlogGrowth === 0 &&
            within(p50Minutes, 30) &&
            within(p90Minutes, 45) &&
            within(checksPerGreen, 1.9) &&
            mainReds === 0 &&
            falseCertifications === 0
          ? 'passes'
          : 'inconclusive',
    astra: backlogGrowth === 0 && within(p90Minutes, 40) && falseCertifications === 0 ? 'passes' : 'fails',
    gemini: isFast
      ? durableGreensInWindow < 22 ||
        backlog.at(-1).pending > 8 ||
        greater(checksPerGreen, 2.1) ||
        greater(p90Minutes, 35) ||
        greater(discardShare, 0.3)
        ? 'collapse'
        : 'inconclusive'
      : backlogGrowth === 0 &&
          within(checksPerGreen, 1.75) &&
          within(p90Minutes, 26) &&
          within(checkToCommitP90Seconds, 30) &&
          mainReds === 0 &&
          falseCertifications === 0
        ? coldStartCeiling < 28
          ? 'throughput-inconclusive'
          : durableGreensInWindow >= 28
            ? 'passes'
            : 'fails'
        : 'fails',
    geminiThroughput: !isFast && coldStartCeiling < 28 ? 'inconclusive' : undefined,
  };
}

/** Score the release window plus drain. Missing observations suppress pass/fail claims. */
export function scoreSustained(plan, trace) {
  const { arm, startedAtMs, observedThroughMs, submissions, checks, jobs, publications, holds, refusals } =
    trace;
  if (!['dogfood', 'strict'].includes(arm) || trace.planDigest !== replayDigest(plan))
    throw Error('Sustained trace has a different plan or unknown arm');
  const end = startedAtMs + plan.scoredMs;
  const missing = [];
  const checkById = new Map(checks.map(check => [check.id, check]));
  const submissionByTask = new Map(submissions.map(submission => [submission.taskId, submission]));
  if (checkById.size !== checks.length || submissionByTask.size !== submissions.length)
    throw Error('Sustained trace contains duplicate submissions or check IDs');
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(observedThroughMs) || observedThroughMs < end)
    missing.push('complete release window observation');
  if (!trace.drained || trace.aborted) missing.push('uninterrupted drain');
  if (!trace.publicationsComplete) missing.push('complete main publication history');
  if (trace.attemptHistoryComplete === false) missing.push('complete retained attempt history');
  if (trace.pinsStable === false) missing.push('unchanged bench deployment and runner pins');
  if (!Array.isArray(holds)) missing.push('queue hold timings');
  if (!Array.isArray(refusals)) missing.push('cohort refusals');
  const { states, landed } = scoreMain(
    plan,
    [...publications].sort((a, b) => a.atMs - b.atMs),
    missing,
  );
  const greenTasks = plan.tasks.filter(task => !task.soloRed);
  const finishToMain = [];
  const checkToCommit = [];
  const badShards = checks.filter(check => check.shardsValid === false).map(check => check.id);
  if (badShards.length) missing.push('two nine-minute test shards for ' + badShards.join(', '));
  let expectedReds = 0;
  let unexpectedReds = 0;
  let durableGreensInWindow = 0;
  let durableGreensAfterTenMinutes = 0;
  for (const task of plan.tasks) {
    const submission = submissionByTask.get(task.id);
    const publication = landed.get(task.id);
    const check = checkById.get(submission?.runId);
    if (!submission || !Number.isFinite(submission.startedAtMs)) missing.push(`submission ${task.id}`);
    if (
      task.soloRed &&
      submission?.outcome === 'check-failed' &&
      check?.status === 'failed' &&
      check.soloRedTasks?.includes(task.id)
    )
      expectedReds++;
    else if (submission?.outcome === 'check-failed') unexpectedReds++;
    else if (submission?.outcome !== 'accepted') missing.push(`terminal result ${task.id}`);
    if (!publication) {
      if (submission?.outcome === 'accepted') missing.push(`accepted source for ${task.id}`);
      continue;
    }
    if (task.soloRed) continue;
    if (publication.atMs <= end) {
      durableGreensInWindow++;
      if (publication.atMs >= startedAtMs + 10 * minute) durableGreensAfterTenMinutes++;
    }
    if (Number.isFinite(submission?.startedAtMs) && publication.atMs >= submission.startedAtMs)
      finishToMain.push(publication.atMs - submission.startedAtMs);
    else missing.push(`finish-to-main for ${task.id}`);
    const certifiedBy = checkById.get(publication.runId);
    if (
      certifiedBy?.status === 'passed' &&
      Number.isFinite(certifiedBy.finishedAtMs) &&
      publication.atMs >= certifiedBy.finishedAtMs
    )
      checkToCommit.push(publication.atMs - certifiedBy.finishedAtMs);
    else missing.push(`check-to-commit for ${task.id}`);
  }
  const holdMs = new Map();
  for (const hold of holds ?? []) {
    if (
      !hold.reason ||
      !Number.isFinite(hold.startedAtMs) ||
      !Number.isFinite(hold.endedAtMs) ||
      hold.endedAtMs < hold.startedAtMs
    ) {
      missing.push('invalid queue hold timing');
      continue;
    }
    holdMs.set(hold.reason, (holdMs.get(hold.reason) ?? 0) + hold.endedAtMs - hold.startedAtMs);
  }
  const backlogAt = offset => {
    const atMs = startedAtMs + offset;
    return {
      minute: offset / minute,
      pending: greenTasks.filter(task => task.releaseAtMs <= offset && !(landed.get(task.id)?.atMs <= atMs))
        .length,
    };
  };
  const backlog = Array.from({ length: plan.scoredMs / (5 * minute) + 1 }, (_, i) =>
    backlogAt(i * 5 * minute),
  );
  const durableGreens = greenTasks.filter(task => landed.has(task.id)).length;
  const landingChecks = checks.filter(check => check.kind !== 'audit').length;
  const audits = checks.length - landingChecks;
  const spending = scoreJobs(checks, jobs, missing);
  finishToMain.sort((a, b) => a - b);
  checkToCommit.sort((a, b) => a - b);
  const metrics = {
    arm,
    durableGreens,
    durableGreensInWindow,
    ...(plan.kind === 'sustained-hour'
      ? {
          stationaryWindow: {
            fromMinute: 10,
            toMinute: 60,
            greens: durableGreensAfterTenMinutes,
            greensPerHour: durableGreensAfterTenMinutes * (60 / 50),
          },
        }
      : {}),
    coldStartCeiling: greenTasks.filter(task => task.releaseAtMs + plan.shardMs <= plan.scoredMs).length,
    landingChecks,
    audits,
    checksPerGreen: ratio(landingChecks, durableGreens),
    p50Minutes: minutes(percentile(finishToMain, 0.5)),
    p90Minutes: minutes(percentile(finishToMain, 0.9)),
    checkToCommitP90Seconds:
      percentile(checkToCommit, 0.9) === null ? null : percentile(checkToCommit, 0.9) / 1000,
    ...spending,
    discardShare: ratio(spending.discardedMinutes, spending.runnerMinutes),
    backlog,
    backlogGrowth: backlog.at(-1).pending - backlog[Math.floor(backlog.length / 2)].pending,
    drainBacklog: backlogAt(observedThroughMs - startedAtMs),
    expectedReds,
    unexpectedReds,
    mainReds: states.filter(state => !state.green).length,
    falseCertifications: states.filter(state => state.falseCertification).length,
    evaluatedPairs: unique(states.flatMap(state => state.evaluatedPairs)),
    refusedPairs: unique(refusals ?? []),
    overlapHeldPairs: unique(trace.overlapHeldPairs ?? []),
    dominantHold: [...holdMs].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null,
  };
  return {
    ...metrics,
    missing: unique(missing),
    decisions: missing.length || plan.kind !== 'sustained-hour' ? null : decisions(metrics),
    ...(plan.kind === 'sustained-smoke'
      ? {
          qualified:
            !missing.length &&
            expectedReds === plan.tasks.length - greenTasks.length &&
            durableGreens === greenTasks.length &&
            metrics.falseCertifications === 0,
        }
      : {}),
    states,
  };
}
