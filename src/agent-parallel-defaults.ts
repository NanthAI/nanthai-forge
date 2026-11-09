// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { AGENT_DEFAULTS as defaultValues, agentDefaultLines } from '../scripts/agent-default-lines.mjs';

/** Parallel-work defaults: project policy that changes how agents finish, prioritize and save.
 * Stored fields are partial; every absent field takes the default below. Kept free of imports
 * from autonomy-policy.ts to avoid a cycle. Docs: docs/parallel-work-defaults.md. */
export const urgentRoleSchema = z.enum(['owner', 'agents']);
export const webhookPresetSchema = z.enum(['off', 'ntfy', 'slack', 'discord', 'telegram', 'generic']);
export const stallAlertsSchema = z
  .object({
    enabled: z.boolean().optional(),
    /** First alert after this long without landing progress (the stall alarm itself fires at 15). */
    notifyAfterMinutes: z.number().int().min(15).max(1440).optional(),
    /** One repeat with diagnosis; it must come after the first alert. */
    repeatAfterMinutes: z.number().int().min(16).max(2880).optional(),
    email: z.array(z.email()).max(10).optional(),
    webhook: webhookPresetSchema.optional(),
  })
  .strict()
  .refine(
    value =>
      value.repeatAfterMinutes === undefined || value.repeatAfterMinutes > (value.notifyAfterMinutes ?? 15),
    'stallAlerts.repeatAfterMinutes must be later than notifyAfterMinutes.',
  );
export const agentDefaultsSchema = z
  .object({
    preflight: z.enum(['off', 'advise', 'require']).optional(),
    preflightMaxMinutes: z.number().int().min(0).max(240).optional(),
    urgentRoles: z.array(urgentRoleSchema).max(2).optional(),
    overlapGate: z.enum(['off', 'warn', 'block']).optional(),
    checkpointNudgeMinutes: z.number().int().min(0).max(1440).optional(),
    /** First-write hook records "touching <path>" on the board (Issue 9c8490a4); absent is on.
     * Stored only: it never joins the effective defaults below (see effectiveAgentDefaults). */
    autoClaim: z.boolean().optional(),
    /** An open Lane with no save, start or landing for this many days is dormant (0 turns it off). */
    dormantAfterDays: z.number().int().min(0).max(365).optional(),
    /** A Lane colliding with an admitted peer (D2, Issue 1eb42254): `offer` (default) prints the
     * one stack command; `auto` stacks at the Lane's next sync. Stored-only, read by the server's
     * overlap read alone, like dormantAfterDays. */
    stacking: z.enum(['offer', 'auto']).optional(),
    stallAlerts: stallAlertsSchema.optional(),
  })
  .strict();
export type AgentDefaults = z.infer<typeof agentDefaultsSchema>;

export const AGENT_DEFAULTS: EffectiveAgentDefaults = defaultValues;
export { agentDefaultLines };

export const effectiveAgentDefaultsSchema = z
  .object({
    preflight: z.enum(['off', 'advise', 'require']),
    preflightMaxMinutes: z.number().int().nonnegative(),
    urgentRoles: z.array(urgentRoleSchema),
    overlapGate: z.enum(['off', 'warn', 'block']),
    checkpointNudgeMinutes: z.number().int().nonnegative(),
    stallAlerts: z
      .object({
        enabled: z.boolean(),
        notifyAfterMinutes: z.number().int().positive(),
        repeatAfterMinutes: z.number().int().positive(),
        email: z.array(z.string()),
        webhook: webhookPresetSchema,
      })
      .strict(),
  })
  .strict();
export type EffectiveAgentDefaults = z.infer<typeof effectiveAgentDefaultsSchema>;
/** Keys of the effective defaults that CLIs before 2026-11-06 parse strictly (every key required,
 * no extra key) on every capabilities reply and policy read. This set is frozen: 2026-11-06, adding
 * autoClaim (and then dormantAfterDays) to the reply broke capabilities across CLI/server versions in
 * both directions (HOSTED_PROTOCOL_INVALID). A new key goes on the wire only to a CLI that asks for
 * contract feature `agent-defaults-extended`, and is shown by the policy read only when stored. */
export const WIRE_AGENT_DEFAULT_KEYS = [
  'preflight',
  'preflightMaxMinutes',
  'urgentRoles',
  'overlapGate',
  'checkpointNudgeMinutes',
  'stallAlerts',
] as const;
const frozenDefaults = (effective: EffectiveAgentDefaults) =>
  Object.fromEntries(WIRE_AGENT_DEFAULT_KEYS.map(key => [key, effective[key]])) as Pick<
    EffectiveAgentDefaults,
    (typeof WIRE_AGENT_DEFAULT_KEYS)[number]
  >;
/** Server side of the capabilities reply: the frozen keys, plus every key when the CLI asked for
 * `agent-defaults-extended`. */
export const wireAgentDefaults = (effective: EffectiveAgentDefaults, extended: boolean) =>
  extended ? effective : frozenDefaults(effective);
/** Client side: unknown keys from a newer server are dropped, so a server change cannot break this
 * parse again. A key added after the freeze must take a `.default()` here (an older server omits it). */
export const effectiveAgentDefaultsWireSchema = z.object({
  ...effectiveAgentDefaultsSchema.shape,
  stallAlerts: z.object(effectiveAgentDefaultsSchema.shape.stallAlerts.shape),
});

/** Days without a Lane record write before an open Lane is dormant. Deliberately outside the effective
 * defaults: capabilities carry those and parse strictly in both directions, so a new effective field breaks
 * every CLI/server pair that differs by one release (HOSTED_PROTOCOL_INVALID). It is stored-only and read
 * by the server alone; `0` turns dormancy off. */
export const DORMANT_AFTER_DAYS = 2;
export const dormantAfterDays = (stored: AgentDefaults | undefined) =>
  stored?.dormantAfterDays ?? DORMANT_AFTER_DAYS;

/** Stored-only like dormantAfterDays: `offer` unless the project chose `auto`. */
export const stackingMode = (stored: AgentDefaults | undefined): 'offer' | 'auto' =>
  stored?.stacking ?? 'offer';

export function effectiveAgentDefaults(stored: AgentDefaults | undefined): EffectiveAgentDefaults {
  const alerts = stored?.stallAlerts;
  return {
    preflight: stored?.preflight ?? AGENT_DEFAULTS.preflight,
    preflightMaxMinutes: stored?.preflightMaxMinutes ?? AGENT_DEFAULTS.preflightMaxMinutes,
    urgentRoles: [...(stored?.urgentRoles ?? AGENT_DEFAULTS.urgentRoles)],
    overlapGate: stored?.overlapGate ?? AGENT_DEFAULTS.overlapGate,
    checkpointNudgeMinutes: stored?.checkpointNudgeMinutes ?? AGENT_DEFAULTS.checkpointNudgeMinutes,
    stallAlerts: {
      enabled: alerts?.enabled ?? AGENT_DEFAULTS.stallAlerts.enabled,
      notifyAfterMinutes: alerts?.notifyAfterMinutes ?? AGENT_DEFAULTS.stallAlerts.notifyAfterMinutes,
      repeatAfterMinutes: alerts?.repeatAfterMinutes ?? AGENT_DEFAULTS.stallAlerts.repeatAfterMinutes,
      email: [...(alerts?.email ?? [])],
      webhook: alerts?.webhook ?? AGENT_DEFAULTS.stallAlerts.webhook,
    },
  };
}

/** Partial edits merge field by field, so one set-policy call changes one setting. */
export function mergeAgentDefaults(previous: AgentDefaults | undefined, edit: AgentDefaults | undefined) {
  if (!edit) return previous;
  const stallAlerts =
    edit.stallAlerts || previous?.stallAlerts ? { ...previous?.stallAlerts, ...edit.stallAlerts } : undefined;
  return agentDefaultsSchema.parse({ ...previous, ...edit, ...(stallAlerts ? { stallAlerts } : {}) });
}

/** Who may put a landing ahead of the queue. The owner role is the owner's own session, or the
 * owner's CLI when the command says asOwner:true (the owner at the keyboard). Agents share the
 * owner's credential, so this is a default-behaviour guard, not an access rule. */
export function urgentAllowed(
  defaults: EffectiveAgentDefaults,
  input: { owner: string; actor: { id: string; kind: 'agent' | 'person' }; asOwner?: boolean },
) {
  if (input.actor.id !== input.owner) return false;
  const role = input.actor.kind === 'person' || input.asOwner ? 'owner' : 'agents';
  return defaults.urgentRoles.includes(role);
}
export const urgentRefusal = (defaults: EffectiveAgentDefaults) =>
  `Urgent priority is limited to ${defaults.urgentRoles.length ? defaults.urgentRoles.join(' and ') : 'nobody'} by this project's urgentRoles setting. ` +
  'Queue normally; urgent is for a red main or an incident the owner names. The owner can pass asOwner:true, or change agentDefaults.urgentRoles with set-policy.';
