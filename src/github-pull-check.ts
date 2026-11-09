// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

/** Two-way GitHub sync, pull request side (portable, V8-safe): the webhook filter, the
 * `forge/verify` commit status and the ruleset a person imports once (Forge never writes it). */
export const pullStatusContext = 'forge/verify';
const sha = z.string().regex(/^[0-9a-f]{40}$/);
/** The PR a mirror job checks, kept inside its inbound job JSON (src/github-inbound-job.ts). */
export const pullJobSchema = z
  .object({
    number: z.number().int().positive(),
    head: sha,
    fork: z.boolean(),
    /** The check-only run once the composition is clean. */
    runId: z.uuid().optional(),
    /** Set once the final status is decided; later events for this head change nothing. */
    outcome: z.enum(['success', 'failure', 'error', 'superseded']).optional(),
  })
  .strict();
export type PullJob = z.infer<typeof pullJobSchema>;
/** PR jobs give their composition and check-only run UUID version 8 operation ids (Forge's
 * own ids are version 4), so the composition and check completion paths skip the PR lookup for
 * every other operation at zero reads. Only cost depends on it: a stray v8 id from a client
 * costs one empty indexed read, never a wrong status. */
export function pullOperationId() {
  const id = crypto.randomUUID();
  return `${id.slice(0, 14)}8${id.slice(15)}`;
}
export const isPullOperation = (id: string) => id[14] === '8';
const pullActions = new Set(['opened', 'synchronize', 'reopened']);
/** The PR events that start a check: opened, synchronize (a new head) and reopened, into main.
 * Forks included: the head commit is readable from the base repository. Null for every other
 * action or base branch. Throws on a malformed payload (the webhook answers 400). */
export function pullRequestEvent(payload: Record<string, unknown>) {
  const pr = payload.pull_request as
    | {
        number?: unknown;
        head?: { sha?: unknown; repo?: { full_name?: unknown } | null };
        base?: { ref?: unknown; repo?: { full_name?: unknown } };
      }
    | undefined;
  const repository = (payload.repository as { full_name?: unknown } | undefined)?.full_name;
  if (typeof repository !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new Error('Invalid repository');
  if (typeof payload.action !== 'string' || !pullActions.has(payload.action)) return null;
  if (!pr || typeof pr !== 'object') throw new Error('Invalid pull request');
  if (pr.base?.ref !== 'main') return null;
  const number = pr.number,
    head = pr.head?.sha;
  if (
    !Number.isSafeInteger(number) ||
    (number as number) <= 0 ||
    typeof head !== 'string' ||
    !sha.safeParse(head).success
  )
    throw new Error('Invalid pull request');
  const from = pr.head?.repo?.full_name;
  return {
    repository,
    number: number as number,
    head,
    // A deleted fork has no head repository; it is still not this repository.
    fork: typeof from !== 'string' || from.toLowerCase() !== repository.toLowerCase(),
  };
}
export type PullStatus = { state: 'pending' | 'success' | 'failure' | 'error'; description: string };
const clip = (text: string) => (text.length > 140 ? `${text.slice(0, 139)}…` : text);
/** The commit status for a check run's terminal status (GitHub caps descriptions at 140). */
export function checkRunStatus(status: string): PullStatus {
  if (status === 'passed') return { state: 'success', description: 'Forge check passed.' };
  if (status === 'failed') return { state: 'failure', description: 'Forge check failed.' };
  return { state: 'error', description: clip(`Forge check ended ${status}. Push again to retry.`) };
}
export const pullStatus = (state: PullStatus['state'], description: string): PullStatus => ({
  state,
  description: clip(description),
});
/** The ruleset `nforge github connect` and `github status` print for a two-way repository:
 * `forge/verify` from the Forge App is required, main cannot be deleted or force-pushed,
 * changes reach main only through a pull request, and the Forge App alone may bypass (its
 * mirror publishes Forge main directly). Import once: GitHub Settings > Rules > Rulesets >
 * New ruleset > Import a ruleset, or `gh api -X POST repos/OWNER/REPO/rulesets --input FILE`. */
export function forgeRuleset(appId: number) {
  return {
    name: 'Forge two-way main',
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
    bypass_actors: [{ actor_id: appId, actor_type: 'Integration', bypass_mode: 'always' }],
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      {
        type: 'pull_request',
        parameters: {
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_review_thread_resolution: false,
        },
      },
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: false,
          do_not_enforce_on_create: false,
          required_status_checks: [{ context: pullStatusContext, integration_id: appId }],
        },
      },
    ],
  };
}
type BranchRule = { type?: unknown; parameters?: unknown; ruleset_id?: unknown };
type Ruleset = { bypass_actors?: { actor_id?: unknown; actor_type?: unknown }[] };
/** Which of the four protections GitHub enforces on main (GET rules/branches/main, Metadata
 * read), and whether the Forge App is a bypass actor of a ruleset that carries them. Rulesets
 * Forge cannot read in full (bypass actors are shown to repository admins only) leave
 * `bypass` unknown (null), never assumed. */
export function protectionFindings(
  rules: readonly BranchRule[],
  appId: number,
  rulesets: readonly Ruleset[],
) {
  const has = (type: string) => rules.some(rule => rule.type === type);
  const status = rules.some(
    rule =>
      rule.type === 'required_status_checks' &&
      (
        (rule.parameters as { required_status_checks?: { context?: unknown; integration_id?: unknown }[] })
          ?.required_status_checks ?? []
      ).some(
        check =>
          check.context === pullStatusContext &&
          (check.integration_id === undefined || check.integration_id === appId),
      ),
  );
  const missing = [
    ...(status ? [] : [`required status ${pullStatusContext} from the Forge App`]),
    ...(has('deletion') ? [] : ['block deletion']),
    ...(has('non_fast_forward') ? [] : ['block force pushes']),
    ...(has('pull_request') || has('update') ? [] : ['require a pull request (block direct pushes)']),
  ];
  const visible = rulesets.filter(set => Array.isArray(set.bypass_actors));
  const bypass = !visible.length
    ? null
    : visible.some(set =>
        set.bypass_actors!.some(actor => actor.actor_type === 'Integration' && actor.actor_id === appId),
      );
  if (bypass === false) missing.push('the Forge App as bypass actor (Forge publishes main directly)');
  return { protected: missing.length === 0, missing, bypass };
}
export type ProtectionFindings = ReturnType<typeof protectionFindings>;
/** What to do next, in words: nothing, import the ruleset, or send it to an admin. */
export function protectionAdvice(
  repository: string,
  findings: ProtectionFindings,
  role: 'admin' | 'maintain' | null,
) {
  if (findings.protected)
    return `${repository} main is protected: GitHub merges only after ${pullStatusContext} passes.${findings.bypass === null ? ' Forge cannot see bypass actors; confirm the Forge App is the only one.' : ''}`;
  const steps = `Save the printed ruleset as forge-ruleset.json and import it once: GitHub ${repository} > Settings > Rules > Rulesets > New ruleset > Import a ruleset, or gh api -X POST repos/${repository}/rulesets --input forge-ruleset.json.`;
  const who =
    role === 'admin'
      ? ''
      : ` This needs the repository Admin role (or organization owner)${role === 'maintain' ? '; you connected with Maintain' : ''}: send the ruleset and these steps to an admin.`;
  return `${repository} main is not protected for two-way sync; missing: ${findings.missing.join(', ')}. ${steps}${who}`;
}
/** The PR check Lane's message, by public fields only. */
export function pullMessage(input: { number: number; head: string; message: string; repository: string }) {
  const subject = input.message.split('\n', 1)[0]!.trim().slice(0, 200) || 'Pull request head';
  return `${subject}\n\nChecked from GitHub ${input.repository} PR #${input.number} at ${input.head}; not landed.\nGitHub-Commit: ${input.head}`;
}
