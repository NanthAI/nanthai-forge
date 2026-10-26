// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { invariant } from './errors.js';
import { readPull } from './work-import.js';
import { workGithubApi } from './work-github.js';
import { githubApprovalSchema, githubCheckSchema, type Invariant, type WorkData } from './work-types.js';
import type { WorkStore } from './work-store.js';

type Approval = z.infer<typeof githubApprovalSchema>;
const reviewSchema = z.object({
  id: z.number().int().positive().safe(),
  state: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED', 'COMMENTED', 'PENDING']),
  commit_id: githubCheckSchema.shape.head_sha,
  submitted_at: z.iso.datetime().nullable().optional(),
  user: z.object({ id: z.number().int().positive().safe(), login: z.string(), type: z.string() }).nullable(),
});

function mapped(data: WorkData, policy: Invariant) {
  const target = policy.githubReview!.target;
  const source =
    target.kind === 'publication'
      ? data.publications.find(item => item.id === target.id)
      : data.intents.find(item => item.id === target.id)?.external;
  invariant(source?.number, 'NOT_FOUND', 'Select an existing GitHub PR mapping for this review policy.');
  return { repository: source.repository, number: source.number };
}
export function matchesReviewMapping(data: WorkData, policy: Invariant, observation: Approval) {
  const source = mapped(data, policy);
  return (
    observation.definition === policy.definition &&
    JSON.stringify(observation.target) === JSON.stringify(policy.githubReview!.target) &&
    observation.repository === source.repository &&
    observation.number === source.number
  );
}
export async function observeGithubReviews(
  store: WorkStore,
  data: WorkData,
  policy: Invariant,
  head: string,
): Promise<Approval> {
  const source = mapped(data, policy),
    before = await readPull(store, source.repository, source.number);
  const latest = new Map<number, z.infer<typeof reviewSchema>>(),
    ids = new Set<number>();
  let complete = true;
  for (let page = 1; ; page++) {
    const parsed = z
      .array(reviewSchema)
      .safeParse(
        await workGithubApi(
          store,
          `repos/${source.repository}/pulls/${source.number}/reviews?per_page=100&page=${page}`,
        ),
      );
    invariant(
      parsed.success,
      'INVALID_REVIEW',
      'GitHub returned an invalid review observation. Existing source and policy are preserved.',
    );
    let newIds = false;
    for (const item of parsed.data) {
      if (ids.has(item.id)) complete = false;
      else {
        newIds = true;
        ids.add(item.id);
      }
      // Comments/drafts do not approve or withdraw an approval. Retain the latest submitted decision per immutable account ID.
      if (
        !item.user ||
        item.user.type !== 'User' ||
        !item.submitted_at ||
        ['COMMENTED', 'PENDING'].includes(item.state)
      )
        continue;
      const current = latest.get(item.user.id);
      if (
        !current ||
        item.submitted_at > current.submitted_at! ||
        (item.submitted_at === current.submitted_at && item.id > current.id)
      )
        latest.set(item.user.id, item);
    }
    if (parsed.data.length < 100) break;
    if (!newIds) {
      complete = false;
      break;
    }
  }
  const after = await readPull(store, source.repository, source.number);
  complete &&= before.head.sha === after.head.sha && before.base.ref === after.base.ref;
  return {
    definition: policy.definition,
    target: policy.githubReview!.target,
    ...source,
    beforeHead: before.head.sha,
    afterHead: after.head.sha,
    checkedAt: new Date().toISOString(),
    complete,
    reviews: policy.githubReview!.accountIds.map(accountId => {
      const item = latest.get(accountId),
        reasons: string[] = [];
      if (!complete)
        reasons.push('Provider pages or PR pins changed during observation; approval coverage is unknown.');
      if (before.head.sha !== head || after.head.sha !== head)
        reasons.push('The current GitHub candidate differs from this exact Candidate commit.');
      if (!item) reasons.push('No submitted decision from this GitHub User account is available.');
      else {
        if (item.commit_id !== head) reasons.push('The latest account decision names another commit.');
        if (item.state !== 'APPROVED') reasons.push(`The latest account decision is ${item.state}.`);
      }
      return {
        accountId,
        ...(item
          ? {
              login: item.user!.login,
              reviewId: item.id,
              decision: item.state,
              head: item.commit_id,
              submittedAt: item.submitted_at!,
            }
          : {}),
        satisfied: !reasons.length,
        reasons,
      };
    }),
  };
}
