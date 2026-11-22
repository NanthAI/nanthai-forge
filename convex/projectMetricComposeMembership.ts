// SPDX-License-Identifier: Apache-2.0
import type { Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { canonicalPayload } from '../src/hosted-source-operation';
import { metricMemberKey } from '../src/self-metrics-context';

type Member = { intentId: string; laneId: string; head: string; sourceCreatedAt: number };
type Membership = { projectId: Id<'hostedProjects'>; root: string; page: string; members: Member[] };

/** The caller already verified the exact Lane versions against this compose page. */
export function metricComposeMembershipRows(input: Membership) {
  const { projectId, root, page, members } = input;
  const writes = new Map<string, { key: string; sourceCreatedAt: number }>();
  for (const { intentId, laneId, head, sourceCreatedAt } of members) {
    for (const key of [
      metricMemberKey('intent', intentId),
      metricMemberKey('lane', laneId),
      metricMemberKey('failed-input', intentId, head),
    ])
      writes.set(canonicalPayload([key, sourceCreatedAt]), { key, sourceCreatedAt });
  }
  return [...writes.values()].map(fact => ({ projectId, ...fact, sourceId: root, value: page }));
}

export function metricComposeMembershipWrites(ctx: MutationCtx, input: Membership) {
  return metricComposeMembershipRows(input).map(row => ctx.db.insert('projectMetricFacts', row));
}
