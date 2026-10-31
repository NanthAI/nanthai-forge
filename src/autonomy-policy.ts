// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { checkLogsSchema } from './check-log-policy.js';
import { invariant } from './errors.js';
import { legacyCheckCredentialsRefSchema } from './legacy-check-credentials.js';
import { trustConfigSchema } from './agent-trust-config.js';
import {
  agentDefaultsSchema,
  effectiveAgentDefaults,
  mergeAgentDefaults,
} from './agent-parallel-defaults.js';
export const autoExchangeSchema = z.object({
  enabled: z.boolean().default(false),
  debounceMs: z.number().safe().nonnegative().default(30_000),
  maxPendingAgeMs: z.number().safe().nonnegative().default(300_000),
  pauseOnDailySpend: z.boolean().optional(),
});
/** Portable API shape, shared by local owners, hosted projects and UI clients. */
export const autonomyPolicySchema = z.object({
  githubMirror: z
    .object({
      repo: z
        .string()
        .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
        .refine(value => value.split('/').every(part => part !== '.' && part !== '..')),
      autoPush: z.boolean(),
      laneRefs: z.literal(false),
    })
    .optional(),
  autoExchange: autoExchangeSchema.optional(),
  checkLogs: checkLogsSchema.optional(),
  /** B2.6: absent is off; enabling is an owner decision. */
  trust: trustConfigSchema.optional(),
  /** Parallel-work defaults for agents; absent fields take their documented defaults. */
  agentDefaults: agentDefaultsSchema.optional(),
  preset: z.enum(['supervised', 'trusted', 'autonomous', 'custom']),
  acceptance: z.object({
    mode: z.enum(['review', 'auto-on-pass']),
    /** Absent preserves the full hosted gate. */
    gate: z.enum(['full', 'contract']).optional(),
    disjointFastPath: z.boolean().optional(),
    /** Hosted clean-recomposition proof; absent means on. Independent of native fast path. */
    hostedCrossHeadReuse: z.boolean().optional(),
    /** Hosted main-race recheck under the contract gate: run only tests affected by
     * both the main delta and this change; absent means on. */
    scopedRecheck: z.boolean().optional(),
    /** Native: `optimistic` opts into optimistic landing. Hosted: `batched` opts into
     * landing batches; absent checks each deferred entry alone. */
    landing: z.enum(['batched', 'optimistic']).optional(),
    /** Hosted batches: check each member's own affected set before it joins a cohort. Absent is off. */
    admissionCheck: z.boolean().optional(),
    /** Hosted batches: fixed cohort size; absent picks it from the recent failure rate. */
    batchMaxSize: z.number().int().min(1).max(8).optional(),
    /** Remote runners only: wait up to this long after the oldest queued landing before the first check. */
    batchWindowMs: z.number().int().min(0).max(60_000).optional(),
    autoActors: z.array(z.string().min(1)).optional(),
    protectedPaths: z.array(z.string().min(1)),
    /** Public-project owner approval; absent selects the built-in governance paths. */
    ownerApprovalPaths: z.array(z.string().min(1)).optional(),
  }),
  checks: z
    .object({
      // Persisted Modal policies remain readable; editedPolicy rejects new selection.
      runner: z.enum(['modal', 'local', 'github-actions']),
      fallback: z.enum(['manual', 'local']).optional(),
      repo: z
        .string()
        .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
        .refine(value => value.split('/').every(part => part !== '.' && part !== '..'))
        .optional(),
      runsOn: z.string().min(1).optional(),
      shards: z.number().int().positive().optional(),
      credentialsRef: legacyCheckCredentialsRefSchema.optional(),
      ratesUsdPerMinute: z.record(z.string().min(1), z.number().nonnegative().finite()).optional(),
      /** Remote runners only: landing batches checked at once (stacked on one another). */
      concurrency: z.number().int().min(1).max(16).optional(),
    })
    .optional(),
  integrationPreview: z.object({ auto: z.boolean() }).optional(),
  ownerRootUpdates: z.boolean().optional(),
  /** Debounced local snapshots of open native Lanes; absent means on. */
  autoSnapshot: z.boolean().optional(),
  laneUpdates: z.enum(['auto', 'ask']),
  lifecycle: z.object({ completeOnAccept: z.boolean(), cleanRegenerableCopies: z.boolean() }),
  notify: z.object({ awaySummary: z.boolean() }),
});
export type AutonomyPolicy = z.infer<typeof autonomyPolicySchema>;
export type AcceptanceActor = { kind: 'person' | 'agent'; id: string };
export function policyPreset(preset: Exclude<AutonomyPolicy['preset'], 'custom'>): AutonomyPolicy {
  return {
    preset,
    autoExchange: autoExchangeSchema.parse({}),
    acceptance: {
      mode: preset === 'supervised' ? 'review' : 'auto-on-pass',
      gate: preset === 'supervised' ? 'full' : 'contract',
      disjointFastPath: false,
      autoActors: [],
      protectedPaths: [],
    },
    integrationPreview: { auto: false },
    ownerRootUpdates: false,
    laneUpdates: preset === 'supervised' ? 'ask' : 'auto',
    lifecycle: { completeOnAccept: true, cleanRegenerableCopies: preset === 'autonomous' },
    notify: { awaySummary: true },
  };
}
/** Existing owners have no new restrictions or cleanup on upgrade. */
export function legacyPolicy(): AutonomyPolicy {
  const policy = policyPreset('trusted');
  delete policy.acceptance.gate;
  return { ...policy, preset: 'custom' };
}
export function effectivePolicy(data: { autonomyPolicy?: AutonomyPolicy | undefined }): AutonomyPolicy {
  let policy = data.autonomyPolicy ? autonomyPolicySchema.parse(data.autonomyPolicy) : legacyPolicy();
  policy = {
    ...policy,
    integrationPreview: policy.integrationPreview ?? { auto: false },
    autoExchange: policy.autoExchange ?? autoExchangeSchema.parse({}),
  };
  // An absent runner policy preserves the legacy finish protocol. Fallback is
  // manual unless explicitly opted in, including when no checks policy exists.
  return policy.checks ? { ...policy, checks: { fallback: 'manual', ...policy.checks } } : policy;
}
/** The `policy` read: stored policy plus every agent default filled in, so agents see effective values.
 * Landing evidence keeps the stored policy, so digests do not change when a default does. */
export const policyReadView = (policy: AutonomyPolicy): AutonomyPolicy => ({
  ...policy,
  agentDefaults: effectiveAgentDefaults(policy.agentDefaults),
});
/** Compare-and-swap accepts the stored form or the read view (filled agent defaults). */
export const samePolicy = (expected: AutonomyPolicy, previous: AutonomyPolicy) =>
  JSON.stringify(expected) === JSON.stringify(previous) ||
  JSON.stringify(expected) === JSON.stringify(policyReadView(previous));
export const policyWriteSchema = z
  .object({
    action: z.literal('set-policy'),
    governanceVersion: z.literal(1).optional(),
    operationId: z.string().uuid(),
    /** Compare-and-swap prevents a concurrent settings edit from being overwritten. */
    expectedPolicy: autonomyPolicySchema.optional(),
    preset: autonomyPolicySchema.shape.preset.optional(),
    acceptance: autonomyPolicySchema.shape.acceptance.partial().optional(),
    checks: autonomyPolicySchema.shape.checks.unwrap().partial().optional(),
    integrationPreview: autonomyPolicySchema.shape.integrationPreview,
    ownerRootUpdates: autonomyPolicySchema.shape.ownerRootUpdates,
    autoSnapshot: autonomyPolicySchema.shape.autoSnapshot,
    checkLogs: checkLogsSchema.optional(),
    laneUpdates: autonomyPolicySchema.shape.laneUpdates.optional(),
    lifecycle: autonomyPolicySchema.shape.lifecycle.partial().optional(),
    notify: autonomyPolicySchema.shape.notify.partial().optional(),
    githubMirror: autonomyPolicySchema.shape.githubMirror,
    trust: trustConfigSchema.optional(),
    agentDefaults: agentDefaultsSchema.optional(),
    autoExchange: z
      .object({
        enabled: z.boolean().optional(),
        pauseOnDailySpend: z.boolean().optional(),
        debounceMs: autoExchangeSchema.shape.debounceMs.removeDefault().optional(),
        maxPendingAgeMs: autoExchangeSchema.shape.maxPendingAgeMs.removeDefault().optional(),
      })
      .optional(),
  })
  .strict()
  .refine(
    value => value.acceptance?.ownerApprovalPaths === undefined || value.governanceVersion === 1,
    'Editing owner approval paths requires governanceVersion:1.',
  );
export type PolicyWrite = z.infer<typeof policyWriteSchema>;
export function editedPolicy(previous: AutonomyPolicy, command: PolicyWrite): AutonomyPolicy {
  invariant(
    command.checks?.runner !== 'modal',
    'BAD_ARGUMENT',
    'The Modal runner has been retired. Select checks.runner local or github-actions.',
  );
  const base =
    command.preset === 'custom'
      ? { ...previous, preset: 'custom' as const }
      : command.preset
        ? policyPreset(command.preset)
        : previous;
  const edited =
    command.integrationPreview ||
    command.autoExchange ||
    command.checkLogs ||
    command.checks ||
    command.acceptance ||
    command.ownerRootUpdates !== undefined ||
    command.autoSnapshot !== undefined ||
    command.laneUpdates ||
    command.lifecycle ||
    command.notify ||
    command.githubMirror ||
    command.trust ||
    command.agentDefaults;
  const githubMirror = command.githubMirror ?? previous.githubMirror;
  const policy = autonomyPolicySchema.parse({
    ...base,
    ...(githubMirror ? { githubMirror } : {}),
    ...((command.trust ?? previous.trust) ? { trust: command.trust ?? previous.trust } : {}),
    ...((command.agentDefaults ?? previous.agentDefaults)
      ? { agentDefaults: mergeAgentDefaults(previous.agentDefaults, command.agentDefaults) }
      : {}),
    autoExchange: { ...autoExchangeSchema.parse({}), ...previous.autoExchange, ...command.autoExchange },
    ...(edited ? { preset: 'custom' } : {}),
    ...(command.checks
      ? { checks: { runner: 'local', fallback: 'manual', ...base.checks, ...command.checks } }
      : {}),
    ...((command.checkLogs ?? previous.checkLogs)
      ? { checkLogs: command.checkLogs ?? previous.checkLogs }
      : {}),
    acceptance: { ...base.acceptance, ...command.acceptance },
    integrationPreview: command.integrationPreview ?? base.integrationPreview ?? { auto: false },
    ownerRootUpdates: command.ownerRootUpdates ?? base.ownerRootUpdates,
    ...((command.autoSnapshot ?? previous.autoSnapshot) !== undefined
      ? { autoSnapshot: command.autoSnapshot ?? previous.autoSnapshot }
      : {}),
    laneUpdates: command.laneUpdates ?? base.laneUpdates,
    lifecycle: { ...base.lifecycle, ...command.lifecycle },
    notify: { ...base.notify, ...command.notify },
  });
  // Cleaning is part of autonomous behavior, never supervised acceptance.
  invariant(
    !policy.lifecycle.cleanRegenerableCopies || policy.acceptance.mode === 'auto-on-pass',
    'BAD_ARGUMENT',
    'Regenerable-copy cleanup requires auto-on-pass acceptance.',
  );
  for (const glob of [...policy.acceptance.protectedPaths, ...(policy.acceptance.ownerApprovalPaths ?? [])])
    globPattern(glob);
  return policy;
}
/** Repository-relative globs: *, **, ?, character classes and brace alternatives.
 * Invalid patterns require review rather than silently missing protected paths. */
export function globPattern(glob: string): RegExp {
  let pattern = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          pattern += '(?:.*/)?';
        } else pattern += '.*';
      } else pattern += '[^/]*';
    } else if (c === '?') pattern += '[^/]';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      invariant(end > i + 1, 'BAD_ARGUMENT', 'Protected-path glob has an unclosed character class.');
      const body = glob.slice(i + 1, end).replace(/^!/, '^');
      pattern += `[${body}]`;
      i = end;
    } else if (c === '{') pattern += '(?:';
    else if (c === '}') pattern += ')';
    else if (c === ',' && glob.slice(0, i).lastIndexOf('{') > glob.slice(0, i).lastIndexOf('}'))
      pattern += '|';
    else pattern += c.replace(/[\\^$+?.()|]/g, '\\$&');
  }
  try {
    return new RegExp(`^${pattern}$`);
  } catch {
    invariant(false, 'BAD_ARGUMENT', 'Protected-path glob is invalid.');
  }
}
export function protectedMatches(policy: AutonomyPolicy, paths: string[]) {
  return paths.filter(path => policy.acceptance.protectedPaths.some(glob => globPattern(glob).test(path)));
}
export function reviewReason(
  policy: AutonomyPolicy,
  actor: AcceptanceActor,
  paths: string[] | null,
): string | null {
  if (actor.kind === 'person') return null;
  if (policy.acceptance.mode === 'review') return 'Waiting for review by a person; not in main yet';
  const allowed = policy.acceptance.autoActors ?? [];
  if (allowed.length && !allowed.includes(actor.id))
    return `Waiting for review by a person; actor ${actor.id} is not allowed to auto-accept`;
  if (paths === null && policy.acceptance.protectedPaths.length)
    return 'Waiting for review by a person; protected-path coverage is unavailable';
  const matched = protectedMatches(policy, paths ?? []);
  return matched.length ? `Waiting for review by a person; protected paths: ${matched.join(', ')}` : null;
}

/** Portable hosted command schema: safe to import in non-Node Convex mutations. */
export const hostedAcceptanceCommandSchema = z.object({
  action: z.literal('accept-hosted-channel'),
  // Explicitly use agent authority; this can never promote a device to person authority.
  agent: z.literal(true).optional(),
  channel: z.string().trim().min(1),
  acceptanceId: z.string().uuid().optional(),
  viewId: z.string().uuid(),
  head: z.string().regex(/^[0-9a-f]{40,64}$/),
  previousId: z.string().uuid().nullable(),
  archiveSha256: z.string().regex(/^[0-9a-f]{64}$/),
});

/** Opt-in trusted acceptance, including equivalent custom policy edits. */
export const optimisticLanding = (policy: AutonomyPolicy) =>
  policy.acceptance.landing === 'optimistic' && policy.acceptance.mode === 'auto-on-pass';
