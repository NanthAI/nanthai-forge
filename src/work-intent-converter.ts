// SPDX-License-Identifier: Apache-2.0
import { planningIntentStatus } from './work-planning-lifecycle.js';
import { invariant } from './errors.js';
import { digest } from './portable-hash.js';
import { workSchema, type WorkData } from './work-types.js';
import { unifiedWorkSchema, type UnifiedIntent, type UnifiedWorkData } from './work-unified-types.js';

/** Hash exact JSON bytes, including property order; never normalize retained requests/events. */
export const intentMergeHash = (value: unknown) => digest(JSON.stringify(value));
export const noteId = (intentId: string, index: number) => {
  const h = digest(`intent-merge-v1:note:${intentId}:${index}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const count = (data: {
  intents: { notes: unknown[] }[];
  planningItems: WorkData['planningItems'];
  planningComments: unknown[];
}) => ({
  intents: data.intents.length,
  issues: new Map(data.planningItems.filter(p => p.kind === 'issue').map(p => [p.id, p])).size,
  initiatives: new Map(data.planningItems.filter(p => p.kind === 'initiative').map(p => [p.id, p])).size,
  versions: data.planningItems.length,
  comments: data.planningComments.length,
  notes: data.intents.reduce((sum, intent) => sum + intent.notes.length, 0),
});

/** Pure, retry-stable conversion. No clock, random IDs, IO, or production reader wiring. */
export function convertWork15To16(
  input: WorkData | UnifiedWorkData,
  target: 16 | 18 | 20 | 22 | 24 = 16,
  options: { sameIdentityEdits?: ReadonlySet<string> } = {},
): UnifiedWorkData {
  if (input.schema === 16) {
    unifiedWorkSchema.parse(input);
    return structuredClone(input);
  }
  invariant(
    input.schema === 15 ||
      (target !== 16 && input.schema === 17) ||
      ((target === 20 || target === 22 || target === 24) && input.schema === 19) ||
      ((target === 22 || target === 24) && input.schema === 21) ||
      (target === 24 && input.schema === 23),
    'WORK_UPGRADE_REQUIRED',
    'Intent conversion requires Work 15/16, Work 17 targeting 18/20/22, Work 19 targeting 20/22, Work 21 targeting 22/24, or Work 23 targeting 24.',
  );
  workSchema.parse(input); // Validate without replacing original objects or extension fields.
  const source = structuredClone(input);
  const current = [...new Map(source.planningItems.map(item => [item.id, item])).values()];
  const issues = current.filter(item => item.kind === 'issue');
  const initiatives = current
    .filter(item => item.kind === 'initiative')
    .map(item => ({ ...item, kind: 'initiative' as const }));
  const execution = new Map(source.intents.map(item => [item.id, item]));
  // Count distinct reverse links across all history: an old ambiguous link must not disappear.
  const reverse = new Map<string, Set<string>>();
  for (const item of source.planningItems.filter(item => item.kind === 'issue'))
    for (const target of item.intentIds) {
      const links = reverse.get(target) ?? new Set<string>();
      links.add(item.id);
      reverse.set(target, links);
    }
  const sameIdentityEdits = issues.filter(
    issue => execution.has(issue.id) && options.sameIdentityEdits?.has(issue.id),
  ).length;
  const aliases: UnifiedWorkData['intentAliases'] = [];
  const resolve = new Map<string, string>();
  for (const issue of issues) {
    const historicalTargets = new Set(
      source.planningItems.filter(item => item.id === issue.id).flatMap(item => item.intentIds),
    );
    const target = issue.intentIds[0];
    const fold =
      issue.intentIds.length === 1 &&
      historicalTargets.size === 1 &&
      target &&
      execution.has(target) &&
      reverse.get(target)?.size === 1;
    invariant(
      !execution.has(issue.id) || options.sameIdentityEdits?.has(issue.id),
      'INTENT_MERGE_ID_COLLISION',
      'Issue and execution Intent identities overlap; preserve the original snapshot for reconciliation.',
    );
    const sameIdentityEdit = execution.has(issue.id) && options.sameIdentityEdits?.has(issue.id);
    resolve.set(issue.id, fold && !sameIdentityEdit ? target : issue.id);
    if (fold && !sameIdentityEdit) aliases.push({ aliasId: issue.id, intentId: target });
  }
  const intents: UnifiedIntent[] = source.intents.map(item => ({
    ...item,
    title: item.outcome,
    description: '',
    status: item.status === 'ready' ? 'active' : item.status,
    memberships: [],
    relatedIntentIds: [],
    historyRefs: [],
    conversation: item.notes.map((_, index) => ({ id: noteId(item.id, index), kind: 'note', index })),
  }));
  const byId = new Map(intents.map(item => [item.id, item]));
  for (const issue of issues) {
    const targetId = resolve.get(issue.id)!;
    let intent = byId.get(targetId);
    if (!intent) {
      intent = {
        ...issue,
        id: issue.id,
        title: issue.title,
        outcome: issue.title,
        description: issue.body,
        constraints: '',
        status: planningIntentStatus(issue.status),
        notes: [],
        createdAt: source.planningItems.find(item => item.id === issue.id)!.at,
        updatedAt: issue.at,
        memberships: [],
        relatedIntentIds: [],
        historyRefs: [],
        conversation: [],
      };
      intents.push(intent);
      byId.set(intent.id, intent);
    } else {
      intent.description = issue.body;
      // A journal-proven write addressed to the execution UUID edits that Intent;
      // the different-UUID legacy fold still preserves execution title/status.
      if (issue.id === targetId && options.sameIdentityEdits?.has(issue.id))
        Object.assign(intent, {
          title: issue.title,
          outcome: issue.title,
          version: issue.version,
          previousVersion: issue.previousVersion,
          operationId: issue.operationId,
          request: issue.request,
          updatedAt: issue.at,
        });
    }
    intent.historyRefs = source.planningItems
      .filter(item => item.id === issue.id)
      .map(item => ({ itemId: item.id, version: item.version }));
    intent.conversation.push(
      ...source.planningComments
        .filter(item => item.itemId === issue.id)
        .map(item => ({ id: item.id, kind: 'planning-comment' as const, itemId: item.itemId })),
    );
    for (const linked of new Set(
      source.planningItems.filter(item => item.id === issue.id).flatMap(item => item.intentIds),
    )) {
      if (linked === targetId) continue;
      intent.relatedIntentIds.push(linked);
      const other = byId.get(linked);
      if (other && !other.relatedIntentIds.includes(targetId)) other.relatedIntentIds.push(targetId);
    }
  }
  // Match the current planning display: retained item insertion order, then direct-link array order.
  // Each source placement remains distinct, even when a folded pair appears twice in a group.
  const positions = new Map<string, number>();
  const membership = (intentId: string, initiativeId: string, sourceId: string) => {
    const intent = byId.get(intentId);
    if (!intent) return;
    const order = positions.get(initiativeId) ?? 0;
    positions.set(initiativeId, order + 1);
    intent.memberships.push({ initiativeId, sourceId, order });
  };
  for (const group of initiatives) {
    for (const target of group.intentIds) membership(target, group.id, group.id);
    for (const issue of issues.filter(item => item.initiativeId === group.id)) {
      const target = resolve.get(issue.id)!;
      membership(target, group.id, issue.id);
      for (const linked of issue.intentIds) if (linked !== target) membership(linked, group.id, issue.id);
    }
  }
  const output = {
    ...source,
    schema: target,
    intents,
    initiatives,
    intentAliases: aliases,
    legacyIntentMerge: structuredClone({
      intents: source.intents,
      planningItems: source.planningItems,
      planningComments: source.planningComments,
      fields: Object.fromEntries(
        Object.entries(source).filter(([key]) => !Object.hasOwn(workSchema.shape, key)),
      ),
    }),
  };
  // A legacy extension may use this newly reserved name; its original is retained in fields.
  delete (output as Record<string, unknown>).intentMergeReceipt;
  const result: UnifiedWorkData = {
    ...output,
    intentMergeReceipt: {
      converter: 'intent-merge-v1',
      fromSchema: source.schema as 15 | 17 | 19 | 21 | 23,
      toSchema: target,
      counts: {
        before: { ...count(source), ...(sameIdentityEdits ? { sameIdentityEdits } : {}) },
        after: {
          ...count(output),
          memberships: intents.reduce((sum, item) => sum + item.memberships.length, 0),
          aliases: aliases.length,
        },
        foldedPairs: aliases.length,
      },
      hashes: {
        input: intentMergeHash(input),
        output: intentMergeHash(output),
        intents: intentMergeHash(source.intents),
        planningItems: intentMergeHash(source.planningItems),
        planningComments: intentMergeHash(source.planningComments),
      },
    },
  };
  unifiedWorkSchema.parse(result);
  return result;
}

/** Compose unified Intents with batch-capable Work, retaining the eight-entry capability. */
export function convertWorkTo18(
  input: WorkData | UnifiedWorkData,
  options: { sameIdentityEdits?: ReadonlySet<string> } = {},
): UnifiedWorkData {
  if (
    input.schema === 16 ||
    input.schema === 18 ||
    input.schema === 20 ||
    input.schema === 22 ||
    input.schema === 24
  ) {
    unifiedWorkSchema.parse(input);
    return {
      ...structuredClone(input),
      schema: input.schema === 24 ? 24 : input.schema === 22 ? 22 : input.schema === 20 ? 20 : 18,
    } as UnifiedWorkData;
  }
  invariant(
    input.schema === 15 ||
      input.schema === 17 ||
      input.schema === 19 ||
      input.schema === 21 ||
      input.schema === 23,
    'WORK_UPGRADE_REQUIRED',
    'Intent conversion requires Work format 15, 16, 17, 18, 19, 20, 21, 22, 23 or 24.',
  );
  return convertWork15To16(
    input,
    input.schema === 23 ? 24 : input.schema === 21 ? 22 : input.schema === 19 ? 20 : 18,
    options,
  );
}
