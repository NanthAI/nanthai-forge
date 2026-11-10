// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { proofReportSchema } from './landing-proof.js';

/**
 * Checks as a status any CI reports for a Candidate (flip 3, Issue 4e4204b6): a second check provider
 * beside Forge's runner. Forge publishes the Candidate's Git commit on a branch of the project's CI
 * repository, the project's own CI file runs on it (one trigger line), and the run's outcome becomes the
 * check's verdict.
 *
 * The pass rule is today's (src/hosted-check-verdict.ts): the job that ran the Candidate can write
 * anything it reports, so a pass needs the provider's own record of this run, received on a channel the
 * job cannot write: a signed provider event, or a provider API read Forge makes with the adapter's
 * credential. A report from the job never passes a check, whatever identity it carries; it can only wake
 * Forge to read the provider record and carry a summary. A record counts only for the exact run Forge
 * bound: the configured repository and CI file, the Candidate branch, the published commit and the
 * provider's first execution for them. The CI file is a check entry (`ciStatusEntryPaths`): a Candidate
 * that changes it ran a check it defined itself, so governance holds it for the owner's review, as for
 * any check script. Outside contributors' Candidates are published (and get a job with the repository's
 * secrets) only after the owner approves them.
 */
export const CANDIDATE_BRANCH_PREFIX = 'forge/candidates/';
export const candidateBranch = (runId: string) => `${CANDIDATE_BRANCH_PREFIX}${runId}`;

const repository = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const credential = z.object({
  secretId: z.string().min(1),
  version: z.number().safe().int(),
  operation: z.string().min(1),
});

/** The project setting: which CI repository and file run the check. A credential is a use reference. */
export const ciStatusProviderSchema = z.discriminatedUnion('adapter', [
  z
    .object({
      adapter: z.literal('github-actions'),
      repository,
      workflow: z.string().regex(/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/),
    })
    .strict(),
  z
    .object({
      adapter: z.literal('gitlab-ci'),
      origin: z.string().regex(/^https:\/\/[a-z0-9.-]+(:[0-9]+)?$/),
      projectPath: z.string().regex(/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/),
      projectId: z.number().safe().int().positive(),
      ciFile: z.string().min(1).default('.gitlab-ci.yml'),
      credential,
    })
    .strict(),
]);
export type CiStatusProvider = z.infer<typeof ciStatusProviderSchema>;

/** What Forge bound when it published the Candidate. `executionId` is the provider run Forge accepted
 * first for this branch and commit; later runs (a re-run, a run a job started) never replace it. */
export type CandidateBinding = {
  runId: string;
  commit: string;
  executionId: string | null;
};

/** One status line a CI job reports to Forge: never a pass on its own (see above). */
export const reportedStatusSchema = z
  .object({
    name: z.string().min(1).max(100),
    state: z.enum(['pending', 'passed', 'failed', 'cancelled']),
    link: z.url({ protocol: /^https$/ }).max(2048),
    summary: z.string().max(4000).default(''),
  })
  .strict();

/** Evidence a verdict may come from. `job-report` carries the reporting job's verified identity
 * (OIDC claims whose signature the caller checked); provider evidence arrives on Forge's own channel. */
export type CiEvidence =
  | { source: 'job-report'; claims: Record<string, unknown>; status: unknown }
  | { source: 'provider-event'; signed: boolean; payload: unknown }
  | { source: 'provider-api'; record: unknown };

export type CiVerdict =
  | { outcome: 'refused'; code: 'EVIDENCE_CHANGED'; reason: string }
  /** A job's report matched the binding: read the provider record now (no polling) and keep the summary. */
  | { outcome: 'read-provider'; summary: string; link: string }
  | { outcome: 'proof'; proof: z.infer<typeof proofReportSchema> }
  | { outcome: 'pending'; executionId: string }
  | {
      outcome: 'terminal';
      status: 'passed' | 'failed' | 'cancelled' | 'runner-unavailable';
      executionId: string;
      link: string | null;
      conclusion: string;
    };

const refuse = (reason: string): CiVerdict => ({ outcome: 'refused', code: 'EVIDENCE_CHANGED', reason });

/** The pass rule shared by every adapter: a provider record of the bound run, never a job's word. */
function decide(
  binding: CandidateBinding,
  run: {
    executionId: string;
    status: 'pending' | 'success' | 'failed' | 'cancelled' | 'other';
    link: string | null;
    conclusion: string;
  },
): CiVerdict {
  if (binding.executionId && binding.executionId !== run.executionId)
    return refuse(`Execution ${run.executionId} is not the run Forge bound (${binding.executionId}).`);
  if (run.status === 'pending') return { outcome: 'pending', executionId: run.executionId };
  const status =
    run.status === 'success'
      ? 'passed'
      : run.status === 'failed'
        ? 'failed'
        : run.status === 'cancelled'
          ? 'cancelled'
          : 'runner-unavailable';
  return {
    outcome: 'terminal',
    status,
    executionId: run.executionId,
    link: run.link,
    conclusion: run.conclusion,
  };
}

/** A job's report: checked against the binding, then only ever a wake (`read-provider`). */
function jobReport(identity: string | null, status: unknown): CiVerdict {
  if (identity) return refuse(identity);
  const proof = proofReportSchema.safeParse(status);
  if (proof.success) return { outcome: 'proof', proof: proof.data };
  const parsed = reportedStatusSchema.safeParse(status);
  if (!parsed.success) return refuse('The status report is malformed.');
  return { outcome: 'read-provider', summary: parsed.data.summary, link: parsed.data.link };
}

const githubRun = z.object({
  action: z.string(),
  repository: z.object({ full_name: z.string() }),
  workflow_run: z.object({
    id: z.number().safe().positive(),
    run_attempt: z.number().safe().int(),
    event: z.string(),
    path: z.string(),
    head_branch: z.string().nullable(),
    head_sha: z.string(),
    status: z.string().nullable(),
    conclusion: z.string().nullable(),
    html_url: z.string().nullable().optional(),
  }),
});

/** GitHub Actions: the HMAC-signed `workflow_run` event (or the same run read from the API) of the
 * configured workflow, triggered by Forge's push of the Candidate branch. */
function githubActions(
  provider: Extract<CiStatusProvider, { adapter: 'github-actions' }>,
  binding: CandidateBinding,
  evidence: CiEvidence,
): CiVerdict {
  const branch = candidateBranch(binding.runId);
  if (evidence.source === 'job-report') {
    const c = evidence.claims;
    const identity =
      c.repository !== provider.repository
        ? 'The report comes from another repository.'
        : c.ref !== `refs/heads/${branch}` || c.sha !== binding.commit
          ? 'The report comes from another branch or commit.'
          : c.workflow_ref !== `${provider.repository}/${provider.workflow}@refs/heads/${branch}`
            ? 'The report comes from another workflow.'
            : null;
    return jobReport(identity, evidence.status);
  }
  if (evidence.source === 'provider-event' && !evidence.signed)
    return refuse('Only a signed GitHub event can carry a run result.');
  const parsed = githubRun.safeParse(
    evidence.source === 'provider-event'
      ? evidence.payload
      : { action: 'read', ...(evidence.record as object) },
  );
  if (!parsed.success) return refuse('The GitHub run record is malformed.');
  const { repository: repo, workflow_run: run } = parsed.data;
  if (repo.full_name.toLowerCase() !== provider.repository.toLowerCase())
    return refuse('The run belongs to another repository.');
  if (run.path !== provider.workflow)
    return refuse(`The run is of ${run.path}, not the configured ${provider.workflow}.`);
  // Forge triggers by pushing the branch; any other event (a dispatch, a schedule) was started by someone else.
  if (run.event !== 'push') return refuse(`The run was started by ${run.event}, not by Forge's push.`);
  if (run.head_branch !== branch || run.head_sha !== binding.commit)
    return refuse('The run checked another branch or commit than the published Candidate.');
  if (run.run_attempt !== 1) return refuse('A re-run attempt is not the run Forge bound.');
  const conclusion = run.status === 'completed' ? (run.conclusion ?? 'unknown') : 'pending';
  return decide(binding, {
    executionId: String(run.id),
    status:
      run.status !== 'completed'
        ? 'pending'
        : conclusion === 'success'
          ? 'success'
          : conclusion === 'failure' || conclusion === 'timed_out'
            ? 'failed'
            : conclusion === 'cancelled'
              ? 'cancelled'
              : 'other',
    link: run.html_url ?? null,
    conclusion: conclusion.slice(0, 40),
  });
}

const gitlabPipeline = z.object({
  id: z.number().safe().positive(),
  project_id: z.number().safe().positive(),
  sha: z.string(),
  ref: z.string(),
  status: z.string(),
  source: z.string(),
  web_url: z.string().nullable().optional(),
});
const gitlabPending = new Set([
  'created',
  'waiting_for_resource',
  'preparing',
  'pending',
  'running',
  'scheduled',
]);

/** GitLab CI: the pipeline Forge reads from the GitLab API with the project's read token. Webhooks and
 * job reports only wake that read: a GitLab webhook carries a shared token, not a signature. */
function gitlabCi(
  provider: Extract<CiStatusProvider, { adapter: 'gitlab-ci' }>,
  binding: CandidateBinding,
  evidence: CiEvidence,
): CiVerdict {
  const branch = candidateBranch(binding.runId);
  if (evidence.source === 'job-report') {
    const c = evidence.claims;
    const identity =
      c.iss !== provider.origin || c.project_path !== provider.projectPath
        ? 'The report comes from another GitLab project.'
        : c.ref !== branch || c.sha !== binding.commit || c.ref_type !== 'branch'
          ? 'The report comes from another branch or commit.'
          : c.pipeline_source !== 'push'
            ? 'The report comes from a pipeline Forge did not start.'
            : null;
    return jobReport(identity, evidence.status);
  }
  if (evidence.source === 'provider-event')
    return refuse('A GitLab webhook only wakes the pipeline read; it never carries the result.');
  const parsed = gitlabPipeline.safeParse(evidence.record);
  if (!parsed.success) return refuse('The GitLab pipeline record is malformed.');
  const p = parsed.data;
  if (p.project_id !== provider.projectId) return refuse('The pipeline belongs to another project.');
  if (p.source !== 'push') return refuse(`The pipeline was started by ${p.source}, not by Forge's push.`);
  if (p.ref !== branch || p.sha !== binding.commit)
    return refuse('The pipeline checked another branch or commit than the published Candidate.');
  return decide(binding, {
    executionId: String(p.id),
    status: gitlabPending.has(p.status)
      ? 'pending'
      : p.status === 'success'
        ? 'success'
        : p.status === 'failed'
          ? 'failed'
          : p.status === 'canceled'
            ? 'cancelled'
            : 'other',
    link: p.web_url ?? null,
    conclusion: p.status.slice(0, 40),
  });
}

/** One adapter's verdict on one piece of evidence for one bound Candidate run. */
export function ciStatusVerdict(
  provider: CiStatusProvider,
  binding: CandidateBinding,
  evidence: CiEvidence,
): CiVerdict {
  return provider.adapter === 'github-actions'
    ? githubActions(provider, binding, evidence)
    : gitlabCi(provider, binding, evidence);
}

/** The provider read Forge makes itself (fixed paths from the setting and the binding, never from a
 * report): the bound execution, or the first push-started one for the branch and commit. */
export function providerReadPath(provider: CiStatusProvider, binding: CandidateBinding): string {
  const branch = encodeURIComponent(candidateBranch(binding.runId));
  if (provider.adapter === 'github-actions')
    return binding.executionId
      ? `repos/${provider.repository}/actions/runs/${binding.executionId}`
      : `repos/${provider.repository}/actions/runs?branch=${branch}&event=push&head_sha=${binding.commit}&per_page=10`;
  return binding.executionId
    ? `${provider.origin}/api/v4/projects/${provider.projectId}/pipelines/${binding.executionId}`
    : `${provider.origin}/api/v4/projects/${provider.projectId}/pipelines?ref=${branch}&sha=${binding.commit}&source=push&sort=asc&per_page=10`;
}

/** Whether Forge may publish a Candidate to the CI repository, where its job runs with the repository's
 * secrets: every input Lane is by a member who can land, or the owner approved this Candidate. */
export function candidatePublishable(input: {
  authors: ('owner' | 'contributor' | 'outside')[];
  ownerApproved: boolean;
}) {
  return input.ownerApproved || (input.authors.length > 0 && input.authors.every(role => role !== 'outside'));
}

/** The CI file joins the project's protected check entries (src/public-governance.ts): changing it
 * needs the owner's review, as changing a check script does. */
export function ciStatusEntryPaths(provider: CiStatusProvider) {
  return [provider.adapter === 'github-actions' ? provider.workflow : provider.ciFile];
}
