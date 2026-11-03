// SPDX-License-Identifier: Apache-2.0
// CI evidence and the registered runner-pool fairness rule. No network or live bench data.
export const EXCLUSIVE_VERSION_SHARE = 0.5;

/** Timestamp order, never API order or job ID order. Unknown timestamps sort last. */
export function chronologicalJobs(jobs) {
  const time = j => (Number.isFinite(Date.parse(j.startedAt)) ? Date.parse(j.startedAt) : Infinity);
  return [...jobs].sort((a, b) => time(a) - time(b) || String(a.jobId).localeCompare(String(b.jobId)));
}

export function parseRunnerLog(log) {
  const pick = re => log.match(re)?.[1]?.trim() ?? null;
  const image = log.match(/\bImage: (\S+)/);
  // Provisioner Version precedes the OS Image section in hosted-runner logs.
  const imageVersion = image
    ? (log.slice(image.index + image[0].length).match(/^[^\r\n]*\r?\n[^\r\n]*\bVersion: (\S+)/)?.[1] ?? null)
    : null;
  return {
    image: image?.[1] ?? null,
    imageVersion,
    runnerVersion: pick(/Current runner version: '([^']+)'/),
    actions: [
      ...new Set(
        [...log.matchAll(/Download action repository '([^']+)' \(SHA:([0-9a-f]+)\)/g)].map(
          m => `${m[1]}@${m[2]}`,
        ),
      ),
    ].sort(),
  };
}

const counted = values => {
  const counts = new Map();
  for (const value of values) if (value != null) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([value, jobs]) => ({ value, jobs }));
};
const skipped = j => j.conclusion === 'skipped';
const ran = j => !skipped(j) && Number.isFinite(Date.parse(j.startedAt));
const major = version => version?.match(/^(\d+)\./)?.[1] ?? null;

/** Each distinct value counts jobs, not repeated action downloads within one job. */
export function summarizeRunners(jobs) {
  const active = jobs.filter(ran);
  return {
    jobs: jobs.length,
    runnerJobs: active.length,
    skippedJobs: jobs.filter(skipped).length,
    unstartedJobs: jobs.filter(j => !skipped(j) && !ran(j)).length,
    missingEvidenceJobs: jobs
      .filter(j => !skipped(j))
      .filter(
        j =>
          j.error ||
          !Number.isFinite(Date.parse(j.startedAt)) ||
          !j.image ||
          !j.imageVersion ||
          !j.runnerVersion ||
          !Array.isArray(j.actions),
      ).length,
    images: counted(active.map(j => j.image)),
    imageVersions: counted(active.map(j => j.imageVersion)),
    runnerVersions: counted(active.map(j => j.runnerVersion)),
    runnerMajors: counted(active.map(j => major(j.runnerVersion))),
    actions: counted(active.flatMap(j => [...new Set(j.actions ?? [])])),
  };
}

export function runnerCellRule(jobs) {
  const summary = summarizeRunners(jobs),
    voided = [],
    flags = [];
  if (summary.images.length > 1) voided.push('runner OS image name changed within arm');
  if (summary.runnerMajors.length > 1) voided.push('runner major version changed within arm');
  const actions = new Map();
  for (const j of jobs.filter(ran))
    for (const action of j.actions ?? []) {
      const at = action.lastIndexOf('@'),
        spec = action.slice(0, at);
      // Group by repository identity; different job types may omit actions entirely.
      const name = spec.split('@')[0],
        sha = action.slice(at + 1);
      if (!actions.has(name)) actions.set(name, new Set());
      actions.get(name).add(sha);
    }
  for (const [name, shas] of actions)
    if (shas.size > 1) voided.push(`action SHA changed within arm: ${name}`);
  if (summary.imageVersions.length > 1)
    flags.push('mixed runner imageVersions: disclose pool and job counts');
  if (summary.missingEvidenceJobs || !summary.runnerJobs)
    flags.push('incomplete runner evidence: pool comparison unknown for missing jobs');
  return { summary, voided, flags };
}

/** Logs are fetched serially: one request per executed job, one full log resident at a time. */
export async function collectRunners(records, read) {
  const jobs = [];
  for (const record of chronologicalJobs(records)) {
    const evidence =
      record.conclusion === 'skipped'
        ? { image: null, imageVersion: null, runnerVersion: null, actions: [], skipped: true }
        : await read(record.jobId).catch(error => ({ error: String(error.message) }));
    jobs.push({
      ...record,
      image: null,
      imageVersion: null,
      runnerVersion: null,
      actions: null,
      ...evidence,
    });
  }
  const readable = jobs.filter(
    j => ran(j) && !j.error && j.imageVersion && Number.isFinite(Date.parse(j.startedAt)),
  );
  return { jobs, first: readable[0] ?? null, last: readable.at(-1) ?? null, ...runnerCellRule(jobs) };
}

/** Exclusive versions are summed per arm; >50% means a majority used a different pool. */
export function runnerFairness(cells, mode) {
  const arms = {},
    voided = [],
    flags = [];
  for (const arm of ['forge', 'github']) {
    const evidence = cells.find(c => c.arm === arm)?.runner;
    const jobs = evidence?.jobs ?? [];
    const rule = runnerCellRule(jobs);
    arms[arm] = {
      ...rule.summary,
      fullEvidence: Array.isArray(evidence?.jobs),
      exclusiveJobs: 0,
      exclusiveShare: null,
    };
    voided.push(...rule.voided.map(v => `${arm}: ${v}`));
    flags.push(...rule.flags.map(v => `${arm}: ${v}`));
  }
  const values = arm => arms[arm].imageVersions.map(v => v.value);
  const f = values('forge'),
    g = values('github');
  const same = JSON.stringify(f) === JSON.stringify(g);
  if (f.length && g.length) {
    if (!same) flags.push('asymmetric runner imageVersion pools: disclose per-arm versions and job counts');
    for (const [arm, other] of [
      ['forge', g],
      ['github', f],
    ]) {
      const s = arms[arm];
      s.exclusiveJobs = s.imageVersions.filter(v => !other.includes(v.value)).reduce((n, v) => n + v.jobs, 0);
      s.exclusiveShare = s.runnerJobs ? s.exclusiveJobs / s.runnerJobs : null;
      if (s.exclusiveShare > EXCLUSIVE_VERSION_SHARE)
        voided.push(
          `${arm}: exclusive imageVersions exceed 50% of runner jobs (${s.exclusiveJobs}/${s.runnerJobs})`,
        );
    }
  }
  return { mode, exclusiveVersionShareThreshold: EXCLUSIVE_VERSION_SHARE, arms, voided, flags };
}
